"""GZip responses without compressing large bodies on the event loop.

Starlette's ``GZipMiddleware`` compresses every response body inline, on the
event loop. Read payloads are large (a 50 kb view of 1,000 reads is ~1 MB per
panel, several MB per navigation with a few panels), so compression was most
of the event loop's busy time while browsing (96% of main-thread samples in a
50-100 kb browse of two deep BAMs): every other request waited behind it.

This middleware behaves like Starlette's (same minimum size, Vary header,
already-encoded and event-stream responses passed through, streaming bodies
compressed chunk by chunk) but compresses a large body, or a large chunk of
a streaming body, in a worker thread (zlib releases the GIL while it works).
"""
from __future__ import annotations

import asyncio
import zlib
from urllib.parse import urlsplit

from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

# A read frame must arrive whole before it can paint. Deflate can retain its
# tail until the next frame (or EOF), undoing the first-frame latency bound.
EXCLUDED_CONTENT_TYPES = ("text/event-stream", "application/vnd.fiberbrowser.reads.stream.v1")
# Below this a thread hop costs more than compressing inline (~30 us per KB at level 6).
OFFLOAD_MIN_BYTES = 64 * 1024


def gzip_body(body: bytes, compresslevel: int) -> bytes:
    """A complete gzip member for ``body``."""
    compressor = zlib.compressobj(compresslevel, zlib.DEFLATED, 31)  # 31: gzip wrapper
    return compressor.compress(body) + compressor.flush()


class OffloopGZipMiddleware:
    def __init__(self, app: ASGIApp, minimum_size: int = 500, compresslevel: int = 6,
                 offload_min_bytes: int = OFFLOAD_MIN_BYTES,
                 loopback_compresslevel: int | None = None) -> None:
        self.app = app
        self.minimum_size = minimum_size
        self.compresslevel = compresslevel
        self.offload_min_bytes = offload_min_bytes
        self.loopback_compresslevel = loopback_compresslevel

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or "gzip" not in Headers(scope=scope).get("Accept-Encoding", ""):
            await self.app(scope, receive, send)
            return
        level = self.compresslevel
        if self.loopback_compresslevel is not None:
            peer = (scope.get("client") or (None,))[0]
            host = Headers(scope=scope).get("host", "")
            try:
                hostname = urlsplit("//" + host).hostname
            except ValueError:
                hostname = None
            if peer in ("127.0.0.1", "::1") and hostname in ("localhost", "127.0.0.1", "::1"):
                level = self.loopback_compresslevel
        await _Responder(self, send, level)(scope, receive)


class _Responder:
    def __init__(self, middleware: OffloopGZipMiddleware, send: Send, compresslevel: int) -> None:
        self.middleware = middleware
        self.send = send
        self.initial_message: Message = {}
        self.started = False
        self.passthrough = False
        self.compressor = None
        self.compresslevel = compresslevel

    async def __call__(self, scope: Scope, receive: Receive) -> None:
        await self.middleware.app(scope, receive, self.send_with_compression)

    async def send_with_compression(self, message: Message) -> None:
        message_type = message["type"]
        if message_type == "http.response.start":
            # Held until the first body says how the headers must change.
            self.initial_message = message
            headers = Headers(raw=message["headers"])
            self.passthrough = ("content-encoding" in headers
                                or headers.get("content-type", "").startswith(EXCLUDED_CONTENT_TYPES))
            return
        if message_type == "http.response.body":
            if not self.started:
                await self._first_body(message)
            elif self.passthrough or self.compressor is None:
                await self.send(message)
            else:
                more_body = message.get("more_body", False)
                data = await self._compress_chunk(message.get("body", b""))
                if not more_body:
                    data += self.compressor.flush()
                await self.send({"type": "http.response.body", "body": data, "more_body": more_body})
            return
        if message_type == "http.response.pathsend" and not self.started:
            # A file sent by path is not compressed.
            self.started = True
            await self.send(self.initial_message)
        await self.send(message)

    async def _compress_chunk(self, body: bytes) -> bytes:
        if len(body) >= self.middleware.offload_min_bytes:
            return await asyncio.to_thread(self.compressor.compress, body)
        return self.compressor.compress(body)

    async def _first_body(self, message: Message) -> None:
        self.started = True
        body = message.get("body", b"")
        more_body = message.get("more_body", False)
        if self.passthrough or (len(body) < self.middleware.minimum_size and not more_body):
            await self.send(self.initial_message)
            await self.send(message)
            return
        level = self.compresslevel
        headers = MutableHeaders(raw=self.initial_message["headers"])
        headers.add_vary_header("Accept-Encoding")
        headers["Content-Encoding"] = "gzip"
        if more_body:
            # Streaming: compress chunk by chunk (a large chunk in a worker thread;
            # chunks are compressed one after another, never concurrently).
            self.compressor = zlib.compressobj(level, zlib.DEFLATED, 31)
            data = await self._compress_chunk(body)
            if "content-length" in headers:
                del headers["Content-Length"]
        elif len(body) >= self.middleware.offload_min_bytes:
            data = await asyncio.to_thread(gzip_body, body, level)
            headers["Content-Length"] = str(len(data))
        else:
            data = gzip_body(body, level)
            headers["Content-Length"] = str(len(data))
        await self.send(self.initial_message)
        await self.send({"type": "http.response.body", "body": data, "more_body": more_body})
