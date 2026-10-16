"""Selected analysis must stay fast without changing evidence or shared caches."""
import pickle
import time
from collections import OrderedDict
import pytest
from services import packed_reads
from services.packed_reads import PackedReads, PackedReadBuilder, select_read_ids
from services.scoped_read_analysis import scoped_analysis
from services.analysis_query import AnalysisReadQuery
from services.clustering_endpoint import _compute_scan_counts_from_broad_cache
from services.working_sets import BROAD_CACHE_SCHEMA_VERSION, read_load_token
from test_clustering_endpoint import FakeClusterState
from test_cluster_preparation_sample import cohort


@pytest.mark.parametrize('kind', ['display', 'lean', 'builder', 'legacy'])
def test_selected_ids_expand_only_needed_frames_preserve_duplicates_and_aliases(kind, monkeypatch):
    rows = [{'id': str(i), 'intervals': [[0, 100, 100]], 'methyl': list(range(100))} for i in range(1024)]
    rows[301]['id'] = rows[300]['id']
    rows[302]['id'] = '300_2'
    if kind == 'builder':
        builder = PackedReadBuilder()
        for r in rows: builder.append(r)
        reads = builder.finish()
    else:
        reads = PackedReads(rows, display_index=kind == 'display')
    if kind == 'legacy': del reads._read_ids
    reads = pickle.loads(pickle.dumps(reads))
    expanded = []
    decompress = packed_reads.zlib.decompress
    monkeypatch.setattr(packed_reads.zlib, 'decompress', lambda part: expanded.extend(pickle.loads(decompress(part))) or decompress(part))
    assert list(select_read_ids(reads, {'300'})) == rows[300:302]
    if kind != 'legacy': assert len(expanded) <= 16
    assert list(select_read_ids(reads, {'300'}, aliases=True)) == rows[300:303]
    assert list(select_read_ids(reads, set())) == []
    assert reads.retained_bytes > reads._bounds.nbytes


def test_scoped_cold_load_never_populates_full_cache_and_preserves_generic_totals(cohort):
    state, start, end = cohort
    options = dict(include_methylation=False, include_layers=True, requested_layers=('nuc',))
    full = state.build_working_set('reads', 'chrT', start, end, **options)
    wanted = [full.reads[0]['id'], full.reads[3]['id']]
    expected = state.build_working_set('reads', 'chrT', start, end, read_ids=wanted, **options)
    state._broad_cache.clear(); state._working_set_cache.clear()
    scoped = scoped_analysis(state.build_working_set)
    actual = scoped('reads', 'chrT', start, end, read_ids=wanted, **options)
    assert actual.reads == expected.reads
    assert not state._broad_cache and not state._working_set_cache
    reloaded = state.build_working_set('reads', 'chrT', start, end, **options)
    assert reloaded.reads == full.reads
    assert reloaded.total_overlapping == full.total_overlapping
    assert scoped('reads', 'chrT', start, end, read_ids=[], **options).reads == []


@pytest.mark.parametrize('packed', [False, True])
def test_scan_selection_keeps_old_gapped_geometry_and_offscreen_exclusion(packed):
    state = FakeClusterState()
    state._broad_cache_schema_version = BROAD_CACHE_SCHEMA_VERSION
    state._broad_cache_timeout = 300
    rows = [{'id': 'gap', 'intervals': [[0, 20, 20], [80, 100, 20]]},
            {'id': 'in', 'intervals': [[35, 65, -30]]},
            {'id': 'out', 'intervals': [[0, 10, 10]]}]
    key = ('ds1', '2R', 100, 200, False, (), False, True, 90, 0, read_load_token(state, '2R'))
    state._broad_cache = OrderedDict({key: (PackedReads(rows, display_index=False) if packed else rows, time.time())})
    def counts(ids):
        query = AnalysisReadQuery(chrom='2R', start=130, end=170, dataset_ids=['ds1'],
            singleton_read_ids=ids, include_methylation=False, include_layers=False, include_layer_qualities=False)
        return _compute_scan_counts_from_broad_cache(state=state, query=query, dataset_id='ds1', signal_source='accessibility', region_width=40)
    full, selected = counts(None), counts(['gap', 'in', 'out'])
    assert full[2] == selected[2] == 2
    assert (full[0] == selected[0]).all() and (full[1] == selected[1]).all()


def test_cancelled_cluster_never_publishes_assignments(monkeypatch):
    import threading
    from services.background_work import cancel_scope, Cancelled
    from services import clustering_endpoint
    from models.requests import ClusterAllRequest
    state = FakeClusterState()
    dataset = state.get_dataset('ds1')
    dataset.cluster_assignments = {'old': 7}
    cancel = threading.Event()
    original = clustering_endpoint.cluster_compact_reads
    def fit(*args, **kwargs):
        result = original(*args, **kwargs)
        cancel.set()  # A navigation or newer run happened while fitting.
        return result
    monkeypatch.setattr(clustering_endpoint, 'cluster_compact_reads', fit)
    with cancel_scope(cancel), pytest.raises(Cancelled):
        clustering_endpoint.run_cluster_all_endpoint(state=state,
            req=ClusterAllRequest(dataset_ids=['ds1'], peak_regions=[{'start': 1, 'end': 10}], k=2, method='kmeans'),
            chrom='chr2R', start=0, end=30, spanning=False)
    assert dataset.cluster_assignments == {'old': 7}


def test_interval_sort_does_not_request_unused_methylation():
    from test_filtering_routes import FakeState
    from models.requests import SortReadsRequest
    from services.filtering_endpoint import sort_reads_for_request
    state = FakeState()
    state.reads = [{'id': 'a', 'intervals': [[0, 100, 100]]},
                   {'id': 'b', 'intervals': [[0, 50, 50], [50, 100, -50]]}]
    calls = []
    original = state.build_working_set
    def build(*args, **kwargs):
        calls.append(kwargs)
        return original(*args, **kwargs)
    state.build_working_set = build
    result = sort_reads_for_request(state, SortReadsRequest(dataset_ids=['ds1'], sort_by='accessibility'),
                                    chrom='chr1', start=0, end=100)
    assert result['results']['ds1']['read_sort_order'] == ['b', 'a']
    assert calls and all(call['include_methylation'] is False for call in calls)
