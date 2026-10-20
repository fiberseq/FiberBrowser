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

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

import orjson

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
