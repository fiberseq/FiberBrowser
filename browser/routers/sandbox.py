"""Sandbox sessions for the guided tour (see state/sandbox.py).

The main tab creates a sandbox, then opens ``/?sandbox=<id>&tour=1`` in a new
tab; everything that tab does runs on the sandbox's own state under
public-mode rules, so the tour can never change the user's work.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from services.runtime import current_sandbox_id, get_host_public_mode
from state.sandbox import get_sandbox_manager, valid_sandbox_id

router = APIRouter(tags=["sandbox"])


def _manager():
    if get_host_public_mode():
        raise HTTPException(status_code=403, detail="Sandboxes aren't available on a public server.")
    manager = get_sandbox_manager()
    if manager is None:
        raise HTTPException(status_code=503, detail="Sandboxes aren't set up on this server.")
    return manager


def _own(sandbox_id: str) -> None:
    if not valid_sandbox_id(sandbox_id):
        raise HTTPException(status_code=400, detail="Malformed sandbox id.")
    inside = current_sandbox_id()
    if inside is not None and inside != sandbox_id:
        raise HTTPException(status_code=403, detail="A sandbox can only see itself.")


@router.post("/api/sandbox")
async def create_sandbox():
    """Start a sandbox: a separate session (empty, public-mode rules) for a tour tab."""
    if current_sandbox_id() is not None:
        raise HTTPException(status_code=403, detail="A sandbox can't start another sandbox.")
    manager = _manager()
    sandbox_id = manager.create()
    # The tour runs on the demo's own genome, whatever this tab has loaded
    # (copy-on-write: the main tab's reference is untouched). From the local
    # cache only, so it takes seconds at most; off the event loop.
    state = manager.get(sandbox_id)
    if state is not None:
        import asyncio
        from services.demo_data import ensure_demo_reference
        await asyncio.to_thread(ensure_demo_reference, state, sandbox=True)
    return {"success": True, "id": sandbox_id, "idle_ttl": manager.idle_ttl}


@router.get("/api/sandbox/{sandbox_id}")
async def sandbox_status(sandbox_id: str):
    """Whether a sandbox is still alive (it ends after idle_ttl seconds unused)."""
    _own(sandbox_id)
    manager = _manager()
    return {"id": sandbox_id, "active": manager.get(sandbox_id) is not None, "idle_ttl": manager.idle_ttl}


@router.delete("/api/sandbox/{sandbox_id}")
async def end_sandbox(sandbox_id: str):
    """End a sandbox now, freeing its state (the tab that used it stops working)."""
    _own(sandbox_id)
    return {"success": True, "ended": _manager().drop(sandbox_id)}
