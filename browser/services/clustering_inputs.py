"""Input preparation helpers for clustering endpoints."""
from __future__ import annotations

from typing import Any, Dict, List

import numpy as np

from services.analysis_query import AnalysisReadQuery
from services.clustering_features import extract_features_from_compact


METHYLATION_CLUSTER_MODES = {"mod", "modification", "m6a", "m5c", "deam"}
PRIMARY_INTERVAL_CLUSTER_MODES = {"off", "accessibility"}


def cluster_modes_need_methylation(peak_modes: List[str]) -> bool:
    return any((mode or "").lower() in METHYLATION_CLUSTER_MODES for mode in peak_modes)


def _modes_need_all_layers(peak_modes: List[str]) -> bool:
    for mode in peak_modes:
        normalized = (mode or "").lower()
        if normalized.startswith("cluster_rule:"):
            return True
        if normalized in PRIMARY_INTERVAL_CLUSTER_MODES:
            continue
        if normalized in METHYLATION_CLUSTER_MODES:
            continue
        return True
    return False


def cluster_modes_need_layers(peak_modes: List[str]) -> bool:
    """Return True when feature extraction needs non-primary interval payloads.

    Accessibility features prefer a read's MSP calls when it has them, so an
    accessibility peak needs the MSP layer too: without it the same read gives
    a different feature depending on whether another peak happened to load layers.
    """
    if _modes_need_all_layers(peak_modes):
        return True
    return any((mode or "").lower() == "accessibility" for mode in peak_modes)


def cluster_modes_requested_layers(peak_modes: List[str]) -> list[str] | None:
    """The layer subset feature extraction reads: None = every layer, else just MSP."""
    if _modes_need_all_layers(peak_modes):
        return None
    if any((mode or "").lower() == "accessibility" for mode in peak_modes):
        return ["msp"]
    return None


def active_peak_regions(peak_regions: List[Any], region_start: int) -> tuple[list[list[int]], list[str]]:
    """Convert absolute request peak regions to active region-relative peaks."""
    peaks = []
    peak_modes = []
    for peak in peak_regions:
        mode = getattr(peak, "mode", "accessibility")
        if mode == "off":
            continue
        if mode == "tf_density":  # the peak scan's source name for the TF feature
            mode = "tf"
        peaks.append([int(getattr(peak, "start")) - region_start, int(getattr(peak, "end")) - region_start])
        peak_modes.append(mode)
    return peaks, peak_modes


def prefix_compact_read(read: dict, dataset_key: str) -> dict:
    """Return a shallow copy with a dataset-prefixed ID for joint feature matrices."""
    original_id = read.get("analysis_id") or read["id"]
    return {
        **read,
        "_original_id": original_id,
        **({"analysis_id": f"{dataset_key}::{original_id}"} if read.get("analysis_id") else {}),
        "id": f"{dataset_key}::{original_id}",
    }


def split_prefixed_read_id(read_id: str, fallback_dataset: str) -> tuple[str, str]:
    parts = read_id.split("::", 1)
    if len(parts) == 2:
        return parts[0], parts[1]
    return fallback_dataset, read_id


def collect_assigned_feature_rows(
    state,
    dataset_ids: List[str],
    chrom: str,
    start: int,
    end: int,
    spanning: bool,
    assignments_by_dataset: Dict[str, Dict[str, int]],
    peaks: list[list[int]],
    peak_modes: list[str],
    subnucleosomal_threshold: int,
    sample_seed: str,
    cluster_feature_rules: list[dict[str, Any]] | None = None,
    cluster_rule_context: dict[str, Any] | None = None,
    query: AnalysisReadQuery | None = None,
) -> tuple[list[np.ndarray], list[tuple[str, str]], list[int]]:
    """Build feature rows for reads that already have cluster assignments."""
    from services.lift.capability import require_for_ids
    require_for_ids(state, dataset_ids, "clustering")
    include_methylation = cluster_modes_need_methylation(peak_modes)
    include_layers = cluster_modes_need_layers(peak_modes)
    requested_layers = cluster_modes_requested_layers(peak_modes)
    query = query or AnalysisReadQuery.from_request(
        state,
        chrom=chrom,
        start=start,
        end=end,
        spanning=spanning,
        dataset_ids=dataset_ids,
        sample_seed=sample_seed,
        include_methylation=include_methylation,
        include_layers=include_layers,
        requested_layers=requested_layers,
    )
    dataset_ids = query.dataset_ids

    all_features = []
    all_read_ids = []
    all_assignments = []

    for ds_id in dataset_ids:
        ds_assignments = assignments_by_dataset.get(ds_id, {})
        if not ds_assignments:
            continue

        requested = query.read_ids_for_dataset(ds_id)
        from services.read_selection import read_matches_id_filter
        from services.cluster_sample import using_assigned_cluster_reads
        allowed = set(requested) if requested is not None else None
        assigned_scope = [read_id for read_id in ds_assignments
                          if allowed is None or read_matches_id_filter(read_id, allowed)]
        with using_assigned_cluster_reads():
            working_set = query.build_working_set(state, ds_id, read_ids=assigned_scope)
        if not working_set.reads:
            continue

        assigned_ids = set(ds_assignments.keys())
        reads_to_use = [read for read in working_set.reads if read_matches_id_filter(read, assigned_ids)]
        if not reads_to_use:
            continue

        feature_kwargs = {}
        if cluster_feature_rules is not None:
            feature_kwargs["cluster_feature_rules"] = cluster_feature_rules
        if cluster_rule_context is not None:
            feature_kwargs["cluster_rule_context"] = cluster_rule_context
        features, read_ids, _, _ = extract_features_from_compact(
            # Saved footprint-class features look reads up by dataset and chromosome.
            [prefix_compact_read({**read, '_consensus_dataset_id': ds_id, '_consensus_chrom': query.chrom}, ds_id)
             for read in reads_to_use],
            peaks,
            start,
            step=10,
            subnucleosomal_threshold=subnucleosomal_threshold,
            peak_modes=peak_modes,
            **feature_kwargs,
        )

        if features.size == 0:
            continue

        for i, read_id in enumerate(read_ids):
            ds, original_id = split_prefixed_read_id(read_id, ds_id)
            all_features.append(features[i])
            all_read_ids.append((ds, original_id))
            all_assignments.append(ds_assignments.get(original_id, -1))

    return all_features, all_read_ids, all_assignments
