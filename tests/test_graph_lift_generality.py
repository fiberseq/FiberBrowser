"""Lifted reads in graph mode beyond HG002 (graph primary G8, DESIGN_GRAPH_PRIMARY §8), end to end with the real helper.

The neutral packages of test_graph_generality.py (``strain``: ``dm6#0#chr2L`` target + ``strainA#0#chr2L``;
``generic``: ``refA#0#chrT`` + ``sampleB#1#chrT`` / ``sampleB#2#chrT``) with lift maps made from the same GBZs by
graphlift ``gbz2chain`` and synthetic fiber-seq BAMs (MM/ML, ns/nl, as/al) on the maps' source contigs:

- strain (one haplotype, source contig ``chr2L`` named like the target): ``POST /api/lift/datasets`` adds it, its
  read binding is the strainA path, graph reads load on that lane with lifted identities (``aid``, ``rk``) and the
  map's own haplotype label ``strainA#0``; a graph cluster run over the lifted observation works;
- generic (two haplotypes of one sample, no MAT/PAT suffixes): rows on both lanes, each with its own label.

Needs FIBERBROWSER_TEST_GRAPH_HELPER, FIBERBROWSER_TEST_GRAPH_GENERALITY_PACKAGES (folders named strain and generic)
and FIBERBROWSER_TEST_GRAPH_LIFT_GENERALITY: a folder with ``strain/strain.chain.graphlift.json`` +
``strain/strain.src.bam`` and ``generic/generic.chain.graphlift.json`` + ``generic/generic.src.bam``.
"""
from __future__ import annotations

import asyncio
import os
import types
from pathlib import Path

import pytest

from services.graph_panel import analysis, service
from services.graph_panel import reads as gr
from services.graph_panel.worker import LIVE_PIDS
from services.lift import live_lift as ll

HELPER = os.environ.get("FIBERBROWSER_TEST_GRAPH_HELPER", "").strip()
PACKAGES = [p for p in os.environ.get("FIBERBROWSER_TEST_GRAPH_GENERALITY_PACKAGES", "").split(os.pathsep) if p.strip()]
LIFTS = os.environ.get("FIBERBROWSER_TEST_GRAPH_LIFT_GENERALITY", "").strip()
NOT_MAT_PAT = lambda label: str(label).upper() not in ("MAT", "PAT", "MATERNAL", "PATERNAL")


def _fixture(name):
    found = [p for p in PACKAGES if os.path.basename(os.path.normpath(p)) == name]
    manifest = Path(LIFTS) / name / f"{name}.chain.graphlift.json" if LIFTS else None
    bam = Path(LIFTS) / name / f"{name}.src.bam" if LIFTS else None
    if not (HELPER and os.path.isfile(HELPER)) or not found or not (manifest and manifest.is_file() and bam.is_file()):
        pytest.skip("set FIBERBROWSER_TEST_GRAPH_HELPER, FIBERBROWSER_TEST_GRAPH_GENERALITY_PACKAGES and "
                    "FIBERBROWSER_TEST_GRAPH_LIFT_GENERALITY")
    return found[0], str(manifest), str(bam)


@pytest.fixture(scope="module")
def helper_env(tmp_path_factory):
    with pytest.MonkeyPatch.context() as mp:
        mp.setenv("FIBERBROWSER_GRAPH_HELPER", HELPER)
        mp.setenv("FIBERBROWSER_GRAPH_REGISTRY", str(tmp_path_factory.mktemp("graph") / "registry.json"))
        mp.delenv("FIBERBROWSER_GRAPH_PACKAGES", raising=False)
        service.reset_for_tests()
        analysis.clear_caches()
        yield
        service.reset_for_tests()
        analysis.clear_caches()


@pytest.fixture
def server(helper_env, monkeypatch):
    """The app with a fresh state (live lift on), as the browser posts to it."""
    import server as srv
    from plugins import init_context
    from services.local_auth import auth_headers
    from starlette.testclient import TestClient

    monkeypatch.setenv("FIBERBROWSER_LIVE_LIFT", "1")
    ll.clear_selection_cache()
    ll.clear_primary_cache()
    gr.clear_cache()
    old = srv.state
    srv.state = srv.BrowserState(None, None, None, None)
    init_context(srv.state)
    srv.state.max_working_reads = 10000
    try:
        yield types.SimpleNamespace(client=TestClient(srv.app, headers=auth_headers()), state=srv.state)
    finally:
        srv.state = old
        init_context(old)
        gr.clear_cache()


def arun(fn):
    async def main():
        try:
            return await fn()
        finally:
            await service.shutdown()
    before = set(LIVE_PIDS)
    out = asyncio.run(main())
    assert not (set(LIVE_PIDS) - before)
    return out


def _register(package):
    async def go():
        await service.ensure_ready()
        return await asyncio.to_thread(service.registry().register, service.helper_status().path, package)
    return arun(go)


def _add_lifted(server, bam, manifest):
    out = server.client.post("/api/lift/datasets", json={"paths": [bam], "manifest": manifest}).json()
    assert out["success"], out
    return out["dataset"]["id"]


def _source_key(reg, sample, hap):
    return next(b["key"] for b in reg.bindings if b["path"]["sample"] == sample and b["path"]["haplotype"] == hap)


def _load(server, reg, did, binding_windows):
    [bound] = [b for b in gr.read_bindings(server.state, reg) if b["dataset_id"] == did]
    return gr.load(server.state, reg, {"datasets": [{"dataset_id": did, "revision": bound["revision"]}],
                                       "paths": [{"binding": k, "windows": [{"start": a, "end": b}]}
                                                 for k, (a, b) in binding_windows.items()]})


def test_a_single_haplotype_strain_lift_loads_on_its_path(server):
    package, manifest, bam = _fixture("strain")
    reg = _register(package)
    did = _add_lifted(server, bam, manifest)
    key = _source_key(reg, "strainA", "0")
    # The map's labels: the haplotype key itself (no MAT/PAT suffix to vote on).
    ds = server.client.get("/api/datasets").json()
    info = next(d for d in (ds.get("datasets") if isinstance(ds, dict) else ds) if d["id"] == did)["live_lift"]
    assert info["haplotypes"] == ["strainA#0"] and info["haplotype_labels"] == {"strainA#0": "strainA#0"}
    [bound] = [b for b in gr.read_bindings(server.state, reg) if b["dataset_id"] == did]
    # The source contig is named chr2L, like the target: it binds the strainA path, never the target dm6.
    assert bound["kind"] == "lifted" and not bound["problems"]
    assert bound["paths"] == {key: "chr2L"} and bound["haps"] == {key: "strainA#0"}
    out = _load(server, reg, did, {key: (0, 50_000)})
    rows = out["reads"]
    assert len(rows) == 24 and {r["b"] for r in rows} == {key} and {r["c"] for r in rows} == {"chr2L"}
    assert {r["hap"] for r in rows} == {"strainA#0"} and all(NOT_MAT_PAT(r["hap"]) for r in rows)
    assert all(r["aid"] and r["rk"] for r in rows) and len({r["rk"] for r in rows}) == 24
    # Fiber-seq marks and footprints come through, in source coordinates.
    assert all(r["m6a"] for r in rows) and all(r["nuc"]["iv"] for r in rows)
    assert all(10_000 <= r["cov"][0][0] < 22_000 for r in rows)
    assert {(b["dataset_id"], b["binding"]) for b in out["report"]["bands"]} == {(did, key)}


def test_two_sample_haplotypes_each_load_on_their_own_lane(server):
    package, manifest, bam = _fixture("generic")
    reg = _register(package)
    did = _add_lifted(server, bam, manifest)
    h1, h2 = _source_key(reg, "sampleB", "1"), _source_key(reg, "sampleB", "2")
    [bound] = [b for b in gr.read_bindings(server.state, reg) if b["dataset_id"] == did]
    assert bound["kind"] == "lifted" and not bound["problems"]
    assert bound["paths"] == {h1: "sampleB#1#chrT", h2: "sampleB#2#chrT"}
    assert bound["haps"] == {h1: "sampleB#1", h2: "sampleB#2"}
    out = _load(server, reg, did, {h1: (0, 50_000), h2: (0, 50_000)})
    lanes = {}
    for r in out["reads"]:
        lanes.setdefault(r["b"], []).append(r)
    assert sorted(lanes) == sorted([h1, h2]) and all(len(v) == 12 for v in lanes.values())
    assert {r["hap"] for r in lanes[h1]} == {"sampleB#1"} and {r["hap"] for r in lanes[h2]} == {"sampleB#2"}
    assert {r["q"][:3] for r in lanes[h1]} == {"g1_"} and {r["q"][:3] for r in lanes[h2]} == {"g2_"}
    assert all(r["aid"] and r["rk"] and NOT_MAT_PAT(r["hap"]) for r in out["reads"])
    assert {b["binding"] for b in out["report"]["bands"]} == {h1, h2}


def test_a_graph_cluster_run_over_the_lifted_strain(server):
    package, manifest, bam = _fixture("strain")
    reg = _register(package)
    did = _add_lifted(server, bam, manifest)
    key = _source_key(reg, "strainA", "0")
    target = next(m["target"] for m in reg.maps if m["source"] == key)
    # Target windows where most lifted reads overlap (source 16-17 kb; the map's offset there is +2,559).
    regions = [(18_600, 18_700), (19_200, 19_300)]
    body = dict(target=target, regions=[dict(start=a, end=b, mode="accessibility") for a, b in regions],
                observations=[dict(id="obs-strain", dataset_id=did, kind="graph", binding=key)], method="combinatorial", k=2)
    out = arun(lambda: analysis.handle(server.state, reg, body))
    result = out["results"]["obs-strain"]
    assert len(result["assignments"]) >= 5, result
    assert out["target"] == target and out["columns"]["shared"]


def test_haplotype_labels_take_mat_pat_only_as_a_whole_token():
    """Graph features (item 10): a haplotype key is MAT or PAT only where that is a whole token of it; sample names
    that contain the letters keep their own labels."""
    from services.lift.live_lift import _haplotype_labels
    def manifest(*haps):
        return {"sources": [{"name": "chrS"}], "chains": [{"haplotype": h, "source": 0} for h in haps]}
    assert _haplotype_labels(manifest("w_mated#0", "line_PAT2#1")) == {"w_mated#0": "w_mated#0", "line_PAT2#1": "line_PAT2#1"}
    assert _haplotype_labels(manifest("HG002_MAT#1", "HG002_PAT#2")) == {"HG002_MAT#1": "MAT", "HG002_PAT#2": "PAT"}
    assert _haplotype_labels(manifest("s_maternal", "strainA#0")) == {"s_maternal": "MAT", "strainA#0": "strainA#0"}
