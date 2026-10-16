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

from models.requests import FigureRequest, LiveFigureState, RenderRequest
from services.render_endpoint import _render_sync
from state.dependencies import get_dafc_state, get_state

router = APIRouter(tags=["render"])


@router.post("/api/render")
async def render_region(request: RenderRequest, state=Depends(get_state), dafc_state=Depends(get_dafc_state)):
    """Render a browser view as PNG, SVG, or PDF (default: headless, see services/figure)."""
    try:
        from services.figure.api import render_request, wants_legacy_engine
        from services.runtime import get_public_mode
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
            # Lazy import so callers that never use the Playwright engine
            # don't pay the import cost (which probes the Node binary).
            from services.playwright_render import render_with_playwright
            return await asyncio.to_thread(render_with_playwright, request, state)
        return await asyncio.to_thread(_render_sync, request, state)
    except Exception as exc:
        return JSONResponse(
            status_code=500,
            content={"error": str(exc)},
        )


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
    from services.figure_render import render_figure
    try:
        return await asyncio.to_thread(render_figure, request, state, dafc_state)
    except Exception as exc:
        import traceback
        traceback.print_exc()
        return JSONResponse(status_code=500, content={"error": str(exc)})
