"""Public mode hides host paths and every response carries security headers (audit section 2)."""
from __future__ import annotations

from pathlib import Path

import pytest

DEMO_BAM = Path(__file__).resolve().parents[1] / "browser" / "data" / "demo" / "napa_ddda.bam"
HOST_DIR = str(DEMO_BAM.parent)


@pytest.fixture
def loaded(standalone_app):
    import server as srv
    from state.browser_state import BrowserState
    from state.runtime_state import set_browser_state
    previous = srv.state
    state = BrowserState(None, None, None, None)
    state.add_dataset("demo", str(DEMO_BAM), "demo")
    state.orthogonal_tracks.append({"path": str(DEMO_BAM.parent / "signal.bw"), "label": "signal",
                                    "format": "bigwig"})
    srv.state = state
    set_browser_state(state)
    yield state
    srv.state = previous
    set_browser_state(previous)


@pytest.fixture
def public(monkeypatch):
    from services import runtime
    monkeypatch.setattr(runtime, "_public_mode", True)


def test_public_responses_carry_file_names_not_host_paths(client, loaded, public):
    datasets = client.get("/api/datasets")
    assert datasets.status_code == 200
    assert HOST_DIR not in datasets.text
    entry = datasets.json()["datasets"][0]
    assert entry["path"] == "napa_ddda.bam" and entry["paths"] == ["napa_ddda.bam"]
    tracks = client.get("/api/tracks")
    assert HOST_DIR not in tracks.text and "signal.bw" in tracks.text
    session = client.post("/api/session/export", json={})
    assert session.status_code == 200 and HOST_DIR not in session.text
    assert "napa_ddda.bam" in session.text


def test_local_mode_keeps_full_paths(client, loaded):
    entry = client.get("/api/datasets").json()["datasets"][0]
    assert entry["path"] == str(DEMO_BAM)


def test_redaction_rules():
    from services.public_redaction import redact_paths
    payload = {
        "path": "/srv/lab/a.bam", "paths": ["/srv/lab/a.bam", "https://host/b.bam", "s3://bucket/c.bam"],
        "files": [{"path": "C:\\data\\d.bam"}], "fasta_path": "~/genomes/hg38.fa",
        "message": "Loaded 1 dataset (1 failed: /srv/lab/private/x.bam: not found)",
        "label": "a/b ratio", "file_fingerprints": {"/srv/lab/a.bam": {"size": 1}},
    }
    out = redact_paths(payload)
    assert out["path"] == "a.bam"
    assert out["paths"] == ["a.bam", "https://host/b.bam", "s3://bucket/c.bam"]
    assert out["files"] == [{"path": "d.bam"}] and out["fasta_path"] == "hg38.fa"
    assert "/srv/lab" not in out["message"] and "x.bam" in out["message"]
    assert out["label"] == "a/b ratio"  # not a path field
    assert out["file_fingerprints"] == {"a.bam": {"size": 1}}


def test_security_headers_public(client, public):
    ok = client.get("/api/status")
    denied = client.get("/api/files/list")
    for resp in (ok, denied):
        assert resp.headers["x-content-type-options"] == "nosniff"
        assert resp.headers["x-frame-options"] == "DENY"
        assert "frame-ancestors 'none'" in resp.headers["content-security-policy"]
        assert resp.headers["referrer-policy"] == "same-origin"
    assert denied.status_code == 403


def test_security_headers_local(client):
    resp = client.get("/api/status")
    assert resp.headers["x-content-type-options"] == "nosniff"
    assert resp.headers["content-security-policy"] == "frame-ancestors 'self'"
    assert "x-frame-options" not in resp.headers
    refused = client.get("/api/status", headers={"Origin": "https://evil.example"})
    assert refused.status_code == 403 and refused.headers["x-content-type-options"] == "nosniff"
