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
    yield state, dataset
    evidence.SCAN_CACHE.clear()


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
