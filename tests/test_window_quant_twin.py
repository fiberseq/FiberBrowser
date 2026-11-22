"""Quantify a window: services/window_quant.py (the headless twin) gives the browser engine's table.

tests/fixtures/window_quant/golden.json is written by the TypeScript engine (frontend .../windowQuant/
pythonTwinGolden.test.ts) from input.json (real meta-locus inputs on the demo BAM, plus synthetic shares). Here the
Python side computes the same cases: every value, interval, enrichment, comparison, n, member count, method, test and
the TSV must match (numbers to 1e-9 relative; TSV text exactly).
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from services import window_quant as wq
from services.meta_locus_numbers import compute_from_inputs

FIX = Path(__file__).resolve().parent / "fixtures" / "window_quant"
INPUT = json.loads((FIX / "input.json").read_text())
GOLDEN = json.loads((FIX / "golden.json").read_text())
CASES = {c["name"]: c for c in INPUT["cases"]}


def reads(ids):
    return [INPUT["reads"][i] for i in ids]


def run_case(c: dict) -> tuple[dict, str | None]:
    if c["kind"] == "engine":
        spec = wq.normalize_spec(c["spec"])
        ms = [({**m["def"]}, {"units": m["units"]}) for m in c["measures"]]
        return wq.compute_quant(spec, ms, c["groups"], c["assignments"], c["boundsBp"], c["seed"]), None
    inp = {k: c[k] for k in ("spec", "view", "bounds", "measures", "has_tf", "panels", "cluster_panels", "visible",
                             "comparison", "y_baseline", "view_bins", "assignments")}
    inp["spec"] = wq.normalize_spec(c["spec"])
    inp["pools"] = [{**p, "pool": None if p["pool"] is None else {**p["pool"], "reads": reads(p["pool"]["reads"])}}
                    for p in c["pools"]]
    for key in ("fresh", "marks", "size_reads"):
        inp[key] = [(ds, reads(ids)) for ds, ids in c[key]]
    out = compute_from_inputs(inp)
    return out["result"], out["readSource"]


def close(a, b, path=""):
    if isinstance(b, dict):
        assert isinstance(a, dict) and set(a) >= {k for k, v in b.items() if v is not None}, f"{path}: keys {sorted(b)} vs {sorted(a or {})}"
        for k, v in b.items():
            close(a.get(k), v, f"{path}.{k}")
    elif isinstance(b, list):
        assert isinstance(a, list) and len(a) == len(b), f"{path}: length {len(a or [])} vs {len(b)}"
        for i, (x, y) in enumerate(zip(a, b)):
            close(x, y, f"{path}[{i}]")
    elif isinstance(b, float) or (isinstance(b, int) and not isinstance(b, bool) and isinstance(a, float)):
        assert a is not None and math.isclose(float(a), float(b), rel_tol=1e-9, abs_tol=1e-12), f"{path}: {a} vs {b}"
    else:
        assert a == b, f"{path}: {a!r} vs {b!r}"


def jsonish(v):
    return json.loads(json.dumps(v, default=float, allow_nan=True).replace("NaN", "null"))


@pytest.mark.parametrize("name", sorted(GOLDEN))
def test_python_twin_matches_the_browser_engine(name):
    result, read_source = run_case(CASES[name])
    want = GOLDEN[name]
    got = jsonish(result)
    # The TypeScript result leaves undefined keys out (color, note, resamplesUsed when unused): compare what it has.
    close(got, want["result"], name)
    assert read_source == want["readSource"]
    assert wq.quant_tsv(result, []) == want["tsv"]


def test_the_cases_exercise_both_read_sources_and_every_unit_kind():
    seen = {(GOLDEN[n]["readSource"], m.get("units")) for n in GOLDEN for m in GOLDEN[n]["result"]["measures"]}
    assert ("panel", "curve") in seen and ("panel", "exact") in seen and ("fetch", "exact") in seen
    assert any(m["kind"] == "share" for n in GOLDEN for m in GOLDEN[n]["result"]["measures"])
    assert any(t for n in GOLDEN for t in GOLDEN[n]["result"]["tests"].values())


def test_statistics_ports_match_known_values():
    lo, hi = wq.wilson_interval(7, 20)
    assert math.isclose(lo, 0.18119, abs_tol=1e-4) and math.isclose(hi, 0.56715, abs_tol=1e-4)
    assert math.isclose(wq.chi_square_sf(3.841458820694124, 1), 0.05, rel_tol=1e-9)
    assert wq.benjamini_hochberg([0.01, 0.04, 0.03]) == pytest.approx([0.03, 0.04, 0.04])
    assert wq._fmt(0.000012345678) == "0.0000123457" and wq._fmt(1234567) == "1234570" and wq._fmt(None) == "NA"


def test_unsupported_measures_are_refused_with_a_message():
    with pytest.raises(ValueError, match="Find classes run in the browser"):
        wq.check_measures(["fp:class:3"])
    with pytest.raises(ValueError, match="Unknown measure"):
        wq.check_measures(["bogus"])
