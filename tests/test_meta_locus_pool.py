"""Meta-locus phase 1: pool index, background build with progress / Cancel, on-disk cache, working sets by stored
file position, More reads and Resample (services/meta_locus_pool, meta_locus_jobs, meta_locus_decode)."""
from __future__ import annotations

import os
import time
from array import array
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pysam
import pytest

from services import meta_locus_decode as md
from services import meta_locus_jobs as mj
from services import meta_locus_pool as mp

DEMO = Path(__file__).resolve().parents[1] / "browser" / "data" / "demo" / "napa_ddda.bam"
SPACING = 7000


@pytest.fixture(autouse=True)
def _cache(tmp_path, monkeypatch):
    monkeypatch.setenv(mp.CACHE_DIR_ENV, str(tmp_path / "cache"))
    mj._pools.clear()
    yield
    for p in list(mj._pools.values()):
        p.cancel.set()
    mj._pools.clear()


def _bam(path: Path, n_sites: int = 40, per_site: int = 12, seed: int = 3, gap_reads: int = 0) -> str:
    """Reads around sites every SPACING bp on chrT (footprints as fibertools ns/nl), some spanning two sites, one
    secondary record, and ``gap_reads`` reads per site with a long unfootprinted end (the terminal-gap filter)."""
    import random
    rng = random.Random(seed)
    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": "chrT", "LN": n_sites * SPACING + 40_000}]}
    recs = []
    for i in range(n_sites):
        a = 10_000 + i * SPACING
        for j in range(per_site + gap_reads):
            length = rng.randint(2500, 9000)
            s = max(1, rng.randint(a - length + 300, a - 300))
            gap = j >= per_site
            fps, pos = [], s + (900 if gap else rng.randint(0, 150))
            while pos + 147 < s + length - 60:
                fps.append(pos - s)
                pos += 190
            recs.append((s, f"r{i:03d}_{j:02d}{'g' if gap else ''}", length, fps, False))
    recs.append((10_000 - 500, "r000_00", 1000, [10], True))  # a secondary alignment of a read already counted
    recs.sort()
    with pysam.AlignmentFile(str(path), "wb", header=header) as out:
        for s, name, length, fps, secondary in recs:
            r = pysam.AlignedSegment(out.header)
            r.query_name, r.reference_id, r.reference_start, r.mapping_quality = name, 0, s, 60
            r.flag = 256 if secondary else 0
            r.query_sequence = "ACGT" * (length // 4) + "ACGT"[: length % 4]
            r.cigarstring = f"{length}M"
            r.set_tag("ns", array("I", fps))
            r.set_tag("nl", array("I", [147] * len(fps)))
            out.write(r)
    pysam.index(str(path))
    return str(path)


def _regions(n_sites: int = 40) -> list:
    return [["chrT", 10_000 + i * SPACING - 100, 10_000 + i * SPACING + 100, "-" if i % 3 == 0 else "+", f"s{i}"] for i in range(n_sites)]


def _spec(regions, **kw):
    return dict(mp.DEFAULTS, regions_sha256=mp.regions_sha256(regions), **kw)


def _state(paths: dict):
    from models.domain import Dataset
    datasets = {d: Dataset(d, p, data_type="bam") for d, p in paths.items()}
    return SimpleNamespace(datasets=datasets, dataset_order=list(paths), chrom_map={}, short_terminal_footprint_bp=0)


def _wait(pool, timeout=60):
    t = time.monotonic()
    while pool.status == "building" and time.monotonic() - t < timeout:
        time.sleep(0.02)
    return pool.status


# ----------------------------------------------------------------------------------------------------- sites and index


def test_sites_flip_convention_spans_the_same_virtual_window():
    s = mp.build_sites([["c", 1000, 1001, "+", "p"], ["c", 1000, 1001, "-", "m"]], "centre", 100)
    assert list(s.anchor) == [1001, 1001]
    assert (int(s.win_start[0]), int(s.win_end[0])) == (901, 1101)   # [a - f, a + f)
    assert (int(s.win_start[1]), int(s.win_end[1])) == (902, 1102)   # [a - f + 1, a + f + 1): after the flip, [-f, f)
    # a minus-strand read base at the anchor lands on window coordinate flank - 1 + 1 = flank (virtual 0)
    read = {"intervals": [[99, 100, 1]], "methyl": [99]}
    flipped = md.mirror_compact_read(read, 200)
    assert flipped["intervals"] == [[100, 101, 1]] and flipped["methyl"] == [100]


def test_overlap_policies_and_block_layout_independence(tmp_path):
    bam = _bam(tmp_path / "a.bam")
    regions = _regions()
    sites = mp.build_sites(regions, "centre", 5000)  # windows of neighbouring sites (7 kb apart) overlap
    with pysam.AlignmentFile(bam) as f:
        primaries = {r.query_name for r in f.fetch("chrT") if not r.is_secondary}
    for policy in ("nearest", "per_site"):
        a = mp.enumerate_dataset("d1", [bam], sites, _spec(regions, flank_bp=5000, policy=policy))
        b = mp.enumerate_dataset("d1", [bam], sites, _spec(regions, flank_bp=5000, policy=policy, block_max_gap_bp=0, block_max_len_bp=5000))
        assert a.names == b.names and np.array_equal(a.site, b.site) and np.array_equal(a.mol, b.mol)
        assert np.array_equal(a.start, b.start)  # (offsets are seek hints and may differ by block layout)
        assert set(a.names) <= primaries and len(set(a.names)) == a.n_molecules
        if policy == "nearest":
            nearest = a
            assert len(a) == a.n_molecules and not a.shared.any()
        else:
            # one entry per (molecule, site) pair, each molecule in every window it overlaps
            assert len(a) > a.n_molecules and a.shared.any()
            assert len({(int(m), int(s)) for m, s in zip(a.mol, a.site)}) == len(a)
            assert set(a.names) == set(nearest.names)
            for m in range(0, a.n_molecules, 7):
                lo, hi = int(a.start[m]), int(a.end[m])
                want = {i for i in range(len(sites)) if sites.win_start[i] < hi and sites.win_end[i] > lo}
                assert {int(s) for s, mm in zip(a.site, a.mol) if mm == m} == want


def test_cache_round_trip_and_key(tmp_path):
    bam = _bam(tmp_path / "a.bam")
    regions = _regions()
    spec = _spec(regions)
    sites = mp.build_sites(regions, "centre", 1000)
    ix = mp.enumerate_dataset("d1", [bam], sites, spec)
    key = mp.dataset_cache_key([bam], spec)
    ix.save(mp.cache_path(key))
    back = mp.DatasetIndex.load("d1", mp.cache_path(key))
    assert back.names == ix.names and np.array_equal(back.voff, ix.voff) and np.array_equal(back.mol, ix.mol)
    assert np.array_equal(back.keys(5), ix.keys(5))
    assert mp.dataset_cache_key([bam], _spec(regions, flank_bp=500)) != key
    assert mp.dataset_cache_key([bam], _spec(regions[:-1])) != key
    st = os.stat(bam)
    os.utime(bam, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000_000))
    assert mp.dataset_cache_key([bam], spec) != key


def test_take_balanced_splits_and_hands_on_shortfalls():
    ix = {"a": list(range(10)), "b": list(range(3))}
    assert mp.take_balanced(ix, ["a", "b"], 1, {}, 8) == {"a": (0, 5), "b": (0, 3)}
    assert mp.take_balanced(ix, ["a", "b"], 1, {"a": 5, "b": 3}, 8) == {"a": (5, 10), "b": (3, 3)}


def test_cache_eviction_keeps_the_newest(tmp_path):
    root = mp.cache_root()
    root.mkdir(parents=True)
    for i in range(3):
        p = root / f"k{i}.npz"
        p.write_bytes(b"x" * 1000)
        os.utime(p, (1000 + i, 1000 + i))
    assert mp.evict_cache(max_bytes=1500) == 2000
    assert [p.name for p in root.glob("*.npz")] == ["k2.npz"]


# ----------------------------------------------------------------------------------------------------- decode


@pytest.mark.parametrize("flank", [400, 150])
def test_seek_decode_matches_the_ordinary_loader_per_site(flank):
    from services.compact_read_loader import build_compact_reads_from_bam
    bam = str(DEMO)
    regions = [["chr19", 47514600 + i * 300, 47514601 + i * 300, "-" if i % 2 else "+", f"s{i}"] for i in range(8)]
    sites = mp.build_sites(regions, "centre", flank)
    ix = mp.enumerate_dataset("d1", [bam], sites, _spec(regions, flank_bp=flank))
    ents = [int(e) for e in ix.ranked(1)[:300]]
    opts = dict(include_methylation=True, include_layers=True)
    st: dict = {}
    got = md.decode_entries([bam], ix, sites, ents, loader_options=opts, stats=st)
    # one record read per molecule, whatever the number of its sites' entries
    assert st["undecodable"] == 0 and st["exact"] + st["forward"] + st["fallback"] == len({int(ix.mol[e]) for e in ents})
    # The reference: the ordinary loader over a view holding every read whole, clipped to each site window.
    checked = 0
    with pysam.AlignmentFile(bam) as f:
        spans = [(r.reference_start, r.reference_end) for r in f.fetch("chr19")]
    lo = min(min(a for a, _ in spans), int(sites.win_start.min()))
    hi = max(max(b for _, b in spans), int(sites.win_end.max()))
    rows = build_compact_reads_from_bam(bam, "chr19", lo, hi, spanning_only=False, **opts)
    whole = {r["id"]: r for r in (rows[0] if isinstance(rows, tuple) else rows)}
    for e in ents:
        s = int(ix.site[e])
        ref = whole.get(ix.names[int(ix.mol[e])])
        assert (ref is None) == (e not in got)
        if ref is None:
            continue
        ref = md.clip_compact_read(ref, lo - int(sites.win_start[s]), 2 * flank)
        if sites.minus[s]:
            ref = md.mirror_compact_read(ref, 2 * flank)
        assert got[e] == ref, ix.names[int(ix.mol[e])]
        checked += 1
    assert checked > 200


# ----------------------------------------------------------------------------------------------------- jobs and working sets


def _ids(ws):
    return [(r["meta"]["dataset"], r["id"]) for r in ws["reads"]]


def test_background_build_progress_more_reads_resample_and_identical_after_cache_rebuild(tmp_path):
    paths = {"d1": _bam(tmp_path / "a.bam", seed=3), "d2": _bam(tmp_path / "b.bam", seed=4)}
    state = _state(paths)
    regions = _regions()
    pool = mj.start_pool(state, {"flank_bp": 1000}, regions, "sites")
    assert _wait(pool) == "ready", pool.error
    status = pool.as_status()
    assert status["progress"]["sites_done"] == 2 * len(regions) and status["progress"]["bytes_total"] > 0
    assert status["progress"]["fraction"] == 1.0 and status["datasets"]["d1"]["status"] == "done"

    first = mj.working_set(pool, {"seed": 1, "count": 200}, state)
    assert first["returned"] == 200 and not first["provisional"]
    assert {r["meta"]["dataset"] for r in first["reads"]} == {"d1", "d2"}
    r = first["reads"][0]
    assert {"site", "site_name", "chrom", "window", "anchor", "strand", "read_start", "read_end", "key", "rank", "identity", "real"} <= set(r["meta"])
    assert set(first["datasets"]) == {"d1", "d2"} and sum(len(p["reads"]) for p in first["datasets"].values()) == 200
    assert all(0 <= iv[0] < iv[1] <= 2000 for r in first["reads"] for iv in r["intervals"])

    more = mj.working_set(pool, {"seed": 1, "count": 100, "cursor": first["cursor"]}, state)
    assert not set(_ids(more)) & set(_ids(first)) and more["returned"] == 100
    both = mj.working_set(pool, {"seed": 1, "count": 300}, state)
    assert _ids(both) and set(_ids(both)) == set(_ids(first)) | set(_ids(more))

    other = mj.working_set(pool, {"seed": 2, "count": 200}, state)
    assert set(_ids(other)) != set(_ids(first))

    # Reopen from the cache (a new server: nothing in memory) and rebuild from scratch: the same working set.
    mj._pools.clear()
    cached = mj.start_pool(state, {"flank_bp": 1000}, regions, "sites")
    assert cached.status == "ready" and set(cached.dataset_status.values()) == {"cached"}
    assert mj.working_set(cached, {"seed": 1, "count": 200}, state)["reads"] == first["reads"]
    mj._pools.clear()
    for p in mp.cache_root().glob("*.npz"):
        p.unlink()
    rebuilt = mj.start_pool(state, {"flank_bp": 1000}, regions, "sites")
    assert _wait(rebuilt) == "ready"
    assert mj.working_set(rebuilt, {"seed": 1, "count": 200}, state)["reads"] == first["reads"]


def test_filtered_reads_are_replaced_and_counted(tmp_path):
    paths = {"d1": _bam(tmp_path / "a.bam", per_site=4, gap_reads=4)}
    state = _state(paths)
    pool = mj.start_pool(state, {}, _regions(), "sites")
    assert _wait(pool) == "ready"
    ws = mj.working_set(pool, {"seed": 1, "count": 60}, state)
    st = ws["stats"]["d1"]
    assert ws["returned"] == 60 and st["filtered"] > 0 and st["requested"] == 60 + st["filtered"]
    assert not any(r["id"].endswith("g") for r in ws["reads"])  # a > 500 bp terminal gap: the display hides it too
    off = mj.working_set(pool, {"seed": 1, "count": 60, "terminal_gap_threshold": 0}, state)
    assert off["stats"]["d1"]["filtered"] == 0


def test_cancel_stops_the_build(tmp_path, monkeypatch):
    paths = {"d1": _bam(tmp_path / "a.bam")}
    state = _state(paths)
    original = mp.enumerate_dataset

    def slow(*args, cancelled=None, **kw):
        while not cancelled():
            time.sleep(0.01)
        return original(*args, cancelled=cancelled, **kw)

    monkeypatch.setattr(mp, "enumerate_dataset", slow)
    pool = mj.start_pool(state, {}, _regions(), "sites")
    assert pool.status == "building"
    mj.cancel_pool(pool.pool_id)
    assert _wait(pool) == "cancelled"
    assert not list(mp.cache_root().glob("*.npz"))


def test_provisional_working_set_while_building(tmp_path, monkeypatch):
    paths = {"d1": _bam(tmp_path / "a.bam")}
    state = _state(paths)
    gate = __import__("threading").Event()
    original = mp._Accumulator.add_block
    calls = []

    def held(self, extents, hits_of):
        added = original(self, extents, hits_of)
        calls.append(1)
        if len(calls) == 1:
            gate.wait(10)  # the build pauses after its first block
        return added

    monkeypatch.setattr(mp._Accumulator, "add_block", held)
    pool = mj.start_pool(state, {"flank_bp": 1000}, _regions(), "sites")
    t = time.monotonic()
    while len(calls) < 1 and time.monotonic() - t < 10:
        time.sleep(0.01)
    ws = mj.working_set(pool, {"seed": 1, "count": 10}, state)
    assert ws["provisional"] and 0 < ws["returned"] <= 10 and pool.as_status()["status"] == "building", (ws["provisional"], ws["returned"], pool.as_status()["status"], len(calls))
    gate.set()
    assert _wait(pool) == "ready"
    assert not mj.working_set(pool, {"seed": 1, "count": 10}, state)["provisional"]


def test_routes(tmp_path, monkeypatch):
    from fastapi import FastAPI
    from starlette.testclient import TestClient
    import routers.meta_locus as rml
    from state.dependencies import get_state

    paths = {"d1": _bam(tmp_path / "a.bam")}
    state = _state(paths)
    bed = tmp_path / "sites.bed"
    bed.write_text("".join(f"{c}\t{s}\t{e}\t{n}\t0\t{st}\n" for c, s, e, st, n in _regions()))
    app = FastAPI()
    app.include_router(rml.router)
    app.dependency_overrides[get_state] = lambda: state
    client = TestClient(app)
    started = client.post("/api/meta_locus/pools", json={"bed_path": str(bed), "flank_bp": 800}).json()
    assert started["name"] == "sites" and started["sites"] == 40
    pid = started["pool_id"]
    t = time.monotonic()
    while client.get(f"/api/meta_locus/pools/{pid}").json()["status"] == "building" and time.monotonic() - t < 30:
        time.sleep(0.02)
    status = client.get(f"/api/meta_locus/pools/{pid}").json()
    assert status["status"] == "ready" and status["progress"]["entries"] > 0
    ws = client.post(f"/api/meta_locus/pools/{pid}/reads", json={"count": 50}).json()
    assert ws["returned"] == 50 and ws["offset"] == -800 and ws["width"] == 1600
    assert client.get("/api/meta_locus/pools/nope").status_code == 404
    assert client.post("/api/meta_locus/pools", json={"regions": _regions(), "dataset_ids": ["missing"]}).status_code == 404
    assert client.post("/api/meta_locus/pools", json={"regions": _regions(), "anchor": "middle"}).status_code == 422
    assert pid in [p["pool_id"] for p in client.get("/api/meta_locus/pools").json()["pools"]]
    assert client.delete(f"/api/meta_locus/pools/{pid}").json()["success"] is True


# ----------------------------------------------------------------------------------------------------- phase 2


def test_fast_keys_are_the_stable_keys():
    from services.stable_sample import stable_key
    names = ["m1/2/ccs", "r_é", "x" * 300, ""]
    assert mp.fast_keys(7, "d1", names).tolist() == [stable_key(7, "d1", n) for n in names]


def test_keys_are_kept_on_disk_per_seed_and_dataset(tmp_path, monkeypatch):
    paths = {"d1": _bam(tmp_path / "a.bam")}
    state = _state(paths)
    pool = mj.start_pool(state, {}, _regions(), "sites")
    assert _wait(pool) == "ready"
    ix = pool.indexes["d1"]
    k = ix.keys(3)
    files = list(mp.cache_root().glob("*.k3.npy"))
    assert len(files) == 1
    mj._pools.clear()
    reopened = mj.start_pool(state, {}, _regions(), "sites").indexes["d1"]
    monkeypatch.setattr(mp, "fast_keys", lambda *a: pytest.fail("keys recomputed"))
    assert np.array_equal(reopened.keys(3), k)
    other = mp.DatasetIndex("d2", ix.site, ix.mol, ix.names, ix.start, ix.end, ix.file, ix.voff, cache_key=ix.cache_key)
    monkeypatch.undo()
    assert not np.array_equal(other.keys(3), k)  # another dataset id: other keys, another file


def test_parallel_decode_gives_the_same_working_set(tmp_path):
    paths = {"d1": _bam(tmp_path / "a.bam"), "d2": _bam(tmp_path / "b.bam", seed=9)}
    state = _state(paths)
    pool = mj.start_pool(state, {}, _regions(), "sites")
    assert _wait(pool) == "ready"
    serial = mj.working_set(pool, {"seed": 4, "count": 300, "decode_workers": 1}, state)
    parallel = mj.working_set(pool, {"seed": 4, "count": 300, "decode_workers": 2, "parallel_min_reads": 1}, state)
    assert parallel["reads"] == serial["reads"] and parallel["cursor"] == serial["cursor"]
    md.shutdown_workers()


def test_virtual_shape_matches_an_ordinary_read():
    s = mp.build_sites([["c", 1000, 1001, "+", "p"], ["c", 5000, 5001, "-", "m"]], "centre", 100)
    # plus window [901, 1101); minus window [4902, 5102)
    read = {"id": "r", "reference_start": 950, "reference_end": 1200, "aligned_blocks": [[950, 1100], [1110, 1200]],
            "alignment_orientation": "forward", "intervals": [[0, 10, 5]]}
    plus = md.virtualize_read(read, s, 0)
    assert (plus["reference_start"], plus["reference_end"]) == (49, 299) and plus["aligned_blocks"] == [[49, 199], [209, 299]]
    assert plus["meta"]["real"]["reference_start"] == 950 and plus["meta"]["real"]["chrom"] == "c"
    rm = dict(read, reference_start=4950, reference_end=5200, aligned_blocks=[[4950, 5100], [5110, 5200]])
    minus = md.virtualize_read(rm, s, 1)
    # [4950, 5200) -> window [48, 298) -> mirrored [200 - 298, 200 - 48) = [-98, 152)
    assert (minus["reference_start"], minus["reference_end"]) == (-98, 152)
    assert minus["aligned_blocks"] == [[-98, -8], [2, 152]] and minus["alignment_orientation"] == "reverse"
    # the anchor base (real 5001 = window 99) lands on 100 = flank after the flip: virtual 0 on the axis
    assert md.virtualize_read(dict(read, reference_start=5001, reference_end=5002, aligned_blocks=[[5001, 5002]]), s, 1)["reference_start"] == 100
    assert minus["intervals"] == read["intervals"]  # window-relative fields are untouched here


def test_overshoot_changes_cost_not_reads(tmp_path):
    paths = {"d1": _bam(tmp_path / "a.bam", per_site=4, gap_reads=4)}
    state = _state(paths)
    pool = mj.start_pool(state, {}, _regions(), "sites")
    assert _wait(pool) == "ready"
    a = mj.working_set(pool, {"seed": 1, "count": 50, "overshoot": 0}, state)
    b = mj.working_set(pool, {"seed": 1, "count": 50, "overshoot": 0.5}, state)
    assert a["reads"] == b["reads"] and a["cursor"] == b["cursor"] and a["stats"] == b["stats"]
    more = mj.working_set(pool, {"seed": 1, "count": 30, "overshoot": 0.5, "cursor": b["cursor"]}, state)
    whole = mj.working_set(pool, {"seed": 1, "count": 80, "overshoot": 0}, state)
    assert [r["id"] for r in whole["reads"]] == [r["id"] for r in b["reads"] + more["reads"]]


def test_counts_are_read_site_observations_by_default(tmp_path):
    paths = {"d1": _bam(tmp_path / "a.bam")}
    state = _state(paths)
    pool = mj.start_pool(state, {"flank_bp": 5000}, _regions(), "sites")  # neighbouring windows overlap
    assert _wait(pool) == "ready"
    ix = pool.indexes["d1"]
    ws = mj.working_set(pool, {"seed": 1, "count": 300}, state)
    st = ws["stats"]["d1"]
    assert ws["count_unit"] == "observation" and st["observations"] == 300 and st["molecules"] < 300
    assert ws["datasets"]["d1"]["total"] == len(ix) > ix.n_molecules
    assert any(r["meta"]["shared"] for r in ws["reads"])
    mol = mj.working_set(pool, {"seed": 1, "count": 300, "count_unit": "molecule"}, state)
    assert mol["reads"] == ws["reads"] and mol["datasets"]["d1"]["total"] == ix.n_molecules


def test_route_accepts_an_uploaded_bed_and_says_what_is_wrong(tmp_path):
    from fastapi import FastAPI
    from starlette.testclient import TestClient
    import routers.meta_locus as rml
    from state.dependencies import get_state

    state = _state({"d1": _bam(tmp_path / "a.bam")})
    app = FastAPI()
    app.include_router(rml.router)
    app.dependency_overrides[get_state] = lambda: state
    client = TestClient(app)
    text = "".join(f"{c}\t{s}\t{e}\t{n}\t0\t{st}\n" for c, s, e, st, n in _regions())
    up = client.post("/api/meta_locus/pools", json={"bed_text": text, "bed_name": "uploaded_sites.bed.gz", "flank_bp": 800})
    assert up.status_code == 200, up.text
    body = up.json()
    saved = Path(body["spec"]["bed_path"])
    assert body["name"] == "uploaded_sites" and saved.is_file() and saved.read_text() == text
    # the saved copy reopens the same pool by path (URLs and sessions)
    again = client.post("/api/meta_locus/pools", json={"bed_path": str(saved), "flank_bp": 800}).json()
    assert again["pool_id"] == body["pool_id"]
    bad = client.post("/api/meta_locus/pools", json={"bed_text": "not a bed\nchr1\tx\ty\n", "bed_name": "junk.bed"})
    assert bad.status_code == 422 and "No BED regions in junk.bed" in bad.json()["detail"]
    missing = client.post("/api/meta_locus/pools", json={"bed_path": str(tmp_path / "gone.bed")})
    assert missing.status_code == 404 and "No BED file" in missing.json()["detail"]
    (tmp_path / "empty.bed").write_text("track name=x\n#nothing\n")
    empty = client.post("/api/meta_locus/pools", json={"bed_path": str(tmp_path / "empty.bed")})
    assert empty.status_code == 422 and "no usable regions" in empty.json()["detail"]
    state.datasets = {}
    state.dataset_order = []
    none = client.post("/api/meta_locus/pools", json={"bed_text": text, "bed_name": "s.bed"})
    assert none.status_code == 422 and "No native BAM dataset" in none.json()["detail"]


def test_probe_says_cached_and_building_pools_show_no_reads_until_a_view(tmp_path, monkeypatch):
    from fastapi import FastAPI
    from starlette.testclient import TestClient
    import routers.meta_locus as rml
    from state.dependencies import get_state

    state = _state({"d1": _bam(tmp_path / "a.bam")})
    app = FastAPI()
    app.include_router(rml.router)
    app.dependency_overrides[get_state] = lambda: state
    client = TestClient(app)
    bed = tmp_path / "sites.bed"
    bed.write_text("".join(f"{c}\t{s}\t{e}\t{n}\t0\t{st}\n" for c, s, e, st, n in _regions()))
    spec = {"bed_path": str(bed), "anchor": "start", "flank_bp": 800}
    assert client.post("/api/meta_locus/pools/probe", json=spec).json()["cached"] is False
    assert client.post("/api/meta_locus/pools/probe", json={**spec, "bed_path": str(tmp_path / "nope.bed")}).json()["cached"] is False
    pid = client.post("/api/meta_locus/pools", json=spec).json()["pool_id"]
    pool = mj.get_pool(pid)
    assert _wait(pool) == "ready"
    assert client.post("/api/meta_locus/pools/probe", json=spec).json() == {"success": True, "cached": True, "pool_id": pid, "sites": 40}
    mj._pools.clear()
    assert client.post("/api/meta_locus/pools/probe", json=spec).json()["cached"] is True  # on disk
    assert client.post("/api/meta_locus/pools/probe", json={**spec, "anchor": "centre"}).json()["cached"] is False

    # A building pool's contig is empty until a (provisional) view is asked for; ready bumps the generation.
    gate = __import__("threading").Event()
    original = mp._Accumulator.add_block

    def held(self, extents, hits_of):
        added = original(self, extents, hits_of)
        gate.wait(10)
        return added

    monkeypatch.setattr(mp, "_Accumulator", type("Held", (mp._Accumulator,), {"add_block": held}))
    for p in mp.cache_root().glob("*"):
        if p.is_file():
            p.unlink()
    mj._pools.clear()
    building = mj.start_pool(state, {"flank_bp": 800, "anchor": "start"}, _regions(), "sites")
    t = time.monotonic()
    while not building.partial and time.monotonic() - t < 10:
        time.sleep(0.01)
    assert building.status == "building"
    assert mj.meta_broad_reads("d1", building.chrom, 0, 1600, {"include_layers": False}) == []
    before = mj.set_view(building, {"seed": 1, "count": 50})["generation"]
    gate.set()
    assert _wait(building) == "ready"
    assert building.view_generation != before


def test_lab_members_and_workspaces_see_only_their_own_pools(tmp_path, monkeypatch):
    """Release audit 3.1.0: on a lab server the pool registry is scoped to the member's workspace (listing, lookup,
    cancel, delete and the virtual contig); off the lab profile one registry, as before."""
    from services import runtime
    paths = {"d1": _bam(tmp_path / "a.bam", n_sites=6)}
    state = _state(paths)
    regions = _regions(6)
    alice, bob = SimpleNamespace(name="alice"), SimpleNamespace(name="bob")
    monkeypatch.setattr(runtime, "_lab_mode", True)
    with runtime.lab_request_context(alice):
        mine = mj.start_pool(state, {"flank_bp": 1000}, regions, "sites")
        assert _wait(mine) == "ready"
        assert mj.get_pool(mine.pool_id) is mine and [p["pool_id"] for p in mj.list_pools()] == [mine.pool_id]
        assert mj.pool_for_chrom(mine.chrom) is mine
    with runtime.lab_request_context(bob):
        assert mj.list_pools() == [] and mj.get_pool(mine.pool_id) is None
        assert mj.pool_for_chrom(mine.chrom) is None and mj.meta_chrom_size(mine.chrom) is None
        assert mj.cancel_pool(mine.pool_id) is None and mj.drop_pool(mine.pool_id) is False
        theirs = mj.start_pool(state, {"flank_bp": 1000}, regions, "sites")  # the same spec: a pool of bob's own
        assert theirs is not mine and theirs.pool_id == mine.pool_id and theirs.status == "ready"
        theirs.view_seed = 99
    with runtime.workspace_context("ws1"), runtime.lab_request_context(alice):
        assert mj.get_pool(mine.pool_id) is None  # alice's other workspace
    with runtime.lab_request_context(alice):
        assert mj.get_pool(mine.pool_id) is mine and mine.view_seed != 99 and not mine.cancel.is_set()
        assert mj.drop_pool(mine.pool_id) is True
    with runtime.lab_request_context(bob):
        assert mj.get_pool(theirs.pool_id) is theirs
    monkeypatch.setattr(runtime, "_lab_mode", False)
    mj._pools.clear()
    local = mj.start_pool(state, {"flank_bp": 1000}, regions, "sites")
    with runtime.workspace_context("ws1"):
        assert mj.get_pool(local.pool_id) is local and mj.pool_for_chrom(local.chrom) is local


def test_a_members_new_pools_never_evict_another_members_pool(tmp_path, monkeypatch):
    """Release audit 3.1.0 (recheck): MAX_POOLS eviction is per owner; past the server-wide cap a new pool is
    refused with a clear error instead of dropping another member's pool."""
    from services import runtime
    paths = {"d1": _bam(tmp_path / "a.bam", n_sites=6)}
    state = _state(paths)
    alice, bob = SimpleNamespace(name="alice"), SimpleNamespace(name="bob")
    monkeypatch.setattr(runtime, "_lab_mode", True)
    with runtime.lab_request_context(alice):
        hers = mj.start_pool(state, {"flank_bp": 1000}, _regions(6), "sites")
        assert _wait(hers) == "ready"
    with runtime.lab_request_context(bob):
        for flank in range(1, mj.MAX_POOLS + 3):  # more than MAX_POOLS distinct pools of bob's
            _wait(mj.start_pool(state, {"flank_bp": 1000 + flank}, _regions(6), "sites"))
        assert len(mj.list_pools()) == mj.MAX_POOLS  # his own oldest were dropped
    with runtime.lab_request_context(alice):
        assert mj.get_pool(hers.pool_id) is hers and not hers.cancel.is_set()
    monkeypatch.setattr(mj, "MAX_POOLS_TOTAL", mj.MAX_POOLS + 1)  # the server is full
    with runtime.lab_request_context(SimpleNamespace(name="carol")):
        with pytest.raises(mj.PoolsFull):
            mj.start_pool(state, {"flank_bp": 1000}, _regions(6), "sites")
    with runtime.lab_request_context(bob):  # bob at his own limit still replaces one of his
        _wait(mj.start_pool(state, {"flank_bp": 5000}, _regions(6), "sites"))
    with runtime.lab_request_context(alice):
        assert mj.get_pool(hers.pool_id) is hers and not hers.cancel.is_set()


def test_a_full_server_replaces_the_requesters_own_idle_pool_instead_of_refusing(tmp_path, monkeypatch):
    """3.1.1 (deferred MED): past the server-wide cap a member with an idle pool of their own gets the new pool in
    place of their least recently used one (it is rebuilt from its cache when asked again); only a member with
    nothing of their own to replace is refused. Other members' pools are never dropped."""
    from services import runtime
    paths = {"d1": _bam(tmp_path / "a.bam", n_sites=6)}
    state = _state(paths)
    alice, bob = SimpleNamespace(name="alice"), SimpleNamespace(name="bob")
    monkeypatch.setattr(runtime, "_lab_mode", True)
    mj._pools.clear()
    with runtime.lab_request_context(alice):
        hers = mj.start_pool(state, {"flank_bp": 1000}, _regions(6), "sites")
        assert _wait(hers) == "ready"
    with runtime.lab_request_context(bob):
        his = [mj.start_pool(state, {"flank_bp": 2000 + i}, _regions(6), "sites") for i in range(mj.MAX_POOLS)]
        for pool in his:
            _wait(pool)
    monkeypatch.setattr(mj, "MAX_POOLS_TOTAL", mj.MAX_POOLS + 1)  # the server is full
    with runtime.lab_request_context(alice):
        new = mj.start_pool(state, {"flank_bp": 1500}, _regions(6), "sites")
        assert _wait(new) == "ready"
        assert mj.get_pool(hers.pool_id) is None and hers.cancel.is_set()  # her own idle pool made room
        assert mj.get_pool(new.pool_id) is new
    with runtime.lab_request_context(bob):
        assert all(mj.get_pool(p.pool_id) is p and not p.cancel.is_set() for p in his)
    with runtime.lab_request_context(SimpleNamespace(name="carol")):  # nothing of hers to replace
        with pytest.raises(mj.PoolsFull):
            mj.start_pool(state, {"flank_bp": 1000}, _regions(6), "sites")
