"""A lifted dataset names its source sample and target reference (labels such as "Open in <sample> view"), and
``GET /api/lift/datasets`` lists lifted datasets, narrowed by ``dataset_id`` (graph follow-ups items 3 and 5)."""
import json

import pytest

from live_lift_fixtures import MAT, PAT, make_record, write_bam, write_toy_sidecar
from services.lift import live_lift as ll
from services.lift.dataset import source_sample, target_reference


def _records(h):
    return [make_record(h, "plus", MAT, 2500, "300M"), make_record(h, "pat", PAT, 500, "300M")]


def _renamed_sidecar(directory, sample="NA12878", reference="CHM13"):
    """The toy sidecar with PanSN haplotypes of another sample (``NA12878#1``/``#2``) and a named target path."""
    path = write_toy_sidecar(directory)
    with open(path) as fh:
        m = json.load(fh)
    rename = {"H#1": f"{sample}#1", "H#2": f"{sample}#2"}
    for chain in m["chains"]:
        chain["haplotype"] = rename[chain["haplotype"]]
    m["nets"] = {rename[k]: v for k, v in m["nets"].items()}
    for t in m["targets"]:
        t["path"] = f"{reference}#0#{t['name']}"
        t["haplotype"] = f"{reference}#0"
    with open(path, "w") as fh:
        json.dump(m, fh)
    return path


def test_sample_and_reference_names_from_pansn():
    assert source_sample(["NA12878#1", "NA12878#2"]) == "NA12878"
    assert source_sample(["strainA#0"]) == "strainA"
    assert source_sample(["HG002_MAT#1", "HG002_PAT#1"]) == "HG002"
    assert source_sample(["A#1", "B#1"]) is None and source_sample([]) is None
    assert target_reference({"targets": [{"name": "chr1", "haplotype": "CHM13#0"}, {"name": "chr2", "path": "CHM13#0#chr2"}]}) == "CHM13"
    assert target_reference({"targets": [{"name": "chrT"}]}) is None


@pytest.fixture
def lift_env(tmp_path, monkeypatch):
    import server as srv
    from plugins import init_context
    from services.local_auth import auth_headers
    from starlette.testclient import TestClient

    monkeypatch.setenv("FIBERBROWSER_LIVE_LIFT", "1")
    ll.clear_selection_cache()
    ll.clear_primary_cache()
    old = srv.state
    srv.state = srv.BrowserState(None, None, None, None)
    init_context(srv.state)
    client = TestClient(srv.app, headers=auth_headers())
    try:
        yield client, tmp_path
    finally:
        srv.state = old
        init_context(old)


def test_lifted_dataset_names_its_sample_and_the_list_filters_by_id(lift_env):
    client, tmp = lift_env
    manifest = _renamed_sidecar(tmp / "map")
    bam = write_bam(tmp / "src.bam", _records)
    out = client.post("/api/lift/datasets", json={"paths": [bam], "manifest": manifest}).json()
    assert out["success"], out
    lifted = out["dataset"]
    assert lifted["live_lift"]["source_sample"] == "NA12878"
    assert lifted["live_lift"]["target_reference"] == "CHM13"
    # A second lifted dataset (the toy map: sample "H", no named target path).
    toy = client.post("/api/lift/datasets", json={"paths": [bam], "manifest": write_toy_sidecar(tmp / "toy"), "label": "toy"}).json()
    assert toy["success"], toy
    assert toy["dataset"]["live_lift"]["source_sample"] == "H" and toy["dataset"]["live_lift"]["target_reference"] is None

    every = client.get("/api/lift/datasets").json()["datasets"]
    assert [d["id"] for d in every] == [lifted["id"], toy["dataset"]["id"]]
    one = client.get("/api/lift/datasets", params={"dataset_id": toy["dataset"]["id"]}).json()["datasets"]
    assert [d["id"] for d in one] == [toy["dataset"]["id"]] and one[0]["live_lift"]["source_sample"] == "H"
    assert client.get("/api/lift/datasets", params={"dataset_id": "missing"}).status_code == 404


def test_listing_is_hidden_with_the_flag_off(lift_env, monkeypatch):
    client, _tmp = lift_env
    monkeypatch.delenv("FIBERBROWSER_LIVE_LIFT")
    assert client.get("/api/lift/datasets").status_code == 404
