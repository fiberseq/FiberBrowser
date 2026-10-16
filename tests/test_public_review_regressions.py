"""Regressions from the round-7 review of the public server (Codex, 30 Sep):
its probes (round7/scratch/test_review_public.py), adapted to this suite's
fixtures (tests/test_public_protection.py) instead of a module-level
server.main(), which would leave the whole test session in public mode."""
from __future__ import annotations

import asyncio
import json
import re
import shutil
import threading
from pathlib import Path

import httpx
import pytest
from starlette.testclient import TestClient

from test_public_protection import DEMO_BAM, limits, public_catalog, _visitor  # noqa: F401 (fixtures)

REPO = Path(__file__).resolve().parents[1]
READS = "/api/reads/compact?chrom=chr19&dataset_id=catalog_0_0&start=47514000&end=47518000"


# --- span limits: every representation of a region ------------------------------------

def test_every_span_pair_and_region_string_is_checked(limits):
    from services.public_limits import limit_body, limit_query
    lim = limits()
    both = {"start": 0, "end": 1, "region_start": 0, "region_end": 2_000_000}
    assert limit_query("/api/cluster/vplot", [(k, str(v)) for k, v in both.items()], lim)[1]
    assert limit_body("/api/cluster/vplot", both, lim)[1]
    for region in ("chr19:1-2000001", "chr19:1,000-2,001,000", ["chr19", 1, 2_000_001]):
        assert limit_body("/api/render", {"engine": "headless", "region": region}, lim)[1], region
    assert limit_query("/api/reads/compact", [("region", "chr19:1-2000001")], lim)[1]
    assert limit_body("/api/render", {"region": "chr19:47514000-47518000"}, lim) == (None, None)


def test_footprint_request_with_an_extra_wide_window_is_refused(client, public_catalog, monkeypatch):
    import routers.footprint
    called = []
    monkeypatch.setattr(routers.footprint, "analyze_footprints_payload",
                        lambda state, **kw: called.append(kw) or {"spy": True})
    visitor = _visitor(client.app, "198.51.100.115")
    resp = visitor.post("/api/footprint/analyze?chrom=chr19&start=0&end=1&region_start=0&region_end=2000000",
                        json={"footprints": [{"start": 0, "end": 1}], "dataset_ids": ["catalog_0_0"]})
    assert resp.status_code == 413 and not called


def test_render_region_string_is_bounded(client, public_catalog, monkeypatch):
    from fastapi.responses import JSONResponse
    import services.figure.api as api
    seen = []
    monkeypatch.setattr(api, "render_response", lambda spec, *a, **k: seen.append((spec.start, spec.end))
                        or JSONResponse({"region": seen[-1]}))
    visitor = _visitor(client.app, "198.51.100.125")
    resp = visitor.post("/api/render", json={"engine": "headless", "region": "chr19:1-2000001", "tracks": ["axis"]})
    assert resp.status_code == 413 and not seen


# --- footprint profiles and V-plots ---------------------------------------------------

def test_profile_window_and_vplot_size_are_bounded(client, public_catalog, monkeypatch, limits):
    import routers.footprint
    got = []
    monkeypatch.setattr(routers.footprint, "analyze_footprints_payload",
                        lambda state, *, request, **kw: got.append(request) or {"ok": True})
    visitor = _visitor(client.app, "198.51.100.117")
    query = "/api/footprint/analyze?chrom=chr19&region_start=47514000&region_end=47518000"
    body = {"footprints": [{"chrom": "chr19", "start": 47515000, "end": 47515050}], "dataset_ids": ["catalog_0_0"]}
    resp = visitor.post(query, json={**body, "profile_window": 1_000_000_000, "flank_bp": 10**9})
    assert resp.status_code == 200
    assert got[-1].profile_window <= 5_000 and got[-1].flank_bp <= 5_000
    too_fine = visitor.post(query, json={**body, "vplot_size_bin": 1, "vplot_pos_bin": 1, "vplot_size_min": 0,
                                         "vplot_size_max": 100_000})
    assert too_fine.status_code == 413 and "V-plot" in too_fine.json()["message"]
    # A cluster V-plot's positions are its (query-string) region.
    from services.public_limits import get_public_limits, limit_body
    assert limit_body("/api/cluster/vplot", {"size_bin": 1, "pos_bin": 1, "size_min": 0, "size_max": 1000},
                      get_public_limits(), positions=1_000_000)[1]
    assert limit_body("/api/cluster/vplot", {"size_bin": 10, "pos_bin": 10}, get_public_limits(),
                      positions=4_000) == (None, None)


# --- errors -------------------------------------------------------------------------

def test_non_finite_numbers_get_a_clean_400(client, public_catalog):
    visitor = _visitor(client.app, "198.51.100.118")
    resp = visitor.post("/api/footprint/analyze?chrom=chr19&region_start=47514000&region_end=47518000",
                        content='{"max_reads":1e400}', headers={"content-type": "application/json"})
    assert resp.status_code == 400 and resp.headers.get("x-request-id")
    assert resp.headers.get("content-security-policy")
    assert visitor.get(READS + "&max_reads=1e400").status_code == 400


def test_a_missing_catalog_file_does_not_reveal_its_folder(client, public_catalog, tmp_path):
    from routers.catalog import set_catalog
    bam = tmp_path / "private_catalog_missing.bam"
    shutil.copyfile(DEMO_BAM, bam)
    shutil.copyfile(str(DEMO_BAM) + ".bai", str(bam) + ".bai")
    set_catalog({"groups": [{"name": "missing file check", "datasets": [{"path": str(bam)}]}]},
                base_dir=str(tmp_path))
    visitor = _visitor(client.app, "198.51.100.128")
    bam.unlink()
    resp = visitor.get(READS + "&max_reads=1")
    assert str(tmp_path) not in resp.text
    assert "private_catalog_missing.bam" in resp.text  # the file name is still said


# --- the shared cache --------------------------------------------------------------------

def test_repeated_parameters_keep_their_order_in_the_cache_key():
    from services.public_cache import request_key
    assert (request_key("GET", "/api/meta", b"bins=1&bins=2", b"", False, "fp")
            != request_key("GET", "/api/meta", b"bins=2&bins=1", b"", False, "fp"))
    assert (request_key("GET", "/api/meta", b"a=1&b=2", b"", False, "fp")
            == request_key("GET", "/api/meta", b"b=2&a=1", b"", False, "fp"))


def test_duplicate_query_values_never_share_an_answer(client, public_catalog):
    from services.public_cache import get_response_cache
    a, b = _visitor(client.app, "198.51.100.113"), _visitor(client.app, "198.51.100.114")
    a.get(READS + "&max_reads=1&max_reads=2")
    second = b.get(READS + "&max_reads=2&max_reads=1")
    get_response_cache().clear()
    fresh = b.get(READS + "&max_reads=2&max_reads=1")
    assert second.headers["x-fiberbrowser-cache"] == "miss"
    assert len(second.json()["reads"]) == len(fresh.json()["reads"]) == 1


def test_a_cache_hit_sets_the_cookie_under_the_url_prefix(client, public_catalog, monkeypatch):
    from services import root_path
    monkeypatch.setattr(root_path, "_root_path", "/fb")
    a = TestClient(client.app, client=("198.51.100.121", 1), raise_server_exceptions=False)
    b = TestClient(client.app, client=("198.51.100.122", 1), raise_server_exceptions=False)
    for visitor in (a, b):
        assert visitor.get("/fb/api/datasets").status_code == 200
        assert visitor.post("/fb/api/catalog/load?group_index=0").json()["success"]
    a.get("/fb" + READS)
    hit = b.get("/fb" + READS)
    assert hit.headers["x-fiberbrowser-cache"] == "hit"
    assert "Path=/fb/" in hit.headers["set-cookie"]
    assert {c.path for c in b.cookies.jar if c.name == "fiberhmm_sid"} == {"/fb/"}


def test_a_cache_hit_records_the_viewport(client, public_catalog):
    a, b = _visitor(client.app, "198.51.100.126"), _visitor(client.app, "198.51.100.127")
    a.get(READS)
    assert b.get(READS).headers["x-fiberbrowser-cache"] == "hit"
    state = public_catalog.get(b.cookies.get("fiberhmm_sid"))
    assert (state._current_chrom, state._current_start, state._current_end) == ("chr19", 47514000, 47518000)


def test_a_read_leaves_the_session_fingerprint_alone(client, public_catalog):
    """The loaders' own bookkeeping (e.g. a read-cache schema bump on first use)
    is not a setting: before, it made every visitor's first read unshareable."""
    from services.public_cache import fingerprint
    visitor = _visitor(client.app, "198.51.100.129")
    state = public_catalog.get(visitor.cookies.get("fiberhmm_sid"))
    before = fingerprint(state)
    visitor.get(READS)
    assert getattr(state, "_signal_counts_cache", None) is not None
    assert fingerprint(state) == before


def test_a_coalesced_follower_rechecks_its_session(client, public_catalog, monkeypatch):
    import routers.reads
    from services.public_cache import fingerprint
    a, b = _visitor(client.app, "198.51.100.123"), _visitor(client.app, "198.51.100.124")
    sid_a, sid_b = a.cookies.get("fiberhmm_sid"), b.cookies.get("fiberhmm_sid")
    state_b = public_catalog.get(sid_b)
    before = fingerprint(state_b)
    started, release = threading.Event(), threading.Event()
    real = routers.reads.compact_reads_payload_for_request
    calls = []

    def delayed(**kwargs):
        calls.append(kwargs["state"])
        started.set()
        assert release.wait(10)
        return real(**kwargs)
    monkeypatch.setattr(routers.reads, "compact_reads_payload_for_request", delayed)
    app = client.app

    async def check():
        transport_a = httpx.ASGITransport(app, client=("198.51.100.123", 1))
        transport_b = httpx.ASGITransport(app, client=("198.51.100.124", 1))
        async with httpx.AsyncClient(transport=transport_a, base_url="http://testserver",
                                     headers={"cookie": "fiberhmm_sid=" + sid_a}) as aa, \
                httpx.AsyncClient(transport=transport_b, base_url="http://testserver",
                                  headers={"cookie": "fiberhmm_sid=" + sid_b}) as bb:
            leader = asyncio.create_task(aa.get(READS + "&max_reads=2"))
            for _ in range(200):
                if started.is_set():
                    break
                await asyncio.sleep(0.01)
            follower = asyncio.create_task(bb.get(READS + "&max_reads=2"))
            await asyncio.sleep(0.1)
            assert not follower.done() and len(calls) == 1
            changed = await bb.delete("/api/datasets/catalog_0_0")
            assert changed.status_code == 200 and fingerprint(state_b) != before
            release.set()
            _one, two = await asyncio.gather(leader, follower)
            assert two.headers.get("x-fiberbrowser-cache") != "hit"
    try:
        asyncio.run(check())
    finally:
        release.set()


# --- slots and cancellation -------------------------------------------------------------

def test_a_cancelled_waiter_does_not_lose_a_slot():
    from services.public_protection import Slots

    async def check():
        slots = Slots(1)
        await slots.acquire("leader", 2, 1, "busy", "mine")
        waiting = asyncio.create_task(slots.acquire("cancelled", 2, 10, "busy", "mine"))
        await asyncio.sleep(0)
        waiting.cancel()
        with pytest.raises(asyncio.CancelledError):
            await waiting
        slots.release("leader")
        await slots.acquire("next", 2, 0.01, "busy", "mine")
        slots.release("next")
        assert slots.running == 0 and not slots.waiters and not slots.per_client

        # Cancelled just after being handed the slot: either it passes the slot
        # on, or (Python's wait_for may keep a result that already arrived) it
        # holds it and its caller releases it as usual. Never lost.
        await slots.acquire("holder", 2, 1, "busy", "mine")
        handed = asyncio.create_task(slots.acquire("late", 2, 10, "busy", "mine"))
        await asyncio.sleep(0)
        slots.release("holder")  # hands the slot to "late"...
        handed.cancel()          # ...which is cancelled before it resumes
        try:
            await handed
            slots.release("late")
        except asyncio.CancelledError:
            pass
        assert slots.running == 0 and not slots.per_client and not slots.waiters
    asyncio.run(check())


def test_a_cancelled_read_keeps_its_slot_until_its_thread_ends():
    from fastapi import FastAPI
    from services.public_limits import PublicLimits
    from services.public_protection import PublicProtection
    began, release, finished = threading.Event(), threading.Event(), threading.Event()

    def blocking():
        began.set()
        release.wait(10)
        finished.set()
        return {"ok": True}
    app = FastAPI()

    @app.get("/api/meta")
    async def meta():
        return await asyncio.to_thread(blocking)
    lim = PublicLimits(read_concurrent=1)
    protect = PublicProtection(app, lambda: True, route_app=app, limits=lambda: lim)

    async def check():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(protect), base_url="http://testserver") as c:
            task = asyncio.create_task(c.get("/api/meta"))
            for _ in range(100):
                if began.is_set():
                    break
                await asyncio.sleep(0.01)
            assert began.is_set() and protect.read_work.running == 1
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            await asyncio.sleep(0.05)
            assert (protect.read_work.running, finished.is_set()) == (1, False)
            release.set()
            for _ in range(200):
                if protect.read_work.running == 0:
                    break
                await asyncio.sleep(0.01)
            assert finished.is_set() and protect.read_work.running == 0
    try:
        asyncio.run(check())
    finally:
        release.set()


def test_a_cancelled_analysis_keeps_its_session_changing_until_it_ends(monkeypatch):
    from types import SimpleNamespace
    from fastapi import FastAPI
    from services import public_cache as pc
    from services import public_protection as pp
    from services.public_limits import PublicLimits
    state = SimpleNamespace(datasets={})
    monkeypatch.setattr(pp, "visitor_state", lambda scope: state)
    began, release = threading.Event(), threading.Event()
    app = FastAPI()

    @app.post("/api/cluster")
    async def cluster():
        began.set()
        await asyncio.to_thread(release.wait, 10)
        return {"ok": True}
    lim = PublicLimits(heavy_concurrent=1, heavy_timeout_seconds=30)
    protect = pp.PublicProtection(app, lambda: True, route_app=app, limits=lambda: lim)

    async def check():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(protect), base_url="http://testserver") as c:
            task = asyncio.create_task(c.post("/api/cluster"))
            for _ in range(100):
                if began.is_set():
                    break
                await asyncio.sleep(0.01)
            assert began.is_set() and pc.busy(state) == 1
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert (pc.busy(state), protect.heavy_work.running) == (1, 1)
            release.set()
            for _ in range(200):
                if protect.heavy_work.running == 0 and pc.busy(state) == 0:
                    break
                await asyncio.sleep(0.01)
            assert pc.busy(state) == protect.heavy_work.running == 0
    try:
        asyncio.run(check())
    finally:
        release.set()


# --- deployment and flags -----------------------------------------------------------------

def test_compose_keeps_the_catalog_beside_its_data():
    """A relative catalog path must resolve inside the data mount."""
    import os
    dockerfile = (REPO / "deploy" / "Dockerfile").read_text()
    compose = (REPO / "deploy" / "docker-compose.yml").read_text()
    catalog = re.search(r'CMD \["--catalog", "([^"]+)"\]', dockerfile).group(1)
    assert re.search(r"\$\{FIBERBROWSER_DATA\}:/data:ro", compose)
    assert os.path.dirname(catalog) == "/data"
    assert "/config/catalog.json" not in compose
    from services import catalog_endpoint as cat
    saved = cat._catalog
    try:
        cat.set_catalog({"groups": []}, base_dir=os.path.dirname(catalog))
        assert cat._catalog_entry_path({"path": "k562/k562_nucleosome.bb"}) == "/data/k562/k562_nucleosome.bb"
    finally:
        cat._catalog = saved


def test_caddy_uses_passive_checks_for_dynamic_replicas():
    """Caddy runs no active health checks on dynamic upstreams."""
    caddyfile = (REPO / "deploy" / "Caddyfile").read_text()
    proxy = caddyfile[caddyfile.index("reverse_proxy"):]
    assert "dynamic a" in proxy
    assert "health_uri" not in proxy and "fail_duration" in proxy and "lb_try_duration" in proxy


def test_every_public_limit_has_its_flag():
    from services.cli_args import build_arg_parser, parse_browser_args
    from services.public_limits import limit_names
    flags = {action.dest for action in build_arg_parser()._actions}
    assert not [name for name in limit_names() if "public_" + name not in flags]
    args = parse_browser_args(["--public", "--public-read-concurrent", "2", "--public-max-vplot-cells", "5"])
    assert args.public_read_concurrent == 2 and args.public_max_vplot_cells == 5
