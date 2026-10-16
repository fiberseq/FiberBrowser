"""Remote clients of a personal server (services/remote_access.py).

- a personal server never listens on the network with the access token off;
- only a direct loopback request to a loopback name is the owner: proxy
  headers (tailscale serve, Caddy, X-Forwarded-For spoofing) and other Host
  names only ever make a request remote;
- remote clients get the read-only route set (default deny), never shutdown,
  Quit or the tab beacon;
- every route has a class (test_every_route_has_a_remote_class).
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi import WebSocket  # module level: annotations are strings here (__future__)
from starlette.testclient import TestClient

from services import local_auth, remote_access
from services.public_mode_guard import PUBLIC_ALLOWED, iter_route_entries
from services.remote_access import (LIFECYCLE_ROUTES, OWNER, REMOTE, REMOTE_ALLOWED, REMOTE_EXCLUDED,
                                    VIEWER_ALLOWED, address_is_loopback, bind_refusal, owner_request,
                                    personal_token_required, remote_request_allowed, request_scope)

ROOT = Path(__file__).resolve().parents[1]

PHONE = ("192.168.1.23", 51234)


def _scope(peer="127.0.0.1", host="localhost:8757", headers=(), method="GET", path="/api/status"):
    raw = [(b"host", host.encode())] if host is not None else []
    raw += [(k.lower().encode(), v.encode()) for k, v in headers]
    return {"type": "http", "method": method, "path": path, "headers": raw, "query_string": b"",
            "client": (peer, 50000) if peer is not None else None}


# --- classification ------------------------------------------------------------

@pytest.mark.parametrize("value,expected", [
    ("127.0.0.1", True), ("127.9.8.7", True), ("::1", True), ("[::1]", True),
    ("::ffff:127.0.0.1", True),  # IPv4-mapped loopback (Python 3.10 says False without unwrapping)
    ("0.0.0.0", False), ("::", False), ("192.168.1.23", False), ("100.101.102.103", False),
    ("::ffff:192.168.1.23", False), ("fe80::1%en0", False), ("localhost", False),
    ("testclient", False), ("", False), (None, False), ("127.0.0.1.evil.example", False),
])
def test_loopback_addresses(value, expected):
    assert address_is_loopback(value) is expected


@pytest.mark.parametrize("host", ["localhost", "localhost:8757", "127.0.0.1:8757", "[::1]:8757", "127.0.0.1"])
def test_a_direct_loopback_request_to_a_loopback_name_is_the_owner(host):
    assert owner_request(_scope(host=host))
    assert request_scope(_scope(host=host)) == OWNER


@pytest.mark.parametrize("header", sorted(h.decode() for h in remote_access.PROXY_MARKER_HEADERS))
def test_any_proxy_marker_makes_a_loopback_request_remote(header):
    # tailscale serve, Caddy and nginx all connect from 127.0.0.1: the peer
    # alone never decides. Spoofed markers can only downgrade a request.
    value = "127.0.0.1" if "for" in header or "ip" in header else "x"
    assert not owner_request(_scope(headers=[(header, value)]))
    assert request_scope(_scope(headers=[(header, value)])) == REMOTE


@pytest.mark.parametrize("host", ["mac.tailnet-1234.ts.net", "192.168.1.10:8757", "fiberbrowser.lab.example",
                                  "localhost.evil.example", "", None])
def test_a_loopback_peer_with_another_host_name_is_remote(host):
    assert not owner_request(_scope(host=host))


@pytest.mark.parametrize("peer", ["192.168.1.23", "::ffff:192.168.1.23", "100.64.0.7", "testclient", "", None])
def test_other_peers_are_remote_whatever_they_send(peer):
    spoofed = _scope(peer=peer, headers=[("X-Forwarded-For", "127.0.0.1")])
    assert not owner_request(_scope(peer=peer))
    assert not owner_request(spoofed)


@pytest.mark.parametrize("xff", ["127.0.0.1", "::1", "127.0.0.1, 127.0.0.1", "evil, 127.0.0.1"])
def test_uvicorn_proxy_headers_never_turn_a_remote_peer_into_the_owner(xff):
    """A personal server runs Uvicorn with proxy_headers on: it rewrites the peer
    from X-Forwarded-For only when the connecting peer is 127.0.0.1, and the
    header itself marks the request as proxied."""
    import asyncio

    from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

    seen = {}

    async def app(scope, receive, send):
        seen["scope"] = dict(scope)

    for peer in ("192.168.1.23", "127.0.0.1"):  # straight from the network / through a local proxy
        scope = _scope(peer=peer, headers=[("X-Forwarded-For", xff)])
        asyncio.run(ProxyHeadersMiddleware(app, trusted_hosts="127.0.0.1")(scope, None, None))
        assert request_scope(seen["scope"]) == REMOTE, (peer, xff, seen["scope"]["client"])


# --- startup -----------------------------------------------------------------------

@pytest.mark.parametrize("host", ["0.0.0.0", "::", "192.168.1.10", "fiberbrowser.local", ""])
def test_a_personal_server_refuses_a_network_bind_without_the_token(host):
    message = bind_refusal(host, token_required=False, public_mode=False, lab_mode=False)
    assert message and "refusing to listen" in message and "--no-token" in message
    # With the token on, or as a public/lab server, it may.
    assert bind_refusal(host, token_required=True, public_mode=False, lab_mode=False) is None
    assert bind_refusal(host, token_required=False, public_mode=True, lab_mode=False) is None
    assert bind_refusal(host, token_required=False, public_mode=False, lab_mode=True) is None


@pytest.mark.parametrize("host", ["127.0.0.1", "localhost", "::1", "127.0.0.2"])
def test_loopback_binds_may_run_without_the_token(host):
    assert bind_refusal(host, token_required=False, public_mode=False, lab_mode=False) is None


def test_the_settings_files_require_token_false_applies_to_loopback_only(tmp_path, monkeypatch):
    from services import user_settings
    settings = tmp_path / "browser_settings.json"
    settings.write_text('{"require_token": false}')
    monkeypatch.setenv("FIBERBROWSER_SETTINGS", str(settings))
    monkeypatch.delenv("FIBERBROWSER_NO_TOKEN", raising=False)
    monkeypatch.setattr(user_settings, "_cache", None)
    assert personal_token_required("127.0.0.1", no_token_flag=False) == (False, None)
    required, note = personal_token_required("0.0.0.0", no_token_flag=False)
    assert required is True and "applies to 127.0.0.1 only" in note
    # Explicit choices stay off (and a network bind then refuses to start).
    assert personal_token_required("0.0.0.0", no_token_flag=True) == (False, None)
    monkeypatch.setenv("FIBERBROWSER_NO_TOKEN", "1")
    assert personal_token_required("0.0.0.0", no_token_flag=False) == (False, None)
    monkeypatch.setattr(user_settings, "_cache", None)


@pytest.mark.slow
def test_the_server_exits_before_listening_on_the_network_without_the_token(tmp_path):
    env = dict(os.environ, FIBERBROWSER_NO_OPEN="1", FIBERBROWSER_COPILOT="off",
               FIBERBROWSER_RUNTIME_FILE=str(tmp_path / "runtime.json"))
    env.pop("FIBERBROWSER_NO_TOKEN", None)
    proc = subprocess.run([sys.executable, str(ROOT / "browser.py"), "--standalone", "--host", "0.0.0.0",
                           "--port", "8899", "--no-token", "--no-open-browser", "--copilot", "off"],
                          cwd=str(ROOT), env=env, capture_output=True, text=True, timeout=120)
    assert proc.returncode == 2, proc.stdout + proc.stderr
    assert "refusing to listen on 0.0.0.0 with the access token off" in proc.stderr
    assert "Press Ctrl+C" not in proc.stdout


# --- the guard ------------------------------------------------------------------------

@pytest.fixture
def phone(standalone_app):
    """A device on the Wi-Fi that has the owner's link (the token)."""
    return TestClient(standalone_app, client=PHONE, base_url="http://192.168.1.10:8757",
                      headers=local_auth.auth_headers())


@pytest.fixture
def proxied(standalone_app):
    """A phone through `tailscale serve` on this computer: a loopback peer with proxy headers."""
    return TestClient(standalone_app, base_url="http://localhost:8757",
                      headers={**local_auth.auth_headers(), "X-Forwarded-For": "100.101.102.103",
                               "X-Forwarded-Proto": "https", "Tailscale-User-Login": "owner@example.com"})


@pytest.fixture
def tabs():
    import routers.utility as utility

    def reset():
        task = utility._pending_shutdown_task
        if task is not None:
            task.cancel()
        utility._pending_shutdown_task = None
        utility._tab_last_seen.clear()
        utility._closed_tabs.clear()

    reset()
    yield utility
    reset()


@pytest.mark.parametrize("which", ["phone", "proxied"])
def test_remote_clients_get_the_read_only_view(request, which):
    remote = request.getfixturevalue(which)
    assert remote.get("/api/status").status_code == 200
    assert remote.get("/api/datasets").status_code == 200
    for method, path in (
            ("GET", "/api/files/list?path=/"), ("POST", "/api/files/upload"), ("POST", "/api/load_folder?path=/"),
            ("POST", "/api/session/read"), ("POST", "/api/datasets/add"), ("POST", "/api/load_genome"),
            ("POST", "/api/pipeline/jobs"), ("POST", "/api/footprint/consensus/jobs"),
            ("POST", "/api/render/figure"), ("POST", "/api/primer_blast_db/build"), ("GET", "/api/remote/sources"),
            ("POST", "/api/s3/configure"), ("POST", "/api/nl/setup"), ("GET", "/api/jupyter/state"),
            ("POST", "/api/plugins/anything/run"), ("POST", "/api/new-window"), ("GET", "/docs"),
            ("GET", "/openapi.json"), ("GET", "/api/no_such_route"), ("POST", "/api/quit"),
            ("POST", "/api/shutdown"), ("GET", "/api/shutdown"), ("POST", "/api/tabs/heartbeat?tab=x")):
        resp = remote.request(method, path)
        assert resp.status_code == 403, (method, path, resp.status_code)
        assert "computer it runs on" in resp.json()["message"]


def test_remote_clients_still_need_the_token(standalone_app):
    stranger = TestClient(standalone_app, client=PHONE, base_url="http://192.168.1.10:8757")
    assert stranger.get("/api/status").status_code == 401


def test_with_the_token_off_a_personal_server_answers_no_remote_client(standalone_app, monkeypatch, client):
    monkeypatch.setattr(local_auth, "_enabled", False)
    for remote in (TestClient(standalone_app, client=PHONE, base_url="http://192.168.1.10:8757"),
                   TestClient(standalone_app, headers={"X-Forwarded-For": "100.101.102.103"})):
        resp = remote.get("/api/status")
        assert resp.status_code == 403 and "access token turned off" in resp.json()["message"]
    assert TestClient(standalone_app).get("/api/status").status_code == 200  # the owner


def test_a_remote_tab_never_counts_and_never_shuts_down(phone, proxied, client, tabs):
    for remote in (phone, proxied):
        assert remote.post("/api/tabs/heartbeat", params={"tab": "phone"}).status_code == 403
        assert remote.post("/api/shutdown", params={"tab": "owner"}).status_code == 403
        assert remote.post("/api/quit").status_code == 403
    assert tabs._tab_last_seen == {} and tabs._closed_tabs == set()
    assert tabs._pending_shutdown_task is None
    # The owner's own tabs work as before.
    assert client.post("/api/tabs/heartbeat", params={"tab": "owner"}).json()["ok"] is True
    assert "owner" in tabs._tab_last_seen


def test_lifecycle_routes_check_the_owner_themselves(tabs):
    """Even past the guard (a future allowlist mistake), the routes refuse."""
    import asyncio

    from starlette.requests import Request

    remote = Request(_scope(peer=PHONE[0], method="POST", path="/api/quit"))
    resp = asyncio.run(tabs.quit_server(remote))
    assert resp.status_code == 403
    resp = asyncio.run(tabs.shutdown(Request(_scope(headers=[("Tailscale-User-Login", "a@b")])), tab="owner"))
    assert resp.status_code == 403 and tabs._closed_tabs == set() and tabs._pending_shutdown_task is None
    resp = asyncio.run(tabs.tab_heartbeat(Request(_scope(peer=PHONE[0])), tab="phone"))
    assert resp.status_code == 403 and tabs._tab_last_seen == {}


def test_public_and_lab_servers_keep_their_own_rules(phone, monkeypatch):
    from services import runtime
    monkeypatch.setattr(runtime, "_public_mode", True)
    # A public server's visitors are all remote: the public allowlist decides.
    assert phone.get("/api/status").status_code == 200
    assert phone.get("/api/files/list").json()["message"] == "This action is disabled on a public FiberBrowser server."
    monkeypatch.setattr(runtime, "_public_mode", False)
    monkeypatch.setattr(runtime, "_lab_mode", True)
    assert remote_access._guard_applies() is False
    from starlette.requests import Request
    assert remote_access.lifecycle_refusal(Request(_scope(peer=PHONE[0]))) is None  # LAB_DENIED covers these


def test_new_routes_are_owner_only_for_remote_clients(standalone_app):
    from fastapi import APIRouter
    router = APIRouter()

    @router.get("/api/brand_new_feature")
    def brand_new_feature():
        return {"ok": True}

    standalone_app.include_router(router)
    try:
        phone = TestClient(standalone_app, client=PHONE, base_url="http://192.168.1.10:8757",
                           headers=local_auth.auth_headers())
        assert phone.get("/api/brand_new_feature").status_code == 403
        assert TestClient(standalone_app, headers=local_auth.auth_headers()).get(
            "/api/brand_new_feature").status_code == 200
    finally:
        standalone_app.router.routes[:] = [r for r in standalone_app.router.routes
                                           if getattr(r, "path", None) != "/api/brand_new_feature"]


def _with_routes(app, router):
    """Include ``router`` for one test (late, like a plugin), then take it out."""
    import contextlib

    @contextlib.contextmanager
    def ctx():
        before = list(app.router.routes)
        app.include_router(router)
        try:
            yield
        finally:
            app.router.routes[:] = before
    return ctx()


def test_unusual_methods_and_protocols_are_denied_too(standalone_app):
    """Codex review: OPTIONS handlers, a separate HEAD handler, a handler under
    /assets/ and WebSockets must not slip past the default deny."""
    from fastapi import APIRouter
    from starlette.websockets import WebSocketDisconnect

    router = APIRouter()

    @router.options("/api/plugins/demo/thing")
    def options_thing():
        return {"ran": True}

    @router.head("/api/status_probe")
    def head_probe():
        return None

    @router.get("/api/status_probe")
    def get_probe():
        return {"ok": True}

    @router.get("/assets/custom")
    def assets_custom():
        return {"ran": True}

    @router.websocket("/api/ws_probe")
    async def ws_probe(ws: WebSocket):
        await ws.accept()
        await ws.send_text("hello")
        await ws.close()

    with _with_routes(standalone_app, router):
        phone = TestClient(standalone_app, client=PHONE, base_url="http://192.168.1.10:8757",
                           headers=local_auth.auth_headers())
        assert phone.options("/api/plugins/demo/thing").status_code == 403
        assert phone.head("/api/status_probe").status_code == 403
        assert phone.get("/assets/custom").status_code == 403
        with pytest.raises(WebSocketDisconnect):
            with phone.websocket_connect("/api/ws_probe") as ws:
                ws.receive_text()
        owner = TestClient(standalone_app, headers=local_auth.auth_headers())
        # (websocket_connect always says ws://testserver; the owner's Host is localhost)
        with owner.websocket_connect("/api/ws_probe", headers={"host": "localhost"}) as ws:
            assert ws.receive_text() == "hello"
        assert owner.get("/assets/custom").json() == {"ran": True}


def test_cors_preflights_pass_only_for_configured_origins(phone, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_CORS_ORIGINS", "https://notebook.example")
    preflight = {"Origin": "https://notebook.example", "Access-Control-Request-Method": "GET"}
    assert phone.options("/api/status", headers=preflight).status_code != 403
    assert phone.options("/api/status", headers={**preflight, "Origin": "https://evil.example"}).status_code == 403
    assert phone.options("/api/status").status_code == 403


def test_remote_scope_is_visible_to_routes_and_blocks_diagnostic_plots(standalone_app, monkeypatch):
    from fastapi import APIRouter

    from services import peak_scanning
    import services.clustering_endpoint as clustering_endpoint

    seen = []
    probe = APIRouter()

    @probe.get("/api/scope_probe")
    def scope_probe():
        seen.append(remote_access.current_request_is_remote())
        return {}

    monkeypatch.setitem(remote_access.ALLOWED_BY_SCOPE, REMOTE, REMOTE_ALLOWED | {("GET", "/api/scope_probe")})
    with _with_routes(standalone_app, probe):
        TestClient(standalone_app, client=PHONE, base_url="http://192.168.1.10:8757",
                   headers=local_auth.auth_headers()).get("/api/scope_probe")
        TestClient(standalone_app, headers=local_auth.auth_headers()).get("/api/scope_probe")
    assert seen == [True, False]
    # save_plot (a PNG in /tmp) is the owner's debugging aid only.
    assert "current_request_is_remote()" in Path(clustering_endpoint.__file__).read_text()
    assert peak_scanning.save_peak_scan_diagnostic_plot is not None


# --- route classes ------------------------------------------------------------------

# Never reachable by a remote or viewer client (task WP0 / mobile plan 4.3).
NEVER_REMOTE_PREFIXES = (
    "/api/files/", "/api/pick_", "/api/load_", "/api/library", "/api/pipeline", "/api/qc",
    "/api/primer", "/api/design_", "/api/render/figure", "/api/remote/", "/api/s3/", "/api/nl/", "/api/jupyter",
    "/api/linked/", "/api/new-window", "/api/shutdown", "/api/quit", "/api/tabs/", "/api/cancel_shutdown",
    "/api/session/read", "/api/session/import", "/api/session/check_files", "/api/datasets/add",
    "/api/footprint/rules", "/api/footprint/derived_layers", "/api/regions/catalog", "/api/reads/export_bam",
    "/api/panel_genomes/attach", "/api/annotations/add", "/api/annotations/browse", "/api/add_track",
    "/api/tracks/add_motif_file", "/api/upload", "/api/settings", "/api/diagnose_bam",
)


def _routes(app):
    out = set()
    for entry in iter_route_entries(app):
        for method in entry.methods - {"HEAD"}:
            out.add((method, entry.path))
    return out


def _concrete(template: str) -> str:
    import re
    return re.sub(r"\{[^}:]+(:path)?\}", "x1", template)


def route_classes(app) -> dict[tuple[str, str], str]:
    """Every route's class: remote (read-only set), lifecycle, or owner."""
    classes = {}
    for route in _routes(app):
        classes[route] = ("lifecycle" if route in LIFECYCLE_ROUTES else
                          "remote" if route in REMOTE_ALLOWED else "owner")
    return classes


def test_every_route_has_a_remote_class(standalone_app):
    classes = route_classes(standalone_app)
    counts = {c: sum(1 for v in classes.values() if v == c) for c in ("remote", "owner", "lifecycle")}
    print(f"\nroute classes: {counts} of {len(classes)} routes")
    assert counts["remote"] > 50 and counts["owner"] > 200 and counts["lifecycle"] == len(LIFECYCLE_ROUTES)
    # The remote set is part of the public allowlist; each public-allowlisted
    # route was decided for remote clients explicitly: allowed or excluded.
    assert REMOTE_ALLOWED <= PUBLIC_ALLOWED
    assert not (REMOTE_ALLOWED & set(REMOTE_EXCLUDED))
    # REMOTE_ALLOWED is listed by hand: a new public route fails here until decided.
    undecided = sorted(PUBLIC_ALLOWED - REMOTE_ALLOWED - set(REMOTE_EXCLUDED))
    assert not undecided, f"Decide for remote clients: add to REMOTE_ALLOWED or REMOTE_EXCLUDED: {undecided}"
    assert REMOTE_ALLOWED | set(REMOTE_EXCLUDED) == PUBLIC_ALLOWED
    assert VIEWER_ALLOWED <= REMOTE_ALLOWED
    assert not (LIFECYCLE_ROUTES & REMOTE_ALLOWED)
    stale = sorted(r for r in REMOTE_EXCLUDED if r not in classes)
    assert not stale
    # The guard's decision for a remote client matches each route's class.
    for (method, template), cls in sorted(classes.items()):
        scope = {"type": "http", "method": method, "path": _concrete(template), "headers": [],
                 "query_string": b""}
        allowed = remote_request_allowed(standalone_app, scope)
        if cls == "remote":
            # A concrete path can match an earlier, more specific route
            # (/api/tracks/x1 vs /api/tracks/recent); only owner routes must never pass.
            continue
        if allowed:
            from services.public_mode_guard import route_template
            matched = route_template(standalone_app, scope)
            assert (method, matched) in REMOTE_ALLOWED, (method, template, matched)


def test_never_remote_routes_are_owner_only(standalone_app):
    leaked = sorted(r for r in REMOTE_ALLOWED if r[1].startswith(NEVER_REMOTE_PREFIXES))
    assert not leaked
    # Plugin routes other than the registry listing, and Jupyter, too.
    assert not [r for r in REMOTE_ALLOWED if r[1].startswith("/api/plugins/") and r[1] != "/api/plugins/registry"]
    for route in _routes(standalone_app):
        if route[1].startswith(NEVER_REMOTE_PREFIXES):
            assert route not in REMOTE_ALLOWED, route
