"""Find a pasted sequence in the loaded genome (services/sequence_search.py): the search's status and
defaults, a search as a background job (poll it, cancel it), and a finished search's hits as a track.

Host compute (a scan of the whole genome, BLAST and its database build), like Identify and the primer
designer: refused on a --public server (tests/test_public_mode_guard.py lists these routes as denied).
On a lab server members may search: the request carries the sequence and numbers only, never a path,
and the reference is read through the confined FASTA readers."""
from __future__ import annotations

import asyncio
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from state.dependencies import get_state
from utils.responses import ORJSONResponse

router = APIRouter(tags=["sequence-search"])

LOCAL_ONLY = "Finding a sequence in the genome is only available in FiberBrowser on your own computer or a lab server."


def _local_only() -> None:
    from services.runtime import get_public_mode
    if get_public_mode():
        raise HTTPException(status_code=403, detail=LOCAL_ONLY)


class SequenceSearchRequest(BaseModel):
    sequence: str = Field(..., max_length=400_000)  # pasted text (FASTA headers, spaces, numbers allowed)
    mode: Optional[str] = None
    exact_max_length: Optional[int] = None
    max_mismatches: Optional[int] = None
    evalue: Optional[float] = None
    max_hits: Optional[int] = None
    min_length: Optional[int] = None
    blast_task: Optional[str] = None


class HitsTrackRequest(BaseModel):
    label: Optional[str] = Field(None, max_length=200)


@router.get("/api/sequence_search/status")
async def sequence_search_status(state=Depends(get_state)):
    """Whether a genome is loaded and searchable, whether BLAST and its database are ready, and the defaults."""
    _local_only()
    from services.sequence_search import status_payload
    return ORJSONResponse(await asyncio.to_thread(status_payload, state))


@router.post("/api/sequence_search")
async def start_sequence_search(req: SequenceSearchRequest, state=Depends(get_state)):
    """Start a search (validated now: a bad query or no genome is answered at once)."""
    _local_only()
    from services.sequence_search import search_request
    settings = req.model_dump(exclude={"sequence"}, exclude_none=True)
    payload = await asyncio.to_thread(search_request, state, sequence=req.sequence, settings=settings)
    return ORJSONResponse(payload)


@router.get("/api/sequence_search/jobs/{job_id}")
async def get_sequence_search_job(job_id: str):
    _local_only()
    from services.sequence_search import get_search_job
    job = get_search_job(job_id)
    if job is None:
        return ORJSONResponse({"success": False, "error": "No such search (the server may have restarted)", "status": "missing"})
    return ORJSONResponse({"success": True, **job})


@router.delete("/api/sequence_search/jobs/{job_id}")
async def cancel_sequence_search_job(job_id: str):
    _local_only()
    from services.sequence_search import cancel_search_job
    return ORJSONResponse({"success": cancel_search_job(job_id)})


@router.post("/api/sequence_search/jobs/{job_id}/track")
async def add_sequence_search_track(job_id: str, req: HitsTrackRequest, state=Depends(get_state)):
    """A finished search's hits as a temporary annotation track (this session only; not saved in sessions)."""
    _local_only()
    from services.sequence_search import add_hits_track
    return ORJSONResponse(add_hits_track(state, job_id, label=req.label))
