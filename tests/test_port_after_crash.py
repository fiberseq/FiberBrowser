"""A crashed server's port is free for the next launch on it.

The page's autosave (crash recovery, "Reopen your last session") is per
origin, so a relaunch has to come back on the same port. After a server was
killed, two leftovers made the launchers move to the next port, although
nothing listened there any more (no orphan process; nothing inherited the
socket):
- the open tab's client connections (CLOSE_WAIT), which `lsof -i :PORT`
  reported as the "process using the port" (browser.py, utils/ports.py);
- the server side's TIME_WAIT entries (~30 s), on which the app's plain
  test bind failed (fiberbrowser/desktop.py port_is_free).
"""
from __future__ import annotations

from conftest import bind_test_port

import http.client
import json
import os
import signal
import socket
import subprocess
import sys
import textwrap
import time
import urllib.request
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
if str(REPO) not in sys.path:
    sys.path.append(str(REPO))

from fiberbrowser import desktop  # noqa: E402
from services import server_startup  # noqa: E402
from utils import ports  # noqa: E402

# A server like uvicorn: SO_REUSEADDR, 127.0.0.1, keeps every connection open.
_LISTENER = textwrap.dedent("""
    import socket, sys
    srv = socket.socket()
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    for port in [int(p) for p in sys.argv[1].split(",")]:
        try:
            srv.bind(("127.0.0.1", port))
            break
        except OSError:
            continue
    else:
        raise RuntimeError("No free test port in " + sys.argv[1])
    srv.listen(8)
    print(srv.getsockname()[1], flush=True)
    held = []
    close_first = len(sys.argv) > 2
    while True:
        conn, _ = srv.accept()
        conn.sendall(b"hi")
        if close_first:
            conn.close()  # the server closes first: its side ends in TIME_WAIT
        else:
            held.append(conn)
""")


def _start_listener(*args: str) -> tuple[subprocess.Popen, int]:
    from port_list import free_ports
    ports = ",".join(map(str, free_ports())) or "0"
    proc = subprocess.Popen([sys.executable, "-c", _LISTENER, ports, *args], stdout=subprocess.PIPE, text=True)
    return proc, int(proc.stdout.readline())


def _connect(port: int) -> socket.socket:
    client = socket.create_connection(("127.0.0.1", port), timeout=5)
    assert client.recv(2) == b"hi"
    return client


def _children(pid: int) -> list[str]:
    return subprocess.run(["pgrep", "-P", str(pid)], capture_output=True, text=True).stdout.split()


def _free_within(port: int, seconds: float = 5.0) -> tuple:
    deadline = time.monotonic() + seconds
    while True:
        state = (ports.check_port_in_use(port), desktop.port_is_free(port))
        if state == (None, True) or time.monotonic() > deadline:
            return state
        time.sleep(0.2)


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX signals and pgrep")
def test_a_killed_servers_port_is_free_while_a_tab_is_still_connected():
    proc, port = _start_listener()
    clients = [_connect(port) for _ in range(3)]
    try:
        assert ports.check_port_in_use(port) in (proc.pid, -1)
        assert desktop.port_is_free(port) is False
        assert _children(proc.pid) == []
        proc.send_signal(signal.SIGKILL)
        proc.wait(10)
        # The tab's sockets are still open (CLOSE_WAIT): they don't hold the port.
        assert _free_within(port) == (None, True)
        assert server_startup._resolve_port(port) == port
    finally:
        for client in clients:
            client.close()
        if proc.poll() is None:
            proc.kill()
            proc.wait(10)
    # ...nor do the server side's TIME_WAIT entries once the tab let go.
    time.sleep(0.3)
    assert _free_within(port) == (None, True)


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX TIME_WAIT on the bind")
def test_a_stopped_servers_time_wait_does_not_hold_the_port():
    proc, port = _start_listener("close-first")
    try:
        for _ in range(3):
            client = _connect(port)
            assert client.recv(1) == b""  # the server closed first
            client.close()
        proc.terminate()
        proc.wait(10)
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(10)
    assert _free_within(port) == (None, True)
    assert desktop.pick_port([port]) == port


def test_without_lsof_a_live_loopback_listener_is_in_use(monkeypatch):
    """Windows, or no lsof: the fallback must see a 127.0.0.1 listener (the
    server's own bind); a 0.0.0.0 bind with SO_REUSEADDR succeeds next to it
    on macOS, so the old probe called the port free."""
    def no_lsof(*args, **kwargs):
        raise FileNotFoundError("lsof")

    monkeypatch.setattr(ports.subprocess, "run", no_lsof)
    with socket.socket() as server:
        bind_test_port(server)
        server.listen(1)
        port = server.getsockname()[1]
        assert ports.check_port_in_use(port) == -1
    assert ports.check_port_in_use(port) is None


def test_a_port_bound_without_listening_is_in_use():
    """Nothing to connect to, nothing lsof lists as LISTEN, but the server's
    bind would fail (Codex review). The holder binds as most programs do,
    without SO_REUSEADDR: on Linux a server's SO_REUSEADDR bind and listen
    succeed next to a SO_REUSEADDR holder that never listens, so that port
    is in fact usable there."""
    from port_list import free_ports, no_free_port_error
    with socket.socket() as holder:
        for candidate in free_ports():
            try:
                holder.bind(("127.0.0.1", candidate))
                break
            except OSError:
                continue
        else:
            raise no_free_port_error()
        port = holder.getsockname()[1]
        assert ports.check_port_in_use(port) == -1
        assert server_startup._check_port_in_use(port, "127.0.0.1") == -1
        assert desktop.port_is_free(port) is False


def test_the_app_skips_a_port_another_server_listens_on_from_0_0_0_0():
    with socket.socket() as server:
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        bind_test_port(server, "0.0.0.0")
        server.listen(1)
        port = server.getsockname()[1]
        assert desktop.port_is_free(port) is False
        assert ports.check_port_in_use(port) is not None


# --- the real server ------------------------------------------------------------

def _free_port() -> int:
    with socket.socket() as sock:
        bind_test_port(sock)
        return sock.getsockname()[1]


def _launch_state(port: int, timeout: float, proc: subprocess.Popen) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/session/launch", timeout=2) as res:
                return json.loads(res.read())
        except OSError:
            if proc.poll() is not None:
                raise RuntimeError("server exited")
            time.sleep(0.3)
    raise RuntimeError(f"no server on port {port}")


@pytest.mark.slow
@pytest.mark.skipif(sys.platform == "win32", reason="POSIX signals")
def test_relaunch_after_a_crash_with_the_tab_open_keeps_the_port(tmp_path):
    """tests/e2e/session-reopen.spec.ts "after a crash", without the browser:
    the restarted server comes back on its port and offers the crash recovery."""
    port = _free_port()
    env = {**os.environ, "FIBERBROWSER_RUNTIME_FILE": str(tmp_path / "browser_runtime.json"),
           "FIBERBROWSER_SETTINGS": str(REPO / "tests" / "__no_user_settings__.json"),
           "FIBERBROWSER_LIBRARY": str(tmp_path / "library.json"),
           "FIBERBROWSER_JOBS_DIR": str(tmp_path / "jobs"),
           "FIBERBROWSER_LIBRARY_NO_STARTUP_SCAN": "1",
           "FIBERBROWSER_NO_OPEN": "1", "PYTHONUNBUFFERED": "1",
           "FIBERBROWSER_PORT_MIN": str(port), "FIBERBROWSER_PORT_MAX": str(port)}
    cmd = [sys.executable, "browser.py", "-p", str(port), "--no-open", "--no-token", "--copilot", "off"]
    procs = []
    tab = None
    try:
        first_log = tmp_path / "first.log"
        with open(first_log, "w") as out:
            procs.append(subprocess.Popen(cmd, cwd=REPO, env=env, stdin=subprocess.DEVNULL,
                                          stdout=out, stderr=subprocess.STDOUT))
        try:
            first = _launch_state(port, 90, procs[-1])
        except RuntimeError:
            pytest.fail(first_log.read_text()[-2000:])
        # The open tab: a kept-alive connection to the server.
        tab = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        tab.request("GET", "/api/status")
        tab.getresponse().read()
        assert _children(procs[-1].pid) == []  # nothing that could outlive it
        procs[-1].kill()  # a crash
        procs[-1].wait(30)
        log = tmp_path / "second.log"
        with open(log, "w") as out:
            procs.append(subprocess.Popen(cmd, cwd=REPO, env=env, stdin=subprocess.DEVNULL,
                                          stdout=out, stderr=subprocess.STDOUT))
        try:
            second = _launch_state(port, 90, procs[-1])
        except RuntimeError:
            pytest.fail(log.read_text()[-2000:])
        assert "instead" not in log.read_text()
        assert second["previous_exit"] == "crash" and second["previous_boot_id"] == first["boot_id"]
    finally:
        if tab is not None:
            tab.close()
        for proc in procs:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(30)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(10)
