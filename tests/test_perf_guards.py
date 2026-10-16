"""Performance guards (fb-n1-perf, 3.0 release candidate).

Each test pins a fix for a measured slowdown; see the comments for the numbers.
"""
from __future__ import annotations

import os

import pytest

from tests.conftest import auth_headers

DEMO_BAM = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "browser", "data", "demo", "napa_ddda.bam")
DEMO_CHROM, DEMO_START, DEMO_END = "chr19", 47_514_000, 47_518_000


@pytest.fixture
def demo_state_client(standalone_app):
    """A TestClient whose requests see a fresh state holding the demo BAM."""
    from starlette.testclient import TestClient
    from state import get_state
    from state.browser_state import BrowserState

    state = BrowserState(None, None, None, None)
    state.add_dataset("demo", DEMO_BAM, "Demo")
    standalone_app.dependency_overrides[get_state] = lambda: state
    try:
        yield TestClient(standalone_app, headers=auth_headers()), state
    finally:
        standalone_app.dependency_overrides.pop(get_state, None)


def test_quality_impact_loads_the_view_not_ten_times_it(demo_state_client, monkeypatch):
    """The toolbar's quality summary asks for /api/quality/impact on every view
    (the FIRE default filter is on), at the same time as the display load. It
    loaded a 10x prefetch window of its own: on the 18.8 GB E02 DddB BAM a
    50 kb view took 10.4 s (1.3 s for the view alone) and competed with the
    display's read load (first reads 13-24 s instead of ~3 s)."""
    import services.read_route_helpers as helpers

    client, _state = demo_state_client
    spans = []
    real = helpers.build_direct_bam_reads

    def spy(state, bam_path, chrom, start, end, **kwargs):
        spans.append((chrom, start, end))
        return real(state, bam_path, chrom, start, end, **kwargs)

    monkeypatch.setattr(helpers, "build_direct_bam_reads", spy)
    response = client.post("/api/quality/impact", json={
        "chrom": DEMO_CHROM, "start": DEMO_START, "end": DEMO_END,
        "filters": [{"layer": "fire", "qualityName": "aq", "minValue": 230, "enabled": True}],
        "dataset_ids": ["demo"],
    })
    assert response.status_code == 200, response.text
    assert response.json()["success"] is True
    assert spans, "the impact count loaded no reads"
    for chrom, start, end in spans:
        assert chrom == DEMO_CHROM
        assert end - start <= DEMO_END - DEMO_START, (start, end)


def _status_latency_during(app, method: str, path: str, **kwargs) -> tuple[float, object]:
    """Seconds /api/status takes while ``method path`` is in flight (and its response).

    A route that does blocking work on the event loop stalls every other
    request for as long as the work takes; one that runs it in a thread does not.
    """
    import asyncio
    import time

    import httpx

    async def run():
        transport = httpx.ASGITransport(app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver",
                                     headers=auth_headers(), timeout=30) as client:
            t0 = time.perf_counter()
            slow = asyncio.create_task(client.request(method, path, **kwargs))
            # The slow request gets under way; a blocked loop overruns this sleep.
            await asyncio.sleep(0.15)
            status = await client.get("/api/status")
            elapsed = time.perf_counter() - t0 - 0.15
            assert status.status_code == 200
            return elapsed, await slow

    return asyncio.run(run())


def test_version_check_does_not_block_the_event_loop(standalone_app, monkeypatch):
    """/api/version (every page load) probed GitHub with a blocking urlopen on
    the event loop and never remembered a failure: each load stalled every
    other request for the round trip (0.65 s measured; up to the 4 s timeout
    per socket operation offline). It now asks the update check
    (services/app_update.py), off the loop, which remembers a failure."""
    import time

    from services import app_update

    probes = []

    def slow_fetch(config):
        probes.append(1)
        time.sleep(1.0)
        raise app_update.UpdateError("offline")

    monkeypatch.delenv("FIBERBROWSER_NO_UPDATE_CHECK", raising=False)
    monkeypatch.setattr(app_update, "fetch_manifest", slow_fetch)
    from services import app_settings
    # A source run (this test) doesn't check at startup by default: nothing is probed.
    app_update.reset()
    from starlette.testclient import TestClient
    assert TestClient(standalone_app, headers=auth_headers()).get("/api/version").json()["update_available"] is False
    assert probes == []
    # As the app does (the check at startup on): the probe runs off the event loop.
    monkeypatch.setattr(app_settings, "default_check_at_startup", lambda: True)
    app_update.reset()
    try:
        elapsed, response = _status_latency_during(standalone_app, "GET", "/api/version")
        assert response.status_code == 200 and response.json()["update_available"] is False
        assert elapsed < 0.5, f"/api/status waited {elapsed:.2f} s behind the version probe"

        # A failed probe is remembered: the next page load doesn't probe again.
        assert TestClient(standalone_app, headers=auth_headers()).get("/api/version").status_code == 200
        assert len(probes) == 1
    finally:
        app_update.reset()


@pytest.mark.parametrize("builder,path", [
    ("get_genes_payload", "/api/genes?chrom=chr2R&start=0&end=800000"),
    ("get_coverage_payload", "/api/coverage?chrom=chr2R&start=0&end=5000000&bins=1000"),
])
def test_navigation_routes_do_not_block_the_event_loop(standalone_app, monkeypatch, builder, path):
    """Every navigation requests genes (for a padded window) and, beyond read
    zoom, coverage. Both ran on the event loop: genes took 0.6 s for a 200 kb
    dm6 view and 4-6 s for 2 Mb (dm6, hg38); coverage 3.3 s for 5 Mb of the
    E02 DddB BAM, stalling every other request meanwhile."""
    import time

    import routers.read_auxiliary as read_auxiliary

    def slow(*args, **kwargs):
        time.sleep(1.0)
        if builder == "get_genes_payload":
            return {"content": {"genes": []}, "headers": {}}
        return {"coverage": [], "max": 0}

    monkeypatch.setattr(read_auxiliary, builder, slow)
    elapsed, response = _status_latency_during(standalone_app, "GET", path)
    assert response.status_code == 200, response.text
    assert elapsed < 0.5, f"/api/status waited {elapsed:.2f} s behind {path}"


def test_gene_exons_grouped_once_per_window():
    """Gene exons were found by scanning the whole exon table once per visible
    transcript (O(transcripts x exons)); the window's exons are now grouped once.
    Same payload, including the exon order and transcripts without exons."""
    import types

    import pandas as pd

    from services.read_auxiliary_endpoint import get_genes_payload

    transcripts = pd.DataFrame([
        {"transcript_id": "t1", "gene_name": "A", "chrom": "chr2R", "start": 100, "end": 900, "strand": "+", "biotype": "protein_coding"},
        {"transcript_id": "t2", "gene_name": "B", "chrom": "chr2R", "start": 500, "end": 2000, "strand": "-", "biotype": ""},
        {"transcript_id": "t3", "gene_name": "C", "chrom": "chr2R", "start": 5000, "end": 6000, "strand": "+", "biotype": ""},
        {"transcript_id": "t4", "gene_name": "D", "chrom": "chr3L", "start": 100, "end": 900, "strand": "+", "biotype": ""},
    ])
    exons = pd.DataFrame([
        {"transcript_id": "t2", "chrom": "chr2R", "start": 1500, "end": 2000},
        {"transcript_id": "t1", "chrom": "chr2R", "start": 700, "end": 900},
        {"transcript_id": "t1", "chrom": "chr2R", "start": 100, "end": 200},
        {"transcript_id": "t2", "chrom": "chr2R", "start": 500, "end": 600},
        {"transcript_id": "t3", "chrom": "chr2R", "start": 5000, "end": 6000},
        {"transcript_id": "t4", "chrom": "chr3L", "start": 100, "end": 900},
    ])
    state = types.SimpleNamespace(gtf_data={"transcripts": transcripts, "exons": exons},
                                  chroms=[], chrom_sizes={}, circular_chroms={})
    genes = get_genes_payload(state, chrom="chr2R", start=0, end=1600)["content"]["genes"]
    assert [(g["id"], g["exons"]) for g in genes] == [
        ("t1", [{"start": 700, "end": 900}, {"start": 100, "end": 200}]),
        ("t2", [{"start": 1500, "end": 2000}, {"start": 500, "end": 600}]),
    ]
    no_exons = get_genes_payload(state, chrom="chr2R", start=1000, end=1400)["content"]["genes"]
    assert [(g["id"], g["exons"]) for g in no_exons] == [("t2", [])]


@pytest.mark.parametrize("prefetch", [None, 3, 20])
def test_prefetch_option_does_not_widen_the_display_load(demo_state_client, monkeypatch, prefetch):
    """The cache budget must not multiply a cold visible request's decode."""
    import services.read_endpoint as read_endpoint

    client, state = demo_state_client
    from services.performance import apply_mode
    apply_mode(state, 'standard')
    if prefetch is not None:
        state.config["prefetch_multiplier"] = prefetch
    spans = []
    real = read_endpoint.build_direct_bam_reads

    def spy(state, bam_path, chrom, start, end, **kwargs):
        spans.append(end - start)
        return real(state, bam_path, chrom, start, end, **kwargs)

    monkeypatch.setattr(read_endpoint, "build_direct_bam_reads", spy)
    response = client.get("/api/reads/compact", params={
        "chrom": DEMO_CHROM, "start": DEMO_START, "end": DEMO_END, "dataset_id": "demo", "max_reads": 50})
    assert response.status_code == 200, response.text
    assert response.json()["reads"], "no reads in the demo view"
    assert spans == [DEMO_END - DEMO_START]


def _app_gzip_middleware(app):
    """The server's response-compression middleware (class, options)."""
    for middleware in app.user_middleware:
        if "gzip" in middleware.cls.__name__.lower():
            return middleware.cls, dict(middleware.kwargs)
    raise AssertionError("no gzip middleware installed")


def _gzip_test_app(app, body: bytes):
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse, Response, StreamingResponse
    from starlette.routing import Route

    async def big(request):
        return Response(body, media_type="application/json")

    async def big_stream(request):
        async def chunks():
            yield body[:1000]
            yield body[1000:]  # one large chunk
        return StreamingResponse(chunks(), media_type="application/json")

    async def status(request):
        return JSONResponse({"ok": True})

    cls, kwargs = _app_gzip_middleware(app)
    inner = Starlette(routes=[Route("/big", big), Route("/big_stream", big_stream), Route("/api/status", status)])
    return cls(inner, **kwargs)


def _big_json(megabytes: int) -> bytes:
    import json
    import random

    rng = random.Random(7)
    row = json.dumps([[rng.randrange(10**6), rng.randrange(10**6), rng.randrange(400)] for _ in range(4000)]).encode()
    return b"[" + b",".join([row] * (megabytes * 1_000_000 // len(row))) + b"]"


@pytest.mark.parametrize("route", ["/big", "/big_stream"])
def test_response_compression_does_not_block_the_event_loop(standalone_app, route):
    """Responses were gzipped on the event loop (Starlette's GZipMiddleware, at
    level 9: 63 ms per MB of read JSON). Browsing 50-100 kb views of two deep
    BAMs, compression was 96% of the event loop's busy time: other requests
    waited behind every read payload. Large bodies are now compressed in a
    worker thread."""
    import asyncio
    import gzip
    import time

    import httpx

    body = _big_json(48)
    app = _gzip_test_app(standalone_app, body)

    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://testserver",
                                     headers={"Accept-Encoding": "gzip"}, timeout=60) as client:
            t0 = time.perf_counter()
            big = asyncio.create_task(client.get(route))
            await asyncio.sleep(0.15)
            status = await client.get("/api/status")
            elapsed = time.perf_counter() - t0 - 0.15
            return elapsed, status, await big

    elapsed, status, big = asyncio.run(run())
    assert status.status_code == 200
    assert big.headers.get("content-encoding") == "gzip"
    assert big.content == body  # httpx decodes the gzip body
    assert elapsed < 0.3, f"/api/status waited {elapsed:.2f} s behind compressing a {len(body) >> 20} MB response"


def test_response_compression_matches_starlette_semantics(standalone_app):
    """Small bodies, already-encoded bodies, event streams and streaming bodies
    behave as with Starlette's GZipMiddleware."""
    import gzip

    from starlette.applications import Starlette
    from starlette.responses import PlainTextResponse, Response, StreamingResponse
    from starlette.routing import Route
    from starlette.testclient import TestClient

    cls, kwargs = _app_gzip_middleware(standalone_app)
    minimum = kwargs.get("minimum_size", 500)

    async def small(request):
        return PlainTextResponse("x" * (minimum - 1))

    async def large(request):
        return PlainTextResponse("y" * (minimum * 4))

    async def encoded(request):
        return Response(gzip.compress(b"z" * 5000), headers={"Content-Encoding": "gzip"}, media_type="text/plain")

    async def events(request):
        return Response("data: 1\n\n" * 500, media_type="text/event-stream")

    async def stream(request):
        async def chunks():
            for i in range(50):
                yield f"chunk {i} ".encode() * 40
        return StreamingResponse(chunks(), media_type="text/plain")

    inner = Starlette(routes=[Route("/small", small), Route("/large", large), Route("/encoded", encoded),
                              Route("/events", events), Route("/stream", stream)])
    client = TestClient(cls(inner, **kwargs))
    gz = {"Accept-Encoding": "gzip"}

    r = client.get("/small", headers=gz)
    assert "content-encoding" not in r.headers and r.text == "x" * (minimum - 1)
    r = client.get("/large", headers=gz)
    assert r.headers["content-encoding"] == "gzip" and r.text == "y" * (minimum * 4)
    assert "accept-encoding" in r.headers.get("vary", "").lower()
    assert int(r.headers["content-length"]) < minimum * 4  # the compressed length
    r = client.get("/large", headers={"Accept-Encoding": "identity"})
    assert "content-encoding" not in r.headers and r.text == "y" * (minimum * 4)
    r = client.get("/encoded", headers=gz)
    assert r.content == b"z" * 5000  # decoded once: not compressed twice
    r = client.get("/events", headers=gz)
    assert "content-encoding" not in r.headers
    r = client.get("/stream", headers=gz)
    assert r.headers["content-encoding"] == "gzip" and "content-length" not in r.headers
    assert r.content == b"".join(f"chunk {i} ".encode() * 40 for i in range(50))


def test_full_gc_threshold_raised_for_read_caches(monkeypatch):
    """Full collections walked the read caches (millions of objects) 20 times
    in 90 s of browsing, up to 2.1 s each with the GIL held (14.5 s in all,
    nothing freed). The server raises the generation-2 threshold at start;
    a threshold already disabled (0) or raised is left alone."""
    import gc

    from services.gc_tuning import FULL_COLLECTION_THRESHOLD, configure_gc

    original = gc.get_threshold()
    try:
        gc.set_threshold(700, 10, 10)
        assert configure_gc() == (700, 10, FULL_COLLECTION_THRESHOLD)
        assert FULL_COLLECTION_THRESHOLD >= 1000
        gc.set_threshold(700, 10, 5000)
        assert configure_gc() == (700, 10, 5000)
        gc.set_threshold(0, 10, 10)  # collection disabled: unchanged
        assert configure_gc() == (0, 10, 10)
        gc.set_threshold(700, 10, 10)
        monkeypatch.setenv("FIBERBROWSER_GC_FULL_THRESHOLD", "0")  # opt out: Python's defaults
        assert configure_gc() == (700, 10, 10)
        monkeypatch.setenv("FIBERBROWSER_GC_FULL_THRESHOLD", "250")
        assert configure_gc() == (700, 10, 250)
    finally:
        gc.set_threshold(*original)


def test_server_main_configures_gc_first():
    """browser.py and the app's --serve both start the server with server.main()."""
    import inspect

    import server

    assert "configure_gc()" in inspect.getsource(server.main)


def test_read_name_lookup_stops_when_the_client_goes_away(standalone_app, monkeypatch):
    """Cancel (or a new query) aborts the browser's fetch; the server is meant
    to stop scanning (``cancelled`` in services/read_locate.py). Behind the
    server's @app.middleware("http") layers ``request.is_disconnected()``
    never reported the disconnect, so every cancelled lookup kept a core busy
    for its whole 20 s budget."""
    import asyncio
    import json
    import time

    import services.read_locate as read_locate

    seen = {}

    def scan_until_cancelled(state, names, *, cancelled=None, **kwargs):
        t0 = time.monotonic()
        while time.monotonic() - t0 < 8:
            if cancelled is not None and cancelled():
                seen["cancelled_after"] = time.monotonic() - t0
                break
            time.sleep(0.02)
        return {"results": [], "complete": False}

    monkeypatch.setattr(read_locate, "locate_reads", scan_until_cancelled)
    body = json.dumps({"names": ["m84046/1/ccs"], "scope": "genome"}).encode()

    async def run():
        sent = {"body": False}
        disconnect_at = time.monotonic() + 0.5

        async def receive():
            if not sent["body"]:
                sent["body"] = True
                return {"type": "http.request", "body": body, "more_body": False}
            await asyncio.sleep(max(0.0, disconnect_at - time.monotonic()))
            return {"type": "http.disconnect"}

        async def send(message):
            pass

        from tests.conftest import auth_headers
        headers = [(b"content-type", b"application/json"), (b"host", b"127.0.0.1")]
        headers += [(k.lower().encode(), v.encode()) for k, v in auth_headers().items()]
        scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "POST",
                 "scheme": "http", "path": "/api/reads/locate", "raw_path": b"/api/reads/locate",
                 "query_string": b"", "root_path": "", "headers": headers,
                 "client": ("127.0.0.1", 50000), "server": ("127.0.0.1", 8000)}
        await asyncio.wait_for(standalone_app(scope, receive, send), timeout=20)

    asyncio.run(run())
    assert "cancelled_after" in seen, "the scan ran to its end after the client went away"
    assert seen["cancelled_after"] < 2.0, seen


def test_region_catalog_is_not_walked_by_jsonable_encoder(client, monkeypatch, tmp_path):
    """GET /api/regions/catalog (every page load) returned a dict, so FastAPI
    ran jsonable_encoder over it on the event loop: 0.6-1.0 s for a
    50,000-entry catalog (1.3-1.6 s per request; first reads 4.4-4.8 s
    instead of 2.8-3.7 s). The catalog is plain JSON: it is sent with orjson."""
    import fastapi.routing

    import services.region_catalog as region_catalog

    entries = [{"id": f"e{i}", "chrom": "chr2R", "start": i * 100, "end": i * 100 + 50, "label": f"r{i}",
                "category": "bed", "source": "bed"} for i in range(2000)]
    catalog = {"version": 1, "genome": "dm6", "categories": [{"id": "bed", "name": "Imported", "source": "bed"}],
               "entries": entries, "revision": 3}
    monkeypatch.setattr(region_catalog, "read_catalog", lambda genome, *rest, **kw: catalog)

    real = fastapi.routing.jsonable_encoder
    walked = []

    def spy(obj, *args, **kwargs):
        if isinstance(obj, dict) and "catalog" in obj:
            walked.append(1)
        return real(obj, *args, **kwargs)

    monkeypatch.setattr(fastapi.routing, "jsonable_encoder", spy)
    response = client.get("/api/regions/catalog", params={"genome": "dm6"})
    assert response.status_code == 200
    assert response.json() == {"success": True, "catalog": catalog, "identity": ""}
    assert not walked, "the catalog went through jsonable_encoder"


def test_read_name_scan_reuses_the_shared_threaded_handle(monkeypatch):
    """Name scans keep threaded decompression within the shared reader cache."""
    import pysam
    import types
    from services import bam_handles
    from services.file_handles import HandleCache
    import services.read_locate as read_locate
    import services.remote_sources.opening as opening

    cache = HandleCache()
    monkeypatch.setattr(bam_handles, 'handles', cache)
    monkeypatch.setattr(bam_handles, '_bam_threads', 4)
    opened = []
    real_open = opening.open_alignment_file

    def spy(path, mode="rb", **kwargs):
        handle = real_open(path, mode, **kwargs)
        opened.append((kwargs, handle))
        return handle

    monkeypatch.setattr(opening, "open_alignment_file", spy)
    with pysam.AlignmentFile(DEMO_BAM) as bam:
        name = next(bam.fetch(DEMO_CHROM, DEMO_START, DEMO_END)).query_name
    dataset = types.SimpleNamespace(id="demo", label="Demo", paths=[DEMO_BAM], data_type="bam")
    state = types.SimpleNamespace(chrom_map={}, translate_chrom=lambda c: c)
    try:
        for _ in range(2):
            search = read_locate._Search([name], budget_s=10, max_records=10**6)
            read_locate._scan_bam(search, state, dataset, DEMO_BAM, [(DEMO_CHROM, DEMO_START, DEMO_END)])
            assert name in search.found
        assert len(opened) == 1
        kwargs, handle = opened[0]
        assert kwargs["threads"] == 4 and handle.is_open
        assert cache.diagnostics()['active'] == 0
    finally:
        cache.discard()
    assert not handle.is_open


_Q = "?chrom=chr2R&start=0&end=10000"


@pytest.mark.parametrize("module,builder,path,body", [
    ("services.clustering_endpoint", "run_cluster_all_endpoint", "/api/cluster_all", {"method": "kmeans"}),
    ("services.clustering_endpoint", "run_cluster_all_endpoint", "/api/cluster_all", {"method": "graph"}),
    ("services.clustering_endpoint", "run_dissolve_cluster_endpoint", "/api/dissolve_cluster",
     {"cluster_to_dissolve": 0, "current_assignments": {}}),
    ("services.clustering_endpoint", "run_auto_cull_clusters_endpoint", "/api/auto_cull_clusters", {"current_assignments": {}}),
    ("services.clustering_endpoint", "run_assign_to_clusters_endpoint", "/api/assign_to_clusters", {}),
    ("services.clustering_endpoint", "run_cluster_endpoint", "/api/cluster", {"peak_indices": [0]}),
    ("services.clustering_endpoint", "run_cluster_expand_endpoint", "/api/cluster_expand", {}),
    ("routers.read_stats", "compute_read_stats", "/api/reads/stats", {"read_ids_by_dataset": {}}),
    ("routers.filtering", "sort_reads_for_request", "/api/sort_reads", {"sort_by": "fp_count"}),
    ("routers.filtering", "filter_reads_for_request", "/api/filter", {}),
    ("routers.filtering", "filter_reads_by_analysis_rule_for_request", "/api/filter_by_analysis_rule", {}),
    ("routers.filtering", "filter_by_transcription_state_for_request", "/api/filter_by_transcription_state",
     {"gene_ids": ["g"], "filters": {}}),
    ("routers.filtering", "pol2_com_for_request", "/api/pol2_com", {}),
    ("routers.filtering", "autozoom_for_request", "/api/autozoom", {}),
])
def test_analysis_routes_do_not_block_the_event_loop(standalone_app, monkeypatch, module, builder, path, body):
    """Clustering, Read stats, sorting and the read filters load the working
    set (BAM reads) and work on it: on deep data, seconds. They ran on the
    event loop: Read stats stalled every other request for 5-72 s (E02 DddB /
    Hia5, 10-100 kb), k-means clustering 0.6-2.1 s per run."""
    import importlib
    import time

    target = importlib.import_module(module)

    def slow(*args, **kwargs):
        time.sleep(1.0)
        return {"success": True}

    monkeypatch.setattr(target, builder, slow)
    elapsed, response = _status_latency_during(standalone_app, "POST", path + _Q, json=body)
    assert response.status_code == 200, response.text
    assert elapsed < 0.5, f"/api/status waited {elapsed:.2f} s behind {path}"


def test_cluster_state_changes_stay_one_at_a_time(standalone_app, monkeypatch):
    """Off the event loop, two clustering runs that change cluster assignments
    still don't interleave (they were serialised by the loop before)."""
    import asyncio
    import threading
    import time

    import httpx

    import services.clustering_endpoint as clustering_endpoint

    active, overlap = [0], []
    guard = threading.Lock()

    def slow(*args, **kwargs):
        with guard:
            active[0] += 1
            overlap.append(active[0])
        time.sleep(0.3)
        with guard:
            active[0] -= 1
        return {"success": True}

    monkeypatch.setattr(clustering_endpoint, "run_cluster_all_endpoint", slow)
    monkeypatch.setattr(clustering_endpoint, "run_dissolve_cluster_endpoint", slow)

    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(standalone_app), base_url="http://testserver",
                                     headers=auth_headers(), timeout=30) as client:
            await asyncio.gather(
                client.post("/api/cluster_all" + _Q, json={"method": "kmeans"}),
                client.post("/api/dissolve_cluster" + _Q, json={"cluster_to_dissolve": 0, "current_assignments": {}}),
                client.post("/api/cluster_all" + _Q, json={"method": "graph"}),
            )

    asyncio.run(run())
    assert overlap and max(overlap) == 1, overlap


def test_disconnect_seen_from_a_worker_event_loop():
    """A --public server runs handlers on worker event loops; the server's
    receive awaits an event of its own loop. The disconnect wait hops to that
    loop instead of failing ("bound to a different event loop")."""
    import asyncio
    import threading
    import time
    import types

    from services.client_disconnect import RAW_RECEIVE_KEY, wait_for_disconnect

    owner = asyncio.new_event_loop()
    threading.Thread(target=owner.run_forever, daemon=True).start()
    try:
        async def make_event():
            event = asyncio.Event()
            asyncio.ensure_future(event.wait())  # bind it to the owner loop, as the server does
            await asyncio.sleep(0)
            return event
        event = asyncio.run_coroutine_threadsafe(make_event(), owner).result(5)

        async def raw_receive():  # what uvicorn's receive does once the body is read
            await event.wait()
            return {"type": "http.disconnect"}

        owner.call_later(0.3, event.set)
        request = types.SimpleNamespace(scope={RAW_RECEIVE_KEY: (raw_receive, owner)})
        t0 = time.monotonic()
        asyncio.run(asyncio.wait_for(wait_for_disconnect(request), timeout=5))
        assert time.monotonic() - t0 < 2
    finally:
        owner.call_soon_threadsafe(owner.stop)


def test_cluster_state_changes_in_other_workspaces_run_concurrently(standalone_app, monkeypatch):
    """The cluster-state lock belongs to a workspace: two sessions' clustering
    runs don't queue behind each other (a panel-genome view shares its
    workspace's lock)."""
    import asyncio
    import threading
    import time

    import httpx
    from fastapi import Request

    import services.clustering_endpoint as clustering_endpoint
    from routers.clustering import _cluster_state_lock
    from services.panel_genomes import genome_view  # noqa: F401  (the view type exists)
    from state import get_state
    from state.browser_state import BrowserState

    states = {"a": BrowserState(None, None, None, None), "b": BrowserState(None, None, None, None)}
    view = type("View", (), {})()
    view.__dict__.update(dict(states["a"].__dict__, _genome_base=states["a"]))
    assert _cluster_state_lock(view) is _cluster_state_lock(states["a"])
    assert _cluster_state_lock(states["a"]) is not _cluster_state_lock(states["b"])

    active, peak = [0], [0]
    guard = threading.Lock()

    def slow(*args, **kwargs):
        with guard:
            active[0] += 1
            peak[0] = max(peak[0], active[0])
        time.sleep(0.4)
        with guard:
            active[0] -= 1
        return {"success": True}

    def pick(request):
        return states[request.headers.get("x-ws", "a")]
    pick.__annotations__["request"] = Request  # a real class (this module has postponed annotations)

    monkeypatch.setattr(clustering_endpoint, "run_cluster_all_endpoint", slow)
    standalone_app.dependency_overrides[get_state] = pick
    try:
        async def run():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(standalone_app), base_url="http://testserver",
                                         headers=auth_headers(), timeout=30) as client:
                return await asyncio.gather(
                    client.post("/api/cluster_all" + _Q, json={"method": "kmeans"}, headers={"x-ws": "a"}),
                    client.post("/api/cluster_all" + _Q, json={"method": "kmeans"}, headers={"x-ws": "b"}),
                )
        responses = asyncio.run(run())
    finally:
        standalone_app.dependency_overrides.pop(get_state, None)
    assert [r.status_code for r in responses] == [200, 200], [r.text[:200] for r in responses]
    assert peak[0] == 2


def test_quality_impact_counts_match_the_prefetched_window(demo_state_client):
    """Counting on the view alone gives the same numbers as counting on the
    old 10x window (MA-tagged reads: the demo BAM)."""
    from services.read_quality_filters import quality_filter_impact

    client, state = demo_state_client
    filters = [{"layer": "*", "qualityName": "tq", "minValue": 100, "enabled": True},
               {"layer": "nuc", "qualityName": "nq", "minValue": 50, "enabled": True}]
    served = client.post("/api/quality/impact", json={
        "chrom": DEMO_CHROM, "start": DEMO_START, "end": DEMO_END, "filters": filters, "dataset_ids": ["demo"],
    }).json()["filters"]
    wide = state.build_working_set("demo", DEMO_CHROM, DEMO_START, DEMO_END, False, 0, include_methylation=False,
                                   include_layers=True, include_layer_qualities=True, quality_filters=[],
                                   broad_prefetch_multiplier=10, force_reload=True)
    expected = quality_filter_impact(wide.reads, [
        {"layer": f["layer"], "quality_name": f["qualityName"], "min_value": f["minValue"]} for f in filters])
    assert served == expected
    assert all(f["total"] > 0 for f in served)


def test_read_stats_load_the_view_with_identical_stats(demo_state_client, monkeypatch):
    """Read stats rebuilt the working set with methylation decoded over the
    10x prefetch window: 5.4 s for 300 reads at 10 kb and 25.8 s at 50 kb on
    the E02 DddB BAM (0.6 s / 2.8 s for the view; stats identical on E02 and
    Hia5). The view alone is loaded; the stats are unchanged."""
    import services.read_endpoint as read_endpoint
    import services.read_route_helpers as helpers
    import services.read_stats as read_stats
    from models.requests import ReadStatsRequest
    from state.browser_state import BrowserState

    _client, state = demo_state_client
    ids = [r["id"] for r in state.build_working_set("demo", DEMO_CHROM, DEMO_START, DEMO_END, False, 0,
                                                    include_layers=False, broad_prefetch_multiplier=1).reads][:40]
    assert ids
    request = ReadStatsRequest(read_ids_by_dataset={"demo": ids})

    spans = []
    real = helpers.build_direct_bam_reads

    def spy(st, bam_path, chrom, start, end, **kwargs):
        spans.append(end - start)
        return real(st, bam_path, chrom, start, end, **kwargs)

    fresh = BrowserState(None, None, None, None)
    fresh.add_dataset("demo", DEMO_BAM, "Demo")
    monkeypatch.setattr(helpers, "build_direct_bam_reads", spy)
    monkeypatch.setattr(read_endpoint, "build_direct_bam_reads", spy, raising=False)
    got = read_stats.compute_read_stats(state=fresh, chrom=DEMO_CHROM, start=DEMO_START, end=DEMO_END,
                                        spanning=False, request=request)
    assert spans and max(spans) <= DEMO_END - DEMO_START, spans

    monkeypatch.setattr(read_stats, "READ_STATS_PREFETCH_MULTIPLIER", 10)
    wide = BrowserState(None, None, None, None)
    wide.add_dataset("demo", DEMO_BAM, "Demo")
    expected = read_stats.compute_read_stats(state=wide, chrom=DEMO_CHROM, start=DEMO_START, end=DEMO_END,
                                             spanning=False, request=ReadStatsRequest(read_ids_by_dataset={"demo": ids}))
    assert got == expected


def test_quality_impact_keeps_the_prefetch_for_bigbed(monkeypatch):
    """BigBed companion layers outside the view count in the terminal-gap
    filter, so the view-only load applies to BAM datasets only."""
    import types

    from starlette.testclient import TestClient

    import server
    from state import get_state

    calls = []

    class FakeState:
        dataset_order = ["bam", "bb"]

        def get_dataset(self, dataset_id):
            return types.SimpleNamespace(id=dataset_id, data_type="bam" if dataset_id == "bam" else "bigbed")

        def build_working_set(self, dataset_id, *args, **kwargs):
            calls.append((dataset_id, kwargs.get("broad_prefetch_multiplier")))
            return types.SimpleNamespace(reads=[])

    server.app.dependency_overrides[get_state] = lambda: FakeState()
    try:
        response = TestClient(server.app, headers=auth_headers()).post("/api/quality/impact", json={
            "chrom": "chr1", "start": 0, "end": 1000, "dataset_ids": ["bam", "bb"],
            "filters": [{"layer": "*", "qualityName": "tq", "minValue": 1}]})
    finally:
        server.app.dependency_overrides.pop(get_state, None)
    assert response.status_code == 200, response.text
    assert calls == [("bam", 1), ("bb", None)]


def test_peak_regions_are_read_as_one_scan_published_them():
    """Scans and filters run in worker threads: a reader gets one scan's view
    and peaks together, never one scan's view with another's peaks."""
    import types

    from services.peak_scanning import remember_peak_regions, stored_peak_regions_for

    state = types.SimpleNamespace()
    remember_peak_regions(state, [[1, 2]], "chr1", 0, 100)
    assert stored_peak_regions_for(state, "chr1", 0, 100) == [[1, 2]]
    # Mid-update (the snapshot is new, the attributes not yet): the old pair, consistent.
    state.peak_regions_snapshot = (("chr1", 500, 600), [[7, 8]])
    assert stored_peak_regions_for(state, "chr1", 0, 100) == [[1, 2]]
    assert stored_peak_regions_for(state, "chr1", 500, 600) == []
    # Attributes updated one by one (regions first): the snapshot pairs them.
    remember_peak_regions(state, [[3, 4]], "chr1", 1000, 1100)
    state.peak_regions_view = ("chr1", 0, 100)  # a stale view from another writer
    assert stored_peak_regions_for(state, "chr1", 1000, 1100) == [[3, 4]]
    assert stored_peak_regions_for(state, "chr1", 0, 100) == []
    # A reset elsewhere (new list, no snapshot): the attributes win.
    state.peak_regions = []
    assert stored_peak_regions_for(state, "chr1", 1000, 1100) == []


def test_state_cache_of_a_panel_genome_view_lives_on_its_workspace():
    """Coverage/FIRE result caches are created once (requests run in threads)
    and, for a panel-genome view, on the workspace it views, so the next
    request (a new view object) finds them."""
    from services.panel_genomes import _view_class
    from services.read_auxiliary_endpoint import _state_cache
    from state.browser_state import BrowserState

    base = BrowserState(None, None, None, None)
    base.__dict__.pop("_coverage_payload_cache", None)
    view = object.__new__(_view_class())
    view.__dict__.update(dict(base.__dict__, _genome_base=base, _genome_context=object(), _genome_key="dm6"))
    cache = _state_cache(view, "_coverage_payload_cache")
    cache["k"] = ("v", 0)
    assert getattr(base, "_coverage_payload_cache", None) is cache
    again = object.__new__(_view_class())
    again.__dict__.update(dict(base.__dict__, _genome_base=base, _genome_context=object(), _genome_key="dm6"))
    assert _state_cache(again, "_coverage_payload_cache") is cache
