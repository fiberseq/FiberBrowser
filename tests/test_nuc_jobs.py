"""Nucleosome resubmits reuse a plan or replace it without overlapping workers."""
import json
import threading
from types import SimpleNamespace as NS

import pytest

from services.nuc import engine, inputs, jobs, live


@pytest.fixture
def run(monkeypatch):
    state = NS()
    started, release = threading.Event(), threading.Event()
    cleanup, release_cleanup = threading.Event(), threading.Event()
    calls, calibrations, order = [], [], []
    sources = {d: NS(browser_id=d, label=d, kind='native', paths=[d]) for d in ('a', 'b')}
    monkeypatch.setattr(inputs, 'nuc_source', lambda state, d: sources[d])
    monkeypatch.setattr(inputs, 'browser_read_policy', lambda *a, **kw: {})
    monkeypatch.setattr(engine, 'resolve_settings', lambda p: (
        {'size': 1, **(p or {})}, json.dumps({'size': 1, **(p or {})}, sort_keys=True)))
    monkeypatch.setattr(live, 'source_regions', lambda state, source, c, a, b: [(c, a, b)])

    def config(state, source, *args, **kw):
        calibrations.append(source.browser_id)
        order.append('calibrate')
        return NS(calibrations={}, calibration=NS(summary=lambda: {}))

    def compute(source, regions, settings, cals, policy, *, cancel, progress):
        calls.append((source.browser_id, regions))
        order.append('compute')
        if len(calls) == 1:
            started.set()
            assert release.wait(5), 'test must release the old compute'
            # Even a kernel returning normally after cancellation must finish cancelled.
            progress(10, 3)
        return dict(records=10, computed=3, cached=0)

    def refresh(state, paths):
        if len(calls) == 1 and harness.slow_cleanup:
            cleanup.set()
            assert release_cleanup.wait(5), 'test must release the old cleanup'
        order.append('publish')
        return paths

    monkeypatch.setattr(jobs, 'ensure_config', config)
    monkeypatch.setattr(live, 'compute_regions', compute)
    monkeypatch.setattr(jobs, 'refresh_after', refresh)
    harness = NS(state=state, started=started, release=release, cleanup=cleanup, release_cleanup=release_cleanup,
                 calls=calls, calibrations=calibrations, order=order, slow_cleanup=False,
                 submit=lambda **kw: jobs.submit(state, dict(datasets=['a'], chrom='c', start=0, end=10, **kw)))
    yield harness
    release.set()
    release_cleanup.set()
    for job in list(getattr(state, 'nuc_jobs', {}).values()):
        job['_thread'].join(timeout=5)
        assert not job['_thread'].is_alive()


def test_identical_resubmit_uses_canonical_plan(run):
    request = dict(datasets=['a', 'b'], chrom='c', start=0, end=10,
                   sourceRegions=[dict(datasetId='a', contig='s', start=0, end=20),
                                  dict(datasetId='a', contig='s', start=30, end=40)])
    first = jobs.submit(run.state, request)
    assert run.started.wait(2)
    same = jobs.submit(run.state, dict(datasets=['b', 'a'],
        views=[dict(datasetId=d, chrom='c', start=0, end=10) for d in ('b', 'a')],
        sourceRegions=list(reversed(request['sourceRegions'])), parameters={'size': 1}, workers=1))
    assert same['job_id'] == first['job_id']
    assert not run.state.nuc_jobs[first['job_id']]['_cancel'].is_set()
    run.release.set()
    assert jobs.wait(run.state, first['job_id'], 2)['status'] == 'complete'
    assert len(run.calls) == 2


def test_an_older_pages_sites_field_is_ignored(run):
    """The Sites step left with the panel's Sites tab: a `sites` field from an older page changes nothing (same job,
    no Sites result, calibration and molecule timings only)."""
    request=dict(observations=[dict(obsId='a')],window=dict(chrom='c',start=0,end=10))
    first=run.submit(sites=request)
    assert run.started.wait(2)
    assert run.submit()['job_id']==first['job_id']
    run.release.set()
    done=jobs.wait(run.state,first['job_id'],5)
    assert done['status']=='complete' and 'sites' not in done
    assert set(done['timings'])=={'calibration','molecules'}
    assert all(v>=0 for v in done['timings'].values())
    assert len(run.calls)==1


@pytest.mark.parametrize('change', [
    dict(views=[dict(datasetId='a', chrom='c', start=20, end=30)]),
    dict(parameters={'size': 2}), dict(include_duplicates=True),
    dict(sourceRegions=[dict(datasetId='a', contig='s', start=0, end=10)]),
    dict(datasets=['b']),
])
def test_different_request_replaces_the_old_run(run, change):
    first = run.submit()
    assert run.started.wait(2)
    second = jobs.submit(run.state, {**dict(datasets=['a'], chrom='c', start=0, end=10), **change})
    assert second['job_id'] != first['job_id']
    assert second['status'] == 'queued'
    assert second['message'] == 'Waiting for the previous run to stop'
    assert jobs.get_job(run.state, first['job_id'])['status'] == 'cancelling'
    assert run.state.nuc_jobs[first['job_id']]['_cancel'].is_set()
    run.release.set()
    old = jobs.wait(run.state, first['job_id'], 2)
    assert (old['status'], old['message']) == ('cancelled', 'Replaced by a newer run')
    assert jobs.wait(run.state, second['job_id'], 2)['status'] == 'complete'


def test_replacement_waits_for_worker_cleanup_before_calibration_or_compute(run, monkeypatch):
    run.slow_cleanup = True
    first = run.submit()
    assert run.started.wait(2)
    second = run.submit(parameters={'size': 2})
    original = jobs.ensure_config

    def config(*args, **kw):
        assert not run.state.nuc_jobs[first['job_id']]['_thread'].is_alive()
        return original(*args, **kw)

    monkeypatch.setattr(jobs, 'ensure_config', config)
    run.release.set()
    assert run.cleanup.wait(2)
    assert run.order == ['calibrate', 'compute']
    assert jobs.get_job(run.state, second['job_id'])['status'] == 'queued'
    run.release_cleanup.set()
    assert jobs.wait(run.state, second['job_id'], 2)['status'] == 'complete'
    assert run.order == ['calibrate', 'compute', 'publish', 'calibrate', 'compute', 'publish']


def test_interrupted_compute_keeps_the_replacement_message(run, monkeypatch):
    original = live.compute_regions

    def compute(*args, **kw):
        stats = original(*args, **kw)
        if kw['cancel'].is_set():
            raise InterruptedError('cancelled')
        return stats

    monkeypatch.setattr(live, 'compute_regions', compute)
    first = run.submit()
    assert run.started.wait(2)
    second = run.submit(parameters={'size': 2})
    run.release.set()
    done = jobs.wait(run.state, first['job_id'], 2)
    assert (done['status'], done['message']) == ('cancelled', 'Replaced by a newer run')
    assert jobs.wait(run.state, second['job_id'], 2)['status'] == 'complete'


def test_cancelling_a_waiting_job_finishes_without_computing(run):
    first = run.submit()
    assert run.started.wait(2)
    second = run.submit(parameters={'size': 2})
    assert run.submit(parameters={'size': 2})['job_id'] == second['job_id']  # queued reuse
    jobs.cancel(run.state, second['job_id'])
    done = jobs.wait(run.state, second['job_id'], 2)
    assert (done['status'], done['message']) == ('cancelled', 'Cancelled')
    assert run.state.nuc_jobs[first['job_id']]['_thread'].is_alive()
    assert len(run.calls) == len(run.calibrations) == 1


def test_user_cancelling_job_is_not_reused(run):
    first = run.submit()
    assert run.started.wait(2)
    jobs.cancel(run.state, first['job_id'])
    second = run.submit()
    assert second['job_id'] != first['job_id']
    assert second['status'] == 'queued'
    assert len(run.calibrations) == 1
    run.release.set()
    assert jobs.wait(run.state, first['job_id'], 2)['message'] == 'Cancelled'
    assert jobs.wait(run.state, second['job_id'], 2)['status'] == 'complete'


def test_superseding_a_waiter_still_waits_for_the_original_worker(run):
    first = run.submit()
    assert run.started.wait(2)
    second = run.submit(parameters={'size': 2})
    third = run.submit(parameters={'size': 3})
    done = jobs.wait(run.state, second['job_id'], 2)
    assert (done['status'], done['message']) == ('cancelled', 'Replaced by a newer run')
    assert jobs.get_job(run.state, third['job_id'])['status'] == 'queued'
    assert len(run.calls) == 1
    run.release.set()
    assert jobs.wait(run.state, third['job_id'], 2)['status'] == 'complete'
    assert len(run.calls) == 2
    assert jobs.wait(run.state, first['job_id'], 2)['status'] == 'cancelled'


def test_pruning_keeps_live_jobs(run, monkeypatch):
    monkeypatch.setattr(jobs, 'MAX_JOBS_KEPT', 2)
    first = run.submit()
    assert run.started.wait(2)
    second = run.submit(parameters={'size': 2})
    third = run.submit(parameters={'size': 3})
    jobs.wait(run.state, second['job_id'], 2)
    assert first['job_id'] in run.state.nuc_jobs
    assert third['job_id'] in run.state.nuc_jobs
    run.release.set()
    jobs.wait(run.state, third['job_id'], 2)
    fourth = run.submit(parameters={'size': 4})
    jobs.wait(run.state, fourth['job_id'], 2)
    assert len(jobs.list_jobs(run.state)) == 2
    assert first['job_id'] not in run.state.nuc_jobs
