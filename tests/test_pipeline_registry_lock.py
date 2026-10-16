"""Two FiberBrowser servers sharing one jobs folder never run a job twice or lose a cancel.

Registration and every state transition take the same cross-server lock as the
queue; a job is published complete (spec and queued state) with one rename.
Reproductions from the 29 Sep review (duplicate launch during creation, cancel
overwritten by another server's launch).
"""
from __future__ import annotations

import os
import signal
import subprocess
import sys
import threading

import pytest

pytestmark = pytest.mark.skipif(os.name == "nt", reason="flock-based registry lock")


def _sleeper_spec(root, job_id, outdir):
    progress = os.path.join(str(root), job_id, "progress.jsonl")
    return {"id": job_id, "argv": [sys.executable, "-c", "import time; time.sleep(60)", progress],
            "cores": 1, "outdir": str(outdir)}


def _kill(procs):
    for proc in procs:
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGKILL)
        proc.wait(timeout=10)


def test_a_job_being_registered_is_not_started_by_another_server(tmp_path, monkeypatch):
    from services import pipeline_jobs as pj

    root = tmp_path / "jobs"
    job_id = "20260929-120000-ccbbbb"
    procs = []

    def launcher(spec, jobdir):
        proc = subprocess.Popen(spec["argv"], start_new_session=True)
        procs.append(proc)
        return proc

    entered, released = threading.Event(), threading.Event()
    original_write = pj._write_json

    def slow_write(path, payload):
        # Pause registration between writing spec.json and the queued state.
        if path.endswith("state.json") and payload.get("status") == "queued":
            entered.set()
            assert released.wait(10)
        original_write(path, payload)

    monkeypatch.setattr(pj, "_write_json", slow_write)
    first = pj.JobManager(str(root), launcher=launcher)
    second = pj.JobManager(str(root), launcher=launcher)
    first.ensure_running = first.tick
    second.ensure_running = second.tick
    errors = []

    def create():
        try:
            first.create(_sleeper_spec(root, job_id, tmp_path / "out"))
        except Exception as exc:  # pragma: no cover - reported below
            errors.append(exc)

    creator = threading.Thread(target=create)
    creator.start()
    other = None
    try:
        assert entered.wait(10)
        # The half-written record is invisible and the other server waits for the lock.
        assert second.job_ids() == []
        other = threading.Thread(target=second.tick)
        other.start()
        other.join(0.3)
        assert other.is_alive(), "the other server's queue pass did not wait for registration"
        released.set()
        creator.join(10)
        other.join(10)
        assert not creator.is_alive() and not other.is_alive()
        assert not errors, errors
        second.tick()
        first.tick()
        assert len(procs) == 1, f"one job was launched {len(procs)} times"
        assert first.state(job_id)["status"] == "running"
        assert first.state(job_id)["pid"] == procs[0].pid
    finally:
        released.set()
        creator.join(10)
        if other is not None:
            other.join(10)
        _kill(procs)


def test_a_record_without_state_is_never_queued(tmp_path):
    from services import pipeline_jobs as pj

    root = tmp_path / "jobs"
    job_id = "20260929-120000-ccdddd"
    (root / job_id).mkdir(parents=True)
    pj._write_json(str(root / job_id / "spec.json"), _sleeper_spec(root, job_id, tmp_path / "out"))
    launched = []
    manager = pj.JobManager(str(root), launcher=lambda spec, jobdir: launched.append(spec))
    manager.tick()
    assert launched == []
    assert manager.state(job_id)["status"] not in pj.ACTIVE


def test_cancel_during_another_servers_launch_stops_the_process(tmp_path):
    from services import pipeline_jobs as pj

    root = tmp_path / "jobs"
    job_id = "20260929-120000-ccaaaa"
    jobdir = root / job_id
    jobdir.mkdir(parents=True)
    pj._write_json(str(jobdir / "spec.json"), _sleeper_spec(root, job_id, tmp_path / "out"))
    pj._write_json(str(jobdir / "state.json"), {"status": "queued", "queued_at": 1})
    entered, released = threading.Event(), threading.Event()
    procs = []

    def launcher(spec, jobdir):
        entered.set()
        assert released.wait(10)
        proc = subprocess.Popen(spec["argv"], start_new_session=True)
        procs.append(proc)
        return proc

    first = pj.JobManager(str(root), launcher=launcher)
    second = pj.JobManager(str(root))
    launching = threading.Thread(target=first.tick)
    launching.start()
    result = {}
    canceller = threading.Thread(target=lambda: result.update(second.cancel(job_id)))
    try:
        assert entered.wait(10)
        canceller.start()
        canceller.join(0.3)
        assert canceller.is_alive(), "cancel did not wait for the launch in progress"
        released.set()
        launching.join(10)
        canceller.join(10)
        assert not launching.is_alive() and not canceller.is_alive()
        # The cancel saw the running job: it asked it to stop instead of claiming it never started.
        assert result["status"] == "cancelling"
        assert procs[0].wait(timeout=10) is not None  # SIGTERM reached the process
        state = first.state(job_id)
        assert state["status"] == "cancelling" and state.get("cancel_requested")
        first.tick()
        assert first.state(job_id)["status"] == "cancelled"
    finally:
        released.set()
        launching.join(10)
        if canceller.is_alive() or canceller.ident:
            canceller.join(10)
        _kill(procs)
