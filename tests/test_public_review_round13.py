"""Regressions from the round-13 review of the public server (Codex, 30 Sep;
round13/scratch/test_round13_review.py)."""
from __future__ import annotations

from types import SimpleNamespace

import numpy as np
import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient


def _cluster_app(monkeypatch, limits, reads, assignments):
    import routers.clustering_visualization as cv
    from services import public_limits as pl
    from services import runtime
    from services.public_protection import PublicProtection
    monkeypatch.setattr(pl, "get_public_limits", lambda: limits)
    monkeypatch.setattr(runtime, "_public_mode", True)
    dataset = SimpleNamespace(cluster_assignments=assignments)
    state = SimpleNamespace(get_dataset=lambda _: dataset)
    query = SimpleNamespace(dataset_ids=["d"], sample_seed="s",
                            build_working_set=lambda *_: SimpleNamespace(reads=reads, start=0))
    monkeypatch.setattr(cv.AnalysisReadQuery, "from_request", lambda *a, **k: query)
    allocated = []
    original = np.zeros

    def zeros(shape, *a, **kw):
        if shape == (10, 10):
            allocated.append(100)
        return original(shape, *a, **kw)
    monkeypatch.setattr(cv.np, "zeros", zeros)
    app = FastAPI()
    app.include_router(cv.router)
    app.dependency_overrides[cv.get_state] = lambda: state
    return PublicProtection(app, lambda: True, route_app=app, limits=lambda: limits), allocated


BODY = {"size_min": 0, "size_max": 100, "size_bin": 10, "pos_bin": 10, "smooth": 0, "log_norm": False}
URL = "/api/cluster/vplot?chrom=p&region_start=0&region_end=100"


def test_cluster_budget_counts_all_retained_matrices(monkeypatch):
    """Stored assignments: eight 100-cell matrices past a 100-cell budget."""
    from services.public_limits import PublicLimits
    limits = PublicLimits(heavy_concurrent=1, max_vplot_cells=100)
    reads = [{"id": str(i), "intervals": [[0, 10, 10]]} for i in range(8)]
    wrapped, allocated = _cluster_app(monkeypatch, limits, reads, {r["id"]: i for i, r in enumerate(reads)})
    with TestClient(wrapped) as client:
        resp = client.post(URL, json=BODY)
    assert resp.status_code == 413 and sum(allocated) <= limits.max_vplot_cells


def test_cluster_count_is_capped_per_dataset(monkeypatch):
    from services.public_limits import PublicLimits
    limits = PublicLimits(heavy_concurrent=1, max_clusters=3)
    reads = [{"id": str(i), "intervals": [[0, 10, 10]]} for i in range(5)]
    wrapped, allocated = _cluster_app(monkeypatch, limits, reads, {r["id"]: i for i, r in enumerate(reads)})
    with TestClient(wrapped) as client:
        assert client.post(URL, json=BODY).status_code == 413
        # Assignments sent with the request count too (those of reads in view).
        overrides = {"d": {str(i): i for i in range(5)}}
        assert client.post(URL, json={**BODY, "cluster_assignments": overrides}).status_code == 413
    assert not allocated


def test_a_few_clusters_are_still_drawn(monkeypatch):
    from services.public_limits import PublicLimits
    limits = PublicLimits(heavy_concurrent=1)
    reads = [{"id": str(i), "intervals": [[0, 10, 10]]} for i in range(6)]
    wrapped, allocated = _cluster_app(monkeypatch, limits, reads, {r["id"]: i % 3 for i, r in enumerate(reads)})
    with TestClient(wrapped) as client:
        resp = client.post(URL, json=BODY)
    assert resp.status_code == 200 and len(resp.json()["data"]["d"]) == 3 and len(allocated) == 3


def test_off_viewport_assignments_are_not_counted(monkeypatch):
    """Round 17: assignments for reads outside the view draw no matrix, so
    they don't count (one visible read in cluster 0, one elsewhere in cluster 1)."""
    from services.public_limits import PublicLimits, limit_body
    limits = PublicLimits(heavy_concurrent=1, max_vplot_cells=100)
    overrides = {"d": {"visible": 0, "elsewhere": 1}}
    assert limit_body("/api/cluster/vplot", {**BODY, "cluster_assignments": overrides},
                      limits, positions=100) == (None, None)
    reads = [{"id": "visible", "intervals": [[0, 10, 10]]}]
    wrapped, allocated = _cluster_app(monkeypatch, limits, reads, {})
    with TestClient(wrapped) as client:
        resp = client.post(URL, json={**BODY, "cluster_assignments": overrides})
    assert resp.status_code == 200 and list(resp.json()["data"]["d"]) == ["0"] and sum(allocated) == 100


@pytest.mark.parametrize("flags", [
    {"include_vplot": False}, {"include_read_analysis": False}, {"include_vplot": "false"},
    # Round 17: every false value the request model accepts.
    {"include_vplot": 0}, {"include_vplot": "0"}, {"include_vplot": "f"}, {"include_vplot": "n"},
    {"include_vplot": "no"}, {"include_vplot": "off"}, {"include_read_analysis": "F"},
    {"include_read_analysis": "N"}, {"include_read_analysis": 0.0},
])
def test_disabled_vplot_is_not_refused(flags):
    from services.public_limits import PublicLimits, limit_body
    body = {**flags, "profile_window": 50, "vplot_size_min": 0, "vplot_size_max": 2000,
            "vplot_size_bin": 1, "vplot_pos_bin": 1}
    assert limit_body("/api/footprint/analyze", body, PublicLimits(max_vplot_cells=100), positions=1)[1] is None
    enabled = {k: v for k, v in body.items() if k not in flags}
    assert limit_body("/api/footprint/analyze", enabled, PublicLimits(max_vplot_cells=100), positions=1)[1]


def test_long_integer_query_is_a_400(monkeypatch):
    from services import public_limits as pl
    limits = pl.PublicLimits()
    monkeypatch.setattr(pl, "get_public_limits", lambda: limits)
    app = FastAPI()

    @app.get("/api/reads/compact")
    async def reads():
        return {"success": True}
    pl.install_public_request_limits(app, lambda: True)
    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.get("/api/reads/compact?start=0&end=" + ("1" * 5000))
        assert response.status_code == 400, (response.status_code, response.text)
        assert client.get("/api/reads/compact?start=0&end=" + ("1" * 5000) + ".5").status_code == 400
    assert pl.limit_body("/api/reads/compact", {"start": "0", "end": "9" * 5000}, limits)[1].status == 400
