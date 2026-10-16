"""Open remote files from a link (session document or track hub), after confirmation.

See services/session_links.py for the flow and docs/workflows/open-from-links.md.
"""
from __future__ import annotations

import asyncio
import html
import json
import secrets
from typing import Optional

from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel

from services import session_links
from services.root_path import url_for_path
from services.session_links import PendingLinkError
from state.dependencies import get_state

router = APIRouter(tags=["session links"])

LINK_PARAMS = ("session", "sessionURL", "hub")


class StageLinkRequest(BaseModel):
    session: Optional[str] = None
    hub: Optional[str] = None
    genome: Optional[str] = None
    origin: Optional[str] = None


class OpenLinkRequest(BaseModel):
    selected: Optional[list[int]] = None


def _error(exc: PendingLinkError) -> JSONResponse:
    content = {**(getattr(exc, "body", None) or {}), "success": False, "error": str(exc), "message": str(exc)}
    return JSONResponse(status_code=exc.status, content=content)


def link_request_from_query(params) -> tuple[Optional[str], Optional[str]]:
    """(kind, raw value) of a ?session= / ?sessionURL= / ?hub= query, if any."""
    for name in LINK_PARAMS:
        value = params.get(name)
        if value:
            return ("hub" if name == "hub" else "session"), value
    return None, None


_LANDING = """<!doctype html><html><head><meta charset="utf-8"><title>FiberBrowser: open link</title>
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer">
<style>body{{font:15px/1.5 system-ui,sans-serif;max-width:40em;margin:4em auto;padding:0 1em;color:#1f2937}}
@media (prefers-color-scheme:dark){{body{{color:#e5e7eb;background:#0f172a}}a{{color:#93c5fd}}}}</style></head><body>
<h1>{heading}</h1><p>{body}</p>{action}
{script}</body></html>"""


def _landing_page(heading: str, body: str, *, target: Optional[str] = None, status: int = 200) -> HTMLResponse:
    action = ""
    script = ""
    nonce = secrets.token_urlsafe(16)
    if target:
        action = f'<p><a id="go" href="{html.escape(target)}">Review it in FiberBrowser</a></p>'
        # A navigation this page starts is same-site, so the browser sends the
        # SameSite=Strict access cookie (the link from another site did not).
        script = (f'<script nonce="{nonce}">(function(){{try{{history.replaceState(null,\'\',location.pathname);}}'
                  f"catch(e){{}}location.replace({json.dumps(target)});}})();</script>")
    page = _LANDING.format(heading=html.escape(heading), body=body, action=action, script=script)
    # Its own strict policy: only this response's script runs (public servers
    # allow no inline script without the nonce either).
    csp = (f"default-src 'none'; script-src 'nonce-{nonce}'; style-src 'unsafe-inline'; "
           "base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
    return HTMLResponse(page, status_code=status, headers={
        "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Content-Security-Policy": csp})


@router.get("/open", include_in_schema=False)
def open_landing(request: Request):
    """Landing page for a link from another site (no access token needed).

    Stores the link as a pending link (nothing is fetched or loaded) and goes on
    to ``/?open_link=<id>``, where the signed-in app asks the user to confirm.
    """
    kind, raw = link_request_from_query(request.query_params)
    if not kind:
        return _landing_page("Nothing to open", "This address opens a FiberBrowser session link: add "
                             "<code>?session=&lt;URL&gt;</code> or <code>?hub=&lt;hub.txt URL&gt;</code>.",
                             status=400)
    enabled, reason = session_links.links_enabled()
    if not enabled:
        return _landing_page("Links are turned off", html.escape(reason or ""), status=403)
    try:
        link = session_links.stage(kind, raw, genome=request.query_params.get("genome"), origin="link")
    except PendingLinkError as exc:
        return _landing_page("This link can't be opened", html.escape(str(exc)), status=exc.status)
    source = session_links.source_description(link)
    where = f" from <b>{html.escape(source['host'])}</b>" if source.get("host") else ""
    return _landing_page("Opening a link in FiberBrowser",
                         f"A page asks FiberBrowser to open data{where}. Nothing is loaded until you "
                         "confirm it in FiberBrowser.", target=f"{url_for_path('/')}?open_link={link.id}")


@router.get("/api/session-links/config")
def session_links_config():
    enabled, reason = session_links.links_enabled()
    policy = session_links.current_policy()
    return {"enabled": enabled, "reason": reason, "public": policy.public,
            "max_tracks": session_links.max_tracks(policy)}


@router.post("/api/session-links")
def stage_session_link(req: StageLinkRequest):
    """Stage a link (a session document URL or inline JSON, or a hub URL): returns its pending id."""
    enabled, reason = session_links.links_enabled()
    if not enabled:
        return _error(PendingLinkError(reason or "Opening links is turned off.", status=403))
    kind, raw = ("hub", req.hub) if req.hub else ("session", req.session)
    origin = req.origin if req.origin in ("app", "page") else "page"
    try:
        link = session_links.stage(kind, raw or "", genome=req.genome, origin=origin)
    except PendingLinkError as exc:
        return _error(exc)
    return {"success": True, "id": link.id, "expires_in": session_links.PENDING_TTL_S,
            "source": session_links.source_description(link)}


@router.get("/api/session-links/status")
async def session_links_status():
    """Pre-signed links in use: which expire soon or have expired (401/403)."""
    return await asyncio.to_thread(session_links.link_status)


@router.get("/api/session-links/{link_id}")
async def preview_session_link(link_id: str, fetch: bool = False, state=Depends(get_state)):
    """What the link would open (fetches the document, never the track files)."""
    try:
        return await asyncio.to_thread(session_links.preview, link_id, fetch_confirmed=fetch, state=state)
    except PendingLinkError as exc:
        return _error(exc)


@router.post("/api/session-links/{link_id}/open")
async def open_session_link(link_id: str, req: OpenLinkRequest, state=Depends(get_state)):
    """Open a previewed link (single use): genome, datasets and tracks into this session."""
    try:
        return await asyncio.to_thread(session_links.open_link, state, link_id, selected=req.selected)
    except PendingLinkError as exc:
        return _error(exc)


@router.delete("/api/session-links/{link_id}")
def discard_session_link(link_id: str):
    """Cancel a pending link."""
    return {"success": True, "discarded": session_links.discard(link_id)}
