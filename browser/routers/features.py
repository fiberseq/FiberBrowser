"""Features (footprint classes, plugin packs' kinds) as things the read panel clusters, sorts and filters on."""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException

from state.dependencies import get_state

router = APIRouter(tags=["features"])


@router.post('/api/features/states')
async def feature_states(request: dict, state=Depends(get_state)):
    """Per-read states ('1' member, '0' not, '.' not evaluated) of the selected features, per dataset and read name."""
    from services.feature_states import feature_states as compute
    if not isinstance(request, dict):
        raise HTTPException(status_code=422, detail='Request must be an object')
    try:
        return await asyncio.to_thread(compute, state, request.get('features'))
    except KeyError as error:
        raise HTTPException(status_code=404, detail='The run of a selected feature is not in this session') from error
    except (ValueError, TypeError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
