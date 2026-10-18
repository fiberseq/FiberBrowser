"""Endpoint workflow helpers for auxiliary read routes."""
from __future__ import annotations

import hashlib
import io
import os
import threading
import time
from collections.abc import Sequence
from typing import Dict, Optional

import numpy as np
from PIL import Image

from services.accessibility_tracks import meta_line_plot
from services.bam_handles import get_bam_handle
from services.bigbed_handles import get_bigbed_handle
from services.fire_tracks import compute_fire_track
from services.query_params import parse_optional_csv_list, resolve_dataset_id
from services.read_compile import compile_reads_from_regions
from services.read_coverage import compute_binned_read_coverage, log_coverage_diagnostic
from services.read_metrics import normalize_sample_seed, random_state_from_seed
from services.read_rendering import render_reads_to_image
from services.read_route_helpers import (
    log_read_diagnostic as _log_read_diagnostic,
    query_bool as _query_bool,
)
from services.read_sorting import sort_reads_by_accessibility, sort_reads_by_kmeans
from utils.chrom import get_chrom_variants
from services.peak_scanning import remember_peak_regions, stored_peak_regions_for


def get_reads_image_payload(
    state,
    *,
    chrom: str,
    start: int,
    end: int,
    spanning: bool = False,
    max_reads: int = 1000,
    row_height: int = 3,
    use_cluster: bool = False,
    dataset_id: Optional[str] = None,
    width: Optional[int] = None,
    height: Optional[int] = None,
) -> dict:
    chrom = state.translate_chrom(chrom)
    dataset_id = resolve_dataset_id(state, dataset_id)
    reads_df = state.get_reads(chrom, start, end, spanning, dataset_id=dataset_id)

    if reads_df.empty:
        img = Image.new("RGB", (100, 20), (255, 255, 255))
    else:
        if len(reads_df) > max_reads:
            reads_df = reads_df.iloc[np.linspace(0, len(reads_df) - 1, max_reads, dtype=int)].reset_index(drop=True)

        assignments = None
        order = None
        if use_cluster:
            # Clusters belong to the dataset; its stored sort order indexes the
            # compact working set, not these rows, so order the rows by cluster
            # here (unassigned last, otherwise as loaded).
            dataset = state.get_dataset(dataset_id) if dataset_id else None
            assignments = dict(getattr(dataset, "cluster_assignments", None) or {})
            if assignments and "read_id" in reads_df.columns:
                ids = reads_df["read_id"].astype(str).tolist()
                order = sorted(
                    range(len(ids)),
                    key=lambda i: (assignments.get(ids[i]) is None or assignments.get(ids[i]) < 0,
                                   assignments.get(ids[i]) or 0, i),
                )
        img = render_reads_to_image(
            reads_df,
            cluster_assignments=assignments,
            sorted_indices=order,
            max_width=width or 2000,
            row_height=row_height,
        ) or Image.new("RGB", (100, 20), (255, 255, 255))

    # The requested size, exactly (binning only narrows by whole factors).
    size = (width or img.width, height or img.height)
    if size != (img.width, img.height):
        img = img.resize(size, Image.NEAREST)

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return {
        "content": buf.getvalue(),
        "media_type": "image/png",
        "headers": {
            "X-Read-Count": str(len(reads_df)),
            "X-Width": str(img.width),
            "X-Height": str(img.height),
        },
    }


def get_reads_info_payload(state, *, chrom: str, start: int, end: int, spanning: bool = False,
                           dataset_id: Optional[str] = None) -> dict:
    chrom = state.translate_chrom(chrom)
    dataset_id = resolve_dataset_id(state, dataset_id)
    return {"count": len(state.get_reads(chrom, start, end, spanning, dataset_id=dataset_id))}


def clear_cache_payload(state) -> dict:
    state.clear_cache()
    for name in ("_coverage_payload_cache", "_fire_payload_cache"):
        getattr(state, name, {}).clear()
    _log_read_diagnostic("Cleared all caches (broad cache and methylation cache)")
    return {"success": True, "message": "Cache cleared"}


def set_quality_filters_payload(state, body: dict) -> dict:
    filters = body.get("filters", [])
    valid = []
    for quality_filter in filters:
        if quality_filter.get("min_value", 0) > 0:
            valid.append({
                "layer": quality_filter.get("layer", "*"),
                "quality_name": quality_filter.get("quality_name", "nq"),
                "min_value": int(quality_filter["min_value"]),
            })
    changed = state.set_quality_filters(valid)
    return {"success": True, "active_filters": len(valid), "changed": changed is not False}


def get_quality_filters_payload(state) -> dict:
    return {"filters": state.quality_filters}


def set_legacy_layer_inference_payload(state, body: dict) -> dict:
    enabled = _query_bool(body.get("enabled", True), True)
    try:
        nuc_min_size = int(body.get("nuc_min_size", 90))
    except (TypeError, ValueError):
        nuc_min_size = 90
    state.set_legacy_layer_inference(enabled, nuc_min_size)
    return {
        "success": True,
        "enabled": state.infer_legacy_layers,
        "nuc_min_size": state.legacy_nuc_min_size,
    }


def read_end_footprints_payload(state) -> dict:
    from services.compact_read_loader import SHORT_TERMINAL_FOOTPRINT_BP, SHORT_TERMINAL_FOOTPRINT_MAX_END_GAP_BP
    return {
        "hide_short": bool(getattr(state, "drop_short_terminal_footprints", True)),
        "min_bp": int(getattr(state, "short_terminal_footprint_bp", SHORT_TERMINAL_FOOTPRINT_BP)),
        "max_end_gap_bp": SHORT_TERMINAL_FOOTPRINT_MAX_END_GAP_BP,
    }


def set_read_end_footprints_payload(state, body: dict) -> dict:
    """Drop (hide_short=true, the default) or keep read-end footprints shorter
    than the cutoff, for display and analyses (clears the read caches)."""
    changed = state.set_short_terminal_footprints(_query_bool(body.get("hide_short", True), True))
    return {"success": True, "changed": changed, **read_end_footprints_payload(state)}


def get_legacy_layer_inference_payload(state) -> dict:
    return {
        "enabled": getattr(state, "infer_legacy_layers", True),
        "nuc_min_size": getattr(state, "legacy_nuc_min_size", 90),
    }


def _read_ids_cache_token(read_ids: Optional[Sequence[str]]) -> Optional[str]:
    """Stable cache token for an optional read_ids subset.

    None / empty -> None (uses the unscoped cache slot). Otherwise a short
    sha1 over the sorted, deduplicated ids so different subset shapes get
    distinct cache entries without exploding key memory.
    """
    if not read_ids:
        return None
    unique_sorted = sorted({str(rid) for rid in read_ids})
    if not unique_sorted:
        return None
    digest = hashlib.sha1(",".join(unique_sorted).encode("utf-8")).hexdigest()
    return f"ids:{len(unique_sorted)}:{digest[:16]}"


def get_meta_payload(
    state,
    *,
    chrom: str,
    start: int,
    end: int,
    dataset_id: Optional[str] = None,
    read_ids: Optional[Sequence[str]] = None,
) -> dict:
    """Compute nucleosome + subnucleosomal metaprofiles for a region.

    When ``read_ids`` is supplied, the profile is computed only over reads in
    that subset (subsetting happens locally on the fetched reads DataFrame).
    The caller does NOT have to install a Jupyter filter first — that
    workflow is fragile (every consumer of the filter has to be aware) and
    couples the metaprofile to global mutable state.
    """
    chrom = state.translate_chrom(chrom)
    dataset_id = resolve_dataset_id(state, dataset_id)
    if not dataset_id:
        return {"nucleosome_profile": [], "subnuc_profile": [], "dataset_id": None}

    if read_ids is not None and len(read_ids) == 0:
        # An explicit empty subset (a selection matching no reads): no profile,
        # never the whole dataset's, and nothing cached.
        return {"nucleosome_profile": [], "subnuc_profile": [], "dataset_id": dataset_id}

    read_ids_token = _read_ids_cache_token(read_ids)
    from services.signal_evidence import signal_filter_key
    from services.background_work import dataset_identity
    cache_key = (dataset_id, chrom, start, end, read_ids_token)
    sources = dataset_identity(state, [dataset_id])
    if any(signal_filter_key(state)) or any(source[2] for source in sources):
        cache_key += (signal_filter_key(state), sources)
    # Lookup, expiry, LRU order and eviction under the lock that invalidation
    # holds: two requests expiring the same entry must not both delete it.
    from services.working_sets import _broad_cache_sync

    cache_lock, _inflight = _broad_cache_sync(state)
    with cache_lock:
        cached = state._meta_profile_cache.get(cache_key)
        if cached is not None:
            cached_nucs, cached_smalls, timestamp = cached
            if time.time() - timestamp < state._meta_profile_cache_timeout:
                state._meta_profile_cache.move_to_end(cache_key)
                return {"nucleosome_profile": cached_nucs, "subnuc_profile": cached_smalls, "dataset_id": dataset_id}
            state._meta_profile_cache.pop(cache_key, None)

    reads_df = state.get_reads(chrom, start, end, True, dataset_id)
    if reads_df.empty:
        return {"nucleosome_profile": [], "subnuc_profile": [], "dataset_id": dataset_id}

    if read_ids_token is not None:
        id_set = {str(rid) for rid in read_ids}
        if "read_id" in reads_df.columns:
            reads_df = reads_df[reads_df["read_id"].astype(str).isin(id_set)]
        else:
            # Defensive: loader contract is `read_id`, but if a custom loader
            # ever returns `id` instead, honor it rather than silently fail-open
            # by returning the unfiltered profile.
            for fallback_col in ("id", "name"):
                if fallback_col in reads_df.columns:
                    reads_df = reads_df[reads_df[fallback_col].astype(str).isin(id_set)]
                    break
        if reads_df.empty:
            return {"nucleosome_profile": [], "subnuc_profile": [], "dataset_id": dataset_id}

    nucs = meta_line_plot(reads_df, start, end, 90, 100000)
    smalls = meta_line_plot(reads_df, start, end, 10, 90)

    if len(nucs) > 500:
        step = len(nucs) // 500
        nucs, smalls = nucs[::step], smalls[::step]

    nucs_list = nucs.tolist()
    smalls_list = smalls.tolist()

    with cache_lock:
        state._meta_profile_cache[cache_key] = (nucs_list, smalls_list, time.time())
        state._meta_profile_cache.move_to_end(cache_key)
        from services.byte_cache import ByteCache
        while not isinstance(state._meta_profile_cache, ByteCache) and len(state._meta_profile_cache) > state._meta_profile_cache_max:
            state._meta_profile_cache.popitem(last=False)

    return {"nucleosome_profile": nucs_list, "subnuc_profile": smalls_list, "dataset_id": dataset_id}


def get_meta_all_payload(state, *, chrom: str, start: int, end: int, spanning: bool = True,
                         dataset_ids: Optional[list[str]] = None) -> dict:
    chrom = state.translate_chrom(chrom)
    results = {}
    # Only the listed datasets (in their order) when a list is given.
    ids = [ds_id for ds_id in dataset_ids if ds_id in state.dataset_order] if dataset_ids else state.dataset_order
    for ds_id in ids:
        reads_df = state.get_reads(chrom, start, end, spanning, ds_id)
        if reads_df.empty:
            results[ds_id] = {"nucleosome_profile": [], "subnuc_profile": []}
            continue

        nucs = meta_line_plot(reads_df, start, end, 90, 100000)
        smalls = meta_line_plot(reads_df, start, end, 10, 90)

        if len(nucs) > 500:
            step = len(nucs) // 500
            nucs, smalls = nucs[::step], smalls[::step]

        results[ds_id] = {"nucleosome_profile": nucs.tolist(), "subnuc_profile": smalls.tolist()}

    return {"profiles": results}


def get_genes_payload(state, *, chrom: str, start: int, end: int) -> dict:
    from services.circular_genome import circular_chrom_size, circular_region_wraps, circular_view_segments

    gtf_data = state.gtf_data  # one snapshot (an annotation can be replaced meanwhile: this runs in a thread)
    if gtf_data is None:
        return {
            "content": {"genes": [], "gtf_loaded": False},
            "headers": {"Cache-Control": "no-cache, no-store, must-revalidate"},
        }

    from services.gene_annotations import exon_table

    tx_df = gtf_data["transcripts"]
    ex_df = exon_table(gtf_data.get("exons"))

    if tx_df.empty:
        return {"content": {"genes": []}, "headers": {"Cache-Control": "max-age=300"}}

    genes = []

    chrom_variants = get_chrom_variants(chrom)
    chrom_size = circular_chrom_size(state, chrom)
    if chrom_size and circular_region_wraps(start, end, chrom_size):
        windows = [
            (segment.ref_start, segment.ref_end, segment.logical_start - segment.ref_start)
            for segment in circular_view_segments(start, end, chrom_size)
        ]
    else:
        windows = [(start, end, 0)]
        if chrom_size:
            # A feature across the origin is stored as start..end past the
            # length: its part after the origin is drawn one turn back.
            windows.append((start + chrom_size, end + chrom_size, -chrom_size))

    for window_start, window_end, coord_shift in windows:
        visible = tx_df[
            (tx_df["chrom"].isin(chrom_variants))
            & (tx_df["start"] <= window_end)
            & (tx_df["end"] >= window_start)
        ]
        if coord_shift and chrom_size and coord_shift == -chrom_size and windows[0][2] == 0:
            visible = visible[visible["end"] > chrom_size]
        # The window's exons of the visible transcripts, grouped once (in table
        # order). Scanning the whole exon table per transcript took 0.6 s for
        # a 200 kb dm6 view and 4-6 s for 2 Mb (dm6, hg38).
        window_exons = ex_df[
            (ex_df["start"] <= window_end)
            & (ex_df["end"] >= window_start)
            & (ex_df["transcript_id"].isin(visible["transcript_id"]))
        ]
        exons_by_tx = {
            tx_id: [(int(lo), int(hi)) for lo, hi in zip(group["start"], group["end"])]
            for tx_id, group in window_exons.groupby("transcript_id", sort=False)
        }
        for _, tx in visible.iterrows():
            exons = exons_by_tx.get(tx["transcript_id"], [])
            biotype = tx.get("biotype", "") if "biotype" in tx.index else ""
            suffix = f":wrap{coord_shift}" if coord_shift else ""
            genes.append({
                "id": f"{tx['transcript_id']}{suffix}",
                "name": str(tx["gene_name"]),
                "chrom": str(tx["chrom"]),
                "start": int(tx["start"]) + coord_shift,
                "end": int(tx["end"]) + coord_shift,
                "strand": str(tx["strand"]),
                "biotype": str(biotype) if biotype else "",
                "exons": [
                    {"start": lo + coord_shift, "end": hi + coord_shift}
                    for lo, hi in exons
                ],
            })
    return {"content": {"genes": genes}, "headers": {"Cache-Control": "max-age=300"}}


_FIRE_CACHE_TTL = 60


_STATE_CACHE_LOCK = threading.Lock()


def _state_cache(state, name: str) -> Dict[tuple, tuple]:
    """A cache that belongs to this session's state (sessions don't share results)."""
    cache = getattr(state, name, None)
    if cache is None:
        # Requests run in worker threads: create it once. setattr (not the
        # instance dict) so a panel-genome view stores it on its base state.
        with _STATE_CACHE_LOCK:
            cache = getattr(state, name, None)
            if cache is None:
                from services.byte_cache import shared_cache
                cache = shared_cache('coverage' if name == '_coverage_payload_cache' else 'profiles')
                try:
                    setattr(state, name, cache)
                except Exception:
                    pass
    return cache


def _source_identity(dataset) -> tuple:
    """What a dataset's results come from: its files (and their timestamps, so a
    file replaced under the same path or dataset id is not served from cache)."""
    identity = []
    for path in list(getattr(dataset, "paths", None) or []):
        try:
            stat = os.stat(path)
            identity.append((str(path), stat.st_mtime_ns, stat.st_size))
        except (OSError, TypeError, ValueError):
            identity.append((str(path),))
    from services.lift.reads import lift_identity
    return (getattr(dataset, "id", None), getattr(dataset, "data_type", None), tuple(identity), *lift_identity(dataset))


def get_fire_payload(state, *, chrom: str, start: int, end: int) -> dict:
    if state.fire_df is not None:
        from services.circular_genome import circular_query_segments_for_region

        query_segments = circular_query_segments_for_region(state, chrom, start, end)
        _fire_cache = _state_cache(state, "_fire_payload_cache")
        # Keyed by the loaded FIRE table too: another one (a new session, genome) recomputes.
        cache_key = (id(state.fire_df), chrom, start, end, tuple(query_segments or ()))
        now = time.time()
        if cache_key in _fire_cache:
            cached_result, cached_regions, cached_time, _table = _fire_cache[cache_key]
            if now - cached_time < _FIRE_CACHE_TTL:
                remember_peak_regions(state, cached_regions, chrom, start, end)
                return cached_result

        chrom_variants = get_chrom_variants(chrom)
        fire_track, regions = None, []
        for variant in chrom_variants:
            fire_track, _peaks, regions = compute_fire_track(
                state.fire_df,
                variant,
                start,
                end,
                query_segments=query_segments,
            )
            if fire_track.max() > 0:
                break
        if fire_track is None:
            fire_track = np.zeros(end - start)
        track_type = "fire"
    else:
        track_type = "none"
        regions = []
        fire_track = np.zeros(100)

    remember_peak_regions(state, regions, chrom, start, end)

    signal = fire_track.tolist()
    if len(signal) > 500:
        signal = signal[::len(signal) // 500]

    peaks_list = [
        {"start": int(start + region[0]), "end": int(start + region[1]), "index": i}
        for i, region in enumerate(regions)
    ]

    result = {
        "peaks": peaks_list,
        "signal": signal,
        "type": track_type,
    }

    if track_type == "fire":
        _fire_cache[cache_key] = (result, regions, time.time(), state.fire_df)
        from services.byte_cache import ByteCache
        if not isinstance(_fire_cache, ByteCache) and len(_fire_cache) > 50:
            oldest_key = next(iter(_fire_cache))
            del _fire_cache[oldest_key]

    return result


_COVERAGE_CACHE_TTL = 60


def get_coverage_payload(
    state,
    *,
    chrom: str,
    start: int = 0,
    end: int,
    bins: int = 1000,
    dataset_id: Optional[str] = None,
    include_duplicates: bool = False,
    lift_hap: Optional[str] = None,
    lift_correspondence_only: bool = False,
) -> dict:
    original_chrom = chrom
    chrom = state.translate_chrom(chrom)
    bins = min(bins, 4000)
    from services.circular_genome import (
        circular_query_segments_for_region,
        circular_topology_token,
        is_circular_chrom,
    )

    query_segments = circular_query_segments_for_region(state, chrom, start, end)

    dataset_id = resolve_dataset_id(state, dataset_id) if dataset_id else None
    log_coverage_diagnostic(
        f"  [Coverage] Request: {original_chrom} (translated={chrom}):{start}-{end}, bins={bins}, dataset_id={dataset_id}"
    )

    if dataset_id:
        datasets_to_query = [state.get_dataset(dataset_id)]
        datasets_to_query = [d for d in datasets_to_query if d]
    else:
        datasets_to_query = [state.get_dataset(ds_id) for ds_id in state.dataset_order]
        datasets_to_query = [d for d in datasets_to_query if d]

    if not datasets_to_query:
        log_coverage_diagnostic(f"  [Coverage] No datasets found! dataset_order={state.dataset_order}")
        return {"coverage": [0] * bins, "max": 0}

    log_coverage_diagnostic(
        f"  [Coverage] Querying {len(datasets_to_query)} dataset(s): "
        f"{[(d.id, d.data_type, d.paths) for d in datasets_to_query]}"
    )

    from services.plasmid_reconcile import contig_links as _contig_links
    links = {d.id: _contig_links(state, dataset_id=d.id) for d in datasets_to_query}
    _coverage_cache = _state_cache(state, "_coverage_payload_cache")
    # Topology too: an interior window has the same (no) query segments either
    # way, but a circular contig's coverage counts wrapped tails.
    from services.signal_evidence import signal_filter_key
    cache_key = (signal_filter_key(state), tuple(_source_identity(d) for d in datasets_to_query), lift_hap,
                 chrom, start, end, bins, bool(lift_correspondence_only),
                 tuple(query_segments or ()), circular_topology_token(state, chrom), bool(include_duplicates),
                 tuple((d_id, tuple(sorted(l.items()))) for d_id, l in links.items() if l))

    now = time.time()
    cached = _coverage_cache.get(cache_key)  # one lookup: another request may evict it meanwhile
    if cached is not None:
        cached_result, cached_time = cached
        if now - cached_time < _COVERAGE_CACHE_TTL:
            log_coverage_diagnostic(f"  [Coverage] Cache hit (age={now - cached_time:.0f}s)")
            return cached_result

    from services.lift.capability import is_lifted
    lifted = [d for d in datasets_to_query if is_lifted(d)]
    native = [d for d in datasets_to_query if not is_lifted(d)]
    if lifted:
        # Live-lift datasets: counted from their lifted rows, with correspondence for hatching
        # (services/lift/reads.lifted_coverage); native datasets in the same request add as reads.
        from services.lift.reads import lifted_coverage
        parts = []
        for dataset in lifted:
            rows, broad_key = (None, None) if lift_correspondence_only or include_duplicates else _cached_lift_rows(
                state, dataset, chrom, start, end, now)
            parts.append(lifted_coverage(dataset, chrom, start, end, bins, lift_hap=lift_hap,
                                         include_duplicates=bool(include_duplicates),
                                         correspondence_only=bool(lift_correspondence_only), rows=rows,
                                         rows_start=broad_key[2] if broad_key else None))
        if lift_correspondence_only:
            result = {"coverage": None, "max": 0,
                      "live_lift": parts[0]["live_lift"] if len(parts) == 1 else {"datasets": [p["live_lift"] for p in parts]}}
            _coverage_cache[cache_key] = (result, now)
            return result
        result = (compute_binned_read_coverage(native, chrom, start, end, bins, bam_handle_getter=get_bam_handle,
                                               bigbed_handle_getter=get_bigbed_handle, query_segments=query_segments,
                                               circular=is_circular_chrom(state, chrom), contig_links=links,
                                               include_duplicates=bool(include_duplicates))
                  if native else {"coverage": [0] * bins, "max": 0})
        total = [a + sum(p["coverage"][i] for p in parts) for i, a in enumerate(result["coverage"])]
        result = {**result, "coverage": total, "max": max(total) if total else 0,
                  "live_lift": parts[0]["live_lift"] if len(parts) == 1 else {"datasets": [p["live_lift"] for p in parts]}}
        _coverage_cache[cache_key] = (result, now)
        return result
    result = compute_binned_read_coverage(
        datasets_to_query,
        chrom,
        start,
        end,
        bins,
        bam_handle_getter=get_bam_handle,
        bigbed_handle_getter=get_bigbed_handle,
        query_segments=query_segments,
        circular=is_circular_chrom(state, chrom),
        contig_links=links,
        include_duplicates=bool(include_duplicates),
    )

    # Requests run in worker threads: evict without assuming no one else did.
    _coverage_cache[cache_key] = (result, now)
    from services.byte_cache import ByteCache
    while not isinstance(_coverage_cache, ByteCache) and len(_coverage_cache) > 50:
        try:
            _coverage_cache.pop(next(iter(_coverage_cache)), None)
        except (StopIteration, RuntimeError):  # emptied / resized by another request
            break

    return result


def _cached_lift_rows(state, dataset, chrom, start, end, now, *, annotations=False):
    """Reuse display geometry, regardless of its requested annotation groups.
    Match its load token to today's sources/lift key; a sampled display entry
    is usable too. Coverage needs bodies only. With annotations=True,
    inspection requires marks, all layers and default inference; its caller
    must still decode any records omitted by a sampled cache."""
    from services.working_sets import (find_broad_cache_entry, read_load_token, broad_cache_topology,
                                       broad_cache_legacy_layer_settings, broad_cache_min_footprints,
                                       _broad_cache_sync)
    token = read_load_token(state, chrom)
    lock, _inflight = _broad_cache_sync(state)
    with lock:
        keys = list(getattr(state, "_broad_cache", {}))
    for key in reversed(keys):
        if key[:2] != (dataset.id, chrom):
            continue
        topology = broad_cache_topology(key)
        if topology[:len(token)] != token:
            continue
        infer, nuc_min = broad_cache_legacy_layer_settings(key)
        if annotations and (not infer or nuc_min != 90 or broad_cache_min_footprints(key)):
            continue
        rows, found = find_broad_cache_entry(state, dataset.id, chrom, start, end, annotations, None if annotations else (), now,
                                            include_layer_qualities=False, infer_legacy_layers=infer,
                                            legacy_nuc_min_size=nuc_min, min_footprints=broad_cache_min_footprints(key),
                                            load_token=topology)
        if rows is not None:
            return rows, found
    return None, None


def compile_regions_payload(state, req) -> dict:
    return compile_reads_from_regions(
        state,
        req.regions,
        req.dataset_ids,
        req.spanning,
        req.max_reads_per_region,
        req.anchor,
        req.target_width,
        req.sample_seed,
        req.include_deam_opportunities,
    )


def render_compiled_image_bytes(
    state,
    req,
    *,
    width: int = 2000,
    row_height: int = 3,
    max_reads: int = 500,
    show_mods: bool = False,
    show_fire: bool = False,
    sort_by: Optional[str] = None,
    title: Optional[str] = None,
) -> bytes:
    from render import render_axis_track, render_compact_reads_track, render_composite

    if not req.regions:
        raise ValueError("No regions")

    sample_seed = normalize_sample_seed(req.sample_seed)
    compiled = compile_reads_from_regions(
        state,
        req.regions,
        req.dataset_ids,
        req.spanning,
        req.max_reads_per_region,
        req.anchor,
        req.target_width,
        sample_seed,
        req.include_deam_opportunities,
    )
    if not compiled.get("success"):
        raise ValueError(compiled.get("message", "Compile failed"))

    all_reads = compiled["reads"]
    target_width = compiled["target_width"]
    if not all_reads:
        raise ValueError("No reads found in any region")

    if sort_by == "accessibility":
        all_reads = sort_reads_by_accessibility(all_reads)
    elif sort_by == "region":
        pass
    elif sort_by == "kmeans":
        try:
            compile_random_state = random_state_from_seed(sample_seed, "reads_compile", "kmeans")
            all_reads = sort_reads_by_kmeans(
                all_reads,
                target_width,
                n_clusters=5,
                random_state=compile_random_state,
            )
        except Exception as exc:
            _log_read_diagnostic(f"  Warning: clustering failed: {exc}")

    track_images = [("axis", render_axis_track(width, "compiled", 0, target_width))]

    img = render_compact_reads_track(
        all_reads,
        target_width,
        width=width,
        row_height=row_height,
        show_mods=show_mods,
        show_fire=show_fire,
        show_deam_opportunities=req.include_deam_opportunities,
        max_reads=max_reads,
    )
    if img is not None:
        track_images.append(("reads", img))

    composite = render_composite(
        track_images,
        title=title or f"Compiled: {len(req.regions)} regions, {len(all_reads)} reads",
        width=width,
    )

    buf = io.BytesIO()
    composite.save(buf, format="PNG")
    buf.seek(0)
    return buf.getvalue()
