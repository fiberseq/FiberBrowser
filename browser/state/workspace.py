"""Independent workspaces: more than one isolated session from one local launch.

``/?workspace=new`` (or ``POST /api/workspaces``) starts a workspace: a fresh
``BrowserState`` with no datasets or tracks that starts from the server's
loaded reference (genome, FASTA, annotations) and owns copies of it, so
loading another genome there leaves the other tabs alone. The page is then
served at ``/?workspace=<ws-id>``; that tab names its workspace on every
request (the frontend's tab channel, ``frontend/src/utils/sandbox.ts``) and
sees only its own state. It runs with the owner's full local rules (it is not
a tour sandbox), and dies after ``FIBERBROWSER_WORKSPACE_TTL`` seconds unused
(default 12 hours), when its tab ends it, or with the server.

Refused on ``--public`` servers, where every visitor already has an isolated
session. On a lab server a workspace belongs to the member who started it
(only through ``POST /api/workspaces``, never by loading a page): only they
list it, use it or end it.
"""
from __future__ import annotations

import os
import re
import secrets
from typing import Optional

from state.sandbox import SANDBOX_EXPIRED_HEADER, SandboxManager

EXPIRED_MESSAGE = ("This workspace has ended (the server restarted, or it was unused for a long time). "
                   "Close the tab; your other tabs are unchanged.")
_ID_RE = re.compile(r"^ws-[A-Za-z0-9_-]{16,64}$")


def valid_workspace_id(value: object) -> bool:
    return isinstance(value, str) and bool(_ID_RE.match(value))


class WorkspaceManager(SandboxManager):
    """Workspaces: like sandboxes (forked state, own reference copies, idle GC)
    but longer-lived, and without public-mode rules."""

    def __init__(self, template, *, max_workspaces: Optional[int] = None, idle_ttl: Optional[int] = None,
                 gc_interval: int = 300):
        self.owners: dict[str, Optional[str]] = {}
        super().__init__(template,
                         max_sandboxes=max_workspaces or int(os.environ.get("FIBERBROWSER_MAX_WORKSPACES", "8")),
                         idle_ttl=idle_ttl or int(os.environ.get("FIBERBROWSER_WORKSPACE_TTL", str(12 * 3600))),
                         gc_interval=gc_interval)

    @staticmethod
    def _new_sid() -> str:
        return "ws-" + secrets.token_urlsafe(18)

    def create(self, owner: Optional[str] = None) -> str:
        """A new workspace (``owner``: the lab member it belongs to). At the cap,
        idle-expired ones are dropped, but a live workspace is someone's analysis
        and is never evicted."""
        from state.session_manager import SessionsFull
        with self._lock:
            self._drop_expired()
            if len(self.sessions) >= self.max_sessions:
                raise SessionsFull(
                    f"This server already has {self.max_sessions} workspaces open. Close one (the "
                    "button in its banner) or raise FIBERBROWSER_MAX_WORKSPACES.")
            workspace_id = super().create()
            self.owners[workspace_id] = owner
            return workspace_id

    def owner_of(self, workspace_id: str) -> Optional[str]:
        with self._lock:
            return self.owners.get(workspace_id)

    def owned_by(self, owner: Optional[str]) -> list[str]:
        with self._lock:
            return sorted(w for w in self.sessions if self.owners.get(w) == owner)

    def drop(self, sandbox_id: str) -> bool:
        with self._lock:
            self.owners.pop(sandbox_id, None)
        return super().drop(sandbox_id)


_manager: Optional[WorkspaceManager] = None


def set_workspace_manager(manager: Optional[WorkspaceManager]) -> None:
    global _manager
    _manager = manager


def get_workspace_manager() -> Optional[WorkspaceManager]:
    return _manager


def request_owner() -> Optional[str]:
    """Whose workspaces this request may see: the lab member (None off the lab profile)."""
    from services.runtime import current_lab_user
    user = current_lab_user()
    return user.name if user is not None else None


def may_use(manager: Optional[WorkspaceManager], workspace_id: str) -> bool:
    """This request may use/see ``workspace_id``: always off the lab profile; on a lab
    server only the member who started it (never an anonymous visitor)."""
    from services.runtime import get_lab_mode
    if not get_lab_mode():
        return True
    owner = request_owner()
    return manager is not None and owner is not None and manager.owner_of(workspace_id) == owner


async def handle_workspace_request(request, call_next, workspace_id: str):
    """Run a request that names a workspace in that workspace (sandbox middleware)."""
    from fastapi.responses import JSONResponse
    from services.runtime import get_host_public_mode, workspace_context

    if get_host_public_mode():
        return JSONResponse(status_code=403, content={
            "success": False, "message": "Workspaces aren't available on a public server."})
    if not valid_workspace_id(workspace_id):
        return JSONResponse(status_code=400, content={"success": False, "message": "Malformed workspace id."})
    manager = get_workspace_manager()
    if request.url.path.startswith("/api/") and (
            manager is None or not may_use(manager, workspace_id) or manager.get(workspace_id) is None):
        # Another member's workspace looks exactly like an ended one.
        return JSONResponse(status_code=410, headers={SANDBOX_EXPIRED_HEADER: "1"}, content={
            "success": False, "sandbox_expired": True, "message": EXPIRED_MESSAGE})
    with workspace_context(workspace_id):
        return await call_next(request)
