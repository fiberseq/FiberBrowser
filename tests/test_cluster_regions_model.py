"""/api/cluster-regions G0 items the graph clustering phases need (DESIGN_GRAPH_PRIMARY §2.5, §2.6, §3.5): a missing
element (-1) is never counted open, ``sample_positions`` choose the sampled frame positions, the fitted model (centres
from the fit rows, under the returned labels; or patterns) and the settings snapshot are returned, and the model
assigns its own fit rows to their labels."""
from types import SimpleNamespace

import numpy as np
import pytest

from models.domain import WorkingSet
from models.requests import PeakRegion
from services import correspondence_clustering as fc
from services.cluster_assignment import cluster_compact_reads
from state.browser_state import BrowserState


def window(key, start=100, blocks=None, **kw):
    return fc.RegionViewport(dataset_id="d", result_key=key, chrom="chr1", start=start, end=start + 200,
                             blocks=blocks or [fc.FrameBlock(frame=(0, 100), genomic=(start, start + 100))], **kw)


@pytest.fixture
def state(monkeypatch):
    base = BrowserState(None)
    base.datasets = {"d": SimpleNamespace(data_type="bam")}
    base.dataset_order = ["d"]

    def working(self, dataset_id, chrom, start, end, *args, **kwargs):
        # Three states over the first 100 bp: open 0-30, open 0-60, closed; window b has more reads than a.
        n = 30 if start == 100 else 90
        reads = []
        for i in range(n):
            cut = (30, 60, 0)[i % 3]
            ivs = ([[0, cut, 0]] if cut else []) + [[cut, end - start, 147]]
            reads.append(dict(id=f"{start}-{i}", intervals=ivs))
        return WorkingSet(reads, total_overlapping=n, total_spanning=n, chrom=chrom, start=start, end=end)

    monkeypatch.setattr(BrowserState, "build_working_set", working)
    return base


def test_missing_elements_are_not_open():
    """A window without a member-specific feature has -1 there: never listed as open (element_read_ids), never a
    True peak state."""
    reads = [dict(id="a", intervals=[[0, 200, 0]], _cluster_group="has"),
             dict(id="b", intervals=[[0, 200, 0]], _cluster_group="lacks")]
    groups = {"has": ([(0, 100), (100, 200)], 0, {}), "lacks": ([(0, 100), (100, 200)], 0, {})}
    _a, _c, _o, info = cluster_compact_reads(reads, [(0, 100), (100, 200)], 0, 2, method="combinatorial",
                                             window_groups=groups, missing_feature_groups={"lacks": [1]})
    assert info["element_read_ids"][1] == ["a"]
    states = {tuple(c["pattern"]): c["peak_states"] for c in info["clusters"].values()}
    assert states[(1, -1)] == {"peak_0": True, "peak_1": False}


def test_sample_positions_choose_the_sampled_frame_positions():
    req = fc.RegionClusterRequest(viewports=[window("a")], peak_regions=[PeakRegion(start=0, end=100)],
                                  method="kmeans", k=2, sample_positions=[[7, 17, 27]])
    _lengths, positions = fc.common_geometry(req)
    assert positions == [[7, 17, 27]]
    for bad in ([[17, 7]], [[7, 7]], [[100]], [[1], [2]]):
        with pytest.raises(ValueError, match="Sample positions"):
            fc.common_geometry(req.model_copy(update={"sample_positions": bad}))


def test_balanced_kmeans_returns_the_fitted_centres_and_they_reassign_their_rows(state):
    req = fc.RegionClusterRequest(viewports=[window("a"), window("b", start=1000)], peak_regions=[PeakRegion(start=0, end=100)],
                                  method="kmeans", k=3, sample_seed="5", balance_windows=True)
    out = fc.run(state, req)
    model = out["model"]
    assert out["matched"]["balanced"] and out["matched"]["balanced_fit_reads"] == 30
    assert sorted(model["centroids"]) == [0, 1, 2] and model["peak_widths"] == [10]
    assert model["settings"] == fc.settings_snapshot(req) and model["samples"] == [list(range(0, 100, 10))]
    # Centres are the k-means centres of the fit rows: open fraction 0.3, 0.6 or 0 over the ten samples.
    assert sorted(round(float(np.mean(c)), 3) for c in model["centroids"].values()) == [0.0, 0.3, 0.6]
    again = fc.run(state, req, model=model)
    for key in ("a", "b"):
        assert again["results"][key]["assignments"] == out["results"][key]["assignments"]


def test_combinatorial_model_is_its_patterns(state):
    req = fc.RegionClusterRequest(viewports=[window("a")], peak_regions=[PeakRegion(start=0, end=100), PeakRegion(start=0, end=100)],
                                  method="combinatorial", k=4)
    req.viewports[0].blocks.append(fc.FrameBlock(feature=1, frame=(0, 100), genomic=(200, 300)))
    out = fc.run(state, req)
    assert out["model"]["cluster_patterns"] and out["model"]["centroids"] is None
    again = fc.run(state, req, model=out["model"])
    assert again["results"]["a"]["assignments"] == out["results"]["a"]["assignments"]


def test_a_model_of_other_widths_is_refused(state):
    req = fc.RegionClusterRequest(viewports=[window("a")], peak_regions=[PeakRegion(start=0, end=100)], method="kmeans", k=2)
    model = fc.run(state, req)["model"]
    narrower = req.model_copy(update={"sample_positions": [[0, 10, 20]]})
    with pytest.raises(ValueError, match="cluster again"):
        fc.run(state, narrower, model=model)


def test_model_assignment_keeps_missing_features_missing(state):
    """Review round 1 (G2): a window lacking a member-specific feature has -1 there in the fit; assigning with the
    model must give it -1 too, never a closed 0 that moves it into a carrier's cluster."""
    a = window("ref")
    b = window("car", blocks=[fc.FrameBlock(feature=0, frame=(0, 100), genomic=(100, 200)),
                              fc.FrameBlock(feature=1, frame=(0, 40), genomic=(220, 260))])
    req = fc.RegionClusterRequest(viewports=[a, b], peak_regions=[PeakRegion(start=0, end=100), PeakRegion(start=0, end=40)],
                                  member_specific_features=[1], method="combinatorial", k=4)
    out = fc.run(state, req)
    again = fc.run(state, req, model=out["model"])
    for key in ("ref", "car"):
        assert again["results"][key]["assignments"] == out["results"][key]["assignments"]


@pytest.mark.parametrize("change", [{"subnucleosomal_threshold": 40}, {"sample_positions": [list(range(5, 100, 10))]}])
def test_a_model_is_never_assigned_with_other_settings_or_samples(state, change):
    req = fc.RegionClusterRequest(viewports=[window("a")], peak_regions=[PeakRegion(start=0, end=100)], method="kmeans", k=2)
    model = fc.run(state, req)["model"]
    with pytest.raises(ValueError, match="cluster again"):
        fc.run(state, req.model_copy(update=change), model=model)


def test_a_folded_molecule_on_two_paths_of_one_dataset_is_fitted_once(monkeypatch):
    """Review round 1 (G4): under fold_molecule a molecule with records on two haplotypes of one dataset has one
    analysis_id in both windows; the primary record's row is kept and the other left out before the fit."""
    from services.lift.cohort import _encode_identity
    base = BrowserState(None)
    base.datasets = {"d": SimpleNamespace(data_type="bam")}
    base.dataset_order = ["d"]
    folded = _encode_identity(["lib|m1", "m1", None, None, "primary"])

    def working(self, dataset_id, chrom, start, end, *args, **kwargs):
        from services.lift.cohort import _scope
        hap = _scope.get()[1]   # the window's haplotype rule (cohort scope)
        sup = hap == "B"
        body = [[0, end - start, 0, "+", True]]
        rows = [dict(id="m1", analysis_id=folded, intervals=[[0, end - start, 0 if sup else 147]],
                     live_lift={"source": {"supplementary": sup}, "segments": body}),
                dict(id=f"x{hap}", analysis_id=_encode_identity([f"lib|x{hap}", f"x{hap}", None, None, "primary"]),
                     intervals=[[0, end - start, 0]], live_lift={"source": {"supplementary": False}, "segments": body})]
        return WorkingSet(rows, total_overlapping=2, total_spanning=2, chrom=chrom, start=start, end=end)

    monkeypatch.setattr(BrowserState, "build_working_set", working)
    req = fc.RegionClusterRequest(viewports=[window("A", lift_hap="A"), window("B", lift_hap="B")],
                                  peak_regions=[PeakRegion(start=0, end=100)], method="combinatorial", k=2)
    out = fc.run(base, req)
    # Fitted once (the primary record's row, window A); window B's path shows the same label.
    assert out["results"]["B"]["analysis_read_count"] == 1 and out["results"]["A"]["analysis_read_count"] == 2
    assert out["results"]["B"]["assignments"][folded] == out["results"]["A"]["assignments"][folded]
    assert out["joint_cohort"]["shared_molecules_within_dataset"] == 1


def test_more_than_fifty_patterns_reassign_by_the_fits_weighted_rule(monkeypatch):
    """Review round 3 (G2): rarer patterns join the nearest kept pattern weighted by feature overlap, in the fit and
    in model assignment alike, so unchanged reads keep their labels."""
    base = BrowserState(None)
    base.datasets = {"d": SimpleNamespace(data_type="bam")}
    base.dataset_order = ["d"]
    lengths = [100, 10, 100, 100, 100, 100]
    starts = [sum(lengths[:i]) for i in range(len(lengths))]

    def working(self, dataset_id, chrom, start, end, *args, **kwargs):
        reads = []
        for n in range(64):
            ivs = [[a, a + ln, 0 if (n >> i) & 1 else 147] for i, (a, ln) in enumerate(zip(starts, lengths))]
            reads.append(dict(id=f"r{n}", intervals=ivs))
        return WorkingSet(reads, total_overlapping=64, total_spanning=64, chrom=chrom, start=start, end=end)

    monkeypatch.setattr(BrowserState, "build_working_set", working)
    v = fc.RegionViewport(dataset_id="d", result_key="w", chrom="chr1", start=0, end=600,
                          blocks=[fc.FrameBlock(feature=i, frame=(0, ln), genomic=(a, a + ln)) for i, (a, ln) in enumerate(zip(starts, lengths))])
    req = fc.RegionClusterRequest(viewports=[v], peak_regions=[PeakRegion(start=0, end=ln) for ln in lengths],
                                  method="combinatorial", k=4)
    out = fc.run(base, req)
    assert len(out["model"]["cluster_patterns"]) == 50
    again = fc.run(base, req, model=out["model"])
    assert again["results"]["w"]["assignments"] == out["results"]["w"]["assignments"]



def test_an_observations_snapshot_names_the_quality_filters(monkeypatch):
    """Review round 2 (G5): feature values depend on the active quality filters (native rows too), so a durable
    model is refused once they change."""
    from services.graph_panel import analysis
    import services.read_quality_filters as qf
    st = SimpleNamespace(datasets={"n": SimpleNamespace(data_type="bam", paths=[], live_lift=None, id="n")})
    spec = {"observations": [{"id": "o", "dataset_id": "n"}]}
    monkeypatch.setattr(analysis, "_loader_options", lambda state: {"x": 1})
    monkeypatch.setattr("services.graph_panel.reads.dataset_revision", lambda ds: "r")
    monkeypatch.setattr(qf, "active_quality_filters", lambda state: [])
    before = analysis.observation_snapshot(st, spec)
    monkeypatch.setattr(qf, "active_quality_filters", lambda state: [{"layer": "msp", "field": "aq", "min": 100}])
    assert analysis.observation_snapshot(st, spec) != before


# ── Stage 2 bookkeeping (final reviews, G5) ────────────────────────────────────

def _stage2_setup(monkeypatch, assign_rows):
    """A plan with one carrier set (A, B) and a fake engine assigning ``assign_rows(view)``."""
    from services.graph_panel import analysis, columns as gc
    feat = gc.Feature("insertion", 0, 10, [0, 5], {"A": [(0, 10, 100, 110, False)], "B": [(0, 10, 200, 210, False)]}, ["A", "B"])
    plan = SimpleNamespace(carrier_sets=[{"carriers": ["A", "B"], "features": [feat]}])
    spec = {"observations": [{"id": o, "dataset_id": "d", "kind": "graph", "binding": o.lower(), "contig": f"c{o}"} for o in ("A", "B")],
            "regions": [{"start": 0, "end": 10, "mode": "accessibility"}], "target": "t", "options": {}}
    calls = []

    def engine(state, req, sources=None, row_cache=None, model=None):
        calls.append({v.result_key: list(v.read_ids or []) for v in req.viewports})
        res = {v.result_key: {"assignments": assign_rows(v)} for v in req.viewports}
        return {"results": res, "model": model or {"peak_widths": [2], "cluster_patterns": {0: [0], 1: [1]}}}

    monkeypatch.setattr(fc, "run", engine)
    return analysis, spec, plan, analysis._settings_of({"method": "combinatorial", "k": 2}), calls


def test_a_parent_with_fewer_than_two_covering_rows_records_no_stage(monkeypatch):
    analysis, spec, plan, settings, _calls = _stage2_setup(monkeypatch, lambda v: {v.read_ids[0]: 0} if v.result_key == "A" else {})
    labels = {"A": {"a1": "0", "a2": "0"}, "B": {"b1": "0"}}
    stages, refinements, _seen = analysis._refine(None, spec, plan, labels, settings, {}, {}, 0, {})
    assert stages == [] and refinements[0]["skipped"]
    assert labels == {"A": {"a1": "0", "a2": "0"}, "B": {"b1": "0"}}


def test_echoed_rows_never_enter_stage_2_and_take_their_winners_final_label(monkeypatch):
    analysis, spec, plan, settings, calls = _stage2_setup(monkeypatch, lambda v: {i: n % 2 for n, i in enumerate(v.read_ids)})
    labels = {"A": {"m": "0", "a2": "0"}, "B": {"m": "0", "b1": "0"}}
    stages, _r, seen = analysis._refine(None, spec, plan, labels, settings, {}, {}, 0, {("B", "m"): "A"})
    assert "m" not in calls[0]["B"]
    assert labels["B"]["m"] == labels["A"]["m"] and "." in labels["A"]["m"]
    assert len(stages) == 1 and seen


def test_a_stage_2_model_never_serves_another_parent(monkeypatch):
    analysis, spec, plan, settings, _calls = _stage2_setup(monkeypatch, lambda v: {i: n % 2 for n, i in enumerate(v.read_ids)})
    labels = {"A": {"a1": "0", "a2": "1", "a3": "0", "a4": "1"}, "B": {"b1": "0", "b2": "1"}}
    stages, _r, _seen = analysis._refine(None, spec, plan, {k: dict(v) for k, v in labels.items()}, settings, {}, {}, 0, {})
    assert [s["parent"] for s in stages] == ["0", "1"]
    swapped = [dict(stages[0], parent="1"), dict(stages[1], parent="0")]
    with pytest.raises(analysis.GraphRunError, match="cluster again"):
        analysis._refine(None, spec, plan, {k: dict(v) for k, v in labels.items()}, settings, {}, {}, 0, {}, fitted=swapped)
    again = {k: dict(v) for k, v in labels.items()}
    analysis._refine(None, spec, plan, again, settings, {}, {}, 0, {}, fitted=stages)
    assert all("." in lab for per in again.values() for lab in per.values())


def test_a_carrier_with_no_fit_rows_in_a_parent_is_refined_by_assignment(monkeypatch):
    """G7 step 0 review (agy): a refinement stage records its carrier set's every carrier, so a carrier whose rows
    reach the parent only later (over the fit's cap, after a pan) is refined by dynamic assignment like its siblings,
    never left on the parent label. (Probe by agy, inverted into a regression test.)"""
    from services.graph_panel import analysis, columns as gc
    feat_shared = gc.Feature(
        "target", 0, 20, [0, 10],
        {"obs-mat": [(0, 20, 100, 120, False)], "obs-pat": [(0, 20, 200, 220, False)], "obs-nat": [(0, 20, 300, 320, False)]},
        ["obs-mat", "obs-pat", "obs-nat"],
    )
    feat_alu = gc.Feature(
        "insertion", 0, 30, [0, 10, 20],
        {"obs-mat": [(0, 30, 120, 150, False)], "obs-pat": [(0, 30, 220, 250, False)]},
        ["obs-mat", "obs-pat"],
    )
    fake_plan = gc.Plan(
        shared=[feat_shared],
        carrier_sets=[{"carriers": ["obs-mat", "obs-pat"], "features": [feat_alu]}],
        participants=["obs-mat", "obs-nat", "obs-pat"],
        left_out={},
        report={"dropped": []},
    )
    spec = {
        "target": "grch38",
        "target_size": 10000,
        "regions": [{"start": 0, "end": 20, "mode": "accessibility"}],
        "observations": [
            {"id": "obs-mat", "dataset_id": "d", "kind": "graph", "binding": "mat", "contig": "c_mat", "read_ids": None, "strand": None},
            {"id": "obs-pat", "dataset_id": "d", "kind": "graph", "binding": "pat", "contig": "c_pat", "read_ids": None, "strand": None},
            {"id": "obs-nat", "dataset_id": "n", "kind": "linear", "binding": None, "chrom": "chr3", "genome": None, "lift_hap": None, "read_ids": None, "strand": None},
        ],
        "options": {"repeat_columns": "exclude", "carrier_features": "refine", "coverage_rule": "require_all", "insertions": True, "carrier_min_samples": 3},
    }
    reg = SimpleNamespace(id="reg1", revisions={"package": "1", "graph": "1", "db": "1", "maps": "1"})
    state = SimpleNamespace(datasets={"d": SimpleNamespace(id="d", live_lift=None), "n": SimpleNamespace(id="n", live_lift=None)},
                            ml_threshold=125, infer_legacy_layers=True, legacy_nuc_min_size=90, quality_filters=[])
    monkeypatch.setattr(analysis, "build_geometry", lambda s, t: ([], fake_plan))
    monkeypatch.setattr(analysis, "observation_snapshot", lambda st, sp: {o["id"]: {"rev": 1} for o in sp["observations"]})

    # Fit time (e.g. capped): obs-mat has m1, m2 in cluster 0 (which split into 0.0 and 0.1 on feat_alu);
    # obs-pat only has p1 in cluster 1 at fit time (its cluster-0 read p_uncapped was left out by the fit cap).
    def fake_engine_fit(st, req, sources=None, row_cache=None, model=None):
        if len(req.peak_regions) == 1 and req.peak_regions[0].end == 20:
            # Stage 1
            if model is None:
                return {
                    "results": {
                        "obs-mat": {"assignments": {"m1": 0, "m2": 0}},
                        "obs-pat": {"assignments": {"p1": 1}},
                        "obs-nat": {"assignments": {"n1": 0}},
                    },
                    "model": {"peak_widths": [2], "cluster_patterns": {0: [1, 1], 1: [0, 0]}},
                }
            else:
                # Assign time (uncapped): obs-pat now ALSO has p_uncapped in Stage-1 cluster 0!
                return {
                    "results": {
                        "obs-mat": {"assignments": {"m1": 0, "m2": 0}},
                        "obs-pat": {"assignments": {"p1": 1, "p_uncapped": 0}},
                        "obs-nat": {"assignments": {"n1": 0}},
                    },
                }
        else:
            # Stage 2 on feat_alu (length 30)
            res = {}
            for v in req.viewports:
                rids = list(v.read_ids or [])
                # m1 -> subcluster 0 (0.0), m2 & p_uncapped -> subcluster 1 (0.1)
                res[v.result_key] = {"assignments": {rid: (0 if rid == "m1" else 1) for rid in rids}}
            return {
                "results": res,
                "model": model or {"peak_widths": [3], "cluster_patterns": {0: [1, 1, 1], 1: [0, 0, 0]}},
            }

    monkeypatch.setattr(fc, "run", fake_engine_fit)
    body = {"method": "combinatorial", "k": 2}
    fit_out = analysis.run(state, reg, body, {}, spec=spec)

    # At fit time, m1 -> C0.0 (id 2), m2 -> C0.1 (id 3), n1 (non-carrier) -> C0 (id 0).
    assert fit_out["label_ids"] == {"0": 0, "1": 1, "0.0": 2, "0.1": 3}
    assert fit_out["results"]["obs-mat"]["assignments"] == {"m1": 2, "m2": 3}
    assert fit_out["results"]["obs-nat"]["assignments"] == {"n1": 0}

    # Look at what run() recorded for the Stage-2 stage:
    stage2_def = fit_out["stages"][1]
    assert stage2_def["carriers"] == ["obs-mat", "obs-pat"]

    # Now run assign() with the fitted durable model (uncapped):
    assign_body = {
        **body,
        "run": {
            "stages": fit_out["stages"],
            "label_ids": fit_out["label_ids"],
            "settings": fit_out["settings"],
            "revisions": fit_out["revisions"],
        },
    }
    assign_out = analysis.assign(state, reg, assign_body, {}, spec=spec)

    # m1 and m2 on obs-mat get refined labels 2 (C0.0) and 3 (C0.1):
    assert assign_out["results"]["obs-mat"]["assignments"] == {"m1": 2, "m2": 3}
    # p_uncapped (obs-pat, Stage-1 cluster 0) is refined on the insertion like obs-mat's m2: C0.1.
    assert assign_out["results"]["obs-pat"]["assignments"]["p_uncapped"] == 3


def test_a_model_with_many_labels_hashes_alike_after_json_transport():
    """G7 step 0 review (Codex): integer label keys sort numerically, their JSON strings lexicographically; the
    stage digest's model hash must not depend on which form it sees."""
    import json
    from services.graph_panel import analysis
    model = {"cluster_patterns": {i: [i % 2, i // 2 % 2] for i in range(16)}, "peak_widths": [10, 10],
             "centroids": {i: [float(i)] for i in range(12)}}
    assert analysis._model_hash(model) == analysis._model_hash(json.loads(json.dumps(model)))
