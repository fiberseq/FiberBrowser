"""Opening files (fb-n2-files, release audit P9).

- Codex 31: a PacBio ``.pbi`` chosen with a remote BAM is used as it is, never
  passed to htslib as the BAM's coordinate index; a BAI/CSI chosen after it is.
- M21: an online-only (cloud placeholder) BAM opened as a dataset with no reads
  and no message. Now it is refused, naming the file and saying to make it
  available offline (metadata only: the file's data is never read).
"""
from __future__ import annotations

import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
DEMO = ROOT / "browser" / "data" / "demo" / "napa_ddda.bam"
CLOUD = "is in the cloud and not downloaded: make it available offline in Dropbox/iCloud, then reopen it."


@pytest.fixture
def api(client):
    """The HTTP API on a fresh, empty workspace."""
    import server as srv
    from state import runtime_state
    from state.browser_state import BrowserState
    fresh = BrowserState(None, None, None, None)
    srv.state = fresh
    runtime_state._state = fresh  # put back by conftest's _restore_browser_state
    return client


def _dropbox_placeholder(path: Path) -> Path:
    """A zero-length file marked as Dropbox marks an online-only file (macOS)."""
    path.write_bytes(b"")
    subprocess.run(["/usr/bin/xattr", "-w", "com.dropbox.placeholder", "1", str(path)], check=True)
    return path


mac_only = pytest.mark.skipif(sys.platform != "darwin" or not os.path.exists("/usr/bin/xattr"),
                              reason="Dropbox placeholders are marked with a macOS extended attribute")


@mac_only
def test_an_online_only_bam_is_refused_with_a_message(api, tmp_path):
    bam = _dropbox_placeholder(tmp_path / "zld.bam")
    _dropbox_placeholder(tmp_path / "zld.bam.bai")
    for route, body in (("/api/datasets/add", {"path": str(bam)}),
                        ("/api/datasets/add_grouped", {"paths": [str(bam), str(bam) + ".bai"]})):
        res = api.post(route, json=body).json()
        assert res["success"] is False, (route, res)
        assert f"zld.bam {CLOUD}" in res["error"], res
    assert api.get("/api/datasets").json()["datasets"] == []


@mac_only
def test_a_bam_whose_index_is_online_only_names_the_index(api, tmp_path):
    shutil.copy(DEMO, tmp_path / "a.bam")
    _dropbox_placeholder(tmp_path / "a.bam.bai")
    res = api.post("/api/datasets/add", json={"path": str(tmp_path / "a.bam")}).json()
    assert res["success"] is False
    assert "a.bam.bai (the index of a.bam) is in the cloud and not downloaded" in res["error"]


def test_the_index_checked_is_the_one_htslib_opens(tmp_path):
    """htslib looks for x.bam.csi, x.csi, x.bam.bai, x.bai: that one decides."""
    from services.cloud_placeholders import dataset_unavailable_message
    bam = tmp_path / "a.bam"
    shutil.copy(DEMO, bam)
    (tmp_path / "a.bam.bai").write_bytes(b"")          # never opened: a CSI comes first
    (tmp_path / "a.csi").write_bytes(b"csi index")
    assert dataset_unavailable_message(str(bam)) is None
    (tmp_path / "a.csi").write_bytes(b"")              # the CSI htslib would open is empty
    assert "a.csi (the index of a.bam) is empty" in dataset_unavailable_message(str(bam))
    (tmp_path / "a.csi").unlink()
    (tmp_path / "a.bam.bai").unlink()
    (tmp_path / ".a.bam.bai.icloud").write_bytes(b"stub")  # only an iCloud stub of the index
    assert "a.bam.bai (the index of a.bam) is in the cloud" in dataset_unavailable_message(str(bam))


@mac_only
def test_an_online_only_bed_track_is_refused_with_a_message(api, tmp_path):
    bed = _dropbox_placeholder(tmp_path / "enhancers.bed")
    res = api.post("/api/add_track", params={"path": str(bed)}).json()
    assert res["success"] is False and res["message"] == f"enhancers.bed {CLOUD}"


def test_a_zero_length_file_is_empty_and_in_a_synced_folder_may_be_online_only(api, tmp_path):
    from services.cloud_placeholders import availability, unavailable_message
    synced = tmp_path / "Dropbox (Lab)" / "bam"
    synced.mkdir(parents=True)
    (synced / "x.bam").write_bytes(b"")
    (tmp_path / "y.bam").write_bytes(b"")
    # A folder's name is no evidence that a file is online-only (an empty BED is a valid track).
    assert availability(str(synced / "x.bam")) == "empty"
    assert "If it is online-only, make it available offline" in unavailable_message(str(synced / "x.bam"))
    assert availability(str(tmp_path / "y.bam")) == "empty"
    res = api.post("/api/datasets/add", json={"path": str(tmp_path / "y.bam")}).json()
    assert res["success"] is False and "y.bam is empty (0 bytes)" in res["error"]
    empty_bed = synced / "no_peaks.bed"
    empty_bed.write_bytes(b"")
    assert api.post("/api/add_track", params={"path": str(empty_bed)}).json()["success"] is True
    # A real BAM (and a folder) is not flagged.
    shutil.copy(DEMO, tmp_path / "z.bam")
    assert availability(str(tmp_path / "z.bam")) is None and availability(str(tmp_path)) is None


def test_file_provider_dataless_files_and_icloud_stubs(monkeypatch, tmp_path):
    from services import cloud_placeholders as cp
    monkeypatch.setattr(cp.sys, "platform", "darwin")
    monkeypatch.setattr(cp, "has_placeholder_xattr", lambda path: False)
    big = 50 * 2**20
    regular = stat.S_IFREG | 0o644
    dataless = SimpleNamespace(st_mode=regular, st_size=big, st_blocks=8, st_flags=cp.SF_DATALESS)
    no_blocks = SimpleNamespace(st_mode=regular, st_size=big, st_blocks=0, st_flags=0)
    compressed = SimpleNamespace(st_mode=regular, st_size=big, st_blocks=0, st_flags=cp.UF_COMPRESSED)
    local = SimpleNamespace(st_mode=regular, st_size=big, st_blocks=big // 512, st_flags=0)
    assert cp.availability("/x/a.bam", dataless) == "cloud"
    assert cp.availability("/x/a.bam", no_blocks) == "cloud"
    assert cp.availability("/x/a.bam", compressed) is None
    assert cp.availability("/x/a.bam", local) is None
    # iCloud's older stub: .a.bam.icloud next to a missing a.bam.
    (tmp_path / ".a.bam.icloud").write_bytes(b"stub")
    assert cp.unavailable_message(str(tmp_path / "a.bam")) == f"a.bam {CLOUD}"


def test_a_pbi_is_never_a_remote_bams_coordinate_index():
    from services.supported_files import attach_remote_indexes, is_coordinate_index, partition_sidecars
    bam = "https://s3.example.org/lab/x.bam"
    pbi = "https://s3.example.org/lab/x.bam.pbi"
    bai = "https://s3.example.org/lab/x.bam.bai"
    csi = "https://s3.example.org/lab/x.bam.csi"
    assert not is_coordinate_index(pbi) and is_coordinate_index(bai) and is_coordinate_index(csi)
    # The .pbi is still a companion used with its BAM (no "open the BAM instead" message).
    assert partition_sidecars([bam, pbi]) == ([bam], [pbi], [])
    assert attach_remote_indexes([bam], [pbi]) == [bam]
    # Chosen before the BAI/CSI: the BAI/CSI is the index.
    assert attach_remote_indexes([bam], [pbi, bai]) == [f"{bam}##idx##{bai}"]
    assert attach_remote_indexes([bam], [pbi, csi]) == [f"{bam}##idx##{csi}"]


# --- L11: a track for another assembly than the main genome ------------------

HG38 = [("chr1", 248_956_422), ("chr2", 242_193_529), ("chrX", 156_040_895), ("chrM", 16_569)]
DM6 = [("chr2L", 23_513_712), ("chr2R", 25_286_936), ("chr3L", 28_110_227), ("chr3R", 32_079_331),
       ("chrX", 23_542_271), ("chrM", 19_524)]


@pytest.fixture
def hg38_with_dm6_panel(api):
    """The main genome is hg38; a dataset's own panel reference is dm6."""
    import server as srv
    from models.domain import ChromInfo
    from services import panel_genomes
    from state.browser_state import BrowserState
    state = srv.state
    state.chroms = [ChromInfo(name=n, size=s) for n, s in HG38]
    state.current_genome = "hg38"
    ctx = BrowserState(None)
    ctx.chroms = [ChromInfo(name=n, size=s) for n, s in DM6]
    ctx._panel_genome_spec = {"kind": "registry", "genome_id": "dm6", "label": "dm6", "source": {"genome_id": "dm6"}}
    panel_genomes.contexts(state)["dm6"] = ctx
    return state


def _bed(path: Path, rows) -> str:
    path.write_text("track name=x\n" + "".join(f"{c}\t{s}\t{e}\tr{i}\n" for i, (c, s, e) in enumerate(rows)))
    return str(path)


def test_a_dm6_bed_on_hg38_is_added_with_a_warning(api, hg38_with_dm6_panel, tmp_path):
    fly = _bed(tmp_path / "fly_enhancers.bed", [("chr2L", 100, 900), ("chr3R", 5_000, 6_000),
                                                ("chr2R", 7_000, 7_500), ("chrX", 1_000, 2_000)])
    res = api.post("/api/add_track", params={"path": fly}).json()
    assert res["success"] is True  # added: switching the main genome to dm6 shows it
    warning = res.get("warning") or ""
    assert warning.startswith("fly_enhancers.bed: its chromosomes (chr2L, chr2R, chr3R) are not on hg38"), warning
    assert "they match dm6" in warning

    human = _bed(tmp_path / "human.bed", [("chr1", 100, 900), ("chrX", 5_000, 6_000), ("2", 1, 2)])
    res = api.post("/api/add_track", params={"path": human}).json()
    assert res["success"] is True and "warning" not in res

    # One interval past a chromosome's end doesn't make the rest another assembly.
    rows = [("chrM", i * 100, i * 100 + 50) for i in range(99)] + [("chrM", 16_000, 17_000)]
    res = api.post("/api/add_track", params={"path": _bed(tmp_path / "mito.bed", rows)}).json()
    assert res["success"] is True and "warning" not in res
    # Most intervals past the ends (a BED has no lengths): said so, not "other lengths".
    rows = [("chrM", 17_000 + i, 17_100 + i) for i in range(10)]
    res = api.post("/api/add_track", params={"path": _bed(tmp_path / "past.bed", rows)}).json()
    assert "most of its intervals lie past the ends of hg38's chromosomes (chrM)" in res["warning"]


def test_an_icloud_stub_track_is_said_to_be_in_the_cloud(api, tmp_path):
    (tmp_path / ".enhancers.bed.icloud").write_bytes(b"stub")
    res = api.post("/api/add_track", params={"path": str(tmp_path / "enhancers.bed")}).json()
    assert res["success"] is False and res["message"] == f"enhancers.bed {CLOUD}"


def test_a_bigwig_on_another_assembly_is_told_by_its_lengths(api, hg38_with_dm6_panel, tmp_path):
    pyBigWig = pytest.importorskip("pyBigWig")
    path = tmp_path / "fly_signal.bw"
    bw = pyBigWig.open(str(path), "w")
    bw.addHeader(DM6)
    bw.addEntries(["chr2L"], [0], ends=[1000], values=[1.0])
    bw.close()
    res = api.post("/api/add_track", params={"path": str(path)}).json()
    assert res["success"] is True and "they match dm6" in (res.get("warning") or ""), res

    # Same names, other lengths (an hg19 file on hg38): told by the lengths.
    from services.panel_genomes import track_reference_warning
    import server as srv
    hg19 = {"chr1": {"weight": 249_250_621, "size": 249_250_621}, "chr2": {"weight": 243_199_373, "size": 243_199_373}}
    assert "have other lengths than on hg38" in track_reference_warning(srv.state, "hg19.bw", hg19)


# --- L12: a fresh window starts a panel on its own reference at its reads -------

def test_a_later_window_learns_where_each_own_reference_panel_opens(client, standalone_app, tmp_path):
    """A window opened after "Open with dm6 in its own panel" (a fresh browser
    profile) started the dm6 panels at the first chromosome's 0-10,000 ("No
    reads in this view"): /api/panel_genomes now says where each one's reads are."""
    import random
    from state import runtime_state
    from state.browser_state import BrowserState
    from test_panel_genomes import _bam, _fasta
    rng = random.Random(3)
    main_fa = _fasta(tmp_path / "main.fa", {"chr1": "".join(rng.choice("ACGT") for _ in range(5_000))})
    fly_fa = _fasta(tmp_path / "fly.fa", {"chr2L": "".join(rng.choice("ACGT") for _ in range(30_000)),
                                          "chr3R": "".join(rng.choice("ACGT") for _ in range(30_000))})
    fly_bam = _bam(tmp_path / "fly.bam", "chr3R", 30_000, at=20_000)
    st = BrowserState(None)
    assert st._load_fasta(main_fa) is None
    st.add_dataset("fly", fly_bam, "fly")
    runtime_state.set_browser_state(st)

    body = client.post("/api/panel_genomes/attach", json={"dataset_ids": ["fly"], "fasta_path": fly_fa,
                                                          "span": 1_000}).json()
    assert body["success"] and body["loci"]["fly"]["chrom"] == "chr3R"
    listed = client.get("/api/panel_genomes").json()
    assert listed["loci"] == {"fly": body["loci"]["fly"]}
    assert listed["loci"]["fly"]["start"] >= 19_000  # at the reads, not chr2L:0-10,000

    # Saved with a session and restored (the restore attaches with span=0): still known.
    from services import panel_genomes
    saved = panel_genomes.session_export(st)
    assert saved["loci"] == {"fly": body["loci"]["fly"]}
    assert panel_genomes.session_restore(st, saved)["restored"] == 1
    assert client.get("/api/panel_genomes").json()["loci"] == {"fly": body["loci"]["fly"]}
    # A saved window off the reference is not taken.
    panel_genomes.session_restore(st, {**saved, "loci": {"fly": {"chrom": "chr19", "start": 0, "end": 10}}})
    assert client.get("/api/panel_genomes").json()["loci"] == {}
    # ... or past the end of its chromosome (a shorter FASTA relinked under the same name).
    panel_genomes.session_restore(st, {**saved, "loci": {"fly": {"chrom": "chr3R", "start": 29_500, "end": 31_000}}})
    assert client.get("/api/panel_genomes").json()["loci"] == {}
    panel_genomes.session_restore(st, saved)

    # Back on the main genome (or closed): nothing is remembered for it.
    client.post("/api/panel_genomes/detach", json={"dataset_ids": ["fly"]})
    assert client.get("/api/panel_genomes").json()["loci"] == {}
