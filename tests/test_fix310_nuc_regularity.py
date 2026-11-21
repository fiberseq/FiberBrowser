"""3.1.0 audit fixes in the nucleosome regularity / geometry requests: a request asked not to adopt (``adopt``
False) never moves the lanes, and the response caches follow the open scans bound to the datasets (opening or
closing a scan recomputes). Synthetic Hia5 molecules (tests/nuc_fixtures.py)."""
from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace as NS

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
def computed(tmp_path_factory):
    import os
    from models.domain import Dataset
    from state.browser_state import BrowserState
    from services.nuc import jobs, nucgeo
    from services.nuc.regularity import clear_references
    from services.nuc.store import STORE
    bam = chromatin_bam(tmp_path_factory.mktemp('fix310_nuc') / 'chromatin.bam', contig=CONTIG, length=LENGTH)
    old = os.environ.get('FIBERBROWSER_SCAN_CACHE_DIR')
    os.environ['FIBERBROWSER_SCAN_CACHE_DIR'] = str(tmp_path_factory.mktemp('fix310_nuc_cache'))
    STORE.clear()
    clear_references()
    nucgeo.clear()
    st = BrowserState(None)
    ds = Dataset('ds0', bam, label='Synthetic')
    ds.available_layers = {'footprint': True}
    st.datasets = {'ds0': ds}
    st.chroms = [NS(name=CONTIG, size=LENGTH)]
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


def test_adopt_false_never_moves_the_lanes(computed):
    """The request's ``adopt`` False reached the adoption guard as the (truthy) local adopt function before."""
    from services.nuc import regularity as R
    path = computed.datasets['ds0'].paths[0]
    R.regularity_analysis(computed, [OBS], params={'window_bp': 2000}, request_scope='panel-a')
    assert R.path_params(path).window_bp == 2000
    res = R.regularity_analysis(computed, [OBS], params={'window_bp': 2500}, request_scope='panel-a', adopt=False)
    assert res['datasets']['ds0']['params']['window_bp'] == 2500
    assert R.path_params(path).window_bp == 2000


def _open_fake_scan(state, tmp_path, path):
    """A tables-less scan with a nuc module bound to ds0 (it supplies no rows; only its presence matters here)."""
    from services.scan import registry
    scan = registry.OpenScan(Path(tmp_path), {'scan_id': 'fake-nuc-scan', 'modules': {'nuc': {'settings': {}}}},
                             'opened', 'Fake')
    scan.bindings = {'s0': dict(dataset='ds0', status='bound', via='content', files={'0': path})}
    scans, lock = registry._session(state)
    with lock:
        scans[scan.scan_id] = scan
    return scan


@pytest.mark.parametrize('which', ['regularity', 'geometry'])
def test_closing_a_bound_scan_recomputes_the_response(computed, tmp_path, monkeypatch, which):
    from services.nuc import nucgeo, regularity as R
    from services.scan import registry
    path = computed.datasets['ds0'].paths[0]
    monkeypatch.setattr(registry, '_refresh_layers', lambda state: None)
    calls = []
    real_obs = R.observation_regularity

    def counting(*a, **k):
        calls.append(1)
        return real_obs(*a, **k)
    monkeypatch.setattr(R, 'observation_regularity', counting)
    obs = dict(OBS, obsId='scan-' + which)

    def ask():
        if which == 'regularity':
            return R.regularity_analysis(computed, [obs], params={'window_bp': 2000}, request_scope='panel-a')
        return nucgeo.geometry_analysis(computed, [obs], request_scope='panel-a')

    scan = _open_fake_scan(computed, tmp_path, path)
    try:
        ask()
        ask()                                   # same state: a cache hit (geometry may not use the spy at all)
        before = len(calls)
        keys_reg, keys_geo = set(R._RESPONSES), set(nucgeo._RESPONSES)
    finally:
        registry.close_scan(computed, scan.scan_id)
    ask()
    if which == 'regularity':
        assert len(calls) > before
        assert set(R._RESPONSES) - keys_reg
    else:
        assert set(nucgeo._RESPONSES) - keys_geo


@pytest.mark.parametrize('which', ['regularity', 'geometry'])
def test_a_scan_closed_during_the_analysis_is_not_published_under_the_closed_key(computed, tmp_path, monkeypatch,
                                                                                  which):
    """Recheck: the scan identity is captured before the inputs are read. A scan closed while the request computes
    makes it recompute against the new scan set (never caching the old answer under the closed-scan key)."""
    from services.nuc import nucgeo, regularity as R
    from services.scan import registry
    path = computed.datasets['ds0'].paths[0]
    monkeypatch.setattr(registry, '_refresh_layers', lambda state: None)
    obs = dict(OBS, obsId='close-during-' + which)
    scan = _open_fake_scan(computed, tmp_path, path)
    real_prefetch = R.prefetch_references
    seen = []

    def prefetch_then_close(state, sources, *a, **k):
        out = real_prefetch(state, sources, *a, **k)
        seen.append(bool(R.bound_scans_identity(state, sources)))
        if registry.list_scans(state):
            registry.close_scan(state, scan.scan_id)       # the user closes the scan mid-request
        return out
    monkeypatch.setattr(R, 'prefetch_references', prefetch_then_close)
    computed_n = []                                     # full computations (not cache hits)
    mod, name = (R, 'observation_regularity') if which == 'regularity' else (nucgeo, 'pooled_geometries')
    real_compute = getattr(mod, name)

    def counting(*a, **k):
        computed_n.append(1)
        return real_compute(*a, **k)
    monkeypatch.setattr(mod, name, counting)

    def ask():
        if which == 'regularity':
            return R.regularity_analysis(computed, [obs], params={'window_bp': 2000}, request_scope='panel-a')
        return nucgeo.geometry_analysis(computed, [obs], request_scope='panel-a')
    try:
        ask()
    finally:
        if registry.list_scans(computed):
            registry.close_scan(computed, scan.scan_id)
    # read with the scan bound, then again (recomputed) once it was closed
    assert seen[:2] == [True, False] and len(computed_n) == 2
    ask()                                               # the published answer is the closed-scan one: a cache hit
    assert len(computed_n) == 2
