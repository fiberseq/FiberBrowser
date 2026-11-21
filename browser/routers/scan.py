"""fiberhmm-scan in FiberBrowser: open scan directories, serve their hits, run live scans (services/scan)."""
from __future__ import annotations

import asyncio
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from state.dependencies import get_state

router = APIRouter(tags=["scan"])


def _not_on_lab_requests() -> None:
    """Scans read and write files the lab server's read roots don't describe (scan directories, the scan cache):
    refused on members' and visitors' requests until confined readers exist."""
    from services.lab.paths import enforcing
    if enforcing():
        raise HTTPException(status_code=403, detail="Scans aren't available in a lab server's member sessions yet")


def _confined(path: str) -> str:
    """A path a lab server's member may read (a no-op elsewhere)."""
    from services.lab.paths import PathDenied, confine
    _not_on_lab_requests()
    try:
        return confine(path)
    except PathDenied as error:
        raise HTTPException(status_code=403, detail=str(error)) from error


def _scan(state, scan_id: str):
    from services.scan.registry import get_scan
    try:
        return get_scan(state, scan_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail='That scan is not open in this session') from error


@router.get('/api/scan/available')
async def scan_available():
    """Whether live scans can run (FiberHMM with fiberhmm.scan) and which modules exist."""
    _not_on_lab_requests()
    from services.scan.planning import available
    return await asyncio.to_thread(available)


@router.post('/api/scan/open')
async def open_scan(request: dict, state=Depends(get_state)):
    """Open a fiberhmm-scan output directory: its manifest, dataset bindings and hub feature sets."""
    _not_on_lab_requests()
    from services.scan.registry import ScanOpenError, open_scan as do_open
    path = request.get('path') if isinstance(request, dict) else None
    if not isinstance(path, str) or not path.strip():
        raise HTTPException(status_code=422, detail='Give the scan directory (path)')
    _confined(path)
    # A restore names the scan generation it read (/api/scan/list): an open for a session replaced since is refused.
    gen = request.get('generation')
    try:
        scan = await asyncio.to_thread(do_open, state, path.strip(), source='cache' if request.get('source') == 'cache' else 'opened', generation=gen if isinstance(gen, int) else None)
    except ScanOpenError as error:
        status = 409 if 'Another session' in str(error) else 422
        raise HTTPException(status_code=status, detail=str(error)) from error
    return scan.info(state)


@router.get('/api/scan/list')
async def list_scans(state=Depends(get_state)):
    """The scans open in this session (opened directories and the browser's own scan cache)."""
    _not_on_lab_requests()
    from services.scan.registry import generation, list_scans as do_list, rebind_all
    def run():
        rebind_all(state)
        return dict(scans=[s.info(state) for s in do_list(state)], generation=generation(state))
    return await asyncio.to_thread(run)


@router.delete('/api/scan/{scan_id}')
async def close_scan(scan_id: str, state=Depends(get_state)):
    _not_on_lab_requests()
    from services.scan.registry import close_scan as do_close
    return dict(closed=bool(do_close(state, scan_id)))


@router.get('/api/scan/{scan_id}/hits')
async def scan_hits(scan_id: str, module: str, chrom: str, start: int = Query(..., ge=0), end: int = Query(..., ge=1),
                    type: Optional[str] = None, graph: bool = False, state=Depends(get_state)):
    """Hits of one module overlapping a region (padded fetch), with per-dataset score roles. A source-frame scan's
    hits (a live-lift dataset's own assembly) are lifted onto this genome, keeping their source coordinates and a
    lift status (G1). ``graph``: also each hit's columns on registered graph packages, with every path's status."""
    _not_on_lab_requests()
    from services.scan.serve import hits_for_view
    scan = _scan(state, scan_id)
    if module not in (scan.manifest.get('modules') or {}):
        raise HTTPException(status_code=404, detail=f'No module {module!r} in this scan')
    if end <= start:
        raise HTTPException(status_code=422, detail='end must be greater than start')
    if (scan.frame or {}).get('kind') == 'source':
        from services.scan.projection import source_hits_for_view
        out = await asyncio.to_thread(source_hits_for_view, state, scan, module, chrom, start, end, type_id=type)
    else:
        out = await asyncio.to_thread(hits_for_view, scan, module, chrom, start, end, type_id=type)
    if graph:
        from services.scan.graph_hits import add_graph_aliases
        note = await add_graph_aliases(state, out['hits'], chrom)
        if note:
            out['graphNote'] = note
    return out


@router.get('/api/scan/{scan_id}/units')
async def scan_units(scan_id: str, chrom: str, start: int = Query(..., ge=0), end: int = Query(..., ge=1),
                     state=Depends(get_state)):
    _not_on_lab_requests()
    from services.scan.serve import units_for_view
    scan = _scan(state, scan_id)
    return dict(units=await asyncio.to_thread(units_for_view, scan, chrom, start, end))


@router.post('/api/scan/plan')
async def scan_plan(request: dict, state=Depends(get_state)):
    """What a live scan would compute: units, what open scans already cover, and the equivalent command line."""
    _not_on_lab_requests()
    from services.scan.planning import ScanPlanError, build_plan
    if not isinstance(request, dict):
        raise HTTPException(status_code=422, detail='Request must be an object')
    if request.get('bed'):
        _confined(str(request['bed']))
    try:
        plan = await asyncio.to_thread(build_plan, state, request)
    except ScanPlanError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return dict(scope=plan['scope'], where=plan['where'], modules=plan['module_names'],
                datasets=[dict(datasetId=d['browser_id'], label=d['label'], scanDataset=d['dataset_id'],
                               chemistry=d['chemistry']) for d in plan['datasets']],
                units=len(plan['units']), workers=plan['workers'],
                coverage={m: dict(total=c['total'], precomputed=len(c['precomputed']), cached=len(c['cached']),
                                  toCompute=len(c['to_compute']), precomputedBy=sorted(set(c['precomputed'].values())))
                          for m, c in plan['coverage'].items()},
                settingsHashes={m['name']: m['settings_hash'] for m in plan['modules']},
                experimental=[m['name'] for m in plan['modules'] if m['experimental']],
                readPolicy=plan['read_policy'], cli=plan['cli'], note=plan['signal_filters_note'])


@router.post('/api/scan/jobs')
async def scan_submit(request: dict, state=Depends(get_state)):
    """Start a live scan (same engine as fiberhmm-scan) into the scan cache."""
    _not_on_lab_requests()
    from services.scan.jobs import submit
    from services.scan.planning import ScanPlanError
    if not isinstance(request, dict):
        raise HTTPException(status_code=422, detail='Request must be an object')
    if request.get('bed'):
        _confined(str(request['bed']))
    try:
        return await asyncio.to_thread(submit, state, request)
    except (ScanPlanError, ValueError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@router.get('/api/scan/jobs')
async def scan_jobs(state=Depends(get_state)):
    _not_on_lab_requests()
    from services.scan.jobs import list_jobs
    return dict(jobs=list_jobs(state))


@router.get('/api/scan/jobs/{job_id}')
async def scan_job(job_id: str, state=Depends(get_state)):
    _not_on_lab_requests()
    from services.scan.jobs import get_job
    try:
        return get_job(state, job_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail='No such scan job') from error


@router.delete('/api/scan/jobs/{job_id}')
async def scan_cancel(job_id: str, state=Depends(get_state)):
    _not_on_lab_requests()
    from services.scan.jobs import cancel
    try:
        return cancel(state, job_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail='No such scan job') from error
