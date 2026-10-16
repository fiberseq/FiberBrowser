"""Codex round 6 on integ/fb62: primer DB pair, complete and bounded downloads, workspace-scoped import,
catalog membership by identity. The lock-order checker is on (tests/conftest.py)."""
import http.server
import json
import socket
import threading
import time
import urllib.error

import pysam
import pytest

from state.browser_state import BrowserState


# --- 1. primer design keeps a validated FASTA/BLAST-DB pair ---------------------------------------------


def _blast_db(directory, name):
    directory.mkdir(parents=True, exist_ok=True)
    for ext in (".nin", ".nsq", ".nhr"):
        (directory / f"{name}{ext}").write_bytes(b"x")
    return str(directory / name)


def test_primer_design_waits_for_a_genome_load_and_uses_the_new_genomes_db(tmp_path, monkeypatch):
    from services.genome_loading import reference_lock
    from services.primer_config import SWITCH_DEFERRED, primer_config_payload
    from services.primer_orchestration import resolve_primer_runtime_config
    hg38 = _blast_db(tmp_path / "blast", "hg38")
    hg19 = _blast_db(tmp_path / "blast", "hg19")
    fasta = tmp_path / "hg19.fa"
    fasta.write_text(">chr1\nACGT\n")
    state = BrowserState(None)
    state.fasta_path = str(fasta)          # hg19's FASTA is in, the load still holds the lock
    state.current_genome = "hg19"
    state.primer_blast_db = hg38
    out = {}
    with reference_lock(state):
        status = {}
        poll = threading.Thread(target=lambda: status.update(primer_config_payload(state)))
        poll.start()
        poll.join(5)
        assert not poll.is_alive()                                   # status never waits
        assert status["blast_db_warning"] == SWITCH_DEFERRED         # deferred, not "valid"
        design = threading.Thread(target=lambda: out.update(
            zip(("config", "error"), resolve_primer_runtime_config(state, require_blastn=False))))
        design.start()
        time.sleep(0.3)
        assert design.is_alive()                                     # design waits for the load
    design.join(5)
    assert out["error"] is None
    assert (out["config"].fasta_path, out["config"].blast_db_path) == (str(fasta), hg19)


# --- 2 and 4. downloads: complete and within the deadline ----------------------------------------------


class _Server:
    """A local HTTP server on a test port answering with a handler function."""

    def __init__(self, handler):
        from port_list import free_ports
        self.port = free_ports()[0]
        outer = handler

        class H(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                outer(self)

            def log_message(self, *a):
                pass
        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", self.port), H)
        self.httpd.daemon_threads = True
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def url(self, path):
        return f"http://127.0.0.1:{self.port}{path}"

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


def test_a_short_index_is_rejected_and_nothing_is_cached(tmp_path, monkeypatch):
    """Codex's reproduction: the index advertises 27 bytes and delivers 13 (only the first chromosome)."""
    from services.http_download import fetch
    full = b"chr1\t4\t6\t4\t5\nchr2\t4\t17\t4\t5\n"

    def short(handler):
        handler.send_response(200)
        handler.send_header("Content-Length", str(len(full)))
        handler.end_headers()
        handler.wfile.write(full[:13])
        handler.wfile.flush()
    server = _Server(short)
    try:
        dest = tmp_path / "ref.fa.fai.tmp"
        with pytest.raises(urllib.error.ContentTooShortError):
            fetch(server.url("/ref.fa.fai"), str(dest), timeout=5)
        assert not dest.exists()                                     # no partial file left
        # Through the cache: no index is published, and the next load downloads again.
        monkeypatch.setenv("HOME", str(tmp_path / "home"))
        fasta = b">chr1\nACGT\n>chr2\nACGT\n"

        def serve(handler):
            body = fasta if handler.path.endswith(".fa") else full[:13]
            handler.send_response(200)
            handler.send_header("Content-Length", str(len(fasta) if handler.path.endswith(".fa") else len(full)))
            handler.end_headers()
            handler.wfile.write(body)
        server.close()
        server = _Server(serve)
        monkeypatch.setattr("services.external_tools.tool_path", lambda name: None)   # no samtools fallback
        url = server.url("/genomes/ref.fa")
        # The short index is never published: the FASTA is indexed locally instead (round 8).
        local = BrowserState._download_fasta_to_cache(url, fasta_urls=[url])
        cache = tmp_path / "home" / ".fiberhmm" / "genomes"
        assert local == str(cache / "ref.fa")
        assert (cache / "ref.fa.fai").read_bytes() == full and not list(cache.glob("*.tmp"))
    finally:
        server.close()


def test_an_index_that_does_not_describe_the_fasta_is_rejected(tmp_path):
    from state.browser_state import _fai_matches_fasta
    fasta = tmp_path / "ref.fa"
    fasta.write_text(">chr1\nACGT\n>chr2\nACGT\n")
    good, short = tmp_path / "good.fai", tmp_path / "short.fai"
    good.write_text("chr1\t4\t6\t4\t5\nchr2\t4\t17\t4\t5\n")
    short.write_text("chr1\t4\t6\t4\t5\n")
    assert _fai_matches_fasta(str(good), str(fasta))
    assert not _fai_matches_fasta(str(short), str(fasta))


def test_a_trickling_download_stops_at_its_deadline(tmp_path):
    """Codex's reproduction: bytes every 25 ms, a 50 ms socket timeout, a 60 ms deadline (it ran 367 ms)."""
    from services.http_download import fetch
    stop = threading.Event()

    def trickle(handler):
        handler.send_response(200)
        handler.send_header("Content-Length", "100000")
        handler.end_headers()
        while not stop.is_set():
            try:
                handler.wfile.write(b"A")
                handler.wfile.flush()
            except OSError:
                return
            time.sleep(0.025)
    server = _Server(trickle)
    try:
        started = time.monotonic()
        with pytest.raises(OSError):
            fetch(server.url("/big.fa"), str(tmp_path / "big.fa"), timeout=0.05, deadline=0.3)
        assert time.monotonic() - started < 0.3 + 0.2
        assert not (tmp_path / "big.fa").exists()
    finally:
        stop.set()
        server.close()


def test_a_stalled_connect_or_header_stops_at_its_deadline(tmp_path):
    from port_list import free_ports
    from services.http_download import fetch
    port = free_ports()[0]
    listener = socket.socket()
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", port))
    listener.listen(1)
    held = []
    threading.Thread(target=lambda: held.append(listener.accept()), daemon=True).start()   # never sends headers
    try:
        started = time.monotonic()
        with pytest.raises(OSError):
            fetch(f"http://127.0.0.1:{port}/x", str(tmp_path / "x"), timeout=10, deadline=0.3)
        assert time.monotonic() - started < 1.0
    finally:
        for conn, _ in held:
            conn.close()
        listener.close()


# --- 3. a session import is workspace-scoped -----------------------------------------------------------


def test_a_panel_scoped_session_import_imports_into_the_workspace_in_lock_order(tmp_path, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routers.genome import _load_plasmid_into_state
    from routers.sessions import router
    from services import lock_order, panel_genomes
    from services.plasmid_maps import PlasmidMap
    from state.dependencies import get_dafc_state, get_state
    assert lock_order.CHECK
    state = BrowserState(None)
    ctx = panel_genomes._empty_context()
    monkeypatch.setattr(panel_genomes, "contexts", lambda s: {"other": ctx})
    bam = tmp_path / "a.bam"
    with pysam.AlignmentFile(str(bam), "wb", header={"HD": {"VN": "1.6"}, "SQ": [{"SN": "chr1", "LN": 1000}]}):
        pass
    pysam.index(str(bam))
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_dafc_state] = lambda: None
    # The route, scoped to the panel genome as get_state would scope it (panel_genome=other).
    app.dependency_overrides[get_state] = lambda: panel_genomes.genome_view(state, "other")
    session = {"version": "2.0", "datasets": [{"id": "a", "paths": [str(bam)], "label": "a"}]}
    errors, results = [], {}

    def plasmid():
        try:
            view = panel_genomes.genome_view(state, "other")
            for i in range(20):
                _load_plasmid_into_state(view, PlasmidMap(name=f"p{i}", sequence="ACGT" * 50, circular=True, features=[]),
                                         str(tmp_path / f"p{i}.gb"))
        except Exception as exc:      # noqa: BLE001
            errors.append(exc)
    publisher = threading.Thread(target=plasmid)
    publisher.start()
    results["import"] = TestClient(app).post("/api/session/import", json={"session": session}).json()
    publisher.join(30)
    assert not publisher.is_alive() and not errors, errors
    assert results["import"].get("success") is not False, results
    assert "a" in state.datasets                          # imported into the workspace, not through the view


# --- 5. catalog membership by identity ------------------------------------------------------------------


def test_unloading_a_catalog_group_never_removes_an_unrelated_dataset_imported_under_its_id(tmp_path, monkeypatch):
    import services.catalog_endpoint as catalog
    from models.requests import SessionImportRequest
    from services.sessions_endpoint import import_session_for_request

    def bam(path):
        path.parent.mkdir(parents=True, exist_ok=True)
        with pysam.AlignmentFile(str(path), "wb", header={"HD": {"VN": "1.6"}, "SQ": [{"SN": "chr1", "LN": 1000}]}):
            pass
        pysam.index(str(path))
        return str(path)
    monkeypatch.setattr(catalog, "_remote_entry_problems", lambda locations: [])
    catalog.set_catalog({"groups": [{"datasets": [{"path": bam(tmp_path / "cat" / "c.bam"), "label": "C"}]}]})
    try:
        state = BrowserState(None)
        assert catalog.catalog_load_payload(state, 0)["dataset_ids"] == ["catalog_0_0"]
        unrelated = bam(tmp_path / "new" / "unrelated.bam")
        session = {"version": "2.0", "datasets": [{"id": "catalog_0_0", "paths": [unrelated], "label": "unrelated"}]}
        import_session_for_request(state, SessionImportRequest(session=session))
        replacement = state.datasets["catalog_0_0"]
        assert replacement.paths == [unrelated]
        catalog.catalog_unload_payload(state, 0)
        assert state.datasets.get("catalog_0_0") is replacement      # not a member of the group
        assert 0 not in state._catalog_loaded
    finally:
        catalog.set_catalog(None)
