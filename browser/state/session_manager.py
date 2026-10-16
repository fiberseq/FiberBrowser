"""Per-session BrowserState isolation for public / review deployments.

Each HTTP client gets its own forked `BrowserState` keyed by a `fiberhmm_sid`
cookie. The template state (built at server startup) owns heavy read-only
resources — FASTA handle, parsed GTF, chromosome info — and new sessions
alias those refs while owning fresh mutable dicts/lists/caches.

Disabled in non-public mode: `SessionManager(enabled=False)` just hands back
the template every time, making single-user local runs behave exactly the
same as before.
"""
from __future__ import annotations

import asyncio
import os
import secrets
import threading
import time
from typing import Dict, Optional, Tuple, TYPE_CHECKING

if TYPE_CHECKING:
    from state.browser_state import BrowserState


class SessionsFull(RuntimeError):
    """Every session slot is held by a visitor active within the idle TTL."""

    status_code = 503
    retry_after = 60


class ClientSessionsFull(SessionsFull):
    """One client address holds its whole share of sessions, all of them active."""

    status_code = 429
    retry_after = 60


class SessionManager:
    """Owns per-session BrowserState instances + idle garbage collection."""

    def __init__(self, template, enabled: bool = False,
                 idle_ttl: int = 1800, gc_interval: int = 300, max_sessions: Optional[int] = None):
        self.template = template
        self.enabled = enabled
        self.idle_ttl = idle_ttl          # seconds; drop sessions inactive longer
        self.gc_interval = gc_interval    # seconds between GC sweeps
        # Live sessions kept; the least recently used is dropped past this.
        self.max_sessions = max_sessions or int(os.environ.get("FIBERBROWSER_MAX_SESSIONS", "200"))
        self.sessions: Dict[str, "BrowserState"] = {}
        self.last_access: Dict[str, float] = {}
        # Which client (IP, or IPv6 /64) each session was minted for; a
        # client may hold at most max_per_client (public servers).
        self.owner: Dict[str, str] = {}
        self.max_per_client: Optional[int] = None
        # Public servers: a smaller per-session read cache, and a hook that
        # may refuse new sessions (memory pressure).
        self.session_cache_entries: Optional[int] = None
        self.admission_check = None
        self._gc_task: Optional[asyncio.Task] = None
        # get_state runs in worker threads for sync routes.
        # Re-entrant: get_or_create drops idle sessions while holding it, and
        # the GC loop (event-loop thread) takes it too while workers create.
        self._lock = threading.RLock()

    @staticmethod
    def _new_sid() -> str:
        return secrets.token_urlsafe(24)

    def get_or_create(self, sid: Optional[str], owner: Optional[str] = None) -> Tuple["BrowserState", str, bool]:
        """Return (state, sid, was_created). A new session is forked from the
        template on cache miss; existing sessions have their last_access bumped.

        ``owner`` (the client's address) limits how many sessions one client
        can hold: past ``max_per_client`` that client's own idle sessions are
        dropped, and if none is idle it is refused (ClientSessionsFull). One
        client can therefore never push out anyone else's session."""
        if not self.enabled:
            return self.template, sid or "", False
        with self._lock:
            now = time.time()
            if sid and sid in self.sessions:
                self.last_access[sid] = now
                return self.sessions[sid], sid, False
            from state.browser_state import BrowserState
            # Session IDs are only ever minted here: an unknown cookie value (an
            # expired session, or one a client made up) gets a fresh ID.
            new_sid = self._new_sid()
            if owner is not None and self.max_per_client:
                mine = [s for s, o in self.owner.items() if o == owner]
                if len(mine) >= self.max_per_client:
                    for stale in [s for s in mine if now - self.last_access.get(s, 0) > self.idle_ttl]:
                        self.drop(stale)
                    mine = [s for s, o in self.owner.items() if o == owner]
                    if len(mine) >= self.max_per_client:
                        raise ClientSessionsFull(
                            "Too many browser sessions from your network on this server; "
                            "close some tabs or try again later")
            if self.admission_check is not None:
                reason = self.admission_check()
                if reason:
                    raise SessionsFull(reason)
            if len(self.sessions) >= self.max_sessions:
                # Make room from idle sessions only: new visitors (or a script
                # without cookies) must never push out someone still working.
                for stale in [s for s, last in self.last_access.items() if now - last > self.idle_ttl]:
                    self.drop(stale)
                if len(self.sessions) >= self.max_sessions:
                    raise SessionsFull("The server is at its visitor limit; try again later")
            state = BrowserState.fork_for_session(self.template)
            if self.session_cache_entries:
                for name in ("_broad_cache_max", "_working_set_cache_max"):
                    current = getattr(state, name, None)
                    if isinstance(current, int):
                        setattr(state, name, min(current, self.session_cache_entries))
            self.sessions[new_sid] = state
            self.last_access[new_sid] = now
            if owner is not None:
                self.owner[new_sid] = owner
            return state, new_sid, True

    def get(self, sid: str) -> Optional["BrowserState"]:
        return self.sessions.get(sid)

    def drop(self, sid: str) -> None:
        with self._lock:
            state = self.sessions.pop(sid, None)
            self.last_access.pop(sid, None)
            self.owner.pop(sid, None)
        if state is None:
            return
        # Clear caches to free memory promptly (Python GC will handle the rest)
        _clear_caches(state)
        # Consensus runs keep artifacts and a fit cache on disk.
        try:
            from services.consensus_workflow import dispose_session
            dispose_session(state)
        except Exception as e:
            print(f"[session-gc] consensus cleanup failed: {e}")
        # Plugin packs drop their own work (each hook reports its own failure).
        from plugins.packs import run_hooks
        run_hooks("session_dispose", state)

    def clear_idle_caches(self, idle_seconds: float) -> int:
        """Empty the read caches of sessions idle for ``idle_seconds``; how many held any."""
        now = time.time()
        with self._lock:
            idle = [self.sessions[s] for s, last in self.last_access.items()
                    if now - last > idle_seconds and s in self.sessions]
        return sum(1 for state in idle if _clear_caches(state))

    async def gc_loop(self) -> None:
        """Periodic sweep: drop sessions that haven't been touched in idle_ttl."""
        while True:
            try:
                await asyncio.sleep(self.gc_interval)
                now = time.time()
                with self._lock:
                    stale = [sid for sid, last in self.last_access.items()
                             if now - last > self.idle_ttl]
                for sid in stale:
                    self.drop(sid)
                if stale:
                    print(f"[session-gc] dropped {len(stale)} idle session(s), "
                          f"{len(self.sessions)} remaining")
            except asyncio.CancelledError:
                return
            except Exception as e:
                # Don't let a single GC bug kill the loop.
                print(f"[session-gc] error: {e}")

    def start_gc(self) -> None:
        """Spawn the GC task on the running event loop. Idempotent."""
        if self._gc_task is None or self._gc_task.done():
            self._gc_task = asyncio.create_task(self.gc_loop())

    def stop_gc(self) -> None:
        if self._gc_task and not self._gc_task.done():
            self._gc_task.cancel()


def _clear_caches(state) -> bool:
    """Empty a session's read caches; True when any held something."""
    held = False
    for cache_attr in ('_broad_cache', '_meta_profile_cache',
                       '_methylation_cache', '_working_set_cache',
                       '_track_data_cache', '_track_region_cache',
                       '_primer_fa_cache', '_broad_read_index_cache', '_coverage_payload_cache'):
        c = getattr(state, cache_attr, None)
        if c is not None:
            try:
                held = held or len(c) > 0
                c.clear()
            except Exception:
                pass
    return held
