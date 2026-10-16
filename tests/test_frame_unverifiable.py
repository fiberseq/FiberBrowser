"""A BAM whose header gives no frame evidence over frame-dependent footprints: FiberBrowser warns as FiberHMM 3.0.1
does (``warn_if_frames_unverifiable``): a dataset warning on load, a Library badge and a diagnose note. A warning
only: nothing is drawn differently.

Never for FiberHMM 3.0 call output, fibertools output, the demo BAMs, raw / m5C-only / Ma-only reads or declared
headers; always for a stripped header over legacy ns/nl or non-m5C MA groups.
"""
from __future__ import annotations

from array import array
from pathlib import Path

import pysam
import pytest

from services import bam_tags
from services.bam_tags import UNVERIFIABLE_FRAME_WARNING, bam_frame_unverifiable

ROOT = Path(__file__).resolve().parents[1]
DEMOS = [ROOT / "browser" / "data" / "demo" / "napa_ddda.bam", ROOT / "browser" / "data" / "demo" / "h1_chr1_insertion.bam"]

CALL_30 = {"PG": [{"ID": "fiberhmm-call", "PN": "fiberhmm-call", "VN": "3.0.0",
                   "CL": "fiberhmm-call -i in.bam -o out.bam --enzyme dddb",
                   "DS": "FiberHMM fused apply+recall; coord=molecular; mode=daf enzyme=dddb"}],
           "CO": ["fiberhmm:coord=molecular"]}
FIBERTOOLS = {"PG": [{"ID": "ft", "PN": "fibertools", "CL": "ft predict-m6a in.bam out.bam"}]}
DECLARED = {"CO": ["fiberhmm:coord=molecular"]}
STRIPPED = {}
UNRELATED = {"PG": [{"ID": "samtools", "PN": "samtools", "CL": "samtools view -b x.bam"}],
             "CO": ["FIBERHMM-CHEMISTRY:v1:assay=daf;enzyme=dddb;platform=ont;mode=daf"]}

LEGACY = {"ns": array("I", [10, 200]), "nl": array("I", [147, 147])}
MA_NUC_DOT = {"MA": "500;nuc.Q:11-147,201-147", "AQ": array("B", [200, 200])}
MA_NUC_PLUS = {"MA": "500;nuc+:11-147"}
M5C_ONLY = {"MA": "500;ddda_mcg.:1-5;ddda_mcg_hemi+:20-1"}
MA_FIBERTOOLS = {"Ma": "500;nuc.:11-147"}
RAW = {}


def write_bam(path: Path, header_extra: dict, tags: dict, n: int = 5) -> Path:
    header = {"HD": {"VN": "1.6", "SO": "unsorted"}, "SQ": [{"SN": "chr1", "LN": 10_000}], **header_extra}
    with pysam.AlignmentFile(str(path), "wb", header=header) as out:
        for i in range(n):
            read = pysam.AlignedSegment(out.header)
            read.query_name = f"r{i}"
            read.query_sequence = "A" * 500
            read.reference_id = 0
            read.reference_start = 100 + i
            read.mapping_quality = 60
            read.cigarstring = "500M"
            read.is_reverse = bool(i % 2)
            for tag, value in tags.items():
                read.set_tag(tag, value)
            out.write(read)
    return path


@pytest.mark.parametrize("name,header,tags", [
    ("fiberhmm-3.0-call", CALL_30, MA_NUC_PLUS),
    ("fiberhmm-3.0-call-legacy", CALL_30, LEGACY),
    ("fibertools", FIBERTOOLS, LEGACY),
    ("declared", DECLARED, MA_NUC_PLUS),
    ("stripped-raw", STRIPPED, RAW),
    ("stripped-m5c-only", STRIPPED, M5C_ONLY),
    ("stripped-Ma-only", STRIPPED, MA_FIBERTOOLS),
])
def test_never_for_evidence_or_frame_independent_reads(tmp_path, name, header, tags):
    assert bam_frame_unverifiable(write_bam(tmp_path / f"{name}.bam", header, tags)) is False


@pytest.mark.parametrize("name,header,tags", [
    ("stripped-legacy", STRIPPED, LEGACY),
    ("stripped-ma-dot", STRIPPED, MA_NUC_DOT),
    ("stripped-ma-plus", STRIPPED, MA_NUC_PLUS),
    ("unrelated-pg-and-chemistry", UNRELATED, MA_NUC_DOT),
])
def test_stripped_headers_over_frame_dependent_footprints(tmp_path, name, header, tags):
    assert bam_frame_unverifiable(write_bam(tmp_path / f"{name}.bam", header, tags)) is True


@pytest.mark.parametrize("demo", DEMOS, ids=lambda p: p.name)
def test_never_for_the_demo_bams(demo):
    assert bam_frame_unverifiable(demo) is False


def test_remote_and_missing_files_are_never_flagged(tmp_path):
    assert bam_frame_unverifiable("https://example.org/x.bam") is False
    assert bam_frame_unverifiable(tmp_path / "missing.bam") is False


def test_only_the_first_records_are_read(tmp_path):
    # Frame-dependent footprints only after the sampled records: not flagged (cheap, like FiberHMM's peek).
    path = tmp_path / "late.bam"
    header = {"HD": {"VN": "1.6"}, "SQ": [{"SN": "chr1", "LN": 10_000}]}
    with pysam.AlignmentFile(str(path), "wb", header=header) as out:
        for i in range(30):
            read = pysam.AlignedSegment(out.header)
            read.query_name, read.query_sequence, read.reference_id = f"r{i}", "A" * 50, 0
            read.reference_start, read.mapping_quality, read.cigarstring = 100, 60, "50M"
            if i >= 20:
                read.set_tag("MA", "50;nuc+:1-20")
            out.write(read)
    assert bam_frame_unverifiable(path, scan_records=10) is False
    assert bam_frame_unverifiable(path, scan_records=25) is False  # cached per file
    bam_tags._frame_unverifiable_cache.clear()
    assert bam_frame_unverifiable(path, scan_records=25) is True


def test_matches_fiberhmm_rule_when_installed(tmp_path):
    annotation_frame = pytest.importorskip("fiberhmm.io.annotation_frame")
    theirs = getattr(annotation_frame, "read_has_frame_dependent_annotations", None)
    if theirs is None:
        pytest.skip("the installed FiberHMM predates read_has_frame_dependent_annotations (3.0.1)")
    for name, tags in [("legacy", LEGACY), ("dot", MA_NUC_DOT), ("plus", MA_NUC_PLUS), ("m5c", M5C_ONLY),
                       ("Ma", MA_FIBERTOOLS), ("raw", RAW)]:
        path = write_bam(tmp_path / f"{name}.bam", STRIPPED, tags, n=1)
        with pysam.AlignmentFile(str(path), "rb", check_sq=False) as bam:
            read = next(bam.fetch(until_eof=True))
        assert bam_tags.read_has_frame_dependent_annotations(read) is bool(theirs(read)), name
    assert UNVERIFIABLE_FRAME_WARNING.startswith("The header has no FiberHMM/fibertools provenance")


def test_dataset_warning_on_load_and_library_flag(tmp_path):
    from models.requests import AddDatasetRequest
    from services import library_inspect
    from services.dataset_endpoint import add_dataset_for_request
    from state.browser_state import BrowserState

    stripped = write_bam(tmp_path / "stripped.bam", STRIPPED, MA_NUC_PLUS)
    called = write_bam(tmp_path / "called.bam", CALL_30, MA_NUC_PLUS)
    for path in (stripped, called):
        pysam.index(str(path))
    state = BrowserState(None, None, None, None)
    warned = add_dataset_for_request(state, AddDatasetRequest(path=str(stripped)))
    assert warned["success"], warned
    assert [w for w in warned.get("warnings", []) if UNVERIFIABLE_FRAME_WARNING in w] == [
        f"stripped.bam: {UNVERIFIABLE_FRAME_WARNING}"]
    quiet = add_dataset_for_request(state, AddDatasetRequest(path=str(called)))
    assert quiet["success"] and not [w for w in quiet.get("warnings", []) if UNVERIFIABLE_FRAME_WARNING in w]

    import os
    identity = {"size": stripped.stat().st_size, "mtime_ns": stripped.stat().st_mtime_ns, "inode": stripped.stat().st_ino}
    assert library_inspect.inspect_bam(str(stripped), identity)["frame_unverifiable"] is True
    identity = {"size": called.stat().st_size, "mtime_ns": called.stat().st_mtime_ns, "inode": called.stat().st_ino}
    assert library_inspect.inspect_bam(str(called), identity)["frame_unverifiable"] is False
    assert os.path.exists(str(called) + ".bai")


def test_diagnose_note_uses_the_same_rule(tmp_path):
    from services.files_endpoint import diagnose_bam_payload
    stripped = write_bam(tmp_path / "stripped.bam", STRIPPED, MA_NUC_DOT)
    m5c = write_bam(tmp_path / "m5c.bam", STRIPPED, M5C_ONLY)
    for path in (stripped, m5c):
        pysam.index(str(path))
    notes = diagnose_bam_payload(None, bam_path=str(stripped)).get("recommendations", [])
    assert any(n.startswith(UNVERIFIABLE_FRAME_WARNING) for n in notes), notes
    notes = diagnose_bam_payload(None, bam_path=str(m5c)).get("recommendations", [])
    assert not any(UNVERIFIABLE_FRAME_WARNING in n for n in notes), notes


def test_the_check_never_opens_an_index_or_the_bam_by_name(tmp_path, monkeypatch):
    """An index beside the BAM may be one the Library refused (online-only, outside the folder): the check opens
    the BAM through a file descriptor, so htslib has no name to look an index up by."""
    path = write_bam(tmp_path / "stripped.bam", STRIPPED, MA_NUC_PLUS)
    pysam.index(str(path))
    opened = []
    real_open = pysam.AlignmentFile

    class Recording(real_open):  # pysam.AlignmentFile is a cdef class: record the arguments of each open
        def __new__(cls, *args, **kwargs):
            opened.append((args, kwargs))
            return real_open.__new__(cls, *args, **kwargs)

    monkeypatch.setattr(pysam, "AlignmentFile", Recording)
    bam_tags._frame_unverifiable_cache.clear()
    assert bam_frame_unverifiable(path) is True
    # Opened on a bare descriptor (an int), never by name or through a file object (whose name htslib probes).
    assert opened and all(isinstance(args[0], int) and "index_filename" not in kwargs for args, kwargs in opened)
    bam, handle = bam_tags.open_bam_without_index(path)
    try:
        assert bam.has_index() is False
    finally:
        bam.close()
        handle.close()


def test_an_unreadable_index_beside_the_bam_is_never_touched(tmp_path):
    import os
    path = write_bam(tmp_path / "stripped.bam", STRIPPED, LEGACY)
    index = tmp_path / "stripped.bam.bai"
    index.write_bytes(b"not an index")
    os.chmod(index, 0)
    try:
        bam_tags._frame_unverifiable_cache.clear()
        assert bam_frame_unverifiable(path) is True
    finally:
        os.chmod(index, 0o600)


def test_the_library_badge_never_loads_an_index_the_inspection_refused(tmp_path, monkeypatch):
    """inspect_bam opens the BAM with exactly the index it chose (here: none, as for a refused one); the frame check
    reads the BAM through a file descriptor, so the index beside it is never opened either."""
    from services import library_inspect
    path = write_bam(tmp_path / "stripped.bam", STRIPPED, MA_NUC_DOT)
    pysam.index(str(path))
    monkeypatch.setattr(library_inspect, "_index_path", lambda p, sidecars: None)  # the index was refused
    checked = []
    real_open = bam_tags.open_bam_without_index

    def recording(p):
        bam, handle = real_open(p)
        checked.append(bam.has_index())
        return bam, handle

    monkeypatch.setattr(bam_tags, "open_bam_without_index", recording)
    bam_tags._frame_unverifiable_cache.clear()
    st = path.stat()
    info = library_inspect.inspect_bam(str(path), {"size": st.st_size, "mtime_ns": st.st_mtime_ns, "inode": st.st_ino})
    assert info["index_path"] is None and info["frame_unverifiable"] is True
    assert checked == [False, False]  # the inspection's own open (no index approved) and the frame check


def test_no_index_is_probed_by_descriptor_number_in_the_working_directory(tmp_path, monkeypatch):
    """A Python file object's numeric name made htslib probe <fd>.bai / <fd>.csi in the working directory (pysam
    0.23-0.24): decoy indexes for every likely descriptor number sit there, and none is loaded."""
    import os
    import shutil
    from services import library_inspect
    (tmp_path / "data").mkdir()
    path = write_bam(tmp_path / "data" / "stripped.bam", STRIPPED, MA_NUC_DOT)
    pysam.index(str(path))
    cwd = tmp_path / "cwd"
    cwd.mkdir()
    for fd in range(3, 256):
        for ext in (".bai", ".csi"):
            shutil.copy(str(path) + ".bai", cwd / f"{fd}{ext}")
    monkeypatch.chdir(cwd)
    bam, descriptor = bam_tags.open_bam_without_index(path)
    try:
        assert bam.has_index() is False
    finally:
        bam.close()
        descriptor.close()
    with library_inspect._open_bam(str(path), None) as bam:
        assert bam.has_index() is False
    bam_tags._frame_unverifiable_cache.clear()
    assert bam_frame_unverifiable(path) is True
    # (A file object, as before, did load a decoy: the reason for the bare descriptor.)
    handle = os.fdopen(os.open(path, os.O_RDONLY), "rb")
    try:
        with pysam.AlignmentFile(handle, "rb", check_sq=False) as old:
            probed = old.has_index()
    finally:
        handle.close()
    assert probed is True
