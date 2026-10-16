"""Matched-domain two-view comparison clustering (haplotype comparison)."""

from __future__ import annotations

from types import SimpleNamespace

import numpy as np
import pytest

from models.domain import WorkingSet
from models.requests import MatchedClusterRequest, MatchedClusterView, MatchedViewPanel, PeakRegion
from services.clustering_features import resample_feature_blocks
from services.matched_view_clustering import run_matched_views_endpoint


# --- resample_feature_blocks -------------------------------------------------

def test_variable_width_blocks_share_one_geometry():
    features = np.array([[0.0, 1.0, 0.0, 0.0, 0.5, 1.0]], dtype=np.float32)
    out = resample_feature_blocks(features, [2, 4], bins_per_feature=5)
    assert out.shape == (1, 10)
    assert out[0, 0] == 0.0 and out[0, 4] == 1.0
    assert out[0, 5] == 0.0 and out[0, 9] == 1.0


def test_single_column_and_empty_blocks():
    features = np.array([[0.7, 0.2, 0.4]], dtype=np.float32)
    out = resample_feature_blocks(features, [1, 0, 2], bins_per_feature=3)
    assert out.shape == (1, 9)
    assert out[0, :3].tolist() == pytest.approx([0.7, 0.7, 0.7])
    assert out[0, 3:6].tolist() == [0.0, 0.0, 0.0]
    assert out[0, 6:].tolist() == pytest.approx([0.2, 0.3, 0.4])


def test_reverse_matches_features_right_to_left_and_flips_each():
    # Feature A = [0, 1], feature B = [0.25, 0.75]. Reversed, the view is read
    # from its right end: B flipped, then A flipped.
    features = np.array([[0.0, 1.0, 0.25, 0.75]], dtype=np.float32)
    out = resample_feature_blocks(features, [2, 2], bins_per_feature=2, reverse=True)
    assert out.tolist() == [[0.75, 0.25, 1.0, 0.0]]


# --- endpoint ------------------------------------------------------------------

def _read(read_id, open_spans, length=300):
    """A compact read over 0..length, nucleosome-covered except at open_spans (accessible, size 0)."""
    intervals, cursor = [], 0
    for start, end in sorted(open_spans):
        if start > cursor:
            intervals.append([cursor, start, 147])
        intervals.append([start, end, 0])
        cursor = end
    if cursor < length:
        intervals.append([cursor, length, 147])
    return {"id": read_id, "intervals": intervals}


class FakeState:
    """Two datasets; reads are open or closed at a feature placed per chromosome."""

    def __init__(self, reads_by_key):
        self.reads_by_key = reads_by_key
        self.datasets = {ds: SimpleNamespace(cluster_assignments={}) for ds, _ in reads_by_key}
        self.dataset_order = list(self.datasets)
        self.max_working_reads = None
        self.calls = []

    def translate_chrom(self, chrom):
        return chrom

    def resolve_dataset_id(self, dataset_id=None):
        return dataset_id or self.dataset_order[0]

    def get_dataset(self, dataset_id):
        return self.datasets.get(dataset_id)

    def build_working_set(self, dataset_id, chrom, start, end, spanning=False, min_footprints=0, **kwargs):
        self.calls.append((dataset_id, chrom, start, end))
        reads = self.reads_by_key.get((dataset_id, chrom), [])
        return WorkingSet(list(reads), total_overlapping=len(reads), total_spanning=len(reads),
                          chrom=chrom, start=start, end=end)


def _view(view_id, chrom, panels, peaks, reverse=False, start=0, end=300):
    return MatchedClusterView(
        id=view_id, chrom=chrom, start=start, end=end, reverse=reverse,
        panels=[MatchedViewPanel(dataset_id=ds, result_key=key) for ds, key in panels],
        peak_regions=[PeakRegion(start=s, end=e) for s, e in peaks],
    )


def _two_state_reads(prefix, n_open, n_closed, span):
    return ([_read(f"{prefix}-open-{i}", [span]) for i in range(n_open)]
            + [_read(f"{prefix}-closed-{i}", []) for i in range(n_closed)])


def test_joint_mode_shares_states_across_views_with_different_feature_widths():
    # The feature is 40 bp at 100-140 on hap1 and 80 bp at 60-140 on hap2.
    state = FakeState({
        ("ds1", "hap1"): _two_state_reads("a", 30, 10, (100, 140)),
        ("ds2", "hap2"): _two_state_reads("b", 10, 30, (60, 140)),
    })
    req = MatchedClusterRequest(
        method="kmeans", k=2, mode="joint",
        views=[_view("left", "hap1", [("ds1", "L1")], [(100, 140)]),
               _view("right", "hap2", [("ds2", "R1")], [(60, 140)])],
    )
    result = run_matched_views_endpoint(state=state, req=req)
    left, right = result["results"]["L1"]["assignments"], result["results"]["R1"]["assignments"]
    assert len(left) == 40 and len(right) == 40
    assert result["label_space"] == "shared"
    # Open reads of both views share one state; closed reads share the other.
    assert {left[f"a-open-{i}"] for i in range(30)} == {right[f"b-open-{i}"] for i in range(10)}
    assert {left[f"a-closed-{i}"] for i in range(10)} == {right[f"b-closed-{i}"] for i in range(30)}
    assert left["a-open-0"] != left["a-closed-0"]
    # Balanced fit: 40 reads from each panel -> all 80; the separation scores exist.
    assert result["balanced_fit_reads"] == 80 and result["total_reads"] == 80
    assert result["view_separation_nmi"] is not None and 0.0 <= result["view_separation_nmi"] <= 1.0
    assert result["results"]["L1"]["view_id"] == "left"


def test_balanced_fit_takes_equal_reads_per_panel():
    state = FakeState({
        ("ds1", "hap1"): _two_state_reads("a", 60, 40, (100, 140)),
        ("ds2", "hap2"): _two_state_reads("b", 5, 5, (100, 140)),
    })
    views = [_view("left", "hap1", [("ds1", "L1")], [(100, 140)]),
             _view("right", "hap2", [("ds2", "R1")], [(100, 140)])]
    balanced = run_matched_views_endpoint(state=state, req=MatchedClusterRequest(method="kmeans", k=2, views=views))
    assert balanced["balanced_fit_reads"] == 20 and balanced["total_reads"] == 110
    # Every read is still assigned.
    assert len(balanced["results"]["L1"]["assignments"]) == 100
    unbalanced = run_matched_views_endpoint(
        state=state, req=MatchedClusterRequest(method="kmeans", k=2, views=views, balance_views=False))
    assert unbalanced["balanced_fit_reads"] == 110


def test_separate_mode_numbers_each_views_states_apart():
    state = FakeState({
        ("ds1", "hap1"): _two_state_reads("a", 20, 20, (100, 140)),
        ("ds1", "hap2"): _two_state_reads("b", 20, 20, (100, 140)),
    })
    req = MatchedClusterRequest(
        method="kmeans", k=2, mode="separate",
        views=[_view("left", "hap1", [("ds1", "L1")], [(100, 140)]),
               _view("right", "hap2", [("ds1", "R1")], [(100, 140)])],
    )
    result = run_matched_views_endpoint(state=state, req=req)
    left = set(result["results"]["L1"]["assignments"].values())
    right = set(result["results"]["R1"]["assignments"].values())
    assert left == {0, 1} and right == {2, 3}
    assert result["label_space"] == "per_view"
    assert result["view_separation_nmi"] is None


def test_combinatorial_patterns_and_reverse_pairing():
    # hap1 has features at 50-90 (always open) and 200-240 (open in half).
    # hap2 is inverted: its first feature (in genomic order) is the one open in
    # half, so with reverse=True it is matched with hap1's second feature.
    hap1 = ([_read(f"a{i}", [(50, 90), (200, 240)]) for i in range(10)]
            + [_read(f"c{i}", [(50, 90)]) for i in range(10)])
    hap2 = ([_read(f"b{i}", [(40, 80), (180, 230)]) for i in range(10)]
            + [_read(f"d{i}", [(180, 230)]) for i in range(10)])
    state = FakeState({("ds1", "hap1"): hap1, ("ds1", "hap2"): hap2})
    req = MatchedClusterRequest(
        method="combinatorial", mode="joint",
        views=[_view("left", "hap1", [("ds1", "L")], [(50, 90), (200, 240)]),
               _view("right", "hap2", [("ds1", "R")], [(40, 80), (180, 230)], reverse=True)],
    )
    result = run_matched_views_endpoint(state=state, req=req)
    patterns = {label: tuple(bits) for label, bits in result["cluster_patterns"].items()}
    left, right = result["results"]["L"]["assignments"], result["results"]["R"]["assignments"]
    assert patterns[left["a0"]] == (1, 1) and patterns[left["c0"]] == (1, 0)
    assert patterns[right["b0"]] == (1, 1) and patterns[right["d0"]] == (1, 0)
    assert result["method"] == "combinatorial" and result["label_space"] == "shared"


def test_multiple_datasets_per_view_and_read_filters():
    state = FakeState({
        ("ds1", "hap1"): _two_state_reads("a", 5, 5, (100, 140)),
        ("ds2", "hap1"): _two_state_reads("b", 5, 5, (100, 140)),
        ("ds1", "hap2"): _two_state_reads("c", 5, 5, (100, 140)),
    })
    views = [_view("left", "hap1", [("ds1", "L1"), ("ds2", "L2")], [(100, 140)]),
             _view("right", "hap2", [("ds1", "R1")], [(100, 140)])]
    views[1].panels[0].read_ids = ["c-open-0", "c-closed-0"]
    result = run_matched_views_endpoint(state=state, req=MatchedClusterRequest(method="kmeans", k=2, views=views))
    assert set(result["results"]) == {"L1", "L2", "R1"}
    assert set(result["results"]["R1"]["assignments"]) == {"c-open-0", "c-closed-0"}
    assert result["results"]["L2"]["dataset_id"] == "ds2"
    assert result["dataset_separation_nmi"] is not None


@pytest.mark.parametrize("views, message", [
    ([_view("left", "hap1", [("ds1", "L")], [(100, 140)])], "Exactly two"),
    ([_view("left", "hap1", [("ds1", "L")], [(100, 140)]),
      _view("right", "hap2", [("ds1", "R")], [(100, 140), (200, 240)])], "same, non-zero number"),
    ([_view("left", "hap1", [("ds1", "L")], []),
      _view("right", "hap2", [("ds1", "R")], [])], "same, non-zero number"),
    ([_view("same", "hap1", [("ds1", "L")], [(100, 140)]),
      _view("same", "hap2", [("ds1", "R")], [(100, 140)])], "different ids"),
])
def test_invalid_requests_are_rejected(views, message):
    with pytest.raises(ValueError, match=message):
        run_matched_views_endpoint(state=FakeState({}), req=MatchedClusterRequest(views=views))


def test_unsupported_method_is_rejected():
    views = [_view("left", "hap1", [("ds1", "L")], [(100, 140)]),
             _view("right", "hap2", [("ds1", "R")], [(100, 140)])]
    with pytest.raises(ValueError, match="supports"):
        run_matched_views_endpoint(state=FakeState({}), req=MatchedClusterRequest(method="hdbscan", views=views))


def test_route_returns_400_for_invalid_request(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routers import clustering
    from state.dependencies import get_state

    app = FastAPI()
    app.include_router(clustering.router)
    app.dependency_overrides[get_state] = lambda: FakeState({})
    response = TestClient(app).post("/api/cluster_matched_views", json={
        "views": [{"id": "left", "chrom": "hap1", "start": 0, "end": 300,
                   "panels": [{"dataset_id": "ds1", "result_key": "L"}],
                   "peak_regions": [{"start": 100, "end": 140}]}],
    })
    assert response.status_code == 400
    assert "Exactly two" in response.json()["detail"]
