"""Remote files from links, read by htslib and pyBigWig under the link policy.

htslib (BAMs) and pyBigWig (bigWig/bigBed) read remote files with libcurl,
which resolves the host name itself on every connection and follows
redirects wherever they lead. Checking a link's URL first and then handing
it to them leaves a gap: the name can resolve to another address by the time
they connect (DNS rebinding), and a redirect can lead into a private network.

So where the link policy restricts addresses or hosts
(``link_fetch.needs_pinned_transport``: public and lab servers, and local
servers with a host allowlist), a link's file is handed to the native reader
as a URL of a small relay on 127.0.0.1 instead::

    http://127.0.0.1:<port>/<random token>/<file name>

The relay forwards each request (GET or HEAD, with its ``Range``) through
``link_fetch.open_pinned``: the host is resolved once per request, every
address is checked against the policy, the connection goes to the checked
address, and every redirect is checked again. The reply's status, length and
range headers are passed back and its body streamed. Nothing else is
reachable through it: a token names one file, and the only other names it
answers are plain file names in the same folder of the same host (a FASTA's
``.fai`` next to it, a FIRE decorators file next to its fibers file), which
go through the same checks. Tokens are random (144 bits) and live as long as
the server (a dataset or track may read its file at any time); the relay
never logs its request lines.

The relay is its own process (``python -m services.link_proxy``, started on
first use, ended with the server or when its stdin closes): pyBigWig holds
the GIL while it waits for the network, so a relay thread in the server
process would never get to answer. Routes are registered over its stdin
(one JSON line each, acknowledged before the reader opens the URL).

Residual risk: ``s3://`` and ``ssh://`` files are not relayed (links on
public and lab servers can't name them; local servers open them as before),
and a local server without a host allowlist hands URLs to the native readers
directly (its policy allows any address). Each relayed request opens its own
upstream connection (one TLS handshake per range read).
"""
from __future__ import annotations

import json
import os
import re
import secrets
import subprocess
import sys
import threading
from dataclasses import asdict
from typing import Optional
from urllib.parse import unquote, urljoin, urlsplit

from services import signed_urls
from services.link_fetch import LinkPolicy

_SAFE_NAME = re.compile(r"[A-Za-z0-9._\-]{1,200}")
_START_TIMEOUT_S = 10.0
_RETRY_AFTER_S = 60.0  # after a failed start, files fail at once for this long


def _file_name(url: str) -> str:
    name = urlsplit(signed_urls.display_url(url)).path.rsplit("/", 1)[-1]
    name = re.sub(r"[^A-Za-z0-9._\-]+", "_", unquote(name)).strip("._") or "file"
    return name[:200]


# ---------------------------------------------------------------------------- the relay process

def _serve(stdin, stdout) -> None:
    import http.client
    import http.server

    from services.link_fetch import LinkError, open_pinned

    passed = ("Content-Length", "Content-Range", "Accept-Ranges", "Content-Type", "Last-Modified", "ETag")
    forwarded = ("Range", "If-Range", "If-Modified-Since", "If-None-Match")
    routes: dict[str, tuple[str, LinkPolicy]] = {}
    lock = threading.Lock()

    def target(token: str, name: str) -> Optional[tuple[str, LinkPolicy]]:
        with lock:
            route = routes.get(token)
        if route is None or not _SAFE_NAME.fullmatch(name) or name in (".", ".."):
            return None
        url, policy = route
        if name == _file_name(url):
            return url, policy
        # A plain file name in the same folder (no query: a signature is for one file).
        return urljoin(urljoin(signed_urls.display_url(url), "."), name), policy

    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "FiberBrowser-link-relay"

        def log_message(self, *args):  # request lines carry tokens: never logged
            pass

        def _refuse(self, status: int, message: str) -> None:
            body = message.encode("utf-8", "replace")
            self.send_response(status)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _relay(self) -> None:
            parts = self.path.split("?", 1)[0].lstrip("/").split("/")
            found = target(parts[0], parts[1]) if len(parts) == 2 else None
            if found is None:
                self._refuse(404, "not found")
                return
            url, policy = found
            headers = {k: self.headers[k] for k in forwarded if self.headers.get(k)}
            try:
                response, conn, _final = open_pinned(url, policy, method=self.command, headers=headers, what="file")
            except LinkError as exc:
                self._refuse(502, signed_urls.redact_text(str(exc)))
                return
            try:
                self.send_response(response.status)
                length = response.getheader("Content-Length")
                for key in passed:
                    value = response.getheader(key)
                    if value:
                        self.send_header(key, value)
                if self.command == "HEAD":
                    self.end_headers()
                    return
                if not length:
                    self.send_header("Connection", "close")  # the body ends when the connection does
                    self.close_connection = True
                self.end_headers()
                while True:
                    chunk = response.read(256 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
            except (OSError, http.client.HTTPException):
                # The reader moved on (a seek, a closed file) or the host stopped answering.
                self.close_connection = True
            finally:
                conn.close()

        do_GET = _relay
        do_HEAD = _relay

    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    stdout.write(f"PORT {httpd.server_address[1]}\n")
    stdout.flush()
    for line in stdin:  # route registrations; EOF: the server is gone
        try:
            message = json.loads(line)
            policy = message["policy"]
            policy["allowed_hosts"] = tuple(policy.get("allowed_hosts") or ())
            with lock:
                routes[str(message["token"])] = (str(message["url"]), LinkPolicy(**policy))
            stdout.write(f"OK {message['token']}\n")
        except (ValueError, KeyError, TypeError):
            stdout.write("ERROR\n")
        stdout.flush()
    httpd.shutdown()


def main() -> None:
    _serve(sys.stdin, sys.stdout)


# ---------------------------------------------------------------------------- the server's side

_lock = threading.Lock()
_process: Optional[subprocess.Popen] = None
_port: Optional[int] = None
_failed_at: float = 0.0


class RelayError(RuntimeError):
    """The relay could not be started or would not take the file."""


def _start_locked() -> None:
    global _process, _port, _failed_at
    import atexit
    import time

    if time.monotonic() - _failed_at < _RETRY_AFTER_S:
        raise RelayError("the link relay could not be started (see the server's setup)")

    import services
    browser_dir = os.path.dirname(os.path.dirname(os.path.abspath(services.__file__)))
    env = dict(os.environ)
    env["PYTHONPATH"] = browser_dir + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    env["PYTHONUNBUFFERED"] = "1"
    process = subprocess.Popen([sys.executable, "-m", "services.link_proxy"], stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, cwd=browser_dir,
                               text=True, bufsize=1)
    line = _read_line(process, _START_TIMEOUT_S)
    if not line.startswith("PORT "):
        process.kill()
        _failed_at = time.monotonic()
        raise RelayError("the link relay could not be started (see the server's setup)")
    _process, _port = process, int(line.split()[1])
    atexit.register(_stop)


def _read_line(process: subprocess.Popen, timeout: float) -> str:
    box: list[str] = []
    reader = threading.Thread(target=lambda: box.append(process.stdout.readline()), daemon=True)
    reader.start()
    reader.join(timeout)
    return box[0].strip() if box else ""


def _stop() -> None:
    global _process
    process, _process = _process, None
    if process is not None and process.poll() is None:
        try:
            process.stdin.close()
            process.wait(3)
        except Exception:
            process.kill()


def relay_url(url: str, policy: LinkPolicy) -> str:
    """The loopback URL a native reader opens for ``url`` under ``policy``."""
    token = secrets.token_urlsafe(18)
    message = json.dumps({"token": token, "url": url, "policy": asdict(policy)}) + "\n"
    with _lock:
        for attempt in (0, 1):
            if _process is None or _process.poll() is not None:
                _start_locked()
            try:
                _process.stdin.write(message)
                _process.stdin.flush()
                if _read_line(_process, 10.0) == f"OK {token}":
                    break
            except (OSError, ValueError):
                pass
            _stop()  # a broken relay: start a new one and register again
        else:
            raise RelayError("the link relay did not accept the file")
        port = _port
    # Registered files show their own display form (signed_urls.register(open_url=...));
    # any other relay address (a sibling .fai, a FIRE decorators file) shows as link-relay:/<name>.
    signed_urls.register_pattern("link-relay", rf"http://127\.0\.0\.1:{port}/[A-Za-z0-9_\-]{{24}}/",
                                 "link-relay:/")
    return f"http://127.0.0.1:{port}/{token}/{_file_name(url)}"


def is_relay_url(url) -> bool:
    return isinstance(url, str) and _port is not None and url.startswith(f"http://127.0.0.1:{_port}/")


def transport_url(url: str, policy: LinkPolicy) -> str:
    """What a native reader opens for a link's ``url``: the relay URL where the
    policy needs the pinned transport, else ``url`` itself."""
    from services.link_fetch import needs_pinned_transport
    if needs_pinned_transport(policy) and isinstance(url, str) and url.lower().startswith(("http://", "https://")):
        return relay_url(url, policy)
    return url


if __name__ == "__main__":
    main()
