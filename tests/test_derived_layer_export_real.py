"""Derived-layer export through the real route on the tracked demo BAM (nothing patched).

test_footprint_analysis.py::test_derived_layer_export_route_materializes_and_registers_bigbed
patches both the materialisation and the registration. Here the route writes a real bundle
from the demo reads; where bedToBigBed is installed it must also write the BigBed and
register it on the dataset, and the reloaded layer must carry the exported rows.
"""
from __future__ import annotations

import json
import shutil

import pytest

import contextlib
from pathlib import Path

DEMO_BAM = Path(__file__).resolve().parents[1] / "browser" / "data" / "demo" / "napa_ddda.bam"


@contextlib.contextmanager
def state_client(app, datasets: dict[str, str]):
    """A TestClient whose main state holds ``datasets`` ({id: BAM path}); restored afterwards (dev realpath_helpers)."""
    import server as srv
    from starlette.testclient import TestClient
    from conftest import auth_headers
    from plugins import init_context
    from state import runtime_state
    from state.browser_state import BrowserState
    from state.runtime_state import set_browser_state

    previous = srv.state
    previous_runtime = runtime_state._state
    state = BrowserState(None, None, None, None)
    for dataset_id, path in datasets.items():
        state.add_dataset(dataset_id, str(path), dataset_id)
    srv.state = state
    set_browser_state(state)
    init_context(state)
    try:
        yield TestClient(app, headers=auth_headers()), state
    finally:
        srv.state = previous
        set_browser_state(previous_runtime)
        init_context(previous)


pytestmark = pytest.mark.skipif(not DEMO_BAM.exists(), reason="tracked demo BAM browser/data/demo/napa_ddda.bam missing")
PARAMS = dict(chrom="chr19", region_start=47515000, region_end=47517000, spanning="false")


def _export(client, out):
    return client.post("/api/footprint/derived_layers/export", params=PARAMS, json={
        "dataset_ids": ["demo"], "output_dir": str(out), "bundle_name": "cart", "sample_seed": "s",
        "groups": [{"id": "g1", "name": "Nucleosomes", "layer": "nuc", "enabled": True},
                   {"id": "g2", "name": "Off", "layer": "tf", "enabled": False}]})


def test_export_writes_a_real_bundle_from_the_demo_reads(standalone_app, tmp_path):
    with state_client(standalone_app, {"demo": str(DEMO_BAM)}) as (client, state):
        response = _export(client, tmp_path)
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["success"] is True, body
        (bundle,) = body["bundles"]
        assert bundle["dataset_id"] == "demo" and bundle["n_rows"] > 100 and bundle["n_intervals"] >= bundle["n_rows"]
        assert [c["label"] for c in bundle["classes"]] == ["Nucleosomes"]  # the disabled entry is left out
        class_id = bundle["classes"][0]["id"]

        rows = [line.split("\t") for line in open(bundle["bed_path"]).read().splitlines() if line.strip()]
        assert len(rows) == bundle["n_rows"]
        read_ids = {r["id"] for r in state.build_working_set("demo", "chr19", 47515000, 47517000).reads}
        for fields in rows:
            assert fields[0] == "chr19" and len(fields) == 16
            assert fields[3] in read_ids and fields[12] == class_id and fields[13] == "nuc"
            start, end, count = int(fields[1]), int(fields[2]), int(fields[9])
            sizes = [int(x) for x in fields[10].rstrip(",").split(",")]
            starts = [int(x) for x in fields[11].rstrip(",").split(",")]
            assert count == len(sizes) == len(starts) and starts[0] == 0 and start + starts[-1] + sizes[-1] == end
        manifest = json.loads(open(bundle["manifest_path"]).read())
        assert manifest["schema"] == "fiberlayers.v1" and class_id in json.dumps(manifest["classes"])


@pytest.mark.skipif(shutil.which("bedToBigBed") is None, reason="bedToBigBed (UCSC) is not installed: BigBed step not testable")
def test_export_writes_and_registers_the_bigbed(standalone_app, tmp_path):
    import pyBigWig
    with state_client(standalone_app, {"demo": str(DEMO_BAM)}) as (client, state):
        body = _export(client, tmp_path).json()
        (bundle,) = body["bundles"]
        assert not bundle["warnings"], bundle["warnings"]
        assert bundle["bigbed_path"], bundle
        bb = pyBigWig.open(bundle["bigbed_path"])
        try:
            assert bb.isBigBed()
            entries = bb.entries("chr19", 47515000, 47517000) or []
        finally:
            bb.close()
        assert len(entries) == bundle["n_rows"]
        class_id = bundle["classes"][0]["id"]
        layers = state.datasets["demo"].derived_layers or {}
        assert class_id in layers, layers
        assert any(v == bundle["bigbed_path"] for v in json.loads(json.dumps(layers[class_id])).values())
        listed = next(d for d in body["datasets"] if d["id"] == "demo")
        assert class_id in json.dumps(listed.get("derived_layers"))
