"""Extend a complete BAM cohort by reading only newly exposed reference ranges.

The requested coordinate frame and the indexed fetch ranges are independent:
an edge-crossing molecule is decoded across the whole new view and replaces its
old clipped copy. Records wholly in the overlap retain their cached evidence.
"""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar

edge_fetch_regions = ContextVar('edge_fetch_regions', default=None)


class EdgeFetchUnsupported(ValueError):
    """The source requires the ordinary full-view loader."""


def iter_edge_records(bam, chrom, start, end, regions=None):
    """Yield each physical record once, including identical primary records.

    A record returned by a later range also occurred in an earlier range iff
    its alignment overlaps that earlier range. This avoids QNAME deduplication
    and does not depend on virtual offsets (which differ for BAM and CRAM).
    """
    if regions is None:
        yield from bam.fetch(chrom, start, end)
        return
    previous = []
    for left, right in regions:
        if not (start <= left < right <= end) or (previous and left < previous[-1][1]):
            raise ValueError('Edge fetch ranges must be ordered, disjoint and inside the view')
        for record in bam.fetch(chrom, left, right):
            lo, hi = record.reference_start, record.reference_end
            if any(lo < b and hi is not None and hi > a for a, b in previous):
                continue
            yield record
        previous.append((left, right))


@contextmanager
def fetching_edges(regions):
    token = edge_fetch_regions.set(tuple(regions))
    try:
        yield
    finally:
        edge_fetch_regions.reset(token)


def exposed_ranges(old_start, old_end, start, end):
    if not (old_start < end and start < old_end):
        return None
    ranges = []
    if start < old_start:
        ranges.append((start, old_start))
    if end > old_end:
        ranges.append((old_end, end))
    return ranges


def alignment_identity(read):
    fields = ('library_id', 'record_sha256', 'alignment_occurrence')
    if any(read.get(key) is None for key in fields):
        return None
    return tuple(read[key] for key in fields)


def extend_direct_cohort(reads, old_start, old_end, start, end, load_edges):
    """Return an exact cohort in the new frame, or None for a normal reload.

    The caller owns source-generation checks and only supplies compatible,
    complete, unfiltered linear BAM cache entries. No partial extension is
    published when a source fails or a record lacks alignment identity.
    """
    ranges = exposed_ranges(old_start, old_end, start, end)
    if not ranges or getattr(reads, 'sample_level', 0):
        return None
    keep = []
    identities = set()
    from services.background_work import checkpoint
    for index, read in enumerate(reads):
        if index % 256 == 0:
            checkpoint()
        identity = alignment_identity(read)
        lo, hi = read.get('reference_start'), read.get('reference_end')
        if (identity is None or identity in identities or not isinstance(lo, int) or not isinstance(hi, int)
                or read.get('alignment_spans') or read.get('cigar') or read.get('circular_ids')
                or '_fiberbrowser_terminal_gaps' not in read):
            return None
        identities.add(identity)
        if hi <= start or lo >= end or any(lo < b and hi > a for a, b in ranges):
            continue
        keep.append(read)
    from services.direct_read_projection import project_direct_reads
    projected = project_direct_reads(keep, old_start, start, end)
    if projected is None:
        return None
    try:
        with fetching_edges(ranges):
            incoming = load_edges()
    except EdgeFetchUnsupported:
        return None
    identities = {alignment_identity(read) for read in projected}
    for index, read in enumerate(incoming):
        if index % 256 == 0:
            checkpoint()
        identity = alignment_identity(read)
        lo, hi = read.get('reference_start'), read.get('reference_end')
        if (identity is None or identity in identities or not isinstance(lo, int) or not isinstance(hi, int)
                or read.get('alignment_spans') or read.get('cigar') or read.get('circular_ids')
                or '_fiberbrowser_terminal_gaps' not in read
                or not any(lo < b and hi > a for a, b in ranges)):
            return None
        identities.add(identity)
        projected.append(read)
    projected.sort(key=lambda read: read['reference_start'])
    return projected, ranges
