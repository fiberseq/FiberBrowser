"""Suggested experiments: one folder scanned on demand (the watched-folder rules,
without watching it), reviewed, then added so a group or Open covers it all."""
from __future__ import annotations

import os
import sys

import pytest

from library_fixtures import make_bam, make_fiberhmm_bam, make_pipeline_run, tree_snapshot, write_map, seq
from services import library_folder_scan as folder_scan
from services import library_scan as scan
from services import library_store as store


@pytest.fixture(autouse=True)
def env(tmp_path, monkeypatch):
    from services.library_hooks import wait_idle
    wait_idle(20)
    monkeypatch.setenv("FIBERBROWSER_LIBRARY", str(tmp_path / "home" / "library.json"))
    monkeypatch.setenv("FIBERBROWSER_JOBS_DIR", str(tmp_path / "jobs"))
    return tmp_path


@pytest.fixture
def exp(tmp_path):
    """A folder of BAMs as a user leaves it: called BAMs, an aligned-only one, one
    without an index, a plasmid map, a run's tracks/, an unrelated sub-folder,
    hidden and non-dataset files, an online-only placeholder and a symlink."""
    root = tmp_path / "data" / "exp1"
    for name in ("a", "b", "c"):
        make_fiberhmm_bam(root / f"{name}.fiberhmm.bam", sample=name)
    make_bam(root / "S.aligned.bam")
    make_bam(root / "noindex.bam", index=False)
    write_map(root / "pX.gb", "pX", seq(3))
    (root / "tracks").mkdir()
    (root / "tracks" / "a.footprints.bb").write_bytes(b"not really a bigbed")
    make_fiberhmm_bam(root / "old" / "old.fiberhmm.bam")
    make_fiberhmm_bam(root / ".hidden" / "h.fiberhmm.bam")
    (root / "notes.txt").write_text("x")
    (root / "cloud.fiberhmm.bam").write_bytes(b"")  # 0 bytes: an online-only placeholder
    (root / "cloud.fiberhmm.bam.bai").write_bytes(b"")
    os.symlink(root / "a.fiberhmm.bam", root / "same_as_a.bam")
    os.symlink(root / "a.fiberhmm.bam.bai", root / "same_as_a.bam.bai")
    outside = tmp_path / "outside"
    make_fiberhmm_bam(outside / "o.bam")
    os.symlink(outside / "o.bam", root / "link_out.bam")
    os.symlink(outside / "o.bam.bai", root / "link_out.bam.bai")
    return root


def _names(rows):
    return sorted(r["name"] for r in rows)


def test_preview_lists_the_folder_and_its_run_outputs_and_writes_nothing(exp):
    entry_id = store.record({"kind": "bam", "path": str(exp / "a.fiberhmm.bam"), "folder": str(exp),
                             "label": "a.fiberhmm.bam"}, "added")["id"]
    before = tree_snapshot(exp)
    library_before = store.load()["entries"]
    result = folder_scan.preview(str(exp))
    assert tree_snapshot(exp) == before and store.load()["entries"] == library_before
    assert result["success"] and result["mode"] == "folder" and result["subdirs"] == ["calls", "tracks"]
    assert _names(result["files"]) == sorted([
        "a.fiberhmm.bam", "b.fiberhmm.bam", "c.fiberhmm.bam", "cloud.fiberhmm.bam", "pX.gb",
        os.path.join("tracks", "a.footprints.bb"),
    ])
    rows = {r["name"]: r for r in result["files"]}
    assert rows["a.fiberhmm.bam"]["entry_id"] == entry_id  # already listed
    assert rows["b.fiberhmm.bam"]["entry_id"] is None
    assert rows["cloud.fiberhmm.bam"]["cloud_only"] and not rows["b.fiberhmm.bam"]["cloud_only"]
    assert result["kinds"] == {"bam": 4, "plasmid_map": 1, "bigbed": 1}
    assert result["new"] == 5 and result["cloud_only"] == 1 and not result["watched"]
    left = result["left_out"]
    assert left["aligned"] == 1 and left["no_index"] == 1 and left["outside"] == 1
    assert left["skipped_dirs"] == 2  # .hidden and old/ (not a run-output folder)
    assert left["other_files"] >= 1  # notes.txt, the indexes


def test_deep_mode_uses_the_watched_folder_depth(exp):
    result = folder_scan.preview(str(exp), "deep")
    assert result["max_depth"] == store.DEFAULT_MAX_DEPTH and result["subdirs"] is None
    assert os.path.join("old", "old.fiberhmm.bam") in _names(result["files"])
    assert not any(".hidden" in r["name"] for r in result["files"])
    assert folder_scan.preview(str(exp), "everything")["success"] is False


def test_a_pipeline_runs_aligned_bam_is_left_out(tmp_path):
    run = tmp_path / "run"
    make_pipeline_run(run, sample="P1")
    result = folder_scan.preview(str(run))
    assert _names(result["files"]) == ["P1.fiberhmm.bam"] and result["left_out"]["aligned"] == 1
    added = folder_scan.add(str(run), [str(run / "P1.fiberhmm.bam"), str(run / "P1.aligned.bam")])
    assert len(added["ids"]) == 1 and added["not_found"] == [] and added["aligned"] == 1
    assert store.load()["entries"][added["ids"][0]]["role"] == "called"


def test_add_records_the_chosen_files_and_answers_every_id(exp):
    known = store.record({"kind": "bam", "path": str(exp / "a.fiberhmm.bam"), "folder": str(exp),
                          "label": "a.fiberhmm.bam"}, "added")["id"]
    rows = folder_scan.preview(str(exp))["files"]
    chosen = [r["path"] for r in rows if r["name"] != "c.fiberhmm.bam"]  # the user unticked c
    before = tree_snapshot(exp)
    result = folder_scan.add(str(exp), chosen)
    assert tree_snapshot(exp) == before
    assert result["success"] and len(result["ids"]) == len(chosen) and known in result["ids"]
    entries = store.load()["entries"]
    paths = sorted(os.path.relpath(entries[i]["path"], exp) for i in result["ids"])
    assert paths == sorted(r["name"] for r in rows if r["name"] != "c.fiberhmm.bam")
    assert not any(e["path"].endswith("c.fiberhmm.bam") for e in entries.values())
    new = [entries[i] for i in result["ids"] if i != known]
    assert all(folder_scan.SOURCE in e["sources"] for e in new)
    cloud = next(e for e in new if e["path"].endswith("cloud.fiberhmm.bam"))
    assert cloud["cloud_only"] and "header_sha256" not in (cloud.get("identity") or {})  # never opened
    assert store.load()["watched"] == {}  # not made a watched folder
    # A group of the full set keeps every id; a second add finds them unchanged.
    group = store.create_group("exp1", result["ids"])
    assert group["entry_ids"] == result["ids"]
    again = folder_scan.add(str(exp), chosen)
    assert again["ids"] == result["ids"] and again["added"] == 0


def test_add_refuses_files_the_scan_does_not_find(exp, tmp_path):
    outside = tmp_path / "outside" / "o.bam"
    result = folder_scan.add(str(exp), [str(outside), str(exp / "link_out.bam"), str(exp / "old" / "old.fiberhmm.bam"),
                                        str(exp / "noindex.bam"), str(exp / "b.fiberhmm.bam")])
    assert len(result["ids"]) == 1
    assert sorted(result["not_found"]) == sorted([str(outside), str(exp / "link_out.bam"),
                                                  str(exp / "old" / "old.fiberhmm.bam"), str(exp / "noindex.bam")])
    assert len(store.load()["entries"]) == 1


def test_a_file_reached_through_a_symlink_is_listed_once(exp):
    rows = folder_scan.preview(str(exp))["files"]
    assert "same_as_a.bam" not in _names(rows)
    result = folder_scan.add(str(exp), [str(exp / "a.fiberhmm.bam"), str(exp / "same_as_a.bam")])
    assert len(result["ids"]) == 1 and len(store.load()["entries"]) == 1


def test_a_folder_reached_through_a_symlink_keeps_the_users_path(exp, tmp_path):
    link = tmp_path / "Dropbox"
    os.symlink(exp.parent, link)
    folder = str(link / "exp1")
    known = store.record({"kind": "bam", "path": os.path.join(folder, "a.fiberhmm.bam"), "folder": folder,
                          "label": "a.fiberhmm.bam"}, "added")["id"]
    rows = folder_scan.preview(folder)["files"]
    assert all(r["path"].startswith(folder + os.sep) for r in rows)
    assert next(r for r in rows if r["name"] == "a.fiberhmm.bam")["entry_id"] == known
    result = folder_scan.add(folder, [r["path"] for r in rows])
    entries = store.load()["entries"]
    assert all(entries[i]["path"].startswith(folder + os.sep) for i in result["ids"])
    assert all(entries[i]["folder"] in (folder, os.path.join(folder, "tracks")) for i in result["ids"])
    assert entries[known]["path"] == os.path.join(folder, "a.fiberhmm.bam")


def test_missing_unreadable_and_whole_disk_folders_answer_in_words(tmp_path):
    gone = folder_scan.preview(str(tmp_path / "gone"))
    assert gone["success"] is False and "no longer exists" in gone["error"]
    assert "no longer exists" in folder_scan.add(str(tmp_path / "gone"), [])["error"]
    a_file = tmp_path / "f.bam"
    a_file.write_text("x")
    assert "Not a folder" in folder_scan.preview(str(a_file))["error"]
    assert "whole disk" in folder_scan.preview(os.path.abspath(os.sep))["error"]


@pytest.mark.skipif(sys.platform == "win32" or (hasattr(os, "geteuid") and os.geteuid() == 0),
                    reason="POSIX permissions (root reads everything)")
def test_a_folder_without_read_permission(tmp_path):
    locked = tmp_path / "locked"
    make_fiberhmm_bam(locked / "a.fiberhmm.bam")
    os.chmod(locked, 0)
    try:
        result = folder_scan.preview(str(locked))
    finally:
        os.chmod(locked, 0o755)
    assert result["success"] is False and "permission denied" in result["error"]


def test_huge_and_truncated_folders_are_reported(exp, monkeypatch):
    monkeypatch.setattr(scan, "MAX_DIR_ENTRIES", 3)  # every folder here is "huge"
    result = folder_scan.preview(str(exp))
    assert result["success"] and result["files"] == [] and result["left_out"]["big_dirs"] == 1
    assert result["big_dir_examples"] == [os.path.realpath(exp)]
    monkeypatch.setattr(scan, "MAX_DIR_ENTRIES", 20_000)
    monkeypatch.setattr(folder_scan, "MAX_FOLDER_FILES", 2)
    capped = folder_scan.preview(str(exp))
    assert "stopped at 2 files" in capped["truncated"]


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

def test_routes_preview_then_add(client, exp):
    preview = client.post("/api/library/folder/preview", json={"path": str(exp)}).json()
    assert preview["success"] and preview["new"] == 6
    paths = [r["path"] for r in preview["files"]]
    added = client.post("/api/library/folder/add", json={"path": str(exp), "paths": paths}).json()
    assert added["success"] and added["added"] == 6 and len(added["ids"]) == 6
    group = client.post("/api/library/groups", json={"name": "exp1", "entry_ids": added["ids"]}).json()
    assert group["group"]["entry_ids"] == added["ids"]
    listed = client.get("/api/library").json()
    assert {e["id"] for e in listed["entries"]} == set(added["ids"]) and listed["watched"] == []


def test_routes_answer_a_missing_folder_inline_and_refuse_urls(client, tmp_path):
    gone = client.post("/api/library/folder/preview", json={"path": str(tmp_path / "gone")})
    assert gone.status_code == 200 and "no longer exists" in gone.json()["error"]
    url = client.post("/api/library/folder/preview", json={"path": "https://example.org/data/"})
    assert url.status_code == 400


def test_routes_are_confined_on_a_lab_server(client, exp, monkeypatch):
    from services.lab import paths as lab_paths

    def deny(path, **kwargs):
        raise lab_paths.PathDenied(lab_paths.OUTSIDE_MESSAGE)

    monkeypatch.setattr(lab_paths, "confine", deny)
    for route in ("preview", "add"):
        resp = client.post(f"/api/library/folder/{route}", json={"path": str(exp), "paths": []})
        assert resp.status_code == 403, route
    monkeypatch.undo()


def test_files_a_lab_server_may_not_read_are_left_out(exp, monkeypatch):
    from services.lab import paths as lab_paths
    monkeypatch.setattr(lab_paths, "readable", lambda path: not str(path).endswith("b.fiberhmm.bam"))
    result = folder_scan.preview(str(exp))
    assert "b.fiberhmm.bam" not in _names(result["files"]) and result["left_out"]["outside"] == 2
    assert folder_scan.add(str(exp), [str(exp / "b.fiberhmm.bam")])["not_found"] == [str(exp / "b.fiberhmm.bam")]


# ---------------------------------------------------------------------------
# Review findings (Codex)
# ---------------------------------------------------------------------------

def test_an_entry_listed_under_another_alias_keeps_its_path_when_refreshed(exp, tmp_path):
    alias = tmp_path / "alias"
    os.symlink(exp, alias)
    saved = str(alias / "b.fiberhmm.bam")
    known = store.record({"kind": "bam", "path": saved, "folder": str(alias), "label": "b.fiberhmm.bam"}, "added")["id"]
    # The stored entry has no identity, so the add re-reads it: still under its own path.
    result = folder_scan.add(str(exp), [str(exp / "b.fiberhmm.bam")])
    assert result["ids"] == [known]
    entry = store.load()["entries"][known]
    assert entry["path"] == saved and entry["folder"] == str(alias) and entry.get("identity", {}).get("content_sha256")


def test_preview_keeps_to_one_time_budget(exp, monkeypatch):
    clock = [0.0]
    real_stat = folder_scan.inspect.stat_identity

    def slow_stat(path):  # each file's check takes 20 s (a slow network share)
        clock[0] += 20
        return real_stat(path)

    monkeypatch.setattr(folder_scan.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(folder_scan.inspect, "stat_identity", slow_stat)
    result = folder_scan.preview(str(exp))
    assert result["truncated"] == "stopped at the time limit" and 0 < len(result["files"]) < 3


def test_add_answers_a_vanished_folder_with_a_full_result(tmp_path):
    result = folder_scan.add(str(tmp_path / "gone"), ["x.bam"])
    assert result["success"] is False and result["ids"] == [] and result["not_found"] == [] and result["errors"] == []
