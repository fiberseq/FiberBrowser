"""Graph clustering, backfill review fixes (B1, B4, B8, B9): probes from the review, with the fixed expectations."""
from types import SimpleNamespace

import numpy as np
import pytest

from models.domain import WorkingSet
from models.requests import PeakRegion
from services import correspondence_clustering as fc
from services.graph_panel import analysis
from state.browser_state import BrowserState


def _occ(oid, node, span, clip, reverse=False):
    return {"id": oid, "fragment": "f", "node": node, "handle": f"h{node}", "reverse": reverse,
            "path_span": {"start": span[0], "end": span[1]}, "clip": {"start": clip[0], "end": clip[1]}}


def _path(binding, occs, *, plan=None):
    return {"binding": binding, "windows": [], "complete": True, "occurrences": occs,
            "coverage": [{"span": {"start": 0, "end": 1}, "kind": "covered"}], "plan": plan}


def _topo(nodes, paths):
    return {"nodes": [{"id": n, "length": ln, "selected": True, "context": False} for n, ln in nodes.items()],
            "edges": [], "paths": paths, "complete": True, "summaries": [], "direct_matches": []}


def _owned(t0, t1, s0=0, s1=0, kind="map_block"):
    return {"target": {"start": t0, "end": t1}, "source": {"start": s0, "end": s1}, "chain_ids": ["c"],
            "strands": ["+"], "kind": kind, "correspondence": "map_anchor", "owned": True}


def test_b8_stale_or_stripped_models_are_refused(monkeypatch):
    """Backfill B8: assign() refuses a model fitted on other regions or with its refinements stripped."""
    nodes = {"flank": 40, "onlyA": 40, "onlyB": 40}
    target = _path("ref", [_occ("t1", "flank", (0, 40), (0, 40)),
                           _occ("t2", "onlyA", (40, 80), (0, 40)),
                           _occ("t3", "onlyB", (80, 120), (0, 40))])
    strain_a = _path("hapA", [_occ("a1", "flank", (0, 40), (0, 40)),
                              _occ("a2", "onlyA", (40, 80), (0, 40))],
                     plan={"windows": [], "summaries": [], "candidates": [
                         _owned(0, 80, 0, 80), _owned(80, 120, kind="target_insertion")]})
    strain_b = _path("hapB", [_occ("b1", "flank", (0, 40), (0, 40)),
                              _occ("b2", "onlyB", (40, 80), (0, 40))],
                     plan={"windows": [], "summaries": [], "candidates": [
                         _owned(0, 40, 0, 40), _owned(40, 80, kind="target_insertion"), _owned(80, 120, 40, 80)]})
    tiles = {"hapA": {0: _topo(nodes, [target, strain_a])}, "hapB": {0: _topo(nodes, [target, strain_b])}}

    def fake_rows(state, src, lo, hi, cache):
        span = hi - lo
        mid = max(0, min(span, 40 - lo))
        def split_ivs(first_fp, second_fp):
            out = []
            if mid > 0:
                out.append([0, mid, first_fp])
            if span > mid:
                out.append([mid, span, second_fp])
            return out or [[0, span, first_fp]]
        return ([
            {"id": f"{src.binding}_1", "intervals": split_ivs(0, 0)},
            {"id": f"{src.binding}_2", "intervals": split_ivs(0, 147)},
            {"id": f"{src.binding}_3", "intervals": split_ivs(147, 0)},
            {"id": f"{src.binding}_4", "intervals": split_ivs(147, 147)},
        ], {})

    monkeypatch.setattr(analysis, "graph_window_rows", fake_rows)
    monkeypatch.setattr(analysis, "observation_snapshot", lambda st, sp: {o["id"]: {"rev": 1} for o in sp["observations"]})
    reg = SimpleNamespace(id="reg1", revisions={"package": "1", "graph": "1", "db": "1", "maps": "1"})
    state = BrowserState(None)
    state.datasets = {"d": SimpleNamespace(id="d", live_lift=None)}
    obs = [
        {"id": "obs-a", "dataset_id": "d", "kind": "graph", "binding": "hapA", "contig": "cA", "read_ids": None, "strand": None},
        {"id": "obs-b", "dataset_id": "d", "kind": "graph", "binding": "hapB", "contig": "cB", "read_ids": None, "strand": None},
    ]
    base_spec = {
        "target": "ref", "target_size": 1000, "observations": obs,
        "options": {"repeat_columns": "exclude", "carrier_features": "refine", "coverage_rule": "require_all",
                    "insertions": True, "carrier_min_samples": 3},
    }
    spec_1reg = {**base_spec, "regions": [{"start": 0, "end": 40, "mode": "accessibility"}]}
    spec_2reg = {**base_spec, "regions": [{"start": 0, "end": 40, "mode": "accessibility"},
                                          {"start": 40, "end": 120, "mode": "accessibility"}]}

    fit_1reg = analysis.run(state, reg, {"method": "combinatorial", "k": 2}, tiles, spec=spec_1reg)
    fit_2reg = analysis.run(state, reg, {"method": "combinatorial", "k": 2}, tiles, spec=spec_2reg)
    assert len(fit_1reg["stages"]) == 1 and len(fit_2reg["stages"]) > 1
    assert fit_2reg["results"]["obs-a"]["assignments"]["hapA_1"] != fit_2reg["results"]["obs-a"]["assignments"]["hapA_2"]

    def refused(run, spec):
        with pytest.raises(analysis.GraphRunError) as exc:
            analysis.assign(state, reg, {"run": run}, tiles, spec=spec)
        assert exc.value.code == "stale_model"
    run = lambda fit, stages=None: {"stages": stages or fit["stages"], "label_ids": fit["label_ids"], "settings": fit["settings"],
                                    "revisions": fit["revisions"]}
    refused(run(fit_1reg), spec_2reg)
    refused(run(fit_2reg), spec_1reg)
    refused(run(fit_2reg, [fit_2reg["stages"][0]]), spec_2reg)
    # The model as fitted, on its own geometry: accepted.
    analysis.assign(state, reg, {"run": run(fit_2reg)}, tiles, spec=spec_2reg)


def test_b4_every_stage2_label_has_an_id(monkeypatch):
    """Backfill B4: every stage-2 model label (C<parent>.<k>), used in the fit or not, has an id."""
    rng = np.random.default_rng(1)
    X_fit = rng.choice([0.0, 1.0], size=(6, 4)).astype(np.float32)

    nodes = {"flankL": 20, "ins": 40, "flankR": 20}
    target = _path("ref", [_occ("t1", "flankL", (0, 20), (0, 20)), _occ("t2", "flankR", (20, 40), (0, 20))])
    pa = _path("hapA", [_occ("a1", "flankL", (0, 20), (0, 20)), _occ("a2", "ins", (20, 60), (0, 40)),
                        _occ("a3", "flankR", (60, 80), (0, 20))],
               plan={"windows": [], "summaries": [], "candidates": [_owned(0, 40, 0, 80)]})
    pb = _path("hapB", [_occ("b1", "flankL", (0, 20), (0, 20)), _occ("b2", "flankR", (20, 40), (0, 20))],
               plan={"windows": [], "summaries": [], "candidates": [_owned(0, 40, 0, 40)]})
    tiles = {"hapA": {0: _topo(nodes, [target, pa])}, "hapB": {0: _topo(nodes, [target, pb])}}

    def vec_ivs(vec, lo, hi):
        span = hi - lo
        offset = 20 - lo
        ivs = []
        if offset > 0:
            ivs.append([0, offset, 0])  # open on flankL
        for idx, val in enumerate(vec):
            a, b = offset + idx * 10, offset + (idx + 1) * 10
            if b > 0 and a < span:
                ivs.append([max(0, a), min(span, b), 0 if val >= 0.5 else 147])
        end_cur = ivs[-1][1] if ivs else 0
        if end_cur < span:
            ivs.append([end_cur, span, 0])  # open on flankR
        return ivs or [[0, span, 0]]

    phase = {"mode": "fit", "probe_vec": None}

    def fake_rows(state, src, lo, hi, cache):
        span = hi - lo
        if src.binding == "hapB":
            return ([{"id": f"del_{i}", "intervals": [[0, span, 0]]} for i in range(6)], {})
        rows = [{"id": f"car_{i}", "intervals": vec_ivs(X_fit[i], lo, hi)} for i in range(6)]
        if phase["mode"] == "assign" and phase["probe_vec"] is not None:
            rows.append({"id": "car_new", "intervals": vec_ivs(phase["probe_vec"], lo, hi)})
        return (rows, {})

    monkeypatch.setattr(analysis, "graph_window_rows", fake_rows)
    monkeypatch.setattr(analysis, "observation_snapshot", lambda st, sp: {o["id"]: {"rev": 1} for o in sp["observations"]})
    reg = SimpleNamespace(id="reg1", revisions={"package": "1", "graph": "1", "db": "1", "maps": "1"})
    state = BrowserState(None)
    state.datasets = {"d": SimpleNamespace(id="d", live_lift=None)}
    spec = {
        "target": "ref", "target_size": 1000,
        "regions": [{"start": 0, "end": 40, "mode": "accessibility"}],
        "observations": [
            {"id": "obs-a", "dataset_id": "d", "kind": "graph", "binding": "hapA", "contig": "cA", "read_ids": None, "strand": None},
            {"id": "obs-b", "dataset_id": "d", "kind": "graph", "binding": "hapB", "contig": "cB", "read_ids": None, "strand": None},
        ],
        "options": {"repeat_columns": "exclude", "carrier_features": "refine", "coverage_rule": "require_all",
                    "insertions": True, "carrier_min_samples": 3},
    }
    checked = 0
    for seed in range(1, 40):
        body = {"method": "minibatch", "k": 5, "sample_seed": f"seed-{seed}", "subnucleosomal_threshold": 10}
        fit_out = analysis.run(state, reg, body, tiles, spec=spec)
        for st2 in fit_out["stages"][1:]:
            keys = list((st2["model"].get("centroids") or {}).keys()) + list((st2["model"].get("cluster_patterns") or {}).keys())
            for k in keys:
                assert f"{st2['parent']}.{int(k)}" in fit_out["label_ids"]
                checked += 1
    assert checked > 0


def test_b9_a_folded_molecule_is_arbitrated_across_placements(monkeypatch):
    """Backfill B9: under fold_molecule a graph row (placement 'primary') and a linear row (its chain) of one molecule are
    one folded molecule: arbitrated by record key, fitted once, one label."""
    base = BrowserState(None)
    base.current_genome = "ref"
    base.datasets = {"d": SimpleNamespace(id="d", live_lift=None)}
    base.dataset_order = ["d"]

    aid_graph = 'lift-cohort:v1 ["d#0|mol_shared","mol_shared",null,null,"primary"]'
    aid_linear = 'lift-cohort:v1 ["d#0|mol_shared","mol_shared",null,null,"0"]'

    def working(self, dataset_id, chrom, start, end, spanning=False, min_footprints=0, **kwargs):
        span = end - start
        segs = [[0, span, 0, "+", True]]
        if chrom == "chrA":
            reads = [
                {"id": "mol_shared", "analysis_id": aid_graph, "intervals": [[0, span, 0]],
                 "live_lift": {"molecule": "d#0|mol_shared", "placement": "primary", "segments": segs, "source": {"supplementary": False}}},
                {"id": "mol_open", "analysis_id": 'lift-cohort:v1 ["d#0|mol_open","mol_open",null,null,"primary"]',
                 "intervals": [[0, span, 0]], "live_lift": {"molecule": "d#0|mol_open", "placement": "primary", "segments": segs, "source": {"supplementary": False}}},
            ]
        else:
            reads = [
                {"id": "mol_shared", "analysis_id": aid_linear, "intervals": [[0, span, 147]],
                 "live_lift": {"molecule": "d#0|mol_shared", "placement": "0", "segments": segs, "source": {"supplementary": True}}},
                {"id": "mol_closed", "analysis_id": 'lift-cohort:v1 ["d#0|mol_closed","mol_closed",null,null,"0"]',
                 "intervals": [[0, span, 147]], "live_lift": {"molecule": "d#0|mol_closed", "placement": "0", "segments": segs, "source": {"supplementary": False}}},
            ]
        return WorkingSet(reads, total_overlapping=len(reads), total_spanning=len(reads), chrom=chrom, start=start, end=end)

    monkeypatch.setattr(BrowserState, "build_working_set", working)
    v_a = fc.RegionViewport(dataset_id="d", result_key="obs-a", chrom="chrA", start=100, end=300,
                            blocks=[fc.FrameBlock(frame=(0, 100), genomic=(100, 200))])
    v_b = fc.RegionViewport(dataset_id="d", result_key="obs-b", chrom="chrB", start=100, end=300,
                            blocks=[fc.FrameBlock(frame=(0, 100), genomic=(100, 200))])
    out = fc.run(base, fc.RegionClusterRequest(viewports=[v_a, v_b], peak_regions=[PeakRegion(start=0, end=100)],
                                               method="combinatorial", k=2))
    # Fitted once (the primary record's row), its other path's row showing the same label under its own identity.
    assert (out.get("joint_cohort") or {}).get("shared_molecules_within_dataset") == 1
    assert out["results"]["obs-a"]["assignments"][aid_graph] == out["results"]["obs-b"]["assignments"][aid_linear]


def test_b1_a_model_hashes_alike_after_a_trip_through_the_browser():
    """Backfill B1: the browser's JSON.stringify writes 0 for 0.0; a model with integral floats hashes alike after a
    round trip through node (it was refused as stale)."""
    import json, shutil, subprocess
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    model = {"centroids": {0: [0.0, 1.0, 0.5], 1: [2.0, 0.25, 1e-7]}, "peak_widths": [3], "labels": {"0": 0}}
    wire = subprocess.run([node, "-e", "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.stringify(JSON.parse(s))))"],
                          input=json.dumps(model), capture_output=True, text=True, check=True).stdout
    assert "0.0" not in wire
    assert analysis._model_hash(json.loads(wire)) == analysis._model_hash(model)
