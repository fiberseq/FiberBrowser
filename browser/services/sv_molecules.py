"""Regional molecule bundles; raw alignments remain distinct from display rows."""
from __future__ import annotations

import json

EVIDENCE_FIELDS = ('id', 'reference_start', 'reference_end', 'file_chrom', 'sv', 'sv_evidence',
                   'aligned_blocks', 'sv_segments', 'sequence_span', 'supplementary')


def alignment_order(read):
    return (bool(read.is_supplementary), -int(read.mapping_quality), int(read.reference_start),
            read.cigarstring or '', bool(read.is_reverse))


def molecule_alignments(records, eligible):
    """Yield a deterministic local anchor and all eligible local records once per QNAME.

    No remote mate/name lookup: SA describes nonlocal segments; fetched records
    supply local CIGAR, available sequence and chromatin evidence.
    """
    groups = {}
    for read in records:
        if eligible(read):
            groups.setdefault(read.query_name, []).append(read)
    for bundle in groups.values():
        bundle.sort(key=alignment_order)
        yield bundle[0], bundle


def segment_key(segment):
    return tuple(segment.get(k) for k in ('chrom', 'pos', 'cigar_ref_len', 'strand',
                                          'q_start', 'q_end', 'query_length'))


def unique_segments(reads):
    """Reciprocal SA deduplication; fetched alignments override their SA descriptions."""
    segments = {}
    for read in reads:
        for segment in read.get('sv_segments') or []:
            key = segment_key(segment)
            previous = segments.get(key)
            # Actual CIGAR geometry has no t:SA; among repeated observations use
            # the conservative MAPQ, independent of input/file order.
            rank = (segment.get('t') == 'SA', int(segment.get('mapq', 0)))
            if previous is None or rank < (previous.get('t') == 'SA', int(previous.get('mapq', 0))):
                segments[key] = segment
    return [segments[key] for key in sorted(segments, key=repr)]


def consolidate_evidence(reads):
    """One compact evidence row, preserving all original per-alignment bundles."""
    if len(reads) == 1:
        return reads[0]
    alignments = []
    seen = set()
    for read in reads:
        for part in read.get('sv_alignments') or [read]:
            entry = {key: part[key] for key in EVIDENCE_FIELDS if key in part}
            key = json.dumps(entry, sort_keys=True)
            if key not in seen:
                seen.add(key)
                alignments.append(entry)
    alignments.sort(key=lambda a: (bool(a.get('supplementary')), int(a.get('reference_start', 0)),
                                   json.dumps(a, sort_keys=True)))
    events = {json.dumps(ev, sort_keys=True): ev for a in alignments
              for ev in a.get('sv_evidence') or a.get('sv') or []}
    return {**reads[0], 'sv_alignments': alignments, 'sv_segments': unique_segments(alignments),
            'sv': sorted(events.values(), key=lambda e: (int(e.get('ref', e.get('pos', 0))), e['t'], repr(e))),
            'aligned_blocks': sorted({tuple(block) for a in alignments for block in a.get('aligned_blocks', [])}),
            'alignment_spans': sorted({(a['reference_start'], a['reference_end']) for a in alignments})}
