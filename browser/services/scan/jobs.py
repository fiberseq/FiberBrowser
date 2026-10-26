"""``ScanJobManager``: live scans into the browser's scan cache through ``fiberhmm.scan.run_units``.

One job scans the planned units (``planning.build_plan``) module by module, each module into its own cache
directory keyed by (datasets, reference, read policy, unit mode, module version and settings), so a module subset
never rewrites another module's results. Grid (view) directories accumulate: every job passes the union of the
units scanned there before and the new ones, with ``continue_run=True, extend=True``, and ``run_units`` reuses
every unit whose key still matches. Units an open scan already computed with the same key are not computed at
all (precomputed). When a module directory is done it is opened in the registry like any scan (``source =
'cache'``), so there is one reader and one format.

The job runs on a single-worker executor of its own (the consensus pattern: per-session job dicts, progress
through ``consensus_progress.update_progress``, cancellation by event: ``run_units`` stops at the next unit).
"""
from __future__ import annotations

import contextvars
import json
import os
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Optional

from services.consensus_progress import finish_progress, update_progress

_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix='fiberhmm-scan')
_INIT_LOCK = threading.Lock()
MAX_JOBS_KEPT = 24


class ScanCancelled(Exception):
    pass


def _session(state):
    with _INIT_LOCK:
        if 'scan_jobs' not in state.__dict__:
            state.scan_jobs = {}
            state.scan_jobs_lock = threading.RLock()
    return state.scan_jobs, state.scan_jobs_lock


def _summary(job: dict) -> dict:
    return {k: v for k, v in job.items() if not k.startswith('_')}


class _Progress:
    """run_units' progress sink: JSON-able job progress (units completed of total), per module."""

    def __init__(self, job, lock, module, index, count):
        self.job, self.lock, self.module, self.index, self.count = job, lock, module, index, count

    def report(self, stage, message, **work):
        if self.job['_cancel'].is_set():
            return
        with self.lock:
            done, total = work.get('completed'), work.get('total')
            extra = {}
            if isinstance(done, int) and isinstance(total, int) and 0 <= done <= total:
                extra = dict(completed=done, total=total, unit='units')
            update_progress(self.job, f'{self.module} ({self.index + 1}/{self.count})', str(message), task=self.module,
                            **extra)


def _plan_file(cache_dir: str) -> Path:
    return Path(str(cache_dir).rstrip('/') + '.plan.json')


def _previous_units(cache_dir: str):
    from fiberhmm.scan.types import ScanUnit
    p = _plan_file(cache_dir)
    if not p.is_file() or not (Path(cache_dir) / 'manifest.json').is_file():
        return []
    try:
        return [ScanUnit.from_json(u) for u in json.loads(p.read_text()).get('units') or []]
    except (OSError, ValueError, TypeError, KeyError):
        return []


def module_units(plan: dict, module: dict):
    """(units to pass to run_units, units_info, number to compute) for one module of a plan, or None when the
    cache directory already holds exactly what is needed."""
    from fiberhmm.scan.types import ScanUnit
    from .planning import union_units
    cov = plan['coverage'][module['name']]
    needed = [ScanUnit.from_json(u) for u in plan['units'] if u['unit_id'] not in cov['precomputed']]
    if not needed:
        return None
    info = dict(plan['units_info'])
    if plan['scope'] == 'view':
        previous = _previous_units(module['cache_dir'])
        units = union_units(previous, needed)
        if previous and {u.unit_id for u in units} == {u.unit_id for u in previous} and not cov['to_compute']:
            return None
        order = list(dict.fromkeys(u.chrom for u in units))
        info['contigs'] = order
    else:
        units = needed
        if (Path(module['cache_dir']) / 'manifest.json').is_file() and not cov['to_compute']:
            return None
    return units, info, len([u for u in units if u.unit_id in set(cov['to_compute'])])


def submit(state, request: dict, *, runner=None) -> dict:
    """Plan and queue a live scan; returns the job summary. ``runner`` replaces ``run_units`` (tests)."""
    from .planning import build_plan
    plan = build_plan(state, request)
    jobs, lock = _session(state)
    with lock:
        if any(j['status'] in ('queued', 'running', 'cancelling') for j in jobs.values()):
            raise ValueError('A scan is already running in this session: wait for it or cancel it')
        job_id = uuid.uuid4().hex[:12]
        job = dict(job_id=job_id, status='queued', stage='queued', message='Queued', created_at=time.time(),
                   scope=plan['scope'], where=plan['where'], modules=plan['module_names'],
                   datasets=[dict(datasetId=d['browser_id'], label=d['label'], scanDataset=d['dataset_id']) for d in plan['datasets']],
                   coverage={m: dict(total=c['total'], precomputed=len(c['precomputed']), cached=len(c['cached']),
                                     toCompute=len(c['to_compute'])) for m, c in plan['coverage'].items()},
                   cli=plan['cli'], scans=[], computed_units=0, _cancel=threading.Event(), _plan=plan)
        jobs[job_id] = job
        for old in sorted(jobs.values(), key=lambda j: j['created_at'])[:-MAX_JOBS_KEPT]:
            if old['status'] not in ('queued', 'running', 'cancelling'):
                jobs.pop(old['job_id'], None)

    def worker():
        from fiberhmm.scan import run_units as fh_run_units
        from .registry import open_scan
        run = runner or fh_run_units
        datasets = [dict(dataset_id=d['dataset_id'], paths=d['paths'], chemistry=d['chemistry']) for d in plan['datasets']]
        try:
            with lock:
                job['status'] = 'running'
                update_progress(job, 'starting', 'Starting')
            count = len(plan['modules'])
            for i, module in enumerate(plan['modules']):
                if job['_cancel'].is_set():
                    raise ScanCancelled()
                planned = module_units(plan, module)
                if planned is not None:
                    units, info, computing = planned
                    Path(module['cache_dir']).parent.mkdir(parents=True, exist_ok=True)
                    existing = (Path(module['cache_dir']) / 'manifest.json').is_file() or \
                        (Path(module['cache_dir']) / 'work' / 'scan_key.json').is_file()
                    params = {module['name']: plan['parameters'][module['name']]} if module['name'] in plan['parameters'] else {}
                    run(datasets, (tuple(units), info), modules=[module['name']], params=params,
                        read_policy=plan['raw_read_policy'], out=module['cache_dir'], annotate=False,
                        progress=_Progress(job, lock, module['name'], i, count), cancel=job['_cancel'],
                        cores=plan['workers'], window_jobs=0, continue_run=existing, extend=existing)
                    if plan['scope'] == 'view':
                        tmp = _plan_file(module['cache_dir']).with_suffix('.tmp')
                        tmp.write_text(json.dumps(dict(units=[u.to_json() for u in units]), sort_keys=True))
                        os.replace(tmp, _plan_file(module['cache_dir']))
                    with lock:
                        job['computed_units'] += computing
                if (Path(module['cache_dir']) / 'manifest.json').is_file():
                    scan = open_scan(state, module['cache_dir'], source='cache',
                                     label=f"Browser scan · {module['name']}")
                    with lock:
                        job['scans'].append(scan.scan_id)
            with lock:
                if job['_cancel'].is_set():
                    raise ScanCancelled()
                job['status'] = 'complete'
                job['message'] = 'Done'
                finish_progress(job)
        except (ScanCancelled, KeyboardInterrupt):
            with lock:
                job['status'] = 'cancelled'
                job['message'] = 'Cancelled'
        except BaseException as error:   # noqa: BLE001 - the job records every failure
            with lock:
                job['status'] = 'error'
                job['message'] = str(error) or type(error).__name__
                job['error'] = job['message']
        finally:
            with lock:
                job['finished_at'] = time.time()

    job['_future'] = _EXECUTOR.submit(contextvars.copy_context().run, worker)
    return _summary(job)


def get_job(state, job_id: str) -> dict:
    jobs, lock = _session(state)
    with lock:
        job = jobs.get(job_id)
        if job is None:
            raise KeyError(job_id)
        return _summary(job)


def list_jobs(state) -> list:
    jobs, lock = _session(state)
    with lock:
        return [_summary(j) for j in sorted(jobs.values(), key=lambda j: j['created_at'])]


def cancel(state, job_id: str) -> dict:
    jobs, lock = _session(state)
    with lock:
        job = jobs.get(job_id)
        if job is None:
            raise KeyError(job_id)
        if job['status'] in ('queued', 'running'):
            job['_cancel'].set()
            job['status'] = 'cancelling'
            job['message'] = 'Cancelling after the current unit'
        return _summary(job)


def wait(state, job_id: str, timeout: Optional[float] = None) -> dict:
    """Block until a job finishes (tests and scripts)."""
    jobs, lock = _session(state)
    with lock:
        future = jobs[job_id].get('_future')
    if future is not None:
        future.result(timeout=timeout)
    return get_job(state, job_id)
