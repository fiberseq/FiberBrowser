"""Stuck, slow and failing requests leave a line in the server's output (the app's log)."""
import asyncio
import io

from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.testclient import TestClient

from services.request_log import RequestLogMiddleware


async def fast(request):
    return JSONResponse({"ok": True})


async def slow(request):
    await asyncio.sleep(0.3)
    return JSONResponse({"ok": True})


async def broken(request):
    raise RuntimeError("boom")


async def error(request):
    return JSONResponse({"ok": False}, status_code=503)


def _client(**kw):
    out = io.StringIO()
    app = Starlette(routes=[Route("/fast", fast), Route("/slow", slow), Route("/broken", broken), Route("/error", error)])
    app.add_middleware(RequestLogMiddleware, out=out, **kw)
    return TestClient(app, raise_server_exceptions=False), out


def test_quiet_for_ordinary_requests():
    client, out = _client(slow_s=5, stuck_s=5)
    assert client.get("/fast").status_code == 200
    assert out.getvalue() == ""


def test_a_stuck_request_is_logged_while_it_runs_and_a_slow_one_when_it_answers():
    client, out = _client(slow_s=0.2, stuck_s=0.1)
    client.get("/slow?path=/Users/me/secret.bam&token=abc")
    lines = out.getvalue().splitlines()
    assert any(line.endswith("GET /slow still running after 0.1 s") for line in lines), lines
    assert any("GET /slow -> 200 in 0." in line for line in lines), lines
    assert "secret" not in out.getvalue() and "token" not in out.getvalue()  # never the query string
    assert all(line.startswith("[20") for line in lines)  # timestamped


def test_failures_are_logged():
    client, out = _client(slow_s=5, stuck_s=5)
    client.get("/error")
    client.get("/broken")
    text = out.getvalue()
    assert "GET /error -> 503" in text
    assert "GET /broken" in text and ("RuntimeError: boom" in text or "-> 500" in text)


def test_a_failure_while_streaming_is_logged():
    from starlette.responses import StreamingResponse

    async def body():
        yield b"part"
        raise RuntimeError("stream broke")

    async def stream(request):
        return StreamingResponse(body())

    out = io.StringIO()
    app = Starlette(routes=[Route("/stream", stream)])
    app.add_middleware(RequestLogMiddleware, out=out, slow_s=5, stuck_s=5)
    try:
        TestClient(app, raise_server_exceptions=False).get("/stream")
    except Exception:
        pass
    assert "GET /stream failed while sending its response" in out.getvalue()
