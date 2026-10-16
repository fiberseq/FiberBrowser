"""Synchronise regions, scoped to the current workspace."""
from fastapi import APIRouter, Depends, HTTPException
from state.dependencies import get_state
from lab.services import region_sync

router = APIRouter(tags=['region-sync'])


@router.post('/api/lab/region-sync/jobs')
def start(request: dict, state=Depends(get_state)):
    try:
        return region_sync.submit(state, request)
    except (ValueError, KeyError, TypeError) as error:
        raise HTTPException(422, str(error)) from error


@router.post('/api/lab/region-sync/locate')
def locate(request: dict, state=Depends(get_state)):
    """Search the template's whole reference for a window's sequence (a job, polled like a search)."""
    try:
        return region_sync.submit(state, request, kind='locate')
    except (ValueError, KeyError, TypeError) as error:
        raise HTTPException(422, str(error)) from error


@router.post('/api/lab/region-sync/cluster')
def cluster(request: dict, state=Depends(get_state)):
    try:
        return region_sync.cluster_check(state, request)
    except (ValueError, KeyError, TypeError) as error:
        raise HTTPException(422, str(error)) from error


@router.get('/api/lab/region-sync/jobs/{job_id}')
def status(job_id: str, state=Depends(get_state)):
    try:
        return dict(region_sync.get_job(state, job_id))
    except KeyError as error:
        raise HTTPException(404, 'Region search not found in this session') from error


@router.delete('/api/lab/region-sync/jobs/{job_id}')
def cancel(job_id: str, state=Depends(get_state)):
    status(job_id, state)
    region_sync.cancel(state, job_id)
    return status(job_id, state)


from lab.services.frame_clustering import RegionClusterRequest


@router.post('/api/lab/cluster-regions')
def cluster_regions(request: RegionClusterRequest, state=Depends(get_state)):
    from lab.services.frame_clustering import run
    try:
        return run(state, request)
    except (ValueError, KeyError, TypeError) as error:
        raise HTTPException(422, str(error)) from error


@router.post('/api/lab/region-classes')
def region_classes(request: dict, state=Depends(get_state)):
    from lab.services.region_analysis import submit
    try:
        return submit(state, request)
    except (ValueError, KeyError, TypeError) as error:
        raise HTTPException(422, str(error)) from error
