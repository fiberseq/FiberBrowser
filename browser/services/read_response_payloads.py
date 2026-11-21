"""Shared response payload helpers for read endpoints."""
from __future__ import annotations

from typing import Callable, Mapping, Optional, Sequence

CompactRead = dict
Sampler = Callable[[list[CompactRead], int, int, int], list[CompactRead]]


def compact_read_count_fields(
    *,
    display_count: int,
    working_count: int,
    total_in_scope: int,
    total_spanning: int,
    total_overlapping: Optional[int] = None,
) -> dict:
    """
    Build consistent count fields for compact-read responses.

    `total` is kept as a legacy alias for the reads in the current request
    scope. New callers should prefer `total_in_scope` because span/filter
    settings can make this differ from all overlapping reads.
    """
    display_count = max(0, int(display_count))
    working_count = max(0, int(working_count))
    total_in_scope = max(0, int(total_in_scope))
    total_spanning = max(0, int(total_spanning))
    if total_overlapping is None:
        total_overlapping = total_in_scope
    total_overlapping = max(0, int(total_overlapping))

    return {
        "count": display_count,
        "display_count": display_count,
        "total": total_in_scope,
        "total_in_scope": total_in_scope,
        "total_overlapping": total_overlapping,
        "total_spanning": total_spanning,
        "working_count": working_count,
    }


# Server-side alignment identity used only for consensus projection; the
# browser never reads it, and it adds ~15% to every read payload.
_PROJECTION_IDENTITY_KEYS = frozenset((
    "library_id", "source_path", "record_sha256", "alignment_occurrence",
    "reference_start", "reference_end", "alignment_orientation",
    "bigbed_sample", "alignment_spans",
))


# Reads from a merged dataset (several source files) keep the alignment fields
# the native lattice needs to tell apart primaries sharing a name across files.
_LATTICE_IDENTITY_KEYS = frozenset((
    "library_id", "reference_start", "reference_end", "alignment_orientation",
))


def _strip_projection_identity(read: CompactRead, keep: frozenset = frozenset()) -> CompactRead:
    if not isinstance(read, dict) or _PROJECTION_IDENTITY_KEYS.isdisjoint(read):
        return read
    return {key: value for key, value in read.items()
            if key not in _PROJECTION_IDENTITY_KEYS or key in keep}


def _identity_keys_to_keep(display_reads: Sequence[CompactRead], multi_library: bool = False) -> frozenset:
    # A dataset of several files keeps each row's file even when the rows in view
    # all came from one: a linked live-lift panel tells molecules apart by it.
    if multi_library:
        return _LATTICE_IDENTITY_KEYS
    libraries = set()
    for read in display_reads:
        if isinstance(read, dict) and read.get("library_id") is not None:
            libraries.add(read["library_id"])
            if len(libraries) > 1:
                return _LATTICE_IDENTITY_KEYS
    return frozenset()


def compact_reads_response_payload(
    *,
    display_reads: Sequence[CompactRead],
    width: int,
    dataset_id: Optional[str],
    working_count: int,
    total_in_scope: int,
    total_spanning: int,
    total_overlapping: Optional[int] = None,
    dataset_label: Optional[str] = None,
    dataset_color: Optional[str] = None,
    has_methylation: bool = False,
    available_layers: Optional[Sequence[str]] = None,
    sample_seed: Optional[str] = None,
    warning: Optional[str] = None,
    success: Optional[bool] = None,
    error: Optional[str] = None,
    server_elapsed_ms: Optional[float] = None,
    server_timings: Optional[Mapping[str, float]] = None,
    metaprofile: Optional[Mapping[str, object]] = None,
    metaprofile_read_count: Optional[int] = None,
    profile_max_reads: Optional[int] = None,
    multi_library: bool = False,
) -> dict:
    """Build the common compact-read response schema used by read endpoints.
    ``multi_library``: the dataset has several files (rows keep ``library_id``)."""
    keep = _identity_keys_to_keep(display_reads, multi_library)
    reads = [_strip_projection_identity(read, keep) for read in display_reads]
    payload = {
        **compact_read_count_fields(
            display_count=len(reads),
            working_count=working_count,
            total_in_scope=total_in_scope,
            total_spanning=total_spanning,
            total_overlapping=total_overlapping,
        ),
        "width": int(width),
        "reads": reads,
        "dataset_id": dataset_id,
        "has_methylation": bool(has_methylation),
        "available_layers": list(available_layers) if available_layers is not None else None,
    }
    from services.read_binary import binary_read_context
    if binary_read_context.get():
        from services.read_stream import read_sink
        stream = read_sink.get()
        if stream is not None and stream.indices:
            payload['_read_stream_order'] = [stream.indices.get(id(read)) for read in display_reads]
        # Cache projections need unclipped alignment extents for counts. Keep
        # this transport metadata separate from the public read dictionaries.
        payload["_read_bounds"] = [
            [read["reference_start"], read["reference_end"]]
            if "reference_start" in read and "reference_end" in read else None
            for read in display_reads
        ]
        if any('_fiberbrowser_terminal_gaps' in read for read in display_reads):
            payload["_read_terminals"] = [read.get('_fiberbrowser_terminal_gaps') for read in display_reads]
    if dataset_label is not None:
        payload["label"] = dataset_label
    if dataset_color is not None:
        payload["color"] = dataset_color
    if sample_seed is not None:
        payload["sample_seed"] = sample_seed
    if warning:
        payload["warning"] = warning
    if success is not None:
        payload["success"] = success
    if error:
        payload["error"] = error
    if server_elapsed_ms is not None:
        payload["server_elapsed_ms"] = round(float(server_elapsed_ms), 1)
    if server_timings:
        payload["server_timings"] = {
            str(name): round(float(elapsed), 1)
            for name, elapsed in server_timings.items()
        }
    if metaprofile is not None:
        payload["metaprofile"] = dict(metaprofile)
        payload["metaprofile_read_count"] = int(metaprofile_read_count or 0)
        if profile_max_reads is not None:
            payload["profile_max_reads"] = int(profile_max_reads)
    return payload


def compact_read_display_start(read: CompactRead) -> int:
    """Stable display sort key for compact reads."""
    intervals = read.get("intervals") or []
    return int(intervals[0][0]) if intervals else 0


def sort_compact_reads_for_display(reads: Sequence[CompactRead]) -> list[CompactRead]:
    """Return compact reads ordered top-to-bottom by their first displayed interval."""
    return sorted(reads, key=compact_read_display_start)


def sample_compact_reads_for_display(
    reads: Sequence[CompactRead],
    max_reads: int,
    region_width: int,
    sampler: Sampler,
    *,
    keep_pinned: bool = True,
) -> list[CompactRead]:
    """
    Sample reads for rendering and apply the canonical display order.

    ``keep_pinned``: the request's pinned reads (services/read_pins.py) join
    the sample; off for analysis samples (metaprofiles), whose reads and counts
    never depend on what the user highlighted.

    The sampler takes viewport-relative coordinates, so the endpoint passes
    0..region_width after compact reads have been projected into the viewport.
    """
    from services.read_pins import compact_read_id, with_pinned
    scoped_reads = list(reads)
    if max_reads > 0 and len(scoped_reads) > max_reads:
        # Reads the request pins (a read gone to by name) stay in the sample.
        scoped_reads = sampler(scoped_reads, max_reads, 0, region_width)
        if keep_pinned:
            scoped_reads = with_pinned(scoped_reads, reads, compact_read_id)
    return sort_compact_reads_for_display(scoped_reads)


def compact_reads_have_methylation(reads: Sequence[CompactRead]) -> bool:
    return any(bool(read.get("methyl")) for read in reads)


def compact_reads_available_layers(reads: Sequence[CompactRead]) -> list[str]:
    layers = set()
    for read in reads:
        layer_payload = read.get("layers")
        if isinstance(layer_payload, dict):
            layers.update(layer_payload.keys())
            # Producer-native tf_sr may carry family identity directly. Expose
            # that identity as an independent display capability even though
            # it shares the compact payload with the refined molecular calls.
            refined = layer_payload.get("tf_sr") or {}
            if "fi" in (refined.get("quality_names") or ()):
                layers.add("tf_consensus")
    return sorted(layers)
