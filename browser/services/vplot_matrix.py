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

Footprint size enrichment (``finish_vplot(normalization=...)``) generalises
this to four normalisations of the same matrix:

- ``row``: each size row over its mean across positions (as above; the paper
  style "size enrichment" plot, centred on 1);
- ``column``: each position column over its mean across sizes (which sizes are
  over-represented at a position, against the size mix at that position);
- ``oe``: observed over expected from both margins, ``obs * total /
  (row_sum * col_sum)`` (1 = what the size's and the position's totals predict);
- ``raw``: the counts.

The minimum-footprints guard blanks rows (``row``, ``oe``) or columns
(``column``) drawn from fewer than ``min_footprints`` footprints.

Smoothing is a separable 2-D Gaussian with its own sigma for each axis, given
in bp (``sigma_size_bp``, ``sigma_pos_bp``) and converted to bins with the
axis's bin width (0 = no smoothing on that axis). It is applied to the counts,
before normalising. The older single ``smooth`` value was one sigma in bins on
both axes: ``legacy_sigmas_bp`` turns it into the bp pair.
"""
from __future__ import annotations

from typing import Iterable, Literal, Sequence

import numpy as np

VPlotMode = Literal["midpoint", "span"]
VPLOT_MODES = ("midpoint", "span")
VPlotNormalization = Literal["row", "column", "oe", "raw"]
VPLOT_NORMALIZATIONS = ("row", "column", "oe", "raw")


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
    col_counts: np.ndarray | None = None,
) -> np.ndarray:
    """Raw counts, shape ``(n_size_bins, n_pos_bins)``; positions are 0-based in the window.

    ``row_counts`` (length ``n_size_bins``), if given, gets the number of
    footprints drawn in each size row added to it. ``col_counts`` (length
    ``n_pos_bins``) gets the number of footprints touching each position bin
    (midpoint: centred in it; full footprint: covering any of it).
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
        if col_counts is not None:
            col_counts += np.bincount(pos_idx[keep], minlength=n_pos_bins)[:n_pos_bins]
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
    if col_counts is not None:
        touched = np.zeros(n_pos_bins + 1, dtype=np.int64)
        np.add.at(touched, b0, 1)
        np.add.at(touched, b1 + 1, -1)
        col_counts += np.cumsum(touched)[:n_pos_bins]
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


def normalize_columns(matrix: np.ndarray, col_counts: np.ndarray | None = None, min_footprints: int = 0,
                      blank: float = 0.0) -> np.ndarray:
    """Each position column over its mean across sizes (blank: no signal, or under ``min_footprints``)."""
    if matrix.size == 0:
        return matrix.astype(float)
    means = matrix.mean(axis=0, keepdims=True)
    usable = means > 0
    if col_counts is not None and min_footprints > 0:
        usable = usable & (np.asarray(col_counts).reshape(1, -1) >= min_footprints)
    out = np.full(matrix.shape, blank, dtype=float)
    np.divide(matrix, means, out=out, where=usable & np.ones_like(matrix, dtype=bool))
    return out


def observed_over_expected(matrix: np.ndarray, row_counts: np.ndarray | None = None, min_footprints: int = 0,
                           blank: float = 0.0) -> np.ndarray:
    """``obs / (row_sum * col_sum / total)``: 1 = what the size's and the position's totals predict.

    Blank where the expectation is 0, and in size rows drawn from fewer than
    ``min_footprints`` footprints.
    """
    if matrix.size == 0:
        return matrix.astype(float)
    total = float(matrix.sum())
    out = np.full(matrix.shape, blank, dtype=float)
    if total <= 0:
        return out
    expected = matrix.sum(axis=1, keepdims=True) * matrix.sum(axis=0, keepdims=True) / total
    usable = expected > 0
    if row_counts is not None and min_footprints > 0:
        usable = usable & (np.asarray(row_counts).reshape(-1, 1) >= min_footprints)
    np.divide(matrix, expected, out=out, where=usable)
    return out


def sigma_bins(sigma_bp: float | None, bin_bp: int) -> float:
    """A Gaussian sigma in bp as bins of ``bin_bp`` (0 when off or invalid)."""
    if not sigma_bp or sigma_bp <= 0 or bin_bp <= 0:
        return 0.0
    return float(sigma_bp) / float(bin_bp)


def legacy_sigmas_bp(smooth: float | None, size_bin: int, pos_bin: int) -> tuple[float, float]:
    """The older ``smooth`` (one sigma in bins, both axes) as ``(sigma_size_bp, sigma_pos_bp)``."""
    if not smooth or smooth <= 0:
        return 0.0, 0.0
    return float(smooth) * size_bin, float(smooth) * pos_bin


def gaussian_smooth(matrix: np.ndarray, sigma_size_bins: float, sigma_pos_bins: float) -> np.ndarray:
    """Separable 2-D Gaussian: ``sigma_size_bins`` down the size axis (0), ``sigma_pos_bins`` along positions (1)."""
    out = matrix.astype(float)
    if out.size == 0 or (sigma_size_bins <= 0 and sigma_pos_bins <= 0):
        return out
    from scipy.ndimage import gaussian_filter
    return gaussian_filter(out, sigma=(max(0.0, sigma_size_bins), max(0.0, sigma_pos_bins)))


def finish_vplot(
    matrix: np.ndarray,
    *,
    smooth: float = 0.0,
    row_normalize: bool = False,
    log: bool = False,
    row_counts: np.ndarray | None = None,
    row_min_footprints: int = 0,
    normalization: str | None = None,
    sigma_bins_size: float | None = None,
    sigma_bins_pos: float | None = None,
    col_counts: np.ndarray | None = None,
    blank: float = 0.0,
) -> np.ndarray:
    """Smooth, then normalise, then (optionally) log1p. Scaling to [0, 1] is the caller's.

    ``normalization`` (``row`` / ``column`` / ``oe`` / ``raw``) overrides
    ``row_normalize`` when given. ``sigma_bins_size`` / ``sigma_bins_pos``
    override ``smooth`` (one sigma in bins on both axes) when either is given.
    ``row_min_footprints`` is the minimum-footprints guard for whichever
    normalisation is used; ``blank`` is the value of cells it leaves out.
    """
    if sigma_bins_size is None and sigma_bins_pos is None:
        s_size = s_pos = float(smooth) if smooth and smooth > 0 else 0.0
    else:
        s_size, s_pos = float(sigma_bins_size or 0.0), float(sigma_bins_pos or 0.0)
    out = gaussian_smooth(matrix, s_size, s_pos)
    norm = normalization if normalization in VPLOT_NORMALIZATIONS else ("row" if row_normalize else "raw")
    if norm == "row":
        out = normalize_rows(out, row_counts, row_min_footprints)
        if blank != 0.0:
            usable = out.mean(axis=1, keepdims=True) > 0
            out = np.where(usable, out, blank) if out.size else out
    elif norm == "column":
        out = normalize_columns(out, col_counts, row_min_footprints, blank=blank)
    elif norm == "oe":
        out = observed_over_expected(out, row_counts, row_min_footprints, blank=blank)
    if log:
        out = np.log1p(out)
    return out
