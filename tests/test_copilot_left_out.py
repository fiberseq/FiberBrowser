"""FiberBrowser.app leaves the Copilot out (--no-copilot / FIBERBROWSER_COPILOT=off).

The server reports it (/api/status features.copilot), marks the page so the UI
hides every Copilot entry point, refuses the /api/nl routes with a plain
reason, and never checks, downloads or starts a model (nor prints the hint to
pip-install mlx-lm). The desktop launcher passes the flag; the pip install
keeps the Copilot.
"""
from __future__ import annotations

import sys
from argparse import Namespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from services import runtime
from services.cli_args import parse_browser_args as parse_args


@pytest.fixture
def copilot_left_out_server():
    runtime.set_copilot_included(False)
    try:
        yield
    finally:
        runtime.set_copilot_included(True)


@pytest.mark.parametrize("argv,env,left_out", [
    ([], {}, False),
    (["--no-copilot"], {}, True),
    ([], {"FIBERBROWSER_COPILOT": "off"}, True),
    ([], {"FIBERBROWSER_COPILOT": " OFF "}, True),
    ([], {"FIBERBROWSER_COPILOT": "0"}, True),
    ([], {"FIBERBROWSER_COPILOT": "on"}, False),
])
def test_the_flag_or_the_environment_leaves_the_copilot_out(argv, env, left_out):
    args = parse_args(argv)
    assert runtime.copilot_left_out(args, env) is left_out


def test_left_out_means_nothing_is_checked_downloaded_or_started(monkeypatch, capsys):
    import services.copilot_lifecycle as cl

    def must_not_run(*_a, **_k):
        raise AssertionError("the Copilot must not be set up when it is left out")

    for name in ("install_shutdown_handlers", "_adopt_or_free_port", "_pick_model",
                 "mlx_host_problem", "mlx_import_problem", "_record_error", "_set_active_backend"):
        monkeypatch.setattr(cl, name, must_not_run)
    args = parse_args(["--no-copilot", "--copilot", "mlx"])
    try:
        assert runtime.apply_copilot_inclusion(args, {}) is False
        assert args.copilot == "off"
        assert runtime.copilot_included() is False
        assert cl.setup_copilot(args) is False
    finally:
        runtime.set_copilot_included(True)
    out = capsys.readouterr()
    assert "mlx-lm" not in out.out + out.err and "pip install" not in out.out + out.err


def test_the_pip_install_keeps_the_copilot():
    args = parse_args(["--copilot", "auto"])
    try:
        assert runtime.apply_copilot_inclusion(args, {}) is True
        assert args.copilot == "auto" and runtime.copilot_included() is True
    finally:
        runtime.set_copilot_included(True)


def test_status_reports_whether_the_copilot_is_included(client, copilot_left_out_server):
    assert client.get("/api/status").json()["features"] == {"copilot": False}


def test_status_reports_the_copilot_by_default(client):
    assert client.get("/api/status").json()["features"] == {"copilot": True}


@pytest.mark.parametrize("method,path", [
    ("GET", "/api/nl/capabilities"),
    ("POST", "/api/nl/plan"),
    ("POST", "/api/nl/stream"),
    ("POST", "/api/nl/setup"),
    ("POST", "/api/nl/download"),
    ("GET", "/api/nl/share_status"),
    ("POST", "/api/nl/log_session"),
])
def test_copilot_routes_refuse_politely(client, copilot_left_out_server, method, path):
    response = client.request(method, path, json={"text": "cluster the reads"})
    assert response.status_code == 403
    assert "not included in FiberBrowser.app" in response.json()["detail"]
    assert "pip install" in response.json()["detail"]


def test_the_page_is_marked_so_the_ui_hides_the_copilot(tmp_path, copilot_left_out_server):
    from services.frontend_mount import mount_frontend
    script_dir = tmp_path / "browser"
    dist = script_dir / "frontend" / "dist"
    dist.mkdir(parents=True)
    (dist / "index.html").write_text("<html><head></head><body>app</body></html>")
    app = FastAPI()
    mount_frontend(app, str(script_dir), public_mode=False)
    assert "window.__FIBERBROWSER_NO_COPILOT__ = true" in TestClient(app).get("/").text
    runtime.set_copilot_included(True)
    assert "__FIBERBROWSER_NO_COPILOT__" not in TestClient(app).get("/").text


def test_the_desktop_app_starts_its_server_without_the_copilot(monkeypatch):
    from fiberbrowser import desktop
    for frozen in (False, True):
        monkeypatch.setattr(desktop, "is_frozen", lambda frozen=frozen: frozen)
        cmd = desktop.server_command(["-b", "x.bam"], 8757)
        assert cmd.count("--no-copilot") == 1
        # Already asked for: not passed twice.
        assert desktop.server_command(["--no-copilot"], 8757).count("--no-copilot") == 1
    # And the flag is one the server understands.
    assert parse_args(["--no-copilot"]).no_copilot is True


def test_the_frozen_app_binary_runs_every_server_without_the_copilot(monkeypatch, tmp_path):
    from fiberbrowser import frozen_entry, desktop
    monkeypatch.setattr(desktop, "user_cache_dir", lambda: tmp_path)
    monkeypatch.setattr("fiberbrowser.cli.prepare_process_environment", lambda: None)
    # Set (not deleted) first, so the test's own value is restored afterwards.
    monkeypatch.setenv("FIBERBROWSER_COPILOT", "on")
    monkeypatch.setattr(sys, "pycache_prefix", sys.pycache_prefix)
    for name in ("NUMBA_CACHE_DIR", "PYTHONPYCACHEPREFIX"):
        monkeypatch.setenv(name, str(tmp_path / name.lower()))
    frozen_entry.configure_frozen_process()
    import os
    assert os.environ["FIBERBROWSER_COPILOT"] == "off"
    assert runtime.copilot_left_out(Namespace(), os.environ) is True


def test_the_doctor_checks_the_install_only_when_the_copilot_is_left_out(monkeypatch, capsys):
    import services.copilot_doctor as doctor
    import services.copilot_lifecycle as cl

    def must_not_run(*_a, **_k):
        raise AssertionError("no Copilot check when it is left out")

    for name in ("mlx_host_problem", "mlx_import_problem", "_pick_model", "hub_endpoint"):
        monkeypatch.setattr(cl, name, must_not_run)
    monkeypatch.setenv("FIBERBROWSER_COPILOT", "on")
    # A clean install: also a pyBigWig that reads URLs (one without libcurl gets a fix; test_pybigwig_support).
    import services.pybigwig_support as pybigwig_support
    monkeypatch.setattr(pybigwig_support, "reads_urls", lambda: True)
    assert doctor.main(["--no-copilot", "--copilot-doctor", "--offline"]) == 0
    out = capsys.readouterr().out
    assert out.startswith("FiberBrowser setup check")
    assert "Copilot not included" in out and "Core packages load" in out
    assert "mlx-lm" not in out and "-m pip install" not in out
    monkeypatch.setenv("FIBERBROWSER_COPILOT", "off")
    assert doctor.main(["--copilot-doctor", "--offline"]) == 0
    assert "Copilot not included" in capsys.readouterr().out
