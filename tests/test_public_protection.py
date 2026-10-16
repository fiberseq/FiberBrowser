"""--public on the open internet: rate limits, analysis slots, bodies, errors,
proxies, sessions, the shared response cache and no visitor-chosen URLs
(services/public_protection.py, services/public_cache.py)."""
from __future__ import annotations

import asyncio
import json
import threading
import time
from pathlib import Path

import pytest
from fastapi import FastAPI, HTTPException
from starlette.testclient import TestClient

DEMO_BAM = Path(__file__).resolve().parents[1] / "browser" / "data" / "demo" / "napa_ddda.bam"


@pytest.fixture
def limits(monkeypatch):
    """Configure public limits for one test (reset afterwards)."""
    from services import public_limits
    public_limits.reset_public_limits()

    def configure(**overrides):
        return public_limits.configure_public_limits(**overrides)
    yield configure
    public_limits.reset_public_limits()


@pytest.fixture
def proxies():
    from services import public_protection
    yield public_protection.configure_trusted_proxies
    public_protection.configure_trusted_proxies(None)


# --- a small app with the protection middleware ------------------------------------

def _mini_app(public=True):
    """Routes standing in for the real ones: fast, blocking, raising."""
    from services.public_protection import install_public_protection
    app = FastAPI()
    release = threading.Event()
    app.state.release = release
    app.state.ran = []

    @app.get("/api/fast")
    async def fast():
        return {"ok": True}

    @app.post("/api/echo")
    async def echo(body: dict):
        return body

    @app.post("/api/cluster")  # a HEAVY_ROUTES template
    async def slow_cluster():
        # An async handler doing blocking work, like the real analysis routes.
        app.state.ran.append(time.monotonic())
        release.wait(10)
        return {"done": True}

    @app.get("/api/boom")
    async def boom():
        raise RuntimeError("secret /srv/lab/private/data.bam exploded")

    @app.get("/api/http500")
    async def http500():
        raise HTTPException(500, detail="open('/home/lab/creds.json') failed")

    @app.get("/api/missing")
    async def missing():
        raise HTTPException(404, detail="no such file /srv/lab/runs/x.bam")

    install_public_protection(app, lambda: public)
    return app


def _client(app, ip="203.0.113.5", **kw):
    return TestClient(app, client=(ip, 40000), raise_server_exceptions=False, **kw)


# --- rate limits ---------------------------------------------------------------------

def test_per_client_rate_limit_answers_429_with_retry_after_and_spares_others(limits):
    limits(rate_per_minute=6, rate_burst=3)
    app = _mini_app()
    greedy, other = _client(app, "198.51.100.7"), _client(app, "198.51.100.8")
    codes = [greedy.get("/api/fast").status_code for _ in range(5)]
    assert codes[:3] == [200, 200, 200] and codes[3:] == [429, 429]
    refused = greedy.get("/api/fast")
    assert refused.status_code == 429 and int(refused.headers["retry-after"]) >= 1
    assert other.get("/api/fast").status_code == 200  # another visitor is unaffected


def test_local_servers_have_no_rate_limit(limits):
    limits(rate_per_minute=1, rate_burst=1)
    client = _client(_mini_app(public=False))
    assert all(client.get("/api/fast").status_code == 200 for _ in range(10))


def test_analysis_requests_have_their_own_stricter_bucket(limits):
    limits(heavy_per_minute=1, heavy_burst=2, heavy_timeout_seconds=30)
    app = _mini_app()
    app.state.release.set()
    client = _client(app)
    assert [client.post("/api/cluster").status_code for _ in range(3)] == [200, 200, 429]
    assert client.get("/api/fast").status_code == 200  # browsing still works


def test_global_backstop_limits_all_clients_together(limits):
    limits(global_rate_per_second=3)
    app = _mini_app()
    codes = [_client(app, f"192.0.2.{i}").get("/api/fast").status_code for i in range(6)]
    assert codes.count(503) >= 2


def test_a_rate_limited_client_does_not_use_up_the_shared_budget(limits):
    limits(rate_per_minute=1, rate_burst=1, global_rate_per_second=5)
    app = _mini_app()
    greedy = _client(app, "198.51.100.66")
    assert greedy.get("/api/fast").status_code == 200
    assert all(greedy.get("/api/fast").status_code == 429 for _ in range(50))
    assert _client(app, "198.51.100.67").get("/api/fast").status_code == 200


def test_token_buckets_are_bounded():
    from services.public_protection import TokenBuckets
    buckets = TokenBuckets(rate=1, burst=1, max_keys=100)
    for i in range(1000):
        buckets.take(f"k{i}")
    assert len(buckets) == 100


# --- analysis concurrency, timeouts and the event loop ----------------------------------

def test_analysis_slots_per_client_and_blocking_handlers_do_not_freeze_the_server(limits):
    limits(heavy_concurrent_per_ip=1, heavy_concurrent=4, heavy_burst=10, heavy_timeout_seconds=30)
    app = _mini_app()
    client = _client(app)
    results = []
    worker = threading.Thread(target=lambda: results.append(client.post("/api/cluster").status_code))
    worker.start()
    for _ in range(100):
        if app.state.ran:
            break
        time.sleep(0.02)
    assert app.state.ran, "the analysis never started"
    # The same client's second analysis is refused while the first runs...
    second = client.post("/api/cluster")
    assert second.status_code == 429 and "retry-after" in second.headers
    # ...and the blocking handler doesn't stall anybody's browsing.
    started = time.monotonic()
    assert _client(app, "198.51.100.99").get("/api/fast").status_code == 200
    assert time.monotonic() - started < 2.0
    app.state.release.set()
    worker.join(10)
    assert results == [200]


def test_server_wide_analysis_slots_wait_then_503(limits):
    limits(heavy_concurrent_per_ip=5, heavy_concurrent=1, heavy_wait_seconds=1, heavy_burst=10,
           heavy_timeout_seconds=30)
    app = _mini_app()
    first = threading.Thread(target=lambda: _client(app, "198.51.100.1").post("/api/cluster"))
    first.start()
    for _ in range(100):
        if app.state.ran:
            break
        time.sleep(0.02)
    busy = _client(app, "198.51.100.2").post("/api/cluster")
    assert busy.status_code == 503 and "retry-after" in busy.headers
    app.state.release.set()
    first.join(10)
    assert _client(app, "198.51.100.2").post("/api/cluster").status_code == 200


def test_an_analysis_past_its_time_gets_503_but_keeps_its_slot_until_done(limits):
    limits(heavy_concurrent_per_ip=1, heavy_concurrent=4, heavy_timeout_seconds=1, heavy_burst=10)
    app = _mini_app()
    client = _client(app)
    started = time.monotonic()
    resp = client.post("/api/cluster")
    assert resp.status_code == 503 and time.monotonic() - started < 5
    # The work is still running: the client can't stack another one on it.
    assert client.post("/api/cluster").status_code == 429
    app.state.release.set()
    for _ in range(100):
        if client.post("/api/cluster").status_code == 200:
            break
        time.sleep(0.05)
    else:
        pytest.fail("the slot was never released")


# --- bodies and uploads ---------------------------------------------------------------

def test_request_bodies_are_bounded(limits):
    limits(max_body_kb=1)
    client = _client(_mini_app())
    assert client.post("/api/echo", json={"a": "x" * 100}).status_code == 200
    assert client.post("/api/echo", json={"a": "x" * 5000}).status_code == 413

    def chunks():  # no Content-Length: counted while it streams
        for _ in range(10):
            yield b'{"a": "' + b"x" * 400 + b'"}'
    assert client.post("/api/echo", content=chunks(), headers={"content-type": "application/json"}).status_code == 413


def test_uploads_are_refused_on_every_route(limits):
    limits()
    client = _client(_mini_app())
    resp = client.post("/api/echo", files={"file": ("x.bam", b"BAM\1", "application/octet-stream")})
    assert resp.status_code == 415
    resp = client.post("/api/echo", data={"path": "/etc/passwd"})
    assert resp.status_code == 415


def test_real_upload_route_is_closed(client, monkeypatch):
    from services import runtime
    monkeypatch.setattr(runtime, "_public_mode", True)
    resp = client.post("/api/files/upload", files={"file": ("x.bw", b"data", "application/octet-stream")})
    assert resp.status_code in (403, 415)


def test_body_regions_lists_and_counts_are_bounded(limits):
    from services.public_limits import limit_body
    lim = limits(max_span_bp=1000, max_regions=3, max_clusters=10, max_reads=50)
    assert limit_body("/api/reads/compile", {"regions": [{"chrom": "c", "start": 0, "end": 5000}]}, lim)[1]
    assert limit_body("/api/reads/compile", {"regions": [{"chrom": "c", "start": 0, "end": 10}] * 4}, lim)[1]
    assert limit_body("/api/cluster_all", {"viewports": [{"chrom": "c", "start": 0, "end": 9999}]}, lim)[1]
    new, refusal = limit_body("/api/cluster", {"k": 500, "max_reads": 0, "nested": {"n_clusters": 99}}, lim)
    assert refusal is None and new == {"k": 10, "max_reads": 50, "nested": {"n_clusters": 10}}
    assert limit_body("/api/cluster", {"k": 4}, lim) == (None, None)


def test_every_route_checks_its_query_window(limits):
    from services.public_limits import limit_query
    lim = limits(max_span_bp=1000, max_coverage_span_bp=10**6, max_bins=100)
    # region_start/region_end (these slipped past the old start/end-only check)
    assert limit_query("/api/cluster/vplot", [("region_start", "0"), ("region_end", "5000")], lim)[1]
    assert limit_query("/api/footprint/analyze", [("region_start", "0"), ("region_end", "5000")], lim)[1]
    # a route on no list is still checked
    assert limit_query("/api/annotations/profile", [("start", "0"), ("end", "5000")], lim)[1]
    # zoomed-out reference views get the coverage limit, with bins clamped
    query, refusal = limit_query("/api/tracks/{track_idx}", [("start", "0"), ("end", "500000"), ("bins", "9999")], lim)
    assert refusal is None and dict(query)["bins"] == "100"
    assert limit_query("/api/reads/random_window", [("span", "5000")], lim)[1]


def test_body_limits_apply_through_the_middleware(limits):
    limits(max_span_bp=1000)
    client = _client(_mini_app())
    resp = client.post("/api/echo", json={"chrom": "c", "start": 0, "end": 10**6})
    assert resp.status_code == 413 and "Zoom in" in resp.json()["message"]
    assert client.post("/api/echo", json={"k": 10**6}).json() == {"k": 50}


# --- errors ------------------------------------------------------------------------------

def test_server_errors_are_generic_with_a_request_id(limits, caplog):
    limits()
    client = _client(_mini_app())
    for path in ("/api/boom", "/api/http500"):
        resp = client.get(path)
        assert resp.status_code == 500
        body = resp.json()
        assert body["request_id"] == resp.headers["x-request-id"]
        text = resp.text
        assert "/srv" not in text and "/home" not in text and "Traceback" not in text
        assert "secret" not in text and "creds" not in text
    assert any("exploded" in record.getMessage() or "exploded" in str(record.exc_info) for record in caplog.records)


def test_client_errors_keep_their_message_without_host_paths(limits):
    limits()
    resp = _client(_mini_app()).get("/api/missing")
    assert resp.status_code == 404
    assert "/srv/lab" not in resp.text and "x.bam" in resp.json()["detail"]


def test_public_server_has_no_api_docs(standalone_app):
    from services.public_protection import remove_api_docs
    app = FastAPI()

    @app.get("/api/status")
    def status():
        return {}
    remove_api_docs(app)
    client = TestClient(app)
    for path in ("/docs", "/redoc", "/openapi.json"):
        assert client.get(path).status_code == 404
    assert client.get("/api/status").status_code == 200


# --- proxies ----------------------------------------------------------------------------

def _scope(peer, xff=None, proto=None):
    headers = []
    if xff:
        headers.append((b"x-forwarded-for", xff.encode()))
    if proto:
        headers.append((b"x-forwarded-proto", proto.encode()))
    return {"type": "http", "client": (peer, 1234), "headers": headers, "scheme": "http"}


def test_forwarded_headers_count_only_from_trusted_proxies(proxies):
    from services.public_protection import client_address, client_key, request_is_https
    proxies(None)
    # Nobody trusted: a client can't pick its own address.
    assert client_address(_scope("198.51.100.3", "1.2.3.4")) == "198.51.100.3"
    assert not request_is_https(_scope("198.51.100.3", proto="https"))
    proxies(["127.0.0.1", "10.0.0.0/8"])
    # Through the proxy: the rightmost untrusted hop (a spoofed left part is ignored).
    assert client_address(_scope("127.0.0.1", "6.6.6.6, 203.0.113.9")) == "203.0.113.9"
    assert client_address(_scope("127.0.0.1", "203.0.113.9, 10.1.2.3")) == "203.0.113.9"
    assert client_address(_scope("127.0.0.1")) == "127.0.0.1"
    assert client_address(_scope("127.0.0.1", "not-an-ip")) == "127.0.0.1"
    assert request_is_https(_scope("127.0.0.1", proto="https"))
    # An IPv6 client counts per /64.
    assert client_key(_scope("127.0.0.1", "2001:db8:1:2::5")) == client_key(_scope("127.0.0.1", "2001:db8:1:2:ffff::9"))
    assert client_key(_scope("127.0.0.1", "2001:db8:1:2::5")) != client_key(_scope("127.0.0.1", "2001:db8:1:3::5"))
    assert client_key(_scope("::ffff:198.51.100.3")) == "198.51.100.3"


def test_proxy_clients_are_rate_limited_separately(limits, proxies):
    limits(rate_per_minute=1, rate_burst=2)
    proxies(["127.0.0.1"])
    app = _mini_app()
    proxy = _client(app, "127.0.0.1")
    a = {"X-Forwarded-For": "203.0.113.1"}
    b = {"X-Forwarded-For": "203.0.113.2"}
    assert [proxy.get("/api/fast", headers=a).status_code for _ in range(3)] == [200, 200, 429]
    assert proxy.get("/api/fast", headers=b).status_code == 200


def test_hsts_only_over_https(client, monkeypatch, proxies):
    from services import runtime
    monkeypatch.setattr(runtime, "_public_mode", True)
    proxies(None)
    assert "strict-transport-security" not in client.get("/api/status", headers={"X-Forwarded-Proto": "https"}).headers
    secure = TestClient(client.app, base_url="https://testserver")
    assert secure.get("/api/status").headers["strict-transport-security"].startswith("max-age=")


def test_health_is_minimal_and_mints_no_session(client, monkeypatch):
    from services import runtime
    monkeypatch.setattr(runtime, "_public_mode", True)
    resp = client.get("/api/health")
    assert resp.status_code == 200 and resp.json() == {"status": "ok"}
    assert "set-cookie" not in resp.headers


def test_hashed_assets_are_immutable_others_short():
    from services.public_redaction import static_cache_control
    assert "immutable" in static_cache_control("/assets/index-C02NOe2T.js")
    assert "immutable" in static_cache_control("/assets/vendor-CVDnmApk.js")
    for path in ("/assets/manifest.webmanifest", "/assets/icons/apple-touch-icon.png",
                 "/assets/icons/icon-maskable-512.png", "/assets/icons/favicon.svg"):
        assert "immutable" not in static_cache_control(path), path
    assert static_cache_control("/api/status") is None


# --- sessions --------------------------------------------------------------------------

def _fake_manager(monkeypatch, **kw):
    from types import SimpleNamespace
    from state.session_manager import SessionManager
    import state.browser_state as bs

    class FakeState:
        @classmethod
        def fork_for_session(cls, template):
            return SimpleNamespace()
    monkeypatch.setattr(bs, "BrowserState", FakeState)
    return SessionManager(template=SimpleNamespace(), enabled=True, **kw)


def test_one_client_cannot_crowd_out_or_evict_others(monkeypatch):
    from state.session_manager import ClientSessionsFull
    sm = _fake_manager(monkeypatch, max_sessions=10)
    sm.max_per_client = 3
    other = sm.get_or_create(None, owner="198.51.100.1")[1]
    mine = [sm.get_or_create(None, owner="203.0.113.7")[1] for _ in range(3)]
    with pytest.raises(ClientSessionsFull):
        sm.get_or_create(None, owner="203.0.113.7")
    assert other in sm.sessions and all(s in sm.sessions for s in mine)
    # The client's own idle session makes room, nobody else's.
    sm.last_access[mine[0]] = 0
    new = sm.get_or_create(None, owner="203.0.113.7")[1]
    assert mine[0] not in sm.sessions and new in sm.sessions and other in sm.sessions


def test_full_server_answers_with_retry_after(client, monkeypatch):
    from services import runtime
    from state import runtime_state
    monkeypatch.setattr(runtime, "_public_mode", True)
    sm = _fake_manager(monkeypatch, max_sessions=1)
    sm.get_or_create(None, owner="x")
    monkeypatch.setattr(runtime_state, "_session_manager", sm)
    resp = TestClient(client.app, client=("198.51.100.50", 1)).get("/api/datasets")
    assert resp.status_code == 503 and int(resp.headers["retry-after"]) > 0


def test_idle_visitors_lose_their_read_caches(monkeypatch):
    from collections import OrderedDict
    from types import SimpleNamespace
    from state.session_manager import SessionManager
    import state.browser_state as bs

    class FakeState:
        @classmethod
        def fork_for_session(cls, template):
            return SimpleNamespace(_broad_cache=OrderedDict(a=1), _working_set_cache=OrderedDict(b=2))
    monkeypatch.setattr(bs, "BrowserState", FakeState)
    sm = SessionManager(template=SimpleNamespace(), enabled=True)
    idle_state, idle = sm.get_or_create(None)[:2]
    busy_state, _busy = sm.get_or_create(None)[:2]
    sm.last_access[idle] -= 500
    assert sm.clear_idle_caches(120) == 1
    assert not idle_state._broad_cache and not idle_state._working_set_cache
    assert busy_state._broad_cache  # a visitor still browsing keeps its caches
    assert sm.clear_idle_caches(120) == 0  # nothing left to free


def test_memory_pressure_refuses_new_sessions(client, monkeypatch, limits):
    from services import public_protection, runtime
    from state import runtime_state
    limits(memory_mb=100)
    monkeypatch.setattr(runtime, "_public_mode", True)
    monkeypatch.setattr(public_protection, "resident_memory_mb", lambda: 10_000.0)
    sm = _fake_manager(monkeypatch, max_sessions=50)
    monkeypatch.setattr(runtime_state, "_session_manager", sm)
    resp = TestClient(client.app, client=("198.51.100.51", 1)).get("/api/datasets")
    assert resp.status_code == 503 and "memory" in resp.json()["detail"]


def test_per_visitor_track_and_run_caps(limits, monkeypatch):
    from types import SimpleNamespace
    from services import public_protection
    lim = limits(session_max_tracks=2, session_max_consensus_runs=1)
    full = SimpleNamespace(orthogonal_tracks=[{}, {}], consensus_workflow_jobs={"a": {}})
    monkeypatch.setattr(public_protection, "visitor_state", lambda scope: full)
    with pytest.raises(public_protection._Refusal) as err:
        public_protection._check_session_caps({}, "POST", "/api/tracks/add_motif_jaspar", lim)
    assert err.value.status == 409
    with pytest.raises(public_protection._Refusal):
        public_protection._check_session_caps({}, "POST", "/api/footprint/consensus/jobs", lim)
    public_protection._check_session_caps({}, "GET", "/api/tracks", lim)


# --- the shared response cache on the real app ----------------------------------------

@pytest.fixture
def public_catalog(client, monkeypatch, limits):
    """A --public server with the demo BAM as its one catalog dataset and real sessions."""
    import server as srv
    from routers.catalog import set_catalog
    from services import public_cache, runtime
    from state import runtime_state
    from state.session_manager import SessionManager
    if not DEMO_BAM.exists():
        pytest.skip("demo BAM missing")
    limits(cache_mb=64)
    public_cache._cache = None
    monkeypatch.setattr(runtime, "_public_mode", True)
    manager = SessionManager(template=srv.state, enabled=True)
    monkeypatch.setattr(runtime_state, "_session_manager", manager)
    set_catalog({"name": "t", "groups": [{"name": "demo", "datasets": [{"path": str(DEMO_BAM), "label": "demo"}]}]},
                base_dir=str(DEMO_BAM.parent))
    yield manager
    set_catalog(None)
    public_cache._cache = None


def _visitor(app, ip):
    c = TestClient(app, client=(ip, 1), raise_server_exceptions=False)
    assert c.get("/api/datasets").status_code == 200  # mints the session
    assert c.post("/api/catalog/load?group_index=0").json()["success"]
    return c


READS = "/api/reads/compact?chrom=chr19&dataset_id=catalog_0_0&start=47514000&end=47518000"


def test_identical_visitors_share_answers(client, public_catalog):
    a, b = _visitor(client.app, "198.51.100.11"), _visitor(client.app, "198.51.100.12")
    first = a.get(READS)
    assert first.status_code == 200 and first.headers["x-fiberbrowser-cache"] == "miss"
    second = b.get(READS)
    assert second.headers["x-fiberbrowser-cache"] == "hit"
    assert second.content == first.content
    # The hit re-issues b's own cookie, never a's.
    assert b.cookies.get("fiberhmm_sid") in second.headers["set-cookie"]
    assert a.cookies.get("fiberhmm_sid") not in second.headers["set-cookie"]


def test_visitors_with_different_filters_never_share_answers(client, public_catalog):
    a, b = _visitor(client.app, "198.51.100.21"), _visitor(client.app, "198.51.100.22")
    b.post("/api/quality_filters", json={"filters": [{"layer": "*", "quality_name": "nq", "min_value": 250}]})
    reads_a = a.get(READS)
    reads_b = b.get(READS)
    assert reads_a.headers["x-fiberbrowser-cache"] == "miss"
    assert reads_b.headers["x-fiberbrowser-cache"] == "miss"  # a's answer is not b's
    # b's filtered answer is not served back to a either.
    assert a.get(READS).content == reads_a.content
    c = _visitor(client.app, "198.51.100.23")
    c.post("/api/legacy_layer_inference", json={"enabled": False})
    assert c.get(READS).headers["x-fiberbrowser-cache"] == "miss"


def test_signal_track_batches_are_shared_too(client, public_catalog, tmp_path):
    """/api/tracks/batch is a read-only POST: it shares answers like the GETs."""
    import pyBigWig
    from routers.catalog import set_catalog
    bw_path = tmp_path / "signal.bw"
    bw = pyBigWig.open(str(bw_path), "w")
    bw.addHeader([("chr19", 58_617_616)])
    bw.addEntries(["chr19"] * 3, [47_514_000, 47_515_000, 47_516_000], ends=[47_515_000, 47_516_000, 47_517_000],
                  values=[1.0, 2.0, 3.0])
    bw.close()
    set_catalog({"name": "t", "tracks": [{"path": str(bw_path), "label": "signal"}],
                 "groups": [{"name": "demo", "datasets": [{"path": str(DEMO_BAM), "label": "demo"}]}]},
                base_dir=str(DEMO_BAM.parent))
    body = {"track_indices": [0], "chrom": "chr19", "start": 47_514_000, "end": 47_518_000, "bins": 100}
    answers = []
    for ip in ("198.51.100.31", "198.51.100.32"):
        visitor = _visitor(client.app, ip)
        assert visitor.post("/api/catalog/tracks/load?track_index=0").json()["success"]
        answers.append(visitor.post("/api/tracks/batch", json=body))
    assert answers[0].status_code == 200 and answers[0].headers["x-fiberbrowser-cache"] == "miss"
    assert answers[1].headers["x-fiberbrowser-cache"] == "hit"
    assert answers[1].content == answers[0].content


def test_an_abandoned_analysis_keeps_its_session_changing_until_it_ends(limits, monkeypatch):
    """A POST analysis answered 503 past its time still changes the session:
    answers computed meanwhile must not be shared."""
    from types import SimpleNamespace
    from services import public_cache as pc
    from services import public_protection
    limits(heavy_timeout_seconds=1, heavy_burst=10)
    session = SimpleNamespace(datasets={})
    monkeypatch.setattr(public_protection, "visitor_state", lambda scope: session)
    app = _mini_app()
    client = _client(app)
    assert client.post("/api/cluster").status_code == 503
    assert pc.busy(session) == 1  # the work goes on, so does the change
    app.state.release.set()
    for _ in range(100):
        if pc.busy(session) == 0:
            break
        time.sleep(0.05)
    assert pc.busy(session) == 0


def test_fingerprint_changes_with_any_setting(public_catalog):
    from services.public_cache import fingerprint
    import server as srv
    from state.browser_state import BrowserState
    one, two = BrowserState.fork_for_session(srv.state), BrowserState.fork_for_session(srv.state)
    assert fingerprint(one) == fingerprint(two)
    two.quality_filters = [{"layer": "*", "quality_name": "nq", "min_value": 200}]
    assert fingerprint(one) != fingerprint(two)
    two.quality_filters = []
    assert fingerprint(one) == fingerprint(two)
    two.annotation_state.confidence_thresholds["x"] = 0.5
    assert fingerprint(one) != fingerprint(two)
    # The last peak scan is not part of it (only analyses read it).
    one.peak_regions, one.peak_regions_view = [{"start": 1, "end": 2}], ("chr1", 0, 10)
    assert fingerprint(one) == fingerprint(BrowserState.fork_for_session(srv.state))
    # Too large to fingerprint cheaply: not cached at all.
    two.quality_filters = [{"layer": str(i)} for i in range(5000)]
    assert fingerprint(two) is None


def test_state_left_out_of_the_fingerprint_is_not_read_by_cached_routes():
    """peak_regions is left out of the fingerprint because only analyses read it.
    If another module starts reading it, decide whether its route is cacheable."""
    import re
    browser = Path(__file__).resolve().parents[1] / "browser"
    pattern = re.compile(r"state\.peak_regions|\(state, ['\"]peak_regions|stored_peak_regions_for|remember_peak_regions")
    readers = sorted(str(p.relative_to(browser)) for folder in ("services", "routers", "state", "utils")
                     for p in (browser / folder).glob("*.py") if pattern.search(p.read_text()))
    assert readers == ["services/clustering_endpoint.py", "services/filtering_endpoint.py",
                       "services/peak_scanning.py", "services/read_auxiliary_endpoint.py"], readers
    from services.public_cache import CACHEABLE_GET
    assert "/api/fire" not in CACHEABLE_GET  # read_auxiliary's FIRE route records peaks


def test_answers_computed_during_a_change_are_not_stored():
    from services import public_cache as pc
    from types import SimpleNamespace
    state = SimpleNamespace(datasets={})
    before = pc.generation(state)
    pc.begin_change(state, "POST")
    assert pc.busy(state) == 1 and pc.generation(state) != before
    pc.end_change(state, "POST")
    assert pc.busy(state) == 0


def test_response_cache_is_byte_bounded_and_expires():
    from services.public_cache import ResponseCache
    now = [0.0]
    cache = ResponseCache(max_bytes=8_000, ttl_seconds=10, clock=lambda: now[0])
    assert not cache.put("big", 200, [], b"x" * 2_000)  # > an eighth of the budget
    for i in range(20):
        cache.put(f"k{i}", 200, [], b"x" * 500)
    assert cache.stats()["bytes"] <= 8_000 and cache.get("k0") is None and cache.get("k19")
    now[0] = 11
    assert cache.get("k19") is None


# --- no visitor-chosen URL ever reaches a loader ----------------------------------------

CANARY = "canary-ssrf.invalid"


def test_no_public_route_fetches_a_visitor_url(client, monkeypatch, limits):
    """Every route a public visitor can reach, fed URLs (https, s3, metadata IP,
    file://) in every usual parameter: nothing is resolved, opened or fetched."""
    import socket
    import urllib.request

    import pyBigWig
    import pysam
    from services import runtime
    from services.public_mode_guard import PUBLIC_ALLOWED
    limits(rate_burst=100_000, rate_per_minute=100_000, heavy_burst=100_000, heavy_per_minute=100_000,
           global_rate_per_second=100_000, heavy_timeout_seconds=20)
    monkeypatch.setattr(runtime, "_public_mode", True)
    seen = []

    def record(name, real):
        def wrapper(*args, **kwargs):
            text = repr(args) + repr(kwargs)
            if CANARY in text or "169.254.169.254" in text:
                seen.append((name, text[:200]))
                raise OSError("blocked in test")
            return real(*args, **kwargs)
        return wrapper
    monkeypatch.setattr(socket, "getaddrinfo", record("getaddrinfo", socket.getaddrinfo))
    monkeypatch.setattr(socket, "create_connection", record("create_connection", socket.create_connection))
    monkeypatch.setattr(urllib.request, "urlopen", record("urlopen", urllib.request.urlopen))
    monkeypatch.setattr(pyBigWig, "open", record("pyBigWig.open", pyBigWig.open))
    monkeypatch.setattr(pysam, "AlignmentFile", record("pysam.AlignmentFile", pysam.AlignmentFile))
    try:
        import requests
        monkeypatch.setattr(requests.Session, "request", record("requests", requests.Session.request))
    except ImportError:
        pass

    urls = [f"https://{CANARY}/x.bw", f"s3://{CANARY}/x.bam", "http://169.254.169.254/latest/meta-data/",
            f"file:///{CANARY}/etc/passwd", f"ucsc://{CANARY}/track"]
    keys = ("path", "url", "file", "source", "bam", "bigbed", "track", "fasta", "gtf", "genome_id",
            "session_path", "fit_cache_dir", "cache_dir")
    probe = TestClient(client.app, client=("198.51.100.77", 1), raise_server_exceptions=False)
    for method, template in sorted(PUBLIC_ALLOWED):
        if not template.startswith("/api/") or template == "/api/health":
            continue
        path = template.replace("{track_idx}", "0").replace("{job_id}", "job").replace(
            "{dataset_id}", "ds").replace("{overlay_id}", "ov").replace("{file_id}", "f")
        for url in urls:
            params = {key: url for key in keys}
            body = {**params, "tracks": [{"path": url, "url": url}], "session": {"tracks": [{"path": url}]},
                    "datasets": [{"path": url}], "regions": [{"chrom": "chr1", "start": 0, "end": 100}]}
            if method == "GET":
                probe.get(path, params=params)
            elif method == "DELETE":
                probe.delete(path, params=params)
            else:
                probe.post(path, params=params, content=json.dumps(body),
                           headers={"content-type": "application/json"})
    assert not seen, seen


# --- one list of trusted proxies; the config file's public profile -------------------

def test_lab_sign_in_and_public_protection_share_one_trusted_proxy_list(proxies, monkeypatch):
    """--trusted-proxy (configure_trusted_proxies) and a lab config's
    auth.trusted_proxies are the same list, used by both the lab sign-in and
    the public protection's client address."""
    from types import SimpleNamespace
    from services import lab
    from services.lab.auth import client_ip, peer_is_trusted
    from services.public_protection import client_address, is_trusted_proxy
    cfg = SimpleNamespace(auth=SimpleNamespace(trusted_proxies=["10.1.2.3"]))
    monkeypatch.setattr(lab, "_config", cfg)
    proxies(["192.0.2.10"])
    request = lambda peer, xff=None: SimpleNamespace(client=SimpleNamespace(host=peer), scope=_scope(peer, xff))
    for peer in ("10.1.2.3", "192.0.2.10"):  # the lab file's proxy and the flag's proxy
        assert peer_is_trusted(request(peer)) and is_trusted_proxy(peer)
        assert client_ip(request(peer, "203.0.113.4")) == client_address(_scope(peer, "203.0.113.4")) == "203.0.113.4"
    assert not peer_is_trusted(request("10.9.9.9"))
    assert client_ip(request("10.9.9.9", "10.1.2.3")) == "10.9.9.9"


def test_config_file_trusted_proxies_join_the_flag(tmp_path):
    import argparse
    from services.server_config import apply_to_args, load_config
    (tmp_path / "public.toml").write_text(
        'profile = "public"\n[data]\ncatalog = "c.json"\n[auth]\ntrusted_proxies = ["172.30.0.0/24"]\n')
    args = argparse.Namespace(host=None, port=8000, root_path=None, open_browser=None, public=False, catalog=None,
                              gtf=None, fasta=None, max_working_reads=0, copilot="auto", trusted_proxy=["127.0.0.1"])
    apply_to_args(load_config(str(tmp_path / "public.toml")), args, [])
    assert args.trusted_proxy == ["127.0.0.1", "172.30.0.0/24"]
    # A file without the key leaves the flag alone (the lab default is lab-only).
    (tmp_path / "plain.toml").write_text('profile = "public"\n[data]\ncatalog = "c.json"\n')
    args.trusted_proxy = None
    apply_to_args(load_config(str(tmp_path / "plain.toml")), args, [])
    assert args.trusted_proxy is None


def test_config_file_public_profile_sets_every_limit(tmp_path, limits):
    import argparse
    from services.public_limits import apply_public_cli, limit_names
    from services.server_config import ConfigError, apply_to_args, load_config
    (tmp_path / "public.toml").write_text(
        'profile = "public"\n[data]\ncatalog = "c.json"\n'
        '[limits]\nrate_per_minute = 60\nheavy_concurrent = 1\ncache_mb = 0\nmax_span_bp = 5000\n')
    args = argparse.Namespace(host=None, port=8000, root_path=None, open_browser=None, public=False, catalog=None,
                              gtf=None, fasta=None, max_working_reads=0, copilot="auto",
                              **{f"public_{name}": None for name in limit_names()})
    args.public_heavy_concurrent = 3  # a flag on the command line wins
    apply_to_args(load_config(str(tmp_path / "public.toml")), args, [])
    configured = apply_public_cli(args)
    assert (configured.rate_per_minute, configured.heavy_concurrent, configured.cache_mb,
            configured.max_span_bp) == (60, 3, 0, 5000)
    (tmp_path / "bad.toml").write_text('profile = "public"\n[limits]\nrate_per_minut = 60\n')
    with pytest.raises(ConfigError, match="Unknown key"):
        load_config(str(tmp_path / "bad.toml"))
    (tmp_path / "lab.toml").write_text('profile = "lab"\n[[data.roots]]\npath = "d"\n[state]\ndir = "s"\n'
                                       '[limits]\nrate_per_minute = 60\n')
    with pytest.raises(ConfigError, match="only apply to profile"):
        load_config(str(tmp_path / "lab.toml"))


def test_health_answers_on_every_kind_of_server(client):
    """Container and load-balancer health checks, even where sign-in or the
    access token guards everything else."""
    from starlette.testclient import TestClient
    tokenless = TestClient(client.app)  # no access-token header
    resp = tokenless.get("/api/health")
    assert resp.status_code == 200 and resp.json() == {"status": "ok"}
    assert tokenless.get("/api/datasets").status_code in (401, 403)


def test_connect_to_cluster_is_refused_on_a_public_server(client, monkeypatch):
    from services import runtime
    from services.public_mode_guard import PUBLIC_ALLOWED
    monkeypatch.setattr(runtime, "_public_mode", True)
    assert not [route for route in PUBLIC_ALLOWED if route[1].startswith("/api/remote/")]
    for method, path in (("GET", "/api/remote/sources"), ("POST", "/api/remote/connect"),
                         ("GET", "/api/remote/list"), ("POST", "/api/remote/refs_status")):
        assert client.request(method, path).status_code == 403
