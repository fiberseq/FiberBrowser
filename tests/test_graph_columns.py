"""Graph node columns (DESIGN_GRAPH_PRIMARY §2.3–2.5, graph primary G2) on synthetic helper responses: clip and
orientation formulas, colinear blocks across `-` handles, availability (carried, absent, unresolved), repeats,
occurrences split across tiles, independence from path order and from other regions, and the parent grid continued
into insertions."""
import pytest

from services.graph_panel import columns as gc


def occ(oid, node, span, clip, reverse=False):
    return {"id": oid, "fragment": "f", "node": node, "handle": f"h{node}", "reverse": reverse,
            "path_span": {"start": span[0], "end": span[1]}, "clip": {"start": clip[0], "end": clip[1]}}


def path(binding, occs, *, complete=True, plan=None, coverage=None):
    return {"binding": binding, "windows": [], "complete": complete, "occurrences": occs,
            "coverage": coverage if coverage is not None else [{"span": {"start": 0, "end": 1}, "kind": "covered"}],
            "plan": plan}


def topo(nodes, paths, complete=True):
    return {"nodes": [{"id": n, "length": ln, "selected": True, "context": False} for n, ln in nodes.items()],
            "edges": [], "paths": paths, "complete": complete, "summaries": [], "direct_matches": []}


def owned(t0, t1, s0=0, s1=0, kind="map_block"):
    return {"target": {"start": t0, "end": t1}, "source": {"start": s0, "end": s1}, "chain_ids": ["c"], "strands": ["+"],
            "kind": kind, "correspondence": "map_anchor", "owned": True}


def plan(*cands, summaries=()):
    return {"windows": [], "candidates": list(cands), "summaries": list(summaries)}


def columns(results, start, end, observations, insertions=True):
    """Region columns from ``{binding: [responses]}`` (target included in every response)."""
    allres = [r for rs in results.values() for r in rs]
    target_occs = gc.merge_occurrences(allres, "target")
    path_occs = {b: gc.merge_occurrences(rs, b) for b, rs in results.items()}
    cells = {b: {gc.CELL_BP and (start // gc.CELL_BP): rs[0]} for b, rs in results.items()}
    obs = [gc.Observation(i, b) for i, b in observations]
    return gc.region_columns(0, start, end, "target", target_occs, obs, path_occs, cells, insertions=insertions)


def blocks_of(rc, oid):
    feats = rc.target_features([oid])
    return feats[0].blocks[oid]


# ── Clip and orientation formulas ────────────────────────────────────────────

def test_forward_and_reverse_partial_clips_map_exactly():
    # Node n (length 10). Target walks it forward over [100, 110); the source walks it reversed over [500, 510),
    # with an asymmetric traversal clip [1, 7): node-forward [3, 9).
    t = path("target", [occ("t1", "n", (100, 110), (0, 10))])
    s = path("s", [occ("s1", "n", (500, 510), (1, 7), reverse=True)])
    rc = columns({"s": [topo({"n": 10}, [t, s])]}, 100, 110, [("o", "s")])
    carried = rc.carried["o"]
    # Node-forward offsets 3..8 are carried: target 103..108 <-> source 510-1-o = 506..501, reversed.
    assert sorted(carried) == [3, 4, 5, 6, 7, 8]
    assert all(carried[u] == (509 - u, True) for u in carried)
    assert blocks_of(rc, "o") == [(3, 9, 501, 507, True)]


def test_reverse_target_handle_and_forward_source_are_one_reversed_block():
    # The target walks n reversed (a `-` handle) with an asymmetric clip; the source forward.
    t = path("target", [occ("t1", "n", (200, 220), (2, 15), reverse=True)])   # node-forward [5, 18)
    s = path("s", [occ("s1", "n", (0, 20), (0, 20))])
    rc = columns({"s": [topo({"n": 20}, [t, s])]}, 200, 220, [("o", "s")])
    c = rc.carried["o"]
    # target t <-> node-forward o = 219 - t; source position o.
    assert sorted(c) == list(range(2, 15))
    assert all(c[u] == (219 - (200 + u), True) for u in c)
    assert len(blocks_of(rc, "o")) == 1


def test_minus_handles_along_a_non_inverted_walk_stay_one_colinear_run():
    # Both paths walk n1, n2 with `-` handles (the same orientation): relative orientation is forward.
    t = path("target", [occ("t1", "a", (0, 10), (0, 10), True), occ("t2", "b", (10, 20), (0, 10), True)])
    s = path("s", [occ("s1", "a", (50, 60), (0, 10), True), occ("s2", "b", (60, 70), (0, 10), True)])
    rc = columns({"s": [topo({"a": 10, "b": 10}, [t, s])]}, 0, 20, [("o", "s")])
    assert blocks_of(rc, "o") == [(0, 20, 50, 70, False)]


def test_inversion_maps_base_for_base_in_reverse():
    t = path("target", [occ("t1", "x", (0, 10), (0, 10)), occ("t2", "inv", (10, 40), (0, 30)),
                        occ("t3", "y", (40, 50), (0, 10))])
    s = path("s", [occ("s1", "x", (0, 10), (0, 10)), occ("s2", "inv", (10, 40), (0, 30), reverse=True),
                   occ("s3", "y", (40, 50), (0, 10))])
    rc = columns({"s": [topo({"x": 10, "inv": 30, "y": 10}, [t, s])]}, 0, 50, [("o", "s")])
    assert blocks_of(rc, "o") == [(0, 10, 0, 10, False), (10, 40, 10, 40, True), (40, 50, 40, 50, False)]
    c = rc.carried["o"]
    assert c[10] == (39, True) and c[39] == (10, True)


# ── Availability ─────────────────────────────────────────────────────────────

def test_deletion_is_absent_and_an_unplanned_window_unresolved():
    nodes = {"a": 10, "d": 5, "b": 10}
    t = path("target", [occ("t1", "a", (0, 10), (0, 10)), occ("t2", "d", (10, 15), (0, 5)), occ("t3", "b", (15, 25), (0, 10))])
    s_occs = [occ("s1", "a", (0, 10), (0, 10)), occ("s3", "b", (10, 20), (0, 10))]
    planned = plan(owned(0, 10), owned(10, 15, kind="target_insertion"), owned(15, 25))
    rc = columns({"s": [topo(nodes, [t, path("s", s_occs, plan=planned)])]}, 0, 25, [("o", "s")])
    assert rc.report["absent"] == {"o": 5} and not rc.report["unresolved"]
    # The same walk with no plan (an unplanned window): unresolved, never absent.
    rc = columns({"s": [topo(nodes, [t, path("s", s_occs, plan=None)])]}, 0, 25, [("o", "s")])
    assert rc.report["unresolved"] == {"o": 5} and not rc.report["absent"]
    # A plan summary, an uncovered portion or an unowned candidate also leave it unresolved.
    for p in (path("s", s_occs, plan=plan(owned(0, 25), summaries=[{"reason": "limit"}])),
              path("s", s_occs, plan=plan(owned(0, 25)), coverage=[{"span": {"start": 0, "end": 1}, "kind": "gap"}]),
              path("s", s_occs, plan=plan(owned(0, 25), {**owned(10, 15), "owned": False}))):
        rc = columns({"s": [topo(nodes, [t, p])]}, 0, 25, [("o", "s")])
        assert rc.report["unresolved"] == {"o": 5}, p


def test_deleted_stretch_is_carrier_only_on_the_parent_grid():
    nodes = {"a": 20, "d": 30, "b": 20}
    t = path("target", [occ("t1", "a", (0, 20), (0, 20)), occ("t2", "d", (20, 50), (0, 30)), occ("t3", "b", (50, 70), (0, 20))])
    keep = path("k", [occ("k1", "a", (0, 20), (0, 20)), occ("k2", "d", (20, 50), (0, 30)), occ("k3", "b", (50, 70), (0, 20))])
    lose = path("l", [occ("l1", "a", (0, 20), (0, 20)), occ("l3", "b", (20, 40), (0, 20))],
                plan=plan(owned(0, 20), owned(20, 50, kind="target_insertion"), owned(50, 70)))
    rc = columns({"k": [topo(nodes, [t, keep])], "l": [topo(nodes, [t, lose])]}, 0, 70, [("K", "k"), ("L", "l")])
    shared, deleted = rc.target_features(["K", "L"])
    assert shared.samples == [0, 10, 50, 60]
    assert deleted.kind == "deleted" and deleted.carriers == ["K"] and deleted.span == (20, 50)
    assert deleted.samples == [20, 30, 40] and deleted.length == 70
    plan_ = gc.stage_plan([rc], ["K", "L"])
    assert [f.kind for f in plan_.shared] == ["target"]
    assert plan_.carrier_sets[0]["carriers"] == ["K"]


def test_repeated_visits_are_unresolved_and_a_split_visit_is_not_a_repeat():
    nodes = {"r": 10}
    t = path("target", [occ("t1", "r", (0, 10), (0, 10))])
    twice = path("s", [occ("s1", "r", (0, 10), (0, 10)), occ("s2", "r", (90, 100), (0, 10))])
    rc = columns({"s": [topo(nodes, [t, twice])]}, 0, 10, [("o", "s")])
    assert rc.report["repeats"] == {"o": 10} and not rc.carried["o"]
    # One visit cut by two tiles (the same occurrence id, two partial clips): merged, carried whole.
    a = topo(nodes, [path("target", [occ("t1", "r", (0, 10), (0, 6))]), path("s", [occ("s1", "r", (40, 50), (0, 6))])])
    b = topo(nodes, [path("target", [occ("t1", "r", (0, 10), (4, 10))]), path("s", [occ("s1", "r", (40, 50), (4, 10))])])
    rc = columns({"s": [a, b]}, 0, 10, [("o", "s")])
    assert sorted(rc.carried["o"]) == list(range(10)) and not rc.report["repeats"]


# ── Independence ─────────────────────────────────────────────────────────────

def _two_paths():
    nodes = {"a": 30, "b": 30, "c": 30}
    t = path("target", [occ("t1", "a", (0, 30), (0, 30)), occ("t2", "b", (30, 60), (0, 30)), occ("t3", "c", (60, 90), (0, 30))])
    p = path("p", [occ("p1", "a", (100, 130), (0, 30)), occ("p2", "b", (130, 160), (0, 30)), occ("p3", "c", (160, 190), (0, 30))])
    q = path("q", [occ("q1", "a", (0, 30), (0, 30), True), occ("q3", "c", (30, 60), (0, 30))],
             plan=plan(owned(0, 30), owned(30, 60, kind="target_insertion"), owned(60, 90)))
    return nodes, t, p, q


def test_columns_do_not_depend_on_path_order_or_selection():
    nodes, t, p, q = _two_paths()
    res = {"p": [topo(nodes, [t, p])], "q": [topo(nodes, [t, q])]}
    one = columns(res, 0, 90, [("P", "p"), ("Q", "q")])
    two = columns({"q": res["q"], "p": res["p"]}, 0, 90, [("Q", "q"), ("P", "p")])
    alone = columns({"p": res["p"]}, 0, 90, [("P", "p")])
    assert one.carried["P"] == two.carried["P"] == alone.carried["P"]
    assert one.carried["Q"] == two.carried["Q"]
    f1 = gc.stage_plan([one], ["P", "Q"])
    f2 = gc.stage_plan([two], ["Q", "P"])
    assert [(f.kind, f.samples, f.blocks) for f in f1.shared] == [(f.kind, f.samples, f.blocks) for f in f2.shared]
    assert [cs["carriers"] for cs in f1.carrier_sets] == [cs["carriers"] for cs in f2.carrier_sets]


def test_adding_a_region_never_changes_another_regions_features():
    nodes, t, p, q = _two_paths()
    res = {"p": [topo(nodes, [t, p])], "q": [topo(nodes, [t, q])]}
    a = columns(res, 0, 40, [("P", "p"), ("Q", "q")])
    b = columns(res, 50, 90, [("P", "p"), ("Q", "q")])
    alone = gc.stage_plan([a], ["P", "Q"])
    both = gc.stage_plan([a, columns(res, 0, 40, [("P", "p"), ("Q", "q")]), b], ["P", "Q"])
    assert (alone.shared[0].samples, alone.shared[0].blocks) == (both.shared[0].samples, both.shared[0].blocks)


def test_a_path_with_no_columns_of_a_region_is_left_out_not_shrinking_the_others():
    nodes, t, p, q = _two_paths()
    empty = path("e", [], plan=None)
    res = {"p": [topo(nodes, [t, p])], "e": [topo(nodes, [t, empty])]}
    rc = columns(res, 0, 90, [("P", "p"), ("E", "e")])
    plan_ = gc.stage_plan([rc], ["E", "P"])
    assert plan_.participants == ["P"] and "E" in plan_.left_out
    assert plan_.shared[0].samples == list(range(0, 90, 10))


# ── Insertions ───────────────────────────────────────────────────────────────

def test_insertion_continues_the_parent_grid_and_shares_nodes_between_carriers():
    # Target: a [0,23) b [23,40). Both haplotypes insert i1 i2 between a and b; Q also has a private SNP node x.
    nodes = {"a": 23, "b": 17, "i1": 12, "i2": 8, "x": 1}
    t = path("target", [occ("t1", "a", (0, 23), (0, 23)), occ("t2", "b", (23, 40), (0, 17))])
    p = path("p", [occ("p1", "a", (0, 23), (0, 23)), occ("p2", "i1", (23, 35), (0, 12)), occ("p3", "i2", (35, 43), (0, 8)),
                   occ("p4", "b", (43, 60), (0, 17))])
    q = path("q", [occ("q1", "a", (0, 23), (0, 23)), occ("q2", "i1", (23, 35), (0, 12)), occ("qx", "x", (35, 36), (0, 1)),
                   occ("q3", "i2", (36, 44), (0, 8)), occ("q4", "b", (44, 61), (0, 17))])
    rc = columns({"p": [topo(nodes, [t, p])], "q": [topo(nodes, [t, q])]}, 0, 40, [("P", "p"), ("Q", "q")])
    ins, private = rc.features
    # Q's private node inside the shared insertion is a feature of its own (Q's block; 1 bp, no sampled position).
    assert private.nodes == ["x"] and private.blocks == {"Q": [(0, 1, 35, 36, False)]} and not private.samples
    assert ins.kind == "insertion" and ins.length == 20 and ins.anchor == (22, 23)
    # Boundary 23: offsets ≡ (10 − 23 mod 10) mod 10 = 7 (mod 10).
    assert ins.samples == [7, 17]
    assert ins.blocks["P"] == [(0, 20, 23, 43, False)]
    assert ins.blocks["Q"] == [(0, 12, 23, 35, False), (12, 20, 36, 44, False)]
    plan_ = gc.stage_plan([rc], ["P", "Q"])
    # Carried by both observations: a shared feature (positions every window carries).
    assert [f.kind for f in plan_.shared] == ["target", "insertion"]
    # With a linear observation (target walk only) it is carrier-only, refined within P and Q.
    rc = columns({"p": [topo(nodes, [t, p])], "q": [topo(nodes, [t, q])]}, 0, 40, [("L", None), ("P", "p"), ("Q", "q")])
    plan_ = gc.stage_plan([rc], ["L", "P", "Q"], carrier_min_samples=1)
    assert [f.kind for f in plan_.shared] == ["target"]
    assert plan_.carrier_sets[0]["carriers"] == ["P", "Q"]
    # Too few samples for the default minimum: dropped and reported.
    rc = columns({"p": [topo(nodes, [t, p])], "q": [topo(nodes, [t, q])]}, 0, 40, [("L", None), ("P", "p"), ("Q", "q")])
    plan_ = gc.stage_plan([rc], ["L", "P", "Q"])
    assert not plan_.carrier_sets and plan_.report["dropped"][0]["kind"] == "insertion"


def test_an_insertion_outside_the_region_or_with_an_open_end_is_not_a_feature():
    nodes = {"a": 23, "b": 17, "i1": 12}
    t = path("target", [occ("t1", "a", (0, 23), (0, 23)), occ("t2", "b", (23, 40), (0, 17))])
    p = path("p", [occ("p1", "a", (0, 23), (0, 23)), occ("p2", "i1", (23, 35), (0, 12)), occ("p4", "b", (35, 52), (0, 17))])
    assert not columns({"p": [topo(nodes, [t, p])]}, 0, 20, [("P", "p")]).features
    open_end = path("p", [occ("p1", "a", (0, 23), (0, 23)), occ("p2", "i1", (23, 35), (0, 12))])
    assert not columns({"p": [topo(nodes, [t, open_end])]}, 0, 40, [("P", "p")]).features


def test_cells_and_tile_intervals_are_fixed():
    assert gc.cells_for(128_655_000, 128_655_100) == [12865]
    assert gc.cells_for(19_990, 20_010) == [1, 2]
    assert gc.tile_interval(12865, None) == (128_648_000, 128_662_000)
    assert gc.tile_interval(0, 5_000) == (0, 5_000)
    with pytest.raises(ValueError):
        columns({}, 0, gc.MAX_FEATURE_BP + 1, [])


# ── Review round 1 (G2): order independence, private sequence, open ends, copies, carrier-only regions ─────────

def _pq(order):
    nodes = {"a": 23, "b": 17, "i1": 12, "i2": 30, "x": 31}
    t = path("target", [occ("t1", "a", (0, 23), (0, 23)), occ("t2", "b", (23, 40), (0, 17))])
    p = path("p", [occ("p1", "a", (0, 23), (0, 23)), occ("p2", "i1", (23, 35), (0, 12)), occ("p3", "i2", (35, 65), (0, 30)),
                   occ("p4", "b", (65, 82), (0, 17))])
    q = path("q", [occ("q1", "a", (0, 23), (0, 23)), occ("q2", "i1", (23, 35), (0, 12)), occ("qx", "x", (35, 66), (0, 31)),
                   occ("q3", "i2", (66, 96), (0, 30)), occ("q4", "b", (96, 113), (0, 17))])
    res = {"p": [topo(nodes, [t, p])], "q": [topo(nodes, [t, q])]}
    obs = [("L", None), ("P", "p"), ("Q", "q")]
    obs = obs if order else list(reversed(obs))
    allres = [r for rs in res.values() for r in rs]
    return gc.region_columns(0, 0, 40, "target", gc.merge_occurrences(allres, "target"), [gc.Observation(i, b) for i, b in obs],
                             {b: gc.merge_occurrences(rs, b) for b, rs in res.items()}, {b: {0: rs[0]} for b, rs in res.items()},
                             binding_order=["target", "p", "q"])


def test_insertion_frames_follow_the_package_binding_order_not_the_request():
    one, two = _pq(True), _pq(False)
    key = lambda rc: [(f.nodes, f.length, f.samples, f.blocks, f.carriers) for f in rc.features]
    assert key(one) == key(two)
    shared, private = one.features
    assert shared.nodes == ["i1", "i2"] and shared.carriers == ["P", "Q"]
    # Q's 31 private bases are a feature carried by Q alone, on the grid continued along Q's walk (12 bases in).
    assert private.nodes == ["x"] and private.carriers == ["Q"] and private.samples == [5, 15, 25]
    plan = gc.stage_plan([one], ["L", "P", "Q"], carrier_min_samples=1)
    assert [cs["carriers"] for cs in plan.carrier_sets] == [["P", "Q"], ["Q"]]


def test_stage_plan_never_changes_the_region_columns():
    rc = _pq(True)
    before = [(f.samples, f.carriers) for f in rc.features]
    gc.stage_plan([rc], ["L", "P"], carrier_min_samples=1)
    again = gc.stage_plan([rc], ["L", "P", "Q"], carrier_min_samples=1)
    assert [(f.samples, f.carriers) for f in rc.features] == before
    assert [cs["carriers"] for cs in again.carrier_sets] == [["P", "Q"], ["Q"]]


def test_runs_across_a_gap_or_with_uncarried_bases_are_not_insertions():
    nodes = {"a": 23, "b": 17, "i1": 12, "i2": 12}
    t = path("target", [occ("t1", "a", (0, 23), (0, 23)), occ("t2", "b", (23, 40), (0, 17))])
    gap = path("p", [occ("p1", "a", (0, 23), (0, 23)), occ("p2", "i1", (23, 35), (0, 12)),
                     occ("p3", "i2", (500, 512), (0, 12)), occ("p4", "b", (512, 529), (0, 17))])
    assert not columns({"p": [topo(nodes, [t, gap])]}, 0, 40, [("P", "p")]).features
    clipped = path("p", [occ("p1", "a", (0, 23), (0, 10)), occ("p2", "i1", (23, 35), (0, 6)), occ("p4", "b", (35, 52), (5, 17))])
    assert not columns({"p": [topo(nodes, [t, clipped])]}, 0, 40, [("P", "p")]).features


def test_a_region_only_carrier_specific_keeps_its_carrier_features_beside_shared_regions():
    nodes = {"l": 40, "r": 40, "s": 40}
    t = path("target", [occ("t1", "l", (0, 40), (0, 40)), occ("t2", "r", (40, 80), (0, 40)), occ("t3", "s", (100, 140), (0, 40))])
    p = path("p", [occ("p1", "l", (0, 40), (0, 40)), occ("p3", "s", (100, 140), (0, 40))],
             plan=plan(owned(0, 40), owned(40, 80, kind="target_insertion"), owned(80, 140)))
    q = path("q", [occ("q2", "r", (40, 80), (0, 40)), occ("q3", "s", (100, 140), (0, 40))],
             plan=plan(owned(0, 40, kind="target_insertion"), owned(40, 140)))
    res = {"p": [topo(nodes, [t, p])], "q": [topo(nodes, [t, q])]}
    halves = columns(res, 0, 80, [("P", "p"), ("Q", "q")])
    both = columns(res, 100, 140, [("P", "p"), ("Q", "q")])
    plan_ = gc.stage_plan([halves, both], ["P", "Q"])
    assert [f.kind for f in plan_.shared] == ["target"] and plan_.shared[0].region == both.region
    assert sorted(cs["carriers"][0] for cs in plan_.carrier_sets) == ["P", "Q"]
    assert any(d["reason"] == "no position every path carries" for d in plan_.report["dropped"])


# ── Review round 2 (G2): frames independent of the selection; columns split by their carrier set ─────────────

def _three(paths):
    """Columns at boundary 23 from tiles of every package path (``paths``: binding -> walk), observing some."""
    nodes = {"a": 23, "b": 17, "i1": 30, "i2": 30, "x": 31}
    t = path("target", [occ("t1", "a", (0, 23), (0, 23)), occ("t2", "b", (23, 40), (0, 17))])
    res = {}
    for b, walk in paths.items():
        occs, pos = [occ(f"{b}a", "a", (0, 23), (0, 23))], 23
        for n in walk:
            occs.append(occ(f"{b}{n}", n, (pos, pos + nodes[n]), (0, nodes[n])))
            pos += nodes[n]
        occs.append(occ(f"{b}b", "b", (pos, pos + 17), (0, 17)))
        res[b] = [topo(nodes, [t, path(b, occs)])]
    allres = [r for rs in res.values() for r in rs]
    def cols(observed):
        return gc.region_columns(0, 0, 40, "target", gc.merge_occurrences(allres, "target"),
                                 [gc.Observation(i, b) for i, b in observed],
                                 {b: gc.merge_occurrences(rs, b) for b, rs in res.items()}, {b: {0: rs[0]} for b, rs in res.items()},
                                 binding_order=["target", *paths])
    return cols


def test_insertion_samples_do_not_depend_on_which_paths_are_in_the_run():
    cols = _three({"p": ["i1", "i2"], "q": ["i1", "x", "i2"]})
    both = cols([("L", None), ("P", "p"), ("Q", "q")])
    alone = cols([("L", None), ("Q", "q")])
    def sampled(rc, oid):
        out = set()
        for f in rc.features:
            for u in f.samples:
                for u0, u1, g0, g1, rev in f.blocks.get(oid, ()):
                    if u0 <= u < u1:
                        out.add(g0 + (u - u0) if not rev else g1 - 1 - (u - u0))
        return sorted(out)
    assert sampled(both, "Q") == sampled(alone, "Q") and sampled(alone, "Q")


def test_a_stretch_only_some_carriers_walk_is_its_own_carrier_only_feature():
    cols = _three({"p": ["i1", "i2"], "q": ["i1"]})
    rc = cols([("L", None), ("P", "p"), ("Q", "q")])
    parts = sorted((f.nodes, f.carriers) for f in rc.features)
    assert parts == [(["i1"], ["P", "Q"]), (["i2"], ["P"])]
    plan_ = gc.stage_plan([rc], ["L", "P", "Q"])
    assert sorted(cs["carriers"] for cs in plan_.carrier_sets) == [["P"], ["P", "Q"]]
