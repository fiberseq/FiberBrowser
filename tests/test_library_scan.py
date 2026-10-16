"""Watched-folder scans: bounded, headers only, nothing written, nothing outside the folder."""
from __future__ import annotations

import os
import shutil

import pytest

from library_fixtures import (
    make_bam, make_fiberhmm_bam, make_pipeline_run, seq, tree_snapshot, write_map, write_qc_json,
)
from services import library_scan as scan
from services import library_store as store


@pytest.fixture(autouse=True)
def library(tmp_path, monkeypatch):
    # A background recording queued by an earlier test must not land in this test's Library.
    from services.library_hooks import wait_idle
    wait_idle(20)
    monkeypatch.setenv("FIBERBROWSER_LIBRARY", str(tmp_path / "home" / "library.json"))


@pytest.fixture
def tree(tmp_path):
    root = tmp_path / "data"
    make_fiberhmm_bam(root / "exp1" / "a.fiberhmm.bam")
    make_fiberhmm_bam(root / "exp1" / "b.fiberhmm.bam")
    write_qc_json(root / "exp1" / "qc" / "a.fiberhmm.qc.json")
    make_bam(root / "exp1" / "noindex.bam", index=False)
    make_pipeline_run(root / "exp2" / "run", sample="P1", plasmid_seq=seq(5))
    write_map(root / "maps" / "pLib.gb", "pLib", seq(9))
    make_fiberhmm_bam(root / ".hidden" / "h.bam")
    make_fiberhmm_bam(root / "node_modules" / "n.bam")
    make_fiberhmm_bam(root / "d1" / "d2" / "d3" / "deep.bam")
    (root / "notes.txt").write_text("x")
    outside = tmp_path / "outside"
    make_fiberhmm_bam(outside / "o.bam")
    os.symlink(outside / "o.bam", root / "exp1" / "link.bam")
    os.symlink(outside / "o.bam.bai", root / "exp1" / "link.bam.bai")
    os.symlink(outside, root / "linked_dir")
    return root


def _paths(data):
    return sorted(os.path.relpath(e["path"], data["_root"]) for e in data["entries"].values())


def test_scan_finds_datasets_and_writes_nothing(tree):
    before = tree_snapshot(tree)
    watched = store.add_watched(str(tree), max_depth=2)
    result = scan.scan_folder(watched["id"])
    assert tree_snapshot(tree) == before
    data = store.load()
    data["_root"] = os.path.realpath(tree)
    assert _paths(data) == sorted([
        "exp1/a.fiberhmm.bam", "exp1/b.fiberhmm.bam",
        "exp2/run/P1.aligned.bam", "exp2/run/P1.fiberhmm.bam", "exp2/run/pTest.gb",
        "maps/pLib.gb",
    ])
    assert result["bam_without_index"] == 1 and result["added"] == 6 and result["truncated"] is None
    entries = {os.path.basename(e["path"]): e for e in data["entries"].values()}
    assert entries["a.fiberhmm.bam"]["qc"]["verdicts"]["overall"] == "PASS"
    assert entries["P1.fiberhmm.bam"]["role"] == "called" and entries["P1.aligned.bam"]["role"] == "aligned"
    assert all(e["sources"] == [f"watched:{watched['id']}"] for e in data["entries"].values())
    assert data["watched"][watched["id"]]["last_scan"]["candidates"] == 6


def test_depth_limit(tree):
    shallow = store.add_watched(str(tree), max_depth=0)
    scan.scan_folder(shallow["id"])
    assert store.load()["entries"] == {}
    deep = store.add_watched(str(tree), max_depth=5)
    scan.scan_folder(deep["id"])
    assert any(e["path"].endswith("deep.bam") for e in store.load()["entries"].values())


def test_symlinks_never_lead_outside(tree):
    watched = store.add_watched(str(tree), max_depth=6)
    scan.scan_folder(watched["id"])
    paths = [e["path"] for e in store.load()["entries"].values()]
    assert not any("outside" in p or "link" in os.path.basename(p) or "linked_dir" in p for p in paths)


def test_rescan_skips_unchanged_and_relocates_moves(tree):
    watched = store.add_watched(str(tree), max_depth=2)
    scan.scan_folder(watched["id"])
    entry_id = next(e["id"] for e in store.load()["entries"].values() if e["path"].endswith("b.fiberhmm.bam"))
    store.annotate(entry_id, tags=["moved"])
    again = scan.scan_folder(watched["id"])
    assert again["unchanged"] == 6 and again["inspected"] == 0
    os.makedirs(tree / "exp3")
    shutil.move(str(tree / "exp1" / "b.fiberhmm.bam"), str(tree / "exp3" / "b.fiberhmm.bam"))
    shutil.move(str(tree / "exp1" / "b.fiberhmm.bam.bai"), str(tree / "exp3" / "b.fiberhmm.bam.bai"))
    moved = scan.scan_folder(watched["id"])
    assert moved["relocated"] == 1 and moved["added"] == 0
    entry = store.load()["entries"][entry_id]
    assert entry["path"].endswith(os.path.join("exp3", "b.fiberhmm.bam")) and entry["tags"] == ["moved"]


def test_budget_truncates(tree, monkeypatch):
    monkeypatch.setattr(scan, "MAX_CANDIDATES", 2)
    watched = store.add_watched(str(tree), max_depth=4)
    result = scan.scan_folder(watched["id"])
    assert result["candidates"] == 2 and "stopped" in result["truncated"]


def test_huge_folders_are_skipped(tree, monkeypatch):
    monkeypatch.setattr(scan, "MAX_DIR_ENTRIES", 3)
    watched = store.add_watched(str(tree), max_depth=4)
    result = scan.scan_folder(watched["id"])
    assert result["skipped_dirs"] >= 1


def test_missing_folder(tmp_path):
    folder = tmp_path / "gone"
    folder.mkdir()
    watched = store.add_watched(str(folder))
    folder.rmdir()
    assert scan.scan_folder(watched["id"])["error"] == "folder not found"


def test_background_runner_and_startup_scan(tree, monkeypatch):
    watched = store.add_watched(str(tree), max_depth=2)
    monkeypatch.setenv(scan.NO_STARTUP_SCAN_ENV, "1")
    assert scan.start_startup_scan() is None
    monkeypatch.delenv(scan.NO_STARTUP_SCAN_ENV)
    scan.start_startup_scan()
    assert scan.runner().wait(30)
    assert len(store.load()["entries"]) == 6
    assert scan.status()["running"] is None
    assert store.load()["watched"][watched["id"]]["last_scan"]["added"] == 6


def test_rescan_picks_up_qc_written_later(tree):
    watched = store.add_watched(str(tree), max_depth=2)
    scan.scan_folder(watched["id"])
    entry = next(e for e in store.load()["entries"].values() if e["path"].endswith("b.fiberhmm.bam"))
    assert "qc" not in entry
    write_qc_json(tree / "exp1" / "qc" / "b.fiberhmm.qc.json", overall="WARN")
    result = scan.scan_folder(watched["id"])
    assert result["inspected"] == 1
    assert store.load()["entries"][entry["id"]]["qc"]["verdicts"]["overall"] == "WARN"


def test_rescan_rechecks_advisories_after_a_fiberhmm_update(tree, monkeypatch):
    import sys
    import types

    import fiberhmm
    module = types.ModuleType("fiberhmm.advisories")
    module.check_header = lambda header: [{"id": "x", "severity": "rerun-recommended", "title": "t"}]
    monkeypatch.setitem(sys.modules, "fiberhmm.advisories", module)
    monkeypatch.setattr(fiberhmm, "advisories", module, raising=False)
    monkeypatch.setattr(fiberhmm, "__version__", "3.0.0", raising=False)
    watched = store.add_watched(str(tree), max_depth=2)
    scan.scan_folder(watched["id"])
    assert scan.scan_folder(watched["id"])["inspected"] == 0
    monkeypatch.setattr(fiberhmm, "__version__", "3.0.1", raising=False)
    again = scan.scan_folder(watched["id"])
    assert again["inspected"] == 4  # the four BAMs; the plasmid maps have no advisories
    keys = {e["advisories"]["key"].split("|")[1] for e in store.load()["entries"].values() if e["kind"] == "bam"}
    assert keys == {"3.0.1"}


# --- Review round 4 ---------------------------------------------------------

def test_a_malformed_sidecar_never_aborts_the_scan(tmp_path, monkeypatch):
    root = tmp_path / "data"
    make_fiberhmm_bam(root / "bad" / "data.bam")
    (root / "bad" / "data.qc.json").write_text('{"signal": "invalid"}')
    make_fiberhmm_bam(root / "good" / "other.bam")
    watched = store.add_watched(str(root))
    scan.runner().request([watched["id"]])
    assert scan.runner().wait(20)
    assert scan.status()["last_error"] is None
    assert sorted(os.path.basename(e["path"]) for e in store.load()["entries"].values()) == ["data.bam", "other.bam"]
    # Even an unexpected failure is one file's error, not the scan's.
    from services import library_inspect as inspect
    real = inspect.inspect_file
    monkeypatch.setattr(inspect, "inspect_file", lambda path, *a, **k: 1 / 0 if path.endswith("data.bam")
                        else real(path, *a, **k))
    make_fiberhmm_bam(root / "good" / "third.bam")
    os.utime(root / "bad" / "data.bam", ns=(1, 1))
    result = scan.scan_folder(watched["id"])
    assert result["errors"] == 1 and result["added"] == 1
    entries = {os.path.basename(e["path"]): e for e in store.load()["entries"].values()}
    assert entries["data.bam"]["error"].startswith("ZeroDivisionError") and "third.bam" in entries


def test_rescan_notices_a_rewritten_or_removed_qc_file(tmp_path):
    root = tmp_path / "data"
    make_fiberhmm_bam(root / "data.bam")
    qc = write_qc_json(root / "data.qc.json", overall="PASS", curves=False)
    watched = store.add_watched(str(root))
    scan.scan_folder(watched["id"])
    write_qc_json(qc, overall="FAIL", curves=False)
    os.utime(qc, ns=(10**18, 10**18))  # a later mtime whatever the clock granularity
    again = scan.scan_folder(watched["id"])
    entry = next(iter(store.load()["entries"].values()))
    assert again["inspected"] == 1 and entry["qc"]["verdicts"]["overall"] == "FAIL"  # stayed PASS before
    assert scan.scan_folder(watched["id"])["unchanged"] == 1  # and unchanged again after
    os.remove(qc)
    assert scan.scan_folder(watched["id"])["inspected"] == 1
    assert "qc" not in next(iter(store.load()["entries"].values()))


def test_rescan_notices_a_changed_or_removed_outputs_json(tmp_path):
    import json
    run = make_pipeline_run(tmp_path / "data" / "run")
    watched = store.add_watched(str(tmp_path / "data"))
    scan.scan_folder(watched["id"])
    outputs = tmp_path / "data" / "run" / "outputs.json"
    raw = json.loads(outputs.read_text())
    raw["settings"] = {"enzyme": "dddb", "dedup": "off"}
    outputs.write_text(json.dumps(raw))
    os.utime(outputs, ns=(10**18, 10**18))
    assert scan.scan_folder(watched["id"])["inspected"] == 2  # the aligned and the called BAM
    called = next(e for e in store.load()["entries"].values() if e["path"] == run["called_bam"])
    assert called["pipeline"]["settings"] == {"enzyme": "dddb", "dedup": "off"}
    os.remove(outputs)
    scan.scan_folder(watched["id"])
    called = next(e for e in store.load()["entries"].values() if e["path"] == run["called_bam"])
    assert "pipeline" not in called


def test_sidecars_outside_the_watched_folder_are_never_read(tmp_path):
    watched_dir, outside = tmp_path / "watched", tmp_path / "outside"
    make_fiberhmm_bam(watched_dir / "data.bam")
    external_qc = write_qc_json(outside / "data.qc.json", overall="FAIL", curves=False)
    os.symlink(external_qc, watched_dir / "data.qc.json")
    watched = store.add_watched(str(watched_dir))
    scan.scan_folder(watched["id"])
    entry = next(iter(store.load()["entries"].values()))
    assert "qc" not in entry  # the external JSON was read (FAIL) before
    assert entry["sidecar_roots"] == [os.path.realpath(watched_dir)]


def test_oversized_folders_do_not_bypass_the_time_limit(tmp_path, monkeypatch):
    # Review round 4: the oversized-folder branch skipped the deadline check, so an
    # expired scan went on and reported truncated=None.
    root = tmp_path / "budget"
    for child in (root / "a", root / "b"):
        child.mkdir(parents=True)
        for i in range(3):
            (child / str(i)).touch()
    monkeypatch.setattr(scan, "MAX_DIR_ENTRIES", 2)
    clock = {"now": 0.0}
    monkeypatch.setattr(scan.time, "monotonic", lambda: clock["now"])
    real_scandir = os.scandir

    def slow_scandir(path):
        if os.path.realpath(path) != os.path.realpath(root):
            clock["now"] += 100  # listing a sub-folder uses up the whole budget
        return real_scandir(path)

    monkeypatch.setattr(os, "scandir", slow_scandir)
    result = scan.find_candidates(str(root), 6, deadline=1)
    assert result["truncated"] == "stopped at the time limit"  # was None
    assert result["counts"]["big_dirs"] == 1  # the second huge folder is not visited after the deadline


def test_a_huge_folder_is_listed_only_up_to_the_limit_and_reported(tmp_path, monkeypatch):
    root = tmp_path / "data"
    make_fiberhmm_bam(root / "ok" / "a.bam")
    huge = root / "huge"
    huge.mkdir()
    for i in range(50):
        (huge / f"f{i}.txt").touch()
    monkeypatch.setattr(scan, "MAX_DIR_ENTRIES", 10)
    consumed = {"n": 0}
    real_scandir = os.scandir

    class Counting:
        def __init__(self, path):
            self.inner = real_scandir(path)

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            self.inner.close()

        def __iter__(self):
            for entry in self.inner:
                consumed["n"] += 1
                yield entry

    monkeypatch.setattr(scan.os, "scandir", Counting)
    watched = store.add_watched(str(root))
    result = scan.scan_folder(watched["id"])
    assert result["candidates"] == 1 and result["big_dirs"] == 1
    assert result["big_dir_examples"] == [os.path.join(os.path.realpath(root), "huge")]
    assert consumed["n"] <= 2 + 11 + 3  # root, the huge folder's first 11 entries, ok/ (a.bam + index)


def test_a_rescan_fingerprints_entries_recorded_before_content_digests(tree):
    # Review round 8: entries from before digests were skipped as unchanged forever,
    # so they could never be relocated safely.
    watched = store.add_watched(str(tree), max_depth=2)
    scan.scan_folder(watched["id"])

    def drop(data):
        for entry in data["entries"].values():
            entry["identity"].pop("content_sha256", None)
    store.update(drop)
    again = scan.scan_folder(watched["id"])
    assert again["inspected"] == 6 and again["unchanged"] == 0
    assert all(e["identity"].get("content_sha256") for e in store.load()["entries"].values())
    assert scan.scan_folder(watched["id"])["unchanged"] == 6
