"""Shared scanning pools counts before detecting peaks, including reversed blocks and gaps."""
from types import SimpleNamespace
import pytest
from models.domain import WorkingSet
from services.correspondence_scanning import CorrespondenceScanRequest, run
from services.correspondence_clustering import RegionViewport, FrameBlock
from state.browser_state import BrowserState


def view(key, genome=None, reverse=False):
    return RegionViewport(dataset_id=key, result_key=key, genome=genome, chrom='alt' if genome else 'chr1',
        start=0, end=250, reverse=reverse, blocks=[FrameBlock(frame=(0, 100), genomic=(0, 100)),
                                                 FrameBlock(frame=(100, 200), genomic=(150, 250))])


def setup(monkeypatch, reverse=False):
    state = BrowserState(None)
    other = BrowserState(None)
    state.genome_contexts = {'alt': other}
    state.dataset_genomes = {'b': 'alt'}
    state.datasets = {'a': SimpleNamespace(), 'b': SimpleNamespace()}
    state.dataset_order = ['a', 'b']
    calls = []

    def working(self, dataset_id, chrom, start, end, spanning=False, min_footprints=0, **kwargs):
        calls.append(dataset_id)
        assert kwargs['broad_prefetch_multiplier'] == 1
        # Neither member alone reaches min_reads=5; only the pooled 6 molecules do.
        intervals = [[0, 20, 147], [20, 60, 0], [60, 250, 147]]
        if reverse and dataset_id == 'b':
            intervals = [[0, 40, 147], [40, 80, 0], [80, 250, 147]]
        return WorkingSet([dict(id=f'r{i}', intervals=intervals) for i in range(3)],
                          total_overlapping=3, total_spanning=3, chrom=chrom, start=start, end=end)
    monkeypatch.setattr(BrowserState, 'build_working_set', working)
    return state, calls


def test_scan_once_over_pooled_molecules_with_member_profiles(monkeypatch):
    state, calls = setup(monkeypatch, reverse=True)
    req = CorrespondenceScanRequest(length=200, viewports=[view('a'), view('b', 'alt', True)],
                                    min_width=10, smooth_width=1, min_reads=5)
    result = run(state, req)
    assert calls == ['a', 'b']
    assert result['n_reads'] == 6
    assert result['peaks']
    assert result['peaks'][0]['start'] < 40 < result['peaks'][0]['end']
    assert all(p['end'] <= 100 or p['start'] >= 100 for p in result['peaks'])
    assert result['members']['a']['n_reads'] == result['members']['b']['n_reads'] == 3
    assert max(result['profiles'][0]['coverage']) == 6
    assert result['members']['a']['signal'] == result['members']['b']['signal']


def test_no_projection_or_peak_call_in_inserted_sequence(monkeypatch):
    state, _ = setup(monkeypatch)
    def working(self, dataset_id, chrom, start, end, spanning=False, min_footprints=0, **kwargs):
        return WorkingSet([dict(id=f'r{i}', intervals=[[0, 100, 147], [100, 150, 0], [150, 250, 147]]) for i in range(8)],
                          total_overlapping=8, total_spanning=8, chrom=chrom, start=start, end=end)
    monkeypatch.setattr(BrowserState, 'build_working_set', working)
    result = run(state, CorrespondenceScanRequest(length=200, viewports=[view('a'), view('b', 'alt')], min_width=10))
    assert result['peaks'] == []


def test_invalid_maps_fail_before_loading(monkeypatch):
    state, calls = setup(monkeypatch)
    b = view('b', 'alt')
    b.blocks[0].genomic = (0, 101)
    with pytest.raises(ValueError, match='block'):
        run(state, CorrespondenceScanRequest(length=200, viewports=[view('a'), b]))
    assert not calls


def test_scan_reuses_broad_counts_with_member_read_scope(monkeypatch):
    import numpy as np
    from services import correspondence_scanning as cs
    state, calls = setup(monkeypatch)
    seen = []
    def cached(*, state, query, dataset_id, signal_source, region_width):
        seen.append((dataset_id, query.read_ids_for_dataset(dataset_id), query.include_layer_qualities))
        numerator = np.zeros(region_width, dtype=np.int64)
        numerator[20:60] = 3
        return numerator, np.full(region_width, 3), 3
    monkeypatch.setattr(cs, '_compute_scan_counts_from_broad_cache', cached)
    a, b = view('a'), view('b', 'alt')
    a.read_ids = ['r1']; b.read_ids = ['r2']
    result = run(state, CorrespondenceScanRequest(length=200, viewports=[a, b], min_width=10, smooth_width=1))
    assert seen == [('a', ['r1'], False), ('b', ['r2'], False)]
    assert calls == []
    assert result['n_reads'] == 6
    assert result['peaks']


def test_many_members_pool_counts_instead_of_averaging_profiles(monkeypatch):
    import numpy as np
    from services import correspondence_scanning as cs
    state, _ = setup(monkeypatch)
    state.datasets = {str(i): SimpleNamespace() for i in range(24)}
    state.dataset_order = list(state.datasets)
    calls = []
    def cached(*, dataset_id, region_width, **kwargs):
        i = int(dataset_id)
        calls.append(i)
        return np.full(region_width, (i + 1) if i % 2 else 0), np.full(region_width, i + 1), i + 1
    monkeypatch.setattr(cs, '_compute_scan_counts_from_broad_cache', cached)
    result = run(state, CorrespondenceScanRequest(length=200, viewports=[view(str(i)) for i in range(24)]))
    assert calls == list(range(24))
    assert len(result['members']) == 24
    assert result['n_reads'] == sum(range(1, 25))
    assert result['profiles'][0]['signal'][0] == pytest.approx(sum(range(2, 25, 2)) / sum(range(1, 25)))
