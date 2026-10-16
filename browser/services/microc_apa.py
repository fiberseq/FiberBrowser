"""Aggregate Peak Analysis helpers for Micro-C endpoints."""
from __future__ import annotations

import numpy as np


class CoolerWindows:
    """A chromosome contact matrix read one window at a time.

    Supports ``m[r0:r1, c0:c1]`` (what APA needs) by fetching just that block
    from the cooler, so a whole chromosome is never densified (250 Mb at 1 kb
    would be ~500 GB).
    """

    def __init__(self, clr, chrom: str, resolution: int, nbins: int, *, balance: bool = False,
                 chrom_length: int | None = None):
        self.clr, self.chrom, self.res, self.nbins, self.balance = clr, chrom, int(resolution), int(nbins), balance
        # The last bin may be partial: coordinates stop at the chromosome's end.
        self.chrom_length = int(chrom_length) if chrom_length is not None else self.nbins * self.res
        self.shape = (self.nbins, self.nbins)

    def __getitem__(self, key):
        rows, cols = key
        r0, r1 = max(0, rows.start), min(self.nbins, rows.stop)
        c0, c1 = max(0, cols.start), min(self.nbins, cols.stop)
        if r1 <= r0 or c1 <= c0:
            return np.zeros((max(0, r1 - r0), max(0, c1 - c0)))
        from services.microc_matrix import fetch_cooler_matrix
        region = lambda a, b: (self.chrom, a * self.res, min(b * self.res, self.chrom_length))
        return fetch_cooler_matrix(self.clr, region(r0, r1), region(c0, c1), balance=self.balance)


def compute_apa_from_matrix(
    full_matrix,
    peaks: list[dict],
    *,
    resolution: int,
    window: int,
    chrom_nbins: int | None = None,
    expected_per_dist=None,
) -> dict:
    """Compute aggregate peak analysis from a chromosome contact matrix."""
    if not isinstance(full_matrix, CoolerWindows):
        full_matrix = np.asarray(full_matrix)
    chrom_nbins = chrom_nbins if chrom_nbins is not None else full_matrix.shape[0]
    window_bins = window // resolution
    matrix_size = 2 * window_bins + 1
    aggregate = np.zeros((matrix_size, matrix_size), dtype=np.float64)
    n_pairs = 0
    # O/E: pairs whose window reaches distances the expected curve doesn't
    # cover are left out, not averaged in as raw counts.
    beyond_expected = 0

    sorted_peaks = sorted(peaks, key=lambda peak: peak["start"])
    peak_bins = [(((peak["start"] + peak["end"]) // 2) // resolution) for peak in sorted_peaks]
    expected = None if expected_per_dist is None else np.asarray(expected_per_dist, dtype=np.float64)

    if expected is not None:
        row_offsets = np.arange(matrix_size)[:, None] - window_bins
        col_offsets = np.arange(matrix_size)[None, :] - window_bins

    for i, bin_i in enumerate(peak_bins):
        for bin_j in peak_bins[i + 1:]:
            if bin_j - bin_i < window_bins:
                continue

            row_start = bin_i - window_bins
            row_end = bin_i + window_bins + 1
            col_start = bin_j - window_bins
            col_end = bin_j + window_bins + 1
            if row_start < 0 or col_end > chrom_nbins:
                continue

            submatrix = full_matrix[row_start:row_end, col_start:col_end].astype(float)
            if submatrix.shape != (matrix_size, matrix_size):
                continue

            if expected is not None:
                base_dist = bin_j - bin_i
                cell_dist = np.abs(base_dist + col_offsets - row_offsets)
                if (cell_dist >= len(expected)).any():
                    beyond_expected += 1
                    continue
                exp_vals = expected[cell_dist]
                # A distance with no expected contacts has none observed either.
                submatrix = np.divide(submatrix, exp_vals, out=np.zeros_like(submatrix), where=exp_vals > 0)

            aggregate += submatrix
            n_pairs += 1

    if n_pairs == 0:
        return {
            "matrix": [],
            "apa_score": 0,
            "center_value": 0,
            "corner_mean": 0,
            "n_pairs": 0,
            "matrix_size": matrix_size,
            "pairs_beyond_expected": beyond_expected,
        }

    aggregate = aggregate / n_pairs
    center_val = float(aggregate[window_bins, window_bins])
    corner_size = max(1, window_bins // 3)
    corners = [
        aggregate[:corner_size, :corner_size],
        aggregate[:corner_size, -corner_size:],
        aggregate[-corner_size:, :corner_size],
        aggregate[-corner_size:, -corner_size:],
    ]
    corner_mean = float(np.mean([corner.mean() for corner in corners]))
    apa_score = center_val / corner_mean if corner_mean > 0 else 0

    return {
        "matrix": aggregate,
        "apa_score": float(apa_score),
        "center_value": center_val,
        "corner_mean": corner_mean,
        "n_pairs": n_pairs,
        "matrix_size": matrix_size,
        "pairs_beyond_expected": beyond_expected,
    }
