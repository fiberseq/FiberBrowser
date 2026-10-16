"""Open remote files from a link: session documents, track hubs, the confirmation
flow, public-server rules, SSRF protections and pre-signed URL handling."""
from __future__ import annotations

import base64
import json
import logging
import os
import re
import shutil
import time
from pathlib import Path
from urllib.parse import quote

import pytest
from starlette.testclient import TestClient

from services import link_fetch, session_links, signed_urls
from services.link_fetch import LinkError, LinkPolicy
from services.session_link_format import SCHEMA, SessionLinkError, decode_inline, normalize_session
from services.track_hub import import_hub, parse_stanzas
from tests.link_fixtures import LinkServer, needs_pybigwig_urls, write_bigwig

REPO = Path(__file__).resolve().parents[1]
DEMO_BAM = REPO / "browser" / "data" / "demo" / "napa_ddda.bam"


@pytest.fixture(autouse=True)
def _fresh_links():
    session_links.clear_pending()
    signed_urls.clear()
    yield
    session_links.clear_pending()
    signed_urls.clear()


@pytest.fixture
def files(tmp_path):
    server = LinkServer(str(tmp_path))
    yield server
    server.close()


@pytest.fixture
def anonymous(standalone_app):
    return TestClient(standalone_app)


@pytest.fixture
def fresh_state(standalone_app):
    """A clean BrowserState for the app (datasets and tracks from earlier tests removed)."""
    import server as srv
    old = srv.state
    srv.state = srv.BrowserState(None, None, None, None)
    yield srv.state
    srv.state = old


def _doc(tracks, **extra):
    return {"schema": SCHEMA, "tracks": tracks, **extra}


# ---------------------------------------------------------------------------- the document

def test_a_valid_document_is_normalised():
    session = normalize_session(_doc([
        {"url": "https://data.example.org/a/s1.bam", "index_url": "https://data.example.org/a/s1.bam.bai",
         "name": "Sample 1", "sample": "S1", "group": "Donor A", "color": "31,119,180"},
        {"url": "https://data.example.org/a/cov.bw"},
        {"url": "s3://bucket/peaks.bb", "as": "reads"},
        {"url": "https://data.example.org/map.gb", "type": "plasmid map"},
    ], genome="HG38", locus="chr7:5,527,000-5,531,000", title="Donor A"))
    tracks = session["tracks"]
    assert [t["type"] for t in tracks] == ["bam", "bigwig", "bigbed", "plasmid"]
    assert [t["as"] for t in tracks] == ["reads", "signal", "reads", "plasmid"]
    assert tracks[0]["color"] == "#1f77b4" and tracks[0]["group"] == "Donor A"
    assert tracks[1]["name"] == "cov.bw"
    assert session["genome"] == {"kind": "catalog", "id": "hg38", "label": "hg38"}
    assert session["locus"] == {"text": "chr7:5,527,000-5,531,000", "chrom": "chr7", "start": 5527000, "end": 5531000}
    assert session["title"] == "Donor A" and not session["warnings"]


@pytest.mark.parametrize("url", [
    "file:///etc/passwd", "/Users/me/data.bam", "~/data.bam", "C:\\data\\x.bam", "ftp://h/x.bam",
    "javascript:alert(1)", "data:text/plain,abc",
])
def test_local_files_and_other_schemes_are_refused(url):
    with pytest.raises(SessionLinkError):
        normalize_session(_doc([{"url": url, "type": "bam"}]))


def test_relative_urls_resolve_against_the_document():
    session = normalize_session(_doc([{"url": "files/x.bw"}]), base_url="https://h.example.org/s/session.json")
    assert session["tracks"][0]["url"] == "https://h.example.org/s/files/x.bw"


@pytest.mark.parametrize("doc, message", [
    ({"schema": "other.v9", "tracks": []}, "Unsupported session schema"),
    ({"schema": SCHEMA, "tracks": "x"}, "must be a list"),
    ({"schema": SCHEMA, "tracks": [{"url": "https://h/x.cram"}]}, "CRAM"),
    ({"schema": SCHEMA, "tracks": [{"url": "https://h/x.txt"}]}, "add \"type\""),
    ({"schema": SCHEMA, "tracks": [{"url": "https://h/x.bw", "type": "vcf"}]}, "unknown type"),
    ({"schema": SCHEMA, "tracks": [{"url": "https://h/x.bw"}], "genome": "hg99"}, "Unknown genome"),
    ({"schema": SCHEMA, "tracks": [{"url": "https://h/x.bw"}], "locus": "chr1:9-2"}, "ends before"),
    ({"schema": SCHEMA, "tracks": []}, "no tracks and no genome"),
    ({"schema": SCHEMA, "tracks": [{"url": "https://h/x.bw"}] * 1001}, "limit is 1000"),
])
def test_invalid_documents_say_why(doc, message):
    with pytest.raises(SessionLinkError, match=message):
        normalize_session(doc)


def test_documents_without_a_schema_are_read_with_a_warning():
    session = normalize_session({"tracks": [{"url": "https://h.example.org/x.bw"}]})
    assert "schema" in session["warnings"][0]


def test_fasta_genomes_and_gene_loci():
    session = normalize_session(_doc([{"url": "https://h.example.org/x.bw"}],
                                     genome={"fasta": "https://h.example.org/ref.fa", "fai": "ref.fa.fai"},
                                     locus="GATA1"), base_url="https://h.example.org/s.json")
    assert session["genome"] == {"kind": "fasta", "url": "https://h.example.org/ref.fa",
                                 "fai": "https://h.example.org/ref.fa.fai", "label": "ref.fa"}
    assert session["locus"] == {"text": "GATA1"}


def test_inline_documents():
    doc = json.dumps(_doc([{"url": "https://h.example.org/x.bw"}]))
    b64 = base64.urlsafe_b64encode(doc.encode()).decode().rstrip("=")
    assert json.loads(decode_inline(b64))["schema"] == SCHEMA
    assert json.loads(decode_inline("data:application/json;base64," + base64.b64encode(doc.encode()).decode()))
    assert json.loads(decode_inline("data:application/json," + quote(doc)))["tracks"]
    assert json.loads(decode_inline(doc))["tracks"]
    with pytest.raises(SessionLinkError):
        decode_inline("data:text/html,<b>")


# ---------------------------------------------------------------------------- hubs

HUB = "hub demoHub\nshortLabel Demo hub\nlongLabel A demo hub\ngenomesFile genomes.txt\nemail x@example.org\n"
GENOMES = "genome hg38\ntrackDb hg38/trackDb.txt\ndefaultPos chr19:47514000-47518000\n\ngenome mm10\ntrackDb mm10/trackDb.txt\n"
TRACKDB = """\
track fireComposite
compositeTrack on
shortLabel FIRE
longLabel FIRE elements
type bigBed 9 +
visibility dense
color 200,0,0

    track firePeaks
    parent fireComposite on
    bigDataUrl bb/fire-peaks.bb
    shortLabel FIRE peaks
    type bigBed 9 +

    track wide
    parent fireComposite off
    bigDataUrl bb/wide.bb
    shortLabel Wide peaks

track cov
container multiWig
shortLabel Coverage
type bigWig 0 100
color 0,0,255

    track hap1
    parent cov
    bigDataUrl bb/hap1.bw
    shortLabel Hap1 coverage

    track hap2
    parent cov
    bigDataUrl bb/hap2.bw
    shortLabel Hap2 coverage
    color 255,0,0

track reads
bigDataUrl https://other.example.org/reads.bam
bigDataIndex https://other.example.org/reads.bam.bai
shortLabel Reads
type bam
visibility hide

track fibers
bigDataUrl bb/fire-fibers.bb
shortLabel Fibers
type bigBed 12 +
decorator.default.bigDataUrl bb/fire-fiber-decorators.bb

track variants
bigDataUrl bb/v.vcf.gz
shortLabel Variants
type vcfTabix

include more.txt
"""
MORE = "track extra\nbigDataUrl ../extra.bw\nshortLabel Extra\ntype bigWig\n"


def _fake_web(files: dict):
    def fetch_text(url):
        if url not in files:
            raise LinkError(f"{url}: not found (HTTP 404).")
        return files[url]
    return fetch_text


def test_hub_import_reads_composites_containers_and_includes():
    base = "https://hub.example.org/h/"
    web = _fake_web({base + "hub.txt": HUB, base + "genomes.txt": GENOMES,
                     base + "hg38/trackDb.txt": TRACKDB, base + "hg38/more.txt": MORE})
    doc = import_hub(base + "hub.txt", web)
    assert doc["genome"] == "hg38" and doc["title"] == "Demo hub" and doc["locus"] == "chr19:47514000-47518000"
    by_name = {t["name"]: t for t in doc["tracks"]}
    assert list(by_name) == ["FIRE peaks", "Wide peaks", "Hap1 coverage", "Hap2 coverage", "Reads", "Fibers",
                             "Fibers (decorations)", "Extra"]
    assert by_name["FIRE peaks"]["url"] == base + "hg38/bb/fire-peaks.bb"
    assert by_name["FIRE peaks"]["group"] == "FIRE" and by_name["FIRE peaks"]["color"] == "#c80000"
    assert by_name["FIRE peaks"]["visible"] and not by_name["Wide peaks"]["visible"]
    assert by_name["Hap1 coverage"]["type"] == "bigwig" and by_name["Hap1 coverage"]["color"] == "#0000ff"
    assert by_name["Hap2 coverage"]["color"] == "#ff0000" and by_name["Hap2 coverage"]["group"] == "Coverage"
    assert by_name["Reads"]["type"] == "bam" and not by_name["Reads"]["visible"]
    assert by_name["Reads"]["index_url"] == "https://other.example.org/reads.bam.bai"
    assert by_name["Fibers (decorations)"]["url"] == base + "hg38/bb/fire-fiber-decorators.bb"
    assert not by_name["Fibers (decorations)"]["visible"]
    assert by_name["Extra"]["url"] == base + "extra.bw"
    assert any("Variants" in s for s in doc["hub"]["skipped"])
    assert "as" not in by_name["FIRE peaks"]  # reads or annotation: decided from the file when opened
    session = normalize_session(doc, base_url=base + "hub.txt")
    assert len(session["tracks"]) == 8 and session["genome"]["id"] == "hg38"


def test_hub_genome_choice():
    base = "https://hub.example.org/h/"
    web = _fake_web({base + "hub.txt": HUB, base + "genomes.txt": GENOMES,
                     base + "mm10/trackDb.txt": "track a\nbigDataUrl a.bw\ntype bigWig\nshortLabel A\n"})
    assert import_hub(base + "hub.txt", web, current_genome="mm10")["genome"] == "mm10"
    with pytest.raises(SessionLinkError, match="no dm6 tracks"):
        import_hub(base + "hub.txt", web, genome="dm6")


def test_stanzas_showing_one_file_become_one_track():
    """A FIRE hub filters one fibers bigBed three ways (H1, H2, UNK)."""
    trackdb = "track fibers\ncompositeTrack on\nshortLabel S1 fibers\ntype bigBed 12 +\n\n" + "".join(
        f"track s1-{hap}\nparent fibers\nbigDataUrl bb/fire-fibers.bb\nshortLabel {hap} fibers\n"
        f"filterText.keywords {hap}\ndecorator.default.bigDataUrl bb/fire-fiber-decorators.bb\n\n"
        for hap in ("H1", "H2", "UNK"))
    base = "https://hub.example.org/f/"
    web = _fake_web({base + "hub.txt": HUB, base + "genomes.txt": "genome hg38\ntrackDb trackDb.txt\n",
                     base + "trackDb.txt": trackdb})
    tracks = import_hub(base + "hub.txt", web)["tracks"]
    assert [(t["name"], t["url"].rsplit("/", 1)[1], t["visible"]) for t in tracks] == [
        ("S1 fibers", "fire-fibers.bb", True), ("S1 fibers", "fire-fiber-decorators.bb", False)]


def test_one_file_hubs_and_supertracks():
    text = """hub one
shortLabel One file
useOneFile on
email x@example.org

genome hg38

track sup
superTrack on show
shortLabel Super

track child
superTrack sup hide
bigDataUrl c.bb
type bigNarrowPeak
shortLabel Child
"""
    doc = import_hub("https://hub.example.org/one/hub.txt", _fake_web({"https://hub.example.org/one/hub.txt": text}))
    [track] = doc["tracks"]
    assert track["url"] == "https://hub.example.org/one/c.bb" and track["type"] == "bigbed"
    assert track["group"] == "Super" and track["visible"] is False


def test_assembly_hubs_and_non_hubs_are_refused():
    base = "https://hub.example.org/a/"
    web = _fake_web({base + "hub.txt": HUB, base + "genomes.txt": "genome myAsm\ntwoBitPath myAsm.2bit\ntrackDb t.txt\n"})
    with pytest.raises(SessionLinkError, match="assembly hub"):
        import_hub(base + "hub.txt", web)
    with pytest.raises(SessionLinkError, match="not a track hub"):
        import_hub(base + "x.txt", _fake_web({base + "x.txt": "track a\n"}))


def test_stanza_parser_handles_continuations_and_comments():
    stanzas = parse_stanzas("# c\ntrack a\nlongLabel one \\\n two\n\n\ntrack b\n")
    assert stanzas == [{"track": "a", "longLabel": "one two"}, {"track": "b"}]


# ---------------------------------------------------------------------------- fetching (SSRF)

def test_fetch_follows_checked_redirects_only(files, tmp_path):
    (tmp_path / "doc.json").write_text("{}")
    files.redirects["/go"] = f"http://127.0.0.1:{files.port}/doc.json"
    local = LinkPolicy(allowed_hosts=("localhost",), allow_private=True)
    # localhost is allowed; the redirect goes to 127.0.0.1, which is not.
    with pytest.raises(LinkError, match="not on this server's list"):
        link_fetch.fetch(f"http://localhost:{files.port}/go", local, max_bytes=1000)
    open_policy = LinkPolicy(allow_private=True)
    assert link_fetch.fetch(f"http://localhost:{files.port}/go", open_policy, max_bytes=1000).body == b"{}"


def test_fetch_refuses_private_addresses_after_dns(files, tmp_path, monkeypatch):
    (tmp_path / "doc.json").write_text("{}")
    monkeypatch.setattr(link_fetch, "resolve", lambda host, port: ["127.0.0.1"])
    public = LinkPolicy(public=True, allowed_hosts=("portal.example.org",), https_only=False, allow_private=False)
    with pytest.raises(LinkError, match="private or local-network"):
        link_fetch.fetch(f"http://portal.example.org:{files.port}/doc.json", public, max_bytes=1000)
    assert files.hits == []
    monkeypatch.setattr(link_fetch, "resolve", lambda host, port: ["169.254.169.254"])
    with pytest.raises(LinkError, match="link-local"):
        link_fetch.fetch("http://metadata.example.org/", LinkPolicy(allow_private=True), max_bytes=1000)


def test_fetch_connects_to_the_checked_address(files, tmp_path, monkeypatch):
    """No second DNS lookup: the connection goes to the address that was checked."""
    (tmp_path / "doc.json").write_text('{"ok": 1}')
    monkeypatch.setattr(link_fetch, "resolve", lambda host, port: ["127.0.0.1"])
    result = link_fetch.fetch(f"http://portal.example.org:{files.port}/doc.json", LinkPolicy(allow_private=True),
                              max_bytes=1000)
    assert json.loads(result.body) == {"ok": 1}


def test_fetch_size_limits(files, tmp_path):
    (tmp_path / "big.json").write_text("x" * 5000)
    policy = LinkPolicy(allow_private=True)
    with pytest.raises(LinkError, match="too large"):
        link_fetch.fetch(f"{files.base}/big.json", policy, max_bytes=1000)
    files.chunked.add("/big.json")  # no Content-Length: the read itself stops
    with pytest.raises(LinkError, match="too large"):
        link_fetch.fetch(f"{files.base}/big.json", policy, max_bytes=1000)


def test_fetch_scheme_and_host_rules():
    public = link_fetch.policy_for_server(public=True)
    with pytest.raises(LinkError, match="turned off"):
        link_fetch.check_url("https://portal.example.org/x.json", public)
    os.environ[link_fetch.HOSTS_ENV] = "example.org"
    try:
        public = link_fetch.policy_for_server(public=True)
        link_fetch.check_url("https://portal.example.org/x.json", public)
        for bad in ("http://portal.example.org/x", "https://evil.example.com/x", "s3://b/k",
                    "https://user:pw@portal.example.org/x", "file:///etc/passwd"):
            with pytest.raises(LinkError):
                link_fetch.check_url(bad, public)
    finally:
        os.environ.pop(link_fetch.HOSTS_ENV)


# ---------------------------------------------------------------------------- confirmation flow

def _serve_session(files, tmp_path, name="session.json", **doc):
    (tmp_path / name).write_text(json.dumps(doc))
    return files.url(name)


def test_the_landing_page_stores_the_link_and_fetches_nothing(anonymous, files, tmp_path):
    url = _serve_session(files, tmp_path, tracks=[{"url": "x.bw"}], schema=SCHEMA)
    resp = anonymous.get("/open", params={"session": url})
    assert resp.status_code == 200 and "no-referrer" in resp.headers["referrer-policy"]
    assert "/?open_link=" in resp.text and "127.0.0.1" in resp.text
    assert files.hits == []  # nothing fetched before an authenticated tab asks
    link_id = resp.text.split("/?open_link=")[1].split('"')[0]
    # The pending link is useless without the access token.
    assert anonymous.get(f"/api/session-links/{link_id}").status_code == 401
    assert anonymous.post(f"/api/session-links/{link_id}/open", json={}).status_code == 401


def test_a_link_to_the_app_itself_goes_to_the_landing_page(anonymous):
    resp = anonymous.get("/?session=https://h.example.org/s.json", headers={"Accept": "text/html"},
                         follow_redirects=False)
    assert resp.status_code == 303 and resp.headers["location"].startswith("/open?session=")
    assert anonymous.get("/?other=1", headers={"Accept": "text/html"}).status_code == 401


@needs_pybigwig_urls
def test_nothing_loads_without_a_confirmed_preview_and_ids_are_single_use(client, files, tmp_path, fresh_state):
    write_bigwig(str(tmp_path / "cov.bw"))
    url = _serve_session(files, tmp_path, schema=SCHEMA, tracks=[{"url": "cov.bw", "name": "Coverage"}])
    link_id = client.post("/api/session-links", json={"session": url}).json()["id"]
    # Opening before the user saw the preview is refused.
    assert client.post(f"/api/session-links/{link_id}/open", json={}).status_code == 409
    preview = client.get(f"/api/session-links/{link_id}").json()
    # http on 127.0.0.1: the document itself needs a "fetch it" confirmation first.
    assert preview["needs_fetch_confirmation"] and files.hits == []
    preview = client.get(f"/api/session-links/{link_id}?fetch=true").json()
    assert preview["success"] and [t["name"] for t in preview["tracks"]] == ["Coverage"]
    assert [h for h in files.hits if "cov.bw" in h] == []  # tracks are not touched before confirming
    def ours():
        return [t for t in client.get("/api/tracks").json()["tracks"] if t["path"].startswith(files.base)]
    assert ours() == []
    opened = client.post(f"/api/session-links/{link_id}/open", json={}).json()
    assert opened["success"] and opened["tracks"][0]["kind"] == "bigwig"
    assert [t["label"] for t in ours()] == ["Coverage"]
    again = client.post(f"/api/session-links/{link_id}/open", json={})
    assert again.status_code == 404 and "already opened" in again.json()["error"]


def test_pending_links_expire_and_are_bounded(client, monkeypatch):
    link_id = client.post("/api/session-links", json={"session": "https://h.example.org/s.json"}).json()["id"]
    later = time.time() + session_links.PENDING_TTL_S + 1
    monkeypatch.setattr(session_links.time, "time", lambda: later)
    assert client.get(f"/api/session-links/{link_id}").status_code == 404
    monkeypatch.undo()
    ids = [session_links.stage("session", f"https://h.example.org/{i}.json").id
           for i in range(session_links.MAX_PENDING + 5)]
    with pytest.raises(session_links.PendingLinkError):
        session_links.get_pending(ids[0])
    assert session_links.get_pending(ids[-1])


def test_cancel_discards_the_link(client):
    link_id = client.post("/api/session-links", json={"session": "https://h.example.org/s.json"}).json()["id"]
    assert client.delete(f"/api/session-links/{link_id}").json()["discarded"]
    assert client.get(f"/api/session-links/{link_id}").status_code == 404


@needs_pybigwig_urls
def test_selected_tracks_only(client, files, tmp_path, fresh_state):
    write_bigwig(str(tmp_path / "a.bw"))
    write_bigwig(str(tmp_path / "b.bw"))
    doc = _doc([{"url": files.url("a.bw")}, {"url": files.url("b.bw"), "visible": False}])
    raw = "data:application/json," + quote(json.dumps(doc))
    link_id = client.post("/api/session-links", json={"session": raw}).json()["id"]
    preview = client.get(f"/api/session-links/{link_id}").json()
    assert preview["source"]["kind"] == "inline" and [t["visible"] for t in preview["tracks"]] == [True, False]
    opened = client.post(f"/api/session-links/{link_id}/open", json={"selected": [1]}).json()
    assert [t["label"] for t in opened["tracks"]] == ["b.bw"]


# ---------------------------------------------------------------------------- pre-signed URLs

def test_signed_url_helpers():
    url = ("https://objects.example.org/a/s1.bam?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=20260930T120000Z"
           "&X-Amz-Expires=3600&X-Amz-Signature=abc123")
    assert signed_urls.looks_signed(url) and not signed_urls.looks_signed("https://h/x.bw?format=1")
    assert signed_urls.display_url(url) == "https://objects.example.org/a/s1.bam"
    assert signed_urls.expiry_of(url) == pytest.approx(time.mktime((2026, 9, 30, 13, 0, 0, 0, 0, 0)) - time.timezone)
    assert signed_urls.display_url("https://u:p@h.example.org/x.bw?sig=1#f") == "https://h.example.org/x.bw"
    text = f"Failed to open {url} (error)"
    assert "X-Amz-Signature" not in signed_urls.redact_text(text)
    real = signed_urls.register(url, "https://objects.example.org/a/s1.bam.bai?X-Amz-Signature=def")
    assert real.endswith("X-Amz-Signature=def") and "##idx##" in real
    assert signed_urls.resolve("https://objects.example.org/a/s1.bam") == real
    assert signed_urls.redact_text(f"x {real} y") == "x https://objects.example.org/a/s1.bam y"
    [held] = signed_urls.status(now=time.mktime((2026, 9, 30, 12, 55, 0, 0, 0, 0)) - time.timezone)
    assert held["expiring_soon"] and not held["expired"]


def test_printed_output_and_logs_never_carry_a_signed_url(capsys, caplog):
    real = signed_urls.register("https://h.example.org/x.bw?sig=SECRET")
    print(f"opening {real}")
    assert "SECRET" not in capsys.readouterr().out
    record = logging.LogRecord("uvicorn.access", logging.INFO, "", 0, '%s - "%s %s HTTP/1.1" %d',
                               ("127.0.0.1", "GET", "/open?session=https%3A%2F%2Fh%2Fs.json%3Fsig%3DX&genome=hg38", 200),
                               None)
    signed_urls.LinkRedactionFilter().filter(record)
    assert "sig" not in record.getMessage() and "genome=hg38" in record.getMessage()


@needs_pybigwig_urls
def test_open_keeps_signed_urls_out_of_every_response(client, files, tmp_path, fresh_state, monkeypatch):
    workdir = tmp_path / "cwd"
    workdir.mkdir()
    monkeypatch.chdir(workdir)  # htslib would save a downloaded remote index here
    shutil.copy(DEMO_BAM, tmp_path / "s1.bam")
    shutil.copy(str(DEMO_BAM) + ".bai", tmp_path / "s1.index")
    write_bigwig(str(tmp_path / "cov.bw"))
    files.signed.update({"s1.bam": "BAMSECRET", "s1.index": "IDXSECRET", "cov.bw": "BWSECRET"})
    doc = _doc([{"url": files.url("s1.bam"), "index_url": files.url("s1.index"), "name": "Sample 1",
                 "color": "#ff0000"},
                {"url": files.url("cov.bw"), "name": "Coverage"}], locus="chr19:47514000-47518000")
    raw = "data:application/json," + quote(json.dumps(doc))
    link_id = client.post("/api/session-links", json={"session": raw}).json()["id"]
    preview = client.get(f"/api/session-links/{link_id}")
    assert "SECRET" not in preview.text and preview.json()["tracks"][0]["url"] == f"{files.base}/s1.bam"
    opened = client.post(f"/api/session-links/{link_id}/open", json={})
    body = opened.json()
    assert body["success"], body
    assert "SECRET" not in opened.text
    [dataset] = body["datasets"]
    assert dataset["path"] == f"{files.base}/s1.bam" and dataset["color"] == "#ff0000"
    for path in ("/api/datasets", "/api/tracks"):
        resp = client.get(path)
        assert "SECRET" not in resp.text and files.base in resp.text
    exported = client.post("/api/session/export", json={"viewport": {}, "frontend": {}})
    assert "SECRET" not in exported.text
    assert list(workdir.iterdir()) == []  # the index went to a private folder
    # The display form comes back (a restored session): this server still holds the signature.
    track = client.post("/api/add_track", params={"path": f"{files.base}/cov.bw", "label": "again"}).json()
    assert track["success"], track
    status = client.get("/api/session-links/status").json()
    assert {i["url"] for i in status["links"]} == {f"{files.base}/s1.bam", f"{files.base}/cov.bw"}
    assert status["expired"] == []


def test_a_presigned_bam_needs_its_index_url(client, files, tmp_path, fresh_state, monkeypatch):
    monkeypatch.chdir(tmp_path)
    shutil.copy(DEMO_BAM, tmp_path / "s1.bam")
    files.signed["s1.bam"] = "S"
    raw = "data:application/json," + quote(json.dumps(_doc([{"url": files.url("s1.bam")}])))
    link_id = client.post("/api/session-links", json={"session": raw}).json()["id"]
    client.get(f"/api/session-links/{link_id}")
    body = client.post(f"/api/session-links/{link_id}/open", json={}).json()
    assert not body["success"] and "index_url" in body["errors"][0]


@needs_pybigwig_urls
def test_expired_links_are_reported(client, files, tmp_path, fresh_state):
    write_bigwig(str(tmp_path / "cov.bw"))
    files.signed["cov.bw"] = "OLD"
    raw = "data:application/json," + quote(json.dumps(_doc([{"url": files.url("cov.bw")}])))
    link_id = client.post("/api/session-links", json={"session": raw}).json()["id"]
    client.get(f"/api/session-links/{link_id}")
    assert client.post(f"/api/session-links/{link_id}/open", json={}).json()["success"]
    files.signed["cov.bw"] = "NEW"  # the old signature no longer works (403)
    status = client.get("/api/session-links/status").json()
    assert [i["url"] for i in status["expired"]] == [f"{files.base}/cov.bw"]
    # After a restart the vault is empty: the display form is refused and says why.
    signed_urls.clear()
    added = client.post("/api/add_track", params={"path": f"{files.base}/cov.bw", "label": "x"}).json()
    assert not added["success"] and "reopen it from the source" in added["message"]


def test_a_link_that_expired_before_opening_says_so(client, files, tmp_path, fresh_state):
    write_bigwig(str(tmp_path / "cov.bw"))
    files.signed["cov.bw"] = "NEW"
    url = f"http://127.0.0.1:{files.port}/cov.bw?sig=OLD"
    raw = "data:application/json," + quote(json.dumps(_doc([{"url": url, "name": "Cov"}])))
    link_id = client.post("/api/session-links", json={"session": raw}).json()["id"]
    client.get(f"/api/session-links/{link_id}")
    body = client.post(f"/api/session-links/{link_id}/open", json={}).json()
    assert not body["success"] and "expired" in body["errors"][0] and "OLD" not in json.dumps(body)


def test_remote_validation_uses_a_ranged_get_when_head_is_refused(files, tmp_path):
    from utils.validation import validate_remote_url
    write_bigwig(str(tmp_path / "cov.bw"))
    files.signed["cov.bw"] = "S"
    result = validate_remote_url(files.url("cov.bw"))
    assert result["valid"] and result["supports_range"] and result["content_length"] == (tmp_path / "cov.bw").stat().st_size


def test_recent_tracks_never_store_a_signed_url(tmp_path, monkeypatch):
    from services import recent_tracks
    monkeypatch.setattr(recent_tracks, "recent_tracks_file", lambda: tmp_path / "recent.json")
    recent_tracks.remember({"url": "https://h.example.org/x.bw?X-Amz-Signature=abc", "label": "x",
                            "source": "online", "kind": "bigwig"})
    assert "X-Amz" not in (tmp_path / "recent.json").read_text()


# ---------------------------------------------------------------------------- public servers

@pytest.fixture
def public(monkeypatch):
    from services import runtime
    monkeypatch.setattr(runtime, "_public_mode", True)
    yield


def test_public_servers_accept_no_links_unless_configured(anonymous, public, monkeypatch):
    assert not anonymous.get("/api/session-links/config").json()["enabled"]
    assert anonymous.get("/open", params={"session": "https://portal.example.org/s.json"}).status_code == 403
    assert anonymous.post("/api/session-links", json={"session": "https://portal.example.org/s.json"}).status_code == 403
    monkeypatch.setenv(link_fetch.HOSTS_ENV, "portal.example.org")
    config = anonymous.get("/api/session-links/config").json()
    assert config["enabled"] and config["public"] and config["max_tracks"] == session_links.DEFAULT_MAX_TRACKS_PUBLIC


def test_public_servers_refuse_other_hosts_http_and_s3_tracks(client, public, monkeypatch):
    monkeypatch.setenv(link_fetch.HOSTS_ENV, "portal.example.org")
    for url in ("https://evil.example.com/s.json", "http://portal.example.org/s.json"):
        link_id = client.post("/api/session-links", json={"session": url}).json()["id"]
        resp = client.get(f"/api/session-links/{link_id}")
        assert resp.status_code == 403
    doc = _doc([{"url": "https://portal.example.org/a.bw"}, {"url": "https://evil.example.com/b.bw"},
                {"url": "s3://bucket/c.bw"}, {"url": "https://portal.example.org/map.gb"}], genome="hg38")
    raw = "data:application/json," + quote(json.dumps(doc))
    link_id = client.post("/api/session-links", json={"session": raw}).json()["id"]
    preview = client.get(f"/api/session-links/{link_id}").json()
    problems = [t["problem"] for t in preview["tracks"]]
    assert problems[0] is None and "allowed link hosts" in problems[1] and "s3://" in problems[2]
    assert "public server" in problems[3]
    assert [t["visible"] for t in preview["tracks"]] == [True, False, False, False]


def test_tour_tabs_never_open_links(monkeypatch):
    from services import runtime
    token = runtime._sandbox_id.set("sb-test")
    try:
        enabled, reason = session_links.links_enabled()
    finally:
        runtime._sandbox_id.reset(token)
    assert not enabled and "tour" in reason


def test_the_access_page_keeps_the_pending_link(anonymous):
    """Without the cookie (another browser, an app window), pasting the access link
    must still land on the pending link's confirmation."""
    resp = anonymous.get("/?open_link=abc123", headers={"Accept": "text/html"})
    assert resp.status_code == 401 and "open_link" in resp.text


def test_links_work_under_a_url_prefix(anonymous, monkeypatch):
    from services import root_path
    monkeypatch.setattr(root_path, "_root_path", "/rnode/node7/8000")
    resp = anonymous.get("/?hub=https://h.example.org/hub.txt", headers={"Accept": "text/html"},
                         follow_redirects=False)
    assert resp.headers["location"].startswith("/rnode/node7/8000/open?hub=")
    landing = anonymous.get("/open", params={"hub": "https://h.example.org/hub.txt"})
    assert '"/rnode/node7/8000/?open_link=' in landing.text


def test_lab_servers_follow_the_public_link_rules(client, monkeypatch):
    from services import runtime
    monkeypatch.setattr(runtime, "_lab_mode", True)
    enabled, reason = session_links.links_enabled()
    assert not enabled and "shared server" in reason
    monkeypatch.setenv(link_fetch.HOSTS_ENV, "portal.example.org")
    assert session_links.links_enabled()[0] and session_links.current_policy().https_only


def test_cluster_files_are_offered_never_connected(client, monkeypatch):
    """ssh:// references: listed, opened only after the user connected to the cluster."""
    from services import remote_sources
    connected = {"value": False}

    class FakeSource:
        def is_connected(self, ref):
            return connected["value"]

    monkeypatch.setattr(remote_sources, "source_for_ref", lambda ref: FakeSource())
    doc = _doc([{"url": "ssh://me@cluster.example.org/data/s1.bam", "name": "On the cluster"}])
    raw = "data:application/json," + quote(json.dumps(doc))
    link_id = client.post("/api/session-links", json={"session": raw}).json()["id"]
    [track] = client.get(f"/api/session-links/{link_id}").json()["tracks"]
    assert track["cluster"] == "me@cluster.example.org" and "never connects" in track["problem"]
    assert not track["visible"]
    connected["value"] = True  # the user connected through Connect to cluster...
    [track] = client.get(f"/api/session-links/{link_id}").json()["tracks"]
    assert track["problem"] is None and track["visible"]


def test_streams_are_not_buffered_while_links_are_held(standalone_app):
    """NDJSON streams (the Copilot) pass through the redaction untouched."""
    from fastapi import FastAPI
    from fastapi.responses import StreamingResponse
    app = FastAPI()
    signed_urls.install_signed_url_redaction(app)
    real = signed_urls.register("https://h.example.org/x.bw?sig=SECRET")

    @app.get("/stream")
    def stream():
        return StreamingResponse(iter([b'{"a": 1}\n', b'{"b": 2}\n']), media_type="application/x-ndjson")

    @app.get("/json")
    def plain():
        return {"path": real}

    client = TestClient(app)
    resp = client.get("/stream")
    assert resp.headers["content-type"].startswith("application/x-ndjson") and "content-length" not in resp.headers
    assert client.get("/json").json() == {"path": "https://h.example.org/x.bw"}


def test_shared_servers_never_hand_out_held_links(client, monkeypatch):
    from services import runtime
    from services.tracks_endpoint import _held_url
    real = signed_urls.register("https://h.example.org/x.bw?sig=SECRET")
    assert _held_url("https://h.example.org/x.bw") == real  # a local server: the owner's own link
    monkeypatch.setattr(runtime, "_lab_mode", True)
    assert _held_url("https://h.example.org/x.bw") == "https://h.example.org/x.bw"
    assert session_links.link_status() == {"links": [], "expired": [], "expiring_soon": []}


def test_the_landing_script_runs_under_its_own_nonce(anonymous):
    resp = anonymous.get("/open", params={"session": "https://h.example.org/s.json"})
    csp = resp.headers["content-security-policy"]
    nonce = re.search(r"'nonce-([^']+)'", csp).group(1)
    assert f'<script nonce="{nonce}">' in resp.text and "default-src 'none'" in csp


def test_public_servers_keep_their_per_visitor_track_limit(monkeypatch):
    from services.public_limits import get_public_limits

    class State:
        orthogonal_tracks = [{}] * get_public_limits().session_max_tracks

    with pytest.raises(LinkError, match="at most"):
        session_links._check_track_cap(State(), LinkPolicy(public=True))
    session_links._check_track_cap(State(), LinkPolicy(public=False))  # local servers: no cap
