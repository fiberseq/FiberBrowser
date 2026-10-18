"""Shared assembly helpers for compact read endpoints."""
from __future__ import annotations

from dataclasses import replace
import random
import time
from typing import Optional

from models.domain import WorkingSet
from services.bam_handles import check_bam_index
from services.dataset_generation import dataset_generation
from services.read_pins import compact_read_id, with_pinned
from services.analysis_query import AnalysisReadQuery
from services.circular_genome import (
    alignment_spans_cover,
    circular_chrom_size,
    circular_region_wraps,
    circular_view_segments,
    merge_compact_reads_by_id,
    shift_compact_read,
)
from services.read_metrics import (
    compute_compact_metaprofile_payload,
    compute_metaprofile_from_compact_reads,
    fill_small_gaps_in_read,
    sample_by_coverage,
    sample_stable_by_id,
    stable_seed_int,
)
from services.read_response_payloads import (
    compact_read_count_fields,
    compact_reads_available_layers,
    compact_reads_have_methylation,
    compact_reads_response_payload,
    sample_compact_reads_for_display,
    sort_compact_reads_for_display,
)
from services.read_route_helpers import (
    available_layers_for_response,
    build_direct_bam_reads,
    display_bam_loader,
    build_direct_bigbed_reads,
    load_direct_bigbed_marks,
    log_read_diagnostic,
    log_read_request,
    query_bool,
    query_int,
    unwrap_query_default,
)
from services.read_selection import (
    filter_reads_by_cluster_focus,
    filter_reads_by_id_set,
    filter_reads_by_min_footprints,
    is_read_spanning,
    read_matches_id_filter,
)
from services.read_quality_filters import active_quality_filters, apply_quality_filters
from services.query_params import parse_csv_int_set, parse_csv_set
from services.working_sets import (
    _broad_cache_sync,
    build_sampled_display_working_set,
    find_broad_cache_entry,
    iter_broad_reads_overlapping_viewport,
    layer_key_has_payload,
    make_layer_key,
    normalize_requested_layers,
    project_broad_read_to_viewport,
    read_load_token,
)
from services.compact_read_loader import short_terminal_footprint_bp_for
from services.sv_events import (
    SV_MIN_LEN_DEFAULT,
    finalize_sv_payload,
    normalize_min_sv_len,
    sv_extraction_floor,
    sv_summary_for_reads,
)


def _sv_summary_scope(state, working_count: int) -> str:
    """'loaded' when a working-read cap truncated the reads the summary saw."""
    cap = int(getattr(state, "max_working_reads", 0) or 0)
    return "loaded" if cap > 0 and working_count >= cap else "all"


def _attach_sv(payload: dict, *, summary_reads, display_reads_key: str = "reads",
               chrom: str, start: int, end: int, min_sv_len: int, include_summary: bool,
               scope: str = "all", precomputed=None, conflict_options=None) -> dict:
    """Cut the payload's reads' ``sv`` to the view and add ``sv_summary``."""
    payload[display_reads_key] = finalize_sv_payload(payload.get(display_reads_key) or [], start, end, min_sv_len)
    if include_summary:
        summary = precomputed if precomputed is not None else (
            sv_summary_for_reads(summary_reads, start, end, min_sv_len, scope=scope, chrom=chrom, conflict_options=conflict_options)
            if summary_reads is not None else None)
        if summary:
            payload["sv_summary"] = summary
    return payload


def update_current_viewport(state, chrom: str, start: int, end: int) -> None:
    """Mirror the active read request region for Jupyter/live-client state."""
    if getattr(state, 'performance', {}).get('effective') == 'low':
        previous = getattr(state, '_current_chrom', None)
        old_start, old_end = getattr(state, '_current_start', start), getattr(state, '_current_end', end)
        if previous is not None and (previous != chrom or start > old_end + 1_000_000 or end < old_start - 1_000_000):
            from services.performance import release_caches
            release_caches(state)
    state._current_chrom = chrom
    state._current_start = start
    state._current_end = end


def bam_index_warning(dataset) -> Optional[str]:
    """Return the first BAM-index warning for a dataset, if any."""
    if getattr(dataset, "data_type", None) != "bam":
        return None
    for bam_path in getattr(dataset, "paths", []) or []:
        warning = check_bam_index(bam_path)
        if warning:
            return warning
    return None


def consensus_overlay_source_layers(
    state,
    dataset,
    dataset_id: str,
    chrom: str,
    start: int,
    end: int,
    requested_layers,
) -> tuple[str, ...]:
    """Resolve physical producers for an active virtual consensus layer."""
    layers = requested_layers
    from services.consensus_workflow import active,source_layers
    if active(state,dataset_id,chrom,start,end):
        layers=source_layers(layers)
    return normalize_requested_layers(layers)


def apply_consensus_display_overlays(
    state,
    dataset_id: str,
    chrom: str,
    start: int,
    end: int,
    reads: list[dict],
    *,
    total_overlapping: int,
    total_spanning: int,
    projection_source=None,
) -> list[dict]:
    """Project active consensus calls onto display reads on every fetch path.

    ``BrowserState.build_working_set`` already applies this projection, but
    the optimized display sampler and the direct BAM path intentionally bypass
    that method.  Keeping the final projection here prevents a successful run
    from populating the Cart without ever exposing its temporary consensus
    layer in the browser.
    """

    if not reads:
        return reads
    working_set = WorkingSet(
        reads,
        total_overlapping,
        total_spanning,
        chrom,
        start,
        end,
    )
    from services.consensus_workflow import active
    if active(state,dataset_id,chrom,start,end):
        working_set=project_consensus_working_set(state,dataset_id,chrom,start,end,working_set,
            projection_source=projection_source)
    return working_set.reads


def project_consensus_working_set(state,dataset_id,chrom,start,end,working_set,*,projection_source=None):
    """``working_set`` with the active consensus run projected onto its reads, once per request.

    Rows this request already projected (``projection_source`` is the working set
    they came from, unchanged) are kept as they are, and carry that projection's
    receipt so a later pass over them is skipped too. Anything else is projected
    (``apply_overlays`` itself reuses a projection saved on the same working set).
    """
    from services.consensus_workflow import apply_overlays,projected_subset_is_current
    if projection_source is not None and projected_subset_is_current(state,dataset_id,chrom,start,end,
            projection_source,working_set.reads):
        if working_set is not projection_source:
            working_set._consensus_overlay_receipt=projection_source._consensus_overlay_receipt
        return working_set
    return apply_overlays(state,dataset_id,chrom,start,end,working_set)


def needs_direct_read_load(
    dataset,
    *,
    min_fp_quality: int = 0,
    hide_terminal_gaps: bool = True,
    terminal_gap_threshold: int = 500,
    include_cigar: bool = False,
    include_duplicates: bool = False,
    ml_threshold: int = 125,
    include_methylation: bool = False,
    min_sv_len: int = SV_MIN_LEN_DEFAULT,
    include_sv_seq: bool = False,
) -> bool:
    """Return True when the request cannot use the standard working-set path."""
    is_bam = getattr(dataset, "data_type", None) == "bam"
    needs_bam_data = is_bam and (include_cigar or min_fp_quality > 0)
    return (
        needs_bam_data
        or include_duplicates
        or not hide_terminal_gaps
        or terminal_gap_threshold != 500
        # Working sets are cached with marks at the default threshold.
        or (is_bam and include_methylation and int(ml_threshold) != 125)
        # ... and SV events at the default floor, without inserted bases.
        or (is_bam and (int(min_sv_len) < SV_MIN_LEN_DEFAULT or bool(include_sv_seq)))
    )


def apply_quality_filters_to_reads(reads: list[dict], filters) -> list[dict]:
    """The active quality gates on direct-loaded reads, as the working-set path applies them."""
    if not filters:
        return reads
    out: list[dict] = []
    for read in reads:
        if "layers" in read:
            read = apply_quality_filters(read, filters)
            if read is None:
                continue
        out.append(read)
    return out


def load_direct_reads_for_dataset(
    state,
    dataset,
    *,
    chrom: str,
    start: int,
    end: int,
    spanning_only: bool,
    include_methylation: bool,
    ml_threshold: int,
    min_fp_quality: int,
    include_cigar: bool,
    hide_terminal_gaps: bool,
    terminal_gap_threshold: int,
    include_layers: bool,
    requested_layers,
    include_layer_qualities: bool,
    infer_legacy_layers: bool,
    legacy_nuc_min_size: int,
    include_duplicates: bool = False,
    min_footprints: int = 0,
    short_terminal_footprint_bp: Optional[int] = None,
    sv_min_len: int = SV_MIN_LEN_DEFAULT,
    include_sv_seq: bool = False,
) -> list[dict]:
    """Load compact reads directly from BAM/BigBed for non-cacheable options.

    ``short_terminal_footprint_bp``: the read-end footprint cutoff, captured
    once by the caller (default: the workspace's current one)."""
    if short_terminal_footprint_bp is None:
        short_terminal_footprint_bp = short_terminal_footprint_bp_for(state)
    chrom_size = circular_chrom_size(state, chrom)
    if chrom_size and circular_region_wraps(start, end, chrom_size):
        merged_inputs: list[dict] = []
        for segment in circular_view_segments(start, end, chrom_size):
            segment_reads = load_direct_reads_for_dataset(
                state,
                dataset,
                chrom=chrom,
                start=segment.ref_start,
                end=segment.ref_end,
                spanning_only=False,
                include_methylation=include_methylation,
                ml_threshold=ml_threshold,
                min_fp_quality=min_fp_quality,
                include_cigar=include_cigar,
                hide_terminal_gaps=hide_terminal_gaps,
                terminal_gap_threshold=terminal_gap_threshold,
                include_layers=include_layers,
                requested_layers=requested_layers,
                include_layer_qualities=include_layer_qualities,
                infer_legacy_layers=infer_legacy_layers,
                legacy_nuc_min_size=legacy_nuc_min_size,
                include_duplicates=include_duplicates,
                min_footprints=min_footprints,
                short_terminal_footprint_bp=short_terminal_footprint_bp,
                sv_min_len=sv_min_len,
                include_sv_seq=include_sv_seq,
            )
            shift = segment.logical_start - start
            merged_inputs.extend(shift_compact_read(read, shift, segment.logical_start - segment.ref_start)
                for read in segment_reads)
        merged = merge_compact_reads_by_id(merged_inputs)
        if spanning_only:
            region_width = end - start
            return [read for read in merged if is_read_spanning(read, region_width)]
        return merged

    # The same loader as the working-set path (companion and derived-layer
    # files, marks), with the direct-only options on the primary loads.
    from services.working_sets import _load_broad_reads, make_layer_key
    from services.read_sampling import sample_level

    reads = _load_broad_reads(
        dataset=dataset,
        dataset_id=getattr(dataset, "id", "") or "",
        chrom=chrom,
        broad_start=start,
        broad_end=end,
        broad_width=end - start,
        include_methylation=include_methylation,
        layer_key=make_layer_key(include_layers, requested_layers or None),
        include_layer_qualities=include_layer_qualities,
        build_bam_reads=display_bam_loader(state, build_direct_bam_reads),
        build_bigbed_reads=build_direct_bigbed_reads,
        load_bigbed_marks=load_direct_bigbed_marks,
        infer_legacy_layers=infer_legacy_layers,
        legacy_nuc_min_size=legacy_nuc_min_size,
        min_footprints=min_footprints,
        ml_threshold=ml_threshold,
        short_terminal_footprint_bp=short_terminal_footprint_bp,
        sample_level=(sample_level(state, dataset, chrom, start, end)
                      if getattr(state, 'performance', {}).get('effective') == 'low' else 0),
        # Spanning is judged by the loaders on the alignment's extent: with
        # terminal gaps hidden, a read's intervals start at its first footprint.
        bam_read_options=dict(
            spanning_only=spanning_only,
            min_fp_quality=min_fp_quality,
            include_cigar=include_cigar,
            hide_terminal_gaps=hide_terminal_gaps,
            terminal_gap_threshold=terminal_gap_threshold,
            include_duplicates=include_duplicates,
            sv_min_len=sv_min_len,
            include_sv_seq=include_sv_seq,
        ),
        bigbed_read_options=dict(
            spanning_only=spanning_only,
            hide_terminal_gaps=hide_terminal_gaps,
            terminal_gap_threshold=terminal_gap_threshold,
            include_duplicates=include_duplicates,
        ),
    )
    return reads


def _has_alignment_bounds(read) -> bool:
    """A BAM compact read's absolute alignment extent (its projection identity)."""
    return isinstance(read.get("reference_start"), int) and isinstance(read.get("reference_end"), int)


def apply_min_footprint_filter(reads: list[dict], dataset, min_footprints: int) -> list[dict]:
    """Apply the shared min-footprints filter only when footprint data exists."""
    if min_footprints <= 0 or not getattr(dataset, "available_layers", {}).get("footprint", True):
        return reads
    return filter_reads_by_min_footprints(
        reads,
        min_footprints,
        has_footprint_layer=True,
    )


def quality_filters_require_full_projection(filters) -> bool:
    """Return True when quality filters can change primary read membership."""
    for filt in filters or []:
        if filt.get("min_value", 0) <= 0:
            continue
        layer = str(filt.get("layer", "*") or "*")
        quality_name = str(filt.get("quality_name", "") or "")
        if layer in {"nuc", "footprint"}:
            return True
        if layer == "*" and quality_name in {"", "nq"}:
            return True
    return False


def quality_filters_for_display_layers(filters, layer_key) -> list[dict]:
    """Restrict display-only quality filters to payload layers the UI requested.

    Backend analysis paths still use the full global filter set. The read-display
    fast path can skip a hidden layer's visual quality gate so a default FIRE
    filter does not force FIRE payloads into every ordinary nuc/TF viewport.
    """
    if not filters:
        return []
    if layer_key is None:
        return [dict(filt) for filt in filters if filt.get("min_value", 0) > 0]
    if layer_key == ():
        return []

    requested = set(layer_key)
    out: list[dict] = []
    for filt in filters:
        if filt.get("min_value", 0) <= 0:
            continue
        layer = str(filt.get("layer", "*") or "*")
        if layer == "*":
            continue
        if layer in requested:
            out.append(dict(filt))
            continue
        if (layer == "fire" and "msp" in requested) or (layer == "msp" and "fire" in requested):
            out.append(dict(filt))
    return out


def compact_metaprofile_for_reads(
    reads: list[dict],
    *,
    region_width: int,
    requested_layers,
    profile_max_reads: int,
) -> tuple[Optional[dict], int]:
    if not reads:
        return None, 0
    profile_reads = reads
    if profile_max_reads > 0 and len(profile_reads) > profile_max_reads:
        profile_reads = sample_compact_reads_for_display(
            profile_reads,
            profile_max_reads,
            region_width,
            sample_by_coverage,
            keep_pinned=False,
        )
    return (
        compute_compact_metaprofile_payload(
            profile_reads,
            region_width,
            list(requested_layers or []),
            include_legacy_profiles=False,
        ),
        len(profile_reads),
    )


def _compact_reads_payload(
    state,
    *,
    chrom: str,
    start: int,
    end: int,
    max_reads: int = 500,
    spanning: bool = False,
    dataset_id: Optional[str] = None,
    include_methylation: bool = False,
    include_layers: bool = False,
    layer_names: Optional[str] = None,
    include_layer_qualities: bool = True,
    ml_threshold: int = 125,
    fill_gap_size: Optional[int] = None,
    min_fp_quality: int = 0,
    min_footprints: int = 0,
    cluster_focus: Optional[str] = None,
    filter_ids: Optional[str | list[str]] = None,  # a list: exact names (a registered read set)
    include_cigar: bool = False,
    hide_terminal_gaps: bool = True,
    terminal_gap_threshold: int = 500,
    infer_legacy_layers: bool = True,
    legacy_nuc_min_size: int = 90,
    include_duplicates: bool = False,
    include_metaprofile: bool = False,
    profile_max_reads: int = 1000,
    metaprofile_layers: Optional[str] = None,
    sample_seed: Optional[str] = None,
    strand: Optional[str] = None,
    min_sv_len: int = SV_MIN_LEN_DEFAULT,
    include_sv_seq: bool = False,
    include_sv_summary: bool = True,
    sv_conflict_options=None,
    full_working_set: bool = False,
    viewport_start: Optional[int] = None,
    viewport_end: Optional[int] = None,
) -> dict:
    """Build the `/api/reads/compact` payload for one dataset.

    A deep BAM view loads a stable sample of its reads (services/read_sampling.py)
    and says so in ``working_sampling``; ``full_working_set`` loads every read."""
    full_working_set = query_bool(full_working_set, False)
    min_sv_len = normalize_min_sv_len(unwrap_query_default(min_sv_len, SV_MIN_LEN_DEFAULT))
    include_sv_seq = query_bool(include_sv_seq, False)
    include_sv_summary = query_bool(include_sv_summary, True)
    sv_floor = sv_extraction_floor(min_sv_len)
    from services.read_strand import cached_read_strand, filter_reads_by_strand, normalize_strand, strand_calls, strand_totals
    strand = normalize_strand(unwrap_query_default(strand, None))
    if strand:
        # A read's strand comes from its deamination marks.
        include_methylation = True
    t0 = time.time()
    server_timings: dict[str, float] = {}
    def phase_ms(started_at: float) -> float:
        return (time.perf_counter() - started_at) * 1000

    infer_legacy_layers = query_bool(infer_legacy_layers, True)
    legacy_nuc_min_size = query_int(legacy_nuc_min_size, 90)
    include_metaprofile = query_bool(include_metaprofile, False)
    include_duplicates = query_bool(include_duplicates, False)
    profile_max_reads = query_int(profile_max_reads, 1000)
    layer_names = unwrap_query_default(layer_names, None)
    metaprofile_layers = unwrap_query_default(metaprofile_layers, None)
    requested_layers = normalize_requested_layers(layer_names)
    requested_metaprofile_layers = normalize_requested_layers(metaprofile_layers) or requested_layers
    query = AnalysisReadQuery.from_request(
        state,
        chrom=chrom,
        start=start,
        end=end,
        spanning=spanning,
        dataset_id=dataset_id,
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
    dataset_id = query.dataset_ids[0] if query.dataset_ids else None
    calls = strand_calls(state, dataset_id) if strand else None
    chrom = query.chrom
    start = query.start
    end = query.end
    spanning = query.spanning
    region_width = end - start

    # An active consensus run is a live, temporary annotation layer.  Force
    # its molecular TF geometry into the display request even when the client
    # has not discovered the consensus layer yet.  This is especially important
    # for the optimized broad-cache sampler, which bypasses BrowserState's
    # normal working-set projection.
    from services.consensus_workflow import active as consensus_active
    active_consensus=bool(dataset_id) and consensus_active(state,dataset_id,chrom,start,end)
    if active_consensus:
        consensus_dataset = state.get_dataset(dataset_id)
        query = replace(
            query,
            include_layers=True,
            requested_layers=consensus_overlay_source_layers(
                state,
                consensus_dataset,
                dataset_id,
                chrom,
                start,
                end,
                query.requested_layers,
            ),
            include_layer_qualities=True,
        )
        include_layer_qualities = True
    requested_layers = query.requested_layers
    layer_key = make_layer_key(query.include_layers, requested_layers)
    include_layers = layer_key_has_payload(layer_key)

    from services.read_stream import is_prefetch
    if not is_prefetch():
        if viewport_start is not None and viewport_end is not None and start <= viewport_start < viewport_end <= end:
            update_current_viewport(state, chrom, viewport_start, viewport_end)
        else:
            update_current_viewport(state, chrom, start, end)

    dataset = state.get_dataset(dataset_id) if dataset_id else None
    if not dataset:
        return compact_reads_response_payload(
            display_reads=[],
            width=region_width,
            dataset_id=dataset_id,
            working_count=0,
            total_in_scope=0,
            total_spanning=0,
            total_overlapping=0,
            success=False,
            error=f"Dataset '{dataset_id}' not found",
        )

    bam_warning = bam_index_warning(dataset)
    needs_direct_load = needs_direct_read_load(
        dataset,
        min_fp_quality=min_fp_quality,
        hide_terminal_gaps=hide_terminal_gaps,
        terminal_gap_threshold=terminal_gap_threshold,
        include_cigar=include_cigar,
        include_duplicates=include_duplicates,
        ml_threshold=ml_threshold,
        include_methylation=include_methylation,
        min_sv_len=min_sv_len,
        include_sv_seq=include_sv_seq,
    )

    focus_clusters = None
    if cluster_focus:
        try:
            focus_clusters = parse_csv_int_set(cluster_focus)
            log_read_diagnostic(f"  Cluster focus: {focus_clusters}")
        except Exception as exc:
            log_read_diagnostic(f"  Warning: invalid cluster_focus '{cluster_focus}': {exc}")

    cluster_assignments = dataset.cluster_assignments if dataset else {}

    if needs_direct_load:
        direct_min_footprints = (
            min_footprints
            if getattr(dataset, "available_layers", {}).get("footprint", True)
            else 0
        )
        direct_terminal_bp = short_terminal_footprint_bp_for(state)
        # Low memory samples direct loads too (load_direct_reads_for_dataset): the level, and
        # the pinned reads outside the sample that load parses, are part of its identity.
        from services.read_sampling import sample_level as _sample_level
        direct_level = (_sample_level(state, dataset, chrom, start, end)
                        if getattr(state, 'performance', {}).get('effective') == 'low' else 0)
        from services.sv_alleles import reference_identity
        methyl_cache_key = (
            dataset_id,
            chrom,
            start,
            end,
            spanning,
            include_methylation,
            ml_threshold,
            min_fp_quality,
            include_cigar,
            layer_key,
            bool(include_layer_qualities),
            hide_terminal_gaps,
            terminal_gap_threshold,
            infer_legacy_layers,
            legacy_nuc_min_size,
            include_duplicates,
            direct_min_footprints,
            read_load_token(state, chrom, direct_terminal_bp, sample_level=direct_level),
            min_sv_len,
            include_sv_seq,
            reference_identity(state),
        )

        if not hasattr(state, "_methylation_cache"):
            state._methylation_cache = {}

        def load_current_span():
            return load_direct_reads_for_dataset(
                state, dataset, chrom=chrom, start=start, end=end, spanning_only=False,
                include_methylation=include_methylation, ml_threshold=ml_threshold,
                min_fp_quality=min_fp_quality, include_cigar=include_cigar,
                hide_terminal_gaps=hide_terminal_gaps, terminal_gap_threshold=terminal_gap_threshold,
                include_layers=include_layers, requested_layers=requested_layers,
                include_layer_qualities=include_layer_qualities, infer_legacy_layers=infer_legacy_layers,
                legacy_nuc_min_size=legacy_nuc_min_size, include_duplicates=include_duplicates,
                min_footprints=direct_min_footprints, short_terminal_footprint_bp=direct_terminal_bp,
                sv_min_len=min_sv_len, include_sv_seq=include_sv_seq,
            )

        generation = dataset_generation(state, dataset_id)
        # Looked up under the lock that pruning and invalidation hold: another
        # request can evict the entry between a membership test and the read.
        cache_lock, _inflight = _broad_cache_sync(state)
        with cache_lock:
            cached_direct = state._methylation_cache.get(methyl_cache_key)
            containing = None
            edge_candidate = None
            if (cached_direct is None and not include_cigar and not active_consensus
                    and getattr(state, 'performance', {}).get('effective') != 'low'
                    and not quality_filters_for_display_layers(active_quality_filters(state), layer_key) and not circular_chrom_size(state, chrom)
                    and not hide_terminal_gaps and not terminal_gap_threshold
                    and not min_fp_quality and not direct_min_footprints
                    and layer_key is not None and set(layer_key) <= {'nuc', 'tf', 'footprint'}):
                for key, value in list(state._methylation_cache.items()):
                    if (key[:2] == methyl_cache_key[:2] and key[4:] == methyl_cache_key[4:]
                            and key[2] <= start and end <= key[3]):
                        containing = (key[2], value[0])
                        break
                    if (full_working_set and not spanning and not filter_ids and not focus_clusters and not strand
                            and not fill_gap_size and dataset.data_type == 'bam'
                            and len(dataset.paths) == 1 and not getattr(dataset, 'companion_layers', None)
                            and not getattr(dataset, 'derived_layers', None)
                            and key[:2] == methyl_cache_key[:2] and key[4:] == methyl_cache_key[4:]
                            and key[2] < end and start < key[3]):
                        overlap = min(end, key[3]) - max(start, key[2])
                        if edge_candidate is None or overlap > edge_candidate[0]:
                            edge_candidate = (overlap, key[2], key[3], value[0])
        if containing is not None:
            from services.direct_read_projection import project_direct_reads
            phase_t0 = time.perf_counter()
            projected = project_direct_reads(containing[1], containing[0], start, end)
            if projected is not None:
                cached_direct = (projected, None)
                server_timings['direct_containment_ms'] = phase_ms(phase_t0)
        if cached_direct is None and edge_candidate is not None:
            from services.read_edge_cache import extend_direct_cohort
            from services.read_stream import decoded_read_sink
            phase_t0 = time.perf_counter()
            sink_token = decoded_read_sink.set(None)
            try:
                extension = extend_direct_cohort(edge_candidate[3], edge_candidate[1], edge_candidate[2],
                                                 start, end, load_current_span)
            finally:
                decoded_read_sink.reset(sink_token)
            if extension is not None and dataset_generation(state, dataset_id) == generation:
                extended_reads, edge_ranges = extension
                cached_direct = (extended_reads, None)
                with cache_lock:
                    if dataset_generation(state, dataset_id) == generation:
                        _store_direct_reads_cache(state._methylation_cache, methyl_cache_key, cached_direct)
                server_timings['direct_edge_load_ms'] = phase_ms(phase_t0)
                server_timings['direct_edge_bases'] = sum(b - a for a, b in edge_ranges)
                server_timings['direct_reused_span_bases'] = region_width - sum(b - a for a, b in edge_ranges)
        if cached_direct is not None:
            all_reads, loader_spanning_ids = cached_direct
            server_timings["direct_cache_hit"] = 1.0
            log_read_diagnostic(f"  Using cached methylation/CIGAR data: {len(all_reads)} reads")
        else:
            phase_t0 = time.perf_counter()
            from services.read_stream import read_sink, decoded_read_sink
            from services.working_sets import _derived_layer_paths_for_request
            stream = read_sink.get()
            stream_safe = (stream is not None and full_working_set
                and getattr(state, 'performance', {}).get('effective') != 'low'
                and dataset.data_type == 'bam' and len(dataset.paths) == 1
                and not spanning and not filter_ids and not focus_clusters and not strand
                and not active_consensus
                and not quality_filters_for_display_layers(active_quality_filters(state), layer_key)
                and not circular_chrom_size(state, chrom) and not include_cigar
                and not hide_terminal_gaps and not terminal_gap_threshold
                and not min_fp_quality and not direct_min_footprints and not fill_gap_size
                and not _derived_layer_paths_for_request(dataset, layer_key))
            if stream_safe and max_reads > 0:
                from services.read_sampling import estimate_dataset_reads
                estimate = estimate_dataset_reads(state, dataset, chrom, start, end)
                # A capped display must not receive a million temporary rows
                # merely to discard most of them at the completion record.
                stream_safe = estimate is not None and estimate <= max_reads * 1.05
            sink_token = decoded_read_sink.set(stream if stream_safe else None)
            try:
                all_reads = load_current_span()
            finally:
                decoded_read_sink.reset(sink_token)
            server_timings["direct_load_ms"] = phase_ms(phase_t0)
            # With terminal gaps hidden a read's intervals start at its first
            # footprint, so they can't tell whether it spans the view. BAM reads
            # carry their alignment bounds; for the others (BigBed), the loaders'
            # own alignment-extent check says which ones span.
            loader_spanning_ids = None
            if hide_terminal_gaps and any(not _has_alignment_bounds(read) for read in all_reads):
                loader_spanning_ids = {
                    read.get("id") for read in load_direct_reads_for_dataset(
                        state, dataset, chrom=chrom, start=start, end=end, spanning_only=True,
                        include_methylation=False, ml_threshold=ml_threshold, min_fp_quality=min_fp_quality,
                        include_cigar=False, hide_terminal_gaps=hide_terminal_gaps,
                        terminal_gap_threshold=terminal_gap_threshold, include_layers=False,
                        requested_layers=None, include_layer_qualities=False,
                        infer_legacy_layers=False, legacy_nuc_min_size=legacy_nuc_min_size,
                        include_duplicates=include_duplicates, min_footprints=direct_min_footprints,
                        short_terminal_footprint_bp=direct_terminal_bp,
                    )
                }

            from services.background_work import checkpoint
            checkpoint()
            # Loaded for a source since replaced under the same ID: not cached.
            cache_lock, _inflight = _broad_cache_sync(state)
            with cache_lock:
                if dataset_generation(state, dataset_id) == generation:
                    _store_direct_reads_cache(
                        state._methylation_cache, methyl_cache_key,
                        (all_reads, loader_spanning_ids),
                    )
            log_read_diagnostic(f"  Loaded methylation data: {len(all_reads)} reads (cached)")

        from services.read_sampling import sampling_info
        direct_sampling = sampling_info(all_reads, start, end, len(all_reads), 0)
        # The quality gates the working-set path applies (cached reads stay raw).
        all_reads = apply_quality_filters_to_reads(
            all_reads,
            quality_filters_for_display_layers(active_quality_filters(state), layer_key),
        )

        if strand:
            # A one-strand panel's counts are that strand's reads.
            all_reads = filter_reads_by_strand(all_reads, strand, calls)
        view_wraps = bool(circular_chrom_size(state, chrom)) and circular_region_wraps(
            start, end, circular_chrom_size(state, chrom))

        def spans(read):
            # A wrapped circular view's coordinates aren't the alignment's: its
            # merged intervals decide, as before.
            if view_wraps:
                return is_read_spanning(read, region_width)
            wrapped = alignment_spans_cover(read, start, end)
            if wrapped is not None:
                # An origin-spanning read's parts, projected into this window.
                return wrapped
            if _has_alignment_bounds(read):
                return int(read["reference_start"]) <= start and int(read["reference_end"]) >= end
            if loader_spanning_ids is not None:
                return read.get("id") in loader_spanning_ids
            return is_read_spanning(read, region_width)

        total_overlapping = len(all_reads)
        total_spanning = sum(1 for read in all_reads if spans(read))
        reads_to_sample = [
            read
            for read in all_reads
            if not spanning or spans(read)
        ]
        # A sampled load (Low memory) counts its loaded reads that pass the filters, as the
        # sampled working-set path does; working_sampling carries the view's alignments
        # (the panel's "N of M reads (sampled)"). It used to put the view's unfiltered
        # alignment count here, so a filter that hid every read still looked non-empty.
        total_in_scope = len(reads_to_sample)

        if fill_gap_size and fill_gap_size > 0:
            reads_to_sample = [fill_small_gaps_in_read(read, fill_gap_size) for read in reads_to_sample]

        if filter_ids:
            filter_id_set = parse_csv_set(filter_ids)
            reads_to_sample = filter_reads_by_id_set(reads_to_sample, filter_id_set)
            log_read_diagnostic(f"  Filter IDs (special path): {len(filter_id_set)} -> {len(reads_to_sample)} reads")

        if focus_clusters and cluster_assignments:
            # A focused cluster shows (and profiles) its own reads only, as on the working-set path.
            reads_to_sample = filter_reads_by_cluster_focus(reads_to_sample, cluster_assignments, focus_clusters)

        working_count = len(reads_to_sample)
        direct_projection = None
        if active_consensus and reads_to_sample:
            direct_projection = project_consensus_working_set(state, dataset_id, chrom, start, end,
                WorkingSet(reads_to_sample, total_overlapping, total_spanning, chrom, start, end))
            reads_to_sample = direct_projection.reads
        metaprofile = None
        metaprofile_read_count = 0
        if include_metaprofile:
            phase_t0 = time.perf_counter()
            metaprofile, metaprofile_read_count = compact_metaprofile_for_reads(
                reads_to_sample,
                region_width=region_width,
                requested_layers=requested_metaprofile_layers,
                profile_max_reads=profile_max_reads,
            )
            server_timings["metaprofile_ms"] = phase_ms(phase_t0)
        phase_t0 = time.perf_counter()
        display_reads = sample_compact_reads_for_display(
            reads_to_sample,
            max_reads,
            region_width,
            sample_by_coverage,
        )
        display_reads = apply_consensus_display_overlays(
            state,
            dataset_id,
            chrom,
            start,
            end,
            display_reads,
            total_overlapping=total_overlapping,
            total_spanning=total_spanning,
            projection_source=direct_projection,
        )
        server_timings["display_sample_ms"] = phase_ms(phase_t0)
        has_methylation = compact_reads_have_methylation(display_reads)

        elapsed = time.time() - t0
        log_read_request(
            f"  /api/reads/compact (methylation path): {len(display_reads)} display "
            f"(from {working_count} working, {total_in_scope} in-scope, "
            f"{total_spanning} spanning) in {elapsed:.3f}s",
            elapsed,
        )

        payload = _attach_sv(compact_reads_response_payload(
            display_reads=display_reads,
            width=region_width,
            dataset_id=dataset_id,
            dataset_label=dataset.label,
            dataset_color=dataset.color,
            working_count=working_count,
            total_in_scope=total_in_scope,
            total_spanning=total_spanning,
            total_overlapping=total_overlapping,
            has_methylation=has_methylation,
            available_layers=available_layers_for_response(
                dataset,
                compact_reads_available_layers(display_reads),
            ),
            sample_seed=sample_seed,
            warning=bam_warning,
            server_elapsed_ms=elapsed * 1000,
            server_timings=server_timings,
            metaprofile=metaprofile,
            metaprofile_read_count=metaprofile_read_count,
            profile_max_reads=profile_max_reads if include_metaprofile else None,
        ), summary_reads=None if view_wraps else reads_to_sample, chrom=chrom, start=start, end=end,
            min_sv_len=min_sv_len, include_summary=include_sv_summary, conflict_options=sv_conflict_options)
        from services.read_binary import binary_read_context
        if binary_read_context.get():
            payload['_region_reuse_safe'] = (
                not quality_filters_for_display_layers(active_quality_filters(state), layer_key) and not active_consensus
                and not circular_chrom_size(state, chrom)
                and layer_key is not None and set(layer_key) <= {'nuc', 'tf', 'footprint'}
            )
        if direct_sampling:
            payload['working_sampling'] = direct_sampling
        return payload

    filter_id_set = None
    if filter_ids:
        filter_id_set = parse_csv_set(filter_ids)
        log_read_diagnostic(f"  Filter IDs: {len(filter_id_set)} base IDs provided")

    effective_min_footprints = (
        int(min_footprints or 0)
        if getattr(dataset, "available_layers", {}).get("footprint", True)
        else 0
    )
    # Read filters (IDs, cluster focus, strand) need the full working set before sampling.
    use_broad_cache = filter_id_set or (focus_clusters and cluster_assignments) or strand
    metaprofile = None
    metaprofile_read_count = 0

    # The working set an active consensus run was already projected onto, if any.
    projection_source = None
    if use_broad_cache:
        display_quality_filters = quality_filters_for_display_layers(
            active_quality_filters(state),
            layer_key,
        )
        phase_t0 = time.perf_counter()
        broad_reads, broad_key = find_broad_cache_entry(
            state,
            dataset_id,
            chrom,
            start,
            end,
            include_methylation,
            layer_key,
            time.time(),
            include_layer_qualities=include_layer_qualities,
            infer_legacy_layers=infer_legacy_layers,
            legacy_nuc_min_size=legacy_nuc_min_size,
            min_footprints=effective_min_footprints,
        )
        server_timings["broad_cache_lookup_ms"] = phase_ms(phase_t0)
        viewport_offset = start - broad_key[2] if broad_key else 0

        if broad_reads is None:
            log_read_diagnostic("  No broad cache available, using working set")
            phase_t0 = time.perf_counter()
            working_set = query.build_working_set(
                state,
                dataset_id,
                read_ids=list(filter_id_set) if filter_id_set is not None else None,
                include_layer_qualities=include_layer_qualities,
                quality_filters=display_quality_filters,
            )
            server_timings["working_set_ms"] = phase_ms(phase_t0)
            # BrowserState.build_working_set projects an active run; the filtered
            # subsets below keep its rows (and so its projection).
            projection_source = working_set
            reads_to_sample = working_set.reads
            # Defense in depth for custom BrowserState implementations. The
            # important ordering guarantee is that the same IDs were already
            # supplied to build_working_set, before any backend cap.
            if filter_id_set:
                reads_to_sample = filter_reads_by_id_set(reads_to_sample, filter_id_set)
            total_overlapping, total_spanning = working_set.total_overlapping, working_set.total_spanning
            if strand:
                stranded = filter_reads_by_strand(reads_to_sample, strand, calls)
                total_overlapping, total_spanning = strand_totals(
                    working_set.reads, stranded, working_set.total_overlapping, end - start)
                reads_to_sample = stranded
            if focus_clusters and cluster_assignments:
                reads_to_sample = filter_reads_by_cluster_focus(
                    reads_to_sample,
                    cluster_assignments,
                    focus_clusters,
                )
            working_set = WorkingSet(
                reads_to_sample,
                total_overlapping,
                total_spanning,
                chrom,
                start,
                end,
            )
        else:
            server_timings["broad_cache_hit"] = 1.0
            phase_t0 = time.perf_counter()
            def matches_cluster(read_id: str) -> bool:
                if not focus_clusters:
                    return True
                return cluster_assignments.get(read_id) in focus_clusters

            reads_to_sample = []
            total_overlapping_in_viewport = 0
            total_in_viewport = 0
            total_spanning_in_viewport = 0
            for read in iter_broad_reads_overlapping_viewport(
                state,
                broad_reads,
                viewport_offset,
                viewport_offset + region_width,
            ):
                adjusted_read, is_spanning = project_broad_read_to_viewport(
                    read,
                    viewport_offset=viewport_offset,
                    region_width=region_width,
                    include_methylation=include_methylation,
                    layer_key=layer_key,
                    include_layer_qualities=include_layer_qualities,
                )
                if adjusted_read is None:
                    continue

                # A one-strand panel's counts are that strand's reads.
                if strand and cached_read_strand(read, calls) != strand:
                    continue

                total_overlapping_in_viewport += 1
                if is_spanning:
                    total_spanning_in_viewport += 1

                if spanning and not is_spanning:
                    continue

                total_in_viewport += 1
                if filter_id_set and not read_matches_id_filter(read["id"], filter_id_set):
                    continue

                if not matches_cluster(read["id"]):
                    continue

                if display_quality_filters and "layers" in adjusted_read:
                    adjusted_read = apply_quality_filters(adjusted_read, display_quality_filters)
                    if adjusted_read is None:
                        continue

                reads_to_sample.append(adjusted_read)

            filter_desc = []
            if filter_id_set:
                filter_desc.append(f"filter_ids={len(filter_id_set)}")
            if focus_clusters:
                filter_desc.append(f"clusters={focus_clusters}")
            if min_footprints > 0:
                filter_desc.append(f"min_fp={min_footprints}")
            log_read_diagnostic(
                f"  Filtered from broad cache ({', '.join(filter_desc)}): "
                f"{total_in_viewport} in-scope -> {len(reads_to_sample)} reads"
            )

            working_set = WorkingSet(
                reads_to_sample,
                total_overlapping_in_viewport,
                total_spanning_in_viewport,
                chrom,
                start,
                end,
            )
            server_timings["broad_filter_ms"] = phase_ms(phase_t0)
        if active_consensus:
            working_set=project_consensus_working_set(state,dataset_id,chrom,start,end,working_set,
                projection_source=projection_source)
        working_count = len(working_set.reads)
        if include_metaprofile:
            phase_t0 = time.perf_counter()
            metaprofile, metaprofile_read_count = compact_metaprofile_for_reads(
                working_set.reads,
                region_width=region_width,
                requested_layers=requested_metaprofile_layers,
                profile_max_reads=profile_max_reads,
            )
            server_timings["metaprofile_ms"] = phase_ms(phase_t0)
        phase_t0 = time.perf_counter()
        display_reads = sample_compact_reads_for_display(
            working_set.reads,
            max_reads,
            region_width,
            sample_by_coverage,
        )
        server_timings["display_sample_ms"] = phase_ms(phase_t0)
    else:
        phase_t0 = time.perf_counter()
        projection_max_reads = int(max_reads or 0)
        can_sample_before_projection = (
            hasattr(state, "_broad_cache")
            and not (active_consensus and include_metaprofile)
            and hasattr(state, "_broad_cache_max")
            and not quality_filters_require_full_projection(active_quality_filters(state))
            and not fill_gap_size
            and projection_max_reads is not None
            and int(projection_max_reads or 0) >= 0
        )
        if can_sample_before_projection:
            display_quality_filters = quality_filters_for_display_layers(
                active_quality_filters(state),
                layer_key,
            )
            working_set, working_count = build_sampled_display_working_set(
                state,
                dataset_id,
                chrom,
                start,
                end,
                max_reads=projection_max_reads,
                spanning=spanning,
                min_footprints=min_footprints,
                include_methylation=include_methylation,
                include_layers=include_layers,
                requested_layers=requested_layers,
                include_layer_qualities=include_layer_qualities,
                build_bam_reads=display_bam_loader(state, build_direct_bam_reads),
                build_bigbed_reads=lambda *args, **kwargs: build_direct_bigbed_reads(
                    *args, **{'short_terminal_footprint_bp': short_terminal_footprint_bp_for(state), **kwargs}),
                load_bigbed_marks=load_direct_bigbed_marks,
                infer_legacy_layers=infer_legacy_layers,
                legacy_nuc_min_size=legacy_nuc_min_size,
                quality_filters=display_quality_filters,
                profile_max_reads=profile_max_reads if include_metaprofile else 0,
                profile_requested_layers=requested_metaprofile_layers if include_metaprofile else None,
                timings=server_timings,
                sv_min_len=min_sv_len if include_sv_summary else None,
                sv_conflict_options=sv_conflict_options,
                full_working_set=full_working_set,
            )
            server_timings["display_working_set_ms"] = phase_ms(phase_t0)
            if include_metaprofile:
                metaprofile = getattr(working_set, "profile_metaprofile", None)
                metaprofile_read_count = getattr(working_set, "profile_read_count", 0)
                server_timings["metaprofile_ms"] = 0.0
            phase_t0 = time.perf_counter()
            display_reads = sample_compact_reads_for_display(
                working_set.reads,
                max_reads,
                region_width,
                sample_by_coverage,
            )
            server_timings["display_sort_ms"] = phase_ms(phase_t0)
        else:
            working_set = query.build_working_set(
                state,
                dataset_id,
                include_layer_qualities=include_layer_qualities,
            )
            server_timings["working_set_ms"] = phase_ms(phase_t0)
            working_count = len(working_set.reads)
            if include_metaprofile:
                phase_t0 = time.perf_counter()
                metaprofile, metaprofile_read_count = compact_metaprofile_for_reads(
                    working_set.reads,
                    region_width=region_width,
                    requested_layers=requested_metaprofile_layers,
                    profile_max_reads=profile_max_reads,
                )
                server_timings["metaprofile_ms"] = phase_ms(phase_t0)
            phase_t0 = time.perf_counter()
            display_reads = sample_compact_reads_for_display(
                working_set.reads,
                max_reads,
                region_width,
                sample_by_coverage,
            )
            server_timings["display_sample_ms"] = phase_ms(phase_t0)

    display_reads = apply_consensus_display_overlays(
        state,
        dataset_id,
        chrom,
        start,
        end,
        display_reads,
        total_overlapping=working_set.total_overlapping,
        total_spanning=working_set.total_spanning,
        # Projected already on every path but the sampled display set's.
        projection_source=working_set,
    )

    if fill_gap_size and fill_gap_size > 0:
        phase_t0 = time.perf_counter()
        display_reads = [fill_small_gaps_in_read(read, fill_gap_size) for read in display_reads]
        display_reads = sort_compact_reads_for_display(display_reads)
        server_timings["fill_gaps_ms"] = phase_ms(phase_t0)

    has_methylation = compact_reads_have_methylation(display_reads)
    available_annotation_layers = compact_reads_available_layers(display_reads)

    elapsed = time.time() - t0
    log_read_request(
        f"  /api/reads/compact: {len(display_reads)} display "
        f"(from {working_count} working, {working_set.total_overlapping} in-scope, "
        f"{working_set.total_spanning} spanning) in {elapsed:.3f}s",
        elapsed,
    )

    sv_wraps = bool(circular_chrom_size(state, chrom)) and circular_region_wraps(
        start, end, circular_chrom_size(state, chrom))
    precomputed_sv = getattr(working_set, "sv_summary", None)
    sv_summary_reads = None if (sv_wraps or hasattr(working_set, "sv_summary")) else working_set.reads
    sampling = getattr(working_set, "sampling", None)
    if sampling and isinstance(precomputed_sv, dict):
        # Counted in the sampled reads: the SV band says "in loaded reads"
        # (the SV split, and plugin packs' insertion views, count every alignment).
        precomputed_sv = {**precomputed_sv, "scope": "loaded"}
    if sampling:
        log_read_request(f"  /api/reads/compact: sampled {sampling['kept']:,} of {sampling['total']:,} reads "
                         f"(level {sampling['level']})", elapsed)
    payload = _attach_sv(compact_reads_response_payload(
        display_reads=display_reads,
        width=region_width,
        dataset_id=dataset_id,
        dataset_label=dataset.label,
        dataset_color=dataset.color,
        working_count=working_count,
        total_in_scope=working_set.total_spanning if spanning else working_set.total_overlapping,
        total_spanning=working_set.total_spanning,
        total_overlapping=working_set.total_overlapping,
        has_methylation=has_methylation,
        available_layers=available_layers_for_response(dataset, available_annotation_layers),
        sample_seed=sample_seed,
        warning=bam_warning,
        server_elapsed_ms=elapsed * 1000,
        server_timings=server_timings,
        metaprofile=metaprofile,
        metaprofile_read_count=metaprofile_read_count,
        profile_max_reads=profile_max_reads if include_metaprofile else None,
    ), summary_reads=sv_summary_reads, chrom=chrom, start=start, end=end, min_sv_len=min_sv_len,
        include_summary=include_sv_summary and not sv_wraps, scope=_sv_summary_scope(state, working_count),
        precomputed=precomputed_sv, conflict_options=sv_conflict_options)
    if sampling and isinstance(payload, dict):
        # The panel says "N of M reads (sampled)" and offers to load them all.
        payload["working_sampling"] = sampling
    from services.read_binary import binary_read_context
    if binary_read_context.get() and isinstance(payload, dict):
        payload["_region_reuse_safe"] = (
            not active_quality_filters(state) and not active_consensus
            and not circular_chrom_size(state, chrom)
        )
    return payload


def _store_direct_reads_cache(cache, key, value, max_reads=100_000):
    """Bound retained region objects, not the number of reads returned.

    A single oversized region remains cacheable. Evict oldest regions before
    inserting, keeping at most ten entries and normally 100k read objects.
    Caller holds the existing broad-cache lock.
    """
    from services.byte_cache import ByteCache
    if isinstance(cache, ByteCache):
        from services.packed_reads import pack_reads
        cache[key] = (pack_reads(value[0]), value[1])
        return
    cache.pop(key, None)
    retained = sum(len(entry[0]) for entry in cache.values())
    incoming = len(value[0])
    if incoming == 0:
        return
    while cache and (len(cache) >= 10 or retained + incoming > max_reads):
        oldest = next(iter(cache))
        retained -= len(cache.pop(oldest)[0])
    cache[key] = value


def compact_reads_payload_for_request(state, *, pin_ids: Optional[str] = None, **kwargs) -> dict:
    """Build the `/api/reads/compact` payload for one dataset.

    When the "Min footprints" filter leaves no read in view, the payload says
    how many reads it hid (``hidden_by_min_footprints``), so the read track
    can say a filter is responsible (short reads and amplicons rarely carry 5
    footprints) instead of looking empty. Counted only in that case: one more
    load of the view with every other filter as asked.
    """
    from services.read_pins import parse_pin_ids, pinned_reads
    with pinned_reads(parse_pin_ids(unwrap_query_default(pin_ids, None))):
        payload = _compact_reads_payload(state, **kwargs)
    min_footprints = int(query_int(kwargs.get("min_footprints", 0), 0) or 0)
    if min_footprints > 0 and _empty_payload(payload):
        # Only Min footprints changes: layers, qualities and marks stay as asked,
        # so the quality gates and strand filters judge the same reads.
        unfiltered = _compact_reads_payload(state, **{
            **kwargs,
            "min_footprints": 0,
            "max_reads": 1,
            "include_cigar": False,
            "include_metaprofile": False,
        })
        hidden = _hidden_count(unfiltered, spanning=query_bool(kwargs.get("spanning"), False))
        if hidden > 0:
            payload["hidden_by_min_footprints"] = hidden
    from services.signal_counts import attach_signal_counts
    signal_t0 = time.perf_counter()
    attach_signal_counts(payload, state, payload.get("dataset_id") or kwargs.get("dataset_id"),
                         kwargs["chrom"], kwargs["start"], kwargs["end"],
                         include_duplicates=query_bool(kwargs.get("include_duplicates"), False),
                         spanning=query_bool(kwargs.get("spanning"), False))
    signal_ms = (time.perf_counter() - signal_t0) * 1000
    payload.setdefault('server_timings', {})['signal_counts_ms'] = round(signal_ms, 1)
    if 'server_elapsed_ms' in payload:
        payload['server_elapsed_ms'] += signal_ms
    return payload


def _empty_payload(payload) -> bool:
    """No read in the request's scope passed its filters. Judged on the reads in
    scope, not total_overlapping: a sampled view (Low memory, deep views) reports
    the whole view's alignments there, before the read filters."""
    return isinstance(payload, dict) and _payload_count(
        payload, ("total_in_scope", "total", "total_overlapping", "working_count")) == 0


def _hidden_count(unfiltered, *, spanning: bool = False) -> int:
    """Reads Min footprints hid: none when nothing is in scope without it either
    (e.g. no read spans the view), else the view's reads as the payload counts them
    (the spanning ones when only those are shown)."""
    if _empty_payload(unfiltered):
        return 0
    if spanning:
        return _payload_count(unfiltered, ("total_spanning", "total_in_scope", "total"))
    return _payload_overlapping(unfiltered)


def _payload_overlapping(payload) -> int:
    return _payload_count(payload, ("total_overlapping", "total_in_scope", "total", "working_count"))


def _payload_count(payload, keys) -> int:
    if not isinstance(payload, dict):
        return 0
    for key in keys:
        value = payload.get(key)
        if isinstance(value, (int, float)):
            return int(value)
    return len(payload.get("reads") or [])


def hidden_by_min_footprints_for_dataset(result, *, query, min_footprints: int, rebuild) -> None:
    """compact_all: add ``hidden_by_min_footprints`` to one dataset's result
    (see compact_reads_payload_for_request). ``rebuild(query, min_footprints)``
    builds the result again."""
    if not result or int(min_footprints or 0) <= 0:
        return
    _dataset_id, data = result
    if not _empty_payload(data):
        return
    from dataclasses import replace
    unfiltered = rebuild(replace(query, min_footprints=0), 0)
    hidden = _hidden_count(unfiltered[1], spanning=bool(getattr(query, "spanning", False))) if unfiltered else 0
    if hidden > 0:
        data["hidden_by_min_footprints"] = hidden


def compact_all_dataset_result(
    *,
    state,
    query,
    dataset_id: str,
    chrom: str,
    start: int,
    end: int,
    region_width: int,
    spanning: bool,
    max_reads: int,
    downsample: Optional[int],
    include_methylation: bool,
    include_layers: bool,
    requested_layers,
    include_layer_qualities: bool,
    ml_threshold: int,
    fill_gap_size: Optional[int],
    min_fp_quality: int,
    min_footprints: int,
    include_metaprofile: bool,
    profile_max_reads: int,
    coverage_sample: bool,
    hide_terminal_gaps: bool,
    terminal_gap_threshold: int,
    infer_legacy_layers: bool,
    legacy_nuc_min_size: int,
    sample_seed: str,
    include_duplicates: bool = False,
    min_sv_len: int = SV_MIN_LEN_DEFAULT,
    include_sv_summary: bool = True,
    sv_conflict_options=None,
):
    """Build one dataset payload for `/api/reads/compact_all`.

    SV events come from the cache's floor: a ``min_sv_len`` below it is
    served at the floor (the browser asks /api/reads/compact for those)."""
    min_sv_len = max(SV_MIN_LEN_DEFAULT, normalize_min_sv_len(unwrap_query_default(min_sv_len, SV_MIN_LEN_DEFAULT)))
    t0 = time.time()
    server_timings: dict[str, float] = {}
    def phase_ms(started_at: float) -> float:
        return (time.perf_counter() - started_at) * 1000

    dataset = state.get_dataset(dataset_id)
    if not dataset:
        return None

    effective_requested_layers = requested_layers
    effective_include_layers = include_layers
    effective_include_layer_qualities = include_layer_qualities
    # Consensus overlays project onto the source TF/nuc/MSP layers; load them
    # on every path (the working-set path also does this in build_working_set).
    from services.consensus_workflow import active as consensus_active
    if consensus_active(state, dataset_id, chrom, start, end):
        effective_requested_layers = consensus_overlay_source_layers(
            state, dataset, dataset_id, chrom, start, end, requested_layers,
        )
        effective_include_layers = True

    warning = bam_index_warning(dataset)
    direct = needs_direct_read_load(
        dataset,
        min_fp_quality=min_fp_quality,
        hide_terminal_gaps=hide_terminal_gaps,
        terminal_gap_threshold=terminal_gap_threshold,
        include_duplicates=include_duplicates,
        ml_threshold=ml_threshold,
        include_methylation=include_methylation,
    )

    if direct:
        phase_t0 = time.perf_counter()
        reads = load_direct_reads_for_dataset(
            state,
            dataset,
            chrom=chrom,
            start=start,
            end=end,
            spanning_only=spanning,
            include_methylation=include_methylation,
            ml_threshold=ml_threshold,
            min_fp_quality=min_fp_quality,
            include_cigar=False,
            hide_terminal_gaps=hide_terminal_gaps,
            terminal_gap_threshold=terminal_gap_threshold,
            include_layers=effective_include_layers,
            requested_layers=effective_requested_layers,
            include_layer_qualities=effective_include_layer_qualities,
            infer_legacy_layers=infer_legacy_layers,
            legacy_nuc_min_size=legacy_nuc_min_size,
            include_duplicates=include_duplicates,
            min_footprints=(
                min_footprints
                if getattr(dataset, "available_layers", {}).get("footprint", True)
                else 0
            ),
        )
        server_timings["direct_load_ms"] = phase_ms(phase_t0)
        # Working sets apply the active quality gates; so must this path.
        reads = apply_quality_filters_to_reads(reads, active_quality_filters(state))
    else:
        phase_t0 = time.perf_counter()
        working_set = query.build_working_set(
            state,
            dataset_id,
            include_layers=effective_include_layers,
            requested_layers=effective_requested_layers,
            include_layer_qualities=effective_include_layer_qualities,
        )
        server_timings["working_set_ms"] = phase_ms(phase_t0)
        reads = list(working_set.reads)

    if fill_gap_size and fill_gap_size > 0:
        phase_t0 = time.perf_counter()
        reads = [fill_small_gaps_in_read(read, fill_gap_size) for read in reads]
        server_timings["fill_gaps_ms"] = phase_ms(phase_t0)

    if direct:
        total_spanning = len(reads) if spanning else sum(
            1 for read in reads if is_read_spanning(read, region_width)
        )
        total_overlapping = len(reads)
    else:
        total_spanning = working_set.total_spanning
        total_overlapping = working_set.total_overlapping

    total_count = len(reads)
    has_methylation = compact_reads_have_methylation(reads)

    phase_t0 = time.perf_counter()
    profile_reads = sort_compact_reads_for_display(reads)
    if profile_max_reads > 0 and len(profile_reads) > profile_max_reads:
        profile_seed = f"{sample_seed}:compact_all_profile:{dataset_id}:{chrom}:{start}:{end}"
        profile_reads = sort_compact_reads_for_display(
            sample_stable_by_id(profile_reads, profile_max_reads, profile_seed)
        )
    server_timings["profile_pool_ms"] = phase_ms(phase_t0)

    phase_t0 = time.perf_counter()
    display_reads = sort_compact_reads_for_display(reads)
    target_count = downsample if (downsample is not None and downsample > 0) else max_reads

    if target_count and target_count > 0 and len(display_reads) > target_count:
        if coverage_sample and not spanning:
            display_reads = sample_by_coverage(display_reads, target_count, start, end)
        elif downsample is not None and downsample > 0:
            region_seed = stable_seed_int(sample_seed, "compact_all", dataset_id, chrom, start, end)
            rng = random.Random(region_seed)
            display_reads = rng.sample(display_reads, target_count)
        else:
            step = len(display_reads) / target_count
            display_reads = [display_reads[int(i * step)] for i in range(target_count)]
        # Reads the request pins (a read gone to by name) stay in the sample.
        display_reads = sort_compact_reads_for_display(with_pinned(display_reads, reads, compact_read_id))
    display_reads = apply_consensus_display_overlays(
        state,
        dataset_id,
        chrom,
        start,
        end,
        display_reads,
        total_overlapping=total_overlapping,
        total_spanning=total_spanning,
        # The normal working-set path already projected the full cohort. Only
        # sampling/sorting borrowed rows is safe to reuse; gap rewriting and
        # direct loads retain the existing final-projection path.
        projection_source=working_set if not direct and not (fill_gap_size and fill_gap_size>0) else None,
    )
    server_timings["display_sample_ms"] = phase_ms(phase_t0)

    metaprofile = None
    if include_metaprofile and profile_reads:
        phase_t0 = time.perf_counter()
        nucs = compute_metaprofile_from_compact_reads(profile_reads, region_width, 90, 100000)
        smalls = compute_metaprofile_from_compact_reads(profile_reads, region_width, 10, 90)
        if len(nucs) > 500:
            step = len(nucs) // 500
            nucs, smalls = nucs[::step], smalls[::step]
        metaprofile = {
            "nucleosome_profile": nucs.tolist(),
            "subnuc_profile": smalls.tolist(),
        }
        server_timings["metaprofile_ms"] = phase_ms(phase_t0)

    result = {
        **compact_read_count_fields(
            display_count=len(display_reads),
            working_count=total_count,
            total_in_scope=total_count,
            total_spanning=total_spanning,
            total_overlapping=total_overlapping,
        ),
        "reads": display_reads,
        "label": dataset.label,
        "color": dataset.color,
        "has_methylation": has_methylation,
        "available_layers": available_layers_for_response(
            dataset,
            compact_reads_available_layers(display_reads),
        ),
        "metaprofile": metaprofile,
        "metaprofile_read_count": len(profile_reads) if include_metaprofile else 0,
        "profile_max_reads": profile_max_reads,
        "sample_seed": sample_seed,
        "server_timings": {name: round(elapsed, 1) for name, elapsed in server_timings.items()},
    }
    if warning:
        result["warning"] = warning
    sv_wraps = bool(circular_chrom_size(state, chrom)) and circular_region_wraps(
        start, end, circular_chrom_size(state, chrom))
    phase_t0 = time.perf_counter()
    _attach_sv(result, summary_reads=None if sv_wraps else reads, chrom=chrom, start=start, end=end,
               min_sv_len=min_sv_len, include_summary=query_bool(include_sv_summary, True) and not sv_wraps,
               scope=_sv_summary_scope(state, total_count), conflict_options=sv_conflict_options)
    server_timings["sv_summary_ms"] = phase_ms(phase_t0)
    from services.signal_counts import attach_signal_counts
    phase_t0 = time.perf_counter()
    attach_signal_counts(result, state, dataset_id, chrom, start, end,
                         include_duplicates=include_duplicates, spanning=spanning)
    server_timings["signal_counts_ms"] = phase_ms(phase_t0)
    result["server_timings"] = {name: round(elapsed, 1) for name, elapsed in server_timings.items()}
    result["server_elapsed_ms"] = round((time.time() - t0) * 1000, 1)
    return dataset_id, result
