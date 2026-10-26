"""Identities a scan shares with FiberBrowser: file content ids and source-record keys.

``content_id`` is FiberHMM's ``cid:v1`` (``fiberhmm.scan.identity.content_id``): SHA-256 over the file size and
its first and last MiB, no timestamps, so copies of one BAM share an id. A scan binds to a loaded dataset when
one of the dataset's files has the id a scan lists (an input BAM, or an annotated BAM the scan wrote).

A scan row names its source record by ``record`` = ``<record_sha256>:<occurrence>`` plus ``qname``. The live
lift's per-record identity (``services/lift/compose.py``) uses the same components, so a scan row joins a lifted
row with no BAM re-read.
"""
from __future__ import annotations

import hashlib
import os
import threading
from pathlib import Path

CONTENT_ID_PREFIX = 'cid:v1:'
_MIB = 1 << 20
_cache: dict = {}
_cache_lock = threading.Lock()


def content_id(path) -> str:
    """``cid:v1:<sha256>`` of a file (cached per path, size and mtime)."""
    p = Path(path).expanduser()
    st = os.stat(p)
    key = (str(p.resolve()), st.st_size, st.st_mtime_ns)
    with _cache_lock:
        hit = _cache.get(key)
    if hit:
        return hit
    size = st.st_size
    h = hashlib.sha256()
    h.update(b'cid:v1\n')
    h.update(str(size).encode() + b'\n')
    with open(p, 'rb') as handle:
        h.update(handle.read(min(size, _MIB)))
        handle.seek(max(0, size - _MIB))
        h.update(handle.read(min(size, _MIB)))
    value = CONTENT_ID_PREFIX + h.hexdigest()
    with _cache_lock:
        if len(_cache) > 4096:
            _cache.clear()
        _cache[key] = value
    return value


def safe_content_id(path) -> str | None:
    try:
        return content_id(path)
    except OSError:
        return None
