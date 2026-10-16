"""Generic peak detection helpers for binned genomic signal arrays."""
from __future__ import annotations

from collections.abc import Sequence
from typing import Optional

import numpy as np
from scipy.signal import find_peaks, peak_widths


def detect_signal_peaks(
    signal: Sequence[float],
    start: int,
    end: int,
    min_distance_bp: int = 100,
    min_width_bp: int = 80,
    threshold_percentile: float = 30,
    threshold_value: Optional[float] = None,
) -> list[dict]:
    """Detect genomic peak intervals from an arbitrary 1D signal array."""
    signal_array = np.array(signal, dtype=np.float64)
    if len(signal_array) < 3 or end <= start:  # (an empty region has no bin size)
        return []

    region_size = end - start
    bin_size = region_size / len(signal_array)

    # mode="same" returns max(len(signal), len(kernel)): a kernel longer than
    # the signal would stretch the bins past the region.
    kernel_len = min(len(signal_array), max(1, int(30 / bin_size)))
    kernel = np.ones(kernel_len) / kernel_len
    smoothed = np.convolve(signal_array, kernel, mode="same")

    nonzero = smoothed[smoothed > 0]
    if len(nonzero) < 3:
        return []
    threshold = float(threshold_value) if threshold_value is not None else float(np.percentile(nonzero, threshold_percentile))

    min_dist_bins = max(1, int(min_distance_bp / bin_size))
    min_width_bins = max(1, int(min_width_bp / bin_size))

    peaks_idx, _ = find_peaks(
        smoothed,
        distance=min_dist_bins,
        height=threshold,
        width=min_width_bins,
    )
    if len(peaks_idx) == 0:
        return []

    widths_result = peak_widths(smoothed, peaks_idx, rel_height=0.5)
    left_ips = widths_result[2].astype(int)
    right_ips = widths_result[3].astype(int)

    peaks = []
    for i, (l_bin, r_bin) in enumerate(zip(left_ips, right_ips)):
        peak_start = max(start, start + int(l_bin * bin_size))
        peak_end = min(end, start + int(r_bin * bin_size))
        if peak_end - peak_start < min_width_bp:
            expand = (min_width_bp - (peak_end - peak_start)) // 2
            peak_start = max(start, peak_start - expand)
            peak_end = min(end, peak_end + expand)
        if peak_end <= peak_start:
            continue
        peaks.append({
            "start": peak_start,
            "end": peak_end,
            "score": float(smoothed[peaks_idx[i]]),
            "threshold": threshold,
        })

    return peaks
