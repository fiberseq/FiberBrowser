"""Regional molecule bundles; raw alignments remain distinct from display rows."""
from __future__ import annotations

import json

EVIDENCE_FIELDS = ('id', 'reference_start', 'reference_end', 'file_chrom', 'sv', 'sv_evidence',
                   'aligned_blocks', 'sv_segments', 'sequence_span', 'supplementary')


def alignment_order(read):
    return (bool(read.is_supplementary), -int(getattr(read, 'mapping_quality', 0) or 0), int(read.reference_start),
            getattr(read, 'cigarstring', None) or '', bool(read.is_reverse))


def molecule_bundles(records, eligible):
    """Yield a deterministic local anchor and all eligible local records once per QNAME.

    No remote mate/name lookup: SA describes nonlocal segments; fetched records
    supply local CIGAR, available sequence and chromatin evidence.
    """
    groups = {}
    for read in records:
        status = eligible(read)
        if status is None:
            continue  # structurally ineligible, rather than filtered by a user policy
        group = groups.setdefault(read.query_name, {'primary': False, 'records': []})
        group['primary'] |= not read.is_supplementary
        if status:
            group['records'].append(read)
    for group in groups.values():
        bundle = group['records']
        if not bundle or (group['primary'] and not any(not r.is_supplementary for r in bundle)):
            continue  # a filtered local primary must not be rescued through an unscored supplementary
        bundle.sort(key=alignment_order)
        yield bundle


def molecule_alignments(records, eligible):
    for bundle in molecule_bundles(records, eligible):
        primaries = [read for read in bundle if not read.is_supplementary]
        # Existing source-record identities/occurrences must remain addressable
        # for consensus overlays. SV reducers still count these rows once per
        # molecule; supplementary segments never introduce a second row.
        for anchor in primaries or [bundle[0]]:
            yield anchor, bundle if any(read.is_supplementary for read in bundle) else [anchor]


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
