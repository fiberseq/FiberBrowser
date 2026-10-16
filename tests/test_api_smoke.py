"""Smoke tests: hit every registered API route and verify the server doesn't crash.

These tests run the app in standalone mode (no BAM/BigBed data) so most data
endpoints will return empty results or 4xx errors — that's fine. The goal is to
verify that:
  1. The app starts up without import errors
  2. Every route is reachable (no 500 Internal Server Error)
  3. Refactoring doesn't break endpoint registration

Run with: pytest tests/test_api_smoke.py -v
"""

import pytest

# Routes that open OS file dialogs or spawn processes — skip in automated tests
SKIP_ROUTES = {
    "/api/pick_folder",
    "/api/pick_file",
    "/api/pick_file_primer",
    "/api/new-window",
    "/api/s3/test",          # tries to connect to AWS
    "/api/s3/list",          # tries to connect to AWS
    "/api/s3/presign",       # tries to connect to AWS
    "/api/chipatlas/status",  # external HTTP call
    "/api/chipatlas/facets",  # external HTTP call
    "/api/chipatlas/search",  # external HTTP call
}


# ── Infrastructure ──────────────────────────────────────────────────────────

def test_app_creates(standalone_app):
    """App object exists and has routes registered."""
    assert standalone_app is not None
    from utils.routes import app_routes
    routes = [r.path for r in app_routes(standalone_app) if getattr(r, 'path', None)]
    assert len(routes) > 50, f"Expected 50+ routes, got {len(routes)}"


def test_state_initialized(standalone_app):
    """BrowserState is initialized in standalone mode."""
    import server as srv
    assert srv.state is not None
    assert hasattr(srv.state, 'chroms')
    assert hasattr(srv.state, 'datasets')


# ── GET endpoints that should work in standalone mode ───────────────────────

@pytest.mark.parametrize("path,expected_status", [
    ("/api/chroms", 200),
    ("/api/datasets", 200),
    ("/api/status", 200),
    ("/api/genomes", 200),
    ("/api/cache/status", 200),
    ("/api/overlays", 200),
    ("/api/primers", 200),
    ("/api/s3/status", 200),
])
def test_get_endpoints_ok(client, path, expected_status):
    """GET endpoints that should return 200 in standalone mode."""
    resp = client.get(path)
    assert resp.status_code == expected_status, f"{path} returned {resp.status_code}: {resp.text[:200]}"


@pytest.mark.parametrize("path", [
    "/api/reads/compact",
    "/api/reads/compact_all",
    "/api/reads/image",
    "/api/reads/info",
    "/api/meta",
    "/api/meta_all",
    "/api/genes",
    "/api/fire",
    "/api/gene_search",
    "/api/sequence",
    "/api/working_set_info",
    "/api/tracks",
    "/api/dafc/status",
    "/api/jupyter/region",
    "/api/jupyter/clusters",
    "/api/jupyter/reads",
    "/api/jupyter/order",
    "/api/jupyter/filter",
    "/api/jupyter/highlights",
    "/api/jupyter/selection",
    "/api/jupyter/state",
    "/api/jupyter/markers",
    "/api/jupyter/footprint_colors",
    "/api/jupyter/peaks",
    "/api/jupyter/settings",
    "/api/diagnose_bam",
    "/api/primer_config",
])
def test_get_endpoints_no_crash(client, path):
    """GET endpoints should not return 500 (may return 4xx without data)."""
    resp = client.get(path)
    assert resp.status_code != 500, f"{path} returned 500: {resp.text[:300]}"


def test_diagnose_bam_uses_ordered_dataset_index(client, monkeypatch):
    """BAM diagnostics should resolve dataset_idx through dataset_order."""
    import server as srv
    from services import files_endpoint
    from models.domain import Dataset

    old_datasets = dict(srv.state.datasets)
    old_order = list(srv.state.dataset_order)
    try:
        srv.state.datasets.clear()
        srv.state.dataset_order.clear()
        srv.state.datasets["sample_a"] = Dataset("sample_a", "/tmp/sample_a.bam", "Sample A", data_type="bam")
        srv.state.dataset_order.append("sample_a")
        monkeypatch.setattr(
            files_endpoint,
            "diagnose_bam_tags",
            lambda bam_path, chrom=None, limit=10: {
                "path": bam_path,
                "has_nucleosomes": True,
                "has_msps": True,
                "chrom": chrom,
                "limit": limit,
            },
        )

        resp = client.get("/api/diagnose_bam?dataset_idx=0&chrom=chr2R&limit=5")

        assert resp.status_code == 200
        assert resp.json()["path"] == "/tmp/sample_a.bam"
        assert resp.json()["chrom"] == "chr2R"
        assert resp.json()["limit"] == 5
    finally:
        srv.state.datasets.clear()
        srv.state.datasets.update(old_datasets)
        srv.state.dataset_order[:] = old_order


def test_scan_peaks_is_quiet_by_default(client, capsys, monkeypatch):
    monkeypatch.delenv("FIBERBROWSER_CLUSTER_DIAGNOSTICS", raising=False)

    resp = client.post("/api/scan_peaks?chrom=chr1&start=0&end=100", json={})

    assert resp.status_code == 200
    assert resp.json()["peaks"] == []
    assert capsys.readouterr().out == ""


def test_cluster_all_is_quiet_by_default(client, capsys, monkeypatch):
    monkeypatch.delenv("FIBERBROWSER_CLUSTER_DIAGNOSTICS", raising=False)

    resp = client.post("/api/cluster_all?chrom=chr1&start=0&end=100&spanning=false", json={})

    assert resp.status_code == 200
    assert resp.json()["results"] == {}
    assert capsys.readouterr().out == ""


# ── POST endpoints with minimal payloads ────────────────────────────────────

@pytest.mark.parametrize("path,payload", [
    ("/api/clear_cache", {}),
    ("/api/jupyter/refresh", {}),
    ("/api/jupyter/peak_rules", {"rules": []}),
    ("/api/jupyter/settings/sync", {}),
    ("/api/jupyter/highlights", {"chrom": "chr1", "start": 0, "end": 1000}),
    ("/api/jupyter/selection", {"chrom": "chr1", "start": 0, "end": 1000}),
])
def test_post_endpoints_no_crash(client, path, payload):
    """POST endpoints should not return 500."""
    resp = client.post(path, json=payload)
    assert resp.status_code != 500, f"{path} returned 500: {resp.text[:300]}"


# ── Session management ──────────────────────────────────────────────────────

def test_session_export(client):
    """Session export returns valid JSON when given minimal payload."""
    resp = client.post("/api/session/export", json={
        "chrom": "chr1", "start": 0, "end": 10000
    })
    # May return 422 if model expects more fields — that's fine, just not 500
    assert resp.status_code != 500, f"Session export returned 500: {resp.text[:300]}"


# ── Route enumeration regression test ───────────────────────────────────────

def test_all_api_routes_reachable(standalone_app, client):
    """Every /api/* GET route (without path params) should respond (not 500)."""
    from utils.routes import app_routes
    api_routes = []
    for route in app_routes(standalone_app):
        if (route.path or "").startswith("/api/"):
            if "{" not in route.path and "GET" in (route.methods or set()):
                if route.path not in SKIP_ROUTES:
                    api_routes.append(route.path)

    failures = []
    for path in api_routes:
        resp = client.get(path)
        if resp.status_code == 500:
            failures.append(f"{path}: 500 - {resp.text[:100]}")

    assert not failures, f"Routes returned 500:\n" + "\n".join(failures)


def test_route_count_regression(standalone_app):
    """Verify we haven't accidentally dropped a large number of routes."""
    from utils.routes import app_routes
    api_routes = [r for r in app_routes(standalone_app)
                  if (getattr(r, "path", None) or "").startswith("/api/")]
    # As of pre-refactor: ~155 endpoints. Allow some margin.
    assert len(api_routes) >= 100, (
        f"Expected 100+ API routes but found {len(api_routes)}. "
        "Endpoints may have been lost during refactoring."
    )
