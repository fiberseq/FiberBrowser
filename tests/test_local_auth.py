"""Per-launch access token on local servers (audit section 2, 'Local mode has no authentication')."""
from __future__ import annotations

import json
import os
import stat
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from services import local_auth


@pytest.fixture
def anonymous(standalone_app):
    """A client with no token: another user or program on this machine."""
    return TestClient(standalone_app)


def test_requests_without_the_token_are_refused(anonymous):
    for method, path in (("GET", "/api/status"), ("GET", "/api/files/list?path=/etc"),
                         ("POST", "/api/session/read"), ("POST", "/api/quit")):
        resp = anonymous.request(method, path)
        assert resp.status_code == 401, (method, path)
        assert "access link" in resp.json()["message"]


def test_page_loads_without_the_token_get_an_explanation(anonymous):
    resp = anonymous.get("/", headers={"Accept": "text/html"})
    assert resp.status_code == 401
    assert "access link" in resp.text and "browser_runtime.json" in resp.text
    assert local_auth.get_token() not in resp.text


def test_the_token_in_a_header_query_or_cookie_is_accepted(anonymous):
    token = local_auth.get_token()
    assert anonymous.get("/api/status", headers={"X-FiberBrowser-Token": token}).status_code == 200
    assert anonymous.get("/api/status", headers={"Authorization": f"Token {token}"}).status_code == 200
    assert anonymous.get("/api/status", headers={"X-FiberBrowser-Token": token + "x"}).status_code == 401
    opened = anonymous.get(f"/api/status?token={token}")
    assert opened.status_code == 200
    set_cookie = opened.headers["set-cookie"]
    assert set_cookie.startswith(f"{local_auth.cookie_name()}={token}")
    assert "HttpOnly" in set_cookie and "SameSite=strict" in set_cookie.replace("Strict", "strict")
    # The browser that opened the link now needs nothing else.
    assert anonymous.get("/api/datasets").status_code == 200


def test_static_assets_and_preflights_need_no_token(anonymous):
    assert anonymous.get("/assets/index-abc.js").status_code != 401
    assert anonymous.options("/api/status").status_code != 401


def test_public_servers_and_no_token_need_none(anonymous, monkeypatch):
    from services import runtime
    monkeypatch.setattr(runtime, "_public_mode", True)
    assert anonymous.get("/api/status").status_code == 200
    monkeypatch.setattr(runtime, "_public_mode", False)
    monkeypatch.setattr(local_auth, "_enabled", False)
    assert anonymous.get("/api/status").status_code == 200


def test_cookie_names_are_per_port_and_urls_carry_the_token(monkeypatch):
    monkeypatch.setattr(local_auth, "_port", 8123)
    assert local_auth.cookie_name() == "fiberbrowser_token_8123"
    url = local_auth.tokened_url("http://localhost:8123/?render=1&token=old")
    assert url == f"http://localhost:8123/?render=1&token={local_auth.get_token()}"


def test_configure_uses_fiberbrowser_token_or_a_fresh_one(monkeypatch):
    saved = (local_auth._token, local_auth._enabled, local_auth._port)
    try:
        monkeypatch.setenv("FIBERBROWSER_TOKEN", "fixed-token-for-scripts")
        assert local_auth.configure_local_auth(port=9000) == "fixed-token-for-scripts"
        monkeypatch.delenv("FIBERBROWSER_TOKEN")
        first = local_auth.configure_local_auth(port=9000)
        assert len(first) >= 32 and local_auth.configure_local_auth(port=9000) != first
    finally:
        local_auth._token, local_auth._enabled, local_auth._port = saved


def test_runtime_file_is_private_and_found_by_browser_client(tmp_path, monkeypatch):
    import browser_client
    path = tmp_path / "browser_runtime.json"
    monkeypatch.setenv("FIBERBROWSER_RUNTIME_FILE", str(path))
    local_auth.record_running_server(8123, "http://localhost:8123/?token=x")
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    entry = json.loads(path.read_text())["servers"]["8123"]
    assert entry["token"] == local_auth.get_token() and entry["pid"] == os.getpid()
    assert browser_client._token_from_runtime_file("http://localhost:8123") == local_auth.get_token()
    assert browser_client._token_from_runtime_file("http://localhost:8124") is None
    local_auth.forget_running_server(8123)
    assert "8123" not in json.loads(path.read_text())["servers"]


def test_browser_client_takes_the_printed_link():
    import browser_client
    assert browser_client._split_token("http://localhost:8000/?token=abc") == ("http://localhost:8000", "abc")
    assert browser_client._split_token("http://localhost:8000") == ("http://localhost:8000", None)


def test_browser_client_sends_the_token(monkeypatch):
    import browser_client
    seen = {}

    class FakeSession:
        def __init__(self):
            self.headers = {}

        def get(self, url, **kwargs):
            seen["headers"] = dict(self.headers)
            return type("R", (), {"status_code": 200, "raise_for_status": lambda self: None})()

    monkeypatch.setattr(browser_client.requests, "Session", FakeSession)
    client = browser_client.BrowserClient("http://localhost:8000/?token=abc")
    assert client.url == "http://localhost:8000" and seen["headers"]["X-FiberBrowser-Token"] == "abc"


def test_headless_render_worker_opens_the_tokened_page(monkeypatch):
    from models.domain import Dataset
    from models.requests import RenderRequest
    from state.browser_state import BrowserState
    import services.playwright_render as pr
    state = BrowserState(None)
    state.datasets["A"] = Dataset("A", "A.bam", label="A")
    state.dataset_order.append("A")
    sent = {}

    def fake_submit(envelope, timeout_s):
        sent.update(envelope)
        raise pr._WorkerError("stop here")

    monkeypatch.setattr(pr._WORKER, "submit", fake_submit)
    pr.render_with_playwright(RenderRequest(chrom="c", start=0, end=10, engine="playwright"), state)
    assert f"token={local_auth.get_token()}" in sent["url"]


def test_new_window_children_get_their_own_token(client, monkeypatch):
    import subprocess
    import routers.utility as utility
    spawned = {}

    class FakeProc:
        pid = 4242

    def fake_popen(cmd, **kwargs):
        spawned.update(cmd=cmd, env=kwargs.get("env") or {})
        return FakeProc()

    monkeypatch.setattr(subprocess, "Popen", fake_popen)
    monkeypatch.setattr(utility, "check_port_in_use", lambda port: None)
    body = client.post("/api/new-window").json()
    child_token = spawned["env"]["FIBERBROWSER_TOKEN"]
    assert child_token and child_token != local_auth.get_token()
    assert body["url"].endswith(f"?token={child_token}")
    assert "--no-open" in spawned["cmd"]


def test_drop_window_helper_sends_the_token():
    from services.dataset_endpoint import build_drop_window_script
    script = build_drop_window_script(8000)
    compile(script, "drop_window.py", "exec")
    assert "X-FiberBrowser-Token" in script and "FIBERBROWSER_TOKEN" in script


@pytest.mark.parametrize("module_name", ["services.local_auth", "browser_client"])
def test_liveness_probe_never_signals_on_windows(monkeypatch, module_name):
    # os.kill(pid, 0) is TerminateProcess on Windows: probing a recorded server
    # must not kill it (or the user's other FiberBrowsers).
    import importlib
    import sys
    import types
    module = importlib.import_module(module_name)
    probe = module.pid_alive if hasattr(module, "pid_alive") else module._pid_alive
    opened = []
    kernel32 = types.SimpleNamespace(OpenProcess=lambda access, inherit, pid: opened.append(pid) or 7,
                                     CloseHandle=lambda handle: True)
    fake_ctypes = types.SimpleNamespace(windll=types.SimpleNamespace(kernel32=kernel32))
    monkeypatch.setitem(sys.modules, "ctypes", fake_ctypes)
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(os, "kill", lambda *a: pytest.fail("os.kill called on Windows"))
    assert probe(4321) is True and opened == [4321]
    assert probe("not-a-pid") is False
