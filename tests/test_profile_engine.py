"""The server's Plots profile engine (services/profile_engine.py): the peak scan's per-base counts and the graph
density strips run on it with the numbers they had (their replaced code kept here), and its channel accumulation is
pinned to the browser's engine by golden values (profileEngineGolden.test.ts holds the same)."""
import json
import math
import random

import numpy as np
import pytest

from services import profile_engine as E


def old_density_strip(reads, windows, bin_bp):  # services/graph_panel/reads.py before Phase 5
    out = []
    for wa, wb in windows:
        n = max(1, int(math.ceil((wb - wa) / bin_bp)))
        centres = wa + (np.arange(n) + 0.5) * bin_bp
        counts = {}
        for name in ("cov", "msp", "nuc"):
            starts, ends = [], []
            for r in reads:
                ivs = (r.get("cov") or ()) if name == "cov" else ((r.get(name) or {}).get("iv") or ())
                for iv in ivs:
                    a, b = int(iv[0]), int(iv[1])
                    if b > wa and a < wb:
                        starts.append(a)
                        ends.append(b)
            diff = np.zeros(n + 1, dtype=np.int64)
            if starts:
                a = np.searchsorted(centres, np.asarray(starts, dtype=np.float64), side="left")
                b = np.searchsorted(centres, np.asarray(ends, dtype=np.float64), side="left")
                keep = b > a
                np.add.at(diff, a[keep], 1)
                np.add.at(diff, b[keep], -1)
            counts[name] = np.cumsum(diff[:-1]).tolist()
        out.append([int(wa), int(wb), counts["cov"], counts["msp"], counts["nuc"]])
    return {"bp": int(bin_bp), "windows": out}


def naive_range_counts(starts, ends, width):
    out = np.zeros(width, dtype=np.int64)
    for a, b in zip(starts, ends):
        for x in range(max(0, a), min(width, b)):
            out[x] += 1
    return out


@pytest.mark.parametrize("seed", range(5))
def test_graph_density_strip_unchanged(seed):
    from services.graph_panel.reads import density_strip
    rnd = random.Random(seed)
    iv = lambda: (lambda a: [a, a + rnd.randint(1, 900)])(rnd.randint(-500, 6000))
    reads = [{"cov": [iv() for _ in range(rnd.randint(0, 3))], "msp": {"iv": [iv() for _ in range(rnd.randint(0, 4))]},
              "nuc": {"iv": [iv() for _ in range(rnd.randint(0, 6))]}} for _ in range(80)]
    windows = [[0, 2500], [2600, 5003], [5100, 5101]]
    for bp in (1, 7, 50, 200):
        assert density_strip(reads, windows, bp) == old_density_strip(reads, windows, bp)


def test_scan_counts_are_per_base_and_int32():
    from services.peak_scanning import _point_counts, _range_counts
    rnd = random.Random(1)
    starts = [rnd.randint(-50, 400) for _ in range(300)]
    ends = [s + rnd.randint(-5, 120) for s in starts]
    got = _range_counts(starts, ends, 333)
    assert got.dtype == np.int32 and np.array_equal(got, naive_range_counts(starts, ends, 333))
    assert _range_counts is E.range_counts and _point_counts is E.point_counts
    assert _point_counts([0, 5, 5], 6).tolist() == [1, 0, 0, 0, 0, 2]


GOLDEN_READS = [
    {"start": 0.5, "end": 6.2, "spans": {"a": [[0.0, 7.0], [1.3, 2.9]], "b": [[3.5, 3.6]]}, "points": {"m": [0.0, 0.69, 0.7, 6.99, 7.0, -0.1]}},
    {"start": -2.0, "end": 3.0, "spans": {"a": [[-1.0, 0.71]]}, "points": {"m": [2.1, 4.2]}},
    {"start": 4.0, "end": 9.0, "spans": {"b": [[6.3, 12.0]]}},
]


def golden(weighting):
    out = E.accumulate_channels(GOLDEN_READS, 10, 7.0, weighting)
    return {"coverage": [round(v, 9) for v in out["coverage"]], "channels": {k: [round(v, 9) for v in vs] for k, vs in sorted(out["channels"].items())}}


GOLDEN_JSON = '{"overlap": {"coverage": [1.285714286, 2.0, 2.0, 2.0, 1.285714286, 1.285714286, 2.0, 2.0, 1.857142857, 1.0], "channels": {"a": [2.0, 1.157142857, 2.0, 2.0, 1.142857143, 1.0, 1.0, 1.0, 1.0, 1.0], "b": [0.0, 0.0, 0.0, 0.0, 0.0, 0.142857143, 0.0, 0.0, 0.0, 1.0], "m": [2.0, 1.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0]}}, "touch": {"coverage": [2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0], "channels": {"a": [2.0, 2.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0], "b": [0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0], "m": [2.0, 1.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0]}}}'


def test_accumulate_channels_matches_the_browser_engine_golden_values():
    # The same numbers are asserted in frontend/src/features/plots/profileEngineGolden.test.ts.
    expected = json.loads(GOLDEN_JSON)
    assert golden("overlap") == expected["overlap"]
    assert golden("touch") == expected["touch"]


