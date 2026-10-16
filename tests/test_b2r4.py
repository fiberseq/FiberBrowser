"""B2 round 4: typed m6A marks, conservative pattern reassignment, per-dataset
read images, joint projection schemas, and autozoom over merged BAMs."""

from __future__ import annotations

from types import SimpleNamespace

import numpy as np
import pandas as pd

from models.requests import AutozoomRequest, ProjectionRequest
from services import autozoom_endpoint, clustering_endpoint, read_auxiliary_endpoint
from services.clustering_features import extract_features_from_compact
from services.dynamic_clustering import assign_reads_to_cluster_patterns
from services.peak_scanning import _marks_for_signal
from services.read_marks import m6a_positions

from test_clustering_endpoint import FakeClusterState


# ── 1. m6A features come from m6A marks only ────────────────────────────────

def test_m6a_positions_ignore_a_legacy_union_copied_from_other_marks():
    # Loaders copy 5mC (or deamination) into `methyl` when a read has no m6A.
    assert m6a_positions({"methyl": [20], "methyl_m5c": [20]}) == []
    assert m6a_positions({"methyl": [20], "deam": [[20, 1]]}) == []
    # Typed m6A, and reads that only ever had the legacy field, keep their marks.
    assert m6a_positions({"methyl": [5], "methyl_m6a": [5]}) == [5]
    assert m6a_positions({"methyl": [7]}) == [7]


def test_scan_signal_and_cluster_features_do_not_count_5mc_as_m6a():
    read = {"id": "r", "intervals": [[0, 100, -100]], "methyl": [20], "methyl_m5c": [20]}
    assert _marks_for_signal(read, "m6a") == []
    features, _, _, _ = extract_features_from_compact(
        [read], [[10, 30]], 0, step=10, subnucleosomal_threshold=90, peak_modes=["m6a"],
    )
    assert not features.any()
    m6a_read = {"id": "r", "intervals": [[0, 100, -100]], "methyl": [20], "methyl_m6a": [20]}
    features, _, _, _ = extract_features_from_compact(
        [m6a_read], [[10, 30]], 0, step=10, subnucleosomal_threshold=90, peak_modes=["m6a"],
    )
    assert features.any()


# ── 2. Conservative reassignment applies to combinatorial patterns ───────────

def test_conservative_pattern_assignment_leaves_partial_reads_unassigned():
    read = {"id": "r", "intervals": [[0, 30, -30]]}  # covers the first peak only
    peaks = [[0, 20], [60, 80]]
    patterns = {0: [1, 0], 1: [1, 1]}
    kwargs = dict(subnucleosomal_threshold=90, accessibility_threshold=0.5)
    aggressive = assign_reads_to_cluster_patterns([read], peaks, patterns, overlap_mode="aggressive", **kwargs)
    conservative = assign_reads_to_cluster_patterns([read], peaks, patterns, overlap_mode="conservative", **kwargs)
    assert aggressive["assignments"]["r"] == 0
    assert conservative["assignments"]["r"] == -1


# ── 3 + 6. Read images render the requested dataset, clustered by its own map ─

class _ImageState:
    def __init__(self):
        self.datasets = {
            "A": SimpleNamespace(cluster_assignments={}),
            "B": SimpleNamespace(cluster_assignments={"b1": 1, "b2": 0}),
        }
        self.requested = []

    def translate_chrom(self, chrom):
        return chrom

    def resolve_dataset_id(self, dataset_id=None):
        return dataset_id or "A"

    def get_dataset(self, dataset_id):
        return self.datasets.get(dataset_id)

    def get_reads(self, chrom, start, end, spanning=True, dataset_id=None):
        self.requested.append(dataset_id)
        ids = ["b1", "b2", "b3"] if dataset_id == "B" else ["a1"]
        df = pd.DataFrame({0: [-50] * len(ids), 1: [60] * len(ids)})
        df["read_id"] = ids
        return df


def test_reads_image_uses_the_requested_dataset_and_its_clusters(monkeypatch):
    state = _ImageState()
    seen = {}

    def fake_render(reads_df, cluster_assignments=None, sorted_indices=None, max_width=2000, row_height=3):
        seen["ids"] = reads_df["read_id"].tolist()
        seen["assignments"] = cluster_assignments
        seen["order"] = sorted_indices
        from PIL import Image
        return Image.new("RGB", (4, 4))

    monkeypatch.setattr(read_auxiliary_endpoint, "render_reads_to_image", fake_render)
    payload = read_auxiliary_endpoint.get_reads_image_payload(
        state, chrom="chr1", start=0, end=2, dataset_id="B", use_cluster=True,
    )
    assert state.requested == ["B"]
    assert payload["headers"]["X-Read-Count"] == "3"
    assert seen["assignments"] == {"b1": 1, "b2": 0}
    # Cluster 0 first, then 1, unassigned last.
    assert [seen["ids"][i] for i in seen["order"]] == ["b2", "b1", "b3"]

    info = read_auxiliary_endpoint.get_reads_info_payload(state, chrom="chr1", start=0, end=2, dataset_id="B")
    assert info == {"count": 3}


# ── 4. Joint projection: one feature layout ─────────────────────────────────

def test_projection_leaves_out_datasets_clustered_at_other_peaks(monkeypatch):
    state = FakeClusterState()
    state.dataset_order = ["ds1", "ds2"]
    state.datasets["ds1"].cluster_assignments = {"read-a": 0}
    state.datasets["ds1"].cluster_peak_regions = [{"start": 10, "end": 30, "mode": "accessibility"}]
    state.datasets["ds2"] = SimpleNamespace(
        cluster_assignments={"read-a": 1},
        cluster_peak_regions=[{"start": 10, "end": 50, "mode": "accessibility"}],
    )

    def fake_project(features, method, n_components, random_state):
        return np.zeros((features.shape[0], 2), dtype=np.float32), None, "pca"

    monkeypatch.setattr(clustering_endpoint, "compute_cluster_projection", fake_project)
    result = clustering_endpoint.run_cluster_projection_endpoint(
        state=state,
        req=ProjectionRequest(dataset_ids=["ds1", "ds2"], method="pca"),
        chrom="chr2R", start=0, end=60, spanning=False,
    )
    assert result["dataset_ids"] == ["ds1"]
    assert result["skipped_datasets"] == ["ds2"]


# ── 5. Autozoom reads every BAM of a merged dataset ─────────────────────────

def test_autozoom_collects_reads_from_every_bam(monkeypatch):
    state = FakeClusterState()
    state.datasets["ds1"] = SimpleNamespace(data_type="bam", paths=["first.bam", "second.bam"])
    asked = []

    def fake_boundaries(path, chrom, start, end, max_reads=10000, chrom_map=None):
        asked.append(path)
        return [(100, 900)] * 20 if path == "second.bam" else []

    monkeypatch.setattr(autozoom_endpoint, "get_read_boundaries_from_bam", fake_boundaries)
    result = autozoom_endpoint.autozoom_for_request(
        state, AutozoomRequest(dataset_ids=["ds1"], min_reads=5, distance=200),
        chrom="chr2R", start=300, end=600,
    )
    assert asked == ["first.bam", "second.bam"]
    assert result.get("message") != "No reads found in search region"


def test_figure_reads_never_draw_deamination_as_m6a():
    from services.figure.tracks import reads as figure_reads
    from services.read_marks import m6a_positions
    assert figure_reads.m6a_positions is m6a_positions
    daf = {'methyl': [5, 9], 'deam': [[5, 0], [9, 1]]}
    assert m6a_positions(daf) == []
    assert m6a_positions({'methyl': [3]}) == [3]
    assert m6a_positions({'methyl': [3], 'methyl_m6a': [4]}) == [4]
