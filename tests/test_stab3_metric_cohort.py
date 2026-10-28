"""Dissolve, Merge similar clusters and the projection rank molecule metric columns against the fit's cohort.

A cluster rule's molecule metric term (nuc.nrl) is each read's percentile rank among a cohort. A fit ranks against
every fitted read; dissolve, auto-cull and the projection must rank the reads of a later, narrower request against
that cohort too (sent by the client, else stored with the clustering), not against each other.

The fit: NRL 170, 180, 190, 200, 202, 204, 206, 208, 210, 215. The view: 170, 180, 190 (cluster 0), 200 (cluster 2)
and 210, 215 (cluster 1). Against the fitted cohort NRL 200 ranks 0.35, nearest cluster 0 (centre 0.15; cluster 1:
0.9). Against the view's own six reads it ranks 7/12, nearest cluster 1 (centres 3/12 and 10/12).
"""
from __future__ import annotations

from types import SimpleNamespace

import numpy as np
import pytest

from models.domain import WorkingSet
from models.requests import (AutoCullRequest, ClusterAllRequest, DissolveClusterRequest, PeakRegion,
                             ProjectionRequest)

METRIC_RULE = {'id': 'm', 'enabled': True,
               'terms': [{'id': 't', 'source': 'molecule_metric', 'moleculeMetric': 'nuc.nrl'}]}
PEAKS = [PeakRegion(start=0, end=100, mode='cluster_rule:m')]
FIT_NRL = [170.0, 180.0, 190.0, 200.0, 202.0, 204.0, 206.0, 208.0, 210.0, 215.0]
VIEW = {'r170': 0, 'r180': 0, 'r190': 0, 'r200': 2, 'r210': 1, 'r215': 1}
COHORT = {'nuc.nrl': {'values': FIT_NRL, 'counts': [1] * len(FIT_NRL)}}


def _metric_read(rid, nrl):
    # A body over the whole peak (0-100), so the read is featured on its metric column.
    return {'id': rid, 'intervals': [[0, 100, 100]], '_fiberbrowser_scalars': {'nuc.nrl': nrl}}


class _State:
    """One dataset whose working set is the fit cohort, or (``narrow``) only the view's reads."""
    dataset_order = ['ds1']

    def __init__(self):
        self.narrow = True
        self.datasets = {'ds1': SimpleNamespace(cluster_assignments={}, cluster_peak_regions=None,
                                                cluster_feature_settings=None)}
        self.max_working_reads = None
        self.peak_regions = []

    def translate_chrom(self, chrom):
        return chrom

    def resolve_dataset_id(self, dataset_id=None):
        return 'ds1' if dataset_id in (None, '', 'primary') else dataset_id

    def get_dataset(self, dataset_id):
        return self.datasets.get(dataset_id)

    def build_working_set(self, dataset_id, chrom, start, end, spanning=False, min_footprints=0, **kwargs):
        reads = [_metric_read(f'r{int(v)}', v) for v in FIT_NRL if not self.narrow or f'r{int(v)}' in VIEW]
        return WorkingSet(reads, total_overlapping=len(reads), total_spanning=len(reads), chrom=chrom, start=start, end=end)


def _call(endpoint, state, req):
    return endpoint(state=state, req=req, chrom='chr1', start=0, end=100, spanning=False)


def _fit(state):
    from services import clustering_endpoint
    state.narrow = False
    fit = _call(clustering_endpoint.run_cluster_all_endpoint, state,
                ClusterAllRequest(dataset_ids=['ds1'], method='kmeans', k=2, peak_regions=PEAKS,
                                  cluster_feature_rules=[METRIC_RULE]))
    state.narrow = True
    return fit


def test_the_hand_computed_ranks_hold():
    from services.clustering_features import metric_percentile_ranks
    view = [170.0, 180.0, 190.0, 200.0, 210.0, 215.0]
    assert metric_percentile_ranks(view, COHORT['nuc.nrl']).tolist() == pytest.approx([0.05, 0.15, 0.25, 0.35, 0.85, 0.95])
    assert metric_percentile_ranks(view).tolist() == pytest.approx([1 / 12, 3 / 12, 5 / 12, 7 / 12, 9 / 12, 11 / 12])


# ── dissolve ────────────────────────────────────────────────────────────────────────────────────────────────────────

def test_dissolve_ranks_against_the_sent_cohort():
    """Dissolving cluster 2 sends NRL 200 to cluster 0, its nearest in the fitted space."""
    from services import clustering_endpoint
    state = _State()
    req = DissolveClusterRequest(cluster_to_dissolve=2, current_assignments={'ds1': dict(VIEW)}, dataset_ids=['ds1'],
                                 peak_regions=PEAKS, cluster_feature_rules=[METRIC_RULE], cluster_metric_cohort=COHORT)
    out = _call(clustering_endpoint.run_dissolve_cluster_endpoint, state, req)
    assert out['results']['ds1']['assignments']['r200'] == 0
    # Without a cohort (and with explicit peaks) the view's reads rank against themselves, as before.
    legacy = _call(clustering_endpoint.run_dissolve_cluster_endpoint, state,
                   req.model_copy(update={'cluster_metric_cohort': None}))
    assert legacy['results']['ds1']['assignments']['r200'] == 1


def test_assigned_feature_rows_use_the_sent_cohort():
    from services import clustering_endpoint
    state = _State()
    req = DissolveClusterRequest(cluster_to_dissolve=2, current_assignments={'ds1': dict(VIEW)}, dataset_ids=['ds1'],
                                 peak_regions=PEAKS, cluster_feature_rules=[METRIC_RULE], cluster_metric_cohort=COHORT)
    _ids, _peaks, _modes, (features, read_ids, _labels), _query = clustering_endpoint.assigned_cluster_feature_rows(
        state=state, req=req, chrom='chr1', start=0, end=100, spanning=False, sample_seed='s',
        assignments_by_dataset={'ds1': dict(VIEW)})
    by_read = {rid: round(float(row[0]), 4) for (_ds, rid), row in zip(read_ids, features)}
    assert by_read == {'r170': 0.05, 'r180': 0.15, 'r190': 0.25, 'r200': 0.35, 'r210': 0.85, 'r215': 0.95}


# ── auto-cull ───────────────────────────────────────────────────────────────────────────────────────────────────────

def _auto_cull_request(**extra):
    # Cluster 2 (1 of 6 reads) is under min_fraction; 1-D centres all have cosine 1, so no similarity merge.
    return AutoCullRequest(current_assignments={'ds1': dict(VIEW)}, dataset_ids=['ds1'], cluster_feature_rules=[METRIC_RULE],
                           min_fraction=0.2, max_cosine_similarity=1.0, **extra)


def test_auto_cull_ranks_against_the_sent_cohort():
    from services import clustering_endpoint
    state = _State()
    out = _call(clustering_endpoint.run_auto_cull_clusters_endpoint, state,
                _auto_cull_request(peak_regions=PEAKS, cluster_metric_cohort=COHORT))
    assert [d['cluster'] for d in out['dissolved']] == [2]
    assert out['results']['ds1']['assignments']['r200'] == 0
    legacy = _call(clustering_endpoint.run_auto_cull_clusters_endpoint, state, _auto_cull_request(peak_regions=PEAKS))
    assert legacy['results']['ds1']['assignments']['r200'] == 1


# ── projection ──────────────────────────────────────────────────────────────────────────────────────────────────────

def _projection(monkeypatch, state, **extra):
    """The projection's feature rows (captured) and its merge preview's labels."""
    from services import clustering_endpoint
    seen = {}

    def fake_projection(features, method='pca', n_components=2, random_state=0):
        seen['features'] = np.asarray(features).copy()
        return np.zeros((features.shape[0], 2), dtype=np.float32), None, 'pca'

    monkeypatch.setattr(clustering_endpoint, 'compute_cluster_projection', fake_projection)
    out = _call(clustering_endpoint.run_cluster_projection_endpoint, state,
                ProjectionRequest(dataset_ids=['ds1'], method='pca', cluster_feature_rules=[METRIC_RULE],
                                  cluster_assignments={'ds1': dict(VIEW)}, simulate_autocull=True, min_fraction=0.2,
                                  max_cosine_similarity=1.0, **extra))
    features = {rid: round(float(row[0]), 4) for rid, row in zip(out['read_ids'], seen['features'])}
    labels_after = dict(zip(out['read_ids'], out['labels_after']))
    return features, labels_after


def test_projection_ranks_against_the_sent_cohort(monkeypatch):
    state = _State()
    features, labels_after = _projection(monkeypatch, state, peak_regions=PEAKS, cluster_metric_cohort=COHORT)
    assert features == {'r170': 0.05, 'r180': 0.15, 'r190': 0.25, 'r200': 0.35, 'r210': 0.85, 'r215': 0.95}
    assert labels_after['r200'] == 0
    features, labels_after = _projection(monkeypatch, state, peak_regions=PEAKS)
    assert features['r200'] == round(7 / 12, 4)
    assert labels_after['r200'] == 1


# ── the stored fallback ─────────────────────────────────────────────────────────────────────────────────────────────

def test_a_fit_stores_its_cohort_and_requests_without_peaks_use_it(monkeypatch):
    """No explicit peaks and no cohort: dissolve, auto-cull and the projection use the stored clustering's peaks,
    rules and fitted cohort."""
    from services import clustering_endpoint
    state = _State()
    fit = _fit(state)
    assert fit['cluster_metric_cohort'] == COHORT
    assert state.datasets['ds1'].cluster_feature_settings['metric_cohort'] == COHORT

    dissolve = _call(clustering_endpoint.run_dissolve_cluster_endpoint, state,
                     DissolveClusterRequest(cluster_to_dissolve=2, current_assignments={'ds1': dict(VIEW)},
                                            dataset_ids=['ds1']))
    assert dissolve['results']['ds1']['assignments']['r200'] == 0
    cull = _call(clustering_endpoint.run_auto_cull_clusters_endpoint, state, _auto_cull_request())
    assert cull['results']['ds1']['assignments']['r200'] == 0
    features, labels_after = _projection(monkeypatch, state)
    assert features['r200'] == 0.35 and labels_after['r200'] == 0

    # A cohort the request sends wins over the stored one.
    view_only = {'nuc.nrl': {'values': [170.0, 180.0, 190.0, 200.0, 210.0, 215.0], 'counts': [1] * 6}}
    sent = _call(clustering_endpoint.run_dissolve_cluster_endpoint, state,
                 DissolveClusterRequest(cluster_to_dissolve=2, current_assignments={'ds1': dict(VIEW)},
                                        dataset_ids=['ds1'], cluster_metric_cohort=view_only))
    assert sent['results']['ds1']['assignments']['r200'] == 1


def test_a_fit_without_metric_columns_stores_no_cohort():
    from services import clustering_endpoint
    state = _State()
    state.narrow = False
    _call(clustering_endpoint.run_cluster_all_endpoint, state,
          ClusterAllRequest(dataset_ids=['ds1'], method='combinatorial', peak_regions=[PeakRegion(start=0, end=100)]))
    assert 'metric_cohort' not in (state.datasets['ds1'].cluster_feature_settings or {})


# ── a fit without a model still returns its cohort ─────────────────────────────────────────────────────────────────

def test_a_fit_without_patterns_or_centroids_returns_its_cohort(monkeypatch):
    """A fit that gives no reassignment model still returns (and stores) the cohort its metric columns ranked
    against, so the client replaces an earlier fit's and merges rank as this fit did."""
    from services import clustering_endpoint
    monkeypatch.setattr(clustering_endpoint, 'compute_cluster_centroids_from_features', lambda *a, **k: ({}, []))
    monkeypatch.setattr(clustering_endpoint, 'compute_cluster_centroids_from_compact', lambda *a, **k: ({}, []))
    state = _State()
    fit = _fit(state)
    assert 'cluster_centroids' not in fit and 'cluster_patterns' not in fit
    assert fit['cluster_metric_cohort'] == COHORT
    assert state.datasets['ds1'].cluster_feature_settings['metric_cohort'] == COHORT


# ── sorts that rebuild the clustering's features ───────────────────────────────────────────────────────────────────

def _spy_features(monkeypatch, module):
    """Record the feature rows ``module``'s extract_features_from_compact returns (by read id)."""
    real = module.extract_features_from_compact
    seen = {}

    def spy(reads, *args, **kwargs):
        out = real(reads, *args, **kwargs)
        X, ids = out[0], out[1]
        seen.update({str(rid).split(':')[-1]: round(float(row[0]), 4) for rid, row in zip(ids, X)})
        return out

    monkeypatch.setattr(module, 'extract_features_from_compact', spy)
    return seen


def test_sort_by_projection_ranks_against_the_sent_cohort(monkeypatch):
    """Sort › By projection orders reads along the Projection tab's map: the same cohort ranks its metric columns."""
    from models.requests import ProjectionSortSettings, SortReadsRequest
    from services import clustering_endpoint
    from services.filtering_endpoint import sort_reads_for_request
    state = _State()
    seen = _spy_features(monkeypatch, clustering_endpoint)
    settings = dict(peak_regions=PEAKS, cluster_feature_rules=[METRIC_RULE], cluster_assignments={'ds1': dict(VIEW)})
    res = sort_reads_for_request(state, SortReadsRequest(
        dataset_ids=['ds1'], sort_by='projection', cluster_assignments={'ds1': dict(VIEW)},
        projection=ProjectionSortSettings(cluster_metric_cohort=COHORT, **settings)), chrom='chr1', start=0, end=100)
    assert sorted(res['results']['ds1']['read_sort_order']) == sorted(VIEW)
    assert seen['r200'] == 0.35
    # None sent (explicit peaks): the view's own reads, as before.
    seen.clear()
    sort_reads_for_request(state, SortReadsRequest(
        dataset_ids=['ds1'], sort_by='projection', cluster_assignments={'ds1': dict(VIEW)},
        projection=ProjectionSortSettings(**settings)), chrom='chr1', start=0, end=100)
    assert seen['r200'] == round(7 / 12, 4)


def test_sort_by_projection_without_settings_uses_the_stored_cohort(monkeypatch):
    from models.requests import SortReadsRequest
    from services import clustering_endpoint
    from services.filtering_endpoint import sort_reads_for_request
    state = _State()
    _fit(state)
    seen = _spy_features(monkeypatch, clustering_endpoint)
    sort_reads_for_request(state, SortReadsRequest(dataset_ids=['ds1'], sort_by='projection',
                                                   cluster_assignments={'ds1': dict(VIEW)}),
                           chrom='chr1', start=0, end=100)
    assert seen['r200'] == 0.35


def test_similarity_sort_uses_the_stored_cohort(monkeypatch):
    """Sort › Similarity rebuilds the stored clustering's features: with its rules, threshold and fitted cohort."""
    from services import read_sorting
    state = _State()
    _fit(state)
    seen = _spy_features(monkeypatch, read_sorting)
    out = read_sorting.sort_similarity_for_dataset(state, 'ds1', 'chr1', 0, 100, False,
                                                   cluster_assignments_override=dict(VIEW))
    assert sorted(out['cluster_order']) == [0, 1, 2]
    assert seen['r200'] == 0.35
