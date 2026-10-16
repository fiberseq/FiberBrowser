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
- removes the partial file on any failure, so the caller can retry or fall back.

It keeps urlretrieve's progress-hook signature.
"""
from __future__ import annotations

import http.client
import os
import socket
import threading
import time
import urllib.error
import urllib.request

READ_TIMEOUT = float(os.environ.get("FIBERBROWSER_DOWNLOAD_TIMEOUT", 60))          # connect, and each read (s)
DEADLINE = float(os.environ.get("FIBERBROWSER_DOWNLOAD_DEADLINE", 4 * 3600))       # whole download (s)
_CHUNK = 1 << 20


class DownloadTimeout(socket.timeout):
    pass


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

    def opener(self):
        watchdog = self

        class HTTP(urllib.request.HTTPHandler):
            def do_open(self, http_class, req, **kw):
                return super().do_open(watchdog.connection_class(http_class), req, **kw)

        class HTTPS(urllib.request.HTTPSHandler):
            def do_open(self, http_class, req, **kw):
                return super().do_open(watchdog.connection_class(http_class), req, **kw)
        return urllib.request.build_opener(HTTP, HTTPS)


def fetch(url: str, dest: str, reporthook=None, *, timeout: float | None = None, deadline: float | None = None):
    """Download ``url`` to ``dest`` (as urlretrieve; ``reporthook(block_num, block_size, total_size)``)."""
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
        with watchdog.opener().open(url, timeout=min(timeout, remaining())) as response, open(dest, "wb") as out:
            total = int(response.headers.get("Content-Length") or -1)
            read = getattr(response, "read1", None) or response.read
            received = block = 0
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
