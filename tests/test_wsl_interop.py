"""Windows integration of a server running in WSL (services/wsl_interop.py).

WSL itself is mocked: ``is_wsl`` / ``WSL_DISTRO_NAME``, ``wslpath`` and the
Windows programs are stand-ins, so these run on any OS.
"""
import json
import os
import subprocess
import sys
from types import SimpleNamespace

import pytest
from fastapi import Body, FastAPI, Query
from fastapi.testclient import TestClient

from services import file_picker, library_endpoint, local_paths, wsl_interop
from services.remote_sources import ssh_command


@pytest.fixture
def wsl(monkeypatch, tmp_path):
    """Pretend to run in the FiberBrowser WSL distribution, with C: mounted at <tmp>/mnt/c."""
    monkeypatch.setenv("WSL_DISTRO_NAME", "FiberBrowser")
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(wsl_interop, "is_wsl", lambda: True)
    monkeypatch.setattr(local_paths, "is_wsl", lambda: True)
    monkeypatch.setattr(file_picker, "is_wsl", lambda: True)
    calls = []

    def fake_wslpath(flag, value):
        calls.append((flag, value))
        if flag == "-u" and len(value) > 1 and value[1] == ":":
            return "/mnt/" + value[0].lower() + "/" + value[3:].replace("\\", "/")
        if flag == "-w" and value.startswith("/mnt/c/"):
            return "C:\\" + value[len("/mnt/c/"):].replace("/", "\\")
        if flag == "-w":
            return "\\\\wsl.localhost\\FiberBrowser" + value.replace("/", "\\")
        return None

    monkeypatch.setattr(wsl_interop, "_wslpath", fake_wslpath)
    programs = {"powershell.exe": "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
                "explorer.exe": "/mnt/c/Windows/explorer.exe", "cmd.exe": "/mnt/c/Windows/System32/cmd.exe",
                "wsl.exe": "/mnt/c/Windows/System32/wsl.exe"}
    monkeypatch.setattr(wsl_interop, "windows_program", lambda name: programs.get(name))
    monkeypatch.setattr(file_picker, "windows_program", lambda name: programs.get(name))
    monkeypatch.setattr(wsl_interop, "windows_cwd", lambda: "/mnt/c")
    monkeypatch.setattr(file_picker, "windows_cwd", lambda: "/mnt/c")
    return SimpleNamespace(calls=calls, programs=programs)


# --- detection and programs --------------------------------------------------------

def test_is_wsl_from_environment_or_kernel(monkeypatch, tmp_path):
    monkeypatch.delenv("WSL_DISTRO_NAME", raising=False)
    monkeypatch.delenv("WSL_INTEROP", raising=False)
    version = tmp_path / "version"
    real_open = open

    def fake_open(path, *args, **kwargs):
        return real_open(version if path == "/proc/version" else path, *args, **kwargs)

    monkeypatch.setattr("builtins.open", fake_open)
    version.write_text("Linux version 5.15.153.1-microsoft-standard-WSL2 (gcc) #1 SMP")
    assert wsl_interop.is_wsl()
    version.write_text("Linux version 6.8.0-45-generic (buildd@lcy02)")
    assert not wsl_interop.is_wsl()
    monkeypatch.setenv("WSL_DISTRO_NAME", "FiberBrowser")
    assert wsl_interop.is_wsl()


def test_windows_program_found_on_the_windows_drive_without_the_windows_path(monkeypatch, tmp_path):
    exe = tmp_path / "c" / "Windows" / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
    exe.parent.mkdir(parents=True)
    exe.write_text("")
    monkeypatch.setattr(wsl_interop.shutil, "which", lambda name: None)
    monkeypatch.setattr(wsl_interop, "is_wsl", lambda: True)
    monkeypatch.setattr(wsl_interop, "_windows_mounts", lambda: [str(tmp_path / "d"), str(tmp_path / "c")])
    assert wsl_interop.windows_program("powershell.exe") == str(exe)
    assert wsl_interop.windows_program("explorer.exe") is None
    # On PATH (appendWindowsPath, the default): that one.
    monkeypatch.setattr(wsl_interop.shutil, "which", lambda name: f"/mnt/c/WINDOWS/{name}")
    assert wsl_interop.windows_program("explorer.exe") == "/mnt/c/WINDOWS/explorer.exe"


def test_outside_wsl_nothing_changes(monkeypatch):
    monkeypatch.setattr(wsl_interop, "is_wsl", lambda: False)
    assert wsl_interop.to_wsl_path("C:\\data\\a.bam") == "C:\\data\\a.bam"
    assert wsl_interop.to_windows_path("/home/me/a.bam") is None
    assert wsl_interop.reveal_argv("/home/me/a.bam") is None
    assert wsl_interop.terminal_argv("/tmp/login.command") is None
    assert wsl_interop.slow_mount_note("/mnt/c/data/a.bam") is None
    assert wsl_interop.install_windows_path_translation(FastAPI()) is False


# --- path translation -------------------------------------------------------------

@pytest.mark.parametrize("given, expected", [
    ("C:\\Users\\me\\data\\a.bam", "/mnt/c/Users/me/data/a.bam"),
    ("D:/runs/b.bam", "/mnt/d/runs/b.bam"),
    ("/C:/Users/me/a.bam", "/mnt/c/Users/me/a.bam"),               # file:///C:/... after the scheme
    ("\\\\wsl$\\FiberBrowser\\home\\fiberbrowser\\data\\a.bam", "/home/fiberbrowser/data/a.bam"),
    ("\\\\wsl.localhost\\fiberbrowser\\home\\fiberbrowser\\a.bam", "/home/fiberbrowser/a.bam"),
    ("//wsl.localhost/FiberBrowser/tmp/x.bam", "/tmp/x.bam"),
    ("/home/fiberbrowser/a.bam", "/home/fiberbrowser/a.bam"),    # already a Linux path
    ("s3://bucket/a.bam", "s3://bucket/a.bam"),
])
def test_windows_paths_become_wsl_paths(wsl, given, expected):
    assert wsl_interop.to_wsl_path(given) == expected


def test_drive_paths_fall_back_when_wslpath_fails(wsl, monkeypatch):
    monkeypatch.setattr(wsl_interop, "_wslpath", lambda flag, value: None)
    assert wsl_interop.to_wsl_path("E:\\lab data\\a.bam") == "/mnt/e/lab data/a.bam"
    assert wsl_interop.to_wsl_path("E:\\") == "/mnt/e"
    assert wsl_interop.to_windows_path("/mnt/e/lab data/a.bam") == "E:\\lab data\\a.bam"
    assert wsl_interop.to_windows_path("/home/fiberbrowser/a.bam") == \
        "\\\\wsl.localhost\\FiberBrowser\\home\\fiberbrowser\\a.bam"


def test_another_distribution_is_named_in_the_not_found_message(wsl, monkeypatch):
    monkeypatch.setattr(wsl_interop, "_wslpath", lambda flag, value: None)
    path = "\\\\wsl.localhost\\Ubuntu\\home\\me\\a.bam"
    assert wsl_interop.other_distro(path) == "Ubuntu"
    assert wsl_interop.other_distro("\\\\wsl$\\FiberBrowser\\home\\a.bam") is None
    message = local_paths.path_access_error(path, expected="file")
    assert "another WSL distribution (Ubuntu)" in message
    assert "FiberBrowser's own folder" in message


def test_normalize_local_path_and_file_uris(wsl):
    assert local_paths.normalize_local_path('"C:\\data\\a.bam"') == "/mnt/c/data/a.bam"
    assert local_paths.normalize_local_path("file:///C:/data/my%20a.bam") == "/mnt/c/data/my a.bam"
    assert local_paths.normalize_local_paths(["/x/a.bam", "C:\\b.bam"]) == ["/x/a.bam", "/mnt/c/b.bam"]


# --- Windows paths in requests ------------------------------------------------------

def _echo_app():
    app = FastAPI()

    @app.get("/q")
    def q(path: str = Query(...), label: str = Query("")):
        return {"path": path, "label": label}

    @app.post("/b")
    def b(payload: dict = Body(...)):
        return payload

    wsl_interop.install_windows_path_translation(app)
    return app


def test_requests_with_windows_paths_reach_endpoints_as_wsl_paths(wsl):
    client = TestClient(_echo_app())
    got = client.get("/q", params={"path": "C:\\Users\\me\\a b.bam", "label": "C:\\not a path key"}).json()
    assert got == {"path": "/mnt/c/Users/me/a b.bam", "label": "C:\\not a path key"}
    body = {"paths": ["C:\\a.bam", "/home/x/b.bam"], "output_dir": "D:\\out", "label": "E:\\keep",
            "fastaPath": "\\\\wsl$\\FiberBrowser\\home\\g.fa", "searchRoot": "C:\\data", "count": 3}
    got = client.post("/b", json=body).json()
    assert got == {"paths": ["/mnt/c/a.bam", "/home/x/b.bam"], "output_dir": "/mnt/d/out", "label": "E:\\keep",
                   "fastaPath": "/home/g.fa", "searchRoot": "/mnt/c/data", "count": 3}
    # Nothing Windows-like: the body goes through as sent.
    assert client.post("/b", json={"path": "/home/a.bam"}).json() == {"path": "/home/a.bam"}
    # Not JSON: untouched.
    assert client.post("/b", content=b"C:\\a", headers={"content-type": "text/plain"}).status_code == 422


def test_nested_objects_such_as_a_saved_session_are_left_alone(wsl):
    # A saved session sent back for checking uses its paths as keys too
    # (file_fingerprints): translating only the values would break the match.
    client = TestClient(_echo_app())
    session = {"datasets": [{"path": "C:\\data\\a.bam"}],
               "file_fingerprints": {"C:\\data\\a.bam": {"size": 1, "mtime": 2}}}
    body = {"session": session, "mapping": {"C:\\data\\a.bam": "D:\\new\\a.bam"},
            "anchor": {"old": "C:\\data\\a.bam", "new": "D:\\new\\a.bam"}, "search_root": "D:\\new"}
    got = client.post("/b", json=body).json()
    assert got["session"] == session and got["mapping"] == body["mapping"] and got["anchor"] == body["anchor"]
    assert got["search_root"] == "/mnt/d/new"


def test_large_and_streamed_bodies_reach_the_endpoint_unchanged(wsl):
    import asyncio

    received = {}

    async def endpoint(scope, receive, send):
        body = b""
        while True:
            message = await receive()
            body += message.get("body", b"")
            if not message.get("more_body"):
                break
        received["body"] = body
        received["headers"] = dict(scope["headers"])
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    middleware = wsl_interop.WindowsPathMiddleware(endpoint)

    def run(chunks):
        queue = list(chunks)

        async def receive():
            return queue.pop(0)

        async def send(message):
            pass

        scope = {"type": "http", "method": "POST", "query_string": b"",
                 "headers": [(b"content-type", b"application/json")]}
        asyncio.run(middleware(scope, receive, send))
        return received["body"]

    # Streamed in two chunks, no Windows path: the same bytes.
    assert run([{"type": "http.request", "body": b'{"path": ', "more_body": True},
                {"type": "http.request", "body": b'"/home/a.bam"}', "more_body": False}]) == b'{"path": "/home/a.bam"}'
    # Streamed with a Windows path: translated, with a matching content-length.
    out = run([{"type": "http.request", "body": b'{"path": "C:', "more_body": True},
               {"type": "http.request", "body": b'\\\\x.bam"}', "more_body": False}])
    assert json.loads(out) == {"path": "/mnt/c/x.bam"}
    assert received["headers"][b"content-length"] == str(len(out)).encode()
    # Over the limit: passed through untouched.
    big = b'{"path": "C:\\\\x.bam", "pad": "' + b"x" * wsl_interop.MAX_TRANSLATED_BODY + b'"}'
    assert run([{"type": "http.request", "body": big[:100], "more_body": True},
                {"type": "http.request", "body": big[100:], "more_body": False}]) == big


def test_path_translation_is_installed_only_in_wsl(wsl, monkeypatch):
    app = FastAPI()
    assert wsl_interop.install_windows_path_translation(app) is True
    monkeypatch.setattr(wsl_interop, "is_wsl", lambda: False)
    assert wsl_interop.install_windows_path_translation(FastAPI()) is False


def test_server_installs_the_translation_innermost():
    import pathlib
    source = (pathlib.Path(__file__).resolve().parents[1] / "browser" / "server.py").read_text()
    install = source.index("install_windows_path_translation(app)")
    assert install < source.index("install_request_origin_guard(app)")


# --- Show in Explorer -----------------------------------------------------------------

def test_reveal_selects_the_file_in_explorer(wsl, tmp_path):
    bam = tmp_path / "my data" / "a.bam"
    bam.parent.mkdir()
    bam.write_text("x")
    argv = wsl_interop.reveal_argv(str(bam))
    assert argv[0] == wsl.programs["explorer.exe"]
    assert argv[1] == "/select,"  # its own argument: a path with spaces is quoted alone
    assert argv[2].startswith("\\\\wsl.localhost\\FiberBrowser\\") and argv[2].endswith("my data\\a.bam")
    # A folder opens itself.
    assert wsl_interop.reveal_argv(str(bam.parent))[1:] == [argv[2].rsplit("\\", 1)[0]]


def test_library_reveal_uses_explorer_in_wsl(wsl, monkeypatch, tmp_path):
    bam = tmp_path / "a.bam"
    bam.write_text("x")
    monkeypatch.setattr(library_endpoint, "get_entry", lambda entry_id: {"path": str(bam)})
    launched = []
    monkeypatch.setattr(library_endpoint.subprocess, "Popen",
                        lambda argv, **kwargs: launched.append((argv, kwargs)) or SimpleNamespace())
    assert library_endpoint.reveal_entry("e1")["success"] is True
    argv, kwargs = launched[0]
    assert argv[0].endswith("explorer.exe") and argv[1] == "/select,"
    assert kwargs["cwd"] == "/mnt/c"


# --- open dialogs ------------------------------------------------------------------------

def test_open_dialog_uses_the_shared_filters_and_converts_the_choice(wsl, monkeypatch):
    seen = {}

    def fake_run(argv, **kwargs):
        import base64
        seen["argv"], seen["kwargs"] = argv, kwargs
        seen["script"] = base64.b64decode(argv[-1]).decode("utf-16-le")
        return subprocess.CompletedProcess(argv, 0, stdout="C:\\Users\\me\\é a.bam\r\nD:\\b.bb\r\n", stderr="")

    monkeypatch.setattr(file_picker.subprocess, "run", fake_run)
    result = file_picker.pick_file_payload("open", multiple=True)
    assert result == {"success": True, "paths": ["/mnt/c/Users/me/é a.bam", "/mnt/d/b.bb"],
                      "path": "/mnt/c/Users/me/é a.bam"}
    assert seen["argv"][0] == wsl.programs["powershell.exe"]
    assert seen["kwargs"]["encoding"] == "utf-8" and seen["kwargs"]["cwd"] == "/mnt/c"
    script = seen["script"]
    assert "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8" in script
    assert "ShowDialog($owner)" in script and "TopMost = $true" in script
    # The Supported-files filter of browser/frontend/src/data/supportedFiles.json, then All files.
    from services import supported_files
    assert supported_files.windows_filter("open") in script
    assert "$dlg.Filter = 'Supported files|" in script and script.count("All files|*.*") == 1


def test_open_dialog_cancel_and_busy(wsl, monkeypatch):
    monkeypatch.setattr(file_picker.subprocess, "run",
                        lambda argv, **kw: subprocess.CompletedProcess(argv, 0, stdout="\r\n", stderr=""))
    result = file_picker.pick_file_payload("dataset", multiple=True)
    assert result["success"] is False and result["cancelled"] is True
    assert file_picker._wsl_dialog_lock.acquire(blocking=False)
    try:
        busy = file_picker.pick_file_payload("dataset", multiple=True)
    finally:
        file_picker._wsl_dialog_lock.release()
    assert busy.get("busy") is True and "already open" in busy["message"]


def test_folder_dialog_in_wsl(wsl, monkeypatch):
    monkeypatch.setattr(file_picker.subprocess, "run",
                        lambda argv, **kw: subprocess.CompletedProcess(argv, 0, stdout="D:\\runs\r\n", stderr=""))
    assert file_picker.pick_folder_payload("Pick") == {"success": True, "path": "/mnt/d/runs"}


# --- ssh sign-in console --------------------------------------------------------------------

def test_ssh_sign_in_opens_a_windows_console_in_this_distribution(wsl):
    argv = ssh_command.terminal_launch_argv("/home/fiberbrowser/.fiberhmm/login-1.command")
    assert argv == [wsl.programs["cmd.exe"], "/c", "start", "FiberBrowser sign-in", "wsl.exe", "-d",
                    "FiberBrowser", "--", "sh", "/home/fiberbrowser/.fiberhmm/login-1.command"]


# --- large files on a Windows drive ---------------------------------------------------------

def test_slow_mount_note_for_large_files_on_a_windows_drive(wsl, monkeypatch, tmp_path):
    monkeypatch.setattr(wsl_interop.os.path, "getsize", lambda path: 3 << 30)
    monkeypatch.setattr(wsl_interop, "fast_data_folder", lambda: "/home/fiberbrowser/data")
    note = wsl_interop.slow_mount_note("/mnt/c/Users/me/big.bam")
    assert note and "Windows drive" in note
    assert "\\\\wsl.localhost\\FiberBrowser\\home\\fiberbrowser\\data" in note
    # The same text for every file: several such files show it once.
    assert wsl_interop.slow_mount_note("/mnt/d/other.bam") == note
    assert wsl_interop.slow_mount_note("/home/fiberbrowser/data/big.bam") is None
    assert wsl_interop.slow_mount_note("https://x/big.bam") is None
    monkeypatch.setattr(wsl_interop.os.path, "getsize", lambda path: 10 << 20)
    assert wsl_interop.slow_mount_note("/mnt/c/Users/me/small.bam") is None


def test_dataset_add_reports_the_slow_drive_note(wsl, monkeypatch):
    from models.requests import AddDatasetRequest
    from services import dataset_endpoint

    class FakeDataset:
        is_remote = False

        def to_dict(self):
            return {"id": "big"}

    state = SimpleNamespace(add_dataset=lambda dataset_id, path, label=None: FakeDataset())
    monkeypatch.setattr(dataset_endpoint, "validate_dataset_paths", lambda paths, raw: [])
    monkeypatch.setattr(dataset_endpoint, "ensure_local_bam_indexes", lambda paths: None)
    monkeypatch.setattr(wsl_interop, "slow_mount_note", lambda path: f"slow:{path}" if path.startswith("/mnt/") else None)
    result = dataset_endpoint.add_dataset_for_request(state, AddDatasetRequest(path="C:\\data\\big.bam"))
    assert result["success"] is True
    assert result["warnings"] == ["slow:/mnt/c/data/big.bam"]
    result = dataset_endpoint.add_dataset_for_request(state, AddDatasetRequest(path="/home/fiberbrowser/a.bam"))
    assert "warnings" not in result
