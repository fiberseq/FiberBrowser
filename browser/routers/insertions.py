"""Insertion lens endpoints: insertion clusters in a region, and one cluster's carriers
in insertion-local coordinates (services/insertion_lens.py); identifying an insertion's
consensus (services/insertion_identify.py, services/te_library.py); and alt-allele panels, an
insertion's carriers as a dataset on its alternate allele (services/alt_allele.py)."""
from __future__ import annotations

import asyncio
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from services.insertion_lens import (
    DEFAULT_FLANK,
    DEFAULT_MAX_CARRIERS,
    DEFAULT_MAX_REFERENCE,
    DEFAULT_MIN_LEN,
    DEFAULT_TOLERANCE,
    MAX_FLANK,
    insertion_clusters_payload,
    insertion_lens_payload,
)
from services.query_params import parse_optional_csv_list
from state.dependencies import get_state
from utils.responses import ORJSONResponse

router = APIRouter(tags=["insertions"])


@router.get("/api/insertions/clusters")
async def get_insertion_clusters(
    chrom: str = Query(...),
    start: int = Query(..., ge=0),
    end: int = Query(..., ge=0),
    dataset_id: Optional[str] = Query(None),
    min_len: int = Query(DEFAULT_MIN_LEN, ge=1),
    tolerance: int = Query(DEFAULT_TOLERANCE, ge=0, le=1000),
    conflict_options: Optional[str] = Query(None),
    request: Request = None,
    state=Depends(get_state),
):
    """Insertions of at least ``min_len`` bp whose left breakpoint lies in the region, clustered.
    Off the read path (services/background_work.py): identical requests share one answer, a
    client that goes away stops it, and the reads' SV events are cached in tiles."""
    from services.background_work import Cancelled, cancelled_response, dataset_identity, run_background
    key = ("insertion_clusters", id(state), chrom, start, end, dataset_id, min_len, tolerance, conflict_options,
           dataset_identity(state, [dataset_id] if dataset_id else list(getattr(state, "dataset_order", []) or [])),
           repr(getattr(state, "chrom_map", None)))
    try:
        payload = await run_background(
            request, key, insertion_clusters_payload, state, chrom=chrom, start=start, end=end,
            dataset_id=dataset_id, min_len=min_len, tolerance=tolerance, conflict_options=conflict_options,
        )
    except Cancelled:
        return cancelled_response()
    return ORJSONResponse(payload)


@router.get("/api/insertions/lens")
async def get_insertion_lens(
    chrom: str = Query(...),
    pos: int = Query(..., ge=0),
    dataset_id: Optional[str] = Query(None),
    tolerance: int = Query(DEFAULT_TOLERANCE, ge=0, le=1000),
    conflict_options: Optional[str] = Query(None),
    len_min: int = Query(DEFAULT_MIN_LEN, ge=1),
    len_max: Optional[int] = Query(None, ge=1),
    ref: Optional[int] = Query(None, ge=0),
    length: Optional[int] = Query(None, ge=1),
    include_duplicates: bool = Query(False),
    flank: int = Query(DEFAULT_FLANK, ge=0, le=MAX_FLANK),
    max_carriers: int = Query(DEFAULT_MAX_CARRIERS, ge=1, le=1000),
    max_reference: int = Query(DEFAULT_MAX_REFERENCE, ge=0, le=500),
    consensus: bool = Query(True),
    include_sequences: bool = Query(False),
    ml_threshold: int = Query(125, ge=0, le=255),
    layer_names: Optional[str] = Query(None),
    include_methylation: bool = Query(True),
    hide_terminal_gaps: bool = Query(True),
    request: Request = None,
    state=Depends(get_state),
):
    """One insertion's carriers (CIGAR and clipped) and spanning reference reads in
    insertion-local coordinates. ``ref``/``length``: the SV cluster (as "Split by
    this SV" takes it); without them the cluster is found at ``pos``."""
    from services.background_work import Cancelled, cancelled_response, dataset_identity, run_background
    from services.sv_alleles import reference_identity
    key = ('insertion_lens', id(state), chrom, pos, dataset_id, tolerance, len_min, len_max,
           ref, length, include_duplicates, flank, max_carriers, max_reference, consensus,
           include_sequences, ml_threshold, layer_names, include_methylation, hide_terminal_gaps,
           conflict_options, reference_identity(state), repr(getattr(state, 'chrom_map', None)),
           dataset_identity(state, [dataset_id] if dataset_id else list(getattr(state, 'dataset_order', []) or [])))
    try:
        payload = await run_background(
            request, key, insertion_lens_payload, state, chrom=chrom, pos=pos, dataset_id=dataset_id,
            tolerance=tolerance, len_min=len_min, len_max=len_max, ref=ref, length=length,
            include_duplicates=include_duplicates, flank=flank,
            max_carriers=max_carriers, max_reference=max_reference, consensus=consensus,
            include_sequences=include_sequences, ml_threshold=ml_threshold,
            layer_names=parse_optional_csv_list(layer_names), include_methylation=include_methylation,
            hide_terminal_gaps=hide_terminal_gaps, conflict_options=conflict_options,
        )
    except Cancelled:
        return cancelled_response()
    return ORJSONResponse(payload)


class AltAlleleRequest(BaseModel):
    dataset_id: Optional[str] = None
    chrom: str
    ref: Optional[int] = None
    length: Optional[int] = None
    pos: Optional[int] = None
    flank: Optional[int] = None
    include_reference: bool = False
    max_carriers: Optional[int] = None
    include_duplicates: bool = False


@router.post("/api/alt_allele/open")
async def open_alt_allele_endpoint(req: AltAlleleRequest, request: Request = None, state=Depends(get_state)):
    """An insertion's carriers re-aligned onto its alternate allele (reference flank + insert
    consensus + reference flank), opened as a dataset with that contig as its own reference.
    Built once per definition (cached on disk); ``built`` says whether this call built it."""
    from services.runtime import current_sandbox_id, get_public_mode
    if get_public_mode() or current_sandbox_id() is not None:
        # A tour tab (a sandbox on a local server) may expand an insertion of a bundled demo
        # (the tour's Variants section); nothing else, and never on a public server.
        from services.demo_data import is_bundled_demo_dataset
        from services.runtime import get_host_public_mode
        if current_sandbox_id() is None or get_host_public_mode() or not is_bundled_demo_dataset(state, req.dataset_id):
            raise HTTPException(status_code=403, detail="Alt-allele panels aren't available here")
    from services.alt_allele import AltAlleleError, open_alt_allele

    def run():
        try:
            return open_alt_allele(state, req.dataset_id, req.model_dump())
        except (AltAlleleError, KeyError, ValueError) as exc:
            return {"success": False, "error": str(exc)}
        except ResourceResult as exc:
            return {"success": False, "error": exc.reason, "resource": exc.payload()}

    from services.reconstruction_budget import ResourceResult
    from services.background_work import Cancelled, cancelled_response, dataset_identity, run_background
    from services.sv_alleles import reference_identity
    try:
        key = ('alt_allele', id(state), repr(req.model_dump()), reference_identity(state),
               dataset_identity(state, [req.dataset_id] if req.dataset_id else list(getattr(state, 'dataset_order', []) or [])))
        return ORJSONResponse(await run_background(request, key, run))
    except Cancelled:
        return cancelled_response()


# ---------------------------------------------------------------------------
# Identify this insertion (local BLAST/minimap2; the TE library set up by the first Identify;
# Dfam online only on opt-in)

LOCAL_ONLY = "Identifying insertions is only available in FiberBrowser on your own computer."


def _local_only() -> None:
    from services.runtime import get_public_mode
    if get_public_mode():  # host processes and downloads: never for anonymous visitors
        raise HTTPException(status_code=403, detail=LOCAL_ONLY)


class IdentifyRequest(BaseModel):
    seq: str = Field(..., max_length=100_000)
    chrom: Optional[str] = None
    ref: Optional[int] = Field(None, ge=0)
    length: Optional[int] = Field(None, ge=0)
    library_id: Optional[str] = None
    engine: str = Field("auto", pattern="^(auto|blast|minimap2)$")
    # Name reference copies from UCSC RepeatMasker: sends hit coordinates (never the sequence) to UCSC.
    rmsk: bool = False
    force: bool = False


class LibraryDownloadRequest(BaseModel):
    library_id: str


class DfamRequest(BaseModel):
    seq: str = Field(..., max_length=100_000)
    # Must be exactly true: the user clicked "Send to Dfam" for this sequence.
    opt_in: bool = False
    organism: Optional[str] = None


@router.get("/api/insertions/te_library")
async def get_te_library(refresh: bool = Query(False), state=Depends(get_state)):
    """The TE libraries for the loaded genome (installed or not, with their licences) and the tools present."""
    _local_only()
    from services.insertion_identify import reference_id, tool_status
    from services.motifs import reference_genome
    from services.te_library import library_status
    payload = library_status(reference_genome(state))
    payload["tools"] = await asyncio.to_thread(tool_status, refresh)
    payload["reference_id"] = reference_id(state)
    payload["genome_loaded"] = bool(getattr(state, "fasta_path", None))
    return ORJSONResponse({"success": True, **payload})


@router.post("/api/insertions/te_library/download")
async def download_te_library(req: LibraryDownloadRequest, state=Depends(get_state)):
    """Set up and cache a TE library now (bundled copy or one download; sends nothing about the
    user's data). The panel doesn't need it (Identify sets the library up itself); kept for scripts."""
    _local_only()
    from services.motifs import reference_genome
    from services.te_library import download_library, library_entry, library_status
    if library_entry(req.library_id) is None:
        return ORJSONResponse({"success": False, "error": f"Unknown TE library: {req.library_id}"})
    try:
        info = await asyncio.to_thread(download_library, req.library_id)
    except Exception as exc:
        return ORJSONResponse({"success": False, "error": f"Could not download the TE library: {exc}"})
    return ORJSONResponse({"success": True, "families": info.get("n_families"),
                           **library_status(reference_genome(state))})


@router.post("/api/insertions/identify")
async def start_identify(req: IdentifyRequest, state=Depends(get_state)):
    """Start identifying a consensus in the background (or return the cached result)."""
    _local_only()
    from services.insertion_identify import identify_request
    payload = await asyncio.to_thread(
        identify_request, state, seq=req.seq, chrom=req.chrom, ref=req.ref, length=req.length,
        library_id=req.library_id, engine=req.engine, rmsk=req.rmsk, force=req.force,
    )
    return ORJSONResponse(payload)


@router.get("/api/insertions/identify/jobs/{job_id}")
async def get_identify_job(job_id: str):
    _local_only()
    from services.insertion_identify import get_job
    job = get_job(job_id)
    if job is None:
        return ORJSONResponse({"success": False, "error": "No such job (the server may have restarted)", "status": "missing"})
    return ORJSONResponse({"success": True, **job})


@router.delete("/api/insertions/identify/jobs/{job_id}")
async def cancel_identify_job(job_id: str):
    _local_only()
    from services.insertion_identify import cancel_job
    return ORJSONResponse({"success": cancel_job(job_id)})


@router.post("/api/insertions/identify/dfam")
async def dfam_identify(req: DfamRequest, state=Depends(get_state)):
    """Search the consensus on dfam.org. This sends the sequence there: refused without ``opt_in``."""
    _local_only()
    from services.insertion_identify import dfam_request
    return ORJSONResponse(dfam_request(state, seq=req.seq, opt_in=req.opt_in is True, organism=req.organism))
