"""Regularity / geometry caches and requests (audit fixes): per-record caches follow the decode configuration, each
request computes with its own parameters and the lanes follow a panel's changes without flip-flopping, cancelled
requests store nothing, response keys are built after the reference, cached responses restore the layer's geometry
numbers, pooling never crosses chromosomes, shared records keep every dataset alias, the hub's shared peak working
sets equal the per-hit states, derived layers never count as footprints, and cluster summaries follow the dataset's
identity. Synthetic Hia5 molecules (tests/nuc_fixtures.py)."""
from __future__ import annotations

from types import SimpleNamespace as NS

import numpy as np
import pytest

pysam = pytest.importorskip('pysam')
pytest.importorskip('fiberhmm.nuc.geometries')
pytest.importorskip('fiberhmm.scan.modules.nuc')

from nuc_fixtures import chromatin_bam

CONTIG, LENGTH = 'chrR', 160_000
SETTINGS = {'calibration': 'self', 'calibration_population': 400}
VIEW = (20_000, 60_000)
OBS = dict(obsId='o1', label='Synthetic', datasetId='ds0', kind='linear', chrom=CONTIG, start=VIEW[0], end=VIEW[1])


@pytest.fixture(scope='module')
def bam(tmp_path_factory):
    return chromatin_bam(tmp_path_factory.mktemp('nuc_caches') / 'chromatin.bam', contig=CONTIG, length=LENGTH)


def _state(bam):
    from models.domain import Dataset
    from state.browser_state import BrowserState
    st = BrowserState(None)
    ds = Dataset('ds0', bam, label='Synthetic')
    ds.available_layers = {'footprint': True}
    st.datasets = {'ds0': ds}
    st.chroms = [NS(name=CONTIG, size=LENGTH)]
    return st


@pytest.fixture(scope='module')
def computed(bam, tmp_path_factory):
    import os
    from services.nuc import jobs, nucgeo
    from services.nuc.regularity import clear_references
    from services.nuc.store import STORE
    old = os.environ.get('FIBERBROWSER_SCAN_CACHE_DIR')
    os.environ['FIBERBROWSER_SCAN_CACHE_DIR'] = str(tmp_path_factory.mktemp('nuc_caches_cache'))
    STORE.clear()
    clear_references()
    nucgeo.clear()
    st = _state(bam)
    job = jobs.submit(st, dict(datasets=['ds0'], chrom=CONTIG, start=VIEW[0], end=VIEW[1], parameters=SETTINGS,
                               workers=2))
    assert jobs.wait(st, job['job_id'], timeout=900)['status'] == 'complete'
    yield st
    STORE.clear()
    clear_references()
    nucgeo.clear()
    if old is None:
        os.environ.pop('FIBERBROWSER_SCAN_CACHE_DIR', None)
    else:
        os.environ['FIBERBROWSER_SCAN_CACHE_DIR'] = old


def _path(st):
    return st.datasets['ds0'].paths[0]


# ---------------------------------------------------------------------------------------------- 3: config identity
def test_config_identity_is_content_not_object_identity(computed):
    import copy
    from services.nuc.jobs import active_config, config_identity
    cfg = active_config(computed, 'ds0')
    twin = copy.copy(cfg)
    assert config_identity(cfg) == config_identity(twin) and config_identity(None) is None
    other = copy.copy(cfg)
    other.settings_hash = 'something-else'
    assert config_identity(other) != config_identity(cfg)


# ---------------------------------------------------------------------------------- 1: caches follow the config
def test_per_record_caches_follow_the_decode_configuration(computed):
    """A re-Analyse with other decode settings swaps the store's molecules: tiles, scores, reach, statistics, grids
    and patches computed from the previous configuration's m6A calls are never served for the new one."""
    from fiberhmm.nuc.regularity import DEFAULT_REGULARITY
    from services.nuc import nucgeo, regularity as R
    from services.nuc.store import STORE
    path = _path(computed)
    config_a = STORE.config_of(path)
    rows = STORE.rows_of(path)
    results = STORE.results_of(path, config_a)
    key = next(k for k in sorted(rows) if k in results and not rows[k].supplementary)
    out = rows[key]
    tiles_a = R.tiles_for_row(path, key[0], key[1], out, DEFAULT_REGULARITY, compute=True)
    assert tiles_a and any(m[4] for m in tiles_a)
    stats_a = R._stats_for(path, [(key, out)], None, acf_budget=0)[key]
    config_b = (config_a[0], 'another-calibration')
    try:
        STORE.configure(path, config_b)
        STORE.put(path, config_b, rows.items())
        mol, res = results[key]
        import copy
        mol_b = copy.copy(mol)
        mol_b.hits = np.zeros_like(mol.hits)          # the new configuration calls no m6A on this molecule
        STORE.put_result(path, key[0], key[1], config_b, mol_b, res)
        assert R.cached_tiles(path, key[0], key[1], R.digest8(DEFAULT_REGULARITY)) is None
        tiles_b = R.tiles_for_row(path, key[0], key[1], out, DEFAULT_REGULARITY, compute=True)
        assert tiles_b is not None and tiles_b != tiles_a
        assert R._stats_for(path, [(key, out)], None, acf_budget=0)[key]['density'] == 0.0 < stats_a['density']
        # the old configuration's entries are still there under their own key (nothing else changed them)
        assert R.cached_tiles(path, key[0], key[1], R.digest8(DEFAULT_REGULARITY), config_a) == tiles_a
        assert all(k[1] in (config_a, config_b) for k in R._TILES)
        assert all(k[1] in (config_a, config_b) for k in nucgeo._GRIDS)
    finally:
        STORE.configure(path, config_a)
        STORE.put(path, config_a, rows.items())
        for k, (m, r) in results.items():
            STORE.put_result(path, k[0], k[1], config_a, m, r)


# -------------------------------------------------------------- 2: explicit parameters, the lane rule, cancellation
def test_each_request_uses_its_own_parameters_and_the_lanes_follow_changes_only(computed):
    """Two panels with different regularity settings: each response is computed with its own; the lanes follow a
    panel that changes its settings and never flip back when the other panel re-asks with unchanged ones."""
    from services.nuc import regularity as R
    path = _path(computed)
    a, b = {'window_bp': 2000}, {'window_bp': 1500}
    ra = R.regularity_analysis(computed, [OBS], params=a, request_scope='panel-a')
    rb = R.regularity_analysis(computed, [OBS], params=b, request_scope='panel-b')
    assert ra['datasets']['ds0']['params']['window_bp'] == 2000 and rb['datasets']['ds0']['params']['window_bp'] == 1500
    lane = R.path_params(path).window_bp
    # re-asks with unchanged settings (pans, re-renders) never take the lanes
    for _ in range(2):
        again_a = R.regularity_analysis(computed, [OBS], params=a, request_scope='panel-a')
        assert again_a['datasets']['ds0']['params']['window_bp'] == 2000
        R.regularity_analysis(computed, [OBS], params=b, request_scope='panel-b')
        assert R.path_params(path).window_bp == lane
    # a change in panel A moves the lanes to A's settings
    R.regularity_analysis(computed, [OBS], params={'window_bp': 2500}, request_scope='panel-a')
    assert R.path_params(path).window_bp == 2500
    R.regularity_analysis(computed, [OBS], params=b, request_scope='panel-b')
    assert R.path_params(path).window_bp == 2500
    # a request without parameters reads the dataset's and writes nothing
    none = R.regularity_analysis(computed, [OBS], request_scope='panel-c')
    assert none['datasets']['ds0']['params']['window_bp'] == 2500 and R.path_params(path).window_bp == 2500
    R.regularity_analysis(computed, [OBS], params={}, request_scope='panel-a')
    assert R.path_params(path).window_bp == 2000


def test_a_cancelled_request_caches_nothing_and_changes_no_parameters(computed):
    from services.nuc import nucgeo, regularity as R
    path = _path(computed)
    before = R.path_params(path).digest()
    n_reg = len(R._RESPONSES)
    calls = []

    def cancel_after(n):
        def checkpoint():
            calls.append(1)
            if len(calls) > n:
                raise InterruptedError('replaced')
        return checkpoint
    with pytest.raises(InterruptedError):
        R.regularity_analysis(computed, [OBS], params={'window_bp': 1750}, request_scope='panel-x',
                              cancel=cancel_after(2))
    assert R.path_params(path).digest() == before and len(R._RESPONSES) == n_reg
    geo_before = nucgeo.path_params(path)
    keys_before = set(nucgeo._RESPONSES)
    calls.clear()
    with pytest.raises(InterruptedError):
        nucgeo.geometry_analysis(computed, [OBS], patch_params={'min_share': 0.01, 'enter': 2.75},
                                 request_scope='panel-x', cancel=cancel_after(3))
    assert set(nucgeo._RESPONSES) == keys_before and nucgeo.path_params(path) == geo_before
    # the same panel asking again with the same settings still moves the lanes (nothing was remembered)
    nucgeo.geometry_analysis(computed, [OBS], patch_params={'min_share': 0.01, 'enter': 2.75}, request_scope='panel-x')
    assert nucgeo.path_params(path)['patch'].enter == 2.75
    nucgeo.geometry_analysis(computed, [OBS], patch_params={'min_share': 0.01}, request_scope='panel-x')


def test_the_routes_cancel_on_a_newer_request_of_the_same_panel(computed, monkeypatch):
    import threading
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routers.nuc import router
    from services.nuc import regularity as R
    from state.dependencies import get_state
    started, release, seen = threading.Event(), threading.Event(), []

    def slow(state, obs, *, cancel, **kw):
        seen.append(kw.get('request_scope'))
        if len(seen) == 1:
            started.set()
            release.wait(10)
        cancel()
        return dict(observations=[], datasets={}, updatedDatasets=[])
    monkeypatch.setattr(R, 'regularity_analysis', slow)
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_state] = lambda: computed
    with TestClient(app) as client:
        out = {}
        t = threading.Thread(target=lambda: out.setdefault('first', client.post(
            '/api/nuc/regularity', json=dict(observations=[OBS], requestScope='p1'))))
        t.start()
        assert started.wait(10)
        second = client.post('/api/nuc/regularity', json=dict(observations=[OBS], requestScope='p1'))
        # an unscoped request (a cluster view) never replaces a panel's request
        other = client.post('/api/nuc/regularity', json=dict(observations=[OBS]))
        release.set()
        t.join(10)
    assert second.status_code == 200 and other.status_code == 200
    assert out['first'].status_code == 409
    assert seen[:2] == ['p1', 'p1']


def _analyse_meanwhile(computed, monkeypatch, *, job_datasets, route='/api/nuc/regularity', scope='p2',
                       extra_datasets=None):
    """POST ``route`` while an Analyse of ``job_datasets`` starts after the request began: (status, stored)."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routers.nuc import router
    from services.nuc import jobs as J, nucgeo as G, regularity as R
    from state.dependencies import get_state
    jobs_now = [dict(created_at=1.0, datasets=[dict(datasetId='ds0')])]
    monkeypatch.setattr(J, 'list_jobs', lambda st: list(jobs_now))
    stored = []

    def analysis(state, obs, *a, cancel=None, checkpoint=None, **kw):
        step = cancel or checkpoint
        step()
        jobs_now.append(dict(created_at=2.0, datasets=[dict(datasetId=d) for d in job_datasets]))  # an Analyse starts
        step()
        stored.append(1)
        return dict(observations=[], datasets={}, updatedDatasets=[], rows=[])
    monkeypatch.setattr(R, 'regularity_analysis', analysis)
    monkeypatch.setattr(G, 'geometry_analysis', analysis)
    saved = dict(computed.datasets)
    computed.datasets.update(extra_datasets or {})
    try:
        app = FastAPI()
        app.include_router(router)
        app.dependency_overrides[get_state] = lambda: computed
        with TestClient(app) as client:
            body = dict(observations=[OBS], window=dict(chrom=CONTIG, start=VIEW[0], end=VIEW[1]))
            if scope is not None:
                body['requestScope'] = scope
            r = client.post(route, json=body)
    finally:
        computed.datasets.clear()
        computed.datasets.update(saved)
    return r, stored


@pytest.mark.parametrize('route', ['/api/nuc/regularity', '/api/nuc/geometries'])
def test_the_routes_stop_when_an_analyse_of_their_datasets_starts_meanwhile(computed, monkeypatch, route):
    """An Analyse of the request's datasets submitted while it runs (new molecules, maybe another
    store configuration) stops it, so its result is never cached under the new store state; the 409 carries the
    detail the client drops silently."""
    from routers.nuc import SUPERSEDED
    r, stored = _analyse_meanwhile(computed, monkeypatch, job_datasets=['ds0'], route=route)
    assert r.status_code == 409 and not stored
    assert r.json()['detail'] == SUPERSEDED


@pytest.mark.parametrize('route', ['/api/nuc/regularity', '/api/nuc/geometries'])
@pytest.mark.parametrize('scope', ['p2', 'cluster:tab:p2', None])
def test_an_analyse_of_other_datasets_never_stops_a_request(computed, monkeypatch, route, scope):
    """An Analyse in another panel, or of another dataset over other files, leaves the request alone (panel, cluster
    view or unscoped)."""
    from models.domain import Dataset
    other = Dataset('ds_other', str(computed.datasets['ds0'].path) + '.other.bam', label='Other')
    r, stored = _analyse_meanwhile(computed, monkeypatch, job_datasets=['ds_other'], route=route, scope=scope,
                                   extra_datasets={'ds_other': other})
    assert r.status_code == 200 and stored == [1]


def test_an_analyse_of_another_dataset_over_the_same_file_stops_a_request(computed, monkeypatch):
    """Two dataset ids over one BAM share the store's file outputs: an Analyse of either stops the other's request."""
    from models.domain import Dataset
    twin = Dataset('ds_twin', computed.datasets['ds0'].path, label='Twin')
    r, stored = _analyse_meanwhile(computed, monkeypatch, job_datasets=['ds_twin'], extra_datasets={'ds_twin': twin})
    assert r.status_code == 409 and not stored


def test_a_cluster_view_request_still_stops_for_an_analyse_of_its_datasets(computed, monkeypatch):
    """Cluster scopes are never cancelled by each other, but an Analyse of their datasets still drops them."""
    r, stored = _analyse_meanwhile(computed, monkeypatch, job_datasets=['ds0'], scope='cluster:tab:p2')
    assert r.status_code == 409 and not stored


# ------------------------------------------------------------------------- 3 + 4: keys and cached layer labels
def test_the_first_geometry_response_is_found_again_after_its_reference(computed):
    """The key is built after the reference: the request right after the one that computed (or reloaded) the
    reference is a cache hit."""
    from services.nuc import nucgeo, regularity as R
    with R._LOCK:
        R._REFERENCES.clear()           # reloaded from the cache directory: the file's revision moves
    with nucgeo._LOCK:
        for cache in (nucgeo._RESPONSES, nucgeo._STATES, getattr(nucgeo, '_LABELS', {})):
            cache.clear()
    first = nucgeo.geometry_analysis(computed, [OBS], patch_params={'min_share': 0.01})
    again = nucgeo.geometry_analysis(computed, [OBS], patch_params={'min_share': 0.01})
    assert not first['cached'] and again['cached']


def test_a_cached_geometry_response_restores_the_layers_geometry_numbers(computed):
    from services.nuc import nucgeo
    from services.nuc.store import STORE
    path = _path(computed)
    rp = nucgeo.real(path)
    loose = {'min_share': 0.01}
    strict = {'min_share': 0.01, 'min_molecules': 100_000}
    first = nucgeo.geometry_analysis(computed, [OBS], patch_params=loose)
    assert first['geometries']
    assert any(v for v in nucgeo._GEO_OF[rp][1].values())
    none = nucgeo.geometry_analysis(computed, [OBS], patch_params=strict)
    assert not none['geometries'] and not any(v for v in nucgeo._GEO_OF[rp][1].values())
    rev, lrev = nucgeo.revision(path), nucgeo.labels_revision(path)
    back = nucgeo.geometry_analysis(computed, [OBS], patch_params=loose)
    assert back['cached'] and back['updatedDatasets'] == ['ds0']
    # the labels move (the lanes' overlay), the rows carrying patches do not (no read reload)
    assert any(v for v in nucgeo._GEO_OF[rp][1].values()) and nucgeo.labels_revision(path) != lrev
    assert nucgeo.revision(path) == rev

    def labelled():
        from services.nuc.layers import injector
        n = 0
        for sha, occ in sorted(STORE.rows_of(path))[:150]:
            inject = injector(path, VIEW[0], VIEW[1], include_layers=True, requested_layers=['nucpatch'],
                              include_qualities=True, include_lift_meta=False)
            row = dict(record_sha256=sha, alignment_occurrence=occ)
            inject(row)
            layer = row['layers'].get('nucpatch')
            if layer:
                n += sum(1 for g in layer['qualities'][3] if g > 0)
        return n
    assert labelled() > 0
    # another panel opening with other patch parameters: its first request takes the lanes (they show what its
    # controls show; regularity.adopt_lane) ...
    nucgeo.geometry_analysis(computed, [OBS], patch_params={'min_share': 0.01, 'enter': 3.0}, request_scope='other')
    assert nucgeo.path_params(path)['patch'].enter == 3.0
    n_other = labelled()
    # ... and the first panel re-asking with unchanged parameters neither takes them back nor relabels the layer
    nucgeo.geometry_analysis(computed, [OBS], patch_params=loose)
    assert nucgeo.path_params(path)['patch'].enter == 3.0 and labelled() == n_other


# ---------------------------------------------------------------------------------------------- 5: pooling parts
def _lay(uid, ds, spans, lo=0, hi=20_000):
    from fiberhmm.nuc.geometries import MoleculeLayout, RefPatch
    tiles = np.arange(lo, hi, 250, dtype=np.int64)
    st = np.zeros(len(tiles), dtype=np.int8)
    for a, b in spans:
        st[(tiles >= a) & (tiles + 2000 <= b + 2000) & (tiles < b)] = 1
    return MoleculeLayout(uid, ds, [RefPatch(a, b, False, False, 3.0, 190) for a, b in spans], tiles, tiles + 2000,
                          st, 10.0)


def test_pooling_never_merges_chromosomes_or_frames():
    from fiberhmm.nuc.geometries import CARRIES, NOT_SPANNED, GeometryParams
    from services.nuc.nucgeo import pooled_geometries
    gp = GeometryParams(min_molecules=2, min_share=0.0)
    lays = [_lay(f'a{i}', 'A', [(5000, 9000)]) for i in range(3)] + [_lay(f'b{i}', 'B', [(5000, 9000)]) for i in range(3)]
    parts = [('chr1', None)] * 3 + [('chr2', None)] * 3
    G, states, gpart = pooled_geometries(lays, parts, gp, ('high',))
    assert len(G) == 2 and gpart == [('chr1', None), ('chr2', None)]
    assert [g.geometry_id.split('_')[0] for g in G] == ['G1', 'G2'] and G[0].geometry_id != G[1].geometry_id
    assert sorted(i for i, _k in G[0].members) == [0, 1, 2] and sorted(i for i, _k in G[1].members) == [3, 4, 5]
    for i in range(3):
        assert states[i][G[0].geometry_id] == CARRIES and states[i][G[1].geometry_id] == NOT_SPANNED
        assert states[i + 3][G[1].geometry_id] == CARRIES and states[i + 3][G[0].geometry_id] == NOT_SPANNED
    # the same contig name in another reference frame (a lift map) is another part
    G2, _s, gpart2 = pooled_geometries(lays, [('chr1', None)] * 3 + [('chr1', 'map')] * 3, gp, ('high',))
    assert len(G2) == 2 and G2[0].geometry_id != G2[1].geometry_id and gpart2[1] == ('chr1', 'map')
    # one part: FiberHMM's own grouping, unchanged
    G3, _s, _p = pooled_geometries(lays, [('chr1', None)] * 6, gp, ('high',))
    assert len(G3) == 1 and G3[0].n_molecules == 6


# ------------------------------------------------------------------------------------- 6: shared-record aliases
def test_a_record_shared_by_two_datasets_gets_states_for_both(computed):
    from models.domain import Dataset
    from services.feature_states import feature_states  # noqa: F401 - the hub path reads _STATES
    from services.nuc import nucgeo
    ds1 = Dataset('ds1', _path(computed), label='Synthetic twin')
    ds1.available_layers = {'footprint': True}
    computed.datasets['ds1'] = ds1
    computed.nuc_active['ds1'] = computed.nuc_active['ds0']
    try:
        obs = [OBS, dict(OBS, obsId='o2', datasetId='ds1')]
        keys = []
        res = nucgeo.geometry_analysis(computed, obs, patch_params={'min_share': 0.01}, _key_out=keys)
        g = max(res['geometries'], key=lambda r: r['molecules'])
        po = g['perObservation']
        assert po['o1']['full'] == po['o2']['full'] > 0
        states = nucgeo._STATES[keys[0]][g['geometryId']]
        by_ds = {d: {k for (dd, k), v in states.items() if dd == d and v == '1'} for d in ('ds0', 'ds1')}
        assert by_ds['ds0'] and by_ds['ds0'] == by_ds['ds1'] and len(by_ds['ds1']) == po['o2']['full']
        assert set(res['assignments']) == {'ds0', 'ds1'}
        assert res['assignments']['ds0']['carried'] == res['assignments']['ds1']['carried']
    finally:
        computed.datasets.pop('ds1', None)
        computed.nuc_active.pop('ds1', None)


# ----------------------------------------------------------------------- 7: shared peak working sets = per hit
def test_shared_peak_working_sets_equal_the_per_hit_states_exactly():
    """Every state, '.' included: a read with one covering record and one partial record near the hit is '.' on
    both routes; a record overlapping the padded window without covering the hit is listed as '.'."""
    from services.hub.provider_states import browser_feature_states, shared_windows
    # (row id, read key, start, end, MSPs): rows 'c1'/'c2' are two records of one read (a supplementary breakpoint
    # within the padding of the peak at 1590)
    raw = [('r0', 'r0', 0, 3000, [(100, 400), (1500, 1700)]), ('c1', 'chim', 900, 3000, [(1580, 1650)]),
           ('c2', 'chim', 1520, 1600, [(1530, 1560)]), ('r3', 'r3', 1400, 1560, [(1450, 1500)]),
           ('r4', 'r4', 2000, 2500, [(2100, 2150)])]

    def build(ds, chrom, lo, hi, **kw):
        reads = []
        for rid, key, a, b, m in raw:
            if a < hi and b > lo:
                ivs = [[max(0, s - lo), min(hi - lo, e - lo)] for s, e in m if e > lo and s < hi]
                reads.append(dict(id=rid, analysis_id=key, reference_start=a, reference_end=b,
                                  layers={'msp': {'intervals': ivs}} if ivs else {}))
        return NS(reads=reads)
    state = NS(datasets={'sample': NS(data_type='bam')}, build_working_set=build, max_working_reads=0)
    hits = [dict(setId='browser:peaks:p', hitId=f'p{a}', chrom='chrT', start=a, end=a + 60, anchor=a + 30,
                 datasets=['sample'], stateSpec={'kind': 'open'}) for a in (300, 1590, 2100)]

    def states():
        return [browser_feature_states(state, h['setId'], dict(id=h['hitId'], hub_hit=h))[0] for h in hits]
    alone = states()
    with shared_windows(state, hits):
        shared = states()
    assert shared == alone
    assert alone[1][('sample', 'chim')] == '.' and alone[1][('sample', 'r0')] == '1'
    assert alone[1][('sample', 'r3')] == '.'


# ------------------------------------------------------------------------------- 8: derived layers aren't footprints
def test_derived_layers_never_count_as_footprints():
    from services.read_metrics import _rule_interval_entries, get_layer_intervals
    fp = [[100, 250, 150], [400, 450, 50]]
    derived = {name: {'intervals': [[0, 3000, 3000]], 'qualities': [[1]], 'quality_names': ['q']}
               for name in ('nucreg', 'nucpatch', 'fpcls', 'nfrvar', 'deam_opportunity', 'msp')}
    read = dict(layers={'nuc': {'intervals': fp}, **derived})
    assert sorted(get_layer_intervals(read, 'all_fp')) == sorted(fp)
    assert sorted([s, e, l] for s, e, l, *_ in _rule_interval_entries(read, 'all_fp', True)) == sorted(fp)


# --------------------------------------------------------------------------- 9: cluster summaries follow the data
def test_cluster_molecule_summaries_follow_the_datasets_identity(computed, monkeypatch):
    from services import cluster_molecules as CM
    from services.dataset_generation import bump_dataset_generation
    built = []

    class Query:
        @classmethod
        def from_request(cls, state, **kw):
            return cls()

        def build_working_set(self, state, dataset_id, read_ids=None):
            built.append(dataset_id)
            return NS(reads=[dict(id=r, reference_start=0, reference_end=1000) for r in read_ids])
    monkeypatch.setattr(CM, 'AnalysisReadQuery', Query)
    monkeypatch.setattr(CM, 'cohort_read_id', lambda r: r['id'])
    monkeypatch.setattr(CM, 'read_matches_id_filter', lambda r, wanted: r['id'] in wanted)
    monkeypatch.setattr(computed, 'translate_chrom', lambda c: c, raising=False)
    monkeypatch.setattr('services.lift.capability.require_for_ids', lambda *a, **k: None)
    CM.clear_cache()
    kw = dict(chrom=CONTIG, start=VIEW[0], end=VIEW[1], spanning=False, dataset_ids=['ds0'],
              cluster_assignments={'ds0': {'m1': 0, 'm2': 1}})
    CM.cluster_molecules(computed, **kw)
    CM.cluster_molecules(computed, **kw)
    assert len(built) == 1
    bump_dataset_generation(computed, 'ds0')           # a reload: the old summaries are never served
    CM.cluster_molecules(computed, **kw)
    assert len(built) == 2
    old = list(getattr(computed, 'quality_filters', None) or [])
    computed.quality_filters = [dict(layer='nuc', quality_name='q', min_value=1)]
    try:
        CM.cluster_molecules(computed, **kw)
        assert len(built) == 3
    finally:
        computed.quality_filters = old
    CM.clear_cache()


# ------------------------------------------------------------------------- the "not analysed" answer is quick
def datasets_to_analyse(observations):
    """The frontend's ``datasetsToAnalyse`` (features/nucleosomes/firstOpen.ts): nothing scored, records not
    computed."""
    by = {}
    for o in observations:
        if not o.get('error'):
            by.setdefault(o['datasetId'], []).append(o)
    return [d for d, obs in by.items() if all((o.get('scored') or 0) == 0 for o in obs)
            and any((o.get('notComputed') or 0) > 0 for o in obs)]


def test_an_unanalysed_view_answers_without_reading_its_records(computed, monkeypatch):
    """Regularity and geometries at a view nothing was computed over answer from the store and the BAM index
    (Auto-Analyse and the "Analyse this view" button wait on it); an analysed view still resolves its records."""
    from services.nuc import nucgeo, observations, regularity as R
    calls = []
    original = observations.resolve
    monkeypatch.setattr(observations, 'resolve', lambda *a, **k: calls.append(1) or original(*a, **k))
    far = dict(OBS, obsId='far', start=100_000, end=140_000)
    res = R.regularity_analysis(computed, [far])
    o = res['observations'][0]
    assert not calls and o['notComputed'] > 0 and o['scored'] == 0 and o['records'] == o['notComputed']
    assert datasets_to_analyse(res['observations']) == ['ds0']
    geo = nucgeo.geometry_analysis(computed, [far], patch_params={'min_share': 0.01})
    assert not calls and geo['nMolecules'] == 0
    # the analysed view (and one overlapping it) reads its records as before
    R.regularity_analysis(computed, [dict(OBS, obsId='near', start=VIEW[1] - 5000, end=VIEW[1] + 5000)])
    assert calls


# ------------------------------------------------------------------- lifted views: projected into the target view
def _piece(strand, q0=0, q1=LENGTH, t0=1_000_000, source=CONTIG):
    return NS(primary=True, source=source, hap='h1', q_start=q0, q_end=q1, t_start=t0, t_end=t0 + (q1 - q0),
              strand=strand)


def test_record_frames_map_source_intervals_into_the_target_view():
    from services.nuc.frames import ViewFrame
    fwd = ViewFrame([_piece('+')]).record(CONTIG, 100, 900)
    assert fwd.interval(100, 900) == (1_000_100, 1_000_900) and not fwd.reverse
    rev = ViewFrame([_piece('-')]).record(CONTIG, 100, 900)
    assert rev.interval(100, 900) == (1_000_000 + LENGTH - 900, 1_000_000 + LENGTH - 100) and rev.reverse
    # a record whose pieces mix orientations has no single frame; one on no piece has none
    mixed = ViewFrame([_piece('+', 0, 500), _piece('-', 500, 1000, t0=2_000_000)])
    assert mixed.record(CONTIG, 100, 900) is None and mixed.record('other', 0, 10) is None


@pytest.mark.parametrize('strand', ['+', '-'])
def test_lifted_geometries_and_regularity_are_drawn_in_the_target_view(computed, monkeypatch, strand):
    """A lifted linear observation: the same molecules give the same geometries, moved (and on a reversed lift
    mirrored) into the target view, and the regularity track runs along the target window."""
    from services.nuc import frames, nucgeo, regularity as R
    native = nucgeo.geometry_analysis(computed, [OBS], patch_params={'min_share': 0.01, 'fold': 'none'})
    t0 = 1_000_000
    view = (t0 + VIEW[0], t0 + VIEW[1]) if strand == '+' else (t0 + LENGTH - VIEW[1], t0 + LENGTH - VIEW[0])
    monkeypatch.setattr(frames, 'view_frame', lambda st, src, obs: (('chrT',) + view, frames.ViewFrame([_piece(strand)])))
    # (the dataset's lift identity is part of the response keys; this fake frame leaves it unchanged)
    with nucgeo._LOCK:
        nucgeo._RESPONSES.clear()
    with R._LOCK:
        R._RESPONSES.clear()
    lifted = nucgeo.geometry_analysis(computed, [OBS], patch_params={'min_share': 0.01, 'fold': 'none'})
    assert lifted['window'] == dict(chrom='chrT', start=view[0], end=view[1])
    assert lifted['nMolecules'] == native['nMolecules'] and lifted['nPatches'] == native['nPatches']
    move = (lambda a, b: (t0 + a, t0 + b)) if strand == '+' else (lambda a, b: (t0 + LENGTH - b, t0 + LENGTH - a))
    assert sorted((g['start'], g['end'], g['molecules']) for g in lifted['geometries']) == \
        sorted(move(g['start'], g['end']) + (g['molecules'],) for g in native['geometries'])
    reg = R.regularity_analysis(computed, [OBS])['observations'][0]
    assert reg['window'] == dict(chrom='chrT', start=view[0], end=view[1])
    assert reg['track']['edges'][0] == view[0] and any(v is not None for v in reg['track']['mean'])
    with nucgeo._LOCK:
        nucgeo._RESPONSES.clear()
    with R._LOCK:
        R._RESPONSES.clear()


def test_assignments_merge_a_reads_records_and_key_lifted_reads_by_record():
    from fiberhmm.nuc.geometries import CARRIES, NOT_SPANNED, PARTIAL
    from services.nuc import nucgeo
    G = [NS(geometry_id='G1_a', kind='high', parent=None), NS(geometry_id='G2_b', kind='high', parent=None)]
    metas = [dict(ds='d', qname='q1', aliases=[dict(ds='d', qname='q1')]),
             dict(ds='d', qname='q1', aliases=[dict(ds='d', qname='q1')]),      # a second record of q1
             dict(ds='d', qname='q2', aliases=[dict(ds='d', qname='q2')])]
    states = [{'G1_a': CARRIES, 'G2_b': NOT_SPANNED}, {'G1_a': NOT_SPANNED, 'G2_b': PARTIAL},
              {'G1_a': NOT_SPANNED, 'G2_b': NOT_SPANNED}]
    a = nucgeo._assignments(G, metas, states, CARRIES, PARTIAL)['d']
    assert a['group'] == {'q1': 1, 'q2': 0} and a['carried'] == {'q1': [1], 'q2': []} and a['partial']['q1'] == [2]
    # live-lift datasets: the record keys their rows' analysis_id name
    keys = [[('d', 'rec-1')], [('d', 'rec-2')], [('d', 'rec-3')]]
    b = nucgeo._assignments(G, metas, states, CARRIES, PARTIAL, keys)['d']
    assert set(b['group']) == {'rec-1', 'rec-2', 'rec-3'} and b['group']['rec-1'] == 1


def test_nucpatch_is_a_nucleosome_group_everywhere_the_others_are():
    """Stale-group dropping, the live-over-scan rule, scan layer metadata and the envelope rule cover nucpatch."""
    from services.bam_tags import NUC_ENVELOPE_GROUPS
    from services.nuc.scalars import NUC_MA_GROUPS
    from services.scan.overlay import LAYER_META, NUC_GROUPS
    assert 'nucpatch' in NUC_MA_GROUPS and 'nucpatch' in NUC_GROUPS and 'nucpatch' in NUC_ENVELOPE_GROUPS
    assert LAYER_META['nucpatch'][2] == 'nuc'


def test_peak_open_routes_load_the_same_layers_and_shared_windows_step_aside():
    """Both peak-open routes ask the loader for the MSP layer only (it keeps or drops reads by the layers asked
    for); quality filters (applied per window) and circular contigs turn shared windows off."""
    from services.hub.provider_states import OPEN_LAYERS, _SHARED, browser_feature_states, shared_windows
    asked = []

    def build(ds, chrom, lo, hi, **kw):
        asked.append(kw.get('requested_layers'))
        return NS(reads=[])
    hit = dict(setId='browser:peaks:p', hitId='p1', chrom='chrT', start=1000, end=1060, anchor=1030,
               datasets=['sample'], stateSpec={'kind': 'open'})
    state = NS(datasets={'sample': NS(data_type='bam')}, build_working_set=build, max_working_reads=0)
    browser_feature_states(state, hit['setId'], dict(id='p1', hub_hit=hit))
    with shared_windows(state, [hit]):
        browser_feature_states(state, hit['setId'], dict(id='p1', hub_hit=hit))
    assert asked == [OPEN_LAYERS, OPEN_LAYERS]
    state.quality_filters = [dict(layer='msp', quality_name='aq', min_value=200)]
    with shared_windows(state, [hit]):
        assert _SHARED.get() is None
    state.quality_filters = []
    state.circular_chroms = {'chrT': {'length': 5000}}
    with shared_windows(state, [hit]):
        assert not (_SHARED.get() or {}).get('windows')


def test_cluster_molecule_summaries_read_m6a_and_fire_correctly():
    from services.cluster_molecules import _call_layers, layer_state_at, summarize_read
    base = dict(reference_start=0, reference_end=1000)
    # an m6A dataset: a fibre with no m6A call in view has 0 per kb, not no value
    assert summarize_read(dict(base), 0, 1000, has_m6a=True)['m6a_per_kb'] == 0.0
    # 5mC / deamination positions the loader put in `methyl` are never m6A
    cpg = dict(base, methyl=[10, 20], methyl_m5c=[10, 20])
    assert summarize_read(cpg, 0, 1000)['m6a'] is None
    assert summarize_read(dict(base, methyl=[10, 20]), 0, 1000)['m6a'] == 2      # legacy m6A-only field
    # FIRE elements are the accessibility share on a dataset without an MSP layer
    fire_only = NS(available_layers={'footprint': True, 'fire': True, 'msp': False})
    both = NS(available_layers={'footprint': True, 'fire': True, 'msp': True})
    assert 'fire' in _call_layers(fire_only) and 'fire' not in _call_layers(both)
    row = dict(base, layers={'fire': {'intervals': [[100, 300, 200]]}})
    assert summarize_read(row, 0, 1000)['frac']['fire'] == 0.2
    assert layer_state_at(row, 0, 150) == 'fire'


def test_a_multi_file_datasets_view_records_never_come_from_one_file(tmp_path):
    """Two BAMs in one dataset: a view extending a remembered one still reads both files."""
    from nuc_fixtures import chromatin_bam
    from services.nuc import live
    from services.nuc.inputs import NucSource
    a = chromatin_bam(tmp_path / 'a.bam', contig=CONTIG, length=60_000, seed=3)
    b = chromatin_bam(tmp_path / 'b.bam', contig=CONTIG, length=60_000, seed=4)
    src = NucSource('ds', 'two files', 'native', (a, b), ('a', 'b'), None)
    policy = {'filters': {}}
    with live._view_lock:
        live._views.clear()
    live.view_records(src, [(CONTIG, 10_000, 20_000)], policy)
    wide = live.view_records(src, [(CONTIG, 10_000, 30_000)], policy)
    with live._view_lock:
        live._views.clear()
    fresh = live.view_records(src, [(CONTIG, 10_000, 30_000)], policy)
    assert {(r.path, r.sha, r.occ) for r in wide} == {(r.path, r.sha, r.occ) for r in fresh}
    assert {r.path for r in wide} == {a, b}


def test_a_replay_at_a_view_never_analysed_analyses_it_with_the_datasets_settings(computed):
    """The hub's geometry replay at a view outside the analysed one (an analysis elsewhere exists) runs the
    Analyse for that view first, with the dataset's own settings, instead of failing as 'not in this analysis'."""
    from services.nuc import jobs as J, nucgeo
    far = dict(OBS, obsId='replay', start=100_000, end=140_000)
    request = dict(observations=[far], patches={'min_share': 0.01}, spanning=False, include_duplicates=False,
                   site_state='nfr', show='patch')
    before = J.active_config(computed, 'ds0').settings_hash
    n = len(J.list_jobs(computed))
    nucgeo._ensure_analysed(computed, request)
    new = J.list_jobs(computed)[n:]
    assert len(new) == 1 and new[0]['status'] == 'complete'
    assert J.active_config(computed, 'ds0').settings_hash == before
    res = nucgeo.geometry_analysis(computed, [far], patch_params={'min_share': 0.01})
    assert res['nMolecules'] > 0
    nucgeo._ensure_analysed(computed, request)          # analysed now: no new job
    assert len(J.list_jobs(computed)) == n + 1


def test_a_wildcard_quality_filter_keeps_the_regularity_lanes():
    from services.working_sets import layer_key_for_quality_filters
    wildcard = [dict(layer='*', quality_name='nq', min_value=100)]
    assert layer_key_for_quality_filters(('nuc', 'nucpatch', 'nucreg'), wildcard) == ('nuc', 'nucpatch', 'nucreg')
    assert layer_key_for_quality_filters(('nuc', 'tf'), wildcard) is None          # as before
    assert layer_key_for_quality_filters(None, wildcard) is None


def test_a_grid_built_from_byte_scores_is_rebuilt_once_exact_scores_exist(computed):
    """Patches are called on the exact float track whenever the browser has it; a grid built from the tiles' byte
    scores (the exact ones evicted or not computed yet) never stands in for it, and the two never share patches."""
    from fiberhmm.nuc.regularity import DEFAULT_REGULARITY
    from services.nuc import nucgeo, regularity as R
    from services.nuc.store import STORE
    path = _path(computed)
    rows = STORE.rows_of(path)
    config = STORE.config_of(path)
    key = next(k for k in sorted(rows) if not rows[k].supplementary and STORE.get_result(path, k[0], k[1], config))
    d8 = R.digest8(DEFAULT_REGULARITY)
    R.tiles_for_row(path, key[0], key[1], rows[key], DEFAULT_REGULARITY, compute=True)
    exact = R.cached_scores(path, key[0], key[1], d8)
    with R._LOCK:
        R._SCORES.pop((nucgeo.real(path), config, key[0], key[1], d8), None)
    with nucgeo._LOCK:
        nucgeo._GRIDS.pop((nucgeo.real(path), config, key[0], key[1], d8), None)
    byte = nucgeo.grids(path, None, rows, [key], DEFAULT_REGULARITY)[key]
    assert not byte['exact']
    R._put_scores(path, [(key, exact)], d8)
    again = nucgeo.grids(path, None, rows, [key], DEFAULT_REGULARITY)[key]
    assert again['exact'] and again is not byte


def test_patch_and_geometry_settings_never_enter_the_nuc_settings_nor_the_live_scan_adapter(monkeypatch):
    from services.nuc import scan as live_scan
    from services.nuc.engine import resolve_settings
    _s0, h0 = resolve_settings({})
    s1, h1 = resolve_settings({'nucpatch': {'enter': 3.0}, 'nucgeo': {'tol_bp': 300}})
    assert h0 == h1 and 'nucpatch' not in s1 and 'nucgeo' not in s1
    st = NS(datasets={})
    plan = dict(scope='view', raw_read_policy={}, datasets=[])
    module = dict(name='nuc', settings={'calibration_scope': 'data'}, settings_hash='h', version='2.4')
    assert live_scan.live_registry(st, plan, module) is not None          # (no dataset to refuse it)
    module['settings']['nucpatch'] = {'enter': 2.0}
    assert live_scan.live_registry(st, plan, module) is None


def test_hub_input_loops_stop_when_the_run_is_cancelled(monkeypatch):
    from services.hub import assoc, assoc_inputs
    calls = []

    def cancelled():
        calls.append(1)
        raise assoc.Cancelled()
    monkeypatch.setattr(assoc, 'check_cancel', cancelled)
    table = NS(hits=[dict(hitId='h1', chrom='chrT', start=10, end=20)], has_states=False, bump=lambda *a: None,
               notes=[])
    with pytest.raises(assoc.Cancelled):
        assoc_inputs.sv_states(NS(datasets={}), table, NS(), ['ds'])
    assert calls
