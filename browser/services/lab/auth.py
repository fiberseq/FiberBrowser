"""Who is making a lab-server request, and may they?

Installed at import time in ``server.py`` (outside the sandbox/workspace and
public-mode middleware, so they see its decision); a no-op unless the lab
profile is active. For each request it:

1. identifies the member, by ``auth.mode``:
   ``accounts``  the sign-in cookie (``fiberbrowser_lab``) of a built-in account;
   ``proxy``     the configured user header (``X-Forwarded-User``), believed
                 only when the TCP peer is one of ``auth.trusted_proxies``;
   ``none``      every request is ``auth.user`` (an admin): for a server that is
                 only reachable through an authenticating proxy such as Open
                 OnDemand, which also hands the browser this launch's access
                 token (``services/local_auth.py``) so other users of the
                 cluster can't reach it directly.
2. without a member: an anonymous visitor of the public catalog (public-mode
   rules) when ``public_catalog.enabled``, else a redirect to the sign-in page
   (pages) or 401 (API);
3. refuses cross-site state changes (CSRF): a POST/PUT/PATCH/DELETE needs the
   ``X-FiberBrowser-CSRF`` header matching the CSRF cookie, or a same-origin
   ``Sec-Fetch-Site``/``Origin``. The same-origin exception is deliberate:
   the headless figure renderer acts for a member with a short-lived render
   token and no CSRF cookie, and in proxy/none modes the CSRF cookie only
   arrives with the first response. Browsers set ``Sec-Fetch-Site`` and
   ``Origin`` themselves (a page can't forge them), so this is the standard
   Fetch-Metadata defence, not a weaker one. Every method, OPTIONS included,
   is authenticated; only a CORS preflight from a configured
   FIBERBROWSER_CORS_ORIGINS origin (which carries no credentials) is not.
   The complete list of exceptions (sign-in pages, static files, the health
   check, those preflights, the launch-token header) is in
   docs/deployment/index.md ("What needs sign-in");
4. applies the lab route policy (denied everywhere / admin only), the upload
   size limit and data-root confinement of request paths (``paths``);
5. writes the audit events of uploads, runs and shared sessions.
"""
from __future__ import annotations

import hmac
import secrets
import threading
import time
from typing import Optional
from urllib.parse import quote, urlparse

from services.lab.logins import COOKIE, CSRF_COOKIE
from services.lab.users import LabUser

CSRF_HEADER = "x-fiberbrowser-csrf"
UNSAFE = frozenset({"POST", "PUT", "PATCH", "DELETE"})

# Routes no lab request may use: native dialogs and windows on the server's
# screen, stopping the server, host-driven Jupyter/linked-view state (one
# per process, not per member).
LAB_DENIED: frozenset[tuple[str, str]] = frozenset({
    ("GET", "/api/pick_file"), ("GET", "/api/pick_folder"), ("GET", "/api/pick_file_primer"),
    ("POST", "/api/datasets/drop_window"), ("POST", "/api/new-window"),
    ("POST", "/api/library/entries/{entry_id}/reveal"),  # a file manager on the server's screen
    ("POST", "/api/quit"), ("GET", "/api/shutdown"), ("POST", "/api/shutdown"),
    ("POST", "/api/nl/setup"), ("POST", "/api/nl/download"), ("POST", "/api/nl/set_backend"),
    ("POST", "/api/nl/share_send"), ("POST", "/api/nl/share_clear"), ("POST", "/api/nl/share_reveal"),
    ("GET", "/api/nl/share_status"), ("GET", "/api/nl/share_upload_status"), ("POST", "/api/nl/log_session"),
    ("POST", "/api/nl/feedback"),
    # Connect to cluster: SSH as the server's own account (services/remote_endpoint.py)
    ("GET", "/api/remote/sources"), ("POST", "/api/remote/connect"), ("POST", "/api/remote/disconnect"),
    ("GET", "/api/remote/list"), ("POST", "/api/remote/refs_status"),
})
# /api/app/: the server's own app settings, FiberHMM choice and update check (the host's, never a member's).
LAB_DENIED_PREFIXES: tuple[str, ...] = ("/api/jupyter/", "/api/linked/", "/api/app/")
# Copilot routes when the server's Copilot is off (the default on servers).
COPILOT_ALLOWED_WHEN_OFF = frozenset({("GET", "/api/nl/capabilities")})
LAB_ADMIN_ONLY: frozenset[tuple[str, str]] = frozenset({
    ("POST", "/api/s3/configure"), ("GET", "/admin"),
    # The graph package table is one per server, shared by every member (routers/graph_panel.py).
    ("POST", "/api/graph/registrations"), ("DELETE", "/api/graph/registrations/{registration_id}"),
})
LAB_ADMIN_PREFIXES: tuple[str, ...] = ("/api/admin/",)
# Pages and forms of the sign-in flow: open to everyone.
OPEN_PATHS = frozenset({"/auth/login", "/auth/logout", "/auth/invite", "/favicon.ico"})

DENIED_MESSAGE = "This action is not available on a shared lab server."
ADMIN_MESSAGE = "Only lab admins can do this."
SIGNIN_MESSAGE = "Sign in to this FiberBrowser lab server first."
CSRF_MESSAGE = "Refused a cross-site request (missing or wrong CSRF token). Reload the page and try again."

# Audit events of member actions: (method, route template) -> event name.
AUDITED_ROUTES: dict[tuple[str, str], str] = {
    ("POST", "/api/files/upload"): "upload",
    ("POST", "/api/pipeline/jobs"): "run_submit",
    ("POST", "/api/pipeline/jobs/{job_id}/cancel"): "run_cancel",
    ("POST", "/api/pipeline/jobs/{job_id}/retry"): "run_retry",
    ("DELETE", "/api/pipeline/jobs/{job_id}"): "run_forget",
    ("POST", "/api/footprint/consensus/jobs"): "footprint_run",
    ("POST", "/api/footprint/consensus/jobs/{job_id}/bam-export"): "bam_export",
    ("POST", "/api/footprint/derived_layers/export"): "layers_export",
    ("POST", "/api/footprint/rules/save"): "rules_save",
    ("POST", "/api/lab/sessions"): "session_save",
    ("DELETE", "/api/lab/sessions/{session_id}"): "session_delete",
}


# ---------------------------------------------------------------------------
# Rate limiting of sign-in attempts
# ---------------------------------------------------------------------------

class LoginLimiter:
    """Failed sign-ins per user name and per client address, with lockout."""

    def __init__(self, max_failures: int, lockout_s: float):
        self.max_failures = max_failures
        self.lockout_s = lockout_s
        self._fails: dict[str, list[float]] = {}
        self._locked_until: dict[str, float] = {}
        self._lock = threading.Lock()

    def _limit(self, key: str) -> int:
        # An address may try several names (a shared NAT); a name gets max_failures.
        return self.max_failures * 5 if key.startswith("ip:") else self.max_failures

    def locked(self, *keys: str) -> float:
        """Seconds until the longest lock among keys ends (0: not locked)."""
        now = time.time()
        with self._lock:
            return max([self._locked_until.get(k, 0) - now for k in keys] + [0.0])

    def fail(self, *keys: str) -> bool:
        """Record a failure; True when it (newly) locks one of the keys."""
        now = time.time()
        window = max(self.lockout_s, 60.0)
        locked = False
        with self._lock:
            for key in keys:
                recent = [t for t in self._fails.get(key, []) if now - t < window]
                recent.append(now)
                self._fails[key] = recent
                if len(recent) >= self._limit(key) and self._locked_until.get(key, 0) <= now:
                    self._locked_until[key] = now + self.lockout_s
                    locked = True
        return locked

    def succeed(self, *keys: str) -> None:
        with self._lock:
            for key in keys:
                self._fails.pop(key, None)
                self._locked_until.pop(key, None)


_limiter: Optional[LoginLimiter] = None


def reset_rate_limits() -> None:
    global _limiter
    _limiter = None


def limiter() -> LoginLimiter:
    global _limiter
    if _limiter is None:
        from services.lab import get_config
        cfg = get_config()
        max_fail = cfg.auth.max_failed_logins if cfg else 5
        lockout = (cfg.auth.lockout_minutes if cfg else 15) * 60
        _limiter = LoginLimiter(max_fail, lockout)
    return _limiter


# ---------------------------------------------------------------------------
# Request helpers
# ---------------------------------------------------------------------------

def _peer(request) -> str:
    client = request.client
    return client.host if client else ""


def peer_is_trusted(request) -> bool:
    """The TCP peer is a trusted proxy (services/public_protection.py keeps the one
    list: this config's auth.trusted_proxies, --trusted-proxy, FIBERBROWSER_TRUSTED_PROXIES)."""
    from services.lab import get_config
    from services.public_protection import is_trusted_proxy
    peer = _peer(request)
    if get_config() is None or not peer:
        return False
    return is_trusted_proxy(peer)


def client_ip(request) -> str:
    """The browser's address: from X-Forwarded-For when the peer is a trusted proxy
    (the rightmost hop that isn't one), else the peer."""
    from services.public_protection import client_address
    return client_address(request.scope)


def cookies_secure(request) -> bool:
    from services.lab import get_config
    from state.dependencies import _is_https
    cfg = get_config()
    mode = cfg.auth.secure_cookies if cfg else "auto"
    if mode == "always":
        return True
    if mode == "never":
        return False
    return _is_https(request) or bool(cfg and cfg.public_url.startswith("https://"))


def _origin_ok(request) -> bool:
    """A same-origin request by the browser's own account (Fetch Metadata or Origin)."""
    site = (request.headers.get("sec-fetch-site") or "").lower()
    if site == "same-origin":
        return True
    if site in ("cross-site", "same-site"):
        return False
    origin = (request.headers.get("origin") or "").rstrip("/")
    if not origin or origin == "null":
        return False
    from services.lab import get_config
    cfg = get_config()
    if cfg and cfg.public_url and origin == urlparse(cfg.public_url)._replace(path="").geturl().rstrip("/"):
        return True
    hosts = [request.headers.get("host") or ""]
    from services.request_origin_guard import forwarded_headers_believed
    if forwarded_headers_believed(_peer(request)) and request.headers.get("x-forwarded-host"):
        hosts.append(request.headers["x-forwarded-host"].split(",")[0].strip())
    parsed = urlparse(origin)
    return any(parsed.netloc.lower() == h.lower() for h in hosts if h)


def csrf_ok(request, expected: Optional[str]) -> bool:
    if request.method not in UNSAFE:
        return True
    header = request.headers.get(CSRF_HEADER)
    if header and expected and hmac.compare_digest(header.encode(), expected.encode()):
        return True
    return _origin_ok(request)


def _cors_preflight(request) -> bool:
    """A CORS preflight from an origin FIBERBROWSER_CORS_ORIGINS allows (it carries no
    credentials, so it can't be authenticated). Any other OPTIONS request is
    authenticated like every other method."""
    if request.method != "OPTIONS" or not request.headers.get("access-control-request-method"):
        return False
    from services.request_origin_guard import cors_origins
    origin = (request.headers.get("origin") or "").rstrip("/")
    return bool(origin) and origin in cors_origins()


def _wants_html(request) -> bool:
    return request.method in ("GET", "HEAD") and not request.url.path.startswith("/api/") \
        and "text/html" in (request.headers.get("accept") or "")


# ---------------------------------------------------------------------------
# The headless figure renderer acts for the member who asked for the figure
# ---------------------------------------------------------------------------

RENDER_PARAM = "fb_render"
RENDER_COOKIE = "fiberbrowser_render"
_RENDER_TTL_S = 900.0
_render_tokens: dict[str, tuple[LabUser, float]] = {}
_render_lock = threading.Lock()


def with_render_identity(url: str) -> str:
    """``url`` for the render worker's browser, carrying a short-lived token
    that makes its requests the current member's (unchanged off the lab profile)."""
    from services.runtime import current_lab_user, get_lab_mode
    user = current_lab_user()
    if not get_lab_mode() or user is None:
        return url
    token = secrets.token_urlsafe(24)
    now = time.time()
    with _render_lock:
        for key in [k for k, (_, exp) in _render_tokens.items() if exp <= now]:
            del _render_tokens[key]
        _render_tokens[token] = (user, now + _RENDER_TTL_S)
    return url + ("&" if "?" in url else "?") + f"{RENDER_PARAM}={token}"


def _render_user(request) -> tuple[Optional[LabUser], bool]:
    """(member, came in the query) for a render worker's request."""
    token = request.query_params.get(RENDER_PARAM)
    from_query = bool(token)
    token = token or request.cookies.get(RENDER_COOKIE)
    if not token:
        return None, False
    with _render_lock:
        entry = _render_tokens.get(token)
    if entry is None or entry[1] <= time.time():
        return None, False
    return entry[0], from_query


# ---------------------------------------------------------------------------
# Identification
# ---------------------------------------------------------------------------

def users_file():
    from services.lab import get_config
    from services.lab.users import UsersFile
    return UsersFile(get_config().users_file)


def identify(request) -> tuple[Optional[LabUser], Optional[str], Optional[str]]:
    """(member, csrf token expected for this browser, sign-in token) of a request."""
    from services.lab import get_config
    cfg = get_config()
    mode = cfg.auth.mode
    csrf_cookie = request.cookies.get(CSRF_COOKIE)
    if mode == "none":
        import getpass
        name = cfg.auth.user or getpass.getuser()
        return LabUser(name=name, role="admin", source="none"), csrf_cookie, None
    if mode == "proxy":
        if not peer_is_trusted(request):
            return None, csrf_cookie, None
        raw = (request.headers.get(cfg.auth.proxy_header) or "").strip()
        from services.lab.users import UserError, normalize_name
        try:
            name = normalize_name(raw)
        except UserError:
            return None, csrf_cookie, None
        if cfg.auth.allowed_users and name not in {u.lower() for u in cfg.auth.allowed_users}:
            return None, csrf_cookie, None
        role = "admin" if name in {u.lower() for u in cfg.auth.admins} else "member"
        # An account in the users file may carry the role instead.
        account = users_file().get(name) if users_file().exists() else None
        if account is not None and account.is_admin:
            role = "admin"
        return LabUser(name=name, role=role, source="proxy"), csrf_cookie, None
    # accounts
    from services.lab.logins import get_store
    token = request.cookies.get(COOKIE)
    login = get_store().get(token)
    if login is None:
        return None, None, None
    accounts = users_file()
    account = accounts.get(login.user)
    if account is None or accounts.generation(login.user) != login.generation:
        get_store().delete(token)
        return None, None, None
    return account, login.csrf, token


def policy_refusal(app, request, user: LabUser) -> Optional[tuple[int, str]]:
    """(status, message) when the route policy refuses this member's request."""
    from services.lab import get_config
    from services.public_mode_guard import route_template
    path = request.url.path
    method = "GET" if request.method == "HEAD" else request.method
    if path.startswith(LAB_DENIED_PREFIXES):
        return 403, DENIED_MESSAGE
    template = route_template(app, request.scope) or path
    key = (method, template)
    if key in LAB_DENIED:
        return 403, DENIED_MESSAGE
    if template.startswith("/api/nl/") and not get_config().copilot and key not in COPILOT_ALLOWED_WHEN_OFF:
        return 403, "Copilot is turned off on this server."
    if (key in LAB_ADMIN_ONLY or path.startswith(LAB_ADMIN_PREFIXES)) and not user.is_admin:
        return 403, ADMIN_MESSAGE
    return None


# ---------------------------------------------------------------------------
# Middleware
# ---------------------------------------------------------------------------

def install_lab_auth(app) -> None:
    from fastapi.responses import JSONResponse, RedirectResponse

    from services.lab import get_config
    from services.runtime import get_lab_mode, lab_request_context

    def refuse(status: int, message: str, **extra):
        return JSONResponse(status_code=status, content={"success": False, "detail": message,
                                                          "message": message, **extra})

    from services.lab.paths import PathDenied

    @app.exception_handler(PathDenied)
    async def path_denied(_request, exc):  # a file operation refused a path (lab/paths.py)
        return refuse(403, str(exc))

    @app.middleware("http")
    async def lab_auth(request, call_next):
        if not get_lab_mode():
            return await call_next(request)
        cfg = get_config()
        path = request.url.path
        if _cors_preflight(request) or path in OPEN_PATHS or \
                (path.startswith("/assets/") and request.method in ("GET", "HEAD")):
            return await call_next(request)

        render_user, render_from_query = _render_user(request)
        if render_user is not None:
            user, expected_csrf = render_user, None
        else:
            user, expected_csrf, _token = identify(request)
        if user is None:
            if cfg.public_catalog.enabled:
                with lab_request_context(anonymous=True):
                    return await call_next(request)
            from services.root_path import url_for_path
            if _wants_html(request):
                target = path + (("?" + request.url.query) if request.url.query else "")
                return RedirectResponse(url_for_path("/auth/login") + "?next=" + quote(target, safe=""),
                                        status_code=303)
            if cfg.auth.mode == "proxy" and not peer_is_trusted(request):
                return refuse(401, "This server accepts requests only through the lab's sign-in proxy.")
            return refuse(401, SIGNIN_MESSAGE, signin=url_for_path("/auth/login"))

        # Scripts that present the launch token in a header (auth = none behind
        # OnDemand) can't be cross-site: a browser never adds that header itself.
        header_token = request.headers.get("x-fiberbrowser-token")
        if not (header_token and cfg.auth.mode == "none") and not csrf_ok(request, expected_csrf):
            return refuse(403, CSRF_MESSAGE)

        refusal = policy_refusal(app, request, user)
        if refusal:
            return refuse(*refusal)

        if path == "/api/files/upload" and cfg.limits.upload_max_mb:
            length = request.headers.get("content-length")
            if length and length.isdigit() and int(length) > cfg.limits.upload_max_mb * 1024 * 1024:
                return refuse(413, f"Uploads are limited to {cfg.limits.upload_max_mb} MB on this server; "
                                   "put large files in a lab data folder and open them from there.")

        from services.lab import paths as lab_paths
        problem = lab_paths.scan_query(request.scope.get("query_string", b"").decode("latin-1"))
        content_type = request.headers.get("content-type")
        if problem is None and request.method not in ("GET", "HEAD") and \
                lab_paths.body_kind(content_type) != "multipart":
            # Every body a route could read (whatever its Content-Type says);
            # refused when it can't be checked completely (lab/paths.py).
            length = request.headers.get("content-length") or ""
            if length.isdigit() and int(length) > lab_paths.MAX_SCAN_BYTES:
                problem = lab_paths.TOO_LARGE_MESSAGE
            else:
                problem = lab_paths.scan_body(await request.body(), content_type)
        if problem:
            status = 413 if problem == lab_paths.TOO_LARGE_MESSAGE else \
                400 if problem == lab_paths.UNREADABLE_MESSAGE else 403
            return refuse(status, problem)

        with lab_request_context(user=user):
            response = await call_next(request)

        if request.method in UNSAFE:
            from services.public_mode_guard import route_template
            event = AUDITED_ROUTES.get((request.method, route_template(app, request.scope) or path))
            if event:
                from services.lab.audit import audit
                fields = {"route": path, "status": response.status_code}
                if event == "upload":
                    fields["bytes"] = request.headers.get("content-length")
                audit(event, user=user.name, ip=client_ip(request), **fields)

        if render_from_query:
            from services.root_path import cookie_path
            response.set_cookie(RENDER_COOKIE, request.query_params[RENDER_PARAM], httponly=True,
                                secure=cookies_secure(request), samesite="strict", path=cookie_path(),
                                max_age=int(_RENDER_TTL_S))
        if cfg.auth.mode != "accounts" and not request.cookies.get(CSRF_COOKIE):
            # Double-submit token for proxy / none modes (accounts mode sets it at sign-in).
            from services.root_path import cookie_path
            response.set_cookie(CSRF_COOKIE, secrets.token_urlsafe(24), httponly=False, samesite="strict",
                                secure=cookies_secure(request), path=cookie_path())
        return response
