"""Render-worker log location, unique OpenAPI operation ids, JSON-body routes (audit section 4 / LOW)."""
import warnings
from pathlib import Path

import pytest


def test_render_worker_logs_outside_the_install_tree():
    import services.playwright_render as pr
    repo = Path(pr.REPO_ROOT).resolve()
    log_dir = Path(pr.WORKER_LOG_DIR).resolve()
    assert repo not in log_dir.parents and log_dir != repo / "logs"
    assert log_dir == (Path.home() / ".fiberhmm" / "logs").resolve() or "FIBERBROWSER_LOG_DIR" in __import__("os").environ


def test_openapi_has_no_duplicate_operation_ids(client):
    with warnings.catch_warnings():
        warnings.simplefilter("error")  # FastAPI warns "Duplicate Operation ID"
        schema = client.app.openapi() if client.app.openapi_schema is None else client.app.openapi_schema
    ids = [op.get("operationId") for path in schema["paths"].values() for op in path.values()
           if isinstance(op, dict) and op.get("operationId")]
    assert len(ids) == len(set(ids))
    assert client.get("/api/cancel_shutdown").status_code == 200
    assert client.post("/api/cancel_shutdown").status_code == 200


@pytest.mark.parametrize("path", ["/api/quality_filters", "/api/legacy_layer_inference", "/api/overlays/add"])
@pytest.mark.parametrize("body", [b"", b"not json", b"[1, 2]"])
def test_raw_json_routes_answer_422_not_500(client, path, body):
    resp = client.post(path, content=body, headers={"Content-Type": "application/json"})
    assert resp.status_code == 422, resp.text


def test_raw_json_routes_still_accept_objects(client):
    resp = client.post("/api/quality_filters", json={"filters": []})
    assert resp.status_code == 200


def test_the_app_is_called_fiberbrowser(client):
    """The page and API carry the product name (they still said "Fiber-seq Browser")."""
    assert client.app.title == "FiberBrowser API"
    index = Path(__file__).resolve().parents[1] / "browser" / "frontend" / "index.html"
    assert "<title>FiberBrowser</title>" in index.read_text()
