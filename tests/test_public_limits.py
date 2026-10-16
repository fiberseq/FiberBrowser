"""--public: anonymous visitors can't choose the compute budget or load unbounded reads (audit F9)."""
from __future__ import annotations

from concurrent.futures import Future
from types import SimpleNamespace

import pytest


@pytest.fixture
def public(monkeypatch):
    from services import public_limits, runtime
    monkeypatch.setattr(runtime, "_public_mode", True)
    public_limits.reset_public_limits()
    monkeypatch.setattr(public_limits, "_active_jobs", [])
    yield public_limits
    public_limits.reset_public_limits()


def test_public_consensus_jobs_run_with_server_caps(client, public, monkeypatch):
    import services.consensus_workflow as cw
    seen = {}
    monkeypatch.setattr(cw, "submit", lambda state, request: seen.setdefault("request", request) and {"job_id": "j"})
    resp = client.post("/api/footprint/consensus/jobs", json={
        "dataset_ids": ["ft"], "chrom": "chr1", "start": 0, "end": 40_000,  # a 9 Mb window is now refused up front
        "parameters": {"cr": {"engine": "lattice_recaller"},
                       "compute": {"cores": 128, "maximum_region_bp": 10_000_000, "maximum_matrix_mb": 262144,
                                   "neighborhood_seconds": 86400, "predictive_backend": "cuda"}}})
    assert resp.status_code == 200
    params = seen["request"]["parameters"]
    assert params["cr"] == {"engine": "lattice_recaller"}  # science settings stay the visitor's
    compute = params["compute"]
    limits = public.get_public_limits()
    assert compute["cores"] == limits.consensus_cores <= 2
    assert compute["maximum_region_bp"] == 50_000
    assert compute["maximum_matrix_mb"] == 1_024
    assert compute["neighborhood_seconds"] == 60
    assert compute["predictive_backend"] == compute["fit_backend"] == "cpu"


def test_public_consensus_queue_is_bounded(client, public, monkeypatch):
    import services.consensus_workflow as cw
    monkeypatch.setattr(cw, "submit", lambda state, request: {"job_id": "j"})
    for _ in range(public.get_public_limits().consensus_queue):
        public.track_consensus_job(Future())  # queued or running elsewhere
    resp = client.post("/api/footprint/consensus/jobs", json={"parameters": {}})
    assert resp.status_code == 429
    for future in list(public._active_jobs):
        future.set_result(None)
    assert client.post("/api/footprint/consensus/jobs", json={"parameters": {}}).status_code == 200


def test_local_servers_keep_the_clients_compute(client, monkeypatch):
    import services.consensus_workflow as cw
    seen = {}
    monkeypatch.setattr(cw, "submit", lambda state, request: seen.setdefault("request", request) and {"job_id": "j"})
    client.post("/api/footprint/consensus/jobs", json={"parameters": {"compute": {"cores": 12}}})
    assert seen["request"]["parameters"]["compute"] == {"cores": 12}


def test_public_read_windows_are_bounded(client, public, monkeypatch):
    import routers.reads as reads
    seen = {}

    def fake_payload(**kwargs):
        seen.update(kwargs)
        return {"reads": []}

    monkeypatch.setattr(reads, "compact_reads_payload_for_request", fake_payload)
    too_big = client.get("/api/reads/compact", params={"chrom": "chr1", "start": 0, "end": 50_000_000})
    assert too_big.status_code == 413 and "Zoom in" in too_big.json()["message"]
    ok = client.get("/api/reads/compact", params={"chrom": "chr1", "start": 0, "end": 20_000,
                                                  "max_reads": 1_000_000, "profile_max_reads": 0})
    assert ok.status_code == 200
    assert seen["max_reads"] == 2_000 and seen["profile_max_reads"] == 2_000
    assert client.post("/api/cluster_all?chrom=chr1&start=0&end=90000000", json={}).status_code == 413
    assert client.get("/api/coacc/matrix/data?chrom=chr1&start=0&end=90000000").status_code == 413


def test_local_read_windows_are_not_limited(client, monkeypatch):
    import routers.reads as reads
    seen = {}
    monkeypatch.setattr(reads, "compact_reads_payload_for_request", lambda **kw: seen.update(kw) or {"reads": []})
    resp = client.get("/api/reads/compact", params={"chrom": "chr1", "start": 0, "end": 50_000_000,
                                                    "max_reads": 1_000_000})
    assert resp.status_code == 200 and seen["max_reads"] == 1_000_000


def test_genome_overview_coverage_stays_available_with_capped_bins(public):
    limits = public.get_public_limits()
    query, refusal = public.limit_query("/api/coverage", [("chrom", "chr1"), ("start", "0"),
                                                          ("end", "248956422"), ("bins", "100000")], limits)
    assert refusal is None and dict(query)["bins"] == "2000"
    _, refusal = public.limit_query("/api/coverage", [("start", "0"), ("end", str(10**9))], limits)
    assert refusal


def test_limited_routes_exist(standalone_app):
    from services.public_limits import COVERAGE_ROUTES, SPAN_LIMITED_ROUTES
    from services.public_mode_guard import PUBLIC_ALLOWED, iter_route_entries
    templates = {entry.path for entry in iter_route_entries(standalone_app)}
    assert not (SPAN_LIMITED_ROUTES | COVERAGE_ROUTES) - templates
    allowed = {path for _method, path in PUBLIC_ALLOWED}
    assert not (SPAN_LIMITED_ROUTES | COVERAGE_ROUTES) - allowed


def test_public_implies_a_working_set_cap_and_flags_configure_limits(public, monkeypatch):
    from services.cli_args import parse_browser_args
    args = parse_browser_args(["--public", "--public-max-span-bp", "250000", "--public-consensus-cores", "1"])
    limits = public.apply_public_cli(args)
    assert args.max_working_reads == 20_000
    assert limits.max_span_bp == 250_000 and limits.consensus_cores == 1
    args = parse_browser_args(["--public", "--max-working-reads", "500"])
    public.apply_public_cli(args)
    assert args.max_working_reads == 500
    monkeypatch.setenv("FIBERBROWSER_PUBLIC_MAX_READS", "300")
    assert public.configure_public_limits().max_reads == 300
