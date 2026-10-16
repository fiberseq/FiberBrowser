"""fibertools-rs / FIRE outputs in FiberBrowser.

Synthetic files in the formats FIRE's track hub publishes (see
tests/fire_fixtures.py for the sources): per-fiber bigBeds opened as a read
dataset, and peaks / coverage / percent-accessible files opened as tracks.
"""
from __future__ import annotations

import shutil

import pytest

import fire_fixtures as ff

pytestmark = pytest.mark.skipif(ff.bed_to_bigbed_tool() is None, reason="bedToBigBed is not installed")

CHROM = ff.CHROM


@pytest.fixture
def hub(tmp_path):
    return ff.write_fire_trackhub(tmp_path / "trackHub")


@pytest.fixture
def hub_with_nuc(tmp_path):
    return ff.write_fire_trackhub(tmp_path / "trackHub", include_nuc=True)


def _reads(paths, start=0, end=10_000, **kwargs):
    from services.compact_read_loader import build_compact_reads_from_bigbed

    kwargs.setdefault("spanning_only", False)
    return {r["id"]: r for r in build_compact_reads_from_bigbed(
        [str(p) for p in paths] if isinstance(paths, list) else str(paths), CHROM, start, end, **kwargs)}


def _abs(ivs, region_start=0):
    return [(s + region_start, e + region_start, size) for s, e, size in ivs]


# ---- detection ---------------------------------------------------------------

def test_fire_bigbed_kinds_come_from_autosql(hub, tmp_path):
    from services.bigbed_detection import detect_fire_bigbed_kind

    assert detect_fire_bigbed_kind(str(hub["fire-fiber-decorators"])) == "decorators"
    assert detect_fire_bigbed_kind(str(hub["fire-fibers"])) == "fibers"
    for key in ("fire-peaks", "fire-wide-peaks", "hap_differences"):
        assert detect_fire_bigbed_kind(str(hub[key])) is None
    # Renamed files are still recognised: the autoSQL decides, not the name.
    renamed = tmp_path / "sampleA.decorated.bb"
    shutil.copy(hub["fire-fiber-decorators"], renamed)
    assert detect_fire_bigbed_kind(str(renamed)) == "decorators"


def test_fire_files_do_not_become_fiberhmm_layers(hub):
    """Their `decoration` table is not a FiberHMM layer: the dataset stays a
    primary read source (no new layer keys reach the layer toggles)."""
    from services.bigbed_detection import detect_overlay_type

    assert detect_overlay_type(str(hub["fire-fiber-decorators"])) == "unknown"
    assert detect_overlay_type(str(hub["fire-fibers"])) == "unknown"


def test_decorator_sibling_and_mark_layers(hub, tmp_path):
    from services.bigbed_detection import fire_bigbed_mark_layers, find_fire_decorator_sibling

    assert find_fire_decorator_sibling(str(hub["fire-fibers"])) == str(hub["fire-fiber-decorators"])
    assert fire_bigbed_mark_layers(str(hub["fire-fiber-decorators"])) == ["m6a", "m5c"]
    assert fire_bigbed_mark_layers(str(hub["fire-fibers"])) == ["m6a", "m5c"]
    assert fire_bigbed_mark_layers(str(hub["fire-peaks"])) == []
    lonely = tmp_path / "alone" / "fire-fibers.bb"
    lonely.parent.mkdir()
    shutil.copy(hub["fire-fibers"], lonely)
    assert find_fire_decorator_sibling(str(lonely)) is None
    assert fire_bigbed_mark_layers(str(lonely)) == []


# ---- per-fiber reads -----------------------------------------------------------

def test_decorators_open_as_fibers_named_by_qname(hub):
    """Before: every decorator row was its own 'read' named m6A / 5mC / LINKER,
    with m6A calls and MSPs drawn as footprints and TFs."""
    reads = _reads(hub["fire-fiber-decorators"])
    assert set(reads) == {f["qname"] for f in hub["fibers"]}
    for read in reads.values():
        assert "tf" not in (read.get("layers") or {})


def test_footprints_are_the_gaps_between_msps_without_nuc_rows(hub):
    """FIRE strips NUC rows from fire-fiber-decorators.bb: nucleosomes are the
    stretches of the fiber between its MSPs."""
    reads = _reads(hub["fire-fiber-decorators"], hide_terminal_gaps=False)
    for fiber in hub["fibers"]:
        read = reads[fiber["qname"]]
        footprints = [(s, e) for s, e, size in _abs(read["intervals"]) if size > 0]
        assert footprints == [(s, s + n) for s, n in fiber["nucs"]]
        gaps = [(s, e) for s, e, size in _abs(read["intervals"]) if size < 0]
        merged = []  # adjacent MSPs (a linker running into a FIRE) are one gap
        for s, n, _fdr in fiber["msps"]:
            if merged and merged[-1][1] == s:
                merged[-1] = (merged[-1][0], s + n)
            else:
                merged.append((s, s + n))
        assert gaps == merged
        assert _abs(read["layers"]["nuc"]["intervals"]) == [(s, s + n, n) for s, n in fiber["nucs"]]


def test_nuc_rows_are_used_when_present(hub_with_nuc):
    reads = _reads(hub_with_nuc["fire-fiber-decorators"])
    for fiber in hub_with_nuc["fibers"]:
        footprints = [(s, e, size) for s, e, size in _abs(reads[fiber["qname"]]["intervals"]) if size > 0]
        assert footprints == [(s, s + n, n) for s, n in fiber["nucs"]]


def test_msp_layer_carries_fire_quality_from_colour(hub):
    reads = _reads(hub["fire-fiber-decorators"])
    fiber = hub["fibers"][0]
    msp = reads[fiber["qname"]]["layers"]["msp"]
    assert msp["quality_names"] == ["aq"]
    got = dict(zip(((s, e) for s, e, _ in _abs(msp["intervals"])), msp["qualities"][0]))
    expected = {(s, s + n): ff.aq_floor_for_msp(fdr) for s, n, fdr in fiber["msps"]}
    assert got == expected
    # The 0.5% FIRE, the 8% FIRE and a linker, against the FIRE display gate (aq >= 230).
    assert got[(2_000, 2_300)] == 253
    assert got[(4_000, 4_200)] == 230
    assert all(aq == 0 for (s, e), aq in got.items() if (s, e) not in {(2_000, 2_300), (4_000, 4_200)})


def test_legacy_fire_named_linkers_keep_linker_quality(tmp_path):
    """Older fibertools named linker-coloured MSP rows 'FIRE': colour decides."""
    hub = ff.write_fire_trackhub(tmp_path / "hub", legacy_fire_names=True)
    reads = _reads(hub["fire-fiber-decorators"])
    fiber = hub["fibers"][0]
    msp = reads[fiber["qname"]]["layers"]["msp"]
    got = dict(zip(((s, e) for s, e, _ in _abs(msp["intervals"])), msp["qualities"][0]))
    assert sorted(aq for aq in got.values() if aq) == [230, 253]
    assert sum(1 for aq in got.values() if aq == 0) == len(fiber["msps"]) - 2


def test_m6a_and_5mc_marks(hub):
    start, end = 1_500, 3_500
    reads = _reads(hub["fire-fiber-decorators"], start=start, end=end)
    for fiber in hub["fibers"]:
        read = reads[fiber["qname"]]
        assert read["methyl_m6a"] == [p - start for p in fiber["m6a"] if start <= p < end]
        assert read["methyl_m5c"] == [p - start for p in fiber["cpg"] if start <= p < end]


def test_window_inside_a_fiber_keeps_true_footprint_sizes(hub):
    """A window after a FIRE MSP: the footprint in view starts at the FIRE's end
    even though the FIRE row lies wholly outside the window."""
    start, end = 2_320, 2_400
    reads = _reads(hub["fire-fiber-decorators"], start=start, end=end)
    read = reads[hub["fibers"][0]["qname"]]
    first = _abs(read["intervals"], start)[0]
    assert first[2] > 0 and first[0] == start  # clipped footprint
    nuc = next((s, s + n) for s, n in hub["fibers"][0]["nucs"] if s <= start < s + n)
    assert first[2] == nuc[1] - nuc[0]


def test_fire_fibers_bb_reads_its_decorators(hub):
    """Before: fire-fibers.bb drew each fiber fully accessible with two 1-bp
    'footprints' (inferred as TFs) at its ends."""
    from_fibers = _reads(hub["fire-fibers"])
    from_decorators = _reads(hub["fire-fiber-decorators"])
    assert from_fibers == from_decorators
    both = _reads([hub["fire-fibers"], hub["fire-fiber-decorators"]])
    assert both == from_decorators


def test_fire_fibers_bb_alone_gives_span_only_reads(hub, tmp_path):
    lonely = tmp_path / "alone" / "fire-fibers.bb"
    lonely.parent.mkdir()
    shutil.copy(hub["fire-fibers"], lonely)
    reads = _reads(lonely)
    assert set(reads) == {f["qname"] for f in hub["fibers"]}
    fiber = hub["fibers"][0]
    assert reads[fiber["qname"]]["intervals"] == [[fiber["start"], fiber["end"], 0]]
    assert "layers" not in reads[fiber["qname"]]


def test_spanning_only_uses_the_fiber_span(hub):
    reads = _reads(hub["fire-fiber-decorators"], start=5_000, end=5_500, spanning_only=True)
    assert set(reads) == {f["qname"] for f in hub["fibers"] if f["start"] <= 5_000 and f["end"] >= 5_500}


def test_layer_request_is_respected(hub):
    reads = _reads(hub["fire-fiber-decorators"], requested_layers=["msp"])
    assert all(set(r.get("layers", {})) <= {"msp"} for r in reads.values())
    reads = _reads(hub["fire-fiber-decorators"], include_layer_qualities=False)
    msp = next(iter(reads.values()))["layers"]["msp"]
    assert msp["qualities"] is None and msp["quality_names"] == []


def test_fire_trackhub_bb_folder_reads_only_fibers(hub):
    """Opening the whole bb/ folder: peaks / wide peaks / hap-differences
    bigBeds have too few columns to be reads; each fiber appears once."""
    reads = _reads(hub["fire-fibers"].parent)
    assert set(reads) == {f["qname"] for f in hub["fibers"]}


def test_dataset_api_serves_fire_fibers(hub, client):
    resp = client.post("/api/datasets/add", json={"path": str(hub["fire-fiber-decorators"]), "label": "fire"})
    assert resp.status_code == 200 and resp.json()["success"], resp.text
    dataset = resp.json()["dataset"]
    try:
        # m6A / 5mC toggles are offered (the frontend requests marks only then).
        assert dataset["available_layers"].get("m6a") and dataset["available_layers"].get("m5c")
        resp = client.get("/api/reads/compact", params={
            "chrom": CHROM, "start": 1_500, "end": 3_500, "dataset_id": dataset["id"],
            "include_layers": "true", "include_methylation": "true", "max_reads": 50,
        })
        assert resp.status_code == 200, resp.text
        data = resp.json()
        ids = {r["id"] for r in data["reads"]}
        assert ids == {f["qname"] for f in hub["fibers"]}
        read = next(r for r in data["reads"] if r["id"] == hub["fibers"][0]["qname"])
        assert (read.get("layers") or {}).get("msp", {}).get("quality_names") == ["aq"]
        assert read.get("methyl_m6a") and read.get("methyl") == read["methyl_m6a"]
    finally:
        client.delete(f"/api/datasets/{dataset['id']}")


# ---- tracks --------------------------------------------------------------------

def _add_track(client, path, **params):
    resp = client.post("/api/add_track", params={"path": str(path), **params})
    assert resp.status_code == 200 and resp.json()["success"], resp.text
    return resp.json()


def _remove_track(client, idx):
    client.delete(f"/api/tracks/{idx}")


@pytest.mark.parametrize("key", ["all.percent.accessible", "hap1.percent.accessible", "all.fire.coverage", "log_FDR"])
def test_bigwigs_open_as_signal_tracks(hub, client, key):
    added = _add_track(client, hub[key])
    try:
        assert added["render_mode"] == "signal"
        resp = client.get(f"/api/tracks/{added['track_index']}", params={
            "chrom": CHROM, "start": 1_900, "end": 2_400, "bins": 50})
        assert resp.status_code == 200, resp.text
        values = resp.json()["values"]
        assert len(values) == 50 and all(v is not None for v in values)
        if key == "all.percent.accessible":  # 80% over 2000-2300, 10% elsewhere
            assert values[25] == pytest.approx(80.0) and values[2] == pytest.approx(10.0)
    finally:
        _remove_track(client, added["track_index"])


def test_fire_peaks_open_as_annotation_track(hub, client):
    added = _add_track(client, hub["fire-peaks"])
    try:
        assert added["render_mode"] == "annotation"
        resp = client.get(f"/api/tracks/{added['track_index']}/annotations", params={
            "chrom": CHROM, "start": 0, "end": 10_000})
        intervals = resp.json()["intervals"]
        assert [(iv["start"], iv["end"], iv["name"], iv.get("score")) for iv in intervals] == [
            (2_000, 2_300, "peak-1", 229), (4_000, 4_200, "peak-2", 330)]
        assert all(iv.get("strand") == "" for iv in intervals)
    finally:
        _remove_track(client, added["track_index"])


@pytest.mark.parametrize("key", ["fire-wide-peaks", "hap_differences"])
def test_bed3_and_bed9_fire_bigbeds_open_as_annotation_tracks(hub, client, key):
    added = _add_track(client, hub[key])
    try:
        resp = client.get(f"/api/tracks/{added['track_index']}/annotations", params={
            "chrom": CHROM, "start": 1_000, "end": 5_000})
        intervals = resp.json()["intervals"]
        assert intervals and all(iv["end"] > iv["start"] for iv in intervals)
    finally:
        _remove_track(client, added["track_index"])


# ---- Review round 8: generic UCSC decorations are annotations, not fibers -----

GENERIC_DECORATION_ROW = [CHROM, 1000, 1100, "promoter", 0, "+", 1000, 1100, "255,0,0,1", 1, "100,", "0,",
                          f"{CHROM}:900-1200:GENE1", "block", "255,0,0,1", "Ignored", "promoter"]


@pytest.fixture(autouse=True)
def _fresh_detection_caches():
    from services import bigbed_detection as bd
    bd._fire_bigbed_kind_cache.clear()
    bd._fire_decorator_sibling_cache.clear()
    yield
    bd._fire_bigbed_kind_cache.clear()
    bd._fire_decorator_sibling_cache.clear()


def test_the_decoration_schema_alone_is_not_a_fire_file(monkeypatch):
    from services import bigbed_detection as bd
    monkeypatch.setattr(bd, "_read_bigbed_autosql", lambda path: ff.DECORATION_AS)
    assert bd.detect_fire_bigbed_kind("ordinary-gene-decorations.bb") is None
    monkeypatch.setattr(bd, "_read_bigbed_autosql", lambda path: ff.BED12_FILTER_AS)
    assert bd.detect_fire_bigbed_kind("ordinary-bed12-keywords.bb") is None


def test_a_generic_decoration_bigbed_opens_as_an_annotation_track(tmp_path):
    from services import bigbed_detection as bd, session_links
    path = ff._write_bigbed(ff.bed_to_bigbed_tool(), [GENERIC_DECORATION_ROW], ff.DECORATION_AS,
                            tmp_path / "promoter-decoration.bb", "bed12+5")
    assert bd.detect_fire_bigbed_kind(str(path)) is None
    assert session_links._bigbed_is_reads(str(path)) is False
    # Even under FIRE's file name.
    named = tmp_path / "fire-fiber-decorators.bb"
    shutil.copy(path, named)
    assert bd.detect_fire_bigbed_kind(str(named)) is None


def test_a_generic_bed12_keywords_file_is_not_fire_fibers(tmp_path):
    from services import bigbed_detection as bd
    rows = [[CHROM, 1000, 5000, "gene1", 0, "+", 1000, 5000, "0,0,0", 3, "100,200,300", "0,1000,3700", "exon"]]
    path = ff._write_bigbed(ff.bed_to_bigbed_tool(), rows, ff.BED12_FILTER_AS, tmp_path / "genes.bb", "bed12+")
    assert bd.detect_fire_bigbed_kind(str(path)) is None


def test_fire_files_are_recognised_by_their_rows_far_from_the_chromosome_start(tmp_path, monkeypatch):
    from services import bigbed_detection as bd, session_links
    monkeypatch.setattr(ff, "CHROM_SIZE", 20_000_000)
    fiber = ff.make_fiber("far/1/ccs", 9_000_000, 9_006_000, fire_msps=[(9_002_000, 9_002_300, 0.5)])
    tool = ff.bed_to_bigbed_tool()
    decorators = ff._write_bigbed(tool, ff.fiber_decorator_rows(fiber), ff.DECORATION_AS,
                                  tmp_path / "far-decorators.bb", "bed12+")
    fibers = ff._write_bigbed(tool, [ff.fiber_bed12_row(fiber)], ff.BED12_FILTER_AS, tmp_path / "far-fibers.bb",
                              "bed12+")
    assert bd.detect_fire_bigbed_kind(str(decorators)) == "decorators"
    assert bd.detect_fire_bigbed_kind(str(fibers)) == "fibers"
    assert session_links._bigbed_is_reads(str(decorators)) is True


# ---- Review round 8: footprint sizes don't depend on the viewport -------------

@pytest.mark.parametrize("with_fibers_file", [False, True])
@pytest.mark.parametrize("view", [(8_000, 8_100), (1_150, 1_300), (12_900, 13_100), (2_000, 12_000)])
def test_a_fire_footprint_across_a_long_gap_keeps_its_size_at_any_zoom(tmp_path, with_fibers_file, view):
    from services.compact_read_loader import build_compact_reads_from_bigbed
    tool = ff.bed_to_bigbed_tool()
    fiber = {"qname": "long-fiber", "start": 0, "end": 20_000, "strand": "+", "hap": "H1",
             "nucs": [], "msps": [(1_000, 200, 0.5), (13_000, 200, 8.0)], "m6a": [1_050, 13_050], "cpg": []}
    paths = [str(ff._write_bigbed(tool, ff.fiber_decorator_rows(fiber, include_nuc=False), ff.DECORATION_AS,
                                  tmp_path / "long-fiber.bb", "bed12+5"))]
    if with_fibers_file:
        paths.append(str(ff._write_bigbed(tool, [ff.fiber_bed12_row(fiber)], ff.BED12_FILTER_AS,
                                          tmp_path / "long-fiber.fibers.bb", "bed12+")))

    def footprints(start, end):
        [read] = build_compact_reads_from_bigbed(paths if with_fibers_file else paths[0], CHROM, start, end,
                                                 spanning_only=False, hide_terminal_gaps=False)
        return [(s + start, e + start, size) for s, e, size in read["intervals"] if size > 0]

    full = footprints(0, 20_000)
    assert [size for _s, _e, size in full] == [1_000, 11_800, 6_800]
    start, end = view
    zoomed = footprints(start, end)
    assert zoomed and all(any(fs <= s and e <= fe and size == fsize for fs, fe, fsize in full)
                          for s, e, size in zoomed), (zoomed, full)


# ---- Review round 13: FIRE files are recognised wherever their data lies --------

@pytest.mark.parametrize("start", [220_000_000, 5_000, 131_000_000])
def test_a_sparse_fire_file_is_recognised_wherever_its_first_fiber_lies(tmp_path, monkeypatch, start):
    from services import bigbed_detection as bd
    monkeypatch.setattr(ff, "CHROM_SIZE", 250_000_000)
    fiber = ff.make_fiber("late/1/ccs", start, start + 20_000, fire_msps=[(start + 2_000, start + 2_300, 0.5)])
    tool = ff.bed_to_bigbed_tool()
    decorators = ff._write_bigbed(tool, ff.fiber_decorator_rows(fiber, include_nuc=False), ff.DECORATION_AS,
                                  tmp_path / "late.bb", "bed12+5")
    fibers = ff._write_bigbed(tool, [ff.fiber_bed12_row(fiber)], ff.BED12_FILTER_AS, tmp_path / "late-fibers.bb",
                              "bed12+")
    assert bd.detect_fire_bigbed_kind(str(decorators)) == "decorators"
    assert bd.detect_fire_bigbed_kind(str(fibers)) == "fibers"


def test_the_first_rows_come_from_the_index_of_a_local_or_remote_file(tmp_path):
    from services import bigbed_detection as bd
    from tests.link_fixtures import LinkServer
    fiber = ff.make_fiber("f/1/ccs", 30_000, 36_000)
    path = ff._write_bigbed(ff.bed_to_bigbed_tool(), ff.fiber_decorator_rows(fiber), ff.DECORATION_AS,
                            tmp_path / "d.bb", "bed12+")
    local = bd._first_bigbed_rows(str(path), limit=3)
    assert len(local) == 3 and all(30_000 <= s < e <= 36_000 for s, e, _rest in local)
    assert local[0][2].split("\t")[0] in {"m6A", "5mC", "NUC", "FIRE", "LINKER"}
    server = LinkServer(str(tmp_path))
    try:
        assert bd._first_bigbed_rows(server.url("d.bb"), limit=3) == local
    finally:
        server.close()


def test_an_unreadable_decoration_file_is_inconclusive_not_remembered(monkeypatch):
    from services import bigbed_detection as bd
    monkeypatch.setattr(bd, "_read_bigbed_autosql", lambda path: ff.DECORATION_AS)
    assert bd.detect_fire_bigbed_kind("missing-decorators.bb") is None
    assert "missing-decorators.bb" not in bd._fire_bigbed_kind_cache


# ---- Review round 17: the row probe's decompression is bounded ---------------

def _replace_first_block(path, payload, declared):
    import struct
    with open(path, "r+b") as handle:
        header = handle.read(64)
        node = struct.unpack("<Q", header[24:32])[0] + 48
        for _ in range(32):
            handle.seek(node)
            leaf, _reserved, _count = struct.unpack("<BBH", handle.read(4))
            if leaf:
                break
            handle.seek(node + 20)
            node = struct.unpack("<Q", handle.read(8))[0]
        handle.seek(0, 2)
        offset = handle.tell()
        handle.write(payload)
        handle.seek(node + 20)
        handle.write(struct.pack("<QQ", offset, len(payload)))
        handle.seek(52)
        handle.write(struct.pack("<I", declared))


@pytest.mark.parametrize("declared", [1024, 64 << 20])
def test_a_first_block_that_inflates_past_its_bound_is_inconclusive(tmp_path, declared):
    import struct
    import tracemalloc
    import zlib
    from services import bigbed_detection as bd
    fiber = ff.make_fiber("f/1/ccs", 30_000, 36_000)
    path = ff._write_bigbed(ff.bed_to_bigbed_tool(), ff.fiber_decorator_rows(fiber), ff.DECORATION_AS,
                            tmp_path / "crafted.bb", "bed12+")
    start, end, rest = bd._first_bigbed_rows(str(path))[0]
    record = struct.pack("<III", 0, start, end) + rest.encode() + b"\0"
    raw = record * (8 * 1024 * 1024 // len(record))
    _replace_first_block(path, zlib.compress(raw), declared)
    tracemalloc.start()
    rows = bd._first_bigbed_rows(str(path))
    kind = bd.detect_fire_bigbed_kind(str(path))
    _current, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    assert rows == [] and kind is None  # inconclusive; pyBigWig is not tried on that block either
    assert peak < 1 << 20  # never the 8 MB the block inflates to


def test_an_honest_first_block_still_gives_its_rows(tmp_path):
    from services import bigbed_detection as bd
    fiber = ff.make_fiber("f/1/ccs", 30_000, 36_000)
    path = ff._write_bigbed(ff.bed_to_bigbed_tool(), ff.fiber_decorator_rows(fiber), ff.DECORATION_AS,
                            tmp_path / "honest.bb", "bed12+")
    assert len(bd._first_bigbed_rows(str(path), limit=3)) == 3
    assert bd.detect_fire_bigbed_kind(str(path)) == "decorators"
