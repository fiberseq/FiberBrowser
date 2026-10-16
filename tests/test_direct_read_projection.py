"""Direct-cache projections preserve molecular evidence across contained views."""
import copy
import os

import pytest

from services.direct_read_projection import project_direct_reads
from services.read_binary import _wire_read, binary_read_context


def test_terminal_gap_provenance_and_aligned_metadata():
    reads = [{'id': 'one', 'reference_start': 100, 'reference_end': 200,
              '_fiberbrowser_terminal_gaps': [[100, 130], [190, 200]],
              'intervals': [[0, 30, -30], [30, 50, 20], [50, 70, -20], [70, 90, 20], [90, 100, -10]],
              'qualities': [10, 20], 'deam': [[0, 0], [20, 1], [80, 0]],
              'layers': {'tf': {'intervals': [[0, 30, 30], [70, 90, 20]], 'qualities': [[40, 90]],
                                'annotation_names': ['a', 'b'], 'source_intervals': [[0, 30, 30], [70, 90, 20]]}}}]
    original = copy.deepcopy(reads)
    projected = project_direct_reads(reads, 100, 120, 180)[0]
    assert projected['intervals'] == [[0, 10, -10], [10, 30, 20], [30, 50, -20], [50, 60, 20]]
    assert projected['qualities'] == [10, 20]
    assert projected['deam'] == [[0, 1]]
    assert projected['layers']['tf']['source_intervals'] == [[-20, 10, 30], [50, 70, 20]]
    assert reads == original
    assert project_direct_reads([{'id': 'old', 'intervals': [[0, 100, 100]]}], 100, 120, 180) is None


def test_terminal_gap_size_survives_deletion_splits():
    read = {'id': 'split', 'intervals': [[0, 200, -800], [400, 800, -800], [800, 1000, 200]],
            'sv': [{'t': 'D', 'ref': 300, 'len': 200, 'q': 200}],
            '_fiberbrowser_terminal_gaps': [[100, 900]]}
    assert project_direct_reads([read], 100, 110, 1090)[0]['intervals'] == [
        [0, 190, -790], [390, 790, -790], [790, 980, 200]]


def test_primary_mark_loss_reloads_instead_of_losing_view_dependent_fallbacks():
    base = dict(id='marks', intervals=[[0, 100, 100]], _fiberbrowser_terminal_gaps=[])
    for marks in [dict(methyl_m6a=[5], methyl=[5]), dict(deam=[[5, 0]], methyl=[5])]:
        assert project_direct_reads([{**base, **marks}], 100, 120, 180) is None
    read = {**base, 'methyl_m6a': [5], 'methyl_m5c': [40], 'methyl': [5]}
    projected = project_direct_reads([read], 100, 120, 180)[0]
    assert 'methyl_m6a' not in projected
    assert projected['methyl_m5c'] == projected['methyl'] == [20]


@pytest.mark.parametrize('start,end', [(47514150, 47516150), (47515150, 47517150), (47514650, 47515650)])
def test_contained_direct_projection_matches_fresh_molecules(start, end):
    path = os.environ.get('FIBERBROWSER_TEST_TRANSPORT_BAM')
    if not path:
        pytest.skip('Set FIBERBROWSER_TEST_TRANSPORT_BAM to an indexed chr19 evidence BAM')
    from services.compact_read_loader import build_compact_reads_from_bam
    kwargs = dict(spanning_only=False, include_methylation=True, include_layers=True,
                  requested_layers={'nuc', 'tf'}, hide_terminal_gaps=False, min_footprints=0,
                  short_terminal_footprint_bp=30)
    token = binary_read_context.set(True)
    try:
        loaded = build_compact_reads_from_bam(path, 'chr19', 47513150, 47518150, **kwargs)
        fresh = build_compact_reads_from_bam(path, 'chr19', start, end, **kwargs)
    finally:
        binary_read_context.reset(token)
    projected = project_direct_reads(loaded, 47513150, start, end)
    assert projected is not None

    def normalized(read):
        read = _wire_read(read)
        if 'layers' in read:
            read = {**read, 'layers': {k: v for k, v in read['layers'].items() if v.get('intervals')}}
        return read

    assert [normalized(r) for r in projected] == [normalized(r) for r in fresh]
    from types import SimpleNamespace
    import numpy as np
    from services.analysis_query import AnalysisReadQuery
    from services.direct_read_projection import direct_scan_counts
    from services.peak_scanning import compute_scan_counts
    from services.working_sets import read_load_token
    state = SimpleNamespace(quality_filters=[{'layer': 'fire', 'quality_name': 'aq', 'min_value': 230}],
                            short_terminal_footprint_bp=30, max_working_reads=0)
    key = ('sample', 'chr19', 47513150, 47518150, False, True, 125, 0, False,
           ('nuc', 'tf'), True, False, 0, True, 90, False, 0, read_load_token(state, 'chr19'), 50, False)
    state._methylation_cache = {key: (loaded, None)}
    query = AnalysisReadQuery(chrom='chr19', start=start, end=end, dataset_ids=['sample'])
    for signal in ('accessibility', 'tf_density'):
        result = direct_scan_counts(state, query, 'sample', signal)
        assert result is not None and result[2] == len(fresh)
        expected = compute_scan_counts(fresh, signal, end - start)
        np.testing.assert_array_equal(result[0], expected[0])
        np.testing.assert_array_equal(result[1], expected[1])
    state.max_working_reads = 1
    assert direct_scan_counts(state, query, 'sample', 'accessibility') is None
    from dataclasses import replace
    scoped = replace(query, singleton_read_ids=[fresh[0]['id']])
    assert direct_scan_counts(state, scoped, 'sample', 'accessibility')[2] == 1
    state.quality_filters = [{'layer': 'nuc', 'min_value': 10}]
    assert direct_scan_counts(state, scoped, 'sample', 'accessibility') is None


def test_explicit_low_memory_scan_cannot_bypass_analysis_cap_with_a_direct_cohort():
    from types import SimpleNamespace
    from services.analysis_query import AnalysisReadQuery
    from services.direct_read_projection import direct_scan_counts
    from services.working_sets import read_load_token
    state = SimpleNamespace(max_working_reads=1, performance={'effective': 'standard'})
    reads = [dict(id=str(i), intervals=[[0, 100, 100]]) for i in range(3)]
    key = ('sample', 'chr1', 0, 100, False, False, 125, 0, False,
           (), True, False, 0, True, 90, False, 0, read_load_token(state, 'chr1'), 50, False)
    state._methylation_cache = {key: (reads, None)}
    query = AnalysisReadQuery(chrom='chr1', start=0, end=100, dataset_ids=['sample'],
                              singleton_read_ids=['0', '1', '2'])
    assert direct_scan_counts(state, query, 'sample', 'accessibility')[2] == 3
    state.performance['effective'] = 'low'
    assert direct_scan_counts(state, query, 'sample', 'accessibility') is None
