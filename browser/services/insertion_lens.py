"""Insertion lens: the chromatin inside a large insertion, in insertion-local coordinates.

FiberHMM calls and MM/ML marks are in query coordinates, and the read track
places them on the genome through the CIGAR, so every inserted base collapses
onto the insertion's anchor. The lens instead gives each carrier read its own
axis, with the left breakpoint at 0:

    left flank  [-F, 0)       reference bases before the left breakpoint
    insert      [0, L_i)      the read's inserted bases (SEQ frame)
    right flank [L_i, L_i+F)  reference bases from the right breakpoint on

It does so without a second parser. Each carrier is copied with the chosen
insertion turned into an aligned block (``I`` -> ``M``, MD spliced to match)
and run through the normal compact-read loader via a one-read stub BAM
handle. Tag frames (molecular/SEQ, both strands), MA/AQ layers, legacy
ns/nl/as/al, MM/ML marks and deamination are therefore exactly what the read
track would draw, only placed in a window where the insert has coordinates.
Intervals are then split at the breakpoints (a call straddling one keeps its
whole size and is listed in ``straddles``).

Reference (non-carrier) reads that span the site go through the same loader
unspliced, so their flanks sit on the same axis with ``L_i = 0``.

Which reads are carriers, reference or neither is decided by the SV module's
one rule (``sv_endpoint.classify_records`` over ``sv_events.carrier_evidence``),
so the lens and "Split by this SV" put the same reads in the same groups. A
carrier is either a CIGAR insertion (``kind: 'cigar'``, the whole insert) or a
read clipped at the breakpoint (``kind: 'clip'``): a soft clip holds part of the
insert (the start, ``partial: 'start'``, when the alignment ends at the
insertion; the end, ``partial: 'end'``, when it starts there) and is spliced in
like a CIGAR insertion; a hard clip (``hard: true``) has no inserted bases in
the record, so only its flank is drawn.
"""

from __future__ import annotations

import copy
import json
import math
import os
import re
import threading
import time

from services.sv_conflicts import normalize_conflict_options
from services.byte_cache import shared_cache
from services.sv_alleles import reference_key as _reference_key
from typing import Any, Callable, Iterable, Optional

from services.sv_events import (
    SV_LENGTH_TOL_FRAC,
    SV_SPAN_MARGIN,
    breakpoint_tolerance,
    cluster_sv_events,
    extract_sv_events,
    sv_extraction_floor,
    insertion_clip_tolerance,
    normalize_min_sv_len,
    sv_summary_for_reads,
    alignment_evidence,
)

DEFAULT_FLANK = 1000
MAX_FLANK = 5000
DEFAULT_TOLERANCE = 50
DEFAULT_MIN_LEN = 50
DEFAULT_MAX_CARRIERS = 300
DEFAULT_MAX_REFERENCE = 100
MAX_CLUSTER_REGION = 2_000_000

_S = 4
_H = 5
_M = 0
_I = 1
_REF_CONSUMING = (0, 2, 3, 7, 8)

# Position-bearing fields of a compact read (see compact_read_loader).
_POINT_FIELDS = ("methyl", "methyl_m6a", "methyl_m5c")
_PAIR_FIELDS = ("deam", "possible_deam_ct", "possible_deam_ga")
_IDENTITY_FIELDS = frozenset({
    "library_id", "reference_start", "reference_end", "alignment_orientation",
    "record_sha256", "alignment_occurrence",
})


# ---------------------------------------------------------------------------
# Choosing carriers


def insertion_span(cigartuples, reference_start: int, q: int, length: int) -> tuple[int, int]:
    """(reference position after the insertion's query span ``[q, q+len)``,
    number of ``I`` pieces in it): the span of a joined insertion consumes the
    few aligned reference bases between its pieces."""
    q_end = int(q) + int(length)
    ref = int(reference_start)
    qpos = 0
    pieces = 0
    for op, n in cigartuples or ():
        consumes_query = op in (0, 1, 4, 7, 8)
        consumes_ref = op in _REF_CONSUMING
        if op == _I and int(q) <= qpos < q_end:
            pieces += 1
        if consumes_query and qpos < q_end <= qpos + n:
            return (ref + (q_end - qpos if consumes_ref else 0)), max(1, pieces)
        if consumes_query:
            qpos += n
        if consumes_ref:
            ref += n
    return ref, max(1, pieces)


def resolve_cluster(records: Iterable, *, pos: int, tolerance: int, len_min: int,
                    len_max: Optional[int], reference=None) -> Optional[dict]:
    """The insertion cluster at a clicked position (sv_events clustering, as
    the SV summary does): of the clusters within ``tolerance`` of ``pos`` and
    in the length range, the one with most carriers, nearest on ties."""
    floor = normalize_min_sv_len(min(DEFAULT_MIN_LEN, int(len_min)))
    compact = []
    for item in records:
        read = item[0]
        events = extract_sv_events(read, sv_extraction_floor(floor), reference=reference)
        if events:
            compact.append({"id": read.query_name, "sv": events})
    clusters, _clips = cluster_sv_events(compact, pos - tolerance, pos + tolerance + 1, floor)
    best = None
    for c in clusters:
        if c["t"] != "I" or c["len"] < len_min or (len_max is not None and c["len"] > len_max):
            continue
        key = (-len(c["members"]), abs(c["ref"] - pos))
        if best is None or key < best[0]:
            best = (key, c)
    return {"t": "I", "ref": int(best[1]["ref"]), "len": int(best[1]["len"])} if best else None


def soft_clip_len(read, side: str) -> int:
    """Soft-clipped bases at one end (``L`` or ``R``): SEQ holds them."""
    if side == "L":
        return int(read.query_alignment_start or 0)
    return max(0, int(read.query_length or 0) - int(read.query_alignment_end or 0))


# ---------------------------------------------------------------------------
# Splicing a carrier


def _replacement_ops(cigartuples, reference_start, event):
    """Complete raw replacement, including zero-query boundary deletions."""
    q0 = int(event['q'])
    q1 = int(event.get('q_end', q0 + event['len']))
    r0 = event.get('raw_ref', event.get('ref'))
    r1 = event.get('raw_ref_end', event.get('ref_end'))
    q, ref, first = 0, reference_start, None
    for i, (op, n) in enumerate(cigartuples):
        if first is None and q == q0 and (op in (1, 2) if r0 is not None else op == 1) and (r0 is None or ref == r0):
            first = i
        q += n if op in (0, 1, 4, 7, 8) else 0
        ref += n if op in (0, 2, 3, 7, 8) else 0
        if first is not None and q == q1 and (r1 is None or ref == r1):
            return first, i + 1
    raise ValueError('replacement span does not end on CIGAR operation boundaries')


def splice_cigar(cigartuples: list[tuple[int, int]], reference_start: int, event: dict) -> list[tuple[int, int]]:
    """Replace the complete raw reference/query interval by aligned query bases."""
    first, last = _replacement_ops(cigartuples, reference_start, event)
    out = []
    for op, n in [*cigartuples[:first], (_M, int(event.get('q_end', event['q'] + event['len'])) - event['q']),
                  *cigartuples[last:]]:
        _append(out, op, n)
    return out


def _append(out: list[tuple[int, int]], op: int, length: int) -> None:
    if length <= 0:
        return
    if out and out[-1][0] == op and op == _M:
        out[-1] = (op, out[-1][1] + length)
    else:
        out.append((op, length))


_MD_TOKEN = re.compile(r"(\d+)|(\^[A-Za-z]+)|([A-Za-z])")


def _md_tokens(md: str) -> list[tuple[str, Any, int, int]]:
    """MD as (kind, value, start, end) in MD coordinates (reference bases the MD covers)."""
    tokens: list[tuple[str, Any, int, int]] = []
    pos = 0
    for number, deletion, mismatch in _MD_TOKEN.findall(md):
        if number:
            kind, value, span = "m", int(number), int(number)
        elif deletion:
            kind, value, span = "d", deletion[1:], len(deletion) - 1
        else:
            kind, value, span = "x", mismatch, 1
        tokens.append((kind, value, pos, pos + span))
        pos += span
    return tokens


def _md_clip(tokens, lo: int, hi: Optional[int], *, keep_deletions: bool = True) -> list[tuple[str, Any]]:
    kept: list[tuple[str, Any]] = []
    for kind, value, start, end in tokens:
        top = end if hi is None else min(end, hi)
        bottom = max(start, lo)
        if kind == "m":
            if top > bottom:
                kept.append(("m", top - bottom))
            continue
        inside = start >= lo and (hi is None or end <= hi)
        if inside:
            if kind == "x" or keep_deletions:
                kept.append((kind, value))
        elif top > bottom:
            raise ValueError("an MD deletion crosses an operation boundary")
    return kept


def _md_string(tokens: list[tuple[str, Any]]) -> str:
    parts: list[str] = []
    pending = 0
    for kind, value in tokens:
        if kind == "m":
            pending += value
            continue
        parts.append(str(pending))
        pending = 0
        parts.append(("^" + value) if kind == "d" else value)
    parts.append(str(pending))
    return "".join(parts)


def splice_md(md: str, cigartuples: list[tuple[int, int]], event: dict, *, reference_start=0) -> str:
    """MD for the spliced alignment (``splice_cigar``).

    MD covers the bases of M/=/X and D operations (not N). Inside the merged
    insert span, inserted bases become matches (there is no reference for them),
    bases of matched bridge operations keep their mismatches (they are aligned to
    the reference), and the span's deletions disappear (the spliced block has no
    deletion). Outside the span the MD is unchanged.
    """
    tokens = _md_tokens(md)
    first, last = _replacement_ops(cigartuples, reference_start, event)
    md_pos = 0
    out = []
    for i, (op, n) in enumerate(cigartuples):
        span = n if op in (0, 2, 7, 8) else 0
        if i == first:
            out.extend(_md_clip(tokens, 0, md_pos))
        if first <= i < last:
            if op == _I:
                out.append(('m', n))
            elif op in (0, 7, 8):
                out.extend(_md_clip(tokens, md_pos, md_pos + n))
        md_pos += span
        if i == last - 1:
            out.extend(_md_clip(tokens, md_pos, None))
    return _md_string(out)


def splice_read(read, event: dict):
    """A copy of ``read`` whose chosen insertion is aligned (``I`` -> ``M``)."""
    spliced = copy.copy(read)
    spliced.cigartuples = splice_cigar(list(read.cigartuples), read.reference_start, event)
    if read.has_tag("MD"):
        try:
            md = splice_md(str(read.get_tag("MD")), list(read.cigartuples), event, reference_start=read.reference_start)
            spliced.set_tag("MD", md, value_type="Z")
        except Exception:
            spliced.set_tag("MD", None)
    return spliced


def _md_pad(md: str, matches: int, side: str) -> str:
    tokens = [(kind, value) for kind, value, _a, _b in _md_tokens(md)]
    pad = [("m", int(matches))]
    return _md_string(pad + tokens if side == "L" else tokens + pad)


def splice_clip(read, side: str):
    """A copy of ``read`` whose soft clip on ``side`` is aligned (``S`` -> ``M``):
    a right clip continues past the alignment end, a left clip starts
    ``soft`` bases before the alignment start. None when nothing is soft
    clipped there or the clip would start before the contig."""
    soft = soft_clip_len(read, side)
    if soft <= 0:
        return None
    cigar = list(read.cigartuples or ())
    order = range(len(cigar)) if side == "L" else range(len(cigar) - 1, -1, -1)
    index = next((i for i in order if cigar[i][0] == _S), None)
    if index is None:
        return None
    out: list[tuple[int, int]] = []
    for i, (op, length) in enumerate(cigar):
        _append(out, _M if i == index else op, length)
    spliced = copy.copy(read)
    if side == "L":
        start = int(read.reference_start) - soft
        if start < 0:
            return None
        spliced.reference_start = start
    spliced.cigartuples = out
    if read.has_tag("MD"):
        try:
            spliced.set_tag("MD", _md_pad(str(read.get_tag("MD")), soft, side), value_type="Z")
        except Exception:
            spliced.set_tag("MD", None)
    return spliced


_HEADER_DICTS: "dict[int, tuple[Any, dict]]" = {}


def _header_dict(bam) -> Any:
    """The handle's header as a dict, once per handle: the loader reads it
    three times per call (tag frames, consensus contracts), and converting a
    large header each time cost ~3 s over a 300-carrier lens."""
    header = bam.header
    cached = _HEADER_DICTS.get(id(bam))
    if cached is not None and cached[0] is header:
        return cached[1]
    try:
        value = header.to_dict() if hasattr(header, "to_dict") else header
    except Exception:
        return header
    if len(_HEADER_DICTS) > 64:
        _HEADER_DICTS.clear()
    _HEADER_DICTS[id(bam)] = (header, value)
    return value


class _OneReadHandle:
    """Enough of a ``pysam.AlignmentFile`` for the region loader to read one record."""

    def __init__(self, bam, read):
        self.header = _header_dict(bam)
        self.references = bam.references
        self._read = read

    def fetch(self, *_args, **_kwargs):
        yield self._read


# ---------------------------------------------------------------------------
# Lens-local coordinates and breakpoint splitting


def _shift_point_list(values, shift: int):
    return [int(v) - shift for v in values]


def to_lens_local(read_data: dict, flank: int) -> dict:
    """Shift every position of a compact read by ``-flank`` (left breakpoint -> 0).

    The record-identity fields (consensus projection) describe the spliced
    copy, not a BAM record, so they are left out."""
    out = {key: value for key, value in read_data.items() if key not in _IDENTITY_FIELDS}
    if "intervals" in out:
        out["intervals"] = [[int(s) - flank, int(e) - flank, *rest] for s, e, *rest in out["intervals"]]
    if "fire" in out:
        out["fire"] = [[int(s) - flank, int(e) - flank, *rest] for s, e, *rest in out["fire"]]
    for field in _POINT_FIELDS:
        if field in out:
            out[field] = _shift_point_list(out[field], flank)
    for field in _PAIR_FIELDS:
        if field in out:
            out[field] = [[int(item[0]) - flank, *item[1:]] for item in out[field]]
    if "layers" in out:
        layers = {}
        for name, layer in out["layers"].items():
            layer = dict(layer)
            layer["intervals"] = [[int(s) - flank, int(e) - flank, *rest] for s, e, *rest in layer.get("intervals") or []]
            if layer.get("source_intervals"):
                # The unclipped call extents, in the same region-relative frame.
                layer["source_intervals"] = [
                    [int(s) - flank, int(e) - flank, *rest] for s, e, *rest in layer["source_intervals"]
                ]
            layers[name] = layer
        out["layers"] = layers
    return out


def _split_intervals(intervals: list, breakpoints: list[int], layer: str,
                     straddles: list[dict]) -> tuple[list, list[int]]:
    """Split ``[s, e, size, ...]`` at ``breakpoints``; also return each piece's source index."""
    new_intervals: list = []
    origin: list[int] = []
    for index, interval in enumerate(intervals):
        s, e = int(interval[0]), int(interval[1])
        rest = list(interval[2:])
        cuts = [b for b in breakpoints if s < b < e]
        if cuts:
            straddles.append({
                "layer": layer, "start": s, "end": e,
                "size": rest[0] if rest else e - s,
                "side": "".join("L" if b == 0 else "R" for b in cuts),
            })
        bounds = [s, *cuts, e]
        for lo, hi in zip(bounds, bounds[1:]):
            new_intervals.append([lo, hi, *rest])
            origin.append(index)
    return new_intervals, origin


def _follow(values: list, origin: list[int]) -> list:
    return [values[i] if i < len(values) else None for i in origin]


def split_at_breakpoints(read_data: dict, insert_len: int) -> dict:
    """Split every interval of a lens-local read at 0 and ``insert_len``.

    Pieces keep the whole call's size (third slot), so a nucleosome straddling
    a breakpoint is still drawn and classified as a nucleosome on each side.
    Per-interval data follows its interval: the read's flat ``qualities``, a
    layer's channel-major ``qualities`` (``[channel][interval]``) and any other
    per-interval layer list (source intervals, names). The whole calls are
    listed in ``straddles``.
    """
    breakpoints = sorted({0, int(insert_len)})
    out = dict(read_data)
    straddles: list[dict] = []
    if out.get("intervals"):
        n = len(out["intervals"])
        out["intervals"], origin = _split_intervals(out["intervals"], breakpoints, "primary", straddles)
        if isinstance(out.get("qualities"), list) and len(out["qualities"]) == n:
            out["qualities"] = _follow(out["qualities"], origin)
    if out.get("fire"):
        out["fire"], _ = _split_intervals(out["fire"], breakpoints, "fire", straddles)
    if out.get("layers"):
        layers = {}
        for name, layer in out["layers"].items():
            layer = dict(layer)
            intervals = layer.get("intervals") or []
            n = len(intervals)
            layer["intervals"], origin = _split_intervals(intervals, breakpoints, name, straddles)
            for key, value in list(layer.items()):
                if key in ("intervals", "quality_names") or not isinstance(value, list):
                    continue
                if key == "qualities":
                    layer[key] = [
                        _follow(channel, origin) if isinstance(channel, list) and len(channel) == n else channel
                        for channel in value
                    ]
                elif len(value) == n:
                    layer[key] = _follow(value, origin)
            layers[name] = layer
        out["layers"] = layers
    if straddles:
        out["straddles"] = straddles
    return out


# ---------------------------------------------------------------------------
# The endpoint workflow


_cache = shared_cache('profiles')
_cache_lock = threading.Lock()


def _file_stamp(path: str) -> tuple:
    try:
        stat = os.stat(path)
        return (stat.st_mtime_ns, stat.st_size)
    except OSError:
        return (None, None)


def _strand(read) -> str:
    return "-" if read.is_reverse else "+"


def _evenly(items: list, limit: int) -> list:
    """At most ``limit`` items spread evenly over ``items`` (0: none)."""
    if limit <= 0:
        return []
    if len(items) <= limit:
        return list(items)
    step = len(items) / limit
    return [items[int(i * step)] for i in range(limit)]


def _site_records(bam_paths, chrom, start, end, *, bam_handle_getter, chrom_map, contig_links, include_duplicates=True):
    """(record, file chromosome, path, handle) of the primary alignments in ``[start, end)``."""
    from utils.chrom import resolve_reference_name
    from services.signal_evidence import signal_header, record_keeps_signal

    for bam_path in bam_paths:
        bam = bam_handle_getter(bam_path)
        if bam is None:
            continue
        actual = resolve_reference_name(chrom, bam.references, chrom_map or {}, links=contig_links)
        if actual is None:
            continue
        provenance = signal_header(bam.header)
        from services.graph_lift import lift_hidden_predicate
        hidden = lift_hidden_predicate(getattr(bam, "header", None))
        from services.sv_molecules import molecule_bundles
        def eligible(read):
            if read.is_unmapped or read.is_secondary:
                return None
            if hidden is not None and hidden(read):
                return None
            return record_keeps_signal(read, provenance) and (include_duplicates or not getattr(read, 'is_duplicate', False))
        for bundle in molecule_bundles(bam.fetch(actual, max(0, int(start)), int(end)), eligible):
            for read in bundle:
                yield read, actual, bam_path, bam


def _empty_read(read) -> dict:
    """A row for a read the loader returned nothing for (no calls in the window)."""
    return {"id": read.query_name, "intervals": [], "no_calls": True}


_KIND_ORDER = {("cigar", None): 0, ("clip", "start"): 1, ("clip", "end"): 2, ("hard", "start"): 3, ("hard", "end"): 4}


def _carrier_plan(read, evidence: dict, cluster_len: int) -> dict:
    """How one carrier is drawn: which bases are its insert and where its axis starts."""
    if evidence["kind"] == "cigar":
        event = evidence["event"]
        query_len = int(event.get('q_end', event['q'] + event['len'])) - int(event['q'])
        ref_end, pieces = insertion_span(read.cigartuples, read.reference_start, event["q"], query_len)
        ref_end = int(event.get('raw_ref_end', ref_end))
        return {"kind": "cigar", "partial": None, "ref": int(event.get('raw_ref', event["ref"])),
                "ref_end": ref_end, "q": int(event["q"]), 'allele_len': int(event['len']),
                'canonical_ref_len': event.get('ref_len', ref_end - int(event.get('raw_ref', event['ref']))),
                **({'canonical_alt_seq': event['alt_seq']} if event.get('normalized') else {}),
                "len": query_len, "pieces": pieces}
    clip = evidence["clip"]
    side = clip["side"]
    partial = "start" if side == "R" else "end"
    soft = soft_clip_len(read, side)
    plen = min(soft, int(cluster_len)) if soft > 0 else 0
    # A right clip's insert starts at its first clipped base; a left clip's ends at its last.
    q = int(clip["q"]) if side == "R" else soft - plen
    return {"kind": "clip" if soft > 0 else "hard", "partial": partial, "side": side, "ref": int(clip["ref"]),
            "ref_end": int(clip["ref"]), "q": q, "len": plen, "soft": soft, "clip_len": int(clip["len"])}


def classify_site(bam_paths, chrom, *, pos: int, tolerance: int = DEFAULT_TOLERANCE,
                  len_min: int = DEFAULT_MIN_LEN, len_max: Optional[int] = None,
                  ref: Optional[int] = None, length: Optional[int] = None, margin: int = SV_SPAN_MARGIN,
                  include_duplicates: bool = False, bam_handle_getter=None, chrom_map=None,
                  contig_links=None, reference=None, conflict_options=None) -> dict:
    """The insertion at a site and its reads: ``{success, ref, length, margin, carriers:
    [(plan, record, path, handle)], reference: [(record, path, handle)], excluded}``.

    ``ref``/``length``: the insertion (an SV summary cluster, as "Split by this SV" gets
    it). Without them the cluster is found at ``pos`` (within ``tolerance``, length in
    ``[len_min, len_max]``); either way the reads are then classified by
    ``sv_endpoint.classify_records`` for that insertion (the lens and the alt-allele panel
    take the same carriers)."""
    from services.sv_endpoint import classify_records

    if bam_handle_getter is None:
        from services.bam_handles import get_bam_handle as bam_handle_getter
    records = dict(bam_handle_getter=bam_handle_getter, chrom_map=chrom_map, contig_links=contig_links,
                   include_duplicates=include_duplicates)
    if ref is None or length is None:
        cluster = resolve_cluster(
            _site_records(bam_paths, chrom, pos - tolerance - 1, pos + tolerance + 1, **records),
            pos=int(pos), tolerance=int(tolerance), len_min=int(len_min), len_max=len_max, reference=reference,
        )
        if cluster is None:
            return {"success": False, "error": (
                f"No insertion of {int(len_min)} bp or more within {int(tolerance)} bp of "
                f"{chrom}:{int(pos) + 1:,}")}
        ref, length = cluster["ref"], cluster["len"]
    ref = int(ref)
    length = int(length)
    margin = max(0, int(margin))
    # A matching event may be up to 1 / (1 - 20%) times as long, and its
    # breakpoint tolerance follows the longer length (events_match).
    longest = math.ceil(length / (1 - SV_LENGTH_TOL_FRAC)) + 1
    reach = int(math.ceil(max(margin, insertion_clip_tolerance(length), breakpoint_tolerance(longest)))) + 1
    by_name = classify_records(
        _site_records(bam_paths, chrom, min(ref - reach, pos - tolerance - 1), max(ref + reach, pos + tolerance + 1), **records),
        t="I", ref=ref, length=length, margin=margin, include_duplicates=include_duplicates, reference=reference, conflict_options=conflict_options,
    )

    carriers_all = []
    reference_all = []
    excluded = {"other_insert": 0, "not_informative": 0}
    for name, entry in by_name.items():
        read, _file_chrom, path, bam = entry["record"]
        if (entry['evidence'] or {}).get('level') is not None:
            plan = {**_carrier_plan(read, entry["evidence"], length), 'evidence_level': entry['evidence']['level'], 'evidence_reason': entry['evidence'].get('reason'),
                    'evidence_bundle': [call['read'] for call in entry['evidence_bundle']]}
            carriers_all.append((plan, read, path, bam))
        elif entry["allele"] == 1:
            reference_all.append((read, path, bam))
        elif (entry["evidence"] or {}).get("kind") == "other":
            excluded["other_insert"] += 1
        else:
            excluded["not_informative"] += 1
    return {"success": True, "ref": ref, "length": length, "margin": margin, "carriers": carriers_all,
            "reference": reference_all, "excluded": excluded}


def build_lens(
    bam_paths: list[str],
    chrom: str,
    *,
    pos: int,
    tolerance: int = DEFAULT_TOLERANCE,
    len_min: int = DEFAULT_MIN_LEN,
    len_max: Optional[int] = None,
    ref: Optional[int] = None,
    length: Optional[int] = None,
    margin: int = SV_SPAN_MARGIN,
    flank: int = DEFAULT_FLANK,
    max_carriers: int = DEFAULT_MAX_CARRIERS,
    max_reference: int = DEFAULT_MAX_REFERENCE,
    consensus: bool = True,
    include_sequences: bool = False,
    loader: Optional[Callable[..., list]] = None,
    loader_kwargs: Optional[dict] = None,
    bam_handle_getter=None,
    chrom_map=None,
    contig_links=None,
    include_duplicates: bool = False,
    daf: bool = False,
    reference=None,
    conflict_options=None,
) -> dict:
    """The lens payload for one insertion across ``bam_paths``.

    ``daf``: a DAF dataset (DddA/DddB), whose consensus is FiberHMM's DAF-aware one when
    the FiberHMM this Browser runs provides it (else, and for Fiber-seq, a majority vote);
    ``consensus.method`` says which.

    ``ref``/``length``: the insertion (an SV summary cluster, as "Split by this
    SV" gets it). Without them the cluster is found at ``pos`` (within
    ``tolerance``, length in ``[len_min, len_max]``); either way the reads are
    then classified by ``sv_endpoint.classify_records`` for that insertion."""
    from services.compact_read_loader import _build_compact_reads_from_bam_region

    if bam_handle_getter is None:
        from services.bam_handles import get_bam_handle as bam_handle_getter
    loader = loader or _build_compact_reads_from_bam_region
    loader_kwargs = dict(loader_kwargs or {})
    flank = max(0, min(int(flank), MAX_FLANK))
    started = time.perf_counter()
    records = dict(bam_handle_getter=bam_handle_getter, chrom_map=chrom_map, contig_links=contig_links)

    site = classify_site(bam_paths, chrom, pos=pos, tolerance=tolerance, len_min=len_min, len_max=len_max,
                         ref=ref, length=length, margin=margin, include_duplicates=include_duplicates, reference=reference, conflict_options=conflict_options, **records)
    if not site["success"]:
        return site
    ref, length, margin = site["ref"], site["length"], site["margin"]
    carriers_all, reference_all, excluded = site["carriers"], site["reference"], site["excluded"]
    total_carriers = len(carriers_all)
    total_reference = len(reference_all)
    counts = {"cigar": 0, "clip": 0, "hard": 0}
    for plan, *_rest in carriers_all:
        counts[plan["kind"]] += 1

    # Evenly over the kinds and lengths, so a cap keeps their proportions.
    carriers_all.sort(key=lambda item: (_KIND_ORDER[(item[0]["kind"], item[0]["partial"])], item[0]["len"],
                                        item[1].query_name, item[2]))
    carriers_out: list[dict] = []
    full_seqs: list[str] = []
    canonical_seqs: list[str] = []
    daf_compatible = True
    full_records: list[tuple] = []
    full_entries: list[dict] = []
    partial_items: list[tuple[str, str]] = []
    partial_entries: list[dict] = []
    for plan, read, bam_path, bam in _evenly(carriers_all, max_carriers):
        ins_len = int(plan["len"])
        if plan["kind"] == "cigar":
            source = splice_read(read, plan)
            origin = plan["ref"]
        elif plan["kind"] == "clip":
            source = splice_clip(read, plan["side"])
            origin = plan["ref"] if plan["partial"] == "start" else plan["ref"] - ins_len
        else:
            source = None
            origin = plan["ref"]
        if source is None:
            # Hard clip (or a soft clip that cannot be placed): its flank only.
            source = read
            ins_len = 0
            origin = plan["ref"]
            plan = {**plan, "kind": "hard", "len": 0}
        loaded = loader(
            bam_path, chrom, origin - flank, origin + ins_len + flank,
            spanning_only=False,
            bam_handle_getter=lambda _p, _bam=bam, _r=source: _OneReadHandle(_bam, _r),
            chrom_map=chrom_map, contig_links=contig_links,
            include_duplicates=True,
            **loader_kwargs,
        )
        entry = {
            "id": read.query_name,
            "strand": _strand(read),
            "kind": "cigar" if plan["kind"] == "cigar" else "clip",
            "evidence_level": plan['evidence_level'], "evidence_reason": plan.get('evidence_reason'),
            "evidence_bundle": plan['evidence_bundle'],
            "ref": int(plan["ref"]),
            "ref_end": int(plan["ref_end"]),
            "q": int(plan["q"]),
            "len": ins_len,
            "inserted_len": plan.get('allele_len', ins_len),
            # A carrier with no calls in the window still gets its (empty) row.
            "read": split_at_breakpoints(to_lens_local(loaded[0] if loaded else _empty_read(read), flank), ins_len),
        }
        if plan["kind"] == "cigar":
            entry["pieces"] = int(plan["pieces"])
        else:
            entry["partial"] = plan["partial"]
            entry["clip_len"] = int(plan["clip_len"])
            if plan["kind"] == "hard":
                entry["hard"] = True
            if read.has_tag("SA"):
                entry["sa"] = True
        carriers_out.append(entry)
        if ins_len > 0:
            seq = read.query_sequence or ""
            insert = seq[plan["q"]:plan["q"] + ins_len]
            if include_sequences:
                entry["seq"] = insert
            if plan["kind"] == "cigar":
                full_seqs.append(insert)  # knots remain on the observed query axis
                canonical = plan.get('canonical_alt_seq', insert)
                canonical_seqs.append(canonical)
                daf_compatible &= canonical == insert or (plan['ref_end'] == plan['ref'] and len(canonical) == ins_len)
                full_records.append((read, plan["q"], ins_len, canonical))
                full_entries.append(entry)
            else:
                partial_items.append((insert, plan["partial"]))
                partial_entries.append(entry)

    reference = sorted(reference_all, key=lambda item: (item[0].query_name, item[1]))
    reference_out: list[dict] = []
    for read, bam_path, bam in _evenly(reference, max_reference):
        loaded = loader(
            bam_path, chrom, ref - flank, ref + flank,
            spanning_only=False,
            bam_handle_getter=lambda _p, _bam=bam, _r=read: _OneReadHandle(_bam, _r),
            chrom_map=chrom_map, contig_links=contig_links,
            include_duplicates=True,
            **loader_kwargs,
        )
        reference_out.append({
            "id": read.query_name,
            "strand": _strand(read),
            "ref": ref,
            "ref_end": ref,
            "len": 0,
            "read": split_at_breakpoints(to_lens_local(loaded[0] if loaded else _empty_read(read), flank), 0),
        })

    lengths = sorted(e["len"] for e in full_entries)
    payload: dict[str, Any] = {
        "success": True,
        "chrom": chrom,
        "flank": flank,
        "site": {
            "pos": int(pos),
            "tolerance": int(tolerance),
            "len_min": int(len_min),
            "len_max": int(len_max) if len_max is not None else None,
        },
        # The insertion the reads were classified for: what "Split by this SV" takes.
        "sv": {"t": "I", "ref": ref, "len": length, "margin": margin},
        "cluster": {
            "ref": ref,
            "len": length,
            "alt_len": lengths[len(lengths) // 2] if lengths else length,
            "ref_len": sorted(p['ref_end'] - p['ref'] for p, *_ in carriers_all if p['kind'] == 'cigar')[
                counts['cigar'] // 2] if counts['cigar'] else 0,
            "len_lo": lengths[0] if lengths else length,
            "len_hi": lengths[-1] if lengths else length,
            "carriers": sum(p['evidence_level'] == 'confirmed' for p, *_ in carriers_all),
            "confirmed": sum(p['evidence_level'] == 'confirmed' for p, *_ in carriers_all),
            "putative": sum(p['evidence_level'] == 'putative' for p, *_ in carriers_all),
            "conflicting": sum(p['evidence_level'] == 'conflicting' for p, *_ in carriers_all),
            "ambiguous": sum(p['evidence_level'] == 'ambiguous' for p, *_ in carriers_all),
            "evidence_total": total_carriers,
            "cigar": counts["cigar"],
            "clipped": counts["clip"] + counts["hard"],
            "hard": counts["hard"],
            "reference": total_reference,
        },
        "carriers": carriers_out,
        "reference": reference_out,
        "excluded": excluded,
        "truncated": {
            "carriers": max(0, total_carriers - min(total_carriers, max_carriers)),
            "reference": max(0, total_reference - min(total_reference, max_reference)),
        },
    }
    if consensus and full_seqs:
        from services.insertion_consensus import reconstruct_lens
        from services.reconstruction_budget import ResourceResult
        cons_started = time.perf_counter()
        try:
            reconstruction = reconstruct_lens(full_seqs, canonical_seqs, partial_items,
                                               records=full_records, daf=daf, daf_compatible=daf_compatible)
        except ResourceResult as exc:
            payload['consensus_resource'] = exc.payload()
            payload['seconds'] = round(time.perf_counter() - started, 3)
            return payload  # ordinary geometry, previews and chromatin remain available
        cons, daf_consensus = reconstruction['full'], reconstruction['daf']
        method, why_not = reconstruction['method'], reconstruction['fallback']
        for entry, read_cons in zip(full_entries, cons["reads"]):
            entry["knots"] = read_cons["knots"]
            entry["identity"] = read_cons["identity"]
        if partial_items and cons["seq"]:
            for entry, read_cons in zip(partial_entries, reconstruction['partials']):
                entry["knots"] = read_cons["knots"]
                entry["identity"] = read_cons["identity"]
        from services.insertion_consensus import METHOD_LABELS
        payload["consensus"] = {
            "status": "complete",
            "budget_version": "reconstruction:v1",
            "alignment_algorithm": reconstruction['alignment_algorithm'],
            "sampling": {"policy": "evenly_by_record_key" if daf_consensus else "evenly_by_length",
                         "input_count": len(full_seqs), "max_reads": 200 if daf_consensus else 32},
            "seq": cons["seq"],
            "length": len(cons["seq"]),
            "n_reads": (daf_consensus["carriers_ct"] + daf_consensus["carriers_ga"]) if daf_consensus
            else min(len(full_seqs), 32),
            "seconds": round(time.perf_counter() - cons_started, 3),
            "method": method,
            "method_label": METHOD_LABELS[method],
        }
        if daf_consensus:
            payload["consensus"].update({k: daf_consensus[k] for k in ("confident_fraction", "carriers_ct",
                                                                         "carriers_ga")})
        if daf and why_not:
            payload["consensus"]["fallback"] = why_not
    if daf:
        run_report = run_insert_report(bam_paths, chrom, ref, length)
        if run_report:
            payload["run_consensus"] = run_report
    payload["seconds"] = round(time.perf_counter() - started, 3)
    return payload


def find_clusters(
    bam_paths: list[str],
    chrom: str,
    start: int,
    end: int,
    *,
    min_len: int = DEFAULT_MIN_LEN,
    tolerance: int = DEFAULT_TOLERANCE,
    bam_handle_getter=None,
    chrom_map=None,
    contig_links=None,
    include_duplicates: bool = False,
    tile_cache=None,
    reference=None,
    conflict_options=None,
) -> list[dict]:
    """Insertions (>= ``min_len``) in ``[start, end)`` as the SV summary
    clusters them, with their clipped carriers counted (``clip_support``).
    ``tolerance`` is accepted for old callers; clustering uses the SV rule.
    ``tile_cache`` (a ``ResultCache``): reuse the reads' SV events of fixed
    tiles already read, so a panned view reads only its new part."""
    if bam_handle_getter is None:
        from services.bam_handles import get_bam_handle as bam_handle_getter
    min_len = max(1, int(min_len))
    # Extract at the clip floor too, so clipped carriers are seen.
    floor = normalize_min_sv_len(min(DEFAULT_MIN_LEN, min_len))
    if tile_cache is not None and bam_paths and all(_file_stamp(p)[0] is not None for p in bam_paths):
        compact = _tiled_sv_reads(bam_paths, chrom, start, end, floor, tile_cache=tile_cache,
                                  bam_handle_getter=bam_handle_getter, chrom_map=chrom_map,
                                  contig_links=contig_links, include_duplicates=include_duplicates, reference=reference)
    else:
        compact = [item for _key, item in _sv_reads(bam_paths, chrom, start, end, floor, bam_handle_getter=bam_handle_getter,
                                                   chrom_map=chrom_map, contig_links=contig_links,
                                                   include_duplicates=include_duplicates, reference=reference)]
    summary = sv_summary_for_reads(compact, start, end, floor, chrom=chrom, conflict_options=conflict_options) or {"clusters": []}
    out = []
    for c in summary["clusters"]:
        if c["t"] != "I" or c["len"] < min_len or not (start <= c["ref"] < end):
            continue
        out.append({**c, "carriers": c["support"] + c.get("putative", 0)})
    return out


def _sv_reads(bam_paths, chrom, start, end, floor, *, bam_handle_getter, chrom_map, contig_links, include_duplicates, reference=None):
    """((file, name, start, end, strand), {id, reference_start, reference_end[, sv]}) per primary
    alignment in ``[start, end)``, in file order."""
    from services.background_work import checkpoint
    index = {path: i for i, path in enumerate(bam_paths)}
    # Identical records (same file, name, extent, strand) are told apart by
    # their order: every fetch covering them sees them in the same order.
    occurrences: dict = {}
    seen = 0
    for read, _chrom, path, _bam in _site_records(bam_paths, chrom, start, end, bam_handle_getter=bam_handle_getter,
                                                  chrom_map=chrom_map, contig_links=contig_links, include_duplicates=include_duplicates):
        seen += 1
        if not seen & 255:
            checkpoint()  # the list's client went away
        if getattr(read, "is_duplicate", False) and not include_duplicates:
            continue
        ref_start, ref_end = int(read.reference_start), int(read.reference_end)
        item = {"id": read.query_name, "reference_start": ref_start, "reference_end": ref_end,
                **alignment_evidence(read)}
        events = extract_sv_events(read, sv_extraction_floor(floor), reference=reference)
        if events:
            item["sv"] = events
        # Reads without events count too (the reference reads spanning a site).
        ident = (index[path], read.query_name, ref_start, ref_end, bool(read.is_reverse))
        occurrence = occurrences.get(ident, 0)
        occurrences[ident] = occurrence + 1
        yield ident + (occurrence,), item


# Smallest tile of the insertions-in-view cache; a tile is at least half the view.
CLUSTER_TILE_MIN = 8_192


def cluster_tile_size(span: int) -> int:
    size = CLUSTER_TILE_MIN
    while size * 2 < max(1, int(span)):
        size *= 2
    return size


def _tiled_sv_reads(bam_paths, chrom, start, end, floor, *, tile_cache, bam_handle_getter, chrom_map,
                    contig_links, include_duplicates, reference=None) -> list[dict]:
    """``_sv_reads`` over ``[start, end)`` from cached tiles; missing tiles are read in
    contiguous runs (one fetch per run, each read's events extracted once)."""
    from services.signal_evidence import signal_filter_key
    size = cluster_tile_size(end - start)
    first, last = max(0, start) // size, max(0, end - 1) // size
    identity = (tuple((p, *_file_stamp(p)) for p in bam_paths), repr(chrom_map), repr(contig_links),
                chrom, size, int(floor), bool(include_duplicates), signal_filter_key(), _reference_key(reference))
    tiles: dict[int, list] = {}
    missing = []
    for t in range(first, last + 1):
        hit = tile_cache.get(identity + (t,), None)
        if hit is None:
            missing.append(t)
        else:
            tiles[t] = hit
    runs: list[list[int]] = []
    for t in missing:
        if runs and runs[-1][-1] == t - 1:
            runs[-1].append(t)
        else:
            runs.append([t])
    for run in runs:
        lo, hi = run[0] * size, (run[-1] + 1) * size
        fresh: dict[int, list] = {t: [] for t in run}
        for key, item in _sv_reads(bam_paths, chrom, lo, hi, floor, bam_handle_getter=bam_handle_getter,
                                   chrom_map=chrom_map, contig_links=contig_links,
                                   include_duplicates=include_duplicates, reference=reference):
            for t in run:
                if item["reference_end"] > t * size and item["reference_start"] < (t + 1) * size:
                    fresh[t].append((key, item))
        for t, rows in fresh.items():
            tile_cache.put(identity + (t,), rows)
            tiles[t] = rows
    # One row per alignment, in file order (file, start, then the fetch order of its first tile).
    merged: dict = {}
    for t in range(first, last + 1):
        for i, (key, item) in enumerate(tiles[t]):
            if key not in merged and item["reference_end"] > start and item["reference_start"] < end:
                merged[key] = ((key[0], key[2], t, i), item)
    return [item for _order, item in sorted(merged.values(), key=lambda row: row[0])]


_CLUSTER_TILES = None


def cluster_tile_cache():
    """The process's insertions-in-view tile cache (keyed by file identity)."""
    global _CLUSTER_TILES
    if _CLUSTER_TILES is None:
        from services.background_work import ResultCache
        _CLUSTER_TILES = ResultCache(max_entries=512, ttl_s=1800)
    return _CLUSTER_TILES


# ---------------------------------------------------------------------------
# Payload helpers for the router


def run_insert_report(bam_paths: list[str], chrom: str, ref: int, length: int) -> Optional[dict]:
    """What the run that called these BAMs reports for this insertion: fiberhmm-call's DAF
    insert-consensus pre-pass writes ``qc/<output BAM stem>.insert_consensus.json`` beside
    the BAM (its clusters, carriers and the share of confident consensus columns). Matched
    by contig, breakpoint (FiberHMM's 30 bp) and length (25%); None when there is none."""
    from services.cloud_placeholders import availability
    for bam_path in bam_paths:
        if "://" in str(bam_path):
            continue
        stem = os.path.splitext(os.path.basename(bam_path))[0]
        report_path = os.path.join(os.path.dirname(os.path.abspath(bam_path)), "qc", f"{stem}.insert_consensus.json")
        if not os.path.isfile(report_path) or availability(report_path) is not None:
            continue  # never an online-only placeholder (reading it would download it)
        try:
            with open(report_path) as handle:
                report = json.load(handle)
        except (OSError, ValueError):
            continue
        if not isinstance(report, dict) or not str(report.get("schema", "")).startswith("fiberhmm.daf.insert_consensus"):
            continue
        tolerance = int(report.get("breakpoint_tolerance") or 30)
        matches = [e for e in report.get("insertions") or [] if isinstance(e, dict)
                   and e.get("contig") in (chrom, None) and isinstance(e.get("pos"), (int, float))
                   and abs(int(e["pos"]) - int(ref)) <= tolerance and e.get("length")
                   and abs(int(e["length"]) - int(length)) <= 0.25 * max(int(length), 1)]
        if not matches:
            continue
        best = max(matches, key=lambda e: (bool(e.get("used")), int(e.get("carriers") or 0)))
        return {"path": report_path, "used": bool(best.get("used")), "carriers": best.get("carriers"),
                "carriers_ct": best.get("carriers_ct"), "carriers_ga": best.get("carriers_ga"),
                "min_carriers": report.get("min_carriers"), "consensus_length": best.get("consensus_length"),
                "confident_fraction": best.get("confident_fraction")}
    return None


def _is_daf_dataset(dataset) -> bool:
    """A DddA/DddB DAF-seq dataset (its declared chemistry; else a deamination layer and no m6A)."""
    from services.chemistry_metadata import dataset_consensus_chemistry
    chemistry = dataset_consensus_chemistry(dataset) if dataset is not None else None
    if chemistry:
        return chemistry in ("ddda", "dddb")
    layers = getattr(dataset, "available_layers", None) or {}
    return bool(layers.get("deam")) and not layers.get("m6a")


def _dataset_bam_paths(state, dataset_id):
    from services.query_params import resolve_dataset_id

    dataset_id = resolve_dataset_id(state, dataset_id)
    dataset = state.get_dataset(dataset_id) if dataset_id else None
    if dataset is None:
        return None, None, "Dataset not found"
    from services.lift.capability import require
    require(dataset, "insertion_lens")
    if getattr(dataset, "data_type", None) != "bam":
        return dataset_id, None, "The insertion lens needs a BAM dataset (insertions live in the alignments)"
    paths = list(getattr(dataset, "paths", None) or [getattr(dataset, "path", None)])
    return dataset_id, [p for p in paths if p], None


def insertion_clusters_payload(state, *, chrom: str, start: int, end: int,
                               dataset_id: Optional[str] = None, min_len: int = DEFAULT_MIN_LEN,
                               tolerance: int = DEFAULT_TOLERANCE, conflict_options=None) -> dict:
    chrom = state.translate_chrom(chrom)
    dataset_id, paths, error = _dataset_bam_paths(state, dataset_id)
    if error:
        return {"success": False, "error": error, "clusters": []}
    start = max(0, int(start))
    end = int(end)
    if end - start > MAX_CLUSTER_REGION:
        return {"success": False, "error": "Zoom in to 2 Mb or less to list insertions", "clusters": []}
    from services.plasmid_reconcile import contig_links
    clusters = find_clusters(
        paths, chrom, start, end, min_len=max(1, int(min_len)), tolerance=max(0, int(tolerance)),
        chrom_map=getattr(state, "chrom_map", None),
        contig_links=contig_links(state, path=paths[0]) if paths else None,
        tile_cache=cluster_tile_cache(),
        reference=getattr(state, 'fasta', None), conflict_options=conflict_options,
    )
    return {"success": True, "dataset_id": dataset_id, "chrom": chrom, "clusters": clusters}


def insertion_lens_payload(state, *, chrom: str, pos: int, dataset_id: Optional[str] = None,
                           tolerance: int = DEFAULT_TOLERANCE, len_min: int = DEFAULT_MIN_LEN,
                           len_max: Optional[int] = None, ref: Optional[int] = None,
                           length: Optional[int] = None, include_duplicates: bool = False,
                           flank: int = DEFAULT_FLANK,
                           max_carriers: int = DEFAULT_MAX_CARRIERS,
                           max_reference: int = DEFAULT_MAX_REFERENCE,
                           consensus: bool = True, include_sequences: bool = False,
                           ml_threshold: int = 125, layer_names: Optional[list[str]] = None,
                           include_methylation: bool = True, hide_terminal_gaps: bool = True, conflict_options=None) -> dict:
    from services.compact_read_loader import short_terminal_footprint_bp_for
    from services.signal_evidence import signal_filter_key
    from services.plasmid_reconcile import contig_links

    chrom = state.translate_chrom(chrom)
    dataset_id, paths, error = _dataset_bam_paths(state, dataset_id)
    if error:
        return {"success": False, "error": error}
    loader_kwargs = {
        "include_methylation": bool(include_methylation),
        "ml_threshold": int(ml_threshold),
        "include_layers": True,
        "requested_layers": layer_names,
        "include_layer_qualities": True,
        "hide_terminal_gaps": bool(hide_terminal_gaps),
        "short_terminal_footprint_bp": short_terminal_footprint_bp_for(state),
    }
    daf = _is_daf_dataset(state.get_dataset(dataset_id))
    stamps = tuple((p, *_file_stamp(p)) for p in paths)
    chrom_map = getattr(state, "chrom_map", None)
    links = contig_links(state, path=paths[0]) if paths else None
    # Remote files have no local stamp to notice a new version by: not cached.
    cacheable = all(stamp[1] is not None for stamp in stamps)
    key = (
        "reconstruction:v1", "native-banded-wavefront:v1", dataset_id, stamps, repr(chrom_map), repr(links),
        chrom, int(pos), int(tolerance), int(len_min),
        len_max, ref, length, bool(include_duplicates), int(flank), int(max_carriers), int(max_reference), bool(consensus),
        bool(include_sequences), repr(sorted(loader_kwargs.items())), daf, signal_filter_key(state),
        _reference_key(getattr(state, 'fasta', None)),
        repr(sorted(normalize_conflict_options(conflict_options).items())),
    )
    with _cache_lock:
        cached = _cache.get(key) if cacheable else None
        if cached is not None:
            _cache.move_to_end(key)
            return cached
    payload = build_lens(
        paths, chrom, pos=int(pos), tolerance=max(0, int(tolerance)), len_min=max(1, int(len_min)),
        len_max=int(len_max) if len_max is not None else None, flank=int(flank),
        ref=int(ref) if ref is not None else None, length=int(length) if length is not None else None,
        include_duplicates=bool(include_duplicates),
        max_carriers=max(1, int(max_carriers)), max_reference=max(0, int(max_reference)),
        consensus=consensus, include_sequences=include_sequences, loader_kwargs=loader_kwargs,
        chrom_map=chrom_map,
        contig_links=links,
        daf=daf,
        reference=getattr(state, 'fasta', None), conflict_options=conflict_options,
    )
    payload["dataset_id"] = dataset_id
    if not cacheable or not payload.get("success") or payload.get("consensus_resource"):
        return payload
    with _cache_lock:
        _cache[key] = payload
    return payload
