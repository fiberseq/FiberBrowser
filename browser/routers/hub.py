"""The feature hub's analyses (services/hub): association runs (A2) and the overlaid patch view (V1)."""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException

from state.dependencies import get_state

router = APIRouter(tags=["hub"])


def _not_on_lab_requests() -> None:
    """Association and overlays read scan directories and BAMs that a lab server's read roots don't describe."""
    from services.lab.paths import enforcing
    if enforcing():
        raise HTTPException(status_code=403, detail="Hub analyses aren't available in a lab server's member sessions yet")


def _confine_paths(request: dict) -> None:
    from services.lab.paths import PathDenied, confine
    paths = []
    scope = request.get('scope') if isinstance(request.get('scope'), dict) else {}
    if scope.get('bed'):
        paths.append(str(scope['bed']))
    options = request.get('options') if isinstance(request.get('options'), dict) else {}
    for key in ('strataBed', 'anchorBed'):
        if options.get(key):
            paths.append(str(options[key]))
    for p in paths:
        try:
            confine(p)
        except PathDenied as error:
            raise HTTPException(status_code=403, detail=str(error)) from error


@router.get('/api/hub/assoc/modes')
async def assoc_modes():
    _not_on_lab_requests()
    from services.hub.assoc import describe
    return describe()


@router.post('/api/hub/assoc/jobs')
async def assoc_submit(request: dict, state=Depends(get_state)):
    """Start an association run (fiberhmm.assoc over hub sets) on the scan job manager."""
    _not_on_lab_requests()
    from services.hub.assoc import submit
    from services.hub.assoc_inputs import AssocInputError
    if not isinstance(request, dict):
        raise HTTPException(status_code=422, detail='Request must be an object')
    _confine_paths(request)
    try:
        return await asyncio.to_thread(submit, state, request)
    except AssocInputError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@router.get('/api/hub/assoc/jobs')
async def assoc_jobs(state=Depends(get_state)):
    _not_on_lab_requests()
    from services.hub.assoc import list_jobs
    return dict(jobs=list_jobs(state))


@router.get('/api/hub/assoc/jobs/{job_id}')
async def assoc_job(job_id: str, state=Depends(get_state)):
    _not_on_lab_requests()
    from services.hub.assoc import get_job
    try:
        return get_job(state, job_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail='No such association run') from error


@router.delete('/api/hub/assoc/jobs/{job_id}')
async def assoc_cancel(job_id: str, state=Depends(get_state)):
    _not_on_lab_requests()
    from services.hub.assoc import cancel
    try:
        return cancel(state, job_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail='No such association run') from error


@router.post('/api/hub/overlay')
async def hub_overlay(request: dict, state=Depends(get_state)):
    """The overlaid patch view (V1): an aligned metaprofile of a mark layer over loci, per observation, with
    denominators (molecules measured at each position) and a pile sample."""
    _not_on_lab_requests()
    from services.hub.overlay import OverlayError, overlay
    if not isinstance(request, dict):
        raise HTTPException(status_code=422, detail='Request must be an object')
    try:
        return await asyncio.to_thread(overlay, state, request)
    except OverlayError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@router.get('/api/hub/legacy')
async def legacy_jobs(state=Depends(get_state)):
    from services.hub.migration import legacy_runs
    return await asyncio.to_thread(legacy_runs, state)
