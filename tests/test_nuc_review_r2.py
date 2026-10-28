"""Codex round-2 review fixes, groups C and D (nucleosome work).

C2-1: dynamic reassignment ranks molecule metrics against the fitted cohort (kept with ordinary cluster patterns and
centroids), not against the reads of the current view.
C2-2: a saved fitted cohort keeps every value's multiplicity, so its ranks are the full cohort's.
D2-1: an item whose molecular length is known never takes the class of a footprint of another known length.
D2-2: graph rows carry the named byte, so named-class rules read the same evidence as the linear renderer.
"""
from __future__ import annotations

from types import SimpleNamespace

import numpy as np

from models.domain import WorkingSet
from models.requests import AssignToClustersRequest, ClusterAllRequest, PeakRegion

METRIC_RULE = {'id': 'm', 'enabled': True,
               'terms': [{'id': 't', 'source': 'molecule_metric', 'moleculeMetric': 'nuc.nrl'}]}
METRIC_MODES = ['cluster_rule:m']


def _metric_read(rid, nrl, **extra):
    # A body over the whole peak (0-100), so the read is assigned on its metric column.
    return {'id': rid, 'intervals': [[0, 100, 100]], '_fiberbrowser_scalars': {'nuc.nrl': nrl}, **extra}


# ── C2-2: exact fitted cohort ───────────────────────────────────────────────────────────────────────────────────────

def test_saved_cohort_keeps_exact_value_multiplicities():
    """Codex C2-2: 8,000 fitted reads with NRL {180: 3000, 190: 2001, 200: 2999}. NRL 190's full-cohort mid-rank is
    0.5000625 (bit 1); the saved cohort must give exactly that, not the 0.5 (bit 0) of a 4,001-point sample."""
    from services.clustering_features import extract_features_from_compact, metric_percentile_ranks
    from services.correspondence_clustering import fitted_metric_cohort
    values = [180.0] * 3000 + [190.0] * 2001 + [200.0] * 2999
    reads = [{'id': f'r{i}', 'intervals': [], '_fiberbrowser_scalars': {'nuc.nrl': v}} for i, v in enumerate(values)]
    cohort = fitted_metric_cohort(reads, METRIC_MODES, [METRIC_RULE])
    full = metric_percentile_ranks([190.0], sorted(values))
    saved = metric_percentile_ranks([190.0], cohort['nuc.nrl'])
    assert float(full[0]) > 0.5
    assert float(saved[0]) == float(full[0])
    # Every value (and values between or outside them) ranks exactly as against the full list.
    probe = [170.0, 180.0, 185.0, 190.0, 195.0, 200.0, 210.0, None]
    assert metric_percentile_ranks(probe, cohort['nuc.nrl']).tolist() == metric_percentile_ranks(probe, sorted(values)).tolist()
    # The saved form is small: distinct values with their counts.
    assert cohort['nuc.nrl'] == {'values': [180.0, 190.0, 200.0], 'counts': [3000, 2001, 2999]}
    # Assigning an NRL-190 read with the saved cohort keeps its fitted bit.
    X, _ids, _w, _m = extract_features_from_compact(
        [_metric_read('n', 190.0)], [(0, 100)], 0, peak_modes=METRIC_MODES, cluster_feature_rules=[METRIC_RULE],
        metric_cohort=cohort)
    assert float(X[0, 0]) > 0.5


def test_percentile_ranks_still_accept_a_plain_sorted_cohort():
    """Models saved before C2-2 keep a plain sorted list."""
    from services.clustering_features import metric_percentile_ranks
    assert metric_percentile_ranks([175.0, 190.0], [170.0, 180.0, 190.0, 200.0]).tolist() == [0.25, 0.625]
    # Fewer than two known values: the median, in either form.
    assert metric_percentile_ranks([1.0], {'values': [1.0], 'counts': [1]}).tolist() == [0.5]


# ── C2-1: dynamic assignment ranks against the fitted cohort ────────────────────────────────────────────────────────

FIT_NRL = [180.0, 190.0, 200.0, 210.0]


def _fit_patterns():
    from services.cluster_assignment import cluster_compact_reads
    reads = [_metric_read(f'f{i}', v) for i, v in enumerate(FIT_NRL)]
    assignments, _counts, _order, info = cluster_compact_reads(
        reads, [(0, 100)], 0, 2, method='combinatorial', peak_modes=METRIC_MODES, cluster_feature_rules=[METRIC_RULE])
    return reads, assignments, info['cluster_patterns']


def test_pattern_reassignment_keeps_scalar_clusters_when_the_view_changes():
    """Codex C2-1: fit nuc.nrl on [180, 190, 200, 210] -> [0, 0, 1, 1]; reassigning only the unchanged [200, 210]
    reads must keep [1, 1] (ranked against the fit's cohort), not switch NRL 200 to cluster 0."""
    from services.correspondence_clustering import fitted_metric_cohort
    from services.dynamic_clustering import assign_reads_to_cluster_patterns
    reads, assignments, patterns = _fit_patterns()
    assert [assignments[r['id']] for r in reads] == [0, 0, 1, 1]
    cohort = fitted_metric_cohort(reads, METRIC_MODES, [METRIC_RULE])
    later = [_metric_read('f2', 200.0), _metric_read('f3', 210.0)]
    kwargs = dict(region_start=0, subnucleosomal_threshold=90, accessibility_threshold=0.5, peak_modes=METRIC_MODES,
                  cluster_feature_rules=[METRIC_RULE])
    kept = assign_reads_to_cluster_patterns(later, [[0, 100]], patterns, metric_cohort=cohort, **kwargs)
    assert kept['assignments'] == {'f2': 1, 'f3': 1}
    # Without a cohort (a model saved before it) the view's own reads are the cohort, as before.
    assert assign_reads_to_cluster_patterns(later, [[0, 100]], patterns, **kwargs)['assignments'] == {'f2': 0, 'f3': 1}


def test_centroid_reassignment_keeps_scalar_clusters_when_the_view_changes():
    """Codex C2-1, centroids: fitted centres [0.25] and [0.75]; NRL 200 stays with the upper centre."""
    from services.correspondence_clustering import fitted_metric_cohort
    from services.dynamic_clustering import assign_reads_to_centroids, compute_cluster_centroids_from_compact
    reads = [_metric_read(f'f{i}', v) for i, v in enumerate(FIT_NRL)]
    centroids, widths = compute_cluster_centroids_from_compact(
        reads, [(0, 100)], 0, {'f0': 0, 'f1': 0, 'f2': 1, 'f3': 1}, subnucleosomal_threshold=90,
        peak_modes=METRIC_MODES, cluster_feature_rules=[METRIC_RULE])
    assert {k: [round(x, 3) for x in v] for k, v in centroids.items()} == {0: [0.25], 1: [0.75]}
    cohort = fitted_metric_cohort(reads, METRIC_MODES, [METRIC_RULE])
    later = [_metric_read('f2', 200.0), _metric_read('f3', 210.0)]
    kwargs = dict(region_start=0, subnucleosomal_threshold=90, peak_modes=METRIC_MODES, cluster_feature_rules=[METRIC_RULE])
    kept = assign_reads_to_centroids(later, [[0, 100]], centroids, widths, metric_cohort=cohort, **kwargs)
    assert kept['assignments'] == {'f2': 1, 'f3': 1}
    assert assign_reads_to_centroids(later, [[0, 100]], centroids, widths, **kwargs)['assignments'] == {'f2': 0, 'f3': 1}


class _MetricState:
    """One dataset whose working set is the fit cohort, or (``narrow``) only its NRL 200 and 210 reads."""
    dataset_order = ['ds1']

    def __init__(self):
        self.narrow = False
        self.datasets = {'ds1': SimpleNamespace(cluster_assignments={})}
        self.max_working_reads = None
        self.peak_regions = []

    def translate_chrom(self, chrom):
        return chrom

    def resolve_dataset_id(self, dataset_id=None):
        return 'ds1' if dataset_id in (None, '', 'primary') else dataset_id

    def get_dataset(self, dataset_id):
        return self.datasets.get(dataset_id)

    def build_working_set(self, dataset_id, chrom, start, end, spanning=False, min_footprints=0, **kwargs):
        reads = [_metric_read(f'r{int(v)}', v) for v in FIT_NRL if not self.narrow or v >= 200]
        return WorkingSet(reads, total_overlapping=len(reads), total_spanning=len(reads), chrom=chrom, start=start, end=end)


def test_cluster_all_returns_the_fitted_cohort_and_dynamic_assignment_uses_it():
    """Codex C2-1 through the endpoints: the fit returns its scalar cohort with the patterns or centroids, and the
    assignment endpoint ranks a narrower view against it (labels of unchanged reads stay)."""
    from services import clustering_endpoint
    peaks = [PeakRegion(start=0, end=100, mode='cluster_rule:m')]
    for method in ('combinatorial', 'kmeans'):
        state = _MetricState()
        fit = clustering_endpoint.run_cluster_all_endpoint(
            state=state, req=ClusterAllRequest(dataset_ids=['ds1'], method=method, k=2, peak_regions=peaks,
                                               cluster_feature_rules=[METRIC_RULE]),
            chrom='chr1', start=0, end=100, spanning=False)
        labels = fit['results']['ds1']['assignments']
        assert labels['r180'] == labels['r190'] != labels['r200'] == labels['r210'], method
        assert fit['cluster_metric_cohort'] == {'nuc.nrl': {'values': FIT_NRL, 'counts': [1, 1, 1, 1]}}, method
        model = (dict(cluster_patterns=fit['cluster_patterns']) if method == 'combinatorial'
                 else dict(cluster_centroids=fit['cluster_centroids'], cluster_peak_widths=fit['cluster_peak_widths']))
        state.narrow = True
        moved = clustering_endpoint.run_assign_to_clusters_endpoint(
            state=state, req=AssignToClustersRequest(dataset_ids=['ds1'], peak_regions=peaks, cluster_feature_rules=[METRIC_RULE],
                                                     cluster_metric_cohort=fit['cluster_metric_cohort'], **model),
            chrom='chr1', start=0, end=100, spanning=False)
        assert moved['results']['ds1']['assignments'] == {'r200': labels['r200'], 'r210': labels['r210']}, method
        # A model without a cohort keeps today's behaviour (the view's reads rank against themselves).
        legacy = clustering_endpoint.run_assign_to_clusters_endpoint(
            state=state, req=AssignToClustersRequest(dataset_ids=['ds1'], peak_regions=peaks, cluster_feature_rules=[METRIC_RULE],
                                                     **model),
            chrom='chr1', start=0, end=100, spanning=False)
        assert legacy['results']['ds1']['assignments']['r200'] == labels['r180'], method


def test_columnar_fit_keeps_the_same_exact_cohort():
    """The columnar engine keeps no reads: the cohort comes from the metric values it ranked at finish."""
    from services.clustering_endpoint import _fitted_metric_cohort
    from services.clustering_features import fitted_metric_cohort
    from services.columnar_clustering import ColumnarPatterns
    reads = [_metric_read(f'f{i}', v) for i, v in enumerate(FIT_NRL + [200.0, None])]
    builder = ColumnarPatterns([[0, 100]], 0, peak_modes=METRIC_MODES, cluster_feature_rules=[METRIC_RULE], block_rows=2)
    for read in reads:
        builder.append(read)
    assignments, *_ = builder.finish()
    assert len(assignments) == len(reads)
    expected = fitted_metric_cohort(reads, METRIC_MODES, [METRIC_RULE])
    assert expected == {'nuc.nrl': {'values': FIT_NRL, 'counts': [1, 1, 2, 1]}}
    assert _fitted_metric_cohort(builder, [], METRIC_MODES, [METRIC_RULE]) == expected
    assert _fitted_metric_cohort(builder, [], ['accessibility'], []) == {}


def test_cluster_all_without_metric_columns_returns_no_cohort():
    from services import clustering_endpoint
    state = _MetricState()
    fit = clustering_endpoint.run_cluster_all_endpoint(
        state=state, req=ClusterAllRequest(dataset_ids=['ds1'], method='combinatorial', peak_regions=[PeakRegion(start=0, end=100)]),
        chrom='chr1', start=0, end=100, spanning=False)
    assert 'cluster_metric_cohort' not in fit


# ── D2-1: known molecular lengths never borrow another footprint's class ────────────────────────────────────────────

def _filtered_read():
    """Codex D2-1: clipped nuc and TF calls both shown at [0, 10] (molecular lengths 147 and 20). A nucsz.posterior
    >= 100 filter removed the TF's mark (coarse 17, posterior 50), leaving the mono mark (coarse 18, posterior 200)."""
    return {'id': 'r', 'intervals': [[0, 10, 147]],
            'layers': {'nucsz': {'intervals': [[0, 10, 147]], 'quality_names': ['coarse', 'named', 'posterior', 'z'],
                                 'qualities': [[18], [0], [200], [128]]},
                       'nuc': {'intervals': [[0, 10, 147]]},
                       'tf': {'intervals': [[0, 10, 20]]}}}


TF_MONO_RULE = {'id': 'tfmono', 'name': 'tf mono', 'enabled': True, 'sizeMin': 0, 'sizeMax': None, 'conditions': [],
                'targetLayers': ['tf'], 'nucCoarse': [2]}


def test_a_call_of_another_known_length_never_takes_the_surviving_mark():
    from services.clustering_features import _cluster_feature_rule_intervals, nuc_size_index, nuc_size_mark_for
    from services.read_metrics import compute_rule_metric
    read = _filtered_read()
    index = nuc_size_index(read)
    assert nuc_size_mark_for(index, 0, 10, 20) is None
    assert nuc_size_mark_for(index, 0, 10, 147)['coarse'] == 18
    assert nuc_size_mark_for(index, 0, 10)['coarse'] == 18           # no length: by span, as before
    assert nuc_size_mark_for(index, 2, 8, 20) is None                # covering phase rejects it too
    assert compute_rule_metric(read, 0, TF_MONO_RULE, [], [], layer='tf') == 0
    term_rule = {'id': 'c', 'enabled': True, 'terms': [{'id': 't', 'source': 'label_rule', 'rule': TF_MONO_RULE}]}
    assert _cluster_feature_rule_intervals(read, term_rule, region_start=0, peak_regions=[(0, 10)]) == []
    # The nucleosome call keeps its own mark.
    nuc_rule = {**TF_MONO_RULE, 'targetLayers': ['nuc']}
    assert compute_rule_metric(read, 0, nuc_rule, [], [], layer='nuc') == 1


def test_a_mark_without_a_length_still_matches_by_span():
    from services.clustering_features import nuc_size_index, nuc_size_mark_for
    read = {'layers': {'nucsz': {'intervals': [[0, 10]], 'qualities': [[17], [0], [50], [128]]}}}
    assert nuc_size_mark_for(nuc_size_index(read), 0, 10, 20)['coarse'] == 17


def test_graph_tf_piece_of_another_length_gets_no_class():
    from services.graph_panel.reads import _nuc_classes
    read = _filtered_read()
    out = {'nuc': {'iv': [[0, 10, 147]], 'id': [None], 'part': [None]},
           'tf': {'iv': [[0, 10, 20]], 'id': [None], 'part': [None]}}
    _nuc_classes(out, read['layers'], 0, lambda a, b: True)
    assert out['nuc']['cls'] == [18]
    assert 'cls' not in out['tf']
    # A mark of unknown length still lends its class by span.
    layers = {'nucsz': {'intervals': [[0, 10]], 'quality_names': ['coarse', 'named', 'posterior', 'z'],
                        'qualities': [[17], [0], [50], [128]]}}
    out = {'tf': {'iv': [[0, 10, 20]], 'id': [None], 'part': [None]}}
    _nuc_classes(out, layers, 0, lambda a, b: True)
    assert out['tf']['cls'] == [17]


# ── D2-2: the named byte on the graph wire ──────────────────────────────────────────────────────────────────────────

def test_graph_pieces_carry_the_named_byte():
    """Codex D2-2: a mono footprint with nucsz bytes [2, 3, 200, 128] (octasome) carries named 3 on the graph wire."""
    from services.graph_panel import reads as graph_reads
    layers = {'nucsz': {'intervals': [[100, 247, 147], [300, 330, 30]], 'quality_names': ['coarse', 'named', 'posterior', 'z'],
                        'qualities': [[2, 17], [3, 0], [200, 50], [128, 255]]}}
    out = {'nuc': {'iv': [[100, 247, 147]], 'id': [None], 'part': [None]},
           'tf': {'iv': [[300, 330, 30]], 'id': [None], 'part': [None]}}
    graph_reads._nuc_classes(out, layers, 0, lambda a, b: True)
    assert out['nuc']['cls'] == [2] and out['nuc']['zb'] == [128] and out['nuc']['nb'] == [3]
    assert out['tf']['nb'] == [0]
    # Without a named track the pieces carry no named byte (None), never a made-up 0.
    bare = {'nucsz': {'intervals': [[100, 247, 147]], 'qualities': [[2]]}}
    out = {'nuc': {'iv': [[100, 247, 147]], 'id': [None], 'part': [None]}}
    graph_reads._nuc_classes(out, bare, 0, lambda a, b: True)
    assert out['nuc']['cls'] == [2] and out['nuc']['nb'] == [None]
    # Rows cached in the previous wire form (no named byte) are not served again.
    assert graph_reads.WIRE_VERSION >= 10   # (11: a supplementary's primary haplotype, stabilize 3)
