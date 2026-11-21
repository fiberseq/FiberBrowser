"""Result assembly helpers for clustering endpoints."""
from __future__ import annotations

from typing import Any, Dict, Iterable, Optional


def count_cluster_assignments(assignments: Dict[str, int]) -> dict:
    """Count reads per cluster label."""
    counts = {}
    for cluster in assignments.values():
        counts[cluster] = counts.get(cluster, 0) + 1
    return counts


def element_read_ids_for_result(element_info: Optional[dict], result_key: str) -> dict:
    """Filter combined element read IDs back to one dataset/result key."""
    if not element_info:
        return {}

    prefix = f"{result_key}::"
    filtered = {}
    for elem_idx, read_ids_list in element_info.get("element_read_ids", {}).items():
        filtered[elem_idx] = sorted(
            read_id[len(prefix):]
            for read_id in read_ids_list
            if read_id.startswith(prefix)
        )
    return filtered


def split_prefixed_assignments(assignments: Dict[str, int], result_key: str) -> tuple[dict, list]:
    """Split joint clustering assignments for one result key."""
    prefix = f"{result_key}::"
    ds_assignments = {}
    filtered_ids = []
    for combined_id, cluster in assignments.items():
        if combined_id.startswith(prefix):
            original_id = combined_id[len(prefix):]
            ds_assignments[original_id] = cluster
            filtered_ids.append(original_id)
    return ds_assignments, filtered_ids


def assemble_cluster_all_results(
    *,
    assignments: Dict[str, int],
    dataset_read_ids: Dict[str, list],
    dataset_read_stats: Dict[str, dict],
    dataset_ids: Iterable[str],
    state=None,
    element_info: Optional[dict] = None,
    peaks: Optional[list] = None,
    peak_modes: Optional[list] = None,
    start: int = 0,
    feature_settings: Optional[dict] = None,
) -> dict:
    """Build per-dataset cluster_all results and update base dataset state."""
    dataset_ids = list(dataset_ids)
    dataset_id_set = set(dataset_ids)
    peaks = peaks or []
    results = {}

    for result_key in dataset_read_ids.keys():
        ds_assignments, ds_filtered_ids = split_prefixed_assignments(assignments, result_key)
        # Canonical membership lists also keep ordinary and columnar results
        # identical when the fitting engine visits rows in a different order.
        ds_filtered_ids.sort()

        dataset = state.get_dataset(result_key) if state is not None and result_key in dataset_id_set else None
        if dataset:
            dataset.cluster_assignments = ds_assignments

            if element_info:
                dataset.cluster_element_info = {
                    "n_elements": element_info.get("n_elements"),
                    "cluster_patterns": element_info.get("cluster_patterns"),
                    "element_read_ids": element_read_ids_for_result(element_info, result_key),
                    "method": element_info.get("method"),
                    # Which peak (and class) each pattern bit is, when known.
                    **({"elements": element_info["elements"]} if element_info.get("elements") else {}),
                }
            else:
                dataset.cluster_element_info = None

            dataset.cluster_peak_regions = [
                {
                    "start": start + peak[0],
                    "end": start + peak[1],
                    "mode": peak_modes[i] if peak_modes and i < len(peak_modes) else "accessibility",
                }
                for i, peak in enumerate(peaks)
            ]
            dataset.cluster_feature_settings = dict(feature_settings) if feature_settings else None

        results[result_key] = {
            "assignments": ds_assignments,
            "cluster_counts": count_cluster_assignments(ds_assignments),
            "filtered_read_ids": ds_filtered_ids,
            "working_count": len(dataset_read_ids.get(result_key, [])),
            **dataset_read_stats.get(result_key, {}),
        }

    return results


def merged_cluster_targets(dissolved: Iterable[dict]) -> dict[int, int]:
    """Where each merged-away cluster's reads mostly went (following chains of merges)."""
    direct = {int(d["cluster"]): int(d["dominant_target"]) for d in dissolved
              if d.get("dominant_target") is not None}
    resolved = {}
    for cluster in direct:
        target, seen = direct[cluster], {cluster}
        while target in direct and target not in seen:
            seen.add(target)
            target = direct[target]
        resolved[cluster] = target
    return resolved


def assemble_assignment_array_results(
    *,
    all_read_ids: list[tuple[str, str]],
    assignments,
    dataset_ids: Iterable[str],
    state=None,
    base_assignments: Optional[dict] = None,
    remap: Optional[dict] = None,
) -> dict:
    """Build per-dataset assignment results from aligned read IDs and labels.

    Only reads in the analysed window have features. With `base_assignments`
    (the full map the client sent) the result keeps every other read too; a
    read outside the window whose cluster was merged away follows `remap`.
    """
    results = {}
    remap = remap or {}
    for ds_id in dataset_ids:
        ds_new = {
            str(read_id): int(remap.get(int(cluster), int(cluster)))
            for read_id, cluster in ((base_assignments or {}).get(ds_id) or {}).items()
        }
        for index, (read_dataset_id, original_id) in enumerate(all_read_ids):
            if read_dataset_id == ds_id:
                ds_new[original_id] = int(assignments[index])

        if not ds_new:
            continue

        results[ds_id] = {
            "assignments": ds_new,
            "cluster_counts": {int(k): v for k, v in count_cluster_assignments(ds_new).items()},
        }

        dataset = state.get_dataset(ds_id) if state is not None else None
        if dataset:
            dataset.cluster_assignments = ds_new

    return results
