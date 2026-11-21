"""Independent BAM tag decoding into compact blocks on worker processes."""
from __future__ import annotations

import multiprocessing
import queue
import threading
from concurrent.futures import ProcessPoolExecutor

_messages = None
_cancel = None
# Decode pools in flight: by default one at a time. A pool that names a
# ``capacity`` shares it with other such pools (a view's datasets decoded
# together), each taking its own worker count.
_pools = threading.Condition()
_pool_workers = 0
_exclusive = False


def _enter_pool(workers, capacity):
    global _pool_workers, _exclusive
    from services.background_work import checkpoint
    while True:
        with _pools:
            if capacity is None:
                if not _exclusive and _pool_workers == 0:
                    _exclusive = True
                    return
            elif not _exclusive and (_pool_workers == 0 or _pool_workers + workers <= capacity):
                _pool_workers += workers
                return
            _pools.wait(0.05)
        checkpoint()


def _leave_pool(workers, capacity):
    global _pool_workers, _exclusive
    with _pools:
        if capacity is None:
            _exclusive = False
        else:
            _pool_workers -= workers
        _pools.notify_all()


def _initialize(messages, cancel):
    global _messages, _cancel
    from services.worker_watchdog import watch_parent
    watch_parent()              # exit with the server, never linger as an orphan
    _messages, _cancel = messages, cancel
    # A cancelled consumer stops draining the pipe. Workers must be able to
    # exit without waiting for their queue feeder to flush discarded blocks.
    _messages.cancel_join_thread()
    from services.file_handles import handles
    from services.bam_handles import configure_bam_threads
    handles.resize(1)
    configure_bam_threads(1)


def _stream_partition(path, chrom, start, end, options, partition, source_index=0):
    from services.packed_reads import packed_block_sink
    from services.signal_windows import signal_window_sink
    from services.background_work import cancel_scope, checkpoint
    def send(block):
        while True:
            checkpoint()
            try:
                _messages.put((source_index, block), timeout=0.05)
                return
            except queue.Full:
                pass
    sink = packed_block_sink.set(send)
    windows = []
    evidence_sink = signal_window_sink.set(windows.append)
    try:
        with cancel_scope(_cancel):
            return len(decode_bam_partition(path, chrom, start, end, options, partition)), windows
    finally:
        packed_block_sink.reset(sink)
        signal_window_sink.reset(evidence_sink)


def decode_bam_partition(path, chrom, start, end, options, partition):
    from services.packed_reads import packed_decode, decode_partition, packed_display
    from services.compact_read_loader import build_compact_reads_from_bam
    from services.gc_tuning import configure_gc
    from services.read_binary import binary_read_context
    from services.background_work import configure_workers, configure_worker_threads
    from services.signal_evidence import signal_filters_for_request
    configure_gc()
    # Each process owns one decode partition; native pools must not multiply it.
    configure_workers(1, 1)
    configure_worker_threads()
    options = dict(options)
    indexed = packed_display.set(options.pop('_packed_display', False))
    filters = options.pop('_signal_filters', None)
    binary = binary_read_context.set(options.pop('_binary_transport', False))
    # Only these read names (a first paint's drawn reads, services/first_paint.py): the server's explicit scope.
    only_ids = options.pop('_only_ids', None)
    from services.read_sampling import Sampler, sampling
    from contextlib import nullcontext
    scope = sampling(Sampler(1, only_ids=frozenset(only_ids), exact_ids=True)) if only_ids is not None else nullcontext()
    compact = packed_decode.set(True)
    part = decode_partition.set(partition)
    try:
        with signal_filters_for_request(filters), scope:
            return build_compact_reads_from_bam(path, chrom, start, end, **options)
    finally:
        from services.bam_handles import discard_bam_handle
        discard_bam_handle(path)
        binary_read_context.reset(binary)
        decode_partition.reset(part)
        packed_decode.reset(compact)
        packed_display.reset(indexed)


def parallel_bam_reads(path, chrom, start, end, options, workers, *, capacity=None):
    """Stream bounded batches; name partitions preserve duplicate occurrences.
    ``capacity``: run alongside other pools that name it, within that many workers in all."""
    return _parallel_jobs([(path, chrom, start, end, options, (i, workers), 0)
                           for i in range(workers)], workers, capacity=capacity)


def parallel_bam_files(paths, chrom, start, end, options, workers, *, retain_packed=False):
    """Decode pooled files together, retaining file order and physical duplicates."""
    return _parallel_jobs([(path, chrom, start, end, opt, (0, 1), index)
                           for index, (path, opt) in enumerate(zip(paths, options))],
                          min(workers, len(paths)), retain_packed=retain_packed)


def _parallel_jobs(jobs, workers, *, retain_packed=False, capacity=None):
    from services.background_work import checkpoint
    from services.packed_reads import _iter_block
    from services.read_stream import decoded_read_sink
    from services.read_binary import binary_read_context
    from services.signal_evidence import active_signal_filters
    stream = decoded_read_sink.get()
    retain_packed = retain_packed and stream is None
    shared = {'_binary_transport': binary_read_context.get(), '_signal_filters': active_signal_filters()}
    if retain_packed:
        shared['_packed_display'] = True
    _enter_pool(workers, capacity)
    messages = cancel = pool = None
    try:
        context = multiprocessing.get_context('spawn')
        messages = context.Queue(maxsize=4)
        cancel = context.Event()
        pool = ProcessPoolExecutor(max_workers=workers, mp_context=context,
                                   initializer=_initialize, initargs=(messages, cancel))
        futures = [pool.submit(_stream_partition, path, chrom, start, end, {**options, **shared}, partition, source)
                   for path, chrom, start, end, options, partition, source in jobs]
        reads = []
        parts = [[] for _ in jobs] if retain_packed else None
        received = 0
        while True:
            checkpoint()
            try:
                source, block = messages.get(timeout=0.05)
            except queue.Empty:
                if all(f.done() for f in futures):
                    completed = [f.result() for f in futures]
                    expected = sum(count for count, _ in completed)
                    if received == expected:
                        checkpoint()
                        for _, windows in completed:
                            for window in windows:
                                window.publish()
                        break
                continue
            if retain_packed:
                parts[source].append(block)
                received += len(block[1].bounds)
                continue
            for read in _iter_block(block):
                read['_fiberbrowser_source_file'] = source
                reads.append(read)
                if stream is not None:
                    stream.append(read)
                received += 1
        if retain_packed:
            from services.packed_reads import PackedReads
            return PackedReads.from_display_blocks(part for source in parts for part in source)
        reads.sort(key=lambda read: (read.pop('_fiberbrowser_source_file'), read.pop('_fiberbrowser_source_order')))
        return reads
    finally:
        try:
            if cancel is not None:
                cancel.set()
            if pool is not None:
                pool.shutdown(wait=True, cancel_futures=True)
        finally:
            try:
                if messages is not None:
                    messages.close()
            finally:
                _leave_pool(workers, capacity)
