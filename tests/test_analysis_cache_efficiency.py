"""Analysis retention preserves geometry and budgets without display-only indexes."""
import copy
from collections import OrderedDict
import pickle
from types import SimpleNamespace

import numpy as np
import pytest

from services.byte_cache import ByteCache, retained_size
from services.packed_reads import PackedReads


def test_analysis_packing_preserves_full_evidence_and_byte_budget():
    reads = [{'id': str(i), 'intervals': [(i, i + 7, 7), (i + 7, i + 20, -13)],
              'methyl': [i + 2], 'sv': [{'t': 'I', 'ref': i + 4, 'len': 80}],
              'layers': {'tf': {'intervals': [[i, i + 7, 7]], 'qualities': [[0.123456789]],
                                'quality_names': ['quality']}}} for i in range(1025)]
    display = PackedReads(copy.deepcopy(reads))
    analysis = PackedReads(copy.deepcopy(reads), display_index=False)
    assert analysis._display_index is None
    assert analysis._selected.max_bytes == 0
    assert 0 < analysis.retained_bytes < display.retained_bytes
    for packed in [analysis, pickle.loads(pickle.dumps(analysis))]:
        assert list(packed) == reads
        assert packed[::37] == reads[::37]
        assert packed[-1] == reads[-1]
        assert packed.take([0, 512, 1024]) == {i: reads[i] for i in [0, 512, 1024]}
        assert [row[0] for row in packed.overlapping(510, 515)] == list(range(491, 515))
    cache = ByteCache(analysis.retained_bytes + 1000)
    cache['analysis'] = analysis
    assert cache['analysis'] is analysis
    cache['second'] = pickle.loads(pickle.dumps(analysis))
    assert list(cache) == ['second'] and cache.retained_bytes <= cache.max_bytes


def test_size_fast_path_respects_custom_scalar_and_container_owners():
    class SizedInt(int):
        retained_bytes = 123456
    class SizedList(list):
        retained_bytes = 234567
    assert retained_size(SizedInt(1)) == 123456
    assert retained_size(SizedList([1])) == 234567
    shared = np.arange(1000)
    assert retained_size([shared, shared]) < retained_size([shared.copy(), shared.copy()])
    cycle = [None] * 100
    cycle[0] = cycle
    assert 0 < retained_size(cycle) < 10000


@pytest.mark.parametrize('quality_filters', [[], [{'layer': 'tf', 'quality': 'aq', 'min_value': 230}]])
@pytest.mark.parametrize('read_ids', [None, ['messy']])
def test_transient_packed_projection_matches_reusable_list(quality_filters, read_ids):
    from services.working_sets import _viewport_reads_from_broad
    reads = [
        {'id': 'messy', 'intervals': [[], [4], [70, 90, 20], [10, 80, -70], [20, 50, 30]],
         'qualities': [201, 202], 'methyl': [1, 35, 80], 'reference_start': 0, 'reference_end': 100,
         'layers': {'tf': {'intervals': [[70, 90, 20], [], [2], [10, 80, 70], [20, 50, 30]],
                           'source_intervals': [[60, 100, 40], [], [], [5, 95, 90], [20, 50, 30]],
                           'qualities': [[231, 0, 0, 229, 255]], 'quality_names': ['aq'],
                           'annotation_names': ['last', '', '', 'wide', 'nested']}}},
        {'id': 'other', 'intervals': [[0, 100, -100]]},
    ]
    result = []
    for cohort in [copy.deepcopy(reads), PackedReads(copy.deepcopy(reads))]:
        state = SimpleNamespace(quality_filters=quality_filters, _broad_read_index_cache=OrderedDict())
        result.append(_viewport_reads_from_broad(state=state, all_reads=cohort, dataset=None,
            region_width=50, bc_start=0, bc_end=100, start=25, end=75,
            spanning=False, min_footprints=0, read_ids=read_ids, include_methylation=True,
            layer_key=('tf',), include_layer_qualities=True, quality_filters=quality_filters))
    assert result[0] == result[1]


def test_endpoint_reuses_fitting_features_for_centroids(monkeypatch):
    from test_clustering_endpoint import FakeClusterState
    from models.requests import ClusterAllRequest
    from services import cluster_assignment, dynamic_clustering
    from services.clustering_endpoint import run_cluster_all_endpoint
    calls = []
    original = cluster_assignment.extract_features_grouped
    def extract(*args, **kwargs):
        calls.append(1)
        return original(*args, **kwargs)
    monkeypatch.setattr(cluster_assignment, 'extract_features_grouped', extract)
    monkeypatch.setattr(dynamic_clustering, 'extract_features_grouped',
                        lambda *a, **k: pytest.fail('features extracted again for centroids'))
    result = run_cluster_all_endpoint(state=FakeClusterState(),
        req=ClusterAllRequest(method='kmeans', k=2,
                             peak_regions=[{'start': 105, 'end': 115}]),
        chrom='chr1', start=100, end=130, spanning=False)
    assert len(calls) == 1 and result['cluster_centroids']


@pytest.mark.parametrize('method', ['kmeans', 'minibatch', 'hdbscan', 'agglom', 'graph'])
@pytest.mark.parametrize('grouped', [False, True])
def test_reused_centroids_preserve_duplicate_id_summation(method, grouped):
    from services.cluster_assignment import cluster_compact_reads
    from services.dynamic_clustering import (compute_cluster_centroids_from_compact,
                                             compute_cluster_centroids_from_features)
    reads = [{'id': 'duplicate' if i % 2 == 0 else str(i),
              'intervals': [[0, i + 10, 100], [i + 10, 30, -20]]} for i in range(8)]
    options = {}
    fitting = {}
    peaks = [[0, 30]]
    if grouped:
        def resolve(read, group, region_start):
            return [(2, 6, 1)] if read['id'] == 'duplicate' else []
        context = {'resolve_footprint_class': resolve}
        rules = [dict(id='cart', enabled=True, terms=[dict(source='footprint_class', group=dict(
            consensusStateId='A', consensusJobId='j', sourceDatasetId='ds1'))])]
        peaks = [[0, 30], [0, 30]]
        options = dict(peak_modes=['accessibility', 'cluster_rule:cart'],
                       cluster_feature_rules=rules, cluster_rule_context=context,
                       window_groups={'other': ([[5, 35], [5, 35]], 100, context)})
        for i, read in enumerate(reads):
            read['_cluster_group'] = 'other' if i % 3 else 'here'
        fitting['missing_feature_groups'] = {'other': [1]}
        if method in ('kmeans', 'minibatch'):
            fitting['fit_rows'] = [0, 1, 3, 5, 6]
    saved = copy.deepcopy(reads)
    features = {}
    assignments, _, _, _ = cluster_compact_reads(reads, peaks, 0, 2, method=method,
                                                features_out=features, **options, **fitting)
    actual = compute_cluster_centroids_from_features(features['features'], features['read_ids'],
                                                     features['peak_widths'], assignments)
    expected = compute_cluster_centroids_from_compact(reads, peaks, 0, assignments,
                                                      subnucleosomal_threshold=90, **options)
    assert actual == expected and reads == saved
