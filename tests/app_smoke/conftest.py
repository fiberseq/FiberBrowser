"""Packaged-app smoke tests (opt-in, marker ``app_smoke``).

These drive a built FiberBrowser.app the way the 3.0.7, 3.0.8 and 3.1.0 release smokes did by hand: the app is opened
headless (``open -n … --args --serve``) with its own scratch HOME, a dead proxy and a loopback port, and checked over
its HTTP API. They never touch the real ``~/.fiberhmm``.

Run them on a Mac against the app to release:

    FIBERBROWSER_APP_SMOKE_APP=/path/to/FiberBrowser.app \\
    FIBERBROWSER_APP_SMOKE_VERSION=3.1.1 \\            # optional: the app version expected
    FIBERBROWSER_APP_SMOKE_FIBERHMM_MIN=3.2.0 \\       # optional: the bundled FiberHMM must be at least this
    FIBERBROWSER_APP_SMOKE_PORT=18940 \\               # optional: a free loopback port (default: any free port)
    FIBERBROWSER_APP_SMOKE_ROOT=/path/to/scratch \\     # optional: where the scratch HOMEs and logs go (default: TMPDIR)
    python -m pytest tests/app_smoke -m app_smoke -v

The browser-driven tests (test_packaged_app_ui.py) also need node and the frontend's Playwright
(browser/frontend/node_modules, ``npm ci`` there, and ``npx playwright install chromium webkit``); without them they
skip. Their optional inputs (a graph package, the network) are described in that file.

Without FIBERBROWSER_APP_SMOKE_APP every test here is skipped. Use a copy of the app (``ditto``), not the one in
/Applications, so the smoke can't change what is installed.

Clean-machine mode (FIBERBROWSER_APP_SMOKE_CLEAN_MACHINE=1) runs every test as on a Mac that is not the build Mac: the
app's server runs under ``sandbox-exec`` with a profile that makes the builder's home folder, Homebrew (/opt/homebrew,
/usr/local), MacPorts, the developer tools, Java, /Library/Frameworks, /Library/Fonts and /Applications (all but
Safari) unreadable, with a minimal PATH and none of SSL_CERT_FILE, REQUESTS_CA_BUNDLE, CURL_CA_BUNDLE, PYTHONPATH or
conda's variables. ``open -n`` can't carry a sandbox (launchd starts the app), so this mode starts the server through
the app binary's own ``-c`` role (frozen_entry: a Python role, no window) running fiberbrowser.cli.run_server. The
app copy, FIBERBROWSER_APP_SMOKE_ROOT and every input must be outside the denied folders (ditto the app to /tmp
first). FIBERBROWSER_APP_SMOKE_CLEAN_DENY adds folders to deny (os.pathsep-separated: another conda, a
second home). test_clean_machine.py holds the checks that only mean something there (HTTPS trust, downloads, the
bundled tools); its network checks also need FIBERBROWSER_APP_SMOKE_NETWORK=1 (they download a few MB: sacCer3, a
FiberHMM wheel, remote file headers). Release builds run:

    FIBERBROWSER_APP_SMOKE_CLEAN_MACHINE=1 FIBERBROWSER_APP_SMOKE_NETWORK=1 \\
    FIBERBROWSER_APP_SMOKE_APP=/tmp/fbsmoke/FiberBrowser.app FIBERBROWSER_APP_SMOKE_ROOT=/tmp/fbsmoke/run \\
    python -m pytest tests/app_smoke -m app_smoke -v
"""
from __future__ import annotations

import json
import os
import pwd
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

APP = os.environ.get("FIBERBROWSER_APP_SMOKE_APP", "")
DEAD_PROXY = "http://127.0.0.1:9"  # discard port: anything that tries the network fails at once, nothing is downloaded
CLEAN_MACHINE = os.environ.get("FIBERBROWSER_APP_SMOKE_CLEAN_MACHINE") == "1"
NETWORK = os.environ.get("FIBERBROWSER_APP_SMOKE_NETWORK") == "1"
MINIMAL_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"  # launchd's PATH for an app opened from Finder
RUN_SERVER = "import sys; from fiberbrowser.cli import run_server; sys.exit(run_server(sys.argv[1:]))"


def real_home() -> str:
    return pwd.getpwuid(os.getuid()).pw_dir


def builder_paths() -> list[str]:
    """Folders a user's Mac doesn't have (or has different content in): denied in clean-machine mode."""
    paths = [real_home(), "/opt/homebrew", "/opt/local", "/usr/local", "/Library/Developer",
             "/Library/Java/JavaVirtualMachines", "/Library/Frameworks", "/Library/Fonts", "/Applications"]
    for var in ("CONDA_PREFIX", "CONDA_EXE", "MAMBA_ROOT_PREFIX"):   # a conda outside the home folder
        value = os.environ.get(var)
        if value:
            root = Path(value).resolve()
            paths.append(str(root.parent.parent if var == "CONDA_EXE" else root))
    paths += [p for p in os.environ.get("FIBERBROWSER_APP_SMOKE_CLEAN_DENY", "").split(os.pathsep) if p]
    return [str(Path(p)) for p in dict.fromkeys(paths)]


def denied(path) -> str | None:
    """The denied folder ``path`` is in (resolved, so /tmp and /var links count as what they point to), else None."""
    target = Path(path).resolve()
    for root in builder_paths():
        if target == Path(root).resolve() or target.is_relative_to(Path(root).resolve()):
            return root
    return None


def write_clean_machine_profile(dest: Path) -> Path:
    """The sandbox-exec profile of clean-machine mode: everything allowed except reading builder_paths()."""
    def both(p: str) -> list[str]:   # the firmlinked Data-volume spelling reaches the same files
        return [p, "/System/Volumes/Data" + p] if not p.startswith("/System/") else [p]
    rules = " ".join(f'(subpath "{q}")' for p in builder_paths() for q in both(p))
    safari = " ".join(f'(subpath "{q}")' for q in both("/Applications/Safari.app"))
    listing = " ".join(f'(literal "{q}")' for q in both("/Applications"))
    dest.write_text("(version 1)\n(allow default)\n"
                    f"(deny file-read* {rules})\n"
                    f"(allow file-read* {safari} {listing})\n")
    return dest


def app_env(home: Path, extra_env: dict | None = None, network: bool = False) -> dict:
    """The environment of an app process in clean-machine mode: nothing from this shell but USER/LANG. A value of
    None in ``extra_env`` removes that variable."""
    tmp = home / "tmp"
    tmp.mkdir(parents=True, exist_ok=True)
    user = pwd.getpwuid(os.getuid()).pw_name
    env = {"HOME": str(home), "PATH": MINIMAL_PATH, "TMPDIR": str(tmp) + "/", "LANG": "en_US.UTF-8",
           "USER": user, "LOGNAME": user, "SHELL": "/bin/zsh", "FIBERBROWSER_NO_OPEN": "1", "FIBERBROWSER_NO_TOKEN": "1"}
    if not network:
        env.update({"HTTPS_PROXY": DEAD_PROXY, "HTTP_PROXY": DEAD_PROXY, "NO_PROXY": "127.0.0.1,localhost"})
    env.update(extra_env or {})
    return {k: v for k, v in env.items() if v is not None}


def sandboxed(cmd: list[str], profile: Path | None) -> list[str]:
    return (["/usr/bin/sandbox-exec", "-f", str(profile)] if profile else []) + cmd


def pytest_collection_modifyitems(config, items):
    here = Path(__file__).parent
    skip = None
    if not APP:
        skip = pytest.mark.skip(reason="packaged-app smoke: set FIBERBROWSER_APP_SMOKE_APP to a FiberBrowser.app (tests/app_smoke/conftest.py)")
    elif sys.platform != "darwin":
        skip = pytest.mark.skip(reason="packaged-app smoke runs on macOS (open -n)")
    elif CLEAN_MACHINE and not os.path.exists("/usr/bin/sandbox-exec"):
        skip = pytest.mark.skip(reason="clean-machine mode needs /usr/bin/sandbox-exec")
    elif CLEAN_MACHINE and denied(APP):
        skip = pytest.mark.skip(reason=f"clean-machine mode: the app is inside {denied(APP)}, which the sandbox hides; "
                                       "ditto it to /tmp first")
    for item in items:
        if Path(str(item.fspath)).is_relative_to(here):
            item.add_marker(pytest.mark.app_smoke)
            if skip is not None:
                item.add_marker(skip)


def _free_port() -> int:
    want = os.environ.get("FIBERBROWSER_APP_SMOKE_PORT")
    if want:
        return int(want)
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _listening_pid(port: int) -> int | None:
    out = subprocess.run(["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"], capture_output=True, text=True).stdout.split()
    return int(out[0]) if out else None


class RunningApp:
    """One headless instance of the packaged app on a scratch HOME."""

    def __init__(self, home: Path, port: int, logs: Path, profile: Path | None = None):
        self.home, self.port, self.logs, self.profile = home, port, logs, profile
        self.base = f"http://127.0.0.1:{port}"
        self.pid: int | None = None
        self.proc: subprocess.Popen | None = None

    def call(self, method: str, path: str, body=None, timeout: float = 300):
        req = urllib.request.Request(self.base + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with opener.open(req, timeout=timeout) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            return {"http_error": e.code, "body": e.read().decode(errors="replace")[:2000]}

    def start(self, tag: str, extra_env: dict | None = None, args: list[str] | None = None, network: bool = False,
              ready=None):
        """``extra_env`` adds to (or replaces) the instance's environment, e.g. a graph package or a loopback proxy;
        ``args`` are more server options (--config ...); ``network`` drops the dead proxy (clean-machine mode only);
        ``ready(response)`` decides when a started server counts as up (default: /api/version answered)."""
        if _listening_pid(self.port) is not None:
            pytest.fail(f"port {self.port} is busy before the app was opened")
        if CLEAN_MACHINE:
            return self._start_sandboxed(tag, extra_env, args or [], network, ready)
        env = {"HOME": str(self.home), "FIBERBROWSER_NO_OPEN": "1", "FIBERBROWSER_NO_TOKEN": "1",
               "HTTPS_PROXY": DEAD_PROXY, "HTTP_PROXY": DEAD_PROXY, "NO_PROXY": "127.0.0.1,localhost",
               **(extra_env or {})}
        cmd = ["open", "-n"]
        for k, v in env.items():
            cmd += ["--env", f"{k}={v}"]
        cmd += ["--stdout", str(self.logs / f"{tag}_stdout.log"), "--stderr", str(self.logs / f"{tag}_stderr.log"),
                APP, "--args", "--serve", "--port", str(self.port), *(args or [])]
        # open(1) hands its own environment to the app: start it from a clean one, so nothing the test process set
        # (tests/conftest.py points FIBERBROWSER_JOBS_DIR, _LIBRARY, _SETTINGS … at scratch files) reaches the app.
        clean = {k: os.environ[k] for k in ("PATH", "USER", "LOGNAME", "LANG", "TMPDIR") if k in os.environ}
        subprocess.run(cmd, check=True, env={k: v for k, v in {**clean, **env}.items() if v is not None})
        return self._wait_up(ready)

    def _wait_up(self, ready=None):
        ready = ready or (lambda v: isinstance(v, dict) and "current" in v)
        deadline = time.time() + 180
        while time.time() < deadline:
            v = self.call("GET", "/api/version", timeout=5) if _listening_pid(self.port) else None
            if ready(v):
                self.pid = _listening_pid(self.port)
                return v
            if self.proc is not None and self.proc.poll() is not None:
                pytest.fail(f"the app's server exited ({self.proc.returncode}) before answering (logs in {self.logs})")
            time.sleep(1)
        pytest.fail(f"the app did not answer on port {self.port} within 180 s (logs in {self.logs})")

    def _start_sandboxed(self, tag, extra_env, args, network, ready):
        """Clean-machine mode: the app binary's -c role runs the server inside the sandbox (see the module text)."""
        exe = str(Path(APP) / "Contents" / "MacOS" / "FiberBrowser")
        cmd = sandboxed([exe, "-c", RUN_SERVER, "--port", str(self.port), "--no-open", "--no-token", *args], self.profile)
        env = app_env(self.home, extra_env, network=network)
        out = open(self.logs / f"{tag}_stdout.log", "ab")
        # cwd: an allowed folder (Finder starts apps in /; a denied cwd makes the frozen entry's abspath() fail)
        self.proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT, env=env,
                                     cwd=str(self.home), start_new_session=True)
        out.close()
        return self._wait_up(ready)

    def stop(self):
        """POST /api/quit, then end only this instance's own pid if it is still listening."""
        try:
            self.call("POST", "/api/quit", timeout=10)
        except Exception:
            pass
        for _ in range(30):
            if _listening_pid(self.port) is None:
                break
            time.sleep(1)
        pid = _listening_pid(self.port)
        if pid is not None and pid == self.pid:
            os.kill(pid, 15)
        if self.proc is not None:   # clean-machine mode: our own child, by its Popen handle
            try:
                self.proc.wait(timeout=30)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=30)
            self.proc = None
        self.pid = None


@pytest.fixture(scope="session")
def smoke_root():
    base = os.environ.get("FIBERBROWSER_APP_SMOKE_ROOT") or None
    if base:
        Path(base).mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="fb-appsmoke-", dir=base))
    (root / "logs").mkdir()
    if CLEAN_MACHINE and denied(root):
        pytest.skip(f"clean-machine mode: the smoke root {root} is inside {denied(root)}, which the sandbox hides; "
                    "set FIBERBROWSER_APP_SMOKE_ROOT outside it (e.g. /tmp/fbsmoke)")
    yield root
    if not os.environ.get("FIBERBROWSER_APP_SMOKE_KEEP"):
        shutil.rmtree(root, ignore_errors=True)


@pytest.fixture(scope="session")
def clean_profile(smoke_root) -> Path | None:
    """The sandbox profile in clean-machine mode, else None."""
    return write_clean_machine_profile(smoke_root / "clean_machine.sb") if CLEAN_MACHINE else None


@pytest.fixture
def in_app(smoke_root, clean_profile):
    """``proc = in_app(code, home_name)``: the app's own interpreter (its -c role) runs ``code`` with HOME=<smoke
    root>/<home_name>, under the sandbox in clean-machine mode. ``network=True`` drops the dead proxy."""
    def run(code: str, home_name: str = "in_app", network: bool = False, timeout: float = 600, env: dict | None = None):
        home = smoke_root / home_name
        home.mkdir(exist_ok=True)
        exe = str(Path(APP) / "Contents" / "MacOS" / "FiberBrowser")
        return subprocess.run(sandboxed([exe, "-c", code], clean_profile), capture_output=True, text=True,
                              timeout=timeout, cwd=str(home), stdin=subprocess.DEVNULL,
                              env=app_env(home, env, network=network))
    return run


@pytest.fixture
def packaged_app(smoke_root, request, clean_profile):
    """Factory: ``app = packaged_app("name")`` opens the app on HOME=<smoke root>/<name> (same name = same HOME, so a
    second call after ``app.stop()`` is a restart); ``packaged_app("name", env={...})`` adds to its environment.
    Every instance is stopped at teardown."""
    real_fiberhmm = Path(real_home()) / ".fiberhmm"
    before = sorted(p.name for p in real_fiberhmm.iterdir()) if real_fiberhmm.is_dir() else None
    started: list[RunningApp] = []

    def make(name: str, env: dict | None = None, args: list[str] | None = None, network: bool = False,
             ready=None) -> RunningApp:
        home = smoke_root / name
        home.mkdir(exist_ok=True)
        app = RunningApp(home, _free_port(), smoke_root / "logs", clean_profile)
        app.version = app.start(f"{request.node.name}_{name}_{len(started)}", extra_env=env, args=args,
                                network=network, ready=ready)
        started.append(app)
        return app

    yield make
    for app in started:
        if app.pid is not None:
            app.stop()
    after = sorted(p.name for p in real_fiberhmm.iterdir()) if real_fiberhmm.is_dir() else None
    assert before == after, "the smoke changed the real ~/.fiberhmm"


@pytest.fixture(scope="session")
def smoke_inputs(smoke_root):
    """The synthetic wizard inputs of tests/synthetic_runs.py (the same reads the source-tree run tests use)."""
    import synthetic_runs as synth
    d = smoke_root / "inputs"
    d.mkdir(exist_ok=True)
    genome = synth.random_genome()
    paths = {"fasta": synth.write_fasta(str(d / "genome.fa"), genome),
             "fastq": synth.write_fastq(str(d / "synthetic_daf.fastq"), synth.daf_reads(genome, n=60)),
             "hia5": str(d / "synthetic_hia5.bam"), "hia5u": str(d / "synthetic_hia5_unaligned.bam")}
    synth.write_hia5_pacbio_bam(paths["hia5"], genome, n=40)
    synth.write_hia5_pacbio_bam(paths["hia5u"], genome, n=40, aligned=False)
    gtf = d / "genome.gtf"
    gtf.write_text('chrA\tsmoke\tgene\t1001\t3000\t.\t+\t.\tgene_id "G1"; gene_name "G1";\n'
                   'chrA\tsmoke\ttranscript\t1001\t3000\t.\t+\t.\tgene_id "G1"; transcript_id "T1"; gene_name "G1";\n'
                   'chrA\tsmoke\texon\t1001\t3000\t.\t+\t.\tgene_id "G1"; transcript_id "T1"; gene_name "G1";\n')
    paths["gtf"] = str(gtf)
    paths["genome"] = genome
    import pysam
    pysam.faidx(paths["fasta"])
    return paths


# --- Browser-driven checks (test_packaged_app_ui.py): small Node Playwright drivers in tests/app_smoke/ui/ ----------

UI_DIR = Path(__file__).parent / "ui"
NODE_MODULES = Path(os.environ.get("FIBERBROWSER_APP_SMOKE_NODE_MODULES")
                    or Path(__file__).resolve().parents[2] / "browser" / "frontend" / "node_modules")


@pytest.fixture(scope="session")
def ui_node():
    """node on PATH, the frontend's Playwright, and Chromium + WebKit that launch; otherwise the UI tests skip."""
    node = shutil.which("node")
    if not node:
        pytest.skip("browser-driven app smoke: node is not on PATH")
    if not (NODE_MODULES / "playwright" / "package.json").is_file():
        pytest.skip(f"browser-driven app smoke: no Playwright in {NODE_MODULES} (npm ci in browser/frontend)")
    env = {**os.environ, "FIBERBROWSER_APP_SMOKE_NODE_MODULES": str(NODE_MODULES)}
    probe = subprocess.run([node, str(UI_DIR / "probe.mjs")], capture_output=True, text=True, timeout=180, env=env)
    if probe.returncode != 0:
        pytest.skip("browser-driven app smoke: Playwright's Chromium/WebKit do not launch "
                    f"(npx playwright install chromium webkit): {(probe.stdout + probe.stderr)[-600:]}")
    return node


@pytest.fixture
def ui_driver(ui_node, smoke_root, request):
    """``result = ui_driver("layer_colours.mjs", {...})``: runs one driver against a running app and returns the
    result it wrote. A driver that throws, exits non-zero or reports ``error`` fails the test. Screenshots and the
    driver log stay in <smoke root>/ui/<test>/ (kept with FIBERBROWSER_APP_SMOKE_KEEP=1)."""
    runs = []

    def run(script: str, args: dict, timeout: float = 900) -> dict:
        out = smoke_root / "ui" / request.node.name / f"{len(runs):02d}_{Path(script).stem}"
        out.mkdir(parents=True, exist_ok=True)
        runs.append(out)
        env = {**os.environ, "FIBERBROWSER_APP_SMOKE_NODE_MODULES": str(NODE_MODULES)}
        proc = subprocess.run([ui_node, str(UI_DIR / script), json.dumps({**args, "outdir": str(out)})],
                              capture_output=True, text=True, timeout=timeout, env=env)
        (out / "driver.log").write_text(proc.stdout + "\n--- stderr ---\n" + proc.stderr)
        result_file = out / "result.json"
        result = json.loads(result_file.read_text()) if result_file.is_file() else None
        assert result is not None, f"{script} wrote no result (exit {proc.returncode}): {(proc.stdout + proc.stderr)[-2000:]}"
        assert proc.returncode == 0 and not result.get("error"), f"{script} failed: {result.get('error') or proc.stderr[-2000:]}"
        return result

    return run
