"""SV allele split and inserted-sequence lookups (fb-n9-sv).

Both read the dataset's BAM records directly: the allele of a read depends on
its whole alignment (bounds, CIGAR, SA tag), not on the calls the display
cache holds, and a fetch without tag parsing is cheap.
"""
from __future__ import annotations

import os
import re
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


def _dataset(state, dataset_id):
    """Resolve the default before BAM validation or cache access, including direct service calls."""
    from services.query_params import resolve_dataset_id
    from services.lift.capability import require
    dataset_id = resolve_dataset_id(state, dataset_id)
    dataset = state.get_dataset(dataset_id) if dataset_id else None
    require(dataset, "sv_summary")
    return dataset_id, dataset


def _bam_records(state, dataset_id: str, chrom: str, start: int, end: int,
                 with_handle: bool = False, checkpoint_fn=None) -> Iterator[tuple]:
    """(record, file chromosome[, path, handle]) of the dataset's primary
    alignments in ``[start, end)``."""
    from services.bam_handles import get_bam_handle
    from services.plasmid_reconcile import contig_links
    from services.signal_evidence import signal_header, record_keeps_signal
    from utils.chrom import resolve_reference_name

    dataset_id, dataset = _dataset(state, dataset_id)
    if dataset is None:
        raise SvRequestError(f"Dataset '{dataset_id}' not found", 404)
    if getattr(dataset, "data_type", None) != "bam":
        raise SvRequestError("SV events need a BAM dataset")
    for path in dataset.paths:
        if checkpoint_fn is not None:
            checkpoint_fn()
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
            if checkpoint_fn is not None:
                checkpoint_fn()
            if read.is_unmapped or read.is_secondary:
                return None
            if hidden is not None and hidden(read):
                return None
            return record_keeps_signal(read, provenance)
        for bundle in molecule_bundles(bam.fetch(actual, max(0, int(start)), int(end)), eligible):
            if checkpoint_fn is not None:
                checkpoint_fn()
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
                     include_duplicates: bool = False, include_putative: bool = True, include_ambiguous: bool = False, include_conflicting: bool = False, conflict_options=None, targets=None, target_end=None) -> dict:
    """``classify_records`` over compact entries (``_compact_record``); each
    entry's ``record`` is the entry itself (or what ``item`` carried)."""
    entries = list(entries)
    # Duplicate eligibility belongs to each source file. Merge QNAME calls
    # only after this decision, matching native BAM spooling and select_cohort.
    def molecule(c):
        return (c.get('_key', (None,))[0], c['id'])
    primaries = {molecule(c) for c, _ in entries if not c.get('supplementary')}
    kept_primaries = {molecule(c) for c, _ in entries if not c.get('supplementary') and (include_duplicates or not c.get('duplicate'))}
    return classify_molecules(
        ((compact, item) for compact, item in entries if (include_duplicates or not compact.get('duplicate'))
         and (molecule(compact) not in primaries or molecule(compact) in kept_primaries)),
        t=t, ref=ref, length=length, margin=margin, include_putative=include_putative, include_ambiguous=include_ambiguous, include_conflicting=include_conflicting, conflict_options=conflict_options, targets=targets, target_end=target_end)


def classify_records(records, *, t: str, ref: int, length: int, margin: int = SV_SPAN_MARGIN,
                     include_duplicates: bool = False, include_putative: bool = True, include_ambiguous: bool = False, include_conflicting: bool = False, conflict_options=None, reference=None) -> dict:
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
                            include_duplicates=include_duplicates, include_putative=include_putative, include_ambiguous=include_ambiguous, include_conflicting=include_conflicting, conflict_options=conflict_options)


# ---------------------------------------------------------------------------
# The split's scan of the view, cached: a deep view (24k PacBio reads over
# 150 kb) takes ~10 s to read from the BAM, and a split is refreshed on every
# pan. The scan keeps each record's bounds and SV events (not its calls), per
# dataset, chromosome and event floor, with exact region/cohort ownership.
# Variants and splits share these tiles, never their policy-specific calls.

# Compatibility names for embedding clients; both APIs use this provider.
from services.sv_evidence import SCAN_CACHE as _SCAN_CACHE, SCAN_LOCK as _SCAN_LOCK


def _path_stamps(paths) -> Optional[tuple]:
    stamps = []
    for path in paths:
        try:
            st = os.stat(path)
        except OSError:
            return None  # remote or missing: never cached
        stamps.append((path, st.st_mtime_ns, st.st_size, st.st_ctime_ns, st.st_ino))
    return tuple(stamps)


def _scan(state, dataset_id: str, chrom: str, start: int, end: int, floor: int, checkpoint_fn=None) -> list[dict]:
    import time
    from services.background_work import checkpoint
    from services.reconstruction_budget import DEFAULT_LIMITS, RESERVATIONS, ResourceResult
    deadline = time.monotonic() + DEFAULT_LIMITS.deadline_s
    def check():
        (checkpoint_fn or checkpoint)()
        if time.monotonic() >= deadline:
            raise ResourceResult('budget_exceeded', 'native_scan_deadline', seconds=DEFAULT_LIMITS.deadline_s)
    # Raw molecule spooling plus retained compact records share the numerical
    # process budget. Cache hits allocate no second extraction reservation.
    size = DEFAULT_LIMITS.job_bytes
    RESERVATIONS.acquire(size, False, deadline, check)
    try:
        return _scan_records(state, dataset_id, chrom, start, end, floor, check)
    finally:
        RESERVATIONS.release(size, False)


def _scan_records(state, dataset_id, chrom, start, end, floor, check):
    out = []
    from services import sv_evidence
    from services.reconstruction_budget import ResourceResult
    retained = 0
    for read, file_chrom, path, _bam in _bam_records(state, dataset_id, chrom, start, end, with_handle=True, checkpoint_fn=check):
        check()
        if len(out) >= sv_evidence.SCAN_MAX_RECORDS:
            raise ResourceResult('budget_exceeded', 'native_scan_records', max_records=sv_evidence.SCAN_MAX_RECORDS)
        # All sequence-free geometry inputs participate in reuse identity.
        # A reference-normalized record additionally retains its complete SAM
        # digest so sequence-distinct records with identical CIGAR cannot merge.
        key = (path, read.query_name, int(read.reference_start), int(read.flag), read.cigarstring,
               int(read.mapping_quality), int(read.query_length), read.get_tag('SA') if read.has_tag('SA') else None)
        if getattr(state, 'fasta', None) is not None:
            import hashlib
            key += (hashlib.sha256(read.to_string().encode()).hexdigest(),)
        entry = sv_evidence.reusable_record(key)
        if entry is None:
            entry = _compact_record(read, file_chrom, floor, reference=getattr(state, 'fasta', None))
            entry['_key'] = key
            entry['_scan_bytes'] = sv_evidence.compact_bytes(entry, floor,
                reusable=getattr(state, 'fasta', None) is None and not getattr(state, 'fasta_path', None))
        retained += entry['_scan_bytes']
        if retained > sv_evidence.SCAN_MAX_BYTES:
            raise ResourceResult('budget_exceeded', 'native_scan_bytes', max_bytes=sv_evidence.SCAN_MAX_BYTES)
        out.append(entry)
    return out


def scan_view(state, dataset_id: str, chrom: str, start: int, end: int, floor: int, *, cancelled=None) -> list[dict]:
    """Compact entries of the dataset's primary records overlapping ``[start, end)``."""
    dataset_id, dataset = _dataset(state, dataset_id)
    from services.sv_evidence import scan_region, select_cohort, ScanCancelled
    from services.background_work import checkpoint
    import time
    from services.reconstruction_budget import DEFAULT_LIMITS, ResourceResult
    deadline = time.monotonic() + DEFAULT_LIMITS.deadline_s
    def check():
        checkpoint()
        if cancelled is not None and cancelled():
            raise ScanCancelled()
        if time.monotonic() >= deadline:
            raise ResourceResult('budget_exceeded', 'native_scan_deadline', seconds=DEFAULT_LIMITS.deadline_s)
    scanner = lambda *args: _scan(*args, checkpoint_fn=check)
    stamps = _path_stamps(getattr(dataset, "paths", None) or []) if dataset is not None else None
    entries = scan_region(state, dataset, dataset_id, chrom, start, end, floor,
                          stamps=stamps, scanner=scanner, check=check)
    return select_cohort(entries, read_ids=getattr(state, '_variant_read_ids', None))


def sv_split_payload(state, *, dataset_id: str, chrom: str, start: int, end: int, t: str, ref: int,
                     length: int, margin: Optional[int] = None, include_duplicates: bool = False,
                     include_putative: bool = True, include_ambiguous: bool = False, include_conflicting: bool = False, conflict_options=None, target_end=None, payload_version=1, allele_target=None) -> dict:
    """Every primary read in ``[start, end)`` as carrier (0), reference (1) or
    not informative (2) for the SV ``t``/``ref``/``length`` (an insertion's
    clipped reads are carriers: sv_events.carrier_evidence)."""
    if payload_version not in (1, 2):
        raise SvRequestError("payload_version must be 1 or 2")
    if allele_target is not None and payload_version != 2:
        raise SvRequestError("allele_target requires payload_version 2")
    if t not in ("D", "I"):
        raise SvRequestError("t must be 'D' or 'I'")
    if int(end) <= int(start):
        raise SvRequestError("empty region")
    length = int(length)
    ref = int(ref)
    if ref < 0 or (target_end is not None and target_end < ref):
        raise SvRequestError("invalid target reference span")
    if length <= 0:
        raise SvRequestError("len must be positive")
    margin = SV_SPAN_MARGIN if margin is None else max(0, int(margin))
    from services.query_params import resolve_dataset_id
    dataset_id = resolve_dataset_id(state, dataset_id)
    entries = scan_view(state, dataset_id, chrom, int(start), int(end), allele_floor(length))
    by_name = classify_compact(((c, c) for c in entries), t=t, ref=ref, length=length,
                               margin=margin, include_duplicates=include_duplicates, include_putative=include_putative, include_ambiguous=include_ambiguous, include_conflicting=include_conflicting, conflict_options=conflict_options,
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
    payload = {
        "assignments": assignments,
        "counts": counts,
        "carriers_by": by_kind,
        "evidence_counts": {level: sum((entry['evidence'] or {}).get('level') == level for entry in by_name.values())
                            for level in ('confirmed', 'putative', 'conflicting', 'ambiguous')},
        "evidence_levels": {name: (entry['evidence'] or {}).get('level') for name, entry in by_name.items()},
        "evidence_reasons": {name: entry["evidence"]["reason"] for name, entry in by_name.items() if (entry["evidence"] or {}).get("reason")},
        "include_conflicting": include_conflicting,
        "include_putative": include_putative, "include_ambiguous": include_ambiguous,
        "label": allele_label(t, ref, length, chrom),
        "margin": margin,
        "groups": ["carriers", "reference", "not informative"],
    }
    if payload_version == 2:
        from services.differences.native import native_geometry_envelope
        from services.sv_conflicts import normalize_conflict_options
        payload["differences"] = native_geometry_envelope(
            by_name, entries, dataset_id=dataset_id, chrom=chrom, start=start, end=end,
            t=t, ref=ref, length=length, target_end=target_end, include_duplicates=include_duplicates,
            policy={"include_duplicates": include_duplicates, "include_putative": include_putative,
                    "include_ambiguous": include_ambiguous, "include_conflicting": include_conflicting,
                    "conflict_options": normalize_conflict_options(conflict_options)})
        if allele_target is not None:
            from services.differences.enrichment import enrich_native
            payload["differences"]["enrichment"] = enrich_native(
                state, payload["differences"], dataset_id=dataset_id, chrom=chrom, ref=ref,
                target_end=target_end if target_end is not None else ref + length if t == "D" else ref,
                specification=allele_target, include_duplicates=include_duplicates)
    return payload


def sv_insert_seq_payload(state, *, dataset_id: str, chrom: str, ref: int, read_id: str, q: int,
                          length: int) -> dict:
    """Inserted source pieces at ``q``; length selects the displayed allele.

    A merged/minimized allele can have a different size from its original I
    pieces. The response length counts the returned bases, excluding M bridges.
    """
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

    lookup = {}
    def events_for(read):
        if id(read) not in lookup:
            # Older raw glyphs remain addressable after allele minimization.
            lookup[id(read)] = (extract_sv_events(read, SV_MIN_LEN_LOWEST, reference=getattr(state, 'fasta', None)) or [])
            lookup[id(read)] += extract_sv_events(read, SV_MIN_LEN_LOWEST) or []
        return lookup[id(read)]

    def has_insertion(read) -> bool:
        return any(e.get("t") == "I" and e.get("q") == q for e in events_for(read))

    matching = [read for read in candidates if has_insertion(read)] or candidates
    for read in matching:
        seq = read.query_sequence or ""
        event = next((ev for ev in events_for(read)
                      if ev.get('t') == 'I' and ev['q'] == q and ev['len'] == length and ev.get('raw_pieces')), None)
        if event is not None:
            pieces = [p for p in event['raw_pieces'] if p['t'] == 'I']
            if any(p['q'] < 0 or p['q'] + p['len'] > len(seq) for p in pieces):
                continue
            inserted = ''.join(seq[p['q']:p['q'] + p['len']] for p in pieces)
            if len(inserted) > 1_000_000:
                raise SvRequestError('inserted sequence exceeds the export limit')
            if inserted:
                return {'read_id': read.query_name, 'q': q, 'len': len(inserted), 'seq': inserted,
                        'strand': '-' if read.is_reverse else '+'}
        if q + length > len(seq):
            continue
        return {"read_id": read.query_name, "q": q, "len": length, "seq": seq[q:q + length],
                "strand": "-" if read.is_reverse else "+"}
    if candidates:
        raise SvRequestError("query interval outside the read")
    raise SvRequestError(f"Read '{read_id}' not found at {chrom}:{int(ref) + 1}", 404)
