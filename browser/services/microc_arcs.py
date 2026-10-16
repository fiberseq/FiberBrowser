"""Interaction-arc construction and scoring for Micro-C tracks."""
from __future__ import annotations

from typing import Optional

import numpy as np


def build_interaction_arcs(
    matrix,
    *,
    start: int,
    resolution: int,
    min_dist_bins: int,
    max_dist_bins: int,
    expected_per_dist=None,
    bin_accessibility=None,
    mean_accessibility: Optional[float] = None,
    acc_log: bool = False,
) -> list[dict]:
    """Build interaction arcs from a dense contact matrix."""
    matrix = np.asarray(matrix)
    expected = None if expected_per_dist is None else np.asarray(expected_per_dist, dtype=np.float64)
    accessibility = None if bin_accessibility is None else np.asarray(bin_accessibility, dtype=np.float64)
    n = matrix.shape[0]
    arcs = []

    min_dist = max(1, min_dist_bins)
    max_dist = min(max_dist_bins, n - 1)
    for dist_bins in range(min_dist, max_dist + 1):
        rows = np.arange(0, n - dist_bins)
        cols = rows + dist_bins
        counts = matrix[rows, cols].astype(np.float64, copy=False)
        has_contact = counts > 0
        if not np.any(has_contact):
            continue

        rows = rows[has_contact]
        cols = cols[has_contact]
        counts = counts[has_contact]
        starts = start + rows * resolution + resolution // 2
        ends = start + cols * resolution + resolution // 2

        oe_raw_values = np.full(len(counts), None, dtype=object)
        oe_values = np.full(len(counts), None, dtype=object)
        if expected is not None and dist_bins < len(expected):
            raw = counts / expected[dist_bins]
            corrected = raw

            if accessibility is not None and mean_accessibility is not None:
                valid_acc = (rows < len(accessibility)) & (cols < len(accessibility))
                if np.any(valid_acc):
                    norm_i = accessibility[rows[valid_acc]] / mean_accessibility
                    norm_j = accessibility[cols[valid_acc]] / mean_accessibility
                    if acc_log:
                        corrected_subset = np.exp(
                            np.log(np.maximum(raw[valid_acc], 0.001))
                            - np.log(np.maximum(1.0, norm_i))
                            - np.log(np.maximum(1.0, norm_j))
                        )
                    else:
                        corrected_subset = raw[valid_acc] / (
                            np.maximum(1.0, norm_i) * np.maximum(1.0, norm_j)
                        )
                    corrected = raw.astype(np.float64, copy=True)
                    corrected[valid_acc] = corrected_subset

            oe_raw_values = raw.astype(object)
            oe_values = corrected.astype(object)

        for row_start, col_end, count, oe_ratio, oe_ratio_raw in zip(
            starts,
            ends,
            counts,
            oe_values,
            oe_raw_values,
        ):
            arcs.append({
                "start": int(row_start),
                "end": int(col_end),
                "count": int(count),
                "oe_ratio": None if oe_ratio is None else float(oe_ratio),
                "oe_ratio_raw": None if oe_ratio_raw is None else float(oe_ratio_raw),
                "distance": dist_bins * resolution,
            })

    arcs.sort(key=lambda arc: (arc["start"], arc["end"]))
    return arcs


def merge_interaction_arcs(arcs: list[dict], merge_bin: int) -> list[dict]:
    """Cluster nearby arcs by start/end proximity."""
    if merge_bin <= 0 or not arcs:
        return arcs

    arcs_sorted = sorted(arcs, key=lambda arc: (arc["start"], arc["end"]))
    clusters = []

    for arc in arcs_sorted:
        merged = False
        for cluster in clusters:
            start_dist = abs(arc["start"] - cluster["center_start"])
            end_dist = abs(arc["end"] - cluster["center_end"])

            if start_dist <= merge_bin and end_dist <= merge_bin:
                cluster["total_count"] += arc["count"]
                cluster["weighted_start"] += arc["start"] * arc["count"]
                cluster["weighted_end"] += arc["end"] * arc["count"]
                if arc["oe_ratio"] is not None:
                    cluster["weighted_oe"] += arc["oe_ratio"] * arc["count"]
                    cluster["oe_count"] += arc["count"]
                cluster["min_start"] = min(cluster["min_start"], arc["start"])
                cluster["max_start"] = max(cluster["max_start"], arc["start"])
                cluster["min_end"] = min(cluster["min_end"], arc["end"])
                cluster["max_end"] = max(cluster["max_end"], arc["end"])
                cluster["center_start"] = cluster["weighted_start"] / cluster["total_count"]
                cluster["center_end"] = cluster["weighted_end"] / cluster["total_count"]
                merged = True
                break

        if not merged:
            clusters.append({
                "center_start": arc["start"],
                "center_end": arc["end"],
                "total_count": arc["count"],
                "weighted_start": arc["start"] * arc["count"],
                "weighted_end": arc["end"] * arc["count"],
                "weighted_oe": arc["oe_ratio"] * arc["count"] if arc["oe_ratio"] is not None else 0,
                "oe_count": arc["count"] if arc["oe_ratio"] is not None else 0,
                "min_start": arc["start"],
                "max_start": arc["start"],
                "min_end": arc["end"],
                "max_end": arc["end"],
            })

    merged_arcs = []
    for cluster in clusters:
        if cluster["total_count"] == 0:
            continue
        avg_start = int(cluster["weighted_start"] / cluster["total_count"])
        avg_end = int(cluster["weighted_end"] / cluster["total_count"])
        avg_oe = cluster["weighted_oe"] / cluster["oe_count"] if cluster["oe_count"] > 0 else None

        merged_arcs.append({
            "start": avg_start,
            "end": avg_end,
            "count": cluster["total_count"],
            "oe_ratio": avg_oe,
            "distance": avg_end - avg_start,
            "start_range": (cluster["min_start"], cluster["max_start"]),
            "end_range": (cluster["min_end"], cluster["max_end"]),
        })

    return merged_arcs


def score_interaction_arcs(
    arcs: list[dict],
    *,
    normalization: str,
    oe_floor: float,
    min_count: int,
    stable_strength: bool,
    threshold: float,
    max_arcs: int,
) -> list[dict]:
    """Filter and annotate arcs with display strength."""
    if not arcs:
        return arcs

    if oe_floor > 0 and normalization in ("oe", "oe_global"):
        arcs = [arc for arc in arcs if arc.get("oe_ratio") is not None and arc["oe_ratio"] >= oe_floor]

    if min_count > 0:
        arcs = [arc for arc in arcs if arc["count"] >= min_count]

    if not arcs:
        return arcs

    if stable_strength and normalization in ("oe", "oe_global"):
        for arc in arcs:
            arc["strength"] = arc["oe_ratio"] if arc["oe_ratio"] is not None else 0

        if min_count == 0:
            arcs = [arc for arc in arcs if arc["strength"] >= threshold]

        arcs.sort(key=lambda arc: arc["strength"], reverse=True)
        if min_count == 0:
            arcs = arcs[:max_arcs]
        return arcs

    if min_count > 0:
        arcs.sort(key=lambda arc: arc["count"], reverse=True)
        max_count = max(arc["count"] for arc in arcs) if arcs else 1
        for arc in arcs:
            arc["strength"] = arc["count"] / max_count
        return arcs

    if normalization in ("oe", "oe_global"):
        for arc in arcs:
            arc["strength"] = arc["oe_ratio"] if arc["oe_ratio"] is not None else 0
        max_oe = max(arc["strength"] for arc in arcs) if arcs else 1
        if max_oe > 0:
            for arc in arcs:
                arc["strength"] = arc["strength"] / max_oe
    else:
        max_strength = max(arc["count"] for arc in arcs) if arcs else 1
        for arc in arcs:
            arc["strength"] = arc["count"] / max_strength

    arcs = [arc for arc in arcs if arc["strength"] >= threshold]
    arcs.sort(key=lambda arc: arc["strength"], reverse=True)
    return arcs[:max_arcs]
