"""Session links: malformed input, redirects, pre-confirmation fetches, signed
references and the network policy of every file a link opens.

Regression tests for an independent review of the 3.0 link feature.
"""
from __future__ import annotations

import json

import pytest

from services import link_fetch as lf
from services import session_links as sl
from services import signed_urls as su
from services.session_link_format import SCHEMA
from services.track_hub import import_hub
from tests.link_fixtures import needs_pybigwig_urls


def _doc(**extra):
    return {"schema": SCHEMA, "tracks": [{"url": "https://portal.example/x.bw"}], **extra}


@pytest.fixture(autouse=True)
def _fresh_links(monkeypatch):
    sl.clear_pending()
    su.clear()
    monkeypatch.delenv(lf.HOSTS_ENV, raising=False)
    monkeypatch.delenv(sl.DISABLE_ENV, raising=False)
    yield
    sl.clear_pending()
    su.clear()


def _stage(client, **body):
    return client.post("/api/session-links", json=body).json()["id"]


def _stage_preview(client, document, *, fetch=False):
    link_id = _stage(client, session=json.dumps(document))
    return link_id, client.get(f"/api/session-links/{link_id}" + ("?fetch=true" if fetch else ""))


def _serve(monkeypatch, pages: dict, *, final: dict | None = None, hits: list | None = None):
    """``sl.fetch`` answering from ``pages`` (by URL); ``final`` maps a URL to where it redirected."""
    monkeypatch.setattr(lf, "resolve", lambda *a: ["93.184.216.34"])

    def fetch(url, policy, **kw):
        if hits is not None:
            hits.append(url)
        where = (final or {}).get(url, url)
        return lf.FetchResult(pages[where].encode(), where, 200)
    monkeypatch.setattr(sl, "fetch", fetch)


# ---------------------------------------------------------------------------- malformed content

def test_deeply_nested_inline_json_is_a_clean_error(client):
    raw = '{"schema":"%s","tracks":[],"unused":' % SCHEMA + "[" * 1500 + "0" + "]" * 1500 + "}"
    link_id = _stage(client, session=raw)
    resp = client.get(f"/api/session-links/{link_id}")
    assert resp.status_code == 400  # an invalid document: a client error, with the preview's id and source
    assert not resp.json()["success"] and "nests more than" in resp.json()["error"]
    assert resp.json()["id"] == link_id and resp.json()["source"]["kind"] == "inline"


def test_brackets_inside_strings_do_not_count_as_nesting(client):
    _, resp = _stage_preview(client, _doc(title="[[[[" * 40 + "{{{{" * 40))
    assert resp.json()["success"]


@pytest.mark.parametrize("url", ["https://[bad/x.bw", "https://portal.example:99999/x.bw",
                                 "https://portal.example:abc/x.bw"])
def test_malformed_track_urls_are_a_clean_error(client, url):
    _, resp = _stage_preview(client, _doc(tracks=[{"url": url, "type": "bigwig"}]))
    assert resp.status_code == 400
    assert not resp.json()["success"] and "not a valid URL" in resp.json()["error"]


@pytest.mark.parametrize("document,message", [
    ('{"schema": "fiberbrowser.session-link.v1", "tracks": [', "not valid JSON"),
    ('{"schema": "other.v9", "tracks": []}', "Unsupported session schema"),
    ('["not", "an", "object"]', "must be a JSON object"),
])
def test_an_invalid_hosted_document_is_a_400(client, monkeypatch, document, message):
    _serve(monkeypatch, {"https://portal.example/s.json": document})
    link_id = _stage(client, session="https://portal.example/s.json")
    resp = client.get(f"/api/session-links/{link_id}?fetch=true")
    assert resp.status_code == 400 and message in resp.json()["error"]


def test_a_document_that_cannot_be_fetched_is_a_422(client, monkeypatch):
    monkeypatch.setattr(lf, "resolve", lambda *a: ["10.1.2.3"])
    from services import runtime
    monkeypatch.setattr(runtime, "_public_mode", True)
    monkeypatch.setenv(lf.HOSTS_ENV, "portal.example")
    link_id = _stage(client, session="https://portal.example/s.json")
    resp = client.get(f"/api/session-links/{link_id}?fetch=true")
    assert resp.status_code == 422 and "private or local-network address" in resp.json()["error"]


def test_malformed_hub_track_urls_are_skipped_with_a_reason(client, monkeypatch):
    base = "https://portal.example/hub/"
    pages = {base + "hub.txt": "hub H\ngenomesFile genomes.txt\n",
             base + "genomes.txt": "genome hg38\ntrackDb tracks.txt\n",
             base + "tracks.txt": ("track Bad\ntype bigWig\nbigDataUrl https://[bad/x.bw\n\n"
                                   "track Good\ntype bigWig\nbigDataUrl good.bw\n")}
    _serve(monkeypatch, pages)
    link_id = _stage(client, hub=base + "hub.txt")
    resp = client.get(f"/api/session-links/{link_id}?fetch=true")
    assert resp.status_code < 500
    body = resp.json()
    assert body["success"] and [t["url"] for t in body["tracks"]] == [base + "good.bw"]
    assert any("Bad" in s and "not a valid address" in s for s in body["hub"]["skipped"])


def test_malformed_link_host_is_refused_not_a_server_error(client):
    link_id = _stage(client, session="https://[bad/s.json")
    resp = client.get(f"/api/session-links/{link_id}")
    assert 400 <= resp.status_code < 500


# ---------------------------------------------------------------------------- redirects

def test_redirected_document_resolves_relative_files_against_its_final_url(client, monkeypatch):
    start, final = "https://portal.example/share/123", "https://data.example/release/session.json"
    _serve(monkeypatch, {final: json.dumps(_doc(tracks=[{"url": "cov.bw"}]))}, final={start: final})
    link_id = _stage(client, session=start)
    preview = client.get(f"/api/session-links/{link_id}?fetch=true").json()
    assert preview["success"]
    assert preview["tracks"][0]["url"] == "https://data.example/release/cov.bw"
    assert any("redirected to data.example" in w for w in preview["warnings"])


def test_redirected_hub_files_resolve_against_their_final_urls():
    moved = {
        "https://portal.example/h/hub.txt": "https://data.example/r1/hub.txt",
        "https://data.example/r1/genomes.txt": "https://data.example/r2/genomes.txt",
    }
    pages = {
        "https://data.example/r1/hub.txt": "hub H\ngenomesFile genomes.txt\n",
        "https://data.example/r2/genomes.txt": "genome hg38\ntrackDb hg38/trackDb.txt\n",
        "https://data.example/r2/hg38/trackDb.txt": "track T\ntype bigWig\nbigDataUrl t.bw\n",
    }

    def fetch_text(url):
        where = moved.get(url, url)
        return pages[where], where

    doc = import_hub("https://portal.example/h/hub.txt", fetch_text)
    assert [t["url"] for t in doc["tracks"]] == ["https://data.example/r2/hg38/t.bw"]


# ---------------------------------------------------------------------------- nothing before confirmation

@pytest.mark.parametrize("public", [False, True])
@pytest.mark.parametrize("kind,url", [("session", "https://portal.example/s.json"),
                                      ("hub", "https://portal.example/hub.txt")])
def test_hosted_documents_are_not_fetched_or_resolved_before_confirmation(client, monkeypatch, public, kind, url):
    from services import runtime
    if public:
        monkeypatch.setattr(runtime, "_public_mode", True)
        monkeypatch.setenv(lf.HOSTS_ENV, "portal.example")
    contacted = []
    monkeypatch.setattr(lf, "resolve", lambda host, port: contacted.append(("dns", host)) or ["93.184.216.34"])
    monkeypatch.setattr(sl, "fetch", lambda url, *a, **k: contacted.append(("fetch", url)))
    link_id = _stage(client, **{kind: url})
    preview = client.get(f"/api/session-links/{link_id}").json()
    assert preview["success"] and preview["needs_fetch_confirmation"]
    assert "portal.example" in preview["reason"] and preview["source"]["host"] == "portal.example"
    assert contacted == []


def test_the_confirmed_fetch_reads_the_document_once(client, monkeypatch):
    hits = []
    _serve(monkeypatch, {"https://portal.example/s.json": json.dumps(_doc())}, hits=hits)
    link_id = _stage(client, session="https://portal.example/s.json")
    assert client.get(f"/api/session-links/{link_id}").json()["needs_fetch_confirmation"] and hits == []
    assert client.get(f"/api/session-links/{link_id}?fetch=true").json()["success"]
    assert client.get(f"/api/session-links/{link_id}").json()["success"]  # the reviewed copy, no new fetch
    assert hits == ["https://portal.example/s.json"]


def test_inline_documents_are_previewed_at_once(client):
    _, resp = _stage_preview(client, _doc())
    assert resp.json()["success"] and not resp.json().get("needs_fetch_confirmation")


# ---------------------------------------------------------------------------- signed references

SIGNED_GENOME = {"fasta": "https://portal.example/ref.fa?sig=FASECRET",
                 "fai": "https://portal.example/ref.fa.fai?sig=INDEXSECRET"}


def test_preview_shows_references_without_their_signature(client):
    _, resp = _stage_preview(client, _doc(genome=SIGNED_GENOME))
    body = resp.json()
    assert body["success"] and "SECRET" not in resp.text
    assert body["genome"]["url"] == "https://portal.example/ref.fa"
    assert body["genome"]["fai"] == "https://portal.example/ref.fa.fai"
    assert body["genome"]["signed"] and body["genome"]["problem"] is None


def test_a_signed_reference_never_reaches_the_disk(client, monkeypatch, tmp_path):
    import urllib.request
    monkeypatch.setenv("HOME", str(tmp_path))
    link_id, _ = _stage_preview(client, _doc(tracks=[], genome=SIGNED_GENOME))

    def retrieve(url, filename, *args):
        with open(filename, "wb") as handle:
            handle.write(b"chr1\t4\t6\t4\t5\n" if ".fai" in url else b">chr1\nACGT\n")
        return filename, {}
    monkeypatch.setattr("services.http_download.fetch", retrieve)
    result = client.post(f"/api/session-links/{link_id}/open", json={}).json()
    assert result["genome"]["loaded"], result
    written = [p for p in tmp_path.rglob("*") if p.is_file()]
    assert any(p.name.endswith(".source") for p in written)
    for path in written:
        assert "SECRET" not in path.name
        if path.suffix in (".source", ".json", ".txt"):
            assert "sig=" not in path.read_text(), path


def test_an_old_cache_record_with_a_signature_is_scrubbed(tmp_path):
    from state.browser_state import cached_fasta_path
    (tmp_path / "ref.fa").write_text(">chr1\nACGT\n")
    (tmp_path / "ref.fa.source").write_text("https://portal.example/ref.fa?sig=OLDSECRET")
    assert cached_fasta_path(str(tmp_path), ["https://portal.example/ref.fa?sig=NEWSECRET"]) == str(tmp_path / "ref.fa")
    assert (tmp_path / "ref.fa.source").read_text() == "https://portal.example/ref.fa"


def test_references_follow_the_link_host_rules(client, monkeypatch):
    from state.browser_state import BrowserState
    monkeypatch.setenv(lf.HOSTS_ENV, "portal.example")
    link_id, preview = _stage_preview(client, _doc(tracks=[], genome={"fasta": "http://127.0.0.1:9900/ref.fa"}))
    assert "allowed link hosts" in preview.json()["genome"]["problem"]
    received = []
    monkeypatch.setattr(BrowserState, "_load_fasta", lambda self, url, **kw: received.append(url))
    result = client.post(f"/api/session-links/{link_id}/open", json={}).json()
    assert received == [] and any("allowed link hosts" in e for e in result["errors"])


def test_library_records_keep_no_signature_from_sidecars(tmp_path, monkeypatch):
    from library_fixtures import make_pipeline_run, seq
    from services import library_inspect as li, library_store as ls
    run = make_pipeline_run(tmp_path / "S1", sample="S1", plasmid_seq=seq(4))
    outputs = tmp_path / "S1" / "outputs.json"
    content = json.loads(outputs.read_text())
    content["reference_fasta"] = "https://portal.example/ref.fa?sig=LIBSECRET"
    outputs.write_text(json.dumps(content))
    monkeypatch.setenv("FIBERBROWSER_LIBRARY", str(tmp_path / "library.json"))
    entry = ls.record(li.inspect_file(run["called_bam"]), "added")
    saved = (tmp_path / "library.json").read_text()
    assert "LIBSECRET" not in saved and "sig=" not in saved
    assert "portal.example/ref.fa" in json.dumps(ls.load()["entries"][entry["id"]])


# ---------------------------------------------------------------------------- the files a link opens

@pytest.fixture
def files(tmp_path):
    from tests.link_fixtures import LinkServer
    server = LinkServer(str(tmp_path))
    yield server
    server.close()


@pytest.fixture
def fresh_state(standalone_app):
    import server as srv
    old = srv.state
    srv.state = srv.BrowserState(None, None, None, None)
    yield srv.state
    srv.state = old


def _demo_bam(tmp_path):
    import shutil
    from pathlib import Path
    import pysam
    demo = Path(__file__).resolve().parents[1] / "browser" / "data" / "demo" / "napa_ddda.bam"
    shutil.copy(demo, tmp_path / "s1.bam")
    pysam.index(str(tmp_path / "s1.bam"))


def _open_inline(client, tracks):
    link_id, preview = _stage_preview(client, {"schema": SCHEMA, "tracks": tracks})
    assert preview.json()["success"], preview.json()
    return client.post(f"/api/session-links/{link_id}/open", json={}).json()


def _open_into(state, tracks):
    """Stage, preview and open an inline link straight into ``state`` (the service calls the routes make)."""
    link = sl.stage("session", json.dumps({"schema": SCHEMA, "tracks": tracks}))
    assert sl.preview(link.id, state=state)["success"]
    return sl.open_link(state, link.id)


def test_public_track_opening_never_uses_an_unpinned_transport(client, monkeypatch):
    import urllib.request
    from services import runtime
    monkeypatch.setattr(runtime, "_public_mode", True)
    monkeypatch.setenv(lf.HOSTS_ENV, "portal.example")
    monkeypatch.setattr(lf, "resolve", lambda *a: ["127.0.0.1"])  # an allowed name pointing inside
    hits = []
    monkeypatch.setattr(urllib.request, "urlopen", lambda req, **kw: hits.append(req) or None)
    result = _open_inline(client, [{"url": "https://portal.example/x.bw"}, {"url": "https://portal.example/r.bb"}])
    assert hits == [] and result["opened"] == 0
    assert all("private or local-network address" in e for e in result["errors"]), result["errors"]


@needs_pybigwig_urls
def test_restricted_links_are_read_through_the_pinned_relay(client, files, tmp_path, fresh_state, monkeypatch):
    from tests.link_fixtures import write_bigwig
    from services import link_proxy
    import pyBigWig
    monkeypatch.setenv(lf.HOSTS_ENV, "127.0.0.1")  # a local server with an allowlist
    write_bigwig(str(tmp_path / "cov.bw"))
    _demo_bam(tmp_path)
    result = _open_into(fresh_state, [{"url": files.url("s1.bam"), "name": "Reads"},
                                      {"url": files.url("cov.bw"), "name": "Coverage"}])
    assert result["opened"] == 2, result
    track_path = fresh_state.orthogonal_tracks[-1]["path"]
    dataset_path = fresh_state.datasets[result["datasets"][0]["id"]].path
    assert link_proxy.is_relay_url(track_path) and link_proxy.is_relay_url(dataset_path.split("##idx##")[0])
    # Everything shown or saved carries the file's own address, never the relay's.
    assert su.redact_text(track_path) == files.url("cov.bw")
    assert su.redact_text(dataset_path) == files.url("s1.bam")
    # pyBigWig reads through the relay (a separate process: pyBigWig holds the GIL while it waits).
    handle = pyBigWig.open(track_path)
    assert handle.values("chr19", 47_516_000, 47_516_002) == [5.0, 5.0]
    handle.close()
    assert any(h.startswith("/cov.bw") for h in files.hits)


def test_a_relayed_redirect_out_of_the_allowlist_is_refused(client, files, tmp_path, fresh_state, monkeypatch):
    from tests.link_fixtures import write_bigwig
    monkeypatch.setenv(lf.HOSTS_ENV, "127.0.0.1")
    write_bigwig(str(tmp_path / "elsewhere.bw"))
    files.redirects["/cov.bw"] = f"http://localhost:{files.port}/elsewhere.bw"
    before = len(fresh_state.orthogonal_tracks)
    result = _open_into(fresh_state, [{"url": files.url("cov.bw"), "type": "bigwig"}])
    assert result["opened"] == 0 and "localhost is not on this server's list" in result["errors"][0]
    assert len(fresh_state.orthogonal_tracks) == before
    assert not any("elsewhere.bw" in h for h in files.hits)


def test_the_relay_checks_every_request_against_the_policy(files, tmp_path):
    import urllib.error
    import urllib.request
    from tests.link_fixtures import write_bigwig
    from services import link_proxy
    write_bigwig(str(tmp_path / "cov.bw"))
    allowed = link_proxy.relay_url(files.url("cov.bw"), lf.LinkPolicy(allowed_hosts=("127.0.0.1",)))
    with urllib.request.urlopen(urllib.request.Request(allowed, headers={"Range": "bytes=0-3"})) as reply:
        assert reply.status == 206 and len(reply.read()) == 4
    private = link_proxy.relay_url(files.url("cov.bw"), lf.LinkPolicy(allowed_hosts=("127.0.0.1",),
                                                                      allow_private=False))
    with pytest.raises(urllib.error.HTTPError) as refused:
        urllib.request.urlopen(private)
    assert refused.value.code == 502
    # A relay address never shows: a sibling's (not registered as a file) is masked too.
    assert su.redact_text(f"cannot open {allowed}.fai") == "cannot open link-relay:/cov.bw.fai"
    # Only the token's own file and plain names beside it: no paths, no other tokens.
    base = allowed.rsplit("/", 2)[0]
    for path in ("/x/cov.bw", "/" + allowed.rsplit("/", 2)[1] + "/../cov.bw", "/" + allowed.rsplit("/", 2)[1]):
        with pytest.raises(urllib.error.HTTPError) as missing:
            urllib.request.urlopen(base + path)
        assert missing.value.code == 404


@needs_pybigwig_urls
def test_unrestricted_local_servers_hand_urls_to_the_readers_directly(client, files, tmp_path, fresh_state):
    from tests.link_fixtures import write_bigwig
    write_bigwig(str(tmp_path / "cov.bw"))
    result = _open_into(fresh_state, [{"url": files.url("cov.bw")}])
    assert result["opened"] == 1 and fresh_state.orthogonal_tracks[-1]["path"] == files.url("cov.bw")


@needs_pybigwig_urls
@pytest.mark.parametrize("mode", ["_lab_mode", "_public_mode"])
def test_shared_servers_open_link_files_through_the_relay(files, tmp_path, fresh_state, monkeypatch, mode):
    """The servers the relay exists for: files open (lab confinement and public
    protection accept the relay URL and the private index copy)."""
    from tests.link_fixtures import write_bigwig
    from services import link_proxy, runtime
    import pyBigWig
    monkeypatch.setattr(runtime, mode, True)
    monkeypatch.setenv(lf.HOSTS_ENV, "localhost")
    # The shared-server policy, but over http and to loopback so the local test file server is reachable.
    shared = lf.LinkPolicy(public=True, allowed_hosts=("localhost",), https_only=False, allow_private=True,
                           allow_s3=False)
    monkeypatch.setattr(sl, "current_policy", lambda: shared)
    write_bigwig(str(tmp_path / "cov.bw"))
    _demo_bam(tmp_path)
    doc = {"schema": SCHEMA, "tracks": [{"url": files.url("s1.bam", host="localhost"), "name": "Reads"},
                                        {"url": files.url("cov.bw", host="localhost"), "name": "Coverage"}]}
    link = sl.stage("session", json.dumps(doc))
    assert sl.preview(link.id, state=fresh_state)["success"]
    result = sl.open_link(fresh_state, link.id)
    assert result["opened"] == 2, result
    track_path = fresh_state.orthogonal_tracks[-1]["path"]
    dataset_path = fresh_state.datasets[result["datasets"][0]["id"]].path
    assert link_proxy.is_relay_url(track_path) and link_proxy.is_relay_url(dataset_path.split("##idx##")[0])
    assert su.redact_text(track_path) == files.url("cov.bw", host="localhost")
    handle = pyBigWig.open(track_path)
    assert handle.values("chr19", 47_516_000, 47_516_001) == [5.0]
    handle.close()


def test_a_relay_that_cannot_start_fails_the_files_quickly_and_cleanly(client, monkeypatch):
    import time
    from services import link_proxy
    monkeypatch.setenv(lf.HOSTS_ENV, "portal.example")
    monkeypatch.setattr(link_proxy, "_process", None)
    monkeypatch.setattr(link_proxy, "_failed_at", time.monotonic())  # it just failed to start
    started = time.monotonic()
    result = _open_inline(client, [{"url": "https://portal.example/a.bw"}, {"url": "https://portal.example/b.bb"}])
    assert time.monotonic() - started < 5
    assert result["opened"] == 0 and all("link relay could not be started" in e for e in result["errors"])
