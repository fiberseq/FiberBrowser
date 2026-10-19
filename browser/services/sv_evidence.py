"""Shared, sequence-free native SV evidence, before consumer cohort policies.

The cached superset retains duplicates and all signal-eligible molecules. Safe
name/duplicate filtering happens *after* extraction, with primary rejection
applied to the whole molecule in each file. Calls, sequence enrichment and
presentation thresholds never enter this cache. Paths/stamps are invalidation
locators, not permanent observation or allele identities.
"""
from __future__ import annotations

import threading

from services.background_work import checkpoint
from services.byte_cache import shared_cache

EXTRACTION_VERSION = 'native-sv-scan:v2'
NORMALIZATION_VERSION = 'cigar-replacements:v1'
SCAN_MAX_SPAN = 2_000_000
SCAN_MAX_RECORDS = 100_000
SCAN_MAX_BYTES = 128 * 1024 * 1024
SCAN_CACHE = shared_cache('indexes')
SCAN_LOCK = threading.Lock()


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
    """Publish complete, bounded view tiles with explicit zero-halo ownership.

    Molecule eligibility can depend on a primary elsewhere in the fetched
    view. A cropped/extended scan is therefore not generally the same cohort.
    Share only identical region/halo scopes; never assemble eligibility from
    separately spooled fragments. Classification/normalization still sees each
    record's full CIGAR, including edits outside the core.
    """
    check()
    if end - start > SCAN_MAX_SPAN:
        from services.reconstruction_budget import ResourceResult
        raise ResourceResult('budget_exceeded', 'native_scan_region', max_span=SCAN_MAX_SPAN)
    key = None if stamps is None else (scope_key(state, dataset, dataset_id, chrom, floor, stamps),
                                       int(start), int(end), 'halo:0;cohort:loaded')
    if key is not None:
        with SCAN_LOCK:
            entry = SCAN_CACHE.get(key)
            if entry is not None:
                SCAN_CACHE.move_to_end(key)
        if entry is not None:
            check()
            return list(entry)
    result = scanner(state, dataset_id, chrom, start, end, floor)
    check()
    if key is not None and end - start <= SCAN_MAX_SPAN:
        with SCAN_LOCK:
            SCAN_CACHE[key] = result
            SCAN_CACHE.move_to_end(key)
    return list(result)


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
