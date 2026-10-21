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
