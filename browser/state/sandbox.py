"""Sandbox sessions: a tour tab that can never change the user's work.

A sandbox is a public-mode visitor session inside a local (non-public)
server. The main tab keeps using the server's state; a tab opened with
``?sandbox=<id>`` gets its own forked ``BrowserState`` (copy-on-write for the
shared reference, starting with no datasets or tracks), and every request it
makes runs under public-mode rules: the route allowlist, the in-route checks,
and the frontend's public UI (no Quit, no host files, no host-only features).
The demo dataset is the one extra it may load (SANDBOX_EXTRA_ALLOWED).

Requests name their sandbox by the ``X-FiberBrowser-Sandbox`` header (fetch /
XHR), a ``sandbox=`` query parameter (EventSource, beacons, opened windows),
or, for plain ``<img>`` / link requests, the ``sandbox=`` parameter of the page
in their ``Referer``.

On a ``--public`` server sandboxes are refused: every visitor there already
has an isolated session, and the demo isn't offered.
"""
from __future__ import annotations

import re
import secrets
import time
from typing import Optional
from urllib.parse import parse_qs, urlparse

from state.session_manager import SessionManager

SANDBOX_HEADER = "x-fiberbrowser-sandbox"
SANDBOX_PARAM = "sandbox"
# An independent workspace (state/workspace.py) uses the same channel: the
# tab's header or ``sandbox=`` parameter carries its ``ws-`` id, and the
# address bar shows it as ``workspace=<id>``.
WORKSPACE_PARAM = "workspace"
# On a 410 for an ended sandbox, so the tab can tell it from any other 410.
SANDBOX_EXPIRED_HEADER = "X-FiberBrowser-Sandbox-Expired"
EXPIRED_MESSAGE = "This tour tab has expired. Close it and start the tour again."
_ID_RE = re.compile(r"^sb-[A-Za-z0-9_-]{16,64}$")

# Routes a sandbox may use beyond the public allowlist.
SANDBOX_EXTRA_ALLOWED: frozenset[tuple[str, str]] = frozenset({
    ("GET", "/api/demo"), ("POST", "/api/demo/load"),
    # The tour's insert-expanded panel: the route itself allows only a bundled demo's insertion.
    ("POST", "/api/alt_allele/open"),
    ("GET", "/api/sandbox/{sandbox_id}"), ("DELETE", "/api/sandbox/{sandbox_id}"),
})


def valid_sandbox_id(value: object) -> bool:
    return isinstance(value, str) and bool(_ID_RE.match(value))


def sandbox_id_from_scope(scope) -> Optional[str]:
    """The sandbox a request names (header, query, then the page's Referer), or None.

    A malformed id is returned as-is so the middleware can refuse it rather than
    silently treating the request as the main tab's.
    """
    headers = {name.decode("latin-1").lower(): value.decode("latin-1") for name, value in scope.get("headers") or []}
    value = headers.get(SANDBOX_HEADER)
    if value:
        return value.strip()
    query = parse_qs((scope.get("query_string") or b"").decode("latin-1"))
    for param in (SANDBOX_PARAM, WORKSPACE_PARAM):
        if query.get(param):
            value = query[param][0].strip()
            if param == WORKSPACE_PARAM and value == "new":
                continue  # a request to create one (the page route handles it)
            return value
    referer = headers.get("referer")
    if referer:
        ref = urlparse(referer)
        host = headers.get("host", "")
        if ref.netloc == host:  # only this server's own pages
            ref_query = parse_qs(ref.query)
            for param in (SANDBOX_PARAM, WORKSPACE_PARAM):
                if ref_query.get(param) and ref_query[param][0].strip() != "new":
                    return ref_query[param][0].strip()
    return None


class SandboxManager(SessionManager):
    """Sandbox sessions: a few at a time, dropped after idle_ttl or when the tab ends them.

    A SessionManager (same idle GC and disposal) whose ids are minted by
    create() and never by a request: an unknown id is an expired tab, not a
    new visitor.
    """

    def __init__(self, template, *, max_sandboxes: int = 4, idle_ttl: int = 1800, gc_interval: int = 60):
        super().__init__(template, enabled=True, idle_ttl=idle_ttl, gc_interval=gc_interval,
                         max_sessions=max_sandboxes)

    @staticmethod
    def _new_sid() -> str:
        return "sb-" + secrets.token_urlsafe(18)

    def get_or_create(self, sid):  # pragma: no cover - requests never mint sandboxes
        raise NotImplementedError("Sandboxes are created with create()")

    def create(self) -> str:
        from state.browser_state import BrowserState
        with self._lock:
            self._drop_expired()
            while len(self.sessions) >= self.max_sessions:
                # A new tour tab means an older one was most likely abandoned.
                self.drop(min(self.last_access, key=self.last_access.get))
            sandbox_id = self._new_sid()
            self.sessions[sandbox_id] = BrowserState.fork_for_session(
                self.template, copy_shared=True, include_data=False)
            self.last_access[sandbox_id] = time.time()
            return sandbox_id

    def get(self, sandbox_id: str):
        with self._lock:
            self._drop_expired()
            state = self.sessions.get(sandbox_id)
            if state is not None:
                self.last_access[sandbox_id] = time.time()
            return state

    def drop(self, sandbox_id: str) -> bool:
        with self._lock:
            state = self.sessions.get(sandbox_id)
        if state is None:
            return False
        super().drop(sandbox_id)  # caches, consensus runs and their files
        # Its own FASTA handle (copy-on-write); never the template's.
        own_fasta = state.__dict__.get('fasta')
        if own_fasta is not None and own_fasta is not getattr(self.template, 'fasta', None):
            try:
                own_fasta.close()
            except Exception:
                pass
        return True

    def _drop_expired(self) -> None:
        now = time.time()
        for sandbox_id in [s for s, last in self.last_access.items() if now - last > self.idle_ttl]:
            self.drop(sandbox_id)


_manager: Optional[SandboxManager] = None


def set_sandbox_manager(manager: Optional[SandboxManager]) -> None:
    global _manager
    _manager = manager


def get_sandbox_manager() -> Optional[SandboxManager]:
    return _manager


def install_sandbox_middleware(app) -> None:
    """Mark sandbox requests (outermost, so the public-mode guard sees them).

    Call AFTER install_public_mode_guard: Starlette runs the last-added
    middleware first.
    """
    from fastapi.responses import JSONResponse
    from services.runtime import get_host_public_mode, sandbox_context

    @app.middleware("http")
    async def sandbox_middleware(request, call_next):
        sandbox_id = sandbox_id_from_scope(request.scope)
        if not sandbox_id:
            return await call_next(request)
        if sandbox_id.startswith("ws-"):
            from state.workspace import handle_workspace_request
            return await handle_workspace_request(request, call_next, sandbox_id)
        if get_host_public_mode():
            return JSONResponse(status_code=403, content={
                "success": False, "message": "Sandboxes aren't available on a public server."})
        if not valid_sandbox_id(sandbox_id):
            return JSONResponse(status_code=400, content={"success": False, "message": "Malformed sandbox id."})
        manager = get_sandbox_manager()
        path = request.url.path
        is_api = path.startswith("/api/")
        if is_api and (manager is None or manager.get(sandbox_id) is None):
            return JSONResponse(status_code=410, headers={SANDBOX_EXPIRED_HEADER: "1"}, content={
                "success": False, "sandbox_expired": True, "message": EXPIRED_MESSAGE})
        with sandbox_context(sandbox_id):
            return await call_next(request)
