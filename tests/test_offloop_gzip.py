"""Local transport trades a few bytes for less response latency."""
import asyncio
import gzip
import threading

import pytest

from services import offloop_gzip


@pytest.mark.parametrize("peer,host,expected", [
    ("127.0.0.1", "127.0.0.1:8886", 1),
    ("::1", "[::1]:8886", 1),
    ("127.0.0.1", "localhost:8886", 1),
    ("127.0.0.1", "shared.example.org", 6),
    ("192.0.2.5", "127.0.0.1:8886", 6),
])
@pytest.mark.parametrize("streaming", [False, True])
def test_local_compression_is_lossless_and_remote_policy_is_preserved(monkeypatch, peer, host, expected, streaming):
    original = offloop_gzip.zlib.compressobj
    levels = []
    def compressor(level, *args, **kwargs):
        levels.append(level)
        return original(level, *args, **kwargs)
    monkeypatch.setattr(offloop_gzip.zlib, "compressobj", compressor)
    body = bytes(range(256)) * 1000
    messages = []
    async def send(message): messages.append(message)
    async def app(scope, receive, send):
        await send({"type": "http.response.start", "status": 200,
                    "headers": [(b"content-type", b"application/json"), (b"vary", b"Accept")]})
        await send({"type": "http.response.body", "body": body, "more_body": streaming})
        if streaming:
            await send({"type": "http.response.body", "body": body, "more_body": False})
    middleware = offloop_gzip.OffloopGZipMiddleware(app, loopback_compresslevel=1)
    scope = {"type": "http", "client": (peer, 55555),
             "headers": [(b"accept-encoding", b"gzip"), (b"host", host.encode())]}
    asyncio.run(middleware(scope, None, send))
    assert levels == [expected]
    headers = dict(messages[0]["headers"])
    assert headers[b"content-encoding"] == b"gzip"
    assert headers[b"vary"] == b"Accept, Accept-Encoding"
    encoded = b"".join(m.get("body", b"") for m in messages[1:])
    assert gzip.decompress(encoded) == body * (2 if streaming else 1)


def test_cli_server_enables_fast_local_compression(monkeypatch):
    monkeypatch.delenv('FIBERBROWSER_EXIT_WITH_PARENT', raising=False)
    from server import app
    configured = next(m for m in app.user_middleware if m.cls is offloop_gzip.OffloopGZipMiddleware)
    assert configured.kwargs['compresslevel'] == 6
    assert configured.kwargs['loopback_compresslevel'] == 1


def test_large_complete_body_stays_off_the_event_loop(monkeypatch):
    loop_thread = threading.get_ident()
    original = offloop_gzip.gzip_body
    threads = []
    def compress(*args):
        threads.append(threading.get_ident())
        return original(*args)
    monkeypatch.setattr(offloop_gzip, "gzip_body", compress)
    async def send(message): pass
    async def app(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"x" * 100000, "more_body": False})
    asyncio.run(offloop_gzip.OffloopGZipMiddleware(app)(
        {"type": "http", "headers": [(b"accept-encoding", b"gzip")]}, None, send))
    assert threads and all(thread != loop_thread for thread in threads)
