"""The nucleosome panel's HTTP routes on a real compute (coverage plan #24 and #44).

Nothing is patched: an Analyse goes in through ``POST /api/nuc/jobs``, FiberHMM's nuc module decodes the synthetic
chromatin BAM (``nuc_fixtures``) in the job thread, and every route the panel uses then reads the stored outputs.
Each route also gets its request-parsing refusals (422 on a malformed body, 404 on an unknown job).
"""
from __future__ import annotations

import time
from types import SimpleNamespace as NS

import pytest

pytest.importorskip('pysam')
pytest.importorskip('fiberhmm.scan.modules.nuc')

from nuc_fixtures import chromatin_bam

CONTIG, LENGTH = 'chrR', 70_000
VIEW = (20_000, 45_000)          # spans the first two 190 bp arrays of the fixture's dyad map
SETTINGS = {'calibration': 'self', 'calibration_population': 300}
OBS = dict(obsId='o1', label='Synthetic', datasetId='ds0', kind='linear', chrom=CONTIG, start=VIEW[0], end=VIEW[1])


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
def client(tmp_path_factory):
    import os
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routers.nuc import router
    from services.nuc.regularity import clear_references
    from services.nuc.store import STORE
    from state.dependencies import get_state
    root = tmp_path_factory.mktemp('nuc_routes')
    bam = chromatin_bam(root / 'chromatin.bam', contig=CONTIG, length=LENGTH)
    old = os.environ.get('FIBERBROWSER_SCAN_CACHE_DIR')
    os.environ['FIBERBROWSER_SCAN_CACHE_DIR'] = str(root / 'cache')
    STORE.clear()
    clear_references()
    st = _state(bam)
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_state] = lambda: st
    with TestClient(app) as c:
        c.state_obj = st
        yield c
    for job in list(getattr(st, 'nuc_jobs', {}).values()):
        job['_thread'].join(timeout=30)
    STORE.clear()
    clear_references()
    if old is None:
        os.environ.pop('FIBERBROWSER_SCAN_CACHE_DIR', None)
    else:
        os.environ['FIBERBROWSER_SCAN_CACHE_DIR'] = old


@pytest.fixture(scope='module')
def analysed(client):
    """#24: one Analyse through the job route, polled through the job route, the real compute in between."""
    r = client.post('/api/nuc/jobs', json=dict(datasets=['ds0'], chrom=CONTIG, start=VIEW[0], end=VIEW[1],
                                              parameters=SETTINGS, workers=2))
    assert r.status_code == 200, r.text
    job_id = r.json()['job_id']
    deadline = time.time() + 300
    job = r.json()
    while job['status'] not in ('complete', 'failed', 'cancelled') and time.time() < deadline:
        time.sleep(0.2)
        got = client.get(f'/api/nuc/jobs/{job_id}')
        assert got.status_code == 200, got.text
        job = got.json()
    assert job['status'] == 'complete', job
    return job


def test_an_analyse_through_the_job_route_runs_the_real_compute_and_publishes(client, analysed):
    from services.nuc.store import STORE
    st = client.state_obj
    path = st.datasets['ds0'].paths[0]
    rows = STORE.rows_of(path)
    assert len(rows) > 10, 'the job decoded and stored per-molecule outputs'
    assert analysed['job_id'] in [j['job_id'] for j in client.get('/api/nuc/jobs').json()['jobs']]
    records = client.post('/api/nuc/records', json=dict(datasetId='ds0', chrom=CONTIG, start=VIEW[0], end=VIEW[1]))
    assert records.status_code == 200, records.text
    status = client.post('/api/nuc/status', json=dict(datasets=['ds0', 'missing'])).json()
    assert status['available'] is True and status['settingsHash']
    by_id = {d['datasetId']: d for d in status['datasets']}
    assert by_id['ds0']['records'] == len(rows) and by_id['ds0']['active'] is not None
    assert 'error' in by_id['missing']
    # an identical resubmit reuses the finished plan instead of decoding again
    again = client.post('/api/nuc/jobs', json=dict(datasets=['ds0'], chrom=CONTIG, start=VIEW[0], end=VIEW[1],
                                                  parameters=SETTINGS, workers=2)).json()
    from services.nuc import jobs
    assert jobs.wait(st, again['job_id'], 120)['status'] == 'complete'
    assert len(STORE.rows_of(path)) == len(rows)


def test_job_routes_refuse_unknown_jobs_and_bad_requests(client):
    assert client.get('/api/nuc/jobs/nope').status_code == 404
    assert client.delete('/api/nuc/jobs/nope').status_code == 404
    assert client.post('/api/nuc/jobs', json=[1, 2]).status_code == 422
    assert client.post('/api/nuc/records', json=dict(datasetId='nope', chrom=CONTIG, start=0, end=10)).status_code == 422


def test_summary_route_reads_the_stored_outputs(client, analysed):
    s = client.post('/api/nuc/summary', json=dict(observations=[OBS]))
    assert s.status_code == 200, s.text
    o = s.json()['observations'][0]
    assert 'error' not in o, o
    nrl = o['spacing']['nrl']
    assert sum(nrl['counts']) > 0
    assert client.post('/api/nuc/summary', json=dict(observations=[])).status_code == 422
    # the Sites, At a site and value-selection routes left with their tabs
    for route in ('/api/nuc/window', '/api/nuc/select', '/api/nuc/sites'):
        assert client.post(route, json=dict(observations=[OBS])).status_code in (404, 405)


def test_patches_and_patch_label_routes(client, analysed):
    p = client.post('/api/nuc/patches', json=dict(observations=[OBS], patches=[
        dict(key='k', type='regular', chrom=CONTIG, start=24_000, end=26_000)]))
    assert p.status_code == 200, p.text
    got = p.json()['observations'][0]['patches']['k']
    assert got['n'] > 0 and got['fraction'] is not None
    labels = client.post('/api/nuc/patch_labels', json=dict(datasets=['ds0']))
    assert labels.status_code == 200 and 'ds0' in labels.json()['datasets']
    assert client.post('/api/nuc/patches', json=dict(observations=[OBS])).status_code == 422
    assert client.post('/api/nuc/patches', json=dict(observations=[OBS], patches=[], fdr=2)).status_code == 422
    assert client.post('/api/nuc/patches', json=dict(observations=[OBS], patches=[{}] * 501)).status_code == 422
    assert client.post('/api/nuc/patch_labels', json=dict(datasets='ds0')).status_code == 422


def test_regularity_and_geometry_routes(client, analysed):
    r = client.post('/api/nuc/regularity', json=dict(observations=[OBS], requestScope='nucleosomes'))
    assert r.status_code == 200, r.text
    o = r.json()['observations'][0]
    assert 'error' not in o, o
    assert o['molecules'] > 10 and 150 < o['summary']['repeatLength'] < 230
    g = client.post('/api/nuc/geometries', json=dict(observations=[OBS], patches={'min_share': 0.02},
                                                     requestScope='nucleosomes'))
    assert g.status_code == 200, g.text
    res = g.json()
    assert res['nMolecules'] > 10 and res['nPatches'] > 0 and res['geometries']
    # parse errors answer 422, never 500
    assert client.post('/api/nuc/regularity', json=dict(observations=[OBS], parameters=[1])).status_code == 422
    assert client.post('/api/nuc/regularity', json=dict(observations=[OBS],
                                                        parameters={'band_bp': [140, 400]})).status_code == 422
    assert client.post('/api/nuc/geometries', json=dict(observations=[OBS], patches='x')).status_code == 422
    assert client.post('/api/nuc/geometries', json=dict(observations=[OBS], regularity=[1])).status_code == 422
    assert client.post('/api/nuc/geometries', json={}).status_code == 422


def test_metric_listing_routes(client):
    assert client.get('/api/nuc/available').status_code == 200
    metrics = client.get('/api/nuc/metrics').json()['metrics']
    assert metrics
