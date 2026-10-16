"""One download at a time per cache file.

Two requests for the same genome (two tabs restoring a session, a double click) used to download the same multi-GB
FASTA at once into one ``.download.tmp``: each truncated the other's file. A caller holds ``download_lock(path)``
around checking for the cached file and downloading it, so the second one finds the first one's file.
"""
from __future__ import annotations

import threading

_guard = threading.Lock()
_locks: dict = {}


def download_lock(key: str):
    """The lock for one cache file (level 4 of the hierarchy in services/lock_order)."""
    from services.lock_order import DOWNLOAD, OrderedLock
    with _guard:
        lock = _locks.get(key)
        if lock is None:
            lock = _locks[key] = OrderedLock(DOWNLOAD, f"download:{key}")
        return lock
