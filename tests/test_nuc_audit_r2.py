"""Round-2 audit regressions (backend): hub replays and cluster views compute with their own settings and never move
or relabel the lanes, lane adoption installs one panel's regularity and patch settings together, the patch-generation
identity (``pg``) on rows and labels follows the decode configuration, an empty answer clears a file's labels, cut
windows are read against their own width everywhere downstream, pooled geometries do not depend on observation order,
spanning is measured per contig, shared records count for every dataset, molecule aliases get states, the reference
bookkeeping is ordered, bounded, cancellable and backs off after failures, populations and full-window tracks are
bounded by bytes, not-analysed counts respect the read filters, the full-decode decision comes before any decode,
and helper processes never outlive their parent. Synthetic Hia5 molecules (tests/nuc_fixtures.py)."""
from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
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
LOOSE = {'min_share': 0.01}


@pytest.fixture(scope='module')
def computed(tmp_path_factory):
    from models.domain import Dataset
    from state.browser_state import BrowserState
    from services.nuc import jobs, nucgeo
    from services.nuc.regularity import clear_references
    from services.nuc.store import STORE
    bam = chromatin_bam(tmp_path_factory.mktemp('nuc_r2') / 'chromatin.bam', contig=CONTIG, length=LENGTH)
    old = os.environ.get('FIBERBROWSER_SCAN_CACHE_DIR')
    os.environ['FIBERBROWSER_SCAN_CACHE_DIR'] = str(tmp_path_factory.mktemp('nuc_r2_cache'))
    STORE.clear(); clear_references(); nucgeo.clear()
    st = BrowserState(None)
    ds = Dataset('ds0', bam, label='Synthetic')
    ds.available_layers = {'footprint': True}
    st.datasets = {'ds0': ds}
    st.chroms = [NS(name=CONTIG, size=LENGTH)]
    job = jobs.submit(st, dict(datasets=['ds0'], chrom=CONTIG, start=VIEW[0], end=VIEW[1], parameters=SETTINGS,
                               workers=2))
    assert jobs.wait(st, job['job_id'], timeout=900)['status'] == 'complete'
    yield st
    STORE.clear(); clear_references(); nucgeo.clear()
    if old is None:
        os.environ.pop('FIBERBROWSER_SCAN_CACHE_DIR', None)
    else:
        os.environ['FIBERBROWSER_SCAN_CACHE_DIR'] = old


def _path(st):
    return st.datasets['ds0'].paths[0]


def _patch_rows(path, n=150):
    from services.nuc.layers import injector
    from services.nuc.store import STORE
    out = []
    for sha, occ in sorted(STORE.rows_of(path))[:n]:
        inject = injector(path, VIEW[0], VIEW[1], include_layers=True, requested_layers=['nucpatch', 'nucreg'],
                          include_qualities=True, include_lift_meta=False)
        row = dict(record_sha256=sha, alignment_occurrence=occ)
        inject(row)
        out.append(row)
    return out


# ------------------------------------------------------------------------------------- lanes: cluster views
def test_a_cluster_views_requests_never_move_or_relabel_the_lanes(computed):
    from services.nuc import nucgeo, regularity as R
    path = _path(computed)
    nucgeo.geometry_analysis(computed, [OBS], patch_params=LOOSE, reg_params={}, request_scope='panel-a')
    lane_reg, lane_patch = R.path_params(path).digest(), nucgeo.path_params(path)
    labels = nucgeo.labels_revision(path)
    assert labels
    # the cluster view (other cohort, other settings): its own answers, the lanes untouched
    other = {'min_share': 0.01, 'enter': 2.5, 'extend': 1.5}
    res = nucgeo.geometry_analysis(computed, [OBS], patch_params=other, reg_params={'ends': 'extend'},
                                   request_scope='cluster:panel-a')
    assert res['params']['patch']['enter'] == 2.5 and res['updatedDatasets'] == []
    reg = R.regularity_analysis(computed, [OBS], params={'ends': 'extend'}, request_scope='cluster:panel-a')
    assert reg['datasets']['ds0']['params']['ends'] == 'extend'
    assert R.path_params(path).digest() == lane_reg and nucgeo.path_params(path) == lane_patch
    assert nucgeo.labels_revision(path) == labels
    # adopt=False (a request's own flag) behaves the same
    nucgeo.geometry_analysis(computed, [OBS], patch_params=other, reg_params={}, request_scope='panel-b', adopt=False)
    assert nucgeo.path_params(path) == lane_patch and nucgeo.labels_revision(path) == labels


# ------------------------------------------------------------------------------------ lanes: one coherent tuple
def test_lane_adoption_installs_one_panels_regularity_and_patches_together(computed):
    """Codex's sequence: A blank/enter 2; B takes the lanes with extend/enter 3; A changes only enter to 4: the lanes
    show A's blank/enter 4, never extend/enter 4."""
    from services.nuc import nucgeo, regularity as R
    path = _path(computed)

    def ask(scope, ends, enter):
        R.regularity_analysis(computed, [OBS], params={'ends': ends}, request_scope=scope)
        nucgeo.geometry_analysis(computed, [OBS], patch_params={'min_share': 0.01, 'enter': enter},
                                 reg_params={'ends': ends}, request_scope=scope)
    ask('tuple-a', 'blank', 2.0)
    ask('tuple-b', 'extend', 3.0)
    assert (R.path_params(path).ends, nucgeo.path_params(path)['patch'].enter) == ('extend', 3.0)
    ask('tuple-a', 'blank', 4.0)
    assert (R.path_params(path).ends, nucgeo.path_params(path)['patch'].enter) == ('blank', 4.0)
    # A's Regularity-view request moving only its regularity brings A's own patch settings along
    ask('tuple-b', 'extend', 3.0)          # unchanged re-ask: no move
    assert (R.path_params(path).ends, nucgeo.path_params(path)['patch'].enter) == ('blank', 4.0)
    R.regularity_analysis(computed, [OBS], params={'ends': 'truncated'}, request_scope='tuple-b')
    assert (R.path_params(path).ends, nucgeo.path_params(path)['patch'].enter) == ('truncated', 3.0)
    nucgeo.geometry_analysis(computed, [OBS], patch_params=LOOSE, reg_params={}, request_scope='tuple-a')


# ----------------------------------------------------------------------------------------- pg and labels
def test_labels_and_rows_carry_the_patch_generation_of_their_decode_configuration(computed, monkeypatch):
    from services.nuc import nucgeo
    from services.nuc.store import STORE
    path = _path(computed)
    nucgeo.geometry_analysis(computed, [OBS], patch_params=LOOSE, reg_params={}, request_scope='pg-panel')
    pg = nucgeo.lane_generation(path)
    rows = [r for r in _patch_rows(path) if r['layers'].get('nucpatch')]
    assert rows and {r['layers']['nucpatch']['pg'] for r in rows} == {pg}
    labels = nucgeo.patch_labels(computed, ['ds0'])['ds0']
    assert labels['pg'] == {nucgeo.file_tag(path): pg} and labels['labels']
    assert nucgeo.labels_revision(path)
    # another decode configuration of the file (a re-Analyse with other settings): the labels are not current
    cfg = STORE.config_of(path)
    monkeypatch.setattr(STORE, 'config_of', lambda p, _c=cfg: ('other-settings', 'other-calibration'))
    assert nucgeo.lane_generation(path) != pg
    assert nucgeo.labels_revision(path) == '' and not nucgeo._labels_current(nucgeo.real(path), pg)
    assert nucgeo.patch_labels(computed, ['ds0'])['ds0']['labels'] == {}


def test_an_answer_without_molecules_for_a_file_clears_its_labels(computed):
    from services.nuc import nucgeo
    path = _path(computed)
    nucgeo.geometry_analysis(computed, [OBS], patch_params=LOOSE, reg_params={}, request_scope='empty-panel')
    assert any(v for v in nucgeo._GEO_OF[nucgeo.real(path)][1].values())
    # the same settings, every molecule filtered out (no molecule spans the whole contig)
    wide = dict(OBS, start=0, end=LENGTH)
    res = nucgeo.geometry_analysis(computed, [wide], patch_params=LOOSE, reg_params={}, cohort='spanning',
                                   request_scope='empty-panel')
    assert res['nMolecules'] == 0
    assert not any(v for v in nucgeo._GEO_OF[nucgeo.real(path)][1].values())
    nucgeo.geometry_analysis(computed, [OBS], patch_params=LOOSE, reg_params={}, request_scope='empty-panel')


# ------------------------------------------------------------------------------- cut windows: their own width
def test_cut_windows_are_read_against_their_width_downstream(computed):
    from fiberhmm.nuc.regularity import tile_reference
    from services.nuc import nucgeo, reference as REF, regularity as R
    path = _path(computed)
    trunc = {'ends': 'truncated'}
    reg = R.regularity_analysis(computed, [OBS], params=trunc, request_scope='trunc-panel')
    ref = reg['datasets']['ds0']['reference']
    assert ref['width_deltas'] and ref.get('width_centres')
    # the summary's excess: per tile against its width (not the score median less the full-width median)
    params = R.parse_params(trunc)
    excess, raw = [], []
    from services.nuc.observations import observation_cohort
    from services.nuc.inputs import browser_read_policy
    _s, _r, _w, cfg, cohort, _c = observation_cohort(computed, OBS, browser_read_policy(computed), quick=True)
    for r, row in cohort:
        marks = R.tiles_of(r.path, (r.sha, r.occ), row, params, R.config_key(r.path, cfg))
        s, _p, _cc = R._mark_tiles(marks or ())
        dl = R.mark_ref_deltas(r.path, r.sha, r.occ, marks, params, ref, R.config_key(r.path, cfg))
        raw += s
        excess += [x - float(dl[i]) for x, i in zip(s, R._mark_kept(marks))] if dl is not None else s
    summary = reg['observations'][0]['summary']
    assert summary['scoreAboveRef'] == round(float(np.median(excess)) - ref['median'], 3)
    assert summary['scoreAboveRef'] > round(float(np.median(raw)) - ref['median'], 3)
    # the lanes: a third quality, ref_delta, on truncated rows only
    rows = [r['layers'].get('nucreg') for r in _patch_rows(path, 60)]
    rows = [x for x in rows if x]
    assert rows and all(x['quality_names'] == ['score', 'period', 'ref_delta'] for x in rows)
    assert any(any(b < 128 for b in x['qualities'][2]) for x in rows)
    # geometry scores (profiles, nested pairs, association) subtract each tile's own reference
    out = nucgeo.geometry_analysis(computed, [OBS], patch_params=LOOSE, reg_params=trunc, request_scope='trunc-panel')
    widths = REF.widths_of(ref)
    d8t = R.digest8(params)
    e = next(v for k, v in nucgeo._GRIDS.items() if k[4] == d8t)
    rt = tile_reference(e['track'].window_widths, out['references']['ds0'], widths)
    assert not np.isscalar(rt) and np.nanmin(rt) < out['references']['ds0']
    R.regularity_analysis(computed, [OBS], params={}, request_scope='trunc-panel')
    nucgeo.geometry_analysis(computed, [OBS], patch_params=LOOSE, reg_params={}, request_scope='trunc-panel')
    rows = [r['layers'].get('nucreg') for r in _patch_rows(path, 30)]
    assert all(x['quality_names'] == ['score', 'period'] for x in rows if x)


# ------------------------------------------------------------------------------------- pooling and cohorts
def test_pooled_geometries_do_not_depend_on_observation_order(computed):
    from services.nuc import nucgeo
    a = dict(OBS, obsId='left', start=VIEW[0], end=40_000)
    b = dict(OBS, obsId='right', start=40_000, end=VIEW[1])

    def key(res):
        return sorted((g['kind'], g['start'], g['end'], g['molecules'], g['patches'],
                       tuple(sorted((k, v['full'], v['callable']) for k, v in g['perObservation'].items())))
                      for g in res['geometries'])
    one = nucgeo.geometry_analysis(computed, [a, b], patch_params=LOOSE, reg_params={}, adopt=False)
    two = nucgeo.geometry_analysis(computed, [b, a], patch_params=LOOSE, reg_params={}, adopt=False)
    assert one['geometries'] and key(one) == key(two)
    assert one['nMolecules'] == two['nMolecules']


def test_spanning_is_measured_against_the_records_own_contig():
    from services.nuc.regularity import _spanning
    rec = NS(blocks=((9_000, 12_000),))
    windows = [('hapA', 1_000, 2_000), ('hapB', 10_000, 11_000)]
    assert _spanning(rec, windows, 'hapB')
    assert not _spanning(rec, windows, 'hapA')
    # without the contig: the old hull (the most-covered contig), kept for callers that have none
    assert _spanning(NS(blocks=((500, 2_500),)), windows)


def test_a_record_shared_by_two_datasets_counts_for_both_density_matched_shares(computed):
    from models.domain import Dataset
    from services.nuc import nucgeo
    ds1 = Dataset('ds1', _path(computed), label='Synthetic twin')
    ds1.available_layers = {'footprint': True}
    computed.datasets['ds1'] = ds1
    computed.nuc_active['ds1'] = computed.nuc_active['ds0']
    try:
        obs = [OBS, dict(OBS, obsId='o2', datasetId='ds1')]
        res = nucgeo.geometry_analysis(computed, obs, patch_params=LOOSE, reg_params={}, adopt=False)
        for g in res['geometries']:
            assert set(g['perDataset']) == {'ds0', 'ds1'} and set(g['densityMatched']) == {'ds0', 'ds1'}
            # the twin's molecules are the same records: the same share (before, ds1 had none at all)
            assert g['densityMatched']['ds0'] == g['densityMatched']['ds1']
    finally:
        computed.datasets.pop('ds1', None)
        computed.nuc_active.pop('ds1', None)
    # (this small fixture leaves too few callable molecules per density bin for a share: the same on enough layouts)
    from fiberhmm.nuc.geometries import CARRIES, ABSENT, MoleculeLayout, density_matched_shares
    rng = np.random.default_rng(0)
    lays = [MoleculeLayout(f'm{i}', 'ds0', [], np.zeros(1, np.int64), np.ones(1, np.int64), np.zeros(1, np.int8),
                           float(rng.uniform(5, 50))) for i in range(80)]
    states = [{'G1': CARRIES if i % 3 else ABSENT} for i in range(80)]
    metas = [dict(ds='ds0', aliases=[dict(ds='ds0'), dict(ds='ds1')]) for _ in lays]
    got = density_matched_shares(*nucgeo._per_dataset_layouts(lays, states, metas), 'G1', ['ds0', 'ds1'])
    assert got['ds0'] is not None and got['ds0'] == got['ds1']
    assert density_matched_shares(lays, states, 'G1', ['ds0', 'ds1'])['ds1'] is None      # the old input


def test_other_reads_of_one_physical_molecule_get_its_geometry_states(computed, monkeypatch):
    from services.nuc import nucgeo, observations
    from services.nuc.inputs import browser_read_policy
    _s, recs, _w, _cfg, cohort, _c = observations.observation_cohort(computed, OBS, browser_read_policy(computed))
    names = sorted({r.qname for r, _row in cohort})[:2]
    twin = {names[1]: names[0]}
    original = observations._molecule_key
    monkeypatch.setattr(observations, '_molecule_key', lambda q: original(twin.get(q, q)))
    computed.__dict__.pop('_nuc_cohorts', None)
    out = observations.observation_cohort(computed, OBS, browser_read_policy(computed))
    aliases = out[5]['aliases']
    assert any(names[1] in {o.qname for o in v} for v in aliases.values())
    res = nucgeo.geometry_analysis(computed, [OBS], patch_params=LOOSE, reg_params={'window_bp': 1990},
                                   adopt=False)
    carried = res['assignments']['ds0']['carried']
    assert names[0] in carried and names[1] in carried and carried[names[0]] == carried[names[1]]
    computed.__dict__.pop('_nuc_cohorts', None)


# ----------------------------------------------------------------------------------------- the reference
def test_a_superseded_reference_computation_never_re_points_the_lanes(computed):
    from services.nuc import reference as REF, regularity as R
    from services.nuc.jobs import active_config
    path = _path(computed)
    params = R.parse_params({'window_bp': 1980})
    cfg = active_config(computed, 'ds0')
    d8 = params.digest()[:8]
    REF._register('key-old', [path], cfg, params)
    REF._register('key-new', [path], cfg, params)
    REF._publish('key-new', [path], params, dict(key='key-new', median=5.0))
    REF._publish('key-old', [path], params, dict(key='key-old', median=1.0))     # the old one finishes last
    assert REF.cached_for_path(path, d8)['median'] == 5.0
    with REF._LOCK:
        REF._REFS.pop('key-old', None); REF._REFS.pop('key-new', None)
        REF._PATH_KEY.pop((REF.real(path), d8), None)


def test_a_failing_reference_is_not_retried_on_every_read_load(computed, monkeypatch):
    from services.nuc import reference as REF, regularity as R
    from services.nuc.jobs import active_config
    path = _path(computed)
    params = R.parse_params({'window_bp': 1970})
    calls = []

    def boom(*a, **k):
        calls.append(1)
        raise OSError('unreadable calibration region')
    monkeypatch.setattr(REF, 'compute', boom)
    src = computed.datasets['ds0']
    with pytest.raises(OSError):
        REF.dataset_reference(list(src.paths), active_config(computed, 'ds0'), params)
    assert calls == [1]
    for _ in range(5):
        assert REF.request_background(path, params.digest()[:8]) is False
    time.sleep(0.2)
    assert calls == [1]
    monkeypatch.setattr(REF, 'FAILURE_BACKOFF', 0.0)
    assert REF.request_background(path, params.digest()[:8]) is True
    for _ in range(50):
        if len(calls) == 2:
            break
        time.sleep(0.05)
    assert len(calls) == 2


def test_reference_prefetch_stops_with_its_request(computed, monkeypatch):
    from services.nuc import reference as REF, regularity as R
    release = threading.Event()
    real_ref = REF.dataset_reference

    def slow(paths, cfg, params, *, compute_now=True):
        if not compute_now:
            return None
        release.wait(10)
        return None
    monkeypatch.setattr(REF, 'dataset_reference', slow)
    sources = {'a': computed.datasets['ds0'], 'b': computed.datasets['ds0']}
    monkeypatch.setattr('services.nuc.jobs.active_config', lambda st, d: object())
    stop = threading.Event()
    stop.set()
    t = time.time()
    with pytest.raises(InterruptedError):
        R.prefetch_references(computed, sources, lambda d: R.parse_params({}), stop)
    assert time.time() - t < 2
    release.set()
    monkeypatch.setattr(REF, 'dataset_reference', real_ref)


def test_populations_are_bounded_by_bytes_not_by_count(monkeypatch):
    from services.nuc import reference as REF

    class M:
        def __init__(self, n):
            self.hits = np.zeros(n, dtype=np.int8)
    with REF._LOCK:
        saved = dict(REF._POPS), dict(REF._POP_SIZE)
        REF._POPS.clear(); REF._POP_SIZE.clear()
    try:
        monkeypatch.setattr(REF, 'POPULATION_BYTES', 10_000)
        monkeypatch.setattr(REF, 'POPULATION_MIN', 2)
        with REF._LOCK:
            for i in range(6):                         # six datasets of 1 kB each: all kept
                REF._POPS[f'p{i}'] = [M(1000)]
                REF._POP_SIZE[f'p{i}'] = REF._population_bytes(REF._POPS[f'p{i}'])
                REF._trim_populations()
            assert len(REF._POPS) == 6
            REF._POPS['big'] = [M(9_000)]
            REF._POP_SIZE['big'] = 9_000
            REF._trim_populations()
            assert list(REF._POPS)[-1] == 'big' and len(REF._POPS) == 2      # the oldest go first, two kept
    finally:
        with REF._LOCK:
            REF._POPS.clear(); REF._POP_SIZE.clear()
            REF._POPS.update(saved[0]); REF._POP_SIZE.update(saved[1])


def test_full_window_tracks_are_bounded_by_bytes(computed, monkeypatch):
    from services.nuc import regularity as R
    monkeypatch.setattr(R, 'BASE_BYTES', 40_000)
    with R._LOCK:
        R._BASE.clear(); R._BASE_BYTES[0] = 0
    R.regularity_analysis(computed, [OBS], params={'window_bp': 1960}, adopt=False)
    with R._LOCK:
        assert 0 < len(R._BASE) and R._BASE_BYTES[0] <= 40_000
        assert R._BASE_BYTES[0] == sum(R._track_bytes(t) for t in R._BASE.values())


# --------------------------------------------------------------------------------- not analysed, first paint
def test_not_analysed_counts_respect_the_read_filters(computed):
    from services.nuc import record_count as RC
    from services.nuc.inputs import nuc_source, browser_read_policy
    from services.nuc.jobs import active_config
    from services.nuc.observations import _not_analysed
    path = _path(computed)
    every = RC.count_records(path, CONTIG, 100_000, 140_000)
    policy = browser_read_policy(computed)
    filtered = RC.count_records(path, CONTIG, 100_000, 140_000, policy['filters'])
    from fiberhmm.scan.reads import passes
    with pysam.AlignmentFile(path, 'rb') as bam:
        want = sum(1 for r in bam.fetch(CONTIG, 100_000, 140_000) if passes(r, policy['filters']))
    assert filtered == want and every >= filtered
    obs = dict(OBS, start=100_000, end=140_000)
    got = _not_analysed(computed, nuc_source(computed, 'ds0'), obs, active_config(computed, 'ds0'), policy)
    assert got is not None and got[5]['records'] == want
    # records that all fail the filters: resolved (nothing to analyse), never "not analysed"
    strict = dict(policy, filters=dict(policy['filters'], min_mapq=10_000))
    assert _not_analysed(computed, nuc_source(computed, 'ds0'), obs, active_config(computed, 'ds0'), strict) is None


def test_the_full_decode_is_decided_before_decoding_anything(monkeypatch):
    from services import first_paint as FP
    extents = {f'r{i}': [0, 10_000, i] for i in range(5000)}          # every read spans the view: all tie
    monkeypatch.setattr(FP, 'alignment_extents', lambda *a, **k: extents)
    built = []
    query = NS(build_working_set=lambda *a, **k: built.append(k) or NS(reads=[]))
    state = NS(get_dataset=lambda d: NS())
    plan = FP.plan_first_paint(state, query, 'ds', chrom='c', start=0, end=10_000, max_reads=1000, build_options={})
    assert plan is None and built == []


# ------------------------------------------------------------------------------------------ helper processes
def test_the_count_helper_is_shut_down_and_reaped(monkeypatch, computed):
    import multiprocessing
    from services.nuc import record_count as RC
    monkeypatch.setattr(RC, 'USE_HELPER', True)
    path = _path(computed)
    assert RC.count(path, CONTIG, 20_000, 40_000) == RC.count_records(path, CONTIG, 20_000, 40_000)
    assert RC._POOL is not None
    RC.shutdown(True)
    assert RC._POOL is None and not multiprocessing.active_children()


_ORPHAN_SCRIPT = r'''
import os, sys
sys.path[:0] = [{browser!r}, {fh!r}]
if __name__ == '__main__':
    from services.nuc import record_count as RC
    pool = RC._pool()
    print(pool.submit(os.getpid).result(timeout=60), flush=True)
    os._exit(0)          # the parent dies without any cleanup
'''


def test_workers_exit_when_their_parent_dies(tmp_path):
    import importlib.util
    browser = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'browser')
    fh = os.path.dirname(os.path.dirname(importlib.util.find_spec('fiberhmm').origin))
    script = tmp_path / 'parent.py'
    script.write_text(_ORPHAN_SCRIPT.format(browser=browser, fh=fh))
    out = subprocess.run([sys.executable, str(script)], capture_output=True, text=True, timeout=120)
    pid = int(out.stdout.strip().splitlines()[-1])

    def alive(p):
        try:
            os.kill(p, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        return True
    deadline = time.time() + 15
    while alive(pid) and time.time() < deadline:
        time.sleep(0.2)
    assert not alive(pid)


def test_a_cluster_views_requests_never_cancel_each_other(computed, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routers.nuc import router
    from services.nuc import regularity as R
    from state.dependencies import get_state
    started, release, seen = threading.Event(), threading.Event(), []

    def slow(state, obs, *, cancel, **kw):
        seen.append((kw.get('request_scope'), kw.get('adopt')))
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
            '/api/nuc/regularity', json=dict(observations=[OBS], requestScope='cluster:p1'))))
        t.start()
        assert started.wait(10)
        second = client.post('/api/nuc/regularity', json=dict(observations=[OBS], requestScope='cluster:p1',
                                                               adopt=False))
        release.set()
        t.join(10)
    assert second.status_code == 200 and out['first'].status_code == 200
    assert seen == [('cluster:p1', True), ('cluster:p1', False)]
