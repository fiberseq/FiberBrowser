"""SV allele split and inserted-sequence lookups (fb-n9-sv).

Both read the dataset's BAM records directly: the allele of a read depends on
its whole alignment (bounds, CIGAR, SA tag), not on the calls the display
cache holds, and a fetch without tag parsing is cheap.
"""
from __future__ import annotations

import os
import re
import threading
from services.byte_cache import shared_cache
from typing import Iterator, Optional

from services.sv_events import (
    SV_MIN_LEN_DEFAULT,
    SV_MIN_LEN_LOWEST,
    SV_SPAN_MARGIN,
    allele_label,
    classify_molecules,
    sv_extraction_floor,
    extract_sv_events,
    normalize_min_sv_len,
    alignment_evidence,
)

_SEGMENT_SUFFIX = re.compile(r"_\d+$")


class SvRequestError(ValueError):
    """A request the endpoints refuse (HTTP 400/404)."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _bam_records(state, dataset_id: str, chrom: str, start: int, end: int,
                 with_handle: bool = False) -> Iterator[tuple]:
    """(record, file chromosome[, path, handle]) of the dataset's primary
    alignments in ``[start, end)``."""
    from services.bam_handles import get_bam_handle
    from services.plasmid_reconcile import contig_links
    from services.signal_evidence import signal_header, record_keeps_signal
    from utils.chrom import resolve_reference_name

    dataset = state.get_dataset(dataset_id) if dataset_id else None
    if dataset is None:
        raise SvRequestError(f"Dataset '{dataset_id}' not found", 404)
    if getattr(dataset, "data_type", None) != "bam":
        raise SvRequestError("SV events need a BAM dataset")
    for path in dataset.paths:
        bam = get_bam_handle(path)
        if bam is None:
            continue
        actual = resolve_reference_name(chrom, bam.references, getattr(state, "chrom_map", None) or {},
                                        links=contig_links(state, path=path))
        if actual is None:
            continue
        provenance = signal_header(bam.header)
        from services.graph_lift import lift_hidden_predicate
        hidden = lift_hidden_predicate(bam.header)  # an unrepaired lift's ex-supplementaries, as the read track
        from services.sv_molecules import molecule_bundles
        def eligible(read):
            if read.is_unmapped or read.is_secondary:
                return None
            if hidden is not None and hidden(read):
                return None
            return record_keeps_signal(read, provenance)
        for bundle in molecule_bundles(bam.fetch(actual, max(0, int(start)), int(end)), eligible):
            for read in bundle:
                yield (read, actual, path, bam) if with_handle else (read, actual)


def allele_floor(length: int) -> int:
    """The same evidence floor as summaries and the lens."""
    return sv_extraction_floor(length)


def _compact_record(read, file_chrom: str, floor: int, reference=None) -> dict:
    return {
        "id": read.query_name,
        "reference_start": int(read.reference_start),
        "reference_end": int(read.reference_end),
        "sv": extract_sv_events(read, floor, reference=reference) or [],
        "duplicate": bool(read.is_duplicate),
        "file_chrom": file_chrom,
        **alignment_evidence(read),
    }


def classify_compact(entries, *, t: str, ref: int, length: int, margin: int = SV_SPAN_MARGIN,
                     include_duplicates: bool = False, include_putative: bool = True, include_ambiguous: bool = False, targets=None, target_end=None) -> dict:
    """``classify_records`` over compact entries (``_compact_record``); each
    entry's ``record`` is the entry itself (or what ``item`` carried)."""
    entries = list(entries)
    primaries = {c['id'] for c, _ in entries if not c.get('supplementary')}
    kept_primaries = {c['id'] for c, _ in entries if not c.get('supplementary') and (include_duplicates or not c.get('duplicate'))}
    return classify_molecules(
        ((compact, item) for compact, item in entries if (include_duplicates or not compact.get('duplicate'))
         and (compact['id'] not in primaries or compact['id'] in kept_primaries)),
        t=t, ref=ref, length=length, margin=margin, include_putative=include_putative, include_ambiguous=include_ambiguous, targets=targets, target_end=target_end)


def classify_records(records, *, t: str, ref: int, length: int, margin: int = SV_SPAN_MARGIN,
                     include_duplicates: bool = False, include_putative: bool = True, include_ambiguous: bool = False, reference=None) -> dict:
    """Every primary record as carrier (0), reference (1) or not informative
    (2) for one SV: ``{name: {'allele', 'evidence', 'record'}}``. A name seen
    twice (merged files) keeps its most informative call. The allele split
    and plugin packs' insertion views classify through here, so their carrier
    sets are the same reads.

    ``records``: (pysam record, file chromosome, ...) tuples; each tuple is
    kept in ``record``."""
    floor = allele_floor(length)
    entries = ((_compact_record(item[0], item[1], floor, reference=reference), item) for item in records)
    return classify_compact(entries, t=t, ref=ref, length=length, margin=margin,
                            include_duplicates=include_duplicates, include_putative=include_putative, include_ambiguous=include_ambiguous)


# ---------------------------------------------------------------------------
# The split's scan of the view, cached: a deep view (24k PacBio reads over
# 150 kb) takes ~10 s to read from the BAM, and a split is refreshed on every
# pan. The scan keeps each record's bounds and SV events (not its calls), per
# dataset, chromosome and event floor; a request overlapping the cached
# region only reads the part it adds.

_SCAN_CACHE = shared_cache('indexes')
_SCAN_LOCK = threading.Lock()
_SCAN_MAX_SPAN = 2_000_000


def _path_stamps(paths) -> Optional[tuple]:
    stamps = []
    for path in paths:
        try:
            st = os.stat(path)
        except OSError:
            return None  # remote or missing: never cached
        stamps.append((path, st.st_mtime_ns, st.st_size))
    return tuple(stamps)


def _scan(state, dataset_id: str, chrom: str, start: int, end: int, floor: int) -> list[dict]:
    out = []
    for read, file_chrom, path, _bam in _bam_records(state, dataset_id, chrom, start, end, with_handle=True):
        entry = _compact_record(read, file_chrom, floor, reference=getattr(state, 'fasta', None))
        # A record's identity across scans (merged files may share names and starts).
        entry["_key"] = (path, read.query_name, int(read.reference_start), int(read.flag), read.cigarstring)
        out.append(entry)
    return out


def scan_view(state, dataset_id: str, chrom: str, start: int, end: int, floor: int) -> list[dict]:
    """Compact entries of the dataset's primary records overlapping ``[start, end)``."""
    dataset = state.get_dataset(dataset_id) if dataset_id else None
    stamps = _path_stamps(getattr(dataset, "paths", None) or []) if dataset is not None else None
    if stamps is None:
        return _scan(state, dataset_id, chrom, start, end, floor)
    from services.plasmid_reconcile import contig_links
    from services.signal_evidence import signal_filter_key
    links = tuple(repr(contig_links(state, path=path)) for path, _m, _s in stamps)
    from services.sv_alleles import reference_identity
    key = (dataset_id, stamps, links, chrom, int(floor), repr(getattr(state, "chrom_map", None)), signal_filter_key(state),
           reference_identity(state))
    with _SCAN_LOCK:
        entry = _SCAN_CACHE.get(key)
        if entry is not None:
            _SCAN_CACHE.move_to_end(key)
    if entry is not None and entry["lo"] <= start and end <= entry["hi"]:
        return [c for c in entry["entries"] if c["reference_end"] > start and c["reference_start"] < end]
    if (entry is not None and start <= entry["hi"] and end >= entry["lo"]
            and max(end, entry["hi"]) - min(start, entry["lo"]) <= _SCAN_MAX_SPAN):
        # Read only what the request adds; a record in both parts is kept once.
        added = []
        if start < entry["lo"]:
            added += _scan(state, dataset_id, chrom, start, entry["lo"], floor)
        if end > entry["hi"]:
            added += _scan(state, dataset_id, chrom, entry["hi"], end, floor)
        seen = {c["_key"] for c in entry["entries"]}
        merged = list(entry["entries"])
        for c in added:
            k = c["_key"]
            if k not in seen:
                seen.add(k)
                merged.append(c)
        entry = {"lo": min(start, entry["lo"]), "hi": max(end, entry["hi"]), "entries": merged}
    else:
        entry = {"lo": int(start), "hi": int(end), "entries": _scan(state, dataset_id, chrom, start, end, floor)}
    with _SCAN_LOCK:
        _SCAN_CACHE[key] = entry
        _SCAN_CACHE.move_to_end(key)
    return [c for c in entry["entries"] if c["reference_end"] > start and c["reference_start"] < end]


def sv_split_payload(state, *, dataset_id: str, chrom: str, start: int, end: int, t: str, ref: int,
                     length: int, margin: Optional[int] = None, include_duplicates: bool = False,
                     include_putative: bool = True, include_ambiguous: bool = False, target_end=None) -> dict:
    """Every primary read in ``[start, end)`` as carrier (0), reference (1) or
    not informative (2) for the SV ``t``/``ref``/``length`` (an insertion's
    clipped reads are carriers: sv_events.carrier_evidence)."""
    if t not in ("D", "I"):
        raise SvRequestError("t must be 'D' or 'I'")
    if int(end) <= int(start):
        raise SvRequestError("empty region")
    length = int(length)
    ref = int(ref)
    if length <= 0:
        raise SvRequestError("len must be positive")
    margin = SV_SPAN_MARGIN if margin is None else max(0, int(margin))
    entries = scan_view(state, dataset_id, chrom, int(start), int(end), allele_floor(length))
    by_name = classify_compact(((c, c) for c in entries), t=t, ref=ref, length=length,
                               margin=margin, include_duplicates=include_duplicates, include_putative=include_putative, include_ambiguous=include_ambiguous,
                               target_end=target_end)
    assignments: dict[str, int] = {}
    counts = [0, 0, 0]
    by_kind = {"cigar": 0, "sa": 0, "clip": 0}
    for name, entry in by_name.items():
        allele = entry["allele"]
        assignments[name] = allele
        counts[allele] += 1
        if allele == 0:
            by_kind[entry["evidence"]["kind"]] += 1
    return {
        "assignments": assignments,
        "counts": counts,
        "carriers_by": by_kind,
        "evidence_counts": {level: sum((entry['evidence'] or {}).get('level') == level for entry in by_name.values())
                            for level in ('confirmed', 'putative', 'ambiguous')},
        "evidence_levels": {name: (entry['evidence'] or {}).get('level') for name, entry in by_name.items()},
        "include_putative": include_putative, "include_ambiguous": include_ambiguous,
        "label": allele_label(t, ref, length, chrom),
        "margin": margin,
        "groups": ["carriers", "reference", "not informative"],
    }


def sv_insert_seq_payload(state, *, dataset_id: str, chrom: str, ref: int, read_id: str, q: int,
                          length: int) -> dict:
    """SEQ ``[q, q+length)`` of the primary record ``read_id`` overlapping ``ref``."""
    q = int(q)
    length = int(length)
    if q < 0 or length <= 0 or length > 1_000_000:
        raise SvRequestError("bad query interval")
    base = _SEGMENT_SUFFIX.sub("", read_id)
    exact, by_base = [], []
    for read, _chrom in _bam_records(state, dataset_id, chrom, max(0, int(ref) - 1), int(ref) + 1):
        if read.query_name == read_id:
            exact.append(read)
        elif base != read_id and read.query_name == base:
            by_base.append(read)
    # The exact name first (a QNAME may itself end in _N); then the record
    # that has this insertion, so a name shared across files resolves right.
    candidates = exact or by_base

    def has_insertion(read) -> bool:
        events = extract_sv_events(read, SV_MIN_LEN_LOWEST, reference=getattr(state, 'fasta', None)) or []
        return any(e.get("t") == "I" and e.get("q") == q for e in events)

    matching = [read for read in candidates if has_insertion(read)] or candidates
    for read in matching:
        seq = read.query_sequence or ""
        event = next((ev for ev in extract_sv_events(read, SV_MIN_LEN_LOWEST, reference=getattr(state, 'fasta', None)) or []
                      if ev.get('t') == 'I' and ev['q'] == q and ev['len'] == length and ev.get('raw_pieces')), None)
        if event is not None:
            inserted = ''.join(seq[p['q']:p['q'] + p['len']] for p in event['raw_pieces'] if p['t'] == 'I')
            if len(inserted) == length:
                return {'read_id': read.query_name, 'q': q, 'len': length, 'seq': inserted,
                        'strand': '-' if read.is_reverse else '+'}
        if q + length > len(seq):
            continue
        return {"read_id": read.query_name, "q": q, "len": length, "seq": seq[q:q + length],
                "strand": "-" if read.is_reverse else "+"}
    if candidates:
        raise SvRequestError("query interval outside the read")
    raise SvRequestError(f"Read '{read_id}' not found at {chrom}:{int(ref) + 1}", 404)
