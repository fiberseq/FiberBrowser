"""Serving under a URL prefix (services/root_path.py): Open OnDemand /rnode/<host>/<port>/, lab proxies."""
from __future__ import annotations

import asyncio
import re

import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient

from services import root_path
from services.root_path import RootPathMiddleware, strip_prefix

PREFIX = "/rnode/hpc-r1c2/8123"


@pytest.fixture
def prefixed(monkeypatch):
    monkeypatch.setattr(root_path, "_root_path", PREFIX)
    return PREFIX


def _concrete(template: str) -> str:
    return re.sub(r"\{[^}]+\}", "x", template)


def test_every_route_and_asset_is_reachable_under_the_prefix(standalone_app, prefixed):
    """The middleware maps <prefix><route> to <route> for every route of the app."""
    from services.public_mode_guard import iter_route_entries
    seen: list[str] = []

    async def inner(scope, receive, send):
        seen.append(scope["path"])

    middleware = RootPathMiddleware(inner)
    paths = sorted({_concrete(e.path) for e in iter_route_entries(standalone_app)})
    paths += ["/", "/assets/index-abc.js", "/assets/icons/favicon.svg", "/dafc", "/favicon.ico"]
    assert len(paths) > 150
    for path in paths:
        for kind in ("http", "websocket"):
            seen.clear()
            asyncio.run(middleware({"type": kind, "path": PREFIX + path, "raw_path": (PREFIX + path).encode()},
                                   None, None))
            assert seen == [path], (kind, path, seen)
    # A proxy that already stripped it (OnDemand /rnode/): unchanged.
    seen.clear()
    asyncio.run(middleware({"type": "http", "path": "/api/status"}, None, None))
    assert seen == ["/api/status"]


def test_strip_prefix_edge_cases():
    assert strip_prefix(PREFIX, PREFIX) == "/"
    assert strip_prefix(PREFIX + "/", PREFIX) == "/"
    assert strip_prefix(PREFIX + "x/api", PREFIX) is None  # /rnode/host/81230 is not /rnode/host/8123
    assert strip_prefix("/api/x", "") == "/api/x"


def test_the_real_app_answers_both_prefixed_and_stripped_requests(client, prefixed):
    assert client.get(PREFIX + "/api/status").status_code == 200
    assert client.get("/api/status").status_code == 200
    assert client.get(PREFIX + "/api/datasets").json() == client.get("/api/datasets").json()


def test_token_cookie_is_scoped_to_the_prefix(standalone_app, prefixed):
    from services import local_auth
    anonymous = TestClient(standalone_app)
    opened = anonymous.get(f"{PREFIX}/api/status?token={local_auth.get_token()}")
    assert opened.status_code == 200
    assert f"Path={PREFIX}/" in opened.headers["set-cookie"]


@pytest.fixture
def frontend_app(tmp_path):
    """A fresh app with a built frontend (index.html as Vite writes it with base './')."""
    from services.frontend_mount import mount_frontend
    dist = tmp_path / "frontend" / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "assets" / "index-abc.js").write_text("console.log(1)")
    (dist / "index.html").write_text(
        '<!doctype html><html><head><link rel="icon" href="/assets/icons/favicon.svg">'
        '<script type="module" crossorigin src="./assets/index-abc.js"></script>'
        '<link rel="stylesheet" href="./assets/index-abc.css"></head><body><div id="root"></div></body></html>')
    app = FastAPI()
    app.add_middleware(RootPathMiddleware)
    mount_frontend(app, str(tmp_path), public_mode=False)
    return app


def test_page_points_assets_and_requests_through_the_prefix(frontend_app, prefixed):
    client = TestClient(frontend_app)
    page = client.get(PREFIX + "/")
    assert page.status_code == 200
    html = page.text
    assert f'window.__FIBERBROWSER_ROOT__ = "{PREFIX}";' in html
    assert f'src="{PREFIX}/assets/index-abc.js"' in html and f'href="{PREFIX}/assets/index-abc.css"' in html
    assert f'href="{PREFIX}/assets/icons/favicon.svg"' in html
    assert '"./assets/' not in html and '="/assets/' not in html
    assert client.get(PREFIX + "/assets/index-abc.js").text == "console.log(1)"
    assert client.get(PREFIX + "/dafc").status_code == 200


def test_page_without_a_prefix_uses_root_relative_assets(frontend_app):
    html = TestClient(frontend_app).get("/").text
    assert 'src="/assets/index-abc.js"' in html and "__FIBERBROWSER_ROOT__" not in html


def test_new_workspace_redirect_keeps_the_prefix(frontend_app, prefixed, monkeypatch):
    from state import workspace

    class FakeManager:
        def create(self):
            return "ws-" + "a" * 20

        def get(self, _id):
            return object()

    monkeypatch.setattr(workspace, "_manager", FakeManager())
    response = TestClient(frontend_app).get(PREFIX + "/?workspace=new", follow_redirects=False)
    assert response.status_code == 303
    assert response.headers["location"] == f"{PREFIX}/?workspace=ws-{'a' * 20}"


def test_origin_guard_accepts_the_proxys_forwarded_host():
    """Behind OnDemand the Host header is the compute node; the page's origin is the portal."""
    from services.request_origin_guard import request_allowed
    portal = {"host": "hpc-r1c2:8123", "origin": "https://ondemand.example.edu", "x-forwarded-proto": "https"}
    assert request_allowed(portal, "/api/datasets/add") == "Cross-origin request"  # no Fetch Metadata
    assert request_allowed({**portal, "x-forwarded-host": "ondemand.example.edu"}, "/api/datasets/add") is None
    assert request_allowed({**portal, "x-forwarded-host": "evil.example"}, "/api/datasets/add") == "Cross-origin request"
    assert request_allowed({**portal, "sec-fetch-site": "same-origin"}, "/api/datasets/add") is None
