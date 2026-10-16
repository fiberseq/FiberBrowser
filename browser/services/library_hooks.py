"""Record the files a user opens in the Library, off the request path.

``note_dataset_opened`` / ``note_plasmid_map_opened`` are called where
datasets and plasmid maps register (``BrowserState``); they queue the files
and return at once. A daemon worker reads each header and stores it. Nothing
is recorded on a ``--public`` server or in a tour-tab sandbox (their datasets
are the host's), for URLs, drag-and-drop upload copies, or the bundled demo.
"""
from __future__ import annotations

import logging
import os
import queue
import threading
from typing import Iterable, Optional

log = logging.getLogger(__name__)

DISABLE_ENV = "FIBERBROWSER_LIBRARY_DISABLE"
_queue: "queue.Queue[tuple[str, str, str]]" = queue.Queue()
_worker: Optional[threading.Thread] = None
_worker_lock = threading.Lock()
_pending = 0
_pending_lock = threading.Condition()
_DEMO_DIR = os.path.realpath(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "demo"))


def _enabled() -> bool:
    if os.environ.get(DISABLE_ENV):
        return False
    try:
        from services.runtime import get_public_mode
        return not get_public_mode()
    except Exception:
        return False


def _skip(path: str) -> bool:
    if not isinstance(path, str) or not path:
        return True
    if "://" in path:
        # Files on a connected cluster are recorded by reference (ssh://host/path);
        # other URLs (https, s3) are not.
        from services.remote_sources import is_source_ref
        return not is_source_ref(path)
    real = os.path.realpath(path)
    if not os.path.isfile(real):
        return True
    try:
        from services.upload_store import upload_dir, LEGACY_UPLOAD_DIR
        for folder in (upload_dir(), LEGACY_UPLOAD_DIR):
            folder = os.path.realpath(folder)
            if real.startswith(folder + os.sep):
                return True
    except Exception:
        pass
    return real.startswith(_DEMO_DIR + os.sep)


def _work() -> None:
    global _pending
    from services import library_inspect, library_store
    while True:
        path, kind, source = _queue.get()
        try:
            info = library_inspect.inspect_file(path, kind)
            if info.get("error") != "file not found":
                library_store.record(info, source, opened=True)
        except Exception as exc:  # the Library must never break loading data
            log.warning("Library: could not record %s: %s", path, exc)
        finally:
            with _pending_lock:
                _pending -= 1
                _pending_lock.notify_all()


def _submit(paths: Iterable[str], kind: Optional[str], source: str = "opened") -> int:
    global _worker, _pending
    if not _enabled():
        return 0
    from services.library_inspect import file_kind
    count = 0
    for path in paths:
        if _skip(path):
            continue
        file_type = kind or file_kind(path)
        if file_type is None:
            continue
        with _pending_lock:
            _pending += 1
        _queue.put((path if "://" in path else os.path.abspath(path), file_type, source))
        count += 1
    if count:
        with _worker_lock:
            if _worker is None or not _worker.is_alive():
                _worker = threading.Thread(target=_work, name="library-record", daemon=True)
                _worker.start()
    return count


def note_dataset_opened(dataset) -> int:
    try:
        paths = list(getattr(dataset, "paths", None) or [getattr(dataset, "path", None)])
        return _submit([p for p in paths if p], None)
    except Exception as exc:
        log.warning("Library: %s", exc)
        return 0


def note_plasmid_map_opened(path: Optional[str]) -> int:
    try:
        return _submit([path] if path else [], "plasmid_map")
    except Exception as exc:
        log.warning("Library: %s", exc)
        return 0


def wait_idle(timeout: float = 10.0) -> bool:
    """For tests: until every queued file is recorded."""
    with _pending_lock:
        return _pending_lock.wait_for(lambda: _pending == 0, timeout)
