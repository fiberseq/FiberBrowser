import io
import os
import time

from services import upload_store
from services.upload_store import cleanup_uploads, mark_uploads_used, save_upload


def _age(path, days):
    past = time.time() - days * 86400
    os.utime(path, (past, past))


def test_upload_dir_defaults_to_user_cache_and_honors_env(monkeypatch, tmp_path):
    monkeypatch.delenv(upload_store.UPLOAD_DIR_ENV, raising=False)
    assert upload_store.upload_dir() == os.path.join(os.path.expanduser("~"), ".fiberhmm", "uploads")
    monkeypatch.setenv(upload_store.UPLOAD_DIR_ENV, str(tmp_path / "custom"))
    assert upload_store.upload_dir() == str(tmp_path / "custom")


def test_identical_redrop_reuses_existing_copy(tmp_path):
    first = save_upload(io.BytesIO(b"reads"), str(tmp_path), "sample.bam")
    _age(first, 10)
    again = save_upload(io.BytesIO(b"reads"), str(tmp_path), "sample.bam")
    assert again == first
    assert os.path.getmtime(first) > time.time() - 60  # reuse counts as use
    assert sorted(os.listdir(tmp_path)) == ["sample.bam"]


def test_different_file_with_same_name_gets_new_name(tmp_path):
    first = save_upload(io.BytesIO(b"reads"), str(tmp_path), "sample.bam")
    second = save_upload(io.BytesIO(b"other"), str(tmp_path), "sample.bam")
    third = save_upload(io.BytesIO(b"other"), str(tmp_path), "sample.bam")
    assert first.endswith("sample.bam")
    assert second.endswith("sample_1.bam")
    assert third == second


def test_cleanup_removes_unused_uploads_with_their_indexes(tmp_path):
    old = save_upload(io.BytesIO(b"old"), str(tmp_path), "old.bam")
    (tmp_path / "old.bam.bai").write_bytes(b"index")
    fresh = save_upload(io.BytesIO(b"fresh"), str(tmp_path), "fresh.bb")
    partial = tmp_path / ".x.bam.partial-abc"
    partial.write_bytes(b"half")
    for path in (old, str(tmp_path / "old.bam.bai"), str(partial)):
        _age(path, 40)

    result = cleanup_uploads(str(tmp_path), max_age_days=30)

    assert sorted(os.path.basename(p) for p in result["removed"]) == [".x.bam.partial-abc", "old.bam", "old.bam.bai"]
    assert os.listdir(tmp_path) == ["fresh.bb"]
    assert os.path.exists(fresh)


def test_cleanup_keeps_uploads_marked_used(tmp_path):
    path = save_upload(io.BytesIO(b"data"), str(tmp_path), "kept.bam")
    _age(path, 40)
    mark_uploads_used([path, "/elsewhere/not-an-upload.bam"], directory=str(tmp_path))
    assert cleanup_uploads(str(tmp_path), max_age_days=30)["removed"] == []


def test_zero_retention_disables_cleanup(tmp_path):
    path = save_upload(io.BytesIO(b"data"), str(tmp_path), "a.bam")
    _age(path, 400)
    assert cleanup_uploads(str(tmp_path), max_age_days=0)["removed"] == []


def test_cleanup_removes_orphaned_old_index(tmp_path):
    orphan = tmp_path / "gone.bam.bai"
    orphan.write_bytes(b"index")
    kept_index = tmp_path / "kept.bam.bai"
    kept_index.write_bytes(b"index")
    (tmp_path / "kept.bam").write_bytes(b"reads")
    short_index = tmp_path / "kept.bai"  # samtools also accepts x.bai for x.bam
    short_index.write_bytes(b"index")
    for path in (orphan, kept_index, short_index):
        _age(str(path), 40)
    removed = cleanup_uploads(str(tmp_path), max_age_days=30)["removed"]
    assert [os.path.basename(p) for p in removed] == ["gone.bam.bai"]


def test_upload_names_cannot_escape_the_cache(tmp_path):
    cache = tmp_path / "cache"
    stored = save_upload(io.BytesIO(b"x"), str(cache), "../../escape.bam")
    assert stored == str(cache / "escape.bam")
    assert not (tmp_path / "escape.bam").exists()
    assert upload_store.safe_upload_name("C:\\evil\\a.bai") == "a.bai"
    assert upload_store.safe_upload_name("..") == "uploaded"


def test_new_copy_never_inherits_a_stale_index(tmp_path):
    (tmp_path / "s.bam.bai").write_bytes(b"orphaned index")
    (tmp_path / "s.bai").write_bytes(b"orphaned index")
    (tmp_path / "s.csi").write_bytes(b"orphaned index")
    stored = save_upload(io.BytesIO(b"reads"), str(tmp_path), "s.bam")
    assert stored == str(tmp_path / "s.bam")
    assert not any((tmp_path / name).exists() for name in ("s.bam.bai", "s.bai", "s.csi"))


def test_reused_identical_copy_keeps_its_index(tmp_path):
    first = save_upload(io.BytesIO(b"reads"), str(tmp_path), "s.bam")
    (tmp_path / "s.bam.bai").write_bytes(b"index")
    assert save_upload(io.BytesIO(b"reads"), str(tmp_path), "s.bam") == first
    assert (tmp_path / "s.bam.bai").read_bytes() == b"index"


def test_windows_style_names_stay_inside_the_cache():
    assert upload_store.safe_upload_name("D:escape.bai") == "escape.bai"
    assert upload_store.safe_upload_name("reads.bam/") == "reads.bam"
    assert upload_store.safe_upload_name("ab:stream.bam") == "ab_stream.bam"


def test_name_claimed_by_a_concurrent_upload_is_not_overwritten(tmp_path):
    (tmp_path / "busy.bam").write_bytes(b"")  # reserved by an in-flight upload
    stored = save_upload(io.BytesIO(b"mine"), str(tmp_path), "busy.bam")
    assert stored.endswith("busy_1.bam")
    assert (tmp_path / "busy.bam").read_bytes() == b""


def test_startup_keeps_old_uploads_that_are_loaded(tmp_path, monkeypatch):
    from types import SimpleNamespace

    monkeypatch.setenv(upload_store.UPLOAD_DIR_ENV, str(tmp_path))
    loaded = save_upload(io.BytesIO(b"cli"), str(tmp_path), "cli.bam")
    unused = save_upload(io.BytesIO(b"old"), str(tmp_path), "old.bam")
    for path in (loaded, unused):
        _age(path, 40)
    footprints = save_upload(io.BytesIO(b"bb"), str(tmp_path), "contacts.bb")
    _age(footprints, 40)
    state = SimpleNamespace(datasets={"d": SimpleNamespace(paths=[loaded])}, orthogonal_tracks=[])
    upload_store.startup_upload_maintenance(state, SimpleNamespace(cool_file=None, bigbed_file=footprints))
    assert os.path.exists(loaded) and os.path.exists(footprints)
    assert not os.path.exists(unused)
