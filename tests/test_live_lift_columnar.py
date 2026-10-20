"""The composer's window-wide columnar pass (compose_columns) gives exactly the
rows of the per-row functions it replaces: random pieces and decoded reads,
composed with the pass and with it switched off, must match value for value
and type for type (dict key order included)."""
import copy
import random

import pytest

from services.lift import compose
from services.lift import live_lift as ll


def _same(x, y, path="$"):
    assert type(x) is type(y), f"{path}: {type(x).__name__} != {type(y).__name__}"
    if isinstance(x, dict):
        assert list(x) == list(y), f"{path}: keys {list(x)} != {list(y)}"
        for k in x:
            _same(x[k], y[k], f"{path}.{k}")
    elif isinstance(x, (list, tuple)):
        assert len(x) == len(y), f"{path}: {len(x)} != {len(y)} items"
        for i, (u, v) in enumerate(zip(x, y)):
            _same(u, v, f"{path}[{i}]")
    else:
        assert x == y, f"{path}: {x!r} != {y!r}"


def _pieces(rng):
    pieces = []
    for chain in range(rng.choice([1, 1, 2, 3])):
        primary = chain == 0 or rng.random() < 0.6
        strand = rng.choice("+-")
        q, t = rng.randrange(0, 300), rng.randrange(0, 400)
        for _ in range(rng.randrange(1, 7)):
            n = rng.randrange(1, 400)
            t0, t1 = (t, t + n) if strand == "+" else (4000 - t - n, 4000 - t)
            pieces.append(ll.LiftPiece(chain, t0, t1, q, q + n, strand, primary, f"H#{chain % 2 + 1}", "src"))
            q += n + rng.choice([0, 0, 1, 3, 20, 120]) - (rng.randrange(1, 50) if rng.random() < 0.08 else 0)
            t += n + rng.choice([0, 0, 1, 5, 40, 1500])
    return [p for p in pieces if p.q_end > p.q_start and p.t_start >= 0]


def _intervals(rng, lo, hi, with_calls, dup):
    ivs, calls, last, n = [], [], None, 0
    pos = lo + rng.randrange(0, 20)
    while pos < hi:
        w = 1 if rng.random() < 0.05 else rng.randrange(1, 160)
        size = 0 if rng.random() < 0.05 else (w if rng.random() < 0.7 else -w)
        ivs.append([pos, pos + w, size])
        if size < 0 and rng.random() < 0.8:
            calls.append(None)
        elif last is not None and rng.random() < dup:
            calls.append([last, rng.randrange(0, 3000), rng.randrange(0, 3000)])
        else:
            n += 1
            m0 = rng.randrange(0, 3000)
            last = f"c{n}"
            calls.append([last, m0, m0 + rng.randrange(0, 200)])
        pos += w + rng.choice([0, 0, 1, 5])
    return ivs, (calls if with_calls else None)


def _read(rng, i):
    rs = rng.randrange(0, 1500)
    re_ = rs + rng.randrange(1, 1500)
    base = rs - rng.randrange(0, 200)
    runs, ref, mol = [], rs, rng.randrange(0, 30)
    while ref < re_:
        n = min(rng.randrange(1, 300), re_ - ref)
        runs.append([ref, mol, n])
        ref, mol = ref + n, mol + n
        r = rng.random()
        ref += rng.randrange(1, 40) if r < 0.3 else 0
        mol += rng.randrange(1, 40) if 0.3 <= r < 0.6 else 0
    reverse = rng.random() < 0.4
    lo, hi = rs - base - 30, re_ - base + 30
    dup = rng.choice([0, 0.1, 0.4])
    ivs, iv_calls = _intervals(rng, lo, hi, rng.random() < 0.9, dup)
    fire, fire_calls = _intervals(rng, lo, hi, rng.random() < 0.7, dup)
    positive = sum(1 for v in ivs if v[2] > 0)
    read = {"id": f"r{i % 5}", "reference_start": rs, "reference_end": re_, "intervals": ivs, "fire": fire,
            "qualities": [rng.randrange(256) for _ in range(positive + rng.choice([0, 0, 3]))],
            "alignment_orientation": "reverse" if reverse else "forward", "library_id": "lib",
            "source_path": "a.bam", "record_sha256": f"s{i}", "alignment_occurrence": 0,
            "_fiberbrowser_source_base": base, "_fiberbrowser_aligned_runs": runs,
            "_fiberbrowser_lift_record": {"contig": "src", "reverse": reverse, "length": mol + 5},
            "_fiberbrowser_primary": {"is_supplementary": False, "sa": None},
            "_fiberbrowser_calls": {"intervals": iv_calls, "fire": fire_calls}, "layers": {}}
    for name in rng.sample(["nuc", "msp", "tf", "nuc_sr"], rng.randrange(0, 4)):
        livs, lcalls = _intervals(rng, lo, hi, rng.random() < 0.7, dup)
        names = rng.choice([["nq", "lq", "rq"], ["q1", "q2"], []])
        read["layers"][name] = {"intervals": livs, "quality_names": names, "_fiberbrowser_calls": lcalls,
                                "qualities": [[rng.randrange(256) for _ in range(len(livs) - rng.choice([0, 2]))]
                                              for _ in names]}
    for key in ("methyl_m6a", "methyl_m5c"):
        xs = [rng.randrange(lo - 50, hi + 50) for _ in range(rng.choice([0, 3, 24, 25, 200]))]
        read[key] = sorted(xs) if rng.random() < 0.9 else xs
    if rng.random() < 0.3:
        read["deam"] = [[x, rng.randrange(2)] for x in sorted(rng.randrange(lo, hi) for _ in range(30))]
    if rng.random() < 0.3:
        read["sv"] = [{"t": "D", "ref": rng.randrange(rs, re_), "len": rng.randrange(1, 80)}]
    if rng.random() < 0.3:
        read["_fiberbrowser_legacy"] = {"ma_names": rng.choice([[], ["nuc"]]), "explicit_msp": False}
    return read


@pytest.mark.parametrize("seed", range(6))
def test_columnar_pass_matches_per_row_composition(seed, monkeypatch):
    rng = random.Random(seed)
    composed = 0
    for _ in range(40):
        pieces = _pieces(rng)
        if not pieces:
            continue
        lo, hi = min(p.t_start for p in pieces), max(p.t_end for p in pieces)
        r0 = rng.randrange(lo - 100, hi)
        r1 = r0 + rng.randrange(1, 3000)
        sel = ll.PieceSelection("tgt", r0, r1, r0, r1, sorted(pieces, key=lambda p: (p.t_start, p.chain)))
        plan = ll.FetchPlan(sel, [], 0, 0)
        reads = [_read(rng, i) for i in range(rng.randrange(1, 10))]
        kw = dict(handle=None, region_start=r0, region_end=r1, key="k", dataset_id="d", molecules={},
                  settings=ll.LiftSettings(rejoin_bp=rng.choice([0, 5, 50]), g_split=rng.choice([1000, 10000])),
                  loader_options=dict(hide_terminal_gaps=rng.random() < 0.6, include_layers=rng.random() < 0.85))
        columnar = compose.lift_compact_reads(copy.deepcopy(reads), plan, **kw)
        with monkeypatch.context() as m:
            m.setattr(compose, "precompute", lambda *a, **k: None)
            per_row = compose.lift_compact_reads(copy.deepcopy(reads), plan, **kw)
        composed += len(columnar)
        _same(columnar, per_row)
    assert composed > 50
