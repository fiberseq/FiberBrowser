"""Visible read requests stop when their client leaves, including batched views."""
from __future__ import annotations

import asyncio
import threading

from services.background_work import Cancelled, cancel_scope, checkpoint, interactive_read
from services.client_disconnect import wait_for_disconnect


async def run_read_work(request, builders):
    """Run each dataset off the event loop with one request cancellation token.

    Completed caches belong to the session. Only this request's unfinished
    decode/projection is cancelled; speculative neighborhood fills have their
    own lifetime and token.
    """
    cancel = threading.Event()

    def run(build):
        with cancel_scope(cancel), interactive_read():
            checkpoint()
            return build()

    work = asyncio.gather(*(asyncio.to_thread(run, build) for build in builders))
    watcher = asyncio.create_task(wait_for_disconnect(request)) if request is not None else None
    try:
        if watcher is None:
            return await asyncio.shield(work)
        done, _ = await asyncio.wait({work, watcher}, return_when=asyncio.FIRST_COMPLETED)
        if work in done:
            return work.result()
        # Surface a watcher failure rather than silently cancelling a live load.
        watcher.result()
        raise Cancelled()
    finally:
        cancel.set()
        if watcher is not None:
            watcher.cancel()
        # Worker threads stop at a checkpoint; cancelling their asyncio future
        # would hide their completion and cannot stop the actual thread.
        if not work.done():
            work.add_done_callback(lambda f: f.cancelled() or f.exception())
