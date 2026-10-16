"""``fiberbrowser://open?session=...`` links: hand them to a FiberBrowser server.

Another web page can offer a "Open in FiberBrowser" link in the
``fiberbrowser:`` scheme::

    fiberbrowser://open?session=https%3A%2F%2Fdata.example.org%2Fs12.json
    fiberbrowser://open?hub=https%3A%2F%2Fdata.example.org%2Fhub.txt&genome=hg38

The operating system passes it to FiberBrowser: the Mac app registers the
scheme (CFBundleURLTypes, handled in ``fiberbrowser.desktop``); elsewhere
``fiberbrowser --open-link <URL>`` does the same (see
docs/workflows/open-from-links.md for the Linux ``x-scheme-handler`` and
Windows registry entries). Either way this module only **stages** the link on
a server of this user (with its access token from
``~/.fiberhmm/browser_runtime.json``) and opens ``/?open_link=<id>``, where
the user is asked to confirm; nothing is fetched or loaded before that. A web
page therefore can't drive the app: it can only put a question in front of
the user.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path
from typing import Optional, Sequence
from urllib.parse import parse_qsl, urlencode, urlsplit

SCHEME = "fiberbrowser"
MAX_LINK_CHARS = 512 * 1024
START_TIMEOUT_S = 120.0


class OpenLinkError(ValueError):
    """A fiberbrowser: link that can't be handled; the message is for the user."""


def parse_open_url(url: str) -> dict:
    """``{"session"|"hub": value, "genome": ...}`` from ``fiberbrowser://open?...``."""
    if not isinstance(url, str) or len(url) > MAX_LINK_CHARS:
        raise OpenLinkError("The link is too long.")
    parts = urlsplit(url.strip())
    if parts.scheme.lower() != SCHEME:
        raise OpenLinkError(f"Not a {SCHEME}: link.")
    action = (parts.netloc or parts.path.strip("/").split("/", 1)[0]).lower()
    if action != "open":
        raise OpenLinkError(f"Unknown {SCHEME}: action {action or '(none)'!r}; use {SCHEME}://open?session=<URL>.")
    params = dict(parse_qsl(parts.query, keep_blank_values=False))
    link: dict = {}
    if params.get("hub"):
        link["hub"] = params["hub"]
    elif params.get("session") or params.get("sessionURL"):
        link["session"] = params.get("session") or params["sessionURL"]
    else:
        raise OpenLinkError("The link names no session (?session=) or hub (?hub=).")
    if params.get("genome"):
        link["genome"] = params["genome"]
    return link


# ---------------------------------------------------------------------------- servers

def runtime_file() -> Path:
    return Path(os.environ.get("FIBERBROWSER_RUNTIME_FILE",
                               str(Path.home() / ".fiberhmm" / "browser_runtime.json"))).expanduser()


def _pid_alive(pid) -> bool:
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    if sys.platform == "win32":
        import ctypes
        handle = ctypes.windll.kernel32.OpenProcess(0x00100000, False, pid)
        if not handle:
            return False
        ctypes.windll.kernel32.CloseHandle(handle)
        return True
    try:
        os.kill(pid, 0)
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def running_servers(path: Optional[Path] = None) -> list[dict]:
    """This user's running servers (newest first): ``{"url", "token", "pid", ...}``."""
    try:
        data = json.loads((path or runtime_file()).read_text())
    except (OSError, ValueError):
        return []
    servers = [s for s in (data.get("servers") or {}).values()
               if isinstance(s, dict) and s.get("url") and _pid_alive(s.get("pid"))]
    return sorted(servers, key=lambda s: s.get("started") or 0, reverse=True)


def _base(server_url: str) -> str:
    parts = urlsplit(server_url)
    return f"{parts.scheme}://{parts.netloc}{parts.path.rstrip('/')}"


def stage_on_server(server: dict, link: dict, timeout: float = 10.0) -> str:
    """Stage ``link`` on ``server`` (with its token); returns the pending id."""
    body = json.dumps({**link, "origin": "app"}).encode()
    headers = {"Content-Type": "application/json"}
    if server.get("token"):
        headers["X-FiberBrowser-Token"] = server["token"]
    request = urllib.request.Request(_base(server["url"]) + "/api/session-links", data=body, headers=headers,
                                     method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            reply = json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as exc:
        try:
            reply = json.loads(exc.read() or b"{}")
        except ValueError:
            reply = {}
        raise OpenLinkError(reply.get("error") or f"FiberBrowser refused the link (HTTP {exc.code}).") from exc
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise OpenLinkError(f"FiberBrowser at {_base(server['url'])} did not answer: {exc}") from exc
    if not reply.get("success") or not reply.get("id"):
        raise OpenLinkError(reply.get("error") or "FiberBrowser refused the link.")
    return str(reply["id"])


def review_url(server: dict, link_id: str) -> str:
    """Where the user confirms: the server's page with the pending id (and its token)."""
    query = {"open_link": link_id}
    if server.get("token"):
        query["token"] = server["token"]
    return f"{_base(server['url'])}/?{urlencode(query)}"


def start_server(argv: Sequence[str] = (), timeout: float = START_TIMEOUT_S) -> dict:
    """Start a FiberBrowser server in the background and wait until it is listed."""
    before = {s.get("pid") for s in running_servers()}
    cmd = [sys.executable, "-m", "fiberbrowser", *argv, "--no-open-browser"]
    kwargs: dict = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
    if sys.platform == "win32":
        kwargs["creationflags"] = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True
    env = dict(os.environ, FIBERBROWSER_NO_OPEN="1")
    subprocess.Popen(cmd, env=env, **kwargs)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        for server in running_servers():
            if server.get("pid") not in before:
                return server
        time.sleep(0.5)
    raise OpenLinkError("FiberBrowser did not start in time.")


def forward(url: str, *, open_page=webbrowser.open, start=start_server) -> str:
    """Stage a ``fiberbrowser:`` link on a running server (else a new one) and open
    its confirmation page. Returns the page's address."""
    link = parse_open_url(url)
    servers = running_servers()
    server = servers[0] if servers else start()
    link_id = stage_on_server(server, link)
    page = review_url(server, link_id)
    open_page(page)
    return page


def main(argv: Sequence[str]) -> int:
    """``fiberbrowser --open-link <fiberbrowser://open?...>``."""
    urls = [a for a in argv if a.lower().startswith(f"{SCHEME}:")]
    if not urls:
        print(f"usage: fiberbrowser --open-link '{SCHEME}://open?session=<URL>'", file=sys.stderr)
        return 2
    try:
        forward(urls[0])
    except OpenLinkError as exc:
        print(f"FiberBrowser: {exc}", file=sys.stderr)
        return 1
    return 0
