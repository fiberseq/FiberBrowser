"""Runtime performance modes bound retention and preserve evidence."""
from types import SimpleNamespace
import os

import numpy as np
import pytest
from test_perf_guards import demo_state_client

from services.byte_cache import ByteCache, retained_size
from services.performance import GIB, apply_mode, effective_mode, mode_limits
from services.packed_reads import PackedReads


@pytest.mark.real_hardware
def test_machine_ram_does_not_require_optional_psutil(monkeypatch):
    import os
    import sys
    from services.performance import machine_hardware
    monkeypatch.setitem(sys.modules, 'psutil', None)
    monkeypatch.setattr(os, 'sysconf', lambda key: 64 * GIB // 4096 if key == 'SC_PHYS_PAGES' else 4096, raising=False)
    assert machine_hardware()['total_memory_bytes'] == 64 * GIB


@pytest.mark.real_hardware
def test_machine_ram_uses_native_windows_fallback(monkeypatch):
    import ctypes
    import sys
    from services import performance
    monkeypatch.setitem(sys.modules, 'psutil', None)
    monkeypatch.setattr(performance, 'os', SimpleNamespace(name='nt', cpu_count=lambda: 16))
    def memory_status(pointer):
        assert pointer._obj.length == 64
        pointer._obj.total_physical = 64 * GIB
        return 1
    monkeypatch.setattr(ctypes, 'windll', SimpleNamespace(kernel32=SimpleNamespace(GlobalMemoryStatusEx=memory_status)), raising=False)
    assert performance.machine_hardware() == {'total_memory_bytes': 64 * GIB, 'cores': 16}


def test_byte_cache_replacement_eviction_oversize_and_resize():
    cache = ByteCache(2500)
    cache['a'] = b'a' * 1000
    cache['b'] = b'b' * 1000
    cache.move_to_end('a')
    cache['c'] = b'c' * 1000
    assert list(cache) == ['a', 'c']
    cache['a'] = b'a' * 2000
    assert list(cache) == ['a']
    cache['oversize'] = b'x' * 5000
    cache.move_to_end('oversize')
    assert list(cache) == ['a']
    cache.resize(500)
    assert not cache and cache.retained_bytes == 0
    cache.update({'small': b'a'})
    del cache['small']
    assert cache.retained_bytes == 0


def test_size_accounts_for_arrays_cycles_and_large_sequences():
    arr = np.zeros(1000, dtype=np.float64)
    assert retained_size(arr) >= arr.nbytes
    value = [arr, arr]
    assert retained_size(value) < 2 * arr.nbytes
    value.append(value)
    assert retained_size(value) >= arr.nbytes
    cyclic = [None] * 100
    cyclic[0] = cyclic
    assert 0 < retained_size(cyclic) < 10_000
    assert retained_size([{'marks': list(range(100))} for _ in range(1000)]) > 1_000_000


@pytest.mark.parametrize('module,attribute', [
    ('coaccessibility_endpoint', '_coacc_matrix_cache'), ('insertion_lens', '_cache'),
    ('sv_endpoint', '_SCAN_CACHE'), ('motif_scoring', '_scored_cache'),
    ('read_locate', '_CACHE'), ('region_detect', '_CACHE'),
    ('random_window', '_TOP_WINDOW_CACHE'), ('circular_genome', '_BAM_TOPOLOGY_CACHE'),
])
def test_auxiliary_caches_observe_runtime_retention_limits(module, attribute):
    import importlib
    from services.byte_cache import configure_shared_caches
    cache = getattr(importlib.import_module('services.' + module), attribute)
    try:
        cache['budget-regression'] = b'x' * 4096
        configure_shared_caches({cache.budget_group: 1024})
        assert 'budget-regression' not in cache
        cache['budget-regression'] = b'x' * 4096
        assert 'budget-regression' not in cache
    finally:
        configure_shared_caches(mode_limits('standard', {'total_memory_bytes': 16 * GIB, 'cores': 8})['cache_bytes'])


@pytest.mark.parametrize('ram,cores,tier,expected', [
    (8, 16, 'high', 'low'), (64, 4, 'low', 'low'), (64, 16, 'low', 'low'),
    (16, 16, 'high', 'standard'), (32, 12, 'standard', 'high'), (64, 16, 'high', 'high'),
    (64, 8, 'standard', 'standard'), (0, 16, 'high', 'standard'),
])
def test_auto_thresholds(ram, cores, tier, expected):
    assert effective_mode('auto', {'total_memory_bytes': ram * GIB, 'cores': cores}, tier) == expected


def test_switching_modes_evicts_and_fences_inflight_results(monkeypatch):
    monkeypatch.setattr('services.performance.machine_hardware', lambda: {'total_memory_bytes': 64 * GIB, 'cores': 16})
    state = SimpleNamespace(config={}, max_working_reads=0, datasets={'a': object()})
    apply_mode(state, 'high')
    generation = state._dataset_generations['a']
    state._broad_cache['a'] = [0] * 100
    info = apply_mode(state, 'low')
    assert info['max_working_reads'] == 2000
    assert not state._broad_cache
    assert state._dataset_generations['a'] == generation + 1
    assert info['margin_fraction'] == 0
    assert sum(info['cache_bytes'].values()) < GIB
    assert info['workers'] == 1
    assert apply_mode(state, 'standard')['max_working_reads'] == 0


def test_cli_cap_is_never_relaxed_by_a_mode():
    state = SimpleNamespace(config={}, max_working_reads=500, datasets={})
    assert apply_mode(state, 'low')['max_working_reads'] == 500
    assert apply_mode(state, 'high')['max_working_reads'] == 500


def test_low_memory_reduces_read_lookup_decompression_threads(monkeypatch):
    from services.read_locate import _open_scan_handle
    from services import bam_handles
    from services.file_handles import HandleCache
    calls, closed = [], []
    monkeypatch.setattr(bam_handles, 'handles', HandleCache())
    monkeypatch.setattr(bam_handles, '_bam_threads', 1)
    def open_reader(path, mode, **kwargs):
        calls.append(kwargs['threads'])
        return SimpleNamespace(close=lambda: closed.append(1))
    monkeypatch.setattr('services.remote_sources.opening.open_alignment_file',
                        open_reader)
    state = SimpleNamespace(config={}, max_working_reads=0, datasets={})
    apply_mode(state, 'low')
    first, owned = _open_scan_handle('example.bam', state)
    assert not owned and first is bam_handles.get_bam_handle('example.bam')
    apply_mode(state, 'standard')
    second, owned = _open_scan_handle('example.bam', state)
    assert not owned and second is _open_scan_handle('example.bam', state)[0]
    assert calls == [1, 4]
    assert len(closed) == 1
    # Ordinary view loads do not retain a native thread pool per cached BAM.
    bam_handles.get_bam_handle('example.bam')
    assert calls == [1, 4, 1] and len(closed) == 2
    bam_handles.handles.discard()
    assert len(closed) == 3


def test_auxiliary_alignment_and_external_tool_workers_follow_mode(monkeypatch):
    from services.background_work import auxiliary_worker_count
    from services.primer_blast_runtime import blast_thread_count
    monkeypatch.setattr('os.cpu_count', lambda: 16)
    state = SimpleNamespace(config={}, max_working_reads=0, datasets={})
    apply_mode(state, 'low')
    assert auxiliary_worker_count(8) == blast_thread_count() == 1
    assert auxiliary_worker_count(2) == 1
    apply_mode(state, 'standard')
    assert auxiliary_worker_count(8) == blast_thread_count() == 8
    assert auxiliary_worker_count(2) == 2


def test_interactive_read_applies_the_current_numerical_thread_limit():
    import numba
    from services.background_work import interactive_read, configure_worker_threads
    state = SimpleNamespace(config={}, max_working_reads=0, datasets={})
    try:
        apply_mode(state, 'low')
        with interactive_read():
            assert numba.get_num_threads() == 1
    finally:
        apply_mode(state, 'standard')
        configure_worker_threads()


def test_high_decode_workers_scale_with_available_machine_memory():
    assert mode_limits('high', {'total_memory_bytes': 32 * GIB, 'cores': 16})['decode_workers'] == 4
    assert mode_limits('high', {'total_memory_bytes': 64 * GIB, 'cores': 16})['decode_workers'] == 8
    assert mode_limits('high', {'total_memory_bytes': 64 * GIB, 'cores': 2})['decode_workers'] == 2


def test_new_session_preserves_autos_constrained_browser(demo_state_client, monkeypatch):
    from state.browser_state import BrowserState
    _, state = demo_state_client
    monkeypatch.setattr('services.performance.machine_hardware', lambda: {'total_memory_bytes': 64 * GIB, 'cores': 16})
    apply_mode(state, 'auto', browser_tier='low')
    child = BrowserState.fork_for_session(state, copy_shared=True, include_data=False)
    assert child.performance['mode'] == 'auto'
    assert child.performance['effective'] == 'low'
    assert child.max_working_reads == 2000
    assert child.performance['workers'] == 1


def test_reference_context_preserves_autos_live_reader_budget(demo_state_client, monkeypatch):
    from services.panel_genomes import _empty_context
    from services.file_handles import handles
    from services.byte_cache import shared_cache_diagnostics
    _, state = demo_state_client
    monkeypatch.setattr('services.performance.machine_hardware', lambda: {'total_memory_bytes': 64 * GIB, 'cores': 16})
    monkeypatch.setattr('services.app_settings.load', lambda: {'performance': {'mode': 'auto'}})
    try:
        apply_mode(state, 'auto', browser_tier='low')
        budgets = shared_cache_diagnostics()
        _empty_context()
        assert handles.max_entries == 32
        assert shared_cache_diagnostics() == budgets
    finally:
        apply_mode(state, 'standard')


def test_machine_mode_updates_existing_and_future_workspaces(demo_state_client):
    from services.performance import apply_machine_mode
    from state.browser_state import BrowserState
    _, state = demo_state_client
    child = BrowserState.fork_for_session(state, copy_shared=True, include_data=False)
    apply_machine_mode(child, 'low')
    assert state.performance['effective'] == child.performance['effective'] == 'low'
    assert state.max_working_reads == child.max_working_reads == 2000
    later = BrowserState.fork_for_session(state, copy_shared=True, include_data=False)
    assert later.performance['effective'] == 'low'
    apply_machine_mode(state, 'standard')
    assert all(s.performance['effective'] == 'standard' and s.max_working_reads == 0
               for s in (state, child, later))


def test_mode_change_during_derived_analysis_cannot_cache_the_old_population(demo_state_client, monkeypatch):
    from services import coaccessibility_endpoint as endpoint
    from services.analysis_query import AnalysisReadQuery
    _, state = demo_state_client
    apply_mode(state, 'high')
    scope = endpoint.CoaccRequestScope(AnalysisReadQuery.from_request(
        state, dataset_id='demo', chrom='chr19', start=47514000, end=47518000), 100)
    endpoint._coacc_matrix_cache.clear()
    calls = []
    def compute(current, *args, **kwargs):
        captured = current.max_working_reads
        calls.append(captured)
        if len(calls) == 1:
            apply_mode(current, 'low')
        return captured
    monkeypatch.setattr(endpoint, '_compute_normalized_matrix', compute)
    assert endpoint._get_cached_normalized_matrix(state, scope, 'raw', 1) == 0
    assert not endpoint._coacc_matrix_cache
    assert endpoint._get_cached_normalized_matrix(state, scope, 'raw', 1) == 2000
    assert endpoint._get_cached_normalized_matrix(state, scope, 'raw', 1) == 2000
    assert calls == [0, 2000]
    apply_mode(state, 'standard')


def test_cache_budget_is_shared_across_instances(monkeypatch):
    from services import byte_cache
    monkeypatch.setitem(byte_cache._shared_budgets, 'test', 1000)
    first = byte_cache.shared_cache('test')
    second = byte_cache.shared_cache('test')
    first['a'] = b'a' * 600
    second['b'] = b'b' * 600
    assert not first and second
    assert first.retained_bytes + second.retained_bytes <= 1000


def test_explicit_decode_scope_matches_base_ids_without_expanding_exact_ids():
    from services.read_sampling import Sampler
    sampler = Sampler(1, only_ids={'name_1'}, raw_aliases={'name'}, max_records=2)
    assert sampler.keep('name_1_9')
    sampler.kept(0, 100)
    assert sampler.keep('name_1_10')
    sampler.kept(0, 100)
    assert not sampler.keep('name_1_11')
    exact = Sampler(1, only_ids={'name_1_9'}, raw_aliases={'name_1'}, max_records=2)
    assert exact.keep('name_1_9') and exact.keep('name_1')
    assert not exact.keep('name_1_10')


def test_low_memory_explicit_analysis_scope_is_capped_before_decode(demo_state_client):
    from services.compact_read_loader import build_compact_reads_from_bam
    from services.read_sampling import decode_read_scope
    client, state = demo_state_client
    dataset = state.get_dataset('demo')
    reads = build_compact_reads_from_bam(dataset.paths[0], 'chr19', 47514000, 47518000,
                                       spanning_only=False, include_methylation=False, include_layers=False)
    ids = [r['id'] for r in reads]
    assert len(ids) > 20
    apply_mode(state, 'low')
    state.max_working_reads = 7
    working = state.build_working_set('demo', 'chr19', 47514000, 47518000,
                                     read_ids=ids, include_methylation=False, include_layers=False)
    assert 0 < len(working.reads) <= 7
    assert working.total_overlapping > len(working.reads)
    assert not state._broad_cache  # No restricted cohort under a full-cohort key.
    assert decode_read_scope.get() is None
    response = client.post('/api/cluster_all?chrom=chr19&start=47514000&end=47518000', json={
        'dataset_ids': ['demo'], 'method': 'kmeans', 'k': 2,
        'peak_regions': [{'start': 47514600, 'end': 47514800}],
    })
    assert response.status_code == 200
    result = response.json()['results']['demo']
    assert result['performance_sampling']['used'] == len(result['assignments'])
    assert result['performance_sampling']['total'] > 7


def test_packed_cohort_preserves_precision_identity_and_sample_extents():
    from services.read_sampling import SampledReads, sampling_info
    reads = SampledReads([
        {'id': str(i), 'intervals': [[1, 100, -99]], 'layers': {'nuc': {'qualities': [0.1, 0.123456789]}},
         'record_sha256': str(i), 'alignment_occurrence': i % 2, 'methyl': list(range(300))}
        for i in range(1000)
    ], level=1, kept_starts=[0] * 1000, kept_ends=[300] * 1000,
       skipped_starts=[0] * 1000, skipped_ends=[300] * 1000)
    packed = PackedReads(reads)
    assert list(packed) == reads
    assert packed[-1] == reads[-1] and packed[100:110] == reads[100:110]
    assert packed.retained_bytes < retained_size(reads)
    assert sampling_info(packed, 0, 300, 1000, 1000)['total'] == 2000


@pytest.mark.parametrize('builder', [False, True])
def test_packed_pan_decodes_only_overlapping_blocks(builder, monkeypatch):
    import pickle
    from services import packed_reads
    reads = [{'id': str(i), 'intervals': [[i * 100, i * 100 + 90, 90]]} for i in range(1024)]
    # Layer-only reads retain exactly the bounds used by working-set projection.
    reads[300] = {'id': 'layer-only', 'intervals': [], 'layers': {'tf': {'intervals': [[30000, 30090, 90]]}}}
    reads[301] = {'id': 'empty', 'intervals': []}
    if builder:
        accumulator = packed_reads.PackedReadBuilder()
        for read in reads:
            accumulator.append(read)
        packed = accumulator.finish()
    else:
        packed = PackedReads(reads)
    packed = pickle.loads(pickle.dumps(packed))
    decoded = []
    original = packed_reads.zlib.decompress
    monkeypatch.setattr(packed_reads.zlib, 'decompress', lambda value: decoded.append(value) or original(value))
    assert [row[1]['id'] for row in packed.overlapping(30000, 30200)] == ['layer-only']
    # Only the overlapping 256-row batch is expanded, regardless of its frames.
    assert [r['id'] for part in decoded for r in pickle.loads(original(part))] == [r['id'] for r in reads[256:512]]
    first_decode_count = len(decoded)
    assert [row[0] for row in packed.overlapping(30000, 30300)] == [300, 302]
    assert len(decoded) == first_decode_count
    assert packed._bounds.nbytes == 1024 * 16
    assert packed.retained_bytes > packed._bounds.nbytes


def test_low_sampling_cannot_be_disabled_by_environment(monkeypatch):
    from services.read_sampling import target_reads
    monkeypatch.setenv('FIBERBROWSER_WORKING_READS_TARGET', '0')
    state = SimpleNamespace(performance=mode_limits('low', {'total_memory_bytes': 8 * GIB, 'cores': 4}) | {'effective': 'low'})
    assert target_reads(2000, state) == 1000


def test_mode_api_persists_in_app_settings_only(client, tmp_path, monkeypatch):
    path = tmp_path / 'app.json'
    monkeypatch.setenv('FIBERBROWSER_APP_SETTINGS', str(path))
    result = client.post('/api/app/performance', json={'mode': 'low'})
    assert result.status_code == 200, result.text
    assert result.json()['effective'] == 'low'
    assert '"mode": "low"' in path.read_text()
    assert client.get('/api/app/performance').json()['max_working_reads'] <= 2000
    assert client.post('/api/app/performance', json={'mode': 'invalid'}).status_code == 422
    client.post('/api/app/performance', json={'mode': 'standard', 'persist': False})


@pytest.mark.parametrize('binary', [False, True])
def test_parallel_decode_preserves_alignment_occurrences_and_evidence(tmp_path, binary):
    from insertion_fixtures import make_insertion_bam, SITE
    from services.compact_read_loader import build_compact_reads_from_bam
    from services.parallel_reads import parallel_bam_reads
    from services.read_binary import binary_read_context
    bam = make_insertion_bam(tmp_path)
    options = dict(spanning_only=False, include_methylation=True, include_layers=True,
                   include_cigar=True, include_sv_seq=True, hide_terminal_gaps=False)
    token = binary_read_context.set(binary)
    try:
        expected = build_compact_reads_from_bam(bam['bam'], 'chrT', SITE - 2000, SITE + 2000, **options)
        actual = parallel_bam_reads(bam['bam'], 'chrT', SITE - 2000, SITE + 2000, options, 2)
    finally:
        binary_read_context.reset(token)
    assert actual == expected


@pytest.mark.parametrize('fails', [False, True])
def test_decode_partition_releases_its_reader_even_on_failure(tmp_path, monkeypatch, fails):
    from services.parallel_reads import decode_bam_partition
    from services import bam_handles, compact_read_loader
    from services.file_handles import HandleCache
    cache = HandleCache(1)
    monkeypatch.setattr(bam_handles, 'handles', cache)
    closed = []
    def decode(path, *args, **kwargs):
        cache.get('bam', path, lambda: SimpleNamespace(close=lambda: closed.append(1)), lambda: None)
        if fails:
            raise ValueError('decode failed')
        return []
    monkeypatch.setattr(compact_read_loader, 'build_compact_reads_from_bam', decode)
    if fails:
        with pytest.raises(ValueError, match='decode failed'):
            decode_bam_partition(str(tmp_path / 'reads.bam'), 'chr1', 0, 100, {}, (0, 2))
    else:
        assert decode_bam_partition(str(tmp_path / 'reads.bam'), 'chr1', 0, 100, {}, (0, 2)) == []
    assert closed == [1] and cache.diagnostics()['entries'] == 0


def _decode_reader_probe(path):
    import os
    import psutil
    from services.file_handles import handles
    from services.parallel_reads import decode_bam_partition
    handles.resize(1)
    decode_bam_partition(path, 'chrT', 0, 10000,
                         dict(spanning_only=False, hide_terminal_gaps=False), (0, 1))
    return os.getpid(), handles.diagnostics(), psutil.Process().num_fds()


@pytest.mark.skipif(os.name == 'nt', reason='Descriptor counts require POSIX')
def test_reused_decode_process_does_not_accumulate_readers(tmp_path):
    import multiprocessing
    psutil = pytest.importorskip('psutil')
    from concurrent.futures import ProcessPoolExecutor
    from insertion_fixtures import make_insertion_bam
    path = make_insertion_bam(tmp_path)['bam']
    with ProcessPoolExecutor(max_workers=1, mp_context=multiprocessing.get_context('spawn')) as pool:
        samples = [pool.submit(_decode_reader_probe, path).result(timeout=60) for _ in range(4)]
    assert len({pid for pid, _, _ in samples}) == 1
    assert all(info['open'] == info['entries'] == 0 and info['limit'] == 1 for _, info, _ in samples)
    assert max(fd for _, _, fd in samples) - min(fd for _, _, fd in samples) <= 1
    assert not psutil.pid_exists(samples[0][0])


@pytest.mark.parametrize('failure', ['queue', 'event'])
def test_decode_setup_failure_releases_queue_and_admission_lock(monkeypatch, failure):
    import threading
    from services import parallel_reads
    closed = []
    def unavailable():
        raise OSError('descriptor allocation failed')
    def queue(**kwargs):
        if failure == 'queue':
            unavailable()
        return SimpleNamespace(close=lambda: closed.append(1))
    monkeypatch.setattr(parallel_reads, '_decode_lock', threading.Lock())
    monkeypatch.setattr(parallel_reads.multiprocessing, 'get_context',
                        lambda method: SimpleNamespace(Queue=queue, Event=unavailable))
    with pytest.raises(OSError, match='descriptor allocation failed'):
        parallel_reads.parallel_bam_reads('reads.bam', 'chr1', 0, 100, {}, 2)
    assert not parallel_reads._decode_lock.locked()
    assert closed == ([1] if failure == 'event' else [])


@pytest.mark.parametrize('mode', ['standard', 'high', 'auto'])
def test_visible_reads_share_foreground_limits_and_defer_process_decoding(monkeypatch, mode):
    from services import read_route_helpers as routes
    from services.background_work import interactive_read, is_interactive_read
    from services.working_sets import configured_prefetch_multiplier
    from services.read_sampling import target_reads
    monkeypatch.setattr('services.performance.machine_hardware', lambda: {'total_memory_bytes': 64 * GIB, 'cores': 16})
    state = SimpleNamespace(config={}, max_working_reads=0, datasets={})
    apply_mode(state, mode)
    monkeypatch.setattr('services.plasmid_reconcile.contig_links', lambda *a, **kw: {})
    monkeypatch.setattr('services.circular_genome.is_circular_chrom', lambda *a: False)
    monkeypatch.setattr('services.read_sampling.estimate_reads', lambda *a, **kw: pytest.fail('foreground pool probe'))
    monkeypatch.setattr(routes, 'build_compact_reads_from_bam', lambda *a, **kw: ['visible'])
    try:
        assert target_reads(10000, state) == 4000
        with interactive_read():
            assert configured_prefetch_multiplier(state) == 1
            with interactive_read():
                assert is_interactive_read()
            assert is_interactive_read()
            assert routes.build_direct_bam_reads(state, __file__, 'chr1', 100, 200) == ['visible']
        assert not is_interactive_read()
        assert configured_prefetch_multiplier(state) == (10 if mode == 'standard' else 20)
    finally:
        apply_mode(state, 'standard')


def test_prefetch_span_is_not_multiplied_a_second_time():
    import threading
    from services.read_stream import prefetch_scope
    from services.working_sets import configured_prefetch_multiplier
    state = SimpleNamespace(config={'prefetch_multiplier': 20})
    with prefetch_scope(threading.Event()):
        assert configured_prefetch_multiplier(state) == 1
    assert configured_prefetch_multiplier(state) == 20


def test_status_for_a_known_viewport_does_not_scan_for_a_start_position(demo_state_client, monkeypatch):
    client, state = demo_state_client
    monkeypatch.setattr(state, 'get_initial_position', lambda *a: pytest.fail('unrequested initial position'))
    response = client.get('/api/status', params={'initial_position': 'false'})
    assert response.status_code == 200
    assert response.json()['initial_position'] is None
    assert response.json()['datasets'] == 1


def test_load_all_retains_neighbors_before_idle_prefetch(demo_state_client, monkeypatch):
    from services import working_sets
    from services.read_stream import MEDIA_TYPE
    from test_perf_guards import DEMO_CHROM, DEMO_START, DEMO_END
    client, state = demo_state_client
    apply_mode(state, 'high')
    spans = []
    original = working_sets._load_broad_reads
    def load(**kwargs):
        spans.append((kwargs['broad_start'], kwargs['broad_end']))
        return original(**kwargs)
    monkeypatch.setattr(working_sets, '_load_broad_reads', load)
    params = dict(dataset_id='demo', chrom=DEMO_CHROM, start=DEMO_START, end=DEMO_END,
                  include_layers=True, min_footprints=5, max_reads=50, full_working_set=True)
    try:
        first = client.get('/api/reads/compact', params=params)
        assert first.status_code == 200 and first.json()['reads']
        span = (DEMO_START - 4000, DEMO_END + 4000)
        assert spans == [span]
        warm = client.get('/api/reads/compact', params={**params, 'start': span[0], 'end': span[1],
            'viewport_start': DEMO_START, 'viewport_end': DEMO_END, 'prefetch': True, 'max_reads': 1},
            headers={'accept': MEDIA_TYPE})
        assert warm.status_code == 200
        assert spans == [span]
        assert (state._current_start, state._current_end) == (DEMO_START, DEMO_END)
        pan = client.get('/api/reads/compact', params={**params, 'start': DEMO_START + 100, 'end': DEMO_END + 100})
        assert pan.status_code == 200 and pan.json()['reads']
        assert len(spans) == 1
    finally:
        apply_mode(state, 'standard')


def test_sampled_pan_reuses_prefetch_at_the_original_sampling_level(demo_state_client, monkeypatch):
    from services import working_sets, read_sampling
    from services.read_stream import MEDIA_TYPE
    from test_perf_guards import DEMO_CHROM, DEMO_START, DEMO_END
    client, state = demo_state_client
    apply_mode(state, 'high')
    monkeypatch.setattr(read_sampling, 'estimate_dataset_reads', lambda *a, **kw: 20000)
    spans = []
    original = working_sets._load_broad_reads
    def load(**kwargs):
        spans.append((kwargs['broad_start'], kwargs['broad_end'], kwargs['sample_level']))
        return original(**kwargs)
    monkeypatch.setattr(working_sets, '_load_broad_reads', load)
    params = dict(dataset_id='demo', chrom=DEMO_CHROM, start=DEMO_START, end=DEMO_END,
                  include_layers=True, min_footprints=5, max_reads=50, full_working_set=False)
    pan_params = {**params, 'start': DEMO_START + 100, 'end': DEMO_END + 100}
    try:
        expected = client.get('/api/reads/compact', params=pan_params).json()
        assert expected['reads'] and expected['working_sampling']['level'] > 0
        state._broad_cache.clear()
        state._working_set_cache.clear()
        spans.clear()
        first = client.get('/api/reads/compact', params=params).json()
        level = first['working_sampling']['level']
        warm = client.get('/api/reads/compact', params={**params, 'start': DEMO_START - 10000,
            'end': DEMO_END + 10000, 'viewport_start': DEMO_START, 'viewport_end': DEMO_END,
            'prefetch': True, 'prefetch_sample_level': level, 'max_reads': 1}, headers={'accept': MEDIA_TYPE})
        assert warm.status_code == 200
        assert len(spans) == 2 and spans[-1][2] == level
        pan = client.get('/api/reads/compact', params=pan_params).json()
        assert len(spans) == 2
        assert pan['working_sampling'] == expected['working_sampling']
        assert pan['reads'] == expected['reads']
    finally:
        apply_mode(state, 'standard')


def _small_machine(monkeypatch):
    import sys
    monkeypatch.setitem(sys.modules, 'psutil', None)
    monkeypatch.setattr(os, 'sysconf', lambda key: 2 * GIB // 4096 if key == 'SC_PHYS_PAGES' else 4096, raising=False)
    monkeypatch.setattr(os, 'cpu_count', lambda: 2)


@pytest.mark.real_hardware
def test_a_real_hardware_test_sees_the_real_probe_under_both_conftest_imports(monkeypatch):
    """The suite imports conftest as `conftest` and as `tests.conftest`; both share
    one floor (tests/hardware_floor.py), so the marker reaches the probe either way."""
    import importlib
    importlib.import_module('conftest')
    importlib.import_module('tests.conftest')
    from services import performance
    _small_machine(monkeypatch)
    assert performance.machine_hardware() == {'total_memory_bytes': 2 * GIB, 'cores': 2}


def test_other_tests_see_at_least_a_standard_machine(monkeypatch):
    import importlib
    importlib.import_module('conftest')
    importlib.import_module('tests.conftest')
    from services import performance
    _small_machine(monkeypatch)
    assert performance.machine_hardware() == {'total_memory_bytes': 16 * GIB, 'cores': 8}
