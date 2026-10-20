"""Independent BAM/count and cache-scope controls for the two legacy adapters."""
from copy import copy
from types import SimpleNamespace
import threading
import time

import pysam
import pytest

from services import sv_endpoint as sv, sv_evidence as evidence, variants_endpoint as variants
from services.background_work import Cancelled, cancel_scope


@pytest.fixture
def cohort(tmp_path):
    path = tmp_path / 'synthetic.bam'
    header = {'HD': {'SO': 'coordinate'}, 'SQ': [{'SN': 'chrT', 'LN': 10000}]}
    with pysam.AlignmentFile(path, 'wb', header=header) as bam:
        for name, flag, cigar in [('alternate', 0, '200M100I200M'), ('reference', 0, '400M'),
                                  ('rejected', 1024, '200M100I200M'), ('rejected', 2048, '200M100I200M')]:
            r = pysam.AlignedSegment(bam.header)
            r.query_name, r.flag, r.reference_id, r.reference_start, r.mapping_quality = name, flag, 0, 1000, 60
            r.cigarstring = cigar
            r.query_sequence = 'A' * (500 if 'I' in cigar else 400)
            bam.write(r)
    pysam.index(str(path))
    dataset = SimpleNamespace(id='native', data_type='bam', paths=[str(path)])
    state = SimpleNamespace(datasets={'native': dataset}, dataset_order=['native'],
                            get_dataset=lambda key: dataset if key == 'native' else None)
    evidence.SCAN_CACHE.clear()
    evidence.SIZE_HINT_CACHE.clear()
    yield state, dataset
    evidence.SCAN_CACHE.clear()
    evidence.SIZE_HINT_CACHE.clear()


def split(state, **kwargs):
    return sv.sv_split_payload(state, dataset_id='native', chrom='chrT', start=900, end=1500,
                              t='I', ref=1200, length=100, margin=20, **kwargs)


def test_variants_split_and_selection_share_raw_extraction_without_sharing_calls(cohort, monkeypatch):
    state, _ = cohort
    original, calls = sv._scan, []
    def scan(*args, **kwargs):
        calls.append((args[3], args[4], args[5]))
        return original(*args, **kwargs)
    monkeypatch.setattr(sv, '_scan', scan)
    assert split(state)['counts'] == [1, 1, 0]
    # The duplicate primary cannot be rescued by its nonduplicate supplement.
    result = variants.svs_payload(state, dict(dataset_id='native', chrom='chrT', start=900, end=1500, min_len=50))
    assert result['n_reads'] == 2
    assert len(result['clusters']) == 1 and result['clusters'][0]['support'] == 1
    selected = copy(state)
    selected._variant_read_ids = frozenset(['reference'])
    assert split(selected)['counts'] == [0, 1, 0]
    assert split(state, include_duplicates=True)['counts'] == [2, 1, 0]
    # A display threshold changes summaries, not the fixed 10-base extraction.
    hidden = variants.svs_payload(state, dict(dataset_id='native', chrom='chrT', start=900, end=1500, min_len=200))
    assert hidden['clusters'] == [] and len(calls) == 1
    assert calls == [(900, 1500, 10)]


def test_extraction_scope_includes_reference_provenance_signal_and_generation(cohort, monkeypatch):
    state, dataset = cohort
    calls = []
    monkeypatch.setattr(sv, '_scan', lambda *args, **kwargs: calls.append(1) or [])
    monkeypatch.setattr('services.signal_evidence.signal_filter_key', lambda s: getattr(s, 'signal', ()))
    def scan():
        sv.scan_view(state, 'native', 'chrT', 900, 1500, 10)
    scan(); scan()
    assert len(calls) == 1
    state.signal = ('different-eligibility',)
    scan()
    state._dataset_generations = {'native': 1}
    scan()
    dataset.molecule_groups = [['library-b']]
    scan()
    state.fasta = object()
    scan()
    state.chrom_map = {'chrT': 'another-contig'}
    scan()
    monkeypatch.setattr(evidence, 'EXTRACTION_VERSION', 'synthetic-next-producer')
    scan()
    assert len(calls) == 7


def test_pan_order_eviction_and_partial_scan_never_rebind_a_complete_tile(cohort, monkeypatch):
    state, _ = cohort
    expected = split(state)
    sv.scan_view(state, 'native', 'chrT', 800, 1600, 10)
    assert split(state) == expected
    evidence.SCAN_CACHE.clear()
    assert split(state) == expected
    evidence.SCAN_CACHE.clear()
    original = sv._scan
    def interrupted(*args, **kwargs):
        original(*args, **kwargs)
        raise Cancelled()
    monkeypatch.setattr(sv, '_scan', interrupted)
    with pytest.raises(Cancelled):
        split(state)
    assert not evidence.SCAN_CACHE
    monkeypatch.setattr(sv, '_scan', original)
    assert split(state) == expected


def test_variants_callback_stops_collection_and_does_not_cache(cohort, monkeypatch):
    state, _ = cohort
    seen = []
    def records(*args, checkpoint_fn=None, **kwargs):
        for i in range(1000):
            checkpoint_fn()
            seen.append(i)
            # Cancellation must run before attempting a record decode.
            yield None, None, None, None
    monkeypatch.setattr(sv, '_bam_records', records)
    monkeypatch.setattr(sv, '_compact_record', lambda *args, **kwargs: {'id': 'synthetic'})
    # First checkpoint in scan_view is followed by _bam_records' checkpoint.
    checks = []
    def cancelled():
        checks.append(1)
        return len(checks) >= 3
    with pytest.raises(variants.VariantsCancelled):
        variants._sv_compact(state, 'native', 'chrT', 900, 1500, 10, False, cancelled)
    assert not seen and not evidence.SCAN_CACHE


def test_warm_scan_obeys_server_abort_before_returning_cached_evidence(cohort):
    state, _ = cohort
    split(state)
    event = threading.Event()
    event.set()
    began = time.monotonic()
    with cancel_scope(event), pytest.raises(Cancelled):
        split(state)
    assert time.monotonic() - began < .250
    # The previously complete result survives; the aborted caller received none.
    assert split(state)['counts'] == [1, 1, 0]


@pytest.mark.parametrize(('limit', 'reason'), [('SCAN_MAX_RECORDS', 'native_scan_records'), ('SCAN_MAX_BYTES', 'native_scan_bytes')])
def test_scope_budget_refusal_cannot_poison_a_complete_scan(cohort, monkeypatch, limit, reason):
    from services.reconstruction_budget import ResourceResult
    state, _ = cohort
    assert split(state)['counts'] == [1, 1, 0]
    with monkeypatch.context() as patch:
        patch.setattr(evidence, limit, 1)
        with pytest.raises(ResourceResult, match=reason):
            split(state)
    assert split(state)['counts'] == [1, 1, 0]


def test_region_refusal_precedes_decoding(cohort, monkeypatch):
    from services.reconstruction_budget import ResourceResult
    state, _ = cohort
    monkeypatch.setattr(sv, '_scan', lambda *a, **k: pytest.fail('refuse before decode'))
    with pytest.raises(ResourceResult, match='native_scan_region'):
        sv.scan_view(state, 'native', 'chrT', 0, evidence.SCAN_MAX_SPAN + 1, 10)


def test_exact_regions_preserve_primary_eligibility_that_a_broad_crop_cannot(tmp_path, monkeypatch):
    path = tmp_path / 'eligibility.bam'
    with pysam.AlignmentFile(path, 'wb', header={'HD': {'SO': 'coordinate'}, 'SQ': [{'SN': 'chrT', 'LN': 10000}]}) as bam:
        for start, flag, cigar, length in [(100, 1024, '100M', 100), (1000, 2048, '200M100I200M', 500)]:
            read = pysam.AlignedSegment(bam.header)
            read.query_name, read.reference_id, read.reference_start, read.flag = 'molecule', 0, start, flag
            read.cigarstring, read.query_sequence, read.mapping_quality = cigar, 'A'*length, 60
            bam.write(read)
    pysam.index(str(path))
    dataset = SimpleNamespace(id='native', data_type='bam', paths=[str(path)])
    state = SimpleNamespace(get_dataset=lambda _: dataset, datasets={'native': dataset}, dataset_order=['native'])
    # A rejected signal primary suppresses the whole fetched molecule. In the
    # narrower loaded cohort that primary is absent, so the actual supplementary
    # remains inspectable. Cropping the already-suppressed broad result loses it.
    monkeypatch.setattr('services.signal_evidence.record_keeps_signal', lambda read, _provenance: not read.is_duplicate)
    monkeypatch.setattr('services.signal_evidence.signal_filter_key', lambda *args: (True, False, False, False))
    evidence.SCAN_CACHE.clear()

    assert sv.scan_view(state, 'native', 'chrT', 0, 1500, 10) == []
    narrow = sv.scan_view(state, 'native', 'chrT', 900, 1500, 10)
    assert len(narrow) == 1 and narrow[0]['supplementary']
    assert narrow[0]['sv'][0]['ref'] == 1200
    evidence.SCAN_CACHE.clear()
    assert sv.scan_view(state, 'native', 'chrT', 900, 1500, 10) == narrow
    assert sv.scan_view(state, 'native', 'chrT', 0, 1500, 10) == []
    evidence.SCAN_CACHE.clear()


def test_positive_eligibility_reuses_compaction(cohort, monkeypatch):
    state, _ = cohort
    original = sv._compact_record
    decoded = []
    def compact(*args, **kwargs):
        decoded.append(1)
        return original(*args, **kwargs)
    monkeypatch.setattr(sv, '_compact_record', compact)
    sv.scan_view(state, 'native', 'chrT', 900, 1400, 10)
    first = len(decoded)
    sv.scan_view(state, 'native', 'chrT', 950, 1450, 10)
    assert len(decoded) == first  # overlapping records need no second extraction
    assert split(state)['counts'] == [1, 1, 0]


def test_oversized_tiles_reuse_estimates_without_reusing_evidence_or_weakening_limits(cohort, monkeypatch):
    from services.reconstruction_budget import ResourceResult
    state, _ = cohort
    estimates, decodes = [], []
    original_size, original_compact = evidence.retained_size, sv._compact_record
    def measure(entry):
        estimates.append(entry['_key'])
        return original_size(entry)
    def compact(*args, **kwargs):
        decodes.append(1)
        return original_compact(*args, **kwargs)
    monkeypatch.setattr(evidence, 'retained_size', measure)
    monkeypatch.setattr(sv, '_compact_record', compact)
    monkeypatch.setattr(evidence.SCAN_CACHE, 'max_bytes', 0)
    expected = split(state)
    assert len(estimates) == len(decodes) == 4 and not evidence.SCAN_CACHE
    assert split(state) == expected
    assert len(estimates) == 4 and len(decodes) == 8
    # A different floor measures different extraction rather than borrowing sizes.
    sv.scan_view(state, 'native', 'chrT', 900, 1500, 50)
    assert len(estimates) == 8
    monkeypatch.setattr(evidence, 'SCAN_MAX_BYTES', 1)
    with pytest.raises(ResourceResult, match='native_scan_bytes'):
        split(state)
    assert not evidence.SCAN_CACHE


def test_size_hints_are_bounded_versioned_and_bypassed_for_normalized_records(cohort, monkeypatch):
    from services.byte_cache import ByteCache
    state, _ = cohort
    entry = sv.scan_view(state, 'native', 'chrT', 900, 1500, 10)[0].copy()
    entry.pop('_scan_bytes')
    evidence.SIZE_HINT_CACHE.clear()
    estimates, original = [], evidence.retained_size
    def measure(value):
        estimates.append(1)
        return original(value)
    monkeypatch.setattr(evidence, 'retained_size', measure)
    first = evidence.compact_bytes(entry, 10, reusable=True)
    assert evidence.compact_bytes(entry, 10, reusable=True) == first
    assert len(estimates) == 1
    monkeypatch.setattr(evidence, 'NORMALIZATION_VERSION', 'synthetic-next-normalizer')
    assert evidence.compact_bytes(entry, 10, reusable=True) == first
    for _ in range(2):
        assert evidence.compact_bytes(entry, 10, reusable=False) == first
    assert len(estimates) == 4
    bounded = ByteCache(1)
    monkeypatch.setattr(evidence, 'SIZE_HINT_CACHE', bounded)
    assert evidence.compact_bytes(entry, 10, reusable=True) == first
    assert not bounded and bounded.retained_bytes == 0


@pytest.mark.parametrize('seed', [901, 1547, 6091])
def test_heldout_authored_molecule_counts_survive_consumer_order_and_eviction(tmp_path, seed):
    import random
    rng = random.Random(seed)
    carriers, references = rng.randint(3, 9), rng.randint(3, 9)
    anchor = rng.randint(2000, 4000)
    path = tmp_path / 'heldout.bam'
    with pysam.AlignmentFile(path, 'wb', header={'HD': {'SO': 'coordinate'}, 'SQ': [{'SN': 'chrT', 'LN': 10000}]}) as bam:
        # These independent expected labels are authored before BAM extraction.
        expected = {f'molecule-{i}': int(i >= carriers) for i in range(carriers + references)}
        for i, (name, group) in enumerate(expected.items()):
            read = pysam.AlignedSegment(bam.header)
            read.query_name, read.flag, read.reference_id = name, 16 if rng.randrange(2) else 0, 0
            read.reference_start, read.mapping_quality = anchor - 200, 60
            read.cigarstring = '200M100I200M' if group == 0 else '400M'
            read.query_sequence = ('A' if i % 2 else 'C') * (500 if group == 0 else 400)
            bam.write(read)
    pysam.index(str(path))
    ds = SimpleNamespace(id='heldout', data_type='bam', paths=[str(path)])
    state = SimpleNamespace(datasets={'heldout': ds}, dataset_order=['heldout'], get_dataset=lambda _: ds)
    body = dict(dataset_id='heldout', chrom='chrT', start=anchor-250, end=anchor+250, min_len=50)
    for order in [False, True]:
        evidence.SCAN_CACHE.clear()
        if order:
            variants.svs_payload(state, body)
        result = sv.sv_split_payload(state, dataset_id='heldout', chrom='chrT', start=anchor-250, end=anchor+250,
                                     t='I', ref=anchor, length=100, margin=20, payload_version=2)
        assert result['assignments'] == expected
        assert result['counts'] == [carriers, references, 0]
        assert result['differences']['exact_counts'] == {'target': 0, 'reference': 0, 'unknown': carriers + references}
        summary = variants.svs_payload(state, body)
        assert summary['clusters'][0]['support'] == carriers
        assert summary['clusters'][0]['informative'] == carriers + references
    evidence.SCAN_CACHE.clear()
