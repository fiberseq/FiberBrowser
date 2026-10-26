""""Not a carrier" (-2) in a run with no shared feature needs complete sequence evidence (graph follow-ups: Codex
review of the group B fix). A participant outside every carrier set is labelled -2 only when it carries no
carrier-only sequence of the regions (dropped for too few samples included) and its lack is proven (no repeated or
unresolved column on its path, the target walk resolved); otherwise it is left out with the reason, in the fit and
in durable assignment alike."""
from __future__ import annotations

import copy

from services.graph_panel import analysis, columns as gc

from test_graph_columns import columns, occ, owned, path, plan, topo

# Target [0, 50) walks x (30 bp) then y (20 bp).
NODES = {"x": 30, "y": 20}
TARGET = path("target", [occ("t1", "x", (0, 30), (0, 30)), occ("t2", "y", (30, 50), (0, 20))])
# A walks x only; y is proven absent (the plan owns the stretch as a target insertion).
A = path("a", [occ("a1", "x", (0, 30), (0, 30))], plan=plan(owned(0, 30), owned(30, 50, kind="target_insertion")))


def _geometry(b_path):
    rc = columns({"a": [topo(NODES, [TARGET, A])], "b": [topo(NODES, [TARGET, b_path])]}, 0, 50,
                 [("A", "a"), ("B", "b")])
    return [rc], gc.stage_plan([rc], ["A", "B"])


def test_a_repeated_carrier_whose_own_feature_is_dropped_is_not_a_non_carrier():
    """Codex's probe: B walks x, x, y. It carries y (20 bp: 2 samples, dropped) and x twice (30 repeated columns).
    No shared feature; only A's set is kept. B is not proven to lack x and carries y: never -2."""
    b = path("b", [occ("b1", "x", (0, 30), (0, 30)), occ("b2", "x", (30, 60), (0, 30)), occ("b3", "y", (60, 80), (0, 20))])
    regions, p = _geometry(b)
    assert regions[0].report["repeats"] == {"B": 30} and sorted(regions[0].carried["B"]) == list(range(30, 50))
    assert not p.shared and [cs["carriers"] for cs in p.carrier_sets] == [["A"]]
    assert p.participants == ["A", "B"] and "B" not in p.left_out
    assert "repeated or unresolved" in analysis._unfitted_sequence(regions, p, "B")


def test_a_proven_lack_beside_dropped_own_sequence_is_not_a_non_carrier():
    """B lacks x (proven) but carries y, a carrier-only stretch too short to cluster: it carries the regions'
    sequence, so it is left out with that reason, not labelled -2."""
    b = path("b", [occ("b3", "y", (0, 20), (0, 20))], plan=plan(owned(0, 30, kind="target_insertion"), owned(30, 50)))
    regions, p = _geometry(b)
    assert regions[0].report["absent"]["B"] == 30 and not regions[0].report["repeats"]
    assert [cs["carriers"] for cs in p.carrier_sets] == [["A"]] and "B" not in p.left_out
    assert "too short to cluster" in analysis._unfitted_sequence(regions, p, "B")


def test_complete_evidence_still_allows_not_a_carrier():
    """The control: a participant that carries no carrier-only sequence and has every column resolved (here B walks
    what A walks, y proven absent on both)."""
    regions, p = _geometry(path("b", [occ("b1", "x", (0, 30), (0, 30))],
                                plan=plan(owned(0, 30), owned(30, 50, kind="target_insertion"))))
    assert analysis._unfitted_sequence(regions, p, "B") is None
    # The same participant with an unresolved target walk in the region: not proven.
    report = copy.deepcopy(regions[0].report)
    report["target_unresolved"] = 3
    rc = gc.RegionColumns(0, 0, 50, regions[0].features, report, regions[0].carried, regions[0].walk)
    assert analysis._unfitted_sequence([rc], p, "B")


def _run_and_assign(monkeypatch, regions, p):
    """``analysis.run`` and ``analysis.assign`` on this geometry, with only row loading and the engine substituted:
    A's one read is fitted (label 0); B's one read spans its columns."""
    import services.correspondence_clustering as cc
    import types
    monkeypatch.setattr(analysis, "build_geometry", lambda spec, tiles: (regions, p))
    monkeypatch.setattr(analysis, "observation_snapshot", lambda state, spec: {})
    monkeypatch.setattr(analysis, "_windows", lambda spec, features, oids, read_ids=None: ([], {}))
    monkeypatch.setattr(analysis, "_request", lambda *a, **k: types.SimpleNamespace())
    monkeypatch.setattr(analysis, "_refine", lambda *a, **k: ([], [], set()))
    monkeypatch.setattr(cc, "run", lambda *a, **k: {"results": {"A": {"assignments": {"a-read": 0}}}, "model": {}})
    row = {"id": "b-read", "analysis_id": "b-read", "intervals": [[0, 10_000, 10_000]]}
    monkeypatch.setattr(analysis, "graph_window_rows", lambda *a, **k: ([dict(row)], {}))
    spec = {"target": "target", "regions": [{"start": 0, "end": 50, "mode": "accessibility"}],
            "observations": [dict(id=i, dataset_id="d", kind="graph", binding=b, contig=b, read_ids=None, strand=None)
                             for i, b in (("A", "a"), ("B", "b"))],
            "options": {"insertions": True, "carrier_features": "refine", "carrier_min_samples": 3}}
    reg = types.SimpleNamespace(revisions={"r": 1})
    fit = analysis.run(None, reg, {"method": "kmeans"}, {}, spec)
    model = dict(stages=fit["stages"], label_ids=fit["label_ids"], settings=fit["settings"], revisions=fit["revisions"])
    again = analysis.assign(None, reg, {"run": model}, {}, spec)
    return fit["results"]["B"], again["results"]["B"]


def test_fit_and_assignment_leave_codexs_repeated_carrier_unlabelled(monkeypatch):
    b = path("b", [occ("b1", "x", (0, 30), (0, 30)), occ("b2", "x", (30, 60), (0, 30)), occ("b3", "y", (60, 80), (0, 20))])
    fit, again = _run_and_assign(monkeypatch, *_geometry(b))
    assert fit["assignments"] == {} and not fit.get("not_carrier") and "repeated or unresolved" in fit["left_out"]
    assert again["assignments"] == {} and not again.get("not_carrier")


def test_fit_and_assignment_label_a_proven_non_carrier(monkeypatch):
    """The control through the same pipeline: complete evidence, -2 in the fit and on assignment."""
    regions, p = _geometry(path("b", [occ("b1", "x", (0, 30), (0, 30))],
                                plan=plan(owned(0, 30), owned(30, 50, kind="target_insertion"))))
    # Recast as a run with no shared feature whose only carrier set is A's (B carries nothing carrier-only).
    from dataclasses import replace
    feats = [replace(f, carriers=["A"]) for f in p.shared]
    p = replace(p, shared=[], carrier_sets=[{"carriers": ["A"], "features": feats}])
    fit, again = _run_and_assign(monkeypatch, regions, p)
    assert fit["not_carrier"] and fit["assignments"] == {"b-read": analysis.NOT_CARRIER}
    assert again["assignments"] == {"b-read": analysis.NOT_CARRIER}


# ── Proven deletions (_absent_path_labels; agy's review of the group B fix) ──────────────────────────────────

class _Dataset:
    id, paths, path, data_type, live_lift, cluster_feature_settings = "d", ["/fake/a.bam"], "/fake/a.bam", "bam", None, {}


class _State:
    def __init__(self):
        self.datasets = {"d": _Dataset()}
        self.signal_quality_filters = []

    def get_dataset(self, ds_id):
        return self.datasets.get(ds_id)


def _obs(i, binding):
    return {"id": i, "dataset_id": "d", "kind": "graph", "binding": binding, "contig": "c" + binding, "read_ids": None,
            "strand": None}


def _spec(regions, *obs, **options):
    return {"target": "target", "regions": [{"start": a, "end": b, "mode": "accessibility"} for a, b in regions],
            "observations": list(obs),
            "options": {"insertions": True, "carrier_features": "refine", "carrier_min_samples": 3, **options}}


def _columns_of(tiles, spec, oid, binding):
    res = [r for per in tiles.values() for r in per.values()]
    return [gc.region_columns(i, r["start"], r["end"], "target", gc.merge_occurrences(res, "target"),
                              [gc.Observation(oid, binding)], {binding: gc.merge_occurrences(res, binding)}, tiles)
            for i, r in enumerate(spec["regions"])]


def test_a_flank_repeated_elsewhere_on_the_path_is_not_a_proven_junction(monkeypatch):
    """agy probe 1b: the target walks nL, nDup, nDel, nR; the path walks nL, nR (adjacent) and elsewhere two copies
    of nDup around its own allele. In the region (nDel) it is cleanly absent, but nDup (between the flanks) is
    repeated on the path, so the adjacent flanks prove no deletion: no -2."""
    nodes = {"nL": 100, "nDup": 400, "nDel": 50, "nR": 100, "nAlt": 50}
    t = path("target", [occ("t1", "nL", (0, 100), (0, 100)), occ("t2", "nDup", (100, 500), (0, 400)),
                        occ("t3", "nDel", (500, 550), (0, 50)), occ("t4", "nR", (550, 650), (0, 100))])
    p = path("pat", [occ("p1", "nL", (0, 100), (0, 100)), occ("p2", "nR", (100, 200), (0, 100)),
                     occ("p3", "nDup", (800, 1200), (0, 400)), occ("p4", "nAlt", (1200, 1250), (0, 50)),
                     occ("p5", "nDup", (1250, 1650), (0, 400))], plan=plan(owned(0, 650)))
    tiles = {"pat": {0: topo(nodes, [t, p])}}
    spec = _spec([(500, 550)], _obs("P", "pat"))
    monkeypatch.setattr(analysis, "graph_window_rows", lambda st, src, a, b, cache=None: (
        [{"id": "r", "analysis_id": "aid", "intervals": [[0, b - a, b - a]]}], {}))
    regions = _columns_of(tiles, spec, "P", "pat")
    assert regions[0].report["absent"] == {"P": 50} and not regions[0].report["repeats"]
    assert analysis._absent_path_labels(_State(), spec, tiles, regions, "P", {}) == {}


def _deletion_tiles():
    """Two plain deletions on the path: target nDel1 [100, 150) and nDel2 [250, 300) between carried flanks."""
    nodes = {"a": 100, "d1": 50, "b": 100, "d2": 50, "c": 100}
    t = path("target", [occ("t1", "a", (0, 100), (0, 100)), occ("t2", "d1", (100, 150), (0, 50)),
                        occ("t3", "b", (150, 250), (0, 100)), occ("t4", "d2", (250, 300), (0, 50)),
                        occ("t5", "c", (300, 400), (0, 100))])
    p = path("pat", [occ("p1", "a", (0, 100), (0, 100)), occ("p2", "b", (100, 200), (0, 100)),
                     occ("p3", "c", (200, 300), (0, 100))],
             plan=plan(owned(0, 100), owned(100, 150, kind="target_insertion"), owned(150, 250),
                       owned(250, 300, kind="target_insertion"), owned(300, 400)))
    return {"pat": {0: topo(nodes, [t, p])}}


def test_a_read_must_span_every_regions_junction(monkeypatch):
    """Two proven deletions: a read spanning both junctions is -2; one spanning only the first is not judged."""
    tiles = _deletion_tiles()
    spec = _spec([(100, 150), (250, 300)], _obs("P", "pat"))

    def rows(st, src, a, b, cache=None):   # path junctions at 99|100 and 199|200
        both = {"id": "both", "analysis_id": "both", "intervals": [[0, 400, 400]]}
        first = {"id": "first", "analysis_id": "first", "intervals": [[0, 150 - a, 150 - a]]}
        return [{**both, "intervals": [[50 - a, 260 - a, 210]]}, first], {}
    monkeypatch.setattr(analysis, "graph_window_rows", rows)
    regions = _columns_of(tiles, spec, "P", "pat")
    assert analysis._absent_path_labels(_State(), spec, tiles, regions, "P", {}) == {"both": analysis.NOT_CARRIER}
    # The single proven deletion alone still labels both reads that span it.
    one = _spec([(100, 150)], _obs("P", "pat"))
    assert analysis._absent_path_labels(_State(), one, tiles, _columns_of(tiles, one, "P", "pat")[:1], "P", {}) == {
        "both": analysis.NOT_CARRIER, "first": analysis.NOT_CARRIER}


def test_a_sampled_out_carrier_molecule_is_never_not_a_carrier(monkeypatch):
    """agy probe 2: with max_reads, a folded carrier molecule left out of the fit's sample (it covers the region on
    the carrier path; its supplementary spans the deletion junction on the other) is not labelled -2 there; the
    durable assignment labels it on its carrier path, and not -2 either."""
    from services.lift.cohort import _encode_identity
    nodes = {"nL": 100, "nDel": 50, "nR": 100}
    t = path("target", [occ("t1", "nL", (0, 100), (0, 100)), occ("t2", "nDel", (100, 150), (0, 50)),
                        occ("t3", "nR", (150, 250), (0, 100))])
    m = path("mat", [occ("m1", "nL", (0, 100), (0, 100)), occ("m2", "nDel", (100, 150), (0, 50)),
                     occ("m3", "nR", (150, 250), (0, 100))])
    p = path("pat", [occ("p1", "nL", (0, 100), (0, 100)), occ("p3", "nR", (100, 200), (0, 100))],
             plan=plan(owned(0, 100), owned(100, 150, kind="target_insertion"), owned(150, 250)))
    tiles = {"mat": {0: topo(nodes, [t, m])}, "pat": {0: topo(nodes, [t, p])}}
    aids = {q: _encode_identity([f"d|{q}", q, None, 0, "primary"]) for q in ("molA", "molB", "molC")}

    def rows(_st, src, a, b, cache=None):
        w = b - a
        sup = src.binding == "pat"
        return ([{"id": q, "analysis_id": aids[q], "intervals": [[0, w, (-w if q == "molA" and not sup else w)]],
                  "live_lift": {"source": {"supplementary": sup}, "segments": [[0, w, 0, "+", True]]}}
                 for q in ("molA", "molB", "molC")], {})
    monkeypatch.setattr(analysis, "graph_window_rows", rows)
    monkeypatch.setattr(analysis, "observation_snapshot", lambda st, sp: {})
    import types
    spec = _spec([(100, 150)], _obs("obs-M", "mat"), _obs("obs-P", "pat"), coverage_rule="require_all")
    reg = types.SimpleNamespace(revisions={"package": "1"})
    fit = analysis.run(_State(), reg, {"method": "kmeans", "k": 2, "max_reads": 2}, tiles, spec)
    fitted = fit["results"]["obs-M"]["assignments"]
    [out] = [aid for aid in aids.values() if aid not in fitted]   # sampled out of the fit
    assert out not in fit["results"]["obs-P"]["assignments"]
    model = dict(stages=fit["stages"], label_ids=fit["label_ids"], settings=fit["settings"], revisions=fit["revisions"])
    again = analysis.assign(_State(), reg, {"run": model}, tiles, spec)
    assert again["results"]["obs-M"]["assignments"][out] >= 0
    assert out not in again["results"]["obs-P"]["assignments"]


def _alu_package():
    import os
    found = [p for p in os.environ.get("FIBERBROWSER_TEST_GRAPH_PACKAGES", "").split(os.pathsep)
             if p.strip() and os.path.basename(os.path.normpath(p)) == "alu"]
    helper = os.environ.get("FIBERBROWSER_TEST_GRAPH_HELPER", "").strip()
    return (found[0] if found and helper and os.path.isfile(helper) else None), helper


def test_a_replacement_bubble_beside_a_deletion_is_not_a_carrier_on_the_real_helper(monkeypatch, tmp_path):
    """agy probe 1a (real helper, toy ``alu`` package): on ``pat``, target [91,037, 91,058) is a 21 bp plain deletion
    and [70,886, 70,888) a 2 bp replacement bubble. The bubble alone gives no -2; with the deletion in the same run
    the path is still not "not a carrier" (it carries other sequence there), in the fit and on assignment."""
    import asyncio
    import pytest
    from services.graph_panel import reads as greads, service
    from services.lift.cohort import _encode_identity
    package, helper = _alu_package()
    if package is None:
        pytest.skip("set FIBERBROWSER_TEST_GRAPH_HELPER and FIBERBROWSER_TEST_GRAPH_PACKAGES (alu)")
    monkeypatch.setenv("FIBERBROWSER_GRAPH_HELPER", helper)
    monkeypatch.setenv("FIBERBROWSER_GRAPH_REGISTRY", str(tmp_path / "registry.json"))
    monkeypatch.delenv("FIBERBROWSER_GRAPH_PACKAGES", raising=False)
    service.reset_for_tests()
    analysis.clear_caches()

    def rows(_st, src, a, b, cache=None):
        w = b - a
        q = ("m1", "m2") if src.binding == "mat" else ("p1", "p2")
        return ([{"id": x, "analysis_id": _encode_identity([f"d|{x}", x, "r" + x, 0, "primary"]),
                  "intervals": [[0, w, w if x.endswith("2") else -max(1, w // 2)]],
                  "live_lift": {"source": {"supplementary": False}, "segments": [[0, w, 0, "+", True]]}} for x in q], {})
    monkeypatch.setattr(analysis, "graph_window_rows", rows)
    monkeypatch.setattr(analysis, "observation_snapshot", lambda st, sp: {})
    monkeypatch.setattr(greads, "read_bindings", lambda st, reg: [
        {"dataset_id": "d", "kind": "lifted", "paths": {"mat": "cM", "pat": "cP"}}])
    obs = [{"id": "obs-M", "dataset_id": "d", "kind": "graph", "binding": "mat"},
           {"id": "obs-P", "dataset_id": "d", "kind": "graph", "binding": "pat"}]

    def body(regions):
        return {"target": "target", "regions": [{"start": a, "end": b, "mode": "accessibility"} for a, b in regions],
                "observations": obs, "method": "kmeans", "k": 2}

    async def go():
        try:
            await service.ensure_ready()
            reg = await asyncio.to_thread(service.registry().register, service.helper_status().path, package)
            alone = await analysis.handle(_State(), reg, body([(91_037, 91_058)]))
            both = await analysis.handle(_State(), reg, body([(70_886, 70_888), (91_037, 91_058)]))
            model = dict(stages=both["stages"], label_ids=both["label_ids"], settings=both["settings"],
                         revisions=both["revisions"])
            again = await analysis.handle(_State(), reg, {**body([(70_886, 70_888), (91_037, 91_058)]), "run": model},
                                          mode="assign")
            return alone["results"]["obs-P"], both["results"]["obs-P"], again["results"]["obs-P"]
        finally:
            await service.shutdown()
            service.reset_for_tests()
            analysis.clear_caches()
    alone, both, again = asyncio.run(go())
    assert alone.get("not_carrier") and set(alone["assignments"].values()) == {analysis.NOT_CARRIER}   # the control
    assert not both.get("not_carrier") and both["assignments"] == {}
    assert again["assignments"] == {}
