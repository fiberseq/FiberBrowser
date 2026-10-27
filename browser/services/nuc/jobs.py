"""Nucleosome jobs: calibrate each dataset (once) and compute live outputs for a view's records.

One job takes datasets, a view and optional source regions (graph paths), and per dataset:

1. resolves its calibration record (``services.nuc.calibration``: a bound scan's, the cache's, else computed);
2. makes that record and the settings the dataset's active configuration (``active_config``);
3. computes outputs for every record of the view (native: the view; live lift: the source windows of the view's
   lift plan; plus any explicit source regions) and stores them (``services.nuc.store``);
4. drops the read caches of every dataset reading those files and declares the ``nucsz``/``nucseg`` layers, so the
   next read fetch carries them (the dataset's ``source_identity`` changes with the store's revision).

Jobs run on a single-worker executor of their own (the scan jobs' pattern: per-session job dicts, progress through
``consensus_progress.update_progress``, cancellation by event, checked between records).
"""
from __future__ import annotations

import contextvars
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Dict, List, Optional

from services.consensus_progress import finish_progress, update_progress

_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix='fiberbrowser-nuc')
_INIT_LOCK = threading.Lock()
MAX_JOBS_KEPT = 24
MAX_VIEW_BP = 2_000_000


@dataclass
class ActiveConfig:
    settings: dict
    settings_hash: str
    calibration: object        # CalibrationRef
    policy: dict

    def summary(self) -> dict:
        return dict(settingsHash=self.settings_hash, calibration=self.calibration.summary())


def _session(state):
    with _INIT_LOCK:
        if 'nuc_jobs' not in state.__dict__:
            state.nuc_jobs = {}
            state.nuc_jobs_lock = threading.RLock()
            state.nuc_active = {}
    return state.nuc_jobs, state.nuc_jobs_lock


def active_config(state, dataset_id: str) -> Optional[ActiveConfig]:
    _session(state)
    return state.nuc_active.get(dataset_id)


def _summary(job: dict) -> dict:
    return {k: v for k, v in job.items() if not k.startswith('_')}


def _cores(request: dict) -> int:
    import os
    want = request.get('workers')
    n = int(want) if isinstance(want, int) and want > 0 else max(1, min(4, (os.cpu_count() or 2) // 2))
    return max(1, min(n, os.cpu_count() or 1))


def ensure_config(state, source, settings: dict, settings_hash: str, policy: dict, *, cores: int = 1,
                  progress=None, cancel=None) -> ActiveConfig:
    """The dataset's active configuration for these settings: a stored calibration, else one computed now."""
    from .calibration import compute_calibration, find_calibration
    from .engine import module_version
    version = module_version()
    filters = policy.get('filters') or {}
    cal = find_calibration(state, source, settings_hash, version, filters)
    if cal is None:
        cal = compute_calibration(source, settings, settings_hash, version, policy, cores=cores, progress=progress,
                                  cancel=cancel)
    cfg = ActiveConfig(settings, settings_hash, cal, policy)
    _session(state)
    state.nuc_active[source.browser_id] = cfg
    return cfg


def refresh_after(state, paths) -> List[str]:
    """Drop the read caches of the datasets reading ``paths`` and (re)declare their nuc layers."""
    from services.dataset_registration import invalidate_dataset_caches
    from .inputs import datasets_using
    from .layers import declare_layers
    touched = sorted({d for p in paths for d in datasets_using(state, p)})
    for ds_id in touched:
        try:
            invalidate_dataset_caches(state, ds_id)
        except Exception:   # pragma: no cover - caches are rebuilt on the next miss anyway
            pass
    declare_layers(state, set(touched))
    return touched


def plan_request(state, request: dict) -> dict:
    """Validated inputs of a job (raises ValueError with a message for the user)."""
    from .engine import resolve_settings
    from .inputs import nuc_source
    ids = [str(d) for d in dict.fromkeys(request.get('datasets') or [])]
    if not ids:
        raise ValueError('Choose at least one dataset')
    sources = [nuc_source(state, d) for d in ids]
    chrom = str(request.get('chrom') or '')
    start, end = int(request.get('start') or 0), int(request.get('end') or 0)
    extra = request.get('sourceRegions') or []
    if (not chrom or end <= start) and not extra:
        raise ValueError('Give a view (chrom, start, end) or source regions')
    if chrom and end - start > MAX_VIEW_BP:
        raise ValueError(f'The view is {end - start:,} bp; the nucleosome panel computes up to {MAX_VIEW_BP:,} bp '
                         'live (scan larger regions with fiberhmm-scan and open the scan)')
    settings, sh = resolve_settings(request.get('parameters') or None)
    regions: Dict[str, list] = {}
    for r in extra:
        try:
            regions.setdefault(str(r['datasetId']), []).append((str(r['contig']), int(r['start']), int(r['end'])))
        except (KeyError, TypeError, ValueError):
            raise ValueError('sourceRegions: {datasetId, contig, start, end} each') from None
    return dict(sources=sources, chrom=chrom, start=start, end=end, settings=settings, settings_hash=sh,
                source_regions=regions, include_duplicates=bool(request.get('include_duplicates')),
                cores=_cores(request))


def submit(state, request: dict) -> dict:
    from .inputs import browser_read_policy
    from .live import compute_regions, source_regions
    plan = plan_request(state, request)
    jobs, lock = _session(state)
    with lock:
        if any(j['status'] in ('queued', 'running', 'cancelling') for j in jobs.values()):
            raise ValueError('A nucleosome job is already running in this session: wait for it or cancel it')
        job_id = uuid.uuid4().hex[:12]
        job = dict(job_id=job_id, status='queued', stage='queued', message='Queued', created_at=time.time(),
                   datasets=[dict(datasetId=s.browser_id, label=s.label, kind=s.kind) for s in plan['sources']],
                   view=dict(chrom=plan['chrom'], start=plan['start'], end=plan['end']),
                   settingsHash=plan['settings_hash'], results={}, _cancel=threading.Event())
        jobs[job_id] = job
        for old in sorted(jobs.values(), key=lambda j: j['created_at'])[:-MAX_JOBS_KEPT]:
            if old['status'] not in ('queued', 'running', 'cancelling'):
                jobs.pop(old['job_id'], None)

    def worker():
        cancel = job['_cancel']
        try:
            with lock:
                job['status'] = 'running'
                update_progress(job, 'starting', 'Starting')
            n = len(plan['sources'])
            for i, source in enumerate(plan['sources']):
                if cancel.is_set():
                    raise InterruptedError('cancelled')
                policy = browser_read_policy(state, include_duplicates=plan['include_duplicates'])

                def cal_progress(message, _label=source.label, _i=i):
                    with lock:
                        update_progress(job, f'calibrating ({_i + 1}/{n})', f'{_label}: {message}', task='calibration')
                with lock:
                    update_progress(job, f'calibrating ({i + 1}/{n})', f'{source.label}: calibration', task='calibration')
                cfg = ensure_config(state, source, plan['settings'], plan['settings_hash'], policy,
                                    cores=plan['cores'], progress=cal_progress, cancel=cancel)
                regions = []
                if plan['chrom'] and plan['end'] > plan['start']:
                    regions += source_regions(state, source, plan['chrom'], plan['start'], plan['end'])
                regions += plan['source_regions'].get(source.browser_id, [])

                def rec_progress(records, computed, _label=source.label, _i=i):
                    with lock:
                        update_progress(job, f'molecules ({_i + 1}/{n})',
                                        f'{_label}: {computed:,} molecules computed of {records:,} records',
                                        task='molecules')
                stats = compute_regions(source, regions, plan['settings'], cfg.calibration, policy,
                                        progress=rec_progress, cancel=cancel)
                touched = refresh_after(state, source.paths)
                with lock:
                    job['results'][source.browser_id] = dict(calibration=cfg.calibration.summary(), datasets=touched,
                                                             **{k: v for k, v in stats.items() if k != 'fraction'})
            with lock:
                job['status'] = 'complete'
                job['message'] = 'Done'
                finish_progress(job)
        except (InterruptedError, KeyboardInterrupt):
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
            job['message'] = 'Cancelling'
        return _summary(job)


def wait(state, job_id: str, timeout: Optional[float] = None) -> dict:
    jobs, lock = _session(state)
    with lock:
        future = jobs[job_id].get('_future')
    if future is not None:
        future.result(timeout=timeout)
    return get_job(state, job_id)
