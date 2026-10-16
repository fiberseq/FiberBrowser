"""The Open OnDemand Batch Connect app (deploy/ondemand/fiberbrowser/), tested off-site.

The ERB templates are rendered with Ruby's ERB (as OnDemand does) and a mock
form; script.sh then runs with the variables before.sh would set (host, port,
password) and serves FiberBrowser behind deploy/ondemand/dev/rnode_proxy.py,
which strips /rnode/<host>/<port>/ like the portal.
"""
from __future__ import annotations

from conftest import bind_test_port

import http.client
import importlib.util
import json
import os
import secrets
import shutil
import socket
import stat
import subprocess
import sys
import threading
import time
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
APP = REPO / "deploy" / "ondemand" / "fiberbrowser"
RENDER = REPO / "deploy" / "ondemand" / "dev" / "render.rb"

needs_ruby = pytest.mark.skipif(shutil.which("ruby") is None, reason="ruby (ERB) not installed")


def render(template: Path, values: dict) -> str:
    result = subprocess.run(["ruby", str(RENDER), str(template), json.dumps(values)], capture_output=True,
                            text=True, timeout=60)
    assert result.returncode == 0, result.stderr
    return result.stdout


def _yaml(text: str):
    yaml = pytest.importorskip("yaml")
    return yaml.safe_load(text)


def test_app_files_are_all_there():
    for name in ("manifest.yml", "form.yml", "submit.yml.erb", "view.html.erb",
                 "template/before.sh.erb", "template/script.sh.erb", "template/after.sh.erb"):
        assert (APP / name).is_file(), name


def test_manifest_and_form_are_valid_yaml_with_the_fields_the_script_reads():
    manifest = _yaml((APP / "manifest.yml").read_text())
    assert manifest["role"] == "batch_connect" and manifest["name"] == "FiberBrowser"
    form = _yaml((APP / "form.yml").read_text())
    script = (APP / "template" / "script.sh.erb").read_text()
    for field in ("lab_data_dir", "run_output_dir", "lab_state_dir", "enable_runs", "fiberbrowser_setup",
                  "fiberbrowser_image", "num_cores"):
        assert field in form["form"], field
        assert f"context.{field}" in script, field
    assert {"bc_num_hours", "memory_gb", "num_cores"} <= set(form["form"])


@needs_ruby
def test_submit_and_view_render():
    submit = _yaml(render(APP / "submit.yml.erb", {"num_cores": "6", "memory_gb": "24"}))
    assert submit["batch_connect"]["template"] == "basic"
    assert "--cpus-per-task=6" in submit["script"]["native"] and "--mem=24G" in submit["script"]["native"]
    view = render(APP / "view.html.erb", {"host": "node7", "port": "8123", "password": "pw123"})
    assert 'action="/rnode/node7/8123/auth/token"' in view and 'name="token" value="pw123"' in view
    assert "?token=" not in view  # the token never goes into a URL


def _free_port() -> int:
    with socket.socket() as sock:
        bind_test_port(sock)
        return sock.getsockname()[1]


def _request(port: int, method: str, path: str, *, body: bytes | None = None, headers: dict | None = None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
    try:
        conn.request(method, path, body=body, headers=headers or {})
        response = conn.getresponse()
        return response.status, dict(response.getheaders()), response.read()
    finally:
        conn.close()


@pytest.fixture
def ondemand_session(tmp_path):
    """script.sh running as an OnDemand session would, behind a local /rnode/ proxy."""
    data, state, home, session_dir, bindir = (tmp_path / n for n in ("data", "state", "home", "session", "bin"))
    for folder in (data, state, home, session_dir, bindir):
        folder.mkdir()
    (data / "sample.bam").write_bytes(b"x")
    wrapper = bindir / "fiberbrowser"
    wrapper.write_text(f'#!/usr/bin/env bash\nexport PYTHONPATH="{REPO}${{PYTHONPATH:+:$PYTHONPATH}}"\n'
                       f'exec "{sys.executable}" -m fiberbrowser "$@"\n')
    wrapper.chmod(wrapper.stat().st_mode | stat.S_IXUSR)
    port, password, host = _free_port(), secrets.token_urlsafe(24), "localhost"
    script = render(APP / "template" / "script.sh.erb", {
        "lab_data_dir": str(data), "run_output_dir": "", "lab_state_dir": str(state), "fiberbrowser_image": "",
        "enable_runs": "1", "num_cores": "2", "fiberbrowser_setup": f'export PATH="{bindir}:$PATH"'})
    (session_dir / "script.sh").write_text(script)
    env = {**os.environ, "host": host, "port": str(port), "password": password, "HOME": str(home),
           "USER": "labmate", "SLURM_JOB_ID": "4242", "FIBERBROWSER_SETTINGS": str(tmp_path / "none.json"),
           "FIBERBROWSER_RUNTIME_FILE": str(tmp_path / "runtime.json"), "FIBERBROWSER_LIBRARY_NO_STARTUP_SCAN": "1"}
    env.pop("FIBERBROWSER_TOKEN", None)
    log = open(tmp_path / "output.log", "w")
    proc = subprocess.Popen(["bash", "script.sh"], cwd=session_dir, env=env, stdout=log, stderr=subprocess.STDOUT)
    spec = importlib.util.spec_from_file_location("rnode_proxy", REPO / "deploy" / "ondemand" / "dev" / "rnode_proxy.py")
    proxy_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(proxy_module)
    prefix = f"/rnode/{host}/{port}"
    from port_list import free_ports, no_free_port_error
    for proxy_port in free_ports():
        if proxy_port == port:
            continue  # the child may still be starting on its chosen port
        try:
            proxy = ThreadingHTTPServer(("127.0.0.1", proxy_port), proxy_module.make_handler(f"127.0.0.1:{port}", prefix, False, False))
            break
        except OSError:
            continue
    else:
        proc.terminate()
        proc.wait(timeout=15)
        raise no_free_port_error()
    threading.Thread(target=proxy.serve_forever, daemon=True).start()
    try:
        deadline = time.time() + 90
        while time.time() < deadline:
            assert proc.poll() is None, (tmp_path / "output.log").read_text()
            try:
                _request(port, "GET", "/api/status")
                break
            except OSError:
                time.sleep(0.5)
        else:
            pytest.fail("FiberBrowser did not start:\n" + (tmp_path / "output.log").read_text())
        yield {"proxy": proxy.server_address[1], "prefix": prefix, "password": password, "port": port,
               "data": data, "state": state, "home": home, "session": session_dir, "log": tmp_path / "output.log"}
    finally:
        proxy.shutdown()
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()


@needs_ruby
@pytest.mark.slow
def test_script_serves_fiberbrowser_behind_the_rnode_proxy(ondemand_session):
    s = ondemand_session
    proxy, prefix = s["proxy"], s["prefix"]
    # Without the session's password: nothing (another cluster user reaching the node).
    assert _request(proxy, "GET", f"{prefix}/api/datasets")[0] == 401
    assert _request(s["port"], "GET", "/api/datasets")[0] == 401
    form = {"Content-Type": "application/x-www-form-urlencoded"}
    assert _request(proxy, "POST", f"{prefix}/auth/token", body=b"token=wrong", headers=form)[0] == 401
    status, headers, _ = _request(proxy, "POST", f"{prefix}/auth/token",
                                  body=f"token={s['password']}".encode(), headers=form)
    assert status == 303 and headers["location"] == f"{prefix}/"
    cookie = headers["set-cookie"]
    assert f"Path={prefix}/" in cookie and "HttpOnly" in cookie
    jar = {"Cookie": cookie.split(";", 1)[0]}
    status, _, body = _request(proxy, "GET", f"{prefix}/api/auth/me", headers=jar)
    me = json.loads(body)
    assert status == 200 and me["user"] == {"name": "labmate", "role": "admin", "source": "none"}
    assert me["jobs"] is True
    listing = json.loads(_request(proxy, "GET", f"{prefix}/api/files/list", headers=jar)[2])
    assert listing["path"] == str(s["data"]) and [e["name"] for e in listing["entries"]] == ["sample.bam"]
    assert _request(proxy, "GET", f"{prefix}/api/files/list?path=/etc", headers=jar)[0] == 403
    assert _request(proxy, "GET", f"{prefix}/api/pipeline/jobs", headers=jar)[0] == 200
    page_status, _, page = _request(proxy, "GET", f"{prefix}/", headers={**jar, "Accept": "text/html"})
    if (REPO / "browser" / "frontend" / "dist" / "index.html").is_file():
        assert page_status == 200 and f'__FIBERBROWSER_ROOT__ = "{prefix}"'.encode() in page
    # The config it wrote, the shared state, and no token anywhere on disk or in the log.
    config = (s["session"] / "fiberbrowser-server.toml").read_text()
    assert 'profile = "lab"' in config and f'root_path = "{prefix}"' in config and 'mode = "none"' in config
    assert str(s["state"] / "jobs" / "localhost") in config
    assert (s["home"] / "fiberbrowser-runs").is_dir()
    assert s["password"] not in config and s["password"] not in s["log"].read_text()
    events = [json.loads(line)["event"] for line in (s["state"] / "audit.log").read_text().splitlines()]
    assert "server_start" in events


@needs_ruby
def test_script_refuses_a_missing_data_folder(tmp_path):
    script = render(APP / "template" / "script.sh.erb", {
        "lab_data_dir": str(tmp_path / "nope"), "run_output_dir": "", "lab_state_dir": "", "fiberbrowser_image": "",
        "enable_runs": "0", "num_cores": "1", "fiberbrowser_setup": ""})
    (tmp_path / "script.sh").write_text(script)
    result = subprocess.run(["bash", "script.sh"], cwd=tmp_path, capture_output=True, text=True, timeout=60,
                            env={**os.environ, "host": "n", "port": "1", "password": "p", "HOME": str(tmp_path)})
    assert result.returncode == 1 and "does not exist" in result.stderr
