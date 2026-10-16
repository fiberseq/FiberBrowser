"""Independent workspaces (state/workspace.py): more isolated sessions from one launch."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from services.runtime import current_workspace_id, get_host_public_mode
from state.workspace import get_workspace_manager, may_use, request_owner, valid_workspace_id

router = APIRouter(tags=["workspaces"])


def _manager():
    if get_host_public_mode():
        raise HTTPException(status_code=403, detail="Workspaces aren't available on a public server.")
    manager = get_workspace_manager()
    if manager is None:
        raise HTTPException(status_code=503, detail="Workspaces aren't set up on this server.")
    return manager


@router.post("/api/workspaces")
async def create_workspace():
    """Start an independent workspace; open the returned url in a new tab."""
    from state.session_manager import SessionsFull
    manager = _manager()
    try:
        workspace_id = manager.create(owner=request_owner())
    except SessionsFull as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"success": True, "id": workspace_id, "url": f"/?workspace={workspace_id}",
            "idle_ttl": manager.idle_ttl}


@router.get("/api/workspaces")
async def list_workspaces():
    """The live workspaces of this server."""
    from services.runtime import get_lab_mode
    manager = _manager()
    listed = manager.owned_by(request_owner()) if get_lab_mode() else sorted(manager.sessions)
    return {"workspaces": listed, "current": current_workspace_id(),
            "max": manager.max_sessions, "idle_ttl": manager.idle_ttl}


@router.get("/api/workspaces/{workspace_id}")
async def workspace_status(workspace_id: str):
    if not valid_workspace_id(workspace_id):
        raise HTTPException(status_code=400, detail="Malformed workspace id.")
    manager = _manager()
    active = may_use(manager, workspace_id) and manager.get(workspace_id) is not None
    return {"id": workspace_id, "active": active, "idle_ttl": manager.idle_ttl}


@router.delete("/api/workspaces/{workspace_id}")
async def end_workspace(workspace_id: str):
    """End a workspace now, freeing its state (its tab stops working)."""
    if not valid_workspace_id(workspace_id):
        raise HTTPException(status_code=400, detail="Malformed workspace id.")
    manager = _manager()
    if not may_use(manager, workspace_id):
        return {"success": True, "ended": False}  # another member's: not visible here
    return {"success": True, "ended": manager.drop(workspace_id)}
