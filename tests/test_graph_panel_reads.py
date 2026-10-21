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


def test_loader_filter_omissions_are_reported(env):
    # A record the source loader leaves out (its signal filters) is counted, not silently missing.
    dropped = write_bam(env.tmp / "dropped.bam", lambda h: [
        make_record(h, "kept", MAT, 1000, "1000M", tags=[("ns", _u32([100, 500])), ("nl", _u32([200, 200]))]),
        make_record(h, "dropped", MAT, 1200, "1000M", tags=[("ns", _u32([100])), ("nl", _u32([200]))], seq="A" * 1000)])
    did = _add_lifted(env, paths=[dropped], dataset_id="dropped")
    out = _reads(env, [did], [{"binding": "mat", "windows": [{"start": 0, "end": 3000}]}]).json()
    assert [r["q"] for r in out["reads"]] == ["kept"]
    assert out["report"]["omitted"] == {"loader_filters": 1}


# ── Review round 1 (Codex) ──────────────────────────────────────────────────

def test_small_windows_keep_whole_calls_and_inferred_msps(env):
    did = _add_lifted(env)
    # Inside the inferred MSP between the nucleosomes: the MSP is still inferred, with its own bounds.
    (inner,) = _by_q(_reads(env, [did], [{"binding": "mat", "windows": [{"start": 1400, "end": 1450}]}]).json())["legacy"]
    assert inner["msp"]["iv"] == [[1300, 1500, 500]] and inner["msp"]["inferred"] is True
    assert "nuc" not in inner      # no nucleosome touches the window
    # A window cutting a nucleosome sends it whole: its own boundaries, never the window's.
    (edge,) = _by_q(_reads(env, [did], [{"binding": "mat", "windows": [{"start": 1250, "end": 1260}]}]).json())["legacy"]
    assert edge["nuc"]["iv"] == [[1100, 1300, 200]]
    assert edge["cov"][0][:2] == [1000, 1500]           # coverage is the record's own


def test_cached_results_are_never_changed_by_a_request(env):
    did = _add_lifted(env)
    paths = [{"binding": "mat", "windows": [{"start": 0, "end": 3000}]}]
    before = _by_q(_reads(env, [did], paths).json())["legacy"][0]
    squeezed = _reads(env, [did], paths, limits={"marks": 1}).json()
    assert squeezed["report"]["m6a_density_reads"] + squeezed["report"]["calls_omitted_reads"] >= 1
    after = _by_q(_reads(env, [did], paths).json())["legacy"][0]
    assert after == before


def test_payload_budget_is_for_the_whole_request(env, monkeypatch):
    many = write_bam(env.tmp / "both.bam", lambda h: [
        make_record(h, f"{c[-4:]}{i:03d}", c, 100 + i * 5, "800M", tags=[("ns", _u32([50, 300])), ("nl", _u32([150, 150]))])
        for c in (MAT, PAT) for i in range(40)])
    did = _add_lifted(env, paths=[many], dataset_id="both")
    paths = [{"binding": "mat", "windows": [{"start": 0, "end": 1200}]}, {"binding": "pat", "windows": [{"start": 0, "end": 1200}]}]
    full = _reads(env, [did], paths).json()["report"]
    assert full["sampling"]["level"] == 0
    # A budget each path fits alone but not both together: the request samples sparser.
    monkeypatch.setattr(gr, "MAX_DECODED_BYTES", int(full["decoded_bytes"] * 0.7))
    gr.clear_cache()
    rep = _reads(env, [did], paths).json()["report"]
    assert rep["sampling"]["level"] >= 1 and rep["decoded_bytes"] <= gr.MAX_DECODED_BYTES


def test_typed_cigar_events(env):
    bam = write_bam(env.tmp / "cigar.bam", lambda h: [
        make_record(h, "lead_ins", MAT, 1000, "20I200M", tags=[("ns", _u32([30, 120])), ("nl", _u32([50, 50]))]),
        make_record(h, "tail_ins", MAT, 2000, "200M20I", tags=[("ns", _u32([30, 120])), ("nl", _u32([50, 50]))]),
        make_record(h, "skip", MAT, 3000, "50M50N50M", tags=[("ns", _u32([10, 60])), ("nl", _u32([30, 30]))]),
        make_record(h, "dele", MAT, 4000, "50M50D50M", tags=[("ns", _u32([10, 60])), ("nl", _u32([30, 30]))])])
    did = _add_lifted(env, paths=[bam], dataset_id="cigar")
    reads = _by_q(_reads(env, [did], [{"binding": "mat", "windows": [{"start": 900, "end": 4300}]}]).json())
    assert [i[:2] for i in reads["lead_ins"][0]["ins"]] == [[1000, 20]]
    assert [i[:2] for i in reads["tail_ins"][0]["ins"]] == [[2200, 20]]
    # A hole with a D event is a deletion; a hole without one is a skip (N).
    assert [c[:2] for c in reads["skip"][0]["cov"]] == [[3000, 3050], [3100, 3150]] and reads["skip"][0]["dl"] == []
    assert reads["dele"][0]["dl"] == [[4050, 50]]


def test_unverifiable_bindings_are_refused(env):
    did = _add_lifted(env)
    with open(env.manifest) as fh:
        manifest = json.load(fh)
    for src in manifest["sources"]:
        src.pop("fragments")
    with open(env.manifest, "w") as fh:
        json.dump(manifest, fh)
    ll.clear_selection_cache()
    from services.lift.live_lift import open_lift_map
    handle = open_lift_map(env.manifest)
    ds = types.SimpleNamespace(id="x", paths=[env.bam], live_lift=types.SimpleNamespace(handle=handle))
    paths, problems = gr._lifted_paths(ds, env.reg)
    assert paths == {} and any("no fragment list" in p for p in problems)
    assert did


def test_supplementaries_the_dataset_does_not_load_are_reported(env):
    did = _add_lifted(env, settings={"supplementary_display": "hide", "cohort_supplementaries": "primary_only"},
                      dataset_id="nosup")
    out = _reads(env, [did], [{"binding": "mat", "windows": [{"start": 5900, "end": 6300}]}]).json()
    assert not out["reads"] and out["report"]["omitted"].get("supplementary_not_loaded") == 1



# ── Review round 2 (Codex) ──────────────────────────────────────────────────

def test_region_is_bounded_by_the_bam_contig_not_an_inferred_graph_size(env):
    # The graph knows MAT only to 5,000 bp (an inferred size); the source contig is 10,000 bp.
    with open(env.manifest) as fh:
        manifest = json.load(fh)
    manifest["sources"][0]["fragments"] = [{"name": "H#1#chrS[0]", "offset": 0, "len": 5000}]
    with open(env.manifest, "w") as fh:
        json.dump(manifest, fh)
    ll.clear_selection_cache()
    env.reg.bindings[1].update(size=5000, size_inferred=True, fragments=[{"origin": 0, "end": 5000, "indexed": True}])
    bam = write_bam(env.tmp / "edge.bam", lambda h: [
        make_record(h, "edge", MAT, 4500, "1000M", tags=[("ns", _u32([0, 700])), ("nl", _u32([300, 300]))])])
    did = _add_lifted(env, paths=[bam], dataset_id="edge")
    (r,) = _by_q(_reads(env, [did], [{"binding": "mat", "windows": [{"start": 4900, "end": 4950}]}]).json())["edge"]
    assert r["msp"]["iv"] == [[4800, 5200, 400]] and r["cov"][0][:2] == [4500, 5500]


def test_records_sharing_name_start_and_flag_are_each_listed(env):
    bam = write_bam(env.tmp / "twin.bam", lambda h: [
        make_record(h, "twin", MAT, 1000, "500M", tags=[("ns", _u32([10, 300])), ("nl", _u32([100, 100]))]),
        make_record(h, "twin", MAT, 1000, "2500M", tags=[("ns", _u32([10, 2000])), ("nl", _u32([100, 100]))])])
    did = _add_lifted(env, paths=[bam], dataset_id="twin")
    recs = gr.window_records(env.state.datasets[did], MAT, [[900, 1200]])
    assert sorted(r[4] for r in recs) == [1500, 3500]
    out = _reads(env, [did], [{"binding": "mat", "windows": [{"start": 900, "end": 1200}]}]).json()
    assert sorted(r["cov"][-1][1] for r in out["reads"]) == [1500, 3500]
    assert any(r.get("msp") and r["msp"]["iv"] == [[1110, 3000, 1890]] for r in out["reads"])


def test_payload_over_budget_at_the_sparsest_level_is_enforced_and_reported(env, monkeypatch):
    did = _add_lifted(env)
    paths = [{"binding": "mat", "windows": [{"start": 0, "end": 3000}]}]
    full = _reads(env, [did], paths).json()["report"]
    monkeypatch.setattr(gr, "MAX_LEVEL", 0)
    monkeypatch.setattr(gr, "MAX_DECODED_BYTES", max(1, full["decoded_bytes"] // 3))
    gr.clear_cache()
    out = _reads(env, [did], paths).json()
    assert out["report"]["truncated"] is True and out["report"]["omitted"]["payload_limit"] >= 1
    assert out["report"]["molecules"] < full["molecules"]


def test_a_terminal_insertion_at_the_far_end_is_kept(env):
    bam = write_bam(env.tmp / "tail.bam", lambda h: [
        make_record(h, "tail", MAT, 2000, "200M20I", tags=[("ns", _u32([30, 120])), ("nl", _u32([50, 50]))])])
    did = _add_lifted(env, paths=[bam], dataset_id="tail")
    (r,) = _by_q(_reads(env, [did], [{"binding": "mat", "windows": [{"start": 1900, "end": 2300}]}]).json())["tail"]
    assert [i[:2] for i in r["ins"]] == [[2200, 20]]



def test_a_terminal_insertion_at_the_contig_end_is_kept(env):
    bam = write_bam(env.tmp / "end.bam", lambda h: [
        make_record(h, "end", MAT, SSIZE - 200, "200M20I", tags=[("ns", _u32([30, 120])), ("nl", _u32([50, 50]))])])
    did = _add_lifted(env, paths=[bam], dataset_id="end")
    (r,) = _by_q(_reads(env, [did], [{"binding": "mat", "windows": [{"start": SSIZE - 300, "end": SSIZE}]}]).json())["end"]
    assert [i[:2] for i in r["ins"]] == [[SSIZE, 20]] and r["cov"][-1][1] == SSIZE


def test_a_pan_decodes_only_new_records_and_matches_a_cold_load(env):
    """The per-record cache (Phase F): a record is composed whole, so a pan decodes only the records it has not
    seen; the payload equals a cold load of the same windows (calls clipped to the windows, never changed)."""
    many = write_bam(env.tmp / "pan.bam", lambda h: [
        make_record(h, f"p{i:03d}", MAT, 100 + i * 60, "700M", tags=[("ns", _u32([50, 300])), ("nl", _u32([150, 150])),
                                                                     ("MM", "A+a,0,3;"), ("ML", _u8([255, 255]))],
                    seq="A" * 700) for i in range(60)])
    did = _add_lifted(env, paths=[many], dataset_id="pan")
    first = _reads(env, [did], [{"binding": "mat", "windows": [{"start": 0, "end": 2000}]}]).json()
    panned = _reads(env, [did], [{"binding": "mat", "windows": [{"start": 500, "end": 2500}]}]).json()
    new = {r["q"] for r in panned["reads"]} - {r["q"] for r in first["reads"]}
    assert new and panned["timings"]["records_decoded"] == len(new)
    again = _reads(env, [did], [{"binding": "mat", "windows": [{"start": 500, "end": 2500}]}]).json()
    assert again["cached"] is True and again["timings"]["records_decoded"] == 0
    gr.clear_cache()
    cold = _reads(env, [did], [{"binding": "mat", "windows": [{"start": 500, "end": 2500}]}]).json()
    strip = lambda o: (o["reads"], {k: v for k, v in o["report"].items() if k != "hard_clipped_scoped"})  # noqa: E731
    assert strip(panned) == strip(cold)
    # Calls are clipped to the request's windows; the cached whole read keeps them for a later window.
    assert all(iv[0] < 2500 and iv[1] > 500 for r in cold["reads"] for n in ("nuc", "msp") for iv in (r.get(n) or {}).get("iv", []))
    assert all(500 <= p < 2500 for r in cold["reads"] for p in r.get("m6a", []))


def test_omissions_of_cached_records_are_reported_again(env):
    did = _add_lifted(env)
    paths = [{"binding": "mat", "windows": [{"start": 0, "end": 7000}]}]
    first = _reads(env, [did], paths).json()
    second = _reads(env, [did], paths).json()
    assert second["cached"] is True and second["report"]["omitted"] == first["report"]["omitted"]
    assert second["reads"] == first["reads"]
    # A loader-filter omission is remembered with its record, not decoded again.
    monkey = write_bam(env.tmp / "filt.bam", lambda h: [make_record(h, "bare", MAT, 100, "300M")])
    did2 = _add_lifted(env, paths=[monkey], dataset_id="filt")
    a = _reads(env, [did2], [{"binding": "mat", "windows": [{"start": 0, "end": 500}]}]).json()
    b = _reads(env, [did2], [{"binding": "mat", "windows": [{"start": 0, "end": 500}]}]).json()
    assert a["report"]["omitted"] == b["report"]["omitted"] and b["timings"]["records_decoded"] == 0


def test_a_truncated_batch_never_caches_part_of_an_identity(env, monkeypatch):
    """Two physical records sharing (library, QNAME, start, end, supplementary): a batch cut short after one of
    them caches neither; the next request decodes both (Codex Gate F round 1)."""
    bam = write_bam(env.tmp / "pair.bam", lambda h: [
        make_record(h, "pair", MAT, 1000, "500M", tags=[("ns", _u32([10, 300])), ("nl", _u32([100, 100]))]),
        make_record(h, "pair", MAT, 1000, "500M", tags=[("ns", _u32([20, 320])), ("nl", _u32([90, 90]))])])
    did = _add_lifted(env, paths=[bam], dataset_id="pair")
    paths = [{"binding": "mat", "windows": [{"start": 900, "end": 1600}]}]
    full = _reads(env, [did], paths).json()
    assert len(full["reads"]) == 2
    gr.clear_cache()
    monkeypatch.setattr(gr, "MAX_LEVEL", 0)
    monkeypatch.setattr(gr, "MAX_DECODED_BYTES", 600)
    cut = _reads(env, [did], paths).json()
    assert cut["report"]["truncated"] is True
    assert len(cut["reads"]) + cut["report"]["omitted"].get("records_not_reached", 0) + cut["report"]["omitted"].get("payload_limit", 0) >= 1
    monkeypatch.setattr(gr, "MAX_DECODED_BYTES", 8 * 1024 * 1024)
    again = _reads(env, [did], paths).json()
    assert len(again["reads"]) == 2 and again["report"]["truncated"] is False
    assert sorted(r["k"] for r in again["reads"]) == sorted(r["k"] for r in full["reads"])


def test_a_changed_dataset_revision_is_its_own_refusal(env):
    """A dataset revision the server no longer has is refused as such (the panel re-reads its bindings), not as a
    package revision change."""
    did = _add_lifted(env)
    r = _reads(env, [did], [{"binding": "mat", "windows": [{"start": 0, "end": 3000}]}])
    assert r.status_code == 200
    body = {"registration_id": "g1", "revisions": env.reg.revisions, "request_id": "r1", "panel_id": "p", "generation": 1,
            "datasets": [{"dataset_id": did, "revision": "0" * 16}],
            "paths": [{"binding": "mat", "windows": [{"start": 0, "end": 3000}]}]}
    out = env.client.post("/api/graph/reads", json=body)
    assert out.status_code == 409 and out.json()["error"]["code"] == "stale_dataset_revision"


def test_graph_rows_carry_the_linear_rows_identities(env):
    """Graph primary G0 (DESIGN_GRAPH_PRIMARY §3.1, §2.6): a lifted graph row's molecule group is the dataset's
    provenance (molecule_group_map), its haplotype is the map source's, and its record key is the one the linear
    rows of the same record derive, so the two views match without loading each other's rows."""
    from services.analysis_query import AnalysisReadQuery
    from services.lift.cohort import record_key
    did = _add_lifted(env)
    out = _reads(env, [did], [{"binding": "mat", "windows": [{"start": 0, "end": 7000}]},
                             {"binding": "pat", "windows": [{"start": 0, "end": 1000}]}]).json()
    graph = [r for r in out["reads"] if not r["sup"]]
    assert graph and all(r["aid"].startswith("lift-cohort:v1 ") and r["rk"] == record_key(r["aid"]) for r in graph)
    linear = []
    for hap in ("MAT", "PAT"):
        q = AnalysisReadQuery.from_request(env.state, capability="clustering", chrom=TARGET, start=0, end=TSIZE,
                                           dataset_ids=[did], include_layers=False, include_methylation=False)
        linear += q.build_working_set(env.state, did, lift_hap=hap).reads
    by_q = {}
    for row in linear:
        by_q.setdefault(row["id"], []).append(row)
    matched = 0
    for r in graph:
        rows = by_q.get(r["q"])
        if not rows:
            continue
        matched += 1
        assert r["rk"] in {record_key(x["analysis_id"]) for x in rows}, r["q"]
        assert r["hap"] in {x["live_lift"]["hap_label"] for x in rows}, r["q"]
        assert r["hap"] == ("MAT" if r["b"] == "mat" else "PAT")
    assert matched >= 3


def test_lifted_read_bindings_name_each_paths_haplotype(env):
    """Graph primary G1: a split panel's liftHap names the path it is a member for (binding key -> map label)."""
    did = _add_lifted(env)
    bindings = env.client.get("/api/graph/read_bindings", params={"registration_id": "g1"}).json()["bindings"]
    (b,) = [x for x in bindings if x["dataset_id"] == did]
    assert b["haps"] == {"mat": "MAT", "pat": "PAT"}


def test_pinned_qnames_survive_sampling_and_the_cap(env):
    """Graph primary G3: a host's members' filters and selections pin their QNAMEs into the sample."""
    many = write_bam(env.tmp / "pins.bam", lambda h: [
        make_record(h, f"p{i:03d}", MAT, 100 + i * 10, "500M", tags=[("ns", _u32([50])), ("nl", _u32([150]))])
        for i in range(120)])
    did = _add_lifted(env, paths=[many], dataset_id="pins")
    paths = [{"binding": "mat", "windows": [{"start": 0, "end": 2500}]}]
    sampled = {r["q"] for r in _reads(env, [did], paths, limits={"molecules": 20}).json()["reads"]}
    out = [f"p{i:03d}" for i in range(120) if f"p{i:03d}" not in sampled][:5]
    pinned = _reads(env, [did], paths, limits={"molecules": 20}, pins=out).json()
    got = {r["q"] for r in pinned["reads"]}
    # Pinned molecules come on top of the cap (the rest still fill it).
    assert set(out) <= got and pinned["report"]["molecules"] <= 25 and pinned["report"]["pinned"] == 5
    assert _reads(env, [did], paths, pins=[1]).status_code == 422


# ── G7 budgets (DESIGN_GRAPH_PRIMARY §6) ────────────────────────────────────

def test_profile_budgets_follow_the_performance_profile():
    low = gr.profile_budgets(types.SimpleNamespace(performance={"effective": "low", "sample_target": 1000}))
    std = gr.profile_budgets(types.SimpleNamespace(performance={"effective": "standard", "sample_target": 4000}))
    high = gr.profile_budgets(types.SimpleNamespace(performance={"effective": "high", "sample_target": 4000}))
    assert (low["molecules"], low["decoded_bytes"]) == (1000, 8 * 1024 * 1024)
    assert (std["molecules"], std["decoded_bytes"]) == (4000, 32 * 1024 * 1024) == (high["molecules"], high["decoded_bytes"])
    assert low["records_bytes"] < std["records_bytes"] < high["records_bytes"]
    # No profile (tools, tests): the Phase E request budget.
    assert gr.profile_budgets(types.SimpleNamespace())["molecules"] == gr.MAX_MOLECULES


def test_split_quota_gives_each_band_its_share_at_least_fifty():
    assert gr.split_quota(4000, [10_000, 10_000]) == [2000, 2000]
    # A small band keeps what it has; the rest goes to the others.
    assert gr.split_quota(4000, [100, 10_000, 10_000]) == [100, 1950, 1950]
    # The floor: 50 each, even when the budget split evenly would give less.
    assert gr.split_quota(100, [500, 500, 500, 500]) == [50, 50, 50, 50]
    assert gr.split_quota(20, [120]) == [20]          # never more than the budget for one band
    assert gr.split_quota(40, [120, 1], floor=1) == [39, 1]   # an explicit request limit: a total
    assert gr.split_quota(1000, [None, 30]) == [970, 30]


def test_each_band_samples_at_its_own_level_and_reports_it(env):
    """One band with 120 molecules and one with 1: with a 40-molecule budget the big band is sampled, the small one
    keeps its molecule unsampled (§6.1: split across sub-bands, at least 50 each, never more than the request)."""
    many = write_bam(env.tmp / "bands.bam", lambda h: [
        *[make_record(h, f"b{i:03d}", MAT, 100 + i * 10, "500M", tags=[("ns", _u32([50])), ("nl", _u32([150]))])
          for i in range(120)],
        make_record(h, "lonely", PAT, 100, "500M", tags=[("ns", _u32([50])), ("nl", _u32([150]))])])
    did = _add_lifted(env, paths=[many], dataset_id="bands")
    paths = [{"binding": "mat", "windows": [{"start": 0, "end": 2500}]}, {"binding": "pat", "windows": [{"start": 0, "end": 1000}]}]
    out = _reads(env, [did], paths, limits={"molecules": 40}).json()
    bands = {b["binding"]: b for b in out["report"]["bands"]}
    assert bands["pat"]["estimated"] == 1 and bands["pat"]["level"] == 0 and bands["pat"]["molecules"] == 1
    assert bands["mat"]["estimated"] == 120 and bands["mat"]["level"] >= 1 and bands["mat"]["molecules"] <= 39
    assert bands["mat"]["quota"] == 39 and bands["pat"]["quota"] == 1
    assert out["report"]["budgets"]["molecules"] == 40


def test_density_strip_counts_rows_before_the_cap_and_the_mark_budget(env, monkeypatch):
    monkeypatch.setattr(gr, "MAX_LEVEL", 0)   # unsampled: the cap alone limits what is drawn
    many = write_bam(env.tmp / "strip.bam", lambda h: [
        make_record(h, f"s{i:03d}", MAT, 100 + i, "500M", tags=[("ns", _u32([200])), ("nl", _u32([150]))]) for i in range(30)])
    did = _add_lifted(env, paths=[many], dataset_id="strip")
    paths = [{"binding": "mat", "windows": [{"start": 0, "end": 1200}]}]
    out = _reads(env, [did], paths, limits={"molecules": 5, "marks": 1, "strip_bp": 100}).json()
    assert out["report"]["molecules"] <= 5
    [strip] = out["strips"]
    assert strip["binding"] == "mat" and strip["bp"] == 100
    [[start, end, cov, acc, nuc]] = strip["windows"]
    assert (start, end) == (0, 1200) and len(cov) == 12
    decoded = out["report"]["bands"][0]["decoded"]
    assert decoded > 5                       # more rows than drawn...
    assert max(cov) == decoded               # ...all counted at the centre of a covered bin
    assert cov[0] == 0 and cov[11] == 0      # 0-100 and 1100-1200 are outside every read
    # Each read's nucleosome (ns 200 from its start) covers bin 3's centre (350): every row; bin 1 (150) none.
    assert nuc[3] == decoded and nuc[1] == 0
    assert all(a <= c for a, c in zip(acc, cov))


def test_concurrent_loads_share_the_decoded_bytes_budget():
    """One allocator: loads running together never hold more than the budget (Codex G7 review); each load gets the
    whole budget, so its sample never depends on what else is loading, and the others wait."""
    import threading
    import time
    total = 32 * 1024 * 1024
    with gr._SharedBytes(total) as a:
        assert a.share == total
        entered = threading.Event()
        got = {}

        def second():
            with gr._SharedBytes(total) as b:
                got["share"], got["concurrent"] = b.share, b.concurrent
                entered.set()
        t = threading.Thread(target=second)
        t.start()
        assert not entered.wait(0.3)      # nothing free: it waits
    t.join(5)
    assert entered.is_set() and got["share"] == total
    # Many at once: the shares in use never pass the budget.
    peak, lock, in_use = [0], threading.Lock(), [0]

    def worker():
        with gr._SharedBytes(total) as w:
            with lock:
                in_use[0] += w.share
                peak[0] = max(peak[0], in_use[0])
            time.sleep(0.05)
            with lock:
                in_use[0] -= w.share
    threads = [threading.Thread(target=worker) for _ in range(6)]
    for th in threads:
        th.start()
    for th in threads:
        th.join(10)
    assert 0 < peak[0] <= total and gr._shared_in_use == 0 and gr._active_loads == 0


def test_a_band_that_fits_its_byte_share_is_never_sampled_for_another(env, monkeypatch):
    """Codex G7 review: byte pressure from one band makes that band sparser, never a small band that fits."""
    many = write_bam(env.tmp / "pressure.bam", lambda h: [
        *[make_record(h, f"p{i:03d}", MAT, 100 + i * 10, "500M", tags=[("ns", _u32([50])), ("nl", _u32([150]))])
          for i in range(120)],
        make_record(h, "small", PAT, 100, "500M", tags=[("ns", _u32([50])), ("nl", _u32([150]))])])
    did = _add_lifted(env, paths=[many], dataset_id="pressure")
    paths = [{"binding": "mat", "windows": [{"start": 0, "end": 2500}]}, {"binding": "pat", "windows": [{"start": 0, "end": 1000}]}]
    full = _reads(env, [did], paths).json()
    assert full["report"]["sampling"]["level"] == 0
    monkeypatch.setattr(gr, "MAX_DECODED_BYTES", int(full["report"]["decoded_bytes"] * 0.4))
    out = _reads(env, [did], paths).json()
    bands = {b["binding"]: b for b in out["report"]["bands"]}
    assert bands["mat"]["level"] >= 1
    assert bands["pat"]["level"] == 0 and bands["pat"]["molecules"] == 1
    assert out["report"]["decoded_bytes"] <= gr.MAX_DECODED_BYTES


def test_a_smaller_record_cache_budget_trims_at_once():
    """Codex G7 review: switching to Low memory trims the record cache to its budget immediately."""
    gr.clear_cache()
    gr._records_put({("k", i): ((), 0, None, 1024 * 1024, 0) for i in range(8)})
    assert gr._records_bytes == 8 * 1024 * 1024
    gr._records_resize(3 * 1024 * 1024)
    assert gr._records_bytes <= 3 * 1024 * 1024 and len(gr._RECORDS) == 3
    gr._records_resize(96 * 1024 * 1024)
    gr.clear_cache()


def test_a_lifted_bam_subset_is_written_on_the_source_assembly(env):
    """Graph primary G8: Export data > BAM subset for lifted rows (linear or graph): the named reads' records from
    the source windows the target region lifts from, on the source contigs, every tag kept. Graph rows name their
    reads by cohort identity or record key; both decode to the QNAME."""
    import pysam
    did = _add_lifted(env)
    out = _reads(env, [did], [{"binding": "mat", "windows": [{"start": 0, "end": 7000}]},
                             {"binding": "pat", "windows": [{"start": 0, "end": 1000}]}]).json()
    by_q = {r["q"]: r for r in out["reads"] if not r["sup"]}
    ids = [by_q["legacy"]["aid"], by_q["explicit"]["rk"], by_q["pat1"]["aid"], "no-such-read"]
    r = env.client.post("/api/lift/export_bam", json={"dataset_id": did, "chrom": TARGET, "start": 0, "end": TSIZE, "read_ids": ids})
    assert r.status_code == 200, r.text
    assert r.headers["X-FiberBrowser-Reads"] == "3" and r.headers["X-FiberBrowser-Missing"] == "1"
    path = env.tmp / "subset.bam"
    path.write_bytes(r.content)
    with pysam.AlignmentFile(str(path)) as bam:
        got = {(rec.query_name, rec.reference_name) for rec in bam}
        assert ("legacy", MAT) in got and ("explicit", MAT) in got and ("pat1", PAT) in got
        assert all(c in (MAT, PAT) for _q, c in got)     # source contigs, never the target
    # The linear routes still refuse lifted datasets (default deny); this one refuses others.
    assert env.client.post("/api/reads/export_bam", json={"dataset_id": did, "chrom": TARGET, "start": 0, "end": TSIZE,
                                                          "read_ids": ["legacy"]}).status_code == 409
    assert env.client.post("/api/lift/export_bam", json={"dataset_id": "nope", "chrom": TARGET, "start": 0, "end": 10,
                                                         "read_ids": ["legacy"]}).status_code == 404


def test_graph_rows_carry_the_daf_strand(env):
    """Graph primary G8: a DAF-seq record's strand (its st:Z tag, else its deamination marks) is on its graph row
    (``ds``), so a one-strand member shows only its strand; other records carry none."""
    daf = write_bam(env.tmp / "daf.bam", lambda h: [
        make_record(h, "ct1", MAT, 100, "500M", tags=[("ns", _u32([50])), ("nl", _u32([150])), ("st", "CT")]),
        make_record(h, "ga1", MAT, 200, "500M", tags=[("ns", _u32([50])), ("nl", _u32([150])), ("st", "GA")]),
        make_record(h, "plain", MAT, 300, "500M", tags=[("ns", _u32([50])), ("nl", _u32([150]))]),
        # A supplementary record with no strand of its own takes its molecule's (its primary's), as linear rows do.
        make_record(h, "ct1", MAT, 900, "300M", flag=2048, tags=[("ns", _u32([50])), ("nl", _u32([150]))])])
    did = _add_lifted(env, paths=[daf], dataset_id="daf")
    out = _reads(env, [did], [{"binding": "mat", "windows": [{"start": 0, "end": 1500}]}]).json()
    got = {(r["q"], r["sup"]): r.get("ds") for r in out["reads"]}
    assert got[("ct1", False)] == "CT" and got[("ga1", False)] == "GA" and got[("plain", False)] is None
    assert got[("ct1", True)] == "CT"


def test_the_payload_trim_keeps_a_band_that_fits_its_share(env, monkeypatch):
    """agy G7 review: past the budget even at the sparsest level (pins never shrink), the payload trim fills each
    band's share, so a band that fits keeps its molecule whatever another band's pins hold."""
    bam = write_bam(env.tmp / "trim.bam", lambda h: [
        *[make_record(h, f"mat_{i:03d}", MAT, 100 + i * 10, "500M", tags=[("ns", _u32([50])), ("nl", _u32([150]))])
          for i in range(60)],
        make_record(h, "pat_only", PAT, 100, "500M", tags=[("ns", _u32([50])), ("nl", _u32([150]))])])
    did = _add_lifted(env, paths=[bam], dataset_id="trim")
    paths = [{"binding": "mat", "windows": [{"start": 0, "end": 1500}]}, {"binding": "pat", "windows": [{"start": 0, "end": 1000}]}]
    monkeypatch.setattr(gr, "MAX_DECODED_BYTES", 5_000)
    out = _reads(env, [did], paths, pins=[f"mat_{i:03d}" for i in range(20)]).json()
    bands = {b["binding"]: b for b in out["report"]["bands"]}
    assert bands["pat"]["molecules"] == 1
    assert [r["q"] for r in out["reads"] if r["b"] == "pat"] == ["pat_only"]
    # MAT's pins over its share: reported (trimmed from the payload, or never decoded past the budget: item 8).
    omitted = out["report"]["omitted"]
    assert omitted.get("payload_limit", 0) + omitted.get("records_not_reached", 0) > 0


def test_a_molecules_strand_is_resolved_as_linear_cohorts_resolve_it(env):
    """Codex G8 review: the first explicit call, primary first (an explicit '.' means none and wins over a
    supplementary's call); else the majority of the molecule's marks across its records."""
    daf = write_bam(env.tmp / "dafdot.bam", lambda h: [
        make_record(h, "dot", MAT, 100, "500M", tags=[("ns", _u32([50])), ("nl", _u32([150])), ("st", ".")]),
        make_record(h, "dot", MAT, 900, "300M", flag=2048, tags=[("ns", _u32([50])), ("nl", _u32([150])), ("st", "GA")])])
    did = _add_lifted(env, paths=[daf], dataset_id="dafdot")
    out = _reads(env, [did], [{"binding": "mat", "windows": [{"start": 0, "end": 1500}]}]).json()
    assert [r.get("ds") for r in out["reads"] if r["q"] == "dot"] == [None, None]
    assert not any(k.startswith("_ds") for r in out["reads"] for k in r)     # evidence never on the wire
    # Inferred: one C>T mark on the primary, three G>A on its supplementary: G>A for both (marks pooled).
    base = dict(d="x", lib=0, q="m", b="mat")
    rows = [dict(base, k="1", rec="a", sup=False, _dse=[[10, 1]]), dict(base, k="2", rec="b", sup=True, _dse=[[50, 0], [60, 0], [70, 0]])]
    gr.resolve_molecule_strands(rows)
    assert [r["ds"] for r in rows] == ["GA", "GA"] and not any("_dse" in r for r in rows)
    tie = [dict(base, k="1", rec="a", sup=False, _dse=[[1, 1], [2, 1], [3, 0], [4, 0]])]
    gr.resolve_molecule_strands(tie)
    assert "ds" not in tie[0]
    # Overlapping records repeat marks: each counts once (2 C>T, 3 G>A: G>A).
    dup = [dict(base, k="1", rec="a", sup=False, _dse=[[1, 1], [2, 1], [5, 0], [6, 0], [7, 0]]),
           dict(base, k="2", rec="b", sup=True, _dse=[[1, 1], [2, 1]])]
    gr.resolve_molecule_strands(dup)
    assert [r["ds"] for r in dup] == ["GA", "GA"]
    # A hidden supplementary's evidence still decides (it is not drawn).
    shown = [dict(base, k="1", rec="a", sup=False, _dse=[[10, 1]])]
    gr.resolve_molecule_strands(shown, evidence_only=[dict(base, k="2", rec="b", sup=True, _dse=[[50, 0], [60, 0], [70, 0]])])
    assert shown[0]["ds"] == "GA"


def test_strand_evidence_is_independent_of_the_decode_origin(env):
    """Graph features review (Codex and agy, step 1): a record's marks are cached at their contig and absolute source
    position, so a molecule's strand is the same whether its records were decoded together or by separate windows
    (a pan): overlapping records' repeated marks count once, and distinct marks never collide."""
    def seq(n, marks):
        out = list("C" * n)
        for off, base in marks:
            out[off] = base
        return "".join(out)
    tags = [("ns", _u32([50])), ("nl", _u32([150]))]
    daf = write_bam(env.tmp / "origin.bam", lambda h: [
        # 3 G>A (R) and 2 C>T (Y) on the primary; the supplementary repeats the 2 C>T: G>A.
        make_record(h, "ov", MAT, 1000, "600M", tags=tags, seq=seq(600, [(10, "R"), (20, "R"), (30, "R"), (300, "Y"), (400, "Y")])),
        make_record(h, "ov", MAT, 1200, "600M", flag=2048, tags=tags, seq=seq(600, [(100, "Y"), (200, "Y")])),
        # 2 C>T and 2 G>A on the primary, 1 more C>T on a supplementary elsewhere: C>T.
        make_record(h, "col", MAT, 3000, "500M", tags=tags, seq=seq(500, [(100, "Y"), (200, "Y"), (300, "R"), (400, "R")])),
        make_record(h, "col", MAT, 4000, "500M", flag=2048, tags=tags, seq=seq(500, [(100, "Y")]))])
    did = _add_lifted(env, paths=[daf], dataset_id="origin")

    def strands(*windows):
        out = None
        for w in windows:
            out = _reads(env, [did], [{"binding": "mat", "windows": [{"start": w[0], "end": w[1]}]}]).json()
        return {(r["q"], r["sup"]): r.get("ds") for r in out["reads"]}
    gr.clear_cache()
    cold = strands((900, 4600))
    assert cold[("ov", False)] == cold[("ov", True)] == "GA"
    assert cold[("col", False)] == cold[("col", True)] == "CT"
    gr.clear_cache()
    panned = strands((1000, 1150), (1150, 1900))      # the primary cached first, its supplementary at another origin
    assert panned[("ov", False)] == panned[("ov", True)] == "GA"
    gr.clear_cache()
    panned = strands((3900, 4600), (2900, 4600))      # the supplementary first
    assert panned[("col", False)] == panned[("col", True)] == "CT"


def test_the_sparsest_level_draws_the_same_reads_within_budget_on_repeat(env, monkeypatch):
    """agy G7 review (graph features, item 8): at the sparsest level a decode truncated by the byte budget caches
    its first slice; a repeat of the request decoded the next slice too and drew more. The decode's allowance is
    the budget less what the band already holds, so a repeat draws the same reads and decodes nothing new."""
    bam = write_bam(env.tmp / "sparsest.bam", lambda h: [
        make_record(h, f"r{i:03d}", MAT, 100 + i * 10, "500M", tags=[("ns", _u32([50])), ("nl", _u32([150]))])
        for i in range(30)])
    did = _add_lifted(env, paths=[bam], dataset_id="sparsest")
    paths = [{"binding": "mat", "windows": [{"start": 0, "end": 1000}]}]
    monkeypatch.setattr(gr, "MAX_LEVEL", 0)
    monkeypatch.setattr(gr, "MAX_DECODED_BYTES", 4_000)
    first = _reads(env, [did], paths).json()
    assert first["report"]["truncated"]
    q1 = sorted(r["q"] for r in first["reads"])
    assert 0 < len(q1) < 30
    for _ in range(3):
        again = _reads(env, [did], paths).json()
        assert sorted(r["q"] for r in again["reads"]) == q1
        assert again["report"]["decoded_bytes"] <= first["report"]["decoded_bytes"]


def test_a_supplementary_keeps_its_molecules_strand_from_another_window(env):
    """Graph features, item 7 (agy G8 review): a supplementary with no strand evidence of its own, whose primary is
    outside the window, takes the strand its molecule was called with before (the session's cross-window strand
    cache, shared with linear views), as a linear row does."""
    def seq(n, marks):
        out = list("C" * n)
        for off, base in marks:
            out[off] = base
        return "".join(out)
    tags = [("ns", _u32([50])), ("nl", _u32([150]))]
    daf = write_bam(env.tmp / "far.bam", lambda h: [
        make_record(h, "far", MAT, 100, "500M", tags=tags, seq=seq(500, [(10, "Y"), (20, "Y"), (30, "Y")])),
        make_record(h, "far", MAT, 3000, "400M", flag=2048, tags=tags)])
    did = _add_lifted(env, paths=[daf], dataset_id="far")
    gr.clear_cache()
    env.state._read_strand_calls = {}
    alone = _reads(env, [did], [{"binding": "mat", "windows": [{"start": 2900, "end": 3500}]}]).json()
    assert [r.get("ds") for r in alone["reads"] if r["q"] == "far"] == [None]      # never called: no strand
    whole = _reads(env, [did], [{"binding": "mat", "windows": [{"start": 0, "end": 3500}]}]).json()
    assert [r.get("ds") for r in whole["reads"] if r["q"] == "far"] == ["CT", "CT"]
    gr.clear_cache()
    again = _reads(env, [did], [{"binding": "mat", "windows": [{"start": 2900, "end": 3500}]}]).json()
    assert [r.get("ds") for r in again["reads"] if r["q"] == "far"] == ["CT"]      # the molecule's call, cached
    # The cache is the linear views' (keyed by molecule): a linear lifted view of the molecule called it the same.
    (key,) = [k for k in env.state._read_strand_calls[did]]
    assert key.endswith("|far") and env.state._read_strand_calls[did][key] == "CT"


def test_a_cross_haplotype_supplementary_is_on_its_own_contigs_band(env):
    """Graph features, item 7 (thin report MED 1): a MAT supplementary of a PAT molecule is drawn on the MAT path,
    in the MAT haplotype's band (its own contig's), where its coordinates are; its primary is on PAT."""
    bam = write_bam(env.tmp / "xhap.bam", lambda h: [
        make_record(h, "split", MAT, 2000, "20S100M", flag=2048, tags=[("ns", _u32([30])), ("nl", _u32([50])),
                                                                     ("SA", f"{PAT},2001,+,100M20S,60,0;")]),
        make_record(h, "split", PAT, 2000, "100M20S", tags=[("ns", _u32([30])), ("nl", _u32([50]))])])
    did = _add_lifted(env, paths=[bam], dataset_id="xhap")
    out = _reads(env, [did], [{"binding": "mat", "windows": [{"start": 0, "end": 10_000}]},
                              {"binding": "pat", "windows": [{"start": 0, "end": 10_000}]}]).json()
    split = {(r["b"], r["sup"]): r for r in out["reads"] if r["q"] == "split"}
    assert split[("mat", True)]["hap"].upper() == "MAT" and split[("mat", True)]["c"] == MAT
    assert split[("pat", False)]["hap"].upper() == "PAT"
    # One molecule: the same record key family, so selection and hover reach both rows.
    assert split[("mat", True)]["rk"] != split[("pat", False)]["rk"]
    assert split[("mat", True)]["aid"].split('"')[1] == split[("pat", False)]["aid"].split('"')[1]


def test_a_supplementary_alone_takes_its_primarys_explicit_strand(env):
    """Codex review (group A): a supplementary drawn without its primary (another window) takes the primary's
    explicit st:Z call, found through its SA locus as linear rows find it, or from the strand cache once seen."""
    tags = [("ns", _u32([50])), ("nl", _u32([150]))]
    daf = write_bam(env.tmp / "explicit.bam", lambda h: [
        make_record(h, "expl", MAT, 100, "500M", tags=[*tags, ("st", "CT")]),
        make_record(h, "expl", MAT, 3000, "400M", flag=2048, tags=[*tags, ("SA", f"{MAT},101,+,500M,60,0;")])])
    did = _add_lifted(env, paths=[daf], dataset_id="explicit")
    gr.clear_cache()
    env.state._read_strand_calls = {}
    alone = _reads(env, [did], [{"binding": "mat", "windows": [{"start": 2900, "end": 3500}]}]).json()
    assert [r.get("ds") for r in alone["reads"] if r["q"] == "expl"] == ["CT"]
    assert not any(k.startswith("_ds") for r in alone["reads"] for k in r)


def test_graph_rows_carry_their_soft_clips(env):
    """Graph features, item 5: a record's soft clips (the loader's SV events of type S) are on its graph row, at the
    source boundary with their length and side, as the read tracks draw them."""
    bam = write_bam(env.tmp / "clips.bam", lambda h: [
        make_record(h, "clp", MAT, 1000, "80S400M60S", tags=[("ns", _u32([50])), ("nl", _u32([150]))]),
        make_record(h, "none", MAT, 2000, "400M", tags=[("ns", _u32([50])), ("nl", _u32([150]))])])
    did = _add_lifted(env, paths=[bam], dataset_id="clips")
    out = _reads(env, [did], [{"binding": "mat", "windows": [{"start": 0, "end": 3000}]}]).json()
    by = {r["q"]: r for r in out["reads"]}
    assert by["clp"]["clips"] == [[1000, 80, "L"], [1400, 60, "R"]]
    assert "clips" not in by["none"]
