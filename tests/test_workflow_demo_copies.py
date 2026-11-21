"""Default-suite copies of two lab-only full-chain workflow tests (coverage plan #28).

``test_workflow_api.py::TestAnalysisWorkflow::test_scan_peaks_then_cluster`` and
``::test_session_export_import_roundtrip`` are marked ``integration`` and need the lab's data. These copies run the
same route chains in-process on the tracked public demo BAM (``browser/data/demo/napa_ddda.bam``), with nothing
patched, and assert a little more than the originals: a peak must be found (no conditional skip), every read the
cluster route assigns must be a read of the window, and the re-imported session must reopen the same dataset.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from conftest import auth_headers

DEMO_BAM = Path(__file__).resolve().parents[1] / "browser" / "data" / "demo" / "napa_ddda.bam"
CHROM, START, END = 'chr19', 47514000, 47518000

pytestmark = pytest.mark.skipif(not DEMO_BAM.exists(), reason='tracked demo BAM browser/data/demo/napa_ddda.bam missing')


@pytest.fixture
def demo_client(standalone_app):
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
        yield TestClient(standalone_app, headers=auth_headers())
    finally:
        srv.state = previous
        set_browser_state(previous_runtime)
        init_context(previous)


def _dataset_id(client):
    datasets = client.get('/api/datasets').json()['datasets']
    assert datasets
    return datasets[0]['id']


def test_scan_peaks_then_cluster_on_the_demo(demo_client):
    c = demo_client
    ds = _dataset_id(c)
    window = dict(chrom=CHROM, start=START, end=END)
    assert c.post('/api/jupyter/goto', json=window).status_code == 200
    resp = c.post('/api/scan_peaks', params={**window, 'dataset_id': ds}, json={})
    assert resp.status_code == 200, resp.text
    peaks = resp.json()['peaks']
    assert peaks, 'the demo window holds the NAPA promoter peak'
    assert all(START <= p['start'] < p['end'] <= END for p in peaks)
    regions = [{'start': p['start'], 'end': p['end'], 'mode': 'accessibility'} for p in peaks[:5]]
    resp = c.post('/api/cluster_all', params=window,
                  json={'peak_regions': regions, 'k': 3, 'method': 'combinatorial', 'dataset_ids': [ds]})
    assert resp.status_code == 200, resp.text
    result = resp.json()['results'][ds]
    assignments = result['assignments']
    assert assignments and sum(result['cluster_counts'].values()) == len(assignments)
    import pysam
    with pysam.AlignmentFile(str(DEMO_BAM)) as bam:
        ids = {r.query_name for r in bam.fetch(CHROM, START, END)}
    assert set(assignments) <= ids, 'the cluster route assigned reads that are not in the window'
    # sort after cluster, as the lab chain does
    resp = c.post('/api/sort_reads', params={**window, 'dataset_id': ds}, json={'sort_by': 'fp_count'})
    assert resp.status_code == 200, resp.text
    order = resp.json()['results'][ds]['read_sort_order']
    assert order and set(order) <= ids


def test_session_export_import_roundtrip_on_the_demo(demo_client):
    c = demo_client
    window = dict(chrom=CHROM, start=START, end=END)
    c.post('/api/jupyter/goto', json=window)
    frontend_state = {
        'analysisSampleSeed': 'paper-seed',
        'peaksLocked': True,
        'selectedPeaks': [1],
        'captureRegions': [{'id': 'cap1', 'chrom': CHROM, 'start': START, 'end': START + 100}],
        'compositeTracks': [{'id': 'comp1', 'label': 'TF', 'kind': 'annotation', 'sources': [], 'scaleMode': 'auto',
                             'logScale': False, 'visible': True, 'groupAutoscaleSelected': False, 'showAxes': True}],
        'sessionManifest': {'sessionName': 'workflow', 'reproducibility': {'seed': 'paper-seed'}, 'warnings': []},
    }
    resp = c.post('/api/session/export', json={**window, 'frontend_state': frontend_state})
    assert resp.status_code == 200, resp.text
    session = resp.json()
    assert session['version'] == '2.0'
    assert session['viewport']['chrom'] == CHROM
    assert [[Path(p).name for p in d['paths']] for d in session['datasets']] == [['napa_ddda.bam']]
    assert session['frontend']['captureRegions'][0]['id'] == 'cap1'
    resp = c.post('/api/session/import', json={'session': session})
    assert resp.status_code == 200, resp.text
    imported = resp.json()
    assert imported['success']
    assert imported['results']['datasets_loaded'] >= 1
    assert imported['frontend']['analysisSampleSeed'] == 'paper-seed'
    assert imported['frontend']['peaksLocked'] is True
    assert imported['frontend']['compositeTracks'][0]['id'] == 'comp1'
    datasets = c.get('/api/datasets').json()['datasets']
    assert any(Path(d.get('path') or '').name == 'napa_ddda.bam' for d in datasets), datasets
    # the reopened dataset still serves reads in the exported window
    ds = datasets[0]['id']
    assert c.get('/api/reads/compact', params={**window, 'dataset_id': ds}).json()['count'] > 0
