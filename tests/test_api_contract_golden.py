"""Frontend/backend contract: golden responses of key routes (coverage plan #22).

The vitest suite mocks ``api/*`` modules or ``fetch`` with hand-written payloads, so a backend field rename leaves it
green while a panel goes blank. This test calls about a dozen key routes for real (the tracked demo BAM, the
synthetic nucleosome fixture, a pipeline job through the job manager) and compares each response's *shape* (keys and
value types, recursively) with the committed golden file in ``browser/frontend/src/api/__fixtures__/contract/``.
The vitest ``src/api/contract.test.ts`` loads the same files through the real frontend API functions and parsers.

Stale golden files fail here. To regenerate after an intended change:

    FIBERBROWSER_UPDATE_API_CONTRACT=1 pytest tests/test_api_contract_golden.py

Values are scrubbed before writing (read names, local paths, timings, ids), and lists are cut to a few items: the
files are public test data. Only the shape is compared, so run-to-run variation in values never fails the check.
"""
from __future__ import annotations

import json
import os
import re
import shlex
import sys
import time
from pathlib import Path
from types import SimpleNamespace as NS

import pytest

from conftest import auth_headers

ROOT = Path(__file__).resolve().parents[1]
GOLDEN_DIR = ROOT / 'browser' / 'frontend' / 'src' / 'api' / '__fixtures__' / 'contract'
DEMO_BAM = ROOT / 'browser' / 'data' / 'demo' / 'napa_ddda.bam'
UPDATE = os.environ.get('FIBERBROWSER_UPDATE_API_CONTRACT') == '1'
WINDOW = dict(chrom='chr19', start=47514800, end=47515800)
MAX_ITEMS = 3

pytestmark = pytest.mark.skipif(not DEMO_BAM.exists(), reason='tracked demo BAM browser/data/demo/napa_ddda.bam missing')

MAP_KEY = re.compile(r'(read-\d+|-?\d+|ds\d*|demo|job-\d+)')
# Subtrees that describe this machine rather than the API (an installed dorado or not): compared by presence only.
MACHINE_SPECIFIC = {'dorado', 'blast_tool'}
VOLATILE_NUMBERS = re.compile(r'(_ms|_s|elapsed|timings?|created_at|updated_at|started_at|finished_at|mtime|pid)$')


class Scrubber:
    """Public-safe values: read names become read-N, absolute paths their basename under /data, times zero."""

    def __init__(self, roots):
        self.roots = [str(r) for r in roots if r]
        self.names = {}

    def read(self, name):
        return self.names.setdefault(name, f'read-{len(self.names) + 1}')

    def string(self, s, key=''):
        if re.fullmatch(r'm\d+[_/][\w/]+', s) or '/ccs' in s:
            return self.read(s)
        if s.startswith('/') or re.match(r'^[A-Za-z]:\\', s):
            tail = Path(s.split('?')[0]).name or 'path'
            return f'/data/{tail}'
        # absolute paths inside a message ("dorado 2.0 (/usr/local/bin/dorado)")
        s = re.sub(r'(?<![\w.])/(?:[^\s()\'"/]+/)+([^\s()\'"/]+)', r'/data/\1', s)
        for r in self.roots:
            s = s.replace(r, '/data')
        if key in ('id', 'job_id') and re.fullmatch(r'[0-9a-f-]{8,}', s):
            return 'job-1'
        return s

    def __call__(self, value, key=''):
        if isinstance(value, dict):
            out = {}
            for k, v in value.items():
                nk = self.string(k) if isinstance(k, str) and ('/ccs' in k or k.startswith('/')) else k
                out[nk] = self(v, str(k))
            if len(out) > MAX_ITEMS and all(MAP_KEY.fullmatch(str(k)) for k in out):
                out = {k: out[k] for k in list(out)[:MAX_ITEMS]}   # a data map (reads, clusters): a few entries
            return out
        if isinstance(value, list):
            return [self(v, key) for v in value[:MAX_ITEMS]]
        if isinstance(value, bool) or value is None:
            return value
        if isinstance(value, (int, float)):
            return 0 if VOLATILE_NUMBERS.search(key) else value
        if isinstance(value, str):
            return self.string(value, key)
        return value


def shape(value):
    """Keys and value types, recursively; a list's items merged (union of keys) into one shape."""
    if isinstance(value, dict):
        # maps keyed by data (dataset ids, read names, cluster numbers) compare by value shape only
        if value and all(MAP_KEY.fullmatch(str(k)) for k in value):
            merged = None
            for v in value.values():
                merged = _merge(merged, shape(v))
            return {'<map>': merged}
        return {k: ('<machine>' if k in MACHINE_SPECIFIC else shape(v)) for k, v in sorted(value.items())}
    if isinstance(value, list):
        merged = None
        for v in value:
            merged = _merge(merged, shape(v))
        return ['list', merged]
    if isinstance(value, bool):
        return 'bool'
    if isinstance(value, (int, float)):
        return 'number'
    if value is None:
        return 'null'
    return type(value).__name__


def _merge(a, b):
    if a is None:
        return b
    if b is None or a == b:
        return a
    if isinstance(a, dict) and isinstance(b, dict):
        return {k: _merge(a.get(k), b.get(k)) for k in sorted(set(a) | set(b))}
    if isinstance(a, list) and isinstance(b, list):
        return ['list', _merge(a[1], b[1])]
    if 'null' in (a, b):
        return a if b == 'null' else b
    return sorted({json.dumps(a), json.dumps(b)})


def compatible(fresh, golden, where='$'):
    """None when the shapes agree; else the first difference. ``null`` matches any type and an empty list any list
    (optional values the fixture data happened not to fill)."""
    if fresh == golden or 'null' in (fresh, golden):
        return None
    if isinstance(fresh, dict) and isinstance(golden, dict):
        if set(fresh) != set(golden):
            return f'{where}: keys added {sorted(set(fresh) - set(golden))}, removed {sorted(set(golden) - set(fresh))}'
        for k in fresh:
            diff = compatible(fresh[k], golden[k], f'{where}.{k}')
            if diff:
                return diff
        return None
    if isinstance(fresh, list) and isinstance(golden, list):
        if fresh[1] is None or golden[1] is None:
            return None
        return compatible(fresh[1], golden[1], f'{where}[]')
    return f'{where}: {fresh} != {golden}'


def _check(name, payload, scrub):
    data = scrub(payload)
    path = GOLDEN_DIR / f'{name}.json'
    if UPDATE:
        GOLDEN_DIR.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, indent=1, sort_keys=True) + '\n')
        return
    assert path.is_file(), f'{path.name} missing: regenerate with FIBERBROWSER_UPDATE_API_CONTRACT=1'
    golden = json.loads(path.read_text())
    diff = compatible(shape(data), shape(golden))
    assert diff is None, (diff,
        f'{name}: the route response no longer matches the committed golden file {path.name}. If the change is '
        'intended, regenerate with FIBERBROWSER_UPDATE_API_CONTRACT=1 and update the frontend types and '
        'src/api/contract.test.ts.')
    text = path.read_text()
    assert '/Users/' not in text and '/home/' not in text and '/ccs' not in text, f'{path.name} is not scrubbed'


# ------------------------------------------------------------------------------------------------- the demo routes

@pytest.fixture(scope='module')
def demo(tmp_path_factory, standalone_app):
    # standalone_app first: it is session-scoped and sets server.state once. Built later, inside this
    # fixture, it would be overwritten here and teardown would put back None, which later files'
    # `client` then served (test_read_sampling: "'NoneType' object has no attribute 'add_dataset'").
    import server as srv
    from starlette.testclient import TestClient
    from plugins import init_context
    from state import runtime_state
    from state.browser_state import BrowserState
    from state.runtime_state import set_browser_state
    previous, previous_runtime = srv.state, runtime_state._state
    state = BrowserState(None, None, None, None)
    state.add_dataset('demo', str(DEMO_BAM), 'demo')
    srv.state = state
    set_browser_state(state)
    init_context(state)
    try:
        yield TestClient(srv.app, headers=auth_headers()), Scrubber([ROOT, tmp_path_factory.getbasetemp()])
    finally:
        srv.state = previous
        set_browser_state(previous_runtime)
        init_context(previous)


def _ok(resp):
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_datasets_status_and_chroms(demo):
    c, scrub = demo
    _check('datasets', _ok(c.get('/api/datasets')), scrub)
    _check('status', _ok(c.get('/api/status')), scrub)
    _check('chroms', _ok(c.get('/api/chroms')), scrub)


def test_compact_reads(demo):
    c, scrub = demo
    body = _ok(c.get('/api/reads/compact', params={**WINDOW, 'dataset_id': 'demo', 'max_reads': 3,
                                                   'include_layers': True}))
    assert body['reads']
    _check('reads_compact', body, scrub)


def test_scan_peaks_and_cluster(demo):
    c, scrub = demo
    peaks = _ok(c.post('/api/scan_peaks', params={**WINDOW, 'dataset_id': 'demo'}, json={}))
    assert peaks['peaks']
    _check('scan_peaks', peaks, scrub)
    regions = [{'start': p['start'], 'end': p['end'], 'mode': 'accessibility'} for p in peaks['peaks'][:3]]
    clusters = _ok(c.post('/api/cluster_all', params=WINDOW, json={'peak_regions': regions, 'k': 2,
                                                                   'method': 'combinatorial', 'dataset_ids': ['demo']}))
    _check('cluster_all', clusters, scrub)


def test_consensus_schema_and_nuc_metrics(demo):
    c, scrub = demo
    _check('consensus_schema', _ok(c.get('/api/footprint/consensus/schema')), scrub)
    _check('nuc_metrics', _ok(c.get('/api/nuc/metrics')), scrub)


# ------------------------------------------------------------------------------------------ the nucleosome summary

def test_nuc_summary(tmp_path_factory, monkeypatch):
    pytest.importorskip('fiberhmm.scan.modules.nuc')
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from models.domain import Dataset
    from nuc_fixtures import chromatin_bam
    from routers.nuc import router
    from services.nuc import jobs
    from services.nuc.store import STORE
    from state.browser_state import BrowserState
    from state.dependencies import get_state
    root = tmp_path_factory.mktemp('contract_nuc')
    bam = chromatin_bam(root / 'chromatin.bam', contig='chrS', length=50_000)
    monkeypatch.setenv('FIBERBROWSER_SCAN_CACHE_DIR', str(root / 'cache'))
    STORE.clear()
    st = BrowserState(None)
    ds = Dataset('ds0', bam, label='Synthetic')
    ds.available_layers = {'footprint': True}
    st.datasets = {'ds0': ds}
    st.chroms = [NS(name='chrS', size=50_000)]
    job = jobs.submit(st, dict(datasets=['ds0'], chrom='chrS', start=20_000, end=30_000,
                               parameters={'calibration': 'self', 'calibration_population': 200}, workers=2))
    assert jobs.wait(st, job['job_id'], 300)['status'] == 'complete'
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_state] = lambda: st
    try:
        with TestClient(app) as client:
            obs = dict(obsId='o1', label='Synthetic', datasetId='ds0', kind='linear', chrom='chrS', start=20_000,
                       end=26_000)
            body = _ok(client.post('/api/nuc/summary', json=dict(observations=[obs])))
        assert 'error' not in body['observations'][0]
        _check('nuc_summary', body, Scrubber([root]))
    finally:
        STORE.clear()


# ---------------------------------------------------------------------------------------- pipeline status and job

def test_pipeline_status_and_job(client, monkeypatch, tmp_path):
    """The job is the contract-v1 stand-in pipeline (the real run is covered elsewhere): this pins FiberBrowser's own
    job and status payloads, which the wizard and the jobs list read."""
    fake = Path(__file__).parent / 'fake_fiberhmm_pipeline.py'
    monkeypatch.setenv('FIBERBROWSER_PIPELINE_COMMAND', f'{shlex.quote(sys.executable)} {shlex.quote(str(fake))}')
    monkeypatch.setenv('FIBERBROWSER_JOBS_DIR', str(tmp_path / 'jobs'))
    monkeypatch.setenv('FIBERBROWSER_NO_CAFFEINATE', '1')
    monkeypatch.setenv('FAKE_PIPELINE_STEP_S', '0.05')
    monkeypatch.delenv('FAKE_PIPELINE_MODE', raising=False)
    from services import pipeline_inputs
    pipeline_inputs._help_cache.clear()
    scrub = Scrubber([ROOT, tmp_path])
    status = _ok(client.get('/api/pipeline/status'))
    assert status['default_options'] and status['enzymes']
    # machine-specific lists (downloaded genomes, references, dorado) reduced to their shape
    _check('pipeline_status', status, scrub)
    reads = tmp_path / 'sample_a.fastq'
    reads.write_text(''.join(f'@r{i}\nACGTACGT\n+\nIIIIIIII\n' for i in range(3)))
    ref = tmp_path / 'ref.fa'
    ref.write_text('>chrT\n' + 'ACGT' * 50 + '\n')
    scan = _ok(client.post('/api/pipeline/scan', json={'paths': [str(reads)], 'input_kind': 'reads'}))
    assert scan['success'] and scan['samples'], scan
    _check('pipeline_scan', scan, scrub)
    body = {'samples': [{'name': 'sample a', 'files': [{'path': str(reads), 'kind': 'fastq'}]}],
            'reference': {'kind': 'file', 'path': str(ref)}, 'enzyme': 'dddb',
            'output_root': str(tmp_path / 'runs' / 'r1'), 'cores': 1, 'options': {'dedup': 'off'}}
    validated = _ok(client.post('/api/pipeline/validate', json=body))
    assert validated['ok'], validated
    _check('pipeline_validate', validated, scrub)
    submitted = _ok(client.post('/api/pipeline/jobs', json=body))
    assert submitted['success'], submitted
    _check('pipeline_submit', submitted, scrub)
    job_id = submitted['jobs'][0]['id']
    from services.pipeline_jobs import get_job_manager
    manager = get_job_manager()
    deadline = time.time() + 30
    while time.time() < deadline:
        manager.tick()
        if manager.state(job_id).get('status') in ('done', 'error'):
            break
        time.sleep(0.05)
    job = _ok(client.get(f'/api/pipeline/jobs/{job_id}'))
    assert job['status'] == 'done', manager.read_log(job_id)
    _check('pipeline_job', job, scrub)
    client.delete(f'/api/pipeline/jobs/{job_id}')
