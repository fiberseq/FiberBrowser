"""Analysis helpers for per-read annotation overlays."""
from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from typing import Any

import numpy as np


AnnotationTuple = tuple[int, int, str, float]
AnnotationDict = Mapping[str, Sequence[AnnotationTuple]]


def merge_annotation_dicts(
    annotation_dicts: Iterable[AnnotationDict],
) -> dict[str, list[AnnotationTuple]]:
    """Merge per-file annotation dictionaries without mutating callers."""
    merged: dict[str, list[AnnotationTuple]] = {}
    for ann_dict in annotation_dicts:
        for read_name, annotations in ann_dict.items():
            merged.setdefault(read_name, []).extend(annotations)
    return merged


def filter_reads_by_annotation_types(
    annotation_dicts: Iterable[AnnotationDict],
    annotation_types: Sequence[str],
    filter_mode: str = "has_any",
    universe_read_ids: Sequence[str] | None = None,
) -> dict[str, Any]:
    """Filter read IDs by annotation-type presence using router-compatible modes."""
    all_types_by_read: dict[str, set[str]] = {}
    universe = {str(read_name) for read_name in universe_read_ids} if universe_read_ids is not None else None
    if universe_read_ids is not None:
        for read_name in universe_read_ids:
            all_types_by_read.setdefault(str(read_name), set())

    for ann_dict in annotation_dicts:
        for read_name, annotations in ann_dict.items():
            if universe is not None and read_name not in universe:
                continue
            read_types = all_types_by_read.setdefault(read_name, set())
            for annotation in annotations:
                read_types.add(annotation[2])

    target_types = set(annotation_types)
    matching_reads: list[str] = []
    for read_name, read_types in all_types_by_read.items():
        overlap = read_types & target_types
        if filter_mode == "has_any" and overlap:
            matching_reads.append(read_name)
        elif filter_mode == "has_all" and overlap == target_types:
            matching_reads.append(read_name)
        elif filter_mode == "lacks_all" and not overlap:
            matching_reads.append(read_name)

    return {
        "read_ids": matching_reads,
        "total": len(all_types_by_read),
        "filtered": len(matching_reads),
    }


def build_annotation_feature_matrix(
    annotations_by_read: AnnotationDict,
    peak_regions: Sequence[Mapping[str, int]],
    annotation_types: Sequence[str],
) -> tuple[np.ndarray, list[str]]:
    """Build binary features over peak x annotation-type overlaps."""
    read_names = list(annotations_by_read.keys())
    n_features = len(peak_regions) * len(annotation_types)
    feature_matrix = np.zeros((len(read_names), n_features), dtype=np.int8)

    for read_idx, read_name in enumerate(read_names):
        read_annotations = annotations_by_read[read_name]
        for peak_idx, peak in enumerate(peak_regions):
            peak_start = peak["start"]
            peak_end = peak["end"]
            for type_idx, annotation_type in enumerate(annotation_types):
                feature_idx = peak_idx * len(annotation_types) + type_idx
                for annotation in read_annotations:
                    if (
                        annotation[2] == annotation_type
                        and annotation[0] < peak_end
                        and annotation[1] > peak_start
                    ):
                        feature_matrix[read_idx, feature_idx] = 1
                        break

    return feature_matrix, read_names


def cluster_reads_by_annotation_patterns(
    annotation_dicts: Iterable[AnnotationDict],
    peak_regions: Sequence[Mapping[str, int]],
    annotation_types: Sequence[str],
    method: str = "combinatorial",
    k: int = 5,
    random_state: int = 42,
) -> dict[str, Any]:
    """Cluster reads by annotation-overlap patterns."""
    annotations_by_read = merge_annotation_dicts(annotation_dicts)
    if not annotations_by_read:
        return {"assignments": {}, "order": [], "patterns": {}}

    feature_matrix, read_names = build_annotation_feature_matrix(
        annotations_by_read,
        peak_regions,
        annotation_types,
    )

    if method == "combinatorial":
        pattern_to_reads: dict[tuple[int, ...], list[str]] = {}
        for read_idx, read_name in enumerate(read_names):
            pattern = tuple(feature_matrix[read_idx].tolist())
            pattern_to_reads.setdefault(pattern, []).append(read_name)

        sorted_patterns = sorted(
            pattern_to_reads.items(),
            key=lambda item: -len(item[1]),
        )

        assignments: dict[str, int] = {}
        order: list[int] = []
        patterns: dict[int, list[int]] = {}
        for cluster_id, (pattern, reads) in enumerate(sorted_patterns):
            order.append(cluster_id)
            patterns[cluster_id] = list(pattern)
            for read_name in reads:
                assignments[read_name] = cluster_id

        return {"assignments": assignments, "order": order, "patterns": patterns}

    from sklearn.cluster import KMeans

    n_clusters = min(k, len(read_names))
    if n_clusters < 2:
        return {
            "assignments": {read_name: 0 for read_name in read_names},
            "order": [0],
            "patterns": {},
        }

    kmeans = KMeans(n_clusters=n_clusters, n_init=10, random_state=random_state)
    labels = kmeans.fit_predict(feature_matrix)

    return {
        "assignments": {
            read_name: int(labels[i])
            for i, read_name in enumerate(read_names)
        },
        "order": list(range(n_clusters)),
        "patterns": {},
    }
