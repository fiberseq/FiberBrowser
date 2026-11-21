"""The nucleosome panel's routes (services/nuc): availability, status, live jobs, per-record rows, summaries."""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException, Request

from state.dependencies import get_state

router = APIRouter(tags=["nucleosomes"])


def _not_on_lab_requests() -> None:
    """Like scans, nucleosome jobs read host files outside a lab server's read roots (the calibration cache)."""
    from services.lab.paths import enforcing
    if enforcing():
        raise HTTPException(status_code=403, detail="The nucleosome panel isn't available in a lab server's member sessions yet")


def _body(request) -> dict:
    if not isinstance(request, dict):
        raise HTTPException(status_code=422, detail='Request must be an object')
    return request


#: The detail of a 409 that drops a request a newer one (or an Analyse of its datasets) replaced: an expected
#: outcome the client never shows (frontend features/nucleosomes/api.ts isSupersededNuc).
SUPERSEDED = 'Replaced by a newer analysis'


@router.get('/api/nuc/available')
async def nuc_available():
    _not_on_lab_requests()
    from services.nuc.engine import available
    return await asyncio.to_thread(available)


@router.get('/api/nuc/metrics')
async def nuc_metrics():
    """The per-molecule metrics rule terms can name (the nucmol / nfrmol scalar groups)."""
    _not_on_lab_requests()
    from services.nuc.scalars import metrics
    return dict(metrics=metrics())


@router.post('/api/nuc/status')
async def nuc_status(request: dict, state=Depends(get_state)):
    """Per dataset: whether the panel can read it, its active configuration, a stored calibration, stored records."""
    _not_on_lab_requests()
    request = _body(request)

    def run():
        from services.nuc.calibration import find_calibration
        from services.nuc.engine import NucUnavailable, module_version, resolve_settings
        from services.nuc.inputs import NucInputError, browser_read_policy, nuc_source
        from services.nuc.jobs import active_config
        from services.nuc.store import STORE
        try:
            settings, sh = resolve_settings(request.get('parameters') or None)
            version = module_version()
        except NucUnavailable as error:
            return dict(available=False, reason=str(error), datasets=[])
        policy = browser_read_policy(state, include_duplicates=bool(request.get('include_duplicates')), include_qcfail=bool(request.get('include_qcfail')))
        out = []
        for ds_id in dict.fromkeys(request.get('datasets') or []):
            entry = dict(datasetId=ds_id)
            try:
                source = nuc_source(state, ds_id)
            except NucInputError as error:
                entry['error'] = str(error)
                out.append(entry)
                continue
            cfg = active_config(state, ds_id)
            stored = find_calibration(state, source, sh, version, policy.get('filters') or {})
            entry.update(kind=source.kind, label=source.label,
                         active=cfg.summary() if cfg is not None else None,
                         storedCalibration=next(iter(stored.values())).summary() if stored else None,
                         records=sum(len(STORE.rows_of(p)) for p in source.paths))
            out.append(entry)
        return dict(available=True, settingsHash=sh, version=version, datasets=out)
    return await asyncio.to_thread(run)


@router.post('/api/nuc/jobs')
async def nuc_submit(request: dict, state=Depends(get_state)):
    """Calibrate (once) and compute live nucleosome outputs for a view's records."""
    _not_on_lab_requests()
    from services.nuc.engine import NucUnavailable
    from services.nuc.jobs import submit
    try:
        return await asyncio.to_thread(submit, state, _body(request))
    except (NucUnavailable, ValueError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@router.get('/api/nuc/jobs')
async def nuc_jobs(state=Depends(get_state)):
    _not_on_lab_requests()
    from services.nuc.jobs import list_jobs
    return dict(jobs=list_jobs(state))


@router.get('/api/nuc/jobs/{job_id}')
async def nuc_job(job_id: str, state=Depends(get_state)):
    _not_on_lab_requests()
    from services.nuc.jobs import get_job
    try:
        return get_job(state, job_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail='No such nucleosome job') from error


@router.delete('/api/nuc/jobs/{job_id}')
async def nuc_cancel(job_id: str, state=Depends(get_state)):
    _not_on_lab_requests()
    from services.nuc.jobs import cancel
    try:
        return cancel(state, job_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail='No such nucleosome job') from error


@router.post('/api/nuc/records')
async def nuc_records(request: dict, state=Depends(get_state)):
    """The stored per-record outputs of a dataset's records over a view."""
    _not_on_lab_requests()
    request = _body(request)
    from services.nuc.inputs import NucInputError
    from services.nuc.observations import record_rows
    try:
        return await asyncio.to_thread(record_rows, state, str(request.get('datasetId') or ''),
                                       str(request.get('chrom') or ''), int(request.get('start') or 0),
                                       int(request.get('end') or 0),
                                       include_duplicates=bool(request.get('include_duplicates')), include_qcfail=bool(request.get('include_qcfail')))
    except (NucInputError, ValueError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@router.post('/api/nuc/summary')
async def nuc_summary(request: dict, state=Depends(get_state)):
    """Per-observation summaries (sizes, spacing, segments, window metrics) of the stored outputs."""
    _not_on_lab_requests()
    request = _body(request)
    obs = request.get('observations')
    if not isinstance(obs, list) or not obs:
        raise HTTPException(status_code=422, detail='Give the observations')
    from services.nuc.observations import summarize
    return await asyncio.to_thread(summarize, state, obs, include_duplicates=bool(request.get('include_duplicates')), include_qcfail=bool(request.get('include_qcfail')))


def _dataset_files(state, dataset_id) -> set:
    """The real paths of a dataset's files (none for an unknown dataset)."""
    import os
    ds = (getattr(state, 'datasets', None) or {}).get(str(dataset_id))
    if ds is None:
        return set()
    return {os.path.realpath(str(p)) for p in (getattr(ds, 'paths', None) or [getattr(ds, 'path', '')]) if p}


def _analyse_watch(state, obs):
    """A checkpoint test for a read-side request over ``obs``: True once a nucleosome Analyse submitted after this
    call touches one of the observations' datasets or their files (new molecules, possibly another store
    configuration: an answer computed meanwhile could mix both, so it is dropped and the client asks again when the
    Analyse ends). An Analyse of other datasets over other files never stops it."""
    from services.nuc.jobs import list_jobs
    ids = {str(o.get('datasetId') or '') for o in obs if isinstance(o, dict)}
    files = set().union(*(_dataset_files(state, d) for d in ids)) if ids else set()
    latest = max((j['created_at'] for j in list_jobs(state)), default=0)

    def touches(job) -> bool:
        for d in job.get('datasets') or ():
            did = str(d.get('datasetId') if isinstance(d, dict) else d)
            if did in ids or (files and files & _dataset_files(state, did)):
                return True
        return False

    def newer():
        return any(j['created_at'] > latest and touches(j) for j in list_jobs(state))
    return newer


@router.post('/api/nuc/patches')
async def nuc_patches(request: dict, state=Depends(get_state)):
    """Per-observation patch scores: each observation's fraction and FiberHMM's shift-within-read recurrence test
    over each listed patch, with Benjamini-Hochberg q-values per observation and kind."""
    _not_on_lab_requests()
    request = _body(request)
    obs, patches = request.get('observations'), request.get('patches')
    if not isinstance(obs, list) or not obs or not isinstance(patches, list):
        raise HTTPException(status_code=422, detail='Give the observations and the patches')
    if len(patches) > 500:
        raise HTTPException(status_code=422, detail='Score at most 500 patches at once')
    fdr = request.get('fdr', 0.05)
    if not isinstance(fdr, (int, float)) or not 0 < float(fdr) < 1:
        raise HTTPException(status_code=422, detail='fdr must be between 0 and 1')
    from services.nuc.observations import ObservationError
    from services.nuc.patches import patch_scores
    try:
        return await asyncio.to_thread(patch_scores, state, obs, patches, fdr=float(fdr),
                                       include_duplicates=bool(request.get('include_duplicates')), include_qcfail=bool(request.get('include_qcfail')))
    except (ObservationError, ValueError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@router.post('/api/nuc/patch_labels')
async def nuc_patch_labels(request: dict, state=Depends(get_state)):
    """The geometry labels of the datasets' live nucpatch rows (``services.nuc.nucgeo.patch_labels``): the read lanes
    apply them to rows already loaded, so a geometry relabel never reloads the reads."""
    _not_on_lab_requests()
    request = _body(request)
    ids = request.get('datasets')
    if not isinstance(ids, list):
        raise HTTPException(status_code=422, detail='Give the datasets')
    from services.nuc.nucgeo import patch_labels
    return dict(datasets=await asyncio.to_thread(patch_labels, state, [str(d) for d in ids]))


async def _cancellable(http: Request, state, endpoint: str, scope, obs, fn, *args, **kwargs):
    """``fn(*args, cancel=checkpoint, **kwargs)`` over the observations ``obs`` on a worker thread, stopped at its next checkpoint when the client
    goes away (an aborted fetch) or, for a request naming its panel (``requestScope``), when a newer request of the
    same panel and endpoint arrives. Requests without a scope or with a cluster view's ('cluster:...') are only stopped by a disconnect,
    so they never replace a panel's request or each other. An Analyse submitted after the
    request started that touches one of its datasets (``_analyse_watch``) stops it too; an Analyse of other datasets
    does not. A stopped request answers 409 ``SUPERSEDED`` and caches nothing: the client drops it silently and asks
    again once the newer state settles."""
    import threading
    from services.client_disconnect import wait_for_disconnect
    from services.nuc.regularity import NON_ADOPTING_SCOPES
    analysed = _analyse_watch(state, obs)
    gone = threading.Event()
    # a cluster view's scope ('cluster:<panel>') never cancels: its several series' requests run side by side (a
    # stale one is aborted by the client, the disconnect path)
    ekey = (endpoint, str(scope)) if scope and not str(scope).startswith(NON_ADOPTING_SCOPES) else None
    epochs = state.__dict__.setdefault('_nuc_panel_epochs', {})
    epoch = None
    if ekey is not None:
        epoch = epochs[ekey] = epochs.get(ekey, 0) + 1

    def checkpoint():
        if gone.is_set() or (ekey is not None and epochs.get(ekey) != epoch) or analysed():
            raise InterruptedError(SUPERSEDED)

    async def watch():
        try:
            await wait_for_disconnect(http)
        except Exception:  # noqa: BLE001 - no way to tell: assume it stays
            await asyncio.Event().wait()
        gone.set()
    watcher = asyncio.ensure_future(watch())
    try:
        return await asyncio.to_thread(fn, *args, cancel=checkpoint, **kwargs)
    except InterruptedError as error:
        raise HTTPException(status_code=409, detail=SUPERSEDED) from error
    finally:
        watcher.cancel()


@router.post('/api/nuc/regularity')
async def nuc_regularity(request: dict, http: Request, state=Depends(get_state)):
    """The Regularity view per observation (one per cluster and dataset): score distribution against the
    random-packing reference, mean score along the region, local repeat length, score against m6A density, the
    masked m6A autocorrelation and a summary row, computed with ``parameters`` (the panel's regularity settings;
    without them the datasets' current ones): nucreg tiles are computed from the decoded molecules, never
    recalibrated. When it finishes, ``parameters`` become the datasets' lane parameters if the panel
    (``requestScope``) changed them since its last request (or it is its first), or none are chosen yet
    (``services.nuc.regularity.adopt_lane``); a cluster view (``requestScope`` 'cluster:<panel>') or ``adopt``
    false never moves them. Cancelled on disconnect or by the same panel's next request."""
    _not_on_lab_requests()
    request = _body(request)
    obs = request.get('observations')
    if not isinstance(obs, list) or not obs or not all(isinstance(o, dict) for o in obs):
        raise HTTPException(status_code=422, detail='Give the observations')
    params = request.get('parameters')
    if params is not None and not isinstance(params, dict):
        raise HTTPException(status_code=422, detail='parameters must be an object')
    from services.nuc.regularity import parse_params, regularity_analysis
    try:
        if params is not None:
            parse_params(params)
        return await _cancellable(http, state, 'regularity', request.get('requestScope'), obs, regularity_analysis, state,
                                  obs, params=params, spanning=bool(request.get('spanning')), cohort=request.get('cohort'),
                                  include_duplicates=bool(request.get('include_duplicates')), include_qcfail=bool(request.get('include_qcfail')),
                                  per_molecule=bool(request.get('per_molecule')),
                                  request_scope=request.get('requestScope'), adopt=request.get('adopt') is not False)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@router.post('/api/nuc/geometries')
async def nuc_geometries(request: dict, http: Request, state=Depends(get_state)):
    """The Regularity view's patch section: per-molecule regularity patches (FiberHMM call_patches on the nucreg
    tiles), shared patch geometries of the pooled observations with fold mode, per-observation full / partial
    carrier shares, nested pairs, member stacks, carrier profiles, read groups, and the association of carriage with
    a site's NFR or TF state. ``patches`` holds the patch and geometry parameters, ``regularity`` the regularity
    parameters, ``reference`` an optional per-dataset reference choice (a median, or ``scan:<scanId>`` to adopt a
    bound scan's recorded reference), ``cohort`` 'overlapping' (default) or 'spanning'. Computed with the request's own
    parameters; they become the lane parameters as for /api/nuc/regularity. Cancelled on disconnect or by the same
    panel's (``requestScope``) next request."""
    _not_on_lab_requests()
    request = _body(request)
    obs = request.get('observations')
    if not isinstance(obs, list) or not obs or not all(isinstance(o, dict) for o in obs):
        raise HTTPException(status_code=422, detail='Give the observations')
    for key in ('patches', 'regularity', 'reference'):
        if request.get(key) is not None and not isinstance(request.get(key), dict):
            raise HTTPException(status_code=422, detail=f'{key} must be an object')
    site = request.get('site')
    from services.nuc.nucgeo import geometry_analysis, parse_params as parse_patch
    from services.nuc.regularity import parse_params
    try:
        parse_patch(request.get('patches'))
        if request.get('regularity') is not None:
            parse_params(request.get('regularity'))
        return await _cancellable(
            http, state, 'geometries', request.get('requestScope'), obs, geometry_analysis, state, obs,
            patch_params=request.get('patches'), reg_params=request.get('regularity'),
            ref_override=request.get('reference'), spanning=bool(request.get('spanning')), cohort=request.get('cohort'),
            include_duplicates=bool(request.get('include_duplicates')), include_qcfail=bool(request.get('include_qcfail')), site=int(site) if site is not None else None,
            site_state=str(request.get('site_state') or 'nfr'), show=str(request.get('show') or 'patch'),
            request_scope=request.get('requestScope'), adopt=request.get('adopt') is not False)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
