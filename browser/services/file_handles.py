"""Process-wide, bounded readers with leases covering native calls and iterators."""
from __future__ import annotations

import logging
import os
import threading
import time
from collections import OrderedDict
from contextlib import contextmanager
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)
FAILURE_RETRY_S = 5.0


def file_stamp(path, sidecars=()):
    """Detect replacement, repaired indexes and files appearing after a failed open."""
    if "://" in str(path):
        return None
    def stamp(name):
        try:
            st = os.stat(name)
            return st.st_ino, st.st_mtime_ns, st.st_size
        except OSError:
            return None
    return tuple(stamp(name) for name in (path, *sidecars))


def _key(kind, path):
    path = os.fspath(path)
    return kind, os.path.realpath(path) if "://" not in path else path


def _close(handle):
    if handle is not None:
        try:
            handle.close()
        except Exception:
            pass


@contextmanager
def _reader_lock(lock):
    from services.background_work import checkpoint
    while not lock.acquire(timeout=.05):
        checkpoint()
    try:
        checkpoint(allow_pause=False)
        yield
    finally:
        lock.release()


@dataclass
class _Entry:
    opener: object
    version: object
    max_idle: float | None = None
    max_age: float | None = None
    handle: object = None
    stamp: object = None
    error: str | None = None
    retry_at: float = 0
    reported: bool = False
    opened: float = 0
    used: float = 0
    pins: int = 0
    retired: bool = False
    proxy: object = None
    owner: int | None = None
    lock: object = field(default_factory=threading.RLock)


class HandleCache:
    """One native reader per file, including across request and analysis pools.

    Idle entries are evicted under the registry lock. Active readers are pinned
    until the native call or iterator completes, including cancellation. Waiters
    never open a second copy of a pinned file. Proxies can outlive LRU eviction.
    """

    def __init__(self, max_entries=128, *, speculative=False):
        self.max_entries = max_entries
        self._speculative = speculative
        self._prefetch = None
        self._entries = OrderedDict()
        self._condition = threading.Condition(threading.RLock())

    def _trim(self):
        for key, entry in list(self._entries.items()):
            if len(self._entries) <= self.max_entries:
                break
            if not entry.pins:
                _close(entry.handle)
                del self._entries[key]

    def resize(self, max_entries):
        """Evict idle readers now; active leases drain to the new limit on release."""
        with self._condition:
            self.max_entries = max(1, int(max_entries))
            self._trim()
            self._condition.notify_all()
        if self._prefetch is not None:
            self._prefetch.resize(min(4, self.max_entries))

    def diagnostics(self):
        with self._condition:
            result = dict(limit=self.max_entries, entries=len(self._entries),
                        open=sum(e.handle is not None for e in self._entries.values()),
                        active=sum(bool(e.pins) for e in self._entries.values()))
        if self._prefetch is not None:
            result['prefetch'] = self._prefetch.diagnostics()
        return result

    def get(self, kind, path, opener, version, *, max_idle=None, max_age=None):
        from services.background_work import is_speculative_read
        if not self._speculative and is_speculative_read():
            # A paused iterator must not own the foreground BAM cursor. Keep
            # at most four speculative readers, shared by the single fill worker.
            with self._condition:
                if self._prefetch is None:
                    self._prefetch = HandleCache(min(4, self.max_entries), speculative=True)
            return self._prefetch.get(kind, path, opener, version, max_idle=max_idle, max_age=max_age)
        proxy = SharedHandle(self, _key(kind, path), opener, version, max_idle, max_age)
        with proxy.lease():
            with self._condition:
                return self._entries[proxy.key].proxy

    @contextmanager
    def lease(self, proxy):
        key = proxy.key
        with self._condition:
            while True:
                entry = self._entries.get(key)
                if entry is not None and (not entry.retired or entry.owner == threading.get_ident()):
                    entry.max_idle, entry.max_age = proxy.max_idle, proxy.max_age
                    break
                if entry is None:
                    if len(self._entries) < self.max_entries:
                        entry = _Entry(proxy.opener, proxy.version, proxy.max_idle, proxy.max_age)
                        self._entries[key] = entry
                        break
                    idle = next((k for k, e in self._entries.items() if not e.pins), None)
                    if idle is not None:
                        _close(self._entries.pop(idle).handle)
                        continue
                    if any(e.owner == threading.get_ident() for e in self._entries.values()):
                        raise OSError('All file readers are in use; close an iterator before opening another file')
                self._condition.wait(.05)
                from services.background_work import checkpoint
                checkpoint(allow_pause=False)  # registry lock: foreground needs it to release readers
            entry.pins += 1
            self._entries.move_to_end(key)
        try:
            with _reader_lock(entry.lock):
                if entry.owner == threading.get_ident():
                    # Metadata read inside an iterator uses its original file,
                    # even if that file was replaced or retired during the read.
                    yield entry.handle
                    return
                now = time.monotonic()
                try:
                    stamp = proxy.version()
                    version_error = None
                except Exception as exc:
                    stamp, version_error = None, exc
                changed = entry.stamp != stamp
                stale = (entry.max_idle is not None and now - entry.used > entry.max_idle
                         or entry.max_age is not None and now - entry.opened > entry.max_age)
                if entry.handle is not None and (changed or stale or getattr(entry.handle, 'closed', False)):
                    _close(entry.handle)
                    entry.handle = None
                if entry.handle is None:
                    if entry.error and not changed and now < entry.retry_at:
                        raise OSError(entry.error)
                    if changed:
                        entry.reported = False
                    entry.stamp = stamp
                    try:
                        if version_error is not None:
                            raise version_error
                        entry.handle = proxy.opener()
                        if entry.handle is None:
                            raise OSError('reader returned no handle')
                    except Exception as exc:
                        from services.remote_sources.opening import redact
                        entry.error = redact(str(exc)) or type(exc).__name__
                        entry.retry_at = now + FAILURE_RETRY_S
                        if not entry.reported:
                            logger.warning('Could not open %s: %s (retrying after %.0f s)',
                                           redact(key[1]), entry.error, FAILURE_RETRY_S)
                            entry.reported = True
                        raise OSError(entry.error) from None
                    entry.error = None
                    entry.reported = False
                    entry.opened = now
                    entry.proxy = proxy
                entry.used = now
                entry.owner = threading.get_ident()
                try:
                    yield entry.handle
                finally:
                    entry.owner = None
        finally:
            with self._condition:
                entry.pins -= 1
                if not entry.pins and entry.retired:
                    _close(entry.handle)
                    self._entries.pop(key, None)
                self._trim()
                self._condition.notify_all()

    def discard(self, path=None, *, kind=None):
        """Retire matching readers; an active iterator closes on its final release."""
        if self._prefetch is not None:
            self._prefetch.discard(path, kind=kind)
        with self._condition:
            for key, entry in list(self._entries.items()):
                if kind is not None and key[0] != kind:
                    continue
                if path is not None and key != _key(key[0], path):
                    continue
                entry.retired = True
                if not entry.pins:
                    _close(entry.handle)
                    del self._entries[key]
            self._condition.notify_all()


class SharedHandle:
    """The read-only native interface, serialized for the duration of each operation."""

    def __init__(self, cache, key, opener, version, max_idle, max_age):
        self.cache, self.key = cache, key
        self.opener, self.version = opener, version
        self.max_idle, self.max_age = max_idle, max_age

    def lease(self):
        return self.cache.lease(self)

    def close(self):
        self.cache.discard(self.key[1], kind=self.key[0])

    @property
    def closed(self):
        with self.cache._condition:
            entry = self.cache._entries.get(self.key)
            return entry is None or entry.retired or entry.handle is None or entry.proxy is not self

    def _iterate(self, name, args, kwargs):
        with self.lease() as handle:
            iterator = iter(handle) if name is None else getattr(handle, name)(*args, **kwargs)
            try:
                yield from iterator
            finally:
                close = getattr(iterator, 'close', None)
                if close is not None and iterator is not handle:
                    close()

    def __iter__(self):
        return self._iterate(None, (), {})

    def __getattr__(self, name):
        # htslib iterators keep using the file after fetch() returns. A lock
        # around fetch alone allows another worker to move their file cursor.
        if self.key[0] == 'bam' and name in {'fetch', 'head', 'pileup'}:
            return lambda *args, **kwargs: self._iterate(name, args, kwargs)
        with self.lease() as handle:
            value = getattr(handle, name)
            if not callable(value):
                return value
        def call(*args, **kwargs):
            with self.lease() as handle:
                return getattr(handle, name)(*args, **kwargs)
        return call


handles = HandleCache()


def release_dataset_handles(dataset) -> None:
    """Retire a dataset's primary and companion readers across worker pools."""
    from services.upload_store import dataset_file_paths
    for path in dataset_file_paths(dataset):
        handles.discard(path)
