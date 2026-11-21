"""Footprint size enrichment (size x position, coloured by how enriched each
size is at each position): the all-reads mode of /api/cluster/vplot (no
clustering needed), its four normalisations, the minimum-footprints guard,
and the per-axis Gaussian whose sigmas are given in bp.
"""
from __future__ import annotations

from types import SimpleNamespace

import numpy as np
import pytest
from fastapi import FastAPI
from scipy.ndimage import gaussian_filter
from starlette.testclient import TestClient

from services.vplot_matrix import (
    accumulate_vplot, finish_vplot, gaussian_smooth, legacy_sigmas_bp, normalize_columns, observed_over_expected,
    sigma_bins,
)


# ---------------------------------------------------------------- matrix maths

M = np.array([[0, 2, 4, 2], [1, 1, 1, 1], [3, 0, 0, 1]], dtype=float)


def test_row_normalisation_is_each_row_over_its_mean():
    out = finish_vplot(M, normalization="row")
    np.testing.assert_allclose(out[0], [0, 1, 2, 1])
    np.testing.assert_allclose(out.mean(axis=1), [1, 1, 1])


def test_column_normalisation_is_each_column_over_its_mean():
    out = finish_vplot(M, normalization="column")
    np.testing.assert_allclose(out.mean(axis=0), [1, 1, 1, 1])
    np.testing.assert_allclose(out[:, 0], np.array([0, 1, 3]) / (4 / 3))
    np.testing.assert_allclose(normalize_columns(M), out)


def test_observed_over_expected_uses_both_margins():
    out = finish_vplot(M, normalization="oe")
    expected = M.sum(axis=1, keepdims=True) * M.sum(axis=0, keepdims=True) / M.sum()
    np.testing.assert_allclose(out, M / expected)
    # A matrix that is exactly the product of its margins is 1 everywhere.
    outer = np.outer([1, 2, 3], [4, 1, 2, 5]).astype(float)
    np.testing.assert_allclose(observed_over_expected(outer), np.ones_like(outer))


def test_raw_is_the_counts_and_row_normalize_still_selects_row():
    np.testing.assert_array_equal(finish_vplot(M, normalization="raw"), M)
    np.testing.assert_allclose(finish_vplot(M, row_normalize=True), finish_vplot(M, normalization="row"))
    # An explicit normalisation wins over the older flag.
    np.testing.assert_array_equal(finish_vplot(M, row_normalize=True, normalization="raw"), M)


def test_min_footprints_guard_blanks_rows_or_columns():
    rows = np.array([30, 5, 40])
    cols = np.array([25, 3, 50, 50])
    nan = float("nan")
    r = finish_vplot(M, normalization="row", row_counts=rows, row_min_footprints=20, blank=nan)
    assert np.isnan(r[1]).all() and np.isfinite(r[0]).all()
    c = finish_vplot(M, normalization="column", col_counts=cols, row_min_footprints=20, blank=nan)
    assert np.isnan(c[:, 1]).all() and np.isfinite(c[:, 0]).all()
    o = finish_vplot(M, normalization="oe", row_counts=rows, row_min_footprints=20, blank=nan)
    assert np.isnan(o[1]).all() and np.isfinite(o[0]).all()
    # Guard 0: nothing blanked.
    assert np.isfinite(finish_vplot(M, normalization="row", row_counts=rows, row_min_footprints=0, blank=nan)).all()


def test_column_counts_are_footprints_touching_each_bin():
    cols = np.zeros(10, dtype=np.int64)
    # 13-48 touches bins 1..4 (10 bp bins); 21-26 bin 2 only.
    accumulate_vplot(np.array([13, 21]), np.array([48, 26]), np.array([35, 5]), size_min=0, size_bin=10,
                     n_size_bins=5, pos_bin=10, n_pos_bins=10, mode="span", col_counts=cols)
    assert cols.tolist() == [0, 1, 2, 1, 1, 0, 0, 0, 0, 0]
    cols = np.zeros(10, dtype=np.int64)
    accumulate_vplot(np.array([13, 21]), np.array([48, 26]), np.array([35, 5]), size_min=0, size_bin=10,
                     n_size_bins=5, pos_bin=10, n_pos_bins=10, mode="midpoint", col_counts=cols)
    assert cols.tolist() == [0, 0, 1, 1, 0, 0, 0, 0, 0, 0]  # midpoints 30 and 23


def test_sigma_in_bp_becomes_bins_of_each_axis():
    assert sigma_bins(20, 10) == 2.0 and sigma_bins(20, 5) == 4.0
    assert sigma_bins(0, 10) == 0.0 and sigma_bins(None, 10) == 0.0
    # The older smooth (bins, both axes) as bp: times each axis's bin width.
    assert legacy_sigmas_bp(1.5, 5, 20) == (7.5, 30.0)
    assert legacy_sigmas_bp(0, 5, 20) == (0.0, 0.0)


def test_gaussian_is_separable_with_its_own_sigma_per_axis():
    impulse = np.zeros((41, 61))
    impulse[20, 30] = 1.0
    # Size bins of 5 bp, position bins of 10 bp; sigma 10 bp down sizes (2 bins), 40 bp along positions (4 bins).
    out = finish_vplot(impulse, sigma_bins_size=sigma_bins(10, 5), sigma_bins_pos=sigma_bins(40, 10))
    np.testing.assert_allclose(out, gaussian_filter(impulse, sigma=(2.0, 4.0)))
    # Separable: the outer product of its two 1-D profiles.
    np.testing.assert_allclose(out, np.outer(out[:, 30] / out[20, 30], out[20, :]), atol=1e-12)
    # The spread of each axis is its own sigma (in bins).
    pos_profile = out[20] / out[20].sum()
    size_profile = out[:, 30] / out[:, 30].sum()
    x = np.arange(61) - 30
    y = np.arange(41) - 20
    assert np.isclose(np.sqrt((pos_profile * x ** 2).sum()), 4.0, atol=0.05)
    assert np.isclose(np.sqrt((size_profile * y ** 2).sum()), 2.0, atol=0.05)


def test_sigma_zero_turns_one_axis_off():
    impulse = np.zeros((11, 11))
    impulse[5, 5] = 1.0
    pos_only = gaussian_smooth(impulse, 0, 2)
    assert np.count_nonzero(pos_only.sum(axis=1)) == 1  # nothing leaks into other sizes
    size_only = gaussian_smooth(impulse, 2, 0)
    assert np.count_nonzero(size_only.sum(axis=0)) == 1
    np.testing.assert_array_equal(gaussian_smooth(impulse, 0, 0), impulse)


def test_legacy_smooth_matches_the_bp_sigmas_it_maps_to():
    rng = np.random.default_rng(3)
    m = rng.poisson(3, size=(29, 80)).astype(float)
    size_bin, pos_bin, smooth = 10, 25, 1.5
    legacy = finish_vplot(m, smooth=smooth, row_normalize=True)
    s_bp, p_bp = legacy_sigmas_bp(smooth, size_bin, pos_bin)
    new = finish_vplot(m, normalization="row", sigma_bins_size=sigma_bins(s_bp, size_bin),
                       sigma_bins_pos=sigma_bins(p_bp, pos_bin))
    np.testing.assert_allclose(legacy, new)


# ---------------------------------------------------------------- the route

def _route(monkeypatch, reads_by_ds, assignments=None, ws_start=1000):
    import routers.clustering_visualization as cv
    datasets = {d: SimpleNamespace(cluster_assignments=(assignments or {}).get(d)) for d in reads_by_ds}
    state = SimpleNamespace(get_dataset=lambda d: datasets.get(d))
    seen = {}

    def from_request(*a, **k):
        seen.update(k)
        ids = k.get("dataset_ids") or list(reads_by_ds)
        return SimpleNamespace(dataset_ids=ids, sample_seed="s",
                               build_working_set=lambda _s, d: SimpleNamespace(reads=reads_by_ds[d], start=ws_start))

    monkeypatch.setattr(cv.AnalysisReadQuery, "from_request", from_request)
    app = FastAPI()
    app.include_router(cv.router)
    app.dependency_overrides[cv.get_state] = lambda: state
    return TestClient(app), seen


URL = "/api/cluster/vplot?chrom=c&region_start=1000&region_end=1400"
BODY = {"size_min": 0, "size_max": 200, "size_bin": 10, "pos_bin": 10, "log_norm": True,
        "sigma_size_bp": 0, "sigma_pos_bp": 0, "raw_values": True, "mode": "span"}


def _reads(n_small=30, n_big=25, prefix="r"):
    reads = [{"id": f"{prefix}s{i}", "intervals": [[0, 50, 50]]} for i in range(n_small)]
    reads += [{"id": f"{prefix}b{i}", "intervals": [[200, 350, 150]]} for i in range(n_big)]
    return reads


def test_all_reads_mode_needs_no_clusters(monkeypatch):
    client, seen = _route(monkeypatch, {"d1": _reads(), "d2": _reads(40, 30, "x")})
    body = client.post(URL, json={**BODY, "group_by": "all", "normalization": "raw"}).json()
    assert body["success"]
    for ds, n_reads in (("d1", 55), ("d2", 70)):
        entry = body["data"][ds]["-1"]
        assert entry["group_by"] == "all" and entry["raw_values"] is True
        assert entry["n_reads"] == n_reads and entry["n_footprints"] == n_reads
        m = np.array(entry["matrix"], dtype=float)
        # Raw counts, not scaled to a maximum and no log1p: 30 footprints cover bins 0-4 of the 50 bp row.
        assert m[5, 0] == (30 if ds == "d1" else 40)
    # Without clusters the cluster mode has nothing to plot.
    assert client.post(URL, json={**BODY, "normalization": "raw"}).json()["data"] == {}


@pytest.mark.parametrize("norm", ["raw", "row", "oe"])
def test_pooled_sums_the_datasets_raw_counts_then_normalises_once(monkeypatch, norm):
    """group_by="pooled" (Plots, Group by None): every dataset's reads in one matrix, as if they were one dataset."""
    client, _ = _route(monkeypatch, {"d1": _reads(), "d2": _reads(40, 30, "x")})
    body = client.post(URL, json={**BODY, "group_by": "pooled", "normalization": norm}).json()
    assert body["success"]
    assert list(body["data"]) == ["__pooled__"]
    pooled = body["data"]["__pooled__"]["-1"]
    assert pooled["group_by"] == "pooled" and pooled["n_reads"] == 125 and pooled["n_footprints"] == 125
    # The same reads as one dataset give the same matrix.
    client1, _ = _route(monkeypatch, {"one": _reads() + _reads(40, 30, "x")})
    one = client1.post(URL, json={**BODY, "group_by": "all", "normalization": norm}).json()["data"]["one"]["-1"]
    a = np.array(pooled["matrix"], dtype=float)
    b = np.array(one["matrix"], dtype=float)
    np.testing.assert_allclose(a, b, equal_nan=True)


def test_dataset_ids_restrict_the_scope(monkeypatch):
    client, seen = _route(monkeypatch, {"d1": _reads(), "d2": _reads()})
    body = client.post(URL, json={**BODY, "group_by": "all", "dataset_ids": ["d2"]}).json()
    assert list(body["data"]) == ["d2"] and seen["dataset_ids"] == ["d2"]


@pytest.mark.parametrize("norm", ["row", "column", "oe", "raw"])
def test_each_normalisation_through_the_route(monkeypatch, norm):
    client, _ = _route(monkeypatch, {"d": _reads()})
    entry = client.post(URL, json={**BODY, "group_by": "all", "normalization": norm,
                                   "row_min_footprints": 0}).json()["data"]["d"]["-1"]
    assert entry["normalization"] == norm and entry["row_normalize"] == (norm == "row")
    got = np.array([[np.nan if v is None else v for v in row] for row in entry["matrix"]], dtype=float)
    raw = np.zeros((20, 40))
    raw[5, 0:5] = 30
    raw[15, 20:35] = 25
    want = finish_vplot(raw, normalization=norm, blank=float("nan"))
    np.testing.assert_allclose(got, want, rtol=1e-5, equal_nan=True)


def test_guard_leaves_sparse_rows_null(monkeypatch):
    client, _ = _route(monkeypatch, {"d": _reads(30, 5)})
    entry = client.post(URL, json={**BODY, "group_by": "all", "normalization": "row",
                                   "row_min_footprints": 20}).json()["data"]["d"]["-1"]
    assert entry["row_min_footprints"] == 20
    assert all(v is None for v in entry["matrix"][15])  # 5 footprints of 150 bp: blank
    assert entry["matrix"][5][0] == pytest.approx(40 / 5)  # 50 bp row: 5 of 40 bins covered


def test_route_sigmas_are_in_bp(monkeypatch):
    client, _ = _route(monkeypatch, {"d": _reads()})
    entry = client.post(URL, json={**BODY, "group_by": "all", "normalization": "raw", "size_bin": 10, "pos_bin": 10,
                                   "sigma_size_bp": 20, "sigma_pos_bp": 30}).json()["data"]["d"]["-1"]
    assert entry["sigma_size_bp"] == 20 and entry["sigma_pos_bp"] == 30
    raw = np.zeros((20, 40))
    raw[5, 0:5] = 30
    raw[15, 20:35] = 25
    np.testing.assert_allclose(np.array(entry["matrix"], dtype=float), gaussian_filter(raw, sigma=(2.0, 3.0)), rtol=1e-5, atol=1e-5)


def test_legacy_requests_are_answered_as_before(monkeypatch):
    # No new fields: smooth is one sigma in bins on both axes, the matrix scaled to its maximum.
    reads = _reads()
    client, _ = _route(monkeypatch, {"d": reads}, assignments={"d": {r["id"]: 0 for r in reads}})
    legacy = {"size_min": 0, "size_max": 200, "size_bin": 10, "pos_bin": 10, "smooth": 1.0, "log_norm": True,
              "mode": "span", "row_normalize": True, "row_min_footprints": 0}
    entry = client.post(URL, json=legacy).json()["data"]["d"]["0"]
    assert "raw_values" not in entry
    raw = np.zeros((20, 40))
    raw[5, 0:5] = 30
    raw[15, 20:35] = 25
    want = finish_vplot(raw, smooth=1.0, row_normalize=True, log=True)
    np.testing.assert_allclose(np.array(entry["matrix"]), want / want.max(), rtol=1e-6)


def test_all_footprints_source_joins_calls_and_tf_layer_once(monkeypatch):
    # Calls hold the nucleosome-sized footprints, the TF layer the small ones; one footprint in both counts once.
    reads = [{"id": f"r{i}", "intervals": [[200, 350, 150], [0, 40, 40]],
              "layers": {"tf": {"intervals": [[0, 40, 40], [100, 130, 30]]}}} for i in range(25)]
    client, seen = _route(monkeypatch, {"d": reads})
    entry = client.post(URL, json={**BODY, "group_by": "all", "normalization": "raw", "layer": "all_footprints",
                                   "mode": "midpoint"}).json()["data"]["d"]["-1"]
    assert seen["requested_layers"] == ["nuc", "tf"] and seen["include_layers"] is True
    assert entry["n_footprints"] == 25 * 3
    m = np.array(entry["matrix"], dtype=float)
    assert m[15].sum() == 25 and m[4].sum() == 25 and m[3].sum() == 25
    # The calls alone (no layer): only what the calls hold.
    calls = client.post(URL, json={**BODY, "group_by": "all", "normalization": "raw", "mode": "midpoint"}).json()["data"]["d"]["-1"]
    assert calls["n_footprints"] == 25 * 2


def test_all_footprints_source_is_the_nuc_and_tf_layers(monkeypatch):
    # With a Nuc layer, All footprints is Nuc + TF (the calls are not added again: a call the Nuc layer holds at
    # slightly different coordinates must not count twice); a footprint in both layers counts once.
    reads = [{"id": f"r{i}", "intervals": [[200, 350, 150], [0, 40, 40], [201, 351, 150]],
              "layers": {"nuc": {"intervals": [[200, 350, 150], [240, 390, 150]]},
                         "tf": {"intervals": [[0, 40, 40], [240, 390, 150]]}}} for i in range(25)]
    client, _ = _route(monkeypatch, {"d": reads})
    entry = client.post(URL, json={**BODY, "size_max": 300, "group_by": "all", "normalization": "raw",
                                   "layer": "all_footprints", "mode": "midpoint"}).json()["data"]["d"]["-1"]
    assert entry["n_footprints"] == 25 * 3
    nuc = client.post(URL, json={**BODY, "size_max": 300, "group_by": "all", "normalization": "raw",
                                 "layer": "nuc", "mode": "midpoint"}).json()["data"]["d"]["-1"]
    assert nuc["n_footprints"] == 25 * 2


def test_named_lifted_datasets_are_left_out_not_an_error(monkeypatch):
    import services.lift.capability as cap
    client, seen = _route(monkeypatch, {"d1": _reads(), "lifted": _reads()})
    monkeypatch.setattr(cap, "is_lifted", lambda ds: getattr(ds, "lifted", False))
    import routers.clustering_visualization as cv
    lifted = SimpleNamespace(cluster_assignments=None, lifted=True)
    plain = SimpleNamespace(cluster_assignments=None, lifted=False)
    client.app.dependency_overrides[cv.get_state] = lambda: SimpleNamespace(
        get_dataset=lambda d: {"d1": plain, "lifted": lifted}.get(d), datasets={"d1": plain, "lifted": lifted})
    body = client.post(URL, json={**BODY, "group_by": "all", "dataset_ids": ["d1", "lifted"]}).json()
    assert body["success"] and list(body["data"]) == ["d1"] and seen["dataset_ids"] == ["d1"]
    only = client.post(URL, json={**BODY, "group_by": "all", "dataset_ids": ["lifted"]}).json()
    assert only == {"success": True, "data": {}, "sample_seed": None}


def test_random_n_reads_by_the_stable_rule(monkeypatch):
    # Plots' Random N reads per dataset: the reads with the smallest stable keys, whatever the order.
    from services.stable_sample import sample_names
    reads = {"d1": _reads(prefix="a")}
    client, _ = _route(monkeypatch, reads)
    body = client.post(URL, json={**BODY, "group_by": "all", "normalization": "raw", "sample_n": 10, "sample_seed_int": 3}).json()
    entry = body["data"]["d1"]["-1"]
    assert entry["n_reads"] == 10
    rev = {"d1": list(reversed(_reads(prefix="a")))}
    again = _route(monkeypatch, rev)[0].post(URL, json={**BODY, "group_by": "all", "normalization": "raw", "sample_n": 10, "sample_seed_int": 3}).json()
    assert again["data"]["d1"]["-1"]["matrix"] == entry["matrix"]
    other = client.post(URL, json={**BODY, "group_by": "all", "normalization": "raw", "sample_n": 10, "sample_seed_int": 4}).json()
    assert other["data"]["d1"]["-1"]["n_reads"] == 10
    assert len(sample_names([r["id"] for r in _reads(prefix="a")], 10, 3, "d1")) == 10


def test_box_bootstrap_over_reads_is_seeded_and_answers_each_matrix(monkeypatch):
    """Plots summaries: the box mean's Poisson bootstrap over reads (each read's own counts), the same for the same seed;
    pooled answers one interval over every dataset's reads."""
    client, _ = _route(monkeypatch, {"d1": _reads(), "d2": _reads(40, 30, "x")})
    boot = {"size_from": 0, "size_to": 200, "pos_from": None, "pos_to": None, "resamples": 200, "seed": 5}
    a = client.post(URL, json={**BODY, "group_by": "all", "normalization": "raw", "box_bootstrap": boot}).json()["data"]["d1"]["-1"]["box_ci"]
    b = client.post(URL, json={**BODY, "group_by": "all", "normalization": "raw", "box_bootstrap": boot}).json()["data"]["d1"]["-1"]["box_ci"]
    assert a == b and a["units"] == 55 and a["lo"] <= a["hi"]
    other = client.post(URL, json={**BODY, "group_by": "all", "normalization": "raw", "box_bootstrap": {**boot, "seed": 6}}).json()["data"]["d1"]["-1"]["box_ci"]
    assert other != a
    pooled = client.post(URL, json={**BODY, "group_by": "pooled", "normalization": "raw", "box_bootstrap": boot}).json()["data"]["__pooled__"]["-1"]["box_ci"]
    assert pooled["units"] == 125
    # Without it, no interval is computed.
    assert "box_ci" not in client.post(URL, json={**BODY, "group_by": "all", "normalization": "raw"}).json()["data"]["d1"]["-1"]
