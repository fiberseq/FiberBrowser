"""Endpoint orchestration helpers for read filtering routes."""
from __future__ import annotations

from services.scoped_read_analysis import scoped_analysis

from services.gene_ids import resolve_selected_transcripts
import time
from typing import Optional

from models.requests import AnalysisFilterRequest, FilterRequest, SortReadsRequest, TranscriptionStateFilterRequest
from services.analysis_query import AnalysisReadQuery
from services.circular_genome import circular_query_segments_for_region
from services.filter_diagnostics import log_filtering_diagnostic
from services.fire_tracks import compute_fire_track
from services.read_metrics import compute_fp_metrics, compute_rule_metric, get_layer_intervals
from services.read_selection import cohort_read_id
from services.read_sorting import sort_similarity_for_dataset
from services.transcription_state import (
    evaluate_read_states,
    filter_reads_by_transcription_state as filter_transcription_reads,
    has_active_transcription_filters,
    merge_read_states,
    read_overlaps_gene,
)
from services.peak_scanning import remember_peak_regions, stored_peak_regions_for


def _empty_filter_response(sample_seed: str) -> dict:
    return {"read_ids": [], "total": 0, "filtered": 0, "sample_seed": sample_seed}


def _all_filter_response(reads: list[dict], sample_seed: str) -> dict:
    # Lifted rows answer by their cohort identity (one record's rows share a QNAME); native rows by their id.
    read_ids = [cohort_read_id(read) for read in reads]
    return {
        "read_ids": read_ids,
        "total": len(reads),
        "filtered": len(reads),
        "sample_seed": sample_seed,
    }


def _resolve_filter_peaks(state, req: FilterRequest, chrom: str, start: int, end: int) -> list[list[int]]:
    if req.peak_regions:
        return [[peak.start - start, peak.end - start] for peak in req.peak_regions]

    if not req.peak_indices:
        return []

    stored = stored_peak_regions_for(state, chrom, start, end)
    if not stored:
        _, _, stored = compute_fire_track(
            state.fire_df,
            chrom,
            start,
            end,
            query_segments=circular_query_segments_for_region(state, chrom, start, end),
        )
        remember_peak_regions(state, stored, chrom, start, end)
    return [stored[index] for index in req.peak_indices if index < len(stored)]


def _read_passes_accessibility_filter(
    read: dict,
    peaks_to_check: list[list[int]],
    *,
    region_width: int,
    layer: Optional[str],
    filter_mode: str,
) -> bool:
    primary_intervals = read.get("intervals", [])
    if not primary_intervals:
        return False

    if layer is None:
        accessibility_intervals = primary_intervals
    else:
        accessibility_intervals = get_layer_intervals(read, layer)

    total_accessible_positions = 0
    total_positions = 0

    for peak_start, peak_end in peaks_to_check:
        peak_start = max(0, int(peak_start))
        peak_end = min(region_width, int(peak_end))
        if peak_end <= peak_start:
            continue

        # The bases of the peak this read actually covers: sequence it doesn't
        # reach is unobserved, not closed.
        observed = sum(
            max(0, min(interval_end, peak_end) - max(interval_start, peak_start))
            for interval_start, interval_end, *_rest in primary_intervals
        )
        if observed <= 0:
            return False
        total_positions += min(observed, peak_end - peak_start)

        # Layer intervals may be [start, end] (or carry extra columns, e.g. quality).
        for interval in accessibility_intervals:
            if len(interval) < 2:
                continue
            interval_start, interval_end = interval[0], interval[1]
            size = interval[2] if len(interval) > 2 else interval_end - interval_start
            if interval_end <= peak_start or interval_start >= peak_end:
                continue
            overlap_start = max(interval_start, peak_start)
            overlap_end = min(interval_end, peak_end)
            overlap_width = overlap_end - overlap_start
            if overlap_width <= 0:
                continue

            if layer is None:
                if size < 0 or (0 < size < 90):
                    total_accessible_positions += overlap_width
            else:
                total_accessible_positions += overlap_width

    if filter_mode == "either":
        return True
    if total_positions <= 0:
        return False
    if filter_mode == "open":
        return total_accessible_positions / total_positions > 0.5
    return total_accessible_positions / total_positions <= 0.5


def filter_reads_for_request(
    state,
    req: FilterRequest,
    *,
    chrom: str,
    start: int,
    end: int,
    spanning: bool = False,
    dataset_id: Optional[str] = None,
) -> dict:
    """Filter reads by accessibility at selected peaks."""
    t0 = time.time()
    query = AnalysisReadQuery.from_request(
        state,
        chrom=chrom,
        start=start,
        end=end,
        spanning=spanning,
        dataset_id=dataset_id,
        sample_seed=req.sample_seed,
        include_layers=bool(req.layer),
        requested_layers=_requested_layers(req.layer),
        capability="filter",
        lift_hap_by_dataset=req.lift_hap_by_dataset,
    )
    sample_seed = query.sample_seed
    if not query.dataset_ids:
        return _empty_filter_response(sample_seed)

    resolved_dataset_id = query.dataset_ids[0]
    working_set = query.build_working_set(state, resolved_dataset_id)
    if not working_set.reads:
        return _empty_filter_response(sample_seed)

    peaks_to_check = _resolve_filter_peaks(state, req, query.chrom, start, end)
    if not peaks_to_check:
        return _all_filter_response(working_set.reads, sample_seed)

    layer = req.layer
    log_filtering_diagnostic(
        f"Filter: mode={req.filter_mode}, peaks={len(peaks_to_check)}, "
        f"reads={len(working_set.reads)}, layer={layer or 'HMM calls'}"
    )

    filtered_ids = [
        cohort_read_id(read)
        for read in working_set.reads
        if _read_passes_accessibility_filter(
            read,
            peaks_to_check,
            region_width=end - start,
            layer=layer,
            filter_mode=req.filter_mode,
        )
    ]

    elapsed = time.time() - t0
    log_filtering_diagnostic(
        f"  Filter: {len(filtered_ids)}/{len(working_set.reads)} reads passed in {elapsed:.3f}s"
    )

    return {
        "read_ids": filtered_ids,
        "total": len(working_set.reads),
        "filtered": len(filtered_ids),
        "sample_seed": sample_seed,
    }


def _sort_similarity_for_request(
    state,
    req: SortReadsRequest,
    query: AnalysisReadQuery,
    *,
    start: int,
    end: int,
    spanning: bool,
) -> dict:
    results = {}
    for dataset_id in query.dataset_ids:
        results[dataset_id] = sort_similarity_for_dataset(
            state,
            dataset_id,
            query.chrom,
            start,
            end,
            spanning,
            sample_seed=query.sample_seed,
            read_ids=query.read_ids_for_dataset(dataset_id),
            cluster_assignments_override=_cluster_assignments_for_sort(state, req, dataset_id),
            peak_regions_override=[{"start": int(a), "end": int(b), "mode": "accessibility"} for a, b, *_ in (req.peak_regions or [])] or None,
            lift_hap=(req.lift_hap_by_dataset or {}).get(dataset_id),
        )

    if req.linked and len(query.dataset_ids) > 1 and len(results) > 1:
        reference_order = None
        for dataset_id in query.dataset_ids:
            order = results.get(dataset_id, {}).get("cluster_order", [])
            if order and len(order) > 1:
                reference_order = order
                break
        if reference_order:
            for dataset_id in results:
                results[dataset_id]["cluster_order"] = reference_order

    return {"results": results, "sample_seed": query.sample_seed}


def _sort_projection_for_request(
    state,
    req: SortReadsRequest,
    query: AnalysisReadQuery,
    *,
    chrom: str,
    start: int,
    end: int,
    spanning: bool,
) -> dict:
    """Order reads along the t-SNE map of their clustering features.

    The map is the Projection tab's (same features, seed and cache), so
    neighbours on the map end up next to each other in the read panel:
    clusters follow a path through their centroids and the reads of each
    cluster a nearest-neighbour path through the map (read_projection).
    """
    import numpy as np

    from models.requests import ProjectionRequest
    from services.clustering_endpoint import run_cluster_projection_endpoint
    from services.read_projection import order_by_projection

    settings = req.projection
    # The reads to order: the request's (possibly scoped) clusters and read ids.
    scoped: dict[str, dict[str, int]] = {}
    unscoped: dict[str, dict[str, int]] = {}
    for dataset_id in query.dataset_ids:
        assigned = _cluster_assignments_for_sort(state, req, dataset_id) or {}
        unscoped[dataset_id] = assigned
        scope = query.read_ids_for_dataset(dataset_id)
        if scope is not None:
            # By identity: a graph run's labels are record keys, a scope's ids cohort identities (graph features review).
            from services.lift.cohort import record_key
            scope_set = set(scope) | {rk for x in scope if (rk := record_key(x))}
            assigned = {read_id: cluster for read_id, cluster in assigned.items() if read_id in scope_set}
        scoped[dataset_id] = assigned
    # The map: the whole clustering the Projection tab shows (given, else the
    # clusters before the read-id scope); only the scoped reads are ordered.
    full = (settings.cluster_assignments if settings else None) or {}
    map_assignments = {
        dataset_id: ({str(k): int(v) for k, v in full[dataset_id].items()} if dataset_id in full else unscoped[dataset_id])
        for dataset_id in query.dataset_ids
    }
    projection = run_cluster_projection_endpoint(
        state=state,
        req=ProjectionRequest(
            dataset_ids=list(query.dataset_ids),
            lift_hap_by_dataset=req.lift_hap_by_dataset,
            peak_regions=list(settings.peak_regions) if settings else [],
            method="tsne",
            subnucleosomal_threshold=settings.subnucleosomal_threshold if settings else 90,
            cluster_feature_rules=list(settings.cluster_feature_rules) if settings else [],
            sample_seed=req.sample_seed,
            cluster_assignments=map_assignments,
            max_reads=settings.max_reads if settings else None,
        ),
        chrom=chrom,
        start=start,
        end=end,
        spanning=spanning,
    )
    empty = {dataset_id: {"cluster_order": [], "read_sort_order": []} for dataset_id in query.dataset_ids}
    if projection.get("error") or not projection.get("n_reads"):
        return {
            "results": empty,
            "sample_seed": query.sample_seed,
            "error": projection.get("error") or "No clustered reads to project: cluster first.",
        }

    read_ids = projection["read_ids"]
    read_datasets = projection["dataset_ids"]
    coords = np.column_stack([projection["coords_x"], projection["coords_y"]])
    labels = np.asarray(projection["labels_before"])
    keys = [f"{dataset_id}::{read_id}" for dataset_id, read_id in zip(read_datasets, read_ids)]

    def ordered_rows(rows: np.ndarray) -> tuple[list[int], list[int]]:
        out = order_by_projection(coords[rows], labels[rows], keys=[keys[i] for i in rows])
        return [int(rows[i]) for i in out["order"]], list(out["cluster_order"])

    all_rows = np.arange(len(read_ids))
    linked = req.linked or len(query.dataset_ids) == 1
    if linked:
        # One clustering across the datasets: one path through its clusters.
        shared_order, shared_clusters = ordered_rows(all_rows)
    results = {}
    for dataset_id in query.dataset_ids:
        if linked:
            row_order, cluster_order = shared_order, shared_clusters
        else:
            # Each dataset clustered on its own: its own clusters, its own path.
            rows = np.flatnonzero(np.asarray(read_datasets) == dataset_id)
            row_order, cluster_order = ordered_rows(rows) if rows.size else ([], [])
        wanted = scoped.get(dataset_id, {})
        from services.lift.cohort import record_key

        def label_key(rid):
            # The label's key for a mapped read: its own id, else its record key (a graph run's labels).
            if rid in wanted:
                return rid
            rk = record_key(rid)
            return rk if rk in wanted else None
        order = [read_ids[i] for i in row_order if read_datasets[i] == dataset_id and label_key(read_ids[i]) is not None]
        placed = set(order) | {label_key(r) for r in order}
        # Clustered reads the map couldn't use (none in this window) keep their place after it.
        order += [read_id for read_id in wanted if read_id not in placed]
        present = {wanted[label_key(read_id) or read_id] for read_id in order}
        results[dataset_id] = {
            "cluster_order": [c for c in cluster_order if c in present],
            "read_sort_order": order,
        }
    return {
        "results": results,
        "sample_seed": query.sample_seed,
        "projection_params": projection.get("projection_params"),
    }


def _build_rule_gene_regions(state, rule: dict | None, chrom: str, start: int, end: int) -> tuple[list, dict]:
    gene_regions = []
    gene_regions_by_key = {}
    if not rule:
        return gene_regions, gene_regions_by_key

    conditions = rule.get("conditions", [])
    if not any(condition.get("target") == "gene" for condition in conditions):
        return gene_regions, gene_regions_by_key

    from services.gene_annotations import get_gene_region_records

    gene_records = get_gene_region_records(state.gtf_data, chrom, start, end)
    gene_regions = [(record["start"], record["end"]) for record in gene_records]
    for record in gene_records:
        region = (record["start"], record["end"])
        if record.get("id"):
            gene_regions_by_key.setdefault(f"id:{record['id']}", []).append(region)
        if record.get("name"):
            gene_regions_by_key.setdefault(f"name:{str(record['name']).lower()}", []).append(region)
    return gene_regions, gene_regions_by_key


def _build_sort_gene_regions(state, req: SortReadsRequest, chrom: str, start: int, end: int) -> tuple[list, dict]:
    if req.sort_by != "rule":
        return [], {}
    return _build_rule_gene_regions(state, req.rule, chrom, start, end)


def _requested_layers(layer: Optional[str]) -> Optional[list[str]]:
    """Layers to load for a metric's layer. 'all_fp' is the union of every
    footprint layer, not a layer of its own, so all layers are loaded."""
    if not layer or layer == "all_fp":
        return None
    return [layer]


def _merge_spans(spans) -> list[tuple[int, int]]:
    merged: list[list[int]] = []
    for lo, hi in sorted((int(a), int(b)) for a, b in spans if int(b) > int(a)):
        if merged and lo <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], hi)
        else:
            merged.append([lo, hi])
    return [(lo, hi) for lo, hi in merged]


def _footprint_occupancy(read: dict, start: int, windows, layer: Optional[str]) -> float:
    """Fraction of the windows' bases (absolute) covered by the read's footprints.

    Footprint bases are counted where they fall, so a footprint covering a
    window counts for it wherever its midpoint is, and one only touching it
    counts only its overlap. Overlapping calls (e.g. 'all_fp') count once.
    """
    windows = _merge_spans(windows)
    width = sum(hi - lo for lo, hi in windows)
    if width <= 0:
        return 0
    footprints = _merge_spans(
        (start + interval[0], start + interval[1])
        for interval in get_layer_intervals(read, layer)
        if len(interval) >= 2 and (interval[2] if len(interval) > 2 else interval[1] - interval[0]) > 0
    )
    covered = 0
    i = 0
    for lo, hi in windows:
        while i < len(footprints) and footprints[i][1] <= lo:
            i += 1
        j = i
        while j < len(footprints) and footprints[j][0] < hi:
            covered += max(0, min(hi, footprints[j][1]) - max(lo, footprints[j][0]))
            j += 1
    return covered / width


def _compute_sort_metric(
    read: dict,
    *,
    start: int,
    end: int,
    sort_by: str,
    rule: dict | None,
    gene_regions: list,
    peak_regions: list[tuple[int, int]],
    layer: Optional[str],
    scope_windows: list[tuple[int, int]] | None = None,
    gene_regions_by_key: dict | None = None,
    transcription_state: str | None = None,
    transcription_genes: list[dict] | None = None,
) -> float:
    if sort_by == "transcription_state" and transcription_state:
        return _compute_transcription_state_metric(
            read,
            transcription_genes or [],
            start,
            transcription_state,
        )
    if sort_by == "rule" and rule:
        return compute_rule_metric(
            read,
            start,
            rule,
            gene_regions,
            peak_regions,
            layer=layer,
            gene_regions_by_key=gene_regions_by_key or {},
            scope_windows=scope_windows,
        )
    if sort_by == "occupancy":
        return _footprint_occupancy(read, start, scope_windows or [(start, end)], layer)
    if sort_by == "fp_count":
        fp_count, _, _ = compute_fp_metrics(read, start, scope_windows, layer=layer)
        return fp_count
    if sort_by == "fp_rate":
        _, fp_sum, total_sum = compute_fp_metrics(read, start, scope_windows, layer=layer)
        return fp_sum / total_sum if total_sum > 0 else 0
    if sort_by == "accessibility":
        _, fp_sum, total_sum = compute_fp_metrics(read, start, scope_windows, layer=layer)
        return 1 - (fp_sum / total_sum) if total_sum > 0 else 1
    return 0


def _compute_transcription_state_metric(
    read: dict,
    genes: list[dict],
    region_start: int,
    state_kind: str,
) -> float:
    if not genes or not read.get("intervals"):
        return 0

    best_states = None
    for gene in genes:
        if not read_overlaps_gene(read, gene, region_start):
            continue
        best_states = merge_read_states(
            best_states,
            evaluate_read_states(read, gene, region_start),
        )
    if best_states is None:
        return 0

    if state_kind == "elongating":
        return float(best_states["elongating_count"])
    if state_kind in ("pause", "pic"):
        return 1.0 if best_states[state_kind] else 0.0
    return 0


def _analysis_filter_sort_by(metric: str, rule: dict | None = None) -> str:
    if metric == "occupancy":
        return "occupancy"
    if metric == "rate":
        return "fp_rate"
    if metric == "accessibility":
        return "accessibility"
    # A count with a rule counts the rule's matches; without one, every
    # footprint in scope (never a silent 0 for all reads).
    return "rule" if rule else "fp_count"


def _term_layers(layer: Optional[str], molecule_metric: Optional[str] = None) -> tuple[bool, Optional[list[str]]]:
    """(include_layers, requested_layers) a rule's term needs: its layer, and for a molecule metric the scalar group
    that carries it (nucmol, nfrmol), so the rows have their scalars. Nothing for a term needing neither."""
    from services.nuc.scalars import group_of
    group = group_of(molecule_metric)
    if group:
        return True, [group] + ([layer] if layer and layer != "all_fp" else [])
    return bool(layer), _requested_layers(layer)


def _hub_counter(state, feature_hub: Optional[dict], wanted_default: str = "1"):
    """A function (read, dataset id) -> the number of the given hub hits where the read's state is the wanted one
    ('1' member / open, '0' not; '.' never counts), from the hub's states provider (/api/features/states)."""
    if not feature_hub:
        return None
    from services.feature_states import feature_states
    from services.lift.cohort import record_key
    hits = [h for h in feature_hub.get("hits") or [] if isinstance(h, dict) and h.get("set_id") and h.get("hit_id")]
    if not hits:
        raise ValueError("feature_hub: give the hub hits (set_id, hit_id)")
    wanted = str(feature_hub.get("state") or wanted_default)
    if wanted not in ("1", "0"):
        raise ValueError("feature_hub: state is '1' or '0'")
    states = feature_states(state, [dict(kind="hub", source=str(h["set_id"]), id=str(h["hit_id"])) for h in hits])
    by_dataset = states.get("by_dataset") or {}

    def count(read, dataset_id):
        keyed = by_dataset.get(dataset_id) or {}
        rk = record_key(read.get("analysis_id")) if read.get("analysis_id") is not None else None
        text = keyed.get(rk) if rk else None
        if text is None:
            text = keyed.get(str(read.get("id", "")))
        return float(text.count(wanted)) if text else 0.0
    return count


def _metric_passes_filter(value: Optional[float], operator: str, threshold: float,
                          threshold_max: Optional[float] = None) -> bool:
    if value is None:
        return False   # a missing value (a molecule metric the read lacks) never passes
    if operator == "between":
        hi = threshold if threshold_max is None else threshold_max
        return threshold <= value <= hi
    if operator == "gt":
        return value > threshold
    if operator == "lt":
        return value < threshold
    if operator == "lte":
        return value <= threshold
    if operator == "eq":
        return value == threshold
    return value >= threshold


def filter_reads_by_analysis_rule_for_request(
    state,
    req: AnalysisFilterRequest,
    *,
    chrom: str,
    start: int,
    end: int,
    spanning: bool = False,
) -> dict:
    # Layers the rule's term needs (its layer; a molecule metric's scalar group), not only a layer named directly.
    term_include, term_layers = _term_layers(req.layer, req.molecule_metric if req.metric == "value" else None)
    query = AnalysisReadQuery.from_request(
        state,
        chrom=chrom,
        start=start,
        end=end,
        spanning=spanning,
        dataset_ids=req.dataset_ids,
        sample_seed=req.sample_seed,
        include_layers=term_include or bool(req.transcription_state),
        requested_layers=term_layers,
        capability="filter",
        lift_hap_by_dataset=req.lift_hap_by_dataset,
    )
    if not query.dataset_ids:
        return {"results": {}, "sample_seed": query.sample_seed}
    if req.metric == "value" and not req.molecule_metric:
        raise ValueError("The value metric needs a molecule metric")
    hub_count = _hub_counter(state, req.feature_hub)

    sort_by = "transcription_state" if req.transcription_state else _analysis_filter_sort_by(req.metric, req.rule)
    peak_regions = [(region[0], region[1]) for region in req.peak_regions] if req.peak_regions else []
    scope_windows = [(region[0], region[1]) for region in req.scope_windows] if req.scope_windows else None
    gene_regions, gene_regions_by_key = _build_rule_gene_regions(state, req.rule, query.chrom, start, end)
    transcription_genes = _resolve_transcription_genes(state, req.gene_ids, query.chrom) if req.transcription_state else []
    threshold = float(req.threshold)

    results = {}
    for dataset_id in query.dataset_ids:
        working_set = query.build_working_set(state, dataset_id)
        if not working_set.reads:
            results[dataset_id] = {"read_ids": [], "total": 0, "filtered": 0}
            continue

        filtered_ids = []
        for read in working_set.reads:
            if req.metric == "value":
                from services.nuc.scalars import metric_value
                if _metric_passes_filter(metric_value(read, req.molecule_metric), req.operator, threshold,
                                         req.threshold_max):
                    filtered_ids.append(cohort_read_id(read))
                continue
            if hub_count is not None:
                if _metric_passes_filter(hub_count(read, dataset_id), req.operator, threshold, req.threshold_max):
                    filtered_ids.append(cohort_read_id(read))
                continue
            metric = _compute_sort_metric(
                read,
                start=start,
                end=end,
                sort_by=sort_by,
                rule=req.rule,
                gene_regions=gene_regions,
                peak_regions=peak_regions,
                layer=req.layer,
                scope_windows=scope_windows,
                gene_regions_by_key=gene_regions_by_key,
                transcription_state=req.transcription_state,
                transcription_genes=transcription_genes,
            )
            if _metric_passes_filter(metric, req.operator, threshold, req.threshold_max):
                filtered_ids.append(cohort_read_id(read))

        results[dataset_id] = {
            "read_ids": filtered_ids,
            "total": len(working_set.reads),
            "filtered": len(filtered_ids),
        }

    return {"results": results, "sample_seed": query.sample_seed}


def _assignment_lookup(cluster_assignments: dict):
    """A read's cluster in a panel's assignments: its cohort identity (lifted) or id, else its record key (a graph
    run writes lifted labels under record keys, DESIGN_GRAPH_PRIMARY §3.1; graph features review)."""
    def lookup(read):
        rid = cohort_read_id(read)
        c = cluster_assignments.get(rid)
        if c is None and read.get("analysis_id") is not None:
            from services.lift.cohort import record_key
            rk = record_key(read["analysis_id"])
            c = cluster_assignments.get(rk) if rk else None
        return c
    return lookup


def _sort_dataset_reads(
    all_reads: list[dict],
    cluster_assignments: dict,
    *,
    req: SortReadsRequest,
    start: int,
    end: int,
    gene_regions: list,
    peak_regions: list[tuple[int, int]],
    scope_windows: list[tuple[int, int]] | None,
    gene_regions_by_key: dict,
    transcription_genes: list[dict],
) -> dict:
    has_clusters = bool(cluster_assignments)
    metric_scope = scope_windows
    read_metrics = {
        cohort_read_id(read): _compute_sort_metric(
            read,
            start=start,
            end=end,
            sort_by=req.sort_by,
            rule=req.rule,
            gene_regions=gene_regions,
            peak_regions=peak_regions,
            layer=req.layer,
            scope_windows=metric_scope,
            gene_regions_by_key=gene_regions_by_key,
            transcription_state=req.transcription_state,
            transcription_genes=transcription_genes,
        )
        for read in all_reads
    }

    cluster_of = _assignment_lookup(cluster_assignments)
    read_cluster = {cohort_read_id(read): cluster_of(read) for read in all_reads} if has_clusters else {}
    values = [value for read_id, value in read_metrics.items()
              if not has_clusters or read_cluster.get(read_id) is not None]
    note = {}
    if len(values) < 2 or len(set(values)) == 1:
        note["no_op_reason"] = (
            "Fewer than two reads to sort. Check the region and filters." if len(values) < 2 else
            "All reads have the same value for this sort. Choose another layer, rule or region."
        )

    if not has_clusters:
        sorted_reads = sorted(read_metrics.items(), key=lambda item: item[1], reverse=req.descending)
        return {"cluster_order": [], "read_sort_order": [read_id for read_id, _metric in sorted_reads], **note}

    cluster_totals = {}
    cluster_reads = {}
    for read_id, cluster in read_cluster.items():
        if cluster is None:
            continue
        cluster_totals.setdefault(cluster, 0)
        cluster_reads.setdefault(cluster, [])
        metric = read_metrics.get(read_id, 0)
        cluster_totals[cluster] += metric
        cluster_reads[cluster].append((read_id, metric))

    cluster_means = {
        cluster: total / len(cluster_reads[cluster]) if cluster_reads[cluster] else 0
        for cluster, total in cluster_totals.items()
    }
    sorted_clusters = sorted(cluster_means, key=lambda cluster: cluster_means[cluster], reverse=req.descending)

    flat_read_order = []
    for cluster in sorted_clusters:
        sorted_reads = sorted(cluster_reads[cluster], key=lambda item: item[1], reverse=req.descending)
        flat_read_order.extend(read_id for read_id, _metric in sorted_reads)

    return {"cluster_order": sorted_clusters, "read_sort_order": flat_read_order, **note}


def _sort_by_values(all_reads: list[dict], cluster_assignments: dict, req: SortReadsRequest, dataset_id: str,
                    hub_count=None) -> dict:
    """Reads (and clusters, by their mean) ordered by a molecule metric or a hub-state count; reads without a value
    go last whatever the direction, and clusters with no value at all after the others."""
    from services.nuc.scalars import metric_value
    values = {}
    for read in all_reads:
        rid = cohort_read_id(read)
        values[rid] = hub_count(read, dataset_id) if hub_count is not None else metric_value(read, req.molecule_metric)

    def order(items):
        known = sorted((x for x in items if x[1] is not None), key=lambda x: x[1], reverse=req.descending)
        return known + [x for x in items if x[1] is None]
    note = {}
    known = [v for v in values.values() if v is not None]
    if len(known) < 2 or len(set(known)) == 1:
        note["no_op_reason"] = ("Fewer than two reads have this value here." if len(known) < 2 else
                                "All reads have the same value for this sort.")
    if not cluster_assignments:
        return {"cluster_order": [], "read_sort_order": [rid for rid, _v in order(list(values.items()))], **note}
    cluster_of = _assignment_lookup(cluster_assignments)
    by_cluster: dict = {}
    for read in all_reads:
        c = cluster_of(read)
        if c is not None:
            by_cluster.setdefault(c, []).append((cohort_read_id(read), values[cohort_read_id(read)]))
    means = {c: (sum(v for _r, v in items if v is not None) / max(1, sum(v is not None for _r, v in items))
                 if any(v is not None for _r, v in items) else None) for c, items in by_cluster.items()}
    clusters = [c for c, _m in order(list(means.items()))]
    flat = [rid for c in clusters for rid, _v in order(by_cluster[c])]
    return {"cluster_order": clusters, "read_sort_order": flat, **note}


def _cluster_assignments_for_sort(state, req: SortReadsRequest, dataset_id: str) -> dict[str, int]:
    request_assignments = (req.cluster_assignments or {}).get(dataset_id)
    if request_assignments is not None:
        return {str(read_id): int(cluster) for read_id, cluster in request_assignments.items()}
    dataset = state.get_dataset(dataset_id)
    return dataset.cluster_assignments if dataset else {}


def _apply_linked_sort_order(
    state,
    req: SortReadsRequest,
    query: AnalysisReadQuery,
    results: dict,
    *,
    start: int,
    end: int,
    gene_regions: list,
    peak_regions: list[tuple[int, int]],
    scope_windows: list[tuple[int, int]] | None,
    gene_regions_by_key: dict,
    transcription_genes: list[dict],
) -> None:
    if not req.linked or len(query.dataset_ids) <= 1:
        return

    pooled_totals = {}
    pooled_counts = {}
    for dataset_id, dataset_result in results.items():
        if not dataset_result.get("cluster_order"):
            continue
        cluster_assignments = _cluster_assignments_for_sort(state, req, dataset_id)
        if not cluster_assignments:
            continue
        working_set = query.build_working_set(state, dataset_id)
        if not working_set.reads:
            continue

        cluster_of = _assignment_lookup(cluster_assignments)
        for read in working_set.reads:
            cluster = cluster_of(read)
            if cluster is None:
                continue
            metric = _compute_sort_metric(
                read,
                start=start,
                end=end,
                sort_by=req.sort_by,
                rule=req.rule,
                gene_regions=gene_regions,
                peak_regions=peak_regions,
                layer=req.layer,
                scope_windows=scope_windows,
                gene_regions_by_key=gene_regions_by_key,
                transcription_state=req.transcription_state,
                transcription_genes=transcription_genes,
            )
            pooled_totals[cluster] = pooled_totals.get(cluster, 0) + metric
            pooled_counts[cluster] = pooled_counts.get(cluster, 0) + 1

    if not pooled_totals:
        return

    pooled_means = {
        cluster: pooled_totals[cluster] / pooled_counts[cluster]
        for cluster in pooled_totals
        if pooled_counts.get(cluster, 0) > 0
    }
    unified_order = sorted(pooled_means, key=lambda cluster: pooled_means[cluster], reverse=req.descending)
    for dataset_id, dataset_result in results.items():
        if not dataset_result.get("cluster_order"):
            continue
        # Ties within one dataset can still separate the pooled clusters.
        if len(set(pooled_means.values())) > 1:
            dataset_result.pop("no_op_reason", None)
        dataset_result["cluster_order"] = unified_order
        # The reads follow the shared cluster order too (keeping their order within a cluster).
        cluster_assignments = _cluster_assignments_for_sort(state, req, dataset_id)
        from services.lift.cohort import record_key
        by_cluster: dict = {}
        for read_id in dataset_result.get("read_sort_order", []):
            c = cluster_assignments.get(read_id)
            if c is None and (rk := record_key(read_id)):
                c = cluster_assignments.get(rk)
            by_cluster.setdefault(c, []).append(read_id)
        rank = {cluster: index for index, cluster in enumerate(unified_order)}
        dataset_result["read_sort_order"] = [
            read_id
            for cluster in sorted(by_cluster, key=lambda c: rank.get(c, len(rank)))
            for read_id in by_cluster[cluster]
        ]
    log_filtering_diagnostic(f"  Linked sort: unified order {unified_order}")


@scoped_analysis
def sort_reads_for_request(
    state,
    req: SortReadsRequest,
    *,
    chrom: str,
    start: int,
    end: int,
    spanning: bool = False,
) -> dict:
    """Generalized read/cluster sorting."""
    t0 = time.time()
    query = AnalysisReadQuery.from_request(
        state,
        chrom=chrom,
        start=start,
        end=end,
        spanning=spanning,
        dataset_ids=req.dataset_ids,
        sample_seed=req.sample_seed,
        # Metrics use interval/layer evidence. Similarity and projection resolve
        # their own feature payload; raw methylation marks are never used here.
        include_methylation=False,
        include_layers=_term_layers(req.layer, req.molecule_metric if req.sort_by == "value" else None)[0]
        or bool(req.transcription_state),
        requested_layers=_term_layers(req.layer, req.molecule_metric if req.sort_by == "value" else None)[1],
        read_ids_by_dataset=req.read_ids,
        capability="sort",
        lift_hap_by_dataset=req.lift_hap_by_dataset,
    )
    if not query.dataset_ids:
        return {"results": {}}

    if req.sort_by == "similarity":
        response = _sort_similarity_for_request(
            state,
            req,
            query,
            start=start,
            end=end,
            spanning=spanning,
        )
        log_filtering_diagnostic(f"Sort by similarity completed in {time.time() - t0:.3f}s")
        return response

    if req.sort_by == "projection":
        response = _sort_projection_for_request(
            state, req, query, chrom=chrom, start=start, end=end, spanning=spanning,
        )
        log_filtering_diagnostic(f"Sort by projection completed in {time.time() - t0:.3f}s")
        return response

    gene_regions, gene_regions_by_key = _build_sort_gene_regions(
        state,
        req,
        query.chrom,
        start,
        end,
    )
    peak_regions = [(region[0], region[1]) for region in req.peak_regions] if req.peak_regions else []
    scope_windows = (
        [(region[0], region[1]) for region in req.selected_peak_windows]
        if req.selected_peak_windows
        else None
    )
    transcription_genes = _resolve_transcription_genes(state, req.gene_ids, query.chrom) if req.transcription_state else []

    log_filtering_diagnostic(
        f"Sort reads: sort_by={req.sort_by}, datasets={query.dataset_ids}, "
        f"gene_regions={len(gene_regions)}, peak_regions={len(peak_regions)}, "
        f"scope_windows={len(scope_windows) if scope_windows else 'none'}, "
        f"transcription_genes={len(transcription_genes)}"
    )

    if req.sort_by == "value" and not req.molecule_metric:
        raise ValueError("Sorting by value needs a molecule metric")
    hub_count = _hub_counter(state, req.feature_hub) if req.sort_by == "feature_hub" else None
    results = {}
    for dataset_id in query.dataset_ids:
        working_set = query.build_working_set(state, dataset_id)
        if not working_set.reads:
            results[dataset_id] = {"cluster_order": [], "read_sort_order": []}
            continue

        cluster_assignments = _cluster_assignments_for_sort(state, req, dataset_id)
        if req.sort_by in ("value", "feature_hub"):
            results[dataset_id] = _sort_by_values(working_set.reads, cluster_assignments, req, dataset_id, hub_count)
            continue
        results[dataset_id] = _sort_dataset_reads(
            working_set.reads,
            cluster_assignments,
            req=req,
            start=start,
            end=end,
            gene_regions=gene_regions,
            peak_regions=peak_regions,
            scope_windows=scope_windows,
            gene_regions_by_key=gene_regions_by_key,
            transcription_genes=transcription_genes,
        )
        log_filtering_diagnostic(
            f"  {dataset_id}: {len(working_set.reads)} reads, "
            f"clusters={'yes' if cluster_assignments else 'no'}"
        )

    _apply_linked_sort_order(
        state,
        req,
        query,
        results,
        start=start,
        end=end,
        gene_regions=gene_regions,
        peak_regions=peak_regions,
        scope_windows=scope_windows,
        gene_regions_by_key=gene_regions_by_key,
        transcription_genes=transcription_genes,
    )

    log_filtering_diagnostic(f"Sort reads completed in {time.time() - t0:.2f}s")
    return {"results": results, "sample_seed": query.sample_seed}


def _empty_transcription_response(sample_seed: str) -> dict:
    # Same shape as a normal response (clients read ``results``); the legacy
    # top-level keys stay for older callers.
    return {"results": {}, "filtered_ids": {}, "read_states": {}, "summary": {}, "sample_seed": sample_seed}


def _resolve_transcription_genes(state, gene_ids: list[str], chrom: str | None = None) -> list[dict]:
    return resolve_selected_transcripts(state, gene_ids, chrom)


def filter_by_transcription_state_for_request(
    state,
    req: TranscriptionStateFilterRequest,
    *,
    chrom: str,
    start: int,
    end: int,
    spanning: bool = False,
) -> dict:
    """Filter reads by transcription state criteria relative to selected genes."""
    t0 = time.time()
    query = AnalysisReadQuery.from_request(
        state,
        chrom=chrom,
        start=start,
        end=end,
        spanning=spanning,
        dataset_ids=req.dataset_ids,
        sample_seed=req.sample_seed,
    )
    if not query.dataset_ids:
        return _empty_transcription_response(query.sample_seed)

    genes = _resolve_transcription_genes(state, req.gene_ids, query.chrom)
    if not genes:
        log_filtering_diagnostic(f"TranscriptionStateFilter: No genes found for IDs {req.gene_ids}")
        return _empty_transcription_response(query.sample_seed)

    log_filtering_diagnostic(
        f"TranscriptionStateFilter: {len(genes)} genes, filters={req.filters}, "
        f"datasets={query.dataset_ids}"
    )

    filters = req.filters or {}
    if not has_active_transcription_filters(filters):
        return _empty_transcription_response(query.sample_seed)

    results = {}
    for dataset_id in query.dataset_ids:
        working_set = query.build_working_set(state, dataset_id)
        dataset = state.get_dataset(dataset_id)
        num_files = len(dataset.paths) if dataset else 0
        log_filtering_diagnostic(
            f"  {dataset_id}: {num_files} files, {len(working_set.reads)} reads in working set"
        )

        results[dataset_id] = filter_transcription_reads(
            working_set.reads,
            genes,
            filters,
            start,
        )
        log_filtering_diagnostic(
            f"  {dataset_id}: {len(results[dataset_id]['filtered_ids'])}/"
            f"{len(working_set.reads)} reads pass filter"
        )

    log_filtering_diagnostic(f"TranscriptionStateFilter completed in {time.time() - t0:.3f}s")
    return {"results": results, "sample_seed": query.sample_seed}
