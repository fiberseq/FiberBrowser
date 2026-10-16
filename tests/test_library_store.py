"""The Library file: per user, versioned, atomic, never touching data files."""
from __future__ import annotations

import json
import os
import threading

import pytest

from library_fixtures import make_fiberhmm_bam
from services import library_inspect as inspect
from services import library_store as store


@pytest.fixture(autouse=True)
def library(tmp_path, monkeypatch):
    # A background recording queued by an earlier test must not land in this test's Library.
    from services.library_hooks import wait_idle
    wait_idle(20)
    path = tmp_path / "lib" / "library.json"
    monkeypatch.setenv("FIBERBROWSER_LIBRARY", str(path))
    return path


def test_env_override_and_default(monkeypatch, tmp_path):
    assert store.library_file() == tmp_path / "lib" / "library.json"
    monkeypatch.delenv("FIBERBROWSER_LIBRARY")
    assert str(store.library_file()).endswith(os.path.join(".fiberhmm", "library.json"))


def test_record_writes_versioned_json_atomically(tmp_path, library):
    bam = make_fiberhmm_bam(tmp_path / "data" / "a.bam")
    result = store.record(inspect.inspect_file(bam), "opened", opened=True)
    assert result["action"] == "added"
    raw = json.loads(library.read_text())
    assert raw["schema"] == store.SCHEMA
    entry = raw["entries"][result["id"]]
    assert entry["path"] == bam and entry["sources"] == ["opened"] and entry["last_opened"]
    assert not [n for n in os.listdir(library.parent) if n.endswith(".tmp")]


def test_user_fields_survive_reinspection(tmp_path):
    bam = make_fiberhmm_bam(tmp_path / "a.bam")
    entry_id = store.record(inspect.inspect_file(bam))["id"]
    store.annotate(entry_id, tags=["embryo", "embryo", " 2-4h ", "<script>"], notes="good run", label="Embryo A")
    again = store.record(inspect.inspect_file(bam), "watched:w1")
    assert again == {"id": entry_id, "action": "updated"}
    entry = store.load()["entries"][entry_id]
    assert entry["tags"] == ["embryo", "2-4h", "script"]
    assert entry["notes"] == "good run" and entry["label_override"] == "Embryo A"


def test_moved_file_is_relocated_not_duplicated(tmp_path):
    bam = make_fiberhmm_bam(tmp_path / "old" / "a.bam")
    entry_id = store.record(inspect.inspect_file(bam))["id"]
    store.annotate(entry_id, tags=["keep"])
    os.makedirs(tmp_path / "new")
    moved = str(tmp_path / "new" / "a.bam")
    os.rename(bam, moved)
    os.rename(bam + ".bai", moved + ".bai")
    result = store.record(inspect.inspect_file(moved))
    assert result == {"id": entry_id, "action": "relocated"}
    entry = store.load()["entries"][entry_id]
    assert entry["path"] == moved and entry["previous_paths"] == [bam] and entry["tags"] == ["keep"]


def test_a_copy_is_a_second_entry(tmp_path):
    import shutil
    bam = make_fiberhmm_bam(tmp_path / "a.bam")
    store.record(inspect.inspect_file(bam))
    copy = str(tmp_path / "b.bam")
    shutil.copy(bam, copy)
    assert store.record(inspect.inspect_file(copy))["action"] == "added"
    assert len(store.load()["entries"]) == 2


def test_remove_forgets_but_never_deletes(tmp_path):
    bam = make_fiberhmm_bam(tmp_path / "a.bam")
    entry_id = store.record(inspect.inspect_file(bam))["id"]
    group = store.create_group("Embryo", [entry_id])
    assert store.remove_entries([entry_id]) == 1
    assert os.path.exists(bam) and os.path.exists(bam + ".bai")
    data = store.load()
    assert data["entries"] == {} and data["groups"][group["id"]]["entry_ids"] == []


def test_groups(tmp_path):
    ids = [store.record(inspect.inspect_file(make_fiberhmm_bam(tmp_path / f"{n}.bam")))["id"] for n in "abc"]
    group = store.create_group("  Time course ", ids[:2] + ["nope"], "2-4h vs 6-8h")
    assert group["name"] == "Time course" and group["entry_ids"] == ids[:2]
    edited = store.edit_group(group["id"], add=[ids[2], ids[0]], remove=[ids[1]], name="TC")
    assert edited["entry_ids"] == [ids[0], ids[2]] and edited["name"] == "TC"
    with pytest.raises(ValueError):
        store.create_group("   ", ids)
    assert store.delete_group(group["id"]) is True
    assert store.load()["groups"] == {}


def test_watched_folders(tmp_path):
    first = store.add_watched(str(tmp_path), max_depth=99)
    assert first["max_depth"] == store.MAX_MAX_DEPTH and first["path"] == os.path.realpath(tmp_path)
    again = store.add_watched(str(tmp_path) + "/", max_depth=2)
    assert again["id"] == first["id"] and again["max_depth"] == 2
    assert store.remove_watched(first["id"]) is True


def test_newer_or_damaged_library_is_never_overwritten(library, tmp_path):
    library.parent.mkdir(parents=True, exist_ok=True)
    library.write_text(json.dumps({"schema": "fiberbrowser.library.v9", "entries": {}}))
    bam = make_fiberhmm_bam(tmp_path / "a.bam")
    with pytest.raises(RuntimeError, match="newer FiberBrowser"):
        store.record(inspect.inspect_file(bam))
    assert json.loads(library.read_text())["schema"] == "fiberbrowser.library.v9"
    library.write_text("{not json")
    with pytest.raises(RuntimeError):
        store.add_watched(str(tmp_path))
    assert library.read_text() == "{not json"


def test_draft_list_layout_is_migrated(library):
    library.parent.mkdir(parents=True, exist_ok=True)
    library.write_text(json.dumps({"entries": [{"id": "e1", "path": "/x.bam", "kind": "bam"}]}))
    data = store.load()
    assert data["schema"] == store.SCHEMA and data["entries"]["e1"]["path"] == "/x.bam"


def test_concurrent_writers_do_not_lose_updates(tmp_path):
    bams = [make_fiberhmm_bam(tmp_path / f"{i}.bam") for i in range(8)]
    infos = [inspect.inspect_file(b) for b in bams]
    threads = [threading.Thread(target=store.record, args=(info,)) for info in infos]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert len(store.load()["entries"]) == 8


def test_a_different_file_with_the_same_header_and_size_is_not_a_move(tmp_path):
    # Review round 4: automatic relocation also required content identity.
    original = make_fiberhmm_bam(tmp_path / "old" / "big.bam", n_reads=4000)
    entry_id = store.record(inspect.inspect_file(original))["id"]
    data = bytearray(open(original, "rb").read())
    data[-200] ^= 0xFF
    os.remove(original)
    other = str(tmp_path / "new" / "big.bam")
    os.makedirs(os.path.dirname(other))
    open(other, "wb").write(bytes(data))
    info = inspect.inspect_file(other)
    assert info["identity"]["size"] == store.load()["entries"][entry_id]["identity"]["size"]
    assert store.record(info)["action"] == "added"


def _remote_info(path, digest="h" * 64, size=1000):
    return {"kind": "bam", "path": path, "folder": path.rsplit("/", 1)[0], "label": path.rsplit("/", 1)[-1],
            "remote": True, "identity": {"size": size, "mtime_ns": 0, "inode": 0, "header_sha256": digest}}


def test_remote_references_are_never_relocated_into_each_other(tmp_path):
    # Codex review of Connect to cluster: two ssh:// files with the same header digest and
    # size were merged ("relocated"), dropping the first reference and moving its notes/groups.
    first = store.record(_remote_info("ssh://host-a/project/reads.bam"))
    store.annotate(first["id"], notes="host A run")
    group = store.create_group("A", [first["id"]])
    for other in ("ssh://host-b/other/reads.bam", "ssh://me@host-a/project/reads.bam",
                  "s3://bucket/reads.bam", "https://example.org/reads.bam"):
        assert store.record(_remote_info(other))["action"] == "added", other
    data = store.load()
    assert len(data["entries"]) == 5
    assert data["entries"][first["id"]]["path"] == "ssh://host-a/project/reads.bam"
    assert data["entries"][first["id"]]["notes"] == "host A run"
    assert data["groups"][group["id"]]["entry_ids"] == [first["id"]]


def test_local_and_remote_files_never_relocate_each_other(tmp_path):
    bam = make_fiberhmm_bam(tmp_path / "a.bam")
    local = inspect.inspect_file(bam)
    local_id = store.record(local)["id"]
    os.remove(bam)  # the local file is gone...
    remote = _remote_info("ssh://host-a/a.bam", digest=local["identity"]["header_sha256"],
                          size=local["identity"]["size"])
    assert store.record(remote)["action"] == "added"  # ...but a cluster file with its header is not it
    remote_id = next(e for e in store.load()["entries"] if e != local_id)
    make_fiberhmm_bam(tmp_path / "b.bam")
    other = inspect.inspect_file(str(tmp_path / "b.bam"))
    other["identity"].update(header_sha256=remote["identity"]["header_sha256"], size=remote["identity"]["size"])
    other["identity"].pop("content_sha256", None)
    result = store.record(other)
    assert result["id"] != remote_id  # a local file never takes over the cluster reference
    assert store.load()["entries"][remote_id]["path"] == "ssh://host-a/a.bam"


# --- Review round 8: automatic relocation needs both content digests ---

@pytest.mark.parametrize("recorded,found", [("original", None), (None, "found"), (None, None)])
def test_automatic_relocation_requires_both_digests(tmp_path, recorded, found):
    def info(path, digest):
        return {"path": str(tmp_path / path), "kind": "bam",
                "identity": {"size": 100, "header_sha256": "h", "content_sha256": digest}}
    store.record(info("missing.bam", recorded))
    assert store.record(info("other.bam", found))["action"] == "added"


def test_automatic_relocation_with_equal_digests_still_works(tmp_path):
    def info(path):
        return {"path": str(tmp_path / path), "kind": "bam",
                "identity": {"size": 100, "header_sha256": "h", "content_sha256": "same"}}
    store.record(info("missing.bam"))
    assert store.record(info("other.bam"))["action"] == "relocated"
