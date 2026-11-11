"""The run wizard's genome download (services/genome_download.py) and reference choice.

The bug: with dm6 open from the user's own FASTA (``--fasta dm6.fa``), Download in the New DAF-seq run wizard
called /api/load_genome, which answered "already loaded" without downloading, so the wizard still said "not
downloaded" and Next stayed blocked. Now the open local FASTA is the run's reference, and Download fetches the
FASTA into the cache only, with progress and each mirror's error. No real network: a local HTTP mirror, or
http_download.fetch replaced.
"""
from __future__ import annotations

import gzip
import os
import threading
import time
from types import SimpleNamespace

import pytest

from services import genome_download, http_download
from services import pipeline_inputs as pi

FASTA = b">chr1\nACGTACGTAC\n>chr2\nTTTTGGGG\n"


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    genome_download._reset_for_tests()
    yield tmp_path / "home"
    genome_download._reset_for_tests()


def _registry(monkeypatch, urls, genome_id="testg"):
    from services import genome_registry
    entry = {"name": f"Test genome ({genome_id})", "fasta_urls": list(urls)}
    monkeypatch.setitem(genome_registry.GENOME_REGISTRY, genome_id, entry)
    return genome_id


def _mirror(files):
    """A local HTTP server: path -> bytes (404 otherwise)."""
    import http.server

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

    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f"http://127.0.0.1:{httpd.server_address[1]}"


def _wait(genome_id, timeout=20.0):
    ends = time.monotonic() + timeout
    while time.monotonic() < ends:
        st = genome_download.status(genome_id)
        if st["state"] != "running":
            return st
        time.sleep(0.02)
    raise AssertionError(f"download still running: {genome_download.status(genome_id)}")


# --------------------------------------------------------------------------
# The open local FASTA is the run's reference (the owner's case)
# --------------------------------------------------------------------------

def _state_with_local_fasta(tmp_path, genome_id="dm6", index=True):
    fa = tmp_path / "user" / f"{genome_id}.fa"
    fa.parent.mkdir(parents=True, exist_ok=True)
    fa.write_bytes(FASTA)
    if index:
        import pysam
        pysam.faidx(str(fa))
    return SimpleNamespace(current_genome=genome_id, fasta=object(), fasta_path=str(fa), registry_fasta=None,
                           gtf_path=None, plasmid_metadata={}), str(fa)


def test_the_open_local_fasta_of_the_chosen_genome_is_the_runs_reference(home, tmp_path):
    state, fa = _state_with_local_fasta(tmp_path)
    before = sorted(os.listdir(os.path.dirname(fa)))
    ref = pi.resolve_reference({"kind": "genome", "genome_id": "dm6"}, state)
    assert ref["path"] == fa and ref["kind"] == "fasta" and ref["genome_id"] == "dm6"
    dm6 = next(g for g in pi.genome_choices(state) if g["id"] == "dm6")
    assert dm6["downloaded"] and dm6["loaded"] and dm6["fasta"] == fa
    # The user's file is only read: nothing written beside it (no .fai.verified stamp).
    assert sorted(os.listdir(os.path.dirname(fa))) == before


def test_without_the_workspace_an_undownloaded_genome_still_asks_for_the_download(home, tmp_path):
    with pytest.raises(pi.InputError) as err:
        pi.resolve_reference({"kind": "genome", "genome_id": "dm6"})
    assert err.value.hint == "download_genome"


@pytest.mark.parametrize("change", ["no_index", "stale_index", "other_index", "other_genome", "remote"])
def test_only_a_local_indexed_fasta_of_that_genome_counts(home, tmp_path, change):
    state, fa = _state_with_local_fasta(tmp_path, index=change != "no_index")
    if change == "stale_index":
        # An index older than the FASTA would be rebuilt beside the user's file by fiberhmm-pipeline.
        os.utime(fa + ".fai", (time.time() - 3600, time.time() - 3600))
    if change == "other_index":
        # A newer index of another file (other contig lengths) would be rebuilt beside it too.
        with open(fa + ".fai", "w") as handle:
            handle.write("chr1\t12\t6\t10\t11\nchr2\t8\t26\t8\t9\n")
    before = sorted(os.listdir(os.path.dirname(fa)))
    if change == "other_genome":
        state.current_genome = "hg38"
    if change == "remote":
        state.fasta_path = "https://example.org/dm6.fa"
    with pytest.raises(pi.InputError):
        pi.resolve_reference({"kind": "genome", "genome_id": "dm6"}, state)
    assert sorted(os.listdir(os.path.dirname(fa))) == before   # nothing written beside the user's file


def test_the_validate_route_uses_the_open_fasta(home, tmp_path, client, monkeypatch):
    from state.dependencies import get_state
    state, fa = _state_with_local_fasta(tmp_path)
    app = client.app
    app.dependency_overrides[get_state] = lambda: state
    try:
        body = {"samples": [], "reference": {"kind": "genome", "genome_id": "dm6"}, "enzyme": "dddb",
                "output_root": str(tmp_path / "out"), "cores": 1}
        res = client.post("/api/pipeline/validate", json=body).json()
        assert not any(e["field"] == "reference" for e in res["errors"]), res["errors"]
    finally:
        app.dependency_overrides.pop(get_state, None)


# --------------------------------------------------------------------------
# Download: cache only, mirrors in turn, gzip by its bytes, errors per mirror, cancel
# --------------------------------------------------------------------------

def test_a_failed_mirror_falls_back_and_gzip_bytes_under_a_fa_name_are_decompressed(home, monkeypatch):
    """UCSC serves dm6.fa.gz's bytes for .../dm6.fa (content negotiation): the cache must hold plain FASTA."""
    httpd, base = _mirror({"/ucsc/ref.fa": gzip.compress(FASTA)})
    try:
        gid = _registry(monkeypatch, [f"{base}/igv/ref.fa", f"{base}/ucsc/ref.fa"])
        first = genome_download.start(gid)
        assert first["state"] in ("running", "done")
        st = _wait(gid)
        assert st["state"] == "done", st
        with open(st["fasta"], "rb") as fh:
            assert fh.read() == FASTA
        assert os.path.exists(st["fasta"] + ".fai")
        assert st["errors"] == [{"url": f"{base}/igv/ref.fa", "error": "HTTP 404 Not Found"}]
        # The wizard now finds it; a second start does not download again.
        assert pi.catalog_genome_fasta(gid)[0] == st["fasta"]
        assert genome_download.start(gid)["state"] == "done"
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_every_mirror_failing_says_which_url_failed_and_why(home, monkeypatch):
    httpd, base = _mirror({"/html/ref.fa": b"<html>Not here</html>"})
    try:
        gid = _registry(monkeypatch, [f"{base}/missing/ref.fa", f"{base}/html/ref.fa"])
        genome_download.start(gid)
        st = _wait(gid)
        assert st["state"] == "error"
        assert [e["url"] for e in st["errors"]] == [f"{base}/missing/ref.fa", f"{base}/html/ref.fa"]
        assert st["errors"][0]["error"] == "HTTP 404 Not Found"
        assert "not a FASTA" in st["errors"][1]["error"] or "other than a FASTA" in st["errors"][1]["error"]
        assert f"{base}/missing/ref.fa" in st["error"]
        cache = home / ".fiberhmm" / "genomes"
        assert not [n for n in os.listdir(cache) if n.startswith("ref.fa")]   # nothing half-written
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_an_unreachable_host_is_reported(home, monkeypatch):
    gid = _registry(monkeypatch, ["http://127.0.0.1:9/ref.fa"])   # discard port: connection refused
    genome_download.start(gid)
    st = _wait(gid)
    assert st["state"] == "error"
    assert st["errors"][0]["error"].startswith("could not reach the server")


def test_progress_is_reported_and_cancel_stops_without_trying_the_next_mirror(home, monkeypatch):
    fetched = []
    release = threading.Event()

    def slow_fetch(url, dest, reporthook=None, **kw):
        fetched.append(url)
        with open(dest, "wb") as out:
            for block in range(1000):
                out.write(b"A" * 10)
                out.flush()
                if reporthook:
                    reporthook(block, 1 << 20, 1000 << 20)
                if block == 3:
                    release.set()
                time.sleep(0.01)
        return dest, None

    monkeypatch.setattr(http_download, "fetch", slow_fetch)
    gid = _registry(monkeypatch, ["https://one.example/ref.fa", "https://two.example/ref.fa"])
    genome_download.start(gid)
    assert release.wait(10)
    st = genome_download.status(gid)
    assert st["state"] == "running" and st["total"] == 1000 << 20 and st["bytes"] > 0
    assert st["url"] == "https://one.example/ref.fa"
    genome_download.cancel(gid)
    st = _wait(gid)
    assert st["state"] == "cancelled"
    assert fetched == ["https://one.example/ref.fa"]
    cache = home / ".fiberhmm" / "genomes"
    assert not [n for n in os.listdir(cache) if n.startswith("ref.fa")]


def test_the_download_never_touches_the_open_genome(home, monkeypatch, client):
    httpd, base = _mirror({"/ref.fa": FASTA})
    try:
        gid = _registry(monkeypatch, [f"{base}/ref.fa"])
        from state.dependencies import get_state
        app = client.app
        state = SimpleNamespace(current_genome="dm6", fasta=None, fasta_path=None)
        app.dependency_overrides[get_state] = lambda: state
        try:
            assert client.post(f"/api/pipeline/genome_download?genome_id={gid}").json()["state"] in ("running", "done")
            ends = time.monotonic() + 20
            while client.get(f"/api/pipeline/genome_download?genome_id={gid}").json()["state"] == "running":
                assert time.monotonic() < ends
                time.sleep(0.02)
            assert client.get(f"/api/pipeline/genome_download?genome_id={gid}").json()["state"] == "done"
            assert client.get("/api/pipeline/genome_download?genome_id=nope").json()["state"] == "idle"
            assert client.post("/api/pipeline/genome_download?genome_id=nope").json()["state"] == "error"
        finally:
            app.dependency_overrides.pop(get_state, None)
        assert state.current_genome == "dm6" and state.fasta_path is None
    finally:
        httpd.shutdown()
        httpd.server_close()



def test_a_download_whose_index_fails_is_discarded_and_retry_downloads_again(home, monkeypatch):
    """A mirror's file that cannot be indexed is not left in the cache: Retry downloads it again instead of
    reporting done for a file validation would refuse."""
    from state import browser_state
    httpd, base = _mirror({"/ref.fa": FASTA})
    try:
        gid = _registry(monkeypatch, [f"{base}/ref.fa"])
        real = browser_state.ensure_verified_index
        calls = []

        def failing_once(path):
            calls.append(path)
            if len(calls) == 1:
                raise browser_state.ReferenceIndexError("the index could not be built")
            return real(path)

        monkeypatch.setattr(browser_state, "ensure_verified_index", failing_once)
        genome_download.start(gid)
        st = _wait(gid)
        assert st["state"] == "error" and "index could not be built" in st["error"]
        cache = home / ".fiberhmm" / "genomes"
        assert not [n for n in os.listdir(cache) if n.startswith("ref.fa")]
        genome_download.start(gid)   # Retry
        st = _wait(gid)
        assert st["state"] == "done" and os.path.isfile(st["fasta"])
        assert pi.catalog_genome_fasta(gid)[0] == st["fasta"]
    finally:
        httpd.shutdown()


def test_cancel_during_indexing_is_honoured_and_keeps_nothing(home, monkeypatch):
    from state import browser_state
    httpd, base = _mirror({"/ref.fa": FASTA})
    try:
        gid = _registry(monkeypatch, [f"{base}/ref.fa"])
        indexing, proceed = threading.Event(), threading.Event()
        real = browser_state.ensure_verified_index

        def slow_index(path):
            indexing.set()
            assert proceed.wait(10)
            return real(path)

        monkeypatch.setattr(browser_state, "ensure_verified_index", slow_index)
        genome_download.start(gid)
        assert indexing.wait(10)
        genome_download.cancel(gid)
        proceed.set()
        st = _wait(gid)
        assert st["state"] == "cancelled"
        cache = home / ".fiberhmm" / "genomes"
        assert not [n for n in os.listdir(cache) if n.startswith("ref.fa")]
    finally:
        httpd.shutdown()


def test_a_mirror_whose_file_cannot_be_indexed_falls_back_to_the_next(home, monkeypatch):
    """The first mirror sends something beginning with '>' that cannot be indexed: it is removed and the next
    mirror's FASTA is used."""
    from state import browser_state
    bad = b">chr1\nACGT\nACGTACGT\nAC\n"   # uneven line lengths: HTSlib refuses to index it
    httpd, base = _mirror({"/bad/ref.fa": bad, "/good/ref.fa": FASTA})
    try:
        gid = _registry(monkeypatch, [f"{base}/bad/ref.fa", f"{base}/good/ref.fa"])
        genome_download.start(gid)
        st = _wait(gid)
        assert st["state"] == "done", st
        assert [e["url"] for e in st["errors"]] == [f"{base}/bad/ref.fa"]
        with open(st["fasta"], "rb") as handle:
            assert handle.read() == FASTA
        assert pi.catalog_genome_fasta(gid)[0] == st["fasta"]
    finally:
        httpd.shutdown()
