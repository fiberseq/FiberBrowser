"""Graph panel endpoints (DESIGN_GRAPH_PANEL.md §3): helper status, registered
graph packages, bounded topology queries and their cancellation.

Queries name a registration ID and its revisions, never a file path; the only
route that takes a path registers a package on the host (denied on public
servers). A subgraph request whose client disconnects, or that is cancelled
with ``DELETE /api/graph/requests/{id}``, leaves its job; the last subscriber
leaving kills the running helper (services/graph_panel/pool.py).
"""
from __future__ import annotations

import asyncio
from typing import Optional

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

import orjson

from state.dependencies import get_state

router = APIRouter(tags=["graph panel"])


class RegisterRequest(BaseModel):
    package: str = Field(..., description="A prepared graph package directory (fiberbrowser-graph prepare)")


def _error(exc) -> JSONResponse:
    return JSONResponse({"status": "error", "error": exc.payload()}, status_code=exc.status)


@router.get("/api/graph/status")
async def graph_status():
    from services.graph_panel import service
    return await service.status_payload()


@router.get("/api/graph/registrations")
async def graph_registrations():
    from services.graph_panel import service
    await service.ensure_ready()
    return {"registrations": service.registry().list(), "errors": service.registry().errors()}


@router.post("/api/graph/registrations")
async def graph_register(req: RegisterRequest):
    from services.graph_panel import service
    from services.graph_panel.pool import JobError
    try:
        return {"registration": await service.register_package(req.package)}
    except JobError as exc:
        return _error(exc)


@router.get("/api/graph/registrations/{registration_id}/paths")
async def graph_paths(registration_id: str, offset: int = Query(0, ge=0), limit: int = Query(64, ge=1, le=128),
                      filter: Optional[str] = Query(None, max_length=256)):
    from services.graph_panel import service
    from services.graph_panel.pool import JobError
    try:
        return await service.catalog(registration_id, offset, limit, filter)
    except JobError as exc:
        return _error(exc)


@router.post("/api/graph/subgraph")
async def graph_subgraph(request: Request):
    from services.client_disconnect import wait_for_disconnect
    from services.graph_panel import service
    from services.graph_panel.pool import JobError
    try:
        body = orjson.loads(await request.body())
    except orjson.JSONDecodeError:
        return JSONResponse({"status": "error", "error": {"code": "invalid_request", "message": "body is not JSON",
                                                          "retryable": False}}, status_code=422)
    if not isinstance(body, dict):
        return JSONResponse({"status": "error", "error": {"code": "invalid_request", "message": "body must be an object",
                                                          "retryable": False}}, status_code=422)
    work = asyncio.ensure_future(service.subgraph(body))
    gone = asyncio.ensure_future(wait_for_disconnect(request))
    try:
        done, _ = await asyncio.wait({work, gone}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        gone.cancel()
    if work not in done:
        # The browser aborted: this subscriber leaves (pool.submit cancels itself on CancelledError).
        work.cancel()
        try:
            await work
        except (asyncio.CancelledError, Exception):
            pass
        return Response(status_code=499)
    try:
        payload = work.result()
    except JobError as exc:
        return _error(exc)
    return Response(orjson.dumps(payload), media_type="application/json")


@router.delete("/api/graph/requests/{request_id}")
async def graph_cancel(request_id: str):
    from services.graph_panel import service
    return {"request_id": request_id, "cancelled": service.cancel(request_id)}


def _reads_error(exc) -> JSONResponse:
    return JSONResponse({"status": "error", "error": exc.payload()}, status_code=exc.status)


def _registration(reg_id):
    """The registration, refused (409 package_changed, and no longer offered) when its package's files changed or
    disappeared since verification: reads, differences and sequence never answer for a package that is gone."""
    from services.graph_panel import service
    from services.graph_panel.reads import ReadsError
    from services.graph_panel.registration import RegistrationError
    try:
        reg = service.registry().get(str(reg_id or ""))
        service.registry().check_unchanged(reg)
        return reg
    except RegistrationError as exc:
        raise ReadsError(exc.code, exc.message, exc.status) from None


@router.get("/api/graph/read_bindings")
async def graph_read_bindings(registration_id: str, state=Depends(get_state)):
    """Loaded datasets and the package paths each binds to (explicit identities, DESIGN §5)."""
    from services.graph_panel import service
    from services.graph_panel import reads as graph_reads
    await service.ensure_ready()
    try:
        reg = _registration(registration_id)
        bindings = await asyncio.to_thread(graph_reads.read_bindings, state, reg)
    except graph_reads.ReadsError as exc:
        return _reads_error(exc)
    return {"registration_id": reg.id, "bindings": bindings}


@router.post("/api/graph/reads")
async def graph_reads_route(request: Request, state=Depends(get_state)):
    """Molecules of bound datasets on the selected paths' source windows (Gate E): composed calls in source
    coordinates, sampled and budgeted, every omission reported. A client that leaves cancels the load."""
    import threading

    from services.background_work import Cancelled, cancel_scope, interactive_read
    from services.client_disconnect import wait_for_disconnect
    from services.graph_panel import service
    from services.graph_panel import reads as graph_reads
    try:
        body = orjson.loads(await request.body())
    except orjson.JSONDecodeError:
        body = None
    if not isinstance(body, dict):
        return JSONResponse({"status": "error", "error": {"code": "invalid_request", "message": "body must be a JSON object",
                                                          "retryable": False}}, status_code=422)
    await service.ensure_ready()
    try:
        reg = _registration(body.get("registration_id"))
        revisions = body.get("revisions") or {}
        stale = [k for k in ("package", "graph", "db", "maps") if revisions.get(k) != reg.revisions[k]]
        if stale:
            raise graph_reads.ReadsError("stale_revision", f"the request names other {', '.join(stale)} revisions",
                                         409, current=reg.revisions)
    except graph_reads.ReadsError as exc:
        return _reads_error(exc)
    cancel = threading.Event()

    def run():
        with cancel_scope(cancel), interactive_read():
            return graph_reads.load(state, reg, body)

    work = asyncio.ensure_future(asyncio.to_thread(run))
    gone = asyncio.ensure_future(wait_for_disconnect(request))
    try:
        done, _ = await asyncio.wait({work, gone}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        gone.cancel()
    if work not in done:
        cancel.set()
        try:
            await work
        except (Cancelled, Exception):
            pass
        return Response(status_code=499)
    try:
        payload = work.result()
    except graph_reads.ReadsError as exc:
        return _reads_error(exc)
    except Cancelled:
        return Response(status_code=499)
    payload.update(request_id=body.get("request_id"), panel_id=body.get("panel_id"), generation=body.get("generation"),
                   registration_id=reg.id, revisions=reg.revisions)
    return Response(orjson.dumps(payload), media_type="application/json")


def _checked(body, reg):
    from services.graph_panel import reads as graph_reads
    revisions = body.get("revisions") or {}
    stale = [k for k in ("package", "graph", "db", "maps") if revisions.get(k) != reg.revisions[k]]
    if stale:
        raise graph_reads.ReadsError("stale_revision", f"the request names other {', '.join(stale)} revisions",
                                     409, current=reg.revisions)


async def _json_body(request: Request):
    try:
        body = orjson.loads(await request.body())
    except orjson.JSONDecodeError:
        body = None
    return body if isinstance(body, dict) else None


@router.post("/api/graph/differences")
async def graph_differences_route(request: Request, state=Depends(get_state)):
    """A graph allele's canonical live-lift difference: only from a dataset whose map is the package's map for the
    pair, at the same boundary and source placement; everything else is listed as rejected, with its reason."""
    from services.graph_panel import service
    from services.graph_panel import reads as graph_reads
    from services.graph_panel.differences import canonical_differences
    body = await _json_body(request)
    if body is None:
        return JSONResponse({"status": "error", "error": {"code": "invalid_request", "message": "body must be a JSON object",
                                                          "retryable": False}}, status_code=422)
    await service.ensure_ready()
    try:
        reg = _registration(body.get("registration_id"))
        _checked(body, reg)
        out = await asyncio.to_thread(canonical_differences, state, reg, body)
    except graph_reads.ReadsError as exc:
        return _reads_error(exc)
    return {"registration_id": reg.id, "revisions": reg.revisions, **out}


@router.post("/api/graph/sequence")
async def graph_sequence_route(request: Request):
    """A path's sequence over an interval (at most 60,000 bp), from the package (the helper's sequence command)."""
    from services.graph_panel import service
    from services.graph_panel import reads as graph_reads
    from services.graph_panel.differences import MAX_SEQUENCE_BP, _span
    from services.graph_panel.pool import JobError
    body = await _json_body(request)
    if body is None:
        return JSONResponse({"status": "error", "error": {"code": "invalid_request", "message": "body must be a JSON object",
                                                          "retryable": False}}, status_code=422)
    status = await service.ensure_ready()
    try:
        reg = _registration(body.get("registration_id"))
        _checked(body, reg)
        binding = reg.binding(str(body.get("binding") or ""))
        if binding is None:
            raise graph_reads.ReadsError("invalid_request", "binding must be a binding of this package")
        a, b = _span(body.get("interval"), "interval")
        if not 0 < b - a <= MAX_SEQUENCE_BP:
            raise graph_reads.ReadsError("selection_limit", f"1 to {MAX_SEQUENCE_BP:,} bp at a time", 413)
    except graph_reads.ReadsError as exc:
        return _reads_error(exc)
    if not status.available:
        return JSONResponse({"status": "error", "error": {"code": "helper_unavailable", "message": "Graph helper unavailable",
                                                          "retryable": False}}, status_code=503)
    import uuid
    rid = f"seq-{uuid.uuid4().hex[:12]}"
    try:
        frame = await service.pool().submit(reg, "sequence", {"binding": binding["key"], "interval": {"start": a, "end": b}},
                                            request_id=rid, panel_id=rid, generation=0)
    except JobError as exc:
        return _error(exc)
    body_out = frame.get("result") if isinstance(frame, dict) else None   # the helper's whole sequence frame
    result = body_out.get("result") if isinstance(body_out, dict) else None
    return {"registration_id": reg.id, "revisions": reg.revisions, "binding": binding["key"],
            "interval": {"start": a, "end": b}, "result": result}
