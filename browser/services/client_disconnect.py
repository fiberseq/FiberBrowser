"""Notice a client that went away (Cancel, a new query, a closed tab).

``Request.is_disconnected()`` polls ``receive`` without waiting. Behind the
server's ``@app.middleware("http")`` layers (Starlette's BaseHTTPMiddleware)
that poll never returns the disconnect, so a long route never learned that
its client had gone: a cancelled read-name lookup scanned on for its whole
20 s budget. ``RawReceiveMiddleware`` (pure ASGI, outside those layers) keeps
the server's own ``receive`` in the scope, and ``wait_for_disconnect`` waits
on it.
"""
from __future__ import annotations

import asyncio

RAW_RECEIVE_KEY = "fiberbrowser.raw_receive"


class RawReceiveMiddleware:
    """Pure ASGI: remember the server's ``receive`` (and its event loop) for this request."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") == "http":
            scope[RAW_RECEIVE_KEY] = (receive, asyncio.get_running_loop())
        await self.app(scope, receive, send)


async def _raw_message(raw_receive, owner_loop) -> dict:
    """The server's next message. A ``--public`` server runs handlers on worker
    event loops (services/public_protection.py): the server's receive awaits
    an event of its own loop, so the call hops there."""
    if owner_loop is None or owner_loop is asyncio.get_running_loop():
        return await raw_receive()
    return await asyncio.wrap_future(asyncio.run_coroutine_threadsafe(raw_receive(), owner_loop))


async def wait_for_disconnect(request, poll_s: float = 0.25) -> None:
    """Return once the client has disconnected.

    Only for a route that has already read its request body (FastAPI reads
    it before the handler runs): after the body, the next message the
    server sends is the disconnect.
    """
    raw = request.scope.get(RAW_RECEIVE_KEY)
    if raw is None:  # not installed (a bare test app): poll as before
        while not await request.is_disconnected():
            await asyncio.sleep(poll_s)
        return
    raw_receive, owner_loop = raw
    while True:
        message = await _raw_message(raw_receive, owner_loop)
        if message.get("type") == "http.disconnect":
            return
