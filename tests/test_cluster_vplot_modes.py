"""Cluster V-plot: the traditional midpoint plot and the "full footprint" plot
(fb-n5-charts). In full-footprint mode a footprint of size s at position p adds
to row s at every position from p to p+s, so a row is the occupancy of that
footprint size along the window. Row normalisation turns each size row into
enrichment over the window's expectation for that size.
"""
from __future__ import annotations

from types import SimpleNamespace

import numpy as np
from fastapi import FastAPI
from starlette.testclient import TestClient

from services.vplot_matrix import accumulate_vplot, finish_vplot, footprint_arrays, normalize_rows


def _one(start, end, size, *, size_min=0, size_bin=1, n_size_bins=200, pos_bin=1, n_pos_bins=400, mode="span"):
    return accumulate_vplot(np.array([start]), np.array([end]), np.array([size]),
                            size_min=size_min, size_bin=size_bin, n_size_bins=n_size_bins,
                            pos_bin=pos_bin, n_pos_bins=n_pos_bins, mode=mode)


def test_full_footprint_fills_its_size_row_from_p_to_p_plus_s():
    p, s = 120, 147
    m = _one(p, p + s, s)
    expected = np.zeros(400)
    expected[p:p + s] = 1.0
    np.testing.assert_array_equal(m[s], expected)
    # Nothing in any other size row.
    assert m.sum() == s and np.count_nonzero(m.sum(axis=1)) == 1


def test_midpoint_counts_once_at_the_centre():
    p, s = 120, 147
    m = _one(p, p + s, s, mode="midpoint")
    assert m.sum() == 1 and m[s, p + s // 2] == 1


def test_full_footprint_with_coarse_bins_counts_the_covered_fraction():
    # 35 bp from 13 to 48 in 10 bp bins: 7/10 of bin 1, bins 2 and 3 whole, 8/10 of bin 4.
    m = _one(13, 48, 35, size_min=10, size_bin=10, n_size_bins=5, pos_bin=10, n_pos_bins=10)
    row = (35 - 10) // 10
    np.testing.assert_allclose(m[row], [0, 0.7, 1, 1, 0.8, 0, 0, 0, 0, 0])
    assert np.isclose(m.sum(), 35 / 10)
    # Inside one bin.
    m = _one(21, 26, 5, size_min=0, size_bin=10, n_size_bins=5, pos_bin=10, n_pos_bins=10)
    np.testing.assert_allclose(m[0], [0, 0, 0.5, 0, 0, 0, 0, 0, 0, 0])


def test_full_footprint_is_clipped_to_the_window():
    # Starts before the window and runs past its end: only the covered part counts.
    m = _one(-30, 450, 480, size_min=0, size_bin=100, n_size_bins=5, pos_bin=10, n_pos_bins=40)
    np.testing.assert_allclose(m[4], np.ones(40))
    # Entirely outside: nothing.
    assert _one(500, 600, 100, n_pos_bins=400).sum() == 0
    # Midpoint outside the window is dropped, as before.
    assert _one(-200, -50, 150, mode="midpoint").sum() == 0


def test_many_footprints_match_a_per_base_reference():
    rng = np.random.default_rng(7)
    n = 500
    starts = rng.integers(-50, 1000, n)
    sizes = rng.integers(10, 300, n)
    ends = starts + sizes
    m = accumulate_vplot(starts, ends, sizes, size_min=10, size_bin=10, n_size_bins=29,
                         pos_bin=25, n_pos_bins=40, mode="span")
    ref = np.zeros((29, 1000))
    for s, e, z in zip(starts, ends, sizes):
        r = (z - 10) // 10
        if 0 <= r < 29:
            ref[r, min(1000, max(0, s)):min(1000, max(0, e))] += 1
    np.testing.assert_allclose(m, ref.reshape(29, 40, 25).mean(axis=2))


def test_row_normalise_is_enrichment_over_the_rows_mean():
    m = np.array([[0, 2, 4, 2], [1, 1, 1, 1], [0, 0, 0, 0]], dtype=float)
    out = normalize_rows(m)
    np.testing.assert_allclose(out[0], [0, 1, 2, 1])
    np.testing.assert_allclose(out[1], [1, 1, 1, 1])
    np.testing.assert_array_equal(out[2], [0, 0, 0, 0])
    # Row normalisation runs before the log.
    np.testing.assert_allclose(finish_vplot(m, row_normalize=True, log=True)[0], np.log1p([0, 1, 2, 1]))


def test_footprint_arrays_shift_into_window_coordinates():
    s, e, z = footprint_arrays([[10, 20, 10], [30, 80, 50]], offset=-5)
    assert s.tolist() == [5, 25] and e.tolist() == [15, 75] and z.tolist() == [10, 50]
    s, e, z = footprint_arrays([], offset=0)
    assert len(s) == len(e) == len(z) == 0


def _route(monkeypatch, reads, ws_start=1000):
    import routers.clustering_visualization as cv
    dataset = SimpleNamespace(cluster_assignments={r["id"]: 0 for r in reads})
    state = SimpleNamespace(get_dataset=lambda _: dataset)
    query = SimpleNamespace(dataset_ids=["d"], sample_seed="s",
                            build_working_set=lambda *_: SimpleNamespace(reads=reads, start=ws_start))
    monkeypatch.setattr(cv.AnalysisReadQuery, "from_request", lambda *a, **k: query)
    app = FastAPI()
    app.include_router(cv.router)
    app.dependency_overrides[cv.get_state] = lambda: state
    return TestClient(app)


BODY = {"size_min": 0, "size_max": 200, "size_bin": 1, "pos_bin": 1, "smooth": 0, "log_norm": False}
URL = "/api/cluster/vplot?chrom=c&region_start=1000&region_end=1400"


def test_route_full_footprint_mode(monkeypatch):
    # A 147 bp footprint at 1120 (read coordinates are relative to the working set's start).
    client = _route(monkeypatch, [{"id": "r", "intervals": [[120, 267, 147]]}])
    span = client.post(URL, json={**BODY, "mode": "span"}).json()["data"]["d"]["0"]
    assert span["mode"] == "span" and span["row_normalize"] is False
    row = np.array(span["matrix"][147])
    assert row[120:267].tolist() == [1.0] * 147 and row[:120].sum() == 0 and row[267:].sum() == 0
    mid = client.post(URL, json=BODY).json()["data"]["d"]["0"]
    assert mid["mode"] == "midpoint"
    assert np.array(mid["matrix"]).sum() == 1 and mid["matrix"][147][120 + 147 // 2] == 1
    # An unknown mode falls back to the traditional plot.
    assert client.post(URL, json={**BODY, "mode": "edges"}).json()["data"]["d"]["0"]["mode"] == "midpoint"


def test_route_row_normalise_brings_a_rare_size_up_to_a_common_one(monkeypatch):
    # Ten 50 bp footprints at 0-50 and one 150 bp footprint at 200-350.
    reads = [{"id": f"a{i}", "intervals": [[0, 50, 50]]} for i in range(10)]
    reads.append({"id": "b", "intervals": [[200, 350, 150]]})
    client = _route(monkeypatch, reads, ws_start=1000)
    raw = np.array(client.post(URL, json={**BODY, "mode": "span"}).json()["data"]["d"]["0"]["matrix"])
    assert raw[50].max() == 1.0 and np.isclose(raw[150].max(), 0.1)
    norm = np.array(client.post(URL, json={**BODY, "mode": "span", "row_normalize": True,
                                           "row_min_footprints": 0}).json()["data"]["d"]["0"]["matrix"])
    # Each row is relative to its own mean: where it sits, the 50 bp row is
    # 400/50 times its mean and the 150 bp row 400/150 (raw: 10x apart).
    assert np.isclose(norm[50, 10], 1.0)
    assert np.isclose(norm[150, 250] / norm[50, 10], (400 / 150) / (400 / 50))


def test_row_normalise_leaves_rows_with_too_few_footprints_blank(monkeypatch):
    # One 150 bp footprint would otherwise be the brightest thing on the plot
    # (400/150 against 400/50 below, but on its own it is noise).
    reads = [{"id": f"a{i}", "intervals": [[0, 50, 50]]} for i in range(25)]
    reads.append({"id": "b", "intervals": [[200, 350, 150]]})
    client = _route(monkeypatch, reads, ws_start=1000)
    answer = client.post(URL, json={**BODY, "mode": "span", "row_normalize": True}).json()["data"]["d"]["0"]
    norm = np.array(answer["matrix"])
    assert answer["row_min_footprints"] == 20
    assert norm[150].sum() == 0 and norm[50, 10] == 1.0
    # The counts behind the guard, per row, in both modes.
    for mode in ("span", "midpoint"):
        counts = np.zeros(200, dtype=np.int64)
        accumulate_vplot(np.array([0, 0, 200]), np.array([50, 50, 350]), np.array([50, 50, 150]),
                         size_min=0, size_bin=1, n_size_bins=200, pos_bin=1, n_pos_bins=400,
                         mode=mode, row_counts=counts)
        assert counts[50] == 2 and counts[150] == 1 and counts.sum() == 3
    out = normalize_rows(np.array([[0, 2.0], [0, 4.0]]), np.array([5, 1]), min_footprints=2)
    np.testing.assert_allclose(out, [[0, 2], [0, 0]])
