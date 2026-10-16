"""Connect to cluster: fixes from the 3.0 security review.

The helper parts run the real request handler over real socketpairs (and the
real helper script as a subprocess); the FiberBrowser parts use a
live-shaped connection. Each test failed on the code before the fix.
"""
from __future__ import annotations

import importlib.util
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import quote

import pytest

from remote_fixtures import HELPER, HelperProcess, http, unix_http, write_fixture_files
from services.remote_sources import opening
from services.remote_sources import ssh_command as cmd
from services.remote_sources import ssh_source as ssh

TOKEN = "review_" + "A" * 36


# --------------------------------------------------------------------------
# The helper, in process
# --------------------------------------------------------------------------

def _load_helper():
    spec = importlib.util.spec_from_file_location("fb_remote_helper_under_test", HELPER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def helper(tmp_path):
    module = _load_helper()
    chosen = tmp_path / "chosen"
    chosen.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (chosen / "ok").write_bytes(b"allowed")
    (outside / "secret").write_bytes(b"outside-secret")
    sub = chosen / "sub"
    sub.mkdir()
    (sub / "secret").write_bytes(b"inside")
    real = os.path.realpath(chosen)
    module.ROOTS[:] = [real]
    module.ROOT_FDS[real] = os.open(real, os.O_RDONLY)
    module.CONFIG["token"] = TOKEN
    module.chosen, module.outside, module.sub = chosen, outside, sub
    yield module
    for fd in module.ROOT_FDS.values():
        os.close(fd)


def _request(module, raw: bytes, *, server=None) -> bytes:
    """One raw HTTP exchange with the real Handler over a real socketpair."""
    client, remote = socket.socketpair()
    worker = threading.Thread(target=module.Handler, args=(remote, ("local", 0), server or SimpleNamespace()))
    worker.start()
    client.sendall(raw)
    worker.join(30)
    remote.close()
    data = b""
    client.settimeout(5)
    while True:
        chunk = client.recv(65536)
        if not chunk:
            break
        data += chunk
    client.close()
    return data


def _get(module, target: str, headers=None, method="GET"):
    extra = "".join(f"{k}: {v}\r\n" for k, v in (headers or {}).items())
    raw = f"{method} {target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n{extra}\r\n".encode()
    data = _request(module, raw)
    head, _sep, body = data.partition(b"\r\n\r\n")
    lines = head.decode("latin-1").split("\r\n")
    status = int(lines[0].split()[1])
    headers_out = {k.lower(): v.strip() for k, _s, v in (line.partition(":") for line in lines[1:])}
    return status, headers_out, body


def _url(path) -> str:
    return f"/{TOKEN}/f{quote(str(path), safe='/')}"


def _swap_after_check(module, monkeypatch, folder: Path, target: Path):
    """Replace ``folder`` with a link to ``target`` right after the path check."""
    original = module.confine

    def confine_then_swap(path):
        real = original(path)
        if real is not None and not folder.is_symlink():
            folder.rename(folder.with_name(folder.name + "-old"))
            folder.symlink_to(target, target_is_directory=True)
        return real
    monkeypatch.setattr(module, "confine", confine_then_swap)


def test_folder_swapped_for_a_link_after_the_check_is_not_followed(helper, monkeypatch):
    _swap_after_check(helper, monkeypatch, helper.sub, helper.outside)
    status, _h, body = _get(helper, _url(helper.sub / "secret"))
    assert status == 404 and b"outside-secret" not in body


def test_folder_swapped_during_the_walk_is_not_followed(helper, monkeypatch):
    # The swap lands between two steps of the descriptor walk.
    original_open = helper.os.open

    def swapping_open(name, flags, *args, **kwargs):
        if name == "sub" and "dir_fd" in kwargs and not helper.sub.is_symlink():
            helper.sub.rename(helper.chosen / "sub-old")
            helper.sub.symlink_to(helper.outside, target_is_directory=True)
        return original_open(name, flags, *args, **kwargs)
    monkeypatch.setattr(helper.os, "open", swapping_open)
    status, _h, body = _get(helper, _url(helper.sub / "secret"))
    assert status == 404 and b"outside-secret" not in body


def test_listing_and_stat_of_a_swapped_folder_are_refused(helper, monkeypatch):
    _swap_after_check(helper, monkeypatch, helper.sub, helper.outside)
    status, _h, body = _get(helper, f"/{TOKEN}/ls?path={quote(str(helper.sub))}")
    assert status == 403 and b"secret" not in body
    status, _h, body = _get(helper, f"/{TOKEN}/stat?path={quote(str(helper.sub / 'secret'))}")
    assert status == 404 and json.loads(body) == {"exists": False}


def test_final_file_swapped_for_a_link_is_refused(helper, monkeypatch):
    file = helper.sub / "secret"
    original = helper.confine

    def confine_then_swap(path):
        real = original(path)
        if real is not None and not file.is_symlink():
            file.unlink()
            file.symlink_to(helper.outside / "secret")
        return real
    monkeypatch.setattr(helper, "confine", confine_then_swap)
    status, _h, body = _get(helper, _url(file))
    assert status == 404 and b"outside-secret" not in body


def test_links_inside_the_roots_still_work(helper):
    (helper.chosen / "alias").symlink_to(helper.sub, target_is_directory=True)
    status, _h, body = _get(helper, _url(helper.chosen / "alias" / "secret"))
    assert (status, body) == (200, b"inside")
    listing = json.loads(_get(helper, f"/{TOKEN}/ls?path={quote(str(helper.chosen))}")[2])
    assert {"name": "alias", "type": "dir", "link": True} == {k: v for k, v in
                                                              next(e for e in listing["entries"] if e["name"] == "alias").items()
                                                              if k in ("name", "type", "link")}


def test_listing_reads_a_bounded_number_of_entries(helper, monkeypatch):
    consumed = [0]

    class _Entry:
        def __init__(self, i):
            self.name = f"f{i:07d}"

    class _Scan:
        def __init__(self, fd):
            pass

        def __iter__(self):
            for i in range(1_000_000):
                consumed[0] += 1
                yield _Entry(i)

        def close(self):
            pass
    monkeypatch.setattr(helper.os, "scandir", _Scan)
    fd = os.open(helper.chosen, os.O_RDONLY)
    try:
        result = helper.list_dir(fd, str(helper.chosen))
    finally:
        os.close(fd)
    assert consumed[0] <= helper.MAX_LIST_SCAN + 1
    assert result["truncated"] is True and result["truncated_reason"] == "scan"
    assert result["scanned"] == helper.MAX_LIST_SCAN


def test_listing_stops_at_its_time_budget(helper, monkeypatch):
    for i in range(300):
        (helper.chosen / f"n{i:04d}").touch()
    monkeypatch.setattr(helper, "LIST_TIME_BUDGET", -1.0)
    listing = json.loads(_get(helper, f"/{TOKEN}/ls?path={quote(str(helper.chosen))}")[2])
    assert listing["truncated"] is True and listing["truncated_reason"] == "time"
    assert len(listing["entries"]) < 300


def test_python36_without_a_descriptor_alias_refuses_to_list(helper, monkeypatch):
    # Python 3.6 where /proc/self/fd (and /dev/fd) can't be read: the only
    # reader left, os.listdir(fd), reads a whole folder at once, so the
    # listing is refused instead of breaking its bound.
    monkeypatch.setattr(helper, "_SCANDIR_FD", False)
    monkeypatch.setattr(helper, "_FD_ALIASES", ("/nonexistent-proc/self/fd/%d",))
    read_all = []
    monkeypatch.setattr(helper.os, "listdir", lambda fd: read_all.append(fd) or ["x"] * 100001)
    status, _h, body = _get(helper, f"/{TOKEN}/ls?path={quote(str(helper.chosen))}")
    listing = json.loads(body)
    assert status == 200 and listing["entries"] == [] and "Python 3.7 or newer" in listing["error"]
    assert read_all == []
    # Files are still served.
    assert _get(helper, _url(helper.chosen / "ok"))[2] == b"allowed"


def test_ranges_are_bounded_and_malformed_ranges_refused(helper):
    big = helper.chosen / "large.bam"
    with big.open("wb") as stream:
        stream.truncate(5 * 1024 ** 3)
    size = 5 * 1024 ** 3
    status, headers, _b = _get(helper, _url(big), {"Range": "bytes=0-9999999999999"}, method="HEAD")
    assert status == 416 and headers["content-range"] == f"bytes */{size}"
    status, _h, _b = _get(helper, _url(big), {"Range": f"bytes=-{helper.MAX_RANGE_BYTES + 1}"}, method="HEAD")
    assert status == 416
    for header in ("bytes=0-1,3-4", "bytes=9-2", "chunks=0-1", "bytes=x-"):
        status, _h, _b = _get(helper, _url(big), {"Range": header}, method="HEAD")
        assert status == 416, header
    # htslib's own requests stay as they are: open-ended ranges and no Range at all.
    status, headers, _b = _get(helper, _url(big), {"Range": "bytes=100-"}, method="HEAD")
    assert status == 206 and int(headers["content-length"]) == size - 100
    status, headers, _b = _get(helper, _url(big), method="HEAD")
    assert status == 200 and int(headers["content-length"]) == size
    status, headers, _b = _get(helper, _url(big), {"Range": "bytes=0-131071"}, method="HEAD")
    assert status == 206 and headers["content-length"] == "131072"


def test_a_file_key_opens_only_its_file_and_index(helper):
    (helper.chosen / "ref.fa").write_bytes(b">c\nACGT\n")
    (helper.chosen / "ref.fa.fai").write_bytes(b"c\t4\t3\t4\t5\n")
    key = helper.file_key(TOKEN, str(helper.chosen / "ref.fa"))
    assert key == ssh.file_key(TOKEN, str(helper.chosen / "ref.fa"))  # FiberBrowser computes the same
    status, _h, body = _get(helper, f"/{key}/f{helper.chosen}/ref.fa")
    assert (status, body) == (200, b">c\nACGT\n")
    assert _get(helper, f"/{key}/f{helper.chosen}/ref.fa.fai")[0] == 200  # htslib appends .fai
    assert _get(helper, f"/{key}/f{helper.chosen}/ok")[0] == 404
    assert _get(helper, f"/{key}/ls?path={quote(str(helper.chosen))}")[0] == 404
    assert _get(helper, f"/{key}/stat?path={quote(str(helper.chosen / 'ok'))}")[0] == 404


def _server(module, monkeypatch, *, cap=None):
    if cap is not None:
        monkeypatch.setattr(module.Server, "max_connections", cap)
    return module.Server(("127.0.0.1", 0), module.Handler, bind_and_activate=False)


def _worker_threads():
    return [t for t in threading.enumerate() if t.name.startswith("Thread-") or "process_request" in t.name]


def test_slow_unauthenticated_clients_are_dropped_at_the_deadline(helper, monkeypatch):
    monkeypatch.setattr(helper, "REQUEST_DEADLINE", 0.4)
    server = _server(helper, monkeypatch)
    clients = []
    try:
        before = threading.active_count()
        for _ in range(24):
            client, remote = socket.socketpair()
            clients.append(client)
            client.sendall(b"GET /")  # never completes its request line; no token needed
            server.process_request(remote, ("local", 0))
        assert threading.active_count() - before >= 20
        deadline = time.time() + 5
        while threading.active_count() > before and time.time() < deadline:
            time.sleep(0.05)
        assert threading.active_count() <= before
        # A client that trickles bytes doesn't extend its deadline either.
        client, remote = socket.socketpair()
        clients.append(client)
        server.process_request(remote, ("local", 0))
        started = time.time()
        for _ in range(20):
            try:
                client.sendall(b"G")
            except OSError:
                break
            time.sleep(0.1)
            if threading.active_count() <= before:
                break
        assert threading.active_count() <= before and time.time() - started < 2.5
    finally:
        for client in clients:
            client.close()
        server.server_close()


def test_connections_beyond_the_limit_are_refused_at_once(helper, monkeypatch):
    monkeypatch.setattr(helper, "REQUEST_DEADLINE", 5.0)
    server = _server(helper, monkeypatch, cap=3)
    clients = []
    try:
        for _ in range(3):
            client, remote = socket.socketpair()
            clients.append(client)
            server.process_request(remote, ("local", 0))
        client, remote = socket.socketpair()
        clients.append(client)
        client.settimeout(2)
        server.process_request(remote, ("local", 0))
        assert client.recv(200).startswith(b"HTTP/1.1 503")
        assert client.recv(200) == b""  # and closed
    finally:
        for client in clients:
            client.close()
        server.server_close()


def test_idle_keep_alive_connections_are_closed(helper, monkeypatch):
    monkeypatch.setattr(helper, "REQUEST_DEADLINE", 0.5)
    server = _server(helper, monkeypatch)
    client, remote = socket.socketpair()
    try:
        server.process_request(remote, ("local", 0))
        client.sendall(f"GET /{TOKEN}/ping HTTP/1.1\r\nHost: x\r\n\r\n".encode())  # keep-alive
        client.settimeout(5)
        first = b""
        while b'"ok": true' not in first:
            first += client.recv(4096)
        assert b"200 OK" in first
        started = time.time()
        assert client.recv(4096) == b""  # closed by the helper after the idle deadline
        assert time.time() - started < 3
    finally:
        client.close()
        server.server_close()


def test_a_client_that_stops_reading_is_released(helper, monkeypatch):
    monkeypatch.setattr(helper, "WRITE_TIMEOUT", 0.5)
    big = helper.chosen / "stream.bin"
    big.write_bytes(os.urandom(1) * (32 * 1024 * 1024))
    server = _server(helper, monkeypatch)
    client, remote = socket.socketpair()
    try:
        before = threading.active_count()
        server.process_request(remote, ("local", 0))
        client.sendall(f"GET {_url(big)} HTTP/1.1\r\nHost: x\r\n\r\n".encode())
        deadline = time.time() + 10
        time.sleep(0.2)
        while threading.active_count() > before and time.time() < deadline:
            time.sleep(0.05)
        assert threading.active_count() <= before
    finally:
        client.close()
        server.server_close()


def test_stat_reports_a_version_that_sees_same_second_rewrites(helper):
    file = helper.chosen / "reads.bam.bai"
    file.write_bytes(b"OLD!")
    second = 1_700_000_000
    os.utime(file, ns=(second * 10**9 + 100, second * 10**9 + 100))
    first = json.loads(_get(helper, f"/{TOKEN}/stat?path={quote(str(file))}")[2])
    file.write_bytes(b"NEW!")
    os.utime(file, ns=(second * 10**9 + 900_000_000, second * 10**9 + 900_000_000))
    again = json.loads(_get(helper, f"/{TOKEN}/stat?path={quote(str(file))}")[2])
    assert first["mtime"] == again["mtime"] and first["size"] == again["size"]
    assert first["version"] != again["version"]
    headers = _get(helper, _url(file), method="HEAD")[1]
    assert headers["etag"] == f'"{again["version"]}"'


# --------------------------------------------------------------------------
# The helper as a subprocess: Unix socket mode, other Pythons
# --------------------------------------------------------------------------

@pytest.fixture(scope="module")
def files(tmp_path_factory):
    root = tmp_path_factory.mktemp("cluster") / "lab"
    return {"root": root, **write_fixture_files(root)}


@pytest.mark.parametrize("ending", ["stdin", "sigterm", "sighup"])
def test_unix_socket_mode_is_private_and_cleaned_up(files, ending):
    proc = HelperProcess([files["root"]], listen="unix")
    try:
        assert proc.info["port"] is None and proc.socket
        folder = os.path.dirname(proc.socket)
        info = os.stat(folder)
        assert info.st_uid == os.getuid() and info.st_mode & 0o777 == 0o700
        assert len(proc.socket.encode()) < 104
        status, _h, body = unix_http(proc.socket, "GET", f"/{proc.token}/ping")
        assert status == 200 and json.loads(body)["ok"] is True
        key = ssh.file_key(proc.token, str(files["bam"]))
        status, _h, body = unix_http(proc.socket, "GET", f"/{key}/f{quote(str(files['bam']))}",
                                     {"Range": "bytes=0-3"})
        assert status == 206 and body == files["bam"].read_bytes()[:4]
        if ending == "stdin":
            proc.proc.stdin.close()
        else:
            proc.proc.send_signal(signal.SIGTERM if ending == "sigterm" else signal.SIGHUP)
        assert proc.proc.wait(timeout=10) == 0
        assert not os.path.exists(folder)
    finally:
        proc.close()


def test_socket_folder_avoids_paths_ssh_cannot_forward_to(tmp_path, monkeypatch):
    helper = _load_helper()
    odd = tmp_path / "job 1:x"
    odd.mkdir()
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(odd))
    monkeypatch.setenv("TMPDIR", str(odd))
    import tempfile
    monkeypatch.setattr(tempfile, "tempdir", None)
    path = helper._private_socket_path()
    try:
        assert path is not None and not path.startswith(str(odd))
        assert cmd.validate_remote_socket(path) == path
    finally:
        helper._cleanup()


def _other_pythons():
    found = []
    for name in ("python3.6", "python3.7", "python3.8", "python3.9", "/usr/bin/python3"):
        path = shutil.which(name) or (name if os.path.isabs(name) and os.path.exists(name) else None)
        if not path:
            continue
        try:
            version = subprocess.run([path, "-c", "import sys; print(sys.version_info[:2])"],
                                     capture_output=True, text=True, timeout=10).stdout.strip()
        except (OSError, subprocess.TimeoutExpired):
            continue
        if version and version not in {v for _p, v in found} and version != str(sys.version_info[:2]):
            found.append((path, version))
    return found


@pytest.mark.parametrize("listen", ["unix", "tcp"])
def test_helper_runs_on_older_pythons(files, listen):
    pythons = _other_pythons()
    if not pythons:
        pytest.skip("no other Python 3 on this machine")
    for python, _version in pythons:
        proc = HelperProcess([files["root"]], python=python, listen=listen)
        try:
            target = f"/{proc.token}/ls?path={quote(str(files['root']))}"
            if listen == "unix":
                status, _h, body = unix_http(proc.socket, "GET", target)
            else:
                status, _h, body = http("GET", f"http://127.0.0.1:{proc.port}{target}")
            assert status == 200 and "reads.bam" in {e["name"] for e in json.loads(body)["entries"]}, python
        finally:
            proc.close()


# --------------------------------------------------------------------------
# FiberBrowser side
# --------------------------------------------------------------------------

@pytest.fixture
def live_conn(monkeypatch):
    conn = ssh.SshConnection("review-host", None, ["/chosen"], remote_python=None, persist="30m", idle_timeout=28800)
    conn.local_port = 9
    conn.state = "connected"
    conn.proc = SimpleNamespace(poll=lambda: None)
    conn.register_redactions()  # as _forward does once the helper answers
    source = ssh.SshSource()
    source._connections[conn.target] = conn
    import services.remote_sources as registry
    monkeypatch.setattr(registry, "_LOADED", True)
    monkeypatch.setitem(registry._SOURCES, "ssh", source)
    monkeypatch.setattr(ssh, "default_user_for", lambda host: None)
    return conn


@pytest.mark.parametrize("kind", ["bam", "fasta"])
def test_native_open_errors_print_no_live_url(live_conn, monkeypatch, capfd, kind):
    monkeypatch.setattr(opening, "cached_index_for", lambda ref: None)
    with pytest.raises(Exception) as caught:
        if kind == "bam":
            opening.open_alignment_file("ssh://review-host/chosen/bad.bam")
        else:
            opening.open_fasta("ssh://review-host/chosen/bad.fa")
    _out, err = capfd.readouterr()
    key = ssh.file_key(live_conn.token, f"/chosen/bad.{'bam' if kind == 'bam' else 'fa'}")
    for text in (err, str(caught.value)):
        assert live_conn.token not in text and key not in text and "127.0.0.1:9/" not in text


def test_htslib_verbosity_is_restored_after_overlapping_quiet_opens():
    import pysam
    from services.htslib_quiet import quiet_htslib
    level = pysam.set_verbosity(3)
    try:
        barrier = threading.Barrier(4)

        def worker():
            with quiet_htslib():
                barrier.wait(5)
                time.sleep(0.05)
        threads = [threading.Thread(target=worker) for _ in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        assert pysam.set_verbosity(3) == 3
    finally:
        pysam.set_verbosity(level)


def test_live_urls_are_redacted_from_printed_output_logs_and_json(live_conn, capsys, caplog):
    import logging
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from services import signed_urls

    # capsys swaps sys.stderr only when the test body starts; a server's
    # streams exist before any connection registers its URLs.
    live_conn.register_redactions()
    url = live_conn.file_url("/chosen/reads.bam")
    key = url.split("/")[3]
    print(f"[E::hts_open_format] Failed to open file \"{url}\"", file=sys.stderr)
    err = capsys.readouterr().err
    assert key not in err and "ssh://review-host/chosen/reads.bam" in err

    signed_urls.install_log_redaction(("fb-test-remote",))
    with caplog.at_level(logging.INFO, logger="fb-test-remote"):
        logging.getLogger("fb-test-remote").info("could not read %s", url)
    assert key not in caplog.text and "ssh://review-host/chosen/reads.bam" in caplog.text

    app = FastAPI()
    signed_urls.install_signed_url_redaction(app)

    @app.get("/x")
    def _x():
        return {"error": f"Failed to open {url}", "base": live_conn.base_url}
    body = TestClient(app).get("/x").text
    assert key not in body and live_conn.token not in body and "ssh://review-host/chosen/reads.bam" in body


def test_opening_many_files_does_not_grow_the_redaction_vault(live_conn):
    from services import signed_urls
    live_conn.file_url("/chosen/first.bam")
    before = (len(signed_urls._secret_to_display), len(signed_urls._patterns))
    urls = [live_conn.file_url(f"/chosen/f{i}.bam") for i in range(200)]
    assert (len(signed_urls._secret_to_display), len(signed_urls._patterns)) == before
    body = json.dumps({"paths": urls}).encode()
    redacted = signed_urls.redact_bytes(body)
    assert b"127.0.0.1:9/" not in redacted and b"ssh://review-host/chosen/f199.bam" in redacted


def _rewrite(path, data: bytes) -> None:
    """Rewrite a file as a later write would. Linux file times move in clock ticks
    (a few ms), so a same-size rewrite right away could keep every stat field the
    version is made of; a real rewrite between two reads of a download is later."""
    before = os.stat(path).st_mtime_ns
    Path(path).write_bytes(data)
    if os.stat(path).st_mtime_ns == before:
        os.utime(path, ns=(before + 1_000_000, before + 1_000_000))


def _versioned_source(files: dict, monkeypatch, *, change_during_fetch=None):
    """A source over local files whose stat carries the helper's version."""
    helper = _load_helper()

    def stat(ref, max_age=15.0):
        path = files.get(ref)
        if path is None or not os.path.exists(path):
            return None
        st = os.stat(path)
        return {"type": "file", "size": st.st_size, "mtime": int(st.st_mtime), "version": helper.version_of(st)}

    fetched = []

    def fetch_bytes(ref, limit):
        fetched.append(ref)
        data = Path(files[ref]).read_bytes()
        if change_during_fetch:
            change_during_fetch(ref, len(fetched))
        return data
    source = SimpleNamespace(stat=stat, fetch_bytes=fetch_bytes, fetched=fetched)
    monkeypatch.setattr(opening, "source_for_ref", lambda ref: source)
    return source


def test_index_cache_sees_same_second_rewrites_and_bam_replacement(tmp_path, monkeypatch):
    monkeypatch.setenv(opening.CACHE_ENV, str(tmp_path / "cache"))
    monkeypatch.setattr(opening, "_index_memo", {})
    bam, bai = tmp_path / "reads.bam", tmp_path / "reads.bam.bai"
    bam.write_bytes(b"BAM1")
    bai.write_bytes(b"OLD!")
    second = 1_700_000_000
    os.utime(bai, ns=(second * 10**9 + 100,) * 2)
    ref = "ssh://review-host/chosen/reads.bam"
    _versioned_source({ref: str(bam), ref + ".bai": str(bai)}, monkeypatch)
    first = opening.cached_index_for(ref)
    assert Path(first).read_bytes() == b"OLD!"
    bai.write_bytes(b"NEW!")
    os.utime(bai, ns=(second * 10**9 + 900_000_000,) * 2)
    opening.forget_remote_state()
    second_copy = opening.cached_index_for(ref)
    assert second_copy != first and Path(second_copy).read_bytes() == b"NEW!"
    # A replaced BAM is a new version even when its index looks unchanged: no memo reuse.
    bam.write_bytes(b"BAM2")
    third = opening.cached_index_for(ref)
    assert third != second_copy


def test_a_file_changing_during_its_download_is_not_cached(tmp_path, monkeypatch):
    monkeypatch.setenv(opening.CACHE_ENV, str(tmp_path / "cache"))
    remote = tmp_path / "p.gb"
    remote.write_bytes(b"version one")
    ref = "ssh://review-host/chosen/p.gb"

    def rewrite(_ref, count):
        _rewrite(remote, b"version %d!" % (count + 1))  # changes under every download
    _versioned_source({ref: str(remote)}, monkeypatch, change_during_fetch=rewrite)
    with pytest.raises(opening.RemoteSourceError, match="kept changing"):
        opening.local_copy(ref)
    assert not list((tmp_path / "cache" / "files").glob("*/p.gb"))

    calls = []

    def rewrite_once(_ref, count):
        if count == 1:
            _rewrite(remote, b"settled version")
        calls.append(count)
    _versioned_source({ref: str(remote)}, monkeypatch, change_during_fetch=rewrite_once)
    local = opening.local_copy(ref)
    assert Path(local).read_bytes() == b"settled version" and calls == [1, 2]


def test_ssh_whole_file_copies_are_ranged_and_version_checked(files, monkeypatch, tmp_path):
    helper_proc = HelperProcess([files["root"]])
    try:
        conn = ssh.SshConnection("review-host", None, [str(files["root"])], remote_python=None,
                                 persist="30m", idle_timeout=0)
        conn.token, conn.local_port, conn.state = helper_proc.token, helper_proc.port, "connected"
        conn.proc = SimpleNamespace(poll=lambda: None)
        source = ssh.SshSource()
        source._connections[conn.target] = conn
        import services.remote_sources as registry
        monkeypatch.setattr(registry, "_LOADED", True)
        monkeypatch.setitem(registry._SOURCES, "ssh", source)
        monkeypatch.setattr(ssh, "FETCH_CHUNK_BYTES", 1000)
        ranges = []
        original_open = ssh._NO_PROXY_OPENER.open

        def recording_open(request, *args, **kwargs):
            if hasattr(request, "headers") and "/f/" in request.full_url:
                ranges.append(request.headers.get("Range"))
                assert conn.token not in request.full_url  # file URLs carry the per-file key
            return original_open(request, *args, **kwargs)
        monkeypatch.setattr(ssh._NO_PROXY_OPENER, "open", recording_open)
        ref = f"ssh://review-host{files['bam']}"
        assert source.fetch_bytes(ref) == files["bam"].read_bytes()
        size = files["bam"].stat().st_size
        assert len(ranges) == -(-size // 1000) and all(r and r.startswith("bytes=") for r in ranges)

        victim = files["root"] / "victim.txt"
        victim.write_bytes(b"x" * 5000)

        def changing_open(request, *args, **kwargs):
            response = original_open(request, *args, **kwargs)
            if "victim" in getattr(request, "full_url", "") and request.headers.get("Range", "").startswith("bytes=0-"):
                _rewrite(victim, b"y" * 5000)  # rewritten between two ranges
            return response
        monkeypatch.setattr(ssh._NO_PROXY_OPENER, "open", changing_open)
        with pytest.raises(ssh.RemoteFileChanged):
            source.fetch_to_file(f"ssh://review-host{victim}", str(tmp_path / "copy.txt"))
        assert not (tmp_path / "copy.txt").exists()
    finally:
        helper_proc.close()


def test_an_explicit_user_never_borrows_a_connection_of_unknown_account(live_conn, monkeypatch):
    from services.remote_sources.base import NotConnectedError
    import services.remote_sources as registry
    source = registry.get_source("ssh")
    with pytest.raises(NotConnectedError):
        source.connection_for("ssh://alice@review-host/chosen/reads.bam")
    assert not source.is_connected("ssh://alice@review-host/chosen/reads.bam")
    # Once ssh -G says the user-less connection signs in as alice, it's the same account.
    live_conn.default_user = "alice"
    assert source.connection_for("ssh://alice@review-host/chosen/reads.bam") is live_conn
    assert not source.is_connected("ssh://bob@review-host/chosen/reads.bam")


def test_a_user_less_reference_uses_an_explicit_connection_only_for_the_default_account(live_conn, monkeypatch):
    import services.remote_sources as registry
    source = registry.get_source("ssh")
    source._connections.pop(live_conn.target)
    live_conn.user, live_conn.target = "bob", "bob@review-host"
    source._connections[live_conn.target] = live_conn
    monkeypatch.setattr(ssh, "default_user_for", lambda host: "alice")
    assert not source.is_connected("ssh://review-host/chosen/reads.bam")
    monkeypatch.setattr(ssh, "default_user_for", lambda host: "bob")
    assert source.connection_for("ssh://review-host/chosen/reads.bam") is live_conn


def test_ssh_g_user_is_parsed():
    output = "hostname hpc.example.org\nuser alice\nport 22\n"
    assert cmd.parse_config_user(output) == "alice"
    assert cmd.parse_config_user("user -oProxyCommand=x\n") is None
    argv = cmd.config_user_argv("hpc")
    assert argv[-3:] == ["-G", "--", "hpc"]


def test_session_restore_loads_a_cluster_plasmid_map(live_conn, monkeypatch, tmp_path):
    from services.sessions_endpoint import _restore_plasmids
    from routers import genome
    local = tmp_path / "p.gb"
    local.write_text("LOCUS p\n")
    monkeypatch.setattr(live_conn, "stat", lambda path, max_age=15.0: {"type": "file", "size": 8, "mtime": 1})
    monkeypatch.setattr(opening, "local_copy", lambda ref, *a, **k: str(local))
    parsed, loaded = [], []
    monkeypatch.setattr(genome, "parse_plasmid_map", lambda path: parsed.append(path) or SimpleNamespace(name="p"))
    monkeypatch.setattr(genome, "_load_plasmid_into_state", lambda state, plasmid, path: loaded.append(path))
    result = {}
    _restore_plasmids(SimpleNamespace(), ["ssh://review-host/chosen/p.gb"], result)
    assert result.get("plasmids_restored") == ["ssh://review-host/chosen/p.gb"], result
    assert parsed == [str(local)] and loaded == ["ssh://review-host/chosen/p.gb"]
    # Not connected: a clear failure, nothing parsed.
    live_conn.state = "disconnected"
    result = {}
    _restore_plasmids(SimpleNamespace(), ["ssh://review-host/chosen/p.gb"], result)
    assert "Not connected" in result["plasmids_failed"][0]["error"]


def test_a_percent_in_the_control_path_is_passed_literally(tmp_path, monkeypatch):
    if not shutil.which("ssh"):
        pytest.skip("no ssh")
    folder = tmp_path / "c%z"
    folder.mkdir()
    control = str(folder / "cm-0123")
    argv = cmd.check_master_argv("fb-no-such-host.invalid", None, control)
    assert argv[argv.index("-S") + 1] == str(folder).replace("%", "%%") + "/cm-0123"
    result = subprocess.run(argv, capture_output=True, text=True, timeout=15)
    assert "percent_expand" not in result.stderr and "unknown key" not in result.stderr
    assert "c%z" in result.stderr  # ssh looked for the literal path
    start = cmd.start_master_argv("h", None, control, "30m", batch=True)
    assert start[start.index("-S") + 1].count("%%") == 1


def test_releasing_a_cluster_fasta_closes_its_handle(monkeypatch):
    from services import fasta_handles
    from services.remote_sources import opening as op
    fasta_handles.close_all_fasta_handles()
    urls = {"url": "http://127.0.0.1:1/k1/f/ref.fa"}
    opened = []

    class _Handle:
        references, lengths, closed = ("chr1",), (10,), False

        def close(self):
            self.closed = True

        def fetch(self, *a, **k):
            return "ACGT"
    monkeypatch.setattr(op, "resolve_open_path", lambda ref: urls["url"])
    monkeypatch.setattr(op, "open_fasta", lambda ref: opened.append(_Handle()) or opened[-1])
    ref = "ssh://review-host/chosen/ref.fa"
    fasta = fasta_handles.ThreadLocalFasta(ref)
    fasta.fetch("chr1", 0, 4)
    assert len(opened) == 1
    urls["url"] = "http://127.0.0.1:2/k2/f/ref.fa"  # reconnected: a new live URL
    fasta_handles.get_fasta_handle(ref)
    assert len(opened) == 2 and opened[0].closed
    fasta.close()
    assert opened[1].closed and not any(key[0] == 'fasta' for key in fasta_handles.handles._entries)
    # A handle idle past the limit is reopened before use.
    fasta_handles.get_fasta_handle(ref)
    monkeypatch.setattr(op, "REMOTE_HANDLE_MAX_IDLE", -1.0)
    fasta_handles.get_fasta_handle(ref)
    assert len(opened) == 4 and opened[2].closed


def test_an_idle_cluster_bam_handle_is_reopened(monkeypatch):
    from services import bam_handles
    from services.remote_sources import opening as op
    bam_handles.close_all_bam_handles()
    opened = []

    class _Handle:
        closed = False

        def close(self):
            self.closed = True
    monkeypatch.setattr(op, "resolve_open_path", lambda ref: "http://127.0.0.1:1/k/f/a.bam")
    monkeypatch.setattr(op, "open_alignment_file", lambda ref, mode, **kwargs: opened.append(_Handle()) or opened[-1])
    ref = "ssh://review-host/chosen/a.bam"
    first = bam_handles.get_bam_handle(ref)
    assert bam_handles.get_bam_handle(ref) is first
    monkeypatch.setattr(op, "REMOTE_HANDLE_MAX_IDLE", -1.0)
    second = bam_handles.get_bam_handle(ref)
    assert second is not first and first.closed


def test_the_cache_is_pruned_by_age_and_size_but_never_in_use_entries(tmp_path, monkeypatch):
    monkeypatch.setenv(opening.CACHE_ENV, str(tmp_path))
    monkeypatch.setenv(opening.CACHE_MAX_MB_ENV, "1")
    monkeypatch.setattr(opening, "_index_memo", {})
    now = time.time()

    def entry(kind, name, size, age_days):
        folder = tmp_path / kind / name
        folder.mkdir(parents=True)
        (folder / "x").write_bytes(b"\0" * size)
        stamp = now - age_days * 86400
        os.utime(folder / "x", (stamp, stamp))  # an entry's last use is its newest file or folder time
        os.utime(folder, (stamp, stamp))
        return folder
    ancient = entry("index", "ancient", 10, 40)
    old_big = entry("files", "oldbig", 600_000, 3)
    newer_big = entry("files", "newerbig", 600_000, 2)
    in_use = entry("index", "inuse", 900_000, 0)  # used minutes ago: kept even over the ceiling
    memo = entry("index", "memo", 10, 50)
    opening._index_memo["ssh://h/a.bam"] = (now, "v", str(memo / "x"))
    removed = set(opening.prune_cache(force=True, now=now))
    assert str(ancient) in removed and str(old_big) in removed and str(newer_big) in removed
    assert in_use.exists() and memo.exists()



# --------------------------------------------------------------------------
# Second review round
# --------------------------------------------------------------------------

def _run_main_with_root(module, monkeypatch, root, swap):
    """Run the helper's real main() up to server start; ``swap`` hooks the root walk."""
    import io
    original_open = module.os.open

    def hooked_open(path, flags, *args, **kwargs):
        swap(path, kwargs)
        return original_open(path, flags, *args, **kwargs)
    monkeypatch.setattr(module.os, "open", hooked_open)
    monkeypatch.setattr(module.os, "supports_dir_fd", set(module.os.supports_dir_fd) | {hooked_open})
    config = json.dumps({"token": TOKEN, "roots": [str(root)]}).encode() + b"\n"
    monkeypatch.setattr(module.sys, "stdin", SimpleNamespace(buffer=io.BytesIO(config)))
    monkeypatch.setattr(module.signal, "signal", lambda *a: None)

    class _Started(Exception):
        pass

    def started():
        raise _Started
    monkeypatch.setattr(module, "_make_server", started)
    try:
        module.main()
    except _Started:
        return "started"
    except SystemExit as exc:
        return f"exit {exc.code}"
    finally:
        for fd in module.ROOT_FDS.values():
            os.close(fd)


@pytest.mark.parametrize("swap_kind", ["link", "directory"])
def test_root_pinning_never_pins_a_folder_outside_the_chosen_root(tmp_path, monkeypatch, swap_kind):
    module = _load_helper()
    parent = tmp_path / "parent"
    chosen = parent / "selected"
    chosen.mkdir(parents=True)
    (chosen / "f").write_bytes(b"inside")
    outside = tmp_path / "outside"
    (outside / "selected").mkdir(parents=True)
    (outside / "selected" / "f").write_bytes(b"outside-secret")
    swapped = []

    def swap(path, kwargs):
        # The ancestor is swapped while the root is being opened, then put back.
        if not swapped and path == "parent" and "dir_fd" in kwargs:
            parent.rename(tmp_path / "parent-old")
            if swap_kind == "link":
                parent.symlink_to(outside, target_is_directory=True)
            else:
                outside.rename(parent)
            swapped.append(True)
    outcome = _run_main_with_root(module, monkeypatch, os.path.realpath(chosen), swap)
    assert swapped and outcome == "exit 3"  # the root is refused, never the outside folder
    assert module.ROOTS == []


def test_root_pinning_walks_from_the_filesystem_root(tmp_path, monkeypatch):
    module = _load_helper()
    chosen = tmp_path / "a" / "b"
    chosen.mkdir(parents=True)
    seen = []
    outcome = _run_main_with_root(module, monkeypatch, chosen, lambda path, kwargs: seen.append((path, "dir_fd" in kwargs)))
    assert outcome == "started"
    real = os.path.realpath(chosen)
    assert seen[0] == ("/", False)
    assert [name for name, anchored in seen[1:] if anchored] == [p for p in real.split("/") if p]


def test_prune_never_removes_an_entry_handed_out_meanwhile(tmp_path, monkeypatch):
    import pysam
    monkeypatch.setenv(opening.CACHE_ENV, str(tmp_path / "cache"))
    monkeypatch.setenv(opening.CACHE_MAX_MB_ENV, "0")
    monkeypatch.setattr(opening, "_index_memo", {})
    bam = tmp_path / "reads.bam"
    with pysam.AlignmentFile(str(bam), "wb", header={"SQ": [{"SN": "chr1", "LN": 1000}], "HD": {"SO": "coordinate"}}):
        pass
    pysam.index(str(bam))
    bai = Path(str(bam) + ".bai")
    source = SimpleNamespace(stat=lambda *a, **k: {"type": "file", "size": bai.stat().st_size, "version": "stable"},
                             fetch_bytes=lambda *a: bai.read_bytes())
    monkeypatch.setattr(opening, "source_for_ref", lambda ref: source)
    ref = "ssh://h/reads.bam"
    local = opening.cached_index_for(ref)
    opening._index_memo.clear()
    old = time.time() - 4000
    for path in (Path(local), Path(local).parent):
        os.utime(path, (old, old))
    acquired = []
    worker = []

    def during_prune():
        # Another request asks for the index while the prune is choosing.
        thread = threading.Thread(target=lambda: acquired.append(opening.cached_index_for(ref)))
        thread.start()
        worker.append(thread)
        thread.join(0.3)
        assert not acquired  # it waits for the prune instead of racing it
        return 30 * 86400
    monkeypatch.setattr(opening, "_max_cache_age", during_prune)
    opening.prune_cache(force=True)
    worker[0].join(10)
    assert acquired and Path(acquired[0]).exists()
    with pysam.AlignmentFile(str(bam), "rb", index_filename=acquired[0], require_index=True):
        pass


def test_prune_spares_an_entry_being_downloaded(tmp_path, monkeypatch):
    monkeypatch.setenv(opening.CACHE_ENV, str(tmp_path / "cache"))
    monkeypatch.setenv(opening.CACHE_MAX_MB_ENV, "0")
    remote = tmp_path / "p.gb"
    remote.write_bytes(b"map")
    ref = "ssh://review-host/chosen/p.gb"
    pruned = []

    def prune_mid_download(_ref, _count):
        folder = next((tmp_path / "cache" / "files").iterdir())
        old = time.time() - 40 * 86400
        os.utime(folder, (old, old))
        pruned.extend(opening.prune_cache(force=True))
    _versioned_source({ref: str(remote)}, monkeypatch, change_during_fetch=prune_mid_download)
    local = opening.local_copy(ref)
    assert pruned == [] and Path(local).read_bytes() == b"map"


def test_socket_folder_only_under_a_parent_no_one_else_can_change(tmp_path, monkeypatch):
    module = _load_helper()
    unsafe = Path("/tmp") / f"fbr-unsafe-{os.getpid()}"
    unsafe.mkdir(exist_ok=True)
    os.chmod(unsafe, 0o777)  # world-writable and not sticky
    try:
        monkeypatch.setenv("XDG_RUNTIME_DIR", str(unsafe))
        path = module._private_socket_path()
        try:
            assert path is None or not path.startswith(str(unsafe))
        finally:
            module._cleanup()
        assert module._trusted_folder(str(unsafe)) is False
        os.chmod(unsafe, 0o1777)  # sticky, like /tmp
        assert module._trusted_folder(str(unsafe)) is True
        os.chmod(unsafe, 0o700)
        assert module._trusted_folder(str(unsafe)) is True
    finally:
        shutil.rmtree(unsafe, ignore_errors=True)


def test_socket_cleanup_removes_only_the_folder_it_made(tmp_path, monkeypatch):
    import tempfile
    module = _load_helper()
    base = Path(tempfile.mkdtemp(prefix="fbrt-", dir="/tmp"))  # short, 0700, under sticky /tmp
    request_cleanup = lambda: shutil.rmtree(base, ignore_errors=True)  # noqa: E731
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(base))
    path = module._private_socket_path()
    if path is None or not path.startswith(str(base)):
        module._cleanup()
        request_cleanup()
        pytest.skip("/tmp is not a trusted base on this machine")
    folder = Path(path).parent
    moved = folder.with_name(folder.name + "-moved")
    folder.rename(moved)
    folder.mkdir()
    Path(path).write_text("replacement")
    module._cleanup()
    assert Path(path).read_text() == "replacement"  # not ours: left alone
    assert moved.exists()  # ours, moved away: its socket entry is gone, the folder stays
    assert not (moved / "s").exists()
    request_cleanup()


def test_python36_listing_reads_through_a_descriptor_alias_and_stops(helper, monkeypatch, tmp_path):
    monkeypatch.setattr(helper, "_SCANDIR_FD", False)
    fd = helper.ROOT_FDS[os.path.realpath(helper.chosen)]
    alias = tmp_path / f"fd-{fd}"
    alias.symlink_to(os.path.realpath(helper.chosen), target_is_directory=True)
    monkeypatch.setattr(helper, "_FD_ALIASES", (str(tmp_path / "fd-%d"),))
    consumed = [0]

    class _Entry:
        def __init__(self, i):
            self.name = f"n{i:07d}"

    class _Scan:
        def __init__(self, path):
            assert path == str(alias)

        def __iter__(self):
            for i in range(1_000_000):
                consumed[0] += 1
                yield _Entry(i)

        def close(self):
            pass
    monkeypatch.setattr(helper.os, "scandir", _Scan)
    monkeypatch.setattr(helper.os, "listdir", lambda fd: pytest.fail("the whole folder was read"))
    names, stopped = helper._dir_entries(fd, time.monotonic() + 60)
    assert stopped == "scan" and len(names) == helper.MAX_LIST_SCAN and consumed[0] <= helper.MAX_LIST_SCAN + 1
    names, stopped = helper._dir_entries(fd, 0)  # deadline already passed
    assert stopped == "time" and len(names) < 300


def test_python36_listing_of_a_real_folder(helper, monkeypatch, tmp_path):
    monkeypatch.setattr(helper, "_SCANDIR_FD", False)
    fd = helper.ROOT_FDS[os.path.realpath(helper.chosen)]
    (tmp_path / f"fd-{fd}").symlink_to(os.path.realpath(helper.chosen), target_is_directory=True)
    monkeypatch.setattr(helper, "_FD_ALIASES", ("/nonexistent/%d", str(tmp_path / "fd-%d")))
    names, stopped = helper._dir_entries(fd, time.monotonic() + 60)
    assert sorted(names) == ["ok", "sub"] and stopped is None


def test_path_and_range_edge_cases_get_ordinary_refusals(helper):
    for i in range(1100):
        (helper.chosen / f"l{i}").symlink_to(f"l{i + 1}" if i < 1099 else "ok")
    assert helper.open_confined(str(helper.chosen / "l0"), "file") is None
    status, _h, _b = _get(helper, _url(helper.chosen / "l0"))
    assert status == 404
    assert helper.parse_range("bytes=" + "1" * 5000 + "-", 10) == "invalid"
    assert helper.parse_range("bytes=0-" + "9" * 5000, 10) == "invalid"
    status, headers, _b = _get(helper, _url(helper.chosen / "ok"), headers={"Range": " "}, method="HEAD")
    assert status == 416 and headers["content-range"] == "bytes */7"
    status, _h, body = _get(helper, _url(helper.chosen / "ok"))  # no Range at all: the file
    assert (status, body) == (200, b"allowed")


def test_a_registered_bare_secret_is_redacted_everywhere(capsys, caplog):
    import logging
    from services import signed_urls
    secret = "review_secret_" + "Q" * 40
    signed_urls.register_secret(secret, "<token>")
    assert secret not in signed_urls.redact_text("token=" + secret)
    assert secret.encode() not in signed_urls.redact_bytes(json.dumps({"token": secret}).encode())
    print("token", secret, file=sys.stderr)
    assert secret not in capsys.readouterr().err
    signed_urls.install_log_redaction(("fb-test-bare",))
    with caplog.at_level(logging.INFO, logger="fb-test-bare"):
        logging.getLogger("fb-test-bare").info("token %s", secret)
    assert secret not in caplog.text
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    app = FastAPI()
    signed_urls.install_signed_url_redaction(app)

    @app.get("/x")
    def _x():
        return {"token": secret}
    assert secret not in TestClient(app).get("/x").text
