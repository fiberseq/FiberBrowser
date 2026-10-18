"""Regional molecule bundles; raw alignments remain distinct from display rows."""
from __future__ import annotations

import json
import tempfile

EVIDENCE_FIELDS = ('id', 'reference_start', 'reference_end', 'file_chrom', 'sv', 'sv_evidence',
                   'aligned_blocks', 'sv_segments', 'sequence_span', 'supplementary')


def alignment_order(read):
    return (bool(read.is_supplementary), -int(getattr(read, 'mapping_quality', 0) or 0), int(read.reference_start),
            getattr(read, 'cigarstring', None) or '', bool(read.is_reverse))


# Only one molecule's raw records are materialized at a time. Oversized
# pathological bundles fail explicitly instead of silently losing evidence.
MOLECULE_RAW_BYTES = 64 * 1024 * 1024
MOLECULE_MAX_GROUPS = 250_000


class MoleculeBudgetError(MemoryError):
    pass


def molecule_bundles(records, eligible, *, keep=None, on_skipped=None,
                     raw_budget_bytes=MOLECULE_RAW_BYTES, max_groups=MOLECULE_MAX_GROUPS):
    """Losslessly spool selected records, then materialize one QNAME at a time.

    Coordinate order cannot close a molecule before its later segments arrive.
    A temporary spool bounds raw-record RAM without an arbitrary genomic-distance
    cutoff. Selection and cancellation happen during collection, before retention.
    No remote name lookup or user application-directory storage is used.
    """
    from services.background_work import checkpoint
    import pysam
    groups = {}
    header = None
    with tempfile.TemporaryFile(mode='w+b', prefix='fiberbrowser-molecules-') as spool:
        for i, read in enumerate(records):
            if not i & 255:
                checkpoint()
            status = eligible(read)
            if status is None:
                continue
            name = read.query_name
            if name not in groups:
                if len(groups) >= max_groups:
                    raise MoleculeBudgetError('Regional molecule index exceeds its collection budget; narrow the region')
                groups[name] = dict(primary=False, primaries=[], supp=None, selected=None, records=[], size=0)
            group = groups[name]
            group['primary'] |= not read.is_supplementary
            if not status:
                continue
            if group['selected'] is None:
                group['selected'] = keep(name) if keep is not None else True
            extent = (read.reference_start, read.reference_end)
            if not read.is_supplementary:
                group['primaries'].append(extent)
            elif group['supp'] is None or alignment_order(read) < group['supp'][0]:
                group['supp'] = (alignment_order(read), extent)
            if not group['selected']:
                continue
            if isinstance(read, pysam.AlignedSegment):
                header = read.header if header is None else header
                data = read.to_string().encode('utf-8')
                group['size'] += len(data)
                if group['size'] > raw_budget_bytes:
                    raise MoleculeBudgetError('A molecule exceeds the raw alignment budget; narrow the region')
                offset = spool.tell()
                spool.write(data)
                group['records'].append((offset, len(data)))
                del data
            else:  # Small protocol/test records without pysam serialization.
                group['size'] += len(getattr(read, 'query_sequence', '') or '') * 4 + 4096
                if group['size'] > raw_budget_bytes:
                    raise MoleculeBudgetError('A molecule exceeds the raw alignment budget')
                group['records'].append(read)
        for i, group in enumerate(groups.values()):
            if not i & 255:
                checkpoint()
            if group['primary'] and not group['primaries']:
                continue  # a filtered primary must not be rescued through a supplementary
            if not group['selected']:
                if on_skipped is not None:
                    for extent in group['primaries'] or ([group['supp'][1]] if group['supp'] else []):
                        on_skipped(*extent)
                continue
            bundle = []
            for entry in group['records']:
                if isinstance(entry, tuple):
                    offset, size = entry
                    spool.seek(offset)
                    bundle.append(pysam.AlignedSegment.fromstring(spool.read(size).decode('utf-8'), header))
                else:
                    bundle.append(entry)
            if bundle:
                bundle.sort(key=alignment_order)
                yield bundle


def molecule_alignments(records, eligible, **collection):
    for bundle in molecule_bundles(records, eligible, **collection):
        primaries = [read for read in bundle if not read.is_supplementary]
        # Primary source occurrences remain addressable for consensus overlays;
        # supplementary segments never introduce a second row.
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
