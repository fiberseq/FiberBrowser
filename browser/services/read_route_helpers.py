"""Shared helpers for read API routers."""
from __future__ import annotations

import os
from typing import Optional

from services.bam_handles import get_bam_handle
from services.bigbed_detection import detect_overlay_type
from services.bigbed_handles import get_bigbed_handle
from services.compact_read_loader import (
    _bam_wrap_length_for,
    build_compact_reads_from_bam,
    build_compact_reads_from_bigbed,
    short_terminal_footprint_bp_for,
)
from services.bigbed_read_loader import load_methyl_from_bigbed
from services.diagnostics import env_flag_enabled, log_if_enabled
from services.read_response_payloads import compact_reads_response_payload
from utils.responses import ORJSONResponse

READ_DIAGNOSTICS_ENV = "FIBERBROWSER_READ_DIAGNOSTICS"
READ_LOG_THRESHOLD_ENV = "FIBERBROWSER_READ_LOG_THRESHOLD"
DEFAULT_READ_LOG_THRESHOLD_SECONDS = 1.0


def read_log_threshold_seconds() -> float:
    raw = os.environ.get(READ_LOG_THRESHOLD_ENV)
    if raw is None or raw.strip() == "":
        return DEFAULT_READ_LOG_THRESHOLD_SECONDS
    try:
        return max(0.0, float(raw))
    except ValueError:
        return DEFAULT_READ_LOG_THRESHOLD_SECONDS


def should_log_read_request(elapsed_seconds: float) -> bool:
    return (
        env_flag_enabled(READ_DIAGNOSTICS_ENV)
        or elapsed_seconds >= read_log_threshold_seconds()
    )


def log_read_diagnostic(message: str) -> None:
    log_if_enabled(READ_DIAGNOSTICS_ENV, message)


def log_read_request(message: str, elapsed_seconds: float) -> None:
    if should_log_read_request(elapsed_seconds):
        print(message)


def _bam_options(state, bam_path, chrom, kwargs):
    kwargs = dict(kwargs)
    kwargs.setdefault("bam_handle_getter", get_bam_handle)
    kwargs.setdefault("chrom_map", getattr(state, "chrom_map", None))
    # Plasmid maps linked to this file's contigs, in this workspace only.
    from services.plasmid_reconcile import contig_links
    kwargs.setdefault("contig_links", contig_links(state, path=bam_path))
    # Origin-spanning records wrap on contigs the browser treats as circular
    # (TP:circular ones wrap whatever the flags say).
    from services.circular_genome import is_circular_chrom
    kwargs.setdefault("circular", bool(is_circular_chrom(state, chrom)))
    # Read-end footprints under the cutoff are dropped for this workspace's
    # display and analyses alike (Edges / terminal gaps settings).
    kwargs.setdefault("short_terminal_footprint_bp", short_terminal_footprint_bp_for(state))
    from services.sv_alleles import reference_identity
    kwargs.setdefault('sv_reference', reference_identity(state)[0])
    from services.read_edge_cache import edge_fetch_regions
    if edge_fetch_regions.get() is not None:
        kwargs['fetch_regions'] = edge_fetch_regions.get()
    return kwargs


def build_direct_bam_reads(state, bam_path, chrom, start, end, **kwargs):
    """Load BAM compact reads without routing through server compatibility wrappers."""
    kwargs = _bam_options(state, bam_path, chrom, kwargs)
    config = getattr(state, 'performance', {})
    workers = config.get('decode_workers', 1)
    from services.background_work import is_interactive_read
    from services.read_stream import is_prefetch
    from services.packed_reads import bounded_analysis
    from services.read_sampling import active_sampler
    from services.cluster_sample import cluster_sample_scope
    # Sampled first views still decompress every fetched BAM record. htslib's
    # bounded native threads accelerate that work without changing the sample.
    # Keep the reader request-local: pooled files must not leave one idle native
    # thread pool per BAM in the shared handle cache.
    if ((is_interactive_read() or cluster_sample_scope.get() is not None) and not is_prefetch()
            and active_sampler() is not None and active_sampler().level > 0
            and config.get('bam_threads', 1) > 1 and os.path.isfile(bam_path)
            and kwargs.get('bam_handle_getter') is get_bam_handle):
        from services.bam_handles import transient_bam_handle
        with transient_bam_handle(bam_path, threads=config['bam_threads']) as bam:
            kwargs['bam_handle_getter'] = lambda path: bam if path == bam_path else get_bam_handle(path)
            return build_compact_reads_from_bam(bam_path, chrom, start, end, **kwargs)
    if workers > 1 and not bounded_analysis.get() and not is_interactive_read() and not is_prefetch() and not kwargs.get('circular'):
        from services.read_sampling import active_sampler, estimate_reads
        if (os.path.isfile(bam_path) and active_sampler() is None
                and (estimate_reads(bam_path, chrom, start, end, chrom_map=kwargs.get('chrom_map')) or 0) >= 20000
                and not _bam_requires_wrap(bam_path, chrom, kwargs)):
            from services.parallel_reads import parallel_bam_reads
            options = {key: value for key, value in kwargs.items() if key != 'bam_handle_getter'}
            return parallel_bam_reads(bam_path, chrom, start, end, options, workers)
    return build_compact_reads_from_bam(bam_path, chrom, start, end, **kwargs)


def _bam_requires_wrap(path, chrom, options):
    # A BAM's TP:circular declaration can apply even when a public workspace
    # cannot update its shared chromosome flags. Streaming raw worker blocks
    # cannot bypass the head/tail join that these records require.
    return _bam_wrap_length_for(path, chrom, bool(options.get('circular')),
        options.get('bam_handle_getter'), options.get('chrom_map'), options.get('contig_links')) is not None


def display_bam_loader(state, load_one=build_direct_bam_reads):
    """Ordinary reads plus bounded pooled decoding for displays and analyses."""
    def load(path, chrom, start, end, **kwargs):
        return load_one(state, path, chrom, start, end, **kwargs)

    def load_many(paths, chrom, start, end, *, retain_packed=False, **kwargs):
        from services.background_work import is_interactive_read
        from services.read_stream import is_prefetch
        from services.read_sampling import active_sampler, estimate_reads
        from services.packed_reads import bounded_analysis
        workers = getattr(state, 'performance', {}).get('decode_workers', 1)
        if (workers <= 1 or len(paths) < 2 or active_sampler() is not None
                or is_prefetch() or bounded_analysis.get()
                or not all(os.path.isfile(path) for path in paths)):
            return None
        options = [_bam_options(state, path, chrom, kwargs) for path in paths]
        if any(opt.get('circular') or opt.get('fetch_regions') for opt in options):
            return None
        estimates = [estimate_reads(path, chrom, start, end, chrom_map=opt.get('chrom_map'),
                                    contig_links=opt.get('contig_links')) or 0
                     for path, opt in zip(paths, options)]
        if sum(estimates) < 20000:
            return None
        # A few large analysis files already use within-file partitions. Keep
        # that path rather than replacing it with fewer one-file workers.
        if not is_interactive_read() and len(paths) < workers and max(estimates) >= 20000:
            return None
        if any(_bam_requires_wrap(path, chrom, opt) for path, opt in zip(paths, options)):
            return None
        from services.parallel_reads import parallel_bam_files
        return parallel_bam_files(paths, chrom, start, end,
            [{key: value for key, value in opt.items() if key != 'bam_handle_getter'} for opt in options], workers,
            retain_packed=retain_packed)

    load.load_many = load_many
    return load


def build_direct_bigbed_reads(bigbed_path, chrom, start, end, **kwargs):
    """Load BigBed compact reads without routing through server compatibility wrappers."""
    kwargs.setdefault("bigbed_handle_getter", get_bigbed_handle)
    kwargs.setdefault("overlay_type_detector", detect_overlay_type)
    return build_compact_reads_from_bigbed(bigbed_path, chrom, start, end, **kwargs)


def load_direct_bigbed_marks(bigbed_path, chrom, start, end, **kwargs):
    """Load BigBed modification marks without routing through compatibility wrappers."""
    kwargs.setdefault("bigbed_handle_getter", get_bigbed_handle)
    return load_methyl_from_bigbed(bigbed_path, chrom, start, end, **kwargs)


def unwrap_query_default(value, fallback):
    """Support tests that call route functions directly and omit Query defaults."""
    if hasattr(value, "default"):
        value = getattr(value, "default")
    return fallback if value is None else value


def query_bool(value, fallback: bool) -> bool:
    value = unwrap_query_default(value, fallback)
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return bool(value)


def query_int(value, fallback: int) -> int:
    value = unwrap_query_default(value, fallback)
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def available_layers_for_response(dataset, discovered_layers=None) -> Optional[list[str]]:
    """Return known layer names without forcing rich read payload construction."""
    names = set(discovered_layers or [])
    if dataset is not None:
        names.update(
            name
            for name, present in (getattr(dataset, "available_layers", {}) or {}).items()
            if present
        )
    return sorted(names) if names else None


def compact_reads_response(**kwargs) -> ORJSONResponse:
    """Build the compact-read payload and wrap it in the fast JSON response."""
    return ORJSONResponse(compact_reads_response_payload(**kwargs))
