"""How the previous run on a port ended, for the page's "Reopen your last session"
(services/launch_state.py, GET /api/session/launch)."""
from __future__ import annotations

from port_list import bind_test_port

import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]


@pytest.fixture
def runs_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_RUNTIME_FILE", str(tmp_path / "browser_runtime.json"))
    from services import launch_state
    launch_state._reset_for_tests()
    yield tmp_path
    launch_state._reset_for_tests()


def _run(path: Path, port: int = 8799) -> dict:
    return json.loads((path / f"browser_run_{port}.json").read_text())


def _put(path: Path, port: int, entry: dict) -> None:
    (path / f"browser_run_{port}.json").write_text(json.dumps(entry))


def test_first_launch_has_no_previous_run(runs_dir):
    from services import launch_state
    assert launch_state.record_launch(8799) == "none"
    entry = _run(runs_dir)
    assert entry["pid"] == os.getpid() and entry["clean_exit"] is False
    assert entry["boot_id"] == launch_state.launch_info()["boot_id"]


def test_clean_exit_then_relaunch_is_clean(runs_dir):
    from services import launch_state
    launch_state.record_launch(8799)
    first_boot = launch_state.launch_info()["boot_id"]
    launch_state.record_clean_exit()
    assert _run(runs_dir)["clean_exit"] is True
    launch_state._reset_for_tests()
    assert launch_state.record_launch(8799) == "clean"
    info = launch_state.launch_info()
    assert info["previous_exit"] == "clean" and info["previous_boot_id"] == first_boot
    assert info["boot_id"] != first_boot


def test_dead_unclean_run_is_a_crash(runs_dir):
    from services import launch_state
    dead = subprocess.Popen([sys.executable, "-c", "pass"])
    dead.wait()
    _put(runs_dir, 8799, {"pid": dead.pid, "boot_id": "old", "clean_exit": False})
    assert launch_state.record_launch(8799) == "crash"
    assert launch_state.launch_info()["previous_boot_id"] == "old"


def test_other_ports_are_kept_and_a_live_owner_is_unknown(runs_dir):
    from services import launch_state
    _put(runs_dir, 8800, {"pid": 1, "boot_id": "x", "clean_exit": True})
    _put(runs_dir, 8799, {"pid": os.getppid(), "boot_id": "y", "clean_exit": False})
    assert launch_state.record_launch(8799) == "unknown"
    launch_state.record_clean_exit()
    assert _run(runs_dir, 8800) == {"pid": 1, "boot_id": "x", "clean_exit": True}


def test_clean_exit_never_marks_another_run(runs_dir):
    from services import launch_state
    launch_state.record_launch(8799)
    entry = _run(runs_dir)
    entry["boot_id"] = "someone-else"
    _put(runs_dir, 8799, entry)
    launch_state.record_clean_exit()
    assert _run(runs_dir)["clean_exit"] is False


def test_endpoint_reports_launch(client, runs_dir):
    from services import launch_state
    launch_state.record_launch(8799)
    body = client.get("/api/session/launch").json()
    assert body["boot_id"] == launch_state.launch_info()["boot_id"]
    assert body["previous_exit"] == "none"


# --- real server restarts (the e2e reopen spec drives the page on top of this) ----

def _free_port() -> int:
    with socket.socket() as sock:
        bind_test_port(sock)
        return sock.getsockname()[1]


def _start(port: int, env: dict) -> tuple:
    proc = subprocess.Popen([sys.executable, "browser.py", "-p", str(port), "--no-open", "--no-token",
                             "--copilot", "off"], cwd=REPO, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/session/launch", timeout=2) as res:
                return proc, json.loads(res.read())
        except OSError:
            if proc.poll() is not None:
                raise RuntimeError("server exited")
            time.sleep(0.3)
    proc.kill()
    raise RuntimeError("server did not start")


def test_restart_after_quit_is_clean_and_after_kill_is_crash(tmp_path):
    port = _free_port()
    env = {**os.environ, "FIBERBROWSER_RUNTIME_FILE": str(tmp_path / "browser_runtime.json"),
           "FIBERBROWSER_NO_OPEN": "1", "PYTHONUNBUFFERED": "1",
           # Only this test port: a busy port fails the test rather than moving the server outside the test ports.
           "FIBERBROWSER_PORT_MIN": str(port), "FIBERBROWSER_PORT_MAX": str(port)}
    proc, first = _start(port, env)
    try:
        assert first["previous_exit"] == "none"
        proc.send_signal(signal.SIGTERM)  # what Quit, the app's Quit and Ctrl+C come down to
        proc.wait(30)
        proc, second = _start(port, env)
        assert second["previous_exit"] == "clean" and second["previous_boot_id"] == first["boot_id"]
        proc.kill()  # a crash: no shutdown runs
        proc.wait(30)
        proc, third = _start(port, env)
        assert third["previous_exit"] == "crash" and third["previous_boot_id"] == second["boot_id"]
    finally:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(30)
            except subprocess.TimeoutExpired:
                proc.kill()


def test_desktop_app_quit_then_relaunch_is_clean(tmp_path, monkeypatch):
    """The app path: DesktopApp starts the server as its child and File > Quit,
    Cmd+Q or the last window closed stop it (stop_server: SIGTERM)."""
    home = tmp_path / "home"
    monkeypatch.setenv("HOME", str(home))  # the app's log and cache, never the user's
    monkeypatch.setenv("FIBERBROWSER_RUNTIME_FILE", str(home / ".fiberhmm" / "browser_runtime.json"))
    from fiberbrowser import desktop

    def launch(app):
        request = urllib.request.Request(f"{app.base}/api/session/launch",
                                         headers={"X-FiberBrowser-Token": app.token})
        with urllib.request.urlopen(request, timeout=5) as res:
            return json.loads(res.read())

    port = _free_port()
    apps = []
    try:
        first_app = desktop.DesktopApp([], port=port)
        apps.append(first_app)
        first_app.start_server()
        assert first_app.wait_ready(120), first_app.log_path.read_text()[-2000:]
        first = launch(first_app)
        first_app.stop_server()
        second_app = desktop.DesktopApp([], port=port)
        apps.append(second_app)
        second_app.start_server()
        assert second_app.wait_ready(120)
        second = launch(second_app)
        assert second["previous_exit"] == "clean" and second["previous_boot_id"] == first["boot_id"]
    finally:
        for app in apps:
            app.stop_server()
