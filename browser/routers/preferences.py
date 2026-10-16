"""The user's analysis preferences on this computer (services/analysis_preferences.py): the pinned key-factor
motifs per species, the custom motifs and the per-key maps plugin packs add. Not on public servers (one file
shared by every visitor) and read-only in a tour tab."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

router = APIRouter(tags=["preferences"])


@router.get('/api/preferences/analysis')
async def get_analysis_preferences():
    from services.analysis_preferences import load_preferences
    return load_preferences()


@router.put('/api/preferences/analysis')
async def put_analysis_preferences(request: dict):
    from services.analysis_preferences import update_preferences
    from services.runtime import current_sandbox_id, get_public_mode
    if get_public_mode() or current_sandbox_id() is not None:
        raise HTTPException(403, 'Preferences are kept only by your own FiberBrowser')
    try:
        return update_preferences(request)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    except OSError as error:
        raise HTTPException(500, f'Could not save the preferences: {error}') from error
