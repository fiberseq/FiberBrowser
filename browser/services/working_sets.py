"""Working-set construction and cache orchestration."""
from __future__ import annotations

from services.dataset_generation import dataset_generation
import os
import re
import time
import heapq
import threading
from bisect import bisect_left, bisect_right
from collections import OrderedDict
from services.byte_cache import ByteCache
from services.packed_reads import pack_reads, PackedReads, PackedReadBuilder, bounded_analysis, compact_read_bounds
from typing import Callable, Iterable, Optional

from models.domain import WorkingSet
from services.circular_genome import (
    circular_chrom_size,
    circular_topology_token,
    circular_region_wraps,
    circular_view_segments,
    merge_compact_reads_by_id,
    shift_compact_read,
)
from services.diagnostics import env_flag_enabled, log_if_enabled
from services.read_quality_filters import active_quality_filters, apply_quality_filters
from services.read_metrics import (
    DEFAULT_SAMPLE_SEED,
    compute_compact_metaprofile_payload,
    nuc_layer_duplicates_primary,
    normalize_sample_seed,
)
from services.read_selection import is_read_spanning, read_matches_id_filter


LayerKey = Optional[tuple[str, ...]]
WORKING_SET_DIAGNOSTICS_ENV = "FIBERBROWSER_WORKING_SET_DIAGNOSTICS"
BROAD_CACHE_SCHEMA_VERSION = 5
_BROAD_CACHE_SYNC_INIT_LOCK = threading.Lock()


def _broad_cache_sync(state) -> tuple[threading.RLock, dict[tuple, threading.Event]]:
    """Return per-session synchronization for broad-cache misses.

    Browser navigation can abort a fetch after FastAPI has dispatched its
    worker thread. A post-scan refresh followed immediately by navigation may
    therefore leave two requests decoding the same large BigBed companions.
    Keep unrelated datasets/regions parallel, but coalesce an identical miss
    so waiters reuse the first completed decode.
    """
    if not hasattr(state, "_broad_cache_lock"):
        with _BROAD_CACHE_SYNC_INIT_LOCK:
            if not hasattr(state, "_broad_cache_lock"):
                state._broad_cache_lock = threading.RLock()
                state._broad_cache_inflight = {}
    return state._broad_cache_lock, state._broad_cache_inflight


def _store_broad_cache_entry(state, key: tuple, reads: list[dict], generation: Optional[int] = None):
    from services.read_sampling import decode_read_scope
    if decode_read_scope.get() is not None:
        return  # An explicit capped cohort must never populate an unfiltered key.
    # Packing can take time; don't hold the navigation cache lock while doing
    # it, and don't publish a cohort whose source changed during the work.
    retained = pack_reads(reads) if isinstance(state._broad_cache, ByteCache) else reads
    cache_lock, _inflight = _broad_cache_sync(state)
    with cache_lock:
        # Loaded for a source since replaced under the same ID: not cached.
        if generation is not None and dataset_generation(state, key[0]) != generation:
            return
        state._broad_cache[key] = (retained, time.time())
        state._broad_cache.move_to_end(key)
        while not isinstance(state._broad_cache, ByteCache) and len(state._broad_cache) > getattr(state, "_broad_cache_max", 20):
            state._broad_cache.popitem(last=False)
    return retained


def _as_path_list(value) -> list[str]:
    """Normalize a companion_layers entry to a list of paths. Accepts the current
    list shape and the legacy single-string shape (older saved sessions)."""
    if not value:
        return []
    if isinstance(value, str):
        return [value]
    return list(value)


DEFAULT_PREFETCH_MULTIPLIER = 10


def configured_prefetch_multiplier(state) -> int:
    """Cache neighboring windows in background work, never in a visible load."""
    from services.background_work import is_interactive_read
    from services.read_stream import is_prefetch
    if is_interactive_read() or is_prefetch():
        return 1
    config = getattr(state, "config", None) or {}
    try:
        value = int(config.get("prefetch_multiplier", DEFAULT_PREFETCH_MULTIPLIER))
    except (TypeError, ValueError, AttributeError):
        value = DEFAULT_PREFETCH_MULTIPLIER
    return max(1, value)


def working_set_diagnostics_enabled() -> bool:
    return env_flag_enabled(WORKING_SET_DIAGNOSTICS_ENV)


def log_working_set_diagnostic(message: str) -> None:
    log_if_enabled(WORKING_SET_DIAGNOSTICS_ENV, message)


def normalize_requested_layers(requested_layers: Optional[Iterable[str] | str]) -> tuple[str, ...]:
    """Normalize a user/request layer list into a stable tuple."""
    if requested_layers is None:
        return ()
    if isinstance(requested_layers, str):
        raw_names = requested_layers.split(",")
    else:
        raw_names = requested_layers
    return tuple(sorted({str(name).strip() for name in raw_names if str(name).strip()}))


def make_layer_key(include_layers: bool, requested_layers: Optional[Iterable[str] | str] = None) -> LayerKey:
    """Layer cache identity: () = no layers, None = all layers, tuple = subset."""
    normalized = normalize_requested_layers(requested_layers)
    if normalized:
        return normalized
    return None if include_layers else ()


def broad_cache_layer_key(broad_key: tuple) -> LayerKey:
    """Extract the layer key from old/new broad-cache keys."""
    if len(broad_key) <= 5:
        return None
    value = broad_key[5]
    if isinstance(value, bool):
        return None if value else ()
    if value is None:
        return None
    return normalize_requested_layers(value)


def broad_cache_legacy_layer_settings(broad_key: tuple) -> tuple[bool, int]:
    """Extract legacy-inference settings from old/new broad-cache keys."""
    if len(broad_key) > 8:
        return bool(broad_key[7]), int(broad_key[8] or 90)
    if len(broad_key) <= 7:
        return True, 90
    return bool(broad_key[6]), int(broad_key[7] or 90)


def broad_cache_min_footprints(broad_key: tuple) -> int:
    """Extract the whole-fiber footprint threshold from a broad-cache key."""
    return int(broad_key[9] or 0) if len(broad_key) > 9 else 0


def read_load_token(state, chrom: str, terminal_bp: Optional[int] = None, *, sample_level: int = 0) -> tuple:
    """Cache identity of how a contig's reads are loaded in this workspace: its
    topology (``circular_topology_token``) and the read-end footprint cutoff
    (``short_terminal_footprint_bp_for``). Every read cache keyed by the
    topology is keyed by this, so reads loaded under another setting (e.g. a
    load still running when it changed) are never served. ``terminal_bp``:
    the cutoff a load captured (default: the workspace's current one)."""
    from services.compact_read_loader import SHORT_TERMINAL_FOOTPRINT_BP, short_terminal_footprint_bp_for
    from services.signal_evidence import signal_filter_key
    from services.background_work import dataset_identity
    token = circular_topology_token(state, chrom)
    signal_key = signal_filter_key(state)
    if any(signal_key):
        token += ("signal", signal_key)
    sources = dataset_identity(state, getattr(state, "dataset_order", ()))
    if sources:
        token += ("sources", sources)
    if terminal_bp is None:
        terminal_bp = short_terminal_footprint_bp_for(state)
    # The default setting keeps the plain topology token.
    token = token if terminal_bp == SHORT_TERMINAL_FOOTPRINT_BP else token + ("terminal_fp", terminal_bp)
    # A sampled display load (services/read_sampling.py) is its own entry.
    from services.cluster_sample import cluster_sample_scope
    sample = cluster_sample_scope.get()
    if sample is not None:
        return token + ('cluster_sample_v1', sample.target, sample.fingerprint)
    if not sample_level or int(sample_level) <= 0:
        return token
    token += ("sample", int(sample_level))
    # Pinned reads outside the sample (a read gone to by name, in Low memory, which keeps
    # sampling) are parsed too (Sampler keep_ids): that load is its own entry, so a
    # load without them never serves the pinned request, nor the pinned one a plain view.
    from services.read_pins import current_pins
    from services.read_sampling import keeps
    outside = sorted(pin for pin in current_pins()
                     if not (keeps(pin, int(sample_level)) and keeps(re.sub(r"_\d+$", "", pin), int(sample_level))))
    return token + ("pins", tuple(outside)) if outside else token


def broad_cache_topology(broad_key: tuple) -> tuple:
    """The contig topology a broad-cache entry was loaded under. Keys without
    one predate circular wrapping (the schema bump drops any such entry that
    was really loaded), so they read as linear."""
    return broad_key[10] if len(broad_key) > 10 else ("linear",)


def ensure_broad_cache_schema(state) -> None:
    """Drop process-local read caches from older loader behavior after hot reload."""
    if getattr(state, "_broad_cache_schema_version", None) == BROAD_CACHE_SCHEMA_VERSION:
        return
    if hasattr(state, "_broad_cache"):
        state._broad_cache.clear()
    # A working-set entry is derived from a broad-cache payload. Clearing only
    # the broad tier can therefore keep serving a stale, layer-incomplete read
    # response until its independent timeout expires.
    if hasattr(state, "_working_set_cache"):
        state._working_set_cache.clear()
    state._broad_cache_schema_version = BROAD_CACHE_SCHEMA_VERSION


def layer_key_has_payload(layer_key: LayerKey) -> bool:
    return layer_key is None or len(layer_key) > 0


def _expand_layer_aliases(names: Iterable[str]) -> set[str]:
    expanded = {str(name) for name in names}
    if "fire" in expanded:
        expanded.add("msp")
    if "msp" in expanded:
        expanded.add("fire")
    return expanded


def layer_key_covers(cached_layer_key: LayerKey, requested_layer_key: LayerKey) -> bool:
    """Return True when cached layer payload can satisfy the requested payload."""
    if requested_layer_key == ():
        return True
    if cached_layer_key is None:
        return True
    if cached_layer_key == ():
        return requested_layer_key == ()
    if requested_layer_key is None:
        return False
    return _expand_layer_aliases(requested_layer_key).issubset(_expand_layer_aliases(cached_layer_key))


def layer_key_includes(layer_key: LayerKey, *names: str) -> bool:
    if layer_key is None:
        return True
    if layer_key == ():
        return False
    return bool(_expand_layer_aliases(names) & _expand_layer_aliases(layer_key))


def _derived_layer_paths_for_request(dataset, layer_key: LayerKey) -> list[str]:
    """Return derived-layer bundle paths needed by a layer request."""
    derived_layers = getattr(dataset, "derived_layers", {}) or {}
    if not derived_layers or layer_key == ():
        return []

    requested = None if layer_key is None else _expand_layer_aliases(layer_key)
    paths: list[str] = []
    seen = set()
    for layer_id, meta in derived_layers.items():
        if requested is not None and layer_id not in requested:
            continue
        meta = meta or {}
        for path in meta.get("bundle_paths") or [meta.get("bundle_path") or meta.get("path")]:
            if not path or path in seen:
                continue
            paths.append(path)
            seen.add(path)
    return paths


def _merge_layer_reads_into_reads(
    reads: list[dict],
    layer_reads: list[dict],
    *,
    append_unmatched: bool = False,
) -> int:
    """Merge sidecar layer payloads into compact reads by id.

    ``append_unmatched`` retains valid layer-only molecules when companion and
    primary BigBeds do not contain identical row sets.
    """
    if not layer_reads:
        return 0
    by_id = {read.get("id"): read for read in reads}
    matched = 0
    for layer_read in layer_reads:
        target = by_id.get(layer_read.get("id"))
        if target is None:
            if append_unmatched:
                reads.append(layer_read)
                by_id[layer_read.get("id")] = layer_read
            continue
        layers = layer_read.get("layers") or {}
        if not layers:
            continue
        target_layers = target.setdefault("layers", {})
        target_layers.update(layers)
        matched += 1
    return matched


def declared_bigbed_msp_paths(dataset) -> list[str]:
    """Return only explicitly registered MSP/FIRE BigBed paths."""
    companions = getattr(dataset, "companion_layers", {}) or {}
    paths: list[str] = []
    for layer_name in ("msp", "fire"):
        paths.extend(_as_path_list(companions.get(layer_name)))
    if str(getattr(dataset, "layer_type", "") or "").lower() in {"msp", "fire"}:
        paths.extend(_as_path_list(getattr(dataset, "paths", ()) or ()))

    unique: list[str] = []
    seen = set()
    for path in paths:
        if path in seen:
            continue
        unique.append(path)
        seen.add(path)
    return unique


def _has_msp_payload(reads: Iterable[dict]) -> bool:
    for read in reads:
        layers = read.get("layers") or {}
        for layer_name in ("msp", "fire"):
            if ((layers.get(layer_name) or {}).get("intervals") or []):
                return True
    return False


def layer_key_for_quality_filters(layer_key: LayerKey, quality_filters: Iterable[dict]) -> LayerKey:
    """Ensure quality-filtered layers are loaded without forcing all layers."""
    needed: set[str] = set()
    for filt in quality_filters or []:
        if filt.get("min_value", 0) <= 0:
            continue
        layer = str(filt.get("layer", "*") or "*")
        if layer == "*":
            return None
        needed.update(_expand_layer_aliases([layer]))

    if not needed:
        return layer_key
    if layer_key is None:
        return None
    if layer_key == ():
        return tuple(sorted(needed))
    return tuple(sorted(_expand_layer_aliases(layer_key) | needed))


def make_quality_key(quality_filters: Iterable[dict]) -> tuple:
    """Build the cache-key fragment for active quality filters."""
    return tuple(
        (
            f.get("layer", "*"),
            f.get("quality_name", ""),
            f.get("min_value", 0),
        )
        for f in quality_filters
    )


def _sampled_entry_with_reads(state, dataset, dataset_id, chrom, start, end, read_ids, include_methylation,
                              layer_key, now, *, include_layer_qualities, infer_legacy_layers, legacy_nuc_min_size,
                              min_footprints, terminal_bp):
    """The read display's sampled load of this view (services/read_sampling.py), when
    every read asked about is in its sample: an analysis of the reads a panel shows
    reuses what the display loaded instead of loading every read. (None, None) otherwise."""
    from services.read_sampling import sample_level
    from services.cluster_sample import assigned_cluster_scope
    level = sample_level(state, dataset, chrom, start, end)
    ids = {str(read_id) for read_id in read_ids}
    if not ids:
        return None, None
    token = read_load_token(state, chrom, terminal_bp, sample_level=level)
    base_token = read_load_token(state, chrom, terminal_bp)
    # The display's load may carry a Min footprints filter the analysis doesn't:
    # with every read asked about in it (checked below), any of them serves.
    cache_lock, _inflight = _broad_cache_sync(state)
    with cache_lock:
        # A follow-up on explicitly assigned fibers may reuse the early
        # clustering cohort too. Its fingerprint can never serve a full query.
        tokens = ([token] if level else []) + (list(dict.fromkeys(
            broad_cache_topology(k) for k in state._broad_cache
            if k and k[0] == dataset_id and len(broad_cache_topology(k)) >= 3
            and broad_cache_topology(k)[-3] == 'cluster_sample_v1'
            and broad_cache_topology(k)[:-3] == base_token)) if assigned_cluster_scope.get() else [])
        # Only floors at least as strict: a laxer load holds reads this analysis excludes.
        floors = [min_footprints] + sorted({broad_cache_min_footprints(k) for k in state._broad_cache
                                            if k and k[0] == dataset_id and broad_cache_min_footprints(k) > min_footprints})
    for token in tokens:
        for floor in floors:
            reads, key = find_broad_cache_entry(
                state, dataset_id, chrom, start, end, include_methylation, layer_key, now,
                include_layer_qualities=include_layer_qualities, infer_legacy_layers=infer_legacy_layers,
                legacy_nuc_min_size=legacy_nuc_min_size, min_footprints=floor, load_token=token,
            )
            if reads is None:
                continue
            have = set()
            exact_ids = len(token) >= 3 and token[-3] == 'cluster_sample_v1'
            names = reads.read_ids() if isinstance(reads, PackedReads) else (str(r.get("id", "")) for r in reads)
            for read_id in names:
                have.add(read_id)
                if not exact_ids:
                    have.add(re.sub(r"_\d+$", "", read_id))
            if ids <= have:
                return reads, key
    return None, None


sampled_entry_with_reads = _sampled_entry_with_reads


def make_working_cache_key(
    dataset_id: str,
    chrom: str,
    start: int,
    end: int,
    spanning: bool,
    min_footprints: int,
    max_working_reads: int,
    include_methylation: bool,
    layer_key: LayerKey,
    quality_filters: Iterable[dict],
    sample_seed: str = "",
    infer_legacy_layers: bool = True,
    legacy_nuc_min_size: int = 90,
    include_layer_qualities: bool = True,
    topology: Optional[tuple] = None,
) -> tuple:
    """Cache identity for viewport-adjusted working sets."""
    return (
        dataset_id,
        chrom,
        start,
        end,
        bool(spanning),
        int(min_footprints or 0),
        int(max_working_reads or 0),
        bool(include_methylation),
        layer_key,
        bool(include_layer_qualities),
        make_quality_key(quality_filters),
        normalize_sample_seed(sample_seed),
        bool(infer_legacy_layers),
        int(legacy_nuc_min_size or 90),
        topology,
    )


def find_broad_cache_entry(
    state,
    dataset_id,
    chrom,
    start,
    end,
    include_methylation,
    layer_key,
    now,
    *,
    include_layer_qualities: bool = True,
    infer_legacy_layers: bool = True,
    legacy_nuc_min_size: int = 90,
    min_footprints: int = 0,
    load_token: Optional[tuple] = None,
):
    ensure_broad_cache_schema(state)
    # Lookup, expiry and LRU updates share the per-state lock with stores and
    # invalidation: two requests pruning the same expired entry must not both
    # delete it. Re-entrant, so the singleflight caller (already holding it) is fine.
    cache_lock, _inflight = _broad_cache_sync(state)
    with cache_lock:
        return _find_broad_cache_entry_locked(
            state, dataset_id, chrom, start, end, include_methylation, layer_key, now,
            include_layer_qualities=include_layer_qualities,
            infer_legacy_layers=infer_legacy_layers,
            legacy_nuc_min_size=legacy_nuc_min_size,
            min_footprints=min_footprints,
            load_token=load_token,
        )


def _find_broad_cache_entry_locked(
    state,
    dataset_id,
    chrom,
    start,
    end,
    include_methylation,
    layer_key,
    now,
    *,
    include_layer_qualities: bool = True,
    infer_legacy_layers: bool = True,
    legacy_nuc_min_size: int = 90,
    min_footprints: int = 0,
    load_token: Optional[tuple] = None,
):
    all_reads = None
    broad_cache_key = None
    best_span = None
    timeout = getattr(state, "_broad_cache_timeout", 300)
    # Reads loaded while the contig had another topology are not these reads.
    topology = load_token if load_token is not None else read_load_token(state, chrom)

    for broad_key, (cached_reads, timestamp) in list(state._broad_cache.items()):
        ds_id, bc_chrom, bc_start, bc_end = broad_key[:4]
        bc_include_methylation = broad_key[4] if len(broad_key) > 4 else True
        bc_layer_key = broad_cache_layer_key(broad_key)
        bc_include_layer_qualities = True
        if len(broad_key) > 8:
            bc_include_layer_qualities = bool(broad_key[6])
        bc_infer_legacy_layers, bc_legacy_nuc_min_size = broad_cache_legacy_layer_settings(broad_key)
        bc_min_footprints = broad_cache_min_footprints(broad_key)
        if ds_id != dataset_id or bc_chrom != chrom:
            continue
        if broad_cache_topology(broad_key) != topology:
            continue
        if (
            bc_infer_legacy_layers != bool(infer_legacy_layers)
            or bc_legacy_nuc_min_size != int(legacy_nuc_min_size or 90)
            or bc_min_footprints != int(min_footprints or 0)
        ):
            continue
        if include_methylation and not bc_include_methylation:
            continue
        if include_layer_qualities and not bc_include_layer_qualities:
            continue
        if not layer_key_covers(bc_layer_key, layer_key):
            continue
        if timeout is not None and now - timestamp > timeout:
            state._broad_cache.pop(broad_key, None)
            continue
        if bc_start <= start and bc_end >= end:
            span = bc_end - bc_start
            if best_span is not None and span >= best_span:
                continue
            all_reads = cached_reads
            broad_cache_key = broad_key
            best_span = span

    if broad_cache_key is not None and broad_cache_key in state._broad_cache:
        state._broad_cache.move_to_end(broad_cache_key)

    return all_reads, broad_cache_key


_find_broad_cache_entry = find_broad_cache_entry


def _load_broad_reads(
    *,
    dataset,
    dataset_id: str,
    chrom: str,
    broad_start: int,
    broad_end: int,
    broad_width: int,
    include_methylation: bool,
    layer_key: LayerKey,
    include_layer_qualities: bool,
    build_bam_reads: Callable,
    build_bigbed_reads: Callable,
    load_bigbed_marks: Callable,
    infer_legacy_layers: bool = True,
    legacy_nuc_min_size: int = 90,
    min_footprints: int = 0,
    ml_threshold: int = 125,
    bam_read_options: Optional[dict] = None,
    bigbed_read_options: Optional[dict] = None,
    short_terminal_footprint_bp: Optional[int] = None,
    sample_level: int = 0,
) -> list[dict]:
    """Load reads with every layer source the dataset has (companions, derived
    sidecars, marks). ``bam_read_options`` / ``bigbed_read_options`` pass the
    direct path's extra display options (CIGAR, terminal gaps, duplicates,
    footprint quality) to the primary loads. ``short_terminal_footprint_bp``:
    the read-end footprint cutoff, captured once for the whole load (default:
    each loader's own)."""
    mark_mode = "with marks" if include_methylation else "intervals only"
    include_layers = layer_key_has_payload(layer_key)
    requested_layers = None if layer_key is None else layer_key
    layer_mode = (
        "with all layers"
        if layer_key is None
        else f"with layers={','.join(layer_key)}"
        if layer_key
        else "primary intervals"
    )
    log_working_set_diagnostic(
        f"  Broad cache MISS: {dataset_id} loading {chrom}:{broad_start}-{broad_end} "
        f"({broad_width}bp, {mark_mode}, {layer_mode})"
    )

    terminal_option = (
        {} if short_terminal_footprint_bp is None
        else {"short_terminal_footprint_bp": int(short_terminal_footprint_bp)}
    )
    if dataset.data_type == "bam_livelift":
        # Source records lifted onto this region, with an explicit sampler for
        # deep display views. Broad rows remain free of display/haplotype rules.
        from services.lift.reads import lifted_reads_for_region
        from services.read_sampling import SampledReads, Sampler
        from services.read_pins import current_pins
        pins = current_pins()
        sampler = Sampler(sample_level, keep_ids=set(pins) | {re.sub(r'_\d+$', '', p) for p in pins}) if sample_level else None
        rows = lifted_reads_for_region(dataset, chrom, broad_start, broad_end, dict(
            include_methylation=include_methylation, ml_threshold=ml_threshold, include_layers=include_layers,
            requested_layers=requested_layers, include_layer_qualities=include_layer_qualities,
            infer_legacy_layers=infer_legacy_layers, legacy_nuc_min_size=legacy_nuc_min_size,
            min_footprints=min_footprints, **terminal_option, **(bam_read_options or {})), sampler=sampler)
        if sampler is not None:
            # Explicit lift sampling records extents on the target, already
            # absolute; adding broad_start here would shift them a second time.
            rows = SampledReads(rows, level=sampler.level, estimated=True, skipped_starts=sampler.skipped_starts,
                                skipped_ends=sampler.skipped_ends, kept_starts=sampler.kept_starts,
                                kept_ends=sampler.kept_ends)
        return rows
    if dataset.data_type == "bam":
        from services.read_sampling import SampledReads, Sampler, sampling
        # A sampled display load parses only the reads whose name hash is in
        # the sample (services/read_sampling.py); the others leave their extent.
        from services.read_pins import current_pins
        pins = current_pins()
        keep_ids = set(pins) | {re.sub(r'_\d+$', '', pin) for pin in pins}
        from services.read_sampling import decode_read_scope
        scope = decode_read_scope.get()
        from services.cluster_sample import cluster_sample_scope
        cluster_sample = cluster_sample_scope.get()
        if cluster_sample is not None:
            scope = dict(only_ids=cluster_sample.names, exact_ids=True)
        sampler = Sampler(sample_level or 1, keep_ids=keep_ids, **(scope or {})) if sample_level or scope is not None else None
        derived_paths = _derived_layer_paths_for_request(dataset, layer_key) if include_layers else []
        # Only this source shape can retain packed blocks without a later
        # sidecar merge mutating the decoded read dictionaries.
        retain_blocks = (bounded_analysis.get() and sampler is None and len(dataset.paths) == 1
                         and not derived_paths)
        all_reads = []
        with sampling(sampler):
            options = dict(
                    include_methylation=include_methylation,
                    ml_threshold=ml_threshold,
                    include_layers=include_layers,
                    requested_layers=requested_layers,
                    include_layer_qualities=include_layer_qualities,
                    infer_legacy_layers=infer_legacy_layers,
                    legacy_nuc_min_size=legacy_nuc_min_size,
                    min_footprints=min_footprints,
                    **terminal_option,
                    **{"spanning_only": False, "min_fp_quality": 0, **(bam_read_options or {})},
            )
            load_many = getattr(build_bam_reads, 'load_many', None)
            pooled = (load_many(dataset.paths, chrom, broad_start, broad_end,
                                retain_packed=not derived_paths, **options)
                      if callable(load_many) and sampler is None else None)
            for bam_path in ([] if pooled is not None else dataset.paths):
                reads = build_bam_reads(bam_path, chrom, broad_start, broad_end, **options)
                if retain_blocks:
                    all_reads = reads
                else:
                    all_reads.extend(reads)
            if pooled is not None:
                all_reads = pooled
        if sampler is not None:
            all_reads = SampledReads(all_reads, level=sampler.level, skipped_starts=sampler.skipped_starts,
                                     skipped_ends=sampler.skipped_ends, kept_starts=sampler.kept_starts,
                                     kept_ends=sampler.kept_ends)
            log_working_set_diagnostic(
                f"  Sampled load: kept {len(all_reads)} reads, skipped {len(sampler.skipped_starts)} "
                f"(level {sampler.level})"
            )
        if derived_paths:
            layer_reads = build_bigbed_reads(
                derived_paths,
                chrom,
                broad_start,
                broad_end,
                spanning_only=False,
                include_methylation=False,
                ml_threshold=125,
                include_layers=True,
                requested_layers=requested_layers,
                include_layer_qualities=include_layer_qualities,
                infer_legacy_layers=infer_legacy_layers,
                legacy_nuc_min_size=legacy_nuc_min_size,
                # Sidecar rows hold extra layers, not the read's own calls.
                short_terminal_footprint_bp=0,
            )
            matched = _merge_layer_reads_into_reads(all_reads, layer_reads)
            if matched:
                log_working_set_diagnostic(
                    f"  Derived layers: matched {matched}/{len(layer_reads)} sidecar rows "
                    f"from {len(derived_paths)} bundle(s)"
                )
        return all_reads

    from services.signal_evidence import signal_keeps
    if not signal_keeps(None):
        return []
    companion_types = {"footprint", "tf", "msp", "fire"}
    if layer_key is not None:
        requested_set = set(layer_key)
        companion_types = {
            layer
            for layer in companion_types
            if (
                layer in requested_set
                or (layer == "footprint" and "nuc" in requested_set)
                or (layer == "msp" and "fire" in requested_set)
                or (layer == "fire" and "msp" in requested_set)
            )
        }
    # companion_layers maps a layer type -> list of files (one per merged sample).
    # Tolerate the legacy single-string shape from older saved sessions.
    companion_path_set = {
        p for paths in dataset.companion_layers.values() for p in _as_path_list(paths)
    }
    primary_paths = [
        path for path in dataset.paths
        if path not in companion_path_set
    ] or list(dataset.paths)
    layer_companion_paths = [
        p
        for ctype, paths in dataset.companion_layers.items()
        if ctype in companion_types
        for p in _as_path_list(paths)
    ] if include_layers else []
    if include_layers:
        layer_companion_paths.extend(_derived_layer_paths_for_request(dataset, layer_key))
    paths_to_load = []
    seen_paths = set()
    for path in list(primary_paths) + layer_companion_paths:
        if path in seen_paths:
            continue
        paths_to_load.append(path)
        seen_paths.add(path)
    all_reads = build_bigbed_reads(
        paths_to_load,
        chrom,
        broad_start,
        broad_end,
        include_methylation=False,
        ml_threshold=ml_threshold,
        include_layers=include_layers,
        requested_layers=requested_layers,
        include_layer_qualities=include_layer_qualities,
        infer_legacy_layers=infer_legacy_layers,
        legacy_nuc_min_size=legacy_nuc_min_size,
        min_footprints=min_footprints,
        **terminal_option,
        **{"spanning_only": False, **(bigbed_read_options or {})},
    )

    # A combined footprint + TF + MSP load should contain the explicitly
    # requested accessibility layer. Some heterogeneous/merged BigBed groups
    # can nevertheless return TF rows while dropping all MSP rows during the
    # multi-file merge. Probe only the declared MSP/FIRE sidecars in isolation
    # and hydrate them by molecule id. This is an integrity recovery, not
    # legacy gap inference, and also fixes FIRE rendering outside analysis.
    declared_msp_paths = declared_bigbed_msp_paths(dataset)
    if (
        include_layers
        and layer_key_includes(layer_key, "msp", "fire")
        and declared_msp_paths
        and not _has_msp_payload(all_reads)
    ):
        recovered_reads = build_bigbed_reads(
            declared_msp_paths,
            chrom,
            broad_start,
            broad_end,
            spanning_only=False,
            include_methylation=False,
            ml_threshold=125,
            hide_terminal_gaps=False,
            terminal_gap_threshold=0,
            include_layers=True,
            requested_layers=("msp", "fire"),
            include_layer_qualities=include_layer_qualities,
            infer_legacy_layers=False,
            legacy_nuc_min_size=legacy_nuc_min_size,
            min_footprints=0,
        )
        before_count = len(all_reads)
        matched = _merge_layer_reads_into_reads(
            all_reads,
            recovered_reads,
            append_unmatched=True,
        )
        recovered_calls = sum(
            len(((read.get("layers") or {}).get("msp") or {}).get("intervals") or [])
            + len(((read.get("layers") or {}).get("fire") or {}).get("intervals") or [])
            for read in recovered_reads
        )
        log_working_set_diagnostic(
            f"  MSP integrity recovery: checked {len(declared_msp_paths)} declared "
            f"sidecar(s), loaded {len(recovered_reads)} reads/{recovered_calls} spans, "
            f"matched {matched}, appended {len(all_reads) - before_count}"
        )

    # DddA mCG spans (ddda_mcg) live in the m5c BigBed next to native 5mC
    # calls; load them as a layer when asked for (the m5c marks themselves
    # come with the other marks below).
    m5c_span_paths = [p for p in _as_path_list(dataset.companion_layers.get("m5c")) if p not in seen_paths]
    if (
        include_layers
        and m5c_span_paths
        and (getattr(dataset, "available_layers", None) or {}).get("ddda_mcg")
        and layer_key_includes(layer_key, "ddda_mcg")
    ):
        span_reads = build_bigbed_reads(
            m5c_span_paths,
            chrom,
            broad_start,
            broad_end,
            spanning_only=False,
            include_methylation=False,
            ml_threshold=125,
            hide_terminal_gaps=False,
            terminal_gap_threshold=0,
            include_layers=True,
            requested_layers=("ddda_mcg",),
            include_layer_qualities=False,
            infer_legacy_layers=False,
            legacy_nuc_min_size=legacy_nuc_min_size,
            min_footprints=0,
        )
        span_reads = [
            {"id": read.get("id"), "layers": {"ddda_mcg": read["layers"]["ddda_mcg"]}}
            for read in span_reads
            if (read.get("layers") or {}).get("ddda_mcg")
        ]
        matched = _merge_layer_reads_into_reads(all_reads, span_reads)
        log_working_set_diagnostic(
            f"  ddda_mcg spans: {len(span_reads)} reads from {len(m5c_span_paths)} m5c file(s), matched {matched}"
        )

    if not include_methylation:
        return all_reads

    companion_plan = [
        ("m6a", "methyl_m6a", _as_path_list(dataset.companion_layers.get("m6a") or dataset.companion_layers.get("mod"))),
        ("m5c", "methyl_m5c", _as_path_list(dataset.companion_layers.get("m5c"))),
        ("deam", "deam", _as_path_list(dataset.companion_layers.get("deam"))),
    ]
    # Reads of a multi-sample merge carry their sample (``bigbed_sample``); a
    # mark file goes to the reads of its own sample, so two samples' molecules
    # that share a read name keep their own marks.
    from services.compact_read_loader import bigbed_sample_key
    reads_by_id: dict[str, list[dict]] = {}
    for read in all_reads:
        reads_by_id.setdefault(read["id"], []).append(read)
    for comp_type, read_field, comp_paths in companion_plan:
        for comp_path in comp_paths:
            marks = load_bigbed_marks(comp_path, chrom, broad_start, broad_end, layer_type=comp_type)
            if not marks:
                continue
            comp_sample = bigbed_sample_key(comp_path)
            matched = 0
            for read_id, data in marks.items():
                if not data:
                    continue
                for read in companion_mark_targets(reads_by_id.get(read_id) or [], comp_sample):
                    read[read_field] = data
                    matched += 1
            if matched:
                log_working_set_diagnostic(
                    f"  Companion {comp_type}: matched {matched}/{len(marks)} reads "
                    f"from {os.path.basename(comp_path)}"
                )

    for read in all_reads:
        if read.get("methyl_m6a"):
            read["methyl"] = read["methyl_m6a"]
        elif read.get("methyl_m5c"):
            read["methyl"] = read["methyl_m5c"]
        elif read.get("deam"):
            read["methyl"] = [e[0] for e in read["deam"]]

    return all_reads


def companion_mark_targets(candidates: list[dict], comp_sample: str) -> list[dict]:
    """The reads a companion mark file's record for one read name belongs to.

    Unmerged or single-sample reads carry no sample: the name alone decides.
    Otherwise the reads of the file's own sample; failing that (a file named
    for no loaded sample), the one read of that name, if only one exists.
    """
    if not any(read.get("bigbed_sample") for read in candidates):
        return candidates
    own = [read for read in candidates if read.get("bigbed_sample") == comp_sample]
    if own:
        return own
    return candidates if len(candidates) == 1 else []


def _load_and_cache_broad_reads_singleflight(
    state,
    *,
    dataset,
    dataset_id: str,
    chrom: str,
    viewport_start: int,
    viewport_end: int,
    broad_start: int,
    broad_end: int,
    broad_width: int,
    include_methylation: bool,
    layer_key: LayerKey,
    include_layer_qualities: bool,
    build_bam_reads: Callable,
    build_bigbed_reads: Callable,
    load_bigbed_marks: Callable,
    infer_legacy_layers: bool,
    legacy_nuc_min_size: int,
    min_footprints: int,
    short_terminal_footprint_bp: Optional[int] = None,
    sample_level: int = 0,
) -> tuple[list[dict], tuple]:
    """Load one broad-cache miss while identical concurrent callers wait.

    ``sample_level``: a sampled display load (services/read_sampling.py); its
    level is part of the load token, so it never serves (or is served by) a
    load of every read.

    The event is scoped to the exact broad decode, while the cache recheck also
    accepts any compatible covering entry completed by another request.
    """
    # One read-end cutoff for the key, the lookup and every file of the load.
    if short_terminal_footprint_bp is None:
        from services.compact_read_loader import short_terminal_footprint_bp_for
        short_terminal_footprint_bp = short_terminal_footprint_bp_for(state)
    load_token = read_load_token(state, chrom, short_terminal_footprint_bp, sample_level=sample_level)
    exact_key = (
        dataset_id,
        chrom,
        broad_start,
        broad_end,
        bool(include_methylation),
        layer_key,
        bool(include_layer_qualities),
        bool(infer_legacy_layers),
        int(legacy_nuc_min_size or 90),
        int(min_footprints or 0),
        # Taken before the load: a topology (or read-end footprint setting)
        # change during it leaves an entry consistent with what it was loaded under.
        load_token,
    )
    cache_lock, inflight = _broad_cache_sync(state)
    # The ID's current source: waiters on a load for an older source don't share it.
    generation = dataset_generation(state, dataset_id)
    from services.read_stream import is_prefetch
    # A foreground request must never wait for a speculative worker that is
    # paused to give that very request priority. Completed entries are shared.
    inflight_key = exact_key + (("generation", generation), ("prefetch", is_prefetch()))

    from services.background_work import checkpoint
    while True:
        checkpoint()
        with cache_lock:
            cached_reads, cached_key = find_broad_cache_entry(
                state,
                dataset_id,
                chrom,
                viewport_start,
                viewport_end,
                include_methylation,
                layer_key,
                time.time(),
                include_layer_qualities=include_layer_qualities,
                infer_legacy_layers=infer_legacy_layers,
                legacy_nuc_min_size=legacy_nuc_min_size,
                min_footprints=min_footprints,
                load_token=load_token,
            )
            if cached_reads is not None and cached_key is not None:
                return cached_reads, cached_key

            event = inflight.get(inflight_key)
            owner = event is None
            if owner:
                event = threading.Event()
                inflight[inflight_key] = event

        if not owner:
            # A background job whose clients left stops waiting too (services/background_work.py).
            while not event.wait(0.25):
                checkpoint()
            continue

        try:
            loaded_reads = _load_broad_reads(
                dataset=dataset,
                dataset_id=dataset_id,
                chrom=chrom,
                broad_start=broad_start,
                broad_end=broad_end,
                broad_width=broad_width,
                include_methylation=include_methylation,
                layer_key=layer_key,
                include_layer_qualities=include_layer_qualities,
                build_bam_reads=build_bam_reads,
                build_bigbed_reads=build_bigbed_reads,
                load_bigbed_marks=load_bigbed_marks,
                infer_legacy_layers=infer_legacy_layers,
                legacy_nuc_min_size=legacy_nuc_min_size,
                min_footprints=min_footprints,
                short_terminal_footprint_bp=short_terminal_footprint_bp,
                sample_level=sample_level,
            )
            retained = _store_broad_cache_entry(state, exact_key, loaded_reads, generation)
            log_working_set_diagnostic(
                f"  Broad cache stored: {dataset_id} {len(loaded_reads)} reads"
            )
            return retained if retained is not None else loaded_reads, exact_key
        finally:
            with cache_lock:
                if inflight.pop(inflight_key, None) is event:
                    event.set()


def geometry_filter(layer_key: LayerKey):
    """Which geometry groups of a cached read (packed_reads.read_geometry_groups) a request with ``layer_key``
    shows: its own intervals always, FIRE calls and each layer as the projection keeps them. None: all."""
    if layer_key is None:
        return None

    def include(name: str) -> bool:
        if name in ('intervals', 'live_lift'):
            return True
        if name == 'fire':
            return layer_key_includes(layer_key, 'fire', 'msp')
        return layer_key_has_payload(layer_key) and layer_key_includes(layer_key, name)
    return include


def _read_viewport_bounds(read: dict, viewport_offset: int, region_width: int,
                          layer_key: LayerKey = None) -> Optional[tuple[int, int, bool]]:
    # An offscreen call beyond a deletion or a distant layer must not extend
    # this view's read across an empty edge. Count the same geometry a cold,
    # viewport-sized load would retain: only the layers this request shows (a
    # broad load cached for more layers is reused for fewer).
    absolute_bounds = compact_read_bounds(read, viewport_offset, viewport_offset + region_width,
                                          include=geometry_filter(layer_key))
    if absolute_bounds is None:
        return None

    read_start = absolute_bounds[0] - viewport_offset
    read_end = absolute_bounds[1] - viewport_offset
    if read_end <= 0 or read_start >= region_width:
        return None

    spanning = read_start <= 0 and read_end >= region_width
    if read.get("live_lift"):
        from services.lift.reads import body_spans_view
        spanning = body_spans_view(read["live_lift"], viewport_offset, viewport_offset + region_width)
    return read_start, read_end, spanning


def _absolute_read_bounds(read: dict) -> Optional[tuple[int, int]]:
    return compact_read_bounds(read)


def _broad_read_signature(all_reads: list[dict]) -> tuple:
    if not all_reads:
        return (0, None, None, None, None)
    first = all_reads[0]
    last = all_reads[-1]
    return (
        len(all_reads),
        first.get("id"),
        _absolute_read_bounds(first),
        last.get("id"),
        _absolute_read_bounds(last),
    )


def _get_broad_read_index(state, all_reads: list[dict]):
    """Return an LRU-cached read-bounds index for a broad-cache read list."""
    cache = getattr(state, "_broad_read_index_cache", None)
    if cache is None:
        cache = OrderedDict()
        state._broad_read_index_cache = cache

    cache_key = id(all_reads)
    signature = _broad_read_signature(all_reads)
    cached = cache.get(cache_key)
    if cached and cached[0] == signature:
        cache.move_to_end(cache_key)
        return cached[1]

    bounds: dict[int, tuple[int, int]] = {}
    start_items: list[tuple[int, int]] = []
    end_items: list[tuple[int, int]] = []
    for idx, read in enumerate(all_reads):
        read_bounds = _absolute_read_bounds(read)
        if read_bounds is None:
            continue
        read_start, read_end = read_bounds
        bounds[idx] = read_bounds
        start_items.append((read_start, idx))
        end_items.append((read_end, idx))

    start_items.sort()
    end_items.sort()
    index = (
        bounds,
        tuple(item[0] for item in start_items),
        tuple(item[1] for item in start_items),
        tuple(item[0] for item in end_items),
        tuple(item[1] for item in end_items),
    )
    cache[cache_key] = (signature, index)
    cache.move_to_end(cache_key)

    max_entries = max(8, int(getattr(state, "_broad_cache_max", 20) or 20) * 2)
    while not isinstance(cache, ByteCache) and len(cache) > max_entries:
        cache.popitem(last=False)
    return index


def iter_broad_read_overlaps(state, all_reads: list[dict], start: int, end: int):
    """Yield indexed broad-cache reads with cached bounds overlapping a viewport."""
    if isinstance(all_reads, PackedReads):
        yield from all_reads.overlapping(start, end)
        return
    if not all_reads:
        return

    bounds, start_values, start_order, end_values, end_order = _get_broad_read_index(state, all_reads)
    valid_count = len(start_order)
    if valid_count == 0:
        return

    start_cut = bisect_left(start_values, end)
    end_cut = bisect_right(end_values, start)
    candidate_indices = []
    if start_cut <= valid_count - end_cut:
        for pos in range(start_cut):
            idx = start_order[pos]
            read_start, read_end = bounds[idx]
            if read_end > start:
                candidate_indices.append((idx, read_start, read_end))
    else:
        for pos in range(end_cut, valid_count):
            idx = end_order[pos]
            read_start, read_end = bounds[idx]
            if read_start < end:
                candidate_indices.append((idx, read_start, read_end))

    for idx, read_start, read_end in sorted(candidate_indices):
        yield idx, all_reads[idx], read_start, read_end


def iter_broad_reads_overlapping_viewport(state, all_reads: list[dict], start: int, end: int):
    """Yield broad-cache reads whose cache-relative read span overlaps a viewport."""
    for _idx, read, _read_start, _read_end in iter_broad_read_overlaps(state, all_reads, start, end):
        yield read


def _clip_interval_to_viewport(interval, viewport_offset: int, region_width: int, *, call=None):
    """Project one absolute interval and keep only the visible span."""
    if len(interval) < 2:
        return None
    start = interval[0] - viewport_offset
    end = interval[1] - viewport_offset
    if start == end and call is not None:
        from services.lift.reads import keep_interval
        if keep_interval(interval, viewport_offset, region_width, call):
            return start, end, interval[2] if len(interval) > 2 else 0
    if end <= 0 or start >= region_width:
        return None
    clipped_start = max(0, start)
    clipped_end = min(region_width, end)
    if clipped_end <= clipped_start:
        return None
    size = interval[2] if len(interval) > 2 else interval[1] - interval[0]
    return clipped_start, clipped_end, size


def _get_interval_index(container: dict):
    intervals = container.get("intervals") or []
    cached = container.get("_fiberbrowser_interval_index")
    cache_key = (id(intervals), len(intervals))
    if cached and len(cached) == 5 and cached[0] == cache_key:
        return intervals, cached[1], cached[2], cached[3], cached[4]

    starts = []
    ends = []
    positive_prefix = [0]
    positive_count = 0
    for interval in intervals:
        if len(interval) >= 2:
            starts.append(interval[0])
            ends.append(interval[1])
        else:
            starts.append(0)
            ends.append(0)
        if len(interval) > 2 and interval[2] > 0:
            positive_count += 1
        positive_prefix.append(positive_count)

    ordered = all(starts[i - 1] <= starts[i] and ends[i - 1] <= ends[i] for i in range(1, len(starts)))
    index = (tuple(starts), tuple(ends), tuple(positive_prefix), ordered)
    container["_fiberbrowser_interval_index"] = (cache_key, *index)
    return intervals, index[0], index[1], index[2], index[3]


def _visible_interval_range(container: dict, view_start: int, view_end: int):
    intervals, starts, ends, positive_prefix, ordered = _get_interval_index(container)
    if not intervals:
        return intervals, range(0), positive_prefix
    if not ordered:
        # Legacy molecular-frame MSPs can arrive in reverse genomic order;
        # overlapping/nested annotations also need their original row order.
        return intervals, [i for i in range(len(intervals)) if ends[i] > view_start and starts[i] < view_end], positive_prefix
    lo = bisect_right(ends, view_start)
    hi = bisect_left(starts, view_end, lo)
    return intervals, range(lo, hi), positive_prefix


def _project_primary_intervals(read: dict, viewport_offset: int, region_width: int, *, index_intervals=True):
    adjusted_intervals = []
    adjusted_qualities = []
    qualities = read.get("qualities")
    view_start = viewport_offset
    view_end = viewport_offset + region_width
    calls = ((read.get("live_lift") or {}).get("calls") or {}).get("intervals") or ()
    if index_intervals and not calls:
        intervals, visible_range, positive_prefix = _visible_interval_range(read, view_start, view_end)
    else:
        intervals = read.get("intervals") or []
        visible_range, positive_prefix = range(len(intervals)), None
    positive_count = 0

    for idx in visible_range:
        interval = intervals[idx]
        if len(interval) < 2:
            continue
        is_positive = len(interval) > 2 and interval[2] > 0
        positive_index = positive_prefix[idx] if positive_prefix is not None else positive_count
        if is_positive:
            positive_count += 1
        rel_start = interval[0] - viewport_offset
        rel_end = interval[1] - viewport_offset
        clipped_start = 0 if rel_start < 0 else rel_start
        clipped_end = region_width if rel_end > region_width else rel_end
        if clipped_end <= clipped_start:
            from services.lift.reads import keep_interval
            if not keep_interval(interval, viewport_offset, region_width, calls[idx] if idx < len(calls) else None):
                continue
        size = interval[2] if len(interval) > 2 else interval[1] - interval[0]
        adjusted_intervals.append((clipped_start, clipped_end, size))
        if is_positive and qualities is not None and positive_index < len(qualities):
            adjusted_qualities.append(qualities[positive_index])

    return tuple(adjusted_intervals), adjusted_qualities if qualities is not None else None


def _project_positions(positions, viewport_offset: int, region_width: int) -> list[int]:
    adjusted = []
    for pos in positions or []:
        rel = pos - viewport_offset
        if 0 <= rel < region_width:  # half-open: the base at `end` is outside
            adjusted.append(rel)
    return adjusted


def _project_deam_events(events, viewport_offset: int, region_width: int) -> list[list[int]]:
    adjusted = []
    for event in events or []:
        if not event:
            continue
        rel = event[0] - viewport_offset
        if 0 <= rel < region_width:  # half-open: the base at `end` is outside
            adjusted.append([rel, event[1] if len(event) > 1 else 0])
    return adjusted


def _project_layer_intervals(
    layer: dict,
    viewport_offset: int,
    region_width: int,
    *,
    include_qualities: bool = True,
    index_intervals: bool = True,
    calls=(),
) -> Optional[dict]:
    intervals = layer.get("intervals") or []
    adjusted_intervals = []
    kept_indices = []
    view_start = viewport_offset
    view_end = viewport_offset + region_width
    if index_intervals and not calls:
        intervals, visible_range, _positive_prefix = _visible_interval_range(layer, view_start, view_end)
    else:
        visible_range = range(len(intervals))
    for idx in visible_range:
        interval = intervals[idx]
        if len(interval) < 2:
            continue
        rel_start = interval[0] - viewport_offset
        rel_end = interval[1] - viewport_offset
        clipped_start = 0 if rel_start < 0 else rel_start
        clipped_end = region_width if rel_end > region_width else rel_end
        if clipped_end <= clipped_start:
            from services.lift.reads import keep_interval
            if not keep_interval(interval, viewport_offset, region_width, calls[idx] if idx < len(calls) else None):
                continue
        size = interval[2] if len(interval) > 2 else interval[1] - interval[0]
        adjusted_intervals.append([clipped_start, clipped_end, size])
        kept_indices.append(idx)

    if not adjusted_intervals:
        return None

    adjusted_layer = {"intervals": adjusted_intervals}
    source_intervals = layer.get("source_intervals")
    if source_intervals is not None:
        adjusted_layer["source_intervals"] = [
            [
                int(source_intervals[idx][0]) - viewport_offset,
                int(source_intervals[idx][1]) - viewport_offset,
                (
                    int(source_intervals[idx][2])
                    if len(source_intervals[idx]) > 2
                    else int(source_intervals[idx][1]) - int(source_intervals[idx][0])
                ),
            ]
            if idx < len(source_intervals)
            else list(adjusted_intervals[position])
            for position, idx in enumerate(kept_indices)
        ]
    qualities = layer.get("qualities")
    if include_qualities and qualities is not None:
        adjusted_layer["qualities"] = [
            # Malformed short AQ tracks fail closed at the missing interval
            # instead of compressing later values onto the wrong calls.
            [track[idx] if idx < len(track) else 0 for idx in kept_indices]
            for track in qualities
        ]
    if include_qualities and layer.get("quality_names") is not None:
        adjusted_layer["quality_names"] = layer.get("quality_names")
    for meta_key in ("annotation_names", "circular_ids"):
        meta_values = layer.get(meta_key)
        if meta_values:
            projected_values = [
                str(meta_values[idx]) if idx < len(meta_values) else ""
                for idx in kept_indices
            ]
            if any(projected_values):
                adjusted_layer[meta_key] = projected_values
    return adjusted_layer


def _positive_primary_interval_payload(adjusted_intervals) -> list[list[int]]:
    return [
        [int(start), int(end), int(size)]
        for start, end, size in adjusted_intervals
        if size > 0
    ]


def project_broad_read_to_viewport(
    read: dict,
    *,
    viewport_offset: int,
    region_width: int,
    include_methylation: bool,
    layer_key: LayerKey,
    include_layer_qualities: bool = True,
    index_intervals: bool = True,
) -> tuple[Optional[dict], bool]:
    """Project a broad-cache read into viewport-relative compact coordinates."""
    from services.background_work import checkpoint
    checkpoint()
    bounds = _read_viewport_bounds(read, viewport_offset, region_width, layer_key)
    if bounds is None:
        return None, False
    _read_start, _read_end, is_spanning = bounds
    adjusted_intervals, adjusted_qualities = _project_primary_intervals(
        read, viewport_offset, region_width, index_intervals=index_intervals)

    adjusted_read = {"id": read["id"], "intervals": adjusted_intervals}
    # These identify the source alignment, not viewport-relative geometry.
    # Keep them unchanged so consensus overlays cannot cross-project between
    # same-QNAME records after a broad-cache read is cropped.
    for identity_key in (
        "library_id", "source_path", "record_sha256", "alignment_occurrence",
        "reference_start", "reference_end", "alignment_orientation",
        "chemical_strand", "daf_strand", "strand", "_original_id",
        "alignment_spans", "signal",
        # st/SEQ strand disagreement and graph-lift provenance (record-level).
        "strand_conflict", "lift",
        # SV events are in absolute reference coordinates: never shifted.
        "sv",
    ):
        if identity_key in read:
            adjusted_read[identity_key] = read[identity_key]
    if include_methylation and read.get("methyl"):
        adjusted_read["methyl"] = _project_positions(read["methyl"], viewport_offset, region_width)
    if include_methylation and read.get("methyl_m6a"):
        adjusted_read["methyl_m6a"] = _project_positions(read["methyl_m6a"], viewport_offset, region_width)
    if include_methylation and read.get("methyl_m5c"):
        adjusted_read["methyl_m5c"] = _project_positions(read["methyl_m5c"], viewport_offset, region_width)
    if include_methylation and read.get("deam"):
        adjusted_read["deam"] = _project_deam_events(read["deam"], viewport_offset, region_width)
    if include_methylation and read.get("possible_deam_ct"):
        adjusted_read["possible_deam_ct"] = _project_positions(
            read["possible_deam_ct"], viewport_offset, region_width
        )
    if include_methylation and read.get("possible_deam_ga"):
        adjusted_read["possible_deam_ga"] = _project_positions(
            read["possible_deam_ga"], viewport_offset, region_width
        )
    if adjusted_qualities:
        adjusted_read["qualities"] = adjusted_qualities
    if layer_key_includes(layer_key, "fire", "msp") and read.get("fire"):
        adjusted_fire = []
        calls = ((read.get("live_lift") or {}).get("calls") or {}).get("fire") or ()
        for i, iv in enumerate(read["fire"]):
            clipped = _clip_interval_to_viewport(iv, viewport_offset, region_width,
                                                 call=calls[i] if i < len(calls) else None)
            if clipped is not None:
                adjusted_fire.append([clipped[0], clipped[1], clipped[2]])
        if adjusted_fire:
            adjusted_read["fire"] = adjusted_fire
    if layer_key_has_payload(layer_key) and read.get("layers"):
        adjusted_layers = {}
        derived_layers = []
        positive_primary_intervals = None
        for layer_name, layer in read["layers"].items():
            if not layer_key_includes(layer_key, layer_name):
                continue
            if layer_name == "nuc" and not read.get("live_lift") and not include_layer_qualities and nuc_layer_duplicates_primary(read):
                derived_layers.append("nuc")
                continue
            adjusted_layer = _project_layer_intervals(
                layer,
                viewport_offset,
                region_width,
                include_qualities=include_layer_qualities,
                index_intervals=index_intervals,
                calls=(((read.get("live_lift") or {}).get("calls") or {}).get(f"layer:{layer_name}") or ()),
            )
            if adjusted_layer is not None:
                if layer_name == "nuc" and not read.get("live_lift") and not include_layer_qualities:
                    if positive_primary_intervals is None:
                        positive_primary_intervals = _positive_primary_interval_payload(adjusted_intervals)
                    if adjusted_layer.get("intervals") == positive_primary_intervals:
                        derived_layers.append("nuc")
                        continue
                adjusted_layers[layer_name] = adjusted_layer
        if adjusted_layers:
            adjusted_read["layers"] = adjusted_layers
        if derived_layers:
            adjusted_read["derived_layers"] = derived_layers

    if not adjusted_intervals:
        # Explicit named layers can legitimately extend outside the visible
        # legacy ns/nl footprint envelope (for example a rescued tf_sr call at
        # an amplicon edge). Keep a neutral row spanning the visible explicit
        # annotations instead of dropping the read and its MA/AQ evidence.
        visible_annotations = list(adjusted_read.get("fire") or [])
        for layer in (adjusted_read.get("layers") or {}).values():
            visible_annotations.extend(layer.get("intervals") or [])
        # A live-lift row seen only through a body segment or a badge is still drawn.
        from services.lift.reads import clip_geometry
        geometry = clip_geometry(read.get("live_lift") or {}, viewport_offset, region_width)
        visible_annotations.extend([s[0], s[1]] for s in geometry.get("segments") or ())
        visible_annotations.extend([b[0], b[0]] for b in geometry.get("badges") or ())
        if not visible_annotations:
            return None, False
        neutral_start = min(int(iv[0]) for iv in visible_annotations)
        neutral_end = max(int(iv[1]) for iv in visible_annotations)
        adjusted_read["intervals"] = [[neutral_start, neutral_end, 0]]

    if "live_lift" in read:
        # Crop parallel provenance only after FIRE, layers and the neutral
        # geometry exist, otherwise their call identities are silently lost.
        from services.lift.reads import crop_live_lift
        crop_live_lift(read, adjusted_read, viewport_offset, region_width)
    return adjusted_read, is_spanning


def _viewport_reads_from_broad(
    *,
    state,
    all_reads: list[dict],
    dataset,
    region_width: int,
    bc_start: int,
    start: int,
    end: int,
    spanning: bool,
    min_footprints: int,
    read_ids: Optional[list],
    include_methylation: bool,
    layer_key: LayerKey,
    include_layer_qualities: bool = True,
    quality_filters: Optional[Iterable[dict]] = None,
    bc_end: Optional[int] = None,
    row_filter: Optional[Callable] = None,
) -> tuple[list[dict], int, int]:
    """``row_filter``: rows that never enter the working set (a lifted display's
    haplotype and display settings), applied before every count, filter and cap."""
    viewport_offset = start - bc_start
    viewport_reads = PackedReadBuilder() if bounded_analysis.get() else []
    total_overlapping = 0
    total_spanning = 0
    read_id_set = set(read_ids) if read_ids is not None and not isinstance(read_ids, set) else read_ids
    quality_filters = list(
        active_quality_filters(state)
        if quality_filters is None
        else quality_filters
    )
    early_read_id_filter = read_id_set is not None and not quality_filters
    # A cold viewport load is already restricted to this exact region. The
    # projection below checks its geometry; building a second whole-cohort
    # spatial index here only repeats that work. Build the index lazily when
    # a later viewport actually needs a subset of the cached region.
    exact_view = bc_start == start and bc_end == end
    # Packed blocks release expanded rows after this pass. Per-row interval
    # indexes would be built once and thrown away without ever being reused.
    index_intervals = not exact_view and not isinstance(all_reads, PackedReads)
    candidates = all_reads if exact_view else iter_broad_reads_overlapping_viewport(
        state, all_reads, viewport_offset, viewport_offset + region_width,
    )
    from services.scoped_read_analysis import selected_analysis
    if selected_analysis.get() and read_id_set is not None:
        from services.packed_reads import select_read_ids
        candidates = select_read_ids(all_reads, read_id_set, aliases=True)
    for read in candidates:
        if row_filter is not None and not row_filter(read):
            continue
        if early_read_id_filter:
            bounds = _read_viewport_bounds(read, viewport_offset, region_width, layer_key)
            if bounds is None:
                continue
            _read_start, _read_end, is_spanning = bounds
            total_overlapping += 1
            if is_spanning:
                total_spanning += 1
            if spanning and not is_spanning:
                continue
            if not read_matches_id_filter(str(read.get("id", "")), read_id_set):
                continue
            adjusted_read, _ = project_broad_read_to_viewport(
                read,
                viewport_offset=viewport_offset,
                region_width=region_width,
                include_methylation=include_methylation,
                layer_key=layer_key,
                include_layer_qualities=include_layer_qualities,
                index_intervals=index_intervals,
            )
            if adjusted_read is not None:
                viewport_reads.append(adjusted_read)
            continue

        adjusted_read, is_spanning = project_broad_read_to_viewport(
            read,
            viewport_offset=viewport_offset,
            region_width=region_width,
            include_methylation=include_methylation,
            layer_key=layer_key,
            include_layer_qualities=include_layer_qualities,
            index_intervals=index_intervals,
        )
        if adjusted_read is None:
            continue

        if quality_filters and "layers" in adjusted_read:
            if (
                quality_filters == list(getattr(state, "quality_filters", None) or [])
                and hasattr(state, "_apply_quality_filters")
            ):
                adjusted_read = state._apply_quality_filters(adjusted_read)
            else:
                adjusted_read = apply_quality_filters(adjusted_read, quality_filters)
            if adjusted_read is None:
                continue

        total_overlapping += 1
        if is_spanning:
            total_spanning += 1
        if spanning and not is_spanning:
            continue

        if read_ids is None or read_matches_id_filter(str(adjusted_read.get("id", "")), read_id_set):
            viewport_reads.append(adjusted_read)

    if isinstance(viewport_reads, PackedReadBuilder):
        viewport_reads = viewport_reads.finish()

    return viewport_reads, total_overlapping, total_spanning


def _candidate_coverage_from_bounds(read_start: int, read_end: int, region_width: int) -> float:
    overlap_start = max(read_start, 0)
    overlap_end = min(read_end, region_width)
    if overlap_end <= overlap_start or region_width <= 0:
        return 0.0
    return (overlap_end - overlap_start) / region_width


def _coverage_sample_candidates(candidates: list[tuple[float, int, dict, bool]], max_reads: int):
    if max_reads <= 0:
        return candidates
    if len(candidates) <= max_reads:
        return candidates
    return heapq.nlargest(max_reads, candidates, key=lambda item: item[0])


def _with_pinned_candidates(selected, candidates):
    """The display selection plus the request's pinned reads (services/read_pins.py)."""
    from services.read_pins import compact_read_id, with_pinned
    return with_pinned(selected, candidates, lambda item: compact_read_id(item[2]))


def build_sampled_display_working_set(
    state,
    dataset_id: str,
    chrom: str,
    start: int,
    end: int,
    *,
    max_reads: int,
    spanning: bool = False,
    min_footprints: int = 0,
    include_methylation: bool = True,
    include_layers: bool = True,
    requested_layers: Optional[Iterable[str] | str] = None,
    include_layer_qualities: bool = True,
    build_bam_reads: Callable,
    build_bigbed_reads: Callable,
    load_bigbed_marks: Callable,
    infer_legacy_layers: Optional[bool] = None,
    legacy_nuc_min_size: Optional[int] = None,
    quality_filters: Optional[Iterable[dict]] = None,
    profile_max_reads: int = 0,
    profile_requested_layers: Optional[Iterable[str] | str] = None,
    profile_include_legacy_profiles: bool = False,
    timings: Optional[dict[str, float]] = None,
    sv_min_len: Optional[int] = None,
    full_working_set: bool = False,
) -> tuple[WorkingSet, int]:
    """Build a display-sampled working set without projecting every candidate read.

    A deep BAM view keeps a stable sample of its reads (services/read_sampling.py),
    unless ``full_working_set``; the working set then carries ``sampling``
    (kept and total counts) for the panel to say so.

    ``sv_min_len``: also summarise the SV events of every candidate read (not
    only the sampled ones) as the working set's ``sv_summary``.

    The UI only receives a capped display pool, but the old path projected all
    overlapping reads with full layer payloads before sampling. This path keeps
    the same count semantics, samples by cheap read extents, then projects only
    the sampled reads.
    """
    if infer_legacy_layers is None:
        infer_legacy_layers = bool(getattr(state, "infer_legacy_layers", True))
    legacy_nuc_min_size = int(
        legacy_nuc_min_size
        if legacy_nuc_min_size is not None
        else getattr(state, "legacy_nuc_min_size", 90)
    )

    dataset = state.get_dataset(dataset_id)
    if not dataset:
        return WorkingSet([], 0, 0, chrom, start, end), 0
    effective_min_footprints = (
        int(min_footprints or 0)
        if dataset.available_layers.get("footprint", True)
        else 0
    )

    layer_key = make_layer_key(include_layers, requested_layers)
    quality_filters = list(
        active_quality_filters(state)
        if quality_filters is None
        else quality_filters
    )
    if quality_filters:
        layer_key = layer_key_for_quality_filters(layer_key, quality_filters)
        include_layer_qualities = True
    include_methylation = bool(include_methylation)
    region_width = end - start
    now = time.time()

    chrom_size = circular_chrom_size(state, chrom)
    if chrom_size and circular_region_wraps(start, end, chrom_size):
        merged_inputs: list[dict] = []
        segment_sampling: list[dict] = []
        for segment in circular_view_segments(start, end, chrom_size):
            segment_set, _segment_working_count = build_sampled_display_working_set(
                state,
                dataset_id,
                chrom,
                segment.ref_start,
                segment.ref_end,
                max_reads=0,
                spanning=False,
                min_footprints=effective_min_footprints,
                include_methylation=include_methylation,
                include_layers=layer_key_has_payload(layer_key),
                requested_layers=None if layer_key is None else layer_key,
                include_layer_qualities=include_layer_qualities,
                build_bam_reads=build_bam_reads,
                build_bigbed_reads=build_bigbed_reads,
                load_bigbed_marks=load_bigbed_marks,
                infer_legacy_layers=infer_legacy_layers,
                legacy_nuc_min_size=legacy_nuc_min_size,
                quality_filters=[],
                full_working_set=full_working_set,
                profile_max_reads=0,
                profile_requested_layers=None,
                profile_include_legacy_profiles=profile_include_legacy_profiles,
                timings=None,
            )
            shift = segment.logical_start - start
            merged_inputs.extend(shift_compact_read(read, shift, segment.logical_start - segment.ref_start)
                for read in segment_set.reads)
            if getattr(segment_set, "sampling", None):
                segment_sampling.append(segment_set.sampling)

        viewport_reads = merge_compact_reads_by_id(merged_inputs)
        if quality_filters:
            viewport_reads = [
                filtered
                for read in viewport_reads
                if (filtered := apply_quality_filters(read, quality_filters)) is not None
            ]
        total_overlapping = len(viewport_reads)
        total_spanning = sum(1 for read in viewport_reads if is_read_spanning(read, region_width))
        if spanning:
            viewport_reads = [
                read for read in viewport_reads
                if is_read_spanning(read, region_width)
            ]

        working_count = len(viewport_reads)
        candidates: list[tuple[float, int, dict, bool]] = []
        for idx, read in enumerate(viewport_reads):
            bounds = _read_viewport_bounds(read, 0, region_width)
            if bounds is None:
                continue
            read_start, read_end, is_spanning = bounds
            coverage = _candidate_coverage_from_bounds(read_start, read_end, region_width)
            candidates.append((coverage, idx, read, is_spanning))

        profile_metaprofile = None
        profile_read_count = 0
        profile_layers = normalize_requested_layers(profile_requested_layers)
        profile_candidates = None
        # Profile cap 0 means every eligible read, not no profile.
        if profile_layers:
            profile_candidates = _coverage_sample_candidates(candidates, int(profile_max_reads or 0))
            profile_reads = [read for _coverage, _idx, read, _is_spanning in profile_candidates]
            profile_read_count = len(profile_reads)
            profile_metaprofile = compute_compact_metaprofile_payload(
                profile_reads,
                region_width,
                list(profile_layers),
                include_legacy_profiles=profile_include_legacy_profiles,
                coordinate_offset=0,
            )

        max_reads_int = int(max_reads or 0)
        if profile_candidates is not None and max_reads_int > 0 and len(profile_candidates) >= max_reads_int:
            selected = _coverage_sample_candidates(profile_candidates, max_reads_int)
        else:
            selected = _coverage_sample_candidates(candidates, max_reads_int)
        selected = _with_pinned_candidates(selected, candidates)
        display_reads = [read for _coverage, _idx, read, _is_spanning in selected]

        circular_set = WorkingSet(
            display_reads,
            total_overlapping,
            total_spanning,
            chrom,
            start,
            end,
            profile_metaprofile=profile_metaprofile,
            profile_read_count=profile_read_count,
        )
        from services.read_sampling import merge_sampling_info
        circular_set.sampling = merge_sampling_info(segment_sampling)
        return circular_set, working_count

    broad_multiplier = configured_prefetch_multiplier(state)
    from services.read_stream import is_prefetch
    if full_working_set and not is_prefetch() and getattr(state, 'performance', {}).get('effective') != 'low':
        # An explicit full-cohort load must leave room for immediate navigation.
        # Keep one viewport on either side, as before visible-first sampling.
        broad_multiplier = max(3, broad_multiplier)
    if getattr(dataset, "data_type", None) == "bigbed" and not effective_min_footprints:
        # Companion files multiply the cost of decoding a widened window.
        # Keep nearby pans cached without making first paint wait for 10 views.
        broad_multiplier = min(broad_multiplier, 2)
    broad_width = region_width * broad_multiplier
    broad_start = max(0, start - (broad_width - region_width) // 2)
    broad_end = broad_start + broad_width

    # A deep view: a stable sample of its reads, unless every read was asked for.
    from services.read_sampling import sample_level as _display_sample_level
    low_memory = getattr(state, 'performance', {}).get('effective') == 'low'
    level = 0 if full_working_set and not low_memory else _display_sample_level(state, dataset, chrom, start, end)
    if level:
        # A read gone to by name must be shown: outside the sample, load every read.
        from services.read_pins import current_pins
        from services.read_sampling import keeps
        # A pin may name a segment ("name_1"): its record's name is either form.
        if not low_memory and any(not (keeps(pin, level) and keeps(re.sub(r"_\d+$", "", pin), level)) for pin in current_pins()):
            level = 0
    # A deep BAM: no more prefetch around the view than its reads afford.
    from services.read_sampling import bounded_prefetch
    if getattr(dataset, "data_type", None) == "bam":
        bounded = bounded_prefetch(state, dataset, chrom, start, end, broad_multiplier, level)
        if bounded != broad_multiplier:
            broad_multiplier = bounded
            broad_width = region_width * broad_multiplier
            broad_start = max(0, start - (broad_width - region_width) // 2)
            broad_end = broad_start + broad_width
    from services.compact_read_loader import short_terminal_footprint_bp_for
    load_token = read_load_token(state, chrom, short_terminal_footprint_bp_for(state), sample_level=level) if level else None

    phase_t0 = time.perf_counter()
    all_reads, broad_cache_key = find_broad_cache_entry(
        state,
        dataset_id,
        chrom,
        start,
        end,
        include_methylation,
        layer_key,
        now,
        include_layer_qualities=include_layer_qualities,
        infer_legacy_layers=infer_legacy_layers,
        legacy_nuc_min_size=legacy_nuc_min_size,
        min_footprints=effective_min_footprints,
        load_token=load_token,
    )

    if all_reads is None:
        all_reads, broad_cache_key = _load_and_cache_broad_reads_singleflight(
            state,
            dataset=dataset,
            dataset_id=dataset_id,
            chrom=chrom,
            viewport_start=start,
            viewport_end=end,
            broad_start=broad_start,
            broad_end=broad_end,
            broad_width=broad_width,
            include_methylation=include_methylation,
            layer_key=layer_key,
            include_layer_qualities=include_layer_qualities,
            build_bam_reads=build_bam_reads,
            build_bigbed_reads=build_bigbed_reads,
            load_bigbed_marks=load_bigbed_marks,
            infer_legacy_layers=infer_legacy_layers,
            legacy_nuc_min_size=legacy_nuc_min_size,
            min_footprints=effective_min_footprints,
            sample_level=level,
        )
    if timings is not None:
        timings['display_load_ms'] = (time.perf_counter() - phase_t0) * 1000

    bc_start = broad_cache_key[2] if broad_cache_key else broad_start
    viewport_offset = start - bc_start
    total_overlapping = 0
    total_spanning = 0
    working_count = 0
    candidates: list[tuple[float, int, dict, bool]] = []

    phase_t0 = time.perf_counter()
    display_index = getattr(all_reads, '_display_index', None)
    overlapping = (display_index.overlapping(viewport_offset, viewport_offset + region_width,
                                             include=geometry_filter(layer_key))
                   if display_index is not None else
                   iter_broad_read_overlaps(state, all_reads, viewport_offset, viewport_offset + region_width))
    for idx, read, abs_read_start, abs_read_end in overlapping:
        if display_index is not None:
            lo, hi = abs_read_start - viewport_offset, abs_read_end - viewport_offset
            bounds = (lo, hi, lo <= 0 and hi >= region_width)
        else:
            bounds = _read_viewport_bounds(read, viewport_offset, region_width, layer_key)
        if bounds is None:
            continue
        read_start, read_end, is_spanning = bounds
        total_overlapping += 1
        if is_spanning:
            total_spanning += 1
        if spanning and not is_spanning:
            continue
        working_count += 1
        coverage = _candidate_coverage_from_bounds(read_start, read_end, region_width)
        candidates.append((coverage, idx, read, is_spanning))
    if timings is not None:
        timings["display_candidate_ms"] = (time.perf_counter() - phase_t0) * 1000
    sv_summary = None
    if sv_min_len is not None:
        from services.sv_events import sv_summary_for_reads
        phase_t0 = time.perf_counter()
        sv_summary = sv_summary_for_reads(
            [read for _coverage, _idx, read, _is_spanning in candidates],
            start, end, int(sv_min_len), chrom=chrom)
        if timings is not None:
            timings["sv_summary_ms"] = (time.perf_counter() - phase_t0) * 1000

    profile_metaprofile = None
    profile_read_count = 0
    profile_layers = normalize_requested_layers(profile_requested_layers)
    profile_candidates = None
    # Select by lightweight geometry before expanding any packed annotation
    # blocks. Hydrate the union of profile/display rows in source order once.
    phase_t0 = time.perf_counter()
    if profile_layers:
        profile_candidates = _coverage_sample_candidates(candidates, int(profile_max_reads or 0))
    if timings is not None:
        timings['display_profile_select_ms'] = (time.perf_counter() - phase_t0) * 1000
    phase_t0 = time.perf_counter()
    max_reads_int = int(max_reads or 0)
    if profile_candidates is not None and max_reads_int > 0 and len(profile_candidates) >= max_reads_int:
        selected = _coverage_sample_candidates(profile_candidates, max_reads_int)
    else:
        selected = _coverage_sample_candidates(candidates, max_reads_int)
    selected = _with_pinned_candidates(selected, candidates)
    if timings is not None:
        timings['display_select_ms'] = (time.perf_counter() - phase_t0) * 1000
    if display_index is not None:
        phase_t0 = time.perf_counter()
        hydrated = all_reads.take(item[1] for item in selected + (profile_candidates or []))
        selected = [(coverage, idx, hydrated[idx], spans) for coverage, idx, _, spans in selected]
        if profile_candidates is not None:
            profile_candidates = [(coverage, idx, hydrated[idx], spans)
                                  for coverage, idx, _, spans in profile_candidates]
        if timings is not None:
            timings['display_expand_ms'] = (time.perf_counter() - phase_t0) * 1000
    # Profile cap 0 means every eligible read, not no profile.
    if profile_layers:
        phase_t0 = time.perf_counter()
        profile_reads = [read for _coverage, _idx, read, _is_spanning in profile_candidates]
        if quality_filters:
            # The profile counts the calls the display shows: the same quality
            # gates (on copies; the broad cache keeps the raw reads).
            profile_reads = [
                filtered for read in profile_reads
                if (filtered := apply_quality_filters(read, quality_filters)) is not None
            ]
        profile_read_count = len(profile_reads)
        profile_metaprofile = compute_compact_metaprofile_payload(
            profile_reads,
            region_width,
            list(profile_layers),
            include_legacy_profiles=profile_include_legacy_profiles,
            coordinate_offset=viewport_offset,
        )
        if timings is not None:
            timings["display_profile_payload_ms"] = (time.perf_counter() - phase_t0) * 1000
            timings["display_profile_ms"] = (
                timings.get("display_profile_select_ms", 0.0)
                + timings.get("display_profile_payload_ms", 0.0)
            )

    viewport_reads = []
    phase_t0 = time.perf_counter()
    for _coverage, _idx, read, is_spanning in selected:
        adjusted_read, _ = project_broad_read_to_viewport(
            read,
            viewport_offset=viewport_offset,
            region_width=region_width,
            include_methylation=include_methylation,
            layer_key=layer_key,
            include_layer_qualities=include_layer_qualities,
            index_intervals=display_index is None,
        )
        if adjusted_read is None:
            continue
        if quality_filters:
            adjusted_read = apply_quality_filters(adjusted_read, quality_filters)
            if adjusted_read is None:
                continue
        viewport_reads.append(adjusted_read)
    if timings is not None:
        timings["display_project_ms"] = (time.perf_counter() - phase_t0) * 1000

    working_set = WorkingSet(
        viewport_reads,
        total_overlapping,
        total_spanning,
        chrom,
        start,
        end,
        profile_metaprofile=profile_metaprofile,
        profile_read_count=profile_read_count,
    )
    if sv_min_len is not None:
        working_set.sv_summary = sv_summary
    from services.read_sampling import sampling_info
    working_set.sampling = sampling_info(all_reads, start, end, total_overlapping, total_spanning)
    return working_set, working_count


def _build_working_set(
    state,
    dataset_id: str,
    chrom: str,
    start: int,
    end: int,
    *,
    spanning: bool = False,
    min_footprints: int = 0,
    read_ids: Optional[list] = None,
    include_methylation: bool = True,
    include_layers: bool = True,
    requested_layers: Optional[Iterable[str] | str] = None,
    include_layer_qualities: bool = True,
    quality_filters: Optional[Iterable[dict]] = None,
    build_bam_reads: Callable,
    build_bigbed_reads: Callable,
    load_bigbed_marks: Callable,
    stable_sampler: Callable,
    sample_seed: str = DEFAULT_SAMPLE_SEED,
    infer_legacy_layers: Optional[bool] = None,
    legacy_nuc_min_size: Optional[int] = None,
    broad_prefetch_multiplier: Optional[int] = None,
    force_reload: bool = False,
) -> WorkingSet:
    """Build a viewport working set from broad read caches.

    ``broad_prefetch_multiplier`` defaults to the server's ``--prefetch``.
    """
    t0 = time.time()
    ensure_broad_cache_schema(state)
    sample_seed = normalize_sample_seed(sample_seed)
    if infer_legacy_layers is None:
        infer_legacy_layers = bool(getattr(state, "infer_legacy_layers", True))
    legacy_nuc_min_size = int(
        legacy_nuc_min_size
        if legacy_nuc_min_size is not None
        else getattr(state, "legacy_nuc_min_size", 90)
    )

    dataset = state.get_dataset(dataset_id)
    if not dataset:
        return WorkingSet([], 0, 0, chrom, start, end)
    effective_min_footprints = (
        int(min_footprints or 0)
        if dataset.available_layers.get("footprint", True)
        else 0
    )

    chrom_size = circular_chrom_size(state, chrom)
    if chrom_size and circular_region_wraps(start, end, chrom_size):
        region_width = end - start
        merged_inputs: list[dict] = []
        for segment in circular_view_segments(start, end, chrom_size):
            segment_set = build_working_set(
                state,
                dataset_id,
                chrom,
                segment.ref_start,
                segment.ref_end,
                spanning=False,
                min_footprints=effective_min_footprints,
                read_ids=read_ids,
                include_methylation=include_methylation,
                include_layers=include_layers,
                requested_layers=requested_layers,
                include_layer_qualities=include_layer_qualities,
                quality_filters=quality_filters,
                build_bam_reads=build_bam_reads,
                build_bigbed_reads=build_bigbed_reads,
                load_bigbed_marks=load_bigbed_marks,
                stable_sampler=stable_sampler,
                sample_seed=sample_seed,
                infer_legacy_layers=infer_legacy_layers,
                legacy_nuc_min_size=legacy_nuc_min_size,
                broad_prefetch_multiplier=broad_prefetch_multiplier,
                force_reload=force_reload,
            )
            shift = segment.logical_start - start
            merged_inputs.extend(shift_compact_read(read, shift, segment.logical_start - segment.ref_start)
                for read in segment_set.reads)

        viewport_reads = merge_compact_reads_by_id(merged_inputs)
        total_overlapping = len(viewport_reads)
        total_spanning = sum(1 for read in viewport_reads if is_read_spanning(read, region_width))
        if spanning:
            viewport_reads = [
                read for read in viewport_reads
                if is_read_spanning(read, region_width)
            ]

        if (
            (read_ids is None or getattr(state, 'performance', {}).get('effective') == 'low')
            and state.max_working_reads
            and state.max_working_reads > 0
            and len(viewport_reads) > state.max_working_reads
        ):
            viewport_reads = stable_sampler(
                viewport_reads,
                state.max_working_reads,
                seed=f"{sample_seed}:working_set:{dataset_id}:{chrom}:circular",
            )

        t1 = time.time()
        if t1 - t0 > 0.01:
            log_working_set_diagnostic(
                f"  Circular working set: {dataset_id} {len(viewport_reads)} reads "
                f"({total_spanning} spanning) in {t1-t0:.3f}s"
            )
        return WorkingSet(viewport_reads, total_overlapping, total_spanning, chrom, start, end)

    layer_key = make_layer_key(include_layers, requested_layers)
    quality_filters = list(
        active_quality_filters(state)
        if quality_filters is None
        else quality_filters
    )
    if quality_filters:
        layer_key = layer_key_for_quality_filters(layer_key, quality_filters)
        include_layer_qualities = True
    include_layers = layer_key_has_payload(layer_key)
    region_width = end - start
    now = time.time()
    cacheable = read_ids is None
    generation = dataset_generation(state, dataset_id)
    from services.compact_read_loader import short_terminal_footprint_bp_for
    terminal_bp = short_terminal_footprint_bp_for(state)
    from services.read_sampling import sample_level, sampling_info
    low_memory = getattr(state, 'performance', {}).get('effective') == 'low'
    from services.read_sampling import decode_read_scope
    from services.lift.reads import display_sampling
    level = (1 if decode_read_scope.get() is not None else sample_level(state, dataset, chrom, start, end)) if low_memory or display_sampling(dataset) else 0
    from services.cluster_sample import cluster_sample_scope
    cluster_sample = cluster_sample_scope.get()
    if cluster_sample is not None:
        level = 1
    topology = read_load_token(state, chrom, terminal_bp, sample_level=level)
    from services.lift.reads import display_key, display_row_filter
    lift_display = display_key(dataset)

    working_cache_key = make_working_cache_key(
        dataset_id,
        chrom,
        start,
        end,
        spanning,
        effective_min_footprints,
        state.max_working_reads,
        include_methylation,
        layer_key,
        quality_filters,
        sample_seed,
        infer_legacy_layers,
        legacy_nuc_min_size,
        include_layer_qualities,
        # A lifted display's haplotype rule: its rows are filtered before the cap below.
        topology=topology if lift_display is None else (*topology, lift_display),
    )
    if cacheable and not force_reload:
        cache_lock, _inflight = _broad_cache_sync(state)
        with cache_lock:
            cached = state._working_set_cache.get(working_cache_key)
            if cached:
                working_set, timestamp = cached
                timeout = state._working_set_cache_timeout
                if timeout is None or now - timestamp <= timeout:
                    state._working_set_cache.move_to_end(working_cache_key)
                    return working_set
                state._working_set_cache.pop(working_cache_key, None)

    if broad_prefetch_multiplier is None:
        broad_prefetch_multiplier = configured_prefetch_multiplier(state)
    broad_multiplier = max(1, int(broad_prefetch_multiplier or 1))
    if level:
        from services.read_sampling import bounded_prefetch
        broad_multiplier = bounded_prefetch(state, dataset, chrom, start, end, broad_multiplier, level)
    if getattr(dataset, "data_type", None) == "bigbed" and not effective_min_footprints:
        broad_multiplier = min(broad_multiplier, 2)
    broad_width = region_width * broad_multiplier
    broad_start = max(0, start - (broad_width - region_width) // 2)
    broad_end = broad_start + broad_width
    chrom_len = state._chrom_size_for(chrom) if hasattr(state, "_chrom_size_for") else None
    if chrom_len:
        if broad_end > chrom_len:
            broad_end = int(chrom_len)
            broad_start = max(0, min(broad_start, broad_end - broad_width))
        if broad_start > start:
            broad_start = max(0, start)

    served_sampled = False
    if force_reload:
        all_reads, broad_cache_key = None, None
    else:
        all_reads, broad_cache_key = find_broad_cache_entry(
            state,
            dataset_id,
            chrom,
            start,
            end,
            include_methylation,
            layer_key,
            now,
            include_layer_qualities=include_layer_qualities,
            infer_legacy_layers=infer_legacy_layers,
            legacy_nuc_min_size=legacy_nuc_min_size,
            min_footprints=effective_min_footprints,
            load_token=topology,
        )
        if all_reads is None and read_ids is not None:
            all_reads, broad_cache_key = _sampled_entry_with_reads(
                state, dataset, dataset_id, chrom, start, end, read_ids, include_methylation, layer_key, now,
                include_layer_qualities=include_layer_qualities, infer_legacy_layers=infer_legacy_layers,
                legacy_nuc_min_size=legacy_nuc_min_size, min_footprints=effective_min_footprints,
                terminal_bp=terminal_bp,
            )
            served_sampled = all_reads is not None

    from services.scoped_read_analysis import selected_analysis
    if all_reads is None and selected_analysis.get() and read_ids is not None and not force_reload:
        if not read_ids:
            return WorkingSet([], 0, 0, chrom, start, end)
        scope = decode_read_scope.set(dict(only_ids=set(map(str, read_ids)),
            raw_aliases={re.sub(r'_\d+$', '', str(name)) for name in read_ids}))
        try:
            return _build_working_set(state, dataset_id, chrom, start, end,
                spanning=spanning, min_footprints=min_footprints, read_ids=read_ids,
                include_methylation=include_methylation, include_layers=include_layers,
                requested_layers=requested_layers, include_layer_qualities=include_layer_qualities,
                quality_filters=quality_filters, build_bam_reads=build_bam_reads,
                build_bigbed_reads=build_bigbed_reads, load_bigbed_marks=load_bigbed_marks,
                stable_sampler=stable_sampler, sample_seed=sample_seed,
                infer_legacy_layers=infer_legacy_layers, legacy_nuc_min_size=legacy_nuc_min_size,
                broad_prefetch_multiplier=1, force_reload=True)
        finally:
            decode_read_scope.reset(scope)
    if all_reads is None:
        if force_reload:
            all_reads = _load_broad_reads(
                dataset=dataset,
                dataset_id=dataset_id,
                chrom=chrom,
                broad_start=broad_start,
                broad_end=broad_end,
                broad_width=broad_width,
                include_methylation=include_methylation,
                layer_key=layer_key,
                include_layer_qualities=include_layer_qualities,
                build_bam_reads=build_bam_reads,
                build_bigbed_reads=build_bigbed_reads,
                load_bigbed_marks=load_bigbed_marks,
                infer_legacy_layers=infer_legacy_layers,
                legacy_nuc_min_size=legacy_nuc_min_size,
                min_footprints=effective_min_footprints,
                short_terminal_footprint_bp=terminal_bp,
                sample_level=level,
            )
            broad_cache_key = (
                dataset_id, chrom, broad_start, broad_end,
                bool(include_methylation), layer_key,
                bool(include_layer_qualities), bool(infer_legacy_layers),
                int(legacy_nuc_min_size or 90), effective_min_footprints,
                topology,
            )
            _store_broad_cache_entry(state, broad_cache_key, all_reads, generation)
        else:
            all_reads, broad_cache_key = _load_and_cache_broad_reads_singleflight(
                state,
                dataset=dataset,
                dataset_id=dataset_id,
                chrom=chrom,
                viewport_start=start,
                viewport_end=end,
                broad_start=broad_start,
                broad_end=broad_end,
                broad_width=broad_width,
                include_methylation=include_methylation,
                layer_key=layer_key,
                include_layer_qualities=include_layer_qualities,
                build_bam_reads=build_bam_reads,
                build_bigbed_reads=build_bigbed_reads,
                load_bigbed_marks=load_bigbed_marks,
                infer_legacy_layers=infer_legacy_layers,
                legacy_nuc_min_size=legacy_nuc_min_size,
                min_footprints=effective_min_footprints,
                short_terminal_footprint_bp=terminal_bp,
                sample_level=level,
            )

    bc_start = broad_cache_key[2] if broad_cache_key else broad_start
    viewport_reads, total_overlapping, total_spanning = _viewport_reads_from_broad(
        state=state,
        all_reads=all_reads,
        dataset=dataset,
        region_width=region_width,
        bc_start=bc_start,
        start=start,
        end=end,
        spanning=spanning,
        min_footprints=effective_min_footprints,
        read_ids=read_ids,
        include_methylation=include_methylation,
        layer_key=layer_key,
        include_layer_qualities=include_layer_qualities,
        quality_filters=quality_filters,
        bc_end=broad_cache_key[3] if broad_cache_key else broad_end,
        row_filter=display_row_filter(dataset),
    )
    sampling_metadata = sampling_info(all_reads, start, end, total_overlapping, total_spanning) if level else None
    if sampling_metadata:
        if decode_read_scope.get() is not None or cluster_sample is not None:
            sampling_metadata['fraction'] = sampling_metadata['kept'] / max(1, sampling_metadata['total'])
        total_overlapping = sampling_metadata['total']
        total_spanning = sampling_metadata['total_spanning']
    if served_sampled and all_reads is not None:
        # Served from the display's sampled load: the view's totals, not the
        # sample's. The sample knows every alignment in view exactly; the share
        # its own reads keep under this analysis' filters scales that (exact
        # when no read is filtered).
        from services.read_sampling import sampling_info
        info = sampling_info(all_reads, start, end, total_overlapping, total_spanning)
        if info and info["kept"] > 0:
            total_overlapping = round(info["total"] * total_overlapping / info["kept"])
        if info and info["kept_spanning"] > 0:
            total_spanning = round(info["total_spanning"] * total_spanning / info["kept_spanning"])

    if (
        (read_ids is None or low_memory)
        and state.max_working_reads
        and state.max_working_reads > 0
        and len(viewport_reads) > state.max_working_reads
    ):
        viewport_reads = stable_sampler(
            viewport_reads,
            state.max_working_reads,
            seed=f"{sample_seed}:working_set:{dataset_id}:{chrom}",
        )

    t1 = time.time()
    if t1 - t0 > 0.01:
        log_working_set_diagnostic(f"  Working set: {dataset_id} {len(viewport_reads)} reads ({total_spanning} spanning) in {t1-t0:.3f}s")

    working_set = WorkingSet(viewport_reads, total_overlapping, total_spanning, chrom, start, end)
    working_set.sampling = sampling_metadata
    if cacheable:
        if isinstance(state._working_set_cache, ByteCache) and len(viewport_reads) >= 4096:
            import copy
            retained = copy.copy(working_set)
            # Packing yields to navigation. Never pause while holding the
            # cache lock the new visible request needs to look up its reads.
            # This exact-viewport cache serves analyses by sequential iteration.
            # The broad cohort owns the spatial index used for navigation.
            retained.reads = pack_reads(viewport_reads, display_index=False)
        else:
            retained = working_set
        cache_lock, _inflight = _broad_cache_sync(state)
        with cache_lock:
            if dataset_generation(state, dataset_id) == generation:
                state._working_set_cache[working_cache_key] = (retained, t1)
                state._working_set_cache.move_to_end(working_cache_key)
                while not isinstance(state._working_set_cache, ByteCache) and len(state._working_set_cache) > state._working_set_cache_max:
                    state._working_set_cache.popitem(last=False)

    return working_set


from functools import wraps


@wraps(_build_working_set)
def build_working_set(state, dataset_id, chrom, start, end, **kwargs):
    """Cap explicit analysis cohorts before BAM tags are decoded in Low memory."""
    from services.read_sampling import decode_read_scope, name_hash
    ids = kwargs.get('read_ids')
    cap = int(getattr(state, 'max_working_reads', 0) or 0)
    if getattr(state, 'performance', {}).get('effective') != 'low' or ids is None or not cap:
        return _build_working_set(state, dataset_id, chrom, start, end, **kwargs)
    selected = heapq.nsmallest(cap, set(map(str, ids)), key=lambda name: (name_hash(name), name))
    token = decode_read_scope.set(dict(only_ids=set(selected),
                                       raw_aliases={re.sub(r'_\d+$', '', name) for name in selected},
                                       max_records=cap))
    try:
        return _build_working_set(state, dataset_id, chrom, start, end,
                                  **{**kwargs, 'read_ids': selected, 'force_reload': True})
    finally:
        decode_read_scope.reset(token)
