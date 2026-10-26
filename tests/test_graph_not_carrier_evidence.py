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
