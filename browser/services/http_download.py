"""Downloads with finite deadlines and complete bodies (genome FASTA, its index, annotations).

``urllib.request.urlretrieve`` opened with no timeout (the socket default is none), so a stalled server held a
download, and the reference lock around it, forever. ``fetch``:

- bounds each blocking socket operation (connect, every read) by ``min(read timeout, remaining deadline)``;
- enforces the overall deadline with a watchdog: every socket the download opens (redirects included) is
  watched from its creation, before any proxy CONNECT tunnel (and its TLS socket before the handshake), and
  each connect and handshake gets at most the time left; when the deadline passes, the watchdog shuts the sockets down, which ends whatever the
  download is blocked in (proxy tunnel, TLS, response headers, chunk-size framing, trailers or the body) at
  once, and the download fails with ``DownloadTimeout`` (a DNS lookup is the one step it cannot interrupt);
- counts the bytes against ``Content-Length`` and raises ``ContentTooShortError`` on a premature end, as
  urlretrieve did, before the caller publishes anything;
- removes the partial file on any failure, so the caller can retry or fall back;
- has no size cap, but warns above a size threshold (``warn_bytes``: the ``downloads.warn_bytes`` app setting,
  ``FIBERBROWSER_DOWNLOAD_WARN_BYTES``, default 4 GB). A caller that can ask the user (the run wizard,
  /api/load_genome, a panel genome's attachment) sets ``download_policy``: a download whose ``Content-Length`` is
  over it is then refused with ``LargeDownload`` before any of the body is read unless it was confirmed. Every
  other caller (a FASTA URL opened at start-up, from a session or a link) cannot ask: its large download goes
  ahead with a warning line. One of unknown size that streams past it is reported once (``events``) and goes on.

It keeps urlretrieve's progress-hook signature.
"""
from __future__ import annotations

import http.client
import os
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from contextlib import contextmanager
from contextvars import ContextVar

READ_TIMEOUT = float(os.environ.get("FIBERBROWSER_DOWNLOAD_TIMEOUT", 60))          # connect, and each read (s)
DEADLINE = float(os.environ.get("FIBERBROWSER_DOWNLOAD_DEADLINE", 4 * 3600))       # whole download (s)
_CHUNK = 1 << 20
# An HTTPS download never follows a redirect to a non-HTTPS URL (the transport protection would be lost silently);
# FIBERBROWSER_DOWNLOAD_ALLOW_INSECURE_REDIRECT=1 allows plain HTTP (never ftp:).
ALLOW_INSECURE_REDIRECT = os.environ.get("FIBERBROWSER_DOWNLOAD_ALLOW_INSECURE_REDIRECT", "") == "1"
# Downloads larger than this ask first (Content-Length known) or warn once they pass it (unknown size); never a cap.
# 4 GB: every catalog genome stays under it (the largest, hg19 and hg38, are about 3.2 GB as plain FASTA; the
# gzipped ones and the GTFs are under 1 GB), so the usual genome loads never ask, while a file bigger than any
# catalog genome (a custom URL, a wrong file, a multi-assembly FASTA) does. 0 turns the warning off.
DEFAULT_WARN_BYTES = 4_000_000_000
WARN_BYTES_ENV = "FIBERBROWSER_DOWNLOAD_WARN_BYTES"


def warn_bytes() -> int:
    """The size warning threshold in bytes (0: off): ``FIBERBROWSER_DOWNLOAD_WARN_BYTES``, else the
    ``downloads.warn_bytes`` app setting (services/app_settings.py), else ``DEFAULT_WARN_BYTES``."""
    raw = os.environ.get(WARN_BYTES_ENV, "").strip()
    if raw:
        try:
            return max(0, int(float(raw)))
        except ValueError:
            pass
    try:
        from services import app_settings
        value = (app_settings.load().get("downloads") or {}).get("warn_bytes")
        if value is not None:
            return max(0, int(value))
    except Exception:   # noqa: BLE001 - an unreadable settings file means the default
        pass
    return DEFAULT_WARN_BYTES


class LargeDownload(Exception):
    """A download whose announced size (Content-Length) is over the warning threshold and was not confirmed.
    Raised before any of the body is read; nothing is written. Callers that try mirrors in turn stop (one
    confirmation covers every mirror)."""

    def __init__(self, url: str, total: int, threshold: int):
        super().__init__(f"{url} is {format_bytes(total)}, over the {format_bytes(threshold)} download warning size")
        self.url, self.total, self.threshold = url, int(total), int(threshold)


def format_bytes(n: int) -> str:
    n = float(n)
    for unit in ("bytes", "KB", "MB", "GB", "TB"):
        if n < 1000 or unit == "TB":
            return f"{int(n)} bytes" if unit == "bytes" else f"{n:.1f} {unit}"
        n /= 1000
    return f"{n:.1f} TB"


# This request's or job's choice: whether a large download was confirmed, and where size events go.
_policy: ContextVar = ContextVar("fiberbrowser_download_policy", default=None)


@contextmanager
def download_policy(confirmed: bool = False, events: list | None = None, threshold: int | None = None,
                    on_large=None):
    """Downloads started inside (``fetch``) by a caller that asked the user: ``confirmed`` lets one over the
    threshold go ahead; ``events`` (a list) receives ``{"kind": "confirm" | "large_confirmed" |
    "large_unknown_size", "url", "bytes", "threshold"}``; ``threshold`` overrides ``warn_bytes()``;
    ``on_large(url, bytes, threshold)`` hears of a large download that goes ahead (confirmed, or of unknown
    size once it passes the threshold)."""
    token = _policy.set({"confirmed": bool(confirmed), "events": events, "threshold": threshold,
                         "on_large": on_large})
    try:
        yield
    finally:
        _policy.reset(token)


def confirmation_needed() -> dict | None:
    """The download this request or job refused for want of confirmation (its ``confirm`` event), if any."""
    events = (_policy.get() or {}).get("events") or []
    return next((e for e in events if e.get("kind") == "confirm"), None)


class InsecureRedirect(urllib.error.URLError):
    """An HTTPS URL redirected to plain HTTP."""


class _NoDowngradeRedirect(urllib.request.HTTPRedirectHandler):
    def __init__(self, allow_insecure: bool):
        super().__init__()
        self.allow_insecure = allow_insecure

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if req.full_url.lower().startswith("https:"):
            scheme = urllib.parse.urlsplit(newurl).scheme.lower()
            # From HTTPS only HTTPS is followed (urllib would also follow ftp:); the escape hatch admits plain HTTP.
            if scheme != "https" and not (self.allow_insecure and scheme == "http"):
                raise InsecureRedirect(f"{req.full_url} redirected to non-HTTPS {newurl}: not followed")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class DownloadTimeout(socket.timeout):
    pass


class DownloadCancelled(Exception):
    """Raised by a progress hook to stop a download (the user cancelled it): callers that try mirrors in turn
    let it through instead of trying the next one."""


def _socket_of(response):
    raw = getattr(getattr(response, "fp", None), "raw", None)
    return getattr(raw, "_sock", None)


class _Watchdog:
    """Shuts down the download's sockets when the overall deadline passes."""

    def __init__(self, seconds: float):
        self._ends = time.monotonic() + seconds
        self._lock = threading.Lock()
        self._sockets: list = []
        self.fired = False
        self._timer = threading.Timer(seconds, self.fire)
        self._timer.daemon = True

    def left(self) -> float:
        left = self._ends - time.monotonic()
        if left <= 0 or self.fired:
            raise DownloadTimeout("Download deadline passed")
        return left

    def start(self):
        self._timer.start()

    def cancel(self):
        self._timer.cancel()

    @staticmethod
    def _shutdown(sock):
        try:
            socket.socket.shutdown(sock, socket.SHUT_RDWR)      # the fd itself (also under a TLS wrapper)
        except (OSError, TypeError, ValueError):
            pass

    def fire(self):
        with self._lock:
            self.fired = True
            sockets = list(self._sockets)
        for sock in sockets:
            self._shutdown(sock)

    def track(self, sock):
        with self._lock:
            self._sockets.append(sock)
            fired = self.fired
        if fired:
            self._shutdown(sock)

    def connection_class(self, http_class):
        watchdog = self

        class Watched(http_class):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                create = self._create_connection

                def create_connection(address, timeout=socket._GLOBAL_DEFAULT_TIMEOUT, *rest, **kw):
                    # Each connection (a redirect's too) gets at most the time left, and its socket is
                    # watched from the moment it exists: before a proxy CONNECT tunnel or a TLS handshake.
                    left = watchdog.left()
                    limited = not isinstance(timeout, (int, float)) or left < timeout
                    timeout = left if limited else timeout
                    try:
                        sock = create(address, timeout, *rest, **kw)
                    except socket.timeout as exc:
                        if limited:
                            raise DownloadTimeout("Download deadline passed while connecting") from exc
                        raise
                    watchdog.track(sock)
                    return sock
                self._create_connection = create_connection

            def connect(self):
                if not isinstance(self, http.client.HTTPSConnection):
                    super().connect()
                    return
                # HTTPSConnection.connect, with the TLS socket watched before its handshake (wrapping detaches
                # the watched TCP socket) and the handshake given at most the time left.
                http.client.HTTPConnection.connect(self)
                server_hostname = self._tunnel_host or self.host
                self.sock = self._context.wrap_socket(self.sock, server_hostname=server_hostname,
                                                      do_handshake_on_connect=False)
                watchdog.track(self.sock)
                timeout = self.sock.gettimeout()
                left = watchdog.left()
                limited = timeout is None or left < timeout
                self.sock.settimeout(left if limited else timeout)
                try:
                    self.sock.do_handshake()
                except socket.timeout as exc:
                    if limited:
                        raise DownloadTimeout("Download deadline passed during the TLS handshake") from exc
                    raise
                self.sock.settimeout(timeout)
        return Watched

    def opener(self, allow_insecure_redirect: bool | None = None):
        watchdog = self
        allow = ALLOW_INSECURE_REDIRECT if allow_insecure_redirect is None else bool(allow_insecure_redirect)

        class HTTP(urllib.request.HTTPHandler):
            def do_open(self, http_class, req, **kw):
                return super().do_open(watchdog.connection_class(http_class), req, **kw)

        class HTTPS(urllib.request.HTTPSHandler):
            def do_open(self, http_class, req, **kw):
                return super().do_open(watchdog.connection_class(http_class), req, **kw)
        return urllib.request.build_opener(HTTP, HTTPS, _NoDowngradeRedirect(allow))


def fetch(url: str, dest: str, reporthook=None, *, timeout: float | None = None, deadline: float | None = None,
          allow_insecure_redirect: bool | None = None, warn_at: int | None = None, confirmed: bool | None = None,
          on_large=None):
    """Download ``url`` to ``dest`` (as urlretrieve; ``reporthook(block_num, block_size, total_size)``).
    ``allow_insecure_redirect``: follow an HTTPS -> HTTP redirect (default: refused, InsecureRedirect).

    Size warning (no cap): ``warn_at`` bytes (default: ``download_policy``'s threshold, else ``warn_bytes()``;
    0 off). A ``Content-Length`` over it raises ``LargeDownload`` before the body unless ``confirmed`` (default:
    ``download_policy``'s, else False). A body of unknown size that passes it calls ``on_large(url, bytes,
    threshold)`` once and records a ``large_unknown_size`` event; the download goes on."""
    asked = _policy.get()
    policy = asked or {}
    threshold = warn_at if warn_at is not None else policy.get("threshold")
    threshold = warn_bytes() if threshold is None else max(0, int(threshold))
    if confirmed is None:
        # No caller that can ask (no download_policy): never refused, only warned about.
        confirmed = True if asked is None else bool(policy.get("confirmed"))
    else:
        confirmed = bool(confirmed)
    events = policy.get("events")
    on_large = on_large if on_large is not None else policy.get("on_large")
    timeout = READ_TIMEOUT if timeout is None else timeout
    deadline = DEADLINE if deadline is None else deadline
    ends = time.monotonic() + deadline
    watchdog = _Watchdog(deadline)

    def expired() -> DownloadTimeout:
        return DownloadTimeout(f"Download took longer than {deadline:g} s: {url}")

    def remaining() -> float:
        left = ends - time.monotonic()
        if left <= 0 or watchdog.fired:
            raise expired()
        return left

    watchdog.start()
    try:
        with watchdog.opener(allow_insecure_redirect).open(url, timeout=min(timeout, remaining())) as response, open(dest, "wb") as out:
            total = int(response.headers.get("Content-Length") or -1)
            if threshold and total > threshold and not confirmed:
                if events is not None:
                    events.append({"kind": "confirm", "url": url, "bytes": total, "threshold": threshold})
                raise LargeDownload(url, total, threshold)
            if threshold and total > threshold:
                print(f"  WARNING: large download, {format_bytes(total)} (over the {format_bytes(threshold)} download "
                      f"warning size): {url}")
                if events is not None:
                    events.append({"kind": "large_confirmed", "url": url, "bytes": total, "threshold": threshold})
                if on_large is not None:
                    on_large(url, total, threshold)
            read = getattr(response, "read1", None) or response.read
            received = block = 0
            warned = False
            if reporthook:
                reporthook(block, _CHUNK, total)
            while True:
                # The response's socket now: read1() closes it on reaching Content-Length (Python 3.11+), so a
                # socket held from before would be a closed descriptor.
                sock = _socket_of(response)
                left = min(timeout, remaining())
                if sock is not None and sock.fileno() != -1:
                    try:
                        sock.settimeout(max(0.001, left))
                    except OSError:
                        pass             # closed at EOF: the read below returns what is buffered, then b""
                chunk = read(_CHUNK)
                remaining()
                if not chunk:
                    break
                out.write(chunk)
                received += len(chunk)
                block += 1
                if threshold and total < 0 and not warned and received > threshold:
                    warned = True   # unknown size, now past the threshold: said once, never cancelled
                    print(f"  WARNING: large download of unknown size, past {format_bytes(threshold)}: {url}")
                    if events is not None:
                        events.append({"kind": "large_unknown_size", "url": url, "bytes": received,
                                       "threshold": threshold})
                    if on_large is not None:
                        on_large(url, received, threshold)
                if reporthook:
                    reporthook(block, _CHUNK, total)
            remaining()            # a body cut short by the watchdog is not a complete body
            if total >= 0 and received < total:
                raise urllib.error.ContentTooShortError(
                    f"retrieval incomplete: got only {received} out of {total} bytes", (dest, response.headers))
    except BaseException as exc:
        try:
            os.remove(dest)
        except OSError:
            pass
        if isinstance(exc, urllib.error.URLError) and isinstance(exc.reason, DownloadTimeout):
            raise expired() from exc       # the deadline, reached while connecting (urllib wraps it)
        if watchdog.fired and not isinstance(exc, DownloadTimeout):
            raise expired() from exc       # whatever the shut-down socket raised (headers, framing, body)
        raise
    finally:
        watchdog.cancel()
    return dest, None


def probe_size(url: str, *, timeout: float | None = None, allow_insecure_redirect: bool | None = None):
    """The size the server announces for ``url`` (``Content-Length`` of a HEAD request, through the same
    redirect rules and deadlines as ``fetch``), or None when it does not say or cannot be reached."""
    timeout = min(READ_TIMEOUT if timeout is None else timeout, 30.0)
    watchdog = _Watchdog(timeout)
    watchdog.start()
    try:
        request = urllib.request.Request(url, method="HEAD")
        with watchdog.opener(allow_insecure_redirect).open(request, timeout=timeout) as response:
            length = response.headers.get("Content-Length")
            return int(length) if length is not None and str(length).strip().isdigit() else None
    except Exception:   # noqa: BLE001 - the size is optional information
        return None
    finally:
        watchdog.cancel()
