"""A small range-capable HTTP file server for session-link tests.

It runs in its own process: pyBigWig and htslib hold the GIL while they wait
for the network, so a server thread in the test process would never answer.

Serves files from a folder. A file whose name is listed in ``signed`` needs
``?sig=<value>`` (anything else gets 403, like an expired pre-signed URL);
HEAD requests to signed files get 403 too (pre-signed URLs are signed for GET
only). ``redirects`` maps a path to a Location; ``chunked`` paths are sent
without a Content-Length. Every request is counted in ``hits``.
"""
from __future__ import annotations

import http.server
import os
import re
from urllib.parse import parse_qs, urlsplit

import pytest


def _pybigwig_reads_urls() -> bool:
    try:
        from services.pybigwig_support import reads_urls
    except ImportError:  # imported before the browser folder is on sys.path
        import pyBigWig
        return bool(getattr(pyBigWig, "remote", 1))
    return reads_urls()


# PyPI's x86_64 Linux pyBigWig wheels have no libcurl: such a build can't read any
# URL (CI builds pyBigWig from source so these run; services/pybigwig_support.py).
needs_pybigwig_urls = pytest.mark.skipif(
    not _pybigwig_reads_urls(),
    reason="this pyBigWig was built without libcurl (pyBigWig.remote == 0): it can't read URLs; "
           "pip install --no-binary pyBigWig pyBigWig with the libcurl headers installed")


class _Config:
    """Settings shared with the server process through a JSON file."""

    def __init__(self, path: str):
        self.path = path

    def load(self) -> dict:
        import json
        try:
            with open(self.path) as handle:
                return json.load(handle)
        except (OSError, ValueError):
            return {}

    def save(self, data: dict) -> None:
        import json
        tmp = self.path + ".tmp"
        with open(tmp, "w") as handle:
            json.dump(data, handle)
        os.replace(tmp, self.path)


class _Watched(dict):
    """A dict/set stand-in that writes the server's config on every change."""

    def __init__(self, owner: "LinkServer", key: str):
        super().__init__()
        self._owner, self._key = owner, key

    def __setitem__(self, k, v):
        super().__setitem__(k, v)
        self._owner._save()

    def update(self, *args, **kwargs):
        super().update(*args, **kwargs)
        self._owner._save()

    def add(self, k):
        self[k] = True


def _make_handler(root: str, config: _Config, hits_path: str):
    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass

        def _serve(self, head: bool):
            settings = config.load()
            parts = urlsplit(self.path)
            with open(hits_path, "a") as handle:
                handle.write(self.path + "\n")
            name = parts.path.lstrip("/")
            redirects = settings.get("redirects", {})
            if parts.path in redirects:
                self.send_response(302)
                self.send_header("Location", redirects[parts.path])
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            expected = settings.get("signed", {}).get(name)
            if expected is not None:
                sig = parse_qs(parts.query).get("sig", [None])[0]
                if head or sig != expected:
                    # As an object store answers an expired pre-signed URL.
                    body = b"<?xml version=\"1.0\"?><Error><Code>AccessDenied</Code></Error>"
                    self.send_response(403)
                    self.send_header("Content-Type", "application/xml")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    if not head:
                        self.wfile.write(body)
                    return
            path = os.path.join(root, name)
            if not name or not os.path.isfile(path):
                self.send_response(404)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            with open(path, "rb") as handle:
                data = handle.read()
            size = len(data)
            status, body = 200, data
            match = re.match(r"bytes=(\d+)-(\d*)", self.headers.get("Range") or "")
            if match:
                start = int(match.group(1))
                end = min(int(match.group(2)) if match.group(2) else size - 1, size - 1)
                status, body = 206, data[start:end + 1]
            self.send_response(status)
            self.send_header("Accept-Ranges", "bytes")
            if status == 206:
                self.send_header("Content-Range", f"bytes {match.group(1)}-{int(match.group(1)) + len(body) - 1}/{size}")
            if parts.path in settings.get("chunked", {}):
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()
                if not head:
                    for i in range(0, len(body), 4096):
                        chunk = body[i:i + 4096]
                        self.wfile.write(f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n")
                    self.wfile.write(b"0\r\n\r\n")
                return
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if not head:
                self.wfile.write(body)

        def do_GET(self):
            self._serve(head=False)

        def do_HEAD(self):
            self._serve(head=True)

    return Handler


class LinkServer:
    def __init__(self, root: str):
        import subprocess
        import sys
        import tempfile
        import time
        self.root = root
        state_dir = tempfile.mkdtemp(prefix="fiberbrowser-linkserver-")
        self._config = _Config(os.path.join(state_dir, "config.json"))
        self._hits_path = os.path.join(state_dir, "hits.txt")
        port_file = os.path.join(state_dir, "port")
        self.signed = _Watched(self, "signed")
        self.redirects = _Watched(self, "redirects")
        self.chunked = _Watched(self, "chunked")
        self._save()
        open(self._hits_path, "w").close()
        self._proc = subprocess.Popen([sys.executable, os.path.abspath(__file__), root, self._config.path,
                                       self._hits_path, port_file])
        deadline = time.time() + 20
        while not os.path.exists(port_file) or not open(port_file).read().strip():
            if time.time() > deadline or self._proc.poll() is not None:
                raise RuntimeError("the test file server did not start")
            time.sleep(0.05)
        self.port = int(open(port_file).read())
        self.base = f"http://127.0.0.1:{self.port}"

    def _save(self) -> None:
        self._config.save({"signed": dict(getattr(self, "signed", {})),
                           "redirects": dict(getattr(self, "redirects", {})),
                           "chunked": dict(getattr(self, "chunked", {}))})

    @property
    def hits(self) -> list[str]:
        with open(self._hits_path) as handle:
            return [line.rstrip("\n") for line in handle if line.strip()]

    def url(self, name: str, host: str = "127.0.0.1") -> str:
        sig = self.signed.get(name)
        query = f"?X-Amz-Expires=3600&sig={sig}" if sig else ""
        return f"http://{host}:{self.port}/{name}{query}"

    def close(self) -> None:
        self._proc.terminate()
        try:
            self._proc.wait(5)
        except Exception:
            self._proc.kill()


def _serve_main(argv: list[str]) -> None:
    root, config_path, hits_path, port_file = argv
    from port_list import free_ports, no_free_port_error
    for port in free_ports():
        try:
            httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), _make_handler(root, _Config(config_path), hits_path))
            break
        except OSError:
            continue
    else:
        raise no_free_port_error()
    httpd.daemon_threads = True
    with open(port_file + ".tmp", "w") as handle:
        handle.write(str(httpd.server_address[1]))
    os.replace(port_file + ".tmp", port_file)
    httpd.serve_forever()


def write_bigwig(path: str, chrom: str = "chr19", size: int = 60_000_000) -> None:
    import pyBigWig
    bw = pyBigWig.open(path, "w")
    bw.addHeader([(chrom, size)])
    bw.addEntries([chrom, chrom], [47_514_000, 47_516_000], ends=[47_515_000, 47_517_000], values=[2.0, 5.0])
    bw.close()


if __name__ == "__main__":
    import sys
    _serve_main(sys.argv[1:])
