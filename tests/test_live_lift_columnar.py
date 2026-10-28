"""The composer's window-wide columnar pass (compose_columns) gives exactly the
rows of the per-row functions it replaces: random pieces and decoded reads,
composed with the pass and with it switched off, must match value for value
and type for type (dict key order included; an ``IntColumn`` of the pass
counts as the list it stands for)."""
import copy
import random

import numpy as np
import pytest

from services.lift import compose
from services.read_columns import IntColumn
from services.lift import live_lift as ll


def _same(x, y, path="$"):
    # Read row format 2: a column stands for the list (int64, Python ints back).
    if type(x) is IntColumn:
        assert x.array.dtype == np.int64, f"{path}: column dtype {x.array.dtype}"
        assert type(y) is list, f"{path}: column != {type(y).__name__}"
        x = x.tolist()
    if type(y) is IntColumn:
        assert type(x) is list, f"{path}: {type(x).__name__} != column"
        y = y.tolist()
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
            q += n + rng.choice([0, 0, 1, 3, 20, 60, 120]) - (rng.randrange(1, 50) if rng.random() < 0.08 else 0)
            t += n + rng.choice([0, 0, 1, 5, 40, 60, 1500])
    return [p for p in pieces if p.q_end > p.q_start and p.t_start >= 0]


def _intervals(rng, lo, hi, with_calls, dup, prefix="c"):
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
            last = f"{prefix}{n}"
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
    # Legacy tag calls (ns:/as:) take the decoder's insertion rule at their ends; MA calls the aligned rule.
    ivs, iv_calls = _intervals(rng, lo, hi, rng.random() < 0.9, dup, rng.choice(["c", "ns:", "ns:"]))
    fire, fire_calls = _intervals(rng, lo, hi, rng.random() < 0.7, dup, rng.choice(["c", "as:", "MA1:"]))
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
        livs, lcalls = _intervals(rng, lo, hi, rng.random() < 0.7, dup, rng.choice(["MA0:", "as:", "c"]))
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
    if rng.random() < 0.6:
        # The whole record's call bounds (absolute source): the per-record footprint rules run per run.
        fp = sorted([base + v[0], base + v[1]] for v in ivs if v[2] > 0 and v[1] > v[0])
        lo_x, hi_x = rs + rng.randrange(-20, 200), re_ - rng.randrange(-20, 200)
        read["_fiberbrowser_call_bounds"] = {
            "fp": fp if rng.random() < 0.9 else [],
            "extent": [lo_x, hi_x] if rng.random() < 0.6 and hi_x > lo_x else None,
            "dropped": sorted([base + v[0], base + v[1]] for v in rng.sample(ivs, min(len(ivs), 2)) if v[1] > v[0])
            if rng.random() < 0.3 else [],
            "ma": None}
        if rng.random() < 0.3:
            read["_fiberbrowser_primary"] = {"is_supplementary": True, "sa": None}
    return read


@pytest.mark.parametrize("seed", range(12))
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
                  loader_options=dict(hide_terminal_gaps=rng.random() < 0.6, include_layers=rng.random() < 0.85,
                                      terminal_gap_threshold=rng.choice([500, 500, 60, 0]),
                                      requested_layers=rng.choice([None, ["nuc", "msp"]])))
        columnar = compose.lift_compact_reads(copy.deepcopy(reads), plan, **kw)
        with monkeypatch.context() as m:
            m.setattr(compose, "precompute", lambda *a, **k: None)
            per_row = compose.lift_compact_reads(copy.deepcopy(reads), plan, **kw)
        composed += len(columnar)
        _same(columnar, per_row)
    assert composed > 50


def test_columnar_pass_matches_in_small_batches(monkeypatch):
    """Windows run as several batches when large; batch edges change nothing."""
    from services.lift import compose_columns

    monkeypatch.setattr(compose_columns, "CHUNK_ELEMENTS", 37)
    test_columnar_pass_matches_per_row_composition(7, monkeypatch)


def _one(**updates):
    read = {"id": "r", "reference_start": 0, "reference_end": 140, "intervals": [[10, 20, 10]], "qualities": [42],
            "alignment_orientation": "forward", "library_id": "lib", "source_path": "a.bam",
            "record_sha256": "s", "alignment_occurrence": 0, "_fiberbrowser_source_base": 0,
            "_fiberbrowser_aligned_runs": [[0, 0, 140]],
            "_fiberbrowser_lift_record": {"contig": "src", "reverse": False, "length": 140},
            "_fiberbrowser_primary": {"is_supplementary": False, "sa": None},
            "_fiberbrowser_calls": {"intervals": [["c", 10, 20]]}}
    read.update(updates)
    return read


def _compose(reads, pieces, start=0, end=100, **opts):
    sel = ll.PieceSelection("tgt", start, end, start, end, pieces)
    return compose.lift_compact_reads(copy.deepcopy(reads), ll.FetchPlan(sel, [], 0, 0), handle=None,
                                      region_start=start, region_end=end, key="k", dataset_id="d", molecules={},
                                      settings=ll.LiftSettings(), loader_options=opts)


def _both(monkeypatch, reads, pieces, **kw):
    def run():
        try:
            return _compose(reads, pieces, **kw)
        except Exception as exc:  # noqa: BLE001 - the per-row path's own failures must match too
            return ("raises", type(exc).__name__)
    columnar = run()
    with monkeypatch.context() as m:
        m.setattr(compose, "precompute", lambda *a, **k: None)
        per_row = run()
    _same(columnar, per_row)
    return columnar


@pytest.mark.parametrize("updates", [
    {"intervals": [[10, 10, 0]]},              # empty interval in a small group: the per-row path fails
    {"methyl_m6a": [2 ** 64]},                 # beyond int64: per-row path
    {"intervals": [[2 ** 64, 2 ** 64 + 2, 2]]},
    {"intervals": [[10, 20, 2 ** 64]]},
    {"intervals": [[10, 20, 1.5]]},            # not ints: per-row path
    {"methyl_m6a": [12, 13.0, True]},
])
def test_unusual_values_take_the_per_row_path(monkeypatch, updates):
    piece = ll.LiftPiece(0, 0, 100, 0, 100, "+", True, "H#1", "src")
    _both(monkeypatch, [_one(**updates)], [piece])


def test_marks_near_the_key_range_take_the_per_row_path(monkeypatch):
    """Positions are checked after the decode base is added: a mark at 2**40 must not share a composite
    key with the next list's mark at 0."""
    piece = ll.LiftPiece(0, 0, 100, 0, 100, "+", True, "H#1", "src")
    reads = [_one(id="a", _fiberbrowser_source_base=1, methyl_m6a=[(1 << 40) - 1]), _one(id="b", methyl_m6a=[0])]
    rows = _both(monkeypatch, reads, [piece])
    assert [r["live_lift"]["dropped"]["points"] for r in rows] == [1, 0]
    _both(monkeypatch, [_one(_fiberbrowser_source_base=(1 << 40) - 1, methyl_m6a=[1], methyl_m5c=[1 - (1 << 40)])],
          [piece])


def test_intervals_across_many_fragments(monkeypatch):
    """An interval crossing many fragments maps to one part per fragment where every junction cuts (a
    50-bp connector: an indel event of sv_min_len), also when the expansion runs in slices (small batch
    budget); across junctions a call runs across (10-bp badges) it is one part."""
    from services.lift import compose_columns

    monkeypatch.setattr(compose_columns, "CHUNK_ELEMENTS", 40)
    ivs = [[3 * j, 3 * j + 900, 900] for j in range(30)]
    read = _one(reference_end=1280, intervals=ivs, qualities=[], _fiberbrowser_calls={},
                _fiberbrowser_aligned_runs=[[0, 0, 1280]],
                _fiberbrowser_lift_record={"contig": "src", "reverse": False, "length": 1280})
    cutting = [ll.LiftPiece(0, 60 * k, 60 * k + 10, 20 * k, 20 * k + 10, "+", True, "H#1", "src") for k in range(64)]
    rows = _both(monkeypatch, [read] * 3, cutting, start=0, end=3840)
    assert sum(len(r["intervals"]) for r in rows) > 1000
    badges = [ll.LiftPiece(0, 10 * k, 10 * k + 10, 20 * k, 20 * k + 10, "+", True, "H#1", "src") for k in range(64)]
    rows = _both(monkeypatch, [read] * 3, badges, start=0, end=640)
    assert [len([iv for iv in r["intervals"] if iv[2] > 0]) for r in rows] == [30, 30, 30]


def test_cancellation_reaches_the_hidden_blocks(monkeypatch):
    """A load cancelled while hidden insertion blocks are composed stops, as it did when they were
    composed row by row."""
    import threading

    from services.background_work import Cancelled, cancel_scope
    from services.lift import differences

    pieces = [ll.LiftPiece(0, 0, 20, 0, 20, "+", True, "H#1", "src"),
              ll.LiftPiece(0, 20, 40, 120, 140, "+", True, "H#1", "src")]
    token = threading.Event()
    original = compose._insertion_payloads

    def cancelling(*args, **kwargs):
        token.set()
        return original(*args, **kwargs)

    monkeypatch.setattr(differences, "source_only_gap", lambda *a: (20, 120))
    monkeypatch.setattr(compose, "_insertion_payloads", cancelling)
    with cancel_scope(token), pytest.raises(Cancelled):
        _compose([_one()] * 512, pieces, 0, 40)


@pytest.mark.parametrize("seed", range(4))
def test_viewport_projection_of_columns_matches_lists(seed):
    """Read row format 2: projecting composed rows (IntColumn fields) to a
    viewport gives exactly what projecting the same rows as lists gives, type
    for type (working_sets.project_broad_read_to_viewport, and the live-lift
    crop of calls and call parts it ends with)."""
    from services.read_columns import has_columns, plain
    from services.working_sets import make_layer_key, project_broad_read_to_viewport

    rng = random.Random(100 + seed)
    projected = 0
    for _ in range(30):
        pieces = _pieces(rng)
        if not pieces:
            continue
        lo, hi = min(p.t_start for p in pieces), max(p.t_end for p in pieces)
        r0 = rng.randrange(lo - 100, hi)
        r1 = r0 + rng.randrange(1, 3000)
        sel = ll.PieceSelection("tgt", r0, r1, r0, r1, sorted(pieces, key=lambda p: (p.t_start, p.chain)))
        plan = ll.FetchPlan(sel, [], 0, 0)
        reads = [_read(rng, i) for i in range(rng.randrange(1, 10))]
        rows = compose.lift_compact_reads(reads, plan, handle=None, region_start=r0, region_end=r1, key="k",
                                          dataset_id="d", molecules={}, settings=ll.LiftSettings(),
                                          loader_options=dict(hide_terminal_gaps=rng.random() < 0.6))
        for row in rows:
            listed = plain(row)
            for _ in range(4):
                offset = rng.randrange(-50, max(1, r1 - r0))
                width = rng.choice([1, 10, 300, 5000])
                kw = dict(viewport_offset=offset, region_width=width, include_methylation=rng.random() < 0.8,
                          layer_key=rng.choice([make_layer_key(True), make_layer_key(True, "nuc"),
                                                make_layer_key(False)]),
                          include_layer_qualities=rng.random() < 0.7, index_intervals=rng.random() < 0.5)
                got = project_broad_read_to_viewport(row, **kw)
                want = project_broad_read_to_viewport(listed, **kw)
                assert not has_columns(got[0] or {}) or "insertions" in str(got[0])
                _same(got, want)
                projected += 1
    assert projected > 200
