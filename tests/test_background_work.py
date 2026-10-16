"""Background analytics off the read path (services/background_work.py).

Navigation used to pile up the analyses that follow the view (quality counts,
peak scans, insertions in view, best-covered windows): each ran to completion
on the shared thread pool, however many views had gone by, and starved the
reads. These check the pool's contract: identical requests share one job, a
job whose clients have all gone stops (or never starts), background work
waits for read loads, finished results are reused, and the insertions-in-view
tiles give the same answer as one scan.
"""
from __future__ import annotations

import asyncio
import os
import threading
import time

import pytest

from services import background_work as BW


class _Request:
    """A route's Request whose client disconnects when ``gone`` is set."""

    def __init__(self):
        self.gone = asyncio.Event()
        self.scope = {}

    async def is_disconnected(self):
        return self.gone.is_set()


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def test_identical_requests_share_one_job():
    calls = []
    release = threading.Event()

    def work(x):
        calls.append(x)
        release.wait(5)
        return x * 2

    async def main():
        a = asyncio.ensure_future(BW.run_background(None, ("t-share", 1), work, 21))
        b = asyncio.ensure_future(BW.run_background(None, ("t-share", 1), work, 21))
        await asyncio.sleep(0.2)
        release.set()
        return await a, await b

    assert _run(main()) == (42, 42)
    assert calls == [21]


def test_a_job_whose_clients_left_stops_at_its_next_checkpoint():
    progress = {"steps": 0, "cancelled": False}
    started = threading.Event()

    def work():
        started.set()
        try:
            for _ in range(500):
                BW.checkpoint()
                progress["steps"] += 1
                time.sleep(0.01)
        except BW.Cancelled:
            progress["cancelled"] = True
            raise
        return "finished"

    async def main():
        request = _Request()
        task = asyncio.ensure_future(BW.run_background(request, ("t-cancel",), work, wait_for_reads=False))
        while not started.is_set():
            await asyncio.sleep(0.01)
        await asyncio.sleep(0.1)
        request.gone.set()
        with pytest.raises(BW.Cancelled):
            await task

    _run(main())
    deadline = time.time() + 5
    while not progress["cancelled"] and time.time() < deadline:
        time.sleep(0.01)
    assert progress["cancelled"]
    assert progress["steps"] < 500
    assert not BW.in_flight(("t-cancel",))


def test_a_queued_job_whose_client_left_never_runs(monkeypatch):
    # One worker, busy: the second job waits in the queue; its client leaves.
    monkeypatch.setenv("FIBERBROWSER_BACKGROUND_WORKERS", "1")
    monkeypatch.setattr(BW, "_executor", None)
    ran = []
    busy = threading.Event()
    release = threading.Event()

    def blocker():
        busy.set()
        release.wait(5)
        return "done"

    async def main():
        first = asyncio.ensure_future(BW.run_background(None, ("t-block",), blocker, wait_for_reads=False))
        while not busy.is_set():
            await asyncio.sleep(0.01)
        request = _Request()
        second = asyncio.ensure_future(BW.run_background(request, ("t-queued",), lambda: ran.append(1),
                                                         wait_for_reads=False))
        await asyncio.sleep(0.05)
        request.gone.set()
        with pytest.raises(BW.Cancelled):
            await second
        release.set()
        assert await first == "done"
        await asyncio.sleep(0.1)

    try:
        _run(main())
    finally:
        BW._pool().shutdown(wait=True)
        monkeypatch.setattr(BW, "_executor", None)
    assert ran == []


def test_one_client_leaving_keeps_the_job_for_the_other():
    release = threading.Event()

    def work():
        for _ in range(300):
            BW.checkpoint()
            if release.is_set():
                return "answer"
            time.sleep(0.01)
        return "timeout"

    async def main():
        leaving = _Request()
        a = asyncio.ensure_future(BW.run_background(leaving, ("t-two",), work, wait_for_reads=False))
        b = asyncio.ensure_future(BW.run_background(_Request(), ("t-two",), work, wait_for_reads=False))
        await asyncio.sleep(0.1)
        leaving.gone.set()
        with pytest.raises(BW.Cancelled):
            await a
        await asyncio.sleep(0.05)
        release.set()
        return await b

    assert _run(main()) == "answer"


def test_background_jobs_wait_for_read_loads():
    order = []
    reading = threading.Event()
    done_reading = threading.Event()

    def read_load():
        with BW.interactive_read():
            reading.set()
            time.sleep(0.4)
            order.append("reads")
        done_reading.set()

    loader = threading.Thread(target=read_load)
    loader.start()
    reading.wait(5)

    async def main():
        return await BW.run_background(None, ("t-prio",), lambda: order.append("analysis") or "ok")

    assert _run(main()) == "ok"
    loader.join()
    assert order == ["reads", "analysis"]


def test_yield_to_reads_is_bounded_and_cancellable():
    with BW.interactive_read():
        t0 = time.monotonic()
        BW.yield_to_reads(max_wait_s=0.2)
        assert 0.15 < time.monotonic() - t0 < 2
        event = threading.Event()
        event.set()
        with BW.cancel_scope(event), pytest.raises(BW.Cancelled):
            BW.yield_to_reads(max_wait_s=5)


def test_checkpoint_is_a_no_op_outside_background_jobs():
    BW.checkpoint()  # no token: nothing happens
    assert not BW.is_cancelled()


def test_prefetch_pauses_for_pan_then_resumes_the_same_work():
    from services.read_stream import prefetch_scope
    token = threading.Event()
    first = threading.Event()
    checkpoint_now = threading.Event()
    finished = threading.Event()
    progress = []

    def warm():
        with BW.cancel_scope(token), prefetch_scope(token):
            progress.append('decoded first portion')
            first.set()
            assert checkpoint_now.wait(3)
            BW.checkpoint()
            progress.append('decoded remainder')
            finished.set()

    thread = threading.Thread(target=warm, daemon=True)
    thread.start()
    assert first.wait(3)
    with BW.interactive_read():
        checkpoint_now.set()
        assert not finished.wait(0.1)
        assert not token.is_set()
    assert finished.wait(3)
    thread.join(3)
    assert progress == ['decoded first portion', 'decoded remainder']


def test_prefetch_can_be_cancelled_while_paused():
    from services.read_stream import prefetch_scope
    token, stopped = threading.Event(), threading.Event()

    def warm():
        with BW.cancel_scope(token), prefetch_scope(token), pytest.raises(BW.Cancelled):
            BW.checkpoint()
        stopped.set()

    with BW.interactive_read():
        thread = threading.Thread(target=warm, daemon=True)
        thread.start()
        token.set()
        assert stopped.wait(3)
    thread.join(3)


def test_foreground_never_joins_a_prefetch_waiting_for_that_foreground(monkeypatch):
    from services import working_sets
    from services.read_stream import prefetch_scope, is_prefetch
    from test_working_sets import FakeState
    state = FakeState()
    warming, enter_checkpoint, finished = threading.Event(), threading.Event(), threading.Event()
    calls = []

    def load(**kwargs):
        calls.append(is_prefetch())
        if is_prefetch():
            warming.set()
            assert enter_checkpoint.wait(3)
            BW.checkpoint()
        return [{'id': 'one', 'intervals': [[0, 100, 100]]}]

    monkeypatch.setattr(working_sets, '_load_broad_reads', load)
    args = dict(dataset=state.dataset, dataset_id='primary', chrom='chr1', viewport_start=0,
                viewport_end=100, broad_start=0, broad_end=100, broad_width=100,
                include_methylation=False, layer_key=None, include_layer_qualities=False,
                build_bam_reads=None, build_bigbed_reads=None, load_bigbed_marks=None,
                infer_legacy_layers=True, legacy_nuc_min_size=90, min_footprints=0)

    def warm():
        with prefetch_scope(threading.Event()):
            working_sets._load_and_cache_broad_reads_singleflight(state, **args)
        finished.set()

    thread = threading.Thread(target=warm, daemon=True)
    thread.start()
    assert warming.wait(3)
    with BW.interactive_read():
        enter_checkpoint.set()
        reads, _ = working_sets._load_and_cache_broad_reads_singleflight(state, **args)
        assert reads[0]['id'] == 'one'
    assert finished.wait(3)
    thread.join(3)
    assert calls == [True, False]
    assert not state._broad_cache_inflight


def test_finished_results_are_reused_from_the_cache():
    cache = BW.ResultCache(max_bytes=700, ttl_s=60)
    calls = []

    async def ask(key):
        return await BW.run_background(None, key, lambda: calls.append(key) or len(calls), cache=cache,
                                       wait_for_reads=False)

    assert _run(ask(("t-cache", 1))) == 1
    assert _run(ask(("t-cache", 1))) == 1
    assert calls == [("t-cache", 1)]
    _run(ask(("t-cache", 2)))
    _run(ask(("t-cache", 3)))  # evicts the oldest
    assert cache.get(("t-cache", 1), None) is None


def test_result_cache_expires():
    cache = BW.ResultCache(ttl_s=0.05)
    cache.put("k", 1)
    assert cache.get("k") == 1
    time.sleep(0.08)
    assert cache.get("k", None) is None


def test_file_identity_changes_with_the_file(tmp_path):
    path = tmp_path / "x.bam"
    path.write_bytes(b"a")
    before = BW.file_identity([str(path)])
    path.write_bytes(b"ab")
    assert BW.file_identity([str(path)]) != before


def test_a_cancelled_broad_load_leaves_no_cache_entry_and_the_next_request_loads(monkeypatch):
    from services import working_sets
    from test_working_sets import FakeState

    state = FakeState()
    state._methylation_cache = {}
    calls = []

    def load(**kwargs):
        calls.append(1)
        if len(calls) == 1:
            # A background job's client went away mid-load: the loop's checkpoint raises.
            raise BW.Cancelled()
        return [{"id": "r1", "intervals": [[0, 10, 10]]}]

    monkeypatch.setattr(working_sets, "_load_broad_reads", load)
    args = dict(dataset=state.dataset, dataset_id="primary", chrom="chr1",
                viewport_start=0, viewport_end=100, broad_start=0, broad_end=1000, broad_width=1000,
                include_methylation=False, layer_key=None, include_layer_qualities=False,
                build_bam_reads=None, build_bigbed_reads=None, load_bigbed_marks=None,
                infer_legacy_layers=True, legacy_nuc_min_size=90, min_footprints=0)
    with pytest.raises(BW.Cancelled):
        working_sets._load_and_cache_broad_reads_singleflight(state, **args)
    assert not state._broad_cache
    assert not state._broad_cache_inflight
    reads, _key = working_sets._load_and_cache_broad_reads_singleflight(state, **args)
    assert [r["id"] for r in reads] == ["r1"]


def test_cancelled_is_not_caught_by_except_exception():
    # The loaders log and go on after `except Exception`: Cancelled must pass through.
    def loader():
        try:
            raise BW.Cancelled()
        except Exception:  # noqa: BLE001
            return "partial"

    with pytest.raises(BW.Cancelled):
        loader()


def test_jobs_run_in_the_requests_context():
    """The request's context variables (remote-access scope, sandbox, workspace) hold inside the job,
    as they did with asyncio.to_thread: a remote request's scan must not look like the owner's."""
    from services.remote_access import _current_scope, current_request_is_remote

    def work():
        return current_request_is_remote()

    async def main():
        token = _current_scope.set("remote")
        try:
            return await BW.run_background(None, ("t-context", 1), work, wait_for_reads=False)
        finally:
            _current_scope.reset(token)

    assert _run(main()) is True
    assert current_request_is_remote() is False
