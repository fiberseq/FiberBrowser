"""FastAPI dependency injection providers for state singletons.

Usage in routers:
    from state import get_state, get_dafc_state, get_jupyter_state

    @router.get("/api/example")
    async def example(state = Depends(get_state)):
        ...

The actual state objects are stored in server.py (the global singletons).
These functions bridge the gap so that extracted routers can use Depends()
instead of accessing module-level globals directly.

In ``--public`` / ``--catalog`` mode ``get_state`` becomes session-aware:
each HTTP client gets a forked ``BrowserState`` keyed by a ``fiberhmm_sid``
cookie, managed by ``server.session_manager``. In non-public mode the
session manager is disabled and ``get_state`` returns the module-global
template for backward-compat single-user usage.

A sandbox request (a tour tab, see ``state/sandbox.py``) gets its sandbox's
own forked state instead, whatever the mode.
"""
from fastapi import Request, Response

from state.runtime_state import (
    get_browser_state,
    get_dafc_runtime_state,
    get_jupyter_runtime_state,
    get_session_manager,
)

_SESSION_COOKIE = 'fiberhmm_sid'


def _is_https(request: Request) -> bool:
    if request.url.scheme == 'https':
        return True
    # X-Forwarded-Proto only from a peer whose forwarded headers are believed
    # (lab and --public servers: a trusted proxy; services/request_origin_guard.py).
    from services.request_origin_guard import forwarded_headers_believed
    client = getattr(request, 'client', None)
    if not forwarded_headers_believed(client.host if client else ""):
        return False
    return request.headers.get('x-forwarded-proto', '').split(',')[0].strip().lower() == 'https'


def install_session_cookie_middleware(app) -> None:
    """Set/refresh the session cookie on every response of a session request."""

    @app.middleware("http")
    async def session_cookie_middleware(request, call_next):
        response = await call_next(request)
        sid = getattr(request.state, "fiberbrowser_sid", None)
        sm = get_session_manager()
        if sid and sm is not None and sm.enabled:
            # samesite=lax lets the cookie survive top-level navigations (reload,
            # link clicks); httponly keeps it out of JS in case the page is ever
            # XSS'd — the frontend doesn't need to read the cookie, just send it.
            from services.root_path import cookie_path
            from services.lab.auth import cookies_secure  # a lab server's cookie policy, else HTTPS
            response.set_cookie(_SESSION_COOKIE, sid, httponly=True, samesite='lax',
                                secure=cookies_secure(request), max_age=sm.idle_ttl, path=cookie_path())
        return response


def get_state(request: Request = None, response: Response = None):
    """Return the BrowserState for this request.

    A request carrying ``panel_genome=<key>`` (a panel on another assembly than the
    main genome) gets the state with that reference in place of the main one
    (services/panel_genomes.genome_view); 404 for a reference not loaded.
    """
    state = _session_state(request, response)
    key = request.query_params.get('panel_genome') if request is not None else None
    if not key and request is not None:
        key = _reads_dataset_genome(request, state)
    if not key:
        return state
    from services.panel_genomes import GenomeUnavailable, genome_view
    try:
        return genome_view(state, key)
    except GenomeUnavailable:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail=f"Reference not loaded: {key}")


def _reads_dataset_genome(request: Request, state):
    """A read or coverage request for one dataset with a reference of its own:
    that reference (its chromosome lengths and topology bound the reads)."""
    path = request.url.path
    if '/api/reads/' not in path and not path.endswith('/api/coverage'):
        return None
    dataset_id = request.query_params.get('dataset_id')
    if not dataset_id or ',' in dataset_id:
        return None
    from services.panel_genomes import dataset_genome
    try:
        return dataset_genome(state, dataset_id)
    except Exception:
        return None


def _session_state(request: Request = None, response: Response = None):
    """The BrowserState of this request's session (workspace, sandbox, lab member, visitor).

    When session isolation is enabled, reads/creates a session from
    ``server.session_manager`` using the ``fiberhmm_sid`` cookie and sets
    the cookie on the response if a new session was minted. Otherwise
    returns the global template (preserves single-user behavior).
    """
    from services.runtime import current_sandbox_id, current_workspace_id
    workspace_id = current_workspace_id()
    if workspace_id is not None:
        from state.workspace import EXPIRED_MESSAGE as WS_EXPIRED, get_workspace_manager, may_use
        from state.sandbox import SANDBOX_EXPIRED_HEADER
        manager = get_workspace_manager()
        # A lab server: only the member who started it (another's looks ended).
        workspace = manager.get(workspace_id) if manager is not None and may_use(manager, workspace_id) else None
        if workspace is None:
            from fastapi import HTTPException
            raise HTTPException(status_code=410, detail=WS_EXPIRED, headers={SANDBOX_EXPIRED_HEADER: "1"})
        return workspace
    sandbox_id = current_sandbox_id()
    if sandbox_id is not None:
        from state.sandbox import EXPIRED_MESSAGE, SANDBOX_EXPIRED_HEADER, get_sandbox_manager
        manager = get_sandbox_manager()
        sandbox = manager.get(sandbox_id) if manager is not None else None
        if sandbox is None:
            from fastapi import HTTPException
            raise HTTPException(status_code=410, detail=EXPIRED_MESSAGE, headers={SANDBOX_EXPIRED_HEADER: "1"})
        return sandbox

    from services.runtime import current_lab_user, get_lab_mode
    if get_lab_mode():
        # A lab member works in their own state (services/lab/members.py);
        # anonymous catalog visitors fall through to the visitor sessions.
        user = current_lab_user()
        from services.lab.members import get_member_manager
        manager = get_member_manager()
        if user is not None and manager is not None:
            from state.session_manager import SessionsFull
            try:
                return manager.for_user(user.name)
            except SessionsFull as exc:
                from fastapi import HTTPException
                raise HTTPException(status_code=503, detail=str(exc)) from exc

    sm = get_session_manager()
    if sm is None or not sm.enabled or request is None:
        return get_browser_state()

    sid = request.cookies.get(_SESSION_COOKIE)
    from state.session_manager import SessionsFull
    # The client address public_protection resolved (trusted proxies honoured).
    owner = (request.scope.get("state") or {}).get("fiberbrowser_client")
    try:
        state, sid, _created = sm.get_or_create(sid, owner=owner)
    except SessionsFull as exc:
        from fastapi import HTTPException
        raise HTTPException(status_code=exc.status_code, detail=str(exc),
                            headers={"Retry-After": str(exc.retry_after)}) from exc
    # The cookie is (re)set on the way out by session_cookie_middleware, so
    # it reaches the browser even from routes that return a Response
    # themselves, and stays valid while the visitor is active.
    request.state.fiberbrowser_sid = sid
    return state


def get_dafc_state():
    """The DAFCState (contact map) of this request.

    A lab member has their own (services/lab/members.py), so a map one member
    loads is never shown to another member or to the lab's anonymous catalog
    visitors, who see only the server's own published map. Elsewhere DAF-C is a
    single host-side map shared by the process (a --public server's visitors
    can't load one).
    """
    from services.runtime import current_lab_user, get_lab_mode
    if get_lab_mode():
        user = current_lab_user()
        if user is not None:
            from services.lab.members import get_member_manager
            manager = get_member_manager()
            if manager is None:
                from fastapi import HTTPException
                raise HTTPException(status_code=503, detail="Member states aren't set up on this server.")
            return manager.dafc_for_user(user.name)
    return get_dafc_runtime_state()


def get_jupyter_state():
    """Get the global JupyterState instance.

    Jupyter integration is host-driven (the local Jupyter client pushes
    state into the same process). Stays globally shared.
    """
    return get_jupyter_runtime_state()
