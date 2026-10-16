"""Figure rendering from a full browser state (/api/render/figure).

The headless worker loads the real app, restores the state the same way a
session import does, and runs the Export button's own figure export. The
result matches what a user sees and exports in the browser: clusters, rules,
colors, layers, motif and signal tracks, panel layout and row heights.
"""
from __future__ import annotations

from utils.responses import content_disposition
import base64
import json
import os
import re
import time
import uuid
from typing import Any, Optional

from fastapi.responses import Response

DEFAULT_LAYOUT = {"width": 1400, "height": 900}
MEDIA_TYPES = {"png": "image/png", "svg": "image/svg+xml", "pdf": "application/pdf"}
_REGION_RE = re.compile(r"^\s*([^:\s]+):([\d,]+)-([\d,]+)\s*$")


class FigureError(Exception):
    def __init__(self, message: str, status: int = 400, **extra):
        super().__init__(message)
        self.status = status
        self.extra = extra


def store_live_state(state, payload) -> dict:
    state.live_figure_state = {
        "viewport": dict(payload.viewport or {}),
        "frontend_state": dict(payload.frontend_state or {}),
        "layout": dict(payload.layout) if payload.layout else None,
        "updated_at": time.time(),
    }
    # Client-held reads can redraw without a read request. Keep Python's
    # current-region view in sync through the existing live-view report.
    viewport = payload.viewport or {}
    chrom, start, end = (viewport.get(key) for key in ("chrom", "start", "end"))
    if isinstance(chrom, str) and isinstance(start, int) and isinstance(end, int) and end > start:
        state._current_chrom, state._current_start, state._current_end = chrom, start, end
    return {"success": True}


def live_state_summary(state, full: bool = False) -> dict:
    live = getattr(state, "live_figure_state", None)
    if not live:
        return {"available": False}
    summary = {
        "available": True,
        "viewport": live["viewport"],
        "layout": live["layout"],
        "updated_at": live["updated_at"],
        "age_s": round(time.time() - live["updated_at"], 1),
    }
    if full:
        summary["frontend_state"] = live["frontend_state"]
    return summary


def parse_region(region: str) -> tuple[str, int, int]:
    match = _REGION_RE.match(region or "")
    if not match:
        raise FigureError(f"Region must look like chr1:1,000-2,000, got {region!r}")
    chrom, start, end = match.group(1), int(match.group(2).replace(",", "")), int(match.group(3).replace(",", ""))
    if end <= start:
        raise FigureError(f"Region end must be after start: {region!r}")
    return chrom, start, end


def _same_sources(saved, loaded) -> bool:
    """Whether a session's dataset files are the ones loaded (sessions without paths match)."""
    if not saved:
        return True

    def norm(paths):
        out = set()
        for p in paths if isinstance(paths, (list, tuple)) else [paths]:
            if not p:
                continue
            p = str(p)
            out.add(p if "://" in p else os.path.realpath(os.path.expanduser(p)))
        return out

    return norm(saved) == norm(loaded or [])


def read_session_path(session_path: str) -> dict:
    """A session JSON named by ``session_path`` (on a lab server only inside its data
    roots, opened by the checked descriptor walk: a URL-looking name is a local path here)."""
    from services.lab.paths import confine, open_read
    confine(session_path)  # a lab server's data roots
    path = os.path.expanduser(session_path)
    if not path.lower().endswith(".json"):
        raise FigureError("session_path must be a .json session file")
    if not os.path.isfile(path):
        raise FigureError(f"Session file not found: {session_path}", status=404)
    with open_read(path) as handle:
        return json.loads(handle.read().decode("utf-8"))


def _session_source(req, state, dafc_state) -> tuple[dict, dict, Optional[dict]]:
    """(viewport, frontend_state, layout) from a session file or JSON."""
    session = req.session
    if session is None and req.session_path:
        session = read_session_path(req.session_path)
    if not isinstance(session, dict):
        raise FigureError("source='session' needs session (JSON) or session_path")

    wanted = [ds.get("id") for ds in session.get("datasets", []) if isinstance(ds, dict) and ds.get("id")]
    missing = [ds_id for ds_id in wanted if ds_id not in state.datasets]
    # The same id may name different files here: that's a different dataset.
    different = [ds.get("id") for ds in session.get("datasets", [])
                 if isinstance(ds, dict) and ds.get("id") in state.datasets
                 and not _same_sources(ds.get("paths"), getattr(state.datasets[ds["id"]], "paths", None))]
    # load_session always loads (same IDs may point at different files).
    if missing or different or req.load_session:
        if not req.load_session:
            problems = []
            if missing:
                problems.append("not loaded on this server: " + ", ".join(missing))
            if different:
                problems.append("loaded here from different files: " + ", ".join(different))
            raise FigureError(
                "These session datasets are " + "; ".join(problems)
                + ". Pass load_session=true to load the session first (this replaces the open view).",
                status=409,
                missing_datasets=missing + different,
            )
        from models.requests import SessionImportRequest
        from services.sessions_endpoint import import_session_for_request

        result = import_session_for_request(state, SessionImportRequest(session=session), dafc_state=dafc_state)
        if not result.get("success"):
            raise FigureError(f"Session import failed: {result.get('error')}", status=500)
        still_missing = [ds_id for ds_id in wanted if ds_id not in state.datasets]
        if still_missing:
            raise FigureError(
                "These session datasets could not be loaded: " + ", ".join(still_missing),
                status=409,
                missing_datasets=still_missing,
                failures=(result.get("results") or {}).get("datasets_failed", []),
            )
    return session.get("viewport") or {}, session.get("frontend") or {}, None


def build_figure_envelope(req, state, dafc_state=None) -> dict:
    """Everything the worker needs: the state to restore and the export options."""
    from services.playwright_render import _chroms_for_render, _orthogonal_tracks_for_render
    from services.sessions_endpoint import state_import_payload

    if req.source == "session" or req.session is not None or req.session_path:
        viewport, frontend, layout = _session_source(req, state, dafc_state)
    else:
        if not state.datasets:
            raise FigureError("No datasets are loaded", status=409)
        live = getattr(state, "live_figure_state", None)
        if not live:
            raise FigureError(
                "No browser view to render yet: open the browser (so it can report its view) "
                "or pass a session.",
                status=409,
            )
        viewport, frontend, layout = live["viewport"], live["frontend_state"], live["layout"]

    viewport = dict(viewport)
    if req.region:
        viewport["chrom"], viewport["start"], viewport["end"] = parse_region(req.region)
    for key in ("chrom", "start", "end"):
        value = getattr(req, key)
        if value is not None:
            viewport[key] = value
    if not all(viewport.get(key) is not None for key in ("chrom", "start", "end")):
        raise FigureError("No region: pass region or chrom/start/end")
    if int(viewport["end"]) <= int(viewport["start"]):
        raise FigureError("Region end must be after start")

    size = {**DEFAULT_LAYOUT, **(layout or {})}
    width = int(req.width or size["width"])
    height = int(req.height or size["height"])
    if not (200 <= width <= 8000 and 150 <= height <= 20000):
        raise FigureError("width must be 200-8000 and height 150-20000 CSS pixels")
    if not (0.5 <= req.scale <= 8):
        raise FigureError("scale must be between 0.5 and 8")

    import_result = state_import_payload(state, viewport=viewport, frontend=frontend)
    # Data the page normally fetches at startup, which render mode skips.
    base_state: dict[str, Any] = {}
    chroms = _chroms_for_render(state)
    if chroms:
        base_state["chroms"] = chroms
    tracks = _orthogonal_tracks_for_render(state)
    if tracks:
        base_state["orthogonalTracks"] = tracks

    return {
        "viewport": {"width": width, "height": height},
        "figure": {
            "baseState": base_state,
            "importResult": import_result,
            "export": {
                "format": req.format,
                "scale": float(req.scale),
                "includeTitle": bool(req.include_title),
                "title": req.title or "",
                "includeCoords": bool(req.include_coords),
                "expandReadTracks": bool(req.expand_read_tracks),
                "matchReadCounts": bool(req.match_read_counts),
                "matchUiSize": bool(getattr(req, "match_ui_size", True)),
            },
        },
    }


def figure_wait_seconds(timeout_ms: int) -> float:
    """The worker may spend timeout_ms settling, then max(30 s, timeout_ms)
    exporting (render-headless.mjs); allow both plus page start-up."""
    return (timeout_ms + max(30_000, timeout_ms) + 30_000) / 1000.0


def render_figure(req, state, dafc_state=None) -> Response:
    from services.playwright_render import (
        DEFAULT_SELF_URL,
        DEFAULT_TIMEOUT_MS,
        MAX_TIMEOUT_MS,
        MIN_TIMEOUT_MS,
        _ConcurrencyExceeded,
        _WORKER,
        _WorkerError,
    )

    def error(status: int, message: str, **extra) -> Response:
        return Response(
            content=json.dumps({"error": message, **extra}).encode("utf-8"),
            media_type="application/json",
            status_code=status,
            headers={"X-Render-Engine": "playwright"},
        )

    try:
        parts = build_figure_envelope(req, state, dafc_state)
    except FigureError as exc:
        return error(exc.status, str(exc), **exc.extra)

    timeout_ms = DEFAULT_TIMEOUT_MS
    if req.timeout_ms is not None:
        timeout_ms = max(MIN_TIMEOUT_MS, min(MAX_TIMEOUT_MS, int(req.timeout_ms)))
    # The worker's page is a browser client like any other: it needs the access
    # token (as playwright_render's own screenshots pass it), else the page never
    # loads its state and the figure times out (502).
    from services.local_auth import tokened_url
    url = tokened_url(DEFAULT_SELF_URL)
    from services.lab.auth import with_render_identity
    url = with_render_identity(url)  # a lab server: act as the member who asked
    if req.show_nudges:
        url = f"{url}{'&' if '?' in url else '?'}nudges=1"
    envelope = {
        "id": str(uuid.uuid4()),
        "url": url,
        "viewport": parts["viewport"],
        "deviceScaleFactor": 1,
        "timeoutMs": timeout_ms,
        "figure": parts["figure"],
    }
    try:
        result = _WORKER.submit(envelope, timeout_s=figure_wait_seconds(timeout_ms))
    except _ConcurrencyExceeded:
        response = error(503, "render concurrency exceeded; retry shortly")
        response.headers["Retry-After"] = "1"
        return response
    except _WorkerError as exc:
        return error(503, str(exc))
    if not result.get("ok"):
        return error(502, result.get("error", "unknown render error"), diagnostics=result.get("diagnostics", {}))

    data = base64.b64decode(result.get("figure_b64") or "")
    if not data:
        return error(502, "worker returned an empty figure")
    fmt = req.format
    viewport = parts["figure"]["importResult"]["viewport"]
    filename = f"fiberbrowser_{viewport['chrom']}_{viewport['start']}-{viewport['end']}.{fmt}"
    headers = {
        "X-Render-Engine": "playwright",
        "X-Figure-Width": str(result.get("width", "")),
        "X-Figure-Height": str(result.get("height", "")),
        "X-Render-Diagnostics": json.dumps(result.get("diagnostics") or {}, separators=(",", ":")),
        "Content-Disposition": content_disposition(filename),
    }
    if result.get("partial"):
        headers["X-Render-Partial"] = "true"
        headers["X-Render-Reason"] = str(result.get("reason") or "")[:200]
    return Response(content=data, media_type=MEDIA_TYPES[fmt], headers=headers)
