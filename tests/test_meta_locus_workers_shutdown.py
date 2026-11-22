"""The meta-locus decode workers stop with the server (3.1.1 packaged-app smoke: six workers and a resource tracker
kept running after Quit)."""
import os
import time

import pytest


@pytest.mark.skipif(os.name == "nt", reason="POSIX process checks")
def test_the_lifespan_shutdown_joins_the_meta_locus_workers(standalone_app):
    from starlette.testclient import TestClient
    from conftest import auth_headers
    from services import meta_locus_decode as mld

    with TestClient(standalone_app, headers=auth_headers()):
        pool = mld.worker_pool(2)
        pids = {pool.submit(mld._noop).result(timeout=60) for _ in range(4)}
        assert pids and all(_alive(p) for p in pids)
    assert mld._pool is None
    deadline = time.monotonic() + 10
    while any(_alive(p) for p in pids) and time.monotonic() < deadline:
        time.sleep(0.1)
    assert not any(_alive(p) for p in pids), pids


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    # A reaped child is gone; an exited but unreaped one is a zombie, which counts as stopped.
    try:
        done, _ = os.waitpid(pid, os.WNOHANG)
        return done == 0
    except ChildProcessError:
        return True


@pytest.mark.skipif(os.name == "nt", reason="POSIX process checks")
def test_a_busy_worker_never_holds_the_shutdown():
    """Round-11 audit: Quit joined the workers without a deadline, so a chunk stalled in I/O held the server's
    shutdown. A bounded shutdown terminates it."""
    from services import meta_locus_decode as mld
    pool = mld.worker_pool(1)
    pid = pool.submit(mld._noop).result(timeout=60)
    pool.submit(time.sleep, 60)          # busy for a minute
    time.sleep(0.5)
    t0 = time.monotonic()
    mld.shutdown_workers(wait=True, timeout=1.0)
    assert time.monotonic() - t0 < 6.0
    assert mld._pool is None
    deadline = time.monotonic() + 5
    while _alive(pid) and time.monotonic() < deadline:
        time.sleep(0.1)
    assert not _alive(pid)


@pytest.mark.skipif(os.name == "nt", reason="POSIX process checks")
def test_a_forced_shutdown_with_queued_payloads_lets_the_process_exit(tmp_path):
    """Round-12 audit: after busy workers were terminated, payloads still queued kept the executor's feeder and
    manager threads waiting, and the interpreter never exited. A pool retired by a resize is shut down too."""
    import subprocess
    import sys
    browser = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "browser")
    script = tmp_path / "probe.py"
    script.write_text(
        "import sys, time\n"
        f"sys.path.insert(0, {browser!r})\n"
        "from services import meta_locus_decode as mld\n"
        "if __name__ == '__main__':\n"
        " old = mld.worker_pool(1)\n"
        " old.submit(time.sleep, 60)\n"
        " pool = mld.worker_pool(2)\n"            # a resize: the old pool keeps running its chunk
        " for _ in range(2):\n"
        "     pool.submit(time.sleep, 60)\n"
        " for _ in range(4):\n"
        "     pool.submit(len, b'x' * (512 * 1024))\n"
        " time.sleep(1.0)\n"
        " t0 = time.monotonic()\n"
        " mld.shutdown_workers(wait=True, timeout=1.0)\n"
        " print('shutdown', round(time.monotonic() - t0, 2), flush=True)\n")
    t0 = time.monotonic()
    out = subprocess.run([sys.executable, str(script)], capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr[-2000:]
    assert "shutdown" in out.stdout
    assert time.monotonic() - t0 < 30


@pytest.mark.skipif(os.name == "nt", reason="POSIX process checks")
def test_stopped_retired_pools_are_released_at_the_next_resize():
    """Round-13 audit: every resized-away pool was kept until Quit (descriptors and results accumulated)."""
    from services import meta_locus_decode as mld
    try:
        for i in range(6):
            pool = mld.worker_pool(2 + i % 2)
            pool.submit(mld._noop).result(timeout=60)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            mld.worker_pool(2 + (len(mld._retired) % 2))     # a resize prunes what has stopped
            if len(mld._retired) <= 1:
                break
            time.sleep(0.5)
        assert len(mld._retired) <= 1
    finally:
        mld.shutdown_workers(wait=True, timeout=5.0)


def test_a_submission_and_a_resize_never_interleave(monkeypatch):
    # Codex R14: a resize that snapshots the pool while another thread's submission is starting its first worker
    # misses that worker, which then escapes the bounded shutdown. Submissions hold the pool lock with the lookup.
    import threading
    from services import meta_locus_decode as mld

    seen = []

    class FakePool:
        def __init__(self, *a, **k):
            pass

        def submit(self, fn, *args):
            seen.append(mld._pool_lock.locked())
            return None

        def shutdown(self, *a, **k):
            pass

    monkeypatch.setattr("concurrent.futures.ProcessPoolExecutor", FakePool)
    monkeypatch.setattr(mld, "_pool", None)
    monkeypatch.setattr(mld, "_pool_size", 0)
    monkeypatch.setattr(mld, "_retired", [])
    mld.submit_decode(2, mld._noop)
    assert seen == [True]

    # While a resize holds the lock, a submission waits for it.
    mld._pool_lock.acquire()
    try:
        worker = threading.Thread(target=mld.submit_decode, args=(3, mld._noop))
        worker.start()
        worker.join(0.3)
        assert worker.is_alive() and seen == [True]
    finally:
        mld._pool_lock.release()
    worker.join(5)
    assert not worker.is_alive() and seen == [True, True]
    assert mld._pool_size == 3 and len(mld._retired) == 0
