"""computeMetaprofileFromReads (ReadTrack.tsx), for the headless renderer.

The browser computes a panel's metaprofile itself (instead of using the
server's) whenever a source is a Labeling rule, the panel has clusters or
read filters, or several datasets are shown. Per 500 bins over the view:
the fraction of covering reads with a footprint matched to each Labeling
rule (first matching rule wins), with each layer's calls, with FIRE, and
with methylation/deamination marks.
"""
from __future__ import annotations

from typing import Optional

import numpy as np

from services.figure.tracks._read_colors import RuleContext, rule_mask

RESOLUTION = 500


def _add_ranges(diff: np.ndarray, starts, ends, view_width: float, bin_size: float) -> None:
    """addRange for arrays: +1 at the first bin, -1 after the last (region-relative bp)."""
    s = np.asarray(starts, dtype=float)
    e = np.asarray(ends, dtype=float)
    keep = (e > 0) & (s < view_width)
    if not keep.any():
        return
    s, e = s[keep], e[keep]
    lo = np.maximum(0, np.floor(np.maximum(0, s) / bin_size)).astype(int)
    hi = np.minimum(RESOLUTION, np.ceil(np.minimum(view_width, e) / bin_size)).astype(int)
    ok = hi > lo
    np.add.at(diff, lo[ok], 1)
    np.add.at(diff, hi[ok], -1)


def _add_read_union(diff: np.ndarray, starts, ends, view_width: float, bin_size: float, read_ids=None) -> None:
    """addReadIntervals (utils/metaprofileBins.ts): each read adds the union of the bins its intervals touch, so a read
    counts at most once per bin however many of its intervals meet there. ``read_ids`` None: one read."""
    s = np.asarray(starts, dtype=float)
    e = np.asarray(ends, dtype=float)
    r = np.zeros(s.size, dtype=np.int64) if read_ids is None else np.asarray(read_ids, dtype=np.int64)
    keep = (e > 0) & (s < view_width) & (e > s)
    if not keep.any():
        return
    s, e, r = s[keep], e[keep], r[keep]
    lo = np.maximum(0, np.floor(np.maximum(0, s) / bin_size)).astype(np.int64)
    hi = np.minimum(RESOLUTION, np.ceil(np.minimum(view_width, e) / bin_size)).astype(np.int64)
    ok = hi > lo
    lo, hi, r = lo[ok], hi[ok], r[ok]
    if lo.size == 0:
        return
    order = np.lexsort((lo, r))
    r, lo, hi = r[order], lo[order], hi[order]
    offset = r * (RESOLUTION + 2)
    reach = np.maximum.accumulate(hi + offset) - offset  # exclusive end, running max within each read
    new_run = np.ones(lo.size, dtype=bool)
    new_run[1:] = (r[1:] != r[:-1]) | (lo[1:] > reach[:-1])
    np.add.at(diff, lo[new_run], 1)
    np.add.at(diff, reach[np.flatnonzero(np.r_[new_run[1:], True])], -1)


def _add_points(arr: np.ndarray, positions, view_width: float, bin_size: float) -> None:
    pos = np.asarray(positions, dtype=float)
    pos = pos[(pos >= 0) & (pos < view_width)]
    if pos.size:
        np.add.at(arr, np.minimum(RESOLUTION - 1, np.floor(pos / bin_size).astype(int)), 1)


def compute_metaprofile(reads: list, view_width: float, rules: list, rctx: Optional[RuleContext]) -> dict:
    """{mod, fire, rules: {rule id: values}, layers: {layer: values}}, each RESOLUTION long."""
    bin_size = view_width / RESOLUTION
    mod = np.zeros(RESOLUTION)
    fire_diff = np.zeros(RESOLUTION + 1)
    coverage_diff = np.zeros(RESOLUTION + 1)
    rule_diffs = {rule["id"]: np.zeros(RESOLUTION + 1) for rule in rules}
    layer_diffs: dict[str, np.ndarray] = {}
    point_layers: dict[str, np.ndarray] = {}

    # Primary intervals of every read, for rule matching (size >= 10 only).
    all_s, all_e, all_size, all_read = [], [], [], []
    for read_index, read in enumerate(reads):
        if read.get("methyl"):
            _add_points(mod, read["methyl"], view_width, bin_size)
        for key, name in (("methyl_m6a", "m6a"), ("methyl_m5c", "m5c")):
            if read.get(key):
                _add_points(point_layers.setdefault(name, np.zeros(RESOLUTION)), read[key], view_width, bin_size)
        if read.get("deam"):
            _add_points(point_layers.setdefault("deam", np.zeros(RESOLUTION)),
                        [d[0] for d in read["deam"]], view_width, bin_size)

        # The read's span: its footprint/gap intervals, widened to every layer/FIRE interval it carries (ReadTrack).
        read_start, read_end = np.inf, -np.inf
        intervals = read.get("intervals") or []
        if intervals:
            arr = np.asarray(intervals, dtype=float).reshape(-1, 3)
            read_start, read_end = arr[:, 0].min(), arr[:, 1].max()
            if rules:
                keep = arr[:, 2] >= 10
                all_s.append(arr[keep, 0])
                all_e.append(arr[keep, 1])
                all_size.append(arr[keep, 2])
                all_read.append(np.full(int(keep.sum()), read_index))

        # msp and fire both feed the "fire" profile: united per read before binning (a read counts once per bin).
        by_profile: dict[str, list] = {}
        for layer_name, layer in (read.get("layers") or {}).items():
            ivs = (layer or {}).get("intervals") or []
            if not ivs:
                continue
            arr = np.asarray(ivs, dtype=float).reshape(-1, 3)
            arr = arr[arr[:, 2] > 0]
            name = "fire" if layer_name == "msp" else layer_name
            layer_diffs.setdefault(name, np.zeros(RESOLUTION + 1))
            by_profile.setdefault(name, []).append(arr)
            if arr.size:
                read_start, read_end = min(read_start, arr[:, 0].min()), max(read_end, arr[:, 1].max())
        for name, arrs in by_profile.items():
            arr = np.concatenate(arrs)
            _add_read_union(layer_diffs[name], arr[:, 0], arr[:, 1], view_width, bin_size)

        if read.get("fire"):
            fire = np.asarray([[f[0], f[1]] for f in read["fire"]], dtype=float)
            _add_read_union(fire_diff, fire[:, 0], fire[:, 1], view_width, bin_size)
            read_start, read_end = min(read_start, fire[:, 0].min()), max(read_end, fire[:, 1].max())

        if read_start < read_end:
            _add_ranges(coverage_diff, [read_start], [read_end], view_width, bin_size)

    if rules and all_s:
        s, e, size = np.concatenate(all_s), np.concatenate(all_e), np.concatenate(all_size)
        read_of = np.concatenate(all_read)
        todo = np.ones(len(size), dtype=bool)
        for rule in rules:  # getMatchingRuleId: first matching rule wins
            idx = np.flatnonzero(todo)
            if idx.size == 0:
                break
            hit = rule_mask(rule, rctx, s[idx], e[idx], size[idx], None)
            if hit.any():
                matched = idx[hit]
                _add_read_union(rule_diffs[rule["id"]], s[matched], e[matched], view_width, bin_size, read_of[matched])
                todo[matched] = False

    coverage = np.cumsum(coverage_diff[:RESOLUTION])
    denom = np.where(coverage > 0, coverage, 1.0)
    covered = coverage > 0

    def normalize(values: np.ndarray) -> list:
        return [float(v) for v in np.where(covered, values / denom, values)]

    layers = {name: normalize(np.cumsum(diff[:RESOLUTION])) for name, diff in layer_diffs.items()}
    for name, points in point_layers.items():
        base = np.asarray(layers.get(name, np.zeros(RESOLUTION)))
        # Layer ranges were already normalised; add normalised point counts.
        layers[name] = [float(v) for v in base + np.where(covered, points / denom, points)]
    return {
        "mod": normalize(mod),
        "fire": normalize(np.cumsum(fire_diff[:RESOLUTION])),
        "rules": {rule_id: normalize(np.cumsum(diff[:RESOLUTION])) for rule_id, diff in rule_diffs.items()},
        "layers": layers,
    }


def metaprofile_rules(fe: dict, active_ids: set) -> list:
    """Colormap rules that are active metaprofile sources, in the colormap's order."""
    rules = ((fe.get("activeColormap") or {}).get("rules")) or []
    return [r for r in rules if isinstance(r, dict) and r.get("id") in active_ids]
