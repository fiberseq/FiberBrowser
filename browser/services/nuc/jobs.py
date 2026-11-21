"""Nucleosome jobs: calibrate each dataset (once) and compute live outputs for a view's records.

One job takes datasets, a view and optional source regions (graph paths), and per dataset:

1. resolves its calibration record (``services.nuc.calibration``: a bound scan's, the cache's, else computed);
2. makes that record and the settings the dataset's active configuration (``active_config``);
3. computes outputs for every record of the view (native: the view; live lift: the source windows of the view's
   lift plan; plus any explicit source regions) and stores them (``services.nuc.store``);
4. (regularity is not computed here: ``services.nuc.regularity`` computes tiles on demand)
5. drops the read caches of every dataset reading those files and declares the ``nucsz``/``nucseg``/``nucreg`` layers, so the
   next read fetch carries them (the dataset's ``source_identity`` changes with the store's revision).

Each job waits for the workers it replaces, then takes the compute lock (one nucleosome compute at a time).
Progress uses ``consensus_progress.update_progress``; cancellation is checked while waiting and between records.
"""
from __future__ import annotations

import contextvars
import threading
import time
import uuid
from dataclasses import dataclass
from typing import Dict, List, Optional

from services.consensus_progress import finish_progress, update_progress

_COMPUTE_LOCK = threading.Lock()
_INIT_LOCK = threading.Lock()
_LIVE = ('queued', 'running', 'cancelling')
_REPLACED = 'Replaced by a newer run'
MAX_JOBS_KEPT = 24
MAX_VIEW_BP = 2_000_000


@dataclass
class ActiveConfig:
    settings: dict
    settings_hash: str
    calibrations: dict         # real path -> CalibrationRef (files of several scan datasets keep their own record)
    policy: dict

    @property
    def calibration(self):
        """The first file's record (one record for every file unless the files come from several scan datasets)."""
        return next(iter(self.calibrations.values()))

    def config_for(self, path: str):
        from .inputs import real
        cal = self.calibrations.get(path) or self.calibrations.get(real(path))
        return (cal.settings_hash, cal.digest) if cal is not None else None

    def summary(self) -> dict:
        digests = {c.digest for c in self.calibrations.values()}
        return dict(settingsHash=self.settings_hash, calibration=self.calibration.summary(),
                    perFile=len(digests) > 1)


def _session(state):
    with _INIT_LOCK:
        if 'nuc_jobs' not in state.__dict__:
            state.nuc_jobs = {}
            state.nuc_jobs_lock = threading.RLock()
            state.nuc_active = {}
            # Moved by dispose_session (a session import): work planned under an older generation never registers
            # a job nor installs a configuration in the replacement session.
            state.nuc_session_generation = 0
    return state.nuc_jobs, state.nuc_jobs_lock


def session_generation(state) -> int:
    _session(state)
    return state.nuc_session_generation


def active_config(state, dataset_id: str) -> Optional[ActiveConfig]:
    _session(state)
    return state.nuc_active.get(dataset_id)


def config_identity(cfg: Optional[ActiveConfig]) -> Optional[tuple]:
    """A content identity of an active configuration for response-cache keys (never ``id()``, which a later object
    can reuse): the settings hash, each file's calibration record digest and the read policy."""
    if cfg is None:
        return None
    import json
    calibrations = getattr(cfg, 'calibrations', None)
    if calibrations is None:      # a configuration-like object without per-file records: its one record
        cal = getattr(cfg, 'calibration', None)
        calibrations = {'': cal} if cal is not None else {}
    cals = tuple(sorted((str(p), str(getattr(c, 'settings_hash', '')), str(getattr(c, 'digest', c)))
                        for p, c in calibrations.items()))
    return (str(getattr(cfg, 'settings_hash', '')), cals,
            json.dumps(getattr(cfg, 'policy', None), sort_keys=True, default=str))


def _summary(job: dict) -> dict:
    return {k: v for k, v in job.items() if not k.startswith('_')}


def _cores(request: dict) -> int:
    import os
    want = request.get('workers')
    n = int(want) if isinstance(want, int) and want > 0 else max(1, min(4, (os.cpu_count() or 2) // 2))
    return max(1, min(n, os.cpu_count() or 1))


def ensure_config(state, source, settings: dict, settings_hash: str, policy: dict, *, cores: int = 1,
                  progress=None, cancel=None, generation: Optional[int] = None) -> ActiveConfig:
    """The dataset's active configuration for these settings: a stored calibration, else one computed now."""
    from .calibration import compute_calibration, find_calibration
    from .engine import module_version
    version = module_version()
    filters = policy.get('filters') or {}
    cals = find_calibration(state, source, settings_hash, version, filters)
    if cals is None:
        cal = compute_calibration(source, settings, settings_hash, version, policy, cores=cores, progress=progress,
                                  cancel=cancel)
        cals = {p: cal for p in source.paths}
    cfg = ActiveConfig(settings, settings_hash, cals, policy)
    _jobs, lock = _session(state)
    with lock:
        # a job cancelled meanwhile (replaced, or its session disposed) never installs its configuration
        if cancel is not None and getattr(cancel, 'is_set', None) is not None and cancel.is_set():
            raise InterruptedError('cancelled')
        if generation is not None and generation != state.nuc_session_generation:
            raise InterruptedError('cancelled')
        state.nuc_active[source.browser_id] = cfg
    from .reference import watch
    watch(state)
    # Another dataset reading one of these files under another configuration loses its outputs there (the store
    # holds one configuration per file): it no longer has an active configuration (Compute again).
    for other, ocfg in list(state.nuc_active.items()):
        if other != source.browser_id and any(ocfg.config_for(p) not in (None, cfg.config_for(p)) for p in source.paths):
            state.nuc_active.pop(other, None)
    return cfg


#: The layers regularity tiles and patches feed (services/nuc/layers.py). Tiles or patches computed for a view change
#: only rows that carry these.
REGULARITY_LAYERS = ('nucreg', 'nucpatch')


def refresh_after(state, paths, layers=None) -> List[str]:
    """Drop the read caches of the datasets reading ``paths`` and (re)declare their nuc layers. ``layers``: only the
    cached rows carrying one of these are dropped (regularity tiles or patches added: the panels' ordinary rows stay
    warm); None drops every cached row (calls computed)."""
    from services.dataset_registration import invalidate_dataset_caches, invalidate_dataset_layer_caches
    from .inputs import datasets_using
    from .layers import declare_layers
    touched = sorted({d for p in paths for d in datasets_using(state, p)})
    for ds_id in touched:
        try:
            if layers is None:
                invalidate_dataset_caches(state, ds_id)
            else:
                invalidate_dataset_layer_caches(state, ds_id, layers)
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
    # Each dataset's own views (the panel's columns: a linked locus computes at its own view), else one view for all.
    views: Dict[str, list] = {}
    for v in request.get('views') or []:
        try:
            ds, c, a, b = str(v['datasetId']), str(v['chrom']), int(v['start']), int(v['end'])
        except (KeyError, TypeError, ValueError):
            raise ValueError('views: {datasetId, chrom, start, end} each') from None
        if b <= a:
            raise ValueError(f'views: an empty view for {ds}')
        views.setdefault(ds, []).append((c, a, b))
    if chrom and end > start:
        for s in sources:
            views.setdefault(s.browser_id, []).append((chrom, start, end))
    if not views and not extra:
        raise ValueError('Give a view (chrom, start, end), views or source regions')
    for ds_views in views.values():
        for c, a, b in ds_views:
            if b - a > MAX_VIEW_BP:
                raise ValueError(f'The view is {b - a:,} bp; the nucleosome panel computes up to {MAX_VIEW_BP:,} bp '
                                 'live (scan larger regions with fiberhmm-scan and open the scan)')
    settings, sh = resolve_settings(request.get('parameters') or None)
    regions: Dict[str, list] = {}
    for r in extra:
        try:
            regions.setdefault(str(r['datasetId']), []).append((str(r['contig']), int(r['start']), int(r['end'])))
        except (KeyError, TypeError, ValueError):
            raise ValueError('sourceRegions: {datasetId, contig, start, end} each') from None
    return dict(sources=sources, chrom=chrom, start=start, end=end, views=views, settings=settings, settings_hash=sh,
                source_regions=regions, include_duplicates=bool(request.get('include_duplicates')),
                include_qcfail=bool(request.get('include_qcfail')),
                hide_uncalled=_request_hides_uncalled(),
                cores=_cores(request))


def _request_hides_uncalled() -> bool:
    """The request's read filters (Min footprints never shows uncalled reads unless it asks for all reads);
    captured in the plan, since the job's worker thread has no request."""
    from services.signal_evidence import request_hide_uncalled
    return request_hide_uncalled()


def _plan_key(plan: dict) -> tuple:
    """Compute identity after validation/normalization, independent of request order and worker count."""
    return (tuple(sorted((s.browser_id,
                          tuple(sorted(set(plan['views'].get(s.browser_id, [])))),
                          tuple(sorted(set(plan['source_regions'].get(s.browser_id, [])))))
                         for s in plan['sources'])),
            plan['settings_hash'], plan['include_duplicates'], plan.get('include_qcfail', False),
            plan.get('hide_uncalled', True))


def submit(state, request: dict) -> dict:
    from .inputs import browser_read_policy
    from .live import compute_regions, source_regions
    generation = session_generation(state)          # before planning: an import meanwhile disowns this request
    plan = plan_request(state, request)
    # (an older page's `sites` field is ignored: the Sites step left with the panel's Sites tab)
    key = _plan_key(plan)
    jobs, lock = _session(state)

    def worker():
        from .compute_pool import ComputePool, compute_workers
        cancel = job['_cancel']
        computing = False
        pool = None

        def checkpoint():
            if cancel.is_set() or state.nuc_session_generation != generation:
                raise InterruptedError('cancelled')

        try:
            for thread in previous:
                while thread.is_alive():
                    checkpoint()
                    thread.join(timeout=0.05)
            # Preserve serialization across sessions too; acquiring the lock is itself cancellable.
            while not computing:
                checkpoint()
                computing = _COMPUTE_LOCK.acquire(timeout=0.05)
            with lock:
                checkpoint()
                job['status'] = 'running'
                update_progress(job, 'starting', 'Starting')
            with lock:
                job['timings'] = dict(calibration=0., molecules=0.)
            n = len(plan['sources'])
            # Worker processes for the molecules (one pool for every dataset of the job; Low memory: none).
            workers = compute_workers(state)
            pool = ComputePool(workers) if workers > 1 else None
            for i, source in enumerate(plan['sources']):
                checkpoint()
                policy = browser_read_policy(state, include_duplicates=plan['include_duplicates'],
                                             include_qcfail=plan.get('include_qcfail', False),
                                             hide_uncalled=plan.get('hide_uncalled', True))

                def cal_progress(message, _label=source.label, _i=i):
                    with lock:
                        if cancel.is_set():
                            return
                        update_progress(job, f'calibrating ({_i + 1}/{n})', f'{_label}: {message}', task='calibration')
                with lock:
                    checkpoint()
                    update_progress(job, f'calibrating ({i + 1}/{n})', f'{source.label}: calibration', task='calibration')
                cal_started = time.perf_counter()
                cfg = ensure_config(state, source, plan['settings'], plan['settings_hash'], policy,
                                    cores=plan['cores'], progress=cal_progress, cancel=cancel,
                                    generation=generation)
                with lock:
                    job['timings']['calibration'] += time.perf_counter()-cal_started
                # the dataset's regularity reference (its calibration population's decode) beside the molecules
                from .reference import start_background
                from .regularity import dataset_params
                start_background(source.paths, cfg, dataset_params(state, source.browser_id))
                checkpoint()
                regions = []
                for c, a, b in plan['views'].get(source.browser_id, []):
                    regions += source_regions(state, source, c, a, b)
                regions += plan['source_regions'].get(source.browser_id, [])

                def rec_progress(records, computed, _label=source.label, _i=i):
                    with lock:
                        if cancel.is_set():
                            return
                        update_progress(job, f'molecules ({_i + 1}/{n})',
                                        f'{_label}: {computed:,} molecules computed of {records:,} records',
                                        task='molecules')
                molecules_started = time.perf_counter()
                try:
                    checkpoint()
                    stats = compute_regions(source, regions, plan['settings'], cfg.calibrations, policy,
                                            progress=rec_progress, cancel=cancel,
                                            **({'pool': pool} if pool is not None else {}))
                finally:
                    with lock:
                        job['timings']['molecules'] += time.perf_counter()-molecules_started
                    # Outputs are published batch by batch: a cancelled or failed compute refreshes what it wrote.
                    touched = refresh_after(state, source.paths)
                    with lock:
                        job['results'][source.browser_id] = dict(calibration=cfg.calibration.summary(), datasets=touched,
                                                                 records=0, computed=0, cached=0, undecodable={}, withoutCalls=0,
                                                                 regions=[list(r) for r in regions], complete=False)
                with lock:
                    job['results'][source.browser_id].update(complete=True,
                                                             **{k: v for k, v in stats.items() if k != 'fraction'})
            if pool is not None:
                pool.close()
                pool = None
            with lock:
                checkpoint()
                job['status'] = 'complete'
                job['message'] = 'Done'
                finish_progress(job)
        except (InterruptedError, KeyboardInterrupt):
            with lock:
                job['status'] = 'cancelled'
                job['message'] = job.get('_cancel_message', 'Cancelled')
        except BaseException as error:   # noqa: BLE001 - the job records every failure
            with lock:
                if cancel.is_set():
                    job['status'] = 'cancelled'
                    job['message'] = job.get('_cancel_message', 'Cancelled')
                else:
                    job['status'] = 'error'
                    job['message'] = str(error) or type(error).__name__
                    job['error'] = job['message']
        finally:
            if pool is not None:
                try:
                    pool.close()
                except Exception:   # pragma: no cover - the workers stop with the pool either way
                    pass
            with lock:
                job['finished_at'] = time.time()
            if computing:
                _COMPUTE_LOCK.release()

    with lock:
        if state.nuc_session_generation != generation:
            raise ValueError(SESSION_REPLACED)
        for old in reversed(list(jobs.values())):
            if old['status'] in ('queued', 'running') and old['_plan_key'] == key:
                return _summary(old)
        # Include workers finishing their final cleanup, even if their status has already become terminal.
        previous = [j['_thread'] for j in jobs.values() if j['_thread'].is_alive()]
        for old in jobs.values():
            if old['status'] in ('queued', 'running'):
                old['_cancel'].set()
                old['_cancel_message'] = old['message'] = _REPLACED
                old['status'] = 'cancelling'
        job_id = uuid.uuid4().hex[:12]
        job = dict(job_id=job_id, status='queued', stage='queued',
                   message='Waiting for the previous run to stop' if previous else 'Queued', created_at=time.time(),
                   datasets=[dict(datasetId=s.browser_id, label=s.label, kind=s.kind) for s in plan['sources']],
                   view=dict(chrom=plan['chrom'], start=plan['start'], end=plan['end']),
                   settingsHash=plan['settings_hash'], results={}, _cancel=threading.Event(), _plan_key=key)
        job['_thread'] = threading.Thread(target=contextvars.copy_context().run, args=(worker,),
                                          name=f'fiberbrowser-nuc-{job_id}', daemon=True)
        jobs[job_id] = job
        for old in sorted(jobs.values(), key=lambda j: j['created_at'])[:-MAX_JOBS_KEPT]:
            if old['status'] not in _LIVE and not old['_thread'].is_alive():
                jobs.pop(old['job_id'], None)
        job['_thread'].start()
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


SESSION_REPLACED = 'Another session was opened while this request was being prepared; compute again'


def dispose_session(state) -> None:
    """A session is being imported: cancel this workspace's nucleosome jobs (they never install a configuration in
    the replacement session) and drop the session's active configurations and live cohorts, so a dataset id the
    new session reuses starts without the old one's calibration."""
    jobs, lock = _session(state)
    with lock:
        state.nuc_session_generation += 1
        for job in jobs.values():
            if job['status'] in ('queued', 'running', 'cancelling'):
                job['_cancel'].set()
                job['_disposed'] = True
                job['_cancel_message'] = job['message'] = 'Cancelled: another session was opened'
                job['status'] = 'cancelling'
        state.nuc_active.clear()
    from .observations import _COHORT_LOCK
    with _COHORT_LOCK:
        state.__dict__.pop('_nuc_cohorts', None)


def wait(state, job_id: str, timeout: Optional[float] = None) -> dict:
    jobs, lock = _session(state)
    with lock:
        thread = jobs[job_id]['_thread']
    thread.join(timeout=timeout)
    if thread.is_alive():
        raise TimeoutError(job_id)
    return get_job(state, job_id)
