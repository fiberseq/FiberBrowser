"""The Plots profile engine on the server: the per-bin counting the browser's engine does
(frontend/src/features/plots/profileEngine.ts `accumulateChannels`), for profiles the server must bin itself because
it holds reads the client never receives (peak-scan signals, graph density strips).

Weightings, as in the browser:
- overlap: each bin gets the covered fraction of its width (bin_bp = 1: per-base counts, the peak scan's signal);
- touch: the read track's metaprofiles: a read counts at most once per bin per channel (the union of the bins its
  intervals of that channel touch), and its coverage spans [start, end) widened to every interval it adds, so an
  interval channel stays within [0, 1] (utils/metaprofileBins.ts); marks count one by one;
- centre: an interval counts 1 in each bin whose centre it covers (the graph panel's density strips).
Under overlap and centre, intervals are counted one by one (nothing is merged), so a caller that wants a base counted
once per read merges first. ``accumulate_channels`` is pinned to the browser's engine by golden values (tests/test_profile_engine.py and
profileEngineGolden.test.ts).
"""
from __future__ import annotations

import math
from collections.abc import Sequence

import numpy as np


def range_counts(starts: Sequence[int], ends: Sequence[int], region_width: int) -> np.ndarray:
    """Per-base counts (overlap weighting, 1 bp bins) of many [start, end) ranges over [0, region_width): a
    vectorised difference array (int32)."""
    width = max(0, int(region_width))
    if width <= 0:
        return np.zeros(0, dtype=np.int32)
    if not starts:
        return np.zeros(width, dtype=np.int32)

    start_array = np.clip(np.asarray(starts, dtype=np.int64), 0, width)
    end_array = np.clip(np.asarray(ends, dtype=np.int64), 0, width)
    valid = end_array > start_array
    if not np.any(valid):
        return np.zeros(width, dtype=np.int32)

    delta = (
        np.bincount(start_array[valid], minlength=width + 1)
        - np.bincount(end_array[valid], minlength=width + 1)
    )
    return np.cumsum(delta[:-1], dtype=np.int64).astype(np.int32, copy=False)


def point_counts(positions: Sequence[int], region_width: int) -> np.ndarray:
    """Marks per base over [0, region_width) (positions must lie inside)."""
    counts = np.zeros(region_width, dtype=np.int32)
    if positions:
        np.add.at(counts, np.asarray(positions, dtype=np.int64), 1)
    return counts


def centre_counts(starts: Sequence[int], ends: Sequence[int], window_start: int, n_bins: int, bin_bp: int) -> list[int]:
    """Centre weighting: per bin of ``bin_bp`` from ``window_start``, the ranges covering the bin's centre."""
    centres = window_start + (np.arange(n_bins) + 0.5) * bin_bp
    diff = np.zeros(n_bins + 1, dtype=np.int64)
    if len(starts):
        a = np.searchsorted(centres, np.asarray(starts, dtype=np.float64), side="left")
        b = np.searchsorted(centres, np.asarray(ends, dtype=np.float64), side="left")
        keep = b > a
        np.add.at(diff, a[keep], 1)
        np.add.at(diff, b[keep], -1)
    return np.cumsum(diff[:-1]).tolist()


def accumulate_channels(reads: Sequence[dict], n_bins: int, width: float, weighting: str = "overlap") -> dict:
    """The browser engine's ``accumulateChannels``: reads ``{start, end, spans: {name: [[a, b]...]}, points: {name:
    [p...]}}`` in window coordinates -> ``{coverage: [...], channels: {name: [...]}}`` over ``n_bins`` bins of
    [0, width)."""
    if weighting == "touch":
        return _accumulate_touch(reads, n_bins, width)
    bin_size = width / n_bins
    coverage = [0.0] * n_bins
    channels: dict[str, list[float]] = {}

    def add(arr: list[float], a: float, b: float) -> None:
        if b <= 0 or a >= width:
            return
        first = max(0, math.floor(a / bin_size))
        last = min(n_bins - 1, math.floor((b - 1e-9) / bin_size))
        for k in range(first, last + 1):
            lo, hi = max(a, k * bin_size), min(b, (k + 1) * bin_size)
            if hi > lo:
                arr[k] += (hi - lo) / bin_size

    for r in reads:
        if r.get("end", 0) > r.get("start", 0):
            add(coverage, r["start"], r["end"])
        for name, ivs in (r.get("spans") or {}).items():
            arr = channels.setdefault(name, [0.0] * n_bins)
            for a, b in ivs:
                add(arr, a, b)
        for name, pts in (r.get("points") or {}).items():
            arr = channels.setdefault(name, [0.0] * n_bins)
            for p in pts:
                k = math.floor(p / bin_size)
                if 0 <= k < n_bins:
                    arr[k] += 1
    return {"coverage": coverage, "channels": channels}


def _touched_bins(a: float, b: float, width: float, n_bins: int):
    """utils/metaprofileBins.ts touchedBins: the bins [first, end) an interval touches, or None."""
    if not (b > 0) or not (a < width) or not (b > a):
        return None
    bin_size = width / n_bins
    first = max(0, math.floor(max(0, a) / bin_size))
    end = min(n_bins, math.ceil(min(width, b) / bin_size))
    return (first, end) if end > first else None


def _add_read_intervals(diff: list[float], intervals, width: float, n_bins: int) -> None:
    """utils/metaprofileBins.ts addReadIntervals: one read's intervals of one channel as the union of their bins."""
    ranges = sorted(r for r in (_touched_bins(a, b, width, n_bins) for a, b in intervals) if r)
    if not ranges:
        return
    s, e = ranges[0]
    for s2, e2 in ranges[1:]:
        if s2 <= e:
            e = max(e, e2)
            continue
        diff[s] += 1
        diff[e] -= 1
        s, e = s2, e2
    diff[s] += 1
    diff[e] -= 1


def _accumulate_touch(reads: Sequence[dict], n_bins: int, width: float) -> dict:
    """The browser engine's 'touch' weighting (accumulateTouch)."""
    bin_size = width / n_bins
    cov_diff = [0.0] * (n_bins + 1)
    diffs: dict[str, list[float]] = {}
    marks: dict[str, list[float]] = {}
    for r in reads:
        start, end = r.get("start", 0), r.get("end", 0)
        s, e = (start, end) if end > start else (math.inf, -math.inf)
        for name, ivs in (r.get("spans") or {}).items():
            diff = diffs.setdefault(name, [0.0] * (n_bins + 1))
            for a, b in ivs:
                if b > a:
                    s, e = min(s, a), max(e, b)
            _add_read_intervals(diff, ivs, width, n_bins)
        if e > s:
            _add_read_intervals(cov_diff, [(s, e)], width, n_bins)
        for name, pts in (r.get("points") or {}).items():
            arr = marks.setdefault(name, [0.0] * n_bins)
            for p in pts:
                if 0 <= p < width:
                    arr[min(n_bins - 1, math.floor(p / bin_size))] += 1

    def cumulate(diff: list[float]) -> list[float]:
        out, run = [], 0.0
        for i in range(n_bins):
            run += diff[i]
            out.append(run)
        return out

    channels = {name: cumulate(diff) for name, diff in diffs.items()}
    for name, arr in marks.items():
        if name in channels:
            channels[name] = [x + y for x, y in zip(channels[name], arr)]
        else:
            channels[name] = arr
    return {"coverage": cumulate(cov_diff), "channels": channels}
