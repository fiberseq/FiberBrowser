"""Per-launch access token for a local FiberBrowser (Jupyter-style).

A local server listens on 127.0.0.1, which every account on a shared machine
(a login or compute node, a lab workstation) can reach, and ``--host 0.0.0.0``
opens it to the network. The API can read the owner's files, list folders,
write exports, start processes and stop the server, so every request must
prove it comes from the owner:

- each launch makes a random token (or takes ``FIBERBROWSER_TOKEN``);
- the launchers open ``http://localhost:<port>/?token=<token>`` for you, and
  the first request carrying the token sets an HttpOnly, SameSite=Strict
  cookie (``fiberbrowser_token_<port>``), so the app and every later request
  of that browser are authorised; the page removes the token from the
  address bar;
- scripts send the token in the ``X-FiberBrowser-Token`` header (or
  ``Authorization: Token <token>``, or a ``token`` query parameter).
  ``browser_client.BrowserClient`` finds it by itself in
  ``~/.fiberhmm/browser_runtime.json`` (mode 0600), which lists this user's
  running servers.

Unauthorised requests get 401 (a short HTML page for page loads). Static
assets are served without it. On a ``--public`` server visitors are anonymous
by design, so no token is required there (the public-mode route allowlist
applies instead). ``--no-token`` turns the check off (single-user machines
only).
"""
from __future__ import annotations

import hmac
import json
import os
import secrets
import sys
import time
from pathlib import Path
from typing import Callable, Optional
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

TOKEN_HEADER = "x-fiberbrowser-token"
TOKEN_PARAM = "token"
COOKIE_PREFIX = "fiberbrowser_token"

_token: str = os.environ.get("FIBERBROWSER_TOKEN") or secrets.token_urlsafe(32)
_enabled: bool = True
_port: Optional[int] = None


def configure_local_auth(*, enabled: bool = True, token: Optional[str] = None,
                         port: Optional[int] = None) -> str:
    """Set this launch's token (explicit, FIBERBROWSER_TOKEN, or a new random one)."""
    global _token, _enabled, _port
    _enabled = bool(enabled)
    _port = port
    _token = token or os.environ.get("FIBERBROWSER_TOKEN") or secrets.token_urlsafe(32)
    return _token


def get_token() -> str:
    return _token


def auth_enabled() -> bool:
    return _enabled


def cookie_name() -> str:
    # Cookies are not port-scoped: two servers on localhost (a second launch,
    # /api/new-window) must not overwrite each other's cookie.
    return f"{COOKIE_PREFIX}_{_port}" if _port else COOKIE_PREFIX


def auth_headers() -> dict[str, str]:
    """Headers for a request this process makes to its own server."""
    return {"X-FiberBrowser-Token": _token} if _enabled else {}


def tokened_url(url: str, token: Optional[str] = None) -> str:
    """``url`` with ``?token=`` added (unchanged when the check is off)."""
    if not _enabled and token is None:
        return url
    token = token or _token
    parts = urlsplit(url)
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if k != TOKEN_PARAM]
    query.append((TOKEN_PARAM, token))
    return urlunsplit((parts.scheme, parts.netloc, parts.path or "/", urlencode(query), parts.fragment))


def _matches(candidate: Optional[str]) -> bool:
    return bool(candidate) and hmac.compare_digest(str(candidate).encode(), _token.encode())


def credential_source(headers, query_string: str, cookies) -> Optional[str]:
    """How a request proves itself: 'header', 'query', 'cookie', or None."""
    if _matches(headers.get(TOKEN_HEADER)):
        return "header"
    authorization = headers.get("authorization") or ""
    scheme, _, value = authorization.partition(" ")
    if scheme.lower() in ("token", "bearer") and _matches(value.strip()):
        return "header"
    for key, value in parse_qsl(query_string or "", keep_blank_values=True):
        if key == TOKEN_PARAM and _matches(value):
            return "query"
    if _matches(cookies.get(cookie_name())):
        return "cookie"
    return None


# Public static files besides /assets/: the icon browsers request on their own.
# The web app manifest and its icons are under /assets/ (browsers fetch a
# manifest without cookies, so an installed app could not load them otherwise).
# /open is the session-link landing page: a link from another site arrives
# without the SameSite=Strict cookie; the page only stores the link as a
# pending one (nothing is fetched or loaded) and goes on to the signed-in app,
# which asks the user to confirm (services/session_links.py).
_EXEMPT_FILES = frozenset({"/favicon.ico", "/open"})
_LINK_QUERY_KEYS = ("session=", "sessionURL=", "hub=")


def _exempt(path: str, method: str) -> bool:
    if method == "OPTIONS":
        return True  # CORS preflights carry no credentials; the real request is checked
    if method not in ("GET", "HEAD"):
        return False
    return path.startswith("/assets/") or path in _EXEMPT_FILES


UNAUTHORIZED_MESSAGE = (
    "This FiberBrowser needs its access link. Open the link printed in the terminal where "
    "FiberBrowser started (it ends in ?token=...), or start it again with the launcher. "
    "Scripts: send the X-FiberBrowser-Token header (browser_client finds it automatically)."
)

_UNAUTHORIZED_PAGE = """<!doctype html><html><head><meta charset="utf-8"><title>FiberBrowser: access link needed</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:40em;margin:4em auto;padding:0 1em;color:#1f2937}
code{background:#f3f4f6;padding:.1em .3em;border-radius:3px}</style></head><body>
<h1>Open FiberBrowser with its access link</h1>
<p>This FiberBrowser only answers its owner. Use the link printed in the terminal where it
started (it ends in <code>?token=&hellip;</code>); the launchers open it for you.</p>
<p>The link changes every time FiberBrowser starts. Your running servers and their links are
also listed in <code>~/.fiberhmm/browser_runtime.json</code>.</p>
<p><b>Installed FiberBrowser as an app from Chrome or Edge?</b> Start FiberBrowser (it opens its
link, which also reconnects the installed app), then reload this window; or paste the link here:</p>
<form id="f"><input id="l" size="48" placeholder="http://localhost:8000/?token=..." autocomplete="off">
<button>Open</button></form>
<script>document.getElementById('f').onsubmit=function(e){e.preventDefault();var v=document.getElementById('l').value.trim();
try{var t=v.indexOf('token=')>=0?new URL(v,location.href).searchParams.get('token'):v;
var k=new URLSearchParams(location.search).get('open_link');
if(t){location.href=location.pathname+'?token='+encodeURIComponent(t)+(k?'&open_link='+encodeURIComponent(k):'');}}catch(x){}};</script>
</body></html>"""


# A form POST of the token (``token`` field) sets the cookie and opens the app,
# so a portal's "Connect" button (Open OnDemand's view.html.erb) never puts the
# token in a URL, the address bar or the history.
TOKEN_SIGNIN_PATH = "/auth/token"


async def _token_signin(request):
    from fastapi.responses import HTMLResponse, RedirectResponse

    from services.root_path import cookie_path, url_for_path
    try:
        form = await request.form()
    except Exception:
        form = {}
    if not _matches(str(form.get(TOKEN_PARAM) or "")):
        return HTMLResponse(_UNAUTHORIZED_PAGE, status_code=401)
    response = RedirectResponse(url_for_path("/"), status_code=303)
    response.set_cookie(cookie_name(), _token, httponly=True, samesite="strict",
                        secure=_cookie_secure(request), path=cookie_path())
    return response


def _cookie_secure(request) -> bool:
    """The Secure flag of the token cookie: a lab server's ``auth.secure_cookies``
    policy (with its HTTPS ``public_url``), else whether this request came over HTTPS."""
    from services.lab.auth import cookies_secure
    return cookies_secure(request)


def install_local_auth(app, is_host_public: Callable[[], bool]) -> None:
    """Require the token (header, query or cookie) on every request of a local server."""
    from fastapi.responses import HTMLResponse, JSONResponse

    @app.middleware("http")
    async def local_auth(request, call_next):
        if not _enabled or is_host_public():
            return await call_next(request)
        path = request.url.path
        if _exempt(path, request.method):
            return await call_next(request)
        if path == TOKEN_SIGNIN_PATH and request.method == "POST":
            return await _token_signin(request)
        source = credential_source(request.headers, request.scope.get("query_string", b"").decode("latin-1"),
                                   request.cookies)
        if source is None:
            query = request.scope.get("query_string", b"").decode("latin-1")
            if path == "/" and request.method in ("GET", "HEAD") and any(
                    part.startswith(_LINK_QUERY_KEYS) for part in query.split("&")):
                # A session link to the app itself (?session=, ?hub=): the landing page.
                from fastapi.responses import RedirectResponse

                from services.root_path import url_for_path
                return RedirectResponse(f"{url_for_path('/open')}?{query}", status_code=303,
                                        headers={"Referrer-Policy": "no-referrer", "Cache-Control": "no-store"})
            wants_html = not path.startswith("/api/") and "text/html" in (request.headers.get("accept") or "")
            if wants_html:
                return HTMLResponse(_UNAUTHORIZED_PAGE, status_code=401)
            return JSONResponse(status_code=401, content={"success": False, "detail": UNAUTHORIZED_MESSAGE,
                                                          "message": UNAUTHORIZED_MESSAGE})
        response = await call_next(request)
        if source == "query":
            # A browser that opened the access link: later requests use the cookie.
            from services.root_path import cookie_path
            response.set_cookie(cookie_name(), _token, httponly=True, samesite="strict",
                                secure=_cookie_secure(request), path=cookie_path())
        return response


# --- ~/.fiberhmm/browser_runtime.json --------------------------------------------

def runtime_file() -> Path:
    return Path(os.environ.get("FIBERBROWSER_RUNTIME_FILE",
                               str(Path.home() / ".fiberhmm" / "browser_runtime.json"))).expanduser()


def _read_runtime(path: Path) -> dict:
    try:
        data = json.loads(path.read_text())
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_runtime(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w") as handle:
            json.dump(data, handle, indent=1)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink()


def pid_alive(pid) -> bool:
    """Whether a process exists, without signalling it.

    On Windows ``os.kill(pid, 0)`` would TerminateProcess the target, so the
    probe opens a SYNCHRONIZE handle instead.
    """
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    if sys.platform == "win32":
        import ctypes
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
        if not handle:
            return False
        kernel32.CloseHandle(handle)
        return True
    try:
        os.kill(pid, 0)
    except PermissionError:
        return True  # exists, owned by someone else
    except OSError:
        return False
    return True


_pid_alive = pid_alive


def record_running_server(port: int, url: str, *, host: str = "127.0.0.1") -> None:
    """List this server (URL, token, pid) in the runtime file, readable by this user only."""
    path = runtime_file()
    data = _read_runtime(path)
    servers = {k: v for k, v in (data.get("servers") or {}).items()
               if isinstance(v, dict) and _pid_alive(v.get("pid")) and v.get("pid") != os.getpid()}
    servers[str(port)] = {"url": url, "token": _token if _enabled else None, "pid": os.getpid(),
                          "host": host, "started": time.time()}
    _write_runtime(path, {"servers": servers})
    global _recorded_port
    _recorded_port = port


_recorded_port: Optional[int] = None


def forget_recorded_server() -> None:
    """Remove this process's runtime-file entry (at shutdown; safe to call twice)."""
    global _recorded_port
    if _recorded_port is not None:
        forget_running_server(_recorded_port)
        _recorded_port = None


def forget_running_server(port: int) -> None:
    path = runtime_file()
    data = _read_runtime(path)
    servers = data.get("servers") or {}
    entry = servers.get(str(port))
    if isinstance(entry, dict) and entry.get("pid") == os.getpid():
        servers.pop(str(port), None)
        try:
            _write_runtime(path, {"servers": servers})
        except OSError:
            pass
