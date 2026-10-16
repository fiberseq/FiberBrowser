"""Find classes: where a run's region came from (fb-n5-classregion).

The panel sends region_source / region_label with a run ("peaks", "the selected peak"); the run keeps them in its
request, and a session that carries the run brings them back, so its results still say what was analysed."""
import threading
from types import SimpleNamespace

from services import consensus_workflow as workflow
from test_consensus_lattice_recaller import planted_payload


def test_a_saved_session_keeps_where_the_region_came_from(tmp_path, monkeypatch):
    fh_workflow, _ = workflow._runtime()
    parameters = {'cr': {'engine': 'lattice_recaller'}, 'recaller': {'learned_spots': False}}
    result = fh_workflow.run_workflow(planted_payload(), parameters, tmp_path / 'run')
    job = dict(job_id='j', status='complete', result=result, filters=workflow.schema()['display_defaults'],
               request=dict(parameters=parameters, region_source='peaks', region_label='the selected peak'),
               _snapshot={'d': dict(paths=['/x/d.bam'], files=[])})
    job['index'], job['layers'] = workflow._index(result)
    state = SimpleNamespace(consensus_workflow_jobs={'j': job}, consensus_workflow_lock=threading.RLock(), consensus_workflow_active=None)
    session = dict(consensus_runs=workflow.export_session_runs(state, {'footprintGroups': [{'consensusJobId': 'j'}]}))

    monkeypatch.setattr(workflow, '_snapshot', lambda state, ids: {'d': dict(paths=['/x/d.bam'], files=[])})
    monkeypatch.setattr(workflow, '_register', lambda state, job: None)
    fresh = SimpleNamespace(consensus_workflow_jobs={}, consensus_workflow_lock=threading.RLock(), consensus_workflow_active=None,
                            get_dataset=lambda _: SimpleNamespace(id='d'))
    restored, problems = workflow.restore_session_runs(fresh, session)
    assert problems == [] and restored == ['j']
    request = workflow.get_job(fresh, 'j')['request']
    assert request['region_source'] == 'peaks' and request['region_label'] == 'the selected peak'


def test_region_meta_keeps_only_short_strings():
    assert workflow._region_meta({'region_source': 'view', 'region_label': 'x' * 500, 'chrom': 'chr1'}) == {
        'region_source': 'view', 'region_label': 'x' * 200}
    assert workflow._region_meta({'region_source': 3}) == {} and workflow._region_meta(None) == {}
