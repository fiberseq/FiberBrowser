"""Regional molecule bundles; raw alignments remain distinct from display rows."""
from __future__ import annotations

import json
import os
import tempfile
from array import array
from contextlib import ExitStack
from copy import copy

EVIDENCE_FIELDS = ('id', 'reference_start', 'reference_end', 'file_chrom', 'sv', 'sv_evidence',
                   'aligned_blocks', 'sv_segments', 'sequence_span', 'supplementary')


def alignment_order(read):
    return (bool(read.is_supplementary), -int(getattr(read, 'mapping_quality', 0) or 0), int(read.reference_start),
            getattr(read, 'cigarstring', None) or '', bool(read.is_reverse))


# Small selections have a bounded memory buffer; spooled loads materialize one
# molecule at a time. Oversized bundles fail rather than lose evidence.
MOLECULE_RAW_BYTES = 64 * 1024 * 1024
MOLECULE_MEMORY_BYTES = 64 * 1024 * 1024
MOLECULE_MAX_GROUPS = 250_000
_BAM_TAG_WIDTHS = {'A': 1, 'c': 1, 'C': 1, 's': 2, 'S': 2, 'i': 4, 'I': 4, 'f': 4, 'd': 8}


class MoleculeBudgetError(MemoryError):
    pass


class MoleculeBundle(list):
    def __init__(self, records, source_order):
        super().__init__(records)
        self.source_order = source_order


def _buffered_record_size(read):
    """Conservative bytes for a copied BAM record, whose field caches are empty.

    Count its binary fields rather than formatting large numeric tags as SAM.
    Allow twice the data size for htslib allocation capacity, plus bookkeeping.
    Unknown tag types use the disk spool instead.
    """
    # C-level operation counts avoid allocating every CIGAR tuple just to
    # measure it; complex native alignments can contain thousands of them.
    data = len(read.query_name or '') + 4 + 4 * sum(read.get_cigar_stats()[1])
    length = int(read.query_length or 0)
    data += (length + 1) // 2 + length
    for _tag, value, kind in read.get_tags(with_value_type=True):
        data += 3  # two-byte tag and its type
        if kind == 'B':
            data += 5 + len(value) * value.itemsize
        elif kind in ('Z', 'H'):
            data += len(value.encode('utf-8')) + 1
        elif kind in _BAM_TAG_WIDTHS:
            data += _BAM_TAG_WIDTHS[kind]
        else:
            return None
    return 2 * data + 4096


def molecule_bundles(records, eligible, *, keep=None, on_skipped=None,
                     raw_budget_bytes=MOLECULE_RAW_BYTES, max_groups=MOLECULE_MAX_GROUPS,
                     memory_budget_bytes=None):
    """Buffer small selections; spill larger ones losslessly to a BAM spool.

    Coordinate order cannot close a molecule before its later segments arrive.
    A bounded buffer avoids a disk round trip for ordinary viewports. A temporary
    spool bounds larger loads without an arbitrary genomic-distance cutoff.
    The buffer is enabled by default only for foreground read requests.
    Selection and cancellation happen during collection, before retention.
    No remote name lookup or user application-directory storage is used.
    """
    from services.background_work import checkpoint, is_interactive_read
    import pysam
    if memory_budget_bytes is None:
        memory_budget_bytes = MOLECULE_MEMORY_BYTES if is_interactive_read() else 0
    groups = {}
    offsets = array('Q')
    with ExitStack() as handles:
        pending = []
        memory_bytes = 0
        writer = None

        def spool_record(read, group):
            nonlocal writer, path
            if writer is None:
                directory = handles.enter_context(tempfile.TemporaryDirectory(prefix='fiberbrowser-molecules-'))
                path = os.path.join(directory, 'alignments.bam')
                writer = handles.enter_context(pysam.AlignmentFile(path, 'wb0', header=read.header))
            offset = writer.tell()
            writer.write(read)
            end = writer.tell()
            group['size'] += (end >> 16) + (end & 65535) - (offset >> 16) - (offset & 65535)
            if group['size'] > raw_budget_bytes:
                raise MoleculeBudgetError('A molecule exceeds the raw alignment budget; narrow the region')
            ordinal = len(offsets)
            offsets.append(offset)
            return ordinal

        path = None
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
            # A supplementary can precede a filtered local primary. Spool it
            # provisionally, but never consult the sampler for that rejected
            # molecule. Most molecules select at their eligible primary here.
            if group['selected'] is None and not read.is_supplementary:
                group['selected'] = bool(keep(name)) if keep is not None else True
            extent = (read.reference_start, read.reference_end)
            if not read.is_supplementary:
                group['primaries'].append(extent)
            elif group['supp'] is None or alignment_order(read) < group['supp'][0]:
                group['supp'] = (alignment_order(read), extent)
            if group['selected'] is False:
                continue
            if isinstance(read, pysam.AlignedSegment):
                if writer is None:
                    try:
                        size = _buffered_record_size(read) if memory_budget_bytes > 0 else None
                    except (AttributeError, TypeError, ValueError, OverflowError):
                        size = None  # An unusual tag must not defeat lossless spooling.
                    if (size is not None and memory_bytes + size <= memory_budget_bytes
                            and group['size'] + size <= raw_budget_bytes):
                        retained = copy(read)
                        group['size'] += size
                        memory_bytes += size
                        pending.append((retained, group, len(group['records']), size))
                        group['records'].append(retained)
                        continue
                    # Preserve write order and the original serialized budget
                    # checks when the conservative memory estimate overflows.
                    for j, (buffered, buffered_group, slot, size) in enumerate(pending):
                        if not j & 255:
                            checkpoint()
                        buffered_group['size'] -= size
                        buffered_group['records'][slot] = spool_record(buffered, buffered_group)
                    pending.clear()
                group['records'].append(spool_record(read, group))
            else:  # Small protocol/test records without pysam serialization.
                group['size'] += len(getattr(read, 'query_sequence', '') or '') * 4 + 4096
                if group['size'] > raw_budget_bytes:
                    raise MoleculeBudgetError('A molecule exceeds the raw alignment budget')
                group['records'].append(read)
        if writer is not None:
            writer.close()
            spool = handles.enter_context(pysam.AlignmentFile(path, 'rb'))
        source_order = 0
        spool_position = 0
        for i, (name, group) in enumerate(groups.items()):
            if not i & 255:
                checkpoint()
            if group['primary'] and not group['primaries']:
                continue  # a filtered primary must not be rescued through a supplementary
            first_order = source_order
            source_order += len(group['primaries']) or (1 if group['supp'] else 0)
            if group['selected'] is None:
                group['selected'] = bool(keep(name)) if keep is not None else True
            if not group['selected']:
                if on_skipped is not None:
                    for extent in group['primaries'] or ([group['supp'][1]] if group['supp'] else []):
                        on_skipped(name, *extent)
                continue
            bundle = []
            for entry in group['records']:
                if isinstance(entry, int):
                    # Continue consecutive records without reloading their
                    # BGZF block. Writer and reader virtual offsets can differ
                    # at block boundaries, so track the serialized ordinal.
                    if spool_position != entry:
                        spool.seek(offsets[entry])
                    bundle.append(next(spool))
                    spool_position = entry + 1
                else:
                    bundle.append(entry)
            if bundle:
                bundle.sort(key=alignment_order)
                yield MoleculeBundle(bundle, first_order)


def molecule_alignments(records, eligible, *, with_source_order=False, **collection):
    for bundle in molecule_bundles(records, eligible, **collection):
        primaries = [read for read in bundle if not read.is_supplementary]
        # Primary source occurrences remain addressable for consensus overlays;
        # supplementary segments never introduce a second row.
        for i, anchor in enumerate(primaries or [bundle[0]]):
            evidence = bundle if any(read.is_supplementary for read in bundle) else [anchor]
            if with_source_order:
                yield anchor, evidence, bundle.source_order + i + 1
            else:
                yield anchor, evidence


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
