"""Locks with a place in FiberBrowser's lock hierarchy, and a debug-mode order checker.

Levels (lower first; a thread holding a lock of level ``n`` may only take locks of a higher level, or the same
lock again):

    0  operation locks   one workspace's operation on one key: a catalog group load/unload, the demo load
    1  state lock        a workspace's datasets and main reference (services/genome_loading.state_lock)
    2  context lock      a panel genome context's reference (services/genome_loading.reference_lock on a view)
    3  registry lock     panel_genomes._LOCK, the process-wide panel registry (bookkeeping only)
    4  download locks    one per cache file (services/download_locks)

Plain leaf locks (caches, settings files) never take any of these while held and are not tracked.

``CHECK`` (tests turn it on in tests/conftest.py; ``FIBERBROWSER_LOCK_ORDER_CHECK=1`` at runtime) makes every
acquire assert the order and raises ``LockOrderError`` naming both locks.
"""
from __future__ import annotations

import os
import threading

CHECK = os.environ.get("FIBERBROWSER_LOCK_ORDER_CHECK", "").strip().lower() in ("1", "true", "yes")

OPERATION, STATE, CONTEXT, REGISTRY, DOWNLOAD = 0, 1, 2, 3, 4
_held = threading.local()


class LockOrderError(AssertionError):
    pass


def _stack() -> list:
    stack = getattr(_held, "stack", None)
    if stack is None:
        stack = _held.stack = []
    return stack


def held_locks() -> list:
    """This thread's held ordered locks (outermost first)."""
    return list(_stack())


class OrderedLock:
    """A re-entrant lock with a level in the hierarchy above."""

    __slots__ = ("_lock", "level", "name", "__weakref__")

    def __init__(self, level: int, name: str):
        self._lock = threading.RLock()
        self.level = level
        self.name = name

    def _check(self) -> None:
        stack = _stack()
        if not stack or any(lock is self for lock in stack):
            return
        top = max(stack, key=lambda lock: lock.level)
        if top.level >= self.level:     # two different locks of one level are never nested either
            raise LockOrderError(f"lock order: taking {self.name} (level {self.level}) while holding "
                                 f"{top.name} (level {top.level})")

    def acquire(self, blocking: bool = True, timeout: float = -1) -> bool:
        if CHECK:
            self._check()
        got = self._lock.acquire(blocking, timeout)
        if got:
            _stack().append(self)
        return got

    def release(self) -> None:
        stack = _stack()
        for i in range(len(stack) - 1, -1, -1):
            if stack[i] is self:
                del stack[i]
                break
        self._lock.release()

    def __enter__(self):
        self.acquire()
        return self

    def __exit__(self, *exc):
        self.release()
        return False

    def __repr__(self) -> str:
        return f"<OrderedLock {self.name} level={self.level}>"


_op_guard = threading.Lock()
_op_locks: dict = {}


def operation_lock(*key) -> OrderedLock:
    """A level-0 lock for one operation on one key (taken before the state lock)."""
    with _op_guard:
        lock = _op_locks.get(key)
        if lock is None:
            lock = _op_locks[key] = OrderedLock(OPERATION, f"operation{key}")
        return lock
