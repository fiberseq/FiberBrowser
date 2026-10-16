"""Find classes: the optional read-order check (FiberHMM recaller.order_replicates).

The panel's "Check robustness to read order" sends recaller.order_replicates=2; FiberHMM then marks each class
robust or not, and the Browser passes the per-class verdict and the run's summary to the class list, keeps the
setting with the run (sessions), and caps it on public servers."""
import threading
from types import SimpleNamespace

import pytest

from services import consensus_workflow as workflow
from test_consensus_lattice_recaller import planted_payload


def robust_job(tmp_path, replicates=2):
    fh_workflow, _ = workflow._runtime()
    parameters = {'cr': {'engine': 'lattice_recaller'}, 'recaller': {'learned_spots': False, 'order_replicates': replicates}}
    result = fh_workflow.run_workflow(planted_payload(), parameters, tmp_path)
    job = dict(job_id='j', status='complete', result=result, filters=workflow.schema()['display_defaults'],
               request=dict(parameters=parameters))
    job['index'], job['layers'] = workflow._index(result)
    state = SimpleNamespace(consensus_workflow_jobs={'j': job}, consensus_workflow_lock=threading.RLock(), consensus_workflow_active='j')
    return state, job


def test_schema_offers_the_read_order_check_off_by_default():
    controls = {c['name']: c for c in workflow.schema()['groups']['recaller']}
    assert controls['order_replicates']['default'] == 0 and controls['order_robust_fraction']['default'] == 1.0


def test_catalog_carries_each_class_verdict_and_the_run_summary(tmp_path):
    from routers.footprint import _consensus_catalog_payload
    state, job = robust_job(tmp_path)
    catalog = _consensus_catalog_payload('j', state)
    assert catalog['robustness']['orderings'] == 3 and catalog['robustness']['replicates'] == 2
    families = catalog['datasets']['d']['catalog']
    assert families and all(isinstance(f['robust'], bool) and 0 < f['order_robustness'] <= 1 for f in families)
    planted = [f for f in families if abs(f['consensus_start'] - 1180) <= 3 and abs(f['consensus_end'] - 1210) <= 3]
    assert len(planted) == 1 and planted[0]['robust'] is True and planted[0]['order_robustness'] == 1.0


def test_a_run_without_the_check_has_no_verdicts(tmp_path):
    from routers.footprint import _consensus_catalog_payload
    state, _ = robust_job(tmp_path, replicates=0)
    catalog = _consensus_catalog_payload('j', state)
    assert catalog['robustness'] is None
    assert all('robust' not in f and 'order_robustness' not in f for f in catalog['datasets']['d']['catalog'])


def test_a_saved_session_keeps_the_setting_and_the_verdicts(tmp_path, monkeypatch):
    """The session carries the run; restored, its request parameters (what the panel shows) still ask for the check."""
    state, job = robust_job(tmp_path)
    monkeypatch.setattr(workflow, '_snapshot', lambda state, ids: {'d': dict(paths=['/x/d.bam'], files=[])})
    job['_snapshot'] = {'d': dict(paths=['/x/d.bam'], files=[])}
    session = dict(consensus_runs=workflow.export_session_runs(state, {'footprintGroups': [{'consensusJobId': 'j'}]}))
    session['consensus_runs']['active_job'] = None        # restore only (activating it needs open datasets)
    fresh = SimpleNamespace(consensus_workflow_jobs={}, consensus_workflow_lock=threading.RLock(), consensus_workflow_active=None,
                            get_dataset=lambda _: SimpleNamespace(id='d'))
    monkeypatch.setattr(workflow, '_install_result', _recording_install(fresh))
    restored, problems = workflow.restore_session_runs(fresh, session)
    assert problems == [] and restored == ['j']
    result = fresh.installed['result']
    assert result['manifest']['parameters']['recaller']['order_replicates'] == 2
    assert all(isinstance(f['robust'], bool) for f in result['datasets']['d']['cr']['catalog'])


def _recording_install(state):
    def install(state_, result, snapshot, **kw):
        state.installed = dict(result=result, **kw)
        state.consensus_workflow_jobs[kw['job_id']] = dict(job_id=kw['job_id'], status='complete', result=result)
    return install


@pytest.fixture
def public(monkeypatch):
    from services import public_limits, runtime
    monkeypatch.setattr(runtime, '_public_mode', True)
    public_limits.reset_public_limits()
    monkeypatch.setattr(public_limits, '_active_jobs', [])
    yield public_limits
    public_limits.reset_public_limits()


@pytest.mark.parametrize('asked,ran', [(20, 2), (2, 2), (0, 0)])
def test_public_servers_cap_the_read_order_check(client, public, monkeypatch, asked, ran):
    seen = {}
    monkeypatch.setattr(workflow, 'submit', lambda state, request: seen.setdefault('request', request) and {'job_id': 'j'})
    resp = client.post('/api/footprint/consensus/jobs', json={
        'dataset_ids': ['ft'], 'chrom': 'chr1', 'start': 0, 'end': 4_000,
        'parameters': {'cr': {'engine': 'lattice_recaller'}, 'recaller': {'stringency': .8, 'order_replicates': asked}}})
    assert resp.status_code == 200
    assert seen['request']['parameters']['recaller'] == {'stringency': .8, 'order_replicates': ran}
