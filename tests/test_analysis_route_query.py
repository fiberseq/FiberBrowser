"""Route-level regressions for shared analysis query normalization."""

from __future__ import annotations

import asyncio
import json
from collections import OrderedDict
from types import SimpleNamespace

import numpy as np
import services.read_endpoint as read_endpoint
from models.domain import WorkingSet
from models.requests import ClusterRequest, RenderRequest, ScanPeaksRequest
from routers.annotations import get_annotations_for_region
from routers.clustering import do_cluster, get_working_set_info, scan_peaks
from routers.jupyter import jupyter_get_reads
from routers.reads import get_reads_compact, get_reads_compact_all
from routers.render import _render_sync


class FakeDataset(SimpleNamespace):
    data_type = "bam"
    label = "Dataset"
    color = "#3b82f6"
    cluster_assignments = {}
    paths = []
    available_layers = {"footprint": True, "tf": True}


class FakeState:
    dataset_order = ["ds1", "ds2"]
    chroms = []

    def __init__(self):
        self.calls = []
        self.datasets = {did: FakeDataset(id=did) for did in self.dataset_order}
        self.peak_regions = [[0, 20]]
        self.max_working_reads = None
        self._broad_cache = OrderedDict()
        self._broad_cache_timeout = 300

    def translate_chrom(self, chrom):
        return {"chr2R": "2R"}.get(chrom, chrom)

    def resolve_dataset_id(self, dataset_id=None):
        if dataset_id in (None, "", "primary"):
            return "ds1"
        return dataset_id

    def get_dataset(self, dataset_id):
        return self.datasets.get(dataset_id)

    def build_working_set(self, dataset_id, chrom, start, end, spanning=False, min_footprints=0, **kwargs):
        self.calls.append((dataset_id, chrom, start, end, spanning, min_footprints, kwargs))
        return WorkingSet(
            [{"id": f"{dataset_id}-read", "intervals": [[0, end - start, -50]]}],
            total_overlapping=1,
            total_spanning=1,
            chrom=chrom,
            start=start,
            end=end,
        )


def test_jupyter_reads_uses_shared_query_normalization():
    state = FakeState()

    result = asyncio.run(
        jupyter_get_reads(
            dataset_id="primary",
            chrom="chr2R",
            start=10,
            end=30,
            spanning=True,
            min_footprints=2,
            sample_seed="paper",
            state=state,
        )
    )

    dataset_id, chrom, start, end, spanning, min_footprints, kwargs = state.calls[0]
    assert (dataset_id, chrom, start, end, spanning, min_footprints) == ("ds1", "2R", 10, 30, True, 2)
    assert kwargs["sample_seed"] == "paper"
    assert result["dataset_id"] == "ds1"
    assert result["chrom"] == "2R"
    assert result["sample_seed"] == "paper"


def test_compact_all_can_scope_to_single_dataset_alias():
    state = FakeState()

    response = asyncio.run(
        get_reads_compact_all(
            chrom="chr2R",
            start=10,
            end=30,
            dataset_id="primary",
            dataset_ids=None,
            spanning=False,
            max_reads=1000,
            downsample=None,
            include_methylation=False,
            include_layers=False,
            layer_names=None,
            ml_threshold=125,
            fill_gap_size=None,
            min_fp_quality=0,
            min_footprints=0,
            include_metaprofile=True,
            profile_max_reads=1000,
            coverage_sample=False,
            hide_terminal_gaps=True,
            terminal_gap_threshold=500,
            sample_seed=None,
            state=state,
        )
    )
    payload = json.loads(response.body)

    assert list(payload["datasets"].keys()) == ["ds1"]
    ds_payload = payload["datasets"]["ds1"]
    assert ds_payload["reads"] == [{"id": "ds1-read", "intervals": [[0, 20, -50]]}]
    assert ds_payload["count"] == 1
    assert ds_payload["display_count"] == 1
    assert ds_payload["working_count"] == 1
    assert ds_payload["total"] == 1
    assert ds_payload["total_in_scope"] == 1
    assert ds_payload["total_overlapping"] == 1
    assert ds_payload["total_spanning"] == 1
    assert state.calls[0][0] == "ds1"


def test_compact_all_metaprofile_uses_profile_pool_not_display_sample(monkeypatch):
    state = FakeState()

    def build_working_set(dataset_id, chrom, start, end, spanning=False, min_footprints=0, **kwargs):
        state.calls.append((dataset_id, chrom, start, end, spanning, min_footprints, kwargs))
        return WorkingSet(
            [
                {"id": f"{dataset_id}-read-a", "intervals": [[0, 10, 100]]},
                {"id": f"{dataset_id}-read-b", "intervals": [[10, 20, 50]]},
            ],
            total_overlapping=2,
            total_spanning=2,
            chrom=chrom,
            start=start,
            end=end,
        )

    profile_call_ids = []

    def fake_profile(reads, region_width, min_size, max_size):
        profile_call_ids.append([read["id"] for read in reads])
        return np.array([len(reads), min_size], dtype=float)

    state.build_working_set = build_working_set
    monkeypatch.setattr(read_endpoint, "compute_metaprofile_from_compact_reads", fake_profile)

    response = asyncio.run(
        get_reads_compact_all(
            chrom="chr2R",
            start=10,
            end=30,
            dataset_id="primary",
            dataset_ids=None,
            spanning=False,
            max_reads=1,
            downsample=None,
            include_methylation=False,
            include_layers=False,
            layer_names=None,
            ml_threshold=125,
            fill_gap_size=None,
            min_fp_quality=0,
            min_footprints=0,
            include_metaprofile=True,
            profile_max_reads=0,
            coverage_sample=False,
            hide_terminal_gaps=True,
            terminal_gap_threshold=500,
            sample_seed="profile-seed",
            state=state,
        )
    )
    payload = json.loads(response.body)
    ds_payload = payload["datasets"]["ds1"]

    assert len(ds_payload["reads"]) == 1
    assert ds_payload["metaprofile_read_count"] == 2
    assert ds_payload["profile_max_reads"] == 0
    assert ds_payload["metaprofile"]["nucleosome_profile"] == [2.0, 90.0]
    assert ds_payload["metaprofile"]["subnuc_profile"] == [2.0, 10.0]
    assert profile_call_ids == [
        ["ds1-read-a", "ds1-read-b"],
        ["ds1-read-a", "ds1-read-b"],
    ]


def test_compact_all_counts_preserve_scope_and_display_cap():
    state = FakeState()

    def build_working_set(dataset_id, chrom, start, end, spanning=False, min_footprints=0, **kwargs):
        state.calls.append((dataset_id, chrom, start, end, spanning, min_footprints, kwargs))
        reads = [
            {"id": f"{dataset_id}-read-a", "intervals": [[0, 20, 100]]},
            {"id": f"{dataset_id}-read-b", "intervals": [[5, 15, 50]]},
            {"id": f"{dataset_id}-read-c", "intervals": [[10, 20, 100]]},
        ]
        return WorkingSet(
            reads,
            total_overlapping=3,
            total_spanning=1,
            chrom=chrom,
            start=start,
            end=end,
        )

    state.build_working_set = build_working_set

    response = asyncio.run(
        get_reads_compact_all(
            chrom="chr2R",
            start=10,
            end=30,
            dataset_id="primary",
            dataset_ids=None,
            spanning=False,
            max_reads=1,
            downsample=None,
            include_methylation=False,
            include_layers=False,
            layer_names=None,
            ml_threshold=125,
            fill_gap_size=None,
            min_fp_quality=0,
            min_footprints=0,
            include_metaprofile=False,
            profile_max_reads=1000,
            coverage_sample=False,
            hide_terminal_gaps=True,
            terminal_gap_threshold=500,
            sample_seed="count-seed",
            state=state,
        )
    )
    payload = json.loads(response.body)
    ds_payload = payload["datasets"]["ds1"]

    assert len(ds_payload["reads"]) == 1
    assert ds_payload["count"] == 1
    assert ds_payload["display_count"] == 1
    assert ds_payload["working_count"] == 3
    assert ds_payload["total"] == 3
    assert ds_payload["total_in_scope"] == 3
    assert ds_payload["total_overlapping"] == 3
    assert ds_payload["total_spanning"] == 1


def test_scan_peaks_honors_explicit_multi_dataset_scope():
    state = FakeState()

    result = asyncio.run(
        scan_peaks(
            req=ScanPeaksRequest(dataset_ids=["ds2"], sample_seed="scan-seed"),
            chrom="chr2R",
            start=100,
            end=200,
            dataset_id=None,
            spanning=True,
            state=state,
        )
    )

    assert [call[0] for call in state.calls] == ["ds2"]
    dataset_id, chrom, start, end, spanning, _min_footprints, kwargs = state.calls[0]
    assert (dataset_id, chrom, start, end, spanning) == ("ds2", "2R", 100, 200, True)
    assert kwargs["sample_seed"] == "scan-seed"
    assert kwargs["include_methylation"] is False
    assert kwargs["include_layers"] is False
    assert result["n_reads"] == 1


def test_annotation_region_uses_lightweight_working_set_and_read_filtered_cache(monkeypatch):
    state = FakeState()
    ann_state = SimpleNamespace(
        files={"ann": SimpleNamespace(path="/tmp/ann.bb", active=True, annotation_types={})},
        confidence_thresholds={},
        type_colors={},
        _cache={},
    )
    ann_state.get_cached = lambda key: ann_state._cache.get(key)
    ann_state.set_cached = lambda key, value: ann_state._cache.__setitem__(key, value)
    state.annotation_state = ann_state
    state.read_ids = ["r1"]

    def build_working_set(dataset_id, chrom, start, end, spanning=False, min_footprints=0, **kwargs):
        state.calls.append((dataset_id, chrom, start, end, spanning, min_footprints, kwargs))
        reads = [{"id": rid, "intervals": [[0, end - start, -50]]} for rid in state.read_ids]
        return WorkingSet(reads, len(reads), len(reads), chrom, start, end)

    state.build_working_set = build_working_set
    loader_calls = []

    def fake_loader(path, chrom, start, end, confidence_thresholds=None, read_names=None):
        loader_calls.append((chrom, sorted(read_names or [])))
        return ({loader_calls[-1][1][0]: [(start, start + 5, "tf", 0.9)]}, {"tf"})

    monkeypatch.setattr("routers.annotations.load_annotations_from_bigbed", fake_loader)

    first = asyncio.run(
        get_annotations_for_region(
            chrom="chr2R",
            start=100,
            end=120,
            dataset_ids="ds1",
            file_ids="ann",
            sample_seed="same-seed",
            state=state,
        )
    )
    state.read_ids = ["r2"]
    second = asyncio.run(
        get_annotations_for_region(
            chrom="chr2R",
            start=100,
            end=120,
            dataset_ids="ds1",
            file_ids="ann",
            sample_seed="same-seed",
            state=state,
        )
    )

    assert loader_calls == [("2R", ["r1"]), ("2R", ["r2"])]
    assert state.calls[0][6]["include_methylation"] is False
    assert state.calls[0][6]["include_layers"] is False
    assert "r1" in first["annotations"]
    assert "r2" in second["annotations"]


def test_render_coverage_uses_shared_query_and_lightweight_working_set():
    state = FakeState()
    request = RenderRequest(
        chrom="chr2R",
        start=100,
        end=200,
        dataset_id="primary",
        tracks=["coverage"],
        width=200,
        format="png",
        sample_seed="render-seed",
    )

    response = _render_sync(request, state)

    dataset_id, chrom, start, end, spanning, _min_footprints, kwargs = state.calls[0]
    assert (dataset_id, chrom, start, end, spanning) == ("ds1", "2R", 100, 200, True)
    assert kwargs["sample_seed"] == "render-seed"
    assert kwargs["include_methylation"] is False
    assert kwargs["include_layers"] is False
    assert response.headers["X-Tracks"] == "coverage"


def test_compact_reads_standard_path_uses_shared_query_for_layers_and_seed():
    state = FakeState()

    response = asyncio.run(
        get_reads_compact(
            chrom="chr2R",
            start=100,
            end=160,
            max_reads=10,
            spanning=False,
            dataset_id="primary",
            include_methylation=False,
            include_layers=False,
            layer_names="tf",
            ml_threshold=125,
            fill_gap_size=None,
            min_fp_quality=0,
            min_footprints=0,
            cluster_focus=None,
            filter_ids=None,
            include_cigar=False,
            hide_terminal_gaps=True,
            terminal_gap_threshold=500,
            sample_seed="display-seed",
            state=state,
        )
    )
    payload = json.loads(response.body)

    dataset_id, chrom, start, end, spanning, min_footprints, kwargs = state.calls[0]
    assert (dataset_id, chrom, start, end, spanning, min_footprints) == ("ds1", "2R", 100, 160, False, 0)
    assert kwargs["sample_seed"] == "display-seed"
    assert kwargs["requested_layers"] == ("tf",)
    assert payload["dataset_id"] == "ds1"
    assert payload["sample_seed"] == "display-seed"


def test_compact_reads_filter_path_expires_stale_broad_cache():
    state = FakeState()
    state._broad_cache_timeout = 1
    stale_key = ("ds1", "2R", 0, 1000, False, ())
    state._broad_cache[stale_key] = (
        [{"id": "stale-read", "intervals": [[0, 60, 60]]}],
        0,
    )

    response = asyncio.run(
        get_reads_compact(
            chrom="chr2R",
            start=100,
            end=160,
            max_reads=10,
            spanning=False,
            dataset_id="primary",
            include_methylation=False,
            include_layers=False,
            layer_names=None,
            ml_threshold=125,
            fill_gap_size=None,
            min_fp_quality=0,
            min_footprints=0,
            cluster_focus=None,
            filter_ids="ds1-read",
            include_cigar=False,
            hide_terminal_gaps=True,
            terminal_gap_threshold=500,
            sample_seed="display-seed",
            state=state,
        )
    )
    payload = json.loads(response.body)

    assert stale_key not in state._broad_cache
    assert state.calls, "expired broad cache should fall back to the working set"
    assert [read["id"] for read in payload["reads"]] == ["ds1-read"]


def test_compact_reads_methylation_refetch_preserves_exact_read_id_scope():
    state = FakeState()

    def build_working_set(dataset_id, chrom, start, end, spanning=False, min_footprints=0, **kwargs):
        state.calls.append((dataset_id, chrom, start, end, spanning, min_footprints, kwargs))
        return WorkingSet(
            [
                {"id": "focus-a", "intervals": [[0, end - start, -50]], "deam": [[10, 1]]},
                {"id": "hidden-b", "intervals": [[0, end - start, -50]], "deam": [[20, 0]]},
                {"id": "focus-c", "intervals": [[0, end - start, -50]], "deam": [[30, 1]]},
            ],
            total_overlapping=3,
            total_spanning=3,
            chrom=chrom,
            start=start,
            end=end,
        )

    state.build_working_set = build_working_set

    payload = read_endpoint.compact_reads_payload_for_request(
        state,
        chrom="chr2R",
        start=100,
        end=160,
        max_reads=10,
        spanning=False,
        dataset_id="primary",
        include_methylation=True,
        include_layers=False,
        layer_names=None,
        ml_threshold=125,
        fill_gap_size=None,
        min_fp_quality=0,
        min_footprints=0,
        cluster_focus=None,
        filter_ids="focus-a,focus-c",
        include_cigar=False,
        hide_terminal_gaps=True,
        terminal_gap_threshold=500,
        sample_seed="display-seed",
    )

    assert [read["id"] for read in payload["reads"]] == ["focus-a", "focus-c"]
    assert state.calls[0][6]["include_methylation"] is True
    assert set(state.calls[0][6]["read_ids"]) == {"focus-a", "focus-c"}
    assert state.calls[0][6]["quality_filters"] == []


def test_legacy_cluster_and_working_set_info_use_shared_query(monkeypatch):
    state = FakeState()

    def fake_cluster_compact_reads(reads, peaks, start, k, method="kmeans", **kwargs):
        return ({reads[0]["id"]: 0}, {0: 1}, [0], None)

    monkeypatch.setattr("routers.clustering.cluster_compact_reads", fake_cluster_compact_reads)

    cluster_result = asyncio.run(
        do_cluster(
            req=ClusterRequest(peak_indices=[], k=2),
            chrom="chr2R",
            start=100,
            end=160,
            spanning=True,
            dataset_id="primary",
            min_footprints=3,
            sample_seed="cluster-seed",
            state=state,
        )
    )

    dataset_id, chrom, start, end, spanning, min_footprints, kwargs = state.calls[0]
    assert (dataset_id, chrom, start, end, spanning, min_footprints) == ("ds1", "2R", 100, 160, True, 3)
    assert kwargs["sample_seed"] == "cluster-seed"
    assert kwargs["include_methylation"] is False
    assert kwargs["include_layers"] is False
    assert cluster_result["sample_seed"] == "cluster-seed"

    info = asyncio.run(
        get_working_set_info(
            chrom="chr2R",
            start=200,
            end=260,
            dataset_id="primary",
            spanning=False,
            sample_seed="info-seed",
            state=state,
        )
    )
    dataset_id, chrom, start, end, spanning, _min_footprints, kwargs = state.calls[-1]
    assert (dataset_id, chrom, start, end, spanning) == ("ds1", "2R", 200, 260, False)
    assert kwargs["sample_seed"] == "info-seed"
    assert info["sample_seed"] == "info-seed"
