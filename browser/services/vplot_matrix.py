"""V-plot matrices (footprint size x position), vectorised with numpy.

Two ways a footprint lands on the plot:

- ``midpoint`` (the traditional V-plot): one count at the footprint's centre,
  in its size row.
- ``span`` ("full footprint"): the footprint adds to every position it covers,
  in its size row, so a row shows where footprints of that size sit along the
  window (occupancy by footprint size). Each position bin gets the fraction of
  its bases the footprint covers, so a row sums to the bases covered / bin
  width whatever the bin width. Computed with one difference array per size
  bin (O(footprints + cells)), not a loop over each footprint's bases.

``row_normalize`` divides each size row by its mean over the window's position
bins: 1 = as common at this position as that size is anywhere in the window,
2 = twice as common. It is the enrichment of footprints of size X at a position
over the window's expectation for that size, so sizes that are rare overall
are as visible as common ones. A row drawn from only a few footprints would be
all noise (one footprint is a huge "enrichment" of its size), so rows with
fewer than ``row_min_footprints`` footprints in the window are left at 0.
"""
from __future__ import annotations

from typing import Iterable, Literal, Sequence

import numpy as np

VPlotMode = Literal["midpoint", "span"]
VPLOT_MODES = ("midpoint", "span")


def footprint_arrays(intervals: Iterable[Sequence[int]], offset: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(start, end, size) arrays in window coordinates for ``[start, end, size]`` intervals.

    ``offset`` is added to each start/end (the working set's start minus the
    region's start). The end is exclusive.
    """
    rows = [iv for iv in intervals if iv is not None and len(iv) >= 3]
    if not rows:
        empty = np.zeros(0, dtype=np.int64)
        return empty, empty, empty
    arr = np.asarray([[int(iv[0]), int(iv[1]), int(iv[2])] for iv in rows], dtype=np.int64)
    return arr[:, 0] + offset, arr[:, 1] + offset, arr[:, 2]


def accumulate_vplot(
    starts: np.ndarray,
    ends: np.ndarray,
    sizes: np.ndarray,
    *,
    size_min: int,
    size_bin: int,
    n_size_bins: int,
    pos_bin: int,
    n_pos_bins: int,
    mode: str = "midpoint",
    row_counts: np.ndarray | None = None,
) -> np.ndarray:
    """Raw counts, shape ``(n_size_bins, n_pos_bins)``; positions are 0-based in the window.

    ``row_counts`` (length ``n_size_bins``), if given, gets the number of
    footprints drawn in each size row added to it.
    """
    matrix = np.zeros((n_size_bins, n_pos_bins), dtype=float)
    if len(sizes) == 0:
        return matrix
    starts = np.asarray(starts, dtype=np.int64)
    ends = np.asarray(ends, dtype=np.int64)
    sizes = np.asarray(sizes, dtype=np.int64)
    size_idx = (sizes - size_min) // size_bin
    keep = (sizes > 0) & (sizes >= size_min) & (size_idx >= 0) & (size_idx < n_size_bins)
    if mode != "span":
        mids = (starts + ends) // 2
        pos_idx = mids // pos_bin
        keep &= (mids >= 0) & (pos_idx >= 0) & (pos_idx < n_pos_bins)
        np.add.at(matrix, (size_idx[keep], pos_idx[keep]), 1.0)
        if row_counts is not None:
            row_counts += np.bincount(size_idx[keep], minlength=n_size_bins)[:n_size_bins]
        return matrix

    window = n_pos_bins * pos_bin
    s = np.clip(starts, 0, window)
    e = np.clip(ends, 0, window)
    keep &= e > s
    if not np.any(keep):
        return matrix
    s, e, row = s[keep], e[keep], size_idx[keep]
    if row_counts is not None:
        row_counts += np.bincount(row, minlength=n_size_bins)[:n_size_bins]
    b0 = s // pos_bin           # first bin touched
    b1 = (e - 1) // pos_bin     # last bin touched
    same = b0 == b1
    # A footprint inside one bin: its covered fraction of that bin.
    np.add.at(matrix, (row[same], b0[same]), (e[same] - s[same]) / pos_bin)
    many = ~same
    if np.any(many):
        r, lo, hi, ss, ee = row[many], b0[many], b1[many], s[many], e[many]
        # Partial first and last bins.
        np.add.at(matrix, (r, lo), ((lo + 1) * pos_bin - ss) / pos_bin)
        np.add.at(matrix, (r, hi), (ee - hi * pos_bin) / pos_bin)
        # Whole bins in between: +1 over [lo+1, hi) through a difference array.
        diff = np.zeros((n_size_bins, n_pos_bins + 1), dtype=float)
        np.add.at(diff, (r, lo + 1), 1.0)
        np.add.at(diff, (r, hi), -1.0)
        matrix += np.cumsum(diff, axis=1)[:, :n_pos_bins]
    return matrix


def normalize_rows(matrix: np.ndarray, row_counts: np.ndarray | None = None, min_footprints: int = 0) -> np.ndarray:
    """Each size row over its mean across positions.

    Rows with no signal stay 0, and so do rows drawn from fewer than
    ``min_footprints`` footprints (when ``row_counts`` is given).
    """
    if matrix.size == 0:
        return matrix
    means = matrix.mean(axis=1, keepdims=True)
    usable = means > 0
    if row_counts is not None and min_footprints > 0:
        usable = usable & (np.asarray(row_counts).reshape(-1, 1) >= min_footprints)
    out = np.zeros_like(matrix, dtype=float)
    np.divide(matrix, means, out=out, where=usable & np.ones_like(matrix, dtype=bool))
    return out


def finish_vplot(
    matrix: np.ndarray,
    *,
    smooth: float = 0.0,
    row_normalize: bool = False,
    log: bool = False,
    row_counts: np.ndarray | None = None,
    row_min_footprints: int = 0,
) -> np.ndarray:
    """Smooth, then (optionally) per-size-row enrichment, then log1p. Scaling to [0, 1] is the caller's."""
    out = matrix.astype(float)
    if smooth and smooth > 0:
        from scipy.ndimage import gaussian_filter
        out = gaussian_filter(out, sigma=smooth)
    if row_normalize:
        out = normalize_rows(out, row_counts, row_min_footprints)
    if log:
        out = np.log1p(out)
    return out
