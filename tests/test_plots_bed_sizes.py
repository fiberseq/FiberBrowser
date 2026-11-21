"""Size enrichment / V-plot over BED anchors (POST /api/plots/bed_sizes): windows counted with the one V-plot counting,
minus-strand windows flipped, raw counts pooled per set, finished with the one finishing; chunks add up to one
request; Random N reads via key_max; the stable read sample per region."""
from types import SimpleNamespace

import numpy as np
from fastapi import FastAPI
from fastapi.testclient import TestClient

from services.vplot_matrix import finish_vplot


def _client(monkeypatch, reads_fn):
    from routers import files as files_router
    from services import analysis_query
    built = []

    def from_request(_state, **k):
        def build(_s, ds, chrom, start, end):
            built.append((ds, start, end))
            return SimpleNamespace(reads=reads_fn(ds, start, end), start=start)
        return SimpleNamespace(dataset_ids=k.get("dataset_ids") or ["d1"], sample_seed="s", build_working_set=build)

    monkeypatch.setattr(analysis_query.AnalysisReadQuery, "from_request", staticmethod(from_request))
    app = FastAPI()
    app.include_router(files_router.router)
    app.dependency_overrides[files_router.get_state] = lambda: SimpleNamespace()
    return TestClient(app), built


# Anchors at 10,000 (+) and 20,000 (−), flank 100 (window 200 bp). Each read has one 60 bp footprint whose midpoint sits
# 30 bp downstream of its anchor: on + at 10,030 (window position 130), on − at 19,970 (flipped: also 130).
def reads_fn(ds, start, end):
    out = []
    for anchor, mid in ((10_000, 10_030), (20_000, 19_970)):
        if start <= anchor < end:
            for i in range(4):
                a = mid - 30
                out.append({"id": f"{ds}-{anchor}-{i}", "aligned_blocks": [[anchor - 500, anchor + 500]], "intervals": [[a - start, a - start + 60, 60]]})
    return out


BODY = {"sets": [{"id": "s", "regions": [["chrT", 9_990, 10_010, "+", "p"], ["chrT", 19_990, 20_010, "-", "m"]]}], "dataset_ids": ["d1"],
        "subsample": "all", "flank_bp": 100, "size_min": 10, "size_max": 100, "size_bin": 10, "pos_bin": 10, "mode": "midpoint", "reads_per_region": 50}


def test_planted_footprints_land_downstream_on_both_strands(monkeypatch):
    client, _ = _client(monkeypatch, reads_fn)
    out = client.post("/api/plots/bed_sizes", json={**BODY, "phase": "count"}).json()
    g = out["groups"]["s|d1"]
    m = np.asarray(g["matrix"])
    assert m.shape == (9, 20) and g["n_reads"] == 8
    # Size 60 -> row 5; midpoint at window position 130 -> column 13: all 8 footprints there, nothing else.
    assert m[5, 13] == 8 and m.sum() == 8 and out["start"] == -100


def test_chunks_add_up_and_finish_is_the_one_finishing(monkeypatch):
    client, _ = _client(monkeypatch, reads_fn)
    whole = client.post("/api/plots/bed_sizes", json={**BODY, "phase": "count"}).json()["groups"]["s|d1"]
    a = client.post("/api/plots/bed_sizes", json={**BODY, "phase": "count", "job_offset": 0, "job_limit": 1}).json()["groups"]["s|d1"]
    b = client.post("/api/plots/bed_sizes", json={**BODY, "phase": "count", "job_offset": 1, "job_limit": 1}).json()["groups"]["s|d1"]
    assert (np.asarray(a["matrix"]) + np.asarray(b["matrix"])).tolist() == whole["matrix"]
    fin = client.post("/api/plots/bed_sizes", json={"phase": "finish", "groups": [{"id": "s|d1", **whole}], "normalization": "row",
                                                   "sigma_size_bp": 10, "sigma_pos_bp": 10, "size_bin": 10, "pos_bin": 10, "row_min_footprints": 0}).json()
    ref = finish_vplot(np.asarray(whole["matrix"]), normalization="row", log=False, sigma_bins_size=1.0, sigma_bins_pos=1.0,
                       row_counts=np.asarray(whole["row"]), col_counts=np.asarray(whole["col"]), row_min_footprints=0, blank=float("nan"))
    got = np.array([[np.nan if v is None else v for v in r] for r in fin["groups"][0]["matrix"]])
    assert np.allclose(np.nan_to_num(got, nan=-1), np.nan_to_num(np.round(ref, 6), nan=-1))


def test_random_n_reads_and_per_region_sample_are_stable(monkeypatch):
    client, _ = _client(monkeypatch, reads_fn)
    names = client.post("/api/plots/bed_sizes", json={**BODY, "phase": "names", "seed": 5}).json()["names"]["d1"]
    assert len(names) == 8
    keys = sorted(int(k) for _n, k in names)
    kept = client.post("/api/plots/bed_sizes", json={**BODY, "phase": "count", "seed": 5, "key_max": {"d1": str(keys[2])}}).json()["groups"]["s|d1"]
    assert kept["n_reads"] == 3
    one = client.post("/api/plots/bed_sizes", json={**BODY, "phase": "count", "seed": 5, "reads_per_region": 1}).json()["groups"]["s|d1"]
    again = client.post("/api/plots/bed_sizes", json={**BODY, "phase": "count", "seed": 5, "reads_per_region": 1}).json()["groups"]["s|d1"]
    assert one == again and one["n_reads"] == 2


def test_box_bootstrap_hand_checked():
    """Two units with one cell each (1 and 3 footprints-worth), raw values, no smoothing: each resample's box mean is
    w_A * 1 + w_B * 3 with the units' own Poisson streams; the interval is their percentile interval; the same seed
    gives the same interval in any unit order."""
    from services.box_bootstrap import UnitCounts, box_bootstrap
    from services.stable_sample import percentile_interval, poisson_weights
    kw = dict(normalization="raw", log=False, sigma_bins_size=0.0, sigma_bins_pos=0.0, row_min_footprints=0)
    uc = UnitCounts(1, 1)
    uc.add("A", np.array([[1.0]]), np.array([1]), np.array([1]))
    uc.add("B", np.array([[3.0]]), np.array([3]), np.array([3]))
    lo, hi, n = box_bootstrap(uc, seed=11, resamples=200, finish_kw=kw, box=(0, 1, 0, 1))
    wa, wb = poisson_weights(11, "A", 200), poisson_weights(11, "B", 200)
    elo, ehi = percentile_interval([a * 1 + b * 3 for a, b in zip(wa, wb)])
    assert n == 2 and abs(lo - elo) < 1e-9 and abs(hi - ehi) < 1e-9
    other = UnitCounts(1, 1)
    other.add("B", np.array([[3.0]]), np.array([3]), np.array([3]))
    other.add("A", np.array([[1.0]]), np.array([1]), np.array([1]))
    assert box_bootstrap(other, seed=11, resamples=200, finish_kw=kw, box=(0, 1, 0, 1))[:2] == (lo, hi)
    assert box_bootstrap(uc, seed=12, resamples=200, finish_kw=kw, box=(0, 1, 0, 1))[:2] != (lo, hi)


def test_bootstrap_phase_regions_by_default_reads_as_option(monkeypatch):
    client, _ = _client(monkeypatch, reads_fn)
    body = {**BODY, "phase": "bootstrap", "normalization": "raw", "box": {"size_from": 0, "size_to": 100}, "resamples": 300, "boot_seed": 3}
    a = client.post("/api/plots/bed_sizes", json=body).json()
    b = client.post("/api/plots/bed_sizes", json=body).json()
    iv = a["intervals"]["s|d1"]
    assert a["unit"] == "regions" and iv["units"] == 2 and iv["lo"] <= iv["hi"]
    assert a["intervals"] == b["intervals"]
    r = client.post("/api/plots/bed_sizes", json={**body, "unit": "reads"}).json()
    assert r["unit"] == "reads" and r["intervals"]["s|d1"]["units"] == 8


def test_box_mean_on_the_plots_scale():
    from services.box_bootstrap import box_mean
    m = np.array([[2.0, 0.5], [4.0, np.nan]])
    assert box_mean(m, 0, 2, 0, 2) == (2 + 0.5 + 4) / 3
    assert abs(box_mean(m, 0, 2, 0, 2, transform="log2") - (1 - 1 + 2) / 3) < 1e-12
    assert abs(box_mean(m, 0, 2, 0, 2, transform="log1p") - (np.log1p(2) + np.log1p(0.5) + np.log1p(4)) / 3) < 1e-12
