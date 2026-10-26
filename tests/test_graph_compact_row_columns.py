"""Graph mode's ``compact_row`` reads ``IntColumn`` fields (read row format 2) in bulk through ``.array``; the
output is exactly what the same row with plain lists gives (graph follow-ups item 2)."""
import os
import random

import numpy as np
import pytest

from services.graph_panel import reads as R
from services.read_columns import IntColumn


def _plain(x):
    if type(x) is IntColumn:
        return x.tolist()
    if isinstance(x, dict):
        return {k: _plain(v) for k, v in x.items()}
    if isinstance(x, list):
        return [_plain(v) for v in x]
    return x


def _ivs(rng, n, width=3):
    out, pos = [], rng.randrange(-50, 50)
    for _ in range(n):
        w = rng.randrange(1, 200)
        out.append([pos, pos + w, w if rng.random() < 0.7 else -w, *([7] * (width - 3))])
        pos += w + rng.choice([0, 0, 3])
    return out


def _row(rng, columns):
    def col(v):
        return IntColumn(np.asarray(v, dtype=np.int64)) if columns else v

    layers, calls, parts = {}, {}, {}
    for name in ("nuc", "tf", "msp"):
        n = rng.choice([0, 1, 5, 40])
        ivs = _ivs(rng, n, width=rng.choice([3, 3, 4]))
        quals = [[rng.randrange(256) for _ in range(n)]] if rng.random() < 0.5 else []
        layers[name] = {"intervals": col(ivs) if ivs else [], "qualities": quals,
                        "quality_names": ["nq"] if quals else []}
        calls[f"layer:{name}"] = [f"c{i}" if rng.random() < 0.8 else None for i in range(n)]
        parts[f"layer:{name}"] = [[i, i] for i in range(n)]
    m6a = sorted(rng.randrange(-100, 4000) for _ in range(rng.choice([0, 1, 30, 300])))
    return {"id": "q", "alignment_orientation": rng.choice(["forward", "reverse"]), "layers": layers,
            "methyl_m6a": col(m6a) if m6a else [],
            "live_lift": {"calls": calls, "call_parts": parts, "molecular_spans": [[0, 4000, 0, 1, True]],
                          "library": 0, "record": "s:0", "source": {"contig": "src", "start": 0, "end": 4000}}}


@pytest.mark.parametrize("seed", range(5))
def test_column_fast_path_matches_lists(seed):
    rng = random.Random(seed)
    for _ in range(30):
        row = _row(rng, columns=True)
        origin = rng.randrange(0, 10 ** 9)
        for windows in (None, [[origin + 100, origin + 900]], [[origin - 10, origin + 5], [origin + 2000, origin + 2500]]):
            fast = R.compact_row(row, origin, "d", "b", windows)
            assert fast == R.compact_row(_plain(row), origin, "d", "b", windows)
            assert all(type(v) is int for iv in fast.get("nuc", {}).get("iv", ()) for v in iv)
            assert all(type(p) is int for p in fast.get("m6a", ()))


@pytest.mark.skipif(not (os.environ.get("FIBERBROWSER_TEST_LIFT_BAM") and os.environ.get("FIBERBROWSER_TEST_LIFT_MAP")),
                    reason="needs the HG002 demo BAM and its lift map")
def test_real_graph_rows_match_lists(monkeypatch):
    """The rows graph mode composes for the AluY demo window (maternal source) give the same wire form."""
    monkeypatch.setenv("FIBERBROWSER_LIVE_LIFT", "1")
    from plugins import init_context
    from services.lift.registration import add_live_lift_dataset
    from state.browser_state import BrowserState

    st = BrowserState(None, None, None, None)
    init_context(st)
    add_live_lift_dataset(st, paths=[os.environ["FIBERBROWSER_TEST_LIFT_BAM"]],
                          manifest=os.environ["FIBERBROWSER_TEST_LIFT_MAP"], dataset_id="lifted")
    ds = st.datasets["lifted"]
    captured = []
    full = R.compact_full
    monkeypatch.setattr(R, "compact_full", lambda row, *a: captured.append((row, *a)) or full(row, *a))
    contig, windows = "chr3_MATERNAL", [[131_179_000, 131_190_000]]
    recs = R.window_records(ds, contig, windows)
    size = R.contig_length(ds, contig)
    region = (max(0, min([windows[0][0], *(k[2] for k in recs)]) - 1),
              min(size + 1, max([windows[0][1], *(k[4] for k in recs)]) + 1))
    R._decode_records(ds, contig, size + 1, windows, contig, recs, region, ("lifted", 0, "p", contig))
    assert len(captured) > 20
    assert any(type(row.get("methyl_m6a")) is IntColumn for row, *_ in captured)
    for row, origin, did, binding in captured:
        for w in (None, [[131_180_000, 131_182_000], [131_185_000, 131_186_000]]):
            assert R.compact_row(row, origin, did, binding, w) == R.compact_row(_plain(row), origin, did, binding, w)
