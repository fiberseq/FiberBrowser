"""Lab-server access control: regressions from the 3.0 lab security reviews.

Each test reproduces a verified finding (a member or visitor reading, writing
or starting something the lab profile promises to prevent) and checks it is
refused now; the positive cases check the legitimate use still works.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import time
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from lab_fixtures import _lab, lab, member_client  # noqa: F401

REPO = Path(__file__).resolve().parents[1]


def _bam(path: Path, *, index: bool = True) -> Path:
    import pysam
    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": "chr1", "LN": 1000}]}
    with pysam.AlignmentFile(str(path), "wb", header=header) as bam:
        read = pysam.AlignedSegment()
        read.query_name, read.query_sequence, read.flag = "r1", "A" * 20, 0
        read.reference_id, read.reference_start, read.mapping_quality, read.cigar = 0, 10, 60, [(0, 20)]
        bam.write(read)
    if index:
        pysam.index(str(path))
    return path


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


# ---------------------------------------------------------------------------
# Path canonicalisation: the same decoder as the reader, bare names, the reader itself
# ---------------------------------------------------------------------------

def test_encoded_file_urls_and_bare_names_cannot_leave_the_data_roots(lab, monkeypatch):
    (lab.outside / "secret.json").write_text('{"secret": "outside"}')
    (lab.data / "inside.json").write_text('{"ok": true}')
    alice = member_client(lab)
    encoded = f"file://{lab.data}/%2e%2e/outside/secret.json"
    assert alice.post("/api/session/read", params={"path": encoded}).status_code == 403
    monkeypatch.chdir(lab.outside)  # a bare name is a file in the server's working directory
    assert alice.post("/api/session/read", params={"path": "secret.json"}).status_code == 403
    assert alice.post("/api/session/read", params={"path": str(lab.outside / "secret.json")}).status_code == 403
    ok = alice.post("/api/session/read", params={"path": f"file://{lab.data}/inside.json"})
    assert ok.status_code == 200 and ok.json() == {"success": True, "session": {"ok": True}}
    # A bare value that names no file (a genome id, a format) is not a path.
    assert alice.get("/api/datasets", params={"reference": "hg38"}).status_code == 200


def test_file_operations_refuse_outside_paths_even_when_the_request_scan_misses_them(lab, monkeypatch):
    """The scan is defence in depth: the readers themselves confine."""
    from services.lab import paths as lab_paths
    monkeypatch.setattr(lab_paths, "scan_query", lambda _q: None)
    monkeypatch.setattr(lab_paths, "scan_body", lambda _b, _t: None)
    (lab.outside / "secret.json").write_text('{"secret": "outside"}')
    _bam(lab.outside / "hidden.bam")
    alice = member_client(lab)
    assert alice.post("/api/session/read", params={"path": str(lab.outside / "secret.json")}).status_code == 403
    assert alice.post("/api/library/watched", json={"path": str(lab.outside), "scan": False}).status_code == 403
    assert alice.post("/api/library/entries", json={"paths": [str(lab.outside / "hidden.bam")]}).status_code == 403
    added = alice.post("/api/datasets/add", json={"path": str(lab.outside / "hidden.bam")})
    assert added.status_code == 403 or not added.json().get("success")
    assert all("hidden" not in json.dumps(d) for d in alice.get("/api/datasets").json().get("datasets", []))


def test_confine_is_a_no_op_off_the_lab_profile_and_outside_member_requests(lab, tmp_path):
    from services.lab.paths import PathDenied, confine
    from services.lab.users import LabUser
    from services.runtime import lab_request_context
    outside = str(lab.outside / "secret.bam")
    assert confine(outside) == outside  # server start-up and its own background work
    with lab_request_context(user=LabUser("alice")):
        with pytest.raises(PathDenied):
            confine(outside)
        with pytest.raises(PathDenied):
            confine(str(lab.data / "sample.bam"), write=True)  # a read-only root
        assert confine(str(lab.runs / "new.bam"), write=True)
        # A URL passes only where the reader fetches URLs; to a local-file reader it is a path.
        assert confine("https://example.org/x.bam", urls=True) == "https://example.org/x.bam"
        with pytest.raises(PathDenied):
            confine("https://example.org/x.bam")


def test_bigbed_and_bigwig_opens_are_confined(lab, monkeypatch):
    import pyBigWig
    from services import bigbed_handles
    from services.lab.users import LabUser
    from services.runtime import lab_request_context
    opened = []
    monkeypatch.setattr(pyBigWig, "open", lambda path, *a: opened.append(path) or None)
    (lab.data / "y.bb").write_bytes(b"reader fixture")
    with lab_request_context(user=LabUser("alice")):
        assert bigbed_handles.get_bigbed_handle(str(lab.outside / "x.bb")) is None
        bigbed_handles.get_bigbed_handle(str(lab.data / "y.bb"))
    assert opened == [str(lab.data / "y.bb")]


def test_the_bundled_tour_dataset_still_loads_but_cannot_be_written(lab):
    from services.demo_data import DEMO_DIR
    from services.lab.paths import PathDenied, confine
    from services.lab.users import LabUser
    from services.runtime import lab_request_context
    response = member_client(lab).post("/api/demo/load").json()
    assert response["success"], response
    with lab_request_context(user=LabUser("alice")):
        with pytest.raises(PathDenied):
            confine(str(DEMO_DIR / "napa_ddda.bam"), write=True)


# ---------------------------------------------------------------------------
# The request scan fails closed
# ---------------------------------------------------------------------------

def test_the_body_scan_covers_every_content_type_a_route_parses(lab):
    alice = member_client(lab)
    body = json.dumps({"path": str(lab.outside), "scan": False}).encode()
    for headers in ({}, {"Content-Type": "text/plain"}, {"Content-Type": "application/merge-patch+json"}):
        response = alice.post("/api/library/watched", content=body, headers=headers)
        assert response.status_code == 403, headers
    unreadable = alice.post("/api/library/watched", content=b'{"path": ', headers={})
    assert unreadable.status_code == 400
    form = alice.post("/api/library/watched", content=f"path={lab.outside}".encode(),
                      headers={"Content-Type": "application/x-www-form-urlencoded"})
    assert form.status_code == 403
    listed = alice.get("/api/library").json()
    assert all(str(lab.outside) not in json.dumps(w) for w in (listed.get("watched") or []))


def test_bodies_beyond_the_scan_budgets_are_refused_not_passed_on(lab, monkeypatch):
    from services.lab import paths as lab_paths
    alice = member_client(lab)
    target = {"path": str(lab.outside), "scan": False}
    monkeypatch.setattr(lab_paths, "MAX_SCAN_BYTES", 4096)
    large = alice.post("/api/library/watched", json={**target, "padding": "x" * 8192})
    assert large.status_code == 413
    monkeypatch.setattr(lab_paths, "MAX_SCAN_BYTES", 64 << 20)
    monkeypatch.setattr(lab_paths, "_MAX_VALUES", 50)
    assert alice.post("/api/library/watched", json={"padding": ["x"] * 60, **target}).status_code == 413
    monkeypatch.setattr(lab_paths, "_MAX_VALUES", 2_000_000)
    monkeypatch.setattr(lab_paths, "_MAX_DEPTH", 8)
    nested: object = target
    for _ in range(10):
        nested = {"inner": nested}
    assert alice.post("/api/library/watched", json=nested).status_code == 413
    # Within the budgets an inside folder is accepted.
    ok = alice.post("/api/library/watched", json={"path": str(lab.data), "scan": False})
    assert ok.status_code == 200 and ok.json()["success"]


# ---------------------------------------------------------------------------
# Files served from stored data (shelf entries, run records, QC manifests)
# ---------------------------------------------------------------------------

def test_a_shelf_entry_symlinked_outside_the_sessions_folder_is_not_read(lab):
    sid = "20260930-123456-aabbccdd"
    target = lab.outside / "shelf.json"
    target.write_text(json.dumps({"schema": "fiberbrowser.lab_session.v1", "id": sid, "name": "x",
                                  "user": "alice", "session": {"secret": "shelf-outside"}}))
    folder = Path(lab.cfg.sessions_dir)
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{sid}.json").symlink_to(target)
    alice = member_client(lab)
    assert alice.get(f"/api/lab/sessions/{sid}").status_code == 404
    assert "shelf-outside" not in alice.get("/api/lab/sessions").text
    saved = alice.post("/api/lab/sessions", json={"name": "mine", "session": {"a": 1}}).json()
    assert alice.get(f"/api/lab/sessions/{saved['id']}").json()["session"] == {"a": 1}


@pytest.fixture
def lab_jobs(lab, monkeypatch):
    """Jobs enabled with a manager that never starts anything."""
    from services.lab import get_config
    from services.pipeline_jobs import JobManager
    cfg = get_config()
    cfg.jobs.enabled = True
    cfg.jobs.max_concurrent_per_user = 1
    cfg.jobs.max_concurrent_total = 4
    manager = JobManager(str(lab.tmp / "state" / "jobs"), launcher=lambda spec, d: None)
    monkeypatch.setattr(manager, "tick", lambda: None)
    monkeypatch.setattr(manager, "ensure_running", lambda: None)
    monkeypatch.setattr("routers.pipeline._manager", lambda: manager)
    monkeypatch.setattr("services.pipeline_jobs.get_job_manager", lambda: manager)
    lab.manager = manager
    return lab


def _seed_job(lab, suffix: str, status: str, *, owner: str = "alice", outputs=None) -> str:
    import services.pipeline_jobs as pj
    job_id = "20260930-123456-" + suffix
    job_dir = Path(lab.manager.root) / job_id
    job_dir.mkdir(parents=True)
    outdir = lab.runs / job_id
    outdir.mkdir(exist_ok=True)
    pj._write_json(str(job_dir / "spec.json"), {"id": job_id, "user": owner, "outdir": str(outdir),
                                               "argv": ["true"], "cores": 1})
    pj._write_json(str(job_dir / "state.json"), {"status": status, "attempt": 1, "outputs": outputs or {}})
    return job_id


def test_run_files_are_served_only_from_the_runs_own_folder(lab_jobs):
    lab = lab_jobs
    (lab.outside / "secret.html").write_text("outside-canary")
    link = lab.runs / "escape.html"
    link.symlink_to(lab.outside / "secret.html")
    escaped = _seed_job(lab, "cccccc", "done", outputs={"qc": {"plots": {"html": str(link)}}})
    real = _seed_job(lab, "dddddd", "done")
    (lab.runs / real / "report.html").write_text("inside-report")
    lab.manager._set_state(real, outputs={"qc": {"plots": {"html": str(lab.runs / real / "report.html")}}})
    alice = member_client(lab)
    refused = alice.get(f"/api/pipeline/jobs/{escaped}/files/html")
    assert refused.status_code == 404 and "outside-canary" not in refused.text
    served = alice.get(f"/api/pipeline/jobs/{real}/files/html")
    assert served.status_code == 200 and served.text == "inside-report"


def test_an_uploaded_qc_manifest_cannot_name_files_outside_the_roots(lab):
    (lab.outside / "secret.html").write_text("outside-html-canary")
    _bam(lab.tmp / "qcproof.bam", index=False)
    alice = member_client(lab)
    bam = alice.post("/api/files/upload", files={"file": ("qcproof.bam", (lab.tmp / "qcproof.bam").read_bytes())}).json()
    stem = Path(bam["path"]).name[:-4]
    manifest = json.dumps({"outputs": {"html": str(lab.outside / "secret.html")}}).encode()
    assert alice.post("/api/files/upload", files={"file": (stem + ".qc.json", manifest)}).json()["success"]
    assert alice.post("/api/library/entries", json={"paths": [bam["path"]]}).status_code == 200
    entry = next(e for e in alice.get("/api/library").json()["entries"] if e["path"] == bam["path"])
    response = alice.get(f"/api/library/entries/{entry['id']}/qc/files/html")
    assert response.status_code == 404 and "canary" not in response.text


# ---------------------------------------------------------------------------
# Writable roots at the write boundary
# ---------------------------------------------------------------------------

def test_a_member_cannot_rewrite_a_bam_in_a_read_only_root(lab):
    bam = _bam(lab.data / "shared.bam")
    before = _digest(bam)
    alice = member_client(lab)
    added = alice.post("/api/datasets/add", json={"path": str(bam)}).json()
    dataset_id = (added.get("dataset") or {}).get("id") or added.get("dataset_id") or next(
        d["id"] for d in alice.get("/api/datasets").json()["datasets"] if d["path"] == str(bam))
    response = alice.post(f"/api/datasets/{dataset_id}/chemistry",
                          json={"chemistry": "dddb", "platform": "pacbio", "persist": True}).json()
    assert not response["success"] and "read-only" in response["error"]
    assert _digest(bam) == before
    assert sorted(p.name for p in lab.data.iterdir() if p.name.startswith("shared")) == ["shared.bam", "shared.bam.bai"]


def test_no_index_or_cache_is_written_beside_files_in_a_read_only_root(lab):
    from services.dataset_endpoint import ensure_local_bam_indexes
    from services.lab.paths import PathDenied
    from services.lab.users import LabUser
    from services.pipeline_inputs import InputError, check_output_dir, default_output_root
    from services.remote_sources.opening import open_fasta
    from services.runtime import lab_request_context
    bam = _bam(lab.data / "unindexed.bam", index=False)
    (lab.data / "ref.fa").write_text(">chr1\n" + "A" * 100 + "\n")
    with lab_request_context(user=LabUser("alice")):
        refused = ensure_local_bam_indexes([str(bam)])
        assert refused and "read-only" in refused["error"]
        with pytest.raises(PathDenied):
            open_fasta(str(lab.data / "ref.fa"))  # htslib would write ref.fa.fai there
        with pytest.raises(InputError):
            check_output_dir(str(lab.data / "out"))
        with pytest.raises(InputError):
            check_output_dir("relative-out")  # the server's working directory
        assert check_output_dir(str(lab.runs / "out"))[0] == str(lab.runs / "out")
        assert default_output_root("S1").startswith(str(lab.runs.resolve()) + os.sep)
    assert not (lab.data / "unindexed.bam.bai").exists() and not (lab.data / "ref.fa.fai").exists()


def test_indexes_are_still_made_for_uploads_and_writable_roots(lab):
    """Uploads and downloaded genomes are the server's own folders: indexing there is fine."""
    from services.dataset_endpoint import ensure_local_bam_indexes
    from services.lab.users import LabUser
    from services.remote_sources.opening import open_fasta
    from services.runtime import lab_request_context
    uploads = Path(lab.cfg.uploads_dir)
    uploads.mkdir(parents=True, exist_ok=True)
    uploaded = _bam(uploads / "mine.bam", index=False)
    (lab.runs / "ref.fa").write_text(">chr1\n" + "A" * 100 + "\n")
    with lab_request_context(user=LabUser("alice")):
        assert ensure_local_bam_indexes([str(uploaded)]) is None
        open_fasta(str(lab.runs / "ref.fa")).close()
    assert (uploads / "mine.bam.bai").exists() and (lab.runs / "ref.fa.fai").exists()


# ---------------------------------------------------------------------------
# Runs: Re-call and retry honour the lab's run policy
# ---------------------------------------------------------------------------

def test_library_recall_is_refused_when_runs_are_turned_off(lab):
    alice = member_client(lab)
    for body in ({"dry_run": True, "cores": 99}, {"plan_id": "x", "cores": 1}):
        response = alice.post("/api/library/entries/missing/recall", json=body)
        assert response.status_code == 403 and "turned off" in response.json()["detail"]
    # The rest of the Library stays available.
    assert alice.get("/api/library").status_code == 200


def test_retry_counts_as_a_new_submission_for_the_limits(lab_jobs):
    lab = lab_jobs
    active = _seed_job(lab, "aaaaaa", "queued")
    failed = _seed_job(lab, "bbbbbb", "error")
    alice, bob = member_client(lab, "alice"), member_client(lab, "bob")
    assert bob.post(f"/api/pipeline/jobs/{failed}/retry").status_code == 403
    refused = alice.post(f"/api/pipeline/jobs/{failed}/retry")
    assert refused.status_code == 429 and "1 run(s) queued or running" in refused.json()["detail"]
    assert lab.manager.state(failed)["status"] == "error"
    alice.post(f"/api/pipeline/jobs/{active}/cancel")
    assert alice.post(f"/api/pipeline/jobs/{failed}/retry").status_code == 200
    assert lab.manager.state(failed)["status"] == "queued"


def test_job_admission_is_checked_under_the_registry_lock(tmp_path):
    from services.pipeline_jobs import JobManager, JobRefused
    manager = JobManager(str(tmp_path / "jobs"), launcher=lambda spec, d: None)
    manager.ensure_running = lambda: None
    with pytest.raises(JobRefused, match="full"):
        manager.create({"argv": ["true"]}, admit=lambda: "full")
    assert manager.job_ids() == []
    seen = []
    job = manager.create({"argv": ["true"]}, admit=lambda: seen.append(manager._registry_depth) or None)
    assert seen == [1] and manager.job_ids() == [job["id"]]


# ---------------------------------------------------------------------------
# Contact maps (DAF-C) belong to the member who loaded them
# ---------------------------------------------------------------------------

@pytest.fixture
def catalog_lab(tmp_path, standalone_app, monkeypatch):
    (tmp_path / "catalog.json").write_text(json.dumps({"groups": []}))
    yield from _lab(tmp_path, standalone_app, monkeypatch,
                    public_catalog={"enabled": True, "catalog": str(tmp_path / "catalog.json")})


def test_a_members_contact_map_is_not_shown_to_visitors_or_other_members(catalog_lab):
    cooler = pytest.importorskip("cooler")
    import pandas as pd
    lab = catalog_lab
    cool = lab.data / "private.cool"
    cooler.create_cooler(str(cool), pd.DataFrame({"chrom": ["private_chrom"] * 2, "start": [0, 100], "end": [100, 200]}),
                         pd.DataFrame({"bin1_id": [0, 0, 1], "bin2_id": [0, 1, 1], "count": [7, 13, 5]}))
    anon = TestClient(lab.app)
    alice, bob = member_client(lab, "alice"), member_client(lab, "bob")
    assert alice.post("/api/dafc/load", params={"cool_file": str(cool)}).status_code == 200
    assert alice.get("/api/dafc/status").json()["cool_file"] == str(cool)
    for other in (anon, bob):
        status = other.get("/api/dafc/status").json()
        assert not status["loaded"] and status["cool_file"] is None
        matrix = other.get("/api/dafc/matrix/data", params={"chrom": "private_chrom", "start": 0, "end": 200,
                                                             "resolution": 100})
        assert matrix.status_code != 200 and "13" not in matrix.text
    outside = lab.outside / "outside.cool"
    shutil.copy(cool, outside)
    assert alice.post("/api/dafc/load", params={"cool_file": str(outside)}).status_code == 403


# ---------------------------------------------------------------------------
# Workspaces belong to a member and are never created by a page load
# ---------------------------------------------------------------------------

@pytest.fixture
def lab_workspaces(lab):
    import server as srv
    from state.workspace import WorkspaceManager, get_workspace_manager, set_workspace_manager
    previous = get_workspace_manager()
    manager = WorkspaceManager(template=srv.state)
    set_workspace_manager(manager)
    try:
        yield manager
    finally:
        for workspace_id in list(manager.sessions):
            manager.drop(workspace_id)
        set_workspace_manager(previous)


def test_a_page_load_never_creates_a_lab_workspace(lab, lab_workspaces, tmp_path):
    """(Personal servers keep /?workspace=new: tests/test_workspaces.py.)"""
    from fastapi import FastAPI
    from services.frontend_mount import mount_frontend
    from state.sandbox import install_sandbox_middleware
    dist = tmp_path / "site" / "frontend" / "dist"
    dist.mkdir(parents=True)
    (dist / "index.html").write_text("<html><head></head><body></body></html>")
    app = FastAPI()
    mount_frontend(app, str(tmp_path / "site"), public_mode=False)
    install_sandbox_middleware(app)
    page = TestClient(app, follow_redirects=False).get("/?workspace=new")
    assert page.status_code == 405 and not lab_workspaces.sessions


def test_lab_workspaces_are_created_by_post_and_owned_by_their_member(lab, lab_workspaces):
    alice, bob = member_client(lab, "alice"), member_client(lab, "bob")
    created = alice.post("/api/workspaces").json()
    workspace_id = created["id"]
    assert alice.get("/api/workspaces").json()["workspaces"] == [workspace_id]
    assert bob.get("/api/workspaces").json()["workspaces"] == []
    assert bob.get("/api/status", params={"workspace": workspace_id}).status_code == 410
    assert bob.get(f"/api/workspaces/{workspace_id}").json()["active"] is False
    assert bob.delete(f"/api/workspaces/{workspace_id}").json()["ended"] is False
    assert alice.get("/api/status", params={"workspace": workspace_id}).status_code == 200
    assert alice.delete(f"/api/workspaces/{workspace_id}").json()["ended"] is True


# ---------------------------------------------------------------------------
# Cookies follow the configured Secure policy
# ---------------------------------------------------------------------------

@pytest.fixture
def secure_none_lab(tmp_path, standalone_app, monkeypatch):
    yield from _lab(tmp_path, standalone_app, monkeypatch,
                    auth={"mode": "none", "user": "jd", "secure_cookies": "always"})


def test_launch_token_and_render_cookies_follow_the_secure_policy(secure_none_lab, monkeypatch):
    from services import local_auth
    from services.lab.auth import with_render_identity
    from services.lab.users import LabUser
    from services.runtime import lab_request_context
    monkeypatch.setattr(local_auth, "_enabled", True)
    monkeypatch.setattr(local_auth, "_token", "launch-token")
    client = TestClient(secure_none_lab.app)
    signin = client.post("/auth/token", data={"token": "launch-token"}, follow_redirects=False)
    assert signin.status_code == 303 and "secure" in signin.headers["set-cookie"].lower()
    via_query = TestClient(secure_none_lab.app).get("/api/datasets", params={"token": "launch-token"})
    assert all("secure" in c.lower() for c in via_query.headers.get_list("set-cookie"))
    with lab_request_context(user=LabUser("jd", role="admin")):
        url = with_render_identity("/api/datasets")
    rendered = TestClient(secure_none_lab.app, headers={"X-FiberBrowser-Token": "launch-token"}).get(url)
    cookies = [c for c in rendered.headers.get_list("set-cookie") if c.startswith("fiberbrowser_render=")]
    assert cookies and "secure" in cookies[0].lower()


def test_visitor_session_cookie_follows_the_secure_policy(tmp_path, standalone_app, monkeypatch):
    (tmp_path / "catalog.json").write_text(json.dumps({"groups": []}))
    for lab in _lab(tmp_path, standalone_app, monkeypatch, auth={"secure_cookies": "always"},
                    public_catalog={"enabled": True, "catalog": str(tmp_path / "catalog.json")}):
        response = TestClient(lab.app).get("/api/datasets")
        sid = [c for c in response.headers.get_list("set-cookie") if c.startswith("fiberhmm_sid=")]
        assert sid and "secure" in sid[0].lower()


# ---------------------------------------------------------------------------
# OPTIONS and forwarded origin metadata
# ---------------------------------------------------------------------------

def test_every_method_is_authenticated_including_options(lab):
    anon = TestClient(lab.app)
    for path in ("/api/datasets", "/api/admin/users", "/api/datasets/"):
        assert anon.options(path).status_code == 401


@pytest.fixture
def trusted_proxy_lab(tmp_path, standalone_app, monkeypatch):
    yield from _lab(tmp_path, standalone_app, monkeypatch, auth={"trusted_proxies": ["10.1.2.3"]})


def test_forwarded_host_is_believed_only_from_a_trusted_proxy(trusted_proxy_lab):
    from services.request_origin_guard import request_allowed
    headers = {"host": "node7:8911", "origin": "https://evil.example", "x-forwarded-host": "evil.example",
               "x-forwarded-proto": "https"}
    assert request_allowed(headers, "/api/status", peer="127.0.0.1") == "Cross-origin request"
    assert request_allowed(headers, "/api/status", peer="10.1.2.3") is None


def test_forwarded_host_is_not_believed_on_a_lab_server_without_a_proxy_list(lab):
    """A lab server believes forwarded metadata only from an explicitly listed proxy;
    behind Open OnDemand (no list) the browser's Fetch Metadata lets its requests in."""
    from services.request_origin_guard import request_allowed
    headers = {"host": "node7:8911", "origin": "https://ondemand.example.edu",
               "x-forwarded-host": "ondemand.example.edu", "x-forwarded-proto": "https"}
    assert request_allowed(headers, "/api/status", peer="10.9.9.9") == "Cross-origin request"
    assert request_allowed({**headers, "sec-fetch-site": "same-origin"}, "/api/status", peer="10.9.9.9") is None
    alice = member_client(lab)
    response = alice.get("/api/datasets", headers={"X-Forwarded-Proto": "https"})
    assert response.status_code == 200  # untrusted X-Forwarded-Proto doesn't make cookies Secure
    from services.lab.auth import cookies_secure
    from starlette.requests import Request
    scope = {"type": "http", "scheme": "http", "headers": [(b"x-forwarded-proto", b"https")],
             "client": ("10.9.9.9", 1), "path": "/", "query_string": b""}
    assert cookies_secure(Request(scope)) is False


def test_library_reveal_is_not_available_on_a_lab_server(lab):
    """It opens a file manager on the server's own screen."""
    alice = member_client(lab)
    response = alice.post("/api/library/entries/missing/reveal")
    assert response.status_code == 403 and "not available on a shared lab server" in response.json()["message"]


# ---------------------------------------------------------------------------
# Open OnDemand: the setup box runs before the Apptainer check
# ---------------------------------------------------------------------------

@pytest.mark.skipif(shutil.which("ruby") is None, reason="ruby (ERB) not installed")
def test_ondemand_setup_box_can_load_apptainer_for_an_image(tmp_path):
    render = REPO / "deploy" / "ondemand" / "dev" / "render.rb"
    template = REPO / "deploy" / "ondemand" / "fiberbrowser" / "template" / "script.sh.erb"
    modules = tmp_path / "modules"
    modules.mkdir()
    fake = modules / "apptainer"
    fake.write_text('#!/usr/bin/env bash\necho "apptainer $*"\n')
    fake.chmod(0o755)
    (tmp_path / "data").mkdir()
    values = {"lab_data_dir": str(tmp_path / "data"), "run_output_dir": "", "lab_state_dir": "",
              "fiberbrowser_image": str(tmp_path / "fiberbrowser.sif"), "enable_runs": "0", "num_cores": "1",
              "fiberbrowser_setup": f'export PATH="{modules}:$PATH"  # module load apptainer'}
    script = subprocess.run(["ruby", str(render), str(template), json.dumps(values)], capture_output=True,
                            text=True, timeout=60, check=True).stdout
    session = tmp_path / "session"
    session.mkdir()
    (session / "script.sh").write_text(script)
    env = {"PATH": "/usr/bin:/bin", "HOME": str(tmp_path), "USER": "tester",
           "host": "node7", "port": "8911", "password": "p"}
    result = subprocess.run(["bash", "script.sh"], cwd=session, capture_output=True, text=True, timeout=60, env=env)
    assert result.returncode == 0, result.stderr
    assert "apptainer exec --cleanenv" in result.stdout and "fiberbrowser serve --config" in result.stdout


# ===========================================================================
# Round 2 (verification of the fixes above)
# ===========================================================================

def _as_alice():
    from services.lab.users import LabUser
    from services.runtime import lab_request_context
    return lab_request_context(user=LabUser("alice"))


def test_recall_refuses_inputs_its_stored_run_metadata_puts_outside_the_roots(lab, monkeypatch):
    from library_fixtures import make_pipeline_run, seq
    from services import library_inspect as inspect
    from services import library_jobs as jobs
    from services import library_store as store
    monkeypatch.setenv("FIBERBROWSER_PIPELINE_COMMAND", "fiberhmm-pipeline")
    run = make_pipeline_run(lab.data / "recall", sample="S1", plasmid_seq=seq(4))

    def entry():
        entry_id = store.record(inspect.inspect_file(run["called_bam"]))["id"]
        return store.load()["entries"][entry_id]

    with _as_alice():
        plan = jobs.plan_recall(entry(), outdir=str(lab.runs / "recall"))
        assert plan["reads"] == [run["aligned_bam"]]
    private = lab.outside / "aligned-private.bam"
    shutil.copy(run["aligned_bam"], private)
    manifest_path = lab.data / "recall" / "outputs.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["aligned_bam"] = str(private)
    manifest_path.write_text(json.dumps(manifest))
    with _as_alice():
        with pytest.raises(ValueError, match="outside the lab's data folders"):
            jobs.plan_recall(entry(), outdir=str(lab.runs / "recall"))


def test_retry_revalidates_stored_cores_and_output_folder(lab_jobs):
    lab = lab_jobs
    alice = member_client(lab)
    greedy = _seed_job(lab, "a1a1a1", "error")
    spec_path = Path(lab.manager.root) / greedy / "spec.json"
    spec = json.loads(spec_path.read_text())
    spec["cores"] = 99
    spec_path.write_text(json.dumps(spec))
    refused = alice.post(f"/api/pipeline/jobs/{greedy}/retry")
    assert refused.status_code == 429 and "99 cores" in refused.json()["detail"]
    stale = _seed_job(lab, "b2b2b2", "error")
    spec_path = Path(lab.manager.root) / stale / "spec.json"
    spec = json.loads(spec_path.read_text())
    spec["outdir"] = str(lab.data / "old-output")
    spec_path.write_text(json.dumps(spec))
    refused = alice.post(f"/api/pipeline/jobs/{stale}/retry")
    assert refused.status_code == 429 and "writable" in refused.json()["detail"]
    assert not (lab.data / "old-output").exists() and lab.manager.state(stale)["status"] == "error"


def test_a_queued_run_is_checked_again_when_it_starts(lab_jobs):
    lab = lab_jobs
    queued = _seed_job(lab, "c3c3c3", "queued")
    spec_path = Path(lab.manager.root) / queued / "spec.json"
    spec = json.loads(spec_path.read_text())
    spec["reads"] = [str(lab.outside / "secret.bam")]
    spec_path.write_text(json.dumps(spec))
    launched = []
    lab.manager._launcher = lambda spec, job_dir: launched.append(spec)
    with lab.manager._registry():
        lab.manager._start(queued)
    state = lab.manager.state(queued)
    assert not launched and state["status"] == "error" and "outside" in state["error"]


def test_job_logs_and_records_are_read_only_from_the_jobs_own_folder(lab_jobs):
    lab = lab_jobs
    (lab.outside / "log-secret.txt").write_text("outside-job-log-canary")
    job_id = _seed_job(lab, "d4d4d4", "done")
    (Path(lab.manager.root) / job_id / "log").symlink_to(lab.outside / "log-secret.txt")
    alice = member_client(lab)
    response = alice.get(f"/api/pipeline/jobs/{job_id}/log")
    assert response.status_code == 404 and "canary" not in response.text  # refused, not an empty log
    (Path(lab.manager.root) / job_id / "log").unlink()
    (Path(lab.manager.root) / job_id / "log").write_text("real log")
    assert alice.get(f"/api/pipeline/jobs/{job_id}/log").text == "real log"


def test_bam_header_and_companion_paths_outside_the_roots_are_never_read(lab):
    import pysam
    from services.plasmid_maps import parse_plasmid_map
    from services.plasmid_reconcile import _file_sha256, reference_fasta_candidates
    outside_fa = lab.outside / "private-reference.fa"
    outside_fa.write_text(">private_contig\n" + "C" * 100 + "\n")
    inside_fa = lab.data / "inside.fa"
    inside_fa.write_text(">private_contig\n" + "A" * 100 + "\n")
    header = {"SQ": [{"SN": "private_contig", "LN": 100, "UR": str(outside_fa)}],
              "CO": [f"FIBERHMM-REFERENCE:v1:contig=private_contig;fasta={inside_fa}"]}
    bam = lab.data / "header.bam"
    (lab.data / "companion.bed").write_text("companion_secret\t0\t10\tfeature\n")
    (lab.outside / "companion-secret.fa").write_text(">companion_secret\n" + "ACGT" * 30 + "\n")
    (lab.data / "companion.fa").symlink_to(lab.outside / "companion-secret.fa")
    with _as_alice():
        found = reference_fasta_candidates(header, str(bam))
        assert str(outside_fa) not in found and str(inside_fa) in found
        with pytest.raises(ValueError, match="same-name FASTA"):
            parse_plasmid_map(str(lab.data / "companion.bed"))
        with pytest.raises(PermissionError):
            _file_sha256(str(outside_fa))
    # Off the lab profile's requests, as before.
    assert str(outside_fa) in reference_fasta_candidates(header, str(bam))


def test_reads_by_descriptor_close_the_check_to_open_window(lab, monkeypatch):
    """A file or folder swapped for a link after the check is not followed."""
    from routers.sessions import read_session_file
    from services.lab import paths
    safe = lab.data / "race.json"
    safe.write_text('{"secret": "safe"}')
    (lab.outside / "race-secret.json").write_text('{"secret": "outside-race-canary"}')
    original = paths.check

    def swap(path, **kwargs):
        result = original(path, **kwargs)
        if str(path) == str(safe) and not safe.is_symlink():
            safe.unlink()
            safe.symlink_to(lab.outside / "race-secret.json")
        return result
    monkeypatch.setattr(paths, "check", swap)
    with _as_alice():
        result = read_session_file(str(safe))
    assert "outside-race-canary" not in json.dumps(result)
    monkeypatch.setattr(paths, "check", original)

    parent = lab.data / "parent"
    parent.mkdir()
    (parent / "report.html").write_text("safe")
    (lab.outside / "parent").mkdir()
    (lab.outside / "parent" / "report.html").write_text("outside-parent-race-canary")
    best = paths._best_root

    def swap_parent(real, roots):
        root = best(real, roots)
        if parent.is_dir() and not parent.is_symlink():
            parent.rename(lab.data / "parent.saved")
            parent.symlink_to(lab.outside / "parent")
        return root
    monkeypatch.setattr(paths, "_best_root", swap_parent)
    assert paths.open_confined(str(parent / "report.html"), [str(lab.data)]) is None


def test_stored_file_opens_never_wait_on_a_fifo(lab):
    import sys as _sys
    fifo = lab.data / "stored-fifo.json"
    os.mkfifo(fifo)
    command = ("import sys; from services.lab.paths import open_confined; "
               "print(open_confined(sys.argv[1], [sys.argv[2]], lab_roots=False), flush=True)")
    env = {**os.environ, "PYTHONPATH": os.pathsep.join([str(REPO / "browser"), os.environ.get("PYTHONPATH", "")])}
    result = subprocess.run([_sys.executable, "-c", command, str(fifo), str(lab.data)], capture_output=True,
                            text=True, timeout=30, env=env)
    assert result.stdout.strip() == "None", result.stderr


def test_fasta_and_bam_indexes_are_confined_too(lab):
    import pysam
    from services.lab.paths import PathDenied
    from services.remote_sources.opening import open_alignment_file, open_fasta
    plain = lab.tmp / "reference.fa"
    plain.write_text(">chr1\n" + "A" * 1000 + "\n")
    gz = lab.data / "reference.fa.gz"
    pysam.tabix_compress(str(plain), str(gz), force=True)
    pysam.faidx(str(gz))
    Path(str(gz) + ".gzi").unlink()
    fa = lab.data / "index-proof.fa"
    fa.write_text(">index_secret\nACGT\n")
    (lab.outside / "index-secret.fai").write_text("index_secret\t4\t14\t4\t5\n")
    Path(str(fa) + ".fai").symlink_to(lab.outside / "index-secret.fai")
    bam = _bam(lab.data / "escaped-index.bam", index=False)
    other = _bam(lab.outside / "other.bam")
    Path(str(bam) + ".bai").symlink_to(Path(str(other) + ".bai"))
    with _as_alice():
        with pytest.raises(PathDenied):
            open_fasta(str(gz))  # htslib would write reference.fa.gz.gzi into a read-only root
        with pytest.raises(PathDenied):
            open_fasta(str(fa))  # its .fai resolves outside the roots
        with pytest.raises(PathDenied):
            open_alignment_file(str(bam))
    assert not Path(str(gz) + ".gzi").exists()


def test_session_relinking_never_compares_files_outside_the_roots(lab):
    import hashlib as _hashlib
    folder = lab.data / "search"
    folder.mkdir()
    target = lab.outside / "hash-secret.bam"
    target.write_bytes(b"outside-fingerprint-canary")
    (folder / "missing.bam").symlink_to(target)
    original = str(lab.data / "original" / "missing.bam")
    fingerprint = {"size": len(target.read_bytes()), "head_sha256": _hashlib.sha256(target.read_bytes()).hexdigest()}
    alice = member_client(lab)
    statuses = []
    for digest in (fingerprint["head_sha256"], "0" * 64):
        body = {"session": {"datasets": [{"paths": [original]}],
                            "file_fingerprints": {original: {**fingerprint, "head_sha256": digest}}},
                "search_root": str(folder)}
        statuses.append(alice.post("/api/session/check_files", json=body).json()["files"][0]["status"])
    assert statuses == ["missing", "missing"]


def test_a_url_looking_name_is_a_local_path_to_a_local_file_reader(lab, monkeypatch):
    from services.figure_render import read_session_path
    from services.lab import paths
    monkeypatch.chdir(lab.tmp)
    (lab.tmp / "odd:").mkdir()
    (lab.tmp / "odd:" / "session.json").write_text('{"datasets": [{"id": "outside-decoder-canary"}]}')
    assert paths.scan_json_body(json.dumps({"session_path": "odd://session.json"}).encode())
    with _as_alice():
        with pytest.raises(paths.PathDenied):
            read_session_path("odd://session.json")
        assert paths.confine("https://example.org/x.bam", urls=True)


def test_lab_run_downloads_keep_range_requests(lab_jobs):
    lab = lab_jobs
    job_id = _seed_job(lab, "e5e5e5", "done")
    report = lab.runs / job_id / "report.html"
    report.write_text("0123456789" * 10)
    lab.manager._set_state(job_id, outputs={"qc": {"plots": {"html": str(report)}}})
    alice = member_client(lab)
    whole = alice.get(f"/api/pipeline/jobs/{job_id}/files/html")
    assert whole.status_code == 200 and whole.headers.get("etag") and whole.headers.get("accept-ranges") == "bytes"
    part = alice.get(f"/api/pipeline/jobs/{job_id}/files/html", headers={"Range": "bytes=5-9"})
    assert part.status_code == 206 and part.content == b"56789"


def test_personal_servers_serve_run_files_as_before(tmp_path, standalone_app, monkeypatch):
    """Off the lab profile: whatever the run's QC lists (even outside its folder), via FileResponse."""
    import services.pipeline_jobs as pj
    from services.local_auth import auth_headers
    from services.pipeline_jobs import JobManager
    manager = JobManager(str(tmp_path / "jobs"), launcher=lambda spec, d: None)
    monkeypatch.setattr(manager, "tick", lambda: None)
    monkeypatch.setattr(manager, "ensure_running", lambda: None)
    monkeypatch.setattr("routers.pipeline._manager", lambda: manager)
    elsewhere = tmp_path / "elsewhere" / "report.html"
    elsewhere.parent.mkdir()
    elsewhere.write_text("0123456789" * 10)
    job_id = "20260930-123456-f6f6f6"
    (tmp_path / "jobs" / job_id).mkdir(parents=True)
    pj._write_json(str(tmp_path / "jobs" / job_id / "spec.json"),
                   {"id": job_id, "outdir": str(tmp_path / "run"), "argv": ["true"]})
    pj._write_json(str(tmp_path / "jobs" / job_id / "state.json"),
                   {"status": "done", "outputs": {"qc": {"plots": {"html": str(elsewhere)}}}})
    client = TestClient(standalone_app, headers=auth_headers())
    whole = client.get(f"/api/pipeline/jobs/{job_id}/files/html")
    assert whole.status_code == 200 and whole.text == "0123456789" * 10
    part = client.get(f"/api/pipeline/jobs/{job_id}/files/html", headers={"Range": "bytes=0-3"})
    assert part.status_code == 206 and part.content == b"0123"


# ===========================================================================
# Round 3
# ===========================================================================

def test_files_named_inside_call_args_are_confined(lab, monkeypatch):
    from library_fixtures import make_pipeline_run, seq
    from services import library_inspect as inspect
    from services import library_jobs as jobs
    from services import library_store as store
    from services.lab.jobs import spec_refusal
    from services.pipeline_inputs import run_option_paths
    monkeypatch.setenv("FIBERBROWSER_PIPELINE_COMMAND", "fiberhmm-pipeline")
    run = make_pipeline_run(lab.data / "recall", plasmid_seq=seq(4))
    external = lab.outside / "model.tsv"
    external.write_text("model-canary")
    manifest = Path(run["called_bam"]).parent / "outputs.json"

    def plan_with(call_args):
        data = json.loads(manifest.read_text())
        data["settings"]["call_args"] = call_args
        manifest.write_text(json.dumps(data))
        entry_id = store.record(inspect.inspect_file(run["called_bam"]))["id"]
        return jobs.plan_recall(store.load()["entries"][entry_id], outdir=str(lab.runs / "recall"))

    with _as_alice():
        assert plan_with(["--min-llr", "6"])  # options without files still plan
        for call_args in (["-m", str(external)], [f"-m{external}"], [f"--model={external}"]):
            with pytest.raises(ValueError, match="outside the lab's data folders"):
                plan_with(call_args)
    stored = {"cores": 1, "outdir": str(lab.runs / "recall"),
              "library_recall": {"extra": ["--call-args", f"-m {external}"]}}
    assert "outside" in (spec_refusal(stored) or "")
    assert (str(external), True) in run_option_paths(["--call-args", f"--model {external} --min-llr 6"], "/")


def test_a_stored_dafc_dataset_is_confined_when_reopened(lab):
    cooler = pytest.importorskip("cooler")
    import pandas as pd
    import pysam
    from library_fixtures import make_bam
    bam = lab.data / "reads.bam"
    make_bam(bam, contigs=(("chr1", 1000),))
    secret = lab.outside / "secret.bam"
    make_bam(secret, contigs=(("chr1", 1000),))
    renamed = lab.outside / "renamed.bam"
    with pysam.AlignmentFile(str(secret), "rb") as src, pysam.AlignmentFile(str(renamed), "wb", header=src.header) as dst:
        for read in src:
            read.query_name = "outside-dafc-canary"
            dst.write(read)
    renamed.rename(secret)
    pysam.index(str(secret))
    cool = lab.data / "contact.cool"
    cooler.create_cooler(str(cool), pd.DataFrame({"chrom": ["chr1"] * 10, "start": list(range(0, 1000, 100)),
                                                  "end": list(range(100, 1100, 100))}),
                         pd.DataFrame({"bin1_id": [0], "bin2_id": [0], "count": [1]}))
    alice = member_client(lab)
    assert alice.post("/api/datasets/add", json={"path": str(bam)}).json()["success"]
    assert alice.post("/api/dafc/load", params={"cool_file": str(cool)}).status_code == 200
    bam.unlink()
    bam.symlink_to(secret)
    index = Path(str(bam) + ".bai")
    index.unlink()
    index.symlink_to(Path(str(secret) + ".bai"))
    response = alice.get("/api/dafc/select", params={"chrom": "chr1", "x_start": 100, "x_end": 140,
                                                    "y_start": 120, "y_end": 160})
    assert "outside-dafc-canary" not in response.text


def test_a_job_folder_that_is_a_link_is_not_followed(lab):
    from services.pipeline_jobs import JobManager
    registry = lab.tmp / "registry"
    registry.mkdir()
    elsewhere = lab.outside / "job"
    elsewhere.mkdir()
    job_id = "20260930-120000-abcdef"
    (registry / job_id).symlink_to(elsewhere, target_is_directory=True)
    (elsewhere / "log").write_text("outside-whole-job-canary")
    (elsewhere / "spec.json").write_text(json.dumps({"id": job_id, "argv": ["true"]}))
    manager = JobManager(root=str(registry))
    assert manager.read_log(job_id) == ""
    with pytest.raises(PermissionError):
        manager.read_log(job_id, strict=True)
    with pytest.raises(KeyError):
        manager.spec(job_id)


def test_a_bgzf_fasta_is_recognised_by_content_not_name(lab):
    import pysam
    from services.lab.paths import PathDenied
    from services.remote_sources.opening import open_fasta
    plain = lab.tmp / "plain.fa"
    plain.write_text(">chr1\n" + "A" * 1000 + "\n")
    compressed = lab.data / "compressed.fa"
    pysam.tabix_compress(str(plain), str(compressed), force=True)
    pysam.faidx(str(compressed))
    gzi = Path(str(compressed) + ".gzi")
    gzi.unlink()
    with _as_alice():
        with pytest.raises(PathDenied):
            open_fasta(str(compressed))
    assert not gzi.exists()


def test_configured_roots_are_pinned_by_identity(lab, monkeypatch):
    from services.lab import paths
    from services.lab.paths import PathDenied, open_read
    (lab.data / "x").write_text("safe")
    (lab.outside / "x").write_text("outside-retarget-canary")
    with _as_alice():
        with open_read(lab.data / "x") as handle:
            assert handle.read() == b"safe"
    lab.data.rename(lab.tmp / "data.saved")
    lab.data.symlink_to(lab.outside, target_is_directory=True)
    with _as_alice():
        with pytest.raises(PathDenied):
            open_read(lab.data / "x")
    # A folder moved away and replaced by another real folder is not the root either.
    lab.data.unlink()
    lab.data.mkdir()
    (lab.data / "x").write_text("replacement")
    with _as_alice():
        with pytest.raises(PathDenied):
            open_read(lab.data / "x")


def test_an_ancestor_swapped_during_the_walk_is_refused(lab, monkeypatch):
    from services.lab import paths
    ancestor = lab.tmp / "anchor"
    root = ancestor / "root"
    root.mkdir(parents=True)
    (root / "x").write_bytes(b"safe")
    (lab.outside / "anchor" / "root").mkdir(parents=True)
    (lab.outside / "anchor" / "root" / "x").write_bytes(b"outside-root-anchor-canary")
    original = os.open

    def swapped(name, flags, *args, **kwargs):
        if name == "anchor" and kwargs.get("dir_fd") is not None and not ancestor.is_symlink():
            ancestor.rename(lab.tmp / "anchor.saved")
            ancestor.symlink_to(lab.outside / "anchor", target_is_directory=True)
        return original(name, flags, *args, **kwargs)
    monkeypatch.setattr(os, "open", swapped)
    monkeypatch.setattr(os, "supports_dir_fd", os.supports_dir_fd | {swapped})
    assert paths.open_confined(str(root / "x"), [str(root)], lab_roots=False) is None


def test_native_openers_read_the_files_that_were_checked(lab, monkeypatch):
    import pysam
    from services.lab import paths
    from services.remote_sources.opening import open_alignment_file, open_fasta
    fasta = lab.data / "ref.fa"
    fasta.write_text(">chr1\nAAAA\n")
    pysam.faidx(str(fasta))
    outside = lab.outside / "ref.fa"
    outside.write_text(">chr1\nTGCA\n")
    pysam.faidx(str(outside))
    bam = _bam(lab.data / "native.bam")
    with _as_alice():
        with open_fasta(str(fasta)) as handle:
            assert handle.fetch("chr1") == "AAAA"
        with open_alignment_file(str(bam)) as handle:
            assert [r.query_name for r in handle.fetch("chr1", 0, 100)] == ["r1"]
    original = paths.confine_fasta

    def swap_after_check(path, kwargs):
        original(path, kwargs)
        fasta.unlink()
        fasta.symlink_to(outside)
    monkeypatch.setattr(paths, "confine_fasta", swap_after_check)
    with _as_alice():
        with pytest.raises(paths.PathDenied):
            open_fasta(str(fasta))


def test_the_annotation_cache_is_read_and_written_only_as_its_own_file(lab):
    from services.gene_annotations import load_gtf
    gtf = lab.runs / "genes.gtf"
    gtf.write_text('chr1\tx\ttranscript\t1\t20\t.\t+\t.\tgene_id "g"; transcript_id "t"; gene_name "inside"; '
                   'gene_biotype "protein_coding";\n')
    victim = lab.outside / "victim.txt"
    victim.write_text("before")
    with _as_alice():
        load_gtf(str(gtf))
    assert victim.read_text() == "before"
    from services.gene_annotations import annotation_cache_path
    cache = Path(annotation_cache_path(str(gtf)))
    secret = lab.outside / "secret.json"
    secret.write_text(cache.read_text().replace('"inside"', '"outside-cache-canary"'))
    cache.unlink()
    cache.symlink_to(secret)
    # An older version's companion beside the file is read too: the same guard applies to it.
    legacy = Path(str(gtf) + ".fbcache.json")
    legacy.symlink_to(secret)
    with _as_alice():
        result = load_gtf(str(gtf))
    assert "outside-cache-canary" not in json.dumps(result["transcripts"]["gene_name"].tolist())


# ===========================================================================
# Round 4
# ===========================================================================

_JASPAR = ">MA0001.1 TEST\nA [ 1 0 0 0 ]\nC [ 0 1 0 0 ]\nG [ 0 0 1 0 ]\nT [ 0 0 0 1 ]\n"


def test_motif_database_files_are_read_through_the_confined_open(lab):
    from services.lab.paths import PathDenied
    from services.motifs import parse_jaspar_file
    inside = lab.data / "motifs.jaspar"
    inside.write_text(_JASPAR)
    (lab.outside / "private.jaspar").write_text(_JASPAR.replace("TEST", "OUTSIDE"))
    linked = lab.data / "linked.jaspar"
    linked.symlink_to(lab.outside / "private.jaspar")
    with _as_alice():
        assert list(parse_jaspar_file(str(inside)))
        for path in (lab.outside / "private.jaspar", linked):
            with pytest.raises(PathDenied):
                parse_jaspar_file(str(path))
    # Off the lab profile's requests (and on personal servers), plain open as before.
    assert list(parse_jaspar_file(str(linked)))
    alice = member_client(lab)
    response = alice.post("/api/tracks/add_motif_file", json={"file_path": str(linked)})
    assert response.status_code == 403 or not response.json().get("success")
    assert "OUTSIDE" not in response.text
