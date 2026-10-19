"""Compact read-list endpoints.

Extracted from server.py.
"""
from __future__ import annotations

from utils.responses import ORJSONResponse
from services.read_binary import reads_response, binary_read_context, MEDIA_TYPE
from fastapi import APIRouter, Query, Depends, Request
from typing import Optional

from state.dependencies import get_state
from services.working_sets import (
    layer_key_has_payload,
    make_layer_key,
    normalize_requested_layers,
)
from services.read_endpoint import (
    compact_all_dataset_result,
    compact_reads_payload_for_request,
    hidden_by_min_footprints_for_dataset,
    update_current_viewport,
)
from services.read_route_helpers import (
    READ_DIAGNOSTICS_ENV,
    READ_LOG_THRESHOLD_ENV,
    log_read_diagnostic as _log_read_diagnostic,
    query_bool as _query_bool,
    query_int as _query_int,
    unwrap_query_default,
    should_log_read_request as _should_log_read_request,
)
from services.analysis_query import AnalysisReadQuery

import asyncio
import time
from functools import partial
from services.background_work import Cancelled, cancelled_response
from services.read_work import run_read_work

router = APIRouter(tags=["reads"])


def _compact_reads_with_priority(binary=False, **kwargs):
    """The view's reads: background analyses wait while this runs (services/background_work.py)."""
    from services.background_work import interactive_read
    token = binary_read_context.set(binary)
    try:
        with interactive_read():
            return compact_reads_payload_for_request(**kwargs)
    finally:
        binary_read_context.reset(token)


@router.get("/api/reads/compact")
async def get_reads_compact(
    chrom: str = Query(...), start: int = Query(...), end: int = Query(...),
    max_reads: int = Query(500),  # Display reads (sampled from working set)
    spanning: bool = Query(False),  # Filter to spanning reads
    dataset_id: Optional[str] = Query(None),
    include_methylation: bool = Query(False),
    include_layers: bool = Query(False, description="Include display annotation layers such as TF/FIRE/nuc"),
    layer_names: Optional[str] = Query(None, description="Comma-separated annotation layers to include when include_layers is true"),
    include_layer_qualities: bool = Query(True, description="Include per-layer quality arrays such as tq/aq/edge confidence"),
    ml_threshold: int = Query(125, description="ML score threshold (0-255). Default 125 (matches ft extract)"),
    fill_gap_size: Optional[int] = Query(None, description="Fill gaps smaller than this size (bp) within footprints"),
    min_fp_quality: int = Query(0, description="Min footprint quality score (0-255). Footprints below threshold are hidden."),
    min_footprints: int = Query(0, description="Min number of footprints per read. Set to 5 to filter reads with <5 footprints."),
    cluster_focus: Optional[str] = Query(None, description="Comma-separated cluster IDs to focus on"),
    filter_ids: Optional[str] = Query(None, description="Comma-separated read IDs (base IDs) to filter to before sampling"),
    filter_set: Optional[str] = Query(None, description="A read-name set registered with POST /api/read_sets (a subset too large for filter_ids); narrowed by filter_ids if both"),
    include_mismatches: bool = Query(True, description="Compute live-lift X markers only when the mismatch layer is requested"),
    include_cigar: bool = Query(False, description="Include CIGAR events (mismatches, insertions, deletions) for visualization"),
    include_duplicates: bool = Query(False, description="Include BAM 0x400 / BigBed isDuplicate reads (hidden by default)"),
    hide_terminal_gaps: bool = Query(True, description="Hide leading/trailing gaps in reads (before first footprint, after last footprint)"),
    terminal_gap_threshold: int = Query(500, description="Max terminal gap size (bp). Reads with leading/trailing gaps larger than this are filtered out. 0 = no filtering."),
    infer_legacy_layers: bool = Query(True, description="Infer TF/nuc/FIRE layers from legacy primary footprints"),
    legacy_nuc_min_size: int = Query(90, description="Footprint size cutoff for inferred legacy nucleosomes"),
    include_metaprofile: bool = Query(False, description="Include compact server-computed layer metaprofiles"),
    profile_max_reads: int = Query(1000, description="Read cap for server-computed metaprofiles. 0 disables the cap."),
    metaprofile_layers: Optional[str] = Query(None, description="Comma-separated layer-backed metaprofile sources to compute"),
    sample_seed: Optional[str] = Query(None, description="Seed for reproducible sampling paths"),
    strand: Optional[str] = Query(None, pattern="^(CT|GA|ct|ga|both|BOTH)?$",
                                  description="DAF-seq: only reads from this strand (CT or GA), by their deamination marks"),
    pin_ids: Optional[str] = Query(None, description="Comma-separated read IDs the display sample keeps when they are in view (a read gone to by name)"),
    lift_hap: Optional[str] = Query(None, description="Live lift: only this haplotype's rows (MAT/PAT or a map haplotype key; a split panel's rule)"),
    min_sv_len: int = Query(50, description="Smallest deletion/insertion/clip (bp) reported in each read's `sv` events and the `sv_summary`"),
    include_sv_seq: bool = Query(False, description="Add the first 1,000 inserted bases to each `sv` insertion event"),
    sv_conflict_options: Optional[str] = Query(None, description="Advanced SV clip conflict thresholds (JSON)"),
    include_sv_summary: bool = Query(True, description="Add `sv_summary`: SV clusters across the reads in view"),
    full_working_set: bool = Query(False, description="Load every read in view: no display sample on deep BAM views (`working_sampling` says when one applies)"),
    viewport_start: Optional[int] = Query(None, description="Visible start when prefetching a containing read span"),
    viewport_end: Optional[int] = Query(None, description="Visible end when prefetching a containing read span"),
    insertion_ids: Optional[str] = Query(None, description="Expanded live-lift insertion IDs; annotations are composed on demand"),
    prefetch: bool = Query(False, description="Speculative read cache fill; yields to navigation and analyses"),
    prefetch_batch: bool = Query(False, description="Warm annotation dependencies used by the multi-dataset display"),
    prefetch_sample_level: Optional[int] = Query(None, ge=0, le=24, description="Keep the visible view's sampling level while warming its neighbors"),
    request: Request = None,
    state=Depends(get_state)):
    """
    Get reads for display using three-tier cache architecture:

    1. Working Set: ALL spanning reads, unless an explicit backend safety cap is set
    2. Display Sample: Subset sampled for rendering (max_reads)

    Analysis (clustering, peaks, Pol II) operates on the full working set by default.
    Display shows a representative sample.
    """
    from services.read_sets import combine_filter
    try:
        # (called directly in tests: an unset Query is its default)
        filter_ids = combine_filter(state, unwrap_query_default(filter_ids, None), unwrap_query_default(filter_set, None))
    except KeyError:
        from fastapi import HTTPException
        raise HTTPException(status_code=410, detail='This read set is no longer registered; register it again')
    if _query_bool(prefetch, False) and _query_bool(prefetch_batch, False):
        # compact_all builds a working set with every active quality gate,
        # including gates on hidden layers. Its speculative fill must carry
        # those same raw annotation dependencies to serve a neighboring view.
        from services.read_quality_filters import active_quality_filters
        from services.working_sets import layer_key_for_quality_filters
        filters = active_quality_filters(state)
        layers = layer_key_for_quality_filters(make_layer_key(
            _query_bool(include_layers, False),
            normalize_requested_layers(unwrap_query_default(layer_names, None)),
        ), filters)
        include_layers = layer_key_has_payload(layers)
        layer_names = None if layers is None else ','.join(layers)
        include_layer_qualities = _query_bool(include_layer_qualities, True) or bool(filters)
    options = dict(
        state=state,
        chrom=chrom,
        start=start,
        end=end,
        max_reads=max_reads,
        spanning=spanning,
        dataset_id=dataset_id,
        include_methylation=include_methylation,
        include_layers=include_layers,
        layer_names=layer_names,
        include_layer_qualities=include_layer_qualities,
        ml_threshold=ml_threshold,
        fill_gap_size=fill_gap_size,
        min_fp_quality=min_fp_quality,
        min_footprints=min_footprints,
        cluster_focus=cluster_focus,
        filter_ids=filter_ids,
        include_cigar=include_cigar,
        include_mismatches=_query_bool(include_mismatches, True),
        include_duplicates=include_duplicates,
        hide_terminal_gaps=hide_terminal_gaps,
        terminal_gap_threshold=terminal_gap_threshold,
        infer_legacy_layers=infer_legacy_layers,
        legacy_nuc_min_size=legacy_nuc_min_size,
        include_metaprofile=include_metaprofile,
        profile_max_reads=profile_max_reads,
        metaprofile_layers=metaprofile_layers,
        sample_seed=sample_seed,
        strand=strand,
        pin_ids=pin_ids,
        lift_hap=unwrap_query_default(lift_hap, None),
        min_sv_len=min_sv_len,
        include_sv_seq=include_sv_seq,
        include_sv_summary=include_sv_summary,
        sv_conflict_options=unwrap_query_default(sv_conflict_options, None),
        full_working_set=full_working_set,
        viewport_start=unwrap_query_default(viewport_start, None),
        viewport_end=unwrap_query_default(viewport_end, None),
        insertion_ids=unwrap_query_default(insertion_ids, None),
    )
    from services.read_stream import MEDIA_TYPE as STREAM_TYPE, stream_reads_response
    if request is not None and STREAM_TYPE in request.headers.get("accept", ""):
        return stream_reads_response(compact_reads_payload_for_request, options,
            prefetch=unwrap_query_default(prefetch, False),
            prefetch_sample_level=unwrap_query_default(prefetch_sample_level, None))
    try:
        payload, = await run_read_work(request, [partial(_compact_reads_with_priority,
            binary=request is not None and MEDIA_TYPE in request.headers.get("accept", ""), **options)])
    except Cancelled:
        return cancelled_response()
    return await asyncio.to_thread(reads_response, payload, request)


@router.get("/api/reads/compact_all")
async def get_reads_compact_all(
    chrom: str = Query(...), start: int = Query(...), end: int = Query(...),
    dataset_id: Optional[str] = Query(None, description="Single dataset ID to load; legacy 'primary' resolves to the first loaded dataset"),
    dataset_ids: Optional[str] = Query(None, description="Comma-separated dataset IDs to load"),
    spanning: bool = Query(False), max_reads: int = Query(1000),
    downsample: Optional[int] = Query(None),
    include_methylation: bool = Query(False),
    include_layers: bool = Query(False, description="Include display annotation layers such as TF/FIRE/nuc"),
    layer_names: Optional[str] = Query(None, description="Comma-separated annotation layers to include when include_layers is true"),
    include_layer_qualities: bool = Query(True, description="Include per-layer quality arrays such as tq/aq/edge confidence"),
    ml_threshold: int = Query(125),
    fill_gap_size: Optional[int] = Query(None),
    min_fp_quality: int = Query(0),
    min_footprints: int = Query(0, description="Min number of footprints per read. Set to 5 to filter reads with <5 footprints."),
    include_metaprofile: bool = Query(True),
    profile_max_reads: int = Query(1000, description="Stable read cap for compact_all metaprofiles. 0 disables the cap."),
    coverage_sample: bool = Query(False),
    hide_terminal_gaps: bool = Query(True, description="Hide leading/trailing gaps in reads (before first footprint, after last footprint)"),
    terminal_gap_threshold: int = Query(500, description="Max terminal gap size (bp). Reads with leading/trailing gaps larger than this are filtered out. 0 = no filtering."),
    infer_legacy_layers: bool = Query(True, description="Infer TF/nuc/FIRE layers from legacy primary footprints"),
    legacy_nuc_min_size: int = Query(90, description="Footprint size cutoff for inferred legacy nucleosomes"),
    include_duplicates: bool = Query(False, description="Include BAM 0x400 / BigBed isDuplicate reads (hidden by default)"),
    sample_seed: Optional[str] = Query(None, description="Seed for reproducible sampling paths"),
    pin_ids: Optional[str] = Query(None, description="Comma-separated read IDs the display sample keeps when they are in view (a read gone to by name)"),
    min_sv_len: int = Query(50, description="Smallest deletion/insertion/clip (bp) in `sv` events and `sv_summary` (served at no less than 50 here)"),
    sv_conflict_options: Optional[str] = Query(None, description="Advanced SV clip conflict thresholds (JSON)"),
    include_sv_summary: bool = Query(True, description="Add each dataset's `sv_summary`"),
    request: Request = None,
    state=Depends(get_state)):
    """
    Get reads for ALL datasets in one request.
    Returns {datasets: {dataset_id: {reads, metaprofile, ...}}}

    This significantly reduces HTTP overhead when viewing multiple datasets.
    """
    t0 = time.time()
    infer_legacy_layers = _query_bool(infer_legacy_layers, True)
    include_duplicates = _query_bool(include_duplicates, False)
    legacy_nuc_min_size = _query_int(legacy_nuc_min_size, 90)
    profile_max_reads = _query_int(profile_max_reads, 1000)
    requested_layers = normalize_requested_layers(layer_names)
    query = AnalysisReadQuery.from_request(
        state,
        capability="compact_all",
        chrom=chrom,
        start=start,
        end=end,
        dataset_id=dataset_id,
        dataset_ids=dataset_ids,
        spanning=spanning,
        sample_seed=sample_seed,
        min_footprints=min_footprints,
        include_methylation=include_methylation,
        include_layers=include_layers,
        requested_layers=requested_layers,
        include_layer_qualities=include_layer_qualities,
        infer_legacy_layers=infer_legacy_layers,
        legacy_nuc_min_size=legacy_nuc_min_size,
    )
    sample_seed = query.sample_seed
    requested_layers = query.requested_layers
    layer_key = make_layer_key(query.include_layers, requested_layers)
    include_layers = layer_key_has_payload(layer_key)
    chrom = query.chrom
    region_width = end - start
    
    # Track current viewport
    update_current_viewport(state, chrom, start, end)
    
    def _build_dataset(dataset_id: str, dataset_query, dataset_min_footprints: int):
        from services.lift.capability import is_lifted
        # Live-lift datasets: no metaprofile and no SV summary in v1 (services/lift/capability.py).
        lifted = is_lifted(state.datasets.get(dataset_id))
        return compact_all_dataset_result(
            state=state,
            query=dataset_query,
            dataset_id=dataset_id,
            chrom=chrom,
            start=start,
            end=end,
            region_width=region_width,
            spanning=spanning,
            max_reads=max_reads,
            downsample=downsample,
            include_methylation=include_methylation,
            include_layers=include_layers,
            requested_layers=requested_layers,
            include_layer_qualities=include_layer_qualities,
            ml_threshold=ml_threshold,
            fill_gap_size=fill_gap_size,
            min_fp_quality=min_fp_quality,
            min_footprints=dataset_min_footprints,
            include_metaprofile=(include_metaprofile if dataset_min_footprints == min_footprints else False)
            and not lifted,
            profile_max_reads=profile_max_reads,
            coverage_sample=coverage_sample,
            hide_terminal_gaps=hide_terminal_gaps,
            terminal_gap_threshold=terminal_gap_threshold,
            infer_legacy_layers=infer_legacy_layers,
            legacy_nuc_min_size=legacy_nuc_min_size,
            include_duplicates=include_duplicates,
            sample_seed=sample_seed,
            min_sv_len=min_sv_len,
            include_sv_summary=include_sv_summary and not lifted,
            sv_conflict_options=unwrap_query_default(sv_conflict_options, None),
        )

    from services.read_pins import parse_pin_ids, pinned_reads
    pins = parse_pin_ids(pin_ids if isinstance(pin_ids, str) else None)

    def _process_dataset(dataset_id: str):
        """Process a single dataset — runs in thread pool for parallel I/O."""
        from services.background_work import interactive_read
        with interactive_read(), pinned_reads(pins):
            result = _build_dataset(dataset_id, query, min_footprints)
            # Min footprints hid every read in view: say how many (short reads).
            hidden_by_min_footprints_for_dataset(
                result, query=query, min_footprints=min_footprints,
                rebuild=lambda q, mf: _build_dataset(dataset_id, q, mf),
            )
        return result

    # Even one dataset must run off the event loop: otherwise a cold load
    # blocks navigation, status and the disconnect notification itself.
    dataset_ids = query.dataset_ids
    try:
        task_results = await run_read_work(request, [partial(_process_dataset, did) for did in dataset_ids])
    except Cancelled:
        return cancelled_response()

    results = {}
    for result in task_results:
        if result is not None:
            dataset_id, data = result
            results[dataset_id] = data

    return await asyncio.to_thread(reads_response, {
        "width": region_width,
        "datasets": results,
        "sample_seed": sample_seed,
        "server_elapsed_ms": round((time.time() - t0) * 1000, 1),
    }, request)


@router.get("/api/reads/random_window")
async def get_random_covered_window(
    span: int = Query(..., description="Desired window width in bp (typically the current viewport span)"),
    min_coverage: int = Query(1, description="Minimum peak read depth the window must reach"),
    dataset_id: Optional[str] = Query(None, description="Restrict sampling to one dataset; default samples across all"),
    seed: Optional[int] = Query(None, description="Optional RNG seed for reproducible picks"),
    state=Depends(get_state),
):
    """Jump to a random window with read coverage (useful for sparse DAF-seq data).

    Windows are anchored on real reads so coverage is guaranteed > 0, sized to
    `span`, clamped within the chromosome, and validated against `min_coverage`.
    """
    from services.random_window import random_covered_window

    return await asyncio.to_thread(
        random_covered_window,
        state,
        span=span,
        min_coverage=min_coverage,
        dataset_id=dataset_id,
        seed=seed,
    )


@router.get("/api/reads/top_windows")
async def get_top_covered_windows(
    span: int = Query(..., ge=1, le=10_000_000, description="Window width in bp (typically the current viewport span)"),
    dataset_id: Optional[str] = Query(None, description="One dataset; default ranks across all"),
    n: int = Query(20, ge=1, le=100, description="How many windows"),
    fit: bool = Query(False, description="Narrow each window to its reads when they cover much less than span (amplicons)"),
    request: Request = None,
    state=Depends(get_state),
):
    """The best-covered windows at this zoom, deepest first, for stepping through loci with reads.
    Identical requests in flight share one search; a client that goes away stops it."""
    from services.background_work import Cancelled, cancelled_response, run_background
    from services.random_window import top_covered_windows

    datasets_key = tuple(sorted(str(d) for d in (getattr(state, "dataset_order", None) or [])))
    key = ("top_windows", id(state), span, dataset_id, datasets_key, n, fit)
    try:
        return await run_background(request, key, top_covered_windows, state,
                                    span=span, dataset_id=dataset_id, n=n, fit=fit, wait_for_reads=False)
    except Cancelled:
        return cancelled_response()


@router.post("/api/reads/locate")
async def locate_reads_by_name(payload: dict, request: Request, state=Depends(get_state)):
    """Where reads align, by name (a read name pasted into a locus box).

    Body: ``names`` (list, or a comma/newline separated string), ``scope``
    (``region`` | ``chrom`` | ``genome``; the client widens it step by step),
    ``chrom``/``start``/``end`` (the view the search starts from),
    ``dataset_ids`` (default: every open dataset), ``budget_s``. A client
    that goes away (Cancel) stops the scan.
    """
    import re
    import threading
    from services.read_locate import DEFAULT_BUDGET_S, SCOPES, locate_reads

    names = payload.get("names") or []
    if isinstance(names, str):
        names = [n for n in re.split(r"[,;\s]+", names) if n]
    if not isinstance(names, list):
        return ORJSONResponse({"error": "names must be a list"}, status_code=400)
    scope = str(payload.get("scope") or "region")
    if scope not in SCOPES:
        return ORJSONResponse({"error": f"scope must be one of {', '.join(SCOPES)}"}, status_code=400)

    def _int(key):
        value = payload.get(key)
        try:
            return None if value is None else int(value)
        except (TypeError, ValueError):
            return None

    dataset_ids = payload.get("dataset_ids")
    if dataset_ids is not None and not isinstance(dataset_ids, list):
        dataset_ids = None
    try:
        budget_s = float(payload.get("budget_s") or DEFAULT_BUDGET_S)
    except (TypeError, ValueError):
        budget_s = DEFAULT_BUDGET_S
    gone = threading.Event()

    async def _watch_disconnect():
        from services.client_disconnect import wait_for_disconnect
        try:
            await wait_for_disconnect(request)
        except Exception:
            return
        gone.set()

    watcher = asyncio.create_task(_watch_disconnect())
    try:
        result = await asyncio.to_thread(
            locate_reads,
            state,
            [str(n) for n in names],
            scope=scope,
            chrom=payload.get("chrom") or None,
            start=_int("start"),
            end=_int("end"),
            dataset_ids=[str(d) for d in dataset_ids] if dataset_ids else None,
            budget_s=budget_s,
            cancelled=gone.is_set,
        )
    finally:
        gone.set()
        watcher.cancel()
    return ORJSONResponse(result)


QUALITY_IMPACT_MAX_BP = 2_000_000
# The toolbar's quality summary asks for this on every view (the FIRE default
# filter is on), alongside the display load: load the view, not 10x of it.
QUALITY_IMPACT_PREFETCH_MULTIPLIER = 1


# Finished counts, by view, filters and data (file identity and generation).
_QUALITY_IMPACT_CACHE = None


def _quality_impact_cache():
    global _QUALITY_IMPACT_CACHE
    if _QUALITY_IMPACT_CACHE is None:
        from services.background_work import ResultCache
        _QUALITY_IMPACT_CACHE = ResultCache(max_entries=64, ttl_s=600)
    return _QUALITY_IMPACT_CACHE


@router.post("/api/quality/impact")
async def quality_filter_impact_endpoint(payload: dict, request: Request, state=Depends(get_state)):
    """How many calls in view each quality filter keeps, per filter (all datasets)."""
    from services.read_quality_filters import available_quality_names, quality_filter_impact

    chrom = str(payload.get("chrom") or "")
    start = int(payload.get("start") or 0)
    end = int(payload.get("end") or 0)
    filters = [
        {
            "layer": f.get("layer", "*"),
            "quality_name": f.get("qualityName", f.get("quality_name", "")),
            "min_value": int(f.get("minValue", f.get("min_value", 0)) or 0),
        }
        for f in (payload.get("filters") or [])
        if isinstance(f, dict) and f.get("enabled", True)
    ]
    dataset_ids = payload.get("dataset_ids") or list(getattr(state, "dataset_order", []) or [])
    from services.lift.capability import require_for_ids
    require_for_ids(state, dataset_ids, "quality_impact")
    # Counting loads every read in view; beyond read-level zoom it is skipped.
    if not chrom or end <= start or end - start > QUALITY_IMPACT_MAX_BP:
        return {"success": True, "filters": quality_filter_impact([], filters), "available": {}, "skipped": end - start > QUALITY_IMPACT_MAX_BP}

    def compute():
        # One dataset at a time, without methylation, so reads aren't all held at once.
        from services.background_work import checkpoint, yield_to_reads
        totals = quality_filter_impact([], filters)
        available: dict[str, set[str]] = {}
        for dataset_id in dataset_ids:
            # Each dataset's count waits for the reads being loaded (and reuses them).
            yield_to_reads()
            checkpoint()
            dataset = state.get_dataset(dataset_id)
            if dataset is None:
                continue
            # A BAM's count is for the view only: no 10x prefetch around it (that
            # is the display's job; a broad display entry that covers the view and
            # its layers is still reused). BigBed keeps the prefetch: its companion
            # layers outside the view count in the terminal-gap filter.
            is_bam = getattr(dataset, "data_type", None) == "bam"
            working = state.build_working_set(
                dataset_id, chrom, start, end, False, 0,
                include_methylation=False, include_layers=True, include_layer_qualities=True, quality_filters=[],
                broad_prefetch_multiplier=QUALITY_IMPACT_PREFETCH_MULTIPLIER if is_bam else None,
            )
            for total, part in zip(totals, quality_filter_impact(working.reads, filters)):
                total["total"] += part["total"]
                total["kept"] += part["kept"]
                total["layers"] = sorted(set(total["layers"]) | set(part["layers"]))
            for layer, names in available_quality_names(working.reads).items():
                available.setdefault(layer, set()).update(names)
            del working
        return totals, {layer: sorted(names) for layer, names in available.items()}

    from services.background_work import Cancelled, cancelled_response, dataset_identity, run_background
    from services.working_sets import read_load_token
    # The client's revision (a data refresh, a new footprint-class result) is part of the question.
    key = ("quality_impact", id(state), chrom, start, end,
           tuple((f["layer"], f["quality_name"], f["min_value"]) for f in filters),
           dataset_identity(state, dataset_ids), repr(read_load_token(state, chrom)),
           bool(getattr(state, "infer_legacy_layers", True)), int(getattr(state, "legacy_nuc_min_size", 90) or 90),
           str(payload.get("revision") or ""))
    try:
        impact, available = await run_background(request, key, compute, cache=_quality_impact_cache())
    except Cancelled:
        return cancelled_response()
    return {"success": True, "filters": impact, "available": available}


@router.post("/api/read_sets")
async def register_read_set(request: dict, state=Depends(get_state)):
    """Register read names for `filter_set` (a subset too large for a query string): {ids: [...]} -> {set_id, size}."""
    from fastapi import HTTPException
    from services.read_sets import register
    try:
        return register(state, (request or {}).get('ids'))
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
