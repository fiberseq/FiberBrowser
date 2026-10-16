"""Endpoint orchestration helpers for clustering routes."""
from __future__ import annotations

from services.scoped_read_analysis import scoped_analysis

import time
from typing import Any, Dict, Optional

import numpy as np
import pandas as pd

from services.analysis_query import AnalysisReadQuery
from services.cluster_analysis import (
    MERGE_DEFAULT_ALPHA,
    compute_cluster_projection,
    dissolve_cluster_to_nearest,
    resolve_merge_threshold,
    run_autocull_on,
)
from services.cluster_assignment import cluster_compact_reads, cluster_reads
from services.clustering_features import extract_features_from_compact
from services.clustering_inputs import (
    active_peak_regions,
    cluster_modes_need_layers,
    cluster_modes_requested_layers,
    cluster_modes_need_methylation,
    collect_assigned_feature_rows,
    prefix_compact_read,
    split_prefixed_read_id,
)
from services.clustering_results import (
    assemble_assignment_array_results,
    count_cluster_assignments,
    assemble_cluster_all_results,
    merged_cluster_targets,
)
from services.diagnostics import env_flag_enabled, log_if_enabled
from services.peak_scanning import (
    LAYER_SOURCE_PREFIX,
    READ_SIGNAL_SOURCES,
    is_read_signal_source,
    scan_signal_layer_name,
    track_signal_index,
    remember_peak_regions,
    stored_peak_regions_for,
    build_peak_thresholds,
    compute_scan_counts,
    compute_scan_signal,
    DEFAULT_MAX_PEAK_WIDTH,
    detect_threshold_layers,
    downsample_signal_for_response,
    format_peak_scan_results,
    save_peak_scan_diagnostic_plot,
    scan_signal_from_counts,
    scan_signal_needs_layers,
    scan_signal_needs_methylation,
    smooth_scan_signal,
)
from services.read_metrics import (
    compact_reads_to_dataframe,
    filter_reads_covering_regions,
    normalize_sample_seed,
    random_state_from_seed,
    sample_by_coverage,
)
from services.query_params import resolve_dataset_ids
from services.dynamic_clustering import (
    assign_reads_to_centroids,
    assign_reads_to_cluster_patterns,
    compute_cluster_centroids_from_compact,
    compute_cluster_centroids_from_features,
)
from services.gene_annotations import get_gene_region_records
from services.working_sets import find_broad_cache_entry, iter_broad_reads_overlapping_viewport, make_layer_key
from services.read_quality_filters import active_quality_filters


CLUSTER_DIAGNOSTICS_ENV = "FIBERBROWSER_CLUSTER_DIAGNOSTICS"


def clustering_diagnostics_enabled() -> bool:
    return env_flag_enabled(CLUSTER_DIAGNOSTICS_ENV)


def log_clustering_diagnostic(message: str) -> None:
    log_if_enabled(CLUSTER_DIAGNOSTICS_ENV, message)


class EndpointTimings:
    """Small accumulator for endpoint phase timings."""

    def __init__(self) -> None:
        self.started_at = time.perf_counter()
        self.timings: Dict[str, float] = {}

    def add(self, name: str, started_at: float) -> None:
        self.timings[name] = self.timings.get(name, 0.0) + (time.perf_counter() - started_at)

    def attach(self, response: Dict[str, Any]) -> Dict[str, Any]:
        response["timings"] = {
            **{name: round(elapsed, 4) for name, elapsed in self.timings.items()},
            "total": round(time.perf_counter() - self.started_at, 4),
        }
        return response


def active_cluster_peaks(req, state, start: int, chrom: Optional[str] = None,
                         end: Optional[int] = None) -> tuple[list[list[int]], list[str]]:
    """Resolve active peak regions and modes for cluster_all."""
    stored = (stored_peak_regions_for(state, chrom, start, end)
              if chrom is not None and end is not None else (state.peak_regions or []))
    if req.peak_regions:
        peaks, peak_modes = active_peak_regions(req.peak_regions, start)

        mode_counts = {}
        for peak in req.peak_regions:
            mode_counts[peak.mode] = mode_counts.get(peak.mode, 0) + 1
        log_clustering_diagnostic(f"  Peak modes: {mode_counts}")

        if req.method in ("binary", "combinatorial") and "tf" in peak_modes:
            log_clustering_diagnostic(
                "  WARNING: TF mode not supported with combinatorial clustering, treating as accessibility"
            )
            peak_modes = ["accessibility" if mode == "tf" else mode for mode in peak_modes]
        return peaks, peak_modes

    if req.peak_indices:
        peaks = [stored[index] for index in req.peak_indices if index < len(stored)]
        return peaks, ["accessibility"] * len(peaks)

    return stored, ["accessibility"] * len(stored)


def build_cluster_jobs(chrom: str, dataset_ids: list[str], extra_chroms, state) -> list[tuple[str, str, str]]:
    """Build (chrom, dataset_id, result_key) jobs for joint clustering."""
    jobs = [(chrom, dataset_id, dataset_id) for dataset_id in dataset_ids]
    if extra_chroms:
        for extra_chrom in extra_chroms:
            extra_chrom_resolved = state.translate_chrom(extra_chrom)
            for dataset_id in dataset_ids:
                jobs.append((extra_chrom_resolved, dataset_id, f"{dataset_id}_{extra_chrom}"))
    return jobs


def empty_cluster_all_results(dataset_ids: list[str]) -> dict:
    return {
        dataset_id: {"assignments": {}, "cluster_counts": {}, "filtered_read_ids": []}
        for dataset_id in dataset_ids
    }


def build_cluster_rule_context(state, chrom: str, start: int, end: int) -> dict[str, Any]:
    """Build genomic context used by cluster feature rules with label conditions."""
    gene_regions: list[tuple[int, int]] = []
    gene_regions_by_key: dict[str, list[tuple[int, int]]] = {}
    gtf_data = getattr(state, "gtf_data", None)
    if gtf_data:
        for record in get_gene_region_records(gtf_data, chrom, start, end):
            region = (int(record["start"]), int(record["end"]))
            gene_regions.append(region)
            if record.get("id"):
                gene_regions_by_key.setdefault(f"id:{record['id']}", []).append(region)
            if record.get("name"):
                gene_regions_by_key.setdefault(f"name:{str(record['name']).lower()}", []).append(region)
    from services.consensus_occupancy import clustering_class_resolver
    return {
        "resolve_footprint_class": clustering_class_resolver(state, chrom),
        "gene_regions": gene_regions,
        "gene_regions_by_key": gene_regions_by_key,
    }


def stored_cluster_peak_regions(
    state,
    dataset_ids: list[str],
    region_start: int,
) -> tuple[list[list[int]], list[str]]:
    """Return peak regions saved with the current clustering, if present."""
    peaks, peak_modes, _ = stored_cluster_setup(state, dataset_ids, region_start)
    return peaks, peak_modes


def _settings_signature(settings: dict) -> str:
    """A comparable form of a clustering's feature settings (rules, threshold)."""
    import json
    return json.dumps(
        {"rules": settings.get("cluster_feature_rules") or [],
         "threshold": settings.get("subnucleosomal_threshold")},
        sort_keys=True, default=str,
    )


def stored_cluster_setup(
    state,
    dataset_ids: list[str],
    region_start: int,
) -> tuple[list[list[int]], list[str], dict]:
    """The peaks saved with the current clustering and the feature settings
    (rules, threshold) it was built with, from the first clustered dataset."""
    for dataset_id in dataset_ids:
        dataset = state.get_dataset(dataset_id)
        stored = getattr(dataset, "cluster_peak_regions", None) if dataset else None
        if not stored:
            continue
        peaks: list[list[int]] = []
        peak_modes: list[str] = []
        for peak in stored:
            if not isinstance(peak, dict):
                continue
            mode = peak.get("mode", "accessibility")
            if mode == "off":
                continue
            if peak.get("start") is None or peak.get("end") is None:
                continue
            peaks.append([int(peak["start"]) - region_start, int(peak["end"]) - region_start])
            peak_modes.append(mode)
        if peaks:
            return peaks, peak_modes, dict(getattr(dataset, "cluster_feature_settings", None) or {})
    return [], [], {}


def assigned_cluster_feature_rows(
    *,
    state,
    req,
    chrom: str,
    start: int,
    end: int,
    spanning: bool,
    sample_seed: str,
    assignments_by_dataset: dict,
):
    """Resolve peaks/query and collect feature rows for assigned-cluster endpoints."""
    initial_dataset_ids = resolve_dataset_ids(state, dataset_ids=req.dataset_ids)
    peaks, peak_modes = active_peak_regions(req.peak_regions, start)
    # Without explicit peaks, the stored clustering's peaks come with the feature
    # rules and threshold it was built with (a saved cluster rule's features are
    # all zero without its rules).
    stored_settings: dict = {}
    if not peaks:
        peaks, peak_modes, stored_settings = stored_cluster_setup(state, initial_dataset_ids, start)
    if not peaks:
        return None, peaks, peak_modes, ([], [], []), None
    feature_rules = stored_settings.get("cluster_feature_rules") or req.cluster_feature_rules
    threshold = stored_settings.get("subnucleosomal_threshold", req.subnucleosomal_threshold)

    query = AnalysisReadQuery.from_request(
        state,
        chrom=chrom,
        start=start,
        end=end,
        spanning=spanning,
        dataset_ids=req.dataset_ids,
        read_ids_by_dataset=getattr(req, "read_ids", None),
        sample_seed=sample_seed,
        include_methylation=cluster_modes_need_methylation(peak_modes),
        include_layers=cluster_modes_need_layers(peak_modes),
        requested_layers=cluster_modes_requested_layers(peak_modes),
    )
    cluster_rule_context = build_cluster_rule_context(state, query.chrom, start, end)

    rows = collect_assigned_feature_rows(
        state,
        query.dataset_ids,
        query.chrom,
        start,
        end,
        spanning,
        assignments_by_dataset,
        peaks,
        peak_modes,
        threshold,
        sample_seed,
        feature_rules,
        cluster_rule_context,
        query,
    )
    return query.dataset_ids, peaks, peak_modes, rows, query


def _active_quality_filters(state) -> list[dict]:
    return [
        filt
        for filt in active_quality_filters(state)
        if int(filt.get("min_value", 0) or 0) > 0
    ]


def _compute_scan_counts_from_broad_cache(
    *,
    state,
    query: AnalysisReadQuery,
    dataset_id: str,
    signal_source: str,
    region_width: int,
) -> tuple[np.ndarray, np.ndarray, int] | None:
    """Compute peak-scan numerator/denominator counts from a broad read cache."""
    if (getattr(state, 'performance', {}).get('effective') == 'low'
            and getattr(state, 'max_working_reads', 0)
            and query.read_ids_for_dataset(dataset_id) is not None):
        # Explicit scopes are capped before decoding in Low memory, including
        # IDs absent from this viewport. Use the same selection on a warm scan.
        return None
    filters = _active_quality_filters(state)
    if filters and not (
        signal_source in {"accessibility", "tf_density"}
        and all(f.get("layer") in {"fire", "msp"} for f in filters)
    ):
        return None
    # FIRE/MSP quality gates change their overlay only, never the primary
    # footprint/gap intervals used by these two signals. Reuse the display's
    # cached cohort even when it did not load that hidden overlay. Otherwise
    # the default aq gate decodes the entire BAM again to scan a few shown IDs.
    if not hasattr(state, "_broad_cache"):
        return None

    layer_key = make_layer_key(query.include_layers, query.requested_layers)
    dataset = state.get_dataset(dataset_id)
    effective_min_footprints = (
        int(query.min_footprints or 0)
        if dataset is not None
        and getattr(dataset, "available_layers", {}).get("footprint", True)
        else 0
    )
    broad_reads, broad_key = find_broad_cache_entry(
        state,
        dataset_id,
        query.chrom,
        query.start,
        query.end,
        query.include_methylation,
        layer_key,
        time.time(),
        include_layer_qualities=query.include_layer_qualities,
        infer_legacy_layers=query.infer_legacy_layers,
        legacy_nuc_min_size=query.legacy_nuc_min_size,
        min_footprints=effective_min_footprints,
    )
    read_ids = query.read_ids_for_dataset(dataset_id)
    if (broad_reads is None or broad_key is None) and read_ids:
        # The reads a panel shows, all in its sampled display load (a deep view):
        # scan them there (services/read_sampling.py).
        from services.compact_read_loader import short_terminal_footprint_bp_for
        from services.working_sets import sampled_entry_with_reads
        broad_reads, broad_key = sampled_entry_with_reads(
            state, dataset, dataset_id, query.chrom, query.start, query.end, read_ids,
            query.include_methylation, layer_key, time.time(),
            include_layer_qualities=query.include_layer_qualities, infer_legacy_layers=query.infer_legacy_layers,
            legacy_nuc_min_size=query.legacy_nuc_min_size, min_footprints=effective_min_footprints,
            terminal_bp=short_terminal_footprint_bp_for(state),
        )
    if broad_reads is None or broad_key is None:
        return None

    viewport_offset = query.start - int(broad_key[2])
    read_id_set = set(read_ids) if read_ids is not None else None
    scan_reads: list[dict[str, Any]] = []

    from services.packed_reads import select_read_ids
    candidates = (select_read_ids(broad_reads, read_id_set) if read_id_set is not None else
        iter_broad_reads_overlapping_viewport(state, broad_reads, viewport_offset, viewport_offset + region_width))
    for read in candidates:
        if read_id_set is not None and read.get("id") not in read_id_set:
            continue
        intervals = read.get("intervals") or []
        if not intervals:
            continue
        if read_id_set is not None:
            from services.packed_reads import compact_read_bounds
            bounds = compact_read_bounds(read)
            if bounds is None or bounds[1] <= viewport_offset or bounds[0] >= viewport_offset + region_width:
                continue
        if query.spanning:
            read_start = int(intervals[0][0]) - viewport_offset
            read_end = int(intervals[-1][1]) - viewport_offset
            if read_start > 0 or read_end < region_width:
                continue
        scan_reads.append(read)

    if read_id_set is not None and not scan_reads:
        return np.zeros(region_width, dtype=np.float32), np.zeros(region_width, dtype=np.int32), 0
    # With no explicit read scope, the working set caps reads (stable sampling);
    # scanning more here would give different peaks than the same request run
    # cold. Leave capped scans to the working-set path.
    cap = int(getattr(state, "max_working_reads", 0) or 0)
    if read_id_set is None and cap > 0 and len(scan_reads) > cap:
        return None

    numerator, total_counts = compute_scan_counts(
        scan_reads,
        signal_source,
        region_width,
        coordinate_offset=viewport_offset,
    )
    return numerator, total_counts, len(scan_reads)


def _scan_track_signal_peaks(state, req, chrom: str, start: int, end: int, track_idx: int, perf_t0: float) -> Dict[str, Any]:
    """Peaks of a loaded signal track ('track:N'), found as the browser's Peaks
    panel finds them: the track binned over the view, then signal peak detection
    with the rule's minimum width and its lowest threshold."""
    from services.signal_peaks import detect_signal_peaks
    from services.tracks_endpoint import get_track_data_payload

    payload = get_track_data_payload(state, track_idx, chrom, start, end, bins=2000)
    if payload.get("error"):
        raise ValueError(f"Signal source track:{track_idx}: {payload['error']}")
    values = [float(v) if v is not None else 0.0 for v in payload.get("values") or []]
    peaks = detect_signal_peaks(
        values, start, end,
        min_width_bp=req.min_width,
        threshold_value=req.threshold_rare,
    ) if len(values) >= 3 else []
    peaks_list = [
        {**peak, "index": idx, "layer": 0}
        for idx, peak in enumerate(sorted(peaks, key=lambda p: p["start"]))
    ]
    remember_peak_regions(state, [[p["start"] - start, p["end"] - start] for p in peaks_list], chrom, start, end)
    result: Dict[str, Any] = {
        "peaks": peaks_list,
        "layer_info": [],
        "n_reads": 0,
        "mode": "Track",
        "server_elapsed_ms": round((time.perf_counter() - perf_t0) * 1000, 1),
        "server_timings": {},
    }
    if req.return_signal and values:
        result["signal"] = downsample_signal_for_response(np.asarray(values, dtype=np.float32), req.signal_bins)
    return result


@scoped_analysis
def run_scan_peaks_endpoint(
    *,
    state,
    req,
    chrom: str,
    start: int,
    end: int,
    dataset_id: str | None,
    spanning: bool,
) -> Dict[str, Any]:
    """Run the shared `/api/scan_peaks` endpoint implementation."""
    wall_t0 = time.time()
    perf_t0 = time.perf_counter()
    server_timings: dict[str, float] = {}

    def phase_ms(started_at: float) -> float:
        return (time.perf_counter() - started_at) * 1000

    resolved_chrom = state.translate_chrom(chrom)
    region_width = end - start
    smooth_width = max(req.smooth_width, req.min_width)

    if region_width <= 0:
        return {
            "peaks": [],
            "layer_info": [],
            "n_reads": 0,
            "server_elapsed_ms": round(phase_ms(perf_t0), 1),
            "server_timings": {},
        }

    signal_source = req.signal_source or "accessibility"
    track_idx = track_signal_index(signal_source)
    if track_idx is not None:
        return _scan_track_signal_peaks(state, req, chrom, start, end, track_idx, perf_t0)
    if not is_read_signal_source(signal_source):
        raise ValueError(
            f"Unsupported peak scan signal source {signal_source!r}; use one of "
            f"{', '.join(sorted(READ_SIGNAL_SOURCES))}, 'layer:<name>' or 'track:<index>'"
        )
    custom_layer = (scan_signal_layer_name(signal_source)
                    if signal_source.startswith(LAYER_SOURCE_PREFIX) else None)

    log_clustering_diagnostic("\n=== SCAN PEAKS ===")
    log_clustering_diagnostic(f"Region: {resolved_chrom}:{start}-{end} ({region_width}bp)")
    query = AnalysisReadQuery.from_request(
        state,
        chrom=chrom,
        start=start,
        end=end,
        spanning=spanning,
        dataset_id=dataset_id,
        dataset_ids=req.dataset_ids,
        sample_seed=req.sample_seed,
        read_ids=req.read_ids,
        read_ids_by_dataset=req.read_ids_by_dataset,
        include_methylation=scan_signal_needs_methylation(req.signal_source) or bool(getattr(req, "strand", None)),
        include_layers=scan_signal_needs_layers(req.signal_source),
        requested_layers=[custom_layer] if custom_layer else None,
        include_layer_qualities=False,
    )
    resolved_chrom = query.chrom
    scan_dataset_ids = query.dataset_ids
    if not scan_dataset_ids:
        log_clustering_diagnostic("No datasets available!")
        # This scan found no peaks here: earlier peaks for this region no longer stand.
        remember_peak_regions(state, [], chrom, start, end)
        return {
            "peaks": [],
            "layer_info": [],
            "n_reads": 0,
            "server_elapsed_ms": round(phase_ms(perf_t0), 1),
            "server_timings": {},
        }

    log_clustering_diagnostic(f"Scanning {len(scan_dataset_ids)} dataset(s): {scan_dataset_ids}")

    scan_reads = []
    scan_numerators: list[np.ndarray] = []
    scan_totals: list[np.ndarray] = []
    n_reads = 0
    broad_scan_hits = 0
    direct_scan_hits = 0

    from services.background_work import checkpoint
    phase_t0 = time.perf_counter()
    for ds_id in query.dataset_ids:
        checkpoint()  # a scan whose clients left stops between datasets
        from services.direct_read_projection import direct_scan_counts
        direct_counts = None if getattr(req, "strand", None) else direct_scan_counts(state, query, ds_id, signal_source)
        if direct_counts is not None:
            numerator, total_counts, ds_n_reads = direct_counts
            scan_numerators.append(numerator)
            scan_totals.append(total_counts)
            n_reads += ds_n_reads
            direct_scan_hits += 1
            continue
        broad_counts = None if getattr(req, "strand", None) else _compute_scan_counts_from_broad_cache(
            state=state,
            query=query,
            dataset_id=ds_id,
            signal_source=req.signal_source,
            region_width=region_width,
        )
        if broad_counts is not None:
            numerator, total_counts, ds_n_reads = broad_counts
            scan_numerators.append(numerator)
            scan_totals.append(total_counts)
            n_reads += ds_n_reads
            broad_scan_hits += 1
            log_clustering_diagnostic(f"  Dataset {ds_id}: {ds_n_reads} reads from broad cache")
            continue

        working_set = query.build_working_set(state, ds_id)
        if not working_set.reads:
            log_clustering_diagnostic(f"  Dataset {ds_id}: no reads")
            continue

        ds_reads = query.filter_reads_for_dataset(ds_id, working_set.reads)
        if ds_reads is not working_set.reads and len(ds_reads) != len(working_set.reads):
            log_clustering_diagnostic(
                f"  Dataset {ds_id}: {len(ds_reads)} specified reads "
                f"(from {len(working_set.reads)} in working set)"
            )
        else:
            log_clustering_diagnostic(
                f"  Dataset {ds_id}: {len(ds_reads)} reads "
                f"({working_set.total_spanning} total spanning)"
            )

        if getattr(req, "strand", None):
            from services.read_strand import filter_reads_by_strand, strand_calls
            ds_reads = filter_reads_by_strand(ds_reads, req.strand, strand_calls(state, ds_id))
        n_reads += len(ds_reads)
        scan_reads.extend(ds_reads)
    server_timings["working_set_ms"] = phase_ms(phase_t0)
    if broad_scan_hits:
        server_timings["broad_scan_hits"] = float(broad_scan_hits)
    if direct_scan_hits:
        server_timings["direct_scan_hits"] = float(direct_scan_hits)

    if n_reads == 0:
        log_clustering_diagnostic("No reads found across any dataset!")
        remember_peak_regions(state, [], chrom, start, end)
        return {
            "peaks": [],
            "layer_info": [],
            "n_reads": 0,
            "server_elapsed_ms": round(phase_ms(perf_t0), 1),
            "server_timings": {name: round(elapsed, 1) for name, elapsed in server_timings.items()},
        }

    phase_t0 = time.perf_counter()
    if scan_reads:
        numerator, total_counts = compute_scan_counts(scan_reads, req.signal_source, region_width)
        scan_numerators.append(numerator)
        scan_totals.append(total_counts)
    if len(scan_numerators) == 1:
        numerator = scan_numerators[0]
        total_counts = scan_totals[0]
    else:
        numerator = np.sum(np.stack(scan_numerators, axis=0), axis=0, dtype=np.int64).astype(np.int32, copy=False)
        total_counts = np.sum(np.stack(scan_totals, axis=0), axis=0, dtype=np.int64).astype(np.int32, copy=False)
    signal = scan_signal_from_counts(numerator, total_counts)
    server_timings["signal_ms"] = phase_ms(phase_t0)
    phase_t0 = time.perf_counter()
    combined_signal = smooth_scan_signal(signal, smooth_width)
    server_timings["smooth_ms"] = phase_ms(phase_t0)

    log_clustering_diagnostic(
        f"Signal computation: {(server_timings['signal_ms'] + server_timings['smooth_ms']) / 1000:.3f}s"
    )
    log_clustering_diagnostic(
        f"Signal stats: max={combined_signal.max():.3f}, mean={combined_signal.mean():.3f}"
    )

    thresholds = build_peak_thresholds(
        req.threshold_strong,
        req.threshold_medium,
        req.threshold_weak,
        req.threshold_rare,
        req.min_reads,
        n_reads,
    )
    log_clustering_diagnostic(
        f"Thresholds: strong={req.threshold_strong:.0%}, "
        f"medium={req.threshold_medium:.0%}, weak={req.threshold_weak:.0%}, "
        f"rare={req.threshold_rare:.0%}"
    )

    phase_t0 = time.perf_counter()
    broad_peaks: list[dict] = []
    all_peaks, layer_info = detect_threshold_layers(
        combined_signal,
        total_counts,
        thresholds,
        req.min_width,
        req.min_reads,
        smooth_width,
        max_width=getattr(req, "max_peak_width", DEFAULT_MAX_PEAK_WIDTH),
        broad_out=broad_peaks,
    )
    server_timings["detect_ms"] = phase_ms(phase_t0)
    for info in layer_info:
        log_clustering_diagnostic(f"  Layer {info['layer']} ({info['label']}): {info['n_peaks']} peaks")

    log_clustering_diagnostic(f"Peak detection: {server_timings['detect_ms'] / 1000:.3f}s")

    from services.remote_access import current_request_is_remote
    from services.runtime import get_public_mode
    # A diagnostic PNG in /tmp: the owner's debugging aid, never for other devices or visitors.
    if req.save_plot and not current_request_is_remote() and not get_public_mode():
        save_peak_scan_diagnostic_plot(
            combined_signal,
            all_peaks,
            thresholds,
            resolved_chrom,
            start,
            end,
            n_reads,
        )

    phase_t0 = time.perf_counter()
    peaks_list = format_peak_scan_results(all_peaks, start)
    remember_peak_regions(state, [[peak["start"] - start, peak["end"] - start] for peak in peaks_list], chrom, start, end)
    server_timings["format_ms"] = phase_ms(phase_t0)

    log_clustering_diagnostic(f"\nTotal peaks: {len(peaks_list)} in {time.time()-wall_t0:.3f}s")
    log_clustering_diagnostic("=== END SCAN PEAKS ===\n")

    result = {
        "peaks": peaks_list,
        "layer_info": layer_info,
        "n_reads": n_reads,
        # Above a tier's threshold but wider than max_peak_width: the view's
        # background accessibility, not peaks (not drawn, not clustered on).
        "broad_peaks": [
            {**peak, "start": int(start + peak["start"]), "end": int(start + peak["end"]),
             "width": int(peak["end"] - peak["start"])}
            for peak in broad_peaks
        ],
        "mode": "Fast",
        "server_timings": {name: round(elapsed, 1) for name, elapsed in server_timings.items()},
    }

    if req.return_signal and len(combined_signal) > 0:
        phase_t0 = time.perf_counter()
        result["signal"] = downsample_signal_for_response(combined_signal, req.signal_bins)
        result["server_timings"]["downsample_ms"] = round(phase_ms(phase_t0), 1)

    result["server_elapsed_ms"] = round(phase_ms(perf_t0), 1)
    return result


def run_dissolve_cluster_endpoint(
    *,
    state,
    req,
    chrom: str,
    start: int,
    end: int,
    spanning: bool,
) -> Dict[str, Any]:
    """Run the shared `/api/dissolve_cluster` endpoint implementation."""
    t0 = time.time()
    sample_seed = normalize_sample_seed(req.sample_seed)
    dissolve_id = req.cluster_to_dissolve
    log_clustering_diagnostic(f"Dissolving cluster {dissolve_id}")

    dataset_ids, _peaks, _peak_modes, rows, _query = assigned_cluster_feature_rows(
        state=state,
        req=req,
        chrom=chrom,
        start=start,
        end=end,
        spanning=spanning,
        sample_seed=sample_seed,
        assignments_by_dataset=req.current_assignments,
    )
    if dataset_ids is None:
        return {"results": {}}

    all_features, all_read_ids, all_assignments = rows
    if not all_features:
        return {"results": {}}

    features = np.array(all_features, dtype=np.float32)
    assignments_arr = np.array(all_assignments, dtype=np.int32)

    new_assignments, dissolve_info = dissolve_cluster_to_nearest(
        features,
        assignments_arr,
        dissolve_id,
    )
    if not dissolve_info["changed"] and dissolve_info["reason"] == "no_reads":
        log_clustering_diagnostic(f"  Cluster {dissolve_id} has no reads, nothing to dissolve")
        return {"results": {}}

    if not dissolve_info["changed"]:
        log_clustering_diagnostic("  No remaining clusters to reassign to")
        return {"results": {}}

    # Reads of the dissolved cluster outside the window go where most of its
    # reads in the window went; every other read keeps its cluster.
    moved = new_assignments[assignments_arr == dissolve_id]
    targets, counts = np.unique(moved, return_counts=True) if moved.size else (np.array([]), np.array([]))
    remap = {int(dissolve_id): int(targets[np.argmax(counts)])} if moved.size else {}
    results = assemble_assignment_array_results(
        all_read_ids=all_read_ids,
        assignments=new_assignments,
        dataset_ids=dataset_ids,
        state=state,
        base_assignments=req.current_assignments,
        remap=remap,
    )

    t1 = time.time()
    log_clustering_diagnostic(
        f"  Dissolved cluster {dissolve_id} ({dissolve_info['dissolved_count']} reads) "
        f"-> {len(dissolve_info['remaining_clusters'])} remaining clusters in {t1-t0:.2f}s"
    )

    return {"results": results, "sample_seed": sample_seed}


def merge_settings(req) -> Dict[str, Any]:
    """The "Merge by" settings a request asks for, resolved (for provenance)."""
    strategy = (getattr(req, "merge_strategy", None) or "cosine")
    threshold = resolve_merge_threshold(
        strategy, getattr(req, "merge_threshold", None), req.max_cosine_similarity)
    return {
        "strategy": strategy,
        "threshold": threshold,
        "alpha": float(getattr(req, "merge_alpha", MERGE_DEFAULT_ALPHA)),
        "min_fraction": float(req.min_fraction),
    }


def merge_kwargs(req) -> Dict[str, Any]:
    """Extra run_autocull_on arguments: none for plain cosine (as before)."""
    settings = merge_settings(req)
    if settings["strategy"] == "cosine" and getattr(req, "merge_threshold", None) is None:
        return {}
    return {"strategy": settings["strategy"], "threshold": settings["threshold"], "alpha": settings["alpha"]}


def run_auto_cull_clusters_endpoint(
    *,
    state,
    req,
    chrom: str,
    start: int,
    end: int,
    spanning: bool,
) -> Dict[str, Any]:
    """Run the shared `/api/auto_cull_clusters` endpoint implementation."""
    t0 = time.time()
    sample_seed = normalize_sample_seed(req.sample_seed)
    current_assignments = {key: dict(value) for key, value in req.current_assignments.items()}

    dataset_ids, _peaks, _peak_modes, rows, _query = assigned_cluster_feature_rows(
        state=state,
        req=req,
        chrom=chrom,
        start=start,
        end=end,
        spanning=spanning,
        sample_seed=sample_seed,
        assignments_by_dataset=current_assignments,
    )
    if dataset_ids is None:
        return {"results": {}, "dissolved": []}

    all_features, all_read_ids, all_assignments = rows
    if not all_features:
        return {"results": {}, "dissolved": []}

    features = np.array(all_features, dtype=np.float32)
    assignments = np.array(all_assignments, dtype=np.int32)

    assignments, dissolved_clusters = run_autocull_on(
        features,
        assignments,
        min_fraction=req.min_fraction,
        max_cosine_similarity=req.max_cosine_similarity,
        **merge_kwargs(req),
    )
    for dissolved in dissolved_clusters:
        log_clustering_diagnostic(
            f"  Auto-cull: dissolved C{dissolved['cluster']} "
            f"({dissolved['count']} reads) - {dissolved['reason']}"
        )

    results = assemble_assignment_array_results(
        all_read_ids=all_read_ids,
        assignments=assignments,
        dataset_ids=dataset_ids,
        state=state,
        base_assignments=current_assignments,
        remap=merged_cluster_targets(dissolved_clusters),
    )

    t1 = time.time()
    log_clustering_diagnostic(
        f"  Auto-cull complete: dissolved {len(dissolved_clusters)} clusters in {t1-t0:.2f}s"
    )

    return {"results": results, "dissolved": dissolved_clusters, "sample_seed": sample_seed,
            "merge": merge_settings(req)}


def _fiberbrowser_version() -> str:
    try:
        from version import __version__

        return str(__version__)
    except Exception:  # pragma: no cover - version module always ships
        return ""


def empty_cluster_projection_result(req) -> Dict[str, Any]:
    return {
        "coords_x": [],
        "coords_y": [],
        "read_ids": [],
        "dataset_ids": [],
        "labels_before": [],
        "labels_after": None,
        "cluster_centroids_before": {},
        "cluster_centroids_after": None,
        "dissolved": [],
        "method": req.method,
        "variance_explained": None,
        "feature_dim": 0,
        "n_reads": 0,
        "strands": [],
        "alignment_strands": [],
        "embedded": None,
        "projection_params": None,
    }


def run_cluster_projection_endpoint(
    *,
    state,
    req,
    chrom: str,
    start: int,
    end: int,
    spanning: bool,
) -> Dict[str, Any]:
    """Run the shared `/api/cluster_projection` endpoint implementation."""
    t0 = time.time()
    sample_seed = normalize_sample_seed(req.sample_seed)
    projection_random_state = random_state_from_seed(sample_seed, "cluster_projection", req.method)

    chrom = state.translate_chrom(chrom)
    dataset_ids = resolve_dataset_ids(state, dataset_ids=req.dataset_ids)
    if not dataset_ids:
        return {"error": "No datasets"}
    cluster_rule_context = build_cluster_rule_context(state, chrom, start, end)

    explicit_peaks = [(peak.start - start, peak.end - start) for peak in req.peak_regions if peak.mode != "off"]
    explicit_modes = [peak.mode for peak in req.peak_regions if peak.mode != "off"]

    all_features = []
    all_read_ids = []
    all_assignments = []
    # Per read: DAF strand (CT/GA from deamination marks, '' when unknown) and
    # alignment orientation (+/-), for the per-read export.
    all_strands: list[str] = []
    all_alignment: list[str] = []
    from services.read_strand import cached_read_strand, strand_calls
    # Without explicit peaks each dataset brings the peaks it was clustered on.
    # One projection needs one feature layout: the first clustered dataset's
    # peaks set it, and a dataset clustered at other peaks is left out (listed).
    shared_schema = None
    skipped_datasets: list[str] = []

    assignment_overrides = req.cluster_assignments or {}
    for dataset_id in dataset_ids:
        dataset = state.get_dataset(dataset_id)
        # Prefer the frontend's active-branch assignments over the backend's
        # stored map so projection reflects the branch currently shown in the UI.
        # Explicit (even empty) overrides win; only an absent one falls back.
        override = assignment_overrides.get(dataset_id)
        assigned = override if override is not None else (dataset.cluster_assignments if dataset else None)
        if not dataset or not assigned:
            continue

        # Projecting the stored clustering (no explicit peaks): its own feature
        # rules and threshold describe how it was built, so they win.
        stored_settings = {}
        if explicit_peaks:
            peaks = explicit_peaks
            peak_modes = explicit_modes
        elif dataset.cluster_peak_regions:
            stored_settings = getattr(dataset, "cluster_feature_settings", None) or {}
            peaks = [
                (peak["start"] - start, peak["end"] - start)
                for peak in dataset.cluster_peak_regions
            ]
            peak_modes = [peak.get("mode", "accessibility") for peak in dataset.cluster_peak_regions]
            # The feature layout also depends on the rules (a cluster rule's
            # terms) and threshold the clustering was built with.
            schema = (tuple(peaks), tuple(peak_modes), _settings_signature(stored_settings))
            if shared_schema is None:
                shared_schema = schema
            elif schema != shared_schema:
                skipped_datasets.append(dataset_id)
                continue
        else:
            continue

        # DAF reads' strand (CT/GA, for the export) comes from their deamination
        # marks; without include_strands only strands already known are given.
        has_deam = bool(getattr(req, "include_strands", False)) and bool(
            (getattr(dataset, "available_layers", None) or {}).get("deam"))
        working_query = AnalysisReadQuery.from_request(
            state,
            chrom=chrom,
            start=start,
            end=end,
            spanning=spanning,
            dataset_id=dataset_id,
            sample_seed=sample_seed,
            include_methylation=cluster_modes_need_methylation(peak_modes) or has_deam,
            include_layers=cluster_modes_need_layers(peak_modes),
            requested_layers=cluster_modes_requested_layers(peak_modes),
        )
        from services.cluster_sample import using_assigned_cluster_reads
        with using_assigned_cluster_reads():
            working_set = working_query.build_working_set(state, dataset_id, read_ids=list(assigned))
        if not working_set.reads:
            continue

        reads_to_use = [read for read in working_set.reads if read["id"] in assigned]
        if not reads_to_use:
            continue

        feature_kwargs = {}
        feature_rules = stored_settings.get("cluster_feature_rules") or req.cluster_feature_rules
        if feature_rules:
            feature_kwargs["cluster_feature_rules"] = feature_rules
            feature_kwargs["cluster_rule_context"] = cluster_rule_context
        threshold = stored_settings.get("subnucleosomal_threshold", req.subnucleosomal_threshold)
        features, read_ids, _, _ = extract_features_from_compact(
            # Saved footprint-class features look reads up by dataset and chromosome.
            [prefix_compact_read({**read, '_consensus_dataset_id': dataset_id, '_consensus_chrom': chrom}, dataset_id)
             for read in reads_to_use],
            peaks,
            start,
            step=10,
            subnucleosomal_threshold=threshold,
            peak_modes=peak_modes,
            **feature_kwargs,
        )

        if features.size == 0:
            continue
        # One projection needs one feature width; a dataset whose features
        # don't match the first one's is left out (listed) rather than crashing.
        if all_features and features.shape[1] != len(all_features[0]):
            skipped_datasets.append(dataset_id)
            continue

        reads_by_id = {read["id"]: read for read in reads_to_use}
        calls = strand_calls(state, dataset_id)
        for index, read_id in enumerate(read_ids):
            read_dataset_id, original_id = split_prefixed_read_id(read_id, dataset_id)
            all_features.append(features[index])
            all_read_ids.append((read_dataset_id, original_id))
            all_assignments.append(assigned.get(original_id, -1))
            read = reads_by_id.get(original_id) or {}
            all_strands.append((cached_read_strand(read, calls) or "") if read else "")
            orientation = read.get("alignment_orientation")
            all_alignment.append("-" if orientation == "reverse" else "+" if orientation == "forward" else "")

    if not all_features:
        return {**empty_cluster_projection_result(req), "skipped_datasets": skipped_datasets}

    features = np.array(all_features, dtype=np.float32)
    labels_before = np.array(all_assignments, dtype=np.int32)

    t1 = time.time()
    method_requested = (req.method or "tsne").lower()
    tsne_info = None
    tsne_fallback_reason = None
    if method_requested == "tsne" and features.shape[0] >= 4:
        # Rows keyed by dataset and read: the same reads give the same map
        # whatever order they arrive in (services/read_projection.py).
        from services.read_projection import TSNE_MAX_READS, compute_tsne_map

        try:
            tsne_info = compute_tsne_map(
                features,
                random_state=projection_random_state,
                keys=[f"{ds}::{rid}" for ds, rid in all_read_ids],
                max_reads=getattr(req, "max_reads", None) or TSNE_MAX_READS,
            )
        except Exception as exc:
            # Too few distinct reads (or another t-SNE failure): PCA, and say why.
            tsne_fallback_reason = str(exc)
            log_clustering_diagnostic(f"  Projection: t-SNE failed ({exc}), falling back to PCA")
    if tsne_info is not None:
        coords, variance_explained, method_used = tsne_info["coords"], None, "tsne"
    else:
        coords, variance_explained, method_used = compute_cluster_projection(
            features,
            method="pca" if method_requested == "tsne" else method_requested,
            # The response is a 2D scatter (x, y, 2D centroids): at least two components.
            n_components=max(2, int(req.n_components)),
            random_state=projection_random_state,
        )
    t2 = time.time()
    log_clustering_diagnostic(
        f"  Projection ({method_used}): {features.shape[0]} reads x {features.shape[1]} features -> "
        f"{coords.shape[1]}D in {t2-t1:.2f}s"
    )

    def centroids_in_2d(labels: np.ndarray) -> Dict[str, list[float]]:
        out: Dict[str, list[float]] = {}
        for cluster in sorted(set(labels.tolist())):
            mask = labels == cluster
            if mask.any():
                mean = coords[mask].mean(axis=0)
                out[str(int(cluster))] = [float(mean[0]), float(mean[1])]
        return out

    centroids_before = centroids_in_2d(labels_before)

    labels_after = None
    centroids_after = None
    dissolved_log = []

    merge = merge_settings(req) if req.simulate_autocull else None
    if req.simulate_autocull:
        labels_after_arr, dissolved_log = run_autocull_on(
            features,
            labels_before.copy(),
            min_fraction=req.min_fraction,
            max_cosine_similarity=req.max_cosine_similarity,
            **merge_kwargs(req),
        )
        labels_after = [int(cluster) for cluster in labels_after_arr.tolist()]
        centroids_after = centroids_in_2d(labels_after_arr)
        log_clustering_diagnostic(f"  Dry-run autocull: dissolved {len(dissolved_log)} clusters")

    response = {
        "coords_x": [float(value) for value in coords[:, 0].tolist()],
        "coords_y": [float(value) for value in coords[:, 1].tolist()],
        "read_ids": [read_id for _, read_id in all_read_ids],
        "dataset_ids": [dataset_id for dataset_id, _ in all_read_ids],
        "labels_before": [int(cluster) for cluster in labels_before.tolist()],
        "labels_after": labels_after,
        "cluster_centroids_before": centroids_before,
        "cluster_centroids_after": centroids_after,
        "dissolved": dissolved_log,
        "method": method_used,
        "variance_explained": variance_explained,
        "feature_dim": int(features.shape[1]),
        "n_reads": int(features.shape[0]),
        "sample_seed": sample_seed,
        "projection_random_state": projection_random_state,
        "skipped_datasets": skipped_datasets,
        "strands": all_strands,
        "alignment_strands": all_alignment,
        "embedded": [bool(v) for v in tsne_info["embedded"].tolist()] if tsne_info else None,
        # Everything that defines this map, for the export's header.
        "projection_params": {
            "fiberbrowser_version": _fiberbrowser_version(),
            "method": method_used,
            "random_state": projection_random_state,
            "sample_seed": sample_seed,
            "n_reads": int(features.shape[0]),
            "feature_dim": int(features.shape[1]),
            **({
                "perplexity": tsne_info["perplexity"],
                "n_neighbors": tsne_info["n_neighbors"],
                "feature_digest": tsne_info["feature_digest"],
                "max_reads": tsne_info["max_reads"],
                "n_embedded": tsne_info["n_embedded"],
                "threads": tsne_info["threads"],
                "init": "pca",
                "learning_rate": "auto",
                "implementation": "scikit-learn TSNE (Barnes-Hut)",
            } if tsne_info else {}),
            "chrom": chrom,
            "start": int(start),
            "end": int(end),
            "seconds": round(t2 - t1, 3),
            # The "Merge by" rule the After merge preview used.
            **({
                "merge_strategy": merge["strategy"],
                "merge_threshold": merge["threshold"],
                "merge_alpha": merge["alpha"],
                "min_fraction": merge["min_fraction"],
            } if merge else {}),
            "cache_hit": bool(tsne_info and tsne_info["cache_hit"]),
            **({"fallback_reason": tsne_fallback_reason} if tsne_fallback_reason else {}),
        },
    }

    t3 = time.time()
    log_clustering_diagnostic(f"  Projection endpoint complete in {t3-t0:.2f}s")
    return response


@scoped_analysis
def run_cluster_all_endpoint(
    *,
    state,
    req,
    chrom: str,
    start: int,
    end: int,
    spanning: bool,
) -> Dict[str, Any]:
    """Run the shared `/api/cluster_all` endpoint implementation."""
    timings = EndpointTimings()
    t0 = timings.started_at

    from services.cluster_assignment import check_cluster_method
    check_cluster_method(req.method)  # before any reads are loaded
    dataset_ids = resolve_dataset_ids(state, dataset_ids=req.dataset_ids)
    log_clustering_diagnostic(
        f"Clustering: method={req.method}, k={req.k}, peaks={len(req.peak_regions)}, datasets={dataset_ids}"
    )
    log_clustering_diagnostic(
        f"  Thresholds: subnucleosomal={req.subnucleosomal_threshold}bp, "
        f"accessibility={req.accessibility_threshold}"
    )
    sample_seed = normalize_sample_seed(req.sample_seed)
    cluster_random_state = random_state_from_seed(sample_seed, "cluster_all", req.method)

    chrom = state.translate_chrom(chrom)
    if not dataset_ids:
        return timings.attach({"results": {}})

    phase_start = time.perf_counter()
    window_with_peaks = next((v for v in (getattr(req, 'viewports', None) or []) if v.peak_regions), None)
    if window_with_peaks is not None and not req.peak_regions:
        # Windows with their own peaks and no shared list: the first window's
        # peaks are the reference (not the server's last scan, which may be elsewhere).
        peaks, peak_modes = active_peak_regions(window_with_peaks.peak_regions, window_with_peaks.start)
    else:
        peaks, peak_modes = active_cluster_peaks(req, state, start, chrom, end)
    timings.add("parse_peaks", phase_start)

    if not peaks:
        return timings.attach({"results": empty_cluster_all_results(dataset_ids)})

    use_compact_path = any(mode != "off" for mode in peak_modes)
    include_methylation = cluster_modes_need_methylation(peak_modes)
    # A one-strand window needs deamination marks to tell reads' strands.
    if any(getattr(view, 'strand', None) for view in (getattr(req, 'viewports', None) or [])):
        include_methylation = True
    include_layers = cluster_modes_need_layers(peak_modes)
    analysis_query = AnalysisReadQuery.from_request(
        state,
        chrom=chrom,
        start=start,
        end=end,
        spanning=spanning,
        dataset_ids=dataset_ids,
        read_ids_by_dataset=None if getattr(req,'viewports',None) else req.read_ids,
        max_reads=req.max_reads,
        sample_seed=sample_seed,
        include_methylation=include_methylation,
        include_layers=include_layers,
        requested_layers=cluster_modes_requested_layers(peak_modes),
    )
    chrom = analysis_query.chrom
    dataset_ids = analysis_query.dataset_ids
    sample_seed = analysis_query.sample_seed
    cluster_rule_context = build_cluster_rule_context(state, chrom, start, end)

    from services.columnar_clustering import ColumnarPatterns, use_columnar_clustering
    from services.packed_reads import bounded_read_analysis
    from contextlib import nullcontext
    columnar = (ColumnarPatterns(peaks, start, peak_modes=peak_modes,
                                subnucleosomal_threshold=req.subnucleosomal_threshold,
                                accessibility_threshold=req.accessibility_threshold,
                                cluster_feature_rules=req.cluster_feature_rules,
                                cluster_rule_context=cluster_rule_context)
                if use_compact_path and use_columnar_clustering(state, req, analysis_query) else None)

    all_reads = []
    all_compact = []
    dataset_read_ids = {}
    dataset_read_stats = {}
    working_totals = {}
    preparation_samples = {}

    def with_performance_sampling(payload):
        for key, result in payload.get('results', {}).items():
            if key in preparation_samples:
                result['preparation_sampling'] = {
                    **preparation_samples[key], 'used': len(result.get('assignments', {})),
                }
            dataset = state.get_dataset(key) if key in dataset_ids else None
            if dataset is not None:
                dataset.cluster_preparation_sampling = result.get('preparation_sampling')
        if getattr(state, 'performance', {}).get('effective') == 'low':
            for key, result in payload.get('results', {}).items():
                result['performance_sampling'] = {
                    'used': len(result.get('assignments', {})),
                    'total': working_totals.get(key, 0),
                }
        return payload

    t1 = time.perf_counter()

    phase_start = time.perf_counter()
    viewports = {view.result_key: view for view in (getattr(req, 'viewports', None) or [])}
    if viewports:
        if len(viewports) != len(req.viewports):
            raise ValueError('Duplicate clustering window keys')
        for view in viewports.values():
            if view.dataset_id not in dataset_ids or view.end <= view.start:
                raise ValueError('Invalid clustering window')
        chrom_jobs = [(state.translate_chrom(view.chrom), view.dataset_id, view.result_key) for view in viewports.values()]
        window_peaks = {
            key: active_peak_regions(view.peak_regions, view.start)
            for key, view in viewports.items() if view.peak_regions
        }
        for own, _modes in window_peaks.values():
            if [p[1] - p[0] for p in own] != [p[1] - p[0] for p in peaks]:
                raise ValueError('Each window needs the same number of peaks, matched in width')
        # Each window's features are read at its own peaks, start and genomic
        # context (the shared peaks are offsets, so a window without its own
        # uses them from its start).
        window_groups = {
            key: (window_peaks[key][0] if key in window_peaks else peaks, view.start,
                  build_cluster_rule_context(state, state.translate_chrom(view.chrom), view.start, view.end))
            for key, view in viewports.items()
        }
    else:
        chrom_jobs = build_cluster_jobs(chrom, dataset_ids, req.extra_chroms, state)
        window_peaks = {}
        window_groups = None
    timings.add("build_jobs", phase_start)

    for job_chrom, dataset_id, result_key in chrom_jobs:
        phase_start = time.perf_counter()
        view = viewports.get(result_key)
        from services.cluster_sample import prepare_cluster_sample, using_cluster_sample
        sample = prepare_cluster_sample(state, dataset_id, job_chrom,
            view.start if view else start, view.end if view else end,
            req.preparation_sample_count, sample_seed,
            read_ids=view.read_ids if view else analysis_query.read_ids_for_dataset(dataset_id))
        timings.add('sample_selection', phase_start)
        phase_start = time.perf_counter()
        with using_cluster_sample(sample), bounded_read_analysis() if columnar is not None else nullcontext():
            working_set = analysis_query.build_working_set(
                state,
                dataset_id,
                chrom=job_chrom,
                **(dict(start=view.start, end=view.end, read_ids=view.read_ids) if view else {}),
                **(dict(broad_prefetch_multiplier=3) if sample is not None else {}),
            )
        timings.add("working_set", phase_start)
        if sample is not None:
            preparation_samples[result_key] = dict(target_names=sample.target,
                selected_names=len(sample.names), total_alignments=sample.total,
                prepared_reads=len(working_set.reads), fingerprint=sample.fingerprint,
                sample_seed=sample_seed, method='bottom_k_qname_v1', chrom=job_chrom,
                result_key=result_key, dataset_id=dataset_id,
                start=view.start if view else start, end=view.end if view else end)
        working_totals[result_key] = working_set.total_overlapping

        if not working_set.reads:
            dataset_read_ids[result_key] = []
            continue

        if columnar is not None:
            # No expanded cohort list or full positional feature matrix is
            # retained. Apply the identical native coverage rule per molecule.
            from services.read_metrics import read_covers_regions
            phase_start = time.perf_counter()
            original_ids = []
            for read in working_set.reads:
                if not read_covers_regions(read, peaks):
                    continue
                original_ids.append(read['id'])
                columnar.append(prefix_compact_read({**read, '_consensus_dataset_id': dataset_id,
                    '_consensus_chrom': job_chrom, '_cluster_group': result_key}, result_key))
            dataset_read_ids[result_key] = original_ids
            dataset_read_stats[result_key] = {
                'eligible_read_count': len(working_set.reads),
                'peak_covering_read_count': len(original_ids),
                'analysis_read_count': len(original_ids),
            }
            timings.add('columnar_features', phase_start)
            continue

        reads_for_job = (working_set.reads if view else analysis_query.filter_reads_for_dataset(dataset_id, working_set.reads))
        if view and view.read_ids is not None:
            allowed = set(view.read_ids)
            reads_for_job = [read for read in reads_for_job if read['id'] in allowed]
        if view and getattr(view, 'strand', None):
            from services.read_strand import filter_reads_by_strand, strand_calls
            reads_for_job = filter_reads_by_strand(reads_for_job, view.strand, strand_calls(state, dataset_id))
        if reads_for_job is not working_set.reads and len(reads_for_job) != len(working_set.reads):
            phase_start = time.perf_counter()
            log_clustering_diagnostic(
                f"  {result_key}: {len(reads_for_job)}/{len(working_set.reads)} reads from req.read_ids"
            )
            timings.add("read_id_filter", phase_start)

        phase_start = time.perf_counter()
        eligible_count = len(reads_for_job)
        job_peaks = window_peaks[result_key][0] if result_key in window_peaks else peaks
        reads_for_job = filter_reads_covering_regions(reads_for_job, job_peaks)
        peak_covering_count = len(reads_for_job)
        timings.add("peak_cover_filter", phase_start)
        if peak_covering_count != eligible_count:
            log_clustering_diagnostic(
                f"  {result_key}: peak coverage filter "
                f"{eligible_count} -> {peak_covering_count} reads"
            )

        if not reads_for_job:
            dataset_read_ids[result_key] = []
            dataset_read_stats[result_key] = {
                "eligible_read_count": eligible_count,
                "peak_covering_read_count": 0,
                "analysis_read_count": 0,
            }
            continue

        if analysis_query.max_reads and len(reads_for_job) > analysis_query.max_reads:
            phase_start = time.perf_counter()
            pre_sample_count = len(reads_for_job)
            reads_for_job = analysis_query.cap_reads(
                reads_for_job,
                namespace="cluster_all",
                label=result_key,
            )
            log_clustering_diagnostic(
                f"  {result_key}: stable analysis read cap "
                f"{pre_sample_count} -> {len(reads_for_job)} reads"
            )
            timings.add("analysis_sampling", phase_start)

        if use_compact_path:
            phase_start = time.perf_counter()
            original_ids = []
            prefixed_reads = []
            for read in reads_for_job:
                original_ids.append(read["id"])
                prefixed_reads.append(prefix_compact_read({**read, '_consensus_dataset_id': dataset_id,
                    '_consensus_chrom': job_chrom, '_cluster_group': result_key}, result_key))
            all_compact.extend(prefixed_reads)
            timings.add("compact_prep", phase_start)
            log_clustering_diagnostic(
                f"  {result_key}: using working set ({len(reads_for_job)} compact reads)"
            )
        else:
            phase_start = time.perf_counter()
            reads_df = compact_reads_to_dataframe(reads_for_job, start, end)
            timings.add("dataframe_prep", phase_start)
            log_clustering_diagnostic(f"  {result_key}: using working set ({len(reads_df)} reads)")

            if reads_df.empty:
                dataset_read_ids[result_key] = []
                continue

            reads_df = reads_df.copy()
            original_ids = (
                reads_df["read_id"].tolist()
                if "read_id" in reads_df.columns
                else [str(index) for index in range(len(reads_df))]
            )
            reads_df["read_id"] = [f"{result_key}::{read_id}" for read_id in original_ids]
            reads_df["_dataset_id"] = result_key
            reads_df["_original_id"] = original_ids
            all_reads.append(reads_df)

        dataset_read_ids[result_key] = original_ids
        dataset_read_stats[result_key] = {
            "eligible_read_count": eligible_count,
            "peak_covering_read_count": peak_covering_count,
            "analysis_read_count": len(original_ids),
        }

    t2 = time.perf_counter()
    total_reads = (len(columnar) if columnar is not None else
                   len(all_compact) if use_compact_path else sum(len(df) for df in all_reads))
    log_clustering_diagnostic(
        f"  Loaded {total_reads} reads from {len(dataset_ids)} datasets in {t2-t1:.2f}s"
    )

    cluster_features = {}
    if columnar is not None:
        if not len(columnar):
            return timings.attach(with_performance_sampling({"results": empty_cluster_all_results(dataset_ids)}))
        phase_start = time.perf_counter()
        assignments, counts, sorted_idx, element_info = columnar.finish()
        timings.add('cluster_columnar', phase_start)
    elif use_compact_path:
        if not all_compact:
            return timings.attach(with_performance_sampling({"results": empty_cluster_all_results(list(viewports) if viewports else dataset_ids)}))

        phase_start = time.perf_counter()
        assignments, counts, sorted_idx, element_info = cluster_compact_reads(
            all_compact,
            peaks,
            start,
            req.k,
            req.method,
            subnucleosomal_threshold=req.subnucleosomal_threshold,
            accessibility_threshold=req.accessibility_threshold,
            peak_modes=peak_modes,
            random_state=cluster_random_state,
            cluster_feature_rules=req.cluster_feature_rules,
            cluster_rule_context=cluster_rule_context,
            window_groups=window_groups,
            resolution=getattr(req, "resolution", 1.0),
            features_out=cluster_features if req.method not in ("binary", "combinatorial") else None,
        )
        timings.add("cluster_compact", phase_start)
    else:
        if not all_reads:
            return timings.attach(with_performance_sampling({"results": empty_cluster_all_results(list(viewports) if viewports else dataset_ids)}))

        phase_start = time.perf_counter()
        combined_df = pd.concat(all_reads, ignore_index=True)
        timings.add("dataframe_concat", phase_start)

        phase_start = time.perf_counter()
        assignments, counts, sorted_idx, element_info = cluster_reads(
            combined_df,
            peaks,
            req.k,
            start,
            req.method,
            subnucleosomal_threshold=req.subnucleosomal_threshold,
            accessibility_threshold=req.accessibility_threshold,
            peak_modes=peak_modes,
            random_state=cluster_random_state,
            resolution=getattr(req, "resolution", 1.0),
        )
        timings.add("cluster_dataframe", phase_start)

    t3 = time.perf_counter()
    log_clustering_diagnostic(f"  Clustering took {t3-t2:.2f}s, total {t3-t0:.2f}s")

    phase_start = time.perf_counter()
    # The response is built before publishing any workspace clustering.

    response = {
        "sample_seed": sample_seed,
        "cluster_random_state": cluster_random_state,
    }
    if columnar is not None:
        response['analysis_storage'] = columnar.diagnostics()
    if req.method == "graph":
        response["resolution"] = float(req.resolution)
    def _peak_region_payload():
        return [
            {
                "start": start + peak[0],
                "end": start + peak[1],
                "mode": peak_modes[index] if index < len(peak_modes) else "accessibility",
            }
            for index, peak in enumerate(peaks)
        ]

    if element_info and "cluster_patterns" in element_info:
        response["cluster_patterns"] = element_info["cluster_patterns"]
        response["peak_regions"] = _peak_region_payload()
    elif use_compact_path and req.method not in ("binary", "combinatorial") and assignments:
        # Non-combinatorial methods (kmeans, etc.) carry per-cluster centroids so
        # the frontend can dynamically reassign reads to the nearest centroid as
        # the viewport changes. Centroids are global across the jointly-clustered
        # datasets, like cluster_patterns.
        if cluster_features:
            centroids, centroid_peak_widths = compute_cluster_centroids_from_features(
                cluster_features['features'], cluster_features['read_ids'],
                cluster_features['peak_widths'], assignments)
        else:
            centroids, centroid_peak_widths = compute_cluster_centroids_from_compact(
                all_compact,
                peaks,
                start,
                assignments,
                subnucleosomal_threshold=req.subnucleosomal_threshold,
                peak_modes=peak_modes,
                cluster_feature_rules=req.cluster_feature_rules,
                cluster_rule_context=cluster_rule_context,
                window_groups=window_groups,
            )
        if centroids:
            response["cluster_centroids"] = centroids
            response["cluster_peak_widths"] = centroid_peak_widths
            response["peak_regions"] = _peak_region_payload()

    from services.background_work import checkpoint
    checkpoint()  # A cancelled fit must not replace the workspace's clustering.
    results = assemble_cluster_all_results(
        assignments=assignments,
        dataset_read_ids=dataset_read_ids,
        dataset_read_stats=dataset_read_stats,
        dataset_ids=dataset_ids,
        state=state,
        element_info=element_info,
        peaks=peaks,
        peak_modes=peak_modes,
        start=start,
        feature_settings={
            "subnucleosomal_threshold": req.subnucleosomal_threshold,
            "cluster_feature_rules": list(req.cluster_feature_rules or []),
        },
    )

    response['results'] = results
    timings.add("response_assembly", phase_start)
    return timings.attach(with_performance_sampling(response))


def run_assign_to_clusters_endpoint(
    *,
    state,
    req,
    chrom: str,
    start: int,
    end: int,
    spanning: bool,
) -> Dict[str, Any]:
    """Assign viewport reads to stored cluster patterns for dynamic clustering."""
    t0 = time.time()
    sample_seed = normalize_sample_seed(req.sample_seed)

    peaks, peak_modes = active_peak_regions(req.peak_regions, start)
    use_centroids = bool(getattr(req, "cluster_centroids", None))
    if not peaks or (not req.cluster_patterns and not use_centroids):
        return {"results": {}}

    query = AnalysisReadQuery.from_request(
        state,
        chrom=chrom,
        start=start,
        end=end,
        spanning=spanning,
        dataset_ids=req.dataset_ids,
        read_ids_by_dataset=req.read_ids,
        sample_seed=sample_seed,
        include_methylation=cluster_modes_need_methylation(peak_modes),
        include_layers=cluster_modes_need_layers(peak_modes),
        requested_layers=cluster_modes_requested_layers(peak_modes),
    )
    dataset_ids = query.dataset_ids
    cluster_rule_context = build_cluster_rule_context(state, query.chrom, start, end)

    results = {}
    for ds_id in dataset_ids:
        working_set = query.build_working_set(state, ds_id)
        if not working_set.reads:
            continue

        reads = query.filter_reads_for_dataset(ds_id, working_set.reads)
        if not reads:
            results[ds_id] = {"assignments": {}, "cluster_counts": {}, "filtered_read_ids": []}
            continue
        # Saved footprint-class features look reads up by dataset and chromosome
        # (as cluster_all tags them); read IDs here are not dataset-prefixed.
        reads = [{**read, '_consensus_dataset_id': ds_id, '_consensus_chrom': query.chrom} for read in reads]
        if use_centroids:
            results[ds_id] = assign_reads_to_centroids(
                reads,
                peaks,
                req.cluster_centroids,
                req.cluster_peak_widths,
                region_start=start,
                subnucleosomal_threshold=req.subnucleosomal_threshold,
                peak_modes=peak_modes,
                overlap_mode=getattr(req, "overlap_mode", "aggressive"),
                cluster_feature_rules=req.cluster_feature_rules,
                cluster_rule_context=cluster_rule_context,
            )
        else:
            results[ds_id] = assign_reads_to_cluster_patterns(
                reads,
                peaks,
                req.cluster_patterns,
                region_start=start,
                subnucleosomal_threshold=req.subnucleosomal_threshold,
                accessibility_threshold=req.accessibility_threshold,
                peak_modes=peak_modes,
                overlap_mode=getattr(req, "overlap_mode", "aggressive"),
                cluster_feature_rules=req.cluster_feature_rules,
                cluster_rule_context=cluster_rule_context,
            )

        dataset = state.get_dataset(ds_id)
        if dataset:
            # Dynamic assignment covers only the reads available in this
            # viewport (and, for child branches, the explicit read scope).
            # Preserve labels for reads outside that partial response so
            # server-side analyses and the frontend's live projection retain
            # the same non-shrinking clustered cohort.
            dataset.cluster_assignments = {
                **(dataset.cluster_assignments or {}),
                **results[ds_id]["assignments"],
            }

    log_clustering_diagnostic(
        "  Dynamic cluster assignment: "
        f"{sum(len(r['assignments']) for r in results.values())} reads across "
        f"{len(dataset_ids)} datasets in {time.time() - t0:.2f}s"
    )
    return {"results": results, "sample_seed": sample_seed}


def run_cluster_endpoint(
    *,
    state,
    req,
    chrom: str,
    start: int,
    end: int,
    spanning: bool,
    dataset_id: str | None,
    min_footprints: int,
    sample_seed: str | None,
    cluster_compact_reads_impl=cluster_compact_reads,
) -> Dict[str, Any]:
    """Cluster a single dataset for the backwards-compatible `/api/cluster` route."""
    query = AnalysisReadQuery.from_request(
        state,
        chrom=chrom,
        start=start,
        end=end,
        spanning=spanning,
        dataset_id=dataset_id,
        sample_seed=sample_seed,
        min_footprints=min_footprints,
        include_methylation=False,
        include_layers=False,
    )
    sample_seed = query.sample_seed
    if not query.dataset_ids:
        return {"assignments": {}, "cluster_counts": {}, "filtered_read_ids": []}

    dataset_id = query.dataset_ids[0]
    cluster_random_state = random_state_from_seed(sample_seed, "cluster", "kmeans")
    dataset = state.get_dataset(dataset_id)
    if not dataset:
        return {"assignments": {}, "cluster_counts": {}, "filtered_read_ids": []}

    working_set = query.build_working_set(state, dataset_id)
    if not working_set.reads:
        dataset.cluster_assignments, dataset.sorted_indices = {}, None
        dataset.cluster_element_info, dataset.cluster_peak_regions = None, None
        return {"assignments": {}, "cluster_counts": {}, "filtered_read_ids": []}

    # The last scan's peaks are offsets from its region's start: only valid there.
    stored = stored_peak_regions_for(state, query.chrom, start, end)
    peaks = [stored[i] for i in req.peak_indices if i < len(stored)] if req.peak_indices else stored
    if not peaks:
        return {"assignments": {}, "cluster_counts": {}, "filtered_read_ids": [],
                "error": "No peaks scanned for this region; scan peaks here first"}

    reads = working_set.reads
    filter_mode = getattr(req, "filter_mode", "either") or "either"
    if filter_mode in ("open", "closed"):
        # Only reads open (or closed) at the peaks are clustered, as the route documents.
        from services.filtering_endpoint import _read_passes_accessibility_filter
        reads = [
            read for read in reads
            if _read_passes_accessibility_filter(
                read, peaks, region_width=end - start, layer=None, filter_mode=filter_mode,
            )
        ]
        if not reads:
            dataset.cluster_assignments, dataset.sorted_indices = {}, None
            dataset.cluster_element_info, dataset.cluster_peak_regions = None, None
            dataset.cluster_feature_settings = None
            return {"assignments": {}, "cluster_counts": {}, "filtered_read_ids": [],
                    "sample_seed": sample_seed, "cluster_random_state": cluster_random_state}

    assignments, counts, sorted_idx, _ = cluster_compact_reads_impl(
        reads,
        peaks,
        start,
        req.k,
        method="kmeans",
        random_state=cluster_random_state,
    )

    dataset.cluster_assignments = assignments
    dataset.sorted_indices = sorted_idx
    # This k-means run replaces any earlier clustering's metadata: no
    # combinatorial patterns, and the peaks it was built on (absolute).
    dataset.cluster_element_info = None
    dataset.cluster_feature_settings = None
    dataset.cluster_peak_regions = [
        {"start": start + int(peak[0]), "end": start + int(peak[1]), "mode": "accessibility"}
        for peak in peaks
    ]
    filtered_ids = [read["id"] for read in reads]

    return {
        "assignments": assignments,
        "cluster_counts": counts,
        "filtered_read_ids": filtered_ids,
        "sample_seed": sample_seed,
        "cluster_random_state": cluster_random_state,
    }


def run_cluster_expand_endpoint(
    *,
    state,
    req,
    chrom: str,
    start: int,
    end: int,
    spanning: bool,
) -> Dict[str, Any]:
    """Return reads from selected clusters for focused display/export."""
    t0 = time.time()
    query = AnalysisReadQuery.from_request(
        state,
        chrom=chrom,
        start=start,
        end=end,
        spanning=spanning,
        dataset_id=req.dataset_id,
        sample_seed=req.sample_seed,
    )
    sample_seed = query.sample_seed
    if not query.dataset_ids:
        return {"reads": [], "count": 0, "cluster_counts": {}, "sample_seed": sample_seed}

    dataset_id = query.dataset_ids[0]
    working_set = query.build_working_set(state, dataset_id)
    if not working_set.reads:
        return {"reads": [], "count": 0, "cluster_counts": {}, "sample_seed": sample_seed}

    cluster_ids = set(req.cluster_ids)
    dataset = state.get_dataset(dataset_id)
    # Prefer the frontend's active-branch assignments when supplied.
    assignment_overrides = getattr(req, "cluster_assignments", None) or {}
    # Explicit (even empty) overrides win; only an absent one falls back.
    override = assignment_overrides.get(dataset_id)
    cluster_assignments = override if override is not None else (dataset.cluster_assignments if dataset else {})
    if not cluster_assignments:
        return {"reads": [], "count": 0, "cluster_counts": {}, "sample_seed": sample_seed}

    cluster_reads = [
        read for read in working_set.reads
        if cluster_assignments.get(read["id"]) in cluster_ids
    ]

    cluster_counts = {}
    for read in cluster_reads:
        cluster_id = cluster_assignments.get(read["id"])
        cluster_counts[cluster_id] = cluster_counts.get(cluster_id, 0) + 1

    if len(cluster_reads) > req.max_reads:
        cluster_reads = sample_by_coverage(cluster_reads, req.max_reads, 0, end - start)

    cluster_reads.sort(key=lambda read: read["intervals"][0][0] if read["intervals"] else 0)

    log_clustering_diagnostic(
        f"Cluster expand: {len(cluster_reads)} reads from clusters {req.cluster_ids} in {time.time() - t0:.2f}s"
    )
    return {
        "reads": cluster_reads,
        "count": len(cluster_reads),
        "cluster_counts": {int(k): v for k, v in cluster_counts.items()},
        "total_in_clusters": sum(cluster_counts.values()),
        "sample_seed": sample_seed,
    }


def get_working_set_info_payload(
    *,
    state,
    chrom: str,
    start: int,
    end: int,
    dataset_id: str | None,
    spanning: bool,
    sample_seed: str | None,
) -> Dict[str, Any]:
    """Return working-set and cluster summary stats for a viewport."""
    # This only reports read COUNTS — it never reads layer/methylation payloads.
    # Loading them (the default) opens every companion file for the region, which
    # makes the cluster panel crawl on merged multi-layer datasets.
    query = AnalysisReadQuery.from_request(
        state,
        chrom=chrom,
        start=start,
        end=end,
        spanning=spanning,
        dataset_id=dataset_id,
        sample_seed=sample_seed,
        include_methylation=False,
        include_layers=False,
    )
    sample_seed = query.sample_seed
    empty = {
        "has_working_set": False,
        "working_count": 0,
        "total_spanning": 0,
        "total_overlapping": 0,
        "has_clusters": False,
        "cluster_count": 0,
        "sample_seed": sample_seed,
    }
    if not query.dataset_ids:
        return empty

    dataset_id = query.dataset_ids[0]
    working_set = query.build_working_set(state, dataset_id)
    if not working_set or not working_set.reads:
        return empty

    dataset = state.get_dataset(dataset_id)
    cluster_assignments = dataset.cluster_assignments if dataset else {}
    unique_clusters = len(set(cluster_assignments.values())) if cluster_assignments else 0

    return {
        "has_working_set": True,
        "working_count": len(working_set.reads),
        "total_spanning": working_set.total_spanning,
        "total_overlapping": working_set.total_overlapping,
        "has_clusters": bool(cluster_assignments),
        "cluster_count": unique_clusters,
        # Plain ints (numpy keys from value_counts() can't be JSON-encoded).
        "cluster_sizes": {int(k): int(v) for k, v in count_cluster_assignments(cluster_assignments).items()}
                         if cluster_assignments else {},
        "max_working_reads": state.max_working_reads,
        "sample_seed": sample_seed,
    }
