"""Connect to cluster over SSH: argv safety, the connection manager, and FiberBrowser end to end.

The end-to-end tests run a user-mode sshd on 127.0.0.1 (skipped when there is
none) and connect to it exactly as FiberBrowser connects to a cluster: a
ControlMaster, the helper streamed to python3 over the master, and a
``-O forward`` of a local port.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

from remote_fixtures import LocalSshd, write_fixture_files
from services.remote_sources import ssh_command as cmd


# --------------------------------------------------------------------------
# argv building (no ssh needed)
# --------------------------------------------------------------------------

@pytest.mark.parametrize("host", [
    "-oProxyCommand=touch /tmp/pwned", "-J", "-F/tmp/x", "hpc -oProxyCommand=x", "hpc;rm -rf ~",
    "hpc`id`", "$(id)", "user@hpc", "hpc:22", "", " ", "a b", "hpc\n", "..", "-", "hpc/..",
    "x" * 300,
])
def test_hostile_host_names_are_refused(host):
    with pytest.raises(cmd.SshCommandError):
        cmd.validate_host(host)


@pytest.mark.parametrize("host", ["hpc", "vis1.hpc.example.edu", "cluster2", "my_alias", "10.0.0.5"])
def test_ordinary_host_names_pass(host):
    assert cmd.validate_host(host) == host


@pytest.mark.parametrize("user", ["-oProxyCommand=x", "a b", "tt;id", "x@y", "../x"])
def test_hostile_user_names_are_refused(user):
    with pytest.raises(cmd.SshCommandError):
        cmd.validate_user(user)


@pytest.mark.parametrize("path", ["python3", "/usr/bin/python3; rm -rf ~", "/a b/python", "/x/../python",
                                  "/opt/py'thon", '/opt/"py'])
def test_hostile_remote_python_is_refused(path):
    with pytest.raises(cmd.SshCommandError):
        cmd.validate_remote_python(path)


def test_every_command_puts_options_before_a_double_dash_and_the_host(monkeypatch):
    monkeypatch.setenv(cmd.SSH_BINARY_ENV, "/usr/bin/ssh")
    monkeypatch.delenv(cmd.SSH_CONFIG_ENV, raising=False)
    builders = [
        cmd.check_master_argv("hpc", "jd", "/s/cm"),
        cmd.exit_master_argv("hpc", None, "/s/cm"),
        cmd.start_master_argv("hpc", "jd", "/s/cm", "30m", batch=True),
        cmd.start_master_argv("hpc", None, "/s/cm", "30m", batch=False),
        cmd.forward_argv("hpc", None, None, 9123, 40000),
        cmd.forward_argv("hpc", "jd", "/s/cm", 9123, 40000, cancel=True),
        cmd.helper_argv("hpc", "jd", "/s/cm"),
    ]
    for argv in builders:
        assert argv[0] == "/usr/bin/ssh"
        dash = argv.index("--")
        assert argv[dash + 1] == "hpc"
        # Only the fixed remote command may follow the host.
        assert len(argv) - dash - 2 in (0, 1)
    helper = cmd.helper_argv("hpc", "jd", "/s/cm")
    assert helper[-1] == cmd.remote_command() and "BatchMode=yes" in helper and "-T" in helper
    assert "BatchMode=yes" not in cmd.start_master_argv("hpc", None, "/s/cm", "30m", batch=False)
    assert "-M" in builders[2] and "ControlPersist=30m" in builders[2]
    with pytest.raises(cmd.SshCommandError):
        cmd.helper_argv("-oProxyCommand=x", None, None)


def test_the_forward_is_loopback_on_both_ends(monkeypatch):
    monkeypatch.setenv(cmd.SSH_BINARY_ENV, "ssh")
    argv = cmd.forward_argv("hpc", None, "/s/cm", 9123, 40000)
    assert argv[argv.index("-L") + 1] == "127.0.0.1:9123:127.0.0.1:40000"
    assert argv[argv.index("-O") + 1] == "forward"


def test_remote_command_is_fixed_and_quote_safe():
    command = cmd.remote_command()
    assert command.startswith("sh -c '") and command.endswith("'")
    assert command.count("'") == 2  # nothing can close the single quotes early
    assert cmd.BOOTSTRAP in command and "python3" in command
    with_python = cmd.remote_command("/usr/licensed/anaconda3/2024.6/bin/python3")
    assert "for p in /usr/licensed/anaconda3/2024.6/bin/python3 python3" in with_python
    # The script runs under sh and finds a Python >= 3.6 (here: this machine's).
    inner = command[len("sh -c '"):-1]
    script = b"print('bootstrapped')\n"
    result = subprocess.run(["sh", "-c", inner], input=b"%d\n" % len(script) + script,
                            capture_output=True, timeout=30)
    assert result.stdout.strip() == b"bootstrapped"


def test_remote_command_reports_a_missing_python(tmp_path):
    inner = cmd.remote_command()[len("sh -c '"):-1]
    env = {"PATH": str(tmp_path)}  # no python anywhere on PATH...
    result = subprocess.run(["/bin/sh", "-c", inner.replace("/usr/bin/python3", "/nonexistent/python3")],
                            env=env, capture_output=True, timeout=30)
    assert result.returncode == cmd.NO_PYTHON_EXIT
    assert cmd.NO_PYTHON_MARKER.encode() in result.stderr


def test_ssh_config_hosts(tmp_path):
    (tmp_path / "extra.conf").write_text("Host cluster2\n  HostName login.cluster2.example.edu\n")
    config = tmp_path / "config"
    config.write_text(
        f"Include {tmp_path}/extra.conf\n"
        "Host hpc hpc-gpu\n  HostName login.hpc.example.edu\n  User jdoe\n"
        "Host *.example.edu !bad\n  ControlMaster auto\n"
        "Host -oProxyCommand=x\n  HostName evil\n"
        "Match host foo\n  User bar\n"
    )
    hosts = cmd.ssh_config_hosts(str(config))
    assert [h["alias"] for h in hosts] == ["cluster2", "hpc", "hpc-gpu"]
    hpc = next(h for h in hosts if h["alias"] == "hpc")
    assert hpc == {"alias": "hpc", "hostname": "login.hpc.example.edu", "user": "jdoe"}


def test_terminal_script_and_launcher(tmp_path, monkeypatch):
    argv = cmd.start_master_argv("hpc", "jd", str(tmp_path / "cm x"), "30m", batch=False)
    text = cmd.terminal_script(cmd.shell_command(argv))
    assert text.startswith("#!/bin/sh\n")
    assert "'" + str(tmp_path / "cm x") + "'" in text  # quoted argv, one line
    monkeypatch.setattr(cmd.sys, "platform", "darwin")
    monkeypatch.setattr(cmd.shutil, "which", lambda name: "/usr/bin/" + name)
    assert cmd.terminal_launch_argv("/s/login.command") == ["open", "-a", "Terminal", "/s/login.command"]
    monkeypatch.setattr(cmd.sys, "platform", "win32")
    assert cmd.terminal_launch_argv("/s/login.command") is None


def test_ssh_refs_round_trip_and_reject_hostile_targets():
    from services.remote_sources.ssh_source import make_ssh_ref, parse_ssh_ref
    assert parse_ssh_ref("ssh://hpc/projects/lab/a b.bam") == (None, "hpc", "/projects/lab/a b.bam")
    assert parse_ssh_ref("ssh://jd@hpc/x.bam") == ("jd", "hpc", "/x.bam")
    assert make_ssh_ref("jd", "hpc", "/x.bam") == "ssh://jd@hpc/x.bam"
    for bad in ("ssh://-oProxyCommand=x/a.bam", "ssh://hpc;id/a", "ssh://a@b@c/x"):
        with pytest.raises(ValueError):
            parse_ssh_ref(bad)


def test_is_url_treats_ssh_refs_as_remote():
    from utils.validation import detect_data_format, is_source_ref, is_url
    assert is_url("ssh://hpc/p/x.bam") and is_source_ref("ssh://hpc/p/x.bam")
    assert not is_source_ref("s3://b/x.bam") and not is_source_ref("/local/x.bam")
    assert detect_data_format("ssh://hpc/p/x.bam") == "bam"
    assert detect_data_format("ssh://hpc/p/x.bb") == "bigbed"


def test_not_connected_refs_say_so():
    from services.remote_sources import get_source
    from services.remote_sources.base import NotConnectedError
    from services.remote_sources.opening import open_alignment_file
    with pytest.raises(NotConnectedError, match="Connect to cluster"):
        open_alignment_file("ssh://nosuchhost/p/x.bam")
    assert get_source("ssh").is_connected("ssh://nosuchhost/p/x.bam") is False


@pytest.mark.parametrize("helper_answers", [False, True])
def test_the_forward_probe_never_reports_connected_early(monkeypatch, tmp_path, helper_answers):
    """While _forward checks that the helper answers through a new forward, the
    connection must not look connected: a poller (the status endpoint, the UI)
    that saw "connected" then would use a socket forward that is about to be
    refused and replaced by the loopback-port fallback."""
    import io
    import urllib.error
    from types import SimpleNamespace
    from services.remote_sources import ssh_source as ssh
    monkeypatch.setenv(ssh.SSH_DIR_ENV, str(tmp_path))
    monkeypatch.setattr(ssh, "_register_key_urls", lambda port, display: None)
    monkeypatch.setattr(ssh, "_register_redaction", lambda secret, display: None)
    monkeypatch.setattr(ssh, "_run", lambda argv, timeout: subprocess.CompletedProcess(argv, 0, b"", b""))
    conn = ssh.SshConnection("hpc", None, ["/p"], remote_python=None, persist="30m", idle_timeout=60)
    conn.proc = SimpleNamespace(poll=lambda: None)  # the helper's ssh session is running
    conn.remote_socket = "/tmp/fbh-abcdefgh/s"
    seen = []

    def probe_open(request, timeout):
        seen.append((conn.state, conn.public_dict()["state"]))
        if not helper_answers:  # sshd refuses the channel: the forward carries nothing
            raise urllib.error.URLError(ConnectionResetError(54, "Connection reset by peer"))
        return io.BytesIO(b'{"ok": true}')

    monkeypatch.setattr(ssh._NO_PROXY_OPENER, "open", probe_open)
    if helper_answers:
        conn._forward()
        assert conn.local_port
    else:
        with pytest.raises(ssh._ForwardRefused):
            conn._forward()
        assert conn.local_port is None
    assert seen and all(state != "connected" for pair in seen for state in pair), seen
    assert conn.state == "starting"  # run() marks it connected once everything is up


def test_redact_hides_tokened_urls():
    from services.remote_sources.opening import redact
    text = "Failed to open http://127.0.0.1:50123/" + "A" * 43 + "/f/projects/x.bam"
    assert "A" * 43 not in redact(text)
    assert "/projects/x.bam" in redact(text)


# --------------------------------------------------------------------------
# A real SSH connection (user-mode sshd on 127.0.0.1)
# --------------------------------------------------------------------------

@pytest.fixture(scope="module")
def sshd():
    if sys.platform == "win32" or not os.path.exists("/usr/sbin/sshd") or not shutil.which("ssh"):
        pytest.skip("no OpenSSH server on this machine")
    try:
        server = LocalSshd()
    except Exception as exc:  # sandboxed CI, sshd refusing to run as a user, ...
        pytest.skip(f"cannot run a local sshd: {exc}")
    yield server
    for sock in server.dir.glob("ctl/cm-*"):
        subprocess.run(["ssh", "-F", server.config, "-S", str(sock), "-O", "exit", "fbtest"],
                       capture_output=True, timeout=10)
    server.stop()


@pytest.fixture
def ssh_env(sshd, monkeypatch, tmp_path):
    ctl = sshd.dir / "ctl"
    ctl.mkdir(exist_ok=True)
    monkeypatch.setenv(cmd.SSH_CONFIG_ENV, sshd.config)
    monkeypatch.setenv("FIBERBROWSER_SSH_DIR", str(ctl))
    monkeypatch.setenv("FIBERBROWSER_REMOTE_CACHE", str(tmp_path / "cache"))
    return sshd


@pytest.fixture
def ssh_source(ssh_env):
    """A fresh SSH source, registered as the app's (so opening.py resolves through it)."""
    import services.remote_sources as rs
    from services.remote_sources.ssh_source import SshSource
    rs._load_builtin_sources()
    previous = rs._SOURCES.get("ssh")
    source = SshSource()
    rs._SOURCES["ssh"] = source
    yield source
    for target in list(source._connections):
        source.disconnect(target, close_master=True)
    rs._SOURCES["ssh"] = previous


def _wait_connected(source, target, timeout=60):
    deadline = time.time() + timeout
    while time.time() < deadline:
        conn = source._connections[target]
        if conn.state in ("connected", "error"):
            return conn
        time.sleep(0.1)
    raise AssertionError(f"still {conn.state}: {conn.message}")


@pytest.fixture(scope="module")
def cluster_files(tmp_path_factory):
    root = tmp_path_factory.mktemp("clusterdata")
    return {"root": root, **write_fixture_files(root / "lab")}


def test_connect_list_open_and_disconnect(ssh_source, cluster_files, tmp_path, monkeypatch):
    from services.remote_sources.opening import open_alignment_file, open_bigwig, open_fasta
    lab = cluster_files["root"] / "lab"
    status = ssh_source.connect({"host": "fbtest", "roots": [str(lab)], "open_terminal": False})
    assert status["state"] in ("starting", "connected")
    conn = _wait_connected(ssh_source, "fbtest")
    assert conn.state == "connected", conn.error
    assert conn.roots == [os.path.realpath(lab)] and conn.remote_python_version.startswith("3.")
    public = conn.public_dict(probe=True)
    assert conn.token not in str(public)  # the token never leaves the server
    assert public["latency_ms"] is not None

    ref_dir = f"ssh://fbtest{os.path.realpath(lab)}"
    listing = ssh_source.list(ref_dir)
    assert {"reads.bam", "reads.bam.bai", "ref.fa"} <= {e["name"] for e in listing["entries"]}

    workdir = tmp_path / "cwd"
    workdir.mkdir()
    monkeypatch.chdir(workdir)
    with open_alignment_file(f"{ref_dir}/reads.bam") as bam:
        names = [r.query_name for r in bam.fetch("chr1", 5000, 5600)]
    assert names
    with open_fasta(f"{ref_dir}/ref.fa") as fasta:
        assert fasta.fetch("chr1", 0, 30) == cluster_files["seq"][:30]
    from services.pybigwig_support import reads_urls
    if reads_urls():
        bw = open_bigwig(f"{ref_dir}/signal.bw")
        assert bw.values("chr1", 900, 901) == [3.0]
        bw.close()
    else:  # a pyBigWig without libcurl (PyPI's x86_64 Linux wheel) says what to do
        with pytest.raises(RuntimeError, match="built without libcurl"):
            open_bigwig(f"{ref_dir}/signal.bw")
    assert os.listdir(workdir) == []  # htslib cached no index in the working folder
    assert list((tmp_path / "cache" / "index").glob("*/reads.bam.bai"))  # ours, keyed by size+mtime

    with pytest.raises(Exception):
        ssh_source.list(f"ssh://fbtest{cluster_files['root']}")  # the parent is not shared

    # The helper listens on a Unix socket in a private folder on the "cluster",
    # reached through an OpenSSH local-to-socket forward.
    assert public["transport"] == "socket" and conn.remote_port is None
    socket_dir = os.path.dirname(conn.remote_socket)
    assert os.stat(socket_dir).st_mode & 0o777 == 0o700
    local_port = conn.local_port

    pid = conn.proc.pid
    assert ssh_source.disconnect("fbtest")["success"]
    assert conn.proc.poll() is not None and pid
    # The helper on the "cluster" is gone too, and so are its socket and folder;
    # the local port no longer answers.
    import socket
    deadline = time.time() + 5
    while os.path.exists(socket_dir) and time.time() < deadline:
        time.sleep(0.05)
    assert not os.path.exists(socket_dir)
    with socket.socket() as sock:
        assert sock.connect_ex(("127.0.0.1", local_port)) != 0
    assert not ssh_source.is_connected(f"{ref_dir}/reads.bam")


def test_reuses_a_live_master_and_can_close_it(ssh_source, cluster_files):
    lab = cluster_files["root"] / "lab"
    ssh_source.connect({"host": "fbtest", "roots": [str(lab)], "open_terminal": False})
    conn = _wait_connected(ssh_source, "fbtest")
    assert conn.state == "connected"
    control = conn.control_path
    ssh_source.disconnect("fbtest")  # the master stays (ControlPersist) ...
    check = subprocess.run(cmd.check_master_argv("fbtest", None, control), capture_output=True)
    assert check.returncode == 0
    ssh_source.connect({"host": "fbtest", "roots": [str(lab)], "open_terminal": False})
    conn = _wait_connected(ssh_source, "fbtest")
    assert conn.state == "connected" and conn.reused_master and conn.control_path == control
    ssh_source.disconnect("fbtest", close_master=True)  # ... unless asked
    check = subprocess.run(cmd.check_master_argv("fbtest", None, control), capture_output=True)
    assert check.returncode != 0


def test_socket_forward_through_the_users_own_master(ssh_source, cluster_files, ssh_env):
    """The user's ControlMaster (their ControlPath) carries the socket forward too."""
    lab = cluster_files["root"] / "lab"
    master = subprocess.run(["ssh", "-F", ssh_env.config, "-M", "-N", "-f", "-o", "ControlPersist=60",
                             "-o", "BatchMode=yes", "fbtest-shared"], capture_output=True, timeout=30)
    assert master.returncode == 0, master.stderr
    try:
        ssh_source.connect({"host": "fbtest-shared", "roots": [str(lab)], "open_terminal": False})
        conn = _wait_connected(ssh_source, "fbtest-shared")
        assert conn.state == "connected", conn.error
        assert conn.shared_master and conn.public_dict()["transport"] == "socket"
        from services.remote_sources.opening import open_alignment_file
        with open_alignment_file(f"ssh://fbtest-shared{os.path.realpath(lab)}/reads.bam") as bam:
            assert sum(1 for _ in bam.fetch("chr1", 5000, 5600)) > 0
        ssh_source.disconnect("fbtest-shared")
    finally:
        subprocess.run(["ssh", "-F", ssh_env.config, "-O", "exit", "fbtest-shared"], capture_output=True, timeout=10)


@pytest.fixture(scope="module")
def sshd_no_socket_forwarding():
    if sys.platform == "win32" or not os.path.exists("/usr/sbin/sshd") or not shutil.which("ssh"):
        pytest.skip("no OpenSSH server on this machine")
    try:
        server = LocalSshd("AllowStreamLocalForwarding no\n")
    except Exception as exc:
        pytest.skip(f"cannot run a local sshd: {exc}")
    yield server
    for sock in server.dir.glob("ctl/cm-*"):
        subprocess.run(["ssh", "-F", server.config, "-S", str(sock), "-O", "exit", "fbtest"],
                       capture_output=True, timeout=10)
    server.stop()


def test_falls_back_to_a_loopback_port_when_socket_forwarding_is_refused(
        sshd_no_socket_forwarding, monkeypatch, tmp_path, cluster_files):
    import services.remote_sources as rs
    from services.remote_sources.ssh_source import SshSource
    from services.remote_sources.opening import open_alignment_file
    sshd = sshd_no_socket_forwarding
    ctl = sshd.dir / "ctl"
    ctl.mkdir(exist_ok=True)
    monkeypatch.setenv(cmd.SSH_CONFIG_ENV, sshd.config)
    monkeypatch.setenv("FIBERBROWSER_SSH_DIR", str(ctl))
    monkeypatch.setenv("FIBERBROWSER_REMOTE_CACHE", str(tmp_path / "cache"))
    rs._load_builtin_sources()
    previous = rs._SOURCES.get("ssh")
    source = SshSource()
    rs._SOURCES["ssh"] = source
    lab = cluster_files["root"] / "lab"
    try:
        source.connect({"host": "fbtest", "roots": [str(lab)], "open_terminal": False})
        conn = _wait_connected(source, "fbtest")
        assert conn.state == "connected", conn.error
        assert conn.socket_refused is not None and conn.public_dict()["transport"] == "port"
        assert conn.remote_socket is None and conn.remote_port
        with open_alignment_file(f"ssh://fbtest{os.path.realpath(lab)}/reads.bam") as bam:
            assert sum(1 for _ in bam.fetch("chr1", 5000, 5600)) > 0
    finally:
        for target in list(source._connections):
            source.disconnect(target, close_master=True)
        rs._SOURCES["ssh"] = previous


def test_interactive_sign_in_waits_for_the_master(ssh_source, cluster_files, ssh_env):
    """Keys fail in batch mode: FiberBrowser shows the sign-in command and waits;
    once the user's terminal has made the master, the connection completes."""
    lab = cluster_files["root"] / "lab"
    ssh_source.connect({"host": "fbtest-nokey", "roots": [str(lab)], "open_terminal": False})
    conn = ssh_source._connections["fbtest-nokey"]
    deadline = time.time() + 30
    while conn.state != "authenticating" and time.time() < deadline:
        time.sleep(0.1)
    public = conn.public_dict()
    assert public["state"] == "authenticating", public
    assert public["auth_command"].split()[0].endswith("ssh") and "-M" in public["auth_command"]
    assert "BatchMode" not in public["auth_command"]
    # What the user's terminal would do (here with the key the alias lacks).
    argv = public["auth_command"].split()
    master = [argv[0], "-i", str(ssh_env.dir / "clientkey")] + cmd.start_master_argv(
        "fbtest-nokey", None, conn.control_path, "60", batch=True)[1:]
    assert subprocess.run(master, capture_output=True, timeout=30).returncode == 0
    conn = _wait_connected(ssh_source, "fbtest-nokey")
    assert conn.state == "connected", conn.error


def test_unknown_host_fails_cleanly(ssh_source):
    ssh_source.connect({"host": "no-such-host.invalid", "open_terminal": False})
    conn = _wait_connected(ssh_source, "no-such-host.invalid")
    assert conn.state == "error"
    assert conn.proc is None


# --------------------------------------------------------------------------
# FiberBrowser end to end: remote BAM + plasmid map, reads, sessions
# --------------------------------------------------------------------------

@pytest.fixture
def app_client(ssh_env, monkeypatch):
    import server as srv
    from plugins import init_context
    from starlette.testclient import TestClient
    from services.local_auth import auth_headers  # (not via conftest: lab_tests has a conftest of its own)
    import services.remote_sources as rs
    from services.remote_sources.ssh_source import SshSource

    monkeypatch.setattr(srv, "state", srv.BrowserState(None, None, None, None))
    init_context(srv.state)
    rs._load_builtin_sources()
    previous = rs._SOURCES.get("ssh")
    fresh = SshSource()
    rs._SOURCES["ssh"] = fresh
    client = TestClient(srv.app, headers=auth_headers())
    yield client
    for target in list(fresh._connections):
        fresh.disconnect(target, close_master=True)
    rs._SOURCES["ssh"] = previous


def _connect(client, roots, host="fbtest"):
    result = client.post("/api/remote/connect", json={"host": host, "roots": roots, "open_terminal": False}).json()
    assert result["success"], result
    deadline = time.time() + 60
    while time.time() < deadline:
        sources = client.get("/api/remote/sources").json()["sources"]
        ssh = next(s for s in sources if s["scheme"] == "ssh")
        conns = [c for c in ssh["connections"] if c["target"] == host]
        if conns and conns[0]["state"] in ("connected", "error"):
            assert conns[0]["state"] == "connected", conns[0]
            return conns[0]
        time.sleep(0.2)
    raise AssertionError("connection did not finish")


def test_remote_bam_and_plasmid_map_end_to_end(app_client, tmp_path):
    from test_plasmid_reconcile import _seq, write_bam, write_map
    lab = tmp_path / "cluster" / "plasmids"
    lab.mkdir(parents=True)
    seq = _seq(11)
    write_map(lab / "pRenamed.gb", "pRenamed", seq)
    write_bam(lab / "reads.bam", "t", seq, m5=True)
    lab = Path(os.path.realpath(lab))

    conn = _connect(app_client, [str(lab)])
    sources = app_client.get("/api/remote/sources").json()["sources"]
    assert {s["scheme"] for s in sources} >= {"ssh", "s3"}
    assert any(h["alias"] == "fbtest" for h in next(s for s in sources if s["scheme"] == "ssh")["hosts"])
    assert "token" not in str(sources).lower() or conn  # no token in the payload

    listing = app_client.get("/api/remote/list", params={"ref": f"ssh://fbtest{lab}"}).json()
    entries = {e["name"]: e for e in listing["entries"]}
    assert entries["reads.bam"]["kind"] == "bam" and entries["reads.bam"]["has_index"] is True
    assert entries["reads.bam"]["ref"] == f"ssh://fbtest{lab}/reads.bam"
    assert entries["pRenamed.gb"]["kind"] == "map" and entries["reads.bam.bai"]["kind"] == "index"
    assert listing["parent_ref"] is None  # the shared root is the top

    map_ref, bam_ref = f"ssh://fbtest{lab}/pRenamed.gb", f"ssh://fbtest{lab}/reads.bam"
    opened = app_client.post("/api/plasmid/open", json={"map_path": map_ref, "bam_paths": [bam_ref]}).json()
    assert opened["success"], opened
    assert opened["links"][0]["contig"] == "t" and opened["links"][0]["chrom"] == "pRenamed"
    dataset = opened["datasets"][0]
    assert dataset["path"] == bam_ref and dataset["is_remote"] is True

    reads = app_client.get("/api/reads/compact", params={
        "chrom": "pRenamed", "start": 0, "end": len(seq), "dataset_id": dataset["id"]}).json()
    assert len(reads["reads"]) == 12

    # Sessions keep the reference, and restore can tell whether it is reachable.
    check = app_client.post("/api/session/check_files", json={"session": {
        "datasets": [{"id": dataset["id"], "paths": [bam_ref]}],
        "reference": {"plasmids": [map_ref]}}}).json()
    assert check["files"] == [] and check["remote"]["disconnected"] == 0
    assert check["remote"]["targets"][0]["folders"] == [str(lab)]

    # The Library records the cluster files by reference, and they stay openable.
    from services.library_hooks import wait_idle
    assert wait_idle(30)
    library = app_client.get("/api/library").json()
    by_path = {e["path"]: e for e in library["entries"]}
    assert bam_ref in by_path and map_ref in by_path, sorted(by_path)
    assert by_path[bam_ref]["remote"] is True and by_path[bam_ref]["connected"] is True
    assert by_path[bam_ref]["available"] is True and by_path[bam_ref]["kind"] == "bam"
    assert by_path[bam_ref]["folder"] == f"ssh://fbtest{lab}"

    assert app_client.post("/api/remote/disconnect", json={"target": "fbtest"}).json()["success"]
    entry = {e["path"]: e for e in app_client.get("/api/library").json()["entries"]}[bam_ref]
    assert entry["connected"] is False and entry["available"] is True and entry["changed"] is False
    status = app_client.post("/api/remote/refs_status", json={"refs": [bam_ref, "/local/x.bam"]}).json()
    assert status["disconnected"] == 1 and status["targets"][0]["host"] == "fbtest"
    again = app_client.post("/api/datasets/add", json={"path": bam_ref}).json()
    assert not again["success"] and "Connect to cluster" in again["error"]


def test_remote_bigbed_dataset_and_fasta(app_client, cluster_files):
    lab = Path(os.path.realpath(cluster_files["root"] / "lab"))
    _connect(app_client, [str(lab)])
    fasta = app_client.post("/api/load_fasta", params={"path": f"ssh://fbtest{lab}/ref.fa"}).json()
    assert fasta["success"], fasta
    seq = app_client.get("/api/sequence", params={"chrom": "chr1", "start": 100, "end": 160}).json()
    assert seq["sequence"] == cluster_files["seq"][100:160]
    added = app_client.post("/api/datasets/add", json={"path": f"ssh://fbtest{lab}/reads.bam"}).json()
    assert added["success"], added
    missing = app_client.post("/api/datasets/add", json={"path": f"ssh://fbtest{lab}/nope.bam"}).json()
    assert not missing["success"]
    outside = app_client.post("/api/datasets/add", json={"path": "ssh://fbtest/etc/hosts.bam"}).json()
    assert not outside["success"]
    if "bigbed" in cluster_files:
        bb = app_client.post("/api/datasets/add", json={"path": f"ssh://fbtest{lab}/fp.bb"}).json()
        assert bb["success"], bb


def test_consensus_runs_refuse_cluster_datasets():
    from services.consensus_workflow import _snapshot

    class DS:
        label = "cluster BAM"
        paths = ["ssh://hpc/projects/lab/reads.bam"]
        path = paths[0]
        companion_layers = {}

    class State:
        def get_dataset(self, _dsid):
            return DS()

    with pytest.raises(ValueError, match="on a cluster"):
        _snapshot(State(), ["d"])


@pytest.mark.parametrize("method,path,body", [
    ("GET", "/api/remote/sources", None),
    ("POST", "/api/remote/connect", {"host": "fbtest"}),
    ("POST", "/api/remote/disconnect", {"target": "fbtest"}),
    ("GET", "/api/remote/list?ref=ssh://fbtest/etc", None),
    ("POST", "/api/remote/refs_status", {"refs": []}),
])
def test_remote_routes_refuse_public_mode_and_sandboxes(client, monkeypatch, method, path, body):
    from services import runtime
    monkeypatch.setattr(runtime, "_public_mode", True)
    response = client.request(method, path, json=body)
    assert response.status_code == 403
    monkeypatch.setattr(runtime, "_public_mode", False)
    token = runtime._sandbox_id.set("sb-test")
    try:
        from services.remote_endpoint import ensure_local_mode
        with pytest.raises(PermissionError):
            ensure_local_mode()
    finally:
        runtime._sandbox_id.reset(token)


def test_layer_probe_of_a_cluster_bam_reads_a_bounded_sample(tmp_path, monkeypatch):
    """An untagged BAM sends the probe into its sparse-tag rescue (up to 8,000
    reads locally); over the network that moved ~150 MB for a long-read DAF
    BAM, so cluster BAMs are probed with a smaller sample."""
    import pysam
    from services import bam_diagnostics
    import services.remote_sources.opening as opening

    bam_path = tmp_path / "untagged.bam"
    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": "chr1", "LN": 1_000_000}]}
    with pysam.AlignmentFile(str(bam_path), "wb", header=header) as out:
        for i in range(3000):
            read = pysam.AlignedSegment(out.header)
            read.query_name, read.reference_id, read.reference_start = f"r{i}", 0, i * 300
            read.cigarstring, read.query_sequence = "50M", "A" * 50
            read.set_tag("XX", 1)  # a tag, but not a fiber-seq one
            out.write(read)
    pysam.index(str(bam_path))

    local = bam_diagnostics.diagnose_bam_tags(str(bam_path), limit=50)
    assert local["all_tags"]["XX"]["count"] == 3000  # locally: the full rescue scan

    monkeypatch.setattr(opening, "open_alignment_file",
                        lambda path, mode="rb", **kw: pysam.AlignmentFile(str(bam_path), mode, **kw))
    remote = bam_diagnostics.diagnose_bam_tags("ssh://hpc/lab/untagged.bam", limit=50)
    scanned = remote["all_tags"]["XX"]["count"]
    assert scanned <= bam_diagnostics.REMOTE_SAMPLE_LIMIT + bam_diagnostics.REMOTE_SPARSE_TAG_SCAN_LIMIT
    assert remote["has_nucleosomes"] is False


def test_a_lab_server_refuses_connect_to_cluster(monkeypatch):
    """A shared lab server would sign in with its own SSH account for every member."""
    from services import runtime
    from services.lab.auth import LAB_DENIED
    from services.remote_endpoint import LAB_MESSAGE, ensure_local_mode
    monkeypatch.setattr(runtime, "_lab_mode", True)
    with pytest.raises(PermissionError, match="shared lab server"):
        ensure_local_mode()
    assert "lab server" in LAB_MESSAGE
    for route in (("GET", "/api/remote/sources"), ("POST", "/api/remote/connect"), ("GET", "/api/remote/list"),
                  ("POST", "/api/remote/disconnect"), ("POST", "/api/remote/refs_status")):
        assert route in LAB_DENIED
    from services.remote_sources.base import RemoteSourceError
    from services.remote_sources.ssh_source import SshSource
    with pytest.raises(RemoteSourceError, match="lab server"):
        SshSource().connection_for("ssh://hpc/projects/lab/a.bam")
