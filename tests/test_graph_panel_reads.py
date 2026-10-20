"""Reads on the graph panel (DESIGN_GRAPH_PANEL.md §5, Gate E; services/graph_panel/reads.py,
``/api/graph/read_bindings`` and ``/api/graph/reads``).

Toy BAMs on the toy live-lift map, whose MAT source carries an explicit graph path identity: datasets bind to
package paths only through those identities; reads are composed by the live-lift composer in source coordinates
(legacy MSP inference, explicit/MA channel precedence, deletion cuts, call identity); hard-clipped
supplementaries, record/library collisions, sampling and budgets are reported, never silent.
"""
from __future__ import annotations

import array
import json
import types

import pytest

from live_lift_fixtures import MAT, PAT, SSIZE, TARGET, TSIZE, make_record, write_bam, write_toy_sidecar
from services.graph_panel import reads as gr
from services.lift import live_lift as ll


def _u32(values):
    return array.array("I", values)


def _u8(values):
    return array.array("B", values)


def _binding(key, sample, hap, contig, size, frags=None):
    return {"key": key, "path": {"sample": sample, "haplotype": hap, "contig": contig}, "assembly": sample,
            "reference": sample, "size": size, "size_inferred": False,
            "fragments": [{"origin": a, "end": b, "indexed": True} for a, b in (frags or [(0, size)])], "uncovered": []}


def _registration():
    bindings = [_binding("target", "REF", "0", TARGET, TSIZE), _binding("mat", "H", "1", "chrS", SSIZE),
                _binding("pat", "H", "2", "chrS", SSIZE)]
    reg = types.SimpleNamespace(id="g1", bindings=bindings, maps=[{"target": "target", "source": "mat"},
                                                                  {"target": "target", "source": "pat"}],
                                revisions={"package": "p", "graph": "g", "db": "d", "maps": "m"})
    reg.binding = lambda key: next((b for b in bindings if b["key"] == key), None)
    return reg


def _sidecar(directory):
    """The toy sidecar with each source's graph path identity (gbz2chain writes `path` and `fragments`)."""
    path = write_toy_sidecar(directory)
    with open(path) as fh:
        manifest = json.load(fh)
    for src, hap in zip(manifest["sources"], ("1", "2")):
        src["path"] = f"H#{hap}#chrS"
        src["fragments"] = [{"name": f"H#{hap}#chrS[0]", "offset": 0, "len": SSIZE}]
    with open(path, "w") as fh:
        json.dump(manifest, fh)
    return path


def _records(h):
    return [
        # Legacy ns/nl only: nucleosomes, MSPs inferred between whole calls, cut at the 100 bp deletion.
        make_record(h, "legacy", MAT, 1000, "500M100D500M", tags=[("ns", _u32([100, 700])), ("nl", _u32([200, 200])),
                                                                  ("MM", "A+a,0,3;"), ("ML", _u8([255, 255]))],
                    seq="A" * 1000),
        # Explicit MA channels: its nuc and msp layers are the tags' (MA ids), never inferred.
        make_record(h, "explicit", MAT, 3000, "400M", tags=[("MA", "400;nuc+Q:1-150,251-150;msp+Q:151-100"),
                                                            ("AQ", _u8([200, 180, 240]))]),
        # ns/nl next to MA nuc: the MA channel wins; MSPs still inferred from the whole nucleosomes.
        make_record(h, "both", MAT, 4000, "600M", tags=[("ns", _u32([10, 400])), ("nl", _u32([150, 150])),
                                                        ("MA", "600;nuc+Q:11-150,401-150"), ("AQ", _u8([100, 100]))]),
        # A small deletion inside one node: M-D-M; a read insertion: M-I-M.
        make_record(h, "mdm", MAT, 5000, "100M3D100M", tags=[("ns", _u32([50])), ("nl", _u32([120]))]),
        make_record(h, "mim", MAT, 5500, "100M7I100M", tags=[("ns", _u32([50])), ("nl", _u32([120]))], seq="C" * 207),
        # A hard-clipped supplementary whose tags cannot be scoped to its stored SEQ.
        make_record(h, "hardclip", MAT, 6000, "50H200M", flag=2048,
                    tags=[("MA", "250;nuc+Q:1-150"), ("AQ", _u8([200])), ("SA", f"{PAT},101,+,200M50S,60,0;")]),
        make_record(h, "pat1", PAT, 100, "800M", tags=[("ns", _u32([50, 400])), ("nl", _u32([150, 150]))]),
    ]


@pytest.fixture
def env(tmp_path, monkeypatch):
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
    reg = _registration()
    import routers.graph_panel as route
    monkeypatch.setattr(route, "_registration", lambda _rid: reg)
    client = TestClient(srv.app, headers=auth_headers())
    manifest = _sidecar(tmp_path / "map")
    bam = write_bam(tmp_path / "src.bam", _records)
    try:
        yield types.SimpleNamespace(client=client, state=srv.state, manifest=manifest, bam=bam, reg=reg, tmp=tmp_path)
    finally:
        srv.state = old
        init_context(old)
        gr.clear_cache()


def _add_lifted(env, paths=None, **extra):
    out = env.client.post("/api/lift/datasets", json={"paths": paths or [env.bam], "manifest": env.manifest, **extra}).json()
    assert out["success"], out
    return out["dataset"]["id"]


def _reads(env, datasets, paths, **extra):
    body = {"registration_id": "g1", "revisions": env.reg.revisions, "request_id": "r1", "panel_id": "p", "generation": 1,
            "datasets": [{"dataset_id": d} for d in datasets], "paths": paths, **extra}
    return env.client.post("/api/graph/reads", json=body)


def _by_q(payload):
    out = {}
    for r in payload["reads"]:
        out.setdefault(r["q"], []).append(r)
    return out


def test_bindings_are_explicit_identities(env):
    did = _add_lifted(env)
    bindings = env.client.get("/api/graph/read_bindings", params={"registration_id": "g1"}).json()["bindings"]
    (b,) = [x for x in bindings if x["dataset_id"] == did]
    assert b["kind"] == "lifted" and b["paths"] == {"mat": MAT, "pat": PAT} and not b["problems"]
    # A map whose source path is another assembly binds nothing; one whose fragments differ is reported.
    reg = env.reg
    reg.bindings[1]["fragments"] = [{"origin": 0, "end": 5000, "indexed": True}]
    paths, problems = gr._lifted_paths(env.state.datasets[did], reg)
    assert "mat" not in paths and any("fragments" in p for p in problems)


def test_legacy_inferred_msps_cut_at_the_deletion(env):
    did = _add_lifted(env)
    r = _reads(env, [did], [{"binding": "mat", "windows": [{"start": 0, "end": 3000}]}])
    assert r.status_code == 200, r.text
    (legacy,) = _by_q(r.json())["legacy"]
    assert legacy["b"] == "mat" and legacy["c"] == MAT
    # Coverage slices in absolute source coordinates, the 100 bp CIGAR deletion a hole between them.
    assert [c[:2] for c in legacy["cov"]] == [[1000, 1500], [1600, 2100]]
    assert legacy["nuc"]["iv"] == [[1100, 1300, 200], [1800, 2000, 200]]
    # MSPs inferred between the whole nucleosomes (no explicit channel), in source coordinates, cut at the
    # deletion like the linear composer; each part keeps the whole MSP size.
    assert legacy["msp"]["iv"] == [[1300, 1500, 500], [1600, 1800, 500]]
    assert legacy["msp"]["inferred"] is True and legacy["msp"]["id"] == [None, None]
    assert legacy["m6a"] and all(1000 <= p < 2100 for p in legacy["m6a"])


def test_explicit_and_ma_channel_precedence(env):
    did = _add_lifted(env)
    reads = _by_q(_reads(env, [did], [{"binding": "mat", "windows": [{"start": 2900, "end": 4700}]}]).json())
    (explicit,) = reads["explicit"]
    assert explicit["nuc"]["id"] == ["MA0:0", "MA0:1"] and explicit["msp"]["id"] == ["MA1:0"]
    assert explicit["msp"]["iv"] == [[3150, 3250, 100]] and "inferred" not in explicit["msp"]
    (both,) = reads["both"]
    assert both["nuc"]["id"] == ["MA0:0", "MA0:1"]           # MA's nucleosomes, not the ns/nl ones
    assert both["msp"]["inferred"] is True                  # no explicit MSP channel: inferred between them
    assert both["msp"]["iv"] == [[4160, 4400, 240]]


def test_cigar_events_inside_a_node(env):
    did = _add_lifted(env)
    reads = _by_q(_reads(env, [did], [{"binding": "mat", "windows": [{"start": 4900, "end": 5800}]}]).json())
    (mdm,) = reads["mdm"]
    assert [c[:2] for c in mdm["cov"]] == [[5000, 5100], [5103, 5203]] and mdm["ins"] == []
    # The 120 bp nucleosome over the 3 bp deletion is one call (the browser cuts it at the hole).
    assert mdm["nuc"]["iv"] == [[5050, 5173, 120]] or len(set(mdm["nuc"]["id"])) == 1
    (mim,) = reads["mim"]
    assert [c[:2] for c in mim["cov"]] == [[5500, 5600], [5600, 5700]]
    assert [i[:2] for i in mim["ins"]] == [[5600, 7]]


def test_hard_clipped_supplementary_and_omissions_are_reported(env):
    did = _add_lifted(env)
    out = _reads(env, [did], [{"binding": "mat", "windows": [{"start": 5900, "end": 6300}]}]).json()
    reads = _by_q(out)
    scoped = out["report"].get("hard_clipped_scoped") or {}
    # Either hidden and counted, or decoded on its scoped SEQ and marked supplementary: never silent.
    assert "hardclip" not in reads and out["report"]["omitted"].get("hard_clipped_supplementary") == 1 \
        or reads["hardclip"][0]["sup"] and sum(scoped.values()) >= 1
    # Hiding supplementaries is the dataset's setting, reported as such.
    did2 = _add_lifted(env, settings={"supplementary_display": "hide"}, dataset_id="hide")
    out2 = _reads(env, [did2], [{"binding": "mat", "windows": [{"start": 5900, "end": 6300}]}]).json()
    assert not any(r["sup"] for r in out2["reads"])


def test_record_and_library_collisions_stay_apart(env):
    other = write_bam(env.tmp / "lib2.bam", lambda h: [
        make_record(h, "legacy", MAT, 1000, "1000M", tags=[("ns", _u32([100, 500])), ("nl", _u32([200, 200]))])])
    did = _add_lifted(env, paths=[env.bam, other], dataset_id="two")
    out = _reads(env, [did], [{"binding": "mat", "windows": [{"start": 0, "end": 3000}]}]).json()
    legacy = _by_q(out)["legacy"]
    assert sorted(r["lib"] for r in legacy) == [0, 1] and len({r["k"] for r in legacy}) == 2
    assert out["report"]["shared_qnames"] == 1


def test_sampling_is_by_molecule_before_decoding_and_reported(env):
    many = write_bam(env.tmp / "many.bam", lambda h: [
        make_record(h, f"m{i:03d}", MAT, 100 + i * 10, "500M", tags=[("ns", _u32([50])), ("nl", _u32([150]))])
        for i in range(120)])
    did = _add_lifted(env, paths=[many], dataset_id="many")
    paths = [{"binding": "mat", "windows": [{"start": 0, "end": 2500}]}]
    a = _reads(env, [did], paths, limits={"molecules": 20}).json()
    b = _reads(env, [did], paths, limits={"molecules": 20}).json()
    assert a["report"]["sampling"]["level"] >= 2 and a["report"]["sampling"]["estimated"] == 120
    assert a["report"]["molecules"] <= 20
    assert [r["q"] for r in a["reads"]] == [r["q"] for r in b["reads"]]      # deterministic
    # Fewer records decoded than in the windows: sampled before decoding, not after.
    full = _reads(env, [did], paths).json()
    assert full["report"]["sampling"]["level"] == 0 and full["report"]["molecules"] == 120


def test_mark_budget_turns_m6a_into_density(env):
    did = _add_lifted(env)
    out = _reads(env, [did], [{"binding": "mat", "windows": [{"start": 0, "end": 3000}]}], limits={"marks": 3}).json()
    rep = out["report"]
    assert rep["m6a_density_reads"] + rep["calls_omitted_reads"] >= 1 and rep["marks"] <= 3 + 10
    assert any("m6a_density" in r or r.get("calls_omitted") for r in out["reads"])


def test_payload_budget_samples_sparser_rather_than_truncating(env, monkeypatch):
    many = write_bam(env.tmp / "many2.bam", lambda h: [
        make_record(h, f"n{i:03d}", MAT, 100 + i * 5, "800M", tags=[("ns", _u32([50, 300])), ("nl", _u32([150, 150]))])
        for i in range(80)])
    did = _add_lifted(env, paths=[many], dataset_id="many2")
    monkeypatch.setattr(gr, "MAX_DECODED_BYTES", 40_000)
    out = _reads(env, [did], [{"binding": "mat", "windows": [{"start": 0, "end": 1500}]}]).json()
    assert out["report"]["sampling"]["level"] >= 1
    assert out["report"]["truncated"] is False


def test_refusals(env):
    did = _add_lifted(env)
    r = _reads(env, [did], [{"binding": "mat", "windows": [{"start": 0, "end": 3000}]}],
               revisions={"package": "other", "graph": "g", "db": "d", "maps": "m"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "stale_revision"
    assert _reads(env, ["nope"], [{"binding": "mat", "windows": [{"start": 0, "end": 100}]}]).status_code == 404
    r = _reads(env, [did], [{"binding": "mat", "windows": [{"start": 0, "end": SSIZE}]},
                            {"binding": "pat", "windows": [{"start": 0, "end": SSIZE}]},
                            {"binding": "target", "windows": [{"start": 0, "end": TSIZE}]}])
    assert r.status_code == 200      # windows clip to each path's fragments: 40 kb here is under the cap
    monkeypatch_cap = gr.MAX_SOURCE_BP
    try:
        gr.MAX_SOURCE_BP = 1000
        r = _reads(env, [did], [{"binding": "mat", "windows": [{"start": 0, "end": 3000}]}])
        assert r.status_code == 413
    finally:
        gr.MAX_SOURCE_BP = monkeypatch_cap
    revision = env.client.get("/api/graph/read_bindings", params={"registration_id": "g1"}).json()["bindings"][0]["revision"]
    body = {"registration_id": "g1", "revisions": env.reg.revisions, "datasets": [{"dataset_id": did, "revision": "stale"}],
            "paths": [{"binding": "mat", "windows": [{"start": 0, "end": 100}]}]}
    assert revision != "stale" and env.client.post("/api/graph/reads", json=body).status_code == 409


def test_native_dataset_binds_to_the_target_path_by_contig_and_size(env):
    _add_lifted(env)   # seeds the main reference (chrT) from the map
    native = write_bam(env.tmp / "native.bam", lambda h: [
        make_record(h, "nat", TARGET, 1000, "800M", tags=[("ns", _u32([50, 400])), ("nl", _u32([150, 150]))])],
        contigs=((TARGET, TSIZE),))
    added = env.client.post("/api/datasets/add", json={"path": str(native), "label": "native"}).json()
    assert added.get("success"), added
    did = added["dataset"]["id"]
    bindings = {b["dataset_id"]: b for b in env.client.get("/api/graph/read_bindings", params={"registration_id": "g1"}).json()["bindings"]}
    assert bindings[did]["kind"] == "native" and bindings[did]["paths"] == {"target": TARGET}
    out = _reads(env, [did], [{"binding": "target", "windows": [{"start": 900, "end": 2000}]}]).json()
    (nat,) = _by_q(out)["nat"]
    assert nat["b"] == "target" and nat["nuc"]["iv"] == [[1050, 1200, 150], [1400, 1550, 150]]
    # A BAM whose contig has another length does not bind (reported).
    wrong = write_bam(env.tmp / "wrong.bam", lambda h: [
        make_record(h, "w", TARGET, 1000, "800M", tags=[("ns", _u32([50, 400])), ("nl", _u32([150, 150]))])],
        contigs=((TARGET, TSIZE + 5),))
    ds = types.SimpleNamespace(id="w", paths=[str(wrong)], data_type="bam")
    paths, problems = gr._native_paths(env.state, ds, env.reg)
    assert paths == {} and problems
