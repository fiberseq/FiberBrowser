"""Dynamic cluster assignment helpers."""
from __future__ import annotations
from services.read_selection import read_body_spans, body_overlap
from services.read_metrics import read_covers_regions

import numpy as np

from services.clustering_features import (
    class_aware_pattern_slices, extract_features_from_compact, extract_features_grouped,
)

UNASSIGNED_CLUSTER_ID = -1


def compute_cluster_centroids_from_compact(
    compact_reads: list[dict],
    peaks: list[list[int]],
    region_start: int,
    assignments: dict,
    *,
    subnucleosomal_threshold: int,
    peak_modes: list[str] | None = None,
    cluster_feature_rules: list[dict] | None = None,
    cluster_rule_context: dict | None = None,
    window_groups: dict | None = None,
) -> tuple[dict[int, list[float]], list[int]]:
    """Per-cluster mean feature vector (centroid) for nearest-centroid reassignment.

    Returns ``(centroids, peak_widths)`` where centroids maps cluster id ->
    feature-space mean and peak_widths gives the per-peak feature-column counts
    (needed to mask partial-overlap reads during aggressive reassignment).
    """
    features, read_ids, peak_widths, _ = extract_features_grouped(
        compact_reads,
        peaks,
        region_start,
        window_groups,
        step=10,
        subnucleosomal_threshold=subnucleosomal_threshold,
        peak_modes=peak_modes,
        cluster_feature_rules=cluster_feature_rules,
        cluster_rule_context=cluster_rule_context,
    )
    return compute_cluster_centroids_from_features(features, read_ids, peak_widths, assignments)


def compute_cluster_centroids_from_features(features, read_ids, peak_widths, assignments):
    """Reuse the fitting features while preserving per-row summation and ID semantics."""
    if features.size == 0:
        return {}, list(peak_widths)

    sums: dict[int, np.ndarray] = {}
    counts: dict[int, int] = {}
    for idx, read_id in enumerate(read_ids):
        cluster = assignments.get(read_id)
        if cluster is None:
            continue
        cluster = int(cluster)
        if cluster == UNASSIGNED_CLUSTER_ID:
            continue
        if cluster not in sums:
            sums[cluster] = np.zeros(features.shape[1], dtype=np.float64)
            counts[cluster] = 0
        sums[cluster] += features[idx]
        counts[cluster] += 1

    centroids = {
        cluster: (sums[cluster] / counts[cluster]).astype(np.float32).tolist()
        for cluster in sums
        if counts[cluster] > 0
    }
    return centroids, list(peak_widths)


def assign_reads_to_centroids(
    reads: list[dict],
    peaks: list[list[int]],
    centroids: dict,
    peak_widths: list[int] | None,
    *,
    region_start: int = 0,
    subnucleosomal_threshold: int,
    peak_modes: list[str] | None = None,
    overlap_mode: str = "conservative",
    cluster_feature_rules: list[dict] | None = None,
    cluster_rule_context: dict | None = None,
    metric_cohort: dict | None = None,
) -> dict:
    """Assign reads to the nearest cluster centroid (kmeans-style redistribution).

    ``metric_cohort``: the fit's molecule metric cohort (clustering_features ``fitted_metric_cohort``), so a metric
    column ranks these reads against the reads the centroids were fitted on, not against each other (None: a model
    saved without one, ranked against these reads as before).

    ``overlap_mode``:
      - ``"conservative"``: a read must overlap EVERY clustering peak, otherwise
        it goes to the Unassigned (-1) bucket.
      - ``"aggressive"``: a read overlapping at least one peak is assigned using
        only feature dimensions at observed body positions. Holes within a
        peak are missing in both modes, rather than closed signal.
    """
    if not reads or not centroids or not peaks:
        return {"assignments": {}, "cluster_counts": {}, "filtered_read_ids": []}

    centroid_keys = sorted(centroids, key=int)
    centroid_ids = [int(c) for c in centroid_keys]
    centroid_matrix = np.array([centroids[c] for c in centroid_keys], dtype=np.float32)

    features, read_ids, feat_peak_widths, feat_modes = extract_features_from_compact(
        reads,
        peaks,
        region_start,
        step=10,
        subnucleosomal_threshold=subnucleosomal_threshold,
        peak_modes=peak_modes,
        cluster_feature_rules=cluster_feature_rules,
        cluster_rule_context=cluster_rule_context,
        metric_cohort=metric_cohort or None,
    )
    if features.size == 0:
        return {"assignments": {}, "cluster_counts": {}, "filtered_read_ids": []}

    widths = [int(w) for w in (peak_widths or feat_peak_widths)]
    # Centroid layout must match the current feature extraction or masking breaks.
    if centroid_matrix.shape[1] != features.shape[1] or widths != list(feat_peak_widths):
        return {"assignments": {}, "cluster_counts": {}, "filtered_read_ids": []}
    slices = class_aware_pattern_slices(widths, feat_modes, cluster_feature_rules)
    n_peaks = len(peaks)
    aggressive = overlap_mode == "aggressive"

    assignments: dict[str, int] = {}
    cluster_counts: dict[int, int] = {}

    def _mark_unassigned(read_id: str) -> None:
        assignments[read_id] = UNASSIGNED_CLUSTER_ID
        cluster_counts[UNASSIGNED_CLUSTER_ID] = cluster_counts.get(UNASSIGNED_CLUSTER_ID, 0) + 1

    for idx, read_id in enumerate(read_ids):
        overlaps = read_peak_overlap_weights(reads[idx], peaks)
        overlapping_peaks = [i for i, weight in enumerate(overlaps) if weight > 0]
        if not overlapping_peaks:
            _mark_unassigned(read_id)
            continue
        if not aggressive and len(overlapping_peaks) < n_peaks:
            _mark_unassigned(read_id)
            continue

        spans = read_body_spans(reads[idx])
        cols: list[int] = []
        for peak_idx, offset, width, is_class in slices:
            if not overlaps[peak_idx]:
                continue
            if is_class:
                # Class bits summarize the observed part of the entire peak;
                # they are not positions on the spatial sampling grid.
                cols.extend(range(offset, offset + width))
            else:
                left = int(peaks[peak_idx][0])
                cols.extend(offset + j for j in range(width)
                            if any(a <= left + j * 10 < b for a, b in spans))
        if not cols:
            _mark_unassigned(read_id)
            continue
        vec = features[idx, cols]
        cmat = centroid_matrix[:, cols]

        distances = np.linalg.norm(cmat - vec[None, :], axis=1)
        cluster = centroid_ids[int(np.argmin(distances))]
        assignments[read_id] = cluster
        cluster_counts[cluster] = cluster_counts.get(cluster, 0) + 1

    return {
        "assignments": assignments,
        "cluster_counts": cluster_counts,
        "filtered_read_ids": list(assignments.keys()),
    }


def build_pattern_to_cluster(cluster_patterns: dict) -> dict:
    """Invert cluster pattern payloads into tuple-pattern lookup keys."""
    return {
        tuple(pattern): int(cluster_id)
        for cluster_id, pattern in cluster_patterns.items()
    }


def read_peak_overlap_weights(read: dict, peaks: list[list[int]]) -> tuple[int, ...]:
    """Return per-peak overlap widths between one read and cluster-defining peaks."""
    intervals = [iv for iv in read.get("intervals", []) if len(iv) >= 2]
    if not intervals:
        return tuple(0 for _ in peaks)

    weights = []
    for peak_start, peak_end in peaks:
        weights.append(body_overlap(read, int(peak_start), int(peak_end)))
    return tuple(weights)


def read_accessibility_pattern(
    read: dict,
    peaks: list[list[int]],
    *,
    subnucleosomal_threshold: int,
    accessibility_threshold: float,
) -> tuple[int, ...]:
    """Compute the binary accessibility pattern used for dynamic clustering."""
    intervals = read.get("intervals", [])
    if not intervals:
        return tuple(0 for _ in peaks)

    pattern_bits = []

    for peak_start, peak_end in peaks:
        peak_width = peak_end - peak_start
        if peak_width <= 0:
            pattern_bits.append(0)
            continue

        if not read_covers_regions(read, [[peak_start, peak_end]]):
            pattern_bits.append(0)
            continue

        inaccessible_count = 0
        for iv_start, iv_end, iv_size in intervals:
            if iv_start >= peak_end:
                break
            if iv_size >= subnucleosomal_threshold:
                ov_start = max(iv_start, peak_start)
                ov_end = min(iv_end, peak_end)
                if ov_end > ov_start:
                    inaccessible_count += ov_end - ov_start

        accessibility = (peak_width - inaccessible_count) / peak_width
        pattern_bits.append(1 if accessibility > accessibility_threshold else 0)

    return tuple(pattern_bits)


def read_accessibility_pattern_by_overlap(
    read: dict,
    peaks: list[list[int]],
    *,
    subnucleosomal_threshold: int,
    accessibility_threshold: float,
) -> tuple[tuple[int, ...], tuple[int, ...]]:
    """Compute accessibility bits using only the read-overlapped part of each peak."""
    intervals = [iv for iv in read.get("intervals", []) if len(iv) >= 2]
    if not intervals:
        return tuple(0 for _ in peaks), tuple(0 for _ in peaks)

    read_start_rel = min(int(iv[0]) for iv in intervals if len(iv) >= 2)
    read_end_rel = max(int(iv[1]) for iv in intervals if len(iv) >= 2)
    pattern_bits = []
    overlap_weights = []

    for peak_start, peak_end in peaks:
        overlap_start = max(int(peak_start), read_start_rel)
        overlap_end = min(int(peak_end), read_end_rel)
        overlap_width = body_overlap(read, int(peak_start), int(peak_end))
        overlap_weights.append(overlap_width)
        if overlap_width <= 0:
            pattern_bits.append(0)
            continue

        inaccessible_count = 0
        for iv_start, iv_end, iv_size in intervals:
            if iv_start >= overlap_end:
                break
            if iv_size >= subnucleosomal_threshold:
                ov_start = max(iv_start, overlap_start)
                ov_end = min(iv_end, overlap_end)
                if ov_end > ov_start:
                    inaccessible_count += ov_end - ov_start

        accessibility = (overlap_width - inaccessible_count) / overlap_width
        pattern_bits.append(1 if accessibility > accessibility_threshold else 0)

    return tuple(pattern_bits), tuple(overlap_weights)


def match_pattern_to_cluster(
    pattern: tuple[int, ...],
    pattern_to_cluster: dict,
    overlap_weights: tuple[int, ...] | None = None,
) -> int:
    """Return exact cluster match or closest cluster, optionally masking non-overlapped peaks."""
    weights = overlap_weights or ()
    has_overlap_weights = any(weight > 0 for weight in weights)
    if not has_overlap_weights and pattern in pattern_to_cluster:
        return pattern_to_cluster[pattern]

    min_dist = float("inf")
    min_full_dist = float("inf")
    closest_cluster = 0
    for ref_pattern, ref_cluster in pattern_to_cluster.items():
        if has_overlap_weights:
            dist = sum(
                weight
                for a, b, weight in zip(pattern, ref_pattern, weights)
                if weight > 0 and a != b
            )
        else:
            dist = sum(a != b for a, b in zip(pattern, ref_pattern))
        full_dist = sum(a != b for a, b in zip(pattern, ref_pattern))
        if (
            dist < min_dist
            or (dist == min_dist and full_dist < min_full_dist)
            or (dist == min_dist and full_dist == min_full_dist and ref_cluster < closest_cluster)
        ):
            min_dist = dist
            min_full_dist = full_dist
            closest_cluster = ref_cluster
    return closest_cluster


def assign_reads_to_cluster_patterns(
    reads: list[dict],
    peaks: list[list[int]],
    cluster_patterns: dict,
    *,
    region_start: int = 0,
    subnucleosomal_threshold: int,
    accessibility_threshold: float,
    peak_modes: list[str] | None = None,
    overlap_mode: str = "aggressive",
    cluster_feature_rules: list[dict] | None = None,
    cluster_rule_context: dict | None = None,
    metric_cohort: dict | None = None,
) -> dict:
    """Assign reads to existing cluster patterns for dynamic clustering.

    Bits are computed exactly as the initial clustering does (the same feature
    extraction: 10-bp samples, FIRE/MSP calls when present, class bits), so a
    read keeps its pattern when nothing about it changed. A read covering only
    part of a peak is judged on the samples it covers.

    ``overlap_mode`` as for centroids: ``"conservative"`` sends a read that
    misses any clustering peak to Unassigned; ``"aggressive"`` assigns every
    read overlapping at least one peak. ``metric_cohort`` as for centroids: a
    molecule metric bit is the read's rank among the fitted reads.
    """
    from services.clustering_features import class_aware_pattern_slices

    step = 10
    pattern_to_cluster = build_pattern_to_cluster(cluster_patterns)
    assignments = {}
    cluster_counts = {}
    peak_modes = peak_modes or ["accessibility"] * len(peaks)

    features, read_ids, peak_widths, _ = extract_features_from_compact(
        reads,
        peaks,
        region_start,
        step=step,
        subnucleosomal_threshold=subnucleosomal_threshold,
        peak_modes=peak_modes,
        cluster_feature_rules=cluster_feature_rules,
        cluster_rule_context=cluster_rule_context,
        metric_cohort=metric_cohort or None,
    )
    if features.size == 0:
        return {"assignments": {}, "cluster_counts": {}, "filtered_read_ids": []}
    pattern_slices = class_aware_pattern_slices(peak_widths, peak_modes, cluster_feature_rules)
    conservative = overlap_mode == "conservative"

    for read_idx, read_id in enumerate(read_ids):
        read = reads[read_idx]
        overlap_weights = read_peak_overlap_weights(read, peaks)
        missed = [weight <= 0 for weight in overlap_weights]
        if all(missed) or (conservative and any(missed)):
            assignments[read_id] = UNASSIGNED_CLUSTER_ID
            cluster_counts[UNASSIGNED_CLUSTER_ID] = cluster_counts.get(UNASSIGNED_CLUSTER_ID, 0) + 1
            continue
        spans = [iv for iv in read.get("intervals", []) if len(iv) >= 2]
        pattern_bits = []
        for peak_idx, offset, width, is_class in pattern_slices:
            if width <= 0:
                pattern_bits.append(0)
                continue
            values = features[read_idx, offset:offset + width]
            if not is_class:
                # Sample j of a peak is at its left edge + j*step: keep the covered ones.
                sample_pos = int(peaks[peak_idx][0]) + step * np.arange(width)
                values = values[np.asarray([any(a <= p < b for a, b in read_body_spans(read)) for p in sample_pos])]
            threshold = 0.5 if is_class else accessibility_threshold
            pattern_bits.append(1 if values.size and values.mean() > threshold else 0)
        class_overlap_weights = [overlap_weights[i] for i, _, _, _ in pattern_slices]
        cluster = match_pattern_to_cluster(tuple(pattern_bits), pattern_to_cluster, class_overlap_weights)
        assignments[read_id] = cluster
        cluster_counts[cluster] = cluster_counts.get(cluster, 0) + 1

    return {
        "assignments": assignments,
        "cluster_counts": cluster_counts,
        "filtered_read_ids": list(assignments.keys()),
    }
