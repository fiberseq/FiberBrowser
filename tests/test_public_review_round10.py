"""Regressions from the round-10 review of the public server (Codex, 30 Sep;
round10/scratch/test_round10_integration.py and test_round10_independent.py)."""
from __future__ import annotations

import asyncio
import json

import numpy as np
import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient

from models.requests import ClusterVPlotRequest
from services.footprint_analysis import accumulate_profile_and_vplot, build_interval_table
from services.public_limits import PublicLimits, install_public_request_limits, limit_body
from services.public_protection import PublicProtection


@pytest.fixture(autouse=True)
def four_workers(monkeypatch):
    monkeypatch.setattr("os.cpu_count", lambda: 4)


# --- V-plots: the matrix the route will really allocate --------------------------------

@pytest.mark.parametrize("case",["footprint_short_region","footprint_default_bins","cluster_default_bins"])
def test_real_models_exceed_public_vplot_cap(monkeypatch,case):
    import routers.footprint as fp
    lim=PublicLimits(heavy_concurrent=1,max_vplot_cells=100)
    app=FastAPI()
    app.include_router(fp.router)
    app.dependency_overrides[fp.get_state]=lambda:object()
    seen=[]
    if case=="cluster_default_bins":
        import routers.clustering_visualization as cv
        app.include_router(cv.router)
        def fake_query(*args,**kwargs):
            return type("Query",(),{"dataset_ids":[],"sample_seed":"test"})()
        monkeypatch.setattr(cv.AnalysisReadQuery,"from_request",fake_query)
        # Verify delivery of the exact model through middleware using a sibling
        # route with the real route template and model to report its dimensions.
        app=FastAPI()
        @app.post("/api/cluster/vplot")
        async def cluster(region_start:int,region_end:int,request:ClusterVPlotRequest):
            cells=((request.size_max-request.size_min)//request.size_bin)*((region_end-region_start)//request.pos_bin)
            seen.append(cells)
            return {"allocated_cells":cells}
        body={"size_min":0,"size_max":2000}
        url="/api/cluster/vplot?region_start=0&region_end=100"
    else:
        def spy(state,*,request,**kwargs):
            table=build_interval_table([],lambda r:[],0)
            _, matrix=accumulate_profile_and_vplot(table,[],request.profile_window,
                request.vplot_size_min,request.vplot_size_max,request.vplot_size_bin,request.vplot_pos_bin)
            seen.append(matrix.size)
            return {"allocated_cells":matrix.size}
        monkeypatch.setattr(fp,"analyze_footprints_payload",spy)
        body={"footprints":[],"dataset_ids":[],"profile_window":50,
              "vplot_size_min":0,"vplot_size_max":2000}
        if case=="footprint_short_region":
            body.update(vplot_size_max=20,vplot_size_bin=1,vplot_pos_bin=1)
        url="/api/footprint/analyze?chrom=p&region_start=0&region_end=1"
    wrapped=PublicProtection(app,lambda:True,route_app=app,limits=lambda:lim)
    with TestClient(wrapped) as client:
        response=client.post(url,json=body)
    assert response.status_code==413, (response.status_code,response.json(),seen,lim.max_vplot_cells)


@pytest.mark.parametrize("payload,positions,actual_cells", [
    ({"profile_window": 5000, "vplot_size_min": 0, "vplot_size_max": 10000,
      "vplot_size_bin": 1, "vplot_pos_bin": 1}, 10, 100_000_000),
    ({"profile_window": 5000, "vplot_size_min": 0, "vplot_size_max": 1000000}, 100, 100_000_000),
    ({"size_min": 0, "size_max": 1000000}, 10000, 100_000_000),
])
def test_public_vplot_guard_uses_actual_dimensions(payload, positions, actual_cells):
    route = "/api/footprint/analyze" if "profile_window" in payload else "/api/cluster/vplot"
    assert actual_cells > PublicLimits().max_vplot_cells
    assert limit_body(route, payload, PublicLimits(), positions=positions)[1] is not None


def test_default_vplots_stay_allowed():
    assert limit_body("/api/footprint/analyze", {"profile_window": 500}, PublicLimits()) == (None, None)
    assert limit_body("/api/cluster/vplot", {}, PublicLimits(), positions=4_000) == (None, None)


def test_the_allocators_refuse_past_the_public_limits(monkeypatch):
    """A backstop inside the allocators, whatever route led there."""
    from services import runtime
    from services.public_limits import AllocationTooLarge
    table = build_interval_table([], lambda r: [], 0)
    monkeypatch.setattr(runtime, "_public_mode", True)
    with pytest.raises(AllocationTooLarge):
        accumulate_profile_and_vplot(table, [], 5000, 0, 10_000, 1, 1)  # 1e8 cells
    with pytest.raises(AllocationTooLarge):
        accumulate_profile_and_vplot(table, [], 10**6, 10, 300, 10, 10)  # the profile itself
    agg, matrix = accumulate_profile_and_vplot(table, [], 500, 10, 300, 10, 10)
    assert matrix.shape == (29, 100)
    monkeypatch.setattr(runtime, "_public_mode", False)  # local use: no limit
    _agg, matrix = accumulate_profile_and_vplot(table, [], 5000, 0, 2000, 1, 1)
    assert matrix.size == 2000 * 10_000


# --- contact maps: every coordinate pair ----------------------------------------------------

@pytest.mark.parametrize("kind",["dafc_select","microc_virtual4c"])
def test_public_alternate_span_keys_are_checked(monkeypatch,kind):
    from types import SimpleNamespace
    from services import public_limits as pl
    monkeypatch.setattr(pl,"get_public_limits",lambda:PublicLimits())
    app=FastAPI()
    seen=[]
    contact=SimpleNamespace(clr=object())
    if kind=="dafc_select":
        import routers.dafc as route
        app.include_router(route.router)
        app.dependency_overrides[route.get_state]=lambda:object()
        monkeypatch.setattr(route,"_resolve_cooler_chrom",lambda s,c:c)
        monkeypatch.setattr(route,"fetch_cooler_matrix",lambda *a,**k:np.zeros((1,1)))
        monkeypatch.setattr(route,"query_reads_for_dafc",lambda c,a,b,**kw:seen.append((a,b)) or [])
        monkeypatch.setattr(route,"find_ligated_reads",lambda *a,**k:[])
        monkeypatch.setattr(route,"detect_contact_mode",lambda *a:SimpleNamespace(value="dafc"))
        url="/api/dafc/select?chrom=p&x_start=0&x_end=300000001&y_start=0&y_end=1&start=0&end=1"
    else:
        import routers.microc as route
        app.include_router(route.router)
        monkeypatch.setattr(route,"_load_cooler_module",lambda:object())
        monkeypatch.setattr(route,"_resolve_cooler_chrom",lambda s,c:c)
        monkeypatch.setattr(route,"cooler_at_resolution",lambda s,*a:(s,10))
        monkeypatch.setattr(route,"fetch_cooler_matrix",lambda *a,**k:seen.append(a[1:]) or np.zeros((1,1)))
        url="/api/microc/virtual4c?chrom=p&viewpoint_start=0&viewpoint_end=1&profile_start=0&profile_end=300000001&start=0&end=1"
    app.dependency_overrides[route.get_dafc_state]=lambda:contact
    install_public_request_limits(app,lambda:True)
    wrapped=PublicProtection(app,lambda:True,route_app=app,limits=lambda:PublicLimits(heavy_concurrent=1))
    with TestClient(wrapped) as client:
        response=client.get(url)
    assert response.status_code==413 and not seen,(response.status_code,response.json(),seen)


@pytest.mark.parametrize("representation", [
    {"start": 0, "end": 2000000},
    {"region_start": 0, "region_end": 2000000},
    {"start": 0, "end": 10, "region_start": 0, "region_end": 2000000},
    {"region": "chr1:0-2,000,000"},
    {"region": ["chr1", 0, 2000000]},
    {"nested": {"start": 0, "end": 2000000}},
    {"x_start": 0, "x_end": 2000000, "y_start": 0, "y_end": 1},
    {"focus_start": 0, "focus_end": 2000000},
])
def test_public_span_representations(representation):
    assert limit_body("/api/footprint/analyze", representation, PublicLimits())[1]


def test_overflowing_json_integers_are_refused_as_malformed():
    refusal = limit_body("/api/footprint/consensus/jobs", {"start": 0, "end": 10**400}, PublicLimits())[1]
    assert refusal and refusal.status == 400
    from services.public_limits import limit_query
    refusal = limit_query("/api/reads/compact", [("start", "0"), ("end", "1" + "0" * 400)], PublicLimits())[1]
    assert refusal and refusal.status == 400


# --- redaction keeps URLs -----------------------------------------------------------------

@pytest.mark.parametrize("public",[True,False])
def test_public_redaction_keeps_url_and_local_mode_keeps_paths(monkeypatch,public):
    from services import public_redaction as pr
    from services import catalog_endpoint as ce
    ce.set_catalog({"groups":[]},base_dir="/data")
    monkeypatch.setattr(pr,"_prefix_cache",(None,()))
    app=FastAPI()
    original={"url":"https://example.org/data/reads.bam","path":"/data/reads.bam"}
    @app.get("/api/catalog")
    async def catalog():return original
    pr.install_public_redaction(app,lambda:public)
    with TestClient(app) as client:
        result=client.get("/api/catalog").json()
    assert result["url"]==original["url"],result
    assert result["path"]==("reads.bam" if public else original["path"])


def test_remote_urls_survive_host_path_redaction(monkeypatch):
    from services import public_redaction as pr
    monkeypatch.setattr(pr, "host_path_prefixes", lambda: (b"/data/",))
    original = {"url": "https://example.org/data/reads.bam", "s3": "s3://bucket/data/x.bb",
                "ssh": "ssh://cluster/data/x.bam", "query": "https://h/x?file=/data/x.bam",
                "path": "/data/reads.bam", "message": "BAM file not found: /data/k562/x.bam",
                "nested": "/srv/data/x.bam"}
    actual = json.loads(pr.strip_host_prefixes(json.dumps(original).encode()))
    assert actual["path"] == "reads.bam" and actual["message"] == "BAM file not found: k562/x.bam"
    for key in ("url", "s3", "ssh", "query", "nested"):
        assert actual[key] == original[key], key


def test_slots_repeated_cancellation_handoff():
    from services.public_protection import Slots

    async def check():
        slots = Slots(1)
        for i in range(200):
            await slots.acquire("holder", 3, 1, "busy", "mine")
            a = asyncio.create_task(slots.acquire("a", 3, 1, "busy", "mine"))
            b = asyncio.create_task(slots.acquire("b", 3, 1, "busy", "mine"))
            await asyncio.sleep(0)
            if i % 2:
                slots.release("holder")
            a.cancel()
            try:
                await a
                slots.release("a")
            except asyncio.CancelledError:
                pass
            if not i % 2:
                slots.release("holder")
            await b
            slots.release("b")
        assert slots.running == 0 and not slots.waiters and not slots.per_client
    asyncio.run(check())
