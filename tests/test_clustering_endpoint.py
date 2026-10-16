"""Regression tests for extracted clustering endpoint orchestration."""

from __future__ import annotations

import time
from collections import OrderedDict
from types import SimpleNamespace

import numpy as np
import pytest

from models.domain import WorkingSet
from models.requests import (
    AssignToClustersRequest,
    AutoCullRequest,
    ClusterAllRequest,
    DissolveClusterRequest,
    PeakRegion,
    ProjectionRequest,
    ScanPeaksRequest,
)
from services.analysis_query import AnalysisReadQuery
from services import clustering_endpoint
from services.peak_scanning import scan_signal_from_counts
from services.working_sets import BROAD_CACHE_SCHEMA_VERSION, read_load_token


class FakeClusterState:
    dataset_order = ["ds1"]

    def __init__(self):
        self.calls = []
        self.peak_regions = [[5, 15]]
        self.datasets = {"ds1": SimpleNamespace(cluster_assignments={})}
        self.max_working_reads = None

    def translate_chrom(self, chrom):
        return {"chr2R": "2R", "chr3L": "3L"}.get(chrom, chrom)

    def resolve_dataset_id(self, dataset_id=None):
        if dataset_id in (None, "", "primary"):
            return "ds1"
        return dataset_id

    def get_dataset(self, dataset_id):
        return self.datasets.get(dataset_id)

    def build_working_set(self, dataset_id, chrom, start, end, spanning=False, min_footprints=0, **kwargs):
        self.calls.append((dataset_id, chrom, start, end, spanning, min_footprints, kwargs))
        return WorkingSet(
            [
                {"id": "read-a", "intervals": [[0, 30, 50]]},
                {"id": "read-b", "intervals": [[0, 8, 100], [22, 30, 100]]},
            ],
            total_overlapping=2,
            total_spanning=1,
            chrom=chrom,
            start=start,
            end=end,
        )


def test_active_cluster_peaks_filters_off_and_remaps_tf_for_combinatorial():
    state = FakeClusterState()
    req = ClusterAllRequest(
        method="combinatorial",
        peak_regions=[
            PeakRegion(start=110, end=130, mode="tf"),
            PeakRegion(start=150, end=160, mode="off"),
        ],
    )

    peaks, modes = clustering_endpoint.active_cluster_peaks(req, state, start=100)

    assert peaks == [[10, 30]]
    assert modes == ["accessibility"]


def test_build_cluster_jobs_preserves_extra_chrom_result_keys():
    state = FakeClusterState()

    jobs = clustering_endpoint.build_cluster_jobs("2R", ["ds1"], ["chr3L"], state)

    assert jobs == [
        ("2R", "ds1", "ds1"),
        ("3L", "ds1", "ds1_chr3L"),
    ]


def test_stored_cluster_peak_regions_filters_invalid_saved_peaks():
    state = FakeClusterState()
    state.datasets["ds1"].cluster_peak_regions = [
        {"start": 110, "end": 125, "mode": "tf"},
        {"start": 130, "end": 140, "mode": "off"},
        {"start": None, "end": 150, "mode": "nuc"},
    ]

    peaks, modes = clustering_endpoint.stored_cluster_peak_regions(state, ["ds1"], region_start=100)

    assert peaks == [[10, 25]]
    assert modes == ["tf"]


def test_run_scan_peaks_endpoint_updates_state_and_returns_signal():
    state = FakeClusterState()

    result = clustering_endpoint.run_scan_peaks_endpoint(
        state=state,
        req=ScanPeaksRequest(
            min_width=5,
            min_reads=1,
            smooth_width=5,
            return_signal=True,
            signal_bins=10,
            dataset_ids=["ds1"],
            sample_seed="scan-seed",
        ),
        chrom="chr2R",
        start=0,
        end=30,
        dataset_id=None,
        spanning=False,
    )

    assert state.calls[0][:6] == ("ds1", "2R", 0, 30, False, 0)
    assert state.calls[0][6]["sample_seed"] == "scan-seed"
    assert state.calls[0][6]["include_layer_qualities"] is False
    assert result["n_reads"] == 2
    assert result["mode"] == "Fast"
    assert result["peaks"]
    assert state.peak_regions == [[peak["start"], peak["end"]] for peak in result["peaks"]]
    assert len(result["signal"]) == 10
    assert result["server_elapsed_ms"] >= 0
    assert set(result["server_timings"]) >= {"working_set_ms", "signal_ms", "smooth_ms", "detect_ms"}


def test_an_empty_rescan_clears_the_regions_peaks():
    from services.peak_scanning import stored_peak_regions_for
    state = FakeClusterState()
    req = dict(min_width=5, min_reads=1, smooth_width=5, dataset_ids=["ds1"])
    kwargs = dict(chrom="chr2R", start=0, end=30, dataset_id=None, spanning=False)
    assert clustering_endpoint.run_scan_peaks_endpoint(state=state, req=ScanPeaksRequest(**req), **kwargs)["peaks"]
    assert stored_peak_regions_for(state, "chr2R", 0, 30)
    # Rescan the same region with a read scope that has no reads.
    empty = clustering_endpoint.run_scan_peaks_endpoint(
        state=state, req=ScanPeaksRequest(**req, read_ids=["no-such-read"]), **kwargs)
    assert empty["peaks"] == [] and stored_peak_regions_for(state, "chr2R", 0, 30) == []


def test_run_scan_peaks_endpoint_returns_empty_for_zero_width_region():
    state = FakeClusterState()

    result = clustering_endpoint.run_scan_peaks_endpoint(
        state=state,
        req=ScanPeaksRequest(),
        chrom="chr2R",
        start=100,
        end=100,
        dataset_id=None,
        spanning=False,
    )

    assert result["peaks"] == []
    assert result["layer_info"] == []
    assert result["n_reads"] == 0
    assert state.calls == []


def test_scan_counts_from_broad_cache_uses_viewport_offset_without_projection():
    state = FakeClusterState()
    state._broad_cache_schema_version = BROAD_CACHE_SCHEMA_VERSION
    state._broad_cache_timeout = 300
    state._broad_cache = OrderedDict()
    broad_key = ("ds1", "2R", 100, 200, False, (), False, True, 90, 0, read_load_token(state, "2R"))
    state._broad_cache[broad_key] = (
        [
            {"id": "r1", "intervals": [[20, 30, 40], [30, 50, 120]]},
            {"id": "r2", "intervals": [[25, 45, 40]]},
        ],
        time.time(),
    )
    query = AnalysisReadQuery(
        chrom="2R",
        start=120,
        end=150,
        dataset_ids=["ds1"],
        include_methylation=False,
        include_layers=False,
        include_layer_qualities=False,
    )

    counts = clustering_endpoint._compute_scan_counts_from_broad_cache(
        state=state,
        query=query,
        dataset_id="ds1",
        signal_source="accessibility",
        region_width=30,
    )

    assert counts is not None
    numerator, total_counts, n_reads = counts
    signal = scan_signal_from_counts(numerator, total_counts)
    assert n_reads == 2
    assert total_counts[2] == 1
    assert total_counts[10] == 2
    assert signal[2] == 1.0
    assert signal[10] == 0.5

    # With a read cap below the cached count, the cache steps aside so the scan
    # uses the capped (stably sampled) working set, as a cold scan would.
    state.max_working_reads = 1
    assert clustering_endpoint._compute_scan_counts_from_broad_cache(
        state=state, query=query, dataset_id="ds1", signal_source="accessibility", region_width=30) is None
    # An explicit read scope is never capped: the cache still serves it.
    scoped = AnalysisReadQuery(chrom="2R", start=120, end=150, dataset_ids=["ds1"], include_methylation=False,
                               include_layers=False, include_layer_qualities=False,
                               read_ids_by_dataset={"ds1": ["r1", "r2"]})
    counts = clustering_endpoint._compute_scan_counts_from_broad_cache(
        state=state, query=scoped, dataset_id="ds1", signal_source="accessibility", region_width=30)
    assert counts is not None and counts[2] == 2


@pytest.mark.parametrize("source", ["accessibility", "tf_density"])
@pytest.mark.parametrize("gate_layer", ["fire", "msp"])
def test_primary_peak_scan_reuses_display_sample_with_hidden_fire_gate(monkeypatch, source, gate_layer):
    from services.peak_scanning import compute_scan_counts
    from services.read_quality_filters import apply_quality_filters

    state = FakeClusterState()
    state._broad_cache_schema_version = BROAD_CACHE_SCHEMA_VERSION
    state._broad_cache_timeout = None
    state.quality_filters = [dict(layer=gate_layer, quality_name="aq", min_value=230)]
    monkeypatch.setattr("services.read_sampling.sample_level", lambda *args: 2)
    # The display loaded nuc/TF, with a stricter whole-read count floor.
    # It deliberately did not decode the hidden FIRE layer.
    token = read_load_token(state, "2R", sample_level=2)
    key = ("ds1", "2R", 100, 200, False, ("nuc", "tf"), True, True, 90, 5, token)
    reads = [
        {"id": "r1", "intervals": [[20, 30, 40], [30, 50, 120]]},
        {"id": "r2", "intervals": [[25, 45, -20]]},
        {"id": "not-selected", "intervals": [[0, 100, 0]]},
    ]
    state._broad_cache = OrderedDict([(key, (reads, time.time()))])
    query = AnalysisReadQuery(chrom="2R", start=120, end=150, dataset_ids=["ds1"],
        include_methylation=False, include_layers=False, include_layer_qualities=False,
        read_ids_by_dataset={"ds1": ["r1", "r2"]})
    counts = clustering_endpoint._compute_scan_counts_from_broad_cache(
        state=state, query=query, dataset_id="ds1", signal_source=source, region_width=30)
    assert counts is not None and counts[2] == 2
    # Compare the cached shortcut with applying the gate to full annotations.
    full = [{**r, "fire": [[20, 40, 100]], "layers": {"msp": {
        "intervals": [[20, 40, 20]], "quality_names": ["aq"], "qualities": [[100]],
    }}} for r in reads[:2]]
    filtered = [apply_quality_filters(r, state.quality_filters) for r in full]
    expected = compute_scan_counts(filtered, source, 30, coordinate_offset=20)
    np.testing.assert_array_equal(counts[0], expected[0])
    np.testing.assert_array_equal(counts[1], expected[1])
    # A request for evidence not retained in the sample still takes the loader path.
    query.read_ids_by_dataset["ds1"].append("not-cached")
    assert clustering_endpoint._compute_scan_counts_from_broad_cache(
        state=state, query=query, dataset_id="ds1", signal_source=source, region_width=30) is None


@pytest.mark.parametrize("source,gate_layer", [
    ("fire", "fire"), ("msp", "msp"), ("layer:fire", "fire"),
    ("accessibility", "nuc"), ("tf_density", "*"), ("tf_layer", "tf"),
])
def test_peak_scan_cannot_bypass_relevant_quality_gates(source, gate_layer):
    state = FakeClusterState()
    state.quality_filters = [dict(layer=gate_layer, quality_name="aq", min_value=230)]
    query = AnalysisReadQuery(chrom="2R", start=120, end=150, dataset_ids=["ds1"])
    assert clustering_endpoint._compute_scan_counts_from_broad_cache(
        state=state, query=query, dataset_id="ds1", signal_source=source, region_width=30) is None


def test_run_dissolve_cluster_endpoint_assembles_reassigned_results(monkeypatch):
    state = FakeClusterState()

    def fake_collect(*args, **kwargs):
        return (
            [np.array([0.0], dtype=np.float32), np.array([1.0], dtype=np.float32)],
            [("ds1", "read-a"), ("ds1", "read-b")],
            [0, 1],
        )

    def fake_dissolve(features, assignments, dissolve_id):
        assert features.shape == (2, 1)
        assert assignments.tolist() == [0, 1]
        assert dissolve_id == 1
        return np.array([0, 0], dtype=np.int32), {
            "changed": True,
            "dissolved_count": 1,
            "remaining_clusters": [0],
            "reason": "dissolved",
        }

    monkeypatch.setattr(clustering_endpoint, "collect_assigned_feature_rows", fake_collect)
    monkeypatch.setattr(clustering_endpoint, "dissolve_cluster_to_nearest", fake_dissolve)

    result = clustering_endpoint.run_dissolve_cluster_endpoint(
        state=state,
        req=DissolveClusterRequest(
            cluster_to_dissolve=1,
            current_assignments={"ds1": {"read-a": 0, "read-b": 1}},
            peak_regions=[PeakRegion(start=10, end=20, mode="accessibility")],
            dataset_ids=["ds1"],
            sample_seed="dissolve-seed",
        ),
        chrom="chr2R",
        start=0,
        end=30,
        spanning=False,
    )

    assert result["results"]["ds1"]["assignments"] == {"read-a": 0, "read-b": 0}
    assert result["results"]["ds1"]["cluster_counts"] == {0: 2}
    assert state.datasets["ds1"].cluster_assignments == {"read-a": 0, "read-b": 0}
    assert result["sample_seed"] == "dissolve-seed"


def test_run_assign_to_clusters_endpoint_respects_read_id_scope():
    state = FakeClusterState()
    state.datasets["ds1"].cluster_assignments = {"read-b": 2}

    result = clustering_endpoint.run_assign_to_clusters_endpoint(
        state=state,
        req=AssignToClustersRequest(
            dataset_ids=["ds1"],
            read_ids={"ds1": ["read-a"]},
            peak_regions=[PeakRegion(start=100, end=120, mode="accessibility")],
            cluster_patterns={1: [1], 2: [0]},
            sample_seed="dynamic-seed",
        ),
        chrom="chr1",
        start=100,
        end=130,
        spanning=False,
    )

    assert result["results"]["ds1"]["assignments"] == {"read-a": 1}
    assert result["results"]["ds1"]["cluster_counts"] == {1: 1}
    # The response is viewport/scope-local, while the stored live projection
    # retains reads omitted from this partial dynamic pass.
    assert state.datasets["ds1"].cluster_assignments == {"read-b": 2, "read-a": 1}


def test_run_auto_cull_clusters_endpoint_returns_dissolved_log(monkeypatch):
    state = FakeClusterState()

    def fake_collect(*args, **kwargs):
        return (
            [np.array([0.0], dtype=np.float32), np.array([1.0], dtype=np.float32)],
            [("ds1", "read-a"), ("ds1", "read-b")],
            [0, 1],
        )

    def fake_autocull(features, assignments, min_fraction, max_cosine_similarity):
        assert min_fraction == 0.2
        assert max_cosine_similarity == 0.9
        return np.array([0, 0], dtype=np.int32), [
            {"cluster": 1, "count": 1, "reason": "low_abundance"}
        ]

    monkeypatch.setattr(clustering_endpoint, "collect_assigned_feature_rows", fake_collect)
    monkeypatch.setattr(clustering_endpoint, "run_autocull_on", fake_autocull)

    result = clustering_endpoint.run_auto_cull_clusters_endpoint(
        state=state,
        req=AutoCullRequest(
            current_assignments={"ds1": {"read-a": 0, "read-b": 1}},
            peak_regions=[PeakRegion(start=10, end=20, mode="accessibility")],
            dataset_ids=["ds1"],
            min_fraction=0.2,
            max_cosine_similarity=0.9,
            sample_seed="autocull-seed",
        ),
        chrom="chr2R",
        start=0,
        end=30,
        spanning=False,
    )

    assert result["results"]["ds1"]["assignments"] == {"read-a": 0, "read-b": 0}
    assert result["dissolved"] == [{"cluster": 1, "count": 1, "reason": "low_abundance"}]
    assert result["sample_seed"] == "autocull-seed"


def test_run_cluster_projection_endpoint_projects_assigned_reads(monkeypatch):
    state = FakeClusterState()
    state.datasets["ds1"].cluster_assignments = {"read-a": 2}
    state.datasets["ds1"].cluster_peak_regions = [{"start": 10, "end": 20, "mode": "accessibility"}]

    def fake_extract(reads, peaks, start, step=10, subnucleosomal_threshold=90, peak_modes=None):
        assert [read["id"] for read in reads] == ["ds1::read-a"]
        assert peaks == [(10, 20)]
        assert peak_modes == ["accessibility"]
        return np.array([[1.0, 2.0]], dtype=np.float32), ["ds1::read-a"], None, None

    def fake_project(features, method, n_components, random_state):
        assert features.tolist() == [[1.0, 2.0]]
        assert method == "pca"
        assert n_components == 2
        return np.array([[0.5, -1.0]], dtype=np.float32), [1.0, 0.0], "pca"

    monkeypatch.setattr(clustering_endpoint, "extract_features_from_compact", fake_extract)
    monkeypatch.setattr(clustering_endpoint, "compute_cluster_projection", fake_project)

    result = clustering_endpoint.run_cluster_projection_endpoint(
        state=state,
        req=ProjectionRequest(
            dataset_ids=["ds1"],
            method="pca",
            sample_seed="projection-seed",
        ),
        chrom="chr2R",
        start=0,
        end=30,
        spanning=False,
    )

    assert result["coords_x"] == [0.5]
    assert result["coords_y"] == [-1.0]
    assert result["read_ids"] == ["read-a"]
    assert result["dataset_ids"] == ["ds1"]
    assert result["labels_before"] == [2]
    assert result["cluster_centroids_before"] == {"2": [0.5, -1.0]}
    assert result["feature_dim"] == 2
    assert result["n_reads"] == 1
    assert result["sample_seed"] == "projection-seed"


def test_a_one_component_projection_request_still_returns_a_2d_scatter():
    state = FakeClusterState()
    state.datasets["ds1"].cluster_assignments = {"read-a": 0, "read-b": 1}
    state.datasets["ds1"].cluster_peak_regions = [{"start": 0, "end": 30, "mode": "accessibility"}]
    result = clustering_endpoint.run_cluster_projection_endpoint(
        state=state, req=ProjectionRequest(dataset_ids=["ds1"], method="pca", n_components=1),
        chrom="chr2R", start=0, end=30, spanning=False)
    assert result["n_reads"] >= 1
    assert len(result["coords_x"]) == len(result["coords_y"]) == result["n_reads"]
    assert all(len(c) == 2 for c in result["cluster_centroids_before"].values())


def test_run_cluster_projection_endpoint_prefers_frontend_assignment_override(monkeypatch):
    state = FakeClusterState()
    # Backend's stored map is stale; the active branch (override) relabels read-a.
    state.datasets["ds1"].cluster_assignments = {"read-a": 2}
    state.datasets["ds1"].cluster_peak_regions = [{"start": 10, "end": 20, "mode": "accessibility"}]

    def fake_extract(reads, peaks, start, step=10, subnucleosomal_threshold=90, peak_modes=None):
        return np.array([[1.0, 2.0]], dtype=np.float32), ["ds1::read-a"], None, None

    def fake_project(features, method, n_components, random_state):
        return np.array([[0.5, -1.0]], dtype=np.float32), [1.0, 0.0], "pca"

    monkeypatch.setattr(clustering_endpoint, "extract_features_from_compact", fake_extract)
    monkeypatch.setattr(clustering_endpoint, "compute_cluster_projection", fake_project)

    result = clustering_endpoint.run_cluster_projection_endpoint(
        state=state,
        req=ProjectionRequest(
            dataset_ids=["ds1"],
            method="pca",
            cluster_assignments={"ds1": {"read-a": 7}},
        ),
        chrom="chr2R",
        start=0,
        end=30,
        spanning=False,
    )

    # Uses the override label (7), not the backend's stored label (2).
    assert result["labels_before"] == [7]


def test_run_cluster_all_endpoint_uses_filtered_prefixed_reads(monkeypatch):
    state = FakeClusterState()

    def fake_cluster_compact_reads(reads, peaks, start, k, method, **kwargs):
        assert [read["id"] for read in reads] == ["ds1::read-a"]
        assert peaks == [[10, 20]]
        assert start == 0
        assert k == 2
        assert method == "combinatorial"
        return (
            {"ds1::read-a": 1},
            {1: 1},
            [0],
            {
                "n_elements": 1,
                "cluster_patterns": {1: [1]},
                "element_read_ids": {0: ["ds1::read-a"]},
                "method": method,
            },
        )

    monkeypatch.setattr(clustering_endpoint, "cluster_compact_reads", fake_cluster_compact_reads)

    result = clustering_endpoint.run_cluster_all_endpoint(
        state=state,
        req=ClusterAllRequest(
            dataset_ids=["ds1"],
            peak_regions=[PeakRegion(start=10, end=20, mode="accessibility")],
            k=2,
            method="combinatorial",
            sample_seed="cluster-seed",
        ),
        chrom="chr2R",
        start=0,
        end=30,
        spanning=True,
    )

    assert state.calls[0][:6] == ("ds1", "2R", 0, 30, True, 0)
    assert state.calls[0][6]["sample_seed"] == "cluster-seed"
    ds_result = result["results"]["ds1"]
    assert ds_result["assignments"] == {"read-a": 1}
    assert ds_result["filtered_read_ids"] == ["read-a"]
    assert ds_result["eligible_read_count"] == 2
    assert ds_result["peak_covering_read_count"] == 1
    assert ds_result["analysis_read_count"] == 1
    assert state.datasets["ds1"].cluster_assignments == {"read-a": 1}
    assert result["sample_seed"] == "cluster-seed"
    assert "timings" in result


def test_cluster_windows_query_and_assign_separately(monkeypatch):
    from models.requests import ClusterViewport
    state = FakeClusterState()
    def cluster(reads, peaks, start, k, method, **kwargs):
        assert [read['id'] for read in reads] == ['maternal::read-a','paternal::read-a']
        return ({read['id']: i for i,read in enumerate(reads)}, {0:1,1:1}, [], {})
    monkeypatch.setattr(clustering_endpoint, 'cluster_compact_reads', cluster)
    req=ClusterAllRequest(dataset_ids=['ds1'], method='combinatorial',peak_regions=[PeakRegion(start=10,end=20)],
        viewports=[ClusterViewport(dataset_id='ds1',result_key='maternal',chrom='chr2R',start=0,end=30),
                   ClusterViewport(dataset_id='ds1',result_key='paternal',chrom='chr3L',start=100,end=130)])
    result=clustering_endpoint.run_cluster_all_endpoint(state=state,req=req,chrom='chr2R',start=0,end=30,spanning=False)
    assert [(row[1],row[2],row[3]) for row in state.calls] == [('2R',0,30),('3L',100,130)]
    assert result['results']['maternal']['assignments']=={'read-a':0}
    assert result['results']['paternal']['assignments']=={'read-a':1}


def test_promoter_windows_share_real_clusters_with_different_spans():
    from models.requests import ClusterViewport
    state = FakeClusterState()
    req = ClusterAllRequest(dataset_ids=['ds1'], method='combinatorial',
        peak_regions=[PeakRegion(start=10,end=20)],
        viewports=[ClusterViewport(dataset_id='ds1',result_key='maternal',chrom='chr2R',start=0,end=30),
                   ClusterViewport(dataset_id='ds1',result_key='paternal',chrom='chr3L',start=100,end=150)])
    result = clustering_endpoint.run_cluster_all_endpoint(state=state,req=req,chrom='chr2R',start=0,end=30,spanning=False)
    maternal = result['results']['maternal']['assignments']
    paternal = result['results']['paternal']['assignments']
    assert maternal and paternal
    assert maternal['read-a'] == paternal['read-a']
    assert [(row[1],row[2],row[3]) for row in state.calls] == [('2R',0,30),('3L',100,150)]


def test_existing_extra_chrom_path_pools_haplotypes_once(monkeypatch):
    state = FakeClusterState()
    calls = []
    def cluster(reads, peaks, start, k, method, **kwargs):
        calls.append([read['id'] for read in reads])
        return ({read['id']: 3 for read in reads}, {3:len(reads)}, [], {})
    monkeypatch.setattr(clustering_endpoint, 'cluster_compact_reads', cluster)
    req = ClusterAllRequest(dataset_ids=['ds1'], extra_chroms=['chr3L'],
        method='combinatorial',peak_regions=[PeakRegion(start=10,end=20)])
    result = clustering_endpoint.run_cluster_all_endpoint(state=state,req=req,chrom='chr2R',start=0,end=30,spanning=False)
    assert calls == [['ds1::read-a','ds1_chr3L::read-a']]
    assert result['results']['ds1']['assignments']=={'read-a':3}
    assert result['results']['ds1_chr3L']['assignments']=={'read-a':3}


def test_windows_at_other_loci_use_their_own_matched_peaks():
    from models.requests import ClusterViewport

    class State(FakeClusterState):
        def build_working_set(self, dataset_id, chrom, start, end, spanning=False, min_footprints=0, **kwargs):
            ws = super().build_working_set(dataset_id, chrom, start, end, spanning, min_footprints, **kwargs)
            ws.reads[1]["intervals"] = [[0, 8, 100], [8, 22, 0], [22, 30, 100]]
            return ws

    state = State()
    # read-a (a TF-sized footprint) reads as accessible everywhere; read-b is
    # open at 10-20 and under a nucleosome at 2-12.
    req = ClusterAllRequest(dataset_ids=['ds1'], method='combinatorial',
        peak_regions=[PeakRegion(start=10, end=20)],
        viewports=[ClusterViewport(dataset_id='ds1', result_key='here', chrom='chr2R', start=0, end=30),
                   ClusterViewport(dataset_id='ds1', result_key='there', chrom='chr3L', start=100, end=130,
                                   peak_regions=[PeakRegion(start=102, end=112)])])
    result = clustering_endpoint.run_cluster_all_endpoint(state=state, req=req, chrom='chr2R', start=0, end=30, spanning=False)
    here = result['results']['here']['assignments']
    there = result['results']['there']['assignments']
    assert here['read-a'] == here['read-b']
    assert there['read-a'] == here['read-a'] != there['read-b']


def test_windows_own_peaks_must_match_in_number_and_width():
    import pytest
    from models.requests import ClusterViewport
    req = ClusterAllRequest(dataset_ids=['ds1'], method='combinatorial',
        peak_regions=[PeakRegion(start=10, end=20)],
        viewports=[ClusterViewport(dataset_id='ds1', result_key='there', chrom='chr3L', start=100, end=130,
                                   peak_regions=[PeakRegion(start=102, end=120)])])
    with pytest.raises(ValueError):
        clustering_endpoint.run_cluster_all_endpoint(state=FakeClusterState(), req=req, chrom='chr2R', start=0, end=30, spanning=False)


def test_window_features_use_that_windows_start_and_context():
    from services.clustering_features import extract_features_grouped
    reads = [{"id": "a", "intervals": [[0, 8, 100], [8, 22, 0], [22, 30, 100]], "_cluster_group": "there"}]
    # The shared peak 10-20 is open for this read; the window's own 2-12 is not.
    shared, *_ = extract_features_grouped(reads, [[10, 20]], 0)
    own, *_ = extract_features_grouped(reads, [[10, 20]], 0, {"there": ([[2, 12]], 100, {})})
    assert shared.tolist() == [[1.0]] and own.tolist() == [[0.0]]


def test_kmeans_centroids_use_each_windows_peaks():
    from models.requests import ClusterViewport

    class State(FakeClusterState):
        def build_working_set(self, dataset_id, chrom, start, end, spanning=False, min_footprints=0, **kwargs):
            ws = super().build_working_set(dataset_id, chrom, start, end, spanning, min_footprints, **kwargs)
            ws.reads[1]["intervals"] = [[0, 8, 100], [8, 22, 0], [22, 30, 100]]
            return ws

    req = ClusterAllRequest(dataset_ids=['ds1'], method='kmeans', k=2,
        peak_regions=[PeakRegion(start=2, end=12)],
        viewports=[ClusterViewport(dataset_id='ds1', result_key='there', chrom='chr3L', start=100, end=130,
                                   peak_regions=[PeakRegion(start=110, end=120)])])
    result = clustering_endpoint.run_cluster_all_endpoint(state=State(), req=req, chrom='chr2R', start=0, end=30, spanning=False)
    # At its own peak (110-120) read-b is open like read-a: every centroid is all open.
    assert all(all(v == 1.0 for v in c) for c in result['cluster_centroids'].values())


def test_combinatorial_cluster_all_feeds_dynamic_reassignment_and_similarity_sort():
    from models.requests import AssignToClustersRequest
    from services.read_sorting import sort_similarity_for_dataset

    class State(FakeClusterState):
        def build_working_set(self, dataset_id, chrom, start, end, spanning=False, min_footprints=0, **kwargs):
            ws = super().build_working_set(dataset_id, chrom, start, end, spanning, min_footprints, **kwargs)
            ws.reads[1]["intervals"] = [[0, 8, 100], [8, 22, 0], [22, 30, 100]]
            return ws

    state = State()
    # At 2-12 read-a (TF-sized footprint) reads as open and read-b as closed: two patterns.
    req = ClusterAllRequest(dataset_ids=['ds1'], method='combinatorial', peak_regions=[PeakRegion(start=2, end=12)])
    result = clustering_endpoint.run_cluster_all_endpoint(state=state, req=req, chrom='chr2R', start=0, end=30, spanning=False)
    patterns = result['cluster_patterns']
    assigned = result['results']['ds1']['assignments']
    assert sorted(map(tuple, patterns.values())) == [(0,), (1,)]
    assert patterns[assigned['read-a']] == [1] and patterns[assigned['read-b']] == [0]
    assert state.datasets['ds1'].cluster_element_info['cluster_patterns'] == patterns

    # Dynamic reassignment on pan/zoom uses those patterns.
    moved = clustering_endpoint.run_assign_to_clusters_endpoint(
        state=state, req=AssignToClustersRequest(dataset_ids=['ds1'], peak_regions=[PeakRegion(start=2, end=12)],
                                                 cluster_patterns=patterns),
        chrom='chr2R', start=0, end=30, spanning=False)
    assert moved['results']['ds1']['assignments'] == assigned

    # Similarity sorting of the resulting clusters works.
    order = sort_similarity_for_dataset(state, 'ds1', 'chr2R', 0, 30, False)
    assert sorted(order['cluster_order']) == sorted(set(assigned.values()))


def test_windows_with_their_own_peaks_need_no_shared_peak_list():
    from models.requests import ClusterViewport
    state = FakeClusterState()
    state.peak_regions = [[1, 2], [3, 4], [5, 6]]  # a stale scan elsewhere
    req = ClusterAllRequest(dataset_ids=['ds1'], method='combinatorial',
        viewports=[ClusterViewport(dataset_id='ds1', result_key='here', chrom='chr2R', start=0, end=30,
                                   peak_regions=[PeakRegion(start=10, end=20)]),
                   ClusterViewport(dataset_id='ds1', result_key='there', chrom='chr3L', start=100, end=130,
                                   peak_regions=[PeakRegion(start=110, end=120)])])
    result = clustering_endpoint.run_cluster_all_endpoint(state=state, req=req, chrom='chr2R', start=0, end=30, spanning=False)
    assert result['results']['here']['assignments'] and result['results']['there']['assignments']


def test_peak_scan_of_a_single_read_does_not_crash():
    import pandas as pd
    from services.accessibility_tracks import scan_for_peaks
    df = pd.DataFrame([{**{p: (0 if 40 <= p < 60 else 150) for p in range(0, 100)}, "read_id": "r1"}])
    assert isinstance(scan_for_peaks(df, 0, 100), list)


def test_merging_and_dissolving_keep_reads_outside_the_window(monkeypatch):
    from models.requests import AutoCullRequest
    # read-a and read-b are in view; read-z (cluster 1) and read-y (cluster 0) are off screen.
    monkeypatch.setattr(clustering_endpoint, "collect_assigned_feature_rows", lambda *a, **k: (
        [np.array([0.0], dtype=np.float32), np.array([1.0], dtype=np.float32)],
        [("ds1", "read-a"), ("ds1", "read-b")], [0, 1]))
    current = {"ds1": {"read-a": 0, "read-b": 1, "read-z": 1, "read-y": 0}}

    monkeypatch.setattr(clustering_endpoint, "dissolve_cluster_to_nearest", lambda f, a, d: (
        np.array([0, 0], dtype=np.int32), {"changed": True, "dissolved_count": 1, "remaining_clusters": [0], "reason": "x"}))
    dissolved = clustering_endpoint.run_dissolve_cluster_endpoint(
        state=FakeClusterState(), req=DissolveClusterRequest(cluster_to_dissolve=1, current_assignments=current,
            peak_regions=[PeakRegion(start=10, end=20)], dataset_ids=["ds1"]),
        chrom="chr2R", start=0, end=30, spanning=False)
    assert dissolved["results"]["ds1"]["assignments"] == {"read-a": 0, "read-b": 0, "read-z": 0, "read-y": 0}

    monkeypatch.setattr(clustering_endpoint, "run_autocull_on", lambda f, a, min_fraction, max_cosine_similarity: (
        np.array([0, 0], dtype=np.int32), [{"cluster": 1, "count": 1, "reason": "x", "dominant_target": 0}]))
    state = FakeClusterState()
    culled = clustering_endpoint.run_auto_cull_clusters_endpoint(
        state=state, req=AutoCullRequest(current_assignments=current, peak_regions=[PeakRegion(start=10, end=20)],
                                         dataset_ids=["ds1"]),
        chrom="chr2R", start=0, end=30, spanning=False)
    assert culled["results"]["ds1"]["assignments"] == {"read-a": 0, "read-b": 0, "read-z": 0, "read-y": 0}
    assert state.datasets["ds1"].cluster_assignments == culled["results"]["ds1"]["assignments"]


def test_merged_cluster_targets_follow_chains():
    from services.clustering_results import merged_cluster_targets
    assert merged_cluster_targets([{"cluster": 3, "dominant_target": 2}, {"cluster": 2, "dominant_target": 0}]) == {3: 0, 2: 0}


def test_stored_peaks_are_only_used_for_the_region_they_were_scanned_in():
    from services.peak_scanning import remember_peak_regions, stored_peak_regions_for
    state = FakeClusterState()
    remember_peak_regions(state, [[5, 15]], "chr2R", 0, 30)
    assert stored_peak_regions_for(state, "chr2R", 0, 30) == [[5, 15]]
    assert stored_peak_regions_for(state, "2R", 0, 30) == [[5, 15]]  # the same chromosome, aliased
    assert stored_peak_regions_for(state, "chr3L", 0, 30) == []
    assert stored_peak_regions_for(state, "chr2R", 100, 130) == []
    # cluster_all by peak index at another locus: nothing to cluster, not the other locus's peaks.
    req = ClusterAllRequest(dataset_ids=['ds1'], method='combinatorial', peak_indices=[0])
    assert clustering_endpoint.active_cluster_peaks(req, state, 100, "3L", 130) == ([], [])
    assert clustering_endpoint.active_cluster_peaks(req, state, 0, "2R", 30) == ([[5, 15]], ["accessibility"])


def test_legacy_cluster_uses_stored_peaks_only_where_they_were_scanned():
    from models.requests import ClusterRequest
    from services.peak_scanning import remember_peak_regions
    state = FakeClusterState()
    remember_peak_regions(state, [[0, 30]], "chr2R", 0, 30)
    used = []

    def fake_cluster(reads, peaks, start, k, method, random_state):
        used.append(peaks)
        return {r["id"]: 0 for r in reads}, {0: len(reads)}, [], None

    kwargs = dict(spanning=False, dataset_id=None, min_footprints=0, sample_seed=None, cluster_compact_reads_impl=fake_cluster)
    here = clustering_endpoint.run_cluster_endpoint(state=state, req=ClusterRequest(peak_indices=[0]),
                                                    chrom="chr2R", start=0, end=30, **kwargs)
    assert used == [[[0, 30]]] and here["assignments"]
    elsewhere = clustering_endpoint.run_cluster_endpoint(state=state, req=ClusterRequest(peak_indices=[0]),
                                                         chrom="chr3L", start=2000, end=2030, **kwargs)
    assert len(used) == 1 and elsewhere["assignments"] == {} and "scan peaks" in elsewhere["error"]


def test_dynamic_reassignment_keeps_saved_footprint_class_membership(monkeypatch):
    from models.requests import AssignToClustersRequest
    rules = [dict(id='cart', enabled=True, terms=[dict(source='footprint_class', group=dict(
        consensusStateId='A', consensusJobId='j', sourceDatasetId='ds1'))])]

    def resolve(read, group, region_start):
        # Like clustering_class_resolver: the dataset comes from the tag, else the read-ID prefix.
        dataset_id = read.get('_consensus_dataset_id') or str(read.get('id', '')).split('::', 1)[0]
        if dataset_id != group['sourceDatasetId'] or read.get('_consensus_chrom') is None:
            return []
        return [(2, 6, 1)] if str(read.get('id')).endswith('read-a') else []

    monkeypatch.setattr(clustering_endpoint, "build_cluster_rule_context",
                        lambda *a, **k: dict(resolve_footprint_class=resolve))
    state = FakeClusterState()
    peaks = [PeakRegion(start=0, end=8, mode='cluster_rule:cart')]  # both reads cover it
    first = clustering_endpoint.run_cluster_all_endpoint(
        state=state, req=ClusterAllRequest(dataset_ids=['ds1'], method='combinatorial', peak_regions=peaks,
                                           cluster_feature_rules=rules),
        chrom='chr2R', start=0, end=30, spanning=False)
    assigned = first['results']['ds1']['assignments']
    assert assigned['read-a'] != assigned['read-b']
    again = clustering_endpoint.run_assign_to_clusters_endpoint(
        state=state, req=AssignToClustersRequest(dataset_ids=['ds1'], peak_regions=peaks,
                                                 cluster_patterns=first['cluster_patterns'], cluster_feature_rules=rules),
        chrom='chr2R', start=0, end=30, spanning=False)
    assert again['results']['ds1']['assignments'] == assigned


def test_scan_peaks_on_a_custom_layer_requests_only_that_layer():
    state = FakeClusterState()
    result = clustering_endpoint.run_scan_peaks_endpoint(
        state=state,
        req=ScanPeaksRequest(min_width=5, min_reads=1, smooth_width=5, dataset_ids=["ds1"],
                             signal_source="layer:ctcf"),
        chrom="chr2R", start=0, end=30, dataset_id=None, spanning=False,
    )
    kwargs = state.calls[0][6]
    assert kwargs["include_layers"] is True
    assert tuple(kwargs["requested_layers"]) == ("ctcf",)
    assert result["n_reads"] == 2


def test_scan_peaks_rejects_unknown_bare_source():
    import pytest
    with pytest.raises(ValueError, match="layer:<name>"):
        clustering_endpoint.run_scan_peaks_endpoint(
            state=FakeClusterState(),
            req=ScanPeaksRequest(dataset_ids=["ds1"], signal_source="ctcf"),
            chrom="chr2R", start=0, end=30, dataset_id=None, spanning=False,
        )
