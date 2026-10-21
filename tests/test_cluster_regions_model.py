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
