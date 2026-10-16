"""Opening a selection of files: indexes chosen with their BAM, files that
can't be opened, and the one list of what FiberBrowser opens.

Owner report (2026-10-01): "if I load BAIs with BAMs by mistake nothing opens
and there is no error. Previously it would open the BAMs and then complain."
A BAM's index chosen with it is not a mistake: the BAM opens and the index is
used. Anything that can't be opened is named with the reason, and one bad file
never blocks the others.
"""
from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
DEMO = ROOT / "browser" / "data" / "demo" / "napa_ddda.bam"


@pytest.fixture
def bams(tmp_path):
    """Two indexed copies of the demo BAM: a.bam + a.bam.bai, b.bam + b.bai (samtools' other naming)."""
    shutil.copy(DEMO, tmp_path / "a.bam")
    shutil.copy(str(DEMO) + ".bai", tmp_path / "a.bam.bai")
    shutil.copy(DEMO, tmp_path / "b.bam")
    shutil.copy(str(DEMO) + ".bai", tmp_path / "b.bai")
    return tmp_path


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


def test_a_bam_with_its_index_opens_from_every_add_route(api, bams):
    a, a_bai, b, b_bai = (str(bams / n) for n in ("a.bam", "a.bam.bai", "b.bam", "b.bai"))

    grouped = api.post("/api/datasets/add_grouped", json={"paths": [a_bai, a, b, b_bai]}).json()
    assert grouped["success"], grouped
    assert sorted(d["path"] for d in grouped["datasets"]) == [a, b]
    assert "errors" not in grouped  # an index next to its BAM is not a mistake

    # One combined dataset (DatasetLayoutPanel's groups): the index is left out,
    # not taken for a BigBed ("Can't combine BAM and BigBed files").
    combined = api.post("/api/datasets/add", json={"paths": [a, a_bai, b, b_bai]}).json()
    assert combined["success"], combined
    assert combined["dataset"]["paths"] == [a, b]
    assert "warnings" not in combined


def test_an_index_alone_says_which_file_to_open(api, bams):
    res = api.post("/api/datasets/add", json={"path": str(bams / "a.bam.bai")}).json()
    assert res["success"] is False
    assert res["error"].startswith("a.bam.bai: this is a BAM index file, not a file to open on its own.")
    assert "Open a.bam instead" in res["error"]
    assert "Invalid path" not in res["error"]

    res = api.post("/api/datasets/add_grouped", json={"paths": [str(bams / "b.bai")]}).json()
    assert res["success"] is False and "Open b.bam instead" in res["error"]


def test_a_mixed_selection_opens_what_it_can_and_names_every_other_file(api, bams, tmp_path):
    (tmp_path / "notes.txt").write_text("not data")
    (tmp_path / "reads.cram").write_bytes(b"CRAM")
    (tmp_path / "peaks.bed").write_text("chr1\t1\t2\n")
    (tmp_path / "corrupt.bam").write_bytes(b"not a bam")
    paths = [str(tmp_path / n) for n in (
        "a.bam", "a.bam.bai", "missing.bam", "notes.txt", "reads.cram", "peaks.bed", "corrupt.bam", "orphan.bam.bai")]

    res = api.post("/api/datasets/add_grouped", json={"paths": paths}).json()
    assert res["success"], res
    assert [d["path"] for d in res["datasets"]] == [str(tmp_path / "a.bam")]
    errors = "\n".join(res["errors"])
    assert len(res["errors"]) == 6, res["errors"]
    assert "orphan.bam.bai: this is a BAM index file" in errors and "Open orphan.bam instead" in errors
    assert "missing.bam" in errors and "not found" in errors.lower()
    assert "notes.txt: not a file type FiberBrowser opens. Supported: Alignments (BAM);" in errors
    assert "reads.cram: CRAM files can't be opened; convert to BAM first" in errors
    assert "peaks.bed: a Tracks (bigWig, BED) file is not a dataset" in errors
    assert "corrupt.bam" in errors
    # Every message names its file.
    for error in res["errors"]:
        assert re.search(r"(missing|notes|reads|peaks|corrupt|orphan)\.", error), error


def test_the_library_skips_indexes_chosen_with_their_bam(bams, tmp_path, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_LIBRARY", str(tmp_path / "library.json"))
    from services import library_endpoint
    res = library_endpoint.add_files([str(bams / "a.bam"), str(bams / "a.bam.bai"), str(bams / "lonely.bam.bai")])
    assert len(res["ids"]) == 1
    assert len(res["errors"]) == 1 and res["errors"][0].startswith("lonely.bam.bai: this is a BAM index file")


# --- the one list -------------------------------------------------------------------

def test_the_list_is_the_frontend_file_and_every_kind_is_dispatched():
    from services import supported_files
    data = json.loads((ROOT / "browser" / "frontend" / "src" / "data" / "supportedFiles.json").read_text())
    assert supported_files.spec() == data
    # The page's opener (utils/openFiles.ts) handles every group the dialogs offer.
    opener = (ROOT / "browser" / "frontend" / "src" / "utils" / "openFiles.ts").read_text()
    for group in data["groups"]:
        assert f"case '{group['id']}'" in opener, group["id"]
    # Indexes are never offered as something to open.
    every = supported_files.dialog_filters("open")[0][1]
    for rule in data["sidecars"]:
        assert rule["suffix"] not in every


def test_dialog_filters_offer_supported_files_each_kind_and_all_files():
    from services import file_picker, supported_files
    filters = supported_files.dialog_filters("open")
    assert filters[0][0] == "Supported files" and filters[-1] == ("All files", [])
    assert file_picker.WINDOWS_FILTERS["dataset"] == (
        "Supported files|*.bam;*.bb;*.bigbed|Alignments (BAM)|*.bam|Fiber-seq BigBed (bb, bigBed)|*.bb;*.bigbed"
        "|All files|*.*")
    assert file_picker.ZENITY_FILTERS["open"][0].startswith("--file-filter=Supported files | *.bam *.bb *.bigbed *.bw")
    assert file_picker.ZENITY_FILTERS["open"][-1] == "--file-filter=All files | *"
    # pywebview's format: letters, digits and spaces, then (*.ext;...); macOS matches last extensions.
    valid = re.compile(r"^([\w ]+)\((\*(?:\.(?:\w+|\*))*(?:;\*(?:\.(?:\w+|\*))*)*)\)$")
    types = supported_files.pywebview_file_types("open")
    assert all(valid.match(t) for t in types), types
    assert types[0].startswith("Supported files (*.bam;*.bb;*.bigbed;") and types[-1] == "All files (*.*)"
    assert "Fiberseq BigBed (*.bb;*.bigbed)" in types


def test_remote_indexes_match_their_bam_whatever_the_signature():
    from services.supported_files import partition_sidecars
    bam = "https://s3.example.org/lab/x.bam?X-Amz-Signature=aaa"
    bai = "https://s3.example.org/lab/x.bam.bai?X-Amz-Signature=bbb"
    assert partition_sidecars([bam, bai]) == ([bam], [bai], [])
    mains, used, messages = partition_sidecars(["https://other.org/x.bam", bai])
    assert used == [] and messages and messages[0].startswith("x.bam.bai: this is a BAM index file")


def test_a_separately_signed_remote_index_is_opened_with_its_bam(monkeypatch):
    from models.requests import AddDatasetRequest
    from services import dataset_endpoint
    bam = "https://s3.example.org/lab/x.bam?X-Amz-Signature=aaa"
    bai = "https://s3.example.org/lab/x.bam.bai?X-Amz-Signature=bbb"
    seen = []
    monkeypatch.setattr(dataset_endpoint, "validate_dataset_paths", lambda paths, originals=None: seen.extend(paths) or [])

    class State:
        datasets = {}

        def add_dataset(self, dataset_id, path, label=None):
            from types import SimpleNamespace
            return SimpleNamespace(is_remote=True, to_dict=lambda: {"id": dataset_id, "path": path})

    res = dataset_endpoint.add_dataset_for_request(State(), AddDatasetRequest(paths=[bam, bai]))
    assert res["success"], res
    assert seen == [f"{bam}##idx##{bai}"]


def test_index_matching_ignores_separator_style_and_dot_segments(tmp_path):
    from services.supported_files import partition_sidecars
    bam = str(tmp_path / "x.bam")
    assert partition_sidecars([bam, str(tmp_path / "." / "x.bam.bai")])[2] == []
    assert partition_sidecars([bam.replace("/", "\\"), str(tmp_path / "x.bam.bai")])[2] == []
    # URLs are compared as they are: S3 keys are case-sensitive.
    assert partition_sidecars(["s3://lab/Case.bam", "s3://lab/case.bam.bai"])[2]


def test_a_missing_list_never_stops_the_server(monkeypatch):
    from services import file_picker, supported_files

    def missing():
        raise FileNotFoundError("supportedFiles.json")

    monkeypatch.setattr(supported_files, "spec", missing)
    file_picker._shared_filters()  # no exception; the dialogs keep their filters
    assert file_picker.WINDOWS_FILTERS["open"]
