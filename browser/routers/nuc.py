"""The nucleosome panel's routes (services/nuc): availability, status, live jobs, per-record rows, summaries."""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException

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


@router.get('/api/nuc/available')
async def nuc_available():
    _not_on_lab_requests()
    from services.nuc.engine import available
    return await asyncio.to_thread(available)


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
        policy = browser_read_policy(state, include_duplicates=bool(request.get('include_duplicates')))
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
                                       include_duplicates=bool(request.get('include_duplicates')))
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
    return await asyncio.to_thread(summarize, state, obs, include_duplicates=bool(request.get('include_duplicates')))
