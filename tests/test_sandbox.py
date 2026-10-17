"""Sandbox sessions (tour tabs): isolation, id handling, cap and TTL, public mode."""
from __future__ import annotations

import os
import re
from pathlib import Path

import pytest

from state.sandbox import SANDBOX_HEADER

DEMO_BAM = Path(__file__).resolve().parents[1] / "browser" / "data" / "demo" / "napa_ddda.bam"
ID_RE = re.compile(r"^sb-[A-Za-z0-9_-]{16,64}$")


@pytest.fixture
def sandboxes(standalone_app):
    """The server's sandbox manager on a fresh main state, removed afterwards."""
    import server as srv
    from state.browser_state import BrowserState
    from state.runtime_state import set_browser_state
    from state.sandbox import SandboxManager, get_sandbox_manager, set_sandbox_manager
    previous_state, previous_manager = srv.state, get_sandbox_manager()
    main = BrowserState(None, None, None, None)
    srv.state = main
    set_browser_state(main)
    manager = SandboxManager(template=main)
    set_sandbox_manager(manager)
    try:
        yield manager
    finally:
        for sandbox_id in list(manager.sessions):
            manager.drop(sandbox_id)
        set_sandbox_manager(previous_manager)
        srv.state = previous_state
        set_browser_state(previous_state)


@pytest.fixture
def public(monkeypatch):
    from services import runtime
    monkeypatch.setattr(runtime, "_public_mode", True)
    yield


def _new(client) -> str:
    response = client.post("/api/sandbox")
    assert response.status_code == 200, response.text
    sandbox_id = response.json()["id"]
    assert ID_RE.match(sandbox_id)
    return sandbox_id


def _in(sandbox_id: str) -> dict:
    return {SANDBOX_HEADER: sandbox_id}


# --- ids -------------------------------------------------------------------------

def test_sandbox_ids_are_random_tokens(client, sandboxes):
    ids = {_new(client) for _ in range(3)}
    assert len(ids) == 3


@pytest.mark.parametrize("bad", ["x", "sb-short", "sb-" + "a" * 65, "sb-../../etc", "sb-aaaaaaaaaaaaaaaa!"])
def test_malformed_ids_are_refused(client, sandboxes, bad):
    response = client.get("/api/datasets", headers=_in(bad))
    assert response.status_code == 400


def test_unknown_or_ended_ids_are_gone_not_the_main_session(client, sandboxes):
    made_up = "sb-" + "A" * 24
    response = client.get("/api/datasets", headers=_in(made_up))
    assert response.status_code == 410
    assert response.headers.get("x-fiberbrowser-sandbox-expired") == "1"
    sandbox_id = _new(client)
    assert client.delete(f"/api/sandbox/{sandbox_id}").json()["ended"] is True
    assert client.get("/api/datasets", headers=_in(sandbox_id)).status_code == 410


def test_requests_never_mint_sandboxes(client, sandboxes):
    client.get("/api/datasets", headers=_in("sb-" + "B" * 24))
    assert sandboxes.sessions == {}


def test_the_query_parameter_and_the_pages_referer_name_the_sandbox(client, sandboxes):
    sandbox_id = _new(client)
    sandboxes.get(sandbox_id).dataset_order.append("only-in-sandbox")
    by_query = client.get(f"/api/status?sandbox={sandbox_id}")
    assert by_query.json()["public_mode"] is True
    # An <img> or link from the tour tab: no header, no parameter, only its page.
    by_referer = client.get("/api/status", headers={"referer": f"http://localhost/?sandbox={sandbox_id}&tour=1"})
    assert by_referer.json()["public_mode"] is True
    # Another site's page can't put a request in a sandbox.
    foreign = client.get("/api/status", headers={"referer": f"http://evil.example/?sandbox={sandbox_id}"})
    assert foreign.json()["public_mode"] is False
    assert client.get("/api/status").json()["public_mode"] is False


def test_a_sandbox_sees_only_itself(client, sandboxes):
    a, b = _new(client), _new(client)
    assert client.get(f"/api/sandbox/{b}", headers=_in(a)).status_code == 403
    assert client.delete(f"/api/sandbox/{b}", headers=_in(a)).status_code == 403
    assert client.get(f"/api/sandbox/{a}", headers=_in(a)).json()["active"] is True
    # ...and can't start more.
    assert client.post("/api/sandbox", headers=_in(a)).status_code == 403
    assert b in sandboxes.sessions


# --- public-mode rules ------------------------------------------------------------

def test_sandbox_requests_run_under_public_mode_rules(client, sandboxes, tmp_path):
    sandbox_id = _new(client)
    assert client.get("/api/status", headers=_in(sandbox_id)).json()["public_mode"] is True
    for method, path in [("GET", f"/api/files/list?path={tmp_path}"), ("POST", "/api/quit"), ("POST", "/api/shutdown"),
                         ("POST", "/api/load_fasta"), ("POST", "/api/footprint/rules/save"),
                         ("POST", "/api/datasets/add"), ("GET", "/api/jupyter/state"), ("POST", "/api/dafc/load"),
                         ("POST", "/api/tabs/heartbeat"), ("POST", "/api/session/import")]:
        response = client.request(method, path, headers=_in(sandbox_id))
        assert response.status_code == 403, (method, path, response.status_code)
    # The main tab is untouched by all this.
    assert client.get("/api/status").json()["public_mode"] is False


def test_the_demo_is_the_sandboxes_extra(client, sandboxes):
    sandbox_id = _new(client)
    info = client.get("/api/demo", headers=_in(sandbox_id)).json()
    assert info["available"] is DEMO_BAM.exists()


def test_only_the_demos_genome_loads_in_a_sandbox(client, sandboxes):
    sandbox_id = _new(client)
    response = client.post("/api/load_genome?genome_id=mm10", headers=_in(sandbox_id))
    assert response.status_code == 403


def test_public_servers_have_no_sandboxes(client, sandboxes, public):
    assert client.post("/api/sandbox").status_code == 403
    response = client.get("/api/datasets", headers=_in("sb-" + "C" * 24))
    assert response.status_code == 403
    info = client.get("/api/demo").status_code
    assert info == 403


# --- isolation --------------------------------------------------------------------

@pytest.mark.skipif(not DEMO_BAM.exists(), reason="demo BAM not present")
def test_demo_peaks_and_clusters_stay_in_the_sandbox(client, sandboxes):
    main = sandboxes.template
    sandbox_id = _new(client)
    loaded = client.post("/api/demo/load", headers=_in(sandbox_id)).json()
    assert loaded["success"], loaded
    region = loaded["region"]
    assert client.get("/api/datasets").json()["datasets"] == []
    assert main.datasets == {} and main.dataset_order == []
    sandbox_datasets = client.get("/api/datasets", headers=_in(sandbox_id)).json()["datasets"]
    assert [d["id"] for d in sandbox_datasets] == [loaded["dataset_id"]]

    query = f"chrom={region['chrom']}&start={region['start']}&end={region['end']}&dataset_id={loaded['dataset_id']}"
    peaks = client.post(f"/api/scan_peaks?{query}", json={}, headers=_in(sandbox_id))
    assert peaks.status_code == 200, peaks.text
    main_peaks = getattr(main, "peak_regions", None)
    assert not main_peaks
    n_peaks = len(getattr(sandboxes.get(sandbox_id), "peak_regions", None) or [])
    assert n_peaks >= 2
    clustered = client.post(f"/api/cluster?{query}", json={"peak_indices": [0, 1], "k": 2}, headers=_in(sandbox_id))
    assert clustered.status_code == 200, clustered.text
    assert clustered.json().get("assignments") or clustered.json().get("clusters"), clustered.json().keys()
    assert main.datasets == {} and not getattr(main, "peak_regions", None)

    # A second sandbox starts clean too.
    other = _new(client)
    assert client.get("/api/datasets", headers=_in(other)).json()["datasets"] == []


def test_sandboxes_start_without_the_main_sessions_data(client, sandboxes):
    main = sandboxes.template
    main.dataset_order = ["mine"]
    main.orthogonal_tracks = [{"label": "CTCF"}]
    sandbox = sandboxes.get(_new(client))
    assert sandbox.dataset_order == [] and sandbox.orthogonal_tracks == []
    assert main.dataset_order == ["mine"]


def test_reference_loads_in_a_sandbox_never_touch_the_main_session(sandboxes):
    main = sandboxes.template
    main.gtf_path = "/genomes/hg38.gtf"
    main.gtf_data = {"transcripts": "main"}
    main.current_genome = "hg38"
    main.chroms = ["chr1"]
    main.plasmid_sequences = {"pUC19": "ACGT"}
    sandbox = sandboxes.get(sandboxes.create())
    # It starts with the main session's reference...
    assert sandbox.gtf_path == "/genomes/hg38.gtf" and sandbox.current_genome == "hg38"
    # ...and whatever it loads is its own.
    sandbox.gtf_path = "/genomes/mm10.gtf"
    sandbox.gtf_data = {"transcripts": "sandbox"}
    sandbox.current_genome = "mm10"
    sandbox.chroms.append("chrX")
    sandbox.plasmid_sequences["pBR322"] = "TTTT"
    sandbox.fasta_path = "/genomes/mm10.fa"
    assert main.gtf_path == "/genomes/hg38.gtf" and main.gtf_data == {"transcripts": "main"}
    assert main.current_genome == "hg38" and main.chroms == ["chr1"]
    assert main.plasmid_sequences == {"pUC19": "ACGT"} and main.fasta_path is None


def test_a_sandbox_has_its_own_fasta_handle(sandboxes, tmp_path):
    pysam = pytest.importorskip("pysam")
    fasta = tmp_path / "ref.fa"
    fasta.write_text(">chr1\nACGTACGTAC\n")
    pysam.faidx(str(fasta))
    main = sandboxes.template
    assert main._load_fasta(str(fasta)) is None
    sandbox_id = sandboxes.create()
    sandbox = sandboxes.get(sandbox_id)
    assert sandbox.fasta is not main.fasta
    assert sandbox.fasta.fetch("chr1", 0, 4) == "ACGT"
    from services.genome_loading import _close_fasta
    _close_fasta(sandbox)
    sandboxes.drop(sandbox_id)
    assert main.fasta.fetch("chr1", 0, 4) == "ACGT"


def test_a_borrowed_reference_is_never_closed_for_the_main_session(sandboxes):
    class Handle:
        closed = False
        def close(self):
            self.closed = True
    main = sandboxes.template
    main.fasta = Handle()  # no file to reopen (e.g. a paired reference collection)
    sandbox_id = sandboxes.create()
    sandbox = sandboxes.get(sandbox_id)
    assert sandbox.fasta is main.fasta
    from services.genome_loading import _close_fasta
    _close_fasta(sandbox)
    sandboxes.drop(sandbox_id)
    assert main.fasta.closed is False and sandbox.fasta is None


def test_quality_filters_set_in_a_sandbox_stay_there(client, sandboxes):
    sandbox_id = _new(client)
    before = client.get("/api/quality_filters").json()
    body = client.get("/api/quality_filters", headers=_in(sandbox_id)).json()
    response = client.post("/api/quality_filters", json={**body, "filters": [{"name": "__sandbox_probe__"}]},
                           headers=_in(sandbox_id))
    assert response.status_code in (200, 400, 422)
    assert client.get("/api/quality_filters").json() == before


def test_saved_rules_can_not_be_written_from_a_sandbox(client, sandboxes, tmp_path):
    sandbox_id = _new(client)
    target = tmp_path / "rules.json"
    response = client.post("/api/footprint/rules/save", json={"path": str(target), "rules": []}, headers=_in(sandbox_id))
    assert response.status_code == 403
    assert not target.exists()


def test_sync_routes_see_the_sandbox_too(client, sandboxes):
    # /api/reference_pairs is a plain def (runs in a worker thread).
    sandbox_id = _new(client)
    sandboxes.get(sandbox_id).fasta_path = "/genomes/sandbox.fa"
    sandbox_pairs = client.get("/api/reference_pairs", headers=_in(sandbox_id)).json()["pairs"]
    assert sandbox_pairs[0]["fasta"] == "/genomes/sandbox.fa"
    assert client.get("/api/reference_pairs").json()["pairs"] == []


# --- cap and TTL -------------------------------------------------------------------

def test_the_oldest_sandbox_makes_room(monkeypatch):
    from state.browser_state import BrowserState
    from state.sandbox import SandboxManager
    manager = SandboxManager(template=BrowserState(None, None, None, None), max_sandboxes=2)
    clock = [1000.0]
    monkeypatch.setattr("state.sandbox.time.time", lambda: clock[0])
    monkeypatch.setattr("state.session_manager.time.time", lambda: clock[0])
    first = manager.create(); clock[0] += 1
    second = manager.create(); clock[0] += 1
    manager.get(first); clock[0] += 1  # the first is the more recently used now
    third = manager.create()
    assert set(manager.sessions) == {first, third}
    assert second not in manager.sessions


def test_idle_sandboxes_end_and_are_disposed(monkeypatch):
    from state.browser_state import BrowserState
    from state.sandbox import SandboxManager
    disposed = []
    monkeypatch.setattr("services.consensus_workflow.dispose_session", lambda state, **_: disposed.append(state))
    manager = SandboxManager(template=BrowserState(None, None, None, None), idle_ttl=60)
    clock = [1000.0]
    monkeypatch.setattr("state.sandbox.time.time", lambda: clock[0])
    sandbox_id = manager.create()
    state = manager.sessions[sandbox_id]
    clock[0] += 59
    assert manager.get(sandbox_id) is state
    clock[0] += 61
    assert manager.get(sandbox_id) is None
    assert disposed == [state]


def test_the_gc_loop_ends_idle_sandboxes(monkeypatch):
    import asyncio
    import time as real_time
    from state.browser_state import BrowserState
    from state.sandbox import SandboxManager
    disposed = []
    monkeypatch.setattr("services.consensus_workflow.dispose_session", lambda state, **_: disposed.append(state))
    manager = SandboxManager(template=BrowserState(None, None, None, None), idle_ttl=0, gc_interval=0)
    manager.create()
    manager.last_access = {k: real_time.time() - 10 for k in manager.last_access}

    async def run():
        manager.start_gc()
        for _ in range(50):
            await asyncio.sleep(0.01)
            if not manager.sessions:
                break
        manager.stop_gc()
    asyncio.run(run())
    assert manager.sessions == {} and len(disposed) == 1


# --- the page -------------------------------------------------------------------------

def test_the_page_tells_a_tour_tab_it_is_one(tmp_path, sandboxes):
    from fastapi import FastAPI
    from starlette.testclient import TestClient
    from services.frontend_mount import mount_frontend
    from state.sandbox import install_sandbox_middleware
    dist = tmp_path / "frontend" / "dist"
    dist.mkdir(parents=True)
    (dist / "index.html").write_text("<html><head></head><body></body></html>")
    app = FastAPI()
    mount_frontend(app, str(tmp_path), public_mode=False)
    install_sandbox_middleware(app)
    page = TestClient(app)
    plain = page.get("/").text
    assert "__FIBERBROWSER_SANDBOX__" not in plain and "__FIBERHMM_PUBLIC__" not in plain
    sandbox_id = sandboxes.create()
    tour = page.get(f"/?sandbox={sandbox_id}&tour=1").text
    assert f'window.__FIBERBROWSER_SANDBOX__ = "{sandbox_id}"' in tour
    assert "window.__FIBERHMM_PUBLIC__ = true" in tour
    assert "__FIBERBROWSER_SANDBOX_EXPIRED__" not in tour
    ended = page.get(f"/?sandbox=sb-{'D' * 24}").text
    assert "__FIBERBROWSER_SANDBOX_EXPIRED__ = true" in ended


# --- the tour's genome (UI audit H5) ------------------------------------------------

def _fake_genome_load(monkeypatch, loaded):
    """load_genome_blocking for a genome 'on disk', without reading hg38."""
    import services.demo_data as demo_data
    import services.genome_loading as genome_loading

    def fake(state, genome_id, info):
        loaded.append(genome_id)
        state.chroms = [{"name": "chr19", "size": 58_617_616}]
        state.chrom_map = {"chr19": "chr19"}
        state.gtf_path = f"/genomes/{genome_id}.gtf"
        state.current_genome = genome_id
        return {"success": True, "genome_id": genome_id, "fasta_loaded": False, "gtf_loaded": True}

    monkeypatch.setattr(genome_loading, "load_genome_blocking", fake)
    return demo_data


@pytest.mark.skipif(not DEMO_BAM.exists(), reason="demo BAM not present")
def test_the_tour_tab_loads_the_demos_genome_not_the_main_tabs(client, sandboxes, monkeypatch):
    main = sandboxes.template
    main.current_genome = "dm6"
    main.chroms = [{"name": "chr2L", "size": 23_513_712}]
    main.gtf_path = "/genomes/dm6.gtf"
    loaded = []
    demo_data = _fake_genome_load(monkeypatch, loaded)
    monkeypatch.setattr(demo_data, "_registry_genome_on_disk", lambda genome_id: True)
    sandbox_id = _new(client)
    # The tour tab opens on the demo's genome (its first step comes before the demo loads).
    assert loaded == ["hg38"] and sandboxes.get(sandbox_id).current_genome == "hg38"
    assert main.current_genome == "dm6"
    answer = client.post("/api/demo/load", headers=_in(sandbox_id)).json()
    assert answer["success"], answer
    assert "reference" not in answer and loaded == ["hg38"]  # already there
    sandbox = sandboxes.get(sandbox_id)
    assert sandbox.current_genome == "hg38" and [c["name"] for c in sandbox.chroms] == ["chr19"]
    # The main tab keeps its own genome.
    assert main.current_genome == "dm6" and main.chroms == [{"name": "chr2L", "size": 23_513_712}]
    assert main.gtf_path == "/genomes/dm6.gtf"
    # Loaded in the tab (an older sandbox, or one whose genome was changed) it comes with the demo.
    sandbox.current_genome = "dm6"
    again = client.post("/api/demo/load", headers=_in(sandbox_id)).json()
    assert again["reference"]["genome"] == "hg38" and loaded == ["hg38", "hg38"]
    assert main.current_genome == "dm6"


@pytest.mark.skipif(not DEMO_BAM.exists(), reason="demo BAM not present")
def test_without_the_demos_genome_on_disk_the_tour_tab_has_no_reference(client, sandboxes, monkeypatch):
    main = sandboxes.template
    main.current_genome = "dm6"
    main.chroms = [{"name": "chr2L", "size": 23_513_712}]
    loaded = []
    demo_data = _fake_genome_load(monkeypatch, loaded)
    monkeypatch.setattr(demo_data, "_registry_genome_on_disk", lambda genome_id: False)
    sandbox_id = _new(client)
    assert sandboxes.get(sandbox_id).current_genome is None  # cleared when the tab opens
    answer = client.post("/api/demo/load", headers=_in(sandbox_id)).json()
    assert answer["success"]
    assert loaded == []  # never downloads in a tour
    sandbox = sandboxes.get(sandbox_id)
    # No genome: the chromosome list is the demo BAM's own (hg38 names), not dm6's.
    names = {getattr(c, "name", None) or c["name"] for c in sandbox.chroms}
    assert sandbox.current_genome is None and "chr19" in names and "chr2L" not in names
    assert main.current_genome == "dm6" and main.chroms == [{"name": "chr2L", "size": 23_513_712}]


@pytest.mark.skipif(not DEMO_BAM.exists(), reason="demo BAM not present")
def test_the_tour_never_waits_for_a_download_of_the_demos_genome(client, sandboxes, monkeypatch):
    """Owner report (3.0.0, first launch): the tour sat at its first step while another request was getting hg38.
    A genome another request is downloading or verifying is treated as not there: the tab goes on without it."""
    main = sandboxes.template
    main.current_genome = "dm6"
    main.chroms = [{"name": "chr2L", "size": 23_513_712}]
    loaded = []
    demo_data = _fake_genome_load(monkeypatch, loaded)
    monkeypatch.setattr(demo_data, "_registry_genome_on_disk", lambda genome_id: True)
    monkeypatch.setattr(demo_data, "_registry_genome_busy", lambda genome_id: True)
    sandbox_id = _new(client)
    answer = client.post("/api/demo/load", headers=_in(sandbox_id)).json()
    assert answer["success"], answer
    assert loaded == []
    assert sandboxes.get(sandbox_id).current_genome is None
    assert main.current_genome == "dm6"


def test_a_genome_being_downloaded_or_verified_is_busy(tmp_path, monkeypatch):
    import threading
    import services.demo_data as demo_data
    from services.download_locks import download_lock
    from services.genome_registry import GENOME_REGISTRY
    from state.browser_state import _plain_fasta_basename
    monkeypatch.setenv("HOME", str(tmp_path))
    info = GENOME_REGISTRY["hg38"]
    url = (info.get("fasta_urls") or [info.get("fasta_url")])[0]
    cache = tmp_path / ".fiberhmm" / "genomes"
    cache.mkdir(parents=True)
    plain = os.path.abspath(str(cache / _plain_fasta_basename(url)))
    assert demo_data._registry_genome_busy("hg38") is False
    # A download under way: its partial file.
    partial = Path(plain + ".download.tmp")
    partial.write_bytes(b">chr1\nACGT")
    assert demo_data._registry_genome_busy("hg38") is True
    partial.unlink()
    # A download or an index check in another request: the cache file's lock is held.
    held, done = threading.Event(), threading.Event()

    def hold():
        with download_lock(f"fasta-cache:{plain}"):
            held.set()
            done.wait(10)

    worker = threading.Thread(target=hold)
    worker.start()
    try:
        assert held.wait(10)
        assert demo_data._registry_genome_busy("hg38") is True
    finally:
        done.set()
        worker.join(10)
    assert demo_data._registry_genome_busy("hg38") is False


def test_inside_no_wait_a_held_download_lock_raises_instead_of_waiting():
    import threading
    from services.download_locks import DownloadBusy, holding, no_wait
    key = "fasta-cache:/test/no_wait.fa"
    held, done = threading.Event(), threading.Event()

    def hold():
        with holding(key):
            held.set()
            done.wait(10)

    worker = threading.Thread(target=hold)
    worker.start()
    try:
        assert held.wait(10)
        with no_wait(), pytest.raises(DownloadBusy):
            with holding(key):
                pass
    finally:
        done.set()
        worker.join(10)
    with no_wait(), holding(key):   # free again: taken at once
        pass


@pytest.mark.parametrize("with_gtf", [False, True])
def test_the_tour_never_waits_for_a_download_that_starts_after_its_check(tmp_path, monkeypatch, with_gtf):
    """The busy check and the load are two steps: a download or index check another request starts between them
    must not hold the tour either (the cache file's lock is taken without waiting inside the load). A load that
    met it is a failed load: with the annotation cached, the tab still ends on no reference, not on the demo's
    genome name and annotations over the main tab's chromosomes."""
    import threading
    import services.demo_data as demo_data
    from services.download_locks import download_lock
    from services.genome_registry import GENOME_REGISTRY
    from state.browser_state import BrowserState, _plain_fasta_basename
    monkeypatch.setenv("HOME", str(tmp_path))
    url = "https://example.invalid/demo_genome.fa"
    entry = {"name": "hg38", "fasta_urls": [url]}  # no network: the files below are the cache
    cache = tmp_path / ".fiberhmm" / "genomes"
    cache.mkdir(parents=True)
    if with_gtf:
        entry["gtf_url"] = "https://example.invalid/demo_genome.gtf"
        (cache / "hg38.gtf").write_text('chr19\tt\texon\t1\t4\t.\t+\t.\tgene_id "g1"; transcript_id "t1"; gene_name "G1";\n')
    monkeypatch.setitem(GENOME_REGISTRY, "hg38", entry)
    plain = os.path.abspath(str(cache / _plain_fasta_basename(url)))
    Path(plain).write_text(">chr19\nACGT\n")
    monkeypatch.setattr(demo_data, "_registry_genome_on_disk", lambda genome_id: True)
    monkeypatch.setattr(demo_data, "_registry_genome_busy", lambda genome_id: False)  # the probe saw it free
    state = BrowserState(None)
    state.current_genome = "dm6"
    state.chroms = [{"name": "chr2L", "size": 23_513_712}]
    state.chrom_map = {"chr2L": "chr2L"}
    held, done = threading.Event(), threading.Event()

    def hold():
        with download_lock(f"fasta-cache:{plain}"):
            held.set()
            done.wait(30)

    worker = threading.Thread(target=hold)
    worker.start()
    answer = {}
    try:
        assert held.wait(10)
        tour = threading.Thread(target=lambda: answer.update(r=demo_data.ensure_demo_reference(state, sandbox=True)))
        tour.start()
        tour.join(10)
        assert not tour.is_alive(), "the tour waited for another request's download"
    finally:
        done.set()
        worker.join(10)
    assert answer["r"] == {"genome": None, "has_fasta": False}
    assert state.current_genome is None and state.chroms == [] and state.chrom_map == {}
    assert state.gtf_data is None and state.gtf_path is None and state.fasta is None


@pytest.mark.skipif(not DEMO_BAM.exists(), reason="demo BAM not present")
def test_the_main_tabs_demo_load_never_touches_its_genome(client, sandboxes, monkeypatch):
    main = sandboxes.template
    main.current_genome = "dm6"
    loaded = []
    _fake_genome_load(monkeypatch, loaded)
    answer = client.post("/api/demo/load").json()
    assert answer["success"] and "reference" not in answer and loaded == []
    assert main.current_genome == "dm6"


@pytest.mark.skipif(not DEMO_BAM.exists(), reason="demo BAM not present")
def test_demo_loads_at_the_same_time_register_it_once(sandboxes):
    import threading
    from services.demo_data import load_demo
    state = sandboxes.template
    results = []
    threads = [threading.Thread(target=lambda: results.append(load_demo(state))) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert all(r["success"] for r in results)
    assert len({r["dataset_id"] for r in results}) == 1 and len(state.datasets) == 1


# --- the Variants section's structural-variant demo ---------------------------------

SV_DEMO_BAM = DEMO_BAM.with_name("h1_chr1_insertion.bam")


@pytest.mark.skipif(not SV_DEMO_BAM.exists(), reason="SV demo BAM not present")
def test_a_sandbox_loads_the_sv_demo_and_expands_its_insertion(client, sandboxes, tmp_path, monkeypatch):
    # The tour's Variants section opens the demo insertion's carriers with the insert expanded:
    # a tour tab may build that one (a bundled demo's), never another dataset's.
    monkeypatch.setenv("FIBERBROWSER_ALT_ALLELE_DIR", str(tmp_path / "alt"))
    sandbox_id = _new(client)
    listed = client.get("/api/demo", headers=_in(sandbox_id)).json()
    assert {d["id"] for d in listed["demos"]} == {"napa", "sv"}
    assert client.get("/api/demo?demo=nope", headers=_in(sandbox_id)).status_code == 404
    loaded = client.post("/api/demo/load?demo=sv", headers=_in(sandbox_id)).json()
    assert loaded["success"] and loaded["region"]["chrom"] == "chr1" and loaded["demo"] == "sv"
    sv_id = loaded["dataset_id"]
    assert client.get("/api/demo?demo=sv", headers=_in(sandbox_id)).json()["dataset_id"] == sv_id
    # The main tab has neither demo.
    assert client.get("/api/demo?demo=sv").json()["dataset_id"] is None
    resp = client.post("/api/alt_allele/open", headers=_in(sandbox_id),
                       json={"dataset_id": sv_id, "chrom": "chr1", "ref": 23_277_272, "length": 7_471})
    data = resp.json()
    assert resp.status_code == 200 and data["success"], data
    assert data["layout"]["insert_end"] - data["layout"]["insert_start"] > 7_000
    assert data["dataset"]["id"] in client.get("/api/datasets", headers=_in(sandbox_id)).text


def test_a_sandbox_can_not_expand_an_insertion_of_other_data(client, sandboxes, tmp_path, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_ALT_ALLELE_DIR", str(tmp_path / "alt"))
    sandbox_id = _new(client)
    # A dataset the sandbox does not have (or any that is not a bundled demo) is refused.
    resp = client.post("/api/alt_allele/open", headers=_in(sandbox_id),
                       json={"dataset_id": "anything", "chrom": "chr1", "ref": 100, "length": 500})
    assert resp.status_code == 403
