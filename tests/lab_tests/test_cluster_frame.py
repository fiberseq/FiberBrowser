"""Region maps share feature columns across references, strands, gaps and copies."""
from types import SimpleNamespace

import numpy as np
import pytest

from lab.services import frame_clustering as fc
from models.requests import PeakRegion
from models.domain import WorkingSet
from services.clustering_features import extract_features_from_compact
from state.browser_state import BrowserState


def window(key, start=100, reverse=False, genome=None, dataset='d', blocks=None, **kw):
    return fc.RegionViewport(dataset_id=dataset, result_key=key, chrom='chr1', start=start, end=start+200,
        genome=genome, reverse=reverse, blocks=blocks or [fc.FrameBlock(frame=(0, 100), genomic=(start, start+100))], **kw)


def request(views, **kwargs):
    return fc.RegionClusterRequest(viewports=views, peak_regions=[PeakRegion(start=0, end=100)],
        method='kmeans', k=2, **kwargs)


def test_reverse_maps_identical_signal_to_identical_columns():
    forward, reverse = window('a'), window('b', reverse=True)
    _, ps = fc.common_geometry(request([forward, reverse]))
    x = []
    for v, intervals in [(forward, [[0, 40, 0], [40, 200, 147]]), (reverse, [[0, 60, 147], [60, 100, 0], [100, 200, 147]])]:
        values, _, _, _ = extract_features_from_compact([dict(id='r', intervals=intervals)], [(0, 100)], 100,
            peak_positions=fc.genomic_positions(v, ps))
        x.append(values)
    np.testing.assert_array_equal(x[0], x[1])
    assert fc.genomic_positions(reverse, ps)[0] == list(range(199, 99, -10))


def test_indel_skips_positions_not_shared_by_every_window():
    a = window('a')
    b = window('b', blocks=[fc.FrameBlock(frame=(0, 20), genomic=(100, 120)),
                            fc.FrameBlock(frame=(70, 100), genomic=(170, 200))])
    _, ps = fc.common_geometry(request([a, b]))
    assert ps == [[0, 10, 70, 80, 90]]
    assert fc.genomic_positions(a, ps) == fc.genomic_positions(b, ps)


def test_invalid_geometry_is_refused_before_loading():
    for blocks in [[fc.FrameBlock(frame=(0, 100), genomic=(100, 199))],
                   [fc.FrameBlock(frame=(0, 60), genomic=(100, 160)), fc.FrameBlock(frame=(50, 100), genomic=(170, 220))]]:
        with pytest.raises(ValueError, match='block'):
            fc.common_geometry(request([window('a', blocks=blocks)]))


@pytest.fixture
def state(monkeypatch):
    base = BrowserState(None)
    context = BrowserState(None)
    base.current_genome = 'main-ref'
    context.current_genome = 'alt-ref'
    base.genome_contexts = {'alt': context}
    base.dataset_genomes = {'other': 'alt'}
    base.datasets = {'d': SimpleNamespace(), 'other': SimpleNamespace()}
    base.dataset_order = ['d', 'other']
    calls = []

    def working(self, dataset_id, chrom, start, end, spanning=False, min_footprints=0, **kwargs):
        calls.append((self.current_genome, dataset_id, start))
        n = 6 if dataset_id == 'd' else 10
        reads = [dict(id=f'r{i}', intervals=[[0, end-start, 0 if i % 2 else 147]]) for i in range(n)]
        reads.append(dict(id='short', intervals=[[0, 10, 0]]))
        return WorkingSet(reads, total_overlapping=len(reads), total_spanning=n, chrom=chrom, start=start, end=end)

    monkeypatch.setattr(BrowserState, 'build_working_set', working)
    return base, calls


def test_two_references_three_copies_assign_every_window_and_balance(state, monkeypatch):
    base, calls = state
    views = [window('native'), *[window(f'copy-{c}', start=100+i*300, genome='alt', dataset='other') for i, c in enumerate('abc')]]
    observed = {}
    original = fc.cluster_compact_reads

    def cluster(reads, *args, **kwargs):
        observed['fit'] = kwargs['fit_rows']
        observed['groups'] = [r['_cluster_group'] for r in reads]
        return original(reads, *args, **kwargs)

    monkeypatch.setattr(fc, 'cluster_compact_reads', cluster)
    result = fc.run(base, request(views))
    assert [c[0] for c in calls] == ['main-ref', 'alt-ref', 'alt-ref', 'alt-ref']
    assert set(result['results']) == {'native', 'copy-a', 'copy-b', 'copy-c'}
    assert [len(v['assignments']) for v in result['results'].values()] == [6, 10, 10, 10]
    assert all('short' not in v['assignments'] for v in result['results'].values())
    assert result['matched']['balanced_fit_reads'] == 6
    assert result['matched']['fit_reads'] == 24
    assert {key: sum(observed['groups'][i] == key for i in observed['fit']) for key in result['results']} == dict.fromkeys(result['results'], 6)
    assert result['results']['copy-a']['assignments'] == result['results']['copy-b']['assignments'] == result['results']['copy-c']['assignments']
    assert result['reference_separation_nmi'] == pytest.approx(0)
    assert result['window_separation_nmi'] == pytest.approx(0)


def test_reference_mismatch_and_duplicate_keys_are_refused(state):
    base, calls = state
    with pytest.raises(ValueError, match='reference'):
        fc.run(base, request([window('a', genome='alt')]))
    with pytest.raises(ValueError, match='distinct'):
        fc.run(base, request([window('a'), window('a')]))
    assert calls == []


def test_empty_window_and_explicit_read_filters(state):
    base, _ = state
    a, b = window('a'), window('b')
    a.read_ids = []
    b.read_ids = ['r1', 'r2']
    result = fc.run(base, request([a, b]))
    assert result['results']['a']['assignments'] == {}
    assert set(result['results']['b']['assignments']) == {'r1', 'r2'}
    assert result['reference_separation_nmi'] is None


def test_balancing_does_not_change_methods_without_prediction(state):
    base, _ = state
    req = request([window('a'), window('b', dataset='other', genome='alt')])
    req.method = 'combinatorial'
    result = fc.run(base, req)
    assert result['matched']['balanced'] is False
    assert result['matched']['fit_reads'] == 16
    assert result['matched']['balanced_fit_reads'] == 0


def test_no_reads_gives_empty_assignments_and_null_nmi(state):
    base, _ = state
    v = window('a'); v.read_ids = []
    result = fc.run(base, request([v]))
    assert result['results']['a']['analysis_read_count'] == 0
    assert result['results']['a']['assignments'] == {}
    assert result['window_separation_nmi'] is None


def test_multiple_features_have_independent_geometry():
    views = [window('a'), window('b', start=400)]
    for v in views:
        v.blocks.append(fc.FrameBlock(feature=1, frame=(0, 40), genomic=(v.start+120, v.start+160), reverse=True))
    req = request(views)
    req.peak_regions.append(PeakRegion(start=0, end=40))
    lengths, positions = fc.common_geometry(req)
    assert lengths == [100, 40]
    assert fc.genomic_positions(views[0], positions)[1] == [259, 249, 239, 229]
    assert [len(ps) for ps in positions] == [10, 4]


def test_wrapped_regions_require_the_whole_hull(state, monkeypatch):
    base, _ = state
    def working(self, dataset_id, chrom, start, end, *args, **kwargs):
        reads = [dict(id='split', intervals=[[0, 90, 0], [190, 200, 0]]),
                 dict(id='full', intervals=[[0, 200, 0]])]
        return WorkingSet(reads, total_overlapping=2, total_spanning=1, chrom=chrom, start=start, end=end)
    monkeypatch.setattr(BrowserState, 'build_working_set', working)
    # Blocks across a circular origin: an explicit flag (graph primary G0), never inferred from block order.
    v = window('wrap', start=0, wraps_origin=True, blocks=[fc.FrameBlock(frame=(0, 10), genomic=(190, 200)),
                                                         fc.FrameBlock(frame=(10, 100), genomic=(0, 90))])
    result = fc.run(base, request([v]))['results']['wrap']
    assert result['eligible_read_count'] == 2
    assert result['peak_covering_read_count'] == 1
    assert set(result['assignments']) == {'full'}


@pytest.mark.parametrize('method', ['graph', 'kmeans'])
def test_identical_windows_have_identical_composition_and_zero_nmi(state, monkeypatch, method):
    base, _ = state
    # Several distinct patterns, each repeated in both windows.
    def working(self, dataset_id, chrom, start, end, *args, **kwargs):
        reads = [dict(id=f'r{i}', intervals=[[0, 20 + (i % 5)*15, 0],
                    [20 + (i % 5)*15, end-start, 147]]) for i in range(80)]
        return WorkingSet(reads, total_overlapping=80, total_spanning=80, chrom=chrom, start=start, end=end)
    monkeypatch.setattr(BrowserState, 'build_working_set', working)
    req = request([window('a'), window('b')], sample_seed='42')
    req.method = method
    result = fc.run(base, req)
    assert result['results']['a']['assignments'] == result['results']['b']['assignments']
    assert result['results']['a']['cluster_counts'] == result['results']['b']['cluster_counts']
    assert result['window_separation_nmi'] == pytest.approx(0, abs=1e-12)
    assert result['matched']['balanced'] is (method == 'kmeans')


def test_graph_receives_one_pooled_matrix_and_no_balanced_fit(state, monkeypatch):
    from services import cluster_assignment as ca
    base, _ = state
    calls = []
    def graph(features, ids, resolution, random_state):
        calls.append((features.copy(), ids))
        return (features[:, 0] > .5).astype(int)
    monkeypatch.setattr(ca, '_graph_labels', graph)
    original = fc.cluster_compact_reads
    def cluster(*args, **kwargs):
        assert kwargs['fit_rows'] is None
        return original(*args, **kwargs)
    monkeypatch.setattr(fc, 'cluster_compact_reads', cluster)
    req = request([window('a'), window('b', dataset='other', genome='alt')])
    req.method = 'graph'
    result = fc.run(base, req)
    assert len(calls) == 1
    assert calls[0][0].shape == (16, 10)
    assert [rid.split('::')[0] for rid in calls[0][1]] == ['a']*6 + ['b']*10
    assert result['matched']['fit_reads'] == 16
    assert result['window_separation_nmi'] == pytest.approx(0)


def test_nmi_uses_only_rows_with_assignments(state, monkeypatch):
    base, _ = state
    monkeypatch.setattr(fc, 'cluster_compact_reads', lambda *a, **k:
        ({'a::r0': 0, 'a::r1': 1, 'b::r0': 0, 'b::r1': 1}, {}, None, None))
    result = fc.run(base, request([window('a'), window('b')]))
    assert result['window_separation_nmi'] == pytest.approx(0)


def test_pooled_graph_columns_follow_frame_order_across_gaps_and_reversal(state, monkeypatch):
    from services import cluster_assignment as ca
    base, _ = state
    def working(self, dataset_id, chrom, start, end, *args, **kwargs):
        intervals = ([[0, 20, 0], [20, 200, 147]] if start == 100 else
                     [[0, 180, 147], [180, 200, 0]])
        return WorkingSet([dict(id='r', intervals=intervals)], total_overlapping=1,
                          total_spanning=1, chrom=chrom, start=start, end=end)
    monkeypatch.setattr(BrowserState, 'build_working_set', working)
    forward = window('a', blocks=[fc.FrameBlock(frame=(0, 40), genomic=(100, 140)),
                                  fc.FrameBlock(frame=(60, 100), genomic=(260, 300))])
    reverse = window('b', start=500, reverse=True,
                     blocks=[fc.FrameBlock(frame=(0, 40), genomic=(660, 700)),
                             fc.FrameBlock(frame=(60, 100), genomic=(500, 540))])
    def graph(features, ids, resolution, random_state):
        assert ids == ['a::r', 'b::r']
        np.testing.assert_array_equal(features, [[1, 1, 0, 0, 0, 0, 0, 0]]*2)
        return np.zeros(2, dtype=int)
    monkeypatch.setattr(ca, '_graph_labels', graph)
    req = request([forward, reverse]); req.method = 'graph'
    assert fc.run(base, req)['matched']['columns'] == [[0, 10, 20, 30, 60, 70, 80, 90]]
