"""The graph helper supervisor (services/graph_panel/{frames,worker,pool}.py) against a misbehaving fake helper.

Gate B of DESIGN_GRAPH_PANEL.md: frame IDs and routing, malformed/oversized/truncated
frames, a stalled query, blocked stdin/stdout, a stderr flood, deadlines, memory
termination and recycling, last-subscriber cancellation, cancellation while another
subscriber remains, restart, retirement after the helper's job budget, the queue
policy, the cache, and shutdown without a leaked child. Every test ends with no
helper process alive.
"""
from __future__ import annotations

import asyncio
import json
import os
import struct
import sys
import time
from pathlib import Path

import pytest

from services.graph_panel import frames
from services.graph_panel.pool import GraphPool, JobError
from services.graph_panel.registration import Registration
from services.graph_panel.worker import LIVE_PIDS, HelperWorker, StderrRing, WorkerFailure

FAKE = Path(__file__).with_name("fake_graph_helper.py")
REVS = {"package": "p" * 64, "graph": "g" * 64, "db": "d" * 64, "maps": "m" * 64}


def pid_alive(pid: int) -> bool:
    """Whether the process still exists (a zombie counts: it was not reaped)."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


@pytest.fixture
def helper(tmp_path):
    script = tmp_path / "fiberbrowser-graph"
    script.write_text(f"#!/bin/sh\nexec {sys.executable} {FAKE} \"$@\"\n")
    script.chmod(0o755)
    return str(script)


@pytest.fixture
def package(tmp_path):
    pkg = tmp_path / "pkg"
    pkg.mkdir()
    (pkg / "manifest.json").write_text(json.dumps({"revisions": REVS}))
    return pkg


def make_reg(package, reg_id="gtest", revisions=REVS):
    return Registration(reg_id, str(package), dict(revisions), [{"key": "t"}], [], "fake", "test", time.time())


@pytest.fixture(autouse=True)
def no_leaks():
    before = set(LIVE_PIDS)
    yield
    leaked = set(LIVE_PIDS) - before
    assert not leaked, f"helper processes left behind: {leaked}"


@pytest.fixture
def env(monkeypatch, tmp_path):
    log = tmp_path / "helper.log"
    monkeypatch.setenv("FAKE_GRAPH_LOG", str(log))
    for name in ("FAKE_GRAPH_STARTUP", "FAKE_GRAPH_NO_READ", "FAKE_GRAPH_JOBS"):
        monkeypatch.delenv(name, raising=False)
    return log


def run(coro):
    return asyncio.run(coro)


def q(mode="ok", **extra):
    return {"request": {"mode": mode, **extra}}


def commands(log: Path) -> list[str]:
    return log.read_text().splitlines() if log.exists() else []


async def submit(pool, reg, fields, rid, panel="p1", generation=1):
    return await pool.submit(reg, "query", fields, request_id=rid, panel_id=panel, generation=generation)


# ----------------------------------------------------------------------------- frames

def test_frames_round_trip_and_type_limits():
    data = frames.encode_command(frames.command("query", "w1-j1", 3, REVS, request={"a": 1}))
    (length,) = struct.unpack(">I", data[:4])
    assert length == len(data) - 4
    frame = frames.decode_payload(data[4:])
    assert (frame.type, frame.job_id, frame.generation) == ("query", "w1-j1", 3)
    big_control = json.dumps({"protocol": 1, "type": "catalog", "job_id": "x", "generation": 0, "revisions": REVS,
                              "pad": "x" * (70 << 10)}).encode()
    with pytest.raises(frames.FrameError) as exc:
        frames.decode_payload(big_control)
    assert exc.value.code == "oversized"
    for bad in (b"[]", b"{nope", json.dumps({"protocol": 2, "type": "t", "job_id": "j", "generation": 0,
                                              "revisions": REVS}).encode(),
                json.dumps({"protocol": 1, "type": "t", "job_id": "", "generation": 0, "revisions": REVS}).encode(),
                json.dumps({"protocol": 1, "type": "t", "job_id": "j", "generation": -1, "revisions": REVS}).encode(),
                json.dumps({"protocol": 1, "type": "t", "job_id": "j", "generation": 0, "revisions": {}}).encode()):
        with pytest.raises(frames.FrameError) as exc:
            frames.decode_payload(bad)
        assert exc.value.code == "malformed"
    with pytest.raises(frames.FrameError):
        frames.encode_command({"pad": "x" * (frames.MAX_COMMAND_BYTES + 1)})


def test_read_frame_checks_the_header_before_reading_a_payload():
    async def go():
        reader = asyncio.StreamReader()
        reader.feed_data(struct.pack(">I", 5 << 20))   # announces 5 MiB, sends nothing more
        with pytest.raises(frames.FrameError) as exc:
            await asyncio.wait_for(frames.read_frame(reader), 0.5)   # fails at once, does not wait for the payload
        assert exc.value.code == "oversized"
        reader = asyncio.StreamReader()
        reader.feed_data(struct.pack(">I", 50) + b"{")
        reader.feed_eof()
        with pytest.raises(frames.FrameError) as exc:
            await frames.read_frame(reader)
        assert exc.value.code == "truncated"
        reader = asyncio.StreamReader()
        reader.feed_data(b"\x00\x00")
        reader.feed_eof()
        with pytest.raises(frames.FrameError) as exc:
            await frames.read_frame(reader)
        assert exc.value.code == "truncated"
        reader = asyncio.StreamReader()
        reader.feed_eof()
        with pytest.raises(frames.FrameError) as exc:
            await frames.read_frame(reader)
        assert exc.value.code == "eof"
    run(go())


def test_stderr_ring_is_bounded():
    ring = StderrRing(1024)
    for _ in range(100):
        ring.add(b"y" * 100 + b"\n")
    ring.add(b"z" * 5000)
    assert ring.size == 1024 and ring.total_bytes == 100 * 101 + 5000 and ring.total_lines == 100
    assert ring.text(10) == "z" * 10
    assert ring.dropped_bytes == ring.total_bytes - 1024


# ----------------------------------------------------------------------------- one worker

def test_worker_routes_frames_by_job_id_and_shuts_down_cleanly(helper, package, env):
    async def go():
        w = HelperWorker(helper, str(package), "gtest", epoch=7)
        await w.start()
        assert w.revisions == REVS and w.state == "idle" and w.pid in LIVE_PIDS
        first = await w.call("query", q("ok", n=1))
        second = await w.call("query", q("ok", n=2))
        assert (first.job_id, second.job_id) == ("w7-j1", "w7-j2")
        assert first.generation == 7 and first.body["result"]["echo"]["n"] == 1
        assert second.body["result"]["echo"]["n"] == 2
        pid = w.pid
        await w.shutdown()
        assert w.state == "dead" and not pid_alive(pid) and pid not in LIVE_PIDS
    run(go())
    assert [line.split()[1] for line in commands(env)] == ["query", "query", "shutdown"]


@pytest.mark.parametrize("mode,code", [
    ("malformed", "protocol_malformed"),
    ("oversized_header", "protocol_oversized"),
    ("oversized_payload", "protocol_oversized"),
    ("truncated", "protocol_truncated"),
    ("eof", "protocol_eof"),
    ("unknown_job", "protocol_unknown_job"),
    ("wrong_generation", "protocol_generation"),
    ("stall", "deadline"),
    ("truncated_hang", "deadline"),
    ("slow_frame:3000", "deadline"),
])
def test_worker_faults_kill_and_reap_the_helper(helper, package, env, mode, code):
    async def go():
        w = HelperWorker(helper, str(package), "gtest", epoch=1)
        await w.start()
        pid = w.pid
        t0 = time.monotonic()
        with pytest.raises(WorkerFailure) as exc:
            await w.call("query", q(mode), deadline_s=1.0)
        elapsed = time.monotonic() - t0
        assert exc.value.code == code
        assert elapsed < 1.6, f"{mode} took {elapsed:.2f} s"
        assert w.state == "dead" and not pid_alive(pid)
    run(go())


def test_duplicate_terminal_frame_fails_the_worker(helper, package, env):
    async def go():
        w = HelperWorker(helper, str(package), "gtest", epoch=1)
        await w.start()
        pid = w.pid
        frame = await w.call("query", q("duplicate"))   # the first copy answers the job
        assert frame.type == "topology"
        for _ in range(200):
            if w.state == "dead" and not pid_alive(pid):
                break
            await asyncio.sleep(0.01)
        assert w.state == "dead" and w.death_reason == "protocol_unknown_job" and not pid_alive(pid)
    run(go())


def test_blocked_stdin_write_hits_the_deadline(helper, package, env, monkeypatch):
    monkeypatch.setenv("FAKE_GRAPH_NO_READ", "1")

    async def go():
        w = HelperWorker(helper, str(package), "gtest", epoch=1)
        await w.start()
        pid = w.pid
        t0 = time.monotonic()
        with pytest.raises(WorkerFailure) as exc:
            # ~900 KiB: more than the pipe holds, so drain() blocks on a helper that never reads.
            await w.call("query", q("ok", pad="x" * (900 << 10)), deadline_s=0.5)
        assert exc.value.code == "deadline" and time.monotonic() - t0 < 1.2
        assert not pid_alive(pid)
    run(go())


def test_stderr_flood_cannot_block_the_helper(helper, package, env):
    async def go():
        w = HelperWorker(helper, str(package), "gtest", epoch=1)
        await w.start()
        frame = await w.call("query", q("stderr_flood:16"), deadline_s=5.0)
        assert frame.type == "topology"
        await asyncio.sleep(0.1)
        stats = w.stderr.stats()
        assert stats["retained_bytes"] <= 64 << 10
        assert stats["total_bytes"] >= 16 << 20
        await w.shutdown()
    run(go())


@pytest.mark.parametrize("startup,code,retryable", [
    ("slow", "startup_timeout", True),
    ("garbage", "startup_failed", True),
    ("exit", "startup_failed", True),
    ("wrong_schema", "schema_mismatch", False),
])
def test_startup_faults(helper, package, env, monkeypatch, startup, code, retryable):
    monkeypatch.setenv("FAKE_GRAPH_STARTUP", startup)

    async def go():
        w = HelperWorker(helper, str(package), "gtest", epoch=1, startup_timeout_s=0.5)
        t0 = time.monotonic()
        with pytest.raises(WorkerFailure) as exc:
            await w.start()
        assert exc.value.code == code and exc.value.retryable is retryable
        assert time.monotonic() - t0 < 1.5
        assert w.state == "dead" and (w.pid is None or not pid_alive(w.pid))
    run(go())


def test_helper_exits_when_the_supervisor_goes_away(helper, package, env):
    """No orphan: a helper whose stdin closes (FiberBrowser killed outright) exits by itself."""
    import subprocess
    proc = subprocess.Popen([helper, "serve", "--package", str(package)], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    header = proc.stdout.read(4)
    proc.stdout.read(struct.unpack(">I", header)[0])
    proc.stdin.close()
    assert proc.wait(timeout=5) == 0


# ----------------------------------------------------------------------------- the pool

def test_pool_shares_equivalent_jobs_and_fans_out_each_token(helper, package, env):
    async def go():
        pool = GraphPool(lambda: helper)
        reg = make_reg(package)
        a = asyncio.ensure_future(submit(pool, reg, q("sleep:200"), "ra", panel="A", generation=4))
        await asyncio.sleep(0.05)
        b = asyncio.ensure_future(submit(pool, reg, q("sleep:200"), "rb", panel="B", generation=9))
        ra, rb = await asyncio.gather(a, b)
        assert (ra["request_id"], ra["generation"], ra["panel_id"]) == ("ra", 4, "A")
        assert (rb["request_id"], rb["generation"], rb["panel_id"]) == ("rb", 9, "B")
        assert ra["result"] == rb["result"]
        assert pool.counters["shared"] == 1
        # The cache answers the same request again without the helper.
        rc = await submit(pool, reg, q("sleep:200"), "rc", panel="C")
        assert rc["cached"] is True and rc["result"] == ra["result"]
        await pool.close()
    run(go())
    assert len([c for c in commands(env) if " query " in c]) == 1


def test_last_subscriber_cancel_kills_the_running_helper_and_the_pool_restarts(helper, package, env):
    async def go():
        pool = GraphPool(lambda: helper)
        reg = make_reg(package)
        task = asyncio.ensure_future(submit(pool, reg, q("stall"), "r1"))
        await asyncio.sleep(0.4)
        (worker,) = pool.workers
        pid, epoch = worker.pid, worker.epoch
        assert pool.cancel("r1") is True
        with pytest.raises(JobError) as exc:
            await task
        assert exc.value.code == "cancelled"
        for _ in range(200):
            if not pid_alive(pid):
                break
            await asyncio.sleep(0.01)
        assert not pid_alive(pid) and worker.death_reason == "cancelled"
        assert pool.counters["killed_on_last_cancel"] == 1
        again = await submit(pool, reg, q("ok"), "r2")
        assert again["status"] == "ok" and again["timings"]["worker_epoch"] > epoch
        await pool.close()
    run(go())


def test_cancel_while_another_subscriber_remains_keeps_the_job(helper, package, env):
    async def go():
        pool = GraphPool(lambda: helper)
        reg = make_reg(package)
        a = asyncio.ensure_future(submit(pool, reg, q("sleep:400"), "ra", panel="A"))
        b = asyncio.ensure_future(submit(pool, reg, q("sleep:400"), "rb", panel="B"))
        await asyncio.sleep(0.15)
        (worker,) = pool.workers
        pid = worker.pid
        assert pool.cancel("ra")
        with pytest.raises(JobError):
            await a
        rb = await b
        assert rb["status"] == "ok" and rb["result"]["pid"] == pid
        assert pid_alive(pid) and worker.state == "idle"
        assert pool.counters.get("killed_on_last_cancel", 0) == 0
        await pool.close()
        assert not pid_alive(pid)
    run(go())


def test_disconnecting_handler_counts_as_cancel(helper, package, env):
    async def go():
        pool = GraphPool(lambda: helper)
        reg = make_reg(package)
        task = asyncio.ensure_future(submit(pool, reg, q("stall"), "r1"))
        await asyncio.sleep(0.4)
        pid = pool.workers[0].pid
        task.cancel()                      # what the router does when the browser aborts
        with pytest.raises(asyncio.CancelledError):
            await task
        for _ in range(200):
            if not pid_alive(pid):
                break
            await asyncio.sleep(0.01)
        assert not pid_alive(pid)
        await pool.close()
    run(go())


@pytest.mark.parametrize("mode,code", [("stall", "deadline"), ("malformed", "protocol_malformed"),
                                       ("oversized_payload", "protocol_oversized"), ("eof", "protocol_eof")])
def test_job_failure_is_retryable_for_every_subscriber_and_the_next_request_recovers(helper, package, env, mode, code):
    async def go():
        pool = GraphPool(lambda: helper)
        reg = make_reg(package)
        a = asyncio.ensure_future(submit(pool, reg, q(mode), "ra", panel="A"))
        b = asyncio.ensure_future(submit(pool, reg, q(mode), "rb", panel="B"))
        results = await asyncio.gather(a, b, return_exceptions=True)
        for r in results:
            assert isinstance(r, JobError) and r.code == code and r.retryable and r.status == 503
        ok = await submit(pool, reg, q("ok"), "rc")
        assert ok["status"] == "ok"
        await pool.close()
    run(go())


def test_semantic_helper_error_keeps_the_worker(helper, package, env):
    async def go():
        pool = GraphPool(lambda: helper)
        reg = make_reg(package)
        with pytest.raises(JobError) as exc:
            await submit(pool, reg, q("error:selection_limit"), "r1")
        assert exc.value.code == "selection_limit" and exc.value.status == 413 and not exc.value.retryable
        pid = pool.workers[0].pid
        ok = await submit(pool, reg, q("ok"), "r2")
        assert ok["result"]["pid"] == pid
        await pool.close()
    run(go())


def test_memory_limit_kills_a_busy_helper(helper, package, env):
    async def go():
        pool = GraphPool(lambda: helper, job_rss=120 << 20, monitor_interval_s=0.02, deadline_s=1.0)
        reg = make_reg(package)
        with pytest.raises(JobError) as exc:
            await submit(pool, reg, q("memory:400"), "r1")
        assert exc.value.code == "memory" and exc.value.retryable
        assert pool.counters["memory_killed"] == 1
        ok = await submit(pool, reg, q("ok"), "r2")
        assert ok["status"] == "ok"
        await pool.close()
    run(go())


def test_idle_helper_above_the_recycle_threshold_is_recycled(helper, package, env):
    async def go():
        pool = GraphPool(lambda: helper, recycle_rss=150 << 20, monitor_interval_s=0.02)
        reg = make_reg(package)
        first = await submit(pool, reg, q("memory_then_ok:300"), "r1")
        pid = first["result"]["pid"]
        for _ in range(300):
            if not pid_alive(pid):
                break
            await asyncio.sleep(0.01)
        assert not pid_alive(pid) and pool.counters["memory_recycled"] == 1
        second = await submit(pool, reg, q("ok"), "r2")
        assert second["result"]["pid"] != pid
        await pool.close()
    run(go())


def test_at_most_two_workers_newest_queued_per_panel_and_expiry(helper, package, env):
    async def go():
        pool = GraphPool(lambda: helper, queue_expiry_s=0.6)
        reg = make_reg(package)
        busy = [asyncio.ensure_future(submit(pool, reg, q("sleep:900", n=i), f"busy{i}", panel=f"busy{i}"))
                for i in range(2)]
        await asyncio.sleep(0.3)
        assert len(pool.workers) == 2
        old = asyncio.ensure_future(submit(pool, reg, q("ok", n="old"), "old", panel="P"))
        await asyncio.sleep(0.01)
        new = asyncio.ensure_future(submit(pool, reg, q("ok", n="new"), "new", panel="P"))
        with pytest.raises(JobError) as exc:
            await old
        assert exc.value.code == "superseded"
        late = asyncio.ensure_future(submit(pool, reg, q("ok", n="late"), "late", panel="Q"))
        with pytest.raises(JobError) as exc:
            await late         # both workers stay busy past its expiry
        assert exc.value.code == "queue_timeout" and exc.value.retryable
        assert [(await b)["status"] for b in busy] == ["ok", "ok"]
        # 'new' was queued at about the same time as 'late': it either ran when a worker freed up or expired.
        result = await asyncio.gather(new, return_exceptions=True)
        assert isinstance(result[0], dict) or result[0].code == "queue_timeout"
        assert len(pool.workers) <= 2
        await pool.close()
    run(go())


def test_panels_are_served_round_robin(helper, package, env):
    async def go():
        pool = GraphPool(lambda: helper, max_workers=1, queue_expiry_s=5.0)
        reg = make_reg(package)
        first = asyncio.ensure_future(submit(pool, reg, q("sleep:300", n="first"), "first", panel="A"))
        await asyncio.sleep(0.2)
        # A asks again (newest replaces its queued one); B and C each ask once.
        later = [asyncio.ensure_future(submit(pool, reg, q("ok", n=name), name, panel=panel))
                 for name, panel in (("b1", "B"), ("a2", "A"), ("c1", "C"))]
        await first
        await asyncio.gather(*later)
        await pool.close()
    run(go())
    # Dispatch order: A was just served, so it waits behind B (queued first) and goes before C.
    served = [c.split()[3] for c in commands(env) if " query " in c]
    assert served == ["first", "b1", "a2", "c1"]


def test_another_package_takes_an_idle_slot(helper, package, env, tmp_path):
    other_pkg = tmp_path / "pkg2"
    other_pkg.mkdir()
    revs2 = {k: v.replace(v[0], "z") for k, v in REVS.items()}
    (other_pkg / "manifest.json").write_text(json.dumps({"revisions": revs2}))

    async def go():
        pool = GraphPool(lambda: helper, max_workers=1)
        a = await submit(pool, make_reg(package), q("ok"), "r1")
        b = await submit(pool, make_reg(other_pkg, "gother", revs2), q("ok"), "r2")
        assert a["result"]["pid"] != b["result"]["pid"]
        assert pool.counters["evicted_other_package"] == 1 and len(pool.workers) == 1
        await pool.close()
        assert not pid_alive(a["result"]["pid"]) and not pid_alive(b["result"]["pid"])
    run(go())


def test_helper_retires_after_its_job_budget(helper, package, env, monkeypatch):
    monkeypatch.setenv("FAKE_GRAPH_JOBS", "3")

    async def go():
        pool = GraphPool(lambda: helper)
        reg = make_reg(package)
        pids = []
        for i in range(7):
            r = await submit(pool, reg, q("ok", n=i), f"r{i}")
            pids.append((r["result"]["pid"], r["timings"]["worker_epoch"]))
        assert len({p for p, _ in pids}) == 3, pids
        await pool.close()
        assert not any(pid_alive(p) for p, _ in pids)
    run(go())


def test_registration_mismatch_is_refused(helper, package, env):
    async def go():
        pool = GraphPool(lambda: helper)
        stale = make_reg(package, revisions={**REVS, "db": "e" * 64})
        with pytest.raises(JobError) as exc:
            await submit(pool, stale, q("ok"), "r1")
        assert exc.value.code == "stale_revision" and exc.value.status == 409
        await pool.close()
    run(go())


def test_repeated_startup_failures_back_off(helper, package, env, monkeypatch):
    monkeypatch.setenv("FAKE_GRAPH_STARTUP", "exit")

    async def go():
        pool = GraphPool(lambda: helper)
        reg = make_reg(package)
        codes = []
        for i in range(4):
            try:
                await submit(pool, reg, q("ok"), f"r{i}")
            except JobError as exc:
                codes.append(exc.code)
        assert codes == ["startup_failed"] * 3 + ["helper_failing"]
        await pool.close()
    run(go())


def test_close_reaps_busy_and_idle_helpers_and_fails_waiters(helper, package, env):
    async def go():
        pool = GraphPool(lambda: helper)
        reg = make_reg(package)
        busy = asyncio.ensure_future(submit(pool, reg, q("stall"), "busy", panel="B"))
        await asyncio.sleep(0.3)
        await submit(pool, reg, q("ok", n=0), "warm", panel="W")   # a second worker, left idle
        pids = [w.pid for w in pool.workers]
        assert len(pids) == 2 and sorted(w.state for w in pool.workers) == ["busy", "idle"]
        await pool.close()
        with pytest.raises(JobError) as exc:
            await busy
        assert exc.value.code == "shutdown"
        assert not any(pid_alive(p) for p in pids)
        with pytest.raises(JobError):
            await submit(pool, reg, q("ok"), "after")
    run(go())


def test_incomplete_results_are_cached_briefly(helper, package, env):
    from services.graph_panel.pool import ResultCache
    cache = ResultCache(max_bytes=100, summary_ttl_s=0.05)
    assert cache.put(b"k1", {"complete": True, "summaries": []}, 40)
    assert cache.put(b"k2", {"complete": False, "summaries": [{"reason": "wire_limit"}]}, 40)
    assert cache.get(b"k1") and cache.get(b"k2")
    time.sleep(0.08)
    assert cache.get(b"k2") is None and cache.get(b"k1")
    assert not cache.put(b"huge", {"complete": True}, 101)
    cache.put(b"k3", {"complete": True}, 40)
    cache.put(b"k4", {"complete": True}, 40)
    assert cache.bytes <= 100 and cache.get(b"k1") is None   # least recently used goes first


# ----------------------------------------------------------------------------- review regressions (Phase B review 1)

def test_cancel_before_dispatch_releases_the_worker_slot(helper, package, env):
    """A job cancelled before its task's first step must not keep its reserved worker (both slots were lost)."""
    async def go():
        pool = GraphPool(lambda: helper, queue_expiry_s=0.3)
        reg = make_reg(package)
        for i in range(2):
            task = asyncio.ensure_future(submit(pool, reg, q("ok", n=i), f"c{i}", panel=f"c{i}"))
            await asyncio.sleep(0)
            pool.cancel(f"c{i}")
            await asyncio.gather(task, return_exceptions=True)
            await asyncio.sleep(0)
        assert not pool.reserved and not pool.workers
        third = await submit(pool, reg, q("ok", n=3), "third", panel="t")
        assert third["status"] == "ok"
        await pool.close()
    run(go())


def test_a_kill_interrupted_by_cancellation_still_reaps(helper, package, env):
    """kill() teardown is its own task: cancelling a caller mid-reap leaves later callers and close() working."""
    async def go():
        pool = GraphPool(lambda: helper, deadline_s=0.2)
        reg = make_reg(package)
        task = asyncio.ensure_future(submit(pool, reg, q("stall"), "r1"))
        while not pool.workers or pool.workers[0].state != "busy":
            await asyncio.sleep(0.005)
        worker = pool.workers[0]
        original = worker._reap
        entered, gate = asyncio.Event(), asyncio.Event()

        async def slow_reap():
            entered.set()
            await gate.wait()
            await original()
        worker._reap = slow_reap
        await entered.wait()               # the deadline is inside kill(), reaping
        pool.cancel("r1")                  # its caller is cancelled now
        await asyncio.gather(task, return_exceptions=True)
        closing = asyncio.ensure_future(pool.close())
        await asyncio.sleep(0.05)
        gate.set()
        await asyncio.wait_for(closing, 3)
        assert worker._exited.is_set() and not pid_alive(worker.pid)
    run(go())


def test_evicted_helpers_hold_their_slot_until_reaped(helper, package, env, monkeypatch, tmp_path):
    monkeypatch.setenv("FAKE_GRAPH_SLOW_SHUTDOWN_MS", "500")
    others = []
    for i in range(4):
        pkg = tmp_path / f"pkg{i}"
        pkg.mkdir()
        revs = {k: f"{i}{k[0]}".ljust(64, "x") for k in REVS}
        (pkg / "manifest.json").write_text(json.dumps({"revisions": revs}))
        others.append(make_reg(pkg, f"g{i}", revs))

    async def go():
        pool = GraphPool(lambda: helper, queue_expiry_s=5.0)
        peak = 0

        async def sample():
            nonlocal peak
            while True:
                peak = max(peak, len(LIVE_PIDS))
                await asyncio.sleep(0.01)
        sampler = asyncio.ensure_future(sample())
        for i, reg in enumerate(others):
            assert (await submit(pool, reg, q("ok"), f"r{i}", panel=f"p{i}"))["status"] == "ok"
        sampler.cancel()
        assert peak <= 2, f"{peak} helpers alive at once"
        await pool.close()
    run(go())


def test_a_reply_for_other_revisions_is_refused_and_not_cached(helper, package, env):
    async def go():
        pool = GraphPool(lambda: helper)
        reg = make_reg(package)
        with pytest.raises(JobError) as exc:
            await submit(pool, reg, q("wrong_revision"), "r1")
        assert exc.value.code == "protocol_revision"
        assert pool.cache.stats()["entries"] == 0
        await pool.close()
    run(go())


def test_a_changed_package_is_refused_before_the_cache(helper, package, env, tmp_path):
    from services.graph_panel.registration import Registry
    registry = Registry(str(tmp_path / "reg.json"))
    (package / "graph.db").write_bytes(b"db")

    async def go():
        reg = registry.register(helper, str(package))
        pool = GraphPool(lambda: helper, check_registration=registry.check_unchanged)
        assert (await submit(pool, reg, q("ok"), "before"))["status"] == "ok"
        assert (await submit(pool, reg, q("ok"), "cached"))["cached"] is True
        (package / "graph.db").write_bytes(b"changed")
        for rid, fields in (("cached-after", q("ok")), ("new-after", q("ok", n=2))):
            with pytest.raises(JobError) as exc:
                await submit(pool, reg, fields, rid)
            assert exc.value.code == "package_changed" and exc.value.status == 409
        assert pool.cache.stats()["entries"] == 0
        await pool.close()
    run(go())


def test_a_same_size_rewrite_with_its_mtime_restored_is_not_remembered(helper, package, env, tmp_path):
    from services.graph_panel.registration import Registry
    (package / "graph.db").write_bytes(b"abcd")
    first = Registry(str(tmp_path / "reg.json"))
    first.register(helper, str(package))
    st = os.stat(package / "graph.db")
    time.sleep(0.02)
    (package / "graph.db").write_bytes(b"wxyz")
    os.utime(package / "graph.db", ns=(st.st_atime_ns, st.st_mtime_ns))
    again = Registry(str(tmp_path / "reg.json"))
    again.ensure_loaded(helper)
    assert [r["verification"] for r in again.list()] == ["verified"]


def test_a_cached_answer_still_supersedes_the_panels_queued_request(helper, package, env):
    async def go():
        pool = GraphPool(lambda: helper, max_workers=1, queue_expiry_s=5.0)
        reg = make_reg(package)
        await submit(pool, reg, q("ok"), "warm", panel="W")
        busy = asyncio.ensure_future(submit(pool, reg, q("sleep:300"), "busy", panel="B"))
        await asyncio.sleep(0.05)
        old = asyncio.ensure_future(submit(pool, reg, q("ok", n=1), "old", panel="P"))
        await asyncio.sleep(0.02)
        new = await submit(pool, reg, q("ok"), "new", panel="P")
        assert new["cached"] is True
        with pytest.raises(JobError) as exc:
            await old
        assert exc.value.code == "superseded"
        await busy
        await pool.close()
    run(go())
