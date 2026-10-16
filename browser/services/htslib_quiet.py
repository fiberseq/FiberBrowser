"""Silence htslib's own messages while a URL that must not be printed is opened.

htslib writes diagnostics such as ``[E::hts_open_format] Failed to open file
"<url>"`` straight to the process's standard error (file descriptor 2),
bypassing Python, so the redaction of ``sys.stderr`` and log records never
sees them. Opening a pre-signed link or a cluster file therefore runs inside
``quiet_htslib()``, which sets htslib's verbosity to 0 for as long as any
such open is in progress.

The verbosity is one process-wide setting. Calls nest and overlap safely
across threads: the first one in saves the level and the last one out
restores it (separate save/restore pairs in different threads could leave it
at 0 for good). Messages from other files opened during that window are
silenced too; Python still raises for every failure.
"""
from __future__ import annotations

import threading
from contextlib import contextmanager

_lock = threading.Lock()
_depth = 0
_saved: int | None = None


@contextmanager
def quiet_htslib():
    global _depth, _saved
    import pysam

    with _lock:
        if _depth == 0:
            _saved = pysam.set_verbosity(0)
        _depth += 1
    try:
        yield
    finally:
        with _lock:
            _depth -= 1
            if _depth == 0 and _saved is not None:
                pysam.set_verbosity(_saved)
                _saved = None
