"""Footprint-class HTTP round trip on the tracked NAPA demo BAM.

The consensus service layer has many unit tests; this drives the routes a user
reaches through the Footprints panel (browser/routers/footprint.py) end to end,
with the access token, on real DddA data: run the default engine (lattice
recaller) → poll → catalog → display filters → stage → reads of one class →
frozen export → tagged BAM export and reload → import of the frozen result.
"""
from __future__ import annotations

import gzip
import json
import time
from pathlib import Path

import pytest

from conftest import auth_headers

DEMO_BAM = Path(__file__).resolve().parents[1] / "browser" / "data" / "demo" / "napa_ddda.bam"
# One recaller tile (tile_bp=350) inside the demo reads: ~25 s on 2 cores, several classes.
REGION = dict(chrom="chr19", start=47515000, end=47515300)

pytestmark = [
    pytest.mark.slow,
    pytest.mark.skipif(not DEMO_BAM.exists(), reason="tracked demo BAM browser/data/demo/napa_ddda.bam missing"),
]


@pytest.fixture
def demo_client(standalone_app):
    """A TestClient on a fresh main state holding only the demo BAM (restored afterwards)."""
    import server as srv
    from starlette.testclient import TestClient
    from plugins import init_context
    from state import runtime_state
    from state.browser_state import BrowserState
    from state.runtime_state import set_browser_state

    previous = srv.state
    # The raw runtime singleton, not the getter's result: the getter falls back
    # to server.state when unset, and pinning that would leak into later tests.
    previous_runtime = runtime_state._state
    state = BrowserState(None, None, None, None)
    state.add_dataset("demo", str(DEMO_BAM), "demo")
    srv.state = state
    set_browser_state(state)
    init_context(state)
    try:
        yield TestClient(standalone_app, headers=auth_headers())
    finally:
        srv.state = previous
        set_browser_state(previous_runtime)
        init_context(previous)


def _wait(client, job_id, timeout_s=300):
    url = f"/api/footprint/consensus/jobs/{job_id}"
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        job = client.get(url).json()
        if job["status"] in ("complete", "failed", "cancelled", "error"):
            return job
        time.sleep(0.5)
    raise AssertionError(f"consensus job {job_id} did not finish in {timeout_s} s")


def test_default_engine_round_trip_through_the_http_routes(demo_client, tmp_path):
    c = demo_client
    # The request/route rejects an unauthenticated caller (the token is the default).
    from starlette.testclient import TestClient
    assert TestClient(c.app).post("/api/footprint/consensus/jobs", json={}).status_code in (401, 403)

    schema = c.get("/api/footprint/consensus/schema").json()
    assert schema["cr_mode"] == "lattice_recaller"

    submitted = c.post("/api/footprint/consensus/jobs", json=dict(
        dataset_ids=["demo"], **REGION, parameters=dict(compute=dict(cores=2))))
    assert submitted.status_code == 200, submitted.text
    job_id = submitted.json()["job_id"]
    # One run at a time per session.
    busy = c.post("/api/footprint/consensus/jobs", json=dict(dataset_ids=["demo"], **REGION))
    assert busy.status_code == 422 and "already running" in busy.json()["detail"]
    job = _wait(c, job_id)
    assert job["status"] == "complete", job.get("message")
    assert "tf_cr" in job["layers"]
    assert job["summary"]["demo"]["classes"] >= 2
    assert any(j["job_id"] == job_id for j in c.get("/api/footprint/consensus/jobs").json()["jobs"])

    # Catalog: the recaller's classes with per-strand prevalence tiers.
    catalog = c.get(f"/api/footprint/consensus/jobs/{job_id}/catalog").json()
    assert catalog["cr_mode"] == "lattice_recaller"
    assert catalog["region"]["chrom"] == REGION["chrom"]
    assert [s["id"] for s in catalog["stages"]] == [catalog["final_stage"]] == [catalog["view_stage"]]
    classes = catalog["datasets"]["demo"]["catalog"]
    assert len(classes) == job["summary"]["demo"]["classes"]
    first = classes[0]
    assert first["family"].startswith("class_")
    assert REGION["start"] - 100 <= first["consensus_start"] < first["consensus_end"] <= REGION["end"] + 100
    tiers = next(v for v in first["recaller"].values() if isinstance(v, dict) and "prevalence" in v)
    assert {"prevalence", "prevalence_edge", "prevalence_loose"} <= set(tiers)

    # Display filters: a valid change is kept, an unknown filter is refused.
    filters = c.post(f"/api/footprint/consensus/jobs/{job_id}/filters",
                     json=dict(recaller_class_tiers={first["family"]: "core+edge"}))
    assert filters.status_code == 200, filters.text
    assert c.get(f"/api/footprint/consensus/jobs/{job_id}").json()["filters"]["recaller_class_tiers"] == {
        first["family"]: "core+edge"}
    assert c.post(f"/api/footprint/consensus/jobs/{job_id}/filters", json=dict(nope=1)).status_code == 422
    c.post(f"/api/footprint/consensus/jobs/{job_id}/filters", json=dict(recaller_class_tiers={}))

    # Stage: the recaller has one; selecting it is accepted, a bad body is not.
    staged = c.post(f"/api/footprint/consensus/jobs/{job_id}/stage", json=dict(stage=catalog["final_stage"]))
    assert staged.status_code == 200, staged.text
    assert c.post(f"/api/footprint/consensus/jobs/{job_id}/stage", json=dict(stage=1)).status_code == 422

    # Reads of a class (what "Filter reads" on a saved class uses).
    members = {}
    for cls in classes:
        body = c.get(f"/api/footprint/consensus/jobs/{job_id}/state-reads",
                     params=dict(dataset_id="demo", family_id=cls["family"])).json()
        members[cls["family"]] = body["read_ids"]
    assert any(members.values())
    best = max(members, key=lambda k: len(members[k]))
    core = c.get(f"/api/footprint/consensus/jobs/{job_id}/state-reads",
                 params=dict(dataset_id="demo", family_id=best, tier="core")).json()["read_ids"]
    assert set(core) <= set(members[best])
    assert c.get(f"/api/footprint/consensus/jobs/{job_id}/state-reads",
                 params=dict(dataset_id="nope", family_id=best)).status_code in (404, 422)

    # Frozen export (gzipped JSON with the schema FiberBrowser checks).
    exported = c.get(f"/api/footprint/consensus/jobs/{job_id}/export")
    assert exported.status_code == 200
    frozen = json.loads(gzip.decompress(exported.content))
    assert frozen["schema"] == "fiberhmm.consensus.v1"
    assert [f["family"] for f in frozen["datasets"]["demo"]["cr"]["catalog"]] == [f["family"] for f in classes]

    # Tagged BAM export, then load it back as a dataset: the class tags are there.
    out = tmp_path / "bams"
    out.mkdir()
    receipt = c.post(f"/api/footprint/consensus/jobs/{job_id}/bam-export",
                     json=dict(output_dir=str(out), grouping="datasets", scope="regions"))
    assert receipt.status_code == 200, receipt.text
    outputs = receipt.json()["outputs"]
    assert len(outputs) == 1 and outputs[0]["annotations"] > 0 and Path(outputs[0]["bam"]).is_file()
    added = c.post("/api/datasets/add", json=dict(path=outputs[0]["bam"], label="Round trip classes"))
    assert added.status_code == 200 and added.json()["success"], added.text
    reloaded = c.get("/api/reads/compact", params=dict(**REGION, dataset_id=added.json()["dataset"]["id"],
                                                       spanning=False, include_layers=True))
    assert reloaded.status_code == 200 and reloaded.json()["reads"]
    assert "fhcr_" in reloaded.text

    # Import the frozen result: a new job with the same classes, recaller mode kept.
    imported = c.post("/api/footprint/consensus/import",
                      files=dict(file=("classes.json.gz", exported.content, "application/gzip")))
    assert imported.status_code == 200, imported.text
    restored = imported.json()["job_id"]
    assert restored != job_id
    again = c.get(f"/api/footprint/consensus/jobs/{restored}/catalog").json()
    assert again["cr_mode"] == "lattice_recaller"
    assert [f["family"] for f in again["datasets"]["demo"]["catalog"]] == [f["family"] for f in classes]
    assert c.post("/api/footprint/consensus/import",
                  files=dict(file=("bad.json.gz", b"not gzip", "application/gzip"))).status_code == 422
