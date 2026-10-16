"""Numeric helpers for single-molecule co-accessibility analyses."""
from __future__ import annotations

from typing import Optional

import numpy as np

from services.analysis_query import AnalysisReadQuery
from services.read_metrics import get_layer_intervals


# Nice bin sizes for adaptive binning
NICE_BINS = [50, 100, 200, 500, 1000, 2000, 5000, 10000]
TARGET_BINS = 150


def pick_bin_size(region_width: int) -> int:
    """Pick a nice bin size targeting roughly 150 bins."""
    raw_bin = max(1, region_width // TARGET_BINS)
    return min(NICE_BINS, key=lambda x: abs(x - raw_bin))


def interval_matches_signal(size: int, signal_type: str, subnuc_threshold: int = 90) -> bool:
    """Test whether a footprint interval matches the requested co-accessibility signal."""
    if signal_type == 'accessibility':
        return size < subnuc_threshold or size <= 0
    if signal_type == 'nucleosome':
        return size >= subnuc_threshold
    if signal_type == 'small_fp':
        return 0 < size < subnuc_threshold
    if signal_type == 'linker':
        return size <= 0
    if signal_type == 'all_fp':
        return size > 0
    if signal_type.startswith('size:'):
        parts = signal_type[5:].split('-')
        if len(parts) == 2:
            try:
                lo, hi = int(parts[0]), int(parts[1])
                return lo <= size <= hi
            except ValueError:
                pass
        return False
    return size < subnuc_threshold or size <= 0


def _add_interval_bp(
    row: np.ndarray,
    iv_start: int,
    iv_end: int,
    *,
    bin_size: int,
    n_bins: int,
    region_width: int,
) -> None:
    """Add interval overlap basepairs to one read/bin row.

    This preserves the existing complete-bin semantics: ``n_bins`` is
    ``region_width // bin_size``, so any partial trailing region outside
    ``n_bins * bin_size`` is ignored.
    """
    if n_bins <= 0:
        return
    start_c = max(0, iv_start)
    end_c = min(region_width, iv_end, n_bins * bin_size)
    if start_c >= end_c:
        return

    first_bin = start_c // bin_size
    last_bin = min(n_bins - 1, (end_c - 1) // bin_size)
    if first_bin == last_bin:
        row[first_bin] += end_c - start_c
        return

    row[first_bin] += ((first_bin + 1) * bin_size) - start_c
    row[last_bin] += end_c - (last_bin * bin_size)
    if last_bin > first_bin + 1:
        row[first_bin + 1:last_bin] += bin_size


def build_accessibility_matrix(
    state,
    query: AnalysisReadQuery,
    bin_size: int,
    signal_type: str = 'accessibility',
    subnuc_threshold: int = 90,
    layer: str | None = None,
):
    """Build (n_reads, n_bins) fractional signal matrix.

    Coverage denominators always come from primary read intervals. When
    ``layer`` is set, matched bases come from that layer's intervals; otherwise
    matched bases are selected from primary intervals by ``signal_type``.
    """
    region_width = query.region_width
    n_bins = region_width // bin_size

    all_reads = []
    for _ds_id, ws in query.iter_working_sets(state):
        all_reads.extend(ws.reads)

    n_reads = len(all_reads)
    if n_reads == 0:
        return np.full((0, n_bins), np.nan, dtype=np.float32), 0

    matched_bp = np.zeros((n_reads, n_bins), dtype=np.float32)
    total_bp = np.zeros((n_reads, n_bins), dtype=np.float32)

    for i, read in enumerate(all_reads):
        primary_intervals = read.get('intervals', [])
        for (iv_start, iv_end, _size) in primary_intervals:
            _add_interval_bp(
                total_bp[i],
                iv_start,
                iv_end,
                bin_size=bin_size,
                n_bins=n_bins,
                region_width=region_width,
            )

        if layer is not None:
            for (iv_start, iv_end, _size) in get_layer_intervals(read, layer):
                _add_interval_bp(
                    matched_bp[i],
                    iv_start,
                    iv_end,
                    bin_size=bin_size,
                    n_bins=n_bins,
                    region_width=region_width,
                )
        else:
            for (iv_start, iv_end, size) in primary_intervals:
                if not interval_matches_signal(size, signal_type, subnuc_threshold):
                    continue
                _add_interval_bp(
                    matched_bp[i],
                    iv_start,
                    iv_end,
                    bin_size=bin_size,
                    n_bins=n_bins,
                    region_width=region_width,
                )

    accessibility = np.full((n_reads, n_bins), np.nan, dtype=np.float32)
    covered = total_bp > 0
    accessibility[covered] = matched_bp[covered] / total_bp[covered]

    return accessibility, n_reads


def compute_raw_matrix(accessibility: np.ndarray, min_coverage: int = 20):
    """Compute raw co-accessibility and coverage from a fractional signal matrix."""
    n_reads, n_bins = accessibility.shape
    if n_reads == 0 or n_bins < 2:
        sz = max(n_bins, 1)
        return np.full((sz, sz), np.nan, dtype=np.float32), np.zeros((sz, sz), dtype=np.float32)

    covered = ~np.isnan(accessibility)
    coverage = covered.astype(np.float32).T @ covered.astype(np.float32)

    acc_filled = np.where(np.isnan(accessibility), 0.0, accessibility)
    co_acc = acc_filled.T @ acc_filled

    # Divide only where there is coverage (np.where would still divide by 0 and warn).
    raw = np.full(coverage.shape, np.nan, dtype=np.float32)
    np.divide(co_acc, coverage, out=raw, where=coverage > 0)
    raw[coverage < min_coverage] = np.nan

    return raw, coverage


def normalize_oe_marginal(raw: np.ndarray, accessibility: Optional[np.ndarray] = None) -> np.ndarray:
    """O/E using marginal independence as the null hypothesis.

    ``raw[i, j]`` is E[a_i * a_j] over the reads covering both bins. Under
    independence its expectation is E[a_i] * E[a_j] over those same reads, so
    with ``accessibility`` (reads x bins, NaN = not covered) each pair's two
    marginals are first moments over its co-covering reads. Without it, the
    diagonal E[a_i^2] stands in for E[a_i], which is right only for binary
    (0/1) accessibility: 50%-accessible bins would give O/E 4 instead of 1.
    """
    if accessibility is not None and accessibility.size and accessibility.shape[1] == raw.shape[0]:
        covered = (~np.isnan(accessibility)).astype(np.float64)
        filled = np.where(np.isnan(accessibility), 0.0, accessibility).astype(np.float64)
        coverage = covered.T @ covered
        sums = filled.T @ covered  # [i, j]: sum of a_i over reads covering i and j
        with np.errstate(divide="ignore", invalid="ignore"):
            mean_i = np.where(coverage > 0, sums / coverage, np.nan)
        expected = mean_i * mean_i.T  # E[a_i] * E[a_j], both over the pair's reads
        expected = np.where(np.isnan(expected) | (expected == 0), 0.001, expected)
    else:
        marginal = np.diag(raw).copy()
        marginal[np.isnan(marginal)] = 0
        expected = np.outer(marginal, marginal)
        expected[expected == 0] = 0.001

    result = np.where(~np.isnan(raw), raw / expected, np.nan)
    np.fill_diagonal(result, np.nan)
    return result


def normalize_oe_distance(raw: np.ndarray) -> np.ndarray:
    """O/E using distance-based expected, same approach as Micro-C."""
    n = raw.shape[0]
    max_dist = n

    expected_per_dist = np.zeros(max_dist, dtype=np.float64)
    for d in range(max_dist):
        diag = np.diag(raw, d)
        valid = diag[~np.isnan(diag)]
        if len(valid) > 0:
            expected_per_dist[d] = np.mean(valid)
    expected_per_dist[expected_per_dist == 0] = 0.001

    result = np.full(raw.shape, np.nan, dtype=np.float64)
    for d, expected in enumerate(expected_per_dist):
        rows = np.arange(n - d)
        cols = rows + d
        upper = raw[rows, cols]
        upper_valid = ~np.isnan(upper)
        result[rows[upper_valid], cols[upper_valid]] = upper[upper_valid] / expected
        if d == 0:
            continue
        lower = raw[cols, rows]
        lower_valid = ~np.isnan(lower)
        result[cols[lower_valid], rows[lower_valid]] = lower[lower_valid] / expected

    np.fill_diagonal(result, np.nan)
    return result


def normalize_correlation(accessibility: np.ndarray, min_coverage: int = 20) -> np.ndarray:
    """Pearson correlation between accessibility columns, pair by pair.

    Each pair (i, j) uses only the reads covering both bins: means, covariance
    and variances over that joint coverage (masked ``corrcoef`` centred each
    column over all its reads). Undefined correlations (a constant bin within
    the pair's reads) stay NaN, as do pairs with fewer than ``min_coverage`` reads.
    """
    n_bins = accessibility.shape[1]
    if n_bins < 2:
        return np.full((n_bins, n_bins), np.nan, dtype=np.float32)
    valid = (~np.isnan(accessibility)).astype(np.float64)
    x = np.where(np.isnan(accessibility), 0.0, accessibility).astype(np.float64)
    n = valid.T @ valid                      # reads covering both i and j
    sx = x.T @ valid                         # [i, j]: sum of a_i over those reads
    sxx = (x * x).T @ valid                  # [i, j]: sum of a_i^2 over those reads
    sxy = x.T @ x                            # [i, j]: sum of a_i * a_j (0 where either is missing)
    with np.errstate(divide="ignore", invalid="ignore"):
        cov = sxy - sx * sx.T / n
        var_i = sxx - sx * sx / n
        var_j = var_i.T
        corr = cov / np.sqrt(var_i * var_j)
    corr[(n < max(min_coverage, 2)) | ~np.isfinite(corr)] = np.nan
    corr = np.clip(corr, -1.0, 1.0).astype(np.float32)
    np.fill_diagonal(corr, np.nan)
    return corr


def compute_normalized_matrix(
    state,
    query: AnalysisReadQuery,
    actual_bin_size: int,
    normalization: str,
    min_coverage: int,
    signal_type: str = 'accessibility',
    subnuc_threshold: int = 90,
    layer: str | None = None,
):
    """Return normalized matrix plus intermediate accessibility/raw/coverage arrays."""
    accessibility, n_reads = build_accessibility_matrix(
        state,
        query,
        actual_bin_size,
        signal_type=signal_type,
        subnuc_threshold=subnuc_threshold,
        layer=layer,
    )

    if normalization == 'correlation':
        matrix = normalize_correlation(accessibility, min_coverage)
        raw, coverage = compute_raw_matrix(accessibility, min_coverage)
    else:
        raw, coverage = compute_raw_matrix(accessibility, min_coverage)
        if normalization == 'oe':
            matrix = normalize_oe_marginal(raw, accessibility)
        elif normalization == 'oe_distance':
            matrix = normalize_oe_distance(raw)
        else:
            matrix = raw.copy()
            np.fill_diagonal(matrix, np.nan)

    return matrix, accessibility, n_reads, raw, coverage
