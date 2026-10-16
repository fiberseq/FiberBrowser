"""Codex round 7 on integ/fb62: catalog membership on the workspace by identity, partial vs complete catalog
groups, an absolute download deadline (headers, chunk framing, trailers), and .fai checks for a FASTA without a
final newline; rounds 8-9: an index paired with its own FASTA (and refused when it cannot be fixed), the
deadline through proxy tunnels and TLS handshakes. The
lock-order checker is on (tests/conftest.py)."""
import socket
import threading
import time

import pysam
import pytest

from state.browser_state import BrowserState


def _bam(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with pysam.AlignmentFile(str(path), "wb", header={"HD": {"VN": "1.6"}, "SQ": [{"SN": "chr1", "LN": 1000}]}):
        pass
    pysam.index(str(path))
    return str(path)


@pytest.fixture
def catalog(monkeypatch):
    import services.catalog_endpoint as catalog
    monkeypatch.setattr(catalog, "_remote_entry_problems", lambda locations: [])
    yield catalog
    catalog.set_catalog(None)


# --- 1. catalog membership lives on the workspace and names objects -----------------------------------------


def test_a_panel_scoped_catalog_load_never_lets_unload_remove_an_unrelated_import(tmp_path, monkeypatch, catalog):
    """Codex's reproduction through the real routes: load with panel_genome=other, import an unrelated BAM as
    catalog_0_0, unload the group. The import stays."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routers.catalog import router as catalog_router
    from routers.sessions import router as sessions_router
    from services import panel_genomes
    from state.dependencies import get_dafc_state, get_state
    state = BrowserState(None)
    ctx = panel_genomes._empty_context()
    monkeypatch.setattr(panel_genomes, "contexts", lambda s: {"other": ctx})
    catalog.set_catalog({"groups": [{"datasets": [{"path": _bam(tmp_path / "cat" / "c.bam"), "label": "C"}]}]})
    app = FastAPI()
    app.include_router(catalog_router)
    app.include_router(sessions_router)
    app.dependency_overrides[get_dafc_state] = lambda: None
    app.dependency_overrides[get_state] = lambda: panel_genomes.genome_view(state, "other")
    client = TestClient(app)

    assert client.post("/api/catalog/load", params={"group_index": 0}).json()["dataset_ids"] == ["catalog_0_0"]
    assert 0 in state.__dict__["_catalog_members"]                      # recorded on the workspace
    unrelated = _bam(tmp_path / "new" / "unrelated.bam")
    session = {"version": "2.0", "datasets": [{"id": "catalog_0_0", "paths": [unrelated], "label": "unrelated"}]}
    assert client.post("/api/session/import", json={"session": session}).json().get("success") is not False
    replacement = state.datasets["catalog_0_0"]
    assert replacement.paths == [unrelated]
    assert client.get("/api/catalog").json()["catalog"]["groups"][0]["loaded"] is False
    client.post("/api/catalog/unload", params={"group_index": 0})
    assert state.datasets.get("catalog_0_0") is replacement


def test_a_replaced_member_is_not_already_loaded(tmp_path, catalog):
    """Remove and re-add a catalog member's id: the group is not "Already loaded"; a load brings it back."""
    state = BrowserState(None)
    catalog.set_catalog({"groups": [{"datasets": [{"path": _bam(tmp_path / "c.bam"), "label": "C"}]}]})
    assert catalog.catalog_load_payload(state, 0)["dataset_ids"] == ["catalog_0_0"]
    state.remove_dataset("catalog_0_0")
    other = _bam(tmp_path / "other.bam")
    state.add_dataset("catalog_0_0", other, "other")
    mine = state.datasets["catalog_0_0"]
    result = catalog.catalog_load_payload(state, 0)
    assert result["message"] != "Already loaded"
    assert state.datasets["catalog_0_0"] is mine                         # the user's dataset is kept
    (new_id,) = result["dataset_ids"]
    assert new_id != "catalog_0_0" and state.datasets[new_id].paths == [str(tmp_path / "c.bam")]
    assert catalog.catalog_load_payload(state, 0)["message"] == "Already loaded"
    catalog.catalog_unload_payload(state, 0)
    assert new_id not in state.datasets and state.datasets["catalog_0_0"] is mine


def test_unload_never_removes_datasets_of_unknown_provenance(tmp_path, catalog):
    """A group recorded as loaded with no members (an older record) removes nothing."""
    state = BrowserState(None)
    catalog.set_catalog({"groups": [{"datasets": [{"path": _bam(tmp_path / "c.bam"), "label": "C"}]}]})
    state.add_dataset("catalog_0_0", _bam(tmp_path / "mine.bam"), "mine")
    mine = state.datasets["catalog_0_0"]
    state._catalog_loaded[0] = ["catalog_0_0"]
    catalog.catalog_unload_payload(state, 0)
    assert state.datasets.get("catalog_0_0") is mine
    assert 0 not in state._catalog_loaded


# --- 3. partial membership is not completeness ---------------------------------------------------------------


def test_an_import_restoring_part_of_a_group_leaves_it_retryable(tmp_path, monkeypatch, catalog):
    """Codex's reproduction: a.bam loads, b.bam fails; an import restores a.bam. The group is not loaded, and the
    next load retries b.bam (and only b.bam)."""
    from models.requests import SessionImportRequest
    from services.sessions_endpoint import import_session_for_request
    a, b = _bam(tmp_path / "a.bam"), _bam(tmp_path / "b.bam")
    catalog.set_catalog({"groups": [{"datasets": [{"path": a, "label": "A"}, {"path": b, "label": "B"}]}]})
    state = BrowserState(None)
    real_add = state.add_dataset
    calls = []

    def flaky(dataset_id, path, label=None, *args, **kwargs):
        calls.append(dataset_id)
        if path == b and fail_b:
            raise OSError("b unavailable")
        return real_add(dataset_id, path, label, *args, **kwargs)
    monkeypatch.setattr(state, "add_dataset", flaky)
    fail_b = True
    first = catalog.catalog_load_payload(state, 0)
    assert first["dataset_ids"] == ["catalog_0_0"] and "failed" in first["message"]
    assert 0 not in state._catalog_loaded

    session = {"version": "2.0", "datasets": [{"id": "catalog_0_0", "paths": [a], "label": "A"}]}
    import_session_for_request(state, SessionImportRequest(session=session))
    assert "catalog_0_0" in state.datasets
    assert 0 not in state._catalog_loaded                         # partial: not loaded
    assert catalog.get_catalog_payload(state)["catalog"]["groups"][0]["loaded"] is False

    fail_b = False
    calls.clear()
    second = catalog.catalog_load_payload(state, 0)
    assert second["message"] != "Already loaded"
    assert calls == ["catalog_0_1"]                                # only the missing member is retried
    assert state._catalog_loaded[0] == ["catalog_0_0", "catalog_0_1"]
    assert catalog.catalog_load_payload(state, 0)["message"] == "Already loaded"


def test_an_import_restoring_a_whole_group_keeps_it_loaded(tmp_path, catalog):
    from models.requests import SessionImportRequest
    from services.sessions_endpoint import import_session_for_request
    a, b = _bam(tmp_path / "a.bam"), _bam(tmp_path / "b.bam")
    catalog.set_catalog({"groups": [{"datasets": [{"path": a, "label": "A"}, {"path": b, "label": "B"}]}]})
    state = BrowserState(None)
    assert catalog.catalog_load_payload(state, 0)["dataset_ids"] == ["catalog_0_0", "catalog_0_1"]
    session = {"version": "2.0", "datasets": [{"id": "catalog_0_0", "paths": [a], "label": "A"},
                                              {"id": "catalog_0_1", "paths": [b], "label": "B"}]}
    import_session_for_request(state, SessionImportRequest(session=session))
    assert state._catalog_loaded[0] == ["catalog_0_0", "catalog_0_1"]
    catalog.catalog_unload_payload(state, 0)
    assert "catalog_0_0" not in state.datasets and "catalog_0_1" not in state.datasets


# --- 2. the overall download deadline bounds headers, chunk framing and trailers -----------------------------


class _Trickler:
    """A raw HTTP server that sends ``prefix`` and then ``unit`` every 15 ms, never finishing."""

    def __init__(self, prefix: bytes, unit: bytes):
        from port_list import free_ports
        self.port = free_ports()[0]
        self.stop = threading.Event()
        self.listener = socket.socket()
        self.listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.listener.bind(("127.0.0.1", self.port))
        self.listener.listen(4)
        self.prefix, self.unit = prefix, unit
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self):
        try:
            conn, _ = self.listener.accept()
        except OSError:
            return
        with conn:
            try:
                conn.recv(65536)
                conn.sendall(self.prefix)
                while not self.stop.is_set():
                    conn.sendall(self.unit)
                    time.sleep(0.015)
            except OSError:
                return

    def close(self):
        self.stop.set()
        self.listener.close()


_CHUNKED = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n"


@pytest.mark.parametrize("stage, prefix, unit", [
    ("headers", b"HTTP/1.1 200 OK\r\n", b"X-Slow: y\r\n"),             # Codex: 809 ms
    ("chunk-size framing", _CHUNKED + b"4\r\nACGT\r\n1", b"0"),         # Codex: 579 ms (one endless size line)
    ("trailers", _CHUNKED + b"4\r\nACGT\r\n0\r\n", b"X-Trailer: y\r\n"),  # Codex: 516 ms
])
def test_the_overall_deadline_bounds_every_stage(tmp_path, stage, prefix, unit):
    """Codex's reproductions: a 60 ms deadline, a 50 ms socket timeout, bytes every 15 ms."""
    from services.http_download import DownloadTimeout, fetch
    server = _Trickler(prefix, unit)
    dest = tmp_path / "x.fa"
    try:
        started = time.monotonic()
        with pytest.raises(DownloadTimeout):
            fetch(f"http://127.0.0.1:{server.port}/x.fa", str(dest), timeout=0.05, deadline=0.06)
        elapsed = time.monotonic() - started
        assert elapsed < 0.25, (stage, elapsed)
        assert not dest.exists()
    finally:
        server.close()


def test_the_deadline_bounds_an_https_proxy_connect_tunnel(tmp_path, monkeypatch):
    """Codex round 8: an HTTPS proxy trickles its CONNECT response headers (60 ms deadline, 50 ms socket timeout,
    a header line every 15 ms; it ran 808 ms). The socket is watched before the tunnel, so the deadline holds."""
    from services.http_download import DownloadTimeout, fetch
    server = _Trickler(b"HTTP/1.1 200 Connection established\r\n", b"X-Proxy: y\r\n")
    for name in ("http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "no_proxy", "NO_PROXY", "all_proxy",
                 "ALL_PROXY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("https_proxy", f"http://127.0.0.1:{server.port}")
    dest = tmp_path / "x.fa"
    try:
        started = time.monotonic()
        with pytest.raises(DownloadTimeout):
            fetch("https://reference.example.invalid/x.fa", str(dest), timeout=0.05, deadline=0.06)
        assert time.monotonic() - started < 0.25
        assert not dest.exists()
    finally:
        server.close()


def test_a_normal_chunked_download_still_completes(tmp_path):
    from services.http_download import fetch
    body = b"".join(b"%x\r\n%s\r\n" % (len(part), part) for part in (b">chr1\n", b"ACGT\n")) + b"0\r\n\r\n"
    server = _Trickler(_CHUNKED + body, b"")
    server.stop.set()
    dest = tmp_path / "ok.fa"
    try:
        fetch(f"http://127.0.0.1:{server.port}/ok.fa", str(dest), timeout=5, deadline=5)
        assert dest.read_bytes() == b">chr1\nACGT\n"
    finally:
        server.close()


# --- 4. .fai validation: a final newline is optional ---------------------------------------------------------


@pytest.mark.parametrize("fasta, fai, ok", [
    (b">chr1\nACGT\nACGT", "chr1\t8\t6\t4\t5\n", True),                       # Codex: 15 bytes, no final newline
    (b">chr1\nACGT\nACGT\n", "chr1\t8\t6\t4\t5\n", True),
    (b">chr1\nACGT\nAC", "chr1\t6\t6\t4\t5\n", True),
    (b">chr1\nACGT\nAC\n", "chr1\t6\t6\t4\t5\n", True),
    (b">chr1\r\nACGT\r\nACGT\r\n", "chr1\t8\t7\t4\t6\n", True),
    (b">chr1\nACGT\n>chr2\nACGT\n", "chr1\t4\t6\t4\t5\nchr2\t4\t17\t4\t5\n", True),
    (b">chr1\nACGT\n>chr2\nACGT", "chr1\t4\t6\t4\t5\nchr2\t4\t17\t4\t5\n", True),
    (b">chr1\nACGT\n>chr2\nACGT\n", "chr1\t4\t6\t4\t5\n", False),             # truncated index
    (b">chr1\nACGT\nAC", "chr1\t8\t6\t4\t5\n", False),                        # points past the end
    (b">chr1\nACGT\nACGTACGT\n", "chr1\t8\t6\t4\t5\n", False),                 # misses the tail
])
def test_fai_validation(tmp_path, fasta, fai, ok):
    from state.browser_state import _fai_matches_fasta
    (tmp_path / "ref.fa").write_bytes(fasta)
    (tmp_path / "ref.fa.fai").write_text(fai)
    assert _fai_matches_fasta(str(tmp_path / "ref.fa.fai"), str(tmp_path / "ref.fa")) is ok


# --- round 8: an index is only ever paired with the FASTA it describes ---------------------------------------


def _mirror(files: dict):
    """A local HTTP server serving ``files`` (path -> bytes); anything else is a 404."""
    import http.server
    from port_list import free_ports
    port = free_ports()[0]

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            body = files.get(self.path)
            if body is None:
                self.send_response(404)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass
    httpd = __import__("http.server").server.ThreadingHTTPServer(("127.0.0.1", port), H)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f"http://127.0.0.1:{port}"


PRIMARY = b">chr1\nACGT\n>chr2\nTGCA\n"
FALLBACK = b">chr2\nTGCA\n>chr1\nACGT\n"                 # the same contigs, reordered, equal lengths
PRIMARY_FAI = b"chr1\t4\t6\t4\t5\nchr2\t4\t17\t4\t5\n"


def test_a_fallback_mirrors_fasta_is_never_paired_with_the_primarys_index(tmp_path, monkeypatch):
    """Codex's reproduction: the primary FASTA is a 404, the fallback serves reordered equal-length contigs and
    the primary's (complete) index is still served. Native pysam must read chr1 as ACGT."""
    from services.fasta_handles import ThreadLocalFasta
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    httpd, base = _mirror({"/fallback/ref.fa": FALLBACK, "/primary/ref.fa.fai": PRIMARY_FAI})
    try:
        urls = [f"{base}/primary/ref.fa", f"{base}/fallback/ref.fa"]
        local = BrowserState._download_fasta_to_cache(urls[0], fasta_urls=urls, fai_urls=[urls[0] + ".fai"])
        assert local is not None
        handle = ThreadLocalFasta(local)
        assert handle.fetch("chr1", 0, 4) == "ACGT" and handle.fetch("chr2", 0, 4) == "TGCA"
        assert pysam.FastaFile(local).fetch("chr1") == "ACGT"
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_a_cached_mismatched_index_is_rebuilt_on_load(tmp_path, monkeypatch):
    """A cache an older release left with another mirror's index is re-validated and re-indexed locally."""
    from state.browser_state import cached_fasta_path, record_fasta_source
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    httpd, base = _mirror({})                                   # nothing to download: the cache is used
    try:
        urls = [f"{base}/primary/ref.fa", f"{base}/fallback/ref.fa"]
        cache = tmp_path / "home" / ".fiberhmm" / "genomes"
        cache.mkdir(parents=True)
        local = cached_fasta_path(str(cache), urls)
        with open(local, "wb") as fh:
            fh.write(FALLBACK)
        with open(local + ".fai", "wb") as fh:
            fh.write(PRIMARY_FAI)
        record_fasta_source(local, urls[1])
        assert pysam.FastaFile(local).fetch("chr1") == "TGCA"       # the silent error being fixed
        assert BrowserState._download_fasta_to_cache(urls[0], fasta_urls=urls) == local
        assert pysam.FastaFile(local).fetch("chr1") == "ACGT"
    finally:
        httpd.shutdown()
        httpd.server_close()


@pytest.mark.parametrize("fasta, fai", [
    (FALLBACK, PRIMARY_FAI),                                                   # reordered, same geometry
    (b">chrA\nACGT\n>chr2\nTGCA\n", PRIMARY_FAI),                              # another name
    (b">chr1\nACG\nT\n>chr2\nTGCA\n", b"chr1\t4\t6\t4\t5\nchr2\t4\t18\t4\t5\n"),  # other line width
    (b">chr1\nACGT\n>chr2\nTGCA\n>chr3\nAAAA\n", PRIMARY_FAI),                # a record the index lacks
    (b">chr1\nACGTA\n>chr2\nTGCA\n", PRIMARY_FAI),                              # another length
])
def test_fai_validation_rejects_an_index_for_another_fasta(tmp_path, fasta, fai):
    from state.browser_state import _fai_matches_fasta
    (tmp_path / "ref.fa").write_bytes(fasta)
    (tmp_path / "ref.fa.fai").write_bytes(fai)
    assert not _fai_matches_fasta(str(tmp_path / "ref.fa.fai"), str(tmp_path / "ref.fa"))


# --- round 9 -----------------------------------------------------------------------------------------------


def test_a_read_only_cache_with_a_wrong_index_is_refused(tmp_path, monkeypatch):
    """Codex's reproduction: a read-only cache holds the reordered FASTA and the other mirror's index. The load
    is refused with a clear error rather than reading chr1 as TGCA."""
    import os
    import stat
    from state.browser_state import cached_fasta_path, record_fasta_source
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    httpd, base = _mirror({})
    cache = tmp_path / "home" / ".fiberhmm" / "genomes"
    cache.mkdir(parents=True)
    urls = [f"{base}/primary/ref.fa", f"{base}/fallback/ref.fa"]
    local = cached_fasta_path(str(cache), urls)
    with open(local, "wb") as fh:
        fh.write(FALLBACK)
    with open(local + ".fai", "wb") as fh:
        fh.write(PRIMARY_FAI)
    record_fasta_source(local, urls[1])
    assert pysam.FastaFile(local).fetch("chr1") == "TGCA"
    os.chmod(cache, stat.S_IRUSR | stat.S_IXUSR)
    try:
        state = BrowserState(None)
        error = state._load_fasta(urls[0], fasta_urls=urls)
        assert error and "does not match" in error and "cannot be replaced" in error, error
        assert getattr(state, "fasta", None) is None
        assert open(local + ".fai", "rb").read() == PRIMARY_FAI          # untouched, and not used
    finally:
        os.chmod(cache, stat.S_IRWXU)
        httpd.shutdown()
        httpd.server_close()


def test_a_read_only_cache_with_a_matching_index_loads(tmp_path, monkeypatch):
    import os
    import stat
    from state.browser_state import cached_fasta_path, record_fasta_source
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    httpd, base = _mirror({})
    cache = tmp_path / "home" / ".fiberhmm" / "genomes"
    cache.mkdir(parents=True)
    url = f"{base}/primary/ref.fa"
    local = cached_fasta_path(str(cache), [url])
    with open(local, "wb") as fh:
        fh.write(PRIMARY)
    pysam.faidx(local)
    record_fasta_source(local, url)
    os.chmod(cache, stat.S_IRUSR | stat.S_IXUSR)
    try:
        state = BrowserState(None)
        assert state._load_fasta(url, fasta_urls=[url]) is None
        assert state.fasta.fetch("chr1", 0, 4) == "ACGT"
    finally:
        os.chmod(cache, stat.S_IRWXU)
        httpd.shutdown()
        httpd.server_close()


def test_prepare_genomes_fails_when_the_index_cannot_be_rebuilt(tmp_path, monkeypatch):
    import os
    import stat
    import prepare_genomes
    genome_dir = tmp_path / "genomes"
    genome_dir.mkdir()
    (genome_dir / "ref.fa").write_bytes(FALLBACK)
    (genome_dir / "ref.fa.fai").write_bytes(PRIMARY_FAI)
    os.chmod(genome_dir, stat.S_IRUSR | stat.S_IXUSR)
    try:
        with pytest.raises(RuntimeError, match="no index that matches"):
            prepare_genomes.download_genome_files("t", {"fasta_url": "http://127.0.0.1:9/ref.fa"}, str(genome_dir))
    finally:
        os.chmod(genome_dir, stat.S_IRWXU)
    prepare_genomes.download_genome_files("t", {"fasta_url": "http://127.0.0.1:9/ref.fa"}, str(genome_dir))
    assert pysam.FastaFile(str(genome_dir / "ref.fa")).fetch("chr1") == "ACGT"     # writable: rebuilt


def test_the_deadline_bounds_a_stalled_tls_handshake_after_a_slow_proxy(tmp_path, monkeypatch):
    """Codex's reproduction: a slow but successful CONNECT, then a TLS handshake the server never answers (it ran
    358-365 ms against a 200 ms deadline). The TLS socket is watched and the handshake gets only the time left."""
    from port_list import free_ports
    from services.http_download import DownloadTimeout, fetch
    port = free_ports()[0]
    listener = socket.socket()
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", port))
    listener.listen(2)
    stop = threading.Event()

    def proxy():
        try:
            conn, _ = listener.accept()
        except OSError:
            return
        with conn:
            try:
                conn.recv(65536)
                conn.sendall(b"HTTP/1.1 200 Connection established\r\n")
                for _ in range(8):                          # ~120 ms of headers, then the tunnel is "open"
                    conn.sendall(b"X-Proxy: y\r\n")
                    time.sleep(0.015)
                conn.sendall(b"\r\n")
                stop.wait(5)                                 # ... and the TLS ClientHello is never answered
            except OSError:
                return
    threading.Thread(target=proxy, daemon=True).start()
    for name in ("http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "no_proxy", "NO_PROXY", "all_proxy",
                 "ALL_PROXY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("https_proxy", f"http://127.0.0.1:{port}")
    try:
        started = time.monotonic()
        with pytest.raises(DownloadTimeout):
            fetch("https://reference.example.invalid/x.fa", str(tmp_path / "x.fa"), timeout=0.3, deadline=0.2)
        assert time.monotonic() - started < 0.27
    finally:
        stop.set()
        listener.close()


# --- round 10 ----------------------------------------------------------------------------------------------


def test_a_complete_content_length_download_succeeds(tmp_path):
    """Codex: on Python 3.11+ read1() closes the socket on reaching Content-Length; the held socket then raised
    EBADF and the complete file was deleted."""
    from services.http_download import fetch
    httpd, base = _mirror({"/ref.fa": b"ACGT"})
    try:
        for i in range(5):
            dest = tmp_path / f"ref{i}.fa"
            fetch(f"{base}/ref.fa", str(dest), timeout=5, deadline=5)
            assert dest.read_bytes() == b"ACGT"
    finally:
        httpd.shutdown()
        httpd.server_close()


def _cached_pair(tmp_path, fasta: bytes, fai: bytes, url: str):
    from state.browser_state import cached_fasta_path, record_fasta_source
    cache = tmp_path / "home" / ".fiberhmm" / "genomes"
    cache.mkdir(parents=True, exist_ok=True)
    local = cached_fasta_path(str(cache), [url])
    with open(local, "wb") as fh:
        fh.write(fasta)
    with open(local + ".fai", "wb") as fh:
        fh.write(fai)
    record_fasta_source(local, url)
    return cache, local


def _index_of(tmp_path, fasta: bytes) -> bytes:
    other = tmp_path / "other" / "o.fa"
    other.parent.mkdir(parents=True, exist_ok=True)
    other.write_bytes(fasta)
    pysam.faidx(str(other))
    return (tmp_path / "other" / "o.fa.fai").read_bytes()


WRAPPED = b">chr1\n" + b"A" * 80 + b"\n" + b"C" * 80 + b"\n"            # 168 bytes, two lines
UNWRAPPED_161 = b">chr1\n" + b"A" * 161 + b"\n"                          # 168 bytes, one 161-base line


@pytest.mark.parametrize("read_only", [False, True])
def test_a_same_size_index_with_other_line_geometry_is_never_used(tmp_path, monkeypatch, read_only):
    """Codex's reproduction: the cached FASTA wraps 80 A + 80 C on two lines; its stale index (native-built) is for
    a 161-base unwrapped record of the same size. Writable: rebuilt (CCCC at 80:84). Read-only: refused."""
    import os
    import stat
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    assert len(WRAPPED) == len(UNWRAPPED_161) == 168
    stale = _index_of(tmp_path, UNWRAPPED_161)
    httpd, base = _mirror({})
    url = f"{base}/ref.fa"
    cache, local = _cached_pair(tmp_path, WRAPPED, stale, url)
    if read_only:
        os.chmod(cache, stat.S_IRUSR | stat.S_IXUSR)
    try:
        state = BrowserState(None)
        error = state._load_fasta(url, fasta_urls=[url])
        if read_only:
            assert error and "does not match" in error and "cannot be replaced" in error, error
            assert getattr(state, "fasta", None) is None
        else:
            assert error is None, error
            assert pysam.FastaFile(local).fetch("chr1", 80, 84) == "CCCC"
            assert pysam.FastaFile(local).get_reference_length("chr1") == 160
    finally:
        os.chmod(cache, stat.S_IRWXU)
        httpd.shutdown()
        httpd.server_close()


def test_a_downloaded_fasta_is_indexed_locally_and_a_served_index_is_not_used(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    requested = []
    httpd, base = _mirror({"/ref.fa": WRAPPED, "/ref.fa.fai": _index_of(tmp_path, UNWRAPPED_161)})
    real_fetch = __import__("services.http_download", fromlist=["fetch"]).fetch

    def recording(url, *a, **k):
        requested.append(url)
        return real_fetch(url, *a, **k)
    monkeypatch.setattr("services.http_download.fetch", recording)
    try:
        url = f"{base}/ref.fa"
        local = BrowserState._download_fasta_to_cache(url, fasta_urls=[url], fai_urls=[url + ".fai"])
        assert requested == [url]                                       # the served index is not fetched
        assert pysam.FastaFile(local).fetch("chr1", 80, 84) == "CCCC"
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_a_verified_pair_is_stamped_and_later_loads_skip_indexing(tmp_path, monkeypatch):
    import json
    import os
    import state.browser_state as bs
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    cache = tmp_path / "home" / ".fiberhmm" / "genomes"          # stamps are kept for the download cache only
    cache.mkdir(parents=True)
    fasta = cache / "ref.fa"
    fasta.write_bytes(WRAPPED)
    pysam.faidx(str(fasta))
    builds = []
    real_build = bs._build_index
    monkeypatch.setattr(bs, "_build_index", lambda f, o: builds.append(f) or real_build(f, o))
    bs.ensure_verified_index(str(fasta))
    assert len(builds) == 1
    stamp = json.loads((cache / "ref.fa.fai.verified").read_text())
    assert stamp["fasta_size"] == 168 and len(stamp["fai_sha256"]) == 64
    assert {"fasta_device", "fasta_inode", "fasta_ctime_ns", "fasta_mtime_ns"} <= set(stamp)
    bs.ensure_verified_index(str(fasta))
    assert len(builds) == 1                                              # stamped: no re-indexing
    # A changed index or FASTA invalidates the stamp: verified again (and repaired).
    (cache / "ref.fa.fai").write_bytes(_index_of(tmp_path, UNWRAPPED_161))
    bs.ensure_verified_index(str(fasta))
    assert len(builds) == 2 and pysam.FastaFile(str(fasta)).fetch("chr1", 80, 84) == "CCCC"
    fasta.write_bytes(UNWRAPPED_161)
    os.utime(fasta, ns=(1, 1))
    bs.ensure_verified_index(str(fasta))
    assert len(builds) == 3 and pysam.FastaFile(str(fasta)).get_reference_length("chr1") == 161


def test_a_megabyte_long_header_is_accepted(tmp_path):
    """Codex: a 1,048,577-byte header was refused although native pysam indexes and reads it."""
    from state.browser_state import _fai_matches_fasta, ensure_verified_index
    fasta = tmp_path / "long.fa"
    fasta.write_bytes(b">chr1 " + b"d" * (1 << 20) + b"\nACGT\n")
    ensure_verified_index(str(fasta))
    assert _fai_matches_fasta(str(fasta) + ".fai", str(fasta))
    assert pysam.FastaFile(str(fasta)).fetch("chr1") == "ACGT"


# --- round 11 ----------------------------------------------------------------------------------------------


def _registry_cache(tmp_path, monkeypatch, fasta: bytes, fai: bytes):
    from state.browser_state import cached_fasta_path, record_fasta_source
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    url = "https://reference.example.invalid/genomes/ref.fa"
    cache = tmp_path / "home" / ".fiberhmm" / "genomes"
    cache.mkdir(parents=True, exist_ok=True)
    local = cached_fasta_path(str(cache), [url])
    with open(local, "wb") as fh:
        fh.write(fasta)
    with open(local + ".fai", "wb") as fh:
        fh.write(fai)
    record_fasta_source(local, url)
    return cache, local, {"name": "Test genome", "fasta_urls": [url]}


@pytest.mark.parametrize("read_only", [False, True])
def test_a_cached_registry_reference_is_verified_through_load_genome_blocking(tmp_path, monkeypatch, read_only):
    """Codex round 11: load_genome_blocking opened the cached FASTA with its stale index (zero verification
    builds; pysam read '\nCCC' and length 161). Writable: rebuilt. Read-only: refused."""
    import os
    import stat
    import state.browser_state as bs
    from services.genome_loading import load_genome_blocking
    cache, local, info = _registry_cache(tmp_path, monkeypatch, WRAPPED, _index_of(tmp_path, UNWRAPPED_161))
    monkeypatch.setattr("services.http_download.fetch", lambda *a, **k: pytest.fail("no download expected"))
    builds = []
    real_build = bs._build_index
    monkeypatch.setattr(bs, "_build_index", lambda f, o: builds.append(f) or real_build(f, o))
    if read_only:
        os.chmod(cache, stat.S_IRUSR | stat.S_IXUSR)
    try:
        state = BrowserState(None)
        result = load_genome_blocking(state, "testgenome", info)
        assert len(builds) == 1
        if read_only:
            assert result["fasta_loaded"] is False
            assert "does not match" in result.get("fasta_error", "") or getattr(state, "fasta", None) is None
            assert getattr(state, "fasta", None) is None
        else:
            assert result["fasta_loaded"] is True, result
            assert state.fasta.fetch("chr1", 80, 84) == "CCCC"
            assert pysam.FastaFile(local).get_reference_length("chr1") == 160
            assert state.fasta_path == local
    finally:
        os.chmod(cache, stat.S_IRWXU)


def test_a_cached_pipeline_reference_is_verified(tmp_path, monkeypatch):
    from services import genome_registry, pipeline_inputs
    cache, local, info = _registry_cache(tmp_path, monkeypatch, WRAPPED, _index_of(tmp_path, UNWRAPPED_161))
    monkeypatch.setitem(genome_registry.GENOME_REGISTRY, "testgenome", info)
    assert pipeline_inputs.catalog_genome_fasta("testgenome", verify=False) == (local, None)
    assert pysam.FastaFile(local).get_reference_length("chr1") == 161                 # still stale: a listing
    assert pipeline_inputs.catalog_genome_fasta("testgenome") == (local, None)
    assert pysam.FastaFile(local).get_reference_length("chr1") == 160                 # verified before use


def test_an_in_place_edit_keeping_size_mtime_and_inode_is_reverified(tmp_path, monkeypatch):
    """Codex round 11: the same-size wrapped FASTA written over the stamped unwrapped one, mtime restored and the
    inode kept. The ctime changes, so the stamp no longer matches."""
    import os
    import state.browser_state as bs
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    cache = tmp_path / "home" / ".fiberhmm" / "genomes"
    cache.mkdir(parents=True)
    fasta = cache / "ref.fa"
    fasta.write_bytes(UNWRAPPED_161)
    bs.ensure_verified_index(str(fasta))
    before = os.stat(fasta)
    time.sleep(0.01)
    with open(fasta, "r+b") as fh:
        fh.write(WRAPPED)
    os.utime(fasta, ns=(before.st_atime_ns, before.st_mtime_ns))
    after = os.stat(fasta)
    assert (after.st_ino, after.st_size, after.st_mtime_ns) == (before.st_ino, before.st_size, before.st_mtime_ns)
    bs.ensure_verified_index(str(fasta))
    assert pysam.FastaFile(str(fasta)).fetch("chr1", 80, 84) == "CCCC"


def test_stamps_are_not_trusted_or_written_outside_the_download_cache(tmp_path, monkeypatch):
    import state.browser_state as bs
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    fasta = tmp_path / "elsewhere" / "ref.fa"
    fasta.parent.mkdir()
    fasta.write_bytes(WRAPPED)
    builds = []
    real_build = bs._build_index
    monkeypatch.setattr(bs, "_build_index", lambda f, o: builds.append(f) or real_build(f, o))
    bs.ensure_verified_index(str(fasta))
    bs.ensure_verified_index(str(fasta))
    assert len(builds) == 2 and not (fasta.parent / "ref.fa.fai.verified").exists()


def test_a_compressed_file_is_never_indexed_by_the_verifier(tmp_path):
    import gzip
    from state.browser_state import ReferenceIndexError, ensure_verified_index
    fasta = tmp_path / "ref.fa"
    fasta.write_bytes(gzip.compress(WRAPPED))
    with pytest.raises(ReferenceIndexError, match="compressed"):
        ensure_verified_index(str(fasta))
    assert sorted(p.name for p in tmp_path.iterdir()) == ["ref.fa"]           # no .fai, no .gzi beside it


def test_two_verifiers_publishing_at_once_both_succeed(tmp_path, monkeypatch):
    """Codex round 11: two unsynchronised verifiers shared <fai>.tmp; one failed although the index was right."""
    import state.browser_state as bs
    fasta = tmp_path / "ref.fa"
    fasta.write_bytes(WRAPPED)
    (tmp_path / "ref.fa.fai").write_bytes(_index_of(tmp_path, UNWRAPPED_161))
    barrier = threading.Barrier(2)
    real_replace = bs.os.replace

    def interleaved(src, dst):
        if str(dst).endswith(".fai"):
            barrier.wait(5)                     # both have written their temporary file before either renames
        return real_replace(src, dst)
    monkeypatch.setattr(bs.os, "replace", interleaved)
    errors = []

    def verify():
        try:
            bs.ensure_verified_index(str(fasta))
        except Exception as exc:   # noqa: BLE001
            errors.append(exc)
    threads = [threading.Thread(target=verify) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(30)
    assert not errors, errors
    assert pysam.FastaFile(str(fasta)).fetch("chr1", 80, 84) == "CCCC"
    assert not list(tmp_path.glob("*.tmp"))


def test_indexing_a_large_reference_keeps_the_event_loop_responsive(tmp_path):
    """Codex round 11: in-process pysam.faidx held the GIL (a 6.6-14.4 s heartbeat pause on hg38). Indexing runs
    in a child process: a 10 ms heartbeat keeps ticking through it."""
    import asyncio
    import state.browser_state as bs
    fasta = tmp_path / "big.fa"
    line = b"ACGT" * 15 + b"\n"
    block = line * 16384                                                    # ~1 MB
    with open(fasta, "wb") as fh:
        for i in range(4):
            fh.write(b">chr%d\n" % i)
            for _ in range(60):
                fh.write(block)

    async def run():
        gaps, last, done = [], [time.monotonic()], asyncio.Event()

        async def beat():
            while not done.is_set():
                await asyncio.sleep(0.01)
                now = time.monotonic()
                gaps.append(now - last[0])
                last[0] = now
        ticker = asyncio.create_task(beat())
        started = time.monotonic()
        ok = await asyncio.to_thread(bs._build_index, str(fasta), str(tmp_path / "out.fai"))
        took = time.monotonic() - started
        done.set()
        await ticker
        return ok, took, max(gaps)
    ok, took, worst = asyncio.run(run())
    assert ok and (tmp_path / "out.fai").exists()
    assert took > 0.2, took                                                 # long enough to matter
    assert worst < 0.1, (worst, took)


# --- round 12 ----------------------------------------------------------------------------------------------


@pytest.mark.parametrize("compression", ["gzip", "bgzf"])
def test_a_compressed_cached_registry_reference_is_decompressed_and_loaded(tmp_path, monkeypatch, compression):
    """Codex round 12: gzip bytes at the cached .fa path, no .fai. The registry load decompresses it in place
    (atomically), indexes the plain file and loads it, as before round 11."""
    import gzip
    import state.browser_state as bs
    from services.genome_loading import load_genome_blocking
    if compression == "gzip":
        data = gzip.compress(WRAPPED)
    else:
        raw = tmp_path / "bgzf_src.fa"
        raw.write_bytes(WRAPPED)
        pysam.tabix_compress(str(raw), str(raw) + ".gz", force=True)
        data = (tmp_path / "bgzf_src.fa.gz").read_bytes()
    cache, local, info = _registry_cache(tmp_path, monkeypatch, data, b"")
    import os
    os.remove(local + ".fai")                                    # Codex: no .fai
    monkeypatch.setattr("services.http_download.fetch", lambda *a, **k: pytest.fail("no download expected"))
    state = BrowserState(None)
    result = load_genome_blocking(state, "testgenome", info)
    assert result["fasta_loaded"] is True, result
    assert open(local, "rb").read() == WRAPPED                    # plain now
    assert state.fasta.fetch("chr1", 80, 84) == "CCCC"
    assert bs._fai_matches_fasta(local + ".fai", local)
    assert not list(cache.glob("*.tmp")) and not (cache / (os.path.basename(local) + ".gzi")).exists()
