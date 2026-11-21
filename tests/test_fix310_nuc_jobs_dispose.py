"""3.1.0 audit fix: a session import cancels the nucleosome jobs of the replaced session and drops its active
configurations; a job still calibrating when the session is disposed never installs its configuration."""
from __future__ import annotations

import threading
from types import SimpleNamespace as NS

import pytest


def _state():
    from state.browser_state import BrowserState
    return BrowserState(None)


def test_dispose_cancels_jobs_and_clears_active_configs(monkeypatch):
    from services.nuc import calibration, jobs
    st = _state()
    gate, entered = threading.Event(), threading.Event()
    source = NS(browser_id='ds0', label='Synthetic', kind='native', paths=['/data/a.bam'])
    cal = NS(settings_hash='h', digest='d', summary=lambda: {})

    def blocking_find(*_a, **_k):
        entered.set()
        gate.wait(10)
        return {'/data/a.bam': cal}
    monkeypatch.setattr(calibration, 'find_calibration', blocking_find)
    monkeypatch.setattr('services.nuc.engine.module_version', lambda: 'test')
    monkeypatch.setattr(jobs, 'plan_request', lambda state, request: dict(
        sources=[source], chrom='chrR', start=0, end=10, views={'ds0': [('chrR', 0, 10)]}, settings={},
        settings_hash='h', source_regions={}, include_duplicates=False, include_qcfail=False, hide_uncalled=True,
        cores=1))
    monkeypatch.setattr('services.nuc.compute_pool.compute_workers', lambda state: 1)
    monkeypatch.setattr('services.nuc.inputs.browser_read_policy', lambda state, **k: {'filters': {}})
    # an older session's configuration of a dataset id the new session may reuse
    jobs._session(st)
    st.nuc_active['ds1'] = jobs.ActiveConfig({}, 'old', {'/data/b.bam': cal}, {})

    job = jobs.submit(st, {})
    assert entered.wait(10)
    jobs.dispose_session(st)
    assert jobs.active_config(st, 'ds1') is None
    gate.set()
    done = jobs.wait(st, job['job_id'], timeout=10)
    assert done['status'] == 'cancelled'
    assert 'another session' in done['message']
    assert jobs.active_config(st, 'ds0') is None      # the disposed job never installed its configuration


def test_session_import_disposes_nucleosome_work(monkeypatch):
    from services import sessions_endpoint
    from services.nuc import jobs
    seen = []
    monkeypatch.setattr(jobs, 'dispose_session', lambda state: seen.append(state))
    st = _state()
    req = NS(session={'version': '2.0', 'datasets': []}, path_mapping=None)
    try:
        sessions_endpoint.import_session_for_request(st, req)
    except Exception:      # noqa: BLE001 - a minimal session may stop later in the import; disposal comes first
        pass
    assert seen == [st]


def test_a_submission_still_planning_when_the_session_is_disposed_never_registers(monkeypatch):
    """Recheck: a request in plan_request while a session import disposes the jobs registered afterwards, ran
    uncancelled and installed the old BAM's calibration under the reused dataset id. The session generation is
    captured before planning and checked under the lock before registration (and before installing)."""
    from services.nuc import calibration, jobs
    st = _state()
    planning, release = threading.Event(), threading.Event()
    source = NS(browser_id='ds0', label='Synthetic', kind='native', paths=['/data/a.bam'])
    cal = NS(settings_hash='h', digest='d', summary=lambda: {})
    monkeypatch.setattr(calibration, 'find_calibration', lambda *_a, **_k: {'/data/a.bam': cal})
    monkeypatch.setattr('services.nuc.engine.module_version', lambda: 'test')

    def gated_plan(state, request):
        planning.set()
        release.wait(10)
        return dict(sources=[source], chrom='chrR', start=0, end=10, views={'ds0': [('chrR', 0, 10)]}, settings={},
                    settings_hash='h', source_regions={}, include_duplicates=False, include_qcfail=False,
                    hide_uncalled=True, cores=1)
    monkeypatch.setattr(jobs, 'plan_request', gated_plan)
    monkeypatch.setattr('services.nuc.compute_pool.compute_workers', lambda state: 1)
    monkeypatch.setattr('services.nuc.inputs.browser_read_policy', lambda state, **k: {'filters': {}})
    monkeypatch.setattr('services.nuc.live.source_regions', lambda *a, **k: [])
    monkeypatch.setattr('services.nuc.live.compute_regions', lambda *a, **k: {})
    monkeypatch.setattr('services.nuc.reference.start_background', lambda *a, **k: None)
    outcome = {}

    def run():
        try:
            outcome['job'] = jobs.submit(st, {})
        except ValueError as error:
            outcome['error'] = str(error)
    thread = threading.Thread(target=run)
    thread.start()
    assert planning.wait(10)
    jobs.dispose_session(st)                          # the session import, while the request is still planning
    release.set()
    thread.join(10)
    if 'job' in outcome:                              # (before the fix: registered and run to completion)
        jobs.wait(st, outcome['job']['job_id'], timeout=10)
    assert 'another session' in outcome.get('error', '').lower(), outcome
    assert jobs.list_jobs(st) == []
    assert jobs.active_config(st, 'ds0') is None
