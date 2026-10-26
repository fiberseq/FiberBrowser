"""Graph package registration on a shared lab server (graph follow-ups review O, agy): only lab admins register or
remove packages (the table is one per server); the package and every file its manifest names must be in the lab's
data folders, a relative path included; the table is kept in the server's state folder, not the service account's
home; removing a package drops its pool work."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

from lab_fixtures import _lab, member_client
from services.graph_panel import service

FAKE = Path(__file__).with_name("fake_graph_helper.py")
REVS = {"package": "e" * 64, "graph": "b" * 64, "db": "c" * 64, "maps": "d" * 64}


def _package(where: Path, graph_path: str = "graph.gbz") -> Path:
    where.mkdir(parents=True)
    (where / "manifest.json").write_text(json.dumps({
        "revisions": REVS, "producer": "fake", "build_target": "test",
        "graph": {"path": graph_path}, "db": {"path": "graph.db"},
        "bindings": [{"key": "target", "path": {"sample": "REF", "haplotype": "0", "contig": "chrT"}, "assembly": "REF",
                      "reference": "REF", "size": 1000, "fragments": [{"origin": 0, "end": 1000, "indexed": True}]}],
        "maps": [],
    }))
    (where / "graph.db").write_bytes(b"db")
    (where / "graph.gbz").write_bytes(b"gbz")
    return where


@pytest.fixture
def lab_graph(tmp_path, standalone_app, monkeypatch):
    script = tmp_path / "bin" / "fiberbrowser-graph"
    script.parent.mkdir()
    script.write_text(f"#!/bin/sh\nexec {sys.executable} {FAKE} \"$@\"\n")
    script.chmod(0o755)
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("FIBERBROWSER_GRAPH_HELPER", str(script))
    monkeypatch.delenv("FIBERBROWSER_GRAPH_REGISTRY", raising=False)
    monkeypatch.delenv("FIBERBROWSER_GRAPH_PACKAGES", raising=False)
    monkeypatch.setenv("FAKE_GRAPH_LOG", str(tmp_path / "helper.log"))
    service.reset_for_tests()
    (tmp_path / "lab").mkdir()
    gen = _lab(tmp_path / "lab", standalone_app, monkeypatch)
    lab = next(gen)
    try:
        yield lab, home
    finally:
        service.reset_for_tests()
        with pytest.raises(StopIteration):
            next(gen)


def test_only_lab_admins_register_and_remove_packages(lab_graph):
    lab, home = lab_graph
    inside = _package(lab.data / "pkg")
    with member_client(lab, "alice", role="member") as alice, member_client(lab, "boss", role="admin") as admin:
        refused = alice.post("/api/graph/registrations", json={"package": str(inside)})
        assert refused.status_code == 403 and "admins" in refused.json()["message"]
        r = admin.post("/api/graph/registrations", json={"package": str(inside)})
        assert r.status_code == 200, r.text
        reg = r.json()["registration"]
        # Every member sees it; a member can't remove it, an admin can.
        assert [x["id"] for x in alice.get("/api/graph/status").json()["registrations"]] == [reg["id"]]
        assert alice.delete(f"/api/graph/registrations/{reg['id']}").status_code == 403
        assert admin.delete(f"/api/graph/registrations/{reg['id']}").status_code == 200
        assert alice.get("/api/graph/status").json()["registrations"] == []
    # Kept in the server's state folder, never the service account's home.
    assert os.environ["FIBERBROWSER_GRAPH_REGISTRY"] == os.path.join(lab.cfg.state_dir, "graph_registrations.json")
    assert json.loads(Path(lab.cfg.state_dir, "graph_registrations.json").read_text())["packages"] == []
    assert not (home / ".fiberhmm" / "graph_registrations.json").exists()


def test_packages_and_their_files_must_be_in_the_lab_data_folders(lab_graph):
    lab, _home = lab_graph
    outside = _package(lab.outside / "pkg")
    # A package inside the data folders whose graph lives outside them ("../x.gbz" is a legitimate layout).
    (lab.outside / "far.gbz").write_bytes(b"gbz")
    reaching = _package(lab.data / "reaching", graph_path=os.path.relpath(lab.outside / "far.gbz", lab.data / "reaching"))
    with member_client(lab, "boss", role="admin") as admin:
        assert admin.post("/api/graph/registrations", json={"package": str(outside)}).status_code == 403
        relative = os.path.relpath(outside, os.getcwd())
        assert not relative.startswith("/")
        assert admin.post("/api/graph/registrations", json={"package": relative}).status_code == 403
        r = admin.post("/api/graph/registrations", json={"package": str(reaching)})
        assert r.status_code == 403, r.text
        assert admin.get("/api/graph/status").json()["registrations"] == []


def test_state_environment_keeps_an_operator_registry(tmp_path, monkeypatch):
    from lab_fixtures import lab_config
    from services.server_config import state_environment
    cfg = lab_config(tmp_path)
    monkeypatch.delenv("FIBERBROWSER_GRAPH_REGISTRY", raising=False)
    assert state_environment(cfg)["FIBERBROWSER_GRAPH_REGISTRY"] == os.path.join(cfg.state_dir, "graph_registrations.json")
    monkeypatch.setenv("FIBERBROWSER_GRAPH_REGISTRY", str(tmp_path / "mine.json"))
    assert state_environment(cfg)["FIBERBROWSER_GRAPH_REGISTRY"] == str(tmp_path / "mine.json")
