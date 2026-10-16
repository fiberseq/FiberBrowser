"""Accessibility track and metaprofile helpers."""
from __future__ import annotations

import numpy as np


def _numeric_signal_columns(reads_df, start=None, end=None):
    return sorted(
        [
            c
            for c in reads_df.columns
            if c != "read_id"
            and not str(c).startswith("_")
            and isinstance(c, (int, np.integer))
            and (start is None or start <= c)
            and (end is None or c < end)
        ]
    )


def scan_for_peaks(reads_df, start, end, n_clusters=8, min_width=80, random_state=42):
    """
    Scan for accessibility peaks using clustering to detect rare states.

    Instead of computing a simple pileup (which drowns out rare peaks),
    we cluster the reads first, then find peaks within each cluster,
    giving equal weight to rare accessible states.

    Returns: list of peak regions [(start, end), ...]
    """
    region_width = end - start

    if reads_df.empty:
        return []

    numeric_cols = _numeric_signal_columns(reads_df)
    if not numeric_cols:
        return []

    arr = reads_df[numeric_cols].to_numpy(dtype=np.float32)
    n_reads = arr.shape[0]

    if n_reads < n_clusters:
        # Never more clusters than reads (KMeans needs n_samples >= n_clusters).
        n_clusters = max(1, min(n_reads, max(2, n_reads // 2)))

    # Create binary accessibility matrix for clustering.
    is_accessible = (arr < 90).astype(np.float32)

    from sklearn.cluster import KMeans

    kmeans = KMeans(n_clusters=n_clusters, random_state=random_state, n_init=10)
    labels = kmeans.fit_predict(is_accessible)

    all_peaks = []
    col_positions = np.array([int(c) - start for c in numeric_cols])

    for cluster_id in range(n_clusters):
        cluster_mask = labels == cluster_id
        cluster_reads = is_accessible[cluster_mask]

        if len(cluster_reads) == 0:
            continue

        cluster_signal = cluster_reads.mean(axis=0)

        signal_at_pos = np.zeros(region_width)
        valid_positions = (col_positions >= 0) & (col_positions < region_width)
        signal_at_pos[col_positions[valid_positions]] = cluster_signal[valid_positions]

        # "same" returns the longer of signal and kernel: keep the kernel no
        # longer than the region, so positions stay the region's.
        smooth = min(30, len(signal_at_pos))
        if smooth > 1:
            signal_at_pos = np.convolve(signal_at_pos, np.ones(smooth) / smooth, mode="same")

        if signal_at_pos.max() < 0.1:
            continue

        threshold = max(0.2, signal_at_pos.mean() + signal_at_pos.std())
        from scipy.signal import find_peaks, peak_widths

        peaks, _ = find_peaks(signal_at_pos, distance=100, height=threshold, width=20)

        if len(peaks) == 0:
            continue

        results = peak_widths(signal_at_pos, peaks, rel_height=0.5)

        for peak_idx, (l, r) in enumerate(zip(results[2].astype(int), results[3].astype(int))):
            width = r - l
            if width >= min_width:
                if width < 150:
                    expand = (150 - width) // 2
                    l, r = max(0, l - expand), min(region_width, r + expand)
                all_peaks.append((l, r, signal_at_pos[peaks[peak_idx]]))

    if not all_peaks:
        return []

    all_peaks.sort(key=lambda x: x[0])
    merged = []
    current_start, current_end, current_score = all_peaks[0]

    for l, r, score in all_peaks[1:]:
        if l <= current_end + 50:
            current_end = max(current_end, r)
            current_score = max(current_score, score)
        else:
            merged.append((current_start, current_end))
            current_start, current_end, current_score = l, r, score
    merged.append((current_start, current_end))

    return merged


def compute_accessibility_track(reads_df, start, end, window=30, random_state=42):
    """
    Compute a simple accessibility visualization track.
    Peak detection is done separately via scan_for_peaks().
    """
    region_width = end - start

    if reads_df.empty:
        return np.zeros(region_width), [], []

    numeric_cols = _numeric_signal_columns(reads_df)
    if not numeric_cols:
        return np.zeros(region_width), [], []

    arr = reads_df[numeric_cols].to_numpy(dtype=np.float32)
    col_positions = np.array([int(c) - start for c in numeric_cols])

    # Dense rows hold 0 (or NaN) where a read doesn't cover the base: those
    # reads say nothing there, so they're left out of each base's mean.
    covered = _covered_mask(arr)
    is_accessible = ((arr < 90) & covered).astype(np.float32)

    signal = np.zeros(region_width)
    valid_positions = (col_positions >= 0) & (col_positions < region_width)
    if np.any(valid_positions):
        n_covered = covered[:, valid_positions].sum(axis=0).astype(float)
        hits = is_accessible[:, valid_positions].sum(axis=0)
        signal[col_positions[valid_positions]] = np.divide(
            hits, n_covered, out=np.zeros_like(n_covered), where=n_covered > 0)

    accessibility = signal

    window = min(int(window), len(accessibility))
    if window > 1:
        kernel = np.ones(window) / window
        accessibility = np.convolve(accessibility, kernel, mode="same")

    if accessibility.max() > 0:
        accessibility = (accessibility / accessibility.max()) * 100

    peaks_regions = scan_for_peaks(reads_df, start, end, random_state=random_state)

    return accessibility, [], peaks_regions


def meta_line_plot(reads_df, start, end, fp_min, fp_max):
    """Calculate metaprofile."""
    cols = _numeric_signal_columns(reads_df, start=start, end=end)
    if not cols:
        return np.array([])

    arr = reads_df[cols].to_numpy(dtype=float)
    # Only reads covering a base count toward its denominator (dense rows are 0
    # where a non-spanning read doesn't reach; 2 is the legacy no-data code).
    counts = (_covered_mask(arr) & (arr != 2)).sum(axis=0).astype(float)
    counts[counts == 0] = 1

    fp_mask = (arr > 2) & (arr > fp_min) & (arr < fp_max)
    return fp_mask.sum(axis=0) / counts


def _covered_mask(arr):
    """Where a dense read row covers the base: footprints are positive sizes,
    gaps negative ones; 0 (or NaN) is outside the read."""
    arr = np.asarray(arr, dtype=float)
    return np.isfinite(arr) & (arr != 0)
