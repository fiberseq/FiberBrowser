"""Each lab member's own working state.

Members share the data and the stores, not a viewport: every member gets a
``BrowserState`` forked from the server's reference (copy-on-write, so one
member loading another genome leaves everyone else's alone), keyed by user
name, so all of a member's tabs and devices see the same session. Idle states
are dropped after ``FIBERBROWSER_LAB_STATE_TTL`` seconds (default 24 hours);
the member's next request starts a fresh one (their datasets are one click
away in the shared Library, and saved sessions stay on the lab shelf).
A member's contact map (DAF-C) is theirs too (:meth:`MemberStateManager.dafc_for_user`).
"""
from __future__ import annotations

import os
import time
from typing import Optional

from state.sandbox import SandboxManager
from state.session_manager import SessionsFull


class MemberStateManager(SandboxManager):
    """Per-member states: created on first use, never evicted while in use."""

    def __init__(self, template, *, max_members: int = 64, idle_ttl: Optional[int] = None, gc_interval: int = 300):
        self._dafc: dict = {}
        super().__init__(template, max_sandboxes=max_members,
                         idle_ttl=idle_ttl or int(os.environ.get("FIBERBROWSER_LAB_STATE_TTL", str(24 * 3600))),
                         gc_interval=gc_interval)

    @staticmethod
    def _key(user: str) -> str:
        return "member:" + user

    def for_user(self, user: str):
        from state.browser_state import BrowserState
        key = self._key(user)
        with self._lock:
            state = self.sessions.get(key)
            now = time.time()
            if state is not None:
                self.last_access[key] = now
                return state
            self._drop_expired()
            if len(self.sessions) >= self.max_sessions:
                raise SessionsFull("The server is at its limit of active members (limits.max_users); "
                                   "try again later or ask an admin to raise it.")
            state = BrowserState.fork_for_session(self.template, copy_shared=True, include_data=True)
            self.sessions[key] = state
            self.last_access[key] = now
            return state

    def drop_user(self, user: str) -> bool:
        return self.drop(self._key(user))

    def drop(self, sandbox_id: str) -> bool:
        with self._lock:
            self._dafc.pop(sandbox_id, None)
        return super().drop(sandbox_id)

    def dafc_for_user(self, user: str):
        """The member's own contact-map (DAF-C) state: starts as the server's
        published map (``--cool`` / the config), and a map the member loads
        replaces only theirs. Anonymous catalog visitors keep the server's."""
        from state.runtime_state import get_dafc_runtime_state
        key = self._key(user)
        with self._lock:
            state = self._dafc.get(key)
            if state is None:
                state = fork_dafc_state(get_dafc_runtime_state())
                self._dafc[key] = state
            return state

    def members(self) -> list[dict]:
        with self._lock:
            return [{"user": key.split(":", 1)[1], "last_active": last}
                    for key, last in sorted(self.last_access.items())]


def fork_dafc_state(template):
    """A DAFCState showing the same map as ``template`` (its open handles shared,
    read-only), with caches of its own; replacing its map leaves ``template`` alone."""
    from models.domain import DAFCState
    if template is None:
        return DAFCState()
    return DAFCState(cool_file=template.cool_file, bigbed_file=template.bigbed_file, clr=template.clr,
                     resolutions=list(template.resolutions), current_resolution=template.current_resolution,
                     chroms=list(template.chroms), bb=template.bb)


_manager: Optional[MemberStateManager] = None


def set_member_manager(manager: Optional[MemberStateManager]) -> None:
    global _manager
    _manager = manager


def get_member_manager() -> Optional[MemberStateManager]:
    return _manager
