"""Shared cache of identical anonymous read requests on a ``--public`` server.

Many visitors of a public server open the same loci (a paper's figure links)
with the same catalog datasets. Their read, coverage and track requests are
then identical, and one answer can serve them all.

A response is reused only when it is a pure function of the request and of
the visitor's session, which the key captures in full:

- The key is the method, path, sorted query string (and, for the one POST
  here, the body), the Accept-Encoding class, and a **fingerprint** of the
  whole session state: every attribute of the visitor's BrowserState
  (datasets with their settings, quality filters, layer inference, tracks,
  annotation filters, peaks, clusters, footprint-class runs, ...) walked
  recursively, minus the read caches themselves. Two visitors whose settings
  differ in anything have different keys, including settings added later.
- A session whose state is too large to fingerprint cheaply (e.g. cluster
  assignments for thousands of reads) or holds data the walk can't read
  (arrays) simply bypasses the cache.
- A response is stored only if the fingerprint is the same when it finishes
  and no change (POST/DELETE) to the session started meanwhile.
- Only complete 200 responses are stored, without Set-Cookie (the visitor's
  own cookie is re-issued on a hit), bounded by ``cache_mb`` in total, an
  eighth of that per entry, and ``cache_ttl_seconds``.
"""
from __future__ import annotations

import hashlib
import json
import threading
import time
from collections import OrderedDict
from typing import Any, Optional

# GET routes whose answer depends only on the query and the session state, and
# that change nothing but caches (a hit skips the handler). Not /api/fire: it
# also records the peaks it found for later clustering.
CACHEABLE_GET: frozenset[str] = frozenset({
    "/api/reads/compact", "/api/reads/compact_all", "/api/reads/info", "/api/working_set_info",
    "/api/coverage", "/api/meta", "/api/meta_all",
    "/api/tracks/{track_idx}", "/api/tracks/{track_idx}/annotations",
    "/api/genes", "/api/sequence", "/api/annotations/region",
})
# POST routes that only read (their body is part of the key).
CACHEABLE_POST: frozenset[str] = frozenset({"/api/tracks/batch"})

# Session attributes that are caches, locks or bookkeeping, not settings.
_NOT_STATE = frozenset({
    "_template", "_cow_shared", "_broad_cache", "_broad_cache_lock", "_broad_cache_inflight",
    "_broad_read_index_cache", "_working_set_cache", "_meta_profile_cache", "_methylation_cache",
    "_track_data_cache", "_track_region_cache", "_primer_fa_cache", "_initial_data_position_cache",
    "_signal_counts_cache",
    "_current_chrom", "_current_start", "_current_end",
    "_public_cache_generation", "_public_cache_busy",
    "_sv_reference_identity",
    # The last peak scan: every view change runs one, and only the analysis
    # routes (filtering, clustering) read it, never a CACHEABLE route
    # (tests/test_public_protection.py checks who reads it).
    "peak_regions", "peak_regions_view", "peak_regions_snapshot",
})
# Read-cache bookkeeping (sizes, timeouts, schema versions the loaders bump
# on first use): named after the caches, never settings.
_CACHE_PREFIXES = ("_broad_cache", "_broad_read_index", "_working_set_cache", "_meta_profile_cache",
                   "_methylation_cache", "_track_data_cache", "_track_region_cache", "_primer_fa_cache")


def _not_state(name: str) -> bool:
    return name in _NOT_STATE or name.startswith(_CACHE_PREFIXES)


_MAX_ITEMS = 2_000
_GENERATION = "_public_cache_generation"
_BUSY = "_public_cache_busy"


class _Unfingerprintable(Exception):
    pass


def generation(state) -> int:
    return state.__dict__.get(_GENERATION, 0)


def busy(state) -> int:
    return state.__dict__.get(_BUSY, 0)


def begin_change(state, method: str, template: Optional[str] = None) -> None:
    """A POST/DELETE is about to run in this session."""
    if method in ("GET", "HEAD"):
        return
    d = state.__dict__
    d[_GENERATION] = d.get(_GENERATION, 0) + 1
    d[_BUSY] = d.get(_BUSY, 0) + 1


def end_change(state, method: str, template: Optional[str] = None) -> None:
    if method in ("GET", "HEAD"):
        return
    d = state.__dict__
    d[_GENERATION] = d.get(_GENERATION, 0) + 1
    d[_BUSY] = max(0, d.get(_BUSY, 0) - 1)


_RESOURCE_TYPES = ("lock", "rlock", "condition", "event", "future", "thread", "alignmentfile",
                   "fastafile", "bigwigfile", "pybigwig", "executor", "tabixfile", "semaphore")


def _sig(value: Any, depth: int = 0, seen: Optional[set] = None) -> Any:
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, bytes):
        return hashlib.sha256(value).hexdigest()
    if depth > 12:
        raise _Unfingerprintable("state nested too deeply")
    seen = seen if seen is not None else set()
    if id(value) in seen:
        return "<cycle>"
    seen = seen | {id(value)}
    if isinstance(value, dict):
        if len(value) > _MAX_ITEMS:
            raise _Unfingerprintable("large mapping")
        return sorted(((repr(k), _sig(v, depth + 1, seen)) for k, v in value.items()), key=lambda kv: kv[0])
    if isinstance(value, (list, tuple, set, frozenset)):
        if len(value) > _MAX_ITEMS:
            raise _Unfingerprintable("large sequence")
        items = [_sig(v, depth + 1, seen) for v in value]
        if isinstance(value, (set, frozenset)):
            items = sorted(items, key=repr)
        return items
    if callable(value) and hasattr(value, "__qualname__"):
        return getattr(value, "__module__", "") + "." + value.__qualname__
    name = type(value).__name__.lower()
    if any(kind in name for kind in _RESOURCE_TYPES):
        return type(value).__name__  # open files, locks, futures: resources, not settings
    if hasattr(value, "__dict__") and not callable(value):
        return [type(value).__name__, _sig({k: v for k, v in vars(value).items() if not _not_state(k)},
                                           depth + 1, seen)]
    if hasattr(value, "__slots__"):
        return [type(value).__name__, _sig({k: getattr(value, k, None) for k in value.__slots__}, depth + 1, seen)]
    # Arrays, data frames and anything else the walk can't read reliably.
    raise _Unfingerprintable(type(value).__name__)


def fingerprint(state) -> Optional[str]:
    """A digest of everything in the session that an answer can depend on (None: don't cache)."""
    try:
        own = {k: v for k, v in vars(state).items() if not _not_state(k)}
        template = state.__dict__.get("_template")
        shared = {
            # The shared reference (the same object for every visitor): which one is loaded.
            "genome": getattr(state, "current_genome", None),
            "gtf": id(getattr(template or state, "gtf_data", None)),
            "fasta": getattr(template or state, "fasta_path", None),
            "chroms": len(getattr(state, "chroms", None) or ()),
        }
        raw = json.dumps([_sig(own), shared], sort_keys=True, default=lambda v: type(v).__name__)
    except _Unfingerprintable:
        return None
    except Exception:
        return None
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def request_key(method: str, path: str, query: bytes, body: bytes, gzip_ok: bool, state_fp: str) -> str:
    from urllib.parse import parse_qsl, urlencode
    # Sorted by name only: a repeated parameter keeps its values' order (a
    # route reading the last one sees a different request when it differs).
    q = urlencode(sorted(parse_qsl(query.decode("latin-1"), keep_blank_values=True), key=lambda kv: kv[0]))
    h = hashlib.sha256()
    for part in (method, path, q, "gzip" if gzip_ok else "identity", state_fp):
        h.update(part.encode("utf-8"))
        h.update(b"\0")
    h.update(hashlib.sha256(body or b"").digest())
    return h.hexdigest()


class ResponseCache:
    """Byte-bounded LRU with a TTL."""

    def __init__(self, max_bytes: int, ttl_seconds: float, clock=time.monotonic):
        self.max_bytes = max(0, int(max_bytes))
        self.max_entry = self.max_bytes // 8
        self.ttl = ttl_seconds
        self.clock = clock
        self._entries: OrderedDict[str, tuple[float, int, list, bytes]] = OrderedDict()
        self._bytes = 0
        self._lock = threading.Lock()
        self.hits = 0
        self.misses = 0

    @property
    def enabled(self) -> bool:
        return self.max_bytes > 0

    def get(self, key: str):
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                self.misses += 1
                return None
            stored_at, status, headers, body = entry
            if self.clock() - stored_at > self.ttl:
                self._drop(key)
                self.misses += 1
                return None
            self._entries.move_to_end(key)
            self.hits += 1
            return status, headers, body

    def put(self, key: str, status: int, headers: list, body: bytes) -> bool:
        size = len(body) + sum(len(k) + len(v) for k, v in headers) + 64
        if not self.enabled or size > self.max_entry:
            return False
        with self._lock:
            if key in self._entries:
                self._drop(key)
            self._entries[key] = (self.clock(), status, headers, body)
            self._bytes += size
            while self._bytes > self.max_bytes and self._entries:
                self._drop(next(iter(self._entries)))
        return True

    def _drop(self, key: str) -> None:
        _stored, _status, headers, body = self._entries.pop(key)
        self._bytes -= len(body) + sum(len(k) + len(v) for k, v in headers) + 64

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()
            self._bytes = 0

    def stats(self) -> dict:
        with self._lock:
            return {"entries": len(self._entries), "bytes": self._bytes, "hits": self.hits, "misses": self.misses}

    def __len__(self) -> int:
        return len(self._entries)


_cache: Optional[ResponseCache] = None
_cache_for: Optional[tuple] = None


def get_response_cache() -> ResponseCache:
    """The process-wide cache, sized from the current public limits."""
    global _cache, _cache_for
    from services.public_limits import get_public_limits
    limits = get_public_limits()
    want = (limits.cache_mb, limits.cache_ttl_seconds)
    if _cache is None or _cache_for != want:
        _cache = ResponseCache(limits.cache_mb * 2**20, limits.cache_ttl_seconds)
        _cache_for = want
    return _cache
