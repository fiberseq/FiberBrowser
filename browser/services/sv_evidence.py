"""Shared, sequence-free native SV evidence, before consumer cohort policies.

The cached superset retains duplicates and all signal-eligible molecules. Safe
name/duplicate filtering happens *after* extraction, with primary rejection
applied to the whole molecule in each file. Calls, sequence enrichment and
presentation thresholds never enter this cache. Paths/stamps are invalidation
locators, not permanent observation or allele identities.
"""
from __future__ import annotations

import threading
from contextlib import contextmanager
from contextvars import ContextVar

from services.background_work import checkpoint
from services.byte_cache import shared_cache
from services.byte_cache import retained_size

EXTRACTION_VERSION = 'native-sv-scan:v3'
NORMALIZATION_VERSION = 'cigar-replacements:v1'
SCAN_MAX_SPAN = 2_000_000
SCAN_MAX_RECORDS = 100_000
SCAN_MAX_BYTES = 128 * 1024 * 1024
SCAN_CACHE = shared_cache('indexes')
SCAN_LOCK = threading.Lock()
SIZE_HINT_BYTES = 4 * 1024 * 1024
SIZE_HINT_CACHE = shared_cache('indexes')
SIZE_HINT_CACHE.resize(SIZE_HINT_BYTES)
SIZE_HINT_LOCK = threading.Lock()
_records = ContextVar('native_scan_records', default=None)


def reusable_record(key):
    records = _records.get()
    return records.get(key) if records is not None else None


def compact_bytes(entry, floor, *, reusable):
    """Reuse geometry-derived estimates even when a whole tile cannot fit.

    Hints contain no evidence or calls. Sequence/reference-normalized records
    are measured afresh; sequence-free geometry is fully identified by the
    producer, floor, file contig and complete compact-record key.
    """
    key = (EXTRACTION_VERSION, NORMALIZATION_VERSION, int(floor),
           entry['file_chrom'], entry['_key']) if reusable else None
    if key is not None:
        with SIZE_HINT_LOCK:
            size = SIZE_HINT_CACHE.get(key)
            if size is not None:
                SIZE_HINT_CACHE.move_to_end(key)
                return size
    size = retained_size(entry) + 128  # includes the subsequently added hint
    if key is not None:
        with SIZE_HINT_LOCK:
            # Shared host configuration may lower this limit, never enlarge it.
            if SIZE_HINT_CACHE.max_bytes > SIZE_HINT_BYTES:
                SIZE_HINT_CACHE.resize(SIZE_HINT_BYTES)
            SIZE_HINT_CACHE[key] = size
    return size


@contextmanager
def reuse_records(entries):
    token = _records.set({c['_key']: c for c in entries})
    try:
        yield
    finally:
        _records.reset(token)


class ScanCancelled(RuntimeError):
    """An explicit consumer callback cancelled before a complete scan."""



def scope_key(state, dataset, dataset_id, chrom, floor, stamps):
    from services.dataset_generation import dataset_generation
    from services.plasmid_reconcile import contig_links
    from services.signal_evidence import signal_filter_key
    from services.sv_alleles import reference_identity
    from services.sv_endpoint import _path_stamps
    links = tuple(repr(contig_links(state, path=path)) for path, *_ in stamps)
    reference = reference_identity(state)
    reference_revision = _path_stamps([reference[0]]) if reference[0] else None
    return (EXTRACTION_VERSION, NORMALIZATION_VERSION, 'native_only', dataset_id,
            dataset_generation(state, dataset_id), stamps, links, chrom, int(floor),
            repr(getattr(state, 'chrom_map', None)), signal_filter_key(state),
            reference, reference_revision, 'all-signal-eligible;duplicates-retained',
            repr(getattr(dataset, 'molecule_groups', [])), getattr(dataset, 'joint_dedup', 'off'),
            SCAN_MAX_RECORDS, SCAN_MAX_BYTES)


def scan_region(state, dataset, dataset_id, chrom, start, end, floor, *, stamps, scanner, check=checkpoint):
    """Reuse positive eligibility; filtered molecules require exact view scopes.

    With no signal filter the producer retains every nonhidden eligible record,
    so extraction is independent of which primary lies in the fetched region.
    Duplicate/name selection is still applied after cropping. Signal-filtered
    bundles can suppress a supplementary through a rejected local primary and
    must never be reconstructed by cropping or joining separately spooled views.
    """
    check()
    if end - start > SCAN_MAX_SPAN:
        from services.reconstruction_budget import ResourceResult
        raise ResourceResult('budget_exceeded', 'native_scan_region', max_span=SCAN_MAX_SPAN)
    from services.signal_evidence import signal_filter_key
    independent = not any(signal_filter_key(state))
    ownership = ('positive-eligibility',) if independent else (int(start), int(end), 'halo:0;cohort:loaded')
    key = None if stamps is None else (scope_key(state, dataset, dataset_id, chrom, floor, stamps), *ownership)
    if key is not None:
        with SCAN_LOCK:
            entry = SCAN_CACHE.get(key)
            if entry is not None:
                SCAN_CACHE.move_to_end(key)
        if entry is not None:
            check()
            if not independent:
                return list(entry['entries'])
            if entry['lo'] <= start and end <= entry['hi']:
                return _crop(entry['entries'], start, end, check)
    else:
        entry = None
    extending = (independent and entry is not None and start <= entry['hi'] and end >= entry['lo']
                 and max(end, entry['hi']) - min(start, entry['lo']) <= SCAN_MAX_SPAN)
    if extending:
        from services.byte_cache import retained_size
        from services.reconstruction_budget import ResourceResult
        added = []
        # Sequence-free geometry can reuse immutable compact records. Reference
        # normalization may inspect SEQ, so that mode only reuses region scans.
        known = entry['entries'] if getattr(state, 'fasta', None) is None and not getattr(state, 'fasta_path', None) else []
        with reuse_records(known):
            if start < entry['lo']:
                check()
                added += scanner(state, dataset_id, chrom, start, entry['lo'], floor)
            if end > entry['hi']:
                check()
                added += scanner(state, dataset_id, chrom, entry['hi'], end, floor)
        seen = {c['_key'] for c in entry['entries']}
        result = list(entry['entries'])
        for i, c in enumerate(added):
            if not i & 255:
                check()
            if c['_key'] not in seen:
                seen.add(c['_key']); result.append(c)
        if len(result) > SCAN_MAX_RECORDS or retained_size(result) > SCAN_MAX_BYTES:
            raise ResourceResult('budget_exceeded', 'native_scan_merge', max_records=SCAN_MAX_RECORDS, max_bytes=SCAN_MAX_BYTES)
        lo, hi = min(start, entry['lo']), max(end, entry['hi'])
    else:
        result = scanner(state, dataset_id, chrom, start, end, floor)
        lo, hi = int(start), int(end)
    check()
    if key is not None and end - start <= SCAN_MAX_SPAN:
        with SCAN_LOCK:
            SCAN_CACHE[key] = dict(lo=lo, hi=hi, entries=result)
            SCAN_CACHE.move_to_end(key)
    return _crop(result, start, end, check) if independent else list(result)


def _crop(entries, start, end, check):
    result = []
    for i, c in enumerate(entries):
        if not i & 255:
            check()
        if c['reference_end'] > start and c['reference_start'] < end:
            result.append(c)
    check()
    return result


def select_cohort(entries, *, read_ids=None, include_duplicates=True):
    """Filter the raw superset without rescuing a rejected primary via SA.

    Legacy consumers merge QNAMEs across files only at classification. Duplicate
    eligibility is decided per input file, as it was during BAM spooling.
    """
    if read_ids is None and include_duplicates:
        return entries
    def molecule(c):
        return (c.get('_key', (None,))[0], c['id'])
    kept_primary, primary = set(), set()
    for i, c in enumerate(entries):
        if not i & 255:
            checkpoint()
        if not c.get('supplementary'):
            primary.add(molecule(c))
            if include_duplicates or not c.get('duplicate'):
                kept_primary.add(molecule(c))
    return [c for c in entries if (read_ids is None or c['id'] in read_ids)
            and (include_duplicates or not c.get('duplicate'))
            and (molecule(c) not in primary or molecule(c) in kept_primary)]
