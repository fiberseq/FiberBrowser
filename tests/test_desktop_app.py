"""The app window (fiberbrowser.desktop) and the Mac app's entry (frozen_entry).

The GUI itself is exercised by building the app (packaging/macos/build_app.sh,
check_app.sh); these cover the logic around it."""
from port_list import bind_test_port

import socket
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.append(str(ROOT))

from fiberbrowser import desktop, frozen_entry  # noqa: E402


def test_windows_open_with_the_token_and_only_this_server_opens_in_the_app():
    base = "http://127.0.0.1:8756"
    assert desktop.with_token(base + "/?sandbox=sb-1&tour=1", "T") == base + "/?sandbox=sb-1&tour=1&token=T"
    assert desktop.with_token(base + "/?token=old", "new") == base + "/?token=new"
    assert desktop.is_same_server("http://localhost:8756/?workspace=new", base)
    assert not desktop.is_same_server("http://127.0.0.1:8000/", base)
    assert not desktop.is_same_server("https://genome.ucsc.edu/", base)


def test_page_requests_for_new_windows(monkeypatch):
    app = desktop.DesktopApp([], port=8756)
    opened, external = [], []
    monkeypatch.setattr(app, "create_window", lambda url=None, title="", html=None: opened.append((url, title)))
    monkeypatch.setattr(desktop.webbrowser, "open", lambda url: external.append(url))
    assert app.open_url("http://127.0.0.1:8756/?sandbox=sb-123&tour=1")
    assert opened == [(f"http://127.0.0.1:8756/?sandbox=sb-123&tour=1&token={app.token}", "FiberBrowser tour")]
    assert app.open_url("https://github.com/example-user/FiberBrowser")
    assert external == ["https://github.com/example-user/FiberBrowser"]
    assert not app.open_url("file:///etc/passwd")


def test_window_open_shim_covers_the_tour_tab_pattern():
    shim = desktop.WINDOW_OPEN_SHIM
    # openTourTab: window.open('about:blank') first, then tab.location.href = url.
    assert "set href(value)" in shim and "about:blank" in shim
    assert "pywebview.api.open_window" in shim
    assert 'a[target="_blank"]' in shim


def test_server_command_and_environment(monkeypatch):
    monkeypatch.setattr(desktop, "is_frozen", lambda: False)
    cmd = desktop.server_command(["-b", "x.bam"], 8757)
    assert cmd[:3] == [sys.executable, "-m", "fiberbrowser"]
    # The app's server runs without the Copilot (tests/test_copilot_left_out.py).
    assert cmd[3:] == ["-b", "x.bam", "--port", "8757", "--no-open-browser", "--no-copilot"]
    env = desktop.server_environment("tok", 4242, {"PATH": "/usr/bin"})
    assert env["FIBERBROWSER_TOKEN"] == "tok" and env["FIBERBROWSER_EXIT_WITH_PARENT"] == "4242"
    assert "NUMBA_CACHE_DIR" not in env
    monkeypatch.setattr(desktop, "is_frozen", lambda: True)
    assert desktop.server_command([], 8757)[:2] == [sys.executable, "--serve"]
    env = desktop.server_environment("tok", 4242, {"PATH": "/usr/bin"})
    assert "FiberBrowser" in env["NUMBA_CACHE_DIR"] or "fiberbrowser" in env["NUMBA_CACHE_DIR"]


def test_pick_port_skips_a_taken_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as held:
        bind_test_port(held)
        held.listen(1)
        taken = held.getsockname()[1]
        assert desktop.pick_port([taken]) != taken
        free = desktop.pick_port([])
        assert isinstance(free, int) and free > 0


def test_frozen_entry_roles():
    exe = "/Applications/FiberBrowser.app/Contents/MacOS/FiberBrowser"
    classify = frozen_entry.classify
    assert classify([], exe) == ("app", [])
    assert classify(["-psn_0_12345"], exe) == ("app", [])
    assert classify(["--serve", "-p", "8756"], exe) == ("serve", ["-p", "8756"])
    # FiberHMM's pipeline: [sys.executable, "-m", "fiberhmm.cli.call", ...]
    assert classify(["-m", "fiberhmm.cli.call", "-i", "x"], exe) == ("module", ["fiberhmm.cli.call", "-i", "x"])
    # loky workers and multiprocessing helpers, with interpreter flags
    assert classify(["-B", "-s", "-m", "joblib.externals.loky.backend.popen_loky_posix", "--pipe", "5"], exe)[0] == "module"
    assert classify(["-W", "ignore", "-c", "print(1)"], exe) == ("code", ["print(1)"])
    # /api/new-window: [sys.executable, sys.argv[0], ...] where argv[0] is browser.py or the binary
    assert classify([exe, "--dataset", "a.bam"], exe) == ("app", ["--dataset", "a.bam"])
    assert classify(["/x/fiberbrowser/browser.py", "--port", "8001"], exe) == \
        ("script", ["/x/fiberbrowser/browser.py", "--port", "8001"])
    assert classify(["--entry-point", "fiberhmm-pipeline", "--help"], exe) == \
        ("entry-point", ["fiberhmm-pipeline", "--help"])
    assert classify(["--multiprocessing-fork", "tracker_fd=5"], exe)[0] == "mp-fork"


def test_frozen_entry_runs_modules_and_code(monkeypatch, capsys):
    monkeypatch.setattr(frozen_entry, "configure_frozen_process", lambda: None)
    monkeypatch.setattr(sys, "argv", ["FiberBrowser"])
    assert frozen_entry.run(["-c", "print('hello from -c')"]) == 0
    assert "hello from -c" in capsys.readouterr().out
    with pytest.raises(SystemExit):  # `python -m json.tool --help` exits after printing
        frozen_entry.run(["-m", "json.tool", "--help"])
    assert "json.tool" in capsys.readouterr().out


def test_frozen_module_role_finds_modules_in_the_working_directory(monkeypatch, tmp_path, capsys):
    """`FiberBrowser -m services.link_proxy` from browser/ (how the server starts
    the link relay) finds the backend package, as `python -m` would."""
    import os
    pkg = tmp_path / "relaypkg"
    pkg.mkdir()
    (pkg / "__init__.py").write_text("")
    (pkg / "relay.py").write_text("print('PORT 1')\n")
    monkeypatch.setattr(frozen_entry, "configure_frozen_process", lambda: None)
    monkeypatch.setattr(sys, "argv", ["FiberBrowser"])
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(sys, "path", [p for p in sys.path if p not in ("", ".", os.getcwd())])
    assert frozen_entry.run(["-m", "relaypkg.relay"]) == 0
    assert "PORT 1" in capsys.readouterr().out


def test_an_explicit_port_is_used_when_free():
    assert desktop.split_port(["-b", "x.bam", "-p", "9001"]) == (9001, ["-b", "x.bam"])
    assert desktop.split_port(["--port=9002", "--standalone"]) == (9002, ["--standalone"])
    assert desktop.split_port(["-b", "x.bam"]) == (None, ["-b", "x.bam"])
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        bind_test_port(probe)
        free = probe.getsockname()[1]
    app = desktop.DesktopApp(["--port", str(free)])
    assert app.port == free and "--port" not in app.server_args
    assert desktop.server_command(app.server_args, app.port).count("--port") == 1


# --- the app's server log and a server that dies ---------------------------------
# The user's app log (~/.fiberhmm/logs/fiberbrowser-app-server.log) ended at
# startup although the app ran for an hour: the server logged nothing more
# (uvicorn at "warning", no access log), and a crash would have closed every
# window without a word.

FAKE_BROWSER = r'''
import sys, threading, time
print("fake server up")
threading.Thread(target=lambda: 1 / 0, name="worker").start()
time.sleep(60)
'''


def test_the_server_log_is_written_while_the_server_runs(monkeypatch, tmp_path):
    """Output and a thread's traceback reach the log at once, not when the server exits."""
    import subprocess
    import time
    script = tmp_path / "browser.py"
    script.write_text(FAKE_BROWSER)
    child = ("import sys; sys.path.insert(0, {root!r}); import fiberbrowser.cli as cli; "
             "from pathlib import Path; cli.browser_script = lambda: Path({script!r}); "
             "cli.prepare_process_environment = lambda: None; cli.run_server([])").format(
                 root=str(ROOT), script=str(script))
    monkeypatch.setenv("FIBERBROWSER_LOG_DIR", str(tmp_path / "logs"))
    # As in the frozen app, where PYTHONUNBUFFERED is ignored: an empty value is "unset".
    monkeypatch.setenv("PYTHONUNBUFFERED", "")
    monkeypatch.setattr(desktop, "server_command", lambda args, port: [sys.executable, "-c", child])
    app = desktop.DesktopApp([], port=8799)
    app.start_server()
    try:
        deadline = time.monotonic() + 20
        text = ""
        while time.monotonic() < deadline:
            text = app.log_path.read_text()
            if "fake server up" in text and "ZeroDivisionError" in text:
                break
            time.sleep(0.1)
        assert app.proc.poll() is None  # still running: nothing was flushed by an exit
        assert text.startswith("FiberBrowser ") and "(started " in text.splitlines()[0]
        assert "fake server up" in text
        assert "uncaught ZeroDivisionError in thread worker" in text and "Traceback" in text
    finally:
        app.proc.kill()
        app.proc.wait()


class _FakeWindow:
    def __init__(self):
        self.html, self.destroyed = None, False

    def load_html(self, html):
        self.html = html

    def destroy(self):
        self.destroyed = True


class _DeadServer:
    def __init__(self, code):
        self.code = code

    def wait(self, timeout=None):
        return self.code

    def poll(self):
        return self.code


def _app_with_windows(monkeypatch, tmp_path, code):
    monkeypatch.setenv("FIBERBROWSER_LOG_DIR", str(tmp_path))
    app = desktop.DesktopApp([], port=8799)
    app.log_path.write_text("FiberBrowser 3.0.0 app server\nTraceback (most recent call last):\nMemoryError\n")
    app.proc = _DeadServer(code)
    app.windows = [_FakeWindow(), _FakeWindow()]
    return app


def test_a_crashed_server_shows_the_error_page_with_the_log(monkeypatch, tmp_path):
    import signal
    app = _app_with_windows(monkeypatch, tmp_path, -signal.SIGSEGV)
    first, second = app.windows
    app._watch_server()
    assert first.html and "FiberBrowser&#x27;s server stopped" in first.html
    assert "SIGSEGV" in first.html and "MemoryError" in first.html  # the log's tail
    assert not first.destroyed and second.destroyed
    assert "The server process exited (code -11)" in app.log_path.read_text()

    app = _app_with_windows(monkeypatch, tmp_path, 1)
    app._watch_server()
    assert "exit code 1" in app.windows[0].html


def test_quit_from_the_page_still_closes_the_app(monkeypatch, tmp_path):
    import signal
    app = _app_with_windows(monkeypatch, tmp_path, -signal.SIGTERM)  # Quit button / last tab closed
    app._watch_server()
    assert all(w.destroyed and w.html is None for w in app.windows)
    app = _app_with_windows(monkeypatch, tmp_path, 137)
    app._stopping = True  # the app is quitting: it stopped the server itself
    app._watch_server()
    assert all(not w.destroyed and w.html is None for w in app.windows)


# --- opening files in the app (owner report 2026-10-01) ------------------------------

class _FakeDialogWindow:
    def __init__(self, chosen):
        self.chosen = chosen
        self.calls = []

    def create_file_dialog(self, dialog_type, allow_multiple=False, file_types=()):
        self.calls.append((dialog_type, allow_multiple, tuple(file_types)))
        return self.chosen


def test_the_open_dialog_is_the_apps_own_with_the_shared_filters(monkeypatch):
    app = desktop.DesktopApp([], port=8756)
    window = _FakeDialogWindow(("/d/a.bam", "/d/a.bam.bai"))
    monkeypatch.setattr(app, "front_window", lambda: window)
    api = desktop._PageApi(app)
    assert api.pick_files("open", True) == {"success": True, "path": "/d/a.bam", "paths": ["/d/a.bam", "/d/a.bam.bai"]}
    _, multiple, types = window.calls[0]
    assert multiple is True
    assert types[0].startswith("Supported files (*.bam;*.bb;*.bigbed;") and types[-1] == "All files (*.*)"
    assert "Alignments (*.bam)" in types
    # Cancel is a cancel; a picker without a list (or no window) leaves it to the server's dialog.
    window.chosen = None
    assert api.pick_files("dataset", True)["cancelled"] is True
    assert window.calls[-1][2][0] == "Supported files (*.bam;*.bb;*.bigbed)"
    # "any" (run inputs, relinking...) is unfiltered: the server's dialog.
    assert api.pick_files("any", True)["success"] is False
    assert api.pick_files("gtf", False) == {"success": False, "cancelled": False, "path": None, "paths": [],
                                           "message": "The app's open dialog is not available for this picker."}
    monkeypatch.setattr(app, "front_window", lambda: None)
    assert api.pick_files("open", True)["cancelled"] is False


def test_dropped_files_reach_the_page_with_their_real_paths(monkeypatch):
    import types as pytypes

    handlers = []

    class Handlers:
        def __iadd__(self, handler):
            handlers.append(handler)
            return self

    class FakeHandler:
        def __init__(self, callback, prevent_default=False, stop_propagation=False):
            self.callback, self.prevent_default, self.stop_propagation = callback, prevent_default, stop_propagation

    dom_module = pytypes.ModuleType("webview.dom")
    dom_module.DOMEventHandler = FakeHandler
    monkeypatch.setitem(sys.modules, "webview", pytypes.ModuleType("webview"))
    monkeypatch.setitem(sys.modules, "webview.dom", dom_module)

    class Window:
        def __init__(self):
            self.dom = pytypes.SimpleNamespace(document=pytypes.SimpleNamespace(events=pytypes.SimpleNamespace(drop=Handlers())))
            self.ran = []

        def run_js(self, code):
            self.ran.append(code)

    app = desktop.DesktopApp([], port=8756)
    sent = []
    monkeypatch.setattr(app, "run_command", lambda window, name, args=None: sent.append((name, args)))
    window = Window()
    app._listen_for_drops(window)
    assert window.ran == ["window.__fiberbrowserNativeDrop = true;"]
    (handler,) = handlers
    # The page keeps handling the drop itself (no preventDefault/stopPropagation from here).
    assert handler.prevent_default is False and handler.stop_propagation is False
    handler.callback({"dataTransfer": {"files": [
        {"name": "a.bam", "pywebviewFullPath": "/data/a.bam"},
        {"name": "a.bam.bai", "pywebviewFullPath": "/data/a.bam.bai"},
        {"name": "from-a-web-page.bed"},
    ]}})
    # Every file, in the page's order (it matches them by position): two samples
    # with the same name from different folders stay two files.
    assert sent == [("native-drop", {"files": [{"name": "a.bam", "path": "/data/a.bam"},
                                               {"name": "a.bam.bai", "path": "/data/a.bam.bai"},
                                               {"name": "from-a-web-page.bed", "path": None}]})]
    # A drop with no paths still tells the page (it uploads instead of waiting).
    handler.callback({"dataTransfer": {"files": [{"name": "x.bed"}]}})
    assert sent[-1] == ("native-drop", {"files": [{"name": "x.bed", "path": None}]})


def test_about_says_which_fiberhmm_the_server_runs(monkeypatch):
    """The app may run a custom FiberHMM: About asks the server (/api/app/info), not this window's package."""
    from fiberbrowser import desktop
    from fiberbrowser.app_menu import iter_items
    app = desktop.DesktopApp(port=8799)
    monkeypatch.setattr(app, "server_fiberhmm", lambda: {
        "source": "bundled", "version": "3.0.0", "package_dir": "/A/fiberhmm",
        "running": {"version": "3.0.1", "path": "/App/Contents/Resources/fiberhmm"},
        "notices": ["Custom FiberHMM at /src lacks the X; using the bundled FiberHMM 3.0.1."]})
    text = app.about_text()
    assert "FiberHMM 3.0.1 (bundled) at /App/Contents/Resources/fiberhmm" in text
    assert "lacks the X; using the bundled FiberHMM 3.0.1." in text
    monkeypatch.setattr(app, "server_fiberhmm", lambda: None)
    assert app.about_text().splitlines()[1] == f"FiberHMM {desktop.fiberhmm_version()}"
    assert any(i.kind == "command" and i.target == "check-updates" for i in iter_items())
