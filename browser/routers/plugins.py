"""Plugin discovery endpoints."""
from __future__ import annotations

from fastapi import APIRouter

router = APIRouter(tags=["plugins"])


@router.get("/api/plugins/registry")
async def plugin_registry():
    """Return plugin manifests for frontend discovery."""
    from plugins.loader import get_plugin_manifests

    return {"plugins": get_plugin_manifests()}
