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
    all_s, all_e, all_size = [], [], []
    for read in reads:
        if read.get("methyl"):
            _add_points(mod, read["methyl"], view_width, bin_size)
        for key, name in (("methyl_m6a", "m6a"), ("methyl_m5c", "m5c")):
            if read.get(key):
                _add_points(point_layers.setdefault(name, np.zeros(RESOLUTION)), read[key], view_width, bin_size)
        if read.get("deam"):
            _add_points(point_layers.setdefault("deam", np.zeros(RESOLUTION)),
                        [d[0] for d in read["deam"]], view_width, bin_size)

        intervals = read.get("intervals") or []
        if intervals:
            arr = np.asarray(intervals, dtype=float).reshape(-1, 3)
            read_start, read_end = arr[:, 0].min(), arr[:, 1].max()
            if read_start < read_end:
                _add_ranges(coverage_diff, [read_start], [read_end], view_width, bin_size)
            if rules:
                keep = arr[:, 2] >= 10
                all_s.append(arr[keep, 0])
                all_e.append(arr[keep, 1])
                all_size.append(arr[keep, 2])

        for layer_name, layer in (read.get("layers") or {}).items():
            ivs = (layer or {}).get("intervals") or []
            if not ivs:
                continue
            arr = np.asarray(ivs, dtype=float).reshape(-1, 3)
            arr = arr[arr[:, 2] > 0]
            name = "fire" if layer_name == "msp" else layer_name
            _add_ranges(layer_diffs.setdefault(name, np.zeros(RESOLUTION + 1)), arr[:, 0], arr[:, 1], view_width, bin_size)

        if read.get("fire"):
            fire = np.asarray([[f[0], f[1]] for f in read["fire"]], dtype=float)
            _add_ranges(fire_diff, fire[:, 0], fire[:, 1], view_width, bin_size)

    if rules and all_s:
        s, e, size = np.concatenate(all_s), np.concatenate(all_e), np.concatenate(all_size)
        todo = np.ones(len(size), dtype=bool)
        for rule in rules:  # getMatchingRuleId: first matching rule wins
            idx = np.flatnonzero(todo)
            if idx.size == 0:
                break
            hit = rule_mask(rule, rctx, s[idx], e[idx], size[idx], None)
            if hit.any():
                matched = idx[hit]
                _add_ranges(rule_diffs[rule["id"]], s[matched], e[matched], view_width, bin_size)
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
