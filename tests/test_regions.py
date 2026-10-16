"""Regions panel backend: amplicons found in a dataset's reads, nearest-gene labels,
bounded scans, and the user's region catalog kept per reference (fb-r4-regions)."""
from __future__ import annotations

import os
import shutil
import time
from pathlib import Path

import pandas as pd
import pysam
import pytest

from conftest import auth_headers

# A dm6 DddB amplicon BAM (integration tier only): FIBERBROWSER_TEST_DM6_BAM.
_DM6_BAM = os.environ.get("FIBERBROWSER_TEST_DM6_BAM", "").strip()
DM6_AMPLICONS = Path(_DM6_BAM) if _DM6_BAM else Path("/nonexistent")


def _fasta(tmp_path: Path, name: str, contigs: dict) -> Path:
    folder = tmp_path / name.split(".")[0]
    folder.mkdir(exist_ok=True)
    path = folder / name
    with open(path, "w") as fh:
        for contig, size in contigs.items():
            fh.write(f">{contig}\n")
            seq = "ACGT" * (size // 4) + "A" * (size % 4)
            for i in range(0, size, 60):
                fh.write(seq[i:i + 60] + "\n")
    pysam.faidx(str(path))
    return path


def _bam(tmp_path: Path, name: str, contigs: dict, reads: list) -> Path:
    """A sorted, indexed BAM; ``reads`` = [(contig, start, length)]."""
    path = tmp_path / name
    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": c, "LN": n} for c, n in contigs.items()]}
    names = list(contigs)
    with pysam.AlignmentFile(str(path), "wb", header=header) as out:
        for i, (contig, start, length) in enumerate(sorted(reads, key=lambda r: (names.index(r[0]), r[1]))):
            seg = pysam.AlignedSegment(out.header)
            seg.query_name = f"r{i}"
            seg.reference_id = names.index(contig)
            seg.reference_start = start
            seg.cigartuples = [(0, length)]
            seg.query_sequence = "A" * length
            seg.mapping_quality = 60
            out.write(seg)
    pysam.index(str(path))
    return path


def _amplicon_reads() -> list:
    """Three amplicons on chr2L (reads share their ends, a few bp of jitter) and two strays."""
    reads = []
    reads += [("chr2L", 1000 + (i % 5), 650 - (i % 7)) for i in range(100)]          # A: 1000-1650
    reads += [("chr2L", 10_000 + (i % 3), 3000 - (i % 11)) for i in range(60)]       # B: 10000-13000
    reads += [("chr2L", 30_000 + (i % 4), 1500) for i in range(20)]                  # C: 30000-31500
    reads += [("chr2L", 20_000, 300), ("chr2L", 45_000, 200)]                         # strays
    return reads


def _genes() -> dict:
    rows = [
        ("chr2L", 900, 2000, "+", "geneX", "tx1"),
        ("chr2L", 950, 1800, "+", "geneX", "tx1b"),
        ("chr2L", 13_500, 15_000, "-", "geneY", "tx2"),
        ("chr2L", 25_000, 28_000, "+", "geneZ", "tx3"),
        ("chr2L", 33_000, 36_000, "+", "geneW", "tx4"),
    ]
    tx = pd.DataFrame(rows, columns=["chrom", "start", "end", "strand", "gene_name", "transcript_id"])
    return {"transcripts": tx, "exons": pd.DataFrame(columns=["transcript_id", "start", "end"])}


@pytest.fixture
def workspace(standalone_app):
    import server as srv
    from starlette.testclient import TestClient
    from plugins import init_context
    from state import runtime_state
    from state.browser_state import BrowserState
    from state.runtime_state import set_browser_state
    import services.region_detect as rd

    previous, previous_runtime = srv.state, runtime_state._state
    state = BrowserState(None, None, None, None)
    srv.state = state
    set_browser_state(state)
    init_context(state)
    rd._CACHE.clear()
    try:
        yield TestClient(standalone_app, headers=auth_headers()), state
    finally:
        srv.state = previous
        set_browser_state(previous_runtime)
        init_context(previous)
        rd._CACHE.clear()


def _load(state, tmp_path, reads=None, genes=True):
    fasta = _fasta(tmp_path, "dm6.fa", {"chr2L": 50_000, "chr3R": 20_000})
    bam = _bam(tmp_path, "amp.bam", {"chr2L": 50_000, "chr3R": 20_000}, reads if reads is not None else _amplicon_reads())
    assert state._load_fasta(str(fasta)) is None
    state.add_dataset("amp", str(bam), "amp")
    # (A FASTA named dm6.fa picks up a cached dm6 annotation: replace it.)
    state.gtf_data = _genes() if genes else None
    return bam


def test_amplicons_are_one_region_each_with_read_counts_and_gene_labels(workspace, tmp_path):
    client, state = workspace
    _load(state, tmp_path)
    body = client.get("/api/reads/regions", params={"dataset_id": "amp"}).json()
    assert body["success"] is True, body
    assert body["kind"] == "amplicon" and body["amplicon_like"] is True
    assert body["genome"] == "dm6"
    assert body["scope"] == "dataset" and body["scanned_reads"] == 182
    regions = body["regions"]
    # One entry per amplicon (not one per window), in genome order; strays are not listed.
    assert [(r["chrom"], r["reads"]) for r in regions] == [("chr2L", 100), ("chr2L", 60), ("chr2L", 20)]
    a, b, c = regions
    assert 995 <= a["start"] <= 1005 and 1640 <= a["end"] <= 1655
    assert 9995 <= b["start"] <= 10_005 and 12_985 <= b["end"] <= 13_005
    assert body["small_clusters"] == 2
    # Nearest gene: overlapping, near one, between two.
    assert a["label"] == "geneX" and a["gene"] == "geneX"
    assert b["label"].startswith("near geneY (") and b["gene"] == "geneY"
    assert c["label"] == "between geneZ and geneW"
    assert "geneZ" in c["detail"] and "geneW" in c["detail"]
    assert isinstance(body["elapsed_ms"], float) and body["fingerprint"]


def test_without_an_annotation_regions_are_named_by_locus(workspace, tmp_path):
    client, state = workspace
    _load(state, tmp_path, genes=False)
    regions = client.get("/api/reads/regions", params={"dataset_id": "amp"}).json()["regions"]
    assert regions[0]["label"].startswith("chr2L:") and regions[0]["gene"] is None


def test_a_large_dataset_is_refused_whole_but_found_in_a_view(workspace, tmp_path, monkeypatch):
    """Whole-genome data: no dataset-wide (or chromosome-wide) scan; a view is fine."""
    import services.region_detect as rd
    client, state = workspace
    _load(state, tmp_path)
    monkeypatch.setattr(rd, "AUTO_MAX_READS", 100)
    monkeypatch.setattr(rd, "CHROM_MAX_READS", 100)
    whole = client.get("/api/reads/regions", params={"dataset_id": "amp"}).json()
    assert whole["success"] is False and whole["refused"] is True
    assert "182 reads" in whole["reason"] and whole["regions"] == []
    chrom = client.get("/api/reads/regions", params={"dataset_id": "amp", "chrom": "chr2L"}).json()
    assert chrom["refused"] is True and "chr2L has 182 reads" in chrom["reason"]
    view = client.get("/api/reads/regions", params={"dataset_id": "amp", "chrom": "chr2L", "start": 0, "end": 20_000}).json()
    assert view["success"] is True and view["scope"] == "view" and view["kind"] == "top"
    assert view["regions"], view
    # The deepest stretch first: amplicon A (100 reads deep).
    top = view["regions"][0]
    assert top["start"] < 1650 and top["end"] > 1000 and top["reads"] == 100
    assert top["label"] == "geneX"


def test_chromosome_regions_are_trimmed_to_their_reads(workspace, tmp_path):
    """On a 5 Mb chromosome a profile bin is 2.5 kb: a 650 bp amplicon is still its own extent,
    and a lone read is not a region (no reference loaded: the BAM's own contigs)."""
    client, state = workspace
    reads = [("chr2L", 1_001_000 + (i % 5), 650) for i in range(60)] + [("chr2L", 3_000_000, 400)]
    bam = _bam(tmp_path, "wide.bam", {"chr2L": 5_000_000}, reads)
    state.add_dataset("wide", str(bam), "wide")
    body = client.get("/api/reads/regions", params={"dataset_id": "wide", "chrom": "chr2L"}).json()
    assert body["success"] is True and body["kind"] == "top" and body["genome"] == "none", body
    assert len(body["regions"]) == 1, body["regions"]
    top = body["regions"][0]
    assert top["reads"] == 60
    assert 1_000_950 <= top["start"] <= 1_001_000 and 1_001_650 <= top["end"] <= 1_001_700, top


def test_a_large_dataset_that_is_not_amplicons_is_not_read_whole(workspace, tmp_path, monkeypatch):
    """Above PRECHECK_ABOVE reads, a first sample decides: reads tiling the genome
    (whole-genome data) are not scanned whole on opening; amplicons are."""
    import services.region_detect as rd
    client, state = workspace
    monkeypatch.setattr(rd, "PRECHECK_ABOVE", 100)
    monkeypatch.setattr(rd, "PRECHECK_READS", 50)
    tiling = _bam(tmp_path, "wgs.bam", {"chr2L": 50_000}, [("chr2L", 37 * i, 500) for i in range(1300)])
    state.add_dataset("wgs", str(tiling), "wgs")
    body = client.get("/api/reads/regions", params={"dataset_id": "wgs"}).json()
    # Not amplicons (the first sample), and its index says the reads cover the whole genome: refused, said why.
    assert body["success"] is False and body["refused"] is True and body["regions"] == [], body
    assert body["status"] == "whole-genome" and body["reads"] == 1300 and "1,300 reads" in body["reason"]
    _load(state, tmp_path)  # the amplicon BAM (182 reads)
    amp = client.get("/api/reads/regions", params={"dataset_id": "amp"}).json()
    assert amp["kind"] == "amplicon" and len(amp["regions"]) == 3 and "precheck" not in amp


def test_a_scan_stops_at_its_read_cap(workspace, tmp_path, monkeypatch):
    import services.region_detect as rd
    client, state = workspace
    _load(state, tmp_path)
    monkeypatch.setattr(rd, "SCAN_READ_CAP", 50)
    body = client.get("/api/reads/regions", params={"dataset_id": "amp"}).json()
    assert body["success"] is True and body["partial"] is True and body["scanned_reads"] == 50
    assert not rd._CACHE  # a partial answer is not kept


def test_detection_is_cached_and_fingerprint_follows_the_data(workspace, tmp_path):
    from services.region_detect import dataset_fingerprint
    client, state = workspace
    bam = _load(state, tmp_path)
    first = client.get("/api/reads/regions", params={"dataset_id": "amp"}).json()
    again = client.get("/api/reads/regions", params={"dataset_id": "amp"}).json()
    assert again.get("cached") is True and again["regions"] == first["regions"]
    # A copy of the BAM elsewhere is the same data; another BAM is not.
    copy_dir = tmp_path / "moved"
    copy_dir.mkdir()
    shutil.copy(bam, copy_dir / "renamed.bam")
    shutil.copy(str(bam) + ".bai", copy_dir / "renamed.bam.bai")
    state.add_dataset("copy", str(copy_dir / "renamed.bam"), "copy")
    assert dataset_fingerprint(state.get_dataset("copy")) == first["fingerprint"]
    other = _bam(tmp_path, "other.bam", {"chr2L": 50_000}, [("chr2L", 100, 500)] * 5)
    state.add_dataset("other", str(other), "other")
    assert dataset_fingerprint(state.get_dataset("other")) != first["fingerprint"]


def test_a_dataset_on_another_assembly_is_not_scanned_on_the_loaded_one(workspace, tmp_path):
    """Audit M16: a dm6 BAM opened under hg38 shares chrX by name; its "amplicons" were
    filed in the hg38 catalog, named after hg38 genes. A dataset the genome check says
    doesn't fit the loaded reference is refused (before reading its reads)."""
    client, state = workspace
    fasta = _fasta(tmp_path, "hg38.fa", {"chrX": 60_000, "chr19": 50_000})
    # Same name, another length: another assembly's chrX.
    bam = _bam(tmp_path, "fly.bam", {"chrX": 40_000, "chr2L": 50_000},
               [("chrX", 1000 + (i % 5), 650) for i in range(50)])
    assert state._load_fasta(str(fasta)) is None
    state.add_dataset("fly", str(bam), "fly")
    state.gtf_data = _genes()
    body = client.get("/api/reads/regions", params={"dataset_id": "fly"}).json()
    assert body["success"] is False and body["refused"] is True and body["mismatch"] is True, body
    assert body["regions"] == [] and "own reference" in body["reason"]
    # The fingerprint still comes back (the browser keys the dataset's amplicons by it).
    assert body["fingerprint"]


def test_region_label_endpoint(workspace, tmp_path):
    client, state = workspace
    _load(state, tmp_path)
    body = client.get("/api/regions/label", params={"chrom": "chr2L", "start": 13_000, "end": 13_200}).json()
    assert body["label"] == "near geneY (300 bp)" and body["genome"] == "dm6"


def test_catalog_round_trip_per_reference(workspace):
    """Saved regions are kept per reference, only known fields, and Reset forgets them."""
    client, _state = workspace
    catalog = {
        "categories": [{"id": "c1", "name": "Enhancers", "collapsed": True, "bogus": 1},
                       {"id": "c2", "name": "Amplicons · amp", "source": "auto", "fingerprint": "abc"}],
        "entries": [
            {"id": "e1", "chrom": "chr2L", "start": 100, "end": 200, "label": "eve stripe 2", "category": "c1",
             "source": "bed", "score": 5.5, "strand": "+", "evil": "<script>"},
            {"id": "e2", "chrom": "chr2L", "start": 1000, "end": 1650, "label": "my amplicon", "autoLabel": "geneX",
             "category": "c2", "source": "auto", "reads": 100},
            {"id": "bad", "chrom": "chr2L", "start": 500, "end": 400, "label": "end before start", "category": "c1"},
            {"id": "e1", "chrom": "chr2L", "start": 1, "end": 2, "label": "duplicate id", "category": "c1"},
        ],
    }
    resp = client.put("/api/regions/catalog", json={"genome": "dm6", "catalog": catalog})
    assert resp.status_code == 200 and resp.json() == {"success": True, "revision": 1, "categories": 2, "entries": 2}
    got = client.get("/api/regions/catalog", params={"genome": "dm6"}).json()["catalog"]
    assert got["genome"] == "dm6"
    assert [c["name"] for c in got["categories"]] == ["Enhancers", "Amplicons · amp"]
    assert "bogus" not in got["categories"][0] and got["categories"][0]["collapsed"] is True
    assert [e["label"] for e in got["entries"]] == ["eve stripe 2", "my amplicon"]
    assert "evil" not in got["entries"][0] and got["entries"][0]["score"] == 5.5
    # Another reference has its own (empty) catalog.
    assert client.get("/api/regions/catalog", params={"genome": "hg38"}).json()["catalog"]["entries"] == []
    # The file is in the configured folder, never ~/.fiberhmm.
    from services.region_catalog import catalog_path
    path = catalog_path("dm6")
    assert path.exists() and str(path).startswith(os.environ["FIBERBROWSER_REGION_CATALOG_DIR"])
    # Reset (a new revision: a window still holding the old regions can't write them back unnoticed).
    reset = client.delete("/api/regions/catalog", params={"genome": "dm6"}).json()
    assert reset["deleted"] is True and reset["revision"] == 2
    assert client.get("/api/regions/catalog", params={"genome": "dm6"}).json()["catalog"]["entries"] == []


def test_catalog_writes_from_two_windows_conflict_instead_of_overwriting(workspace):
    """Each write says which revision it started from; a write from an older one is refused
    with the current catalog (the browser then reapplies its own changes on top)."""
    client, _state = workspace
    one = {"categories": [{"id": "c", "name": "A"}], "entries": []}
    first = client.put("/api/regions/catalog", json={"genome": "mm10", "catalog": one, "base_revision": 0}).json()
    assert first["revision"] == 1
    # A second window, still at revision 0, is refused and shown what is saved now.
    two = {"categories": [{"id": "d", "name": "B"}], "entries": []}
    stale = client.put("/api/regions/catalog", json={"genome": "mm10", "catalog": two, "base_revision": 0})
    assert stale.status_code == 409
    assert [c["name"] for c in stale.json()["catalog"]["categories"]] == ["A"] and stale.json()["catalog"]["revision"] == 1
    ok = client.put("/api/regions/catalog", json={"genome": "mm10", "catalog": {"categories": one["categories"] + two["categories"], "entries": []}, "base_revision": 1})
    assert ok.status_code == 200 and ok.json()["revision"] == 2
    assert [c["name"] for c in client.get("/api/regions/catalog", params={"genome": "mm10"}).json()["catalog"]["categories"]] == ["A", "B"]


def _two_fastas(tmp_path):
    """Two unrelated FASTAs with the same file name (Codex #5): A/reference.fa and B/reference.fa."""
    paths = []
    for folder, contigs in (("A", {"chr1": 5_000, "chr2": 4_000}), ("B", {"contigX": 9_000})):
        (tmp_path / folder).mkdir()
        made = _fasta(tmp_path / folder, "reference.fa", contigs)
        paths.append(made)
    return paths


def test_two_fastas_of_one_name_keep_separate_catalogs(workspace, tmp_path, monkeypatch):
    """Codex #5: the catalog key of a FASTA reference is its file name, so two unrelated
    reference.fa files shared one catalog. Its file is now also keyed by the contigs."""
    client, state = workspace
    monkeypatch.setenv("FIBERBROWSER_REGION_CATALOG_DIR", str(tmp_path / "regions"))
    a, b = _two_fastas(tmp_path)
    regions = {"categories": [{"id": "c", "name": "A regions"}],
               "entries": [{"id": "e", "chrom": "chr1", "start": 10, "end": 200, "label": "a1", "category": "c"}]}
    assert state._load_fasta(str(a)) is None
    assert client.put("/api/regions/catalog", json={"genome": "reference.fa", "catalog": regions}).status_code == 200
    assert state._load_fasta(str(b)) is None
    got = client.get("/api/regions/catalog", params={"genome": "reference.fa"}).json()["catalog"]
    assert got["entries"] == [] and got["revision"] == 0
    assert state._load_fasta(str(a)) is None
    got = client.get("/api/regions/catalog", params={"genome": "reference.fa"}).json()["catalog"]
    assert [e["label"] for e in got["entries"]] == ["a1"] and got["genome"] == "reference.fa"


def test_a_save_goes_to_the_catalog_it_was_read_from(workspace, tmp_path, monkeypatch):
    """Codex review: a save that lands after another FASTA of the same name was loaded
    (or the reference was closed) went to the reference loaded then. GET answers the
    catalog's identity; a PUT with it writes that catalog whatever is loaded now."""
    client, state = workspace
    monkeypatch.setenv("FIBERBROWSER_REGION_CATALOG_DIR", str(tmp_path / "regions"))
    a, b = _two_fastas(tmp_path)
    assert state._load_fasta(str(a)) is None
    read = client.get("/api/regions/catalog", params={"genome": "reference.fa"}).json()
    identity = read["identity"]
    assert identity and len(identity) == 16
    assert state._load_fasta(str(b)) is None  # B replaces A before the save lands
    edit = {"categories": [{"id": "c", "name": "A's"}], "entries": []}
    put = client.put("/api/regions/catalog", json={"genome": "reference.fa", "catalog": edit, "base_revision": 0, "identity": identity})
    assert put.status_code == 200
    assert client.get("/api/regions/catalog", params={"genome": "reference.fa"}).json()["catalog"]["categories"] == []
    assert state._load_fasta(str(a)) is None
    assert [c["name"] for c in client.get("/api/regions/catalog", params={"genome": "reference.fa"}).json()["catalog"]["categories"]] == ["A's"]
    # A registry genome's identity is "" (its bare key); a malformed one is the bare key too.
    assert client.get("/api/regions/catalog", params={"genome": "hg19"}).json()["identity"] == ""
    assert client.put("/api/regions/catalog", json={"genome": "x", "catalog": edit, "identity": "../../etc"}).status_code == 200
    from services.region_catalog import catalog_path
    assert catalog_path("x").exists()


def test_a_catalog_saved_under_a_bare_fasta_name_is_taken_over_once(workspace, tmp_path, monkeypatch):
    """Regions saved before the contig key are kept: the first reference of that name
    they fit takes them over; another FASTA of that name starts empty."""
    client, state = workspace
    monkeypatch.setenv("FIBERBROWSER_REGION_CATALOG_DIR", str(tmp_path / "regions"))
    from services.region_catalog import catalog_path, write_catalog
    a, b = _two_fastas(tmp_path)
    write_catalog("reference.fa", {"categories": [{"id": "c", "name": "Old"}],
                                   "entries": [{"id": "e", "chrom": "chr2", "start": 0, "end": 3_000, "label": "old", "category": "c"}]})
    legacy = catalog_path("reference.fa")
    assert legacy.exists()
    # B's contigs don't hold chr2: not B's.
    assert state._load_fasta(str(b)) is None
    assert client.get("/api/regions/catalog", params={"genome": "reference.fa"}).json()["catalog"]["entries"] == []
    assert legacy.exists()
    assert state._load_fasta(str(a)) is None
    got = client.get("/api/regions/catalog", params={"genome": "reference.fa"}).json()["catalog"]
    assert [e["label"] for e in got["entries"]] == ["old"] and got["revision"] == 1
    assert not legacy.exists()


def test_a_saved_catalog_of_plasmid_map_regions_is_taken_over_too(workspace, tmp_path, monkeypatch):
    """A plasmid map's regions are kept with the genome's: a catalog of only those still
    belongs to the FASTA it was saved under (the map is loaded beside it)."""
    client, state = workspace
    monkeypatch.setenv("FIBERBROWSER_REGION_CATALOG_DIR", str(tmp_path / "regions"))
    from services.region_catalog import write_catalog
    a, _b = _two_fastas(tmp_path)
    write_catalog("reference.fa", {"categories": [{"id": "c", "name": "Plasmid"}],
                                   "entries": [{"id": "e", "chrom": "pN1", "start": 0, "end": 300, "label": "ori", "category": "c"}]})
    assert state._load_fasta(str(a)) is None
    state.plasmid_sequences = {"pN1": "A" * 4_000}
    got = client.get("/api/regions/catalog", params={"genome": "reference.fa"}).json()["catalog"]
    assert [e["label"] for e in got["entries"]] == ["ori"]


def test_an_oversized_catalog_is_refused_not_cut_short(workspace, tmp_path, monkeypatch):
    """Codex #26: over the limits the backend dropped regions and answered success."""
    client, _state = workspace
    monkeypatch.setenv("FIBERBROWSER_REGION_CATALOG_DIR", str(tmp_path / "regions"))
    import services.region_catalog as rc
    monkeypatch.setattr(rc, "MAX_ENTRIES", 2)
    small = {"categories": [{"id": "c", "name": "C"}],
             "entries": [{"id": f"e{i}", "chrom": "chr1", "start": i, "end": i + 10, "label": str(i), "category": "c"} for i in range(2)]}
    assert client.put("/api/regions/catalog", json={"genome": "mm39", "catalog": small}).status_code == 200
    big = {**small, "entries": small["entries"] + [{"id": "e9", "chrom": "chr1", "start": 5, "end": 9, "label": "9", "category": "c"}]}
    resp = client.put("/api/regions/catalog", json={"genome": "mm39", "catalog": big, "base_revision": 1})
    assert resp.status_code == 413 and resp.json()["too_large"] is True and "3 regions" in resp.json()["detail"]
    got = client.get("/api/regions/catalog", params={"genome": "mm39"}).json()["catalog"]
    assert len(got["entries"]) == 2 and got["revision"] == 1


def test_lab_members_have_their_own_catalogs(workspace, tmp_path, monkeypatch):
    """Codex #27: on a lab server every member read and wrote the server user's catalogs."""
    monkeypatch.setenv("FIBERBROWSER_REGION_CATALOG_DIR", str(tmp_path / "regions"))
    from services import runtime
    from services.lab.users import LabUser
    from services.region_catalog import catalog_path, read_catalog, write_catalog
    monkeypatch.setattr(runtime, "_lab_mode", True)
    one = {"categories": [{"id": "c", "name": "Alice's"}], "entries": []}
    with runtime.lab_request_context(user=LabUser(name="alice")):
        write_catalog("hg38", one)
        alice_path = catalog_path("hg38")
        assert [c["name"] for c in read_catalog("hg38")["categories"]] == ["Alice's"]
    with runtime.lab_request_context(user=LabUser(name="bob")):
        assert read_catalog("hg38")["categories"] == []
        assert catalog_path("hg38") != alice_path
    # The server's own user (no member) keeps the top folder.
    assert read_catalog("hg38")["categories"] == []
    assert alice_path.parent.name == "alice" and alice_path.parent.parent.name == "members"


def test_catalog_file_names_are_safe():
    from services.region_catalog import catalog_path
    weird = catalog_path("../../etc/passwd")
    assert weird.parent == catalog_path("dm6").parent and ".." not in weird.name
    assert catalog_path("my genome.fa") != catalog_path("my_genome.fa")
    # Long names that share their first 80 characters are still two files.
    long = "x" * 80
    assert catalog_path(long + "a") != catalog_path(long + "b")


def test_a_scan_counts_every_record_toward_its_limits(workspace, tmp_path, monkeypatch):
    """Secondary alignments are not kept but still count: a contig of them is not read to its end."""
    import services.region_detect as rd
    client, state = workspace
    path = tmp_path / "secondary.bam"
    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": "chr2L", "LN": 50_000}]}
    with pysam.AlignmentFile(str(path), "wb", header=header) as out:
        for i in range(3000):
            seg = pysam.AlignedSegment(out.header)
            seg.query_name = f"s{i}"
            seg.reference_id = 0
            seg.reference_start = 100 + i
            seg.cigartuples = [(0, 100)]
            seg.query_sequence = "A" * 100
            seg.flag = 256
            out.write(seg)
    pysam.index(str(path))
    state.add_dataset("sec", str(path), "sec")
    monkeypatch.setattr(rd, "SCAN_RECORD_CAP", 500)
    body = client.get("/api/reads/regions", params={"dataset_id": "sec"}).json()
    assert body["success"] is True and body["partial"] is True and body["scanned_reads"] == 0, body


def test_later_chromosomes_are_not_crowded_out_of_top_regions(workspace, tmp_path):
    """The deepest region wins even when an earlier chromosome has many shallow ones."""
    client, state = workspace
    reads = [("chr1", 1_000 * k, 300) for k in range(1, 40) for _ in range(3)] + [("chr2", 5_000, 300)] * 100
    bam = _bam(tmp_path, "two.bam", {"chr1": 60_000, "chr2": 60_000}, reads)
    state.add_dataset("two", str(bam), "two")
    body = client.get("/api/reads/regions", params={"dataset_id": "two", "chrom": "chr2"}).json()
    assert body["regions"][0]["reads"] == 100
    from services.region_detect import _top_regions
    intervals = {"chr1": sorted((s, s + 300) for c, s, _l in reads if c == "chr1"),
                 "chr2": sorted((s, s + 300) for c, s, _l in reads if c == "chr2")}
    top = _top_regions(intervals, {}, {}, 1)
    assert top[0][0] == "chr2" and top[0][3] == 100


@pytest.mark.integration
@pytest.mark.skipif(not DM6_AMPLICONS.exists(), reason="set FIBERBROWSER_TEST_DM6_BAM to a dm6 DddB amplicon BAM")
def test_dm6_amplicons_are_found_quickly(workspace):
    """DddB amplicons (dm6): three amplicons, found in well under a second."""
    client, state = workspace
    state.add_dataset("amplicons", str(DM6_AMPLICONS), "amplicons")
    t0 = time.monotonic()
    body = client.get("/api/reads/regions", params={"dataset_id": "amplicons"}).json()
    elapsed = time.monotonic() - t0
    assert body["success"] is True and body["kind"] == "amplicon", body
    assert [r["reads"] for r in body["regions"]] == [5030, 2844, 323]
    assert elapsed < 2.0
    print(f"amplicons: {len(body['regions'])} amplicons from {body['scanned_reads']} reads in {body['elapsed_ms']} ms (request {elapsed * 1000:.0f} ms)")


def _long_reads(contig: str, lo: int, hi: int, length: int, step: int) -> list:
    return [(contig, x, length) for x in range(lo, hi - length, step)]


def test_a_targeted_dataset_is_found_from_its_index(workspace, tmp_path, monkeypatch):
    """Two loci of long reads on a large chromosome (a capture like the numb loop anchors), above
    PRECHECK_ABOVE: the regions come from the .bai (dense stretches refined to half their plateau),
    not from reading every read; they are labelled and stated as index estimates."""
    import services.region_detect as rd
    client, state = workspace
    monkeypatch.setattr(rd, "PRECHECK_ABOVE", 100)
    reads = (_long_reads("chr2L", 1_300_000, 1_470_000, 8_000, 40)
             + _long_reads("chr2L", 2_400_000, 2_550_000, 8_000, 40)
             + [("chr2L", 200_000, 8_000), ("chr2L", 2_900_000, 8_000)])  # strays
    bam = _bam(tmp_path, "capture.bam", {"chr2L": 23_000_000, "chr3R": 1_000_000}, reads)
    state.add_dataset("cap", str(bam), "cap")

    def no_full_scan(*a, **k):
        if k.get("read_cap") != rd.PRECHECK_READS:
            raise AssertionError("read every read")
        return real_scan(*a, **k)
    real_scan = rd._scan
    monkeypatch.setattr(rd, "_scan", no_full_scan)
    body = client.get("/api/reads/regions", params={"dataset_id": "cap"}).json()
    assert body["success"] is True and body["kind"] == "targeted" and body["method"] == "index", body
    assert body["status"] == "scanned" and "index" in body["note"]
    spans = [(r["chrom"], r["start"], r["end"]) for r in body["regions"]]
    assert len(spans) == 2, spans
    (c1, s1, e1), (c2, s2, e2) = spans
    assert c1 == c2 == "chr2L"
    assert abs(s1 - 1_300_000) < 12_000 and abs(e1 - 1_470_000) < 12_000, spans
    assert abs(s2 - 2_400_000) < 12_000 and abs(e2 - 2_550_000) < 12_000, spans
    assert all(r["reads"] > 100 for r in body["regions"])


def test_whole_genome_data_is_skipped_unless_scanned_anyway(workspace, tmp_path, monkeypatch):
    import services.region_detect as rd
    client, state = workspace
    monkeypatch.setattr(rd, "PRECHECK_ABOVE", 100)
    monkeypatch.setattr(rd, "PRECHECK_READS", 50)
    reads = _long_reads("chr2L", 0, 3_000_000, 8_000, 900)
    bam = _bam(tmp_path, "wgs_long.bam", {"chr2L": 3_000_000}, reads)
    state.add_dataset("wgs", str(bam), "wgs")
    body = client.get("/api/reads/regions", params={"dataset_id": "wgs"}).json()
    assert body["refused"] is True and body["whole_genome"] is True and body["status"] == "whole-genome"
    assert body["reads"] == len(reads)
    forced = client.get("/api/reads/regions", params={"dataset_id": "wgs", "force": "true"}).json()
    assert forced["success"] is True and forced["method"] == "reads" and forced["scanned_reads"] == len(reads)
    assert forced["note"].startswith("Scanned anyway")


def test_without_a_bai_the_reads_are_read_and_it_says_so(workspace, tmp_path, monkeypatch):
    import services.region_detect as rd
    client, state = workspace
    monkeypatch.setattr(rd, "PRECHECK_ABOVE", 100)
    reads = _long_reads("chr2L", 1_300_000, 1_400_000, 8_000, 30)
    bam = _bam(tmp_path, "csi.bam", {"chr2L": 3_000_000}, reads)
    os.remove(str(bam) + ".bai")
    pysam.index("-c", str(bam))
    state.add_dataset("csi", str(bam), "csi")
    body = client.get("/api/reads/regions", params={"dataset_id": "csi"}).json()
    assert body["success"] is True and body["method"] == "reads", body
    assert "No local .bai" in body["note"]
    assert len(body["regions"]) == 1


def test_index_profile_targeted_survey_and_refine(tmp_path):
    """The index helpers on their own: a targeted file's stretches, a whole-genome file's share."""
    from services import bam_index_profile as bip
    bam_path = _bam(tmp_path, "two.bam", {"chr1": 4_000_000},
                    _long_reads("chr1", 500_000, 600_000, 6_000, 30) + _long_reads("chr1", 3_000_000, 3_080_000, 6_000, 30))
    bam = pysam.AlignmentFile(str(bam_path))
    sv = bip.survey({str(bam_path): bam}, [(str(bam_path), "chr1", 4_000_000)])
    assert sv.targeted and sv.reads == bam.mapped and len(sv.stretches) == 2
    refs = bip.bam_index(str(bam_path))
    got = sorted(bip.refine(bam, refs[0], 0, lo, hi, bip.block_ratio(str(bam_path), [v for v in refs[0].linear if v]))
                 for _p, _c, _t, lo, hi in sv.stretches)
    assert abs(got[0][0] - 500_000) < 10_000 and abs(got[0][1] - 600_000) < 10_000, got
    assert abs(got[1][0] - 3_000_000) < 10_000 and abs(got[1][1] - 3_080_000) < 10_000, got
    wgs_path = _bam(tmp_path, "wgs.bam", {"chr1": 4_000_000}, _long_reads("chr1", 0, 4_000_000, 6_000, 2_000))
    wgs = pysam.AlignmentFile(str(wgs_path))
    sv2 = bip.survey({str(wgs_path): wgs}, [(str(wgs_path), "chr1", 4_000_000)])
    assert not sv2.targeted and sv2.stretches == []
    assert bip.survey({str(wgs_path): wgs}, [("/nonexistent.bam", "chr1", 10)]) is None


def test_a_stretch_that_cannot_be_refined_is_still_a_region(workspace, tmp_path, monkeypatch):
    """Reads longer than the sampled margin (their starts out of reach): the dense stretch at 16 kb
    resolution, never a 'scanned' result with no region (Codex review)."""
    import services.region_detect as rd
    from services import bam_index_profile as bip
    client, state = workspace
    monkeypatch.setattr(rd, "PRECHECK_ABOVE", 100)
    monkeypatch.setattr(bip, "refine", lambda *a, **k: None)
    reads = _long_reads("chr2L", 1_300_000, 1_470_000, 8_000, 40)
    state.add_dataset("cap2", str(_bam(tmp_path, "cap2.bam", {"chr2L": 23_000_000}, reads)), "cap2")
    body = client.get("/api/reads/regions", params={"dataset_id": "cap2"}).json()
    assert body["method"] == "index" and len(body["regions"]) == 1, body
    r = body["regions"][0]
    assert r["start"] % bip.WINDOW_BP == 0 and abs(r["start"] - 1_300_000) < 3 * bip.WINDOW_BP and r["reads"] > 100
