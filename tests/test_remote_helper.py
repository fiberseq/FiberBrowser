"""The read-only remote file helper (services/remote_sources/remote_helper.py).

Run as a local subprocess exactly as ssh runs it on a cluster: token on every
request, realpath confinement to the chosen roots, HTTP range semantics,
read-only, exit when stdin closes; and htslib / pyBigWig random access through it.
"""
from __future__ import annotations

import json
import os
import socket
import time

import pytest

from link_fixtures import needs_pybigwig_urls
from remote_fixtures import HelperProcess, http, write_fixture_files


@pytest.fixture(scope="module")
def files(tmp_path_factory):
    root = tmp_path_factory.mktemp("cluster") / "lab"
    made = write_fixture_files(root)
    (root / "sub").mkdir()
    (root / "sub" / "note.txt").write_text("hello world\n")
    (root / ".hidden").write_text("x")
    outside = tmp_path_factory.mktemp("outside")
    (outside / "secret.txt").write_text("top secret\n")
    os.symlink(outside / "secret.txt", root / "link_out.txt")
    os.symlink(outside, root / "dir_out")
    os.symlink(root / "sub" / "note.txt", root / "link_in.txt")
    os.mkfifo(root / "pipe")
    return {"root": root, "outside": outside, **made}


@pytest.fixture(scope="module")
def helper(files):
    proc = HelperProcess([files["root"]])
    yield proc
    proc.close()


def test_ready_line_reports_resolved_roots(helper, files):
    assert helper.info["roots"] == [os.path.realpath(files["root"])]
    assert helper.info["version"] == 2
    assert helper.info["python"].startswith("3.")


def test_helper_binds_loopback_only(helper):
    # Nothing answers on a non-loopback address of this machine.
    try:
        addrs = {ai[4][0] for ai in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)}
    except OSError:
        addrs = set()
    for addr in addrs - {"127.0.0.1"}:
        with socket.socket() as sock:
            sock.settimeout(1)
            assert sock.connect_ex((addr, helper.port)) != 0


def test_token_is_required_and_wrong_tokens_look_like_missing_files(helper, files):
    path = files["root"] / "sub" / "note.txt"
    assert http("GET", helper.url(path))[0] == 200
    bad = helper.url(path).replace(helper.token, "A" * len(helper.token))
    status, _h, body = http("GET", bad)
    assert status == 404 and b"secret" not in body
    no_token = f"http://127.0.0.1:{helper.port}/f{path}"
    assert http("GET", no_token)[0] == 404
    assert http("GET", f"http://127.0.0.1:{helper.port}/")[0] == 404
    assert http("GET", f"{helper.base[:-1]}/ping")[0] == 404  # a prefix of the token is not the token


@pytest.mark.parametrize("make_path", [
    lambda f: f["outside"] / "secret.txt",                      # absolute path outside the roots
    lambda f: f"{f['root']}/../{f['outside'].name}/secret.txt",  # ../ out of a root
    lambda f: f["root"] / "link_out.txt",                        # symlink leaving the roots
    lambda f: f["root"] / "dir_out" / "secret.txt",              # through a symlinked folder
    lambda f: "etc/passwd",                                      # relative path
    lambda f: f["root"] / "pipe",                                # a FIFO is never served
    lambda f: f["root"] / "sub",                                 # a folder is not a file
])
def test_paths_outside_the_roots_are_refused(helper, files, make_path):
    status, _h, body = http("GET", helper.url(make_path(files)))
    assert status == 404
    assert b"top secret" not in body


def test_encoded_traversal_is_refused(helper, files):
    url = f"{helper.base}/f{files['root']}/%2e%2e/{files['outside'].name}/secret.txt"
    assert http("GET", url)[0] == 404


def test_symlink_inside_the_roots_is_served(helper, files):
    assert http("GET", helper.url(files["root"] / "link_in.txt"))[2] == b"hello world\n"


def test_listing_is_confined_and_hides_escaping_links(helper, files):
    status, _h, body = http("GET", f"{helper.base}/ls?path={files['root']}")
    payload = json.loads(body)
    names = {e["name"]: e for e in payload["entries"]}
    assert status == 200
    assert {"reads.bam", "reads.bam.bai", "ref.fa", "ref.fa.fai", "sub", "link_in.txt"} <= set(names)
    assert "link_out.txt" not in names and "dir_out" not in names  # links out of the roots
    assert "pipe" not in names and ".hidden" not in names
    assert names["sub"]["type"] == "dir" and names["reads.bam"]["size"] > 0
    for outside in (files["outside"], f"{files['root']}/..", "/", "/etc"):
        status, _h, body = http("GET", f"{helper.base}/ls?path={outside}")
        assert status == 403 and json.loads(body)["entries"] == []


def test_listing_is_bounded(tmp_path):
    for i in range(5005):
        (tmp_path / f"f{i:05d}.txt").touch()
    proc = HelperProcess([tmp_path])
    try:
        payload = json.loads(http("GET", f"{proc.base}/ls?path={tmp_path}")[2])
        assert len(payload["entries"]) == 5000 and payload["truncated"] is True
    finally:
        proc.close()


def test_range_semantics(helper, files):
    path = files["root"] / "sub" / "note.txt"  # "hello world\n": 12 bytes
    url = helper.url(path)
    status, headers, body = http("GET", url)
    assert (status, body) == (200, b"hello world\n")
    assert headers["content-length"] == "12" and headers["accept-ranges"] == "bytes"
    status, headers, body = http("GET", url, {"Range": "bytes=0-4"})
    assert (status, body, headers["content-range"], headers["content-length"]) == (206, b"hello", "bytes 0-4/12", "5")
    status, headers, body = http("GET", url, {"Range": "bytes=6-"})
    assert (status, body, headers["content-range"]) == (206, b"world\n", "bytes 6-11/12")
    status, headers, body = http("GET", url, {"Range": "bytes=-6"})
    assert (status, body) == (206, b"world\n")
    status, headers, body = http("GET", url, {"Range": "bytes=6-1000"})
    assert (status, body, headers["content-range"]) == (206, b"world\n", "bytes 6-11/12")
    status, headers, _b = http("GET", url, {"Range": "bytes=12-"})
    assert status == 416 and headers["content-range"] == "bytes */12"
    status, _h, _b = http("GET", url, {"Range": "bytes=-0"})
    assert status == 416
    # Malformed or multiple ranges are refused, never answered with the whole
    # file (a garbled Range on a 100 GB BAM must not stream all of it).
    for header in ("bytes=5-2", "bytes=0-1,4-5", "items=0-3", "bytes=-", "bytes=a-b"):
        status, headers, body = http("GET", url, {"Range": header})
        assert status == 416 and b"hello" not in body and headers["content-range"] == "bytes */12"


def test_head_reports_size_without_a_body(helper, files):
    status, headers, body = http("HEAD", helper.url(files["bam"]))
    assert status == 200 and body == b""
    assert int(headers["content-length"]) == files["bam"].stat().st_size
    status, headers, _b = http("HEAD", helper.url(files["bam"]), {"Range": "bytes=0-99"})
    assert status == 206 and headers["content-length"] == "100"


@pytest.mark.parametrize("method", ["POST", "PUT", "DELETE", "PATCH"])
def test_helper_is_read_only(helper, files, method):
    target = files["root"] / "sub" / "note.txt"
    status, _h, _b = http(method, helper.url(target))
    assert status == 405
    assert target.read_text() == "hello world\n"


def test_stat_ping_and_stats(helper, files):
    info = json.loads(http("GET", f"{helper.base}/stat?path={files['bam']}")[2])
    st = files["bam"].stat()
    assert {k: info[k] for k in ("exists", "type", "size", "mtime")} == {
        "exists": True, "type": "file", "size": st.st_size, "mtime": int(st.st_mtime)}
    # A version that changes with any rewrite, not just a whole-second mtime.
    assert (info["mtime_ns"], info["ctime_ns"], info["ino"]) == (st.st_mtime_ns, st.st_ctime_ns, st.st_ino)
    assert info["version"] and isinstance(info["version"], str)
    assert http("GET", f"{helper.base}/stat?path={files['outside']}/secret.txt")[0] == 404
    assert json.loads(http("GET", f"{helper.base}/ping")[2])["ok"] is True
    stats = json.loads(http("GET", f"{helper.base}/stats")[2])
    assert stats["requests"] > 0 and stats["bytes"] > 0


def test_pysam_reads_bam_and_fasta_by_range(helper, files, tmp_path, monkeypatch):
    import pysam
    monkeypatch.chdir(tmp_path)
    with pysam.AlignmentFile(helper.url(files["bam"]), "rb",
                             index_filename=str(files["bam"]) + ".bai") as bam:
        remote = [r.query_name for r in bam.fetch("chr1", 5000, 5600)]
    with pysam.AlignmentFile(str(files["bam"]), "rb") as bam:
        local = [r.query_name for r in bam.fetch("chr1", 5000, 5600)]
    assert remote == local and remote
    with pysam.FastaFile(helper.url(files["fasta"])) as fasta:
        assert fasta.fetch("chr1", 1000, 1060) == files["seq"][1000:1060]
    assert os.listdir(tmp_path) == []  # nothing cached in the working folder


def test_pysam_reads_a_csi_index_by_range(helper, files, tmp_path, monkeypatch):
    import pysam
    import shutil
    # htslib saves a remote index into the working folder (why opening.py
    # passes a cached local copy instead); keep it out of the repository.
    monkeypatch.chdir(tmp_path)
    csi_bam = files["root"] / "csi_reads.bam"
    shutil.copy(files["bam"], csi_bam)
    pysam.index("-c", str(csi_bam))
    with pysam.AlignmentFile(helper.url(csi_bam), "rb", index_filename=helper.url(csi_bam) + ".csi") as bam:
        assert bam.count("chr1", 5000, 5600) > 0


@needs_pybigwig_urls
def test_pybigwig_reads_bigwig_and_bigbed_by_range(helper, files):
    import pyBigWig
    bw = pyBigWig.open(helper.url(files["bigwig"]))
    assert bw.values("chr1", 500, 502) == [2.0, 2.0]
    bw.close()
    if "bigbed" not in files:
        pytest.skip("bedToBigBed not installed")
    bb = pyBigWig.open(helper.url(files["bigbed"]))
    assert [e[:2] for e in bb.entries("chr1", 0, 10_000)] == [(100, 200), (5000, 5400)]
    bb.close()


def test_helper_exits_when_its_session_closes(files):
    proc = HelperProcess([files["root"]])
    assert http("GET", f"{proc.base}/ping")[0] == 200
    proc.proc.stdin.close()
    assert proc.proc.wait(timeout=5) == 0
    with socket.socket() as sock:
        assert sock.connect_ex(("127.0.0.1", proc.port)) != 0


def test_helper_exits_when_idle(files):
    proc = HelperProcess([files["root"]], idle_timeout=2)
    try:
        assert proc.proc.wait(timeout=10) == 0
    finally:
        proc.close()


def test_helper_refuses_a_short_token_and_missing_roots(tmp_path):
    with pytest.raises(RuntimeError):
        HelperProcess([tmp_path], token="short")
    with pytest.raises(RuntimeError):
        HelperProcess([tmp_path / "does-not-exist"])


def test_helper_script_is_pure_stdlib_and_py36_clean():
    import ast
    from remote_fixtures import HELPER
    tree = ast.parse(HELPER.read_text())
    allowed = {"hashlib", "hmac", "io", "json", "os", "re", "signal", "socket", "stat", "sys",
               "tempfile", "threading", "time", "http.server", "socketserver", "urllib.parse"}
    ast.parse(HELPER.read_text(), feature_version=(3, 6))  # nothing newer than 3.6 syntax
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            assert {a.name for a in node.names} <= allowed
        elif isinstance(node, ast.ImportFrom):
            assert node.module in allowed
        # Python 3.6: no walrus, no f-strings with "=" etc. (f-strings are 3.6 but kept out anyway)
        assert not isinstance(node, getattr(ast, "NamedExpr", ())), "walrus needs 3.8"
        assert not isinstance(node, ast.JoinedStr), "keep the helper %-formatted"
    names = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)} | {
        a.name for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) for a in n.names}
    assert "ThreadingHTTPServer" not in names  # 3.7+
