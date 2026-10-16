"""Fixtures for the Connect to cluster tests: the helper as a local subprocess,
a user-mode sshd on 127.0.0.1, and small BAM / BigBed / FASTA / map files."""
from __future__ import annotations

import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import pysam

BROWSER = Path(__file__).resolve().parents[1] / "browser"
HELPER = BROWSER / "services" / "remote_sources" / "remote_helper.py"
BOOTSTRAP = "import sys;exec(sys.stdin.buffer.read(int(sys.stdin.buffer.readline())))"


class HelperProcess:
    """remote_helper.py run exactly as ssh runs it: bootstrap + script + config on stdin."""

    def __init__(self, roots, *, idle_timeout=0, token=None, python=sys.executable, listen="tcp"):
        self.token = token or secrets.token_urlsafe(32)
        self.proc = subprocess.Popen([python, "-u", "-c", BOOTSTRAP], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        script = HELPER.read_bytes()
        config = {"token": self.token, "roots": [str(r) for r in roots], "idle_timeout": idle_timeout,
                  "listen": listen}
        self.proc.stdin.write(b"%d\n" % len(script) + script + json.dumps(config).encode() + b"\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline().decode()
        if not line.startswith("FBHELPER_READY "):
            err = self.proc.stderr.read().decode() if self.proc.poll() is not None else ""
            raise RuntimeError(f"helper did not start: {line!r} {err}")
        self.info = json.loads(line[len("FBHELPER_READY "):])
        self.port = self.info["port"]
        self.socket = self.info.get("socket")
        self.base = f"http://127.0.0.1:{self.port}/{self.token}"

    def url(self, path: str) -> str:
        from urllib.parse import quote
        return f"{self.base}/f{quote(str(path), safe='/')}"

    def key_url(self, path: str) -> str:
        """The URL FiberBrowser hands htslib: a per-file key, not the token."""
        from urllib.parse import quote
        from services.remote_sources.ssh_source import file_key
        return f"http://127.0.0.1:{self.port}/{file_key(self.token, str(path))}/f{quote(str(path), safe='/')}"

    def close(self):
        try:
            self.proc.stdin.close()
        except OSError:
            pass
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()


def http(method: str, url: str, headers=None):
    """(status, headers, body) without following anything or using proxies."""
    import http.client
    from urllib.parse import urlsplit
    parts = urlsplit(url)
    conn = http.client.HTTPConnection(parts.hostname, parts.port, timeout=10)
    path = parts.path + (f"?{parts.query}" if parts.query else "")
    conn.request(method, path, headers=headers or {})
    resp = conn.getresponse()
    body = resp.read()
    conn.close()
    return resp.status, {k.lower(): v for k, v in resp.getheaders()}, body


def unix_http(socket_path: str, method: str, target: str, headers=None):
    """(status, headers, body) of one request over a Unix socket."""
    import http.client

    class _Conn(http.client.HTTPConnection):
        def connect(self):
            self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.sock.settimeout(10)
            self.sock.connect(socket_path)

    conn = _Conn("localhost", timeout=10)
    conn.request(method, target, headers=headers or {})
    resp = conn.getresponse()
    body = resp.read()
    conn.close()
    return resp.status, {k.lower(): v for k, v in resp.getheaders()}, body


def write_fixture_files(folder: Path) -> dict:
    """Indexed BAM (+ plasmid contig), FASTA + .fai, a BigWig and (when bedToBigBed exists) a BigBed."""
    import random
    folder.mkdir(parents=True, exist_ok=True)
    rng = random.Random(3)
    seq = "".join(rng.choice("ACGT") for _ in range(20_000))
    fasta = folder / "ref.fa"
    fasta.write_text(">chr1\n" + "\n".join(seq[i:i + 60] for i in range(0, len(seq), 60)) + "\n")
    pysam.faidx(str(fasta))
    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": "chr1", "LN": len(seq)}]}
    bam = folder / "reads.bam"
    with pysam.AlignmentFile(str(bam), "wb", header=header) as out:
        for i in range(300):
            read = pysam.AlignedSegment(out.header)
            read.query_name = f"r{i}"
            read.reference_id = 0
            read.reference_start = i * 50
            read.cigarstring = "300M"
            read.query_sequence = seq[i * 50:i * 50 + 300]
            read.query_qualities = pysam.qualitystring_to_array("I" * 300)
            read.mapping_quality = 60
            out.write(read)
    pysam.index(str(bam))
    import pyBigWig
    bw_path = folder / "signal.bw"
    bw = pyBigWig.open(str(bw_path), "w")
    bw.addHeader([("chr1", len(seq))])
    bw.addEntries(["chr1"] * 3, [100, 500, 900], ends=[200, 600, 1000], values=[1.0, 2.0, 3.0])
    bw.close()
    files = {"bam": bam, "fasta": fasta, "bigwig": bw_path, "seq": seq}
    tool = shutil.which("bedToBigBed") or next(
        (p for p in (os.path.expanduser("~/ucsc_tools/bedToBigBed"),) if os.path.isfile(p)), None)
    if tool:
        bed = folder / "fp.bed"
        bed.write_text("chr1\t100\t200\tfp1\t0\t+\nchr1\t5000\t5400\tfp2\t0\t-\n")
        sizes = folder / "chrom.sizes"
        sizes.write_text(f"chr1\t{len(seq)}\n")
        bb = folder / "fp.bb"
        subprocess.run([tool, str(bed), str(sizes), str(bb)], check=True, capture_output=True)
        files["bigbed"] = bb
    return files


def _free_port(lo=9150, hi=9199) -> int:
    for port in range(lo, hi):
        with socket.socket() as sock:
            try:
                sock.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    raise RuntimeError("no free port in 9150-9199")


class LocalSshd:
    """A user-mode OpenSSH server on 127.0.0.1 (key login as the current user)."""

    def __init__(self, extra_config: str = ""):
        # Short paths: ssh control sockets live under this folder too.
        self.dir = Path(tempfile.mkdtemp(prefix="fbs"))
        d = self.dir
        for name in ("hostkey", "clientkey"):
            subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(d / name)], check=True)
        shutil.copy(d / "clientkey.pub", d / "authorized_keys")
        os.chmod(d / "authorized_keys", 0o600)
        self.port = _free_port()
        (d / "sshd_config").write_text(
            f"Port {self.port}\nListenAddress 127.0.0.1\nHostKey {d}/hostkey\n"
            f"AuthorizedKeysFile {d}/authorized_keys\nPasswordAuthentication no\n"
            "KbdInteractiveAuthentication no\nUsePAM no\nStrictModes no\nAllowTcpForwarding yes\n"
            f"PidFile {d}/sshd.pid\n" + extra_config
        )
        common = (f"  HostName 127.0.0.1\n  Port {self.port}\n  IdentitiesOnly yes\n"
                  f"  UserKnownHostsFile {d}/known_hosts\n  StrictHostKeyChecking no\n  LogLevel ERROR\n")
        (d / "ssh_config").write_text(
            f"Host fbtest\n{common}  IdentityFile {d}/clientkey\n\n"
            f"Host fbtest-nokey\n{common}  IdentityFile {d}/missingkey\n\n"
            # The user's own ControlMaster (ControlPath in their ssh config).
            f"Host fbtest-shared\n{common}  IdentityFile {d}/clientkey\n  ControlPath {d}/um\n\n"
            "Host *.wild\n  User nobody\n"
        )
        self.proc = subprocess.Popen(["/usr/sbin/sshd", "-D", "-e", "-f", str(d / "sshd_config")],
                                     stdout=subprocess.DEVNULL, stderr=open(d / "sshd.log", "wb"))
        deadline = time.time() + 10
        while time.time() < deadline:
            with socket.socket() as sock:
                if sock.connect_ex(("127.0.0.1", self.port)) == 0:
                    break
            time.sleep(0.1)
        ok = subprocess.run(["ssh", "-F", str(d / "ssh_config"), "-o", "BatchMode=yes", "fbtest", "true"],
                            capture_output=True, timeout=20)
        if ok.returncode != 0:
            self.stop()
            raise RuntimeError(f"local sshd unusable: {ok.stderr.decode()[-300:]}")

    @property
    def config(self) -> str:
        return str(self.dir / "ssh_config")

    def stop(self):
        self.proc.terminate()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        shutil.rmtree(self.dir, ignore_errors=True)
