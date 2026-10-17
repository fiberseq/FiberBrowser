"""One download at a time per cache file.

Two requests for the same genome (two tabs restoring a session, a double click) used to download the same multi-GB
FASTA at once into one ``.download.tmp``: each truncated the other's file. A caller holds ``download_lock(path)``
around checking for the cached file and downloading it, so the second one finds the first one's file.
"""
from __future__ import annotations

import contextlib
import threading

_guard = threading.Lock()
_locks: dict = {}
_local = threading.local()


class DownloadBusy(RuntimeError):
    """Another request holds this cache file's lock, inside ``no_wait()``."""


def download_lock(key: str):
    """The lock for one cache file (level 4 of the hierarchy in services/lock_order)."""
    from services.lock_order import DOWNLOAD, OrderedLock
    with _guard:
        lock = _locks.get(key)
        if lock is None:
            lock = _locks[key] = OrderedLock(DOWNLOAD, f"download:{key}")
        return lock


class _NoWait:
    __slots__ = ("busy", "previous")

    def __init__(self, previous):
        self.busy = False          # a lock was held elsewhere (whoever caught the DownloadBusy)
        self.previous = previous


@contextlib.contextmanager
def no_wait():
    """In this thread, inside this block, ``holding`` a lock another request holds raises DownloadBusy instead of
    waiting for it (a tour tab's demo genome: it goes on without the reference rather than wait for a download).
    The block's value says afterwards whether that happened (``.busy``), even when a caller caught the error."""
    scope = _NoWait(getattr(_local, "no_wait", None))
    _local.no_wait = scope
    try:
        yield scope
    finally:
        _local.no_wait = scope.previous


@contextlib.contextmanager
def holding(key: str):
    """``with download_lock(key)``, except that inside ``no_wait()`` a lock held elsewhere raises DownloadBusy."""
    lock = download_lock(key)
    scope = getattr(_local, "no_wait", None)
    if not lock.acquire(blocking=scope is None):
        while scope is not None:   # every enclosing no_wait block sees it
            scope.busy = True
            scope = scope.previous
        raise DownloadBusy(key)
    try:
        yield lock
    finally:
        lock.release()
