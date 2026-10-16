"""Slow, failing and stuck requests in the server's output.

The server logs almost nothing once it is up (uvicorn runs at log level
"warning", without an access log), so a request that hangs or runs for
minutes left no trace: the Mac app's ``fiberbrowser-app-server.log`` ended at
startup while "find reads" searched for an hour. This middleware writes one
timestamped line for

- a request still without a response after ``STUCK_S`` seconds,
- a response that took ``SLOW_S`` seconds or more, or a 5xx response,
- a request whose handler raised (the traceback follows from uvicorn).

Only the method and path are written: never the query string, which can
carry the access token, file paths or signed URLs.
"""
from __future__ import annotations

import asyncio
import os
import sys
import time
from typing import Callable, Optional, TextIO


def _seconds(name: str, default: float) -> float:
    try:
        return max(0.0, float(os.environ.get(name, default)))
    except ValueError:
        return default


SLOW_S = _seconds("FIBERBROWSER_SLOW_REQUEST_S", 10.0)
STUCK_S = _seconds("FIBERBROWSER_STUCK_REQUEST_S", 60.0)


def log_line(message: str, out: Optional[TextIO] = None) -> None:
    stream = out or sys.stderr
    try:
        stream.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}\n")
        stream.flush()
    except Exception:
        pass


class RequestLogMiddleware:
    def __init__(self, app, slow_s: float = SLOW_S, stuck_s: float = STUCK_S,
                 out: Optional[TextIO] = None, clock: Callable[[], float] = time.monotonic) -> None:
        self.app = app
        self.slow_s = slow_s
        self.stuck_s = stuck_s
        self.out = out
        self.clock = clock

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        what = f"{scope.get('method', '?')} {scope.get('path', '?')}"
        t0 = self.clock()
        status: list = []
        stuck = None
        if self.stuck_s > 0:
            loop = asyncio.get_running_loop()
            stuck = loop.call_later(self.stuck_s, lambda: log_line(
                f"{what} still running after {self.stuck_s:g} s", self.out))

        async def send_logged(message):
            if message.get("type") == "http.response.start":
                if stuck is not None:
                    stuck.cancel()  # answering (streams may go on for long)
                status.append(int(message.get("status", 0)))
                elapsed = self.clock() - t0
                if status[0] >= 500 or elapsed >= self.slow_s:
                    log_line(f"{what} -> {status[0]} in {elapsed:.1f} s", self.out)
            await send(message)

        try:
            await self.app(scope, receive, send_logged)
        except BaseException as exc:
            if not isinstance(exc, asyncio.CancelledError):
                when = "while sending its response" if status else "before answering"
                log_line(f"{what} failed {when} after {self.clock() - t0:.1f} s: "
                         f"{type(exc).__name__}: {exc}", self.out)
            raise
        finally:
            if stuck is not None:
                stuck.cancel()


def install_request_log(app) -> None:
    app.add_middleware(RequestLogMiddleware)
