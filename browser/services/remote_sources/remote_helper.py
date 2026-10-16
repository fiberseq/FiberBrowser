"""FiberBrowser remote file helper: read-only HTTP range server for SSH sources.

This file is NOT imported by FiberBrowser. It is streamed over an SSH session
to ``python3`` on the remote machine (a cluster login node) and runs there
without installing anything. It must stay:

- pure standard library and Python 3.6 compatible (no dataclasses, no
  ``ThreadingHTTPServer``, no walrus operator, no f-strings);
- read-only: GET and HEAD only, regular files only, never writes anywhere
  (except its own private socket folder, removed when it exits);
- confined: a request path is resolved with realpath and must lie under one
  of the roots the user chose; the file or folder is then opened by walking
  from a descriptor of that root pinned at start-up, one component at a time
  with ``O_NOFOLLOW`` (``openat``), so a folder swapped for a symlink between
  the check and the open is refused instead of followed. Listing and stat use
  the same descriptors;
- private: by default it listens on a Unix socket inside a new 0700 folder
  (only this account can connect; FiberBrowser reaches it with an OpenSSH
  local-to-socket forward). When the site refuses socket forwarding it binds
  127.0.0.1 on a random port instead. Either way every request carries a
  per-connection secret as its first path segment: the connection token, or
  for file bytes a per-file key derived from it (a wrong one is answered
  exactly like an unknown path);
- bounded: at most ``MAX_CONNECTIONS`` connections at once (more are refused
  at once), a request line and headers must arrive within
  ``REQUEST_DEADLINE`` seconds (idle keep-alive connections are closed after
  that), a response the client stops reading is abandoned after
  ``WRITE_TIMEOUT`` seconds, closed byte ranges are at most
  ``MAX_RANGE_BYTES``, and a listing reads at most ``MAX_LIST_SCAN`` entries
  within ``LIST_TIME_BUDGET`` seconds;
- short-lived: it exits when its stdin closes (the SSH session ended), on
  SIGHUP/SIGTERM, or after ``idle_timeout`` seconds without requests.

Protocol. The launcher runs ``python3 -u -c <bootstrap>`` where the bootstrap
reads one line with the script length, then the script, and ``exec``s it. The
script then reads one JSON line of configuration from stdin::

    {"token": "...", "roots": ["~", "/projects/LAB"], "idle_timeout": 28800,
     "listen": "unix"}

and prints one line ``FBHELPER_READY {json}`` to stdout with the socket path
(``"socket"``) or port (``"port"``), pid, Python version and the resolved
roots. Nothing else is written to stdout.

Routes::

    GET|HEAD /<file key>/f/<absolute path>  file bytes, single Range supported
    GET      /<token>/ls?path=<dir>         JSON directory listing (bounded)
    GET      /<token>/stat?path=<path>      JSON size/mtime/version/type
    GET      /<token>/roots                 JSON resolved roots
    GET      /<token>/ping                  JSON {"ok": true}
    GET      /<token>/stats                 JSON bytes/requests served

``<file key>`` is ``file_key(token, path)``: the token itself also works. A
file key opens only that file and its index files (``.fai``, ``.gzi``,
``.bai``, ``.csi``, ``.crai``, ``.tbi`` next to it), so a URL that ends up in
a log opens nothing else.
"""
import hashlib
import hmac
import io
import json
import os
import re
import signal
import socket
import stat
import sys
import tempfile
import threading
import time

try:  # Python 3
    from http.server import BaseHTTPRequestHandler, HTTPServer
    from socketserver import TCPServer, ThreadingMixIn
    from urllib.parse import parse_qs, unquote, urlsplit
except ImportError:  # pragma: no cover - Python 2 is refused by the launcher
    sys.stderr.write("FBHELPER_ERROR python3 is required\n")
    sys.exit(97)

HELPER_VERSION = 2
CHUNK = 256 * 1024
MAX_LIST_ENTRIES = 5000
MAX_LIST_SCAN = 50000
LIST_TIME_BUDGET = 5.0
# Closed byte ranges (pyBigWig asks for 128 kB at a time). htslib's own
# requests are open-ended ("bytes=N-") or carry no Range at all and must be
# streamed as they are: it reads a shorter answer as a truncated file.
MAX_RANGE_BYTES = 256 * 1024 * 1024
# FiberBrowser itself keeps one paused stream per open BAM/FASTA handle per
# worker thread (about 40 threads x open cluster files), so the cap is roomy;
# 256 connections plus as many open files still fit a 1024-descriptor limit.
MAX_CONNECTIONS = 256
REQUEST_DEADLINE = 20.0
# htslib pauses a stream between reads; FiberBrowser reopens a handle idle for
# 5 minutes, so a paused stream is abandoned only well after that.
WRITE_TIMEOUT = 900.0
INDEX_SUFFIXES = (".fai", ".gzi", ".bai", ".csi", ".crai", ".tbi")
READY_PREFIX = "FBHELPER_READY "

CONFIG = {"token": "", "roots": [], "idle_timeout": 0, "listen": "tcp"}
ROOTS = []  # resolved (realpath) root directories
ROOT_FDS = {}  # root -> descriptor pinned at start-up
STATS = {"bytes": 0, "requests": 0, "started": time.time(), "last": time.time()}
STATS_LOCK = threading.Lock()
SOCKET_DIR = {}  # the private socket's folder: {"path", "fd"} (removed on exit)

_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
_CLOEXEC = getattr(os, "O_CLOEXEC", 0)
_OPEN_DIR = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | _NOFOLLOW | _CLOEXEC
_OPEN_FILE = os.O_RDONLY | _NOFOLLOW | getattr(os, "O_NONBLOCK", 0) | _CLOEXEC
_monotonic = getattr(time, "monotonic", time.time)
_SCANDIR_FD = sys.version_info >= (3, 7)  # os.scandir(fd) is 3.7+
# Python 3.6 reads an open folder entry by entry through one of these (Linux:
# /proc); where none works (macOS 3.6, no /proc) listing is refused.
_FD_ALIASES = ("/proc/self/fd/%d", "/dev/fd/%d")


def file_key(token, path):
    """The per-file secret for ``path`` (FiberBrowser computes the same)."""
    message = ("f\x00" + path).encode("utf-8", "surrogateescape")
    return hmac.new(token.encode("utf-8"), message, hashlib.sha256).hexdigest()[:40]


def version_of(st):
    """A file version that changes whenever the file is replaced or rewritten."""
    return "%x-%x-%x-%x-%x" % (int(st.st_size), int(st.st_mtime_ns), int(st.st_ctime_ns),
                               int(st.st_ino), int(st.st_dev))


def _resolve_root(raw):
    """A user-chosen root: ~ and $VARS expanded, must be an existing directory."""
    if not isinstance(raw, str) or not raw.strip() or "\x00" in raw:
        return None
    path = os.path.expandvars(os.path.expanduser(raw.strip()))
    if not os.path.isabs(path):
        return None
    try:
        real = os.path.realpath(path)
    except (OSError, ValueError, RuntimeError):
        return None
    if not os.path.isdir(real):
        return None
    return real


def _pin_root(real):
    """A descriptor for the root folder ``real`` (a realpath), or None.

    Opened by walking from "/" one component at a time without following any
    symlink (a realpath has none), and checked to be the very folder that
    ``real`` named a moment earlier, so an ancestor renamed or swapped for a
    link during start-up cannot make an outside folder the root.
    """
    try:
        expected = os.stat(real)
    except OSError:
        return None
    try:
        fd = os.open("/", _OPEN_DIR)
    except OSError:
        return None
    try:
        for name in [part for part in real.split("/") if part]:
            nxt = os.open(name, _OPEN_DIR, dir_fd=fd)
            _close(fd)
            fd = nxt
        got = os.fstat(fd)
        if not stat.S_ISDIR(got.st_mode) or (got.st_dev, got.st_ino) != (expected.st_dev, expected.st_ino):
            _close(fd)
            return None
        return fd
    except OSError:
        _close(fd)
        return None


def _root_of(real):
    """The most specific root containing ``real``, or None."""
    best = None
    for root in ROOTS:
        if root == "/" or real == root or real.startswith(root.rstrip("/") + "/"):
            if best is None or len(root) > len(best):
                best = root
    return best


def _under_roots(real):
    return _root_of(real) is not None


def confine(path):
    """Resolved path under a root, or None. ``path`` must be absolute (or ~)."""
    if not isinstance(path, str) or not path or "\x00" in path:
        return None
    if path.startswith("~"):
        path = os.path.expanduser(path)
    if not path.startswith("/"):
        return None
    try:
        real = os.path.realpath(path)
    except (OSError, ValueError, RuntimeError):  # RecursionError: a very long chain of links
        return None
    return real if _under_roots(real) else None


def _close(fd):
    try:
        os.close(fd)
    except OSError:
        pass


def open_confined(path, kind):
    """Open ``path`` inside the roots by an anchored descriptor walk.

    ``kind`` is "file" (regular files), "dir" or "any". Returns
    ``(fd, stat_result, real_path)``, or None when the path is outside the
    roots, missing, of the wrong kind, or changed during the walk. For "any",
    a FIFO/socket/device is reported without being opened (fd None).

    Symlinks inside the roots are resolved by realpath first; the walk from
    the root's pinned descriptor then refuses any symlink it meets
    (``O_NOFOLLOW``), so a folder swapped for a link after the check is never
    followed, on Linux and macOS alike.
    """
    real = confine(path)
    if real is None:
        return None
    root = _root_of(real)
    rest = real if root == "/" else real[len(root):]
    parts = [part for part in rest.split("/") if part]
    try:
        cur = os.dup(ROOT_FDS[root])
    except (KeyError, OSError):
        return None
    try:
        for name in parts[:-1]:
            nxt = os.open(name, _OPEN_DIR, dir_fd=cur)
            _close(cur)
            cur = nxt
        if not parts:  # the root itself
            if kind == "file":
                return None
            fd, cur = cur, None
            return fd, os.fstat(fd), real
        name = parts[-1]
        before = os.stat(name, dir_fd=cur, follow_symlinks=False)
        if stat.S_ISDIR(before.st_mode):
            flags, wanted = _OPEN_DIR, kind in ("dir", "any")
        elif stat.S_ISREG(before.st_mode):
            flags, wanted = _OPEN_FILE, kind in ("file", "any")
        else:
            # A link here was swapped in after realpath: refused. FIFOs,
            # sockets and devices are never opened (opening can block or act).
            if kind == "any" and not stat.S_ISLNK(before.st_mode):
                return None, before, real
            return None
        if not wanted:
            return None
        fd = os.open(name, flags, dir_fd=cur)
        after = os.fstat(fd)
        if (after.st_dev, after.st_ino) != (before.st_dev, before.st_ino):
            _close(fd)
            return None
        return fd, after, real
    except (OSError, ValueError):
        return None
    finally:
        if cur is not None:
            _close(cur)


def parse_range(header, size):
    """(start, end) inclusive, None for no Range, "unsatisfiable", "invalid" or "too_large".

    Only one ``bytes=`` range is accepted; anything else is refused (416)
    rather than answered with the whole file. Open-ended ranges are htslib's
    streaming reads and are not capped; closed ranges are at most
    ``MAX_RANGE_BYTES``.
    """
    if header is None:
        return None  # no Range header at all
    header = header.strip()
    if not header:
        return "invalid"  # present but empty: not a request for the whole file
    # At most 20 digits per bound (more than any file size; int() of thousands
    # of digits is refused by Python 3.11+ with ValueError).
    match = re.match(r"^bytes=(\d{0,20})-(\d{0,20})$", header)
    if not match:
        return "invalid"  # multi-range, other units or malformed
    first, last = match.group(1), match.group(2)
    if first == "" and last == "":
        return "invalid"
    if first == "":
        suffix = int(last)
        if suffix == 0 or size == 0:
            return "unsatisfiable"
        if min(suffix, size) > MAX_RANGE_BYTES:
            return "too_large"
        return (max(0, size - suffix), size - 1)
    start = int(first)
    if last != "" and int(last) < start:
        return "invalid"
    if start >= size:
        return "unsatisfiable"
    if last == "":
        return (start, size - 1)
    end = min(int(last), size - 1)
    if end - start + 1 > MAX_RANGE_BYTES:
        return "too_large"
    return (start, end)


class _NoBoundedListing(Exception):
    """Python 3.6 without /proc/self/fd or /dev/fd: no way to read a folder in steps."""


NO_BOUNDED_LISTING = ("Listing folders needs Python 3.7 or newer on this machine (its Python %d.%d "
                      "cannot read a folder a bounded number of entries at a time). Set Remote Python "
                      "to a newer python3; files you open by reference still work.")


def _dir_entries(fd, deadline):
    """Names in the open folder ``fd``: at most MAX_LIST_SCAN, until ``deadline``.

    Returns (names, stopped) where ``stopped`` is None, "scan" or "time".
    """
    names = []
    if _SCANDIR_FD:
        iterator = os.scandir(fd)
        try:
            for count, entry in enumerate(iterator):
                if count >= MAX_LIST_SCAN:
                    return names, "scan"
                if count % 256 == 255 and _monotonic() > deadline:
                    return names, "time"
                names.append(entry.name)
        finally:
            iterator.close()
        return names, None
    # Python 3.6: os.scandir takes no descriptor, but it reads the same open
    # folder through /proc/self/fd/N (Linux) or /dev/fd/N, entry by entry.
    for pattern in _FD_ALIASES:
        alias = pattern % fd
        try:
            same = os.stat(alias)
            mine = os.fstat(fd)
            if (same.st_dev, same.st_ino) != (mine.st_dev, mine.st_ino):
                continue
            iterator = os.scandir(alias)
        except OSError:
            continue
        try:
            for count, entry in enumerate(iterator):
                if count >= MAX_LIST_SCAN:
                    return names, "scan"
                if count % 256 == 255 and _monotonic() > deadline:
                    return names, "time"
                names.append(entry.name)
        finally:
            close = getattr(iterator, "close", None)
            if close is not None:
                close()
        return names, None
    # No descriptor alias (no /proc, macOS): the only reader left is
    # os.listdir(fd), which reads the whole folder at once. Refuse instead of
    # breaking the bound; a newer remote Python lists normally.
    raise _NoBoundedListing()


def list_dir(fd, real, show_hidden=False):
    """Bounded JSON listing of the folder open as ``fd`` (its real path ``real``)."""
    deadline = _monotonic() + LIST_TIME_BUDGET
    try:
        names, stopped = _dir_entries(fd, deadline)
    except _NoBoundedListing:
        return {"error": NO_BOUNDED_LISTING % sys.version_info[:2], "entries": []}
    except OSError as exc:
        return {"error": "Cannot list folder: %s" % exc.strerror, "entries": []}
    scanned = len(names)
    if not show_hidden:
        names = [name for name in names if not name.startswith(".")]
    names.sort()
    entries = []
    for index, name in enumerate(names):
        if len(entries) >= MAX_LIST_ENTRIES:
            stopped = stopped or "limit"
            break
        if index % 64 == 63 and _monotonic() > deadline:
            stopped = stopped or "time"
            break
        try:
            st = os.stat(name, dir_fd=fd, follow_symlinks=False)
        except OSError:
            continue
        is_link = stat.S_ISLNK(st.st_mode)
        if is_link:
            # Shown only when it leads to a file or folder inside the roots.
            target = open_confined(os.path.join(real, name), "any")
            if target is None or target[0] is None:
                continue
            _close(target[0])
            st = target[1]
        if stat.S_ISDIR(st.st_mode):
            kind = "dir"
        elif stat.S_ISREG(st.st_mode):
            kind = "file"
        else:
            continue  # sockets, FIFOs, devices: never listed, never served
        entries.append({
            "name": name,
            "type": kind,
            "size": int(st.st_size) if kind == "file" else None,
            "mtime": int(st.st_mtime),
            "link": bool(is_link),
        })
    return {"path": real, "entries": entries, "truncated": stopped is not None,
            "truncated_reason": stopped, "scanned": scanned, "limit": MAX_LIST_ENTRIES}


class _DeadlineReader(io.RawIOBase):
    """Socket reads that give up at the handler's request deadline (slow clients)."""

    def __init__(self, handler):
        io.RawIOBase.__init__(self)
        self._handler = handler

    def readable(self):
        return True

    def readinto(self, buffer):
        remaining = self._handler.deadline - _monotonic()
        if remaining <= 0:
            raise socket.timeout("request deadline")
        self._handler.connection.settimeout(remaining)
        return self._handler.connection.recv_into(buffer)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "fiberbrowser-remote-helper/%d" % HELPER_VERSION
    sys_version = ""
    deadline = 0.0

    def log_message(self, *args):  # never log request lines (they carry the token)
        pass

    # -- plumbing ---------------------------------------------------------
    def setup(self):
        BaseHTTPRequestHandler.setup(self)
        # Reads go through the request deadline: a client that sends its
        # request line or headers slowly (or not at all) is dropped.
        plain = self.rfile
        self.deadline = _monotonic() + REQUEST_DEADLINE
        self.rfile = io.BufferedReader(_DeadlineReader(self), 64 * 1024)
        plain.close()

    def handle_one_request(self):
        # Each request (and each idle wait between keep-alive requests) gets
        # REQUEST_DEADLINE seconds for its request line and headers.
        self.deadline = _monotonic() + REQUEST_DEADLINE
        BaseHTTPRequestHandler.handle_one_request(self)

    def _start_response_phase(self):
        try:
            self.connection.settimeout(WRITE_TIMEOUT)
        except OSError:
            pass

    def _touch(self, nbytes=0):
        with STATS_LOCK:
            STATS["requests"] += 1
            STATS["bytes"] += nbytes
            STATS["last"] = time.time()

    def _send_plain(self, code, text, extra=None, head=False):
        body = (text + "\n").encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if not head:
            self.wfile.write(body)
        self._touch(0)

    def _send_json(self, payload, code=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)
        self._touch(0)

    def _not_found(self, head=False):
        self._send_plain(404, "Not found", head=head)

    def _route(self):
        """(route, rest, query) after a valid token or file key, or None."""
        parts = urlsplit(self.path)
        raw_path = parts.path or ""
        if not raw_path.startswith("/"):
            return None
        segments = raw_path[1:].split("/", 2)
        if len(segments) < 2:
            return None
        token = CONFIG.get("token") or ""
        if not token:
            return None
        supplied = segments[0].encode("utf-8", "surrogateescape")
        route = segments[1]
        rest = "/" + segments[2] if len(segments) > 2 else ""
        if not hmac.compare_digest(supplied, token.encode("utf-8")):
            if route != "f" or not self._file_key_ok(supplied, unquote(rest)):
                return None
        return route, rest, parse_qs(parts.query)

    @staticmethod
    def _file_key_ok(supplied, path):
        """A per-file key opens that file and the index files next to it."""
        token = CONFIG.get("token") or ""
        candidates = [path]
        for suffix in INDEX_SUFFIXES:
            if path.endswith(suffix) and len(path) > len(suffix):
                candidates.append(path[:-len(suffix)])
        ok = False
        for candidate in candidates:  # no early exit: same work for every key
            if hmac.compare_digest(supplied, file_key(token, candidate).encode("ascii")):
                ok = True
        return ok

    # -- methods ----------------------------------------------------------
    def do_GET(self):
        self._handle(head=False)

    def do_HEAD(self):
        self._handle(head=True)

    def _refuse_write(self):
        self._start_response_phase()
        self._send_plain(405, "Read-only", extra={"Allow": "GET, HEAD"})

    do_POST = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = _refuse_write

    def _handle(self, head):
        self._start_response_phase()
        routed = self._route()
        if routed is None:
            self._not_found(head)
            return
        route, rest, query = routed
        if route == "f":
            self._serve_file(unquote(rest), head)
            return
        if head:
            self._send_plain(405, "Use GET", head=True)
            return
        if route == "ping":
            self._send_json({"ok": True, "time": time.time()})
        elif route == "roots":
            self._send_json({"roots": ROOTS, "home": os.path.expanduser("~")})
        elif route == "stats":
            with STATS_LOCK:
                snapshot = dict(STATS)
            snapshot["now"] = time.time()
            self._send_json(snapshot)
        elif route == "ls":
            raw = (query.get("path") or [""])[0]
            opened = open_confined(raw, "dir")
            if opened is None:
                self._send_json({"error": "Folder is not under the allowed roots", "entries": []}, 403)
                return
            fd, _st, real = opened
            try:
                hidden = (query.get("hidden") or ["0"])[0] == "1"
                payload = list_dir(fd, real, hidden)
            finally:
                _close(fd)
            self._send_json(payload)
        elif route == "stat":
            raw = (query.get("path") or [""])[0]
            opened = open_confined(raw, "any")
            if opened is None:
                self._send_json({"exists": False}, 404)
                return
            fd, st, _real = opened
            if fd is not None:
                _close(fd)
            kind = "dir" if stat.S_ISDIR(st.st_mode) else "file" if stat.S_ISREG(st.st_mode) else "other"
            self._send_json({
                "exists": True, "type": kind, "size": int(st.st_size), "mtime": int(st.st_mtime),
                "mtime_ns": int(st.st_mtime_ns), "ctime_ns": int(st.st_ctime_ns),
                "ino": int(st.st_ino), "dev": int(st.st_dev), "version": version_of(st),
            })
        else:
            self._not_found()

    def _serve_file(self, path, head):
        opened = open_confined(path, "file")
        if opened is None:
            self._not_found(head)
            return
        fd, st, _real = opened
        try:
            handle = os.fdopen(fd, "rb")
        except OSError:
            _close(fd)
            self._not_found(head)
            return
        with handle:
            size = int(st.st_size)
            wanted = parse_range(self.headers.get("Range"), size)
            if wanted in ("unsatisfiable", "invalid", "too_large"):
                text = {"unsatisfiable": "Range not satisfiable",
                        "invalid": "Only one byte range (bytes=first-last) is accepted",
                        "too_large": "Range larger than %d bytes" % MAX_RANGE_BYTES}[wanted]
                self._send_plain(416, text,
                                 extra={"Content-Range": "bytes */%d" % size, "Accept-Ranges": "bytes"}, head=head)
                return
            if wanted is None:
                start, end, code = 0, size - 1, 200
            else:
                start, end = wanted
                code = 206
            length = max(0, end - start + 1)
            self.send_response(code)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(length))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Last-Modified", self.date_time_string(int(st.st_mtime)))
            self.send_header("ETag", '"%s"' % version_of(st))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            if code == 206:
                self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
            self.end_headers()
            if head or length == 0:
                self._touch(0)
                return
            handle.seek(start)
            remaining = length
            self._touch(0)
            try:
                while remaining > 0:
                    chunk = handle.read(min(CHUNK, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
                    with STATS_LOCK:  # counted as it goes: the transfer rate the UI shows
                        STATS["bytes"] += len(chunk)
                        STATS["last"] = time.time()
            except (BrokenPipeError, ConnectionResetError, socket.timeout):
                self.close_connection = True
            if remaining > 0:
                # The file shrank under us, or the client stopped reading.
                self.close_connection = True


class Server(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    block_on_close = False  # daemon workers; never keep a list of them (3.7+)
    allow_reuse_address = False
    request_queue_size = 64
    max_connections = MAX_CONNECTIONS

    def __init__(self, *args, **kwargs):
        self._slots = threading.BoundedSemaphore(self.max_connections)
        HTTPServer.__init__(self, *args, **kwargs)

    def process_request(self, request, client_address):
        # A bounded number of connections, whoever opens them (checked before
        # anything is read, so no token is needed to be refused).
        if not self._slots.acquire(False):
            self._refuse(request)
            return
        try:
            ThreadingMixIn.process_request(self, request, client_address)
        except Exception:
            self._slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            ThreadingMixIn.process_request_thread(self, request, client_address)
        finally:
            self._slots.release()

    def _refuse(self, request):
        try:
            request.setblocking(False)
            request.send(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        except OSError:
            pass
        self.shutdown_request(request)

    def handle_error(self, request, client_address):
        # Clients (htslib, libcurl) drop keep-alive connections at will; a
        # reset is normal and nothing about it belongs on the SSH stderr.
        pass


class UnixServer(Server):
    """The same server on a Unix socket (only this account can connect)."""
    address_family = socket.AF_UNIX

    def server_bind(self):
        # HTTPServer.server_bind would treat the path as (host, port) and look it up.
        TCPServer.server_bind(self)
        self.server_name = "localhost"
        self.server_port = 0

    def get_request(self):
        request, _address = self.socket.accept()
        return request, ("local", 0)


def _cleanup():
    """Remove the private socket and its folder: the folder we made, not whatever the path names now."""
    fd = SOCKET_DIR.pop("fd", None)
    path = SOCKET_DIR.pop("path", None)
    if fd is None:
        return
    try:
        try:
            os.unlink("s", dir_fd=fd)
        except OSError:
            pass
        try:
            now = os.lstat(path)
            mine = os.fstat(fd)
            if (now.st_dev, now.st_ino) == (mine.st_dev, mine.st_ino):
                os.rmdir(path)
        except OSError:
            pass
    finally:
        _close(fd)


def _exit(code=0):
    _cleanup()
    os._exit(code)


def _trusted_folder(path):
    """True when no other account can rename or replace entries in ``path``.

    Every folder from ``path`` up to "/" must belong to this account or root
    and, when others may write to it, be sticky (like /tmp).
    """
    try:
        current = os.path.realpath(path)
    except (OSError, ValueError, RuntimeError):
        return False
    uid = os.getuid()
    while True:
        try:
            info = os.lstat(current)
        except OSError:
            return False
        if not stat.S_ISDIR(info.st_mode) or info.st_uid not in (0, uid):
            return False
        mode = stat.S_IMODE(info.st_mode)
        if mode & 0o022 and not mode & stat.S_ISVTX:
            return False
        parent = os.path.dirname(current)
        if parent == current:
            return True
        current = parent


def _private_socket_path():
    """A socket path inside a new 0700 folder (short: Unix socket paths are ~104 bytes).

    Only under a folder no other account can tamper with (a private runtime
    folder, or a sticky /tmp owned by root); otherwise None, and the helper
    uses a loopback port instead.
    """
    bases = []
    runtime = os.environ.get("XDG_RUNTIME_DIR")
    if runtime:
        bases.append(runtime)
    bases.extend([tempfile.gettempdir(), "/tmp"])
    for base in bases:
        # Short, and nothing ssh -L would misread (':' or spaces): FiberBrowser
        # refuses other socket paths and would fall back to a port for nothing.
        if not base or len(base) > 70 or not re.match(r"^/[A-Za-z0-9._/-]*$", base) or not os.path.isdir(base):
            continue
        if not _trusted_folder(base):
            continue
        try:
            folder = tempfile.mkdtemp(prefix="fbh-", dir=base)  # 0700, created atomically
        except OSError:
            continue
        try:
            fd = os.open(folder, _OPEN_DIR)
        except OSError:
            continue
        info = os.fstat(fd)
        same = os.lstat(folder)
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077
                or (same.st_dev, same.st_ino) != (info.st_dev, info.st_ino)):
            _close(fd)
            continue
        SOCKET_DIR.update({"path": folder, "fd": fd})
        return os.path.join(folder, "s")
    return None


def _watch_stdin():
    """Exit as soon as the SSH session (our stdin) closes."""
    try:
        stream = sys.stdin.buffer
        while True:
            data = stream.read(1)
            if not data:
                break
    except Exception:
        pass
    _exit(0)


def _watch_idle(timeout):
    while True:
        time.sleep(min(60.0, max(1.0, timeout / 4.0)))
        with STATS_LOCK:
            idle = time.time() - STATS["last"]
        if idle > timeout:
            _exit(0)


def _on_signal(signum, frame):
    _exit(0)


def _make_server():
    """(server, address info for the ready line). Unix socket when asked and possible."""
    if CONFIG["listen"] == "unix" and hasattr(socket, "AF_UNIX"):
        path = _private_socket_path()
        if path is not None:
            try:
                return UnixServer(path, Handler), {"socket": path, "port": None}
            except OSError:
                _cleanup()
    server = Server(("127.0.0.1", 0), Handler)
    return server, {"socket": None, "port": server.server_address[1]}


def main():
    line = sys.stdin.buffer.readline()
    try:
        config = json.loads(line.decode("utf-8"))
    except Exception:
        sys.stderr.write("FBHELPER_ERROR bad configuration line\n")
        sys.exit(2)
    token = config.get("token")
    if not isinstance(token, str) or len(token) < 32 or not re.match(r"^[A-Za-z0-9_-]+$", token):
        sys.stderr.write("FBHELPER_ERROR a random token of at least 32 characters is required\n")
        sys.exit(2)
    if not (os.open in os.supports_dir_fd and os.stat in os.supports_dir_fd):
        sys.stderr.write("FBHELPER_ERROR this Python cannot open files relative to a folder (openat)\n")
        sys.exit(4)
    CONFIG["token"] = token
    CONFIG["listen"] = "unix" if config.get("listen") == "unix" else "tcp"
    try:
        CONFIG["idle_timeout"] = max(0, int(config.get("idle_timeout") or 0))
    except (TypeError, ValueError):
        CONFIG["idle_timeout"] = 0
    requested = config.get("roots") or ["~"]
    missing = []
    for raw in requested:
        real = _resolve_root(raw)
        if real is None:
            missing.append(raw if isinstance(raw, str) else repr(raw))
            continue
        if real in ROOTS:
            continue
        fd = _pin_root(real)
        if fd is None:
            missing.append(raw)
            continue
        ROOT_FDS[real] = fd
        ROOTS.append(real)
    if not ROOTS:
        sys.stderr.write("FBHELPER_ERROR none of the folders exist: %s\n" % ", ".join(missing))
        sys.exit(3)

    for signum in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(signum, _on_signal)
        except (OSError, ValueError):
            pass
    server, address = _make_server()
    ready = {
        "version": HELPER_VERSION,
        "port": address["port"],
        "socket": address["socket"],
        "pid": os.getpid(),
        "python": "%d.%d.%d" % sys.version_info[:3],
        "roots": ROOTS,
        "missing_roots": missing,
        "home": os.path.expanduser("~"),
        "host": socket.gethostname(),
    }
    sys.stdout.write(READY_PREFIX + json.dumps(ready) + "\n")
    sys.stdout.flush()

    watcher = threading.Thread(target=_watch_stdin, name="stdin-watch")
    watcher.daemon = True
    watcher.start()
    if CONFIG["idle_timeout"]:
        idle = threading.Thread(target=_watch_idle, args=(CONFIG["idle_timeout"],), name="idle-watch")
        idle.daemon = True
        idle.start()
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        _exit(0)


if __name__ == "__main__":
    main()
