"""Orthogonal track management, BigBed operations, and GTF endpoints.

Extracted from server.py.
"""
from __future__ import annotations

from utils.responses import content_disposition
from fastapi import APIRouter, Query, Depends, UploadFile, File
from fastapi.responses import JSONResponse, Response
from typing import Optional

from models.requests import MotifFileRequest, MotifJasparTrackRequest, MotifPwmTrackRequest, MotifSequenceRequest, TracksBatchBody, TracksExportBody
from state.dependencies import get_state
from services.bigbed_names import get_bigbed_names_payload
from services.external_ucsc import _disk_cache
from services.tracks_endpoint import (
    add_motif_file_tracks_for_request,
    add_motif_jaspar_tracks_for_request,
    add_motif_pwm_track_for_request,
    add_motif_sequence_track_for_request,
    add_track_for_request,
    build_multi_track_export_payload,
    build_single_track_export_payload,
    get_track_annotations_payload,
    get_track_data_payload,
    get_tracks_batch_payload,
    get_tracks_payload,
    remove_track_for_request,
    reorder_tracks_for_request,
    update_track_filter_for_request,
)
from services.local_paths import normalize_local_path, path_access_error
import asyncio
import os

router = APIRouter(tags=["tracks"])


@router.post("/api/tracks/batch")
async def get_tracks_batch(body: TracksBatchBody, state=Depends(get_state)):
    """Get signal/annotation payloads for multiple orthogonal tracks at once."""
    return await asyncio.to_thread(get_tracks_batch_payload, state, body)


# Before /api/tracks/{track_idx} so 'recent' isn't taken as an index.
@router.get("/api/tracks/recent")
def get_recent_tracks():
    """Track sources used before (any session), most recent first."""
    from services.recent_tracks import list_recent
    return {"tracks": list_recent()}


@router.post("/api/tracks/recent")
def remember_recent_track(entry: dict):
    """Remember where a track came from (path/URL, label, kind; no data)."""
    from services.recent_tracks import remember
    try:
        return remember(entry)
    except ValueError as exc:
        return {"success": False, "error": str(exc)}


@router.delete("/api/tracks/recent")
def forget_recent_track(key: str = Query(...)):
    from services.recent_tracks import forget
    return forget(key)


@router.get("/api/tracks/{track_idx}")
async def get_track_data(
    track_idx: int,
    chrom: str = Query(...),
    start: int = Query(...),
    end: int = Query(...),
    bins: int = Query(500),
    state=Depends(get_state)):
    """Get signal data for an orthogonal track."""
    return get_track_data_payload(state, track_idx, chrom, start, end, bins)


@router.get("/api/tracks/{track_idx}/export")
async def export_track(
    track_idx: int,
    chrom: str = Query(...),
    start: int = Query(...),
    end: int = Query(...),
    bins: int = Query(2000),
    format: str = Query("bedgraph"),
    state=Depends(get_state)):
    """Export a track region as bedGraph (or, for `format=tsv`, a 4-column TSV).

    Returns one row per bin, where each bin spans `(end-start)/bins` bases
    starting at `start`. NaN/None values are emitted as 0. Mirrors what the
    UI sends to the browser canvas, so `Cart → Export` and direct API calls
    return the same numbers.
    """
    result = build_single_track_export_payload(
        state,
        track_idx=track_idx,
        chrom=chrom,
        start=start,
        end=end,
        bins=bins,
        format=format,
    )
    if "error" in result:
        return JSONResponse({"error": result["error"]}, status_code=result["status_code"])

    export = result["export"]
    headers = {
        "Content-Disposition": content_disposition(export["filename"]),
    }
    return Response(content=export["content"], media_type=export["media_type"], headers=headers)


@router.post("/api/tracks/export")
async def export_tracks_multi(body: TracksExportBody, state=Depends(get_state)):
    """Export multiple tracks in a single TSV — bin column joined across all
    given track indices. Emits `chrom\\tstart\\tend\\t<label1>\\t<label2>...`.
    """
    result = build_multi_track_export_payload(state, body)
    if "error" in result:
        return JSONResponse({"error": result["error"]}, status_code=result["status_code"])

    export = result["export"]
    headers = {
        "Content-Disposition": content_disposition(export["filename"]),
    }
    return Response(content=export["content"], media_type=export["media_type"], headers=headers)


@router.get("/api/tracks/{track_idx}/annotations")
async def get_track_annotations(
    track_idx: int,
    chrom: str = Query(...),
    start: int = Query(...),
    end: int = Query(...),
    filter_names: str = Query(None),
    state=Depends(get_state)):
    """Get annotation intervals for an orthogonal track (bed/genePred/bigBed/rmsk)."""
    return get_track_annotations_payload(state, track_idx, chrom, start, end, filter_names)


@router.post("/api/load_gtf")
async def load_gtf_endpoint(path: str = Query(...),
    state=Depends(get_state)):
    """Load a GTF or GFF3 annotation file.

    Runs GTF parsing in a thread pool to avoid blocking the event loop.
    """

    original_path = path
    path = normalize_local_path(path)
    if not os.path.isfile(path):
        return {
            "success": False,
            "message": path_access_error(path, original_path=original_path, expected="file") or f"File not found: {path}",
        }

    try:
        from services.gene_annotations import load_gtf

        gtf_data = await asyncio.to_thread(load_gtf, path)   # parsed outside the reference lock

        def publish():
            from services.genome_loading import reference_lock
            with reference_lock(state):
                state.gtf_data = gtf_data
                state.gtf_path = path
        await asyncio.to_thread(publish)
        gene_count = len(state.gtf_data.get("transcripts", [])) if state.gtf_data is not None else 0
        return {
            "success": True,
            "message": f"Loaded {gene_count} genes from {os.path.basename(path)}",
            "gene_count": gene_count
        }
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"success": False, "message": str(e)}


@router.post("/api/add_track")
async def add_track_endpoint(
    path: str = Query(...),
    label: str = Query(None),
    render_mode: str = Query(None),
    track_type: str = Query(None),
    ucsc_genome: str = Query(None),
    ucsc_track: str = Query(None),
    filter_names: str = Query(None),
    category: str = Query(None),
    state=Depends(get_state)):
    """Add an orthogonal bigWig, bigBed, or UCSC API-backed track"""
    from services.runtime import get_public_mode, get_visitor_public_mode
    if get_visitor_public_mode():
        # A public server (or a lab server's anonymous catalog visitor) shows
        # its catalog only (the route guard refuses this too).
        return JSONResponse(status_code=403, content={
            "success": False, "message": "Tracks can't be added on a public server."})
    if get_public_mode() and not path.startswith("ucsc://"):
        from services.public_mode_guard import public_track_url_allowed
        if not public_track_url_allowed(path):
            return JSONResponse(status_code=403, content={
                "success": False, "message": "Only https tracks from the public track hosts can be added on a public server."})
    return add_track_for_request(
        state,
        path=path,
        label=label,
        render_mode=render_mode,
        track_type=track_type,
        ucsc_genome=ucsc_genome,
        ucsc_track=ucsc_track,
        filter_names=filter_names,
        category=category,
    )


@router.post("/api/tracks/add_motif_sequence")
async def add_motif_sequence(req: MotifSequenceRequest,
    state=Depends(get_state)):
    """Add a custom motif track from an IUPAC consensus sequence."""
    return add_motif_sequence_track_for_request(state, req)


@router.post("/api/tracks/add_motif_file")
async def add_motif_file(req: MotifFileRequest,
    state=Depends(get_state)):
    """Add motif tracks from a motif database file (.jaspar, .meme, .pfm, .homer, .motif)."""
    return add_motif_file_tracks_for_request(state, req)


@router.post("/api/tracks/add_motif_pwm")
async def add_motif_pwm(req: MotifPwmTrackRequest,
    state=Depends(get_state)):
    """Add a custom motif track from a raw PWM/count dictionary."""
    return add_motif_pwm_track_for_request(state, req)


@router.post("/api/tracks/add_motif_jaspar")
def add_motif_jaspar(req: MotifJasparTrackRequest, state=Depends(get_state)):
    """Add JASPAR CORE matrices (by matrix ID) as motif tracks."""
    return add_motif_jaspar_tracks_for_request(state, req)


@router.get("/api/motifs/jaspar/search")
def search_jaspar_motifs(q: str = Query(...), limit: int = Query(20, ge=1, le=100),
    genome: str = Query(None), state=Depends(get_state)):
    """Search JASPAR CORE by TF name or matrix ID (e.g. CTCF, MA0139); the loaded
    genome's taxon ranks first."""
    from services import motifs as motif_service

    if not motif_service.check_pyjaspar():
        return {"available": False, "results": [], "message": "Install pyjaspar to search JASPAR"}
    # The panel's reference: its own genome, the one it was built from (an expanded insert), or the declared one.
    taxon = motif_service.genome_taxon(genome or motif_service.jaspar_genome(state)[0])
    return {"available": True, "results": motif_service.search_jaspar(q, limit=limit, taxon=taxon)}


@router.post("/api/motifs/parse")
def parse_motifs(request: dict):
    """Custom motifs from pasted text (IUPAC consensus, a bare PFM, or JASPAR / MEME / HOMER format): [{name, counts}],
    scored by the shared motif engine like JASPAR matrices (services.motif_scoring)."""
    from fastapi import HTTPException
    from services.motif_scoring import parse_motif_text

    request = request if isinstance(request, dict) else {}
    try:
        return {"motifs": parse_motif_text(str(request.get("text") or ""), (str(request.get("name")).strip() or None) if request.get("name") else None)}
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@router.get("/api/bigbed/names")
async def get_bigbed_names(url: str = Query(...), genome: str = Query(None), sample_size: int = Query(500_000)):
    """Get unique TF names from JASPAR.

    Strategy: JASPAR REST API first (fast JSON, ~50KB), BigBed sampling as fallback.
    Results are cached in memory for instant subsequent calls.
    """
    return await get_bigbed_names_payload(
        url=url,
        genome=genome,
        sample_size=sample_size,
        disk_cache=_disk_cache,
    )


@router.post("/api/tracks/{track_idx}/filter")
async def update_track_filter(track_idx: int, body: dict,
    state=Depends(get_state)):
    """Update the name filter on a loaded track."""
    return update_track_filter_for_request(state, track_idx, body)


@router.get("/api/tracks")
async def get_tracks(state=Depends(get_state)):
    """Get list of loaded orthogonal tracks"""
    return get_tracks_payload(state)


@router.post("/api/tracks/reorder")
async def reorder_tracks(body: dict,
    state=Depends(get_state)):
    """Reorder orthogonal tracks by moving one from from_index to to_index"""
    return reorder_tracks_for_request(state, body)


@router.delete("/api/tracks/{track_idx}")
async def remove_track(track_idx: int,
    state=Depends(get_state)):
    """Remove an orthogonal track"""
    return remove_track_for_request(state, track_idx)


@router.delete("/api/gtf")
async def remove_gtf(state=Depends(get_state)):
    """Remove loaded GTF annotations"""
    def clear():
        from services.genome_loading import reference_lock
        with reference_lock(state):
            state.gtf_data = None
    await asyncio.to_thread(clear)
    return {"success": True, "message": "GTF annotations removed"}
