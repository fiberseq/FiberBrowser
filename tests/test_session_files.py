import os

from services.session_files import (
    apply_path_mapping,
    check_session_files,
    file_fingerprint,
    infer_prefix_change,
    session_file_refs,
)


def _write(path, content=b"data"):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return str(path)


def _session(old_root, **extra):
    return {
        "version": "2.0",
        "datasets": [
            {"id": "a", "label": "A", "paths": [f"{old_root}/runs/a.bam"]},
            {"id": "b", "label": "B", "paths": [f"{old_root}/runs/b.bam"]},
        ],
        "orthogonal_tracks": [
            {"path": "motif://sequence/GAGA", "label": "GAF"},
            {"path": "https://example.org/signal.bw", "label": "Remote"},
        ],
        "reference": {"fasta_path": f"{old_root}/ref/genome.fa"},
        "gtf": {"path": f"{old_root}/ref/genes.gtf"},
        "frontend": {"history": [{"datasets": [{"paths": [f"{old_root}/runs/a.bam"]}]}]},
        **extra,
    }


def test_refs_skip_remote_and_motif_sources():
    refs = session_file_refs(_session("/old"))
    assert [ref["path"] for ref in refs] == [
        "/old/runs/a.bam", "/old/runs/b.bam", "/old/ref/genome.fa", "/old/ref/genes.gtf",
    ]


def test_reference_pairs_replace_joined_gtf_path():
    session = {
        "reference": {"pairs": [{"label": "dm6", "fasta": "/r/dm6.fa", "annotation": "/r/dm6.gtf"}]},
        "gtf": {"path": "/r/dm6.gtf" + os.pathsep + "/r/other.gtf"},
    }
    assert [ref["path"] for ref in session_file_refs(session)] == ["/r/dm6.fa", "/r/dm6.gtf"]


def test_infer_prefix_change_from_one_relinked_file():
    old_root, old_prefix, new_prefix = infer_prefix_change("/Users/me/data/runs/a.bam", "/home/lab/proj/runs/a.bam")
    assert old_root == "/"
    assert old_prefix == ["Users", "me", "data"]
    assert new_prefix == "/home/lab/proj"
    assert infer_prefix_change("/x/a.bam", "/y/b.bam") is None


def test_locating_one_file_relinks_the_rest(tmp_path):
    new_root = tmp_path / "moved"
    for rel in ("runs/a.bam", "runs/b.bam", "ref/genome.fa", "ref/genes.gtf"):
        _write(new_root / rel)
    session = _session("/nonexistent/old")

    before = check_session_files(session)
    assert before["missing"] == 4

    after = check_session_files(session, anchor={"old": "/nonexistent/old/runs/a.bam",
                                                  "new": str(new_root / "runs/a.bam")})
    assert after["missing"] == 0
    assert after["mapping"]["/nonexistent/old/ref/genes.gtf"] == str(new_root / "ref/genes.gtf")


def test_folder_search_prefers_fingerprint_match(tmp_path):
    original = _write(tmp_path / "orig/a.bam", b"right contents")
    session = {"datasets": [{"id": "a", "paths": ["/gone/a.bam"]}],
               "file_fingerprints": {"/gone/a.bam": file_fingerprint(original)}}
    _write(tmp_path / "search/decoy/a.bam", b"other contents")
    right = _write(tmp_path / "search/real/a.bam", b"right contents")

    result = check_session_files(session, search_root=str(tmp_path / "search"))
    assert result["mapping"] == {"/gone/a.bam": right}
    assert result["files"][0]["status"] == "ok"


def test_changed_file_is_flagged_but_not_missing(tmp_path):
    path = _write(tmp_path / "a.bam", b"new contents")
    session = {"datasets": [{"id": "a", "paths": [path]}],
               "file_fingerprints": {path: {"size": 1, "head_sha256": "old"}}}
    result = check_session_files(session)
    assert (result["missing"], result["changed"]) == (0, 1)


def test_apply_path_mapping_rewrites_every_exact_occurrence():
    session = _session("/old")
    mapped = apply_path_mapping(session, {"/old/runs/a.bam": "/new/a.bam"})
    assert mapped["datasets"][0]["paths"] == ["/new/a.bam"]
    assert mapped["frontend"]["history"][0]["datasets"][0]["paths"] == ["/new/a.bam"]
    assert mapped["datasets"][1]["paths"] == ["/old/runs/b.bam"]
    assert session["datasets"][0]["paths"] == ["/old/runs/a.bam"]


def test_same_named_file_in_another_folder_is_not_cross_linked(tmp_path):
    _write(tmp_path / "new/A/sample.bam")
    session = {"datasets": [{"id": "a", "paths": ["/old/A/sample.bam"]},
                            {"id": "b", "paths": ["/elsewhere/B/sample.bam"]}]}
    result = check_session_files(session, anchor={"old": "/old/A/sample.bam",
                                                  "new": str(tmp_path / "new/A/sample.bam")})
    assert result["mapping"] == {"/old/A/sample.bam": str(tmp_path / "new/A/sample.bam")}
    assert result["missing"] == 1


def test_ambiguous_folder_search_leaves_file_for_the_user(tmp_path):
    _write(tmp_path / "search/x/reads.bam")
    _write(tmp_path / "search/y/reads.bam")
    session = {"datasets": [{"id": "a", "paths": ["/gone/reads.bam"]}]}
    result = check_session_files(session, search_root=str(tmp_path / "search"))
    assert result["mapping"] == {}
    assert result["missing"] == 1


def test_filesystem_root_is_never_searched():
    session = {"datasets": [{"id": "a", "paths": ["/gone/reads.bam"]}]}
    assert check_session_files(session, search_root=os.path.abspath(os.sep))["mapping"] == {}


def test_windows_drive_and_unc_roots_are_kept():
    from services.session_files import _apply_prefix

    new = "C:\\data\\r.bam"
    change = infer_prefix_change("/old/x/data/r.bam", new)
    assert _apply_prefix("/old/x/data/s.bam", *change, new) == "C:\\data\\s.bam"
    unc = "\\\\srv\\share\\d\\r.bam"
    change = infer_prefix_change("/old/d/r.bam", unc)
    assert _apply_prefix("/old/d/s.bam", *change, unc) == "\\\\srv\\share\\d\\s.bam"
    change = infer_prefix_change("/srv/share/d/r.bam", unc)
    assert _apply_prefix("/srv/share/d/s.bam", *change, unc) == "\\\\srv\\share\\d\\s.bam"


def test_whole_path_shared_infers_no_folder_change():
    assert infer_prefix_change("/data/r.bam", "C:\\data\\r.bam") is None


def test_a_file_the_session_already_uses_is_not_reused_for_a_missing_one(tmp_path):
    present = _write(tmp_path / "search/sample.bam")
    session = {"datasets": [{"id": "a", "paths": [present]}, {"id": "b", "paths": ["/gone/sample.bam"]}]}
    result = check_session_files(session, search_root=str(tmp_path / "search"))
    assert result["mapping"] == {}
    assert result["missing"] == 1


def test_folder_change_only_applies_on_the_same_drive():
    from services.session_files import _apply_prefix

    change = infer_prefix_change("C:/old/data/r.bam", "E:/new/data/r.bam")
    assert _apply_prefix("C:/old/data/s.bam", *change, "E:/new/data/r.bam") == "E:/new/data/s.bam"
    assert _apply_prefix("D:/old/data/s.bam", *change, "E:/new/data/r.bam") is None


def test_relative_paths_stay_relative():
    from services.session_files import _apply_prefix

    change = infer_prefix_change("old/data/r.bam", "data/r.bam")
    assert _apply_prefix("old/data/s.bam", *change, "data/r.bam") == "data/s.bam"


def test_check_files_route_accepts_the_nulls_the_frontend_sends(client):
    # Regression: the relink dialog never appeared because null optional
    # fields were rejected with 422.
    response = client.post("/api/session/check_files", json={
        "session": {"datasets": []}, "mapping": None, "anchor": None, "search_root": None,
    })
    assert response.status_code == 200, response.text


def test_session_read_route_returns_the_json_and_rejects_other_files(client, tmp_path):
    good = tmp_path / "s.json"
    good.write_text('{"viewport": {"chrom": "chr1", "start": 0, "end": 10}, "datasets": []}')
    reply = client.post("/api/session/read", params={"path": str(good)}).json()
    assert reply["success"] and reply["session"]["viewport"]["end"] == 10
    other = tmp_path / "notes.txt"
    other.write_text("x")
    assert client.post("/api/session/read", params={"path": str(other)}).json()["success"] is False
