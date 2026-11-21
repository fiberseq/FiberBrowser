"""Alignment record counts over a region (``bam.count``) on a helper process.

pysam releases the GIL around each record it reads, and takes it back for the next one: while the server's other
threads are busy in Python (a read load), each record waits for the GIL's switch interval, and counting the few
thousand long records of a view takes tens of seconds instead of a fraction of one. The "not analysed" answer
(``observations._not_analysed``) counts on a single helper process instead (the same ``bam.count``, so the same
number), started in the background when the panel first asks; any failure counts here.
"""
from __future__ import annotations

import threading
from typing import Optional

#: count on the helper process (False: always in the server process)
USE_HELPER = True
#: seconds to wait for the helper before counting here
HELPER_TIMEOUT = 30.0

#: helper failures (timeouts, crashes) before counting stays in this process for the server's life
MAX_HELPER_FAILURES = 3

_LOCK = threading.Lock()
_POOL = None
_BROKEN = False
_FAILURES = 0


def count_records(path: str, chrom: str, start: int, end: int, filters: Optional[dict] = None) -> int:
    """The records of one file over ``[start, end)`` (``chrom``: the BAM's own contig name): ``bam.count`` without
    ``filters``, else those passing the read policy's filters (FiberHMM ``passes``, as the cohort resolves them)."""
    import pysam
    with pysam.AlignmentFile(path, 'rb') as bam:
        if not filters:
            return int(bam.count(chrom, int(start), int(end)))
        from fiberhmm.scan.reads import passes
        return sum(1 for r in bam.fetch(chrom, max(0, int(start)), int(end)) if passes(r, filters))


def _pool():
    global _POOL
    with _LOCK:
        if _POOL is None and not _BROKEN:
            import multiprocessing
            from concurrent.futures import ProcessPoolExecutor
            _POOL = ProcessPoolExecutor(max_workers=1, mp_context=multiprocessing.get_context('spawn'),
                                        initializer=_initialize)
            _register_exit()
        return _POOL


def _initialize() -> None:
    """The helper exits with the server (``services.worker_watchdog``)."""
    from services.worker_watchdog import watch_parent
    watch_parent()


_EXIT_REGISTERED = [False]


def _register_exit() -> None:
    """Shut the helper down when the server process exits (also the server's lifespan shutdown and tests'
    teardown call ``shutdown``)."""
    if not _EXIT_REGISTERED[0]:
        import atexit
        atexit.register(shutdown, True)
        _EXIT_REGISTERED[0] = True


def warm() -> None:
    """Start the helper in the background (its first count would otherwise pay the process start)."""
    if not USE_HELPER or _BROKEN:
        return
    try:
        pool = _pool()
        if pool is not None:
            pool.submit(int, 0)
    except Exception:      # noqa: BLE001 - counts fall back to this process
        pass


def count(path: str, chrom: str, start: int, end: int, filters: Optional[dict] = None) -> int:
    """The record count (``count_records``), on the helper process when it is available, else here (identical
    either way)."""
    if USE_HELPER and not _BROKEN:
        import concurrent.futures as cf
        pool = None
        try:
            pool = _pool()
            if pool is not None:
                return int(pool.submit(count_records, path, chrom, start, end, filters).result(timeout=HELPER_TIMEOUT))
        except (TimeoutError, cf.TimeoutError):     # (one class since Python 3.11)
            _discard(pool)
            return count_records(path, chrom, start, end, filters)
        except (OSError, ValueError, KeyError):
            raise                      # the file's own error: as counting here would raise it
        except Exception:      # noqa: BLE001 - a broken or slow helper: replaced (or, after repeated failures, off)
            _discard(pool)
    return count_records(path, chrom, start, end, filters)


def _discard(pool) -> None:
    """Stop a failed or hung helper (its worker killed: a hung count never holds the file or a process on) so the
    next count starts a new one; after ``MAX_HELPER_FAILURES`` failures counts stay in this process."""
    global _POOL, _BROKEN, _FAILURES
    with _LOCK:
        if pool is not None and _POOL is pool:
            _POOL = None
        _FAILURES += 1
        if _FAILURES >= MAX_HELPER_FAILURES:
            _BROKEN = True
    if pool is None:
        return
    for proc in list((getattr(pool, '_processes', None) or {}).values()):
        try:
            proc.kill()
        except Exception:      # noqa: BLE001 - already gone
            pass
    try:
        pool.shutdown(wait=False, cancel_futures=True)
    except Exception:      # noqa: BLE001 - a broken pool
        pass


def shutdown(wait: bool = True) -> None:
    """Stop the helper process (``wait``: until it has exited); the next count starts a new one."""
    global _POOL
    with _LOCK:
        pool, _POOL = _POOL, None
    if pool is not None:
        pool.shutdown(wait=wait, cancel_futures=True)
