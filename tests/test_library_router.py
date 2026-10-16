"""Library routes: local only, entry actions, catalog export round trip, and
the hook that records the datasets a user opens."""
from __future__ import annotations

import os
import sys

import pytest

from library_fixtures import make_fiberhmm_bam, make_pipeline_run, seq, write_map, write_qc_json
from services import library_hooks
from services import library_store as store


@pytest.fixture(autouse=True)
def env(tmp_path, monkeypatch):
    # A background recording queued by an earlier test must not land in this test's Library.
    from services.library_hooks import wait_idle
    wait_idle(20)
    monkeypatch.setenv("FIBERBROWSER_LIBRARY", str(tmp_path / "home" / "library.json"))
    monkeypatch.setenv("FIBERBROWSER_JOBS_DIR", str(tmp_path / "jobs"))
    return tmp_path


@pytest.fixture
def public(monkeypatch):
    from services import runtime
    monkeypatch.setattr(runtime, "_public_mode", True)


def _library_routes(app):
    from services.public_mode_guard import iter_route_entries
    out = set()
    for entry in iter_route_entries(app):
        if entry.path.startswith("/api/library"):
            for method in entry.methods - {"HEAD"}:
                out.add((method, entry.path))
    return sorted(out)


def _concrete(path):
    return (path.replace("{entry_id}", "e0").replace("{group_id}", "g0").replace("{folder_id}", "w0")
            .replace("{name}", "plot"))


def test_every_library_route_is_refused_in_public_mode(client, standalone_app, public):
    routes = _library_routes(standalone_app)
    assert len(routes) >= 15
    for method, path in routes:
        resp = client.request(method, _concrete(path), json={})
        assert resp.status_code == 403, (method, path)


def test_every_library_route_is_refused_in_a_sandbox(standalone_app):
    from fastapi import HTTPException
    from routers.library import local_only
    from services.runtime import sandbox_context
    with sandbox_context("sb-test"):
        with pytest.raises(HTTPException) as err:
            local_only()
    assert err.value.status_code == 403
    # Every route carries the guard itself (not only the public-mode middleware).
    from routers.library import router
    for route in router.routes:
        assert any(dep.call is local_only for dep in route.dependant.dependencies), route.path


def test_list_add_tag_group_and_remove(client, tmp_path):
    bam = make_fiberhmm_bam(tmp_path / "d" / "a.fiberhmm.bam")
    write_qc_json(tmp_path / "d" / "a.fiberhmm.qc.json")
    (tmp_path / "d" / "notes.txt").write_text("not data")
    resp = client.post("/api/library/entries", json={"paths": [bam, str(tmp_path / "d" / "notes.txt")]})
    body = resp.json()
    assert len(body["ids"]) == 1 and body["errors"]
    entry_id = body["ids"][0]

    listing = client.get("/api/library").json()
    entry = listing["entries"][0]
    assert entry["available"] is True and entry["changed"] is False and entry["rerun"] is None
    assert entry["qc"]["verdicts"]["overall"] == "PASS" and entry["chemistry"]["key"] == "dddb"
    assert listing["schema"] == store.SCHEMA and listing["library_file"].endswith("library.json")
    assert listing["genomes_downloaded"] in ([], ["dm6"])  # only genomes on this computer are auto-loaded

    assert client.patch(f"/api/library/entries/{entry_id}", json={"tags": ["x"], "notes": "n"}).json()["success"]
    group = client.post("/api/library/groups", json={"name": "G", "entry_ids": [entry_id]}).json()["group"]
    assert client.patch(f"/api/library/groups/{group['id']}", json={"name": "G2"}).json()["group"]["name"] == "G2"
    assert client.post("/api/library/entries/remove", json={"ids": [entry_id]}).json()["removed"] == 1
    assert os.path.exists(bam)
    assert client.get("/api/library").json()["groups"][0]["entry_ids"] == []
    assert client.patch("/api/library/entries/nope", json={"tags": []}).status_code == 404


def test_missing_file_and_locate(client, tmp_path):
    bam = make_fiberhmm_bam(tmp_path / "old" / "a.bam")
    entry_id = client.post("/api/library/entries", json={"paths": [bam]}).json()["ids"][0]
    os.makedirs(tmp_path / "new")
    new = str(tmp_path / "new" / "a.bam")
    os.rename(bam, new)
    os.rename(bam + ".bai", new + ".bai")
    entry = client.get("/api/library").json()["entries"][0]
    assert entry["available"] is False
    other = make_fiberhmm_bam(tmp_path / "other.bam", sample="someone else")
    refused = client.post(f"/api/library/entries/{entry_id}/locate", json={"path": other}).json()
    assert refused["success"] is False and "different data" in refused["error"]
    located = client.post(f"/api/library/entries/{entry_id}/locate", json={"path": new}).json()
    assert located["success"] and located["entry"]["path"] == new
    assert client.get("/api/library").json()["entries"][0]["available"] is True
    assert client.post(f"/api/library/entries/{entry_id}/locate",
                       json={"path": str(tmp_path / "nope.bam")}).status_code == 400


def test_reveal_uses_the_platform_file_manager(client, tmp_path, monkeypatch):
    from services import library_endpoint, wsl_interop
    calls = []
    monkeypatch.setattr(library_endpoint.subprocess, "Popen", lambda argv, **kw: calls.append(argv))
    bam = make_fiberhmm_bam(tmp_path / "a.bam")
    entry_id = client.post("/api/library/entries", json={"paths": [bam]}).json()["ids"][0]
    path = client.get("/api/library").json()["entries"][0]["path"]
    # Natively: this OS's file manager, the file selected (macOS, Windows), its folder (Linux: xdg-open has no select).
    monkeypatch.setattr(wsl_interop, "is_wsl", lambda: False)
    assert client.post(f"/api/library/entries/{entry_id}/reveal").json()["success"]
    assert calls == [library_endpoint.reveal_command(path)]
    want = {"darwin": path, "win32": f"/select,{path}"}.get(sys.platform, os.path.dirname(path))
    assert calls[0][-1] == want
    # In WSL (the Windows app): Explorer, with the file selected (argv from test_wsl_interop's reveal_argv).
    explorer = ["/mnt/c/Windows/explorer.exe", "/select,", "C:\\x\\a.bam"]
    monkeypatch.setattr(wsl_interop, "is_wsl", lambda: True)
    monkeypatch.setattr(wsl_interop, "reveal_argv", lambda target: explorer if target == path else None)
    monkeypatch.setattr(wsl_interop, "windows_cwd", lambda: None)
    assert client.post(f"/api/library/entries/{entry_id}/reveal").json()["success"]
    assert calls[-1] == explorer
    assert library_endpoint.reveal_command("/d/a.bam", "darwin") == ["open", "-R", "/d/a.bam"]
    assert library_endpoint.reveal_command("/d/a.bam", "linux") == ["xdg-open", "/d"]
    assert library_endpoint.reveal_command("C:\\d\\a.bam", "win32") == ["explorer", "/select,C:\\d\\a.bam"]


def test_qc_payload_and_files(client, tmp_path):
    bam = make_fiberhmm_bam(tmp_path / "a.fiberhmm.bam")
    qc_json = write_qc_json(tmp_path / "qc" / "a.fiberhmm.qc.json")
    (tmp_path / "qc" / "a.fiberhmm.qc.png").write_bytes(b"\x89PNG fake")
    entry_id = client.post("/api/library/entries", json={"paths": [bam]}).json()["ids"][0]
    payload = client.get(f"/api/library/entries/{entry_id}/qc").json()
    assert payload["available"] and payload["qc"]["overall"]["status"] == "PASS"
    assert payload["curves"]["schema"] == "fiberhmm.qc.curves.v1"
    assert payload["plots"] == {"report": f"/api/library/entries/{entry_id}/qc/files/report"}
    assert client.get(payload["plots"]["report"]).content == b"\x89PNG fake"
    assert client.get(f"/api/library/entries/{entry_id}/qc/files/../../etc").status_code == 404
    del qc_json


def test_plasmid_bams_link_to_their_map(client, tmp_path):
    sequence = seq(21)
    run = make_pipeline_run(tmp_path / "run", plasmid_seq=sequence)
    other_map = write_map(tmp_path / "maps" / "pOther.gb", "pOther", seq(22))
    client.post("/api/library/entries", json={"paths": [run["called_bam"], run["plasmid_map"], other_map]})
    entries = {os.path.basename(e["path"]): e for e in client.get("/api/library").json()["entries"]}
    assert entries["S1.fiberhmm.bam"]["linked_maps"] == [entries["pTest.gb"]["id"]]


def test_catalog_export_round_trips_through_the_catalog_loader(client, tmp_path):
    from routers.catalog import set_catalog
    from services.catalog_endpoint import catalog_load_payload, get_catalog_payload
    from test_catalog_router import DummyCatalogState

    a = make_fiberhmm_bam(tmp_path / "share" / "e1" / "a.fiberhmm.bam", sample="Embryo A")
    b = make_fiberhmm_bam(tmp_path / "share" / "e2" / "b.fiberhmm.bam")
    plasmid = write_map(tmp_path / "share" / "p.gb", "p", seq(2))
    ids = client.post("/api/library/entries", json={"paths": [a, b, plasmid]}).json()["ids"]
    client.patch(f"/api/library/entries/{ids[1]}", json={"label": "Embryo B"})
    group = client.post("/api/library/groups", json={"name": "Embryo", "entry_ids": ids,
                                                     "description": "2-4h"}).json()["group"]
    exported = client.post("/api/library/catalog", json={"group_ids": [group["id"]], "relative": True}).json()
    catalog = exported["catalog"]
    assert catalog["genome"] == "dm6" and exported["base_dir"] == str(tmp_path / "share")
    assert [d["path"] for d in catalog["groups"][0]["datasets"]] == ["e1/a.fiberhmm.bam", "e2/b.fiberhmm.bam"]
    assert exported["skipped"][0]["path"] == plasmid

    try:
        set_catalog(catalog, base_dir=exported["base_dir"])
        state = DummyCatalogState()
        listed = get_catalog_payload(state)["catalog"]
        assert listed["name"] == "Embryo" and listed["groups"][0]["dataset_labels"] == ["Embryo A", "Embryo B"]
        loaded = catalog_load_payload(state, 0)
        assert loaded["success"] and [d.path for d in state.datasets.values()] == [a, b]
    finally:
        set_catalog(None)
    assert client.post("/api/library/catalog", json={"group_ids": ["nope"]}).status_code == 404


def test_watched_folder_routes(client, tmp_path):
    from services.library_scan import runner
    make_fiberhmm_bam(tmp_path / "w" / "x.bam")
    watched = client.post("/api/library/watched", json={"path": str(tmp_path / "w"), "max_depth": 2}).json()["watched"]
    assert runner().wait(30)
    listing = client.get("/api/library").json()
    assert [e["path"] for e in listing["entries"]] == [str(tmp_path / "w" / "x.bam")]
    assert listing["watched"][0]["last_scan"]["added"] == 1
    assert client.post("/api/library/scan", json={"folder_ids": []}).json()["requested"] == [watched["id"]]
    assert runner().wait(30)
    assert client.post("/api/library/watched", json={"path": str(tmp_path / "w" / "x.bam")}).status_code == 400
    assert client.post("/api/library/watched", json={"path": "/"}).status_code == 400
    assert client.delete(f"/api/library/watched/{watched['id']}").json()["success"]


def test_recall_route_dry_run(client, tmp_path, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_PIPELINE_COMMAND", "fiberhmm-pipeline")
    run = make_pipeline_run(tmp_path / "run", plasmid_seq=seq(8))
    entry_id = client.post("/api/library/entries", json={"paths": [run["called_bam"]]}).json()["ids"][0]
    plan = client.post(f"/api/library/entries/{entry_id}/recall",
                       json={"dry_run": True, "outdir": str(tmp_path / "o")}).json()
    assert plan["success"] and plan["plan"]["tool"] == "fiberhmm-pipeline"


# ---------------------------------------------------------------------------
# Datasets the user opens are recorded (background, local only)
# ---------------------------------------------------------------------------

def test_opened_datasets_and_maps_are_recorded(tmp_path):
    from state.browser_state import BrowserState
    run = make_pipeline_run(tmp_path / "run", plasmid_seq=seq(13))
    state = BrowserState(None, None, None, None)
    state.add_dataset("d1", run["called_bam"], "S1")
    assert library_hooks.wait_idle(20)
    entries = {os.path.basename(e["path"]): e for e in store.load()["entries"].values()}
    assert "S1.fiberhmm.bam" in entries and entries["S1.fiberhmm.bam"]["sources"] == ["opened"]
    assert entries["S1.fiberhmm.bam"]["last_opened"]
    # The header names the map beside it: loading the BAM loaded the map, which is recorded too.
    assert "pTest.gb" in entries


def test_public_mode_and_demo_data_are_not_recorded(tmp_path, public):
    from state.browser_state import BrowserState
    bam = make_fiberhmm_bam(tmp_path / "a.bam")
    state = BrowserState(None, None, None, None)
    state.add_dataset("d1", bam, "A")
    assert library_hooks.wait_idle(20)
    assert store.load()["entries"] == {}


def test_demo_bam_is_not_recorded(tmp_path):
    from state.browser_state import BrowserState
    demo = os.path.join(os.path.dirname(__file__), "..", "browser", "data", "demo", "napa_ddda.bam")
    if not os.path.exists(demo):
        pytest.skip("demo BAM not present")
    state = BrowserState(None, None, None, None)
    state.add_dataset("demo", demo, "demo")
    assert library_hooks.wait_idle(20)
    assert store.load()["entries"] == {}


def test_list_rows_are_slim_and_details_are_full(client, tmp_path):
    contigs = tuple((f"chr{i}", 1000 + i) for i in range(150))
    bam = make_fiberhmm_bam(tmp_path / "many.bam", contigs=contigs)
    entry_id = client.post("/api/library/entries", json={"paths": [bam]}).json()["ids"][0]
    row = client.get("/api/library").json()["entries"][0]
    assert row["reference"]["n_contigs"] == 150 and row["reference"]["contigs"] == []
    assert "programs" not in row["fiberhmm"]
    full = client.get(f"/api/library/entries/{entry_id}").json()["entry"]
    assert len(full["reference"]["contigs"]) == 64 and full["fiberhmm"]["programs"]
    assert client.get("/api/library/entries/nope").status_code == 404


def test_damaged_library_with_a_finished_run_still_shows_the_recovery_message(client, tmp_path):
    # Review round 4: importing the finished run tried to write the damaged file, so
    # GET /api/library failed with 500 instead of returning the "unreadable" payload.
    from library_fixtures import make_job
    make_pipeline_run(tmp_path / "run")
    make_job(tmp_path / "jobs", "20260929-101010-aaaaaa", tmp_path / "run")
    store.library_file().parent.mkdir(parents=True, exist_ok=True)
    store.library_file().write_text("{damaged")
    resp = client.get("/api/library")
    assert resp.status_code == 200
    body = resp.json()
    assert body["unreadable"] is True and body["entries"] == []
    assert body["jobs"]["imported"] == 0 and body["jobs"]["skipped"] == "library unreadable"
    assert store.library_file().read_text() == "{damaged"
    # Once the user moves the damaged file away, the run is imported.
    store.library_file().rename(tmp_path / "library.damaged.json")
    body = client.get("/api/library").json()
    assert body["unreadable"] is False and body["jobs"]["imported"] == 1 and len(body["entries"]) == 1


def test_qc_files_outside_the_approved_folder_are_not_served(client, tmp_path):
    # Review round 4: a QC JSON symlinked out of the watched folder was read, and a
    # plot symlink inside the folder served a file outside it (HTTP 200).
    import json
    from services import library_scan
    watched_dir, outside = tmp_path / "watched", tmp_path / "outside"
    make_fiberhmm_bam(watched_dir / "data.bam")
    secret = outside / "private.txt"
    secret.parent.mkdir(parents=True)
    secret.write_text("scratch-only private marker")
    os.symlink(secret, watched_dir / "private.png")
    qc_json = write_qc_json(watched_dir / "data.qc.json", curves=False)
    raw = json.loads(open(qc_json).read())
    raw["outputs"] = {"plot": str(watched_dir / "private.png"), "curves": str(outside / "c.json")}
    with open(qc_json, "w") as handle:
        json.dump(raw, handle)
    (outside / "c.json").write_text(json.dumps({"schema": "fiberhmm.qc.curves.v1", "secret": True}))
    watched = store.add_watched(str(watched_dir))
    library_scan.scan_folder(watched["id"])
    entry_id = next(iter(store.load()["entries"]))
    payload = client.get(f"/api/library/entries/{entry_id}/qc").json()
    assert payload["available"] and payload["plots"] == {} and payload["curves"] is None
    resp = client.get(f"/api/library/entries/{entry_id}/qc/files/plot")
    assert resp.status_code == 404 and "private marker" not in resp.text
    # An entry added directly: only its own folder.
    added = client.post("/api/library/entries", json={"paths": [str(watched_dir / "data.bam")]}).json()
    assert client.get(f"/api/library/entries/{added['ids'][0]}/qc/files/plot").status_code == 404


def test_a_cloud_only_qc_json_is_not_read_when_details_open(client, tmp_path, monkeypatch):
    from services import library_inspect as inspect
    bam = make_fiberhmm_bam(tmp_path / "d" / "a.fiberhmm.bam")
    qc = write_qc_json(tmp_path / "d" / "a.fiberhmm.qc.json")
    entry_id = client.post("/api/library/entries", json={"paths": [bam]}).json()["ids"][0]
    real_identity = inspect.stat_identity
    monkeypatch.setattr(inspect, "stat_identity", lambda path: dict(real_identity(path), cloud_only=True)
                        if os.path.abspath(path) == qc else real_identity(path))
    payload = client.get(f"/api/library/entries/{entry_id}/qc").json()
    assert payload["available"] is False and payload["online_only"] is True


def _bam_with_header(path, n_reads):
    """Written directly (no samtools sort @PG naming the file), so equal headers are byte-identical."""
    import pysam
    from library_fixtures import DDDB_DECLARATION
    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": "p", "LN": 3000}], "CO": [DDDB_DECLARATION],
              "PG": [{"ID": "fiberhmm-call", "PN": "fiberhmm-call", "VN": "3.0.0", "CL": "fiberhmm-call --enzyme dddb"}]}
    os.makedirs(os.path.dirname(str(path)), exist_ok=True)
    with pysam.AlignmentFile(str(path), "wb", header=header) as out:
        for i in range(n_reads):
            read = pysam.AlignedSegment(out.header)
            read.query_name, read.reference_id, read.reference_start = f"r{i}", 0, 100 + i * 50
            read.mapping_quality, read.cigarstring, read.query_sequence = 60, "50M", "A" * 50
            read.query_qualities = pysam.qualitystring_to_array("I" * 50)
            out.write(read)
    pysam.index(str(path))
    return str(path)


def _same_header_bams(tmp_path):
    """Two BAMs with identical headers: 3 reads (recorded) and 9 reads (another dataset)."""
    return (_bam_with_header(tmp_path / "old" / "original.bam", 3),
            _bam_with_header(tmp_path / "new" / "different.bam", 9))


def test_locate_refuses_another_dataset_with_the_same_header(client, tmp_path):
    # Review round 4: Locate compared only the header digest, so a different
    # experiment with the same header inherited the entry's tags and groups.
    from services import library_inspect as inspect
    original, different = _same_header_bams(tmp_path)
    assert inspect.inspect_file(original)["identity"]["header_sha256"] == \
        inspect.inspect_file(different)["identity"]["header_sha256"]
    entry_id = client.post("/api/library/entries", json={"paths": [original]}).json()["ids"][0]
    store.annotate(entry_id, tags=["original experiment"])
    group = store.create_group("Original", [entry_id])
    os.remove(original)
    refused = client.post(f"/api/library/entries/{entry_id}/locate", json={"path": different}).json()
    assert refused["success"] is False and "size differs" in refused["error"]
    entry = store.load()["entries"][entry_id]
    assert entry["path"] == original and entry["tags"] == ["original experiment"]
    assert store.load()["groups"][group["id"]]["entry_ids"] == [entry_id]
    # A recorded entry from before content digests: header and size must both match now.
    def drop_digest(data):
        data["entries"][entry_id]["identity"].pop("content_sha256", None)
    store.update(drop_digest)
    refused = client.post(f"/api/library/entries/{entry_id}/locate", json={"path": different}).json()
    assert refused["success"] is False


def test_locate_refuses_same_header_and_size_but_different_content(client, tmp_path):
    from library_fixtures import make_fiberhmm_bam
    original = make_fiberhmm_bam(tmp_path / "old" / "big.bam", n_reads=4000)
    tampered = str(tmp_path / "new" / "big.bam")
    os.makedirs(os.path.dirname(tampered))
    data = bytearray(open(original, "rb").read())
    data[-200] ^= 0xFF  # inside the last records, after the header
    open(tampered, "wb").write(bytes(data))
    entry_id = client.post("/api/library/entries", json={"paths": [original]}).json()["ids"][0]
    os.remove(original)
    refused = client.post(f"/api/library/entries/{entry_id}/locate", json={"path": tampered}).json()
    assert refused["success"] is False and "content differs" in refused["error"]


def test_locate_accepts_a_moved_copy_and_refuses_an_online_only_file(client, tmp_path, monkeypatch):
    import shutil
    from services import library_inspect as inspect
    original, _ = _same_header_bams(tmp_path)
    entry_id = client.post("/api/library/entries", json={"paths": [original]}).json()["ids"][0]
    moved = str(tmp_path / "moved" / "original.bam")
    os.makedirs(os.path.dirname(moved))
    shutil.copy(original, moved)
    os.remove(original)
    real_identity = inspect.stat_identity
    monkeypatch.setattr(inspect, "stat_identity", lambda path: dict(real_identity(path), cloud_only=True)
                        if path == moved else real_identity(path))
    refused = client.post(f"/api/library/entries/{entry_id}/locate", json={"path": moved}).json()
    assert refused["success"] is False and "online-only" in refused["error"]
    monkeypatch.setattr(inspect, "stat_identity", real_identity)
    located = client.post(f"/api/library/entries/{entry_id}/locate", json={"path": moved}).json()
    assert located["success"] and located["entry"]["path"] == moved


def test_recall_route_starts_only_a_reviewed_plan(client, tmp_path, monkeypatch):
    import sys
    from services import pipeline_jobs
    monkeypatch.setenv("FIBERBROWSER_PIPELINE_COMMAND", f"{sys.executable} -c pass")
    created = []

    class FakeManager:
        root = str(tmp_path / "jobs")

        def create(self, spec, admit=None):
            created.append(spec)
            return {"id": spec["id"], "status": "queued"}

    monkeypatch.setattr(pipeline_jobs, "get_job_manager", lambda: FakeManager())
    run = make_pipeline_run(tmp_path / "run", plasmid_seq=seq(8))
    entry_id = client.post("/api/library/entries", json={"paths": [run["called_bam"]]}).json()["ids"][0]
    url = f"/api/library/entries/{entry_id}/recall"
    plan = client.post(url, json={"dry_run": True, "outdir": str(tmp_path / "o")}).json()["plan"]
    assert plan["entry_id"] == entry_id and plan["settings"]["source"] == "outputs.json"
    assert "command" not in plan and plan["display_command"].startswith("fiberhmm-pipeline ")
    assert client.post(url, json={"outdir": str(tmp_path / "o")}).json()["success"] is False and not created
    wrong = client.post(url, json={"outdir": str(tmp_path / "o"), "plan_id": "0" * 16}).json()
    assert wrong["success"] is False and "plan changed" in wrong["error"] and not created
    started = client.post(url, json={"outdir": plan["outdir"], "cores": plan["cores"], "plan_id": plan["plan_id"]}).json()
    assert started["success"] and len(created) == 1 and created[0]["library_recall"]["entry_id"] == entry_id


# --- Review round 8: an entry without a content digest is relocated only when the user confirms ---

def _legacy_entry(client, tmp_path, *, change_content: bool):
    """An entry recorded before content digests, its file moved (optionally with changed records)."""
    import shutil
    from library_fixtures import make_fiberhmm_bam
    original = make_fiberhmm_bam(tmp_path / "old" / "big.bam", n_reads=4000)
    entry_id = client.post("/api/library/entries", json={"paths": [original]}).json()["ids"][0]
    store.update(lambda data: data["entries"][entry_id]["identity"].pop("content_sha256"))
    store.annotate(entry_id, tags=["experiment 1"])
    moved = str(tmp_path / "new" / "big.bam")
    os.makedirs(os.path.dirname(moved))
    if change_content:
        data = bytearray(open(original, "rb").read())
        data[-200] ^= 0xFF  # same header and size, different last records
        open(moved, "wb").write(bytes(data))
    else:
        shutil.copy(original, moved)
    os.remove(original)
    return entry_id, original, moved


@pytest.mark.parametrize("change_content", [False, True])
def test_locate_never_accepts_an_unverifiable_entry_silently(client, tmp_path, change_content):
    entry_id, original, moved = _legacy_entry(client, tmp_path, change_content=change_content)
    answer = client.post(f"/api/library/entries/{entry_id}/locate", json={"path": moved}).json()
    assert answer["success"] is False and answer["needs_confirmation"]
    assert "content fingerprint" in answer["error"] and "header and size" in answer["error"]
    assert store.load()["entries"][entry_id]["path"] == original


def test_locate_relocates_an_unverifiable_entry_the_user_vouches_for(client, tmp_path):
    entry_id, _original, moved = _legacy_entry(client, tmp_path, change_content=False)
    located = client.post(f"/api/library/entries/{entry_id}/locate", json={"path": moved, "confirm": True}).json()
    assert located["success"] and located["entry"]["path"] == moved
    entry = store.load()["entries"][entry_id]
    assert entry["tags"] == ["experiment 1"] and entry["identity"]["content_sha256"]  # fingerprinted now
