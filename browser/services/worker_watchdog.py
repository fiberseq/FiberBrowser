"""Worker processes exit when the server that started them is gone.

Every multiprocessing worker FiberBrowser spawns (live nucleosome compute, parallel read decode, the record-count
helper, reconstruction workers) calls ``watch_parent`` first. A daemon thread checks the parent process id; once it
changes (the server exited or was killed, and the worker was re-parented), the worker exits at once instead of
finishing its share and lingering, together with the resource tracker it keeps alive.
"""
from __future__ import annotations

import os
import threading

#: seconds between checks
INTERVAL = 1.0

_started = False
_lock = threading.Lock()


def _parent_gone(parent: int) -> bool:
    return os.getppid() != parent


def watch_parent(interval: float = INTERVAL) -> None:
    """Start the watch (once per process). In the server process itself (not a spawned child) it does nothing."""
    global _started
    import multiprocessing
    if multiprocessing.parent_process() is None:
        return
    with _lock:
        if _started:
            return
        _started = True
    parent = os.getppid()

    def run():
        import time
        while True:
            time.sleep(interval)
            if _parent_gone(parent):
                os._exit(0)
    threading.Thread(target=run, name='fiberbrowser-parent-watch', daemon=True).start()
