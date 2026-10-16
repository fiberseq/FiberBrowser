"""Independent native parity for bounded, full-cohort feature extraction."""
from types import SimpleNamespace
from copy import deepcopy

import numpy as np
import pytest

from models.domain import WorkingSet
from models.requests import ClusterAllRequest, PeakRegion
from services.cluster_assignment import cluster_compact_reads
from services.columnar_clustering import ColumnarPatterns, use_columnar_clustering
from services.packed_reads import PackedReadBuilder, PackedReads, bounded_analysis, bounded_read_analysis, packed_decode


def assert_native_parity(reads, peaks, **kwargs):
    native = cluster_compact_reads(reads, peaks, 1000, 5, method='combinatorial', **kwargs)
    builder = ColumnarPatterns(peaks, 1000, block_rows=7, **kwargs)
    for read in reads:
        builder.append(read)
    actual = builder.finish()
    assert actual[0] == native[0]
    assert actual[1] == native[1]
    np.testing.assert_array_equal(actual[2], native[2])
    assert actual[3] == native[3]
    assert builder.diagnostics()['input_rows'] == len(reads)
    assert builder.max_expanded_reads <= 7
    return builder


@pytest.mark.parametrize('threshold', [0, .1, .333333333, .5, .999999, 1])
def test_mixed_features_marks_empty_authoritative_msp_and_block_boundaries(threshold):
    rng = np.random.default_rng(483)
    peaks = [[0, 90], [90, 140], [140, 230], [230, 320], [320, 440], [440, 520]]
    reads = []
    for i in range(89):
        intervals = [[p, p + 10, int(rng.choice([0, 40, 150]))] for p in range(0, 520, 10)]
        read = dict(id=f'r{i}', intervals=intervals,
                    methyl_m6a=sorted(int(v) for v in rng.choice(520, 18, replace=False)),
                    methyl_m5c=sorted(int(v) for v in rng.choice(520, 18, replace=False)),
                    deam=[[int(v), 1] for v in sorted(rng.choice(520, 18, replace=False))])
        if i % 3 == 0:
            read['layers'] = {'msp': {'intervals': []}}
        elif i % 3 == 1:
            read['layers'] = {'msp': {'intervals': [[0, 30, 30], [50, 80, 30]]}}
        reads.append(read)
    assert_native_parity(reads, peaks, peak_modes=['accessibility', 'nuc', 'tf', 'm6a', 'm5c', 'deam'],
                         accessibility_threshold=threshold)


def test_rare_patterns_weighted_by_unequal_peak_widths_and_frequency_ties():
    peaks, cursor = [], 0
    for i in range(7):
        peaks.append([cursor, cursor + 10 * (i + 1)])
        cursor = peaks[-1][1]
    reads = []
    # Every possible pattern, intentionally encountered in non-lexical order.
    for pattern in np.random.default_rng(19).permutation(128):
        for repeat in range(1 + int(pattern % 3 == 0)):
            reads.append(dict(id=f'p{pattern}-{repeat}',
                              intervals=[[left, right, 0 if pattern & (1 << bit) else 150]
                                         for bit, (left, right) in enumerate(peaks)]))
    result = assert_native_parity(reads, peaks)
    assert result.pattern_bytes == len(reads) * len(peaks)


def test_class_columns_and_duplicate_read_names_keep_native_semantics():
    rules = [dict(id='cart', enabled=True, terms=[dict(source='footprint_class', group=dict(
        consensusStateId=f, consensusJobId='j', sourceDatasetId='d')) for f in ['A', 'B']])]
    reads = [dict(id=f'd::{name}', intervals=[[0, 30, 30]]) for name in ['A', 'B', 'both', 'neither', 'A']]
    def resolve(read, group, start):
        return [(5, 8, 1)] if read['id'].split('::')[1] in (group['consensusStateId'], 'both') else []
    assert_native_parity(reads, [[0, 30]], peak_modes=['cluster_rule:cart'],
                         cluster_feature_rules=rules, cluster_rule_context=dict(resolve_footprint_class=resolve))


def test_partial_coverage_is_rejected_and_context_is_restored_after_failure():
    builder = ColumnarPatterns([[0, 100]], 0)
    with pytest.raises(ValueError, match='full feature coverage'):
        builder.append(dict(id='hole', intervals=[[0, 40, 10], [60, 100, 10]]))
    with pytest.raises(RuntimeError):
        with bounded_read_analysis():
            assert bounded_analysis.get() and packed_decode.get()
            raise RuntimeError('cancelled')
    assert not bounded_analysis.get() and not packed_decode.get()


def test_feature_block_size_is_bounded_for_wide_peaks():
    builder = ColumnarPatterns([[0, 2_000_000]], 0)
    assert builder.block_rows == 10


@pytest.mark.parametrize('estimate,expected', [(99999, False), (100000, True), (None, True)])
def test_size_policy_keeps_unknown_csi_and_remote_cohorts_bounded(monkeypatch, estimate, expected):
    from services import compact_read_loader, read_sampling
    from services.analysis_query import AnalysisReadQuery
    monkeypatch.setattr(compact_read_loader, '_bam_wrap_length_for', lambda *args: None)
    monkeypatch.setattr(read_sampling, 'estimate_reads', lambda *args, **kwargs: estimate)
    dataset = SimpleNamespace(data_type='bam', paths=['sample.bam'], derived_layers={}, companion_layers={})
    state = SimpleNamespace(get_dataset=lambda _: dataset)
    query = AnalysisReadQuery(chrom='chr1', start=0, end=100, dataset_ids=['d'])
    assert use_columnar_clustering(state, ClusterAllRequest(method='combinatorial'), query) is expected


def test_endpoint_matches_native_counts_assignments_elements_and_filters(monkeypatch):
    from services import columnar_clustering, clustering_endpoint
    class State:
        dataset_order = ['d1', 'd2']
        max_working_reads = 0
        peak_regions = []
        def __init__(self):
            self.datasets = {d: SimpleNamespace(cluster_assignments={}) for d in self.dataset_order}
            self.bounded_calls = []
        def translate_chrom(self, chrom):
            return chrom
        def resolve_dataset_id(self, dataset_id=None):
            return dataset_id or 'd1'
        def get_dataset(self, dataset_id):
            return self.datasets.get(dataset_id)
        def build_working_set(self, dataset_id, chrom, start, end, *args, **kwargs):
            self.bounded_calls.append(bounded_analysis.get())
            builder = PackedReadBuilder()
            for i in range(39):
                read = dict(id=f'r{i}', intervals=[[0, 100, 0 if i % 2 else 120], [100, 250, 0 if i % 3 else 120]])
                if i == 3:
                    read['intervals'] = [[0, 25, 10], [100, 250, 120]]
                builder.append(read)
            return WorkingSet(builder.finish(), 39, 38, chrom, start, end)
    req = ClusterAllRequest(method='combinatorial', max_reads=0, dataset_ids=['d1', 'd2'],
                            peak_regions=[PeakRegion(start=1010, end=1070), PeakRegion(start=1110, end=1210)])
    args = dict(req=req, chrom='chr1', start=1000, end=1250, spanning=False)
    before = State()
    monkeypatch.setattr(columnar_clustering, 'use_columnar_clustering', lambda *_: False)
    native = clustering_endpoint.run_cluster_all_endpoint(state=before, **args)
    after = State()
    monkeypatch.setattr(columnar_clustering, 'use_columnar_clustering', lambda *_: True)
    actual = clustering_endpoint.run_cluster_all_endpoint(state=after, **args)
    diagnostic = actual.pop('analysis_storage')
    native.pop('timings'); actual.pop('timings')
    assert actual == native
    assert diagnostic['input_rows'] == 76
    assert after.bounded_calls == [True, True]
    assert before.bounded_calls == [False, False]
    for dataset_id in before.datasets:
        assert vars(before.datasets[dataset_id]) == vars(after.datasets[dataset_id])
    assert not bounded_analysis.get()


@pytest.mark.parametrize('change', ['cap', 'working_cap', 'scope', 'low', 'circular', 'derived', 'graph'])
def test_unsupported_queries_use_native_path(change):
    from services.analysis_query import AnalysisReadQuery
    state = SimpleNamespace(max_working_reads=0, performance={}, circular_chroms={},
                            get_dataset=lambda _: SimpleNamespace(data_type='bam', paths=['unused'],
                                                                   derived_layers={}, companion_layers={}))
    req = ClusterAllRequest(method='combinatorial')
    query = AnalysisReadQuery(chrom='chr1', start=0, end=100, dataset_ids=['d'])
    if change == 'cap':
        query = deepcopy(query)
        object.__setattr__(query, 'max_reads', 10)
    elif change == 'working_cap':
        state.max_working_reads = 10
    elif change == 'scope':
        query.read_ids_by_dataset['d'] = []
    elif change == 'low':
        state.performance = {'effective': 'low'}
    elif change == 'circular':
        state.circular_chroms = {'chr1': {'size': 100}}
    elif change == 'derived':
        state.get_dataset = lambda _: SimpleNamespace(data_type='bam', paths=['unused'], derived_layers={'nuc': {}})
    elif change == 'graph':
        req.method = 'graph'
    assert not use_columnar_clustering(state, req, query)
