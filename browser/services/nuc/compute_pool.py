"""Live nucleosome outputs on worker processes.

``compute_regions`` (``services.nuc.live``) decides, in the server process, which records of a region need
computing. Each worker re-reads the region with the same scan iterator (so record SHA-256 and identical-record
occurrence come out exactly as in the server), computes its share of those records with the same FiberHMM call
and streams the outputs back. The server stores them in record order, so the store ends up as a serial compute
leaves it. Records are independent: the outputs do not depend on which process computes them.
"""
from __future__ import annotations

import multiprocessing
import queue
import threading
from concurrent.futures import ProcessPoolExecutor
from typing import Optional

#: records per message from a worker
BATCH = 8

_messages = None
_cancel = None


def _initialize(messages, cancel):
    global _messages, _cancel
    from services.worker_watchdog import watch_parent
    watch_parent()              # exit with the server, never linger as an orphan
    _messages, _cancel = messages, cancel
    # A cancelled consumer stops draining the pipe; workers must be able to exit without flushing it.
    _messages.cancel_join_thread()
    import os
    for name in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS',
                 'NUMBA_NUM_THREADS'):
        os.environ.setdefault(name, '1')


def slim_molecule(mol):
    """The molecule without its cumulative count arrays (two int64 arrays of the molecule's length; they are
    rebuilt from ``hits``/``informative`` on first use, with identical values)."""
    if mol is not None and getattr(mol, '_cum_hit', None) is not None:
        mol._cum_hit = None
        mol._cum_inf = None
    return mol


def _compute_share(task):
    """Worker: compute the records at ``task['indices']`` (positions in the region's record order)."""
    import pysam
    from fiberhmm.scan.reads import iter_records
    from .live import _decode_context, record_outputs
    path, chrom, start, end = task['path'], task['chrom'], task['start'], task['end']
    want = task['indices']          # ascending positions -> expected (sha, occ)
    sent = 0
    batch = []

    def flush():
        while True:
            if _cancel.is_set():
                raise InterruptedError('cancelled')
            try:
                _messages.put((task['tag'], batch), timeout=0.05)
                return
            except queue.Full:
                pass

    with pysam.AlignmentFile(path, 'rb') as bam:
        ctx = _decode_context(path, bam.header, task['params'], task['params_key'])
        nxt = 0
        keys = sorted(want)
        for k, (read, sha, occ) in enumerate(iter_records(bam, chrom, start, end, task['filters'])):
            if nxt >= len(keys):
                break
            if k != keys[nxt]:
                continue
            nxt += 1
            if _cancel.is_set():
                raise InterruptedError('cancelled')
            if (sha, occ) != want[k]:
                raise RuntimeError(f'record order differs in a worker at position {k}')
            out, mol, res, why = record_outputs(read, task['input_index'], ctx, task['params'], task['calibration'],
                                                task['regularity'], calibration_digest=task['calibration_digest'])
            if out is None:
                batch.append((k, None, None, None, why))
            else:
                batch.append((k, out, slim_molecule(mol) if task['keep_results'] else None,
                              res if task['keep_results'] else None, 'ok'))
            sent += 1
            if len(batch) >= BATCH:
                flush()
                batch = []
        if batch:
            flush()
    if nxt < len(keys):
        raise RuntimeError('a worker did not find every record it was given')
    return sent


class ComputePool:
    """Worker processes for one nucleosome job (spawned on first use, stopped by ``close``)."""

    def __init__(self, workers: int):
        self.workers = max(1, int(workers))
        self._pool = None
        self._messages = None
        self._cancel = None
        self._lock = threading.Lock()
        self._serial = 0

    def _ensure(self):
        if self._pool is None:
            context = multiprocessing.get_context('spawn')
            self._messages = context.Queue(maxsize=4 * self.workers)
            self._cancel = context.Event()
            self._pool = ProcessPoolExecutor(max_workers=self.workers, mp_context=context,
                                             initializer=_initialize, initargs=(self._messages, self._cancel))

    def run(self, base: dict, todo, *, on_result, cancel=None):
        """Compute ``todo`` ([(position, (sha, occ))], ascending positions) and call ``on_result(position, out,
        mol, res, why)`` in position order. ``base`` holds the region and compute inputs shared by every share."""
        if not todo:
            return
        with self._lock:
            self._ensure()
            self._serial += 1
            tag = self._serial
            n = min(self.workers, len(todo))
            # Interleaved shares: every worker moves through the region at the same pace, so results arrive
            # roughly in position order and the reorder buffer stays small.
            shares = [dict(base, tag=tag, indices={k: key for k, key in todo[w::n]}) for w in range(n)]
            futures = [self._pool.submit(_compute_share, share) for share in shares]
            order = [k for k, _key in todo]
            ready = {}
            nxt = 0
            idle_after_done = 0
            try:
                while nxt < len(order):
                    if cancel is not None and cancel.is_set():
                        raise InterruptedError('cancelled')
                    try:
                        got_tag, items = self._messages.get(timeout=0.05)
                    except queue.Empty:
                        for f in futures:
                            if f.done() and f.exception() is not None:
                                raise f.exception()
                        if all(f.done() for f in futures):
                            # Every worker returned; their last messages may still be in the pipe.
                            idle_after_done += 1
                            if idle_after_done > 200:
                                raise RuntimeError('nucleosome workers stopped before finishing') from None
                        continue
                    if got_tag != tag:
                        continue
                    for item in items:
                        ready[item[0]] = item
                    while nxt < len(order) and order[nxt] in ready:
                        on_result(*ready.pop(order[nxt]))
                        nxt += 1
                for f in futures:
                    f.result()
            except BaseException:
                self._abort()
                raise

    def _abort(self):
        """Stop the workers of a cancelled or failed run (the next run spawns new ones)."""
        pool, messages, cancel = self._pool, self._messages, self._cancel
        self._pool = self._messages = self._cancel = None
        if cancel is not None:
            cancel.set()
        if pool is not None:
            pool.shutdown(wait=True, cancel_futures=True)
        if messages is not None:
            messages.close()

    def close(self):
        with self._lock:
            self._abort()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def compute_workers(state, records_hint: Optional[int] = None) -> int:
    """Worker processes for a nucleosome compute: the machine profile's decode workers (High performance) or
    background workers (Standard); one (serial, in the server process) in Low memory mode."""
    import os
    perf = getattr(state, 'performance', None) or {}
    if perf.get('effective') == 'low':
        return 1
    n = max(int(perf.get('decode_workers') or 1), int(perf.get('workers') or 1))
    return max(1, min(n, (os.cpu_count() or 1) - 1 or 1))
