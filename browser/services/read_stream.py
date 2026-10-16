"""Bounded binary read frames, with a completion record before cache publication."""
from __future__ import annotations

import asyncio
import concurrent.futures
import contextvars
import queue
import struct
import threading
from contextlib import contextmanager

from starlette.responses import StreamingResponse
from services.background_work import Cancelled, cancel_scope, checkpoint, interactive_read
from services.read_binary import binary_read_context, encode_reads, _wire_payload

MEDIA_TYPE = 'application/vnd.fiberbrowser.reads.stream.v1'
read_sink = contextvars.ContextVar('read_stream_sink', default=None)
decoded_read_sink = contextvars.ContextVar('decoded_read_sink', default=None)
_prefetch_pool = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix='read-prefetch')
_prefetch_lock = threading.Lock()
_prefetch_events = set()
_prefetch_active = contextvars.ContextVar('read_prefetch_active', default=False)


def is_prefetch() -> bool:
    return _prefetch_active.get()


def cancel_prefetches():
    """Explicit resource-policy changes discard unfinished speculative reads."""
    with _prefetch_lock:
        for event in _prefetch_events:
            event.set()


@contextmanager
def prefetch_scope(event, sample_level=None):
    token = _prefetch_active.set(True)
    from services.read_sampling import prefetch_sample_level
    sample_token = prefetch_sample_level.set(sample_level)
    with _prefetch_lock:
        _prefetch_events.add(event)
    try:
        from services.background_work import speculative_read
        with speculative_read():
            yield
    finally:
        _prefetch_active.reset(token)
        prefetch_sample_level.reset(sample_token)
        with _prefetch_lock:
            _prefetch_events.discard(event)


class ReadStream:
    def __init__(self, send, options):
        from services.sv_events import normalize_min_sv_len
        self.send = send
        self.options = options
        self.min_sv_len = normalize_min_sv_len(options.get('min_sv_len'))
        self.pending = []
        self.indices = {}
        self.sent = False

    def append(self, read):
        self.indices[id(read)] = len(self.indices)
        self.pending.append(read)
        # A small first frame gets rows on screen; later frames amortize packing.
        if len(self.pending) >= (2048 if self.sent else 256):
            self.flush()

    def flush(self):
        if not self.pending:
            return
        from services.read_response_payloads import compact_reads_response_payload
        from services.sv_events import finalize_sv_payload
        reads, self.pending = self.pending, []
        payload = compact_reads_response_payload(display_reads=reads,
            width=self.options['end'] - self.options['start'], dataset_id=self.options['dataset_id'],
            working_count=0, total_in_scope=0, total_spanning=0)
        payload.pop('_read_stream_order', None)
        payload['reads'] = finalize_sv_payload(payload['reads'], self.options['start'], self.options['end'],
            self.min_sv_len)
        self.send(payload)
        self.sent = True

    def finish(self, payload):
        self.flush()
        if self.indices:
            order = payload.get('_read_stream_order')
            if order is None or len(order) != len(payload['reads']) or any(index is None for index in order):
                raise ValueError('Read stream cohort changed before completion')
            payload = {key: value for key, value in payload.items()
                       if key not in {'reads', '_read_bounds', '_read_terminals', '_read_stream_order'}}
            payload.update(reads=[], _stream_order=order)
        self.send({**payload, '_stream_complete': True})


def stream_reads_response(build, options, *, prefetch=False, prefetch_sample_level=None):
    """Decode and pack on a worker; retain at most two unsent frames."""
    messages = queue.Queue(maxsize=2)
    cancel = threading.Event()

    def put(value):
        while not cancel.is_set():
            try:
                messages.put(value, timeout=0.05)
                return
            except queue.Full:
                pass
        raise Cancelled()

    def send(payload):
        checkpoint()
        data = encode_reads(_wire_payload(payload))
        put(struct.pack('<I', len(data)) + data)

    def run():
        token = binary_read_context.set(True)
        stream = ReadStream(send, options)
        sink_token = read_sink.set(stream)
        try:
            with cancel_scope(cancel), (prefetch_scope(cancel, prefetch_sample_level) if prefetch else interactive_read()):
                if prefetch:
                    from services.background_work import yield_to_foreground
                    yield_to_foreground()
                checkpoint()
                stream.finish(build(**options))
        except Cancelled:
            pass
        except Exception:
            import logging
            logging.getLogger(__name__).exception('Read stream failed')
            try:
                send({'reads': [], '_stream_error': 'Could not load the complete read set'})
            except Cancelled:
                pass
        finally:
            read_sink.reset(sink_token)
            binary_read_context.reset(token)
            # The consumer also checks worker completion: cancellation never
            # publishes a partial cohort, nor waits on a full queue to finish.

    async def body():
        context = contextvars.copy_context()
        loop = asyncio.get_running_loop()
        work = loop.run_in_executor(_prefetch_pool if prefetch else None, context.run, run)
        try:
            while True:
                try:
                    frame = messages.get_nowait()
                except queue.Empty:
                    if work.done():
                        await work
                        break
                    await asyncio.sleep(0.005)
                    continue
                yield frame
        finally:
            cancel.set()

    return StreamingResponse(body(), media_type=MEDIA_TYPE, headers={'Vary': 'Accept', 'X-Accel-Buffering': 'no'})
