"""Differential features: the statistics (services/differential.py) against references, the planted-difference
recovery, density-matched and replicate-aware strata, and the run over feature states (services/differential_run.py)."""
import math
import random
from types import SimpleNamespace

import numpy as np
import pytest

from services import differential as D


# --- statistics -----------------------------------------------------------------------------------------------------
def test_newcombe_matches_the_published_example():
    # Newcombe (1998) Table II example: 56/70 vs 48/80 -> 0.2000 (0.0524, 0.3339).
    d, lo, hi = D.newcombe_delta(56, 70, 48, 80)
    assert round(d, 4) == 0.2 and round(lo, 4) == 0.0524 and round(hi, 4) == 0.3339


def test_woolf_and_haldane():
    l2, lo, hi = D.log2_odds_ratio(20, 10, 10, 20)
    assert math.isclose(l2, 2.0) and lo < 2.0 < hi
    ln_se = math.sqrt(1 / 20 + 1 / 10 + 1 / 10 + 1 / 20)
    assert math.isclose(hi - l2, 1.959963984540054 * ln_se / math.log(2))
    l2z, _, _ = D.log2_odds_ratio(5, 0, 0, 5)  # zero cells: 0.5 added to every cell
    assert math.isclose(l2z, math.log2(5.5 * 5.5 / (0.5 * 0.5)))


def test_cmh_and_mh_or_match_statsmodels():
    from statsmodels.stats.contingency_tables import StratifiedTable
    tables = [(12, 8, 6, 14), (20, 30, 10, 40), (5, 5, 3, 9)]
    st = StratifiedTable([np.array([[a, b], [c, d]]) for a, b, c, d in tables])
    res = D.cmh(tables)
    assert math.isclose(res["p"], st.test_null_odds(correction=True).pvalue, rel_tol=1e-9)
    assert math.isclose(res["odds_ratio"], st.oddsratio_pooled, rel_tol=1e-9)
    l2, lo, hi = D.mh_log2_or(tables)
    slo, shi = st.oddsratio_pooled_confint()
    assert math.isclose(l2, math.log2(st.oddsratio_pooled)) and math.isclose(lo, math.log2(slo), rel_tol=1e-9) and math.isclose(hi, math.log2(shi), rel_tol=1e-9)


def old_lab_cmh(tables):  # the copy lab/services/accessibility_pooled.cmh had before it delegated (reference)
    from scipy.stats import chi2
    num = den = s_a = s_e = s_v = 0.
    used = 0
    for a, b, c, d in tables:
        n = a + b + c + d
        if n < 2 or (a + b) == 0 or (c + d) == 0 or (a + c) == 0 or (b + d) == 0:
            continue
        used += 1
        num += a*d/n
        den += b*c/n
        s_a += a
        s_e += (a + b)*(a + c)/n
        s_v += (a + b)*(c + d)*(a + c)*(b + d)/(n*n*(n - 1))
    if not used or s_v <= 0:
        return dict(strata=used, odds_ratio=None, log2=None, p=None)
    stat = max(0., abs(s_a - s_e) - 0.5)**2/s_v
    orr = num/den if den > 0 and num > 0 else None
    return dict(strata=used, odds_ratio=None if orr is None else round(float(orr), 4),
                log2=None if orr is None else round(float(np.log2(orr)), 3), p=float(chi2.sf(stat, 1)),
                direction=1 if s_a > s_e else -1 if s_a < s_e else 0)


def test_lab_cmh_unchanged():
    from lab.services.accessibility_pooled import cmh
    rnd = random.Random(3)
    cases = [[], [(0, 0, 0, 0)], [(3, 0, 0, 3)], [(1, 1, 1, 1), (0, 4, 0, 4)]]
    cases += [[tuple(rnd.randint(0, 30) for _ in range(4)) for _ in range(rnd.randint(1, 5))] for _ in range(200)]
    for tables in cases:
        assert cmh(tables) == old_lab_cmh(tables)


def test_untestable_features_have_no_p_or_q():
    rows = D.differential_rows([dict(key="x", strata={"all": (0, 0, 5, 5)}), dict(key="y", strata={"all": (9, 1, 1, 9)})], min_reads=1)
    assert rows[0]["testable"] is False and rows[0]["q"] is None and "A" in rows[0]["reason"]
    assert rows[1]["testable"] and rows[1]["q"] == rows[1]["p"]  # one test: q = p


# --- planted differences ------------------------------------------------------------------------------------------
def _states(n_features, planted, n_reads, rnd, base=0.5, shift=0.3):
    """by_dataset {dsA: {...}, dsB: {...}}: per read one char per feature; planted features open more in A."""
    by = {"dsA": {}, "dsB": {}}
    for ds, sign in (("dsA", 1), ("dsB", -1)):
        for r in range(n_reads):
            chars = []
            for f in range(n_features):
                p = base + (sign * shift / 2 if f in planted else 0)
                chars.append("1" if rnd.random() < p else "0")
            by[ds][f"read{r}"] = "".join(chars)
    return by


def _run(by, n_features, sideA="dsA", sideB="dsB", stratum_of=lambda ds, read, side: "all", stratified=False):
    feats = [dict(key=f"f{i}") for i in range(n_features)]
    cols = [[i] for i in range(n_features)]
    side_of = lambda ds, read: ["A"] if ds == sideA else ["B"] if ds == sideB else []
    return D.differential_rows(D.count_tables(feats, cols, by, side_of, stratum_of), "fisher", stratified, 5)


def test_planted_differences_are_recovered_with_their_sign_and_swap_flips_it():
    rnd = random.Random(42)
    planted = set(range(0, 200, 10))  # 20 of 200
    by = _states(200, planted, 150, rnd)
    rows = _run(by, 200)
    hits = {int(r["key"][1:]) for r in rows if r["q"] is not None and r["q"] < 0.05}
    assert len(hits & planted) >= 18 and len(hits - planted) <= 1
    assert all(rows[i]["delta"] > 0 and rows[i]["log2or"] > 0 and rows[i]["deltaLo"] > 0 for i in hits & planted)
    swapped = _run(by, 200, "dsB", "dsA")
    for a, b in zip(rows, swapped):
        assert math.isclose(a["delta"], -b["delta"]) and math.isclose(a["log2or"], -b["log2or"]) and math.isclose(a["p"], b["p"])
        assert math.isclose(a["deltaLo"], -b["deltaHi"])


def test_two_halves_of_one_sample_find_nothing():
    rnd = random.Random(7)
    by = _states(300, set(), 150, rnd)
    rows = _run(by, 300)
    assert sum(1 for r in rows if r["q"] is not None and r["q"] < 0.05) == 0


def test_density_matching_removes_a_confounded_difference():
    # Openness follows the read's m6A density, and A has more dense reads: unstratified, every feature "differs";
    # within density bins (CMH), nothing does.
    rnd = random.Random(5)
    by, dens = {"dsA": {}, "dsB": {}}, {}
    for ds, frac_dense in (("dsA", 0.8), ("dsB", 0.2)):
        for r in range(300):
            dense = rnd.random() < frac_dense
            dens[(ds, f"read{r}")] = 30.0 if dense else 10.0
            by[ds][f"read{r}"] = "".join("1" if rnd.random() < (0.7 if dense else 0.3) else "0" for _ in range(20))
    plain = _run(by, 20)
    assert sum(1 for r in plain if r["q"] < 0.05) == 20
    edges = D.density_bins(list(dens.values()), 5)
    matched = _run(by, 20, stratum_of=lambda ds, read, side: f"d{D.bin_of(dens[(ds, read)], edges)}", stratified=True)
    assert sum(1 for r in matched if r["q"] < 0.05) <= 1 and all(r["strata"] == 2 for r in matched)


def test_replicate_strata_combine_two_pairs():
    t1, t2 = (30, 20, 20, 30), (28, 22, 18, 32)
    rows = D.differential_rows([dict(key="f", strata={"0": t1, "1": t2})], stratified=True)
    alone = D.differential_rows([dict(key="f", strata={"0": t1})], stratified=True)
    assert rows[0]["strata"] == 2 and rows[0]["p"] < alone[0]["p"] and rows[0]["delta"] > 0 and rows[0]["nA"] == 100


# --- the run over feature states ------------------------------------------------------------------------------------
def _fake_states(monkeypatch, by_ref):
    """feature_states stub: by_ref {ref id: {ds: {read: char}}}; a ref id 'bad' raises."""
    import services.feature_states as fs

    def fake(state, features):
        out = {}
        for k, f in enumerate(features):
            if f["id"] == "bad":
                raise ValueError("The Find classes run of this class is not available; rerun or restore it")
        for k, f in enumerate(features):
            for ds, reads in by_ref.get(f["id"], {}).items():
                for read, ch in reads.items():
                    row = out.setdefault(ds, {}).setdefault(read, ["."] * len(features))
                    row[k] = ch
        return {"by_dataset": {ds: {r: "".join(v) for r, v in reads.items()} for ds, reads in out.items()}}

    monkeypatch.setattr(fs, "feature_states", fake)


def test_run_merges_per_dataset_refs_groups_reads_and_reports_bad_refs(monkeypatch):
    from services.differential_run import run_differential
    by_ref = {
        "c1@d1": {"d1": {f"a{i}": "1" if i < 18 else "0" for i in range(20)}},
        "c1@d2": {"d2": {f"b{i}": "1" if i < 4 else "0" for i in range(20)}},
        "p1": {"d1": {f"a{i}": "1" for i in range(10)}, "d2": {f"b{i}": "1" for i in range(10)}},
    }
    _fake_states(monkeypatch, by_ref)
    body = {"features": [
        {"key": "class", "refs": [{"kind": "fp-class", "source": "j", "id": "c1@d1", "dataset_id": "d1"},
                                  {"kind": "fp-class", "source": "j", "id": "c1@d2", "dataset_id": "d2"}]},
        {"key": "peak", "refs": [{"kind": "x", "source": "browser:peaks:r", "id": "p1"}]},
        {"key": "gone", "refs": [{"kind": "fp-class", "source": "j", "id": "bad", "dataset_id": "d1"}]},
    ], "groups": {"A": {"datasets": ["d1"]}, "B": {"datasets": ["d2"]}}, "min_reads": 5}
    out = run_differential(SimpleNamespace(), body)
    cls, peak, gone = out["rows"]
    assert (cls["kA"], cls["nA"], cls["kB"], cls["nB"]) == (18, 20, 4, 20) and cls["q"] < 0.01 and cls["delta"] > 0
    assert peak["testable"] and peak["fracA"] == peak["fracB"] == 1.0 and peak["p"] == 1.0
    assert not gone["testable"] and "not available" in gone["reason"]
    # Groups of reads (a cluster against the rest, inside one dataset)
    body2 = dict(body, groups={"A": {"datasets": ["d1"], "reads": {"d1": [f"a{i}" for i in range(10)]}},
                               "B": {"datasets": ["d1"], "reads": {"d1": [f"a{i}" for i in range(10, 20)]}}})
    cls2 = run_differential(SimpleNamespace(), body2)["rows"][0]
    assert (cls2["kA"], cls2["nA"], cls2["kB"], cls2["nB"]) == (10, 10, 8, 10)


def test_run_replicates_need_pairs_and_cancel(monkeypatch):
    from services.differential_run import Cancelled, run_differential
    _fake_states(monkeypatch, {})
    feats = [{"key": "f", "refs": [{"kind": "x", "source": "s", "id": "f"}]}]
    with pytest.raises(ValueError, match="same number"):
        run_differential(SimpleNamespace(), {"features": feats, "replicate_aware": True,
                                             "groups": {"A": {"datasets": ["a1", "a2"]}, "B": {"datasets": ["b1"]}}})
    with pytest.raises(Cancelled):
        run_differential(SimpleNamespace(), {"features": feats, "groups": {"A": {"datasets": ["a"]}, "B": {"datasets": ["b"]}}},
                         cancelled=lambda: True)


def test_run_replicate_and_density_strata(monkeypatch):
    from services.differential_run import run_differential
    rnd = random.Random(9)
    reads = {ds: {f"{ds}r{i}": ("1" if rnd.random() < (0.8 if ds.startswith("a") else 0.3) else "0") for i in range(40)}
             for ds in ("a1", "a2", "b1", "b2")}
    _fake_states(monkeypatch, {"f": reads})
    ws = {ds: SimpleNamespace(reads=[{"id": r, "aligned_blocks": [[0, 10_000]], "methyl_m6a": list(range(i % 50))}
                                     for i, r in enumerate(reads[ds])]) for ds in reads}
    state = SimpleNamespace(build_working_set=lambda ds, chrom, lo, hi, **k: ws[ds])
    body = {"features": [{"key": "f", "chrom": "chrT", "start": 100, "end": 200, "refs": [{"kind": "x", "source": "s", "id": "f"}]}],
            "groups": {"A": {"datasets": ["a1", "a2"]}, "B": {"datasets": ["b1", "b2"]}}, "replicate_aware": True, "density_match": True}
    out = run_differential(state, body)
    row = out["rows"][0]
    assert out["test"] == "cmh" and row["strata"] >= 6 and row["q"] < 0.001 and row["delta"] > 0.3
    assert len(out["density"]["edges"]) == 4 and out["density"]["reads_without_density"] == 0


def test_density_divides_window_marks_by_the_span_inside_the_window():
    # The working set keeps only the marks in its window; the aligned blocks are whole-read.
    from services.differential_run import _densities
    ws = SimpleNamespace(start=900, reads=[{"id": "r", "aligned_blocks": [[0, 100_000]], "methyl_m6a": list(range(30))}])
    state = SimpleNamespace(build_working_set=lambda ds, chrom, lo, hi, **k: ws)
    dens = _densities(state, ["d"], [{"chrom": "chrT", "start": 1000, "end": 1100}], lambda: False)
    assert dens == {"d": {"r": 30 * 1000.0 / 300}}  # window 900..1200
