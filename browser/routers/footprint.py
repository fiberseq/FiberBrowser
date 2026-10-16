"""Footprint analysis endpoint.

Extracted from server.py.
"""
from __future__ import annotations

import asyncio
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, File, UploadFile

from models.requests import FootprintAnalysisRequest
from services.footprint_endpoint import (
    _footprint_warning_once_keys,
    _print_footprint_warning_once,
    analyze_footprints_payload,
)
from state.dependencies import get_state

router = APIRouter(tags=["footprint"])


@router.post('/api/footprint/consensus/lattice')
async def consensus_lattice_view(request: dict, state=Depends(get_state)):
    from services.consensus_lattice_view import lattice_payload
    try:return await asyncio.to_thread(lattice_payload,state,request)
    except (ValueError,KeyError,TypeError,OSError) as error:
        raise HTTPException(status_code=422,detail=str(error)) from error


@router.get('/api/footprint/consensus/schema')
async def consensus_parameter_schema():
    from services.consensus_workflow import schema
    try:return await asyncio.to_thread(schema)
    except ValueError as error:
        raise HTTPException(status_code=422,detail=str(error)) from error


# Public servers: extra read orders of the optional read-order check (FootprintAnalysis "Check robustness to read order").
PUBLIC_MAX_ORDER_REPLICATES = 2


@router.post('/api/footprint/consensus/jobs')
async def start_consensus_workflow(request: dict, state=Depends(get_state)):
    from services.consensus_workflow import submit
    from services.runtime import get_host_public_mode, get_public_mode
    host_public = get_host_public_mode()
    if get_public_mode() and isinstance(request, dict):
        params = dict(request.get('parameters') or {})
        if host_public:
            # Anonymous visitors never choose the compute budget: the server's
            # caps replace the whole group (services/public_limits.py).
            from services.public_limits import public_consensus_compute
            compute = public_consensus_compute()
            # The read-order check repeats the whole run per extra order: at most the panel's own value (3 orders).
            recaller = params.get('recaller')
            if isinstance(recaller, dict) and isinstance(recaller.get('order_replicates'), int) \
                    and recaller['order_replicates'] > PUBLIC_MAX_ORDER_REPLICATES:
                params = {**params, 'recaller': {**recaller, 'order_replicates': PUBLIC_MAX_ORDER_REPLICATES}}
        else:
            # A tour sandbox: scores are cached in a per-session temp dir,
            # never a client-chosen one.
            compute = dict(params.get('compute') or {})
            compute.pop('fit_cache_dir', None)
        request = {**request, 'parameters': {**params, 'compute': compute}}
    if host_public:
        from services.public_limits import consensus_queue_full
        if consensus_queue_full():
            raise HTTPException(status_code=429, detail='This public server is busy with other footprint-class '
                                                        'runs; try again in a few minutes.')
    try:
        summary = await asyncio.to_thread(submit, state, request)
    except (ValueError, KeyError, TypeError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    if host_public:
        from services.public_limits import track_consensus_job
        track_consensus_job(_consensus_future(state, summary))
    return summary


def _consensus_future(state, summary):
    """The worker future of a job just submitted (for the public job queue)."""
    try:
        from services.consensus_workflow import _session
        jobs, lock = _session(state)
        with lock:
            job = jobs.get((summary or {}).get('job_id'))
            return job.get('_future') if job else None
    except Exception:
        return None


@router.get('/api/footprint/consensus/jobs')
async def consensus_jobs(state=Depends(get_state)):
    from services.consensus_workflow import list_jobs
    return await asyncio.to_thread(list_jobs,state)


@router.post('/api/footprint/consensus/import')
async def import_consensus(file: UploadFile=File(...), state=Depends(get_state)):
    from services.consensus_workflow import import_result
    raw=await file.read(128*1024**2+1)
    await file.close()
    try:return await asyncio.to_thread(import_result,state,raw)
    except (ValueError,KeyError,TypeError,OSError,EOFError) as error:
        raise HTTPException(status_code=422,detail=str(error)) from error


@router.post('/api/footprint/consensus/jobs/{job_id}/activate')
async def activate_consensus(job_id: str, state=Depends(get_state)):
    from services.consensus_workflow import activate
    try:return await asyncio.to_thread(activate,state,job_id)
    except (ValueError,KeyError) as error:
        raise HTTPException(status_code=422,detail=str(error)) from error


@router.get('/api/footprint/consensus/jobs/{job_id}')
async def consensus_job(job_id: str, state=Depends(get_state)):
    from services.consensus_workflow import get_job
    try:
        return await asyncio.to_thread(get_job,state,job_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail='Consensus job not found in this session') from error


@router.delete('/api/footprint/consensus/jobs/{job_id}')
async def cancel_consensus_job(job_id: str, state=Depends(get_state)):
    from services.consensus_workflow import cancel
    try:
        return await asyncio.to_thread(cancel,state,job_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail='Consensus job not found') from error


@router.post('/api/footprint/consensus/jobs/{job_id}/filters')
async def filter_consensus_job(job_id: str, request: dict, state=Depends(get_state)):
    from services.consensus_workflow import set_filters
    try:
        return await asyncio.to_thread(set_filters, state, job_id, request)
    except (KeyError, ValueError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@router.get('/api/footprint/consensus/jobs/{job_id}/export')
async def export_consensus_job(job_id: str, state=Depends(get_state)):
    from fastapi.responses import FileResponse
    from pathlib import Path
    from services.consensus_workflow import get_job
    try:
        job = await asyncio.to_thread(get_job,state,job_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail='Consensus job not found') from error
    if job['status'] != 'complete':
        raise HTTPException(status_code=409, detail='The frozen result is not complete')
    from services.consensus_workflow import export_with_curation
    path=await asyncio.to_thread(export_with_curation,state,job_id)
    return FileResponse(path, media_type='application/gzip',
                        filename=f'fiberhmm-consensus-{job_id}.json.gz')


@router.get('/api/footprint/consensus/jobs/{job_id}/catalog')
async def consensus_catalog(job_id: str, state=Depends(get_state)):
    # A filter/overlay projection can hold the session lock while hydrating a
    # large visible cohort. Waiting for that lock must not stop the event loop
    # (including opportunity-lattice responses and cancellation requests).
    return await asyncio.to_thread(_consensus_catalog_payload,job_id,state)


@router.post('/api/footprint/consensus/jobs/{job_id}/stage')
async def select_consensus_stage(job_id: str, request: dict, state=Depends(get_state)):
    from services.consensus_workflow import select_stage
    try:
        if set(request)!={'stage'} or not isinstance(request['stage'],str):
            raise ValueError('One stage identifier is required')
        return await asyncio.to_thread(select_stage,state,job_id,request['stage'])
    except (KeyError,ValueError) as error:
        raise HTTPException(status_code=422,detail=str(error)) from error


def _consensus_catalog_payload(job_id,state):
    from services.consensus_workflow import _session,rescue_rate_summary,_cr_mode,viewed_result,viewing_final
    from services.consensus_curation import curation_for_job,curated_display_families,subclass_candidates
    jobs, lock = _session(state)
    with lock:
        job = jobs.get(job_id)
        if not job or 'result' not in job:
            raise HTTPException(status_code=404, detail='Completed consensus result not found')
        result=viewed_result(job)
        mode=_cr_mode(result)
        native=mode=='native_family_distribution'
        edges=result['cross'].get('edges',[])
        if native:
            edges=[dict({k:v for k,v in edge.items() if k!='call_evidence'},
                call_evidence_counts={name:len(rows) for name,rows in edge.get('call_evidence',{}).items()},
                full_call_evidence_in_export=True) for edge in edges]
        from services.oriented_regions import catalog_sources
        return dict(region_sources=catalog_sources(result),region=result['manifest']['region'],cr_mode=mode,
            stages=result.get('stages',[]),view_stage=job.get('view_stage',result.get('final_stage')),
            final_stage=result.get('final_stage'),curation_read_only=not viewing_final(job),
            curation_scope='__shared_families__' if mode=='staged_native_families' and result['manifest'].get('mode')=='XCR' else None,
            curation=curation_for_job(job),datasets={name:dict(catalog=[dict(family,subclass_candidates=candidates)
                if (candidates:=subclass_candidates(job,name,family.get('family',''))) else dict(family)
                for family in ds.get('cr',{}).get('catalog',[])],
            cr_mode=ds.get('cr',{}).get('cr_mode',mode),
            native_catalog_update=ds.get('cr',{}).get('native_catalog_update'),
            display_classification_counts=job.get('index',{}).get(name,{}).get('display_classification_counts'),
            classification_reference_percent=job['filters'].get('classification_reference_percent',99.9),
            cross_projection_errors=job.get('index',{}).get(name,{}).get('cross_projection_errors',[]),
            auxiliary_projection_errors=job.get('index',{}).get(name,{}).get('auxiliary_projection_errors',[]),
            curated_display_families=[dict(family,subclass_candidates=candidates)
                if not family.get('manual') and (candidates:=subclass_candidates(job,name,family.get('family',''))) else family
                for family in curated_display_families(job,name)] if viewing_final(job) else [],
            comparability=ds.get('comparability',{}).get('records',[]),
            rescue_rates=rescue_rate_summary(ds,job['filters'])) for name,ds in result['datasets'].items()},
            edges=edges,
            count_groups=result['cross'].get('count_groups',[]),
            count_semantics=result['cross'].get('count_semantics'),
            comparison=result.get('comparison'),
            # Lattice recaller with the read-order check: orderings, rule and per-order counts (absent otherwise).
            robustness=((result.get('manifest') or {}).get('recaller') or {}).get('order_robustness'))


@router.get('/api/footprint/consensus/jobs/{job_id}/call')
async def consensus_native_call(job_id: str, dataset_id: str=Query(...,min_length=1,max_length=1000),
                                source_call_id: str=Query(...,min_length=1,max_length=2000), state=Depends(get_state)):
    from services.consensus_workflow import get_native_call
    try:
        return await asyncio.to_thread(get_native_call,state,job_id,dataset_id,source_call_id)
    except KeyError as error:
        raise HTTPException(status_code=404,detail='Frozen native job, dataset, or original call not found') from error
    except (ValueError,TypeError) as error:
        raise HTTPException(status_code=422,detail=str(error)) from error


@router.get('/api/footprint/consensus/jobs/{job_id}/state-reads')
async def consensus_state_reads(job_id: str, dataset_id: str=Query(...,min_length=1,max_length=1000),
                                family_id: str=Query(...,min_length=1,max_length=2000),
                                stage: Optional[str]=Query(None,max_length=200), strand: Optional[str]=Query(None,max_length=20),
                                tier: Optional[str]=Query(None,max_length=20), state=Depends(get_state)):
    from services.consensus_workflow import state_read_ids
    try:
        return await asyncio.to_thread(state_read_ids,state,job_id,dataset_id,family_id,stage,strand,tier)
    except KeyError as error:
        raise HTTPException(status_code=404,detail='Consensus job not found') from error
    except (ValueError,TypeError) as error:
        raise HTTPException(status_code=422,detail=str(error)) from error


@router.get('/api/footprint/consensus/jobs/{job_id}/curation')
async def consensus_curation(job_id: str, state=Depends(get_state)):
    from services.consensus_curation import get_curation,CurationConflict,CurationUnavailable
    try:
        return await asyncio.to_thread(get_curation,state,job_id)
    except KeyError as error:
        raise HTTPException(status_code=404,detail='Consensus job not found') from error
    except (CurationConflict,CurationUnavailable) as error:
        raise HTTPException(status_code=409,detail=str(error)) from error
    except (ValueError,TypeError) as error:
        raise HTTPException(status_code=422,detail=str(error)) from error


@router.post('/api/footprint/consensus/jobs/{job_id}/curation')
async def update_consensus_curation(job_id: str, request: dict, state=Depends(get_state)):
    from services.consensus_curation import update_curation,CurationConflict,CurationUnavailable
    try:
        return await asyncio.to_thread(update_curation,state,job_id,request)
    except KeyError as error:
        raise HTTPException(status_code=404,detail='Consensus job not found') from error
    except (CurationConflict,CurationUnavailable) as error:
        raise HTTPException(status_code=409,detail=str(error)) from error
    except (ValueError,TypeError) as error:
        raise HTTPException(status_code=422,detail=str(error)) from error


@router.post("/api/footprint/analyze")
async def analyze_footprints(
    chrom: str,
    region_start: int,
    region_end: int,
    spanning: bool = False,
    request: FootprintAnalysisRequest = None,
    state=Depends(get_state),
):
    """
    Analyze selected footprints: extract sequences, scan motifs, compute overlap
    statistics, aggregate profiles, and V-plot data.
    Runs in thread to avoid blocking event loop.
    """
    return await asyncio.to_thread(
        analyze_footprints_payload,
        state,
        chrom=chrom,
        region_start=region_start,
        region_end=region_end,
        spanning=spanning,
        request=request,
    )


@router.post('/api/footprint/consensus/jobs/{job_id}/bam-export')
async def export_consensus_bams(job_id: str, request: dict, state=Depends(get_state)):
    from services.consensus_workflow import export_family_bams
    from pysam import SamtoolsError
    try:
        return await asyncio.to_thread(export_family_bams,state,job_id,request.get('output_dir'),request.get('grouping','datasets'),request.get('scope','regions'))
    except KeyError as error:
        raise HTTPException(status_code=404,detail='Consensus job not found') from error
    except (ValueError,OSError,SamtoolsError) as error:
        raise HTTPException(status_code=422,detail=str(error)) from error
