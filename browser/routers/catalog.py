"""Dataset catalog endpoints for --catalog / --public review deployments."""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends

from services.catalog_endpoint import (
    CATALOG_DIAGNOSTICS_ENV,
    catalog_diagnostics_enabled,
    catalog_load_payload,
    catalog_track_load_payload,
    catalog_track_unload_payload,
    catalog_unload_payload,
    get_catalog_payload,
    log_catalog_diagnostic,
    set_catalog,
)
from state.dependencies import get_state

router = APIRouter(tags=["catalog"])


@router.get("/api/catalog")
async def get_catalog(state=Depends(get_state)):
    """Return the catalog plus per-session loaded state, or null if disabled."""
    return get_catalog_payload(state)


@router.post("/api/catalog/load")
async def catalog_load(group_index: int, state=Depends(get_state)):
    """Load all datasets in a catalog group for this session."""
    from services.runtime import allow_shared_writes
    # Catalog datasets are the host's own choice, so the reference facts
    # inferred while loading them (chromosomes, circular contigs) may fill
    # in the reference every visitor shares.
    def load():
        with allow_shared_writes():
            return catalog_load_payload(state, group_index)
    # In a worker: registering datasets waits for the state lock (services/genome_loading).
    return await asyncio.to_thread(load)


@router.post("/api/catalog/unload")
async def catalog_unload(group_index: int, state=Depends(get_state)):
    """Unload a catalog group for this session."""
    return await asyncio.to_thread(catalog_unload_payload, state, group_index)


@router.post("/api/catalog/tracks/load")
async def catalog_track_load(track_index: int, state=Depends(get_state)):
    """Load a catalog track into this session's orthogonal_tracks."""
    return catalog_track_load_payload(state, track_index)


@router.post("/api/catalog/tracks/unload")
async def catalog_track_unload(track_index: int, state=Depends(get_state)):
    """Unload a catalog track from this session."""
    return catalog_track_unload_payload(state, track_index)
