"""Background analytics off the read path: bounded, deduplicated, cancellable.

The view's reads (``/api/reads/compact``) are what the user waits for. The
analyses that follow a view around (quality-filter counts, auto-scanned peaks,
insertions in view, the best-covered windows) used to run on the same thread
pool, every one to completion, however many views had gone by: on a busy
machine they piled up and starved the reads.

Here they run on a small pool of their own (``FIBERBROWSER_BACKGROUND_WORKERS``,
default 2), and

- **reads first**: a job waits (bounded) while any read load is in flight
  (``interactive_read`` marks one), and so reuses the reads it loaded;
- **one per question**: identical requests in flight share one computation
  (``key``), and a finished result can be kept in a ``ResultCache``;
- **cancellable**: when every client waiting for a job has gone (an aborted
  fetch closes its connection), the job's cancel event is set. A job not
  started yet never starts; a running one stops at its next ``checkpoint()``
  (the BAM loops call it) by raising ``Cancelled``.

The cancel token is thread-local: ``checkpoint()`` is a no-op outside a
background job, so shared loaders can call it freely.
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import contextvars
import os
import threading
import time
from contextlib import contextmanager
from typing import Any, Callable, Hashable, Optional

# Longest a background job waits for read loads to finish before it starts anyway.
READ_PRIORITY_MAX_WAIT_S = 30.0


class Cancelled(BaseException):
    """Every client waiting for this background job has gone: it stopped.

    A BaseException, like KeyboardInterrupt: the loaders' ``except Exception``
    handlers (log a file's error and go on with the reads so far) must never
    catch it, or a cancelled load could be cached as a partial read set."""


_local = threading.local()


def _token() -> Optional[threading.Event]:
    return getattr(_local, "cancel", None)


def is_cancelled() -> bool:
    token = _token()
    return token is not None and token.is_set()


def checkpoint(*, allow_pause=True) -> None:
    """Raise ``Cancelled`` if this thread's background job was cancelled (else nothing)."""
    token = _token()
    if token is not None and token.is_set():
        raise Cancelled()
    if allow_pause and is_speculative_read():
        # Keep useful decode progress while foreground work runs. Navigation
        # used to cancel and restart the entire neighborhood at this point.
        while _reads_in_flight > 0 or _active_jobs > 0:
            if token is not None and token.wait(0.02):
                raise Cancelled()
            if token is None:
                time.sleep(0.02)


@contextmanager
def speculative_read():
    previous = getattr(_local, 'prefetch', False)
    _local.prefetch = True
    try:
        yield
    finally:
        _local.prefetch = previous


def is_speculative_read():
    return getattr(_local, 'prefetch', False)


@contextmanager
def cancel_scope(event: Optional[threading.Event]):
    """Run the block with ``event`` as this thread's cancel token."""
    previous = _token()
    _local.cancel = event
    try:
        yield
    finally:
        _local.cancel = previous


# ---------------------------------------------------------------------------
# Read priority

_reads_cond = threading.Condition()
_reads_in_flight = 0


def is_interactive_read() -> bool:
    """Whether this worker is loading a visible view."""
    return getattr(_local, 'interactive', False)


@contextmanager
def interactive_read():
    """Mark a read load in flight: background jobs wait for it (``yield_to_reads``)."""
    global _reads_in_flight
    with _reads_cond:
        _reads_in_flight += 1
    previous = is_interactive_read()
    _local.interactive = True
    try:
        configure_worker_threads(1)
        yield
    finally:
        _local.interactive = previous
        with _reads_cond:
            _reads_in_flight -= 1
            if _reads_in_flight <= 0:
                _reads_in_flight = 0
                _reads_cond.notify_all()


def reads_in_flight() -> int:
    with _reads_cond:
        return _reads_in_flight


def yield_to_reads(max_wait_s: float = READ_PRIORITY_MAX_WAIT_S) -> None:
    """Wait while reads are loading (at most ``max_wait_s``), stopping if cancelled."""
    deadline = time.monotonic() + max(0.0, max_wait_s)
    with _reads_cond:
        while _reads_in_flight > 0:
            if is_cancelled():
                raise Cancelled()
            left = deadline - time.monotonic()
            if left <= 0:
                break
            _reads_cond.wait(min(0.1, left))
    checkpoint()


# ---------------------------------------------------------------------------
# Results


_MISS = object()


class ResultCache:
    """A small thread-safe LRU of finished results, each kept ``ttl_s`` seconds."""

    def __init__(self, max_entries: int = 64, ttl_s: float = 600.0, max_bytes=None):
        self.max_entries = max(1, int(max_entries))
        self.ttl_s = float(ttl_s)
        from services.byte_cache import shared_cache
        self._items = shared_cache()
        if max_bytes is not None:
            self._items.resize(max_bytes)
        self._lock = threading.Lock()

    def get(self, key: Hashable, default: Any = _MISS) -> Any:
        with self._lock:
            item = self._items.get(key)
            if item is None:
                return default
            stored, value = item
            if time.monotonic() - stored > self.ttl_s:
                del self._items[key]
                return default
            self._items.move_to_end(key)
            return value

    def put(self, key: Hashable, value: Any) -> None:
        with self._lock:
            self._items[key] = (time.monotonic(), value)
            self._items.move_to_end(key)

    def clear(self) -> None:
        with self._lock:
            self._items.clear()

    def __len__(self) -> int:
        with self._lock:
            return len(self._items)


# ---------------------------------------------------------------------------
# The pool


def _worker_count() -> int:
    try:
        return max(1, int(os.environ.get("FIBERBROWSER_BACKGROUND_WORKERS", "2")))
    except ValueError:
        return 2


_executor: Optional[concurrent.futures.ThreadPoolExecutor] = None
_executor_lock = threading.Lock()
_runtime_workers = None
_numeric_threads = 1
_numeric_limit = None
_slots = threading.Condition()
_active_jobs = 0


def configure_workers(workers, numeric_threads):
    """New jobs use the new limits; existing jobs can finish without interruption."""
    global _runtime_workers, _numeric_threads, _executor, _numeric_limit
    with _executor_lock:
        changed = _runtime_workers != workers
        _runtime_workers, _numeric_threads = workers, numeric_threads
        if changed and _executor is not None:
            _executor.shutdown(wait=False)
            _executor = None
    with _slots:
        _slots.notify_all()
    try:
        from threadpoolctl import threadpool_limits
        _numeric_limit = threadpool_limits(limits=numeric_threads)
    except ImportError:
        pass


@contextmanager
def worker_slot():
    global _active_jobs
    with _slots:
        while _active_jobs >= _effective_workers():
            checkpoint()
            _slots.wait(0.05)
        _active_jobs += 1
    try:
        configure_worker_threads()
        yield
    finally:
        with _slots:
            _active_jobs -= 1
            _slots.notify_all()


def configure_worker_threads(threads=None):
    """Numba's thread mask is per calling thread, including persistent job pools."""
    try:
        import numba
        numba.set_num_threads(min(_numeric_threads if threads is None else threads, numba.config.NUMBA_NUM_THREADS))
    except (ImportError, ValueError):
        pass


def _effective_workers():
    count = _runtime_workers or _worker_count()
    return min(count, _worker_count()) if 'FIBERBROWSER_BACKGROUND_WORKERS' in os.environ else count


def auxiliary_worker_count(limit=8):
    """Bound alignment and external-tool pools without multiplying Low's work."""
    if _runtime_workers == 1 and _numeric_threads == 1:
        return 1
    return max(1, min(limit, os.cpu_count() or 1))


def _pool() -> concurrent.futures.ThreadPoolExecutor:
    global _executor
    with _executor_lock:
        if _executor is None:
            _executor = concurrent.futures.ThreadPoolExecutor(
                max_workers=_effective_workers(), thread_name_prefix="fiberbrowser-background")
        return _executor


class _Flight:
    __slots__ = ("future", "cancel", "waiters")

    def __init__(self):
        self.future: concurrent.futures.Future = concurrent.futures.Future()
        self.cancel = threading.Event()
        self.waiters = 0


_flights: dict = {}
_flights_lock = threading.Lock()

# Counters for tests and diagnostics.
stats = {"started": 0, "shared": 0, "cached": 0, "cancelled": 0, "skipped": 0}


def _run(flight: _Flight, key, fn: Callable, args, kwargs, cache: Optional[ResultCache], wait_for_reads: bool):
    if not flight.future.set_running_or_notify_cancel():
        return
    try:
        with cancel_scope(flight.cancel):
            if flight.cancel.is_set():
                stats["skipped"] += 1
                raise Cancelled()
            if wait_for_reads:
                yield_to_reads()
            with worker_slot():
                result = fn(*args, **kwargs)
            # Cancelled while it ran, but it ran to the end: the result is still good.
    except BaseException as error:  # noqa: BLE001 - handed to every waiter
        if isinstance(error, Cancelled):
            stats["cancelled"] += 1
        flight.future.set_exception(error)
    else:
        if cache is not None:
            cache.put(key, result)
        flight.future.set_result(result)
    finally:
        with _flights_lock:
            if _flights.get(key) is flight:
                del _flights[key]


def yield_to_foreground():
    """Speculative cache fills wait for both visible reads and analysis jobs."""
    while True:
        checkpoint()
        yield_to_reads()
        with _flights_lock:
            busy = bool(_flights)
        if not busy and not reads_in_flight():
            return
        time.sleep(0.05)


def in_flight(key) -> bool:
    with _flights_lock:
        return key in _flights


def _join(key, fn, args, kwargs, cache, wait_for_reads) -> _Flight:
    with _flights_lock:
        flight = _flights.get(key)
        if flight is None or flight.cancel.is_set():
            flight = _Flight()
            _flights[key] = flight
            stats["started"] += 1
            # In the request's context (as asyncio.to_thread did): its sandbox, workspace, lab user and
            # remote-access scope (services/runtime.py, services/remote_access.py) hold in the job too.
            # A request that joins a flight shares the first one's result (same key: same data and settings).
            _pool().submit(contextvars.copy_context().run, _run, flight, key, fn, args, kwargs, cache, wait_for_reads)
        else:
            stats["shared"] += 1
        flight.waiters += 1
    return flight


def _leave(key, flight: _Flight) -> None:
    with _flights_lock:
        flight.waiters -= 1
        if flight.waiters <= 0 and not flight.future.done():
            flight.cancel.set()
            if _flights.get(key) is flight:
                del _flights[key]  # a new request for it starts afresh


async def _client_gone(request) -> None:
    from services.client_disconnect import wait_for_disconnect
    try:
        await wait_for_disconnect(request)
    except Exception:  # noqa: BLE001 - no way to tell: assume it stays
        await asyncio.Event().wait()


async def run_background(request, key: Hashable, fn: Callable, *args,
                         cache: Optional[ResultCache] = None, wait_for_reads: bool = True, **kwargs):
    """``fn(*args, **kwargs)`` on the background pool, shared by identical ``key`` s.

    Returns its result, or raises ``Cancelled`` when this client went away
    (``request``: the route's Request; None never watches). With ``cache``,
    a finished result is reused for the same key.
    """
    from services.signal_evidence import signal_filter_key
    filters = signal_filter_key()
    if any(filters):
        key = (key, "signal", filters)
    if cache is not None:
        hit = cache.get(key)
        if hit is not _MISS:
            stats["cached"] += 1
            return hit
    flight = _join(key, fn, args, kwargs, cache, wait_for_reads)
    work = asyncio.wrap_future(flight.future)
    watcher = asyncio.ensure_future(_client_gone(request)) if request is not None else None
    try:
        if watcher is None:
            return await asyncio.shield(work)
        done, _pending = await asyncio.wait({work, watcher}, return_when=asyncio.FIRST_COMPLETED)
        if work in done:
            return work.result()
        raise Cancelled()
    finally:
        if watcher is not None:
            watcher.cancel()
        _leave(key, flight)
        if not work.done():
            # Nobody awaits it here any more; keep its exception from being reported as unretrieved.
            work.add_done_callback(lambda f: f.cancelled() or f.exception())


def cancelled_response():
    """What a route returns for a client that has gone (nobody reads it)."""
    from utils.responses import ORJSONResponse
    return ORJSONResponse({"success": False, "cancelled": True, "error": "Cancelled"}, status_code=499)


def file_identity(paths) -> tuple:
    """(path, mtime_ns, size) per local file; a remote one by its path."""
    out = []
    for path in paths or ():
        path = str(path)
        try:
            st = os.stat(path)
            out.append((path, st.st_mtime_ns, st.st_size))
        except OSError:
            out.append((path, None, None))
    return tuple(out)


def dataset_identity(state, dataset_ids) -> tuple:
    """Each dataset's files and generation: a new file or a reload is a new key."""
    from services.dataset_generation import dataset_generation
    out = []
    for dataset_id in dataset_ids or ():
        dataset = state.get_dataset(dataset_id) if hasattr(state, "get_dataset") else None
        paths = list(getattr(dataset, "paths", None) or ([getattr(dataset, "path", None)] if getattr(dataset, "path", None) else []))
        out.append((str(dataset_id), dataset_generation(state, dataset_id), file_identity(paths)))
    return tuple(out)
