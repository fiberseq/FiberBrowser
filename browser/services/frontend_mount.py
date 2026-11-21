"""Frontend asset discovery and FastAPI route mounting."""
from __future__ import annotations

import json
import os

from urllib.parse import parse_qsl, urlencode

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles


def find_frontend_dist(script_dir: str) -> str | None:
    """Return the built frontend dist directory if it exists.

    ``FIBERBROWSER_FRONTEND_DIST`` names another build (a test or demo build made
    outside the checkout, so a running server's own dist is never rebuilt under it)."""
    override = os.environ.get('FIBERBROWSER_FRONTEND_DIST')
    if override and os.path.exists(os.path.join(override, 'index.html')):
        return os.path.abspath(override)
    possible_frontend_dirs = (
        os.path.join(script_dir, 'frontend', 'dist'),
        os.path.join(script_dir, '..', 'frontend', 'dist'),
    )
    for candidate in possible_frontend_dirs:
        resolved = os.path.abspath(candidate)
        if os.path.exists(os.path.join(resolved, 'index.html')):
            return resolved
    return None


def mount_frontend(app: FastAPI, script_dir: str, public_mode: bool) -> str | None:
    """Mount the Vite-built frontend and return its dist directory."""
    frontend_dir = find_frontend_dist(script_dir)
    if not frontend_dir:
        return None

    index_path = os.path.join(frontend_dir, 'index.html')

    def current_index_response(request: Request | None = None) -> HTMLResponse:
        # Vite asset names are content-hashed. Read the entrypoint for every
        # navigation so a production rebuild cannot leave a long-running
        # FiberBrowser process pointing at deleted/stale asset names.
        with open(index_path, 'r') as handle:
            index_html = handle.read()

        # Served under a URL prefix (services/root_path.py): asset links and
        # the app's own requests go through the prefix.
        from services.root_path import get_root_path
        root = get_root_path()
        index_html = index_html.replace('="./assets/', '="/assets/')
        if root:
            index_html = index_html.replace('="/assets/', f'="{root}/assets/')

        # Inject public-mode flag synchronously so the frontend knows before
        # any effects run; this avoids a race with the /api/status fetch.
        flags = []
        if root:
            flags.append(f'window.__FIBERBROWSER_ROOT__ = {json.dumps(root)};')
        if request is not None and 'token' in request.query_params:
            # Opened with the access link (services/local_auth.py): the cookie
            # is set by now; keep the token out of the address bar and history
            # before the app reads the URL.
            flags.append("(function(){try{var u=new URL(window.location.href);u.searchParams.delete('token');"
                         "window.history.replaceState(window.history.state,'',u.pathname+u.search+u.hash);}"
                         "catch(e){}})();")
        from services.runtime import current_workspace_id, get_visitor_public_mode
        # A --public server, or an anonymous visitor of a lab server's catalog.
        visitor_public = public_mode or get_visitor_public_mode()
        workspace_id = None if visitor_public else current_workspace_id()
        if visitor_public:
            flags.append('window.__FIBERHMM_PUBLIC__ = true;')
        elif workspace_id:
            # An independent workspace (state/workspace.py): its own session,
            # the owner's full local UI.
            from state.workspace import get_workspace_manager, may_use
            manager = get_workspace_manager()
            alive = manager is not None and may_use(manager, workspace_id) and manager.get(workspace_id) is not None
            flags.append(f'window.__FIBERBROWSER_SANDBOX__ = {json.dumps(workspace_id)};')
            flags.append('window.__FIBERBROWSER_WORKSPACE__ = true;')
            if not alive:
                flags.append('window.__FIBERBROWSER_SANDBOX_EXPIRED__ = true;')
        else:
            # A tour tab (sandbox): public-mode UI, and the sandbox it belongs
            # to (the id was validated by the sandbox middleware).
            from services.runtime import current_sandbox_id
            from state.sandbox import get_sandbox_manager
            sandbox_id = current_sandbox_id()
            if sandbox_id:
                manager = get_sandbox_manager()
                alive = manager is not None and manager.get(sandbox_id) is not None
                flags.append('window.__FIBERHMM_PUBLIC__ = true;')
                flags.append(f'window.__FIBERBROWSER_SANDBOX__ = {json.dumps(sandbox_id)};')
                if not alive:
                    flags.append('window.__FIBERBROWSER_SANDBOX_EXPIRED__ = true;')
        from services.runtime import copilot_included, get_lab_mode
        if not copilot_included():
            # FiberBrowser.app leaves the Copilot out: the page hides it (before any script runs).
            flags.append('window.__FIBERBROWSER_NO_COPILOT__ = true;')
        if get_lab_mode():
            # Lab server: who is signed in (or a sign-in link), in a small bar.
            from services.lab.pages import index_flags, index_body_snippet
            flags.extend(index_flags())
            index_html = index_html.replace('</body>', index_body_snippet() + '\n  </body>', 1)
        if flags:
            index_html = index_html.replace(
                '<head>',
                '<head>\n    <script>' + ' '.join(flags) + '</script>',
                1,
            )
        headers = {'Cache-Control': 'no-cache'}
        if public_mode:
            # Content-Security-Policy: the page's own inline scripts (these
            # flags, the dark-mode switch) run by a per-response nonce;
            # nothing else inline does.
            import secrets
            from services.public_redaction import public_csp
            nonce = secrets.token_urlsafe(16)
            index_html = index_html.replace('<script>', f'<script nonce="{nonce}">')
            headers['Content-Security-Policy'] = public_csp(nonce)
        return HTMLResponse(index_html, headers=headers)

    assets_dir = os.path.join(frontend_dir, 'assets')
    if os.path.exists(assets_dir):
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    favicon = os.path.join(assets_dir, 'icons', 'favicon.ico')

    @app.get("/favicon.ico", include_in_schema=False)
    async def favicon_ico():
        # Browsers ask for /favicon.ico on their own; the page links /assets/icons/.
        if not os.path.isfile(favicon):
            raise HTTPException(status_code=404)
        return FileResponse(favicon, media_type="image/x-icon")

    def establish_session(request: Request) -> None:
        # In session mode, the page itself mints (or refreshes) the visitor's
        # session, so its cookie arrives with the HTML before the app fires its
        # first, concurrent API requests. Otherwise each of those would mint a
        # session of its own and the last Set-Cookie would switch the visitor
        # to another one (losing, e.g., quality filters set meanwhile).
        from state.dependencies import get_state
        try:
            get_state(request)
        except HTTPException:
            pass  # at the visitor limit: the page loads, its API calls report it

    def new_workspace_redirect(request: Request):
        """``/?workspace=new``: start an independent workspace and open it."""
        from services.runtime import get_public_mode
        from state.workspace import get_workspace_manager
        manager = get_workspace_manager()
        if public_mode or get_public_mode() or manager is None:
            raise HTTPException(status_code=403, detail="Workspaces aren't available on this server.")
        from services.runtime import get_lab_mode
        if get_lab_mode():
            # A page load never creates state on a shared server: the app's
            # "New Independent Workspace" button starts one (POST /api/workspaces).
            raise HTTPException(status_code=405, detail=(
                "On a lab server, start a workspace with New Independent Workspace in the app's File panel."))
        from state.session_manager import SessionsFull
        try:
            workspace_id = manager.create()
        except SessionsFull as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        query = [(k, v) for k, v in parse_qsl(request.url.query, keep_blank_values=True)
                 if k not in ('workspace', 'token', 'sandbox')]
        query.append(('workspace', workspace_id))
        from services.root_path import url_for_path
        return RedirectResponse(f"{url_for_path(request.url.path)}?{urlencode(query)}", status_code=303)

    @app.get("/", response_class=HTMLResponse)
    async def root(request: Request):
        if request.query_params.get('workspace') == 'new':
            return new_workspace_redirect(request)
        establish_session(request)
        return current_index_response(request)

    @app.get("/dafc", response_class=HTMLResponse)
    async def dafc_route(request: Request):
        establish_session(request)
        return current_index_response(request)

    return frontend_dir
