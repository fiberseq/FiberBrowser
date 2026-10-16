"""Independent workspaces: more isolated sessions from one local launch (state/workspace.py)."""
from __future__ import annotations

import re
from pathlib import Path

import pytest

from state.sandbox import SANDBOX_HEADER

DEMO_BAM = Path(__file__).resolve().parents[1] / "browser" / "data" / "demo" / "napa_ddda.bam"
ID_RE = re.compile(r"^ws-[A-Za-z0-9_-]{16,64}$")


@pytest.fixture
def workspaces(standalone_app):
    """The server's workspace manager on a fresh main state with the demo BAM."""
    import server as srv
    from state.browser_state import BrowserState
    from state.runtime_state import set_browser_state
    from state.workspace import WorkspaceManager, get_workspace_manager, set_workspace_manager
    previous_state, previous_manager = srv.state, get_workspace_manager()
    main = BrowserState(None, None, None, None)
    main.add_dataset("demo", str(DEMO_BAM), "demo")
    main.current_genome = "dm6"
    srv.state = main
    set_browser_state(main)
    manager = WorkspaceManager(template=main)
    set_workspace_manager(manager)
    try:
        yield manager
    finally:
        for workspace_id in list(manager.sessions):
            manager.drop(workspace_id)
        set_workspace_manager(previous_manager)
        srv.state = previous_state
        set_browser_state(previous_state)


def _new(client) -> str:
    body = client.post("/api/workspaces").json()
    assert ID_RE.match(body["id"]) and body["url"] == f"/?workspace={body['id']}"
    return body["id"]


def _in(workspace_id):
    return {SANDBOX_HEADER: workspace_id}


def test_a_workspace_starts_empty_with_the_shared_reference(client, workspaces):
    workspace_id = _new(client)
    assert [d["id"] for d in client.get("/api/datasets").json()["datasets"]] == ["demo"]
    assert client.get("/api/datasets", headers=_in(workspace_id)).json()["datasets"] == []
    state = workspaces.get(workspace_id)
    assert state.current_genome == "dm6"
    # Its reference is its own copy: changing it leaves the main tab alone.
    state.current_genome = "hg38"
    assert workspaces.template.current_genome == "dm6"


def test_workspaces_are_isolated_from_each_other_and_the_main_tab(client, workspaces):
    a, b = _new(client), _new(client)
    workspaces.get(a).dataset_order.append("only-in-a")
    assert workspaces.get(b).dataset_order == []
    assert workspaces.template.dataset_order == ["demo"]
    assert client.get("/api/workspaces").json()["workspaces"] == sorted([a, b])


def test_workspaces_run_with_the_owners_full_rules(client, workspaces, tmp_path):
    workspace_id = _new(client)
    status = client.get("/api/status", headers=_in(workspace_id)).json()
    assert status["public_mode"] is False
    listing = client.get(f"/api/files/list?path={tmp_path}", headers=_in(workspace_id))
    assert listing.status_code == 200  # a tour sandbox gets 403 here
    by_param = client.get(f"/api/datasets?sandbox={workspace_id}")
    assert by_param.json()["datasets"] == []
    by_referer = client.get("/api/datasets", headers={"referer": f"http://localhost/?workspace={workspace_id}"})
    assert by_referer.json()["datasets"] == []


def test_ended_or_unknown_workspaces_are_gone(client, workspaces):
    made_up = "ws-" + "A" * 24
    gone = client.get("/api/datasets", headers=_in(made_up))
    assert gone.status_code == 410 and gone.headers.get("x-fiberbrowser-sandbox-expired") == "1"
    assert client.get("/api/datasets", headers=_in("ws-short")).status_code == 400
    workspace_id = _new(client)
    assert client.delete(f"/api/workspaces/{workspace_id}").json()["ended"] is True
    assert client.get("/api/datasets", headers=_in(workspace_id)).status_code == 410
    assert workspaces.sessions == {}


def test_workspace_requests_need_the_token_too(standalone_app, workspaces, client):
    from starlette.testclient import TestClient
    workspace_id = _new(client)
    assert TestClient(standalone_app).get("/api/datasets", headers=_in(workspace_id)).status_code == 401


def test_public_servers_have_no_workspaces(client, workspaces, monkeypatch):
    from services import runtime
    monkeypatch.setattr(runtime, "_public_mode", True)
    assert client.post("/api/workspaces").status_code == 403
    assert client.get("/api/datasets", headers=_in("ws-" + "C" * 24)).status_code == 403


def test_the_page_opens_new_workspaces_and_tells_the_tab(tmp_path, workspaces):
    from fastapi import FastAPI
    from starlette.testclient import TestClient
    from services.frontend_mount import mount_frontend
    from state.sandbox import install_sandbox_middleware
    dist = tmp_path / "frontend" / "dist"
    dist.mkdir(parents=True)
    (dist / "index.html").write_text("<html><head></head><body></body></html>")
    app = FastAPI()
    mount_frontend(app, str(tmp_path), public_mode=False)
    install_sandbox_middleware(app)
    page = TestClient(app, follow_redirects=False)
    opened = page.get("/?workspace=new&locus=eve&token=secret")
    assert opened.status_code == 303
    location = opened.headers["location"]
    workspace_id = re.search(r"workspace=(ws-[A-Za-z0-9_-]+)", location).group(1)
    assert workspace_id in workspaces.sessions and "locus=eve" in location and "token" not in location
    html = page.get(location).text
    assert f'window.__FIBERBROWSER_SANDBOX__ = "{workspace_id}"' in html
    assert "window.__FIBERBROWSER_WORKSPACE__ = true" in html
    assert "__FIBERHMM_PUBLIC__" not in html
    ended = page.get(f"/?workspace=ws-{'D' * 24}").text
    assert "__FIBERBROWSER_SANDBOX_EXPIRED__ = true" in ended


def test_the_page_removes_the_token_from_the_address_bar(tmp_path):
    from fastapi import FastAPI
    from starlette.testclient import TestClient
    from services.frontend_mount import mount_frontend
    dist = tmp_path / "frontend" / "dist"
    dist.mkdir(parents=True)
    (dist / "index.html").write_text("<html><head></head><body></body></html>")
    app = FastAPI()
    mount_frontend(app, str(tmp_path), public_mode=False)
    page = TestClient(app)
    assert "replaceState" in page.get("/?token=abc&render=1").text
    assert "replaceState" not in page.get("/").text


def test_a_full_server_refuses_new_workspaces_instead_of_evicting_one(client, workspaces):
    workspaces.max_sessions = 2
    a, b = _new(client), _new(client)
    full = client.post("/api/workspaces")
    assert full.status_code == 503 and "FIBERBROWSER_MAX_WORKSPACES" in full.json()["detail"]
    assert set(workspaces.sessions) == {a, b}  # nobody's live workspace was dropped
    workspaces.last_access[a] = 0  # idle past the TTL: that one may go
    c = _new(client)
    assert set(workspaces.sessions) == {b, c}
