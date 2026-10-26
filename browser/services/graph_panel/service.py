"""The graph panel service the router uses: helper status, registrations, the pool, request validation.

One pool per event loop (the server has one; a test client brings its own),
closed by the server's lifespan shutdown (``shutdown``).
"""
from __future__ import annotations

import asyncio
import os
import re
import threading
from typing import Optional

from services.graph_panel import helper as helper_mod
from services.graph_panel.pool import GraphPool, JobError
from services.graph_panel.registration import Registration, RegistrationError, Registry

MAX_TARGET_BP = 50_000
MAX_PATHS = 4
MAX_CONTEXT_BP = 2_000
# Named visits walked beyond each window edge, so the joint layout can anchor an event exactly at the edge
# (graphlift GRAPH_HELPER.md `flank_bp`).
MAX_FLANK_BP = 1_000
DEFAULT_CONTEXT_BP = 100
LIMIT_KEYS = ("target_bp", "paths", "source_bp", "source_portions", "target_portions", "nodes", "edges", "visits",
              "wire_bytes", "context_bp", "candidates", "walk_steps")
_REQUEST_ID = re.compile(r"^[A-Za-z0-9._:-]{1,96}$")

_lock = threading.Lock()
_registry: Optional[Registry] = None
_status: Optional[helper_mod.HelperStatus] = None
_pools: dict[int, GraphPool] = {}


def registry() -> Registry:
    global _registry
    with _lock:
        if _registry is None:
            _registry = Registry()
        return _registry


def helper_status(refresh: bool = False) -> helper_mod.HelperStatus:
    global _status
    with _lock:
        current = _status
    if current is None or refresh or not current.available:
        current = helper_mod.resolve(refresh=refresh)
        with _lock:
            _status = current
    return current


def _helper_path() -> Optional[str]:
    with _lock:
        status = _status
    return status.path if status is not None and status.available else None


def pool_options() -> dict:
    """Test hooks: lowered limits through the environment (never raised above the design's)."""
    def num(name, default, cast=float):
        raw = os.environ.get(name)
        try:
            return cast(raw) if raw else default
        except ValueError:
            return default
    return {
        "queue_expiry_s": num("FIBERBROWSER_GRAPH_QUEUE_EXPIRY_S", 1.0),
        "deadline_s": min(1.0, num("FIBERBROWSER_GRAPH_DEADLINE_S", 1.0)),
        "job_rss": num("FIBERBROWSER_GRAPH_JOB_RSS", int(1.5 * (1 << 30)), int),
    }


def pool() -> GraphPool:
    loop = asyncio.get_running_loop()
    with _lock:
        existing = _pools.get(id(loop))
        if existing is not None and existing.loop is loop:
            return existing
    created = GraphPool(_helper_path, check_registration=registry().check_unchanged, **pool_options())
    with _lock:
        _pools[id(loop)] = created
    return created


async def ensure_ready() -> helper_mod.HelperStatus:
    status = await asyncio.to_thread(helper_status)
    if status.available:
        await asyncio.to_thread(registry().ensure_loaded, status.path)
    return status


async def status_payload() -> dict:
    status = await ensure_ready()
    loop = asyncio.get_running_loop()
    with _lock:
        current = _pools.get(id(loop))
    return {
        "helper": status.public(),
        "registrations": registry().list(),
        "registration_errors": registry().errors(),
        "pool": current.stats() if current is not None else None,
        "limits": {"target_bp": MAX_TARGET_BP, "paths": MAX_PATHS, "context_bp": MAX_CONTEXT_BP},
    }


def _bad(message: str, code: str = "invalid_request", status: int = 422, **extra) -> JobError:
    return JobError(code, message, retryable=False, status=status, detail=extra)


def validate_query(reg: Registration, body: dict) -> dict:
    """Check a subgraph request against the registration before it reaches a worker; return the helper request."""
    for name in ("revisions", "interval", "limits"):
        if body.get(name) is not None and not isinstance(body.get(name), dict):
            raise _bad(f"{name} must be an object")
    revisions = body.get("revisions") or {}
    stale = [k for k in ("package", "graph", "db", "maps") if revisions.get(k) != reg.revisions[k]]
    if stale:
        raise _bad(f"the request names other {', '.join(stale)} revisions than the registered package",
                   "stale_revision", 409, current=reg.revisions)
    target = body.get("target")
    if not isinstance(target, str) or reg.binding(target) is None:
        raise _bad(f"unknown target binding {target!r}")
    interval = body.get("interval") or {}
    start, end = interval.get("start"), interval.get("end")
    if not all(isinstance(v, int) and not isinstance(v, bool) for v in (start, end)) or start < 0 or end <= start:
        raise _bad("interval must be zero-based half-open integers with end > start")
    if end - start > MAX_TARGET_BP:
        raise _bad(f"the target interval is {end - start:,} bp; the graph view shows at most {MAX_TARGET_BP:,} bp",
                   "selection_limit", 413, max_target_bp=MAX_TARGET_BP)
    selected = body.get("selected")
    if not isinstance(selected, list) or not selected or not all(isinstance(s, str) for s in selected):
        raise _bad("selected must list binding keys")
    if len(set(selected)) != len(selected):
        raise _bad("selected lists a binding twice")
    if len(selected) > MAX_PATHS:
        raise _bad(f"{len(selected)} paths selected; at most {MAX_PATHS} including the target", "selection_limit", 413,
                   max_paths=MAX_PATHS)
    if target not in selected:
        raise _bad("the selected paths must include the target")
    unknown = [s for s in selected if reg.binding(s) is None]
    if unknown:
        raise _bad(f"unknown binding(s) {', '.join(unknown)}")
    context = body.get("context_bp", DEFAULT_CONTEXT_BP)
    if not isinstance(context, int) or isinstance(context, bool) or not 0 <= context <= MAX_CONTEXT_BP:
        raise _bad(f"context_bp must be 0–{MAX_CONTEXT_BP}")
    snarls = body.get("snarls", "none")
    if snarls not in ("none", "contained"):
        raise _bad("snarls must be none or contained")
    request = {"target": target, "interval": {"start": start, "end": end}, "selected": selected,
               "context_bp": context, "snarls": snarls}
    flank = body.get("flank_bp", 0)
    if not isinstance(flank, int) or isinstance(flank, bool) or not 0 <= flank <= MAX_FLANK_BP:
        raise _bad(f"flank_bp must be 0–{MAX_FLANK_BP}")
    if flank:
        request["flank_bp"] = flank
    limits = body.get("limits")
    if limits:
        if not isinstance(limits, dict) or any(k not in LIMIT_KEYS or not isinstance(v, int) or isinstance(v, bool) or v <= 0
                                               for k, v in limits.items()):
            raise _bad("limits may only lower the helper's named limits (positive integers)")
        if "wire_bytes" in limits and limits["wire_bytes"] < 1024:
            raise _bad("wire_bytes is at least 1024")
        request["limits"] = dict(sorted(limits.items()))
    return request


def check_request_id(value) -> str:
    if not isinstance(value, str) or not _REQUEST_ID.match(value):
        raise _bad("request_id must be 1–96 letters, digits or ._:-")
    return value


async def subgraph(body: dict) -> dict:
    status = await ensure_ready()
    if not status.available:
        raise JobError("helper_unavailable", "Graph helper unavailable", retryable=False, status=503,
                       detail={"hint": status.hint, "error": status.error})
    try:
        reg = registry().get(str(body.get("registration_id") or ""))
    except RegistrationError as exc:
        raise _bad(exc.message, exc.code, exc.status) from None
    request = validate_query(reg, body)
    # Only a helper that lists the feature gets flank_bp (an older helper refuses the unknown field); the layout
    # then simply has no flank anchors at the window edges.
    if "flank_bp" in request and "flank_bp" not in ((status.handshake or {}).get("features") or []):
        del request["flank_bp"]
    rid = check_request_id(body.get("request_id"))
    panel_id = str(body.get("panel_id") or rid)[:128]
    generation = body.get("generation", 0)
    if not isinstance(generation, int) or isinstance(generation, bool) or generation < 0:
        raise _bad("generation must be a non-negative integer")
    response = await pool().submit(reg, "query", {"request": request}, request_id=rid, panel_id=panel_id,
                                   generation=generation)
    response["registration_id"] = reg.id
    response["revisions"] = reg.revisions
    return response


async def catalog(reg_id: str, offset: int, limit: int, filter_text: Optional[str]) -> dict:
    status = await ensure_ready()
    if not status.available:
        raise JobError("helper_unavailable", "Graph helper unavailable", retryable=False, status=503,
                       detail={"hint": status.hint})
    try:
        reg = registry().get(reg_id)
    except RegistrationError as exc:
        raise _bad(exc.message, exc.code, exc.status) from None
    fields = {"offset": max(0, int(offset)), "limit": max(1, min(128, int(limit))),
              "filter": (filter_text or None) and filter_text[:256]}
    import uuid
    rid = f"catalog-{uuid.uuid4().hex[:12]}"
    response = await pool().submit(reg, "catalog", fields, request_id=rid, panel_id=rid, generation=0)
    body = response["result"]
    return {"registration_id": reg.id, "bindings": reg.bindings, "paths": body.get("paths", []),
            "next_offset": body.get("next_offset"), "total": body.get("total")}


async def register_package(package_dir: str) -> dict:
    status = await ensure_ready()
    if not status.available:
        raise JobError("helper_unavailable", "Graph helper unavailable", retryable=False, status=503,
                       detail={"hint": status.hint})
    try:
        reg = await asyncio.to_thread(registry().register, status.path, package_dir)
    except RegistrationError as exc:
        raise _bad(exc.message, exc.code, exc.status) from None
    return reg.public()


async def unregister_package(registration_id: str) -> dict:
    """Forget a registered package (it is no longer offered; a package named in FIBERBROWSER_GRAPH_PACKAGES comes
    back at the next start)."""
    await ensure_ready()
    reg = registry().get(str(registration_id or ""))   # 404 unknown_registration
    registry().unregister(reg.id)
    return {"registration_id": reg.id, "removed": True}


def cancel(request_id: str) -> bool:
    loop = asyncio.get_running_loop()
    with _lock:
        current = _pools.get(id(loop))
    return bool(current and current.cancel(request_id))


async def shutdown() -> None:
    """Close this loop's pool: every helper this server started is shut down or killed, and reaped."""
    loop = asyncio.get_running_loop()
    with _lock:
        current = _pools.pop(id(loop), None)
    if current is not None:
        await current.close()


def reset_for_tests() -> None:
    global _registry, _status
    with _lock:
        _registry = None
        _status = None
        _pools.clear()
    helper_mod.clear_cache()
