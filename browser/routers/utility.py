"""Miscellaneous utility endpoints (new window, etc.).

Extracted from server.py.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request

from state.dependencies import get_dafc_state, get_state
from services.remote_access import lifecycle_refusal
from services.runtime import get_public_mode
from utils.ports import check_port_in_use

import sys

router = APIRouter(tags=["utility"])
_pending_shutdown_task = None

# Open browser tabs report in every TAB_HEARTBEAT_S seconds (browsers slow
# timers in background tabs to about once a minute, so a tab counts as open
# for TAB_ALIVE_S after its last report). Closing a tab starts a monitor that
# shuts the server down once no open tab remains; a reload registers a new
# page id well within that time.
#
# Only the owner's own tabs count (services/remote_access.py): a tab of
# another device (a phone through tailscale serve, a laptop on the Wi-Fi)
# never registers, never closes and never stops the server.
TAB_HEARTBEAT_S = 10
TAB_ALIVE_S = 150
SHUTDOWN_CHECK_S = 15
_tab_last_seen: dict[str, float] = {}
_closed_tabs: set[str] = set()


def _live_tabs(now: float) -> list[str]:
    horizon = now - TAB_ALIVE_S
    return [tab for tab, seen in _tab_last_seen.items() if seen >= horizon]


def datasets_key(state) -> str:
    """A short key of the server's loaded datasets (IDs and files): it changes when one is added, removed or
    replaced, also by another tab or a script, so an open page can notice without listing them."""
    import hashlib

    items = sorted((str(d_id), tuple(str(p) for p in (getattr(d, "paths", None) or ())))
                   for d_id, d in list((getattr(state, "datasets", None) or {}).items()))
    return hashlib.sha1(repr(items).encode()).hexdigest()[:12]


@router.post("/api/tabs/heartbeat")
async def tab_heartbeat(request: Request, tab: str = Query(..., max_length=64), state=Depends(get_state)):
    """An open browser tab checking in; keeps the server alive. ``datasets``: the loaded datasets' key (a page
    compares it with the last one it saw)."""
    import time

    refusal = lifecycle_refusal(request)
    if refusal is not None:
        return refusal
    if tab in _closed_tabs:  # a report sent just before the page closed
        return {"ok": False}
    _tab_last_seen[tab] = time.monotonic()
    return {"ok": True, "datasets": datasets_key(state)}


@router.get("/api/shutdown", operation_id="shutdown_get")
@router.post("/api/shutdown", operation_id="shutdown_post")
async def shutdown(request: Request, tab: str | None = Query(None, max_length=64)):
    """A tab closed: shut down once no other tab is open. No-op in public mode;
    owner only (a tab of another device never counts)."""
    import asyncio
    import os
    import signal
    import time

    global _pending_shutdown_task
    if get_public_mode():
        return {"message": "Shutdown disabled in public mode"}
    refusal = lifecycle_refusal(request)
    if refusal is not None:
        return refusal
    if tab:
        _tab_last_seen.pop(tab, None)
        _closed_tabs.add(tab)
    if _pending_shutdown_task is None or _pending_shutdown_task.done():
        async def monitor():
            global _pending_shutdown_task
            while True:
                await asyncio.sleep(SHUTDOWN_CHECK_S)
                if not _live_tabs(time.monotonic()):
                    print("=== No browser tabs open; shutting down ===")
                    os.kill(os.getpid(), signal.SIGTERM)
                    return

        print(f"\n=== A tab closed; the server stops once no tab is open (checked every {SHUTDOWN_CHECK_S}s) ===")
        _pending_shutdown_task = asyncio.create_task(monitor())
    others = _live_tabs(time.monotonic())
    if others:
        return {"message": f"{len(others)} other tab(s) open; staying up"}
    return {"message": "Shutting down unless a tab reconnects..."}


@router.post("/api/quit")
async def quit_server(request: Request):
    """Stop the server now (the Quit button). Disabled in public mode; owner only."""
    import asyncio
    import os
    import signal

    if get_public_mode():
        return {"success": False, "message": "Quit is disabled in public mode"}
    refusal = lifecycle_refusal(request)
    if refusal is not None:
        return refusal

    async def stop():
        await asyncio.sleep(0.5)  # let this reply reach the page first
        print("\n=== Quit from the browser; shutting down ===")
        os.kill(os.getpid(), signal.SIGTERM)

    asyncio.get_running_loop().create_task(stop())
    return {"success": True, "message": "Stopping"}


@router.get("/api/cancel_shutdown", operation_id="cancel_shutdown_get")
@router.post("/api/cancel_shutdown", operation_id="cancel_shutdown_post")
async def cancel_shutdown(request: Request):
    """Compatibility: a reloaded page now simply reports in as an open tab."""
    refusal = lifecycle_refusal(request)
    if refusal is not None:
        return refusal
    return {"message": "Open tabs keep the server running"}


@router.post("/api/new-window")
async def launch_new_window(state=Depends(get_state), dafc_state=Depends(get_dafc_state)):
    """Spawn a new FiberBrowser instance on a different port."""
    import subprocess as _sp

    # 1. Find free port
    new_port = None
    # Set by the CLI launcher; a server started another way (uvicorn, tests,
    # a per-session state) has none.
    base_port = int(getattr(state, "port", None) or 8000)
    for candidate in range(base_port + 1, base_port + 100):
        if check_port_in_use(candidate) is None:
            new_port = candidate
            break
    if new_port is None:
        return {"error": "No available port found"}

    # 2. Reconstruct command from current state
    cmd = [sys.executable, sys.argv[0]]

    # Add datasets (covers both CLI and drag-and-drop loaded datasets)
    for ds_id in state.dataset_order:
        ds = state.datasets[ds_id]
        paths = ",".join(ds.paths)
        label = ds.label or ds_id
        cmd.extend(["--dataset", f"{paths}:{label}"])

    # If no datasets, run standalone
    if not state.dataset_order:
        cmd.append("--standalone")

    # Add GTF if loaded
    if state.gtf_path:
        cmd.extend(["--gtf", state.gtf_path])

    # Add FASTA if loaded
    if state.fasta_path:
        cmd.extend(["--fasta", state.fasta_path])

    # Add cool file if loaded
    if dafc_state.cool_file:
        cmd.extend(["--cool", dafc_state.cool_file])

    # Add port
    cmd.extend(["--port", str(new_port), "--no-open"])  # the calling tab opens it

    # 3. Spawn subprocess (detached, won't die with parent). It gets its own
    # access token, which the returned URL carries (services/local_auth.py).
    import os as _os
    import secrets as _secrets
    from services.local_auth import auth_enabled, tokened_url
    env = dict(_os.environ)
    url = f"http://localhost:{new_port}/"
    if auth_enabled():
        child_token = _secrets.token_urlsafe(32)
        env["FIBERBROWSER_TOKEN"] = child_token
        url = tokened_url(url, child_token)
    else:
        cmd.append("--no-token")
    proc = _sp.Popen(cmd, start_new_session=True, env=env,
                      stdout=_sp.DEVNULL, stderr=_sp.DEVNULL)

    return {"url": url, "port": new_port, "pid": proc.pid}
