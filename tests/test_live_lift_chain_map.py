"""Plain UCSC chain input for live lift (A12): the same geometry as the sidecar route.

Independent oracle: the chain text below is written by hand from the toy
sidecar's blocks (live_lift_fixtures), so the expected pieces are known.
"""
import gzip
import json
import os

import pytest

from live_lift_fixtures import MAT, PAT, SSIZE, TARGET, TSIZE, write_bam, write_toy_sidecar, make_record
from services.lift import live_lift as ll
from services.lift.chain_map import is_chain_path, load_chain_map, read_chains
from services.lift.live_lift import LiftMapHandle

# chain0 MAT '+', chain2 PAT '+' of the toy (ids 1 and 3), as UCSC chain text.
CHAIN = f"""chain 5000 {TARGET} {TSIZE} + 1000 7900 {MAT} {SSIZE} + 0 6990 1
3000 10 0
2000 0 100
1890

chain 4000 {TARGET} {TSIZE} + 15000 19000 {PAT} {SSIZE} + 0 4000 3
4000
"""


def write_chain(path, text=CHAIN, compress=False):
    if compress:
        with gzip.open(path, "wt") as fh:
            fh.write(text)
    else:
        with open(path, "w") as fh:
            fh.write(text)
    return str(path)


def pieces(handle, s, e, chains=None):
    m = handle.map
    return sorted((handle.manifest["sources"][m.chains[p.chain]["source"]]["name"], p.t_start, p.t_end, p.q_start,
                   p.q_end, p.strand, p.primary) for p in m.target_to_source(TARGET, s, e)
                  if chains is None or p.chain in chains)


@pytest.mark.parametrize("compress", [False, True])
def test_chain_matches_sidecar_geometry(tmp_path, compress):
    chain = LiftMapHandle(write_chain(tmp_path / ("toy.chain.gz" if compress else "toy.chain"), compress=compress))
    side = LiftMapHandle(write_toy_sidecar(tmp_path / "map"))
    for s, e in ((900, 1200), (3990, 4020), (5990, 6100), (6000, 6020), (15500, 15600), (1000, 7900)):
        # The toy sidecar's chains 0 (MAT) and 2 (PAT) are the two chains written above.
        assert pieces(chain, s, e) == pieces(side, s, e, chains={0, 2}), (s, e)
    assert chain.haplotype_labels == {"MATERNAL": "MAT", "PATERNAL": "PAT"}
    assert chain.target_size(TARGET) == TSIZE and chain.plain_chain and not side.plain_chain
    assert chain.payload_stamps == [] and chain.fingerprint


def test_gap_reasons_are_shape_guesses(tmp_path):
    m = load_chain_map(write_chain(tmp_path / "toy.chain"))
    gaps = m.chain_data(0)["gaps"]
    reasons = [m.reasons[g[4]] for g in gaps]
    assert reasons == ["target_insertion", "source_insertion"]


@pytest.mark.parametrize("text,match", [
    ("1000\n", "before any header"),
    (f"chain 1 {TARGET} {TSIZE} + 0 10 {MAT} {SSIZE} + 0 10 1\n5\n", "do not end"),
    (f"chain 1 {TARGET} {TSIZE} - 0 10 {MAT} {SSIZE} + 0 10 1\n10\n", "target strand"),
    ("", "no chains"),
])
def test_malformed_chains_are_refused(tmp_path, text, match):
    with pytest.raises(ValueError, match=match):
        read_chains(write_chain(tmp_path / "bad.chain", text))


def test_chain_suffixes():
    assert all(is_chain_path(p) for p in ("a.chain", "b.over.chain.gz", "C.CHAIN.GZ"))
    assert not is_chain_path("a.graphlift.json")


def test_registration_reads_through_a_chain(tmp_path, monkeypatch):
    import server as srv
    from plugins import init_context
    from services.local_auth import auth_headers
    from starlette.testclient import TestClient
    monkeypatch.setenv("FIBERBROWSER_LIVE_LIFT", "1")
    ll.clear_selection_cache()
    ll.clear_primary_cache()
    chain = write_chain(tmp_path / "toy.chain")
    side = write_toy_sidecar(tmp_path / "map")
    bam = write_bam(tmp_path / "src.bam", lambda h: [make_record(h, "plus", MAT, 2500, "3300M"),
                                                      make_record(h, "pat", PAT, 500, "1000M")])
    old = srv.state
    srv.state = srv.BrowserState(None, None, None, None)
    init_context(srv.state)
    try:
        client = TestClient(srv.app, headers=auth_headers())
        rows = {}
        for name, manifest in (("chain", chain), ("sidecar", side)):
            added = client.post("/api/lift/datasets", json={"paths": [bam], "manifest": manifest,
                                                            "dataset_id": f"lift_{name}"}).json()
            assert added["success"], added
            r = client.get("/api/reads/compact", params=dict(dataset_ids=added["dataset"]["id"], chrom=TARGET,
                                                             start=0, end=TSIZE, format="json"))
            assert r.status_code == 200, r.text
            body = r.json()
            reads = body.get("reads") or body.get(added["dataset"]["id"], {}).get("reads") or []
            rows[name] = sorted((x.get("id"), x.get("start"), x.get("end")) for x in reads)
        assert rows["chain"] and rows["chain"] == rows["sidecar"]
        maps = client.get("/api/lift/maps", params={"near": bam}).json()["maps"]
        assert any(m["manifest"].endswith("toy.chain") for m in maps)
    finally:
        srv.state = old
        init_context(old)


REAL_CHAIN = os.environ.get("FIBERBROWSER_TEST_LIFT_CHAIN")
REAL_MAP = os.environ.get("FIBERBROWSER_TEST_LIFT_MAP")


@pytest.mark.skipif(not (REAL_CHAIN and REAL_MAP and os.path.exists(REAL_CHAIN) and os.path.exists(REAL_MAP)),
                    reason="set FIBERBROWSER_TEST_LIFT_CHAIN and FIBERBROWSER_TEST_LIFT_MAP (the chain graphlift emitted with that sidecar)")
def test_real_chain_matches_its_sidecar():
    import random
    chain, side = LiftMapHandle(REAL_CHAIN), LiftMapHandle(REAL_MAP)
    rng = random.Random(1)
    targets = [t["name"] for t in side.manifest["targets"]][:3]
    for chrom in targets:
        size = side.target_size(chrom) or 1_000_000
        for _ in range(100):
            s = rng.randrange(0, max(1, size - 10_000))
            e = s + rng.choice([1, 100, 5000])
            def geo(h):
                return sorted((h.manifest["sources"][h.map.chains[p.chain]["source"]]["name"], p.t_start, p.t_end,
                               p.q_start, p.q_end, p.strand, p.primary) for p in h.map.target_to_source(chrom, s, e))
            assert geo(chain) == geo(side), (chrom, s, e)
