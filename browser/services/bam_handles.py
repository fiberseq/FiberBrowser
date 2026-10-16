"""Shared BAM readers with bounded, synchronized native handle ownership."""
from __future__ import annotations

import os
import threading
import time
from collections import OrderedDict
from contextlib import contextmanager
from typing import Optional

from services.file_handles import handles, file_stamp


def bam_index_candidates(bam_path: str) -> tuple[str, ...]:
    """Index files pysam accepts for a BAM: ``x.bam.bai``, ``x.bai``, ``x.bam.csi``
    and ``x.csi``. The stem comes from the path's own extension (any case), so
    ``x.BAM`` never yields itself and a ``.bam`` elsewhere in the path is kept."""
    stem = os.path.splitext(bam_path)[0]
    return (bam_path + ".bai", stem + ".bai", bam_path + ".csi", stem + ".csi")


def local_bam_index_exists(bam_path: str) -> bool:
    return any(os.path.exists(index) for index in bam_index_candidates(bam_path))


REMOTE_VERSION_CHECK_S = 30.0
_remote_versions = OrderedDict()
_remote_version_lock = threading.Lock()
_bam_threads = 1
_transient_pools = threading.BoundedSemaphore(max(1, min(2, (os.cpu_count() or 1) // 4)))


def configure_bam_threads(threads):
    """Use the machine's decompression limit on the next shared-reader lease."""
    global _bam_threads
    limit = max(1, int(threads))
    if limit < _bam_threads:
        handles.discard(kind='bam')
    _bam_threads = limit


def get_bam_handle(filepath: str, *, threads: int = 1) -> Optional[object]:
    """Get a shared reader; fetch iterators retain an exclusive lease until closed."""
    return _get_bam_handle(filepath, threads=threads, cache=handles)


@contextmanager
def transient_bam_handle(filepath: str, *, threads: int):
    """Threaded foreground decompression without retaining an idle native pool.

    A single request owns this reader, so an outward fill's paused cursor is
    untouched. Closing the scope releases the BAM and all decompression threads,
    including after cancellation or an exception.
    """
    from services.file_handles import HandleCache
    from services.background_work import checkpoint
    while not _transient_pools.acquire(timeout=.05):
        checkpoint()
    cache = HandleCache(max_entries=1)
    try:
        checkpoint()
        reader = _get_bam_handle(filepath, threads=threads, cache=cache)
        if reader is None:
            yield None
        else:
            with reader.lease() as native:
                try:
                    yield native
                finally:
                    # This reader is exclusively owned by this scope. A saved
                    # traceback/iterator must not keep its native pool alive.
                    native.close()
    finally:
        try:
            cache.discard()
        finally:
            _transient_pools.release()


def _get_bam_handle(filepath, *, threads, cache):
    from services.remote_sources import is_source_ref
    from services.remote_sources import opening as op

    remote = is_source_ref(filepath) or op.is_s3_ref(filepath)

    def version():
        if not is_source_ref(filepath):
            from services.lab.paths import confine_alignment
            confine_alignment(filepath, 'rb', {})
        if "://" not in filepath:
            return file_stamp(filepath, bam_index_candidates(filepath)), min(threads, _bam_threads)
        url = op.resolve_open_path(filepath) if is_source_ref(filepath) else op.live_url(filepath) if remote else filepath
        if not op.is_remote_url_bam(filepath):
            return url, min(threads, _bam_threads)
        now = time.monotonic()
        with _remote_version_lock:
            checked, stamp = _remote_versions.get(filepath, (float('-inf'), None))
        if now - checked > REMOTE_VERSION_CHECK_S:
            try:
                stamp = op.remote_version(filepath)
            except Exception:
                pass
            with _remote_version_lock:
                _remote_versions[filepath] = (now, stamp)
                _remote_versions.move_to_end(filepath)
                while len(_remote_versions) > 128:
                    _remote_versions.popitem(last=False)
        return url, stamp, min(threads, _bam_threads)

    def open_reader():
        from services.htslib_quiet import quiet_htslib
        with quiet_htslib():
            handle = op.open_alignment_file(filepath, "rb", threads=min(threads, _bam_threads))
        # htslib can open the BAM but fail to open its index under FD pressure.
        # Never cache that half-open reader as a successful indexed open.
        if "://" not in filepath and local_bam_index_exists(filepath) and hasattr(handle, 'has_index'):
            try:
                if not handle.has_index():
                    raise OSError('Could not open BAM index')
            except Exception:
                handle.close()
                raise
        return handle

    try:
        return cache.get('bam', filepath, open_reader, version,
                           max_idle=op.REMOTE_HANDLE_MAX_IDLE if remote else None)
    except OSError:
        return None


def discard_bam_handle(filepath: str) -> None:
    """Retire a broken or removed file across every worker pool."""
    handles.discard(filepath, kind='bam')


def close_all_bam_handles() -> None:
    """Retire all BAM readers, closing active iterators on their final release."""
    handles.discard(kind='bam')
    with _remote_version_lock:
        _remote_versions.clear()


def check_bam_index(bam_path: str) -> Optional[str]:
    """Return a local BAM index warning message, or None when available/not needed."""
    from utils.validation import is_url

    if is_url(bam_path):
        return None
    if not os.path.exists(bam_path):
        return f"BAM file not found: {bam_path}"

    if not local_bam_index_exists(bam_path):
        basename = os.path.basename(bam_path)
        return (
            f"BAM index (.bai) not found for {basename}. "
            f"Run 'samtools index {basename}' to create one."
        )
    return None
