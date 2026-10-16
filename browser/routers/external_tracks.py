"""External Track Source endpoints — UCSC, ENCODE, ChIP-Atlas integration.

Extracted from server.py. Contains endpoints for browsing and searching
external genomic track databases (UCSC Genome Browser, ENCODE, ChIP-Atlas).
Includes associated globals, caches, and helper functions.
"""
from __future__ import annotations

from fastapi import APIRouter, Query, Depends

from services.external_chipatlas import (
    get_chipatlas_facets_for_genome,
    get_chipatlas_status_payload,
    search_chipatlas_tracks,
)
from services.external_encode import get_encode_facets_for_genome, search_encode_tracks
from services.external_ucsc import (
    UCSC_CURATED_TRACKS,
    _UCSC_GETDATA_TTL,
    _broken_url_cache,
    _fetch_ucsc_tracks,
    _ucsc_getdata_cache,
    _url_validation_cache,
    _validate_url_head,
    browse_ucsc_tracks_for_state,
    get_disk_cache,
    get_ucsc_curated_payload,
    search_ucsc_tracks_for_state,
)
from state.dependencies import get_state

router = APIRouter(tags=["external-tracks"])


# =============================================================================
# UCSC Track Browser Endpoints
# =============================================================================

@router.get("/api/ucsc/curated")
async def get_ucsc_curated(genome: str = Query(...), state=Depends(get_state)):
    """Get curated UCSC tracks for a genome."""
    return get_ucsc_curated_payload(genome, state)


@router.get("/api/ucsc/search")
async def search_ucsc_tracks(genome: str = Query(...), query: str = Query(""), state=Depends(get_state)):
    """Search UCSC tracks for a genome."""
    return search_ucsc_tracks_for_state(genome, query, state)


@router.get("/api/ucsc/browse")
async def browse_ucsc_tracks(genome: str = Query(...), state=Depends(get_state)):
    """Browse all UCSC tracks grouped by category."""
    return browse_ucsc_tracks_for_state(genome, state)


# =============================================================================
# ENCODE Integration
# =============================================================================

@router.get("/api/encode/facets")
async def get_encode_facets(genome: str = Query(...)):
    """Get available ENCODE facets (assay types, targets, biosamples) for a genome."""
    return await get_encode_facets_for_genome(genome, get_disk_cache())


@router.get("/api/encode/search")
async def search_encode(
    genome: str = Query(...),
    assay: str = Query(""),
    target: str = Query(""),
    biosample: str = Query(""),
    query: str = Query(""),
    limit: int = Query(25),
):
    """Search ENCODE for bigWig files matching filters."""
    return await search_encode_tracks(
        genome=genome,
        assay=assay,
        target=target,
        biosample=biosample,
        query=query,
        limit=limit,
    )


# =============================================================================
# ChIP-Atlas Integration
# =============================================================================

@router.get("/api/chipatlas/status")
async def get_chipatlas_status():
    """Get ChIP-Atlas metadata loading status."""
    return get_chipatlas_status_payload()


@router.get("/api/chipatlas/facets")
async def get_chipatlas_facets(genome: str = Query(...)):
    """Get available ChIP-Atlas facets for a genome. Triggers metadata download if needed."""
    return get_chipatlas_facets_for_genome(genome)


@router.get("/api/chipatlas/search")
async def search_chipatlas(
    genome: str = Query(...),
    antigen_class: str = Query(""),
    antigen: str = Query(""),
    cell_type_class: str = Query(""),
    cell_type: str = Query(""),
    limit: int = Query(25),
):
    """Search ChIP-Atlas experiments and return bigWig URLs."""
    return search_chipatlas_tracks(
        genome=genome,
        antigen_class=antigen_class,
        antigen=antigen,
        cell_type_class=cell_type_class,
        cell_type=cell_type,
        limit=limit,
    )
