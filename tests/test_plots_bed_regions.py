"""Plots BED region sets read by path: parsing (strand, name, header and bad lines, cap), gzip, missing files."""
from __future__ import annotations

import gzip

from fastapi import FastAPI
from starlette.testclient import TestClient

import routers.files as files


def _client():
    app = FastAPI()
    app.include_router(files.router)
    return TestClient(app)


BED = "track name=x\n#comment\nchrT\t100\t200\tp1\t0\t+\nchrT\t300\t250\tbad\nchrT\tx\t5\nchrT\t400\t500\t.\t0\t-\nchrT 600 700\n"


def test_parse_strand_name_and_skips():
    out = files.parse_bed_regions(BED)
    assert out["regions"] == [["chrT", 100, 200, "+", "p1"], ["chrT", 400, 500, "-", ""], ["chrT", 600, 700, ".", ""]]
    assert out["total"] == 3 and out["skipped"] == 2 and out["capped"] is False


def test_columns_from_five_on_as_numbers():
    out = files.parse_bed_regions("chrT\t1\t9\tn1\t7.5\t+\t3\tx\nchrT\t20\t30\nchrT\t40\t50\tn3\tnan\n")
    # Column 5 (score) first; strand and text are not numbers; a region without them has none.
    assert out["columns"] == [[7.5, None, 3.0, None], [], [None]]


def test_cap_counts_the_rest():
    out = files.parse_bed_regions("".join(f"c\t{i}\t{i + 10}\n" for i in range(50)), cap=10)
    assert len(out["regions"]) == 10 and out["total"] == 50 and out["capped"] is True


def test_route_reads_plain_and_gzip(tmp_path):
    plain = tmp_path / "promoters.bed"
    plain.write_text(BED)
    gz = tmp_path / "enh.bed.gz"
    with gzip.open(gz, "wt") as fh:
        fh.write(BED)
    client = _client()
    a = client.post("/api/plots/bed_regions", json={"path": str(plain)}).json()
    assert a["name"] == "promoters" and len(a["regions"]) == 3
    b = client.post("/api/plots/bed_regions", json={"path": str(gz)}).json()
    assert b["name"] == "enh" and b["regions"][0] == ["chrT", 100, 200, "+", "p1"]
    assert client.post("/api/plots/bed_regions", json={"path": str(tmp_path / "missing.bed")}).status_code == 404


# ---------------------------------------------------------------- region reads (many regions at once)

from types import SimpleNamespace

from services import plots_regions as pr


def test_subsample_is_seeded_equal_and_capped():
    reg = lambda n: [["chrT", 100 * i, 100 * i + 50, "+", f"r{i}"] for i in range(n)]
    sets = [{"id": "a", "regions": reg(30)}, {"id": "b", "regions": reg(12)}]
    a = pr.subsample_regions(sets, "random", 10, 7, 2000)
    assert a == pr.subsample_regions(sets, "random", 10, 7, 2000) and [len(x) for x in a] == [10, 10]
    assert a != pr.subsample_regions(sets, "random", 10, 8, 2000)
    assert [len(x) for x in pr.subsample_regions(sets, "equal", 0, 7, 2000)] == [12, 12]
    assert [len(x) for x in pr.subsample_regions(sets, "all", 0, 7, 20)] == [20, 12]


def test_windows_follow_the_strand_and_round_like_the_client():
    assert pr.region_window(["c", 100, 201, "+"], "centre", "point", 50, 0) == ("c", 101, 201)
    assert pr.region_window(["c", 100, 200, "-"], "start", "point", 50, 0) == ("c", 150, 250)
    assert pr.region_window(["c", 100, 200, "-"], "end", "point", 50, 0) == ("c", 50, 150)
    assert pr.region_window(["c", 100, 200, "+"], "centre", "scale", 50, 30) == ("c", 70, 230)


def test_engine_reads_per_source_with_nucleosomes():
    read = {"intervals": [[0, 20, 20], [20, 30, -10]], "aligned_blocks": [[1000, 1040]],
            "layers": {"nuc": {"intervals": [[0, 20, 20]]}, "tf": {"intervals": [[30, 35, 5]]}, "msp": {"intervals": [[20, 30, 10]]}}}
    assert pr.engine_read(read, 1000, "all_footprints", True) == [1000, 1040, [1000, 1020, 1030, 1035], [], [1000, 1020]]
    assert pr.engine_read(read, 1000, "fire", False)[2] == [1020, 1030]
    assert pr.engine_read({**read, "layers": {}}, 1000, "nuc", False)[2] == [1000, 1020]


def _region_route(monkeypatch, n_reads=8):
    import routers.files as files_router
    from services import analysis_query
    built = []

    def from_request(_state, **k):
        def build(_s, ds, chrom, start, end):
            built.append((ds, chrom, start, end))
            reads = [{"id": f"{ds}{i}", "intervals": [[0, 50, 50], [50, 100, -50]], "aligned_blocks": [[start, end]],
                      "layers": {"nuc": {"intervals": [[0, 50, 50]]}, "tf": {"intervals": []}}} for i in range(n_reads)]
            return SimpleNamespace(reads=reads, start=start)
        return SimpleNamespace(dataset_ids=k.get("dataset_ids") or ["d1"], sample_seed="s", build_working_set=build)

    monkeypatch.setattr(analysis_query.AnalysisReadQuery, "from_request", staticmethod(from_request))
    app = FastAPI()
    app.include_router(files_router.router)
    app.dependency_overrides[files_router.get_state] = lambda: SimpleNamespace()
    return TestClient(app), built


def test_region_reads_route_subsamples_caps_reads_and_answers_per_region(monkeypatch):
    client, built = _region_route(monkeypatch)
    sets = [{"id": "a", "regions": [["chrT", 1000 + i * 100, 1100 + i * 100, "+", ""] for i in range(40)]},
            {"id": "b", "regions": [["chrT", 5000, 5100, "-", ""]]}]
    body = client.post("/api/plots/region_reads", json={"sets": sets, "dataset_ids": ["d1", "d2"], "subsample": "random", "n": 5, "seed": 3,
                                                       "reads_per_region": 3, "occluders": True, "flank_bp": 200}).json()
    assert body["success"] and body["sets"] == [{"id": "a", "total": 40, "read": 5}, {"id": "b", "total": 1, "read": 1}]
    assert len(body["regions"]) == 6
    first = body["regions"][0]
    assert set(first["reads"]) == {"d1", "d2"} and len(first["reads"]["d1"]) == 3
    start, end, src, marks, nuc, name = first["reads"]["d1"][0]
    assert name.startswith("d1")
    # Clipped to the region's window (anchor centre +- 200), relative to its start.
    idx = first["index"]
    assert first["offset"] == 1050 + idx * 100 - 200 and 0 <= start < end <= 400 and nuc == len(src) and marks == []
    # One block (the windows are near each other), read once per dataset.
    assert len(built) == 2


def test_blocks_merge_nearby_windows_and_clip_reads():
    w = [("c", 100, 300), ("c", 5000, 5200), ("c", 900_000, 900_200), ("d", 100, 300)]
    blocks = pr.region_blocks(w, max_gap=20_000)
    assert [(b[0], b[1], b[2], sorted(b[3])) for b in blocks] == [("c", 100, 5200, [0, 1]), ("c", 900_000, 900_200, [2]), ("d", 100, 300, [3])]
    assert pr.clip_read([50, 400, [60, 120, 250, 380], [70, 200, 390], [50, 110]], 100, 300) == [100, 300, [100, 120, 250, 300], [200], [100, 110]]
    assert pr.clip_read([400, 500, [], [], []], 100, 300) is None


def test_region_reads_reads_each_block_once(monkeypatch):
    client, built = _region_route(monkeypatch, n_reads=4)
    sets = [{"id": "a", "regions": [["chrT", 1000 + i * 50, 1050 + i * 50, "+", ""] for i in range(20)]}]
    body = client.post("/api/plots/region_reads", json={"sets": sets, "dataset_ids": ["d1"], "subsample": "all", "reads_per_region": 2, "flank_bp": 100}).json()
    assert len(body["regions"]) == 20 and len(built) == 1
    assert [r["index"] for r in body["regions"]] == list(range(20))


def test_relative_row_shares_nucleosomes_with_the_source():
    from services.plots_regions import relative_row
    assert relative_row([100, 200, [110, 120, 150, 160], [130], [110, 120]], 100) == [0, 100, [10, 20, 50, 60], [30], 2]
    assert relative_row([100, 200, [150, 160], [], [110, 120]], 100) == [0, 100, [50, 60], [], [10, 20]]
    assert relative_row([100, 200, [150, 160], [], []], 100) == [0, 100, [50, 60], [], []]


def test_region_reads_stop_inside_a_block_when_the_client_goes_away(monkeypatch):
    from starlette.requests import Request
    client, built = _region_route(monkeypatch, n_reads=2)
    calls = {"n": 0}

    async def gone(self):  # connected for the block's start and its first chunk, then gone
        calls["n"] += 1
        return calls["n"] > 1

    monkeypatch.setattr(Request, "is_disconnected", gone)
    sets = [{"id": "a", "regions": [["chrT", 1000 + i * 10, 1010 + i * 10, "+", ""] for i in range(25)]}]
    body = client.post("/api/plots/region_reads", json={"sets": sets, "dataset_ids": ["d1"], "subsample": "all", "chunk_windows": 10,
                                                       "reads_per_region": 2, "flank_bp": 50}).json()
    # One block (read once); the first chunk of 10 windows answered, then stopped.
    assert body["success"] is False and body["cancelled"] is True and len(body["regions"]) == 10 and len(built) == 1


def test_region_reads_in_chunks_cover_the_same_regions_once(monkeypatch):
    client, _built = _region_route(monkeypatch, n_reads=2)
    sets = [{"id": "a", "regions": [["chrT", 1000 + i * 100, 1100 + i * 100, "+", ""] for i in range(40)]}]
    base = {"sets": sets, "dataset_ids": ["d1"], "subsample": "random", "n": 25, "seed": 4, "reads_per_region": 1, "flank_bp": 50}
    whole = client.post("/api/plots/region_reads", json=base).json()
    parts = [client.post("/api/plots/region_reads", json=dict(base, job_offset=k, job_limit=10)).json() for k in (0, 10, 20)]
    assert all(p["jobs_total"] == 25 for p in parts) and whole["jobs_total"] == 25
    assert [len(p["regions"]) for p in parts] == [10, 10, 5]
    assert [r["index"] for p in parts for r in p["regions"]] == [r["index"] for r in whole["regions"]]
    # Same windows (the stub's reads depend on the block read, real reads do not).
    assert [r["offset"] for p in parts for r in p["regions"]] == [r["offset"] for r in whole["regions"]]
    # The same reads per region whatever the chunk size (the read name is the last field).
    names = lambda regs: [[row[5] for row in r["reads"]["d1"]] for r in regs]
    for size in (3, 10, 25):
        chunks = [client.post("/api/plots/region_reads", json=dict(base, job_offset=k, job_limit=size)).json() for k in range(0, 25, size)]
        assert names([r for c in chunks for r in c["regions"]]) == names(whole["regions"])



def test_region_sampling_is_stable_across_order_and_other_sets():
    reg = [["chrT", 100 * i, 100 * i + 50, "+", f"r{i}"] for i in range(40)]
    a = pr.subsample_regions([{"id": "a", "regions": reg}], "random", 10, 1, 2000)[0]
    picked = {pr.region_identity(reg[i]) for i in a}
    rev = list(reversed(reg))
    b = pr.subsample_regions([{"id": "a", "regions": rev}, {"id": "z", "regions": reg[:5]}], "random", 10, 1, 2000)[0]
    assert {pr.region_identity(rev[i]) for i in b} == picked
    c = pr.subsample_regions([{"id": "a", "regions": reg}], "random", 10, 2, 2000)[0]
    assert {pr.region_identity(reg[i]) for i in c} != picked


def test_reads_per_region_are_the_same_reads_whatever_the_block():
    rows = [[i * 10, i * 10 + 500, [], [], [], f"read{i}"] for i in range(60)]
    k = pr.sample_reads(rows, 8, 1, "d1")
    # A block holding fewer or more reads around it, in another order: the same reads among those present.
    names = {r[5] for r in k}
    more = pr.sample_reads(list(reversed(rows)) + [[0, 1, [], [], [], f"other{i}"] for i in range(30)], 200, 1, "d1")
    assert names <= {r[5] for r in more}
    assert {r[5] for r in pr.sample_reads(list(reversed(rows)), 8, 1, "d1")} == names
    assert {r[5] for r in pr.sample_reads(rows, 8, 2, "d1")} != names
    assert [r[0] for r in k] == sorted(r[0] for r in k)


def test_footprint_intervals_are_nucleosomes_and_tf_by_start():
    read = {"intervals": [[0, 20, 20]], "layers": {"nuc": {"intervals": [[30, 180, 150]]}, "tf": {"intervals": [[0, 20, 20], [200, 210, 0]]}}}
    # The TF entry of size 0 is not a footprint (as engine_read's layers); absolute, by start.
    assert pr.footprint_intervals(read, 1000) == [1000, 1020, 1030, 1180]


def test_region_reads_send_every_footprint_when_asked(monkeypatch):
    client, _ = _region_route(monkeypatch, n_reads=2)
    sets = [{"id": "a", "regions": [["chrT", 1000, 1100, "+", ""]]}]
    plain = client.post("/api/plots/region_reads", json={"sets": sets, "dataset_ids": ["d1"], "subsample": "all", "flank_bp": 100}).json()
    assert len(plain["regions"][0]["reads"]["d1"][0]) == 6
    body = client.post("/api/plots/region_reads", json={"sets": sets, "dataset_ids": ["d1"], "subsample": "all", "flank_bp": 100, "footprints": True}).json()
    row = body["regions"][0]["reads"]["d1"][0]
    # The last element: footprints relative to the window start (anchor 1050 - 100 = 950; the read's nucleosome 950-1000).
    assert len(row) == 7 and row[6] == [0, 50]


def test_region_reads_send_whole_footprints_with_their_sizes_for_histograms(monkeypatch):
    """Size histograms (whole_footprints): footprints that cross the window's edges come whole, with their size, so
    the client bins the real size and selects by the real midpoint. The block is read with a margin so a footprint
    shorter than the margin is not cut by the working set either."""
    import routers.files as files_router
    from services import analysis_query
    built = []
    # Genomic footprints of one read: [950, 1050) (100 bp, cut by the window [1000, 1100) on the left) and
    # [810, 1110) (300 bp, wider than the window: cut on both sides).
    genomic = [(950, 1050, 100), (810, 1110, 300)]

    def from_request(_state, **k):
        def build(_s, ds, chrom, start, end):
            built.append((start, end))
            # As the loaders do: intervals clipped to the fetched span, the size kept.
            ivs = [[max(a, start) - start, min(b, end) - start, s] for a, b, s in genomic if min(b, end) > max(a, start)]
            reads = [{"id": "r1", "intervals": ivs, "aligned_blocks": [[500, 1600]]}]
            return SimpleNamespace(reads=reads, start=start)
        return SimpleNamespace(dataset_ids=["d1"], sample_seed="s", build_working_set=build)

    monkeypatch.setattr(analysis_query.AnalysisReadQuery, "from_request", staticmethod(from_request))
    app = FastAPI()
    app.include_router(files_router.router)
    app.dependency_overrides[files_router.get_state] = lambda: SimpleNamespace()
    client = TestClient(app)
    sets = [{"id": "a", "regions": [["chrT", 1000, 1100, "+", ""]]}]
    base = {"sets": sets, "dataset_ids": ["d1"], "subsample": "all", "anchor": "centre", "flank_bp": 50, "source": "nuc"}
    body = client.post("/api/plots/region_reads", json=dict(base, whole_footprints=True, footprint_pad_bp=800)).json()
    region = body["regions"][0]
    assert region["offset"] == 1000
    row = region["reads"]["d1"][0]
    start, end, src, _marks, _nuc, name, fps, sizes = row
    assert (start, end, name, fps) == (0, 100, "r1", None)
    assert src == [-50, 50, -190, 110] and sizes == [100, 300]
    assert built[-1][0] <= 1000 - 300 and built[-1][1] >= 1100 + 300
    # With conditioning (footprints) too: the footprints at index 6, the sizes last.
    both = client.post("/api/plots/region_reads", json=dict(base, whole_footprints=True, footprint_pad_bp=800, footprints=True)).json()
    row = both["regions"][0]["reads"]["d1"][0]
    assert len(row) == 8 and isinstance(row[6], list) and row[7] == [100, 300]
    # Profiles (no whole_footprints) are unchanged: clipped to the window, no sizes.
    plain = client.post("/api/plots/region_reads", json=base).json()["regions"][0]["reads"]["d1"][0]
    assert len(plain) == 6 and plain[2] == [0, 50, 0, 100]


def test_a_footprint_across_a_large_deletion_cut_by_the_fetch_is_listed_as_cut(monkeypatch):
    """A 200 bp footprint on a read 100M1900D100M from reference 400 spans [400, 2500). For the window [1700, 1800)
    with a margin of 800 the fetch is [900, 2600): the loader cuts it to [900, 2500), which was sent as whole (its
    midpoint 1700 inside the window; the real one is 1450). It is now listed as cut by the fetch."""
    import routers.files as files_router
    from services import analysis_query
    genomic = [(400, 2500, 200), (1720, 1780, 60)]

    def from_request(_state, **k):
        def build(_s, ds, chrom, start, end):
            ivs = [[max(a, start) - start, min(b, end) - start, s] for a, b, s in genomic if min(b, end) > max(a, start)]
            return SimpleNamespace(reads=[{"id": "r1", "intervals": ivs, "aligned_blocks": [[400, 2600]]}], start=start)
        return SimpleNamespace(dataset_ids=["d1"], sample_seed="s", build_working_set=build)

    monkeypatch.setattr(analysis_query.AnalysisReadQuery, "from_request", staticmethod(from_request))
    app = FastAPI()
    app.include_router(files_router.router)
    app.dependency_overrides[files_router.get_state] = lambda: SimpleNamespace()
    client = TestClient(app)
    body = client.post("/api/plots/region_reads", json={
        "sets": [{"id": "a", "regions": [["chrT", 1700, 1800, "+", ""]]}], "dataset_ids": ["d1"], "subsample": "all",
        "anchor": "centre", "flank_bp": 50, "source": "nuc", "whole_footprints": True, "footprint_pad_bp": 800}).json()
    region = body["regions"][0]
    row = region["reads"]["d1"][0]
    assert region["offset"] == 1700 and len(row) == 9
    src, sizes, cut = row[2], row[7], row[8]
    assert [x + 1700 for x in src] == [900, 2500, 1720, 1780] and sizes == [200, 60] and cut == [0]
    assert pr.cut_by_fetch([0, 50, 10, 20], 0, 100) == []  # a fetch from 0 cuts nothing on the left
