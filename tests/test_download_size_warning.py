"""Downloads: no size cap, a warning size (3.1.0, owner decision).

services/http_download.fetch refuses a download whose Content-Length is over the warning size until it is
confirmed (nothing written, no other mirror tried), lets a confirmed one go ahead, and warns once, without
cancelling, when a body of unknown size streams past it. The threshold is a setting (app setting
``downloads.warn_bytes``, ``FIBERBROWSER_DOWNLOAD_WARN_BYTES``; default 4 GB). The wizard's genome download
and /api/load_genome go through it: both say the size and ask. No real network: a local HTTP server.
"""
from __future__ import annotations

import http.server
import json
import os
import threading
import time

import pytest

from services import genome_download, http_download

FASTA = b">chr1\n" + b"ACGT" * 2000 + b"\n"   # 8,006 bytes


class _Handler(http.server.BaseHTTPRequestHandler):
    files: dict = {}
    served: list = []

    def _send(self, body_wanted: bool):
        body = self.files.get(self.path.split("?")[0].rstrip("/").replace("/chunked", ""))
        if body is None:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(200)
        if self.path.startswith("/chunked"):
            # No Content-Length: the size is unknown until the body ends (HTTP/1.0, close-delimited).
            self.send_header("Connection", "close")
            self.end_headers()
        else:
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
        if body_wanted:
            for i in range(0, len(body), 1000):
                self.wfile.write(body[i:i + 1000])
                self.served.append(1000)

    def do_GET(self):
        self._send(True)

    def do_HEAD(self):
        self._send(False)

    def log_message(self, *a):
        pass


@pytest.fixture
def server():
    _Handler.files = {"/genome.fa": FASTA}
    _Handler.served = []
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{httpd.server_address[1]}"
    finally:
        httpd.shutdown()
        httpd.server_close()


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("FIBERBROWSER_APP_SETTINGS", str(tmp_path / "app_settings.json"))
    monkeypatch.delenv(http_download.WARN_BYTES_ENV, raising=False)
    genome_download._reset_for_tests()
    yield tmp_path / "home"
    genome_download._reset_for_tests()


# ── the threshold ─────────────────────────────────────────────────────────────

def test_threshold_default_setting_and_environment(home, monkeypatch):
    from services import app_settings
    assert http_download.warn_bytes() == http_download.DEFAULT_WARN_BYTES == 4_000_000_000
    app_settings.update("downloads", {"warn_bytes": 2_000_000_000})
    assert http_download.warn_bytes() == 2_000_000_000
    monkeypatch.setenv(http_download.WARN_BYTES_ENV, "1000")
    assert http_download.warn_bytes() == 1000
    monkeypatch.delenv(http_download.WARN_BYTES_ENV)
    app_settings.update("downloads", {"warn_bytes": None})
    assert http_download.warn_bytes() == http_download.DEFAULT_WARN_BYTES
    with pytest.raises(ValueError):
        app_settings.update("downloads", {"warn_bytes": -1})


# Content-Length of every catalog download (HEAD, 20 Nov 2026): the largest is hg38's plain FASTA from igv.org.
CATALOG_SIZES = {
    "hg38 igv FASTA": 3_273_481_150, "hg38 UCSC FASTA": 983_659_424, "hg38 GTF": 30_390_388,
    "hg19 igv FASTA": 3_199_905_909, "hg19 UCSC FASTA": 948_731_419, "hg19 GTF": 40_033_986,
    "mm39 FASTA.gz": 870_543_764, "mm10 FASTA.gz": 870_141_360, "mm39 GTF": 20_237_514, "mm10 GTF": 19_833_013,
    "dm6 igv FASTA": 146_638_899, "dm6 UCSC FASTA": 45_153_922, "dm6 GTF": 7_131_291,
    "sacCer3 FASTA.gz": 3_820_548, "sacCer3 GTF": 595_453,
}


def test_catalog_downloads_are_under_the_default_threshold():
    """The default asks for no catalog download (sizes measured above), while a 2 GB default would ask for every
    hg38 and hg19 load from the first mirror."""
    assert max(CATALOG_SIZES.values()) < http_download.DEFAULT_WARN_BYTES
    assert sum(size > 2_000_000_000 for size in CATALOG_SIZES.values()) == 2


# ── fetch ─────────────────────────────────────────────────────────────────────

def test_known_size_over_the_threshold_waits_for_confirmation(server, tmp_path):
    dest = tmp_path / "out.fa"
    events: list = []
    with http_download.download_policy(events=events, threshold=5000):
        with pytest.raises(http_download.LargeDownload) as err:
            http_download.fetch(f"{server}/genome.fa", str(dest))
        assert http_download.confirmation_needed()["bytes"] == len(FASTA)
    assert (err.value.total, err.value.threshold) == (len(FASTA), 5000)
    assert not dest.exists()
    assert events == [{"kind": "confirm", "url": f"{server}/genome.fa", "bytes": len(FASTA), "threshold": 5000}]


def test_confirmed_download_goes_ahead_and_is_reported(server, tmp_path):
    dest = tmp_path / "out.fa"
    heard = []
    with http_download.download_policy(confirmed=True, threshold=5000, on_large=lambda *a: heard.append(a)):
        http_download.fetch(f"{server}/genome.fa", str(dest))
    assert dest.read_bytes() == FASTA
    assert heard == [(f"{server}/genome.fa", len(FASTA), 5000)]


def test_under_the_threshold_nothing_is_asked(server, tmp_path):
    dest = tmp_path / "out.fa"
    events: list = []
    with http_download.download_policy(events=events, threshold=len(FASTA)):
        http_download.fetch(f"{server}/genome.fa", str(dest))
    assert dest.read_bytes() == FASTA and events == []


def test_unknown_size_warns_once_past_the_threshold_without_cancelling(server, tmp_path):
    dest = tmp_path / "out.fa"
    events: list = []
    heard = []
    with http_download.download_policy(events=events, threshold=3000, on_large=lambda *a: heard.append(a)):
        http_download.fetch(f"{server}/chunked/genome.fa", str(dest))
    assert dest.read_bytes() == FASTA
    assert [e["kind"] for e in events] == ["large_unknown_size"] and len(heard) == 1
    assert 3000 < heard[0][1] <= len(FASTA)


def test_a_caller_that_cannot_ask_downloads_with_a_warning(server, tmp_path, capsys):
    """No download_policy (a FASTA URL opened at start-up, from a session, a link or a panel genome): nothing can
    ask, so a large download is never refused, only warned about."""
    dest = tmp_path / "out.fa"
    http_download.fetch(f"{server}/genome.fa", str(dest), warn_at=5000)
    assert dest.read_bytes() == FASTA
    assert "WARNING: large download, 8.0 KB (over the 5.0 KB download warning size)" in capsys.readouterr().out


def test_load_fasta_url_without_a_policy_is_not_refused(home, server, monkeypatch):
    """BrowserState._load_fasta with a URL (start-up --fasta, sessions, links, panel genomes) goes ahead."""
    from state.browser_state import BrowserState
    monkeypatch.setenv(http_download.WARN_BYTES_ENV, "5000")
    state = BrowserState(None)
    assert state._load_fasta(f"{server}/genome.fa") is None
    assert state.fasta is not None
    state.fasta.close()


def test_threshold_zero_turns_the_warning_off(server, tmp_path):
    dest = tmp_path / "out.fa"
    http_download.fetch(f"{server}/genome.fa", str(dest), warn_at=0)
    assert dest.read_bytes() == FASTA


def test_probe_size(server):
    assert http_download.probe_size(f"{server}/genome.fa") == len(FASTA)
    assert http_download.probe_size(f"{server}/chunked/genome.fa") is None
    assert http_download.probe_size(f"{server}/missing.fa") is None
    assert _Handler.served == []   # HEAD only: no body


# ── the wizard's genome download ─────────────────────────────────────────────

def _registry(monkeypatch, urls, genome_id="sizeg"):
    from services import genome_registry
    monkeypatch.setitem(genome_registry.GENOME_REGISTRY, genome_id, {"name": f"Test ({genome_id})", "fasta_urls": urls})
    return genome_id


def _wait(genome_id, timeout=20.0):
    ends = time.monotonic() + timeout
    while time.monotonic() < ends:
        st = genome_download.status(genome_id)
        if st["state"] != "running":
            return st
        time.sleep(0.02)
    raise AssertionError(f"download still running: {genome_download.status(genome_id)}")


def test_wizard_download_shows_the_size_asks_then_goes_ahead(home, server, monkeypatch):
    monkeypatch.setenv(http_download.WARN_BYTES_ENV, "5000")
    # Two mirrors: one confirmation covers both; the refusal never tries the second.
    gid = _registry(monkeypatch, [f"{server}/genome.fa", f"{server}/second/genome.fa"])
    size = genome_download.size(gid)
    assert (size["bytes"], size["threshold"], size["over"]) == (len(FASTA), 5000, True)
    genome_download.start(gid)
    st = _wait(gid)
    assert st["state"] == "confirm" and (st["total"], st["threshold"]) == (len(FASTA), 5000)
    assert st["errors"] == [] and not st.get("fasta")
    genome_download.start(gid, confirm_large=True)
    st = _wait(gid)
    assert st["state"] == "done" and os.path.exists(st["fasta"])
    assert "over the 5.0 KB download warning size" in st["warning"]


def test_wizard_download_of_unknown_size_warns_and_finishes(home, server, monkeypatch):
    monkeypatch.setenv(http_download.WARN_BYTES_ENV, "3000")
    gid = _registry(monkeypatch, [f"{server}/chunked/genome.fa"], genome_id="sizeu")
    assert genome_download.size(gid)["bytes"] is None
    genome_download.start(gid)
    st = _wait(gid)
    assert st["state"] == "done" and st["warning"] and "Large download" in st["warning"]


def test_size_route_and_confirm_param(home, server, monkeypatch, client):
    monkeypatch.setenv(http_download.WARN_BYTES_ENV, "5000")
    gid = _registry(monkeypatch, [f"{server}/genome.fa"], genome_id="sizer")
    body = client.get("/api/pipeline/genome_download/size", params={"genome_id": gid}).json()
    assert body["bytes"] == len(FASTA) and body["over"] is True
    client.post("/api/pipeline/genome_download", params={"genome_id": gid})
    assert _wait(gid)["state"] == "confirm"
    client.post("/api/pipeline/genome_download", params={"genome_id": gid, "confirm_large": "true"})
    assert _wait(gid)["state"] == "done"


# ── /api/load_genome ──────────────────────────────────────────────────────────

def test_load_genome_asks_before_a_large_download_and_changes_nothing(home, server, monkeypatch, client):
    from services import genome_registry
    monkeypatch.setenv(http_download.WARN_BYTES_ENV, "5000")
    gid = "sizel"
    monkeypatch.setitem(genome_registry.GENOME_REGISTRY, gid, {
        "name": "Test (sizel)", "fasta_urls": [f"{server}/genome.fa"], "gtf_url": f"{server}/genes.gtf"})
    _Handler.files["/genes.gtf"] = b'chr1\tt\tgene\t1\t100\t.\t+\t.\tgene_id "g1"; gene_name "G1";\n'
    from state.browser_state import BrowserState
    from state.dependencies import get_state
    state = BrowserState(None)   # its own state: the app is shared with other tests
    client.app.dependency_overrides[get_state] = lambda: state
    try:
        res = client.post("/api/load_genome", params={"genome_id": gid}).json()
        assert res["needs_confirmation"] is True and not res["success"]
        assert res["download"]["bytes"] == len(FASTA) and res["download"]["threshold"] == 5000
        assert getattr(state, "current_genome", None) is None and state.fasta is None
        assert not os.path.exists(os.path.join(str(home), ".fiberhmm", "genomes", "sizel.gtf"))
        res = client.post("/api/load_genome", params={"genome_id": gid, "confirm_large": "true"}).json()
        assert res["success"] and res.get("fasta_loaded") and not res.get("needs_confirmation")
        assert res["download_warnings"][0]["kind"] == "large_confirmed"
        assert state.current_genome == gid
    finally:
        client.app.dependency_overrides.pop(get_state, None)
        if state.fasta is not None:
            state.fasta.close()


def test_load_genome_finishes_a_large_annotation_after_confirmation(home, server, monkeypatch, client):
    """3.1.0 audit: a GTF over the warning size was caught as an ordinary GTF failure; the FASTA was published
    and the confirmed retry answered "already loaded" without fetching the annotation. The sequence loads, the
    response asks, an unconfirmed repeat asks again, and the confirmed retry downloads the annotation."""
    from services import genome_registry
    monkeypatch.setenv(http_download.WARN_BYTES_ENV, "10000")   # the FASTA (8 kB) is under it, the GTF over
    gid = "sizeg2"
    line = b'chr1\tt\ttranscript\t1\t100\t.\t+\t.\tgene_id "g1"; transcript_id "t1"; gene_name "G1";\n'
    gtf = line * (12000 // len(line) + 1)
    monkeypatch.setitem(genome_registry.GENOME_REGISTRY, gid, {
        "name": "Test (sizeg2)", "fasta_urls": [f"{server}/genome.fa"], "gtf_url": f"{server}/big.gtf"})
    _Handler.files["/big.gtf"] = gtf
    from state.browser_state import BrowserState
    from state.dependencies import get_state
    state = BrowserState(None)
    client.app.dependency_overrides[get_state] = lambda: state
    gtf_path = os.path.join(str(home), ".fiberhmm", "genomes", f"{gid}.gtf")
    try:
        res = client.post("/api/load_genome", params={"genome_id": gid}).json()
        assert res["needs_confirmation"] is True and res.get("fasta_loaded") and not res.get("gtf_error")
        assert res["download"]["bytes"] == len(gtf) and res["download"]["url"].endswith("/big.gtf")
        assert not os.path.exists(gtf_path)
        again = client.post("/api/load_genome", params={"genome_id": gid}).json()
        assert again["needs_confirmation"] is True and not os.path.exists(gtf_path)
        res = client.post("/api/load_genome", params={"genome_id": gid, "confirm_large": "true"}).json()
        assert res["success"] and res.get("gtf_loaded") and not res.get("needs_confirmation"), res
        assert os.path.exists(gtf_path) and state.gtf_path == gtf_path and state.current_genome == gid
        # Now complete: a repeat is "already loaded".
        assert client.post("/api/load_genome", params={"genome_id": gid}).json().get("success")
    finally:
        client.app.dependency_overrides.pop(get_state, None)
        if state.fasta is not None:
            state.fasta.close()


def test_load_genome_ordinary_annotation_failure_still_loads_the_sequence(home, server, monkeypatch, client):
    from services import genome_registry
    monkeypatch.setenv(http_download.WARN_BYTES_ENV, "10000")
    gid = "sizeg3"
    monkeypatch.setitem(genome_registry.GENOME_REGISTRY, gid, {
        "name": "Test (sizeg3)", "fasta_urls": [f"{server}/genome.fa"], "gtf_url": f"{server}/missing.gtf"})
    from state.browser_state import BrowserState
    from state.dependencies import get_state
    state = BrowserState(None)
    client.app.dependency_overrides[get_state] = lambda: state
    try:
        res = client.post("/api/load_genome", params={"genome_id": gid}).json()
        assert res["success"] and res.get("fasta_loaded") and res.get("gtf_error")
        assert not res.get("needs_confirmation") and state.current_genome == gid
    finally:
        client.app.dependency_overrides.pop(get_state, None)
        if state.fasta is not None:
            state.fasta.close()


def test_app_info_reports_and_saves_the_threshold(home, client):
    info = client.get("/api/app/info").json()["downloads"]
    assert info["warn_bytes"] == info["default"] == http_download.DEFAULT_WARN_BYTES
    info = client.post("/api/app/downloads", json={"warn_bytes": 2_000_000_000}).json()["downloads"]
    assert info["warn_bytes"] == 2_000_000_000 and info["saved"] == 2_000_000_000
    assert client.post("/api/app/downloads", json={"warn_bytes": "big"}).status_code == 422
    assert json.loads(open(os.environ["FIBERBROWSER_APP_SETTINGS"]).read())["downloads"]["warn_bytes"] == 2_000_000_000
