"""B6 round 4: contact-matrix O/E, DAF-C linked reads, UCSC bedGraph signal, catalog retries."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import numpy as np

from services import dafc_reads
from services.microc_matrix import apply_distance_expected, local_expected_per_distance
from services.orthogonal_tracks import get_ucsc_api_signal, normalize_ucsc_interval


# ── 1. Rectangular O/E ────────────────────────────────────────────────

def test_rectangular_matrix_oe_is_flat_for_uniform_contacts():
    for shape in ((2, 4), (4, 2)):
        matrix = np.ones(shape)
        expected = local_expected_per_distance(matrix)
        oe = apply_distance_expected(matrix, expected)
        assert np.allclose(oe, 1.0), (shape, oe)


def test_square_matrix_expected_unchanged():
    matrix = np.array([[4.0, 2.0, 1.0], [2.0, 4.0, 2.0], [1.0, 2.0, 4.0]])
    expected = local_expected_per_distance(matrix)
    assert np.allclose(expected, [4.0, 2.0, 1.0])


# ── 3. UCSC bedGraph values ───────────────────────────────────────────

def test_ucsc_bedgraph_values_survive_normalization():
    iv = normalize_ucsc_interval({"chromStart": 0, "chromEnd": 10, "dataValue": 7})
    assert iv["value"] == 7.0
    assert "value" not in normalize_ucsc_interval({"chromStart": 0, "chromEnd": 10, "name": "x"})


def test_ucsc_bedgraph_signal_keeps_amplitudes():
    intervals = [
        {"start": 0, "end": 50, "value": 7.0},
        {"start": 50, "end": 100, "value": 23.0},
    ]
    values = get_ucsc_api_signal(
        {"label": "t"}, "chr1", 0, 100, bins=2,
        interval_fetcher=lambda *_: intervals,
    )
    assert values == [7.0, 23.0]


def test_ucsc_bedgraph_signal_is_a_covered_base_mean():
    # One bin of 100 bp: 30 bp at 10 and 20 bp at 40 -> (300 + 800) / 50 = 22.
    intervals = [
        {"start": 0, "end": 30, "value": 10.0},
        {"start": 60, "end": 80, "value": 40.0},
    ]
    values = get_ucsc_api_signal(
        {"label": "t"}, "chr1", 0, 100, bins=1,
        interval_fetcher=lambda *_: intervals,
    )
    assert values == [22.0]


def test_ucsc_plain_intervals_are_still_counted():
    intervals = [{"start": 0, "end": 100}, {"start": 0, "end": 40}]
    values = get_ucsc_api_signal(
        {"label": "t"}, "chr1", 0, 100, bins=2,
        interval_fetcher=lambda *_: intervals,
    )
    assert values == [2.0, 1.0]


# ── 4. Merged BigBed contact queries ──────────────────────────────────

class _FakeBB:
    def __init__(self, entries):
        self._entries = entries

    def chroms(self):
        return {"chr1": 10_000}

    def entries(self, chrom, start, end):
        return self._entries

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_merged_bigbed_dataset_reads_every_file(monkeypatch):
    files = {
        "a.bb": _FakeBB([(0, 100, "read_a\t0\t+\t0\t100\t0\t1\t10,\t5,")]),
        "b.bb": _FakeBB([(0, 100, "read_b\t0\t+\t0\t100\t0\t1\t10,\t5,")]),
    }
    monkeypatch.setattr(dafc_reads.pyBigWig, "open", lambda path: files[path])
    dataset = SimpleNamespace(data_type="bigbed", paths=["a.bb", "b.bb"])
    state = SimpleNamespace(datasets={"d": dataset}, dataset_order=["d"])
    reads = dafc_reads.query_reads_for_dafc(
        "chr1", 0, 100, state=state, dafc_state=SimpleNamespace(bb=None),
    )
    assert sorted(r["name"] for r in reads) == ["read_a", "read_b"]


# ── 5. Long gaps stay negative ────────────────────────────────────────

def test_long_gap_does_not_overflow_into_a_footprint():
    seg = {"start": 0, "end": 40_100, "blockSizes": "100,", "blockStarts": "40000,"}
    arr = dafc_reads.build_read_footprint_array([seg], region_start=0, region_end=40_100)
    assert arr.dtype == np.int32
    assert np.all(arr[:40_000] == -40_000)
    assert np.all(arr[40_000:] == 100)


# ── 6. Footprint-free segments ────────────────────────────────────────

def test_footprint_free_called_segment_is_accessible():
    seg = {"start": 10, "end": 60, "blockSizes": "", "blockStarts": "", "footprintsCalled": True}
    arr = dafc_reads.build_read_footprint_array([seg], region_start=0, region_end=100)
    assert np.all(arr[10:60] == -50)
    assert np.all(arr[:10] == 0) and np.all(arr[60:] == 0)


def test_segment_without_footprint_calls_stays_empty():
    seg = {"start": 10, "end": 60, "blockSizes": "", "blockStarts": ""}
    arr = dafc_reads.build_read_footprint_array([seg], region_start=0, region_end=100)
    assert np.all(arr == 0)


def test_bigbed_rows_with_block_columns_are_marked_called():
    bb = _FakeBB([(0, 100, "r\t0\t+\t0\t100\t0\t0\t\t")])
    rows = dafc_reads.query_bigbed_for_dafc(bb, "chr1", 0, 100)
    assert rows[0]["footprintsCalled"] is True
    bb = _FakeBB([(0, 100, "only_name")])
    assert dafc_reads.query_bigbed_for_dafc(bb, "chr1", 0, 100)[0]["footprintsCalled"] is False


# ── 7. Catalog retries ────────────────────────────────────────────────

class _CatalogState:
    def __init__(self, failing):
        self._catalog_loaded = {}
        self._catalog_loaded_tracks = set()
        self.datasets = {}
        self.dataset_order = []
        self.failing = set(failing)
        self._broad_cache = {}
        self._meta_profile_cache = {}
        self._methylation_cache = {}
        self._working_set_cache = {}

    def add_dataset(self, dataset_id, path, label):
        if path in self.failing:
            raise OSError(f"cannot open {path}")
        dataset = SimpleNamespace(path=path, label=label, color=None, available_layers=None)
        self.datasets[dataset_id] = dataset
        self.dataset_order.append(dataset_id)
        return dataset


def _catalog(*paths):
    from routers.catalog import set_catalog
    set_catalog({"groups": [{"datasets": [{"path": p, "label": p} for p in paths]}]})


def teardown_function():
    from routers.catalog import set_catalog
    set_catalog(None)


def test_failed_catalog_load_is_not_marked_loaded_and_can_be_retried():
    from routers.catalog import catalog_load
    _catalog("/data/a.bam")
    state = _CatalogState(failing={"/data/a.bam"})
    result = asyncio.run(catalog_load(0, state))
    assert result["success"] is False
    assert 0 not in state._catalog_loaded

    state.failing.clear()
    result = asyncio.run(catalog_load(0, state))
    assert result["success"] is True
    assert result["dataset_ids"] == ["catalog_0_0"]
    assert state._catalog_loaded[0] == ["catalog_0_0"]


def test_partial_catalog_load_retries_only_missing_members():
    from routers.catalog import catalog_load
    _catalog("/data/a.bam", "/data/b.bam")
    state = _CatalogState(failing={"/data/b.bam"})
    result = asyncio.run(catalog_load(0, state))
    assert result["success"] is True and result["dataset_ids"] == ["catalog_0_0"]
    assert 0 not in state._catalog_loaded

    state.failing.clear()
    result = asyncio.run(catalog_load(0, state))
    assert result["dataset_ids"] == ["catalog_0_0", "catalog_0_1"]
    assert state.dataset_order == ["catalog_0_0", "catalog_0_1"]
    assert state._catalog_loaded[0] == ["catalog_0_0", "catalog_0_1"]


def test_partly_loaded_catalog_group_can_be_unloaded():
    from routers.catalog import catalog_load, catalog_unload
    _catalog("/data/a.bam", "/data/b.bam")
    state = _CatalogState(failing={"/data/b.bam"})
    asyncio.run(catalog_load(0, state))
    result = asyncio.run(catalog_unload(0, state))
    assert result["removed_ids"] == ["catalog_0_0"]
    assert state.datasets == {}
