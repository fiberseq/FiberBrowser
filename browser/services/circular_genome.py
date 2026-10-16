"""Circular chromosome/reference helpers.

The browser keeps viewport coordinates as a continuous logical axis.  For a
circular chromosome, that logical axis can extend below 0 or past the reference
length; backend I/O still has to query linear BAM/BigBed/FASTA coordinates.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Iterable, Optional


DEFAULT_CIRCULAR_SHORT_CHROM_MAX = 500_000
MITO_CHROM_NAMES = {"m", "mt", "chrm", "chrmt", "mitochondria", "mitochondrion"}
MAX_USER_CIRCULAR_CHROM_SIZE = 10_000_000
logger = logging.getLogger(__name__)
_TRUNCATION_WARNING_EMITTED = False


@dataclass(frozen=True)
class CircularSegment:
    logical_start: int
    logical_end: int
    ref_start: int
    ref_end: int

    @property
    def width(self) -> int:
        return self.logical_end - self.logical_start

    @property
    def viewport_offset(self) -> int:
        return self.logical_start


def normalize_circular_position(pos: int, chrom_size: int) -> int:
    if chrom_size <= 0:
        return int(pos)
    return int(pos) % int(chrom_size)


def circular_view_segments(start: int, end: int, chrom_size: int, max_segments: int = 16) -> list[CircularSegment]:
    """Split a logical circular viewport into linear reference segments.

    Example for a 1000 bp plasmid:
      950..1050 -> 950..1000 and 0..50
      -50..50   -> 950..1000 and 0..50
    """
    start = int(start)
    end = int(end)
    chrom_size = int(chrom_size or 0)
    if end <= start or chrom_size <= 0:
        return []

    segments: list[CircularSegment] = []
    cursor = start
    while cursor < end and len(segments) < max_segments:
        cycle_index = cursor // chrom_size
        next_boundary = (cycle_index + 1) * chrom_size
        piece_end = min(end, next_boundary)
        ref_start = cursor % chrom_size
        ref_end = ref_start + (piece_end - cursor)
        if ref_end > chrom_size:
            # Should only happen for defensive callers with pathological input;
            # split at the true reference boundary.
            piece_end -= ref_end - chrom_size
            ref_end = chrom_size
        if piece_end > cursor and ref_end > ref_start:
            segments.append(CircularSegment(cursor, piece_end, ref_start, ref_end))
        cursor = piece_end

    if cursor < end:
        _warn_circular_segment_truncation(start, end, chrom_size, max_segments)

    return segments


def _warn_circular_segment_truncation(start: int, end: int, chrom_size: int, max_segments: int) -> None:
    global _TRUNCATION_WARNING_EMITTED
    if _TRUNCATION_WARNING_EMITTED:
        return
    _TRUNCATION_WARNING_EMITTED = True
    logger.warning(
        "Circular viewport %s..%s on chromosome size %s was truncated at %s wrapped segments",
        start,
        end,
        chrom_size,
        max_segments,
    )


def circular_region_wraps(start: int, end: int, chrom_size: int) -> bool:
    if chrom_size <= 0 or end <= start:
        return False
    return start < 0 or end > chrom_size or (start // chrom_size) != ((end - 1) // chrom_size)


def is_short_circular_candidate(name: str, size: int, max_size: int = DEFAULT_CIRCULAR_SHORT_CHROM_MAX) -> bool:
    return is_mitochondrial_chrom(name) or int(size or 0) <= int(max_size)


def is_mitochondrial_chrom(name: str) -> bool:
    norm = str(name or "").lower().replace("_", "").replace("-", "")
    return norm in MITO_CHROM_NAMES


def chrom_circular_metadata(state, chrom: str) -> Optional[dict]:
    circular_chroms = getattr(state, "circular_chroms", {}) or {}
    if chrom in circular_chroms:
        return circular_chroms[chrom]
    translated = state.translate_chrom(chrom) if hasattr(state, "translate_chrom") else chrom
    if translated in circular_chroms:
        return circular_chroms[translated]
    normalized = str(chrom).lower()
    for entry_name, meta in circular_chroms.items():
        if str(entry_name).lower() == normalized:
            return meta
    return None


def is_circular_chrom(state, chrom: str) -> bool:
    return chrom_circular_metadata(state, chrom) is not None


def circular_chrom_size(state, chrom: str) -> Optional[int]:
    """The contig's length when it is circular, else None (linear contigs never wrap)."""
    meta = chrom_circular_metadata(state, chrom)
    if not meta:
        return None
    if meta.get("size"):
        return int(meta["size"])
    if hasattr(state, "_chrom_size_for"):
        size = state._chrom_size_for(chrom)
        return int(size) if size else None
    return None


def circular_topology_token(state, chrom: str) -> tuple:
    """Cache identity of a contig's topology as the read loaders see it
    (circular or not, and at which length): reads and coverage of a contig
    differ between the two (wrapped tails, segmented views), so every cache of
    them is keyed by this too.  Evaluated at lookup time, it also follows a
    change made through a shared reference by another session."""
    if chrom_circular_metadata(state, chrom) is None:
        return ("linear",)
    return ("circular", int(circular_chrom_size(state, chrom) or 0))


def circular_query_segments_for_region(
    state,
    chrom: str,
    start: int,
    end: int,
) -> Optional[list[tuple[int, int, int]]]:
    """Return linear reference query segments for a wrapped circular viewport."""
    chrom_size = circular_chrom_size(state, chrom)
    if not chrom_size or not circular_region_wraps(start, end, chrom_size):
        return None
    return [
        (segment.ref_start, segment.ref_end, segment.logical_start - segment.ref_start)
        for segment in circular_view_segments(start, end, chrom_size)
    ]


def shift_interval(interval, offset: int) -> list:
    shifted = list(interval)
    if len(shifted) >= 2:
        shifted[0] = int(shifted[0]) + offset
        shifted[1] = int(shifted[1]) + offset
    return shifted


def shift_compact_read(read: dict, offset: int, reference_offset: Optional[int] = None) -> dict:
    """Shift a viewport-relative compact-read payload by `offset` bp.

    ``reference_offset`` (a wrapped view's segment: ``logical_start -
    ref_start``) also moves the read's absolute alignment extent into the
    view's logical coordinates, as ``alignment_spans`` (its own, or its
    ``reference_start``/``end``), so analyses see where its bases are."""
    out = dict(read)
    if reference_offset is not None:
        spans = read.get("alignment_spans")
        if not spans:
            rs, re_ = read.get("reference_start"), read.get("reference_end")
            spans = [[rs, re_]] if isinstance(rs, int) and isinstance(re_, int) and re_ > rs else []
        if spans:
            out["alignment_spans"] = [[int(lo) + reference_offset, int(hi) + reference_offset] for lo, hi in spans]
    out["intervals"] = [shift_interval(iv, offset) for iv in read.get("intervals") or []]
    for key in ("methyl", "methyl_m6a", "methyl_m5c"):
        if key in read:
            out[key] = [int(pos) + offset for pos in read.get(key) or []]
    if "deam" in read:
        out["deam"] = [
            [int(event[0]) + offset, event[1] if len(event) > 1 else 0]
            for event in read.get("deam") or []
            if event
        ]
    if "fire" in read:
        out["fire"] = [shift_interval(iv, offset) for iv in read.get("fire") or []]
    if "layers" in read:
        shifted_layers = {}
        for layer_name, layer in (read.get("layers") or {}).items():
            shifted_layer = dict(layer)
            shifted_layer["intervals"] = [
                shift_interval(iv, offset)
                for iv in layer.get("intervals") or []
            ]
            shifted_layers[layer_name] = shifted_layer
        out["layers"] = shifted_layers
    return out


def _append_optional_values(target: dict, source: dict, key: str) -> None:
    values = source.get(key)
    if values:
        target.setdefault(key, []).extend(values)


def _read_position_sort_key(read: dict) -> int:
    candidates: list[int] = []
    for interval in read.get("intervals") or []:
        if len(interval) >= 1:
            candidates.append(int(interval[0]))
    for interval in read.get("fire") or []:
        if len(interval) >= 1:
            candidates.append(int(interval[0]))
    for key in ("methyl", "methyl_m6a", "methyl_m5c"):
        candidates.extend(int(pos) for pos in read.get(key) or [])
    for event in read.get("deam") or []:
        if event:
            candidates.append(int(event[0]))
    for layer in (read.get("layers") or {}).values():
        for interval in layer.get("intervals") or []:
            if len(interval) >= 1:
                candidates.append(int(interval[0]))
    return min(candidates) if candidates else 0


# Alignment identity and strand fields a merged row keeps from its parts (the
# same fields a broad-cache read keeps when it is cropped to a viewport).
_ROW_IDENTITY_KEYS = (
    "library_id", "source_path", "record_sha256", "alignment_occurrence",
    "reference_start", "reference_end", "alignment_orientation",
    "chemical_strand", "daf_strand", "strand", "_original_id", "bigbed_sample",
    # Absolute-coordinate SV events (services/sv_events.py): the record's own.
    "sv",
)


def _alignment_identity_key(read: dict) -> tuple:
    """Which alignment record a segment's row is a part of: the record digest
    and occurrence (exact duplicates stay apart), else its bounds and
    orientation, per source file; a row with no alignment identity (BigBed)
    by name (and sample)."""
    read_id = str(read.get("id", ""))
    if read.get("record_sha256") is not None:
        return ("record", read_id, read.get("library_id"), read.get("source_path"),
                read.get("record_sha256"), read.get("alignment_occurrence"))
    if read.get("reference_start") is not None and read.get("reference_end") is not None:
        return ("bounds", read_id, read.get("library_id"), read.get("source_path"),
                read.get("reference_start"), read.get("reference_end"), read.get("alignment_orientation"))
    return ("name", read_id, read.get("bigbed_sample"))


def merge_compact_reads_by_id(reads: Iterable[dict]) -> list[dict]:
    """Merge segmented circular payloads so one alignment record remains one
    row: its parts in the view's segments (either side of the seam, or one
    per revolution) join, while distinct records sharing a name (exact
    duplicates, the same QNAME in two files) stay separate rows.  The row
    keeps its alignment identity and the union of its parts'
    ``alignment_spans``."""
    grouped: dict[tuple, list[dict]] = {}
    order: list[tuple] = []

    for read in reads:
        read_id = str(read.get("id", ""))
        if not read_id:
            continue
        key = _alignment_identity_key(read)
        if key not in grouped:
            grouped[key] = []
            order.append(key)
        grouped[key].append(read)

    result: list[dict] = []
    for key in order:
        parts = grouped[key]
        target = {"id": key[1], "intervals": []}
        for identity_key in _ROW_IDENTITY_KEYS:
            for part in parts:
                if identity_key in part:
                    target[identity_key] = part[identity_key]
                    break
        spans = [span for part in parts for span in part.get("alignment_spans") or []]
        if spans:
            target["alignment_spans"] = merged_spans(spans)
        for read in sorted(parts, key=_read_position_sort_key):
            if read.get("duplicate"):
                target["duplicate"] = True
            target["intervals"].extend([list(iv) for iv in read.get("intervals") or []])
            _append_optional_values(target, read, "qualities")
            for key in ("methyl", "methyl_m6a", "methyl_m5c", "deam", "fire"):
                _append_optional_values(target, read, key)

            for key in ("circular_ids", "annotation_names"):
                _append_optional_values(target, read, key)

            layers = read.get("layers") or {}
            if layers:
                target_layers = target.setdefault("layers", {})
                for layer_name, layer in layers.items():
                    dest = target_layers.setdefault(layer_name, {"intervals": []})
                    dest["intervals"].extend([list(iv) for iv in layer.get("intervals") or []])
                    if layer.get("qualities") is not None:
                        existing = dest.setdefault("qualities", [[] for _ in layer.get("qualities")])
                        while len(existing) < len(layer.get("qualities")):
                            existing.append([])
                        for i, qtrack in enumerate(layer.get("qualities") or []):
                            existing[i].extend(qtrack)
                    if layer.get("quality_names") is not None:
                        dest["quality_names"] = layer.get("quality_names")
                    for meta_key in ("circular_ids", "annotation_names"):
                        if layer.get(meta_key):
                            dest.setdefault(meta_key, []).extend(layer.get(meta_key) or [])
        result.append(target)
    return result


# ── Origin-spanning alignments (SAM circular representation) ────────────────
#
# The SAM spec's preferred form for a read across the origin of a circular
# contig (``@SQ TP:circular``) is one record whose alignment runs past the
# contig end: POS near the end, reference_end > LN.  ``fiberhmm-pipeline``
# writes plasmid reads that way.  Such a record is found by an index query of
# the contig's first bases only at ``[start + LN, end + LN)``; its part there
# (the "tail") belongs at ``position - LN``.
#
# Display windows are linear windows inside [0, LN) (a wrapped circular view
# is split into such windows), so positions >= LN of a record are never shown
# where it starts: the tail pass is the only place they are drawn, and nothing
# is drawn twice.

from services.byte_cache import shared_cache
_BAM_TOPOLOGY_CACHE = shared_cache('indexes')
MAX_WRAP_PASSES = 4


def header_circular_contigs(header) -> dict[str, int]:
    """``{contig: length}`` for the ``@SQ TP:circular`` contigs of a BAM header
    (a pysam AlignmentHeader or its ``to_dict()``)."""
    try:
        header_dict = header.to_dict() if hasattr(header, "to_dict") else dict(header or {})
    except Exception:
        return {}
    out: dict[str, int] = {}
    for sq in header_dict.get("SQ") or []:
        if str(sq.get("TP", "")).lower() == "circular" and sq.get("SN") and sq.get("LN"):
            out[str(sq["SN"])] = int(sq["LN"])
    return out


def bam_circular_contigs(bam) -> dict[str, int]:
    """``header_circular_contigs`` of an open BAM, cached per handle."""
    header = getattr(bam, "header", None)
    if header is None:
        return {}
    key = (getattr(bam, "filename", None), id(header))
    cached = _BAM_TOPOLOGY_CACHE.get(key)
    if cached is None:
        cached = header_circular_contigs(header)
        _BAM_TOPOLOGY_CACHE[key] = cached
    return cached


def bam_wrap_length(bam, contig: str, flagged_circular: bool = False) -> Optional[int]:
    """The length origin-spanning records of ``contig`` wrap at, or None.

    A contig wraps when the BAM declares it ``TP:circular`` or the browser
    treats it as circular (``flagged_circular``); the BAM's own length is used
    either way, since that is what its alignments run past."""
    circular = bam_circular_contigs(bam)
    if contig in circular:
        return circular[contig]
    if not flagged_circular:
        return None
    try:
        length = int(bam.get_reference_length(contig))
    except Exception:
        return None
    return length or None


def wrap_passes(region_start: int, region_end: int, wrap_length: Optional[int]) -> list[int]:
    """Offsets ``k * wrap_length`` (k >= 1) to query for tails overlapping a
    window of a wrapping contig; none when the window does not start inside it."""
    if not wrap_length or wrap_length <= 0 or region_end <= region_start:
        return []
    if not (0 <= region_start < wrap_length):
        return []
    return [k * wrap_length for k in range(1, MAX_WRAP_PASSES + 1)]


def merged_spans(spans) -> list[list[int]]:
    """Sorted spans with overlapping/abutting ones joined."""
    out: list[list[int]] = []
    for lo, hi in sorted((int(s[0]), int(s[1])) for s in spans or [] if len(s) >= 2 and s[1] > s[0]):
        if out and lo <= out[-1][1]:
            out[-1][1] = max(out[-1][1], hi)
        else:
            out.append([lo, hi])
    return out


def alignment_spans_cover(read: dict, start: int, end: int) -> Optional[bool]:
    """Whether a read's projected alignment covers [start, end), from its
    ``alignment_spans`` (set on reads with a wrapped part); None without them."""
    spans = read.get("alignment_spans")
    if not spans:
        return None
    return any(lo <= start and hi >= end for lo, hi in merged_spans(spans))


_PART_LIST_KEYS = (
    "intervals", "qualities", "methyl", "methyl_m6a", "methyl_m5c", "deam",
    "possible_deam_ct", "possible_deam_ga", "fire", "cigar", "alignment_spans",
)


def concat_compact_read_parts(parts: list[dict]) -> dict:
    """Join compact-read parts of ONE alignment record, given in frame order.

    The parts are the record's wrapped tail(s) and its head, built in the same
    window frame and not overlapping.  The last part (the head, when present)
    keeps its identity and other scalar fields; every positional list is
    concatenated in order, and layer lists stay parallel (qualities per track,
    names, unclipped source intervals)."""
    from services.bam_tags import _merge_layer_sections

    if len(parts) == 1:
        return parts[0]
    out = dict(parts[-1])
    for key in _PART_LIST_KEYS:
        values: list = []
        present = False
        for part in parts:
            if key in part:
                present = True
                values.extend(part.get(key) or [])
        if present:
            out[key] = values
    layers: dict = {}
    for part in parts:
        for name, layer in (part.get("layers") or {}).items():
            section = {k: (list(v) if isinstance(v, list) else v) for k, v in layer.items()}
            n = len(section.get("intervals") or [])
            if name not in layers:
                layers[name] = section
                continue
            existing = layers[name]
            # Keep quality tracks parallel when only one part carries them.
            if (existing.get("qualities") is None) != (section.get("qualities") is None):
                tracks = len(existing.get("qualities") or section.get("qualities") or [])
                if existing.get("qualities") is None:
                    existing["qualities"] = [[0] * len(existing.get("intervals") or []) for _ in range(tracks)]
                else:
                    section["qualities"] = [[0] * n for _ in range(tracks)]
                existing["quality_names"] = existing.get("quality_names") or section.get("quality_names")
            _merge_layer_sections(existing, section)
    if layers:
        out["layers"] = layers
    return out
