"""SSH source: read files on a cluster through the user's own ``ssh``.

How a connection is made (``SshSource.connect``):

1. Reuse a live ControlMaster: the user's own (``ssh -O check host`` with
   their ~/.ssh/config ControlPath) or FiberBrowser's (``-S <socket>``).
2. Otherwise open FiberBrowser's master non-interactively (keys/agent,
   ``BatchMode=yes``). When that needs a password, Duo or a host-key answer,
   open a terminal window running the same ``ssh -M ... -N -f`` command (and
   show it so the user can run it anywhere) and wait for the master to
   appear. FiberBrowser never sees or stores a password.
3. Run the helper over the master: ``ssh ... host "sh -c '<find python3>'"``
   with the helper script and a JSON config (roots, random token) on stdin.
   The helper listens on a Unix socket inside a new 0700 folder on the login
   node (other users there cannot connect to it at all) and exits when this
   ssh session ends.
4. Forward a local loopback port to that socket
   (``ssh -O forward -L 127.0.0.1:<port>:<socket>``). A site that refuses
   socket forwarding (``AllowStreamLocalForwarding no``, very old sshd) gets
   the earlier arrangement automatically: the helper is restarted on
   127.0.0.1:<random> on the login node and the port is forwarded instead.

References look like ``ssh://[user@]host/abs/path``. The live URL
``http://127.0.0.1:<port>/<file key>/f/<path>`` is made at open time only:
the file key is derived from the connection's secret token and opens only
that file (and its index files), so a URL that shows up in a native library
message opens nothing else. The connection's live URLs are registered with
``services.signed_urls`` (one pattern per connection) so logs, printed output
and JSON responses show the ``ssh://`` reference instead.
"""
from __future__ import annotations

import collections
import hashlib
import json
import os
import secrets
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Optional

from services.remote_sources import ssh_command as cmd
from services.remote_sources.base import NotConnectedError, RemoteFileChanged, RemoteSource, RemoteSourceError

HELPER_NAME = "remote_helper.py"


def helper_source() -> bytes:
    """The helper script's bytes (next to this module, or in the Mac app bundle)."""
    candidates = [Path(__file__).with_name(HELPER_NAME)]
    bundle = getattr(sys, "_MEIPASS", None)
    if bundle:
        candidates.append(Path(bundle) / "fiberbrowser" / "browser" / "services" / "remote_sources" / HELPER_NAME)
    for candidate in candidates:
        try:
            return candidate.read_bytes()
        except OSError:
            continue
    raise RemoteSourceError("FiberBrowser's remote helper script is missing from this installation.")
READY_PREFIX = "FBHELPER_READY "

SSH_DIR_ENV = "FIBERBROWSER_SSH_DIR"
DEFAULT_PERSIST = "30m"
DEFAULT_IDLE_TIMEOUT = 8 * 3600
DEFAULT_AUTH_TIMEOUT = 300.0
HELPER_START_TIMEOUT = 60.0
MAX_FETCH_BYTES = 256 * 1024 * 1024
FETCH_CHUNK_BYTES = 16 * 1024 * 1024  # whole-file copies are fetched as byte ranges of this size
DEFAULT_USER_TTL = 300.0


def file_key(token: str, path: str) -> str:
    """The per-file secret the helper accepts for ``path`` (see remote_helper.file_key)."""
    import hmac
    message = ("f\x00" + path).encode("utf-8", "surrogateescape")
    return hmac.new(token.encode("utf-8"), message, hashlib.sha256).hexdigest()[:40]


class _ForwardRefused(RemoteSourceError):
    """The site would not forward a local port to the helper's Unix socket."""


_default_users: dict[str, tuple[float, Optional[str]]] = {}
_default_users_lock = threading.Lock()


def default_user_for(host: str) -> Optional[str]:
    """The account ``ssh host`` signs in as (``ssh -G``; nothing is contacted), or None."""
    now = time.time()
    with _default_users_lock:
        cached = _default_users.get(host)
    if cached and now - cached[0] < DEFAULT_USER_TTL:
        return cached[1]
    try:
        result = _run(cmd.config_user_argv(host), timeout=10)
        user = cmd.parse_config_user(result.stdout.decode("utf-8", "replace")) if result.returncode == 0 else None
    except (cmd.SshCommandError, OSError):
        user = None
    with _default_users_lock:
        _default_users[host] = (now, user)
    return user


def _register_redaction(secret: str, display: str) -> None:
    from services import signed_urls
    signed_urls.register_secret(secret, display)


def _register_key_urls(port: int, display: str) -> None:
    """Every per-file key URL of the connection on ``port`` shows as ``display``."""
    from services import signed_urls
    signed_urls.register_pattern(f"ssh-loopback-{int(port)}", rf"https?://127\.0\.0\.1:{int(port)}/[0-9a-f]{{40}}/f",
                                 display)


def parse_ssh_ref(ref: str) -> tuple[Optional[str], str, str]:
    """``ssh://[user@]host/abs/path`` -> (user, host, path). Path kept verbatim."""
    if not isinstance(ref, str) or not ref.startswith("ssh://"):
        raise RemoteSourceError(f"Not an ssh:// reference: {ref!r}")
    rest = ref[len("ssh://"):]
    target, slash, path = rest.partition("/")
    if not slash:
        path = ""
    path = "/" + path
    user, at, host = target.rpartition("@")
    if not at:
        user = ""
    user = cmd.validate_user(user)
    host = cmd.validate_host(host)
    if "\x00" in path:
        raise RemoteSourceError("Invalid path")
    return user, host, path


def make_ssh_ref(user: Optional[str], host: str, path: str) -> str:
    target = f"{user}@{host}" if user else host
    if not path.startswith("/"):
        path = "/" + path
    return f"ssh://{target}{path}"


def _control_dir() -> str:
    override = os.environ.get(SSH_DIR_ENV)
    base = override or os.path.join(os.path.expanduser("~"), ".fiberhmm", "ssh")
    # Unix socket paths are short (104 bytes on macOS); ssh adds ~17 chars.
    if len(base) > 70:
        base = os.path.join(tempfile.gettempdir(), f"fb-ssh-{os.getuid() if hasattr(os, 'getuid') else 'u'}")
    os.makedirs(base, mode=0o700, exist_ok=True)
    try:
        os.chmod(base, 0o700)
    except OSError:
        pass
    return base


def _control_path(target: str) -> str:
    digest = hashlib.sha256(target.encode("utf-8")).hexdigest()[:12]
    return os.path.join(_control_dir(), f"cm-{digest}")


def _free_local_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _ensure_no_proxy_for_loopback() -> None:
    """libcurl (htslib, pyBigWig) honours http_proxy; loopback must bypass it
    so tokened URLs never reach a proxy."""
    for key in ("NO_PROXY", "no_proxy"):
        values = [v.strip() for v in os.environ.get(key, "").split(",") if v.strip()]
        for host in ("127.0.0.1", "localhost"):
            if host not in values:
                values.append(host)
        os.environ[key] = ",".join(values)


_NO_PROXY_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _run(argv: list[str], timeout: float) -> subprocess.CompletedProcess:
    # stdout/stderr go to files: a backgrounded ssh (-f) keeps them open, so
    # pipes would never reach EOF.
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        try:
            proc = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=out, stderr=err,
                                  timeout=timeout, check=False)
            code = proc.returncode
        except subprocess.TimeoutExpired:
            code = 124
        except OSError as exc:
            return subprocess.CompletedProcess(argv, 127, b"", str(exc).encode())
        out.seek(0)
        err.seek(0)
        return subprocess.CompletedProcess(argv, code, out.read(), err.read())


def _clean_stderr(data: bytes | str, limit: int = 600) -> str:
    text = data.decode("utf-8", "replace") if isinstance(data, bytes) else data
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    lines = [line for line in lines if not line.startswith("Warning: Permanently added")]
    return "\n".join(lines)[-limit:]


class SshConnection:
    """One connected (or connecting) host."""

    def __init__(self, host: str, user: Optional[str], roots: list[str], *,
                 remote_python: Optional[str], persist: str, idle_timeout: int):
        self.host = host
        self.user = user
        self.target = f"{user}@{host}" if user else host
        self.requested_roots = roots
        self.remote_python = remote_python
        self.persist = persist
        self.idle_timeout = idle_timeout
        self.control_path: Optional[str] = _control_path(self.target)
        self.default_user: Optional[str] = None  # ssh -G's user for this host (resolved on connect)
        self.own_master = False  # True: FiberBrowser opened the master
        self.shared_master = False  # True: the user's own ControlMaster
        self.reused_master = False  # True: a master still open from an earlier connection
        self.state = "starting"
        self.message = "Connecting…"
        self.error: Optional[str] = None
        self.auth_command: Optional[str] = None
        self.terminal_opened = False
        self.roots: list[str] = []
        self.missing_roots: list[str] = []
        self.home: Optional[str] = None
        self.remote_hostname: Optional[str] = None
        self.remote_python_version: Optional[str] = None
        self.token = secrets.token_urlsafe(32)
        self.remote_port: Optional[int] = None
        self.remote_socket: Optional[str] = None
        self.socket_refused: Optional[str] = None  # why the Unix-socket forward was not used
        self.local_port: Optional[int] = None
        self.proc: Optional[subprocess.Popen] = None
        self.stderr_tail: collections.deque[str] = collections.deque(maxlen=40)
        self.started = time.time()
        self.connected_at: Optional[float] = None
        self.cancelled = threading.Event()
        self.lock = threading.RLock()
        self._stat_cache: dict[str, tuple[float, Optional[dict]]] = {}
        self._last_sample: Optional[tuple[float, int]] = None
        self.rate_bps: Optional[float] = None
        self.latency_ms: Optional[float] = None
        self.bytes_served = 0

    # -- helpers ---------------------------------------------------------
    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.local_port}/{self.token}"

    def _set(self, state: str, message: str, error: Optional[str] = None) -> None:
        with self.lock:
            self.state = state
            self.message = message
            self.error = error

    def alive(self) -> bool:
        return self.state == "connected" and self.proc is not None and self.proc.poll() is None

    def effective_user(self) -> Optional[str]:
        """The account this connection signed in as, when known."""
        return self.user or self.default_user

    def _mux_path(self) -> Optional[str]:
        return None if self.shared_master else self.control_path

    def request(self, route: str, *, query: Optional[dict] = None, timeout: float = 20.0,
                headers: Optional[dict] = None, probe: bool = False) -> bytes:
        """GET ``route`` from the helper. ``probe``: while connecting, the helper's
        ssh session only has to be running (the state is not "connected" yet)."""
        if probe:
            usable = bool(self.local_port) and self.proc is not None and self.proc.poll() is None
        else:
            usable = self.alive()
        if not usable:
            raise NotConnectedError(f"Not connected to {self.target}.", scheme="ssh", target=self.target)
        url = f"{self.base_url}/{route}"
        if query:
            url += "?" + urllib.parse.urlencode(query)
        req = urllib.request.Request(url, headers=headers or {})
        try:
            with _NO_PROXY_OPENER.open(req, timeout=timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as exc:
            body = exc.read()
            try:
                payload = json.loads(body.decode("utf-8"))
            except Exception:
                payload = {}
            if exc.code in (403, 404):
                raise RemoteSourceError(payload.get("error") or "Not found under the shared folders") from None
            raise RemoteSourceError(f"Remote helper error {exc.code}") from None
        except (urllib.error.URLError, OSError) as exc:
            raise RemoteSourceError(f"Connection to {self.target} failed: {getattr(exc, 'reason', exc)}") from None

    def json(self, route: str, **kwargs) -> Any:
        return json.loads(self.request(route, **kwargs).decode("utf-8"))

    def file_url(self, path: str) -> str:
        """The URL htslib / pyBigWig open for ``path``: a per-file key, never the token."""
        prefix = f"http://127.0.0.1:{self.local_port}/{file_key(self.token, path)}/f"
        return f"{prefix}{urllib.parse.quote(path, safe='/')}"

    def public_dict(self, *, probe: bool = False) -> dict[str, Any]:
        if self.state == "connected" and self.proc is not None and self.proc.poll() is not None:
            tail = _clean_stderr("\n".join(self.stderr_tail))
            self._set("disconnected", "The SSH session ended.", tail or None)
        if probe and self.alive():
            self.sample()
        return {
            "source": "ssh",
            "target": self.target,
            "host": self.host,
            "user": self.user,
            "default_user": self.default_user,
            "effective_user": self.effective_user(),
            "transport": "socket" if self.remote_socket else ("port" if self.remote_port else None),
            "state": self.state,
            "message": self.message,
            "error": self.error,
            "auth_command": self.auth_command if self.state == "authenticating" else None,
            "terminal_opened": self.terminal_opened,
            "roots": self.roots,
            "missing_roots": self.missing_roots,
            "home": self.home,
            "remote_hostname": self.remote_hostname,
            "python": self.remote_python_version,
            "shared_master": self.shared_master,
            "own_master": self.own_master,
            "reused_master": self.reused_master,
            "connected_at": self.connected_at,
            "latency_ms": self.latency_ms,
            "rate_bps": self.rate_bps,
            "bytes_served": self.bytes_served,
            "ref_prefix": f"ssh://{self.target}",
        }

    def sample(self) -> None:
        """Round-trip latency and the helper's bytes-served rate."""
        try:
            t0 = time.perf_counter()
            stats = self.json("stats", timeout=5.0)
            self.latency_ms = round((time.perf_counter() - t0) * 1000.0, 1)
            now = float(stats.get("now") or time.time())
            served = int(stats.get("bytes") or 0)
            if self._last_sample is not None and now > self._last_sample[0]:
                self.rate_bps = max(0.0, (served - self._last_sample[1]) / (now - self._last_sample[0]))
            self._last_sample = (now, served)
            self.bytes_served = served
        except RemoteSourceError:
            pass

    def stat(self, path: str, max_age: float = 15.0) -> Optional[dict]:
        cached = self._stat_cache.get(path)
        if cached and time.time() - cached[0] < max_age:
            return cached[1]
        try:
            info = self.json("stat", query={"path": path}, timeout=15.0)
        except RemoteSourceError:
            info = None
        if info is not None and not info.get("exists"):
            info = None
        self._stat_cache[path] = (time.time(), info)
        return info

    # -- lifecycle -------------------------------------------------------
    def run(self, *, open_terminal: bool, auth_timeout: float) -> None:
        try:
            self.default_user = default_user_for(self.host)
            self._establish_master(open_terminal=open_terminal, auth_timeout=auth_timeout)
            if self.cancelled.is_set():
                return
            self._start_helper("unix")
            if self.cancelled.is_set():
                self._stop_helper()
                return
            if self.remote_socket:
                try:
                    self._forward()
                except _ForwardRefused as exc:
                    # AllowStreamLocalForwarding no (or an old sshd): the helper
                    # moves to a loopback port on the login node instead.
                    self.socket_refused = str(exc) or "refused"
                    self._stop_helper()
                    if self.cancelled.is_set():
                        return
                    self._start_helper("tcp")
                    self._forward()
            else:
                self._forward()
            if self.cancelled.is_set():
                self._cancel_forward()
                self._stop_helper()
                return
            self.connected_at = time.time()
            self._set("connected", f"Connected to {self.target}.")
        except RemoteSourceError as exc:
            self._stop_helper()
            self._set("error", str(exc), str(exc))
        except Exception as exc:  # pragma: no cover - unexpected
            self._stop_helper()
            self._set("error", f"Connection failed: {exc}", str(exc))

    def _master_alive(self, control_path: Optional[str]) -> bool:
        result = _run(cmd.check_master_argv(self.host, self.user, control_path), timeout=15)
        return result.returncode == 0

    def _establish_master(self, *, open_terminal: bool, auth_timeout: float) -> None:
        if sys.platform == "win32":
            raise RemoteSourceError(
                "Connect to cluster needs OpenSSH connection sharing (ControlMaster), which the "
                "Windows ssh does not support. Run FiberBrowser in WSL, or use the cluster's OnDemand."
            )
        self._set("starting", "Looking for an open SSH connection…")
        if self._master_alive(None):
            self.shared_master = True
            self._set("starting", "Using your open SSH connection.")
            return
        if self._master_alive(self.control_path):
            self.own_master = True
            self.reused_master = True
            self._set("starting", "Reusing FiberBrowser's SSH connection.")
            return
        self._set("starting", f"Signing in to {self.target} with your SSH keys…")
        batch = _run(cmd.start_master_argv(self.host, self.user, self.control_path, self.persist, batch=True),
                     timeout=45)
        if batch.returncode == 0 and self._master_alive(self.control_path):
            self.own_master = True
            return
        reason = _clean_stderr(batch.stderr)
        if batch.returncode == 124:
            reason = "timed out"
        if "Could not resolve hostname" in reason or "Name or service not known" in reason:
            raise RemoteSourceError(f"Unknown host '{self.host}': {reason}")
        # Needs a password, Duo, or a first-time host-key answer: the user does
        # that in a terminal; we only wait for the master socket.
        interactive = cmd.start_master_argv(self.host, self.user, self.control_path, self.persist, batch=False)
        self.auth_command = cmd.shell_command(interactive)
        self._set("authenticating",
                  "Finish signing in (password / Duo) in the terminal window, then come back here."
                  if open_terminal else "Run the command below in a terminal to sign in, then come back here.",
                  None)
        if open_terminal:
            self.terminal_opened = self._open_terminal(self.auth_command)
            if not self.terminal_opened:
                self._set("authenticating", "Run the command below in a terminal to sign in, then come back here.")
        deadline = time.time() + auth_timeout
        while time.time() < deadline:
            if self.cancelled.wait(1.5):
                raise RemoteSourceError("Cancelled.")
            if self._master_alive(self.control_path):
                self.own_master = True
                self.auth_command = None
                return
        raise RemoteSourceError(
            f"No SSH connection to {self.target} after {int(auth_timeout)} s. "
            + (f"Batch sign-in said: {reason}" if reason else "")
        )

    def _open_terminal(self, command: str) -> bool:
        script = os.path.join(_control_dir(), f"login-{hashlib.sha256(self.target.encode()).hexdigest()[:12]}.command")
        try:
            fd = os.open(script, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o700)
            with os.fdopen(fd, "w") as handle:
                handle.write(cmd.terminal_script(command))
            os.chmod(script, 0o700)
        except OSError:
            return False
        launcher = cmd.terminal_launch_argv(script)
        if not launcher:
            return False
        try:
            result = subprocess.run(launcher, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                    stderr=subprocess.DEVNULL, timeout=20, start_new_session=True)
        except (OSError, subprocess.TimeoutExpired):
            return False
        return result.returncode == 0

    def _start_helper(self, listen: str = "unix") -> None:
        self._set("starting", "Starting the read-only file helper on the cluster…" if listen == "unix" else
                  "This cluster does not forward to a private socket; using a loopback port there instead…")
        self.stderr_tail.clear()
        argv = cmd.helper_argv(self.host, self.user, self._mux_path(), self.remote_python)
        try:
            proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, start_new_session=True)
        except OSError as exc:
            raise RemoteSourceError(f"Could not run ssh: {exc}") from None
        self.proc = proc
        threading.Thread(target=self._drain_stderr, args=(proc,), daemon=True, name="fb-ssh-stderr").start()
        script = helper_source()
        config = {"token": self.token, "roots": self.requested_roots or ["~"],
                  "idle_timeout": int(self.idle_timeout), "listen": listen}
        try:
            proc.stdin.write(b"%d\n" % len(script) + script + json.dumps(config).encode("utf-8") + b"\n")
            proc.stdin.flush()
        except OSError:
            pass
        ready = self._read_ready(proc)
        self.remote_socket = ready.get("socket") or None
        self.remote_port = None if self.remote_socket else int(ready["port"])
        self.roots = list(ready.get("roots") or [])
        self.missing_roots = list(ready.get("missing_roots") or [])
        self.home = ready.get("home")
        self.remote_hostname = ready.get("host")
        self.remote_python_version = ready.get("python")

    def _read_ready(self, proc: subprocess.Popen) -> dict:
        result: dict[str, Any] = {}
        done = threading.Event()

        def reader() -> None:
            # Login banners and .bashrc output may come first: skip to the marker.
            for _ in range(500):
                line = proc.stdout.readline()
                if not line:
                    break
                text = line.decode("utf-8", "replace").strip()
                if text.startswith(READY_PREFIX):
                    try:
                        result.update(json.loads(text[len(READY_PREFIX):]))
                    except ValueError:
                        pass
                    break
            done.set()

        threading.Thread(target=reader, daemon=True, name="fb-ssh-ready").start()
        done.wait(HELPER_START_TIMEOUT)
        if result.get("port") or result.get("socket"):
            return result
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass
        tail = _clean_stderr("\n".join(self.stderr_tail))
        if cmd.NO_PYTHON_MARKER in tail or proc.returncode == cmd.NO_PYTHON_EXIT:
            raise RemoteSourceError(
                f"No Python 3.6 or newer was found on {self.host}. Set 'Remote Python' to the full "
                "path of a python3 there (for example, after 'module load anaconda3', run 'which python3')."
            )
        for line in tail.splitlines():
            if "FBHELPER_ERROR" in line:
                raise RemoteSourceError(line.split("FBHELPER_ERROR", 1)[1].strip())
        raise RemoteSourceError(f"The file helper did not start on {self.host}." + (f" {tail}" if tail else ""))

    def _drain_stderr(self, proc: subprocess.Popen) -> None:
        try:
            for line in iter(proc.stderr.readline, b""):
                self.stderr_tail.append(line.decode("utf-8", "replace").rstrip()[:500])
        except Exception:
            pass

    def register_redactions(self) -> None:
        """Anything that prints this connection's live URLs shows the reference instead."""
        _register_key_urls(self.local_port, f"ssh://{self.target}")
        _register_redaction(f"{self.base_url}/f", f"ssh://{self.target}")
        _register_redaction(self.base_url, f"ssh://{self.target}")
        _register_redaction(self.token, "<token>")

    def _remote_endpoint(self):
        return self.remote_socket or self.remote_port

    def _forward(self) -> None:
        """Forward a free local loopback port to the helper and check it answers.

        Raises ``_ForwardRefused`` when the helper listens on a Unix socket and
        the forward can't be made or carries nothing (sshd accepts the
        forward request but refuses each connection when socket forwarding is
        disabled), so ``run`` can fall back to a loopback port.
        """
        self._set("starting", "Forwarding a local port to the helper…")
        _ensure_no_proxy_for_loopback()
        unix = bool(self.remote_socket)
        last_error = ""
        for _attempt in range(2 if unix else 5):
            port = _free_local_port()
            try:
                argv = cmd.forward_argv(self.host, self.user, self._mux_path(), port, self._remote_endpoint())
            except cmd.SshCommandError as exc:
                raise (_ForwardRefused if unix else RemoteSourceError)(str(exc)) from None
            result = _run(argv, timeout=20)
            if result.returncode != 0:
                last_error = _clean_stderr(result.stderr)
                continue
            self.local_port = port
            # The state stays "starting" until run() has finished: a poller that
            # saw "connected" here would get a forward that may yet be refused.
            try:
                self.json("ping", timeout=10.0, probe=True)
            except RemoteSourceError as exc:
                last_error = str(exc)
                self._cancel_forward()
                continue
            self.register_redactions()
            return
        if unix:
            raise _ForwardRefused(last_error)
        raise RemoteSourceError(f"Could not forward a local port to {self.host}: {last_error}")

    def _cancel_forward(self) -> None:
        remote = self._remote_endpoint()
        if self.local_port and remote:
            try:
                _run(cmd.forward_argv(self.host, self.user, self._mux_path(), self.local_port, remote,
                                      cancel=True), timeout=10)
            except cmd.SshCommandError:
                pass
        self.local_port = None

    def _stop_helper(self) -> None:
        proc = self.proc
        if proc is None:
            return
        try:
            if proc.stdin:
                proc.stdin.close()  # the helper exits on EOF
        except OSError:
            pass
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()

    def close(self, *, close_master: bool = False) -> None:
        self.cancelled.set()
        self._cancel_forward()
        self._stop_helper()
        if close_master and self.own_master and self.control_path:
            _run(cmd.exit_master_argv(self.host, self.user, self.control_path), timeout=10)
        self._set("disconnected", f"Disconnected from {self.target}.")


class SshSource(RemoteSource):
    scheme = "ssh"
    label = "Cluster (SSH)"

    def __init__(self) -> None:
        self._connections: dict[str, SshConnection] = {}
        self._lock = threading.RLock()

    # -- connections -----------------------------------------------------
    def describe(self, *, probe: bool = False) -> dict[str, Any]:
        try:
            binary = cmd.ssh_binary()
            available, problem = True, None
        except cmd.SshCommandError as exc:
            binary, available, problem = None, False, str(exc)
        if sys.platform == "win32":
            available, problem = False, (
                "Windows' ssh can't share connections (ControlMaster). Run FiberBrowser in WSL.")
        with self._lock:
            connections = list(self._connections.values())
        return {
            "scheme": self.scheme,
            "label": self.label,
            "available": available,
            "problem": problem,
            "ssh": bool(binary),
            "hosts": cmd.ssh_config_hosts() if available else [],
            "connections": [c.public_dict(probe=probe) for c in connections],
        }

    def connect(self, params: dict[str, Any]) -> dict[str, Any]:
        host = cmd.validate_host(str(params.get("host") or "").strip())
        user = cmd.validate_user(str(params.get("user") or "").strip() or None)
        remote_python = cmd.validate_remote_python(str(params.get("remote_python") or "").strip() or None)
        roots = [str(r).strip() for r in (params.get("roots") or []) if str(r).strip()]
        for root in roots:
            if "\x00" in root or len(root) > 1024 or not (root.startswith("/") or root.startswith("~") or root.startswith("$")):
                raise RemoteSourceError(f"Folder must be an absolute path, ~ or $VAR/...: {root!r}")
        persist = str(params.get("persist") or DEFAULT_PERSIST)
        if not persist.isalnum():
            raise RemoteSourceError("ControlPersist must be like 30m, 4h or yes.")
        idle = int(params.get("idle_timeout") or DEFAULT_IDLE_TIMEOUT)
        auth_timeout = float(params.get("auth_timeout") or DEFAULT_AUTH_TIMEOUT)
        open_terminal = bool(params.get("open_terminal", True))
        target = f"{user}@{host}" if user else host
        with self._lock:
            existing = self._connections.get(target)
            if existing and existing.state in ("starting", "authenticating"):
                return existing.public_dict()
            if existing:
                existing.close()
            conn = SshConnection(host, user, roots or ["~"], remote_python=remote_python,
                                 persist=persist, idle_timeout=idle)
            self._connections[target] = conn
        thread = threading.Thread(target=conn.run, kwargs={"open_terminal": open_terminal,
                                                           "auth_timeout": auth_timeout},
                                  daemon=True, name=f"fb-ssh-connect-{host}")
        thread.start()
        if params.get("wait"):
            thread.join(float(params.get("wait")))
        return conn.public_dict()

    def disconnect(self, target: str, **options) -> dict[str, Any]:
        with self._lock:
            conn = self._connections.pop(target, None)
        if conn is None:
            return {"success": False, "error": f"Not connected to {target}"}
        conn.close(close_master=bool(options.get("close_master")))
        return {"success": True, "target": target}

    def disconnect_all(self) -> None:
        with self._lock:
            conns = list(self._connections.values())
            self._connections.clear()
        for conn in conns:
            try:
                conn.close()
            except Exception:
                pass

    def connection_for(self, ref: str, *, required: bool = True) -> Optional[SshConnection]:
        user, host, _path = parse_ssh_ref(ref)
        target = f"{user}@{host}" if user else host
        with self._lock:
            conn = self._connections.get(target)
            others = [c for c in self._connections.values() if c.host == host and c is not conn]
        if conn is None or not conn.alive():
            conn = None
            # The same account under another spelling (``hpc`` vs ``me@hpc``)
            # only when both sides are known to sign in as the same user: an
            # explicit user never borrows a connection whose account is unknown.
            alive = [c for c in others if c.alive()]
            if alive:
                wanted = user or default_user_for(host)
                if wanted:
                    conn = next((c for c in alive if c.effective_user() == wanted), None)
        if conn is None or not conn.alive():
            if required:
                from services.runtime import get_lab_mode
                if get_lab_mode():
                    raise RemoteSourceError(f"{ref} is on a cluster; a shared lab server does not open "
                                            "cluster references (put the file under one of its data folders).")
                raise NotConnectedError(
                    f"Not connected to {target}. Use Connect to cluster… to open {ref}.",
                    scheme="ssh", target=target)
            return None
        return conn

    def is_connected(self, ref: str) -> bool:
        try:
            return self.connection_for(ref, required=False) is not None
        except (RemoteSourceError, cmd.SshCommandError):
            return False

    # -- browsing --------------------------------------------------------
    def list(self, ref: str) -> dict[str, Any]:
        conn = self.connection_for(ref)
        _user, _host, path = parse_ssh_ref(ref)
        payload = conn.json("ls", query={"path": path}, timeout=30.0)
        if payload.get("error"):
            raise RemoteSourceError(payload["error"])
        payload["ref"] = make_ssh_ref(conn.user, conn.host, payload.get("path") or path)
        return payload

    def stat(self, ref: str, *, max_age: float = 15.0) -> Optional[dict[str, Any]]:
        conn = self.connection_for(ref)
        _user, _host, path = parse_ssh_ref(ref)
        return conn.stat(path, max_age=max_age)

    # -- opening ---------------------------------------------------------
    def open_url(self, ref: str) -> str:
        conn = self.connection_for(ref)
        _user, _host, path = parse_ssh_ref(ref)
        return conn.file_url(path)

    def _download(self, ref: str, sink, max_bytes: int, expected_version: Optional[str]) -> Optional[str]:
        """Copy a whole file into ``sink`` as byte ranges; returns the file version.

        Every range must carry the version the file had when the copy began
        (the helper's ETag): a file replaced or rewritten meanwhile raises
        instead of yielding a mix of old and new bytes.
        """
        conn = self.connection_for(ref)
        _user, _host, path = parse_ssh_ref(ref)
        info = conn.stat(path, max_age=0)
        if info is None or info.get("type") != "file":
            raise RemoteSourceError(f"{ref} is not a file under the shared folders.")
        version = info.get("version")
        if expected_version and version and version != expected_version:
            raise RemoteFileChanged(f"{ref} changed on the cluster; open it again.")
        size = int(info.get("size") or 0)
        if size > max_bytes:
            raise RemoteSourceError(f"{ref} is larger than {max_bytes // (1024 * 1024)} MB.")
        url = conn.file_url(path)
        offset = 0
        try:
            while offset < size:
                end = min(offset + FETCH_CHUNK_BYTES, size) - 1
                request = urllib.request.Request(url, headers={"Range": f"bytes={offset}-{end}"})
                with _NO_PROXY_OPENER.open(request, timeout=300.0) as resp:
                    etag = (resp.headers.get("ETag") or "").strip('"')
                    if resp.status != 206 or (version and etag != version):
                        raise RemoteFileChanged(f"{ref} changed on the cluster while it was being copied; try again.")
                    while True:
                        chunk = resp.read(1 << 20)
                        if not chunk:
                            break
                        offset += len(chunk)
                        if offset > end + 1:
                            raise RemoteSourceError(f"{ref}: the cluster sent more bytes than asked for.")
                        sink.write(chunk)
                if offset != end + 1:
                    raise RemoteFileChanged(f"{ref} changed on the cluster while it was being copied; try again.")
        except urllib.error.HTTPError as exc:
            if exc.code in (404, 416):
                raise RemoteFileChanged(f"{ref} changed on the cluster while it was being copied; try again.") from None
            raise RemoteSourceError(f"Download of {ref} failed (helper error {exc.code}).") from None
        except (urllib.error.URLError, OSError) as exc:
            raise RemoteSourceError(f"Download of {ref} failed: {getattr(exc, 'reason', exc)}") from None
        return version

    def fetch_bytes(self, ref: str, max_bytes: int = MAX_FETCH_BYTES) -> bytes:
        import io
        sink = io.BytesIO()
        self._download(ref, sink, max_bytes, None)
        return sink.getvalue()

    def fetch_to_file(self, ref: str, dest: str, max_bytes: int = MAX_FETCH_BYTES,
                      expected_version: Optional[str] = None) -> Optional[str]:
        """Download ``ref`` to ``dest`` (atomically); returns the version copied."""
        tmp = dest + f".part-{secrets.token_hex(4)}"
        try:
            with open(tmp, "wb") as out:
                version = self._download(ref, out, max_bytes, expected_version)
            os.replace(tmp, dest)
            return version
        finally:
            if os.path.exists(tmp):
                try:
                    os.remove(tmp)
                except OSError:
                    pass
