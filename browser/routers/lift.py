"""Live-lift endpoints (DESIGN_LIVE_LIFT.md §3.1): open a lifted dataset,
inspect a graphlift map, change a lifted dataset's settings. Every route
answers 404 while the ``FIBERBROWSER_LIVE_LIFT`` flag is off."""
from __future__ import annotations

import asyncio
from typing import Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field

from state.dependencies import get_state

router = APIRouter(tags=["live lift"])


class LiftDatasetRequest(BaseModel):
    paths: list[str] = Field(default_factory=list, description="Source BAM file(s), aligned to the source assembly")
    manifest: str = Field(..., description="The graphlift sidecar manifest (.graphlift.json)")
    haplotypes: list[str] = Field(default_factory=list, description="Haplotype keys or labels (MAT/PAT); empty: all")
    settings: Optional[dict] = None
    label: Optional[str] = None


class LiftSettingsRequest(BaseModel):
    settings: Optional[dict] = None
    haplotypes: Optional[list[str]] = None


@router.get("/api/lift/enabled")
async def lift_enabled():
    from services.lift.dataset import live_lift_enabled
    return {"enabled": live_lift_enabled()}


@router.get("/api/lift/inspect")
async def lift_inspect(manifest: str = Query(..., description="graphlift sidecar manifest")):
    from services.lift.registration import inspect_map
    try:
        return await asyncio.to_thread(inspect_map, manifest)
    except (OSError, ValueError) as exc:
        return {"success": False, "error": f"Cannot read the map: {exc}"}


@router.post("/api/lift/datasets")
async def lift_add_dataset(req: LiftDatasetRequest, state=Depends(get_state)):
    from services.lift.registration import add_live_lift_dataset
    return await asyncio.to_thread(add_live_lift_dataset, state, paths=req.paths, manifest=req.manifest,
                                   haplotypes=req.haplotypes, settings=req.settings, label=req.label)


@router.post("/api/lift/datasets/{dataset_id}/settings")
async def lift_update_settings(dataset_id: str, req: LiftSettingsRequest, state=Depends(get_state)):
    from services.lift.registration import update_settings
    return update_settings(state, dataset_id, req.settings, req.haplotypes)
