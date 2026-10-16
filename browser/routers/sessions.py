"""Session save/load and overlay endpoints.

Extracted from server.py.
"""
from __future__ import annotations

import asyncio

from utils.responses import content_disposition
from fastapi import APIRouter, Query, Depends, Request
from fastapi.responses import JSONResponse

from models.requests import SessionExportRequest, SessionFileCheckRequest, SessionImportRequest
from utils.request_body import json_object_body
from state.dependencies import get_state, get_dafc_state
from services.overlays_endpoint import (
    add_overlay_for_request,
    get_overlay_marks_payload,
    get_overlays_payload,
    remove_overlay_for_request,
)
from services.sessions_endpoint import build_session_export_for_request, import_session_for_request

router = APIRouter(tags=["sessions"])


@router.post("/api/session/export")
async def export_session(req: SessionExportRequest,
    state=Depends(get_state), dafc_state=Depends(get_dafc_state)):
    """Export current browser session state as JSON.

    Frontend POSTs its UI state; backend merges with server-side state.
    Returns a complete session JSON for download.
    """
    try:
        export = build_session_export_for_request(state, req, dafc_state=dafc_state)
        return JSONResponse(
            content=export["session"],
            headers={
                "Content-Disposition": content_disposition(export["filename"])
            }
        )

    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}


@router.get("/api/session/launch")
async def session_launch():
    """This server run's boot id and how the previous run on its port ended
    (none, clean, crash, unknown): a normal quit offers "Reopen your last
    session", a crash the crash recovery (services/launch_state.py)."""
    from services.launch_state import launch_info
    from services.runtime import get_public_mode
    info = launch_info()
    if get_public_mode():
        info["previous_exit"] = "unknown"
    return info


@router.post("/api/session/check_files")
def check_session_files_route(req: SessionFileCheckRequest):  # sync: walks/hashes files in the threadpool
    """List a session's local input files and whether each exists here.

    Called before import so missing files can be relinked without clearing
    the current browser state. ``anchor`` and ``search_root`` extend the
    returned ``mapping``; pass it back as ``path_mapping`` on import.
    """
    from services.session_files import check_session_files

    return check_session_files(
        req.session,
        mapping=req.mapping,
        anchor=req.anchor,
        search_root=req.search_root,
    )


@router.post("/api/session/read")
def read_session_file(path: str = Query(...)):
    """Read a session JSON on this machine (Load File / drag and drop)."""
    import json
    import os

    from services.lab.paths import confine, open_read
    from services.local_paths import normalize_local_path

    confine(path)  # a lab server: only inside its data folders (resolved as below)
    full = normalize_local_path(path)
    if not full.lower().endswith(".json"):
        return {"success": False, "error": "Session files are .json"}
    if not os.path.isfile(full):
        return {"success": False, "error": f"File not found: {path}"}
    try:
        # On a lab server opened by the checked descriptor walk (never a swapped-in link).
        with open_read(full) as handle:
            if os.fstat(handle.fileno()).st_size > 200 * 1024 * 1024:
                return {"success": False, "error": "Session file is too large"}
            return {"success": True, "session": json.loads(handle.read().decode("utf-8"))}
    except (OSError, ValueError) as exc:
        return {"success": False, "error": f"Not a readable session file: {exc}"}


@router.post("/api/session/import")
async def import_session(req: SessionImportRequest,
    state=Depends(get_state), dafc_state=Depends(get_dafc_state)):
    """Import a browser session from JSON (v1.0 and v2.0 compatible).

    Clears existing state and restores everything from the session file.
    Returns full state so the frontend can restore programmatically without a page reload.
    """
    try:
        # Off the event loop: the import loads files and waits for the reference lock (a genome download may
        # hold it), which must not stall every other request.
        return await asyncio.to_thread(import_session_for_request, state, req, dafc_state=dafc_state)

    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}


@router.get("/api/overlays")
async def get_overlays(state=Depends(get_state)):
    """Get list of loaded modification overlays."""
    return get_overlays_payload(state)


@router.post("/api/overlays/add")
async def add_overlay(request: Request,
    state=Depends(get_state)):
    """Add a modification overlay from a bigBed file or directory.

    Type is auto-detected from filename (looking for _m6a, _m5c, _footprint, _fire/_msp patterns).
    Can be overridden by specifying 'type' in the request.
    """
    return add_overlay_for_request(state, await json_object_body(request))


@router.delete("/api/overlays/{overlay_id}")
async def remove_overlay(overlay_id: str,
    state=Depends(get_state)):
    """Remove a modification overlay."""
    return remove_overlay_for_request(state, overlay_id)


@router.get("/api/overlays/{overlay_id}/marks")
async def get_overlay_marks(
    overlay_id: str,
    chrom: str = Query(...),
    start: int = Query(...),
    end: int = Query(...),
    state=Depends(get_state)):
    """Get modification marks from an overlay for the given region.
    
    Returns a dict mapping read_id -> list of positions (relative to region start).
    """
    return get_overlay_marks_payload(state, overlay_id, chrom, start, end)
