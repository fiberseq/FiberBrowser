"""LRU storage bounded by retained bytes, including Python container overhead."""
from __future__ import annotations

import sys
import threading
import weakref
import time
from collections import OrderedDict

_shared = weakref.WeakValueDictionary()
_shared_budgets = {}
_cache_lock = threading.RLock()
_ATOMIC_TYPES = frozenset((int, float, bool, complex, str, bytes, type(None)))


def shared_cache(group='profiles', default_bytes=32 * 1024 ** 2):
    with _cache_lock:
        cache = ByteCache(_shared_budgets.setdefault(group, default_bytes))
        cache.budget_group = group
        _shared[id(cache)] = cache
        return cache


def _trim_shared(group):
    caches = sorted((c for c in list(_shared.values()) if c.budget_group == group), key=lambda c: c._last_use)
    total = sum(c.retained_bytes for c in caches)
    budget = _shared_budgets[group]
    for cache in caches:
        while cache and total > budget:
            before = cache.retained_bytes
            cache.popitem(last=False)
            total -= before - cache.retained_bytes


def configure_shared_caches(budgets):
    with _cache_lock:
        _shared_budgets.update(budgets)
        for cache in list(_shared.values()):
            cache.resize(budgets.get(cache.budget_group, 16 * 1024 ** 2))
        for group in _shared_budgets:
            _trim_shared(group)


def shared_cache_diagnostics():
    with _cache_lock:
        return [{'group': group, 'budget_bytes': budget,
                 'retained_bytes': sum(c.retained_bytes for c in list(_shared.values()) if c.budget_group == group),
                 'entries': sum(len(c) for c in list(_shared.values()) if c.budget_group == group)}
                for group, budget in _shared_budgets.items()
                if any(c.budget_group == group for c in list(_shared.values()))]


def retained_size(value, seen=None) -> int:
    """Estimate resident bytes; arrays are exact, large Python sequences sampled.

    Counting shared objects more than once across entries is conservative. A
    bounded sample avoids walking millions of marks on every cache insertion.
    This is a retention budget, not a bound on a running request's RSS.
    """
    if seen is None:
        seen = set()
    identity = id(value)
    if identity in seen:
        return 0
    seen.add(identity)
    # Exact builtins have no owned containers or custom retention metadata.
    # Read geometry has millions of these scalars; avoid attribute probes.
    if type(value) in _ATOMIC_TYPES:
        return sys.getsizeof(value)
    if hasattr(value, 'retained_bytes'):
        return int(value.retained_bytes)
    size = sys.getsizeof(value)
    if isinstance(value, dict):
        items = (item for pair in value.items() for item in pair)
    elif isinstance(value, (list, tuple, set, frozenset)):
        if isinstance(value, (list, tuple)) and len(value) > 64:
            # Samples have independent seen sets. An atomic sample cannot add
            # descendants, so its size needs no copied set or recursive call.
            total = 0
            for i in range(64):
                item = value[i * (len(value) - 1) // 63]
                if type(item) in _ATOMIC_TYPES:
                    if id(item) not in seen:
                        total += sys.getsizeof(item)
                else:
                    total += retained_size(item, seen.copy())
            return size + int(total * len(value) / 64)
        items = value
    else:
        if hasattr(value, 'nbytes'):
            # A view owns its underlying allocation through base.
            size += retained_size(value.base, seen) if getattr(value, 'base', None) is not None else 0
        elif hasattr(value, '__dict__'):
            size += retained_size(vars(value), seen)
        return size
    for item in items:
        if type(item) in _ATOMIC_TYPES:
            identity = id(item)
            if identity not in seen:
                seen.add(identity)
                size += sys.getsizeof(item)
        else:
            size += retained_size(item, seen)
    return size


class ByteCache(OrderedDict):
    """An OrderedDict-compatible byte LRU; oversized entries are not retained."""

    def __init__(self, max_bytes: int):
        super().__init__()
        self.max_bytes = max(0, int(max_bytes))
        self.retained_bytes = 0
        self._sizes = {}
        self._lock = _cache_lock
        self._last_use = time.monotonic()

    def __setitem__(self, key, value):
        size = retained_size(key) + retained_size(value) + 128
        with self._lock:
            self.pop(key, None)
            if size > self.max_bytes:
                return
            while self and self.retained_bytes + size > self.max_bytes:
                self.popitem(last=False)
            super().__setitem__(key, value)
            self._sizes[key] = size
            self.retained_bytes += size
            self._last_use = time.monotonic()
            if hasattr(self, 'budget_group'):
                _trim_shared(self.budget_group)

    def __delitem__(self, key):
        with self._lock:
            super().__delitem__(key)
            self.retained_bytes -= self._sizes.pop(key)

    def pop(self, key, *default):
        with self._lock:
            if key not in self:
                if default:
                    return default[0]
                raise KeyError(key)
            value = super().__getitem__(key)
            del self[key]
            return value

    def popitem(self, last=True):
        with self._lock:
            if not self:
                raise KeyError('cache is empty')
            key = next(reversed(self) if last else iter(self))
            return key, self.pop(key)

    def move_to_end(self, key, last=True):
        with self._lock:
            if key in self:
                super().move_to_end(key, last=last)
                self._last_use = time.monotonic()

    def clear(self):
        with self._lock:
            super().clear()
            self._sizes.clear()
            self.retained_bytes = 0

    def resize(self, max_bytes):
        with self._lock:
            self.max_bytes = max(0, int(max_bytes))
            while self and self.retained_bytes > self.max_bytes:
                self.popitem(last=False)

    def setdefault(self, key, default=None):
        with self._lock:
            if key in self:
                return self[key]
            self[key] = default
            return default

    def update(self, *args, **kwargs):
        for key, value in dict(*args, **kwargs).items():
            self[key] = value
