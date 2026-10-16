"""Early sampling keeps complete molecular evidence and isolated caches."""
import random

import pytest

from services.cluster_sample import (prepare_cluster_sample, select_names, using_cluster_sample,
                                     using_assigned_cluster_reads)
from services.read_metrics import DEFAULT_SAMPLE_SEED


def test_selection_is_stable_bounded_and_nested_with_display():
    from services.read_sampling import keeps, name_hash
    names = [f'read_{i}' for i in range(4000)]
    expected = frozenset(sorted(names, key=lambda n: (name_hash(n), n))[:1000])
    shuffled = names * 3
    random.Random(42).shuffle(shuffled)
    assert select_names(iter(shuffled), 1000, DEFAULT_SAMPLE_SEED) == expected
    assert {n for n in names if keeps(n, 4)} <= expected
    assert select_names(iter(names), 1000, 'other') != expected
    assert select_names(iter(names[:10]), 1000, DEFAULT_SAMPLE_SEED) == frozenset(names[:10])
    assert select_names(iter(names[:10] * 3), 10, DEFAULT_SAMPLE_SEED, with_status=True)[1] is False
    assert select_names(iter(names[:11]), 10, DEFAULT_SAMPLE_SEED, with_status=True)[1] is True


@pytest.fixture
def cohort(tmp_path, monkeypatch):
    from insertion_fixtures import make_insertion_bam, SITE
    from state.browser_state import BrowserState
    from services.performance import apply_mode
    monkeypatch.setenv('FIBERBROWSER_LIBRARY_NO_STARTUP_SCAN', '1')
    monkeypatch.setenv('FIBERBROWSER_SETTINGS', str(tmp_path / 'settings.json'))
    paths = []
    for i in range(2):
        folder = tmp_path / str(i)
        folder.mkdir()
        paths.append(make_insertion_bam(folder)['bam'])
    state = BrowserState(None, reference_only=True)
    state.add_dataset('reads', paths)
    apply_mode(state, 'high')
    state.config['prefetch_multiplier'] = 3
    return state, SITE - 2000, SITE + 2000


def test_early_sampler_uses_exact_raw_names():
    from services.read_sampling import Sampler
    sampler = Sampler(1, only_ids={'fiber', 'other_3'}, exact_ids=True)
    assert sampler.keep('fiber') and sampler.keep('other_3')
    assert not sampler.keep('fiber_1') and not sampler.keep('other')
    # Legacy explicit segment scopes retain their established alias behavior.
    assert Sampler(1, only_ids={'fiber'}).keep('fiber_1')


@pytest.mark.parametrize('spanning', [False, True])
@pytest.mark.parametrize('quality_filters', [[], [{'layer': 'nuc', 'quality_name': 'aq', 'min_value': 150}]])
def test_sample_evidence_matches_full_and_never_serves_full_key(cohort, spanning, quality_filters):
    state, start, end = cohort
    options = dict(spanning=spanning, include_methylation=True, include_layers=True,
                   include_layer_qualities=True, quality_filters=quality_filters)
    sample = prepare_cluster_sample(state, 'reads', 'chrT', start, end, 12, DEFAULT_SAMPLE_SEED)
    assert sample is not None and len(sample.names) == 12
    with using_cluster_sample(sample):
        sampled = state.build_working_set('reads', 'chrT', start, end, **options)
        assert state.build_working_set('reads', 'chrT', start, end, **options) is sampled
    full = state.build_working_set('reads', 'chrT', start, end, **options)
    assert len(full.reads) >= len(sampled.reads) > 0
    identity = lambda r: tuple(r.get(k) for k in ('id', 'library_id', 'source_path', 'record_sha256', 'alignment_occurrence'))
    full_by_id = {identity(r): r for r in full.reads}
    for read in sampled.reads:
        assert read == full_by_id[identity(read)]
    assert len(sampled.reads) < len(full.reads)
    assert sampled.sampling['fraction'] != 0.5
    assert full.sampling is None
    with using_cluster_sample(sample):
        assert state.build_working_set('reads', 'chrT', start, end, **options) is sampled


def test_selection_cache_reuses_only_unchanged_inputs(cohort, monkeypatch):
    state, start, end = cohort
    sample = prepare_cluster_sample(state, 'reads', 'chrT', start, end, 12, DEFAULT_SAMPLE_SEED)
    import services.cluster_sample as module
    original = module.select_names
    calls = []
    def record(*args, **kwargs):
        calls.append(1)
        return original(*args, **kwargs)
    monkeypatch.setattr(module, 'select_names', record)
    assert prepare_cluster_sample(state, 'reads', 'chrT', start, end, 12, DEFAULT_SAMPLE_SEED) is sample
    assert calls == []
    other = prepare_cluster_sample(state, 'reads', 'chrT', start, end, 12, 'other')
    assert other.fingerprint != sample.fingerprint
    from services.dataset_generation import bump_dataset_generation
    bump_dataset_generation(state, 'reads')
    assert prepare_cluster_sample(state, 'reads', 'chrT', start, end, 12, DEFAULT_SAMPLE_SEED) == sample
    assert len(calls) == 2


def test_explicit_read_scopes_and_small_inputs_keep_full_path(cohort):
    state, start, end = cohort
    assert prepare_cluster_sample(state, 'reads', 'chrT', start, end, None, 's') is None
    assert prepare_cluster_sample(state, 'reads', 'chrT', start, end, 1, 's', read_ids=[]) is None
    assert prepare_cluster_sample(state, 'reads', 'chrT', start, end, 1, 's', read_ids=['a']) is None
    assert prepare_cluster_sample(state, 'reads', 'chrT', start, end, 10000, 's') is None


def test_low_memory_target_respects_working_limit(cohort):
    state, start, end = cohort
    state.performance['effective'] = 'low'
    state.max_working_reads = 8
    sample = prepare_cluster_sample(state, 'reads', 'chrT', start, end, 12, DEFAULT_SAMPLE_SEED)
    assert sample.target == len(sample.names) == 8
    assert prepare_cluster_sample(state, 'reads', 'chrT', start, end, 12,
                                  DEFAULT_SAMPLE_SEED, read_ids=['explicit']) is None


def test_sample_survives_file_reordering_and_cached_followup_avoids_decode(cohort, monkeypatch):
    state, start, end = cohort
    sample = prepare_cluster_sample(state, 'reads', 'chrT', start, end, 12, DEFAULT_SAMPLE_SEED)
    state.get_dataset('reads').paths.reverse()
    reordered = prepare_cluster_sample(state, 'reads', 'chrT', start, end, 12, DEFAULT_SAMPLE_SEED)
    assert reordered == sample
    options = dict(include_methylation=False, include_layers=True, include_layer_qualities=True)
    with using_cluster_sample(sample):
        working = state.build_working_set('reads', 'chrT', start, end, **options)
    monkeypatch.setattr('services.working_sets._load_broad_reads',
                        lambda **kwargs: pytest.fail('assigned sample re-decoded the BAMs'))
    with using_assigned_cluster_reads():
        followup = state.build_working_set('reads', 'chrT', start, end,
                                         read_ids=[r['id'] for r in working.reads], **options)
    assert followup.reads == working.reads


def test_sampled_cache_never_proves_an_open_ended_base_id_scope(cohort):
    from services.working_sets import sampled_entry_with_reads
    import time
    state, start, end = cohort
    sample = prepare_cluster_sample(state, 'reads', 'chrT', start, end, 12, DEFAULT_SAMPLE_SEED)
    with using_cluster_sample(sample):
        working = state.build_working_set('reads', 'chrT', start, end, include_methylation=False,
                                          include_layers=True, requested_layers=('nuc',))
    args = (state, state.get_dataset('reads'), 'reads', 'chrT', start, end,
            [working.reads[0]['id']], False, ('nuc',), time.time())
    options = dict(include_layer_qualities=True, infer_legacy_layers=True,
                   legacy_nuc_min_size=90, min_footprints=0, terminal_bp=None)
    assert sampled_entry_with_reads(*args, **options) == (None, None)
    with using_assigned_cluster_reads():
        assert sampled_entry_with_reads(*args, **options)[0] is not None


def test_cancellation_releases_owned_reader_and_does_not_cache_partial_sample(cohort, monkeypatch):
    from contextlib import contextmanager
    from services import bam_handles, background_work, cluster_sample
    state, start, end = cohort
    original = bam_handles.transient_bam_handle
    native = []
    @contextmanager
    def opened(*args, **kwargs):
        with original(*args, **kwargs) as bam:
            native.append(bam)
            yield bam
    monkeypatch.setattr(bam_handles, 'transient_bam_handle', opened)
    def cancel(**kwargs):
        if native:
            raise RuntimeError('test cancellation')
    size_before = len(cluster_sample._selections)
    monkeypatch.setattr(background_work, 'checkpoint', cancel)
    with pytest.raises(RuntimeError, match='test cancellation'):
        prepare_cluster_sample(state, 'reads', 'chrT', start, end, 12, 'cancel')
    assert native and all(bam.closed for bam in native)
    assert len(cluster_sample._selections) == size_before


def test_header_circular_sources_keep_full_path(cohort, monkeypatch):
    from contextlib import contextmanager
    from types import SimpleNamespace
    state, start, end = cohort
    header = SimpleNamespace(to_dict=lambda: {'SQ': [{'SN': 'chrT', 'TP': 'circular'}]})
    @contextmanager
    def circular(*args, **kwargs):
        yield SimpleNamespace(header=header, references=('chrT',))
    monkeypatch.setattr('services.bam_handles.transient_bam_handle', circular)
    assert prepare_cluster_sample(state, 'reads', 'chrT', start, end, 12, 'circular') is None


@pytest.mark.parametrize('method', ['kmeans', 'combinatorial'])
def test_cluster_response_reports_sample_and_repeat_uses_same_cohort(cohort, method):
    state, start, end = cohort
    from models.requests import ClusterAllRequest
    from services.clustering_endpoint import run_cluster_all_endpoint
    req = ClusterAllRequest(dataset_ids=['reads'], method=method, k=2, preparation_sample_count=12,
                            peak_regions=[dict(start=start + 50, end=end - 50)])
    result = run_cluster_all_endpoint(state=state, req=req, chrom='chrT', start=start, end=end, spanning=False)
    metadata = result['results']['reads']['preparation_sampling']
    assert metadata['selected_names'] == 12 and metadata['total_alignments'] > 12
    assert metadata['used'] == len(result['results']['reads']['assignments'])
    repeated = run_cluster_all_endpoint(state=state, req=req, chrom='chrT', start=start, end=end, spanning=False)
    assert {k: v for k, v in repeated.items() if k != 'timings'} == {k: v for k, v in result.items() if k != 'timings'}


@pytest.mark.parametrize('method', ['kmeans', 'combinatorial'])
def test_zero_peak_eligible_result_still_reports_sample(cohort, method):
    state, start, end = cohort
    from models.requests import ClusterAllRequest
    from services.clustering_endpoint import run_cluster_all_endpoint
    req = ClusterAllRequest(dataset_ids=['reads'], method=method, preparation_sample_count=12,
                            peak_regions=[dict(start=end + 10000, end=end + 11000)])
    result = run_cluster_all_endpoint(state=state, req=req, chrom='chrT', start=start, end=end, spanning=False)
    assert result['results']['reads']['assignments'] == {}
    assert result['results']['reads']['preparation_sampling']['used'] == 0
