"""The graph panel API with the real native helper (graphlift ``fiberbrowser-graph``) on prepared toy packages.

Skipped unless FIBERBROWSER_TEST_GRAPH_HELPER names the helper executable and
FIBERBROWSER_TEST_GRAPH_PACKAGES lists prepared packages (os.pathsep-separated)
of the graphlift toy graphs ``alu`` and ``flip`` (graphlift
tests/fixtures/graph/{alu,flip}.prepare.json). The Alu checks are DESIGN_GRAPH_PANEL.md
§4's regression: at target boundary 97,395 MAT inserts 2,353 bp and PAT 2,350 bp,
both between the same flank nodes 645 → 669.
"""
from __future__ import annotations

import os
import subprocess
import struct

import pytest

from services.graph_panel import service
from services.graph_panel.worker import LIVE_PIDS

HELPER = os.environ.get("FIBERBROWSER_TEST_GRAPH_HELPER", "").strip()
PACKAGES = [p for p in os.environ.get("FIBERBROWSER_TEST_GRAPH_PACKAGES", "").split(os.pathsep) if p.strip()]
pytestmark = pytest.mark.skipif(not (HELPER and os.path.isfile(HELPER) and PACKAGES),
                                reason="set FIBERBROWSER_TEST_GRAPH_HELPER and FIBERBROWSER_TEST_GRAPH_PACKAGES")


def package(name):
    found = [p for p in PACKAGES if os.path.basename(os.path.normpath(p)) == name]
    if not found:
        pytest.skip(f"no {name} package in FIBERBROWSER_TEST_GRAPH_PACKAGES")
    return found[0]


@pytest.fixture
def client(standalone_app, monkeypatch, tmp_path):
    from starlette.testclient import TestClient
    from conftest import auth_headers
    monkeypatch.setenv("FIBERBROWSER_GRAPH_HELPER", HELPER)
    monkeypatch.setenv("FIBERBROWSER_GRAPH_REGISTRY", str(tmp_path / "registry.json"))
    monkeypatch.delenv("FIBERBROWSER_GRAPH_PACKAGES", raising=False)
    service.reset_for_tests()
    with TestClient(standalone_app, headers=auth_headers()) as c:
        yield c
    assert not LIVE_PIDS
    service.reset_for_tests()


def register(client, name):
    r = client.post("/api/graph/registrations", json={"package": package(name)})
    assert r.status_code == 200, r.text
    return r.json()["registration"]


def query(client, reg, rid, start, end, selected=("target", "mat", "pat"), **extra):
    r = client.post("/api/graph/subgraph", json={
        "registration_id": reg["id"], "revisions": reg["revisions"], "request_id": rid, "panel_id": "p", "generation": 1,
        "target": "target", "interval": {"start": start, "end": end}, "selected": list(selected), **extra})
    return r


def test_real_helper_status_and_registration(client):
    status = client.get("/api/graph/status").json()["helper"]
    assert status["available"] and status["producer"].startswith("fiberbrowser-graph")
    assert status["limits"]["target_bp"] == 50_000 and status["limits"]["paths"] == 4
    reg = register(client, "alu")
    assert {b["key"] for b in reg["bindings"]} >= {"target", "mat", "pat"}
    assert all(len(v) == 64 for v in reg["revisions"].values())


def test_alu_insertion_is_one_boundary_with_both_alleles(client):
    reg = register(client, "alu")
    r = query(client, reg, "alu-1", 97_300, 97_500)
    assert r.status_code == 200, r.text
    result = r.json()["result"]
    assert result["complete"] is True and not result["summaries"]
    paths = {p["binding"]: p for p in result["paths"]}
    assert list(paths) == ["target", "mat", "pat"]
    for key, length, source in (("mat", 2353, (94_676, 97_029)), ("pat", 2350, (95_686, 98_036))):
        inserts = [c for c in paths[key]["plan"]["candidates"] if c["kind"] == "source_insertion"]
        assert len(inserts) == 1
        ins = inserts[0]
        assert ins["target"] == {"start": 97_395, "end": 97_395}
        assert (ins["source"]["start"], ins["source"]["end"]) == source
        assert ins["source"]["end"] - ins["source"]["start"] == length
    target_nodes = [o["node"] for o in paths["target"]["occurrences"]]
    assert target_nodes[:2] == ["645", "669"]
    for key in ("mat", "pat"):
        nodes = [o["node"] for o in paths[key]["occurrences"]]
        assert nodes[0] == "645" and "669" in nodes
    # Visit identities are strings and distinct.
    ids = [o["id"] for p in result["paths"] for o in p["occurrences"]]
    assert len(ids) == len(set(ids)) and all(isinstance(i, str) for i in ids)


def test_refusals_happen_before_the_helper(client):
    reg = register(client, "alu")
    r = query(client, reg, "big", 0, 100_000)
    assert r.status_code == 413 and r.json()["error"]["code"] == "selection_limit"
    stale = dict(reg, revisions={**reg["revisions"], "graph": "0" * 64})
    r = query(client, stale, "stale", 90_000, 100_000)
    assert r.status_code == 409 and r.json()["error"]["code"] == "stale_revision"


def test_flip_whole_minus_comparison_and_cache(client):
    reg = register(client, "flip")
    first = query(client, reg, "f1", 40_000, 50_000).json()
    assert first["status"] == "ok" and first["result"]["complete"] is True
    reverse = [m for m in first["result"]["direct_matches"] if m["reverse"]]
    assert reverse, "flip's alternates traverse the target in the opposite orientation"
    again = query(client, reg, "f2", 40_000, 50_000).json()
    assert again["cached"] is True and again["result"] == first["result"]


def test_two_packages_share_the_two_worker_slots(client):
    alu, flip = register(client, "alu"), register(client, "flip")
    for i in range(3):
        assert query(client, alu, f"a{i}", 90_000 + i * 100, 100_000).status_code == 200
        assert query(client, flip, f"f{i}", 40_000 + i * 100, 50_000).status_code == 200
    pool = client.get("/api/graph/status").json()["pool"]
    assert len(pool["workers"]) <= 2
    assert {w["registration_id"] for w in pool["workers"]} == {alu["id"], flip["id"]}


def test_real_helper_exits_when_its_stdin_closes():
    proc = subprocess.Popen([HELPER, "serve", "--package", package("alu")], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    header = proc.stdout.read(4)
    proc.stdout.read(struct.unpack(">I", header)[0])
    proc.stdin.close()
    assert proc.wait(timeout=5) is not None
