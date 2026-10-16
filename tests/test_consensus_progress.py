from services.consensus_progress import update_progress, finish_progress
import pytest


def test_stage_counters_and_cancellation_heartbeat_do_not_lie():
    job={}
    update_progress(job,'cr_classification','F001: fitting fold 2/10',
        dataset_id='ddda',completed=3,total=20,unit='families')
    old=job['progress'].copy()
    assert old['fraction']==.15
    update_progress(job,'cr',None)
    assert job['stage']=='cr_classification'
    assert job['progress']==old
    update_progress(job,'cr_classification','F002: recipients',
        dataset_id='ddda',completed=4,total=20,unit='families')
    assert job['progress']['stage_started_at']==old['stage_started_at']
    assert job['progress']['fraction']==.2


def test_next_stage_has_its_own_count_not_a_misleading_global_percent():
    job={}
    update_progress(job,'cr_nomination','done',dataset_id='d',completed=70,total=70)
    update_progress(job,'cr_classification','fitting',dataset_id='d',completed=0,total=322)
    assert job['progress']['fraction']==0
    update_progress(job,'saving_models','Writing models')
    assert job['progress']['fraction'] is None
    assert job['progress']['completed'] is None


def test_caller_completion_waits_for_atomic_browser_installation():
    job={'status':'running'}
    update_progress(job,'complete','caller done')
    assert job['stage']=='finalizing'
    assert job['progress']['fraction'] is None
    assert job['status']=='running'
    finish_progress(job)
    assert job['progress']['fraction']==1


@pytest.mark.parametrize('complete,total',[(2,1),(-1,4),(1,-4),(1,2.5)])
def test_reject_invalid_counters(complete,total):
    with pytest.raises(ValueError):update_progress({},'cr','work',completed=complete,total=total)


def test_empty_catalog_does_not_divide_by_zero():
    job={};update_progress(job,'xcr','No pairs',completed=0,total=0)
    assert job['progress']['fraction'] is None


def test_job_polling_and_cancel_remain_live_during_index_build(monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from types import SimpleNamespace
    import threading
    from services import consensus_workflow as service
    # This tests job-lock responsiveness, not cold module/disk I/O latency.
    # Preload the artifact helper before starting the timed synchronization.
    from fiberhmm.inference.consensus import artifacts
    monkeypatch.setattr(artifacts,'write_json',lambda *args:None)
    entered=threading.Event();release=threading.Event();registered=[]
    class Cancelled(Exception):pass
    options={'compute':SimpleNamespace(maximum_region_bp=1000),'cross':SimpleNamespace(enabled=False)}
    def run(payload,parameters,out,progress):
        progress.report('cr_classification','fitting',completed=3,total=4,unit='families')
        progress('complete','inference done')
        return {'datasets':{},'cross':{'status':'disabled'}}
    def index(result):
        entered.set()
        assert release.wait(10)
        return {},[]
    monkeypatch.setattr(service,'_runtime',lambda:(SimpleNamespace(ConsensusCancelled=Cancelled,run_analysis=run),
        SimpleNamespace(parse_options=lambda p:options)))
    monkeypatch.setattr(service,'schema',lambda:{'display_defaults':{}})
    monkeypatch.setattr(service,'_snapshot',lambda *a:{'d':{'paths':[]}})
    monkeypatch.setattr(service,'load_payload',lambda *a:{'strata':[{'units':[{}]}]})
    monkeypatch.setattr(service,'_index',index)
    monkeypatch.setattr(service,'_register',lambda *a:registered.append(True))
    state=SimpleNamespace(get_dataset=lambda ds:SimpleNamespace(family_scan_chemistry='ddda'))
    with ThreadPoolExecutor(max_workers=1) as executor:
        monkeypatch.setattr(service,'_EXECUTOR',executor)
        try:
            job=service.submit(state,{'dataset_ids':['d'],'chrom':'chr1','start':0,'end':100})
            assert entered.wait(10)
            # If indexing holds the job lock these calls deadlock until timeout.
            report=service.get_job(state,job['job_id'])
            assert report['stage']=='finalizing' and report['status']=='running'
            assert report['progress']['fraction'] is None
            assert service.cancel(state,job['job_id'])['status']=='cancelling'
        finally:release.set()
        state.consensus_workflow_jobs[job['job_id']]['_future'].result(timeout=10)
    assert service.get_job(state,job['job_id'])['status']=='cancelled'
    assert not registered
