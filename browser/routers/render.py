"""Server-side rendering endpoint for headless mode.

Produces images of the browser view via one of three engines:
- headless (default): the browser's view drawn in Python (services/figure).
- numpy: legacy PIL/numpy compositor, also used when a request relies on
  its legacy-only options without choosing an engine.
- playwright: drives the live React app via headless Chromium for full
  color/rule/layer parity with the on-screen browser. See
  services/playwright_render.py.
"""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from models.requests import FigureRequest, LiveFigureState, RenderClusterRequest, RenderRequest
from services.render_endpoint import _render_sync
from services.lift.capability import LiveLiftUnsupported
from state.dependencies import get_dafc_state, get_state

# engine="playwright" in the Mac app (CLEAN_MAC_AUDIT, 3.1.1): it answered "node not found on PATH".
BROWSER_ENGINE_IN_APP = ("The browser-render engine (/api/render/figure, engine=\"playwright\") needs a FiberBrowser "
                         "source install with Node and Playwright; the app does not include them. Use the default "
                         "headless engine (POST /api/render, or BrowserClient.figure), or the Export button in "
                         "the browser.")


router = APIRouter(tags=["render"])


@router.post("/api/render")
async def render_region(request: RenderRequest, state=Depends(get_state), dafc_state=Depends(get_dafc_state)):
    """Render a browser view as PNG, SVG, or PDF (default: headless, see services/figure)."""
    try:
        from services.figure.api import BROWSER_ONLY_MESSAGE, BROWSER_ONLY_TRACKS, render_request, wants_legacy_engine
        from services.runtime import get_public_mode
        if {str(t).lower() for t in (request.tracks or [])} & BROWSER_ONLY_TRACKS:
            # No engine draws these (Plots, Gallery, Quantify, panels): say so whichever engine was asked for.
            return JSONResponse(status_code=400, content={"error": BROWSER_ONLY_MESSAGE})
        if get_public_mode():
            if request.engine != "headless" or wants_legacy_engine(request):
                return JSONResponse(status_code=403, content={"error": "Only the headless engine is available on a public server"})
            if request.session_path or request.load_session:
                return JSONResponse(status_code=403, content={"error": "session_path and load_session are not available on a public server"})
        if request.engine == "headless" and not wants_legacy_engine(request):
            return await asyncio.to_thread(render_request, request, state, dafc_state)
        if request.chrom is None or request.start is None or request.end is None:
            return JSONResponse(status_code=400, content={"error": f"engine={request.engine!r} needs chrom, start and end"})
        if request.engine == "playwright":
            from services.app_build import is_frozen
            if is_frozen():
                # The Mac app bundles neither Node nor Playwright (nor the frontend sources the worker builds).
                return JSONResponse(status_code=501, content={"error": BROWSER_ENGINE_IN_APP})
            # Lazy import so callers that never use the Playwright engine
            # don't pay the import cost (which probes the Node binary).
            from services.playwright_render import render_with_playwright
            return await asyncio.to_thread(render_with_playwright, request, state)
        return await asyncio.to_thread(_render_sync, request, state)
    except LiveLiftUnsupported:
        raise  # The shared handler preserves the 409 notice for resolved/current datasets.
    except Exception as exc:
        return JSONResponse(
            status_code=500,
            content={"error": str(exc)},
        )


@router.post("/api/render/cluster")
async def recluster_for_figure(request: RenderClusterRequest, state=Depends(get_state), dafc_state=Depends(get_dafc_state)):
    """Re-cluster a session's panels with a fixed method, k and seed; returns the updated session and assignments."""
    from services.runtime import get_public_mode
    from services.figure_render import FigureError
    if get_public_mode():
        return JSONResponse(status_code=403, content={"error": "Not available on a public server"})
    try:
        from services.figure.recluster import recluster_request
        return await asyncio.to_thread(recluster_request, request, state, dafc_state)
    except FigureError as exc:
        return JSONResponse(status_code=exc.status, content={"error": str(exc), **exc.extra})
    except (ValueError, KeyError, TypeError) as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})


@router.post("/api/render/live_state")
async def push_live_state(payload: LiveFigureState, state=Depends(get_state)):
    """The open browser tab reports what it shows, for source="current" figures."""
    from services.figure_render import store_live_state
    return store_live_state(state, payload)


@router.get("/api/render/live_state")
async def get_live_state(full: bool = False, state=Depends(get_state)):
    """Whether a browser view is available to render, and which region it shows.

    ``full=true`` also returns the browser's frontend state (for saving
    sessions from Python that match the screen)."""
    from services.figure_render import live_state_summary
    return live_state_summary(state, full=full)


@router.post("/api/render/figure")
async def render_figure_route(request: FigureRequest, state=Depends(get_state), dafc_state=Depends(get_dafc_state)):
    """Render a figure the way the browser's Export button does (PNG, SVG or PDF).

    Uses the open browser's current view (default) or a saved session, with
    optional region/size overrides. Requires Node + Playwright Chromium.
    """
    from services.app_build import is_frozen
    from services.figure_render import render_figure
    if is_frozen():
        # The Mac app bundles neither Node nor Playwright (it answered "node not found on PATH").
        return JSONResponse(status_code=501, content={"error": BROWSER_ENGINE_IN_APP})
    try:
        return await asyncio.to_thread(render_figure, request, state, dafc_state)
    except LiveLiftUnsupported:
        raise
    except Exception as exc:
        import traceback
        traceback.print_exc()
        return JSONResponse(status_code=500, content={"error": str(exc)})
