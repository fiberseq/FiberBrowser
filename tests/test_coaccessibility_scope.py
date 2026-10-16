"""Regression tests for co-accessibility request scoping."""

import threading
import time

import numpy as np

from models.domain import WorkingSet
from services.coaccessibility_endpoint import (
    _coacc_matrix_cache,
    _coacc_matrix_inflight,
    _coacc_scope,
    _get_cached_normalized_matrix,
    get_coacc_arcs_payload,
    get_coacc_matrix_image_bytes,
    get_coacc_matrix_data_payload,
    get_coacc_metadata_payload,
    get_coacc_slice_payload,
    get_coacc_strip_image_bytes,
)
from services.coaccessibility import (
    _add_interval_bp,
    build_accessibility_matrix as _build_accessibility_matrix,
    normalize_oe_distance,
)


class FakeState:
    dataset_order = ["ds1", "ds2"]
    datasets = {"ds1": object(), "ds2": object()}

    def __init__(self):
        self.calls = []

    def translate_chrom(self, chrom):
        return {"chr2R": "2R"}.get(chrom, chrom)

    def get_dataset(self, dataset_id):
        return self.datasets.get(dataset_id)

    def build_working_set(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        return WorkingSet(
            [
                {
                    "id": "r1",
                    "intervals": [[0, 100, -10]],
                    "layers": {"tf": {"intervals": [[0, 50, 50]]}},
                }
            ],
            total_overlapping=1,
            total_spanning=1,
            chrom=args[1],
            start=args[2],
            end=args[3],
        )


def test_coacc_scope_normalizes_seed_dataset_chrom_and_layer_working_set():
    state = FakeState()
    scope = _coacc_scope(
        state,
        chrom="chr2R",
        start=100,
        end=200,
        bin_size=50,
        dataset_ids="primary",
        read_ids="r1,r3",
        layer="tf",
        sample_seed="paper",
    )

    accessibility, n_reads = _build_accessibility_matrix(
        state,
        scope.query,
        scope.bin_size,
        layer="tf",
    )

    args, kwargs = state.calls[0]
    assert scope.chrom == "2R"
    assert scope.sample_seed == "paper"
    assert scope.query.dataset_ids == ["ds1"]
    assert args[:6] == ("ds1", "2R", 100, 200, False, 0)
    assert kwargs["read_ids"] == ["r1", "r3"]
    assert kwargs["include_methylation"] is False
    assert kwargs["include_layers"] is True
    assert kwargs["requested_layers"] == ("tf",)
    assert kwargs["sample_seed"] == "paper"
    assert n_reads == 1
    np.testing.assert_allclose(accessibility, np.array([[1.0, 0.0]], dtype=np.float32))


def test_coacc_scope_accepts_dataset_scoped_read_ids():
    state = FakeState()
    scope = _coacc_scope(
        state,
        chrom="chr2R",
        start=100,
        end=200,
        bin_size=50,
        dataset_ids="ds1,ds2",
        read_ids_by_dataset='{"ds1":["r1"],"ds2":["r2"]}',
        sample_seed="paper",
    )

    _build_accessibility_matrix(state, scope.query, scope.bin_size)

    assert scope.query.read_ids_by_dataset == {"ds1": ["r1"], "ds2": ["r2"]}
    assert state.calls[0][1]["read_ids"] == ["r1"]
    assert state.calls[1][1]["read_ids"] == ["r2"]


def test_coacc_scope_preserves_explicit_empty_dataset_scopes():
    state = FakeState()
    scope = _coacc_scope(
        state,
        chrom="chr2R",
        start=100,
        end=200,
        bin_size=50,
        dataset_ids="ds1,ds2",
        read_ids_by_dataset='{"ds1":[],"ds2":["r2"]}',
    )

    _build_accessibility_matrix(state, scope.query, scope.bin_size)

    assert scope.query.read_ids_by_dataset == {"ds1": [], "ds2": ["r2"]}
    assert state.calls[0][1]["read_ids"] == []
    assert state.calls[1][1]["read_ids"] == ["r2"]


def test_interval_bp_accumulator_handles_clipping_and_middle_bins():
    row = np.zeros(3, dtype=np.float32)
    _add_interval_bp(row, 50, 250, bin_size=100, n_bins=3, region_width=300)
    np.testing.assert_allclose(row, np.array([50, 100, 50], dtype=np.float32))

    clipped = np.zeros(3, dtype=np.float32)
    _add_interval_bp(clipped, -20, 350, bin_size=100, n_bins=3, region_width=300)
    np.testing.assert_allclose(clipped, np.array([100, 100, 100], dtype=np.float32))

    tail_preserved = np.zeros(2, dtype=np.float32)
    _add_interval_bp(tail_preserved, 0, 250, bin_size=100, n_bins=2, region_width=250)
    np.testing.assert_allclose(tail_preserved, np.array([100, 100], dtype=np.float32))


def test_coacc_fire_layer_uses_legacy_msp_payload():
    class FireAliasState(FakeState):
        def build_working_set(self, *args, **kwargs):
            self.calls.append((args, kwargs))
            return WorkingSet(
                [
                    {
                        "id": "r1",
                        "intervals": [[0, 100, 100]],
                        "layers": {"msp": {"intervals": [[0, 50, 50]]}},
                    }
                ],
                total_overlapping=1,
                total_spanning=1,
                chrom=args[1],
                start=args[2],
                end=args[3],
            )

    state = FireAliasState()
    scope = _coacc_scope(state, chrom="chr2R", start=100, end=200, bin_size=50, dataset_ids="ds1", layer="fire")

    accessibility, n_reads = _build_accessibility_matrix(state, scope.query, scope.bin_size, layer="fire")

    assert n_reads == 1
    np.testing.assert_allclose(accessibility, np.array([[1.0, 0.0]], dtype=np.float32))


def test_coacc_all_fp_layer_loads_all_layers_and_unions_fp_payload():
    class AllFpState(FakeState):
        def build_working_set(self, *args, **kwargs):
            self.calls.append((args, kwargs))
            return WorkingSet(
                [
                    {
                        "id": "r1",
                        "intervals": [[0, 100, 100]],
                        "layers": {
                            "nuc": {"intervals": [[0, 50, 50]]},
                            "tf": {"intervals": [[50, 100, 50]]},
                            "fire": {"intervals": [[0, 100, 100]]},
                        },
                    }
                ],
                total_overlapping=1,
                total_spanning=1,
                chrom=args[1],
                start=args[2],
                end=args[3],
            )

    state = AllFpState()
    scope = _coacc_scope(state, chrom="chr2R", start=100, end=200, bin_size=50, dataset_ids="ds1", layer="all_fp")

    accessibility, n_reads = _build_accessibility_matrix(state, scope.query, scope.bin_size, layer="all_fp")

    assert state.calls[0][1]["include_layers"] is True
    assert state.calls[0][1]["requested_layers"] == ()
    assert n_reads == 1
    np.testing.assert_allclose(accessibility, np.array([[1.0, 1.0]], dtype=np.float32))


def test_coacc_normalized_matrix_cache_reuses_matching_request(monkeypatch):
    state = FakeState()
    scope = _coacc_scope(
        state,
        chrom="chr2R",
        start=100,
        end=300,
        bin_size=100,
        dataset_ids="ds1",
        sample_seed="paper",
    )
    calls = []

    def fake_compute(*args, **kwargs):
        calls.append((args, kwargs))
        matrix = np.full((2, 2), len(calls), dtype=np.float32)
        return matrix, scope.bin_size, 7, matrix.copy(), np.ones((2, 2), dtype=np.int32)

    monkeypatch.setattr("services.coaccessibility_endpoint._compute_normalized_matrix", fake_compute)
    _coacc_matrix_cache.clear()

    first = _get_cached_normalized_matrix(state, scope, "correlation", 5)
    second = _get_cached_normalized_matrix(state, scope, "correlation", 5)

    assert len(calls) == 1
    assert second is first
    np.testing.assert_allclose(second[0], np.ones((2, 2), dtype=np.float32))

    _get_cached_normalized_matrix(state, scope, "oe", 5)

    assert len(calls) == 2


def test_coacc_normalized_matrix_cache_singleflights_concurrent_requests(monkeypatch):
    state = FakeState()
    scope = _coacc_scope(state, chrom="chr2R", start=100, end=300, bin_size=100, dataset_ids="ds1")
    calls = []
    entered = threading.Event()

    def fake_compute(*args, **kwargs):
        calls.append((args, kwargs))
        entered.set()
        time.sleep(0.05)
        matrix = np.full((2, 2), 9, dtype=np.float32)
        return matrix, scope.bin_size, 5, matrix.copy(), np.ones((2, 2), dtype=np.int32)

    monkeypatch.setattr("services.coaccessibility_endpoint._compute_normalized_matrix", fake_compute)
    _coacc_matrix_cache.clear()
    _coacc_matrix_inflight.clear()

    results = []

    def worker():
        results.append(_get_cached_normalized_matrix(state, scope, "correlation", 5))

    first = threading.Thread(target=worker)
    second = threading.Thread(target=worker)
    first.start()
    assert entered.wait(timeout=1)
    second.start()
    first.join(timeout=1)
    second.join(timeout=1)

    assert not first.is_alive()
    assert not second.is_alive()
    assert len(calls) == 1
    assert len(results) == 2
    assert results[0] is results[1]
    assert _coacc_matrix_inflight == {}


def test_coacc_normalized_matrix_cache_respects_quality_filters(monkeypatch):
    state = FakeState()
    scope = _coacc_scope(state, chrom="chr2R", start=100, end=300, bin_size=100, dataset_ids="ds1")
    calls = []

    def fake_compute(*args, **kwargs):
        calls.append((args, kwargs))
        matrix = np.full((2, 2), len(calls), dtype=np.float32)
        return matrix, scope.bin_size, 3, matrix.copy(), np.ones((2, 2), dtype=np.int32)

    monkeypatch.setattr("services.coaccessibility_endpoint._compute_normalized_matrix", fake_compute)
    _coacc_matrix_cache.clear()

    _get_cached_normalized_matrix(state, scope, "oe", 20)
    state.quality_filters = [{"id": "q1", "field": "read_length", "op": "gte", "value": 500}]
    _get_cached_normalized_matrix(state, scope, "oe", 20)

    assert len(calls) == 2


def test_coacc_endpoint_payload_helpers_share_matrix_response_schema(monkeypatch):
    state = FakeState()
    scope = _coacc_scope(state, chrom="chr2R", start=100, end=400, bin_size=100, dataset_ids="ds1", sample_seed="paper")
    matrix = np.array(
        [
            [np.nan, 1.25, 2.5],
            [1.25, np.nan, 0.5],
            [2.5, 0.5, np.nan],
        ],
        dtype=np.float32,
    )
    raw = np.array(
        [
            [0.1, 0.2, np.nan],
            [0.2, 0.5, 0.6],
            [np.nan, 0.6, 0.9],
        ],
        dtype=np.float32,
    )
    coverage = np.array(
        [
            [5, 6, 7],
            [6, 8, 9],
            [7, 9, 10],
        ],
        dtype=np.int32,
    )

    def fake_cached(_state, _scope, _normalization, _min_coverage, **_kwargs):
        return matrix, None, 11, raw, coverage

    monkeypatch.setattr("services.coaccessibility_endpoint._get_cached_normalized_matrix", fake_cached)

    metadata = get_coacc_metadata_payload(state, scope, "oe", 20)
    assert metadata["n_bins"] == 3
    assert metadata["bin_size"] == 100
    assert metadata["n_reads"] == 11
    assert metadata["coverage_median"] == 8
    assert metadata["masked_fraction"] == 0.2222
    assert metadata["marginal_accessibility"] == [0.1, 0.5, 0.9]
    assert metadata["sample_seed"] == "paper"

    data = get_coacc_matrix_data_payload(state, scope, "oe", 20)
    assert data["chrom"] == "2R"
    assert data["matrix"][0] == [None, 1.25, 2.5]
    assert data["coverage"][2] == [7.0, 9.0, 10.0]
    assert data["marginal_accessibility"] == [0.1, 0.5, 0.9]

    slice_payload = get_coacc_slice_payload(state, scope, position=150, normalization="oe", min_coverage=20)
    assert slice_payload["viewpoint_bin"] == 0
    assert slice_payload["viewpoint_start"] == 100
    assert slice_payload["viewpoint_end"] == 200
    assert slice_payload["profile"] == [None, 1.25, 2.5]
    assert slice_payload["coverage"] == [5, 6, 7]

    arcs = get_coacc_arcs_payload(
        state,
        scope,
        "oe",
        20,
        threshold=1.0,
        max_arcs=5,
        min_distance=1,
    )
    assert arcs == {
        "arcs": [
            {"start": 150, "end": 350, "strength": 2.5, "coverage": 7},
            {"start": 150, "end": 250, "strength": 1.25, "coverage": 6},
        ],
        "bin_size": 100,
        "n_arcs": 2,
        "sample_seed": "paper",
    }


def test_coacc_payload_helpers_return_empty_shapes_for_invalid_scope():
    query = type("Query", (), {
        "chrom": "chr1",
        "start": 10,
        "end": 10,
        "region_width": 0,
        "sample_seed": "seed",
        "dataset_ids": [],
        "read_ids_by_dataset": {},
        "singleton_read_ids": [],
        "spanning": False,
        "max_reads": None,
        "min_footprints": 0,
        "include_methylation": False,
        "include_layers": False,
        "requested_layers": (),
    })()
    scope = type("Scope", (), {
        "query": query,
        "bin_size": 0,
        "chrom": "chr1",
        "start": 10,
        "end": 10,
        "region_width": 0,
        "sample_seed": "seed",
    })()

    assert get_coacc_metadata_payload(None, scope, "oe", 20) == {"n_bins": 0, "bin_size": 0, "n_reads": 0}
    assert get_coacc_matrix_data_payload(None, scope, "oe", 20) == {"matrix": [], "coverage": [], "n_bins": 0, "n_reads": 0}
    assert get_coacc_slice_payload(None, scope, 10, "oe", 20)["profile"] == []
    assert get_coacc_arcs_payload(None, scope, "oe", 20) == {"arcs": [], "bin_size": 0, "n_arcs": 0}


def test_coacc_image_helpers_emit_png_bytes(monkeypatch):
    from PIL import Image

    state = FakeState()
    scope = _coacc_scope(state, chrom="chr2R", start=100, end=400, bin_size=100, dataset_ids="ds1")
    matrix = np.array(
        [
            [np.nan, 1.0, 2.0],
            [1.0, np.nan, 3.0],
            [2.0, 3.0, np.nan],
        ],
        dtype=np.float32,
    )
    coverage = np.full((3, 3), 5, dtype=np.int32)

    def fake_cached(_state, _scope, _normalization, _min_coverage, **_kwargs):
        return matrix, None, 3, matrix.copy(), coverage

    def fake_render(mat, **kwargs):
        assert mat is matrix
        assert kwargs["scaling"] == "sqrt"
        return Image.new("RGB", (4, 4), (255, 0, 0))

    def fake_colormap(norm, _colormap):
        rgb = np.zeros((*norm.shape, 3), dtype=np.uint8)
        rgb[:, :, 0] = 255
        return rgb

    monkeypatch.setattr("services.coaccessibility_endpoint._get_cached_normalized_matrix", fake_cached)

    matrix_png = get_coacc_matrix_image_bytes(
        state,
        scope,
        "oe",
        20,
        render_contact_matrix_image=fake_render,
        scaling="sqrt",
    )
    strip_png = get_coacc_strip_image_bytes(
        state,
        scope,
        "oe",
        20,
        apply_colormap=fake_colormap,
        width=12,
        height=6,
    )

    assert matrix_png.startswith(b"\x89PNG")
    assert strip_png.startswith(b"\x89PNG")
    # The strip actually draws the contacts (it used to accumulate onto NaN and come out empty).
    import io
    strip = np.asarray(Image.open(io.BytesIO(strip_png)).convert("RGBA"))
    assert strip[:, :, 3].max() > 0


def test_distance_oe_normalization_matches_dense_reference():
    raw = np.array(
        [
            [0.7, 0.2, np.nan, 0.4],
            [0.2, 0.8, 0.3, np.nan],
            [np.nan, 0.3, 0.9, 0.5],
            [0.4, np.nan, 0.5, 0.6],
        ],
        dtype=np.float32,
    )
    n = raw.shape[0]
    expected_per_dist = np.zeros(n, dtype=np.float64)
    for d in range(n):
        diag = np.diag(raw, d)
        valid = diag[~np.isnan(diag)]
        if len(valid) > 0:
            expected_per_dist[d] = np.mean(valid)
    expected_per_dist[expected_per_dist == 0] = 0.001
    dist_matrix = np.abs(np.arange(n)[:, None] - np.arange(n)[None, :])
    exp_vals = expected_per_dist[np.clip(dist_matrix, 0, n - 1)]
    reference = np.where(~np.isnan(raw), raw / exp_vals, np.nan)
    np.fill_diagonal(reference, np.nan)

    np.testing.assert_allclose(normalize_oe_distance(raw), reference)
