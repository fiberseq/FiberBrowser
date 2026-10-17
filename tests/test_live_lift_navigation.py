"""Live-lift navigation tables (DESIGN_LIVE_LIFT.md §5.1): summary, outline
with drift bound, and exact delta-varint tiles in both directions."""
import os
import random

import pytest

from live_lift_fixtures import MAT, TARGET, write_toy_sidecar
from services.lift import live_lift as ll
from services.lift import navigation as nav

V4 = os.path.expanduser("~/pglift_work/pglift_20261017/native/graphlift/scratch/v4")
HPRC = os.path.join(V4, "hprc.GRCh38.HG002.chain.graphlift.json")


@pytest.fixture
def toy(tmp_path):
    return ll.open_lift_map(write_toy_sidecar(tmp_path / "map"))


def test_summary_rows(toy):
    rows = nav.map_summary(toy)
    assert rows[1] == [TARGET, 12000, 14000, MAT, 7000, 9000, "-", "H#1", 2000]
    assert rows[4][-1] == 0  # the alternative chain is never primary


def test_outline_merges_small_gaps_with_drift(toy):
    rows = nav.outline(toy, TARGET)
    # Chain 0: the 10 bp target gap and the 100 bp source gap merge (<= 2 kb); drift 100 - 10 = 90.
    assert [r for r in rows if r[5] == 0] == [[1000, 7900, 0, 6990, "+", 0, 90]]
    assert [r for r in rows if r[5] == 3] == [[8000, 8403, 9100, 9500, "+", 3, 3]]
    out = nav.Outline(rows)
    chain, q, drift = out.lookup(12_100)[0]
    assert (chain, q, drift) == (1, 8899, 0)
    exact = toy.map.target_to_source(TARGET, 6500, 6501)[0].q_start
    (_c, approx, d), = out.lookup(6500)
    assert abs(approx - exact) <= d


@pytest.mark.parametrize("side", [0, 1])
def test_tile_roundtrip_and_lookup_toy(toy, side):
    pieces = nav.primary_pieces(toy, TARGET)
    runs = nav.tile_runs(pieces, side, 0)
    tile = nav.decode_tile(nav.encode_tile(runs, side, 0))
    assert len(tile["start"]) == len(runs)
    if side == 0:
        assert nav.tile_lookup(tile, 12_000) == [(1, 8999)]
        assert nav.tile_lookup(tile, 4005) == []           # the target-only gap
    else:
        assert nav.tile_lookup(tile, 8999) == [(1, 12_000)]
        assert sorted(nav.tile_lookup(tile, 100)) == [(0, 1100), (2, 15_100)]  # both haplotypes


@pytest.mark.skipif(not os.path.exists(HPRC), reason="graphlift v4 sidecars not present")
def test_tiles_agree_with_the_reader_on_hprc_chr1():
    h = ll.open_lift_map(HPRC)
    pieces = nav.primary_pieces(h, "chr1")
    rng = random.Random(5)
    by_source = {}
    for p in pieces:
        by_source.setdefault(p.source, []).append(p)
    target_tiles = nav.build_tiles(pieces, 0)
    source_tiles = {src: nav.build_tiles(ps, 1) for src, ps in by_source.items()}
    checked = 0
    for _ in range(2000):
        t = rng.randrange(0, 248_000_000)
        want = sorted((p.chain, p.q_start if p.strand == "+" else p.q_end - 1)
                      for p in h.map.target_to_source("chr1", t, t + 1) if p.primary)
        encoded = target_tiles.get(t // nav.TILE_BP)
        got = sorted(nav.tile_lookup(nav.decode_tile(encoded), t)) if encoded else []
        assert got == want
        for chain, q in want:
            src = h.manifest["sources"][h.map.chains[chain]["source"]]["name"]
            st = nav.decode_tile(source_tiles[src][q // nav.TILE_BP])
            assert (chain, t) in nav.tile_lookup(st, q)
            checked += 1
    assert checked > 1000
