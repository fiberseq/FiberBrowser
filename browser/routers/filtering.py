"""Read filtering, sorting, transcription state, Pol II COM, and autozoom endpoints.

Extracted from server.py.
"""
from __future__ import annotations

import asyncio

from fastapi import Request, APIRouter, Query, Depends, HTTPException
from typing import Optional

from state.dependencies import get_state
from models.requests import (
    AnalysisFilterRequest,
    AutozoomRequest,
    FilterRequest,
    Pol2COMRequest,
    SortReadsRequest,
    TranscriptionStateFilterRequest,
)
from services.autozoom_endpoint import autozoom_for_request
from services.filtering_endpoint import (
    filter_reads_by_analysis_rule_for_request,
    filter_by_transcription_state_for_request,
    filter_reads_for_request,
    sort_reads_for_request,
)
from services.pol2_endpoint import pol2_com_for_request


router = APIRouter(tags=["filtering"])


@router.post("/api/filter")
async def filter_reads(
    req: FilterRequest, 
    chrom: str = Query(...), 
    start: int = Query(...), 
    end: int = Query(...), 
    spanning: bool = Query(False),
    dataset_id: Optional[str] = Query(None),
    state=Depends(get_state)):
    """Filter reads by accessibility at selected peaks.
    
    Uses WORKING SET for fast filtering on all spanning reads.
    
    Either: Filter to reads that cover all selected peaks (have data, not gaps at those positions)
    Open: >50% of footprint coverage in selected peaks is subnucleosomal (<90bp)
    Closed: >50% of footprint coverage in selected peaks is nucleosomal (>=90bp)
    """
    return await asyncio.to_thread(
        filter_reads_for_request,
        state,
        req,
        chrom=chrom,
        start=start,
        end=end,
        spanning=spanning,
        dataset_id=dataset_id,
    )


@router.post("/api/filter_by_analysis_rule")
async def filter_by_analysis_rule(
    req: AnalysisFilterRequest,
    chrom: str = Query(...),
    start: int = Query(...),
    end: int = Query(...),
    spanning: bool = Query(False),
    state=Depends(get_state)):
    """Filter reads by a reusable analysis-rule metric and scope."""
    try:
        return await asyncio.to_thread(
            filter_reads_by_analysis_rule_for_request,
            state,
            req,
            chrom=chrom,
            start=start,
            end=end,
            spanning=spanning,
        )
    except ValueError as error:   # a rule the request can't evaluate (a hub hit whose scan is closed, a missing metric)
        raise HTTPException(status_code=422, detail=str(error)) from error


@router.post("/api/sort_reads")
async def sort_reads(
    req: SortReadsRequest,
    chrom: str = Query(...),
    start: int = Query(...),
    end: int = Query(...),
    spanning: bool = Query(False),
    request: Request = None,
    state=Depends(get_state)):
    """
    Generalized read/cluster sorting.

    sort_by modes:
    - 'rule': Count footprints matching a colormap rule (size range + conditions)
    - 'fp_count': Total footprint count
    - 'fp_rate': Footprint rate (sum positive sizes / sum all sizes)
    - 'accessibility': 1 - fp_rate
    - 'similarity': Hierarchical cluster ordering (clusters only)
    - 'projection': Along the t-SNE map: neighbours on the map end up next
      to each other (clusters only; `projection` gives the map's features)
    - 'value': a per-molecule scalar (`molecule_metric`: nucmol / nfrmol); reads without one last
    - 'feature_hub': the number of the given hub hits where the read is in the given state
    """
    # Every mode loads the working set (and a t-SNE map can take seconds): off the event loop.
    from services.background_work import Cancelled, cancelled_response, run_background
    try:
        return await run_background(request, object(), sort_reads_for_request,
            state, req, chrom=chrom, start=start, end=end, spanning=spanning)
    except Cancelled:
        return cancelled_response()
    except ValueError as error:   # a rule the request can't evaluate (a hub hit whose scan is closed, a missing metric)
        raise HTTPException(status_code=422, detail=str(error)) from error


@router.post("/api/filter_by_transcription_state")
async def filter_by_transcription_state(
    req: TranscriptionStateFilterRequest,
    chrom: str = Query(...),
    start: int = Query(...),
    end: int = Query(...),
    spanning: bool = Query(False),
    state=Depends(get_state)):
    """
    Filter reads by transcription state criteria relative to selected gene(s).

    States (not mutually exclusive):
    - Pause: TSS+10 to TSS+50, median footprint size 35-65bp
    - PIC: TSS-50 to TSS+25, median 20-40 OR 60-80bp
    - Elongating: Count of 35-65bp footprints in gene body >= threshold

    Returns filtered read IDs and per-read state details for visualization.
    """
    return await asyncio.to_thread(
        filter_by_transcription_state_for_request,
        state,
        req,
        chrom=chrom,
        start=start,
        end=end,
        spanning=spanning,
    )


@router.post("/api/pol2_com")
async def pol2_com(
    req: Pol2COMRequest,
    chrom: str = Query(...),
    start: int = Query(...),
    end: int = Query(...),
    spanning: bool = Query(False),
    state=Depends(get_state)):
    """
    Compute Pol II center-of-mass heatmaps for reads overlapping selected genes.

    For each read: compute COM of Pol II-sized footprints in the gene body,
    build a binary occupancy row (gene body) and an accessibility row
    (>100bp MSPs across the full viewport). Rows are sorted by COM value.
    """
    return await asyncio.to_thread(
        pol2_com_for_request,
        state,
        req,
        chrom=chrom,
        start=start,
        end=end,
        spanning=spanning,
    )


@router.post("/api/autozoom")
async def autozoom(
    req: AutozoomRequest,
    chrom: str = Query(...),
    start: int = Query(...),
    end: int = Query(...),
    spanning: bool = Query(False),
    state=Depends(get_state)):
    """
    Find the optimal window within +/- distance that maximizes spanning reads.
    
    For targeted DAF-seq: detects primer sites (clusters of read starts/ends)
    and clips inward to maximize spanning reads.
    
    Algorithm:
    1. Find clusters of read starts (primer sites on left)
    2. Find clusters of read ends (primer sites on right)
    3. Use cluster positions + inward clipping as optimal window
    """
    return await asyncio.to_thread(
        autozoom_for_request,
        state,
        req,
        chrom=chrom,
        start=start,
        end=end,
    )
