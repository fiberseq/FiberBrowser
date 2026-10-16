"""Build the fixed ``ssh`` command lines FiberBrowser runs (argv lists only).

Nothing here runs a shell locally. Host and user names come from the UI, so
they are validated before they reach an argv: a host must be a plain host
name / ``~/.ssh/config`` alias (letters, digits, ``.``, ``_``, ``-``; never a
leading ``-``), which rules out option injection such as
``-oProxyCommand=...``, and every command puts ``--`` before the host.

The remote command is one fixed string (``REMOTE_COMMAND``): it finds a
Python >= 3.6 and runs a tiny bootstrap that reads the helper script from
stdin. The only user-controlled part is an optional absolute path to a
remote Python, validated to a safe character set.
"""
from __future__ import annotations

import glob
import os
import re
import shlex
import shutil
import sys
from typing import Optional

HOST_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$")
USER_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$")
REMOTE_PYTHON_RE = re.compile(r"^/[A-Za-z0-9._+/-]{1,255}$")
# The helper's socket path as it reports it (a mkdtemp folder under /tmp,
# $TMPDIR or $XDG_RUNTIME_DIR): no ':' or spaces, which -L would misread.
REMOTE_SOCKET_RE = re.compile(r"^/[A-Za-z0-9._/-]{1,200}$")

BOOTSTRAP = "import sys;exec(sys.stdin.buffer.read(int(sys.stdin.buffer.readline())))"
DEFAULT_PYTHONS = ("python3", "/usr/bin/python3", "python")
NO_PYTHON_MARKER = "FBHELPER_NO_PYTHON"
NO_PYTHON_EXIT = 97

# Environment overrides (trusted: set by whoever launches the server, never by the UI).
SSH_BINARY_ENV = "FIBERBROWSER_SSH"
SSH_CONFIG_ENV = "FIBERBROWSER_SSH_CONFIG"


class SshCommandError(ValueError):
    """A host, user or path that may not be put on an ssh command line."""


def validate_host(host: str) -> str:
    host = host or ""
    if not isinstance(host, str) or not HOST_RE.fullmatch(host) or ".." in host:
        raise SshCommandError(
            "Host must be a host name or a Host alias from your ~/.ssh/config "
            "(letters, digits, '.', '_' and '-')."
        )
    return host


def validate_user(user: Optional[str]) -> Optional[str]:
    user = user or ""
    if not user:
        return None
    if not isinstance(user, str) or not USER_RE.fullmatch(user):
        raise SshCommandError("User name may contain letters, digits, '.', '_' and '-' only.")
    return user


def validate_remote_python(path: Optional[str]) -> Optional[str]:
    path = path or ""
    if not path:
        return None
    if not isinstance(path, str) or not REMOTE_PYTHON_RE.fullmatch(path) or "/../" in path + "/":
        raise SshCommandError("Remote Python must be an absolute path such as /usr/bin/python3.")
    return path


def ssh_binary() -> str:
    override = os.environ.get(SSH_BINARY_ENV)
    if override:
        return override
    found = shutil.which("ssh")
    if not found:
        raise SshCommandError(
            "No 'ssh' program was found. Install OpenSSH (it ships with macOS and Linux)."
        )
    return found


def ssh_config_path() -> Optional[str]:
    override = os.environ.get(SSH_CONFIG_ENV)
    return override or None


def base_argv() -> list[str]:
    argv = [ssh_binary()]
    config = ssh_config_path()
    if config:
        argv += ["-F", config]
    return argv


def target_args(host: str, user: Optional[str]) -> list[str]:
    """``[-l user] -- host``: always last, after every option."""
    args = []
    if user:
        args += ["-l", validate_user(user)]
    return args + ["--", validate_host(host)]


def control_path_arg(control_path: str) -> str:
    """A literal filesystem path as ssh's ``-S`` / ControlPath value.

    ssh expands ``%h``, ``%u``, ``%%`` ... in ControlPath even when it comes
    from ``-S``, so a literal ``%`` in the path (a home folder such as
    ``/Users/a%b``) must be written ``%%``.
    """
    return control_path.replace("%", "%%")


def mux_args(control_path: Optional[str]) -> list[str]:
    """Use FiberBrowser's control socket, or (None) the user's own ControlPath."""
    return ["-S", control_path_arg(control_path)] if control_path else []


def check_master_argv(host: str, user: Optional[str], control_path: Optional[str]) -> list[str]:
    return base_argv() + mux_args(control_path) + ["-O", "check"] + target_args(host, user)


def exit_master_argv(host: str, user: Optional[str], control_path: str) -> list[str]:
    return base_argv() + mux_args(control_path) + ["-O", "exit"] + target_args(host, user)


def start_master_argv(host: str, user: Optional[str], control_path: str, persist: str,
                      *, batch: bool) -> list[str]:
    """Open a background ControlMaster (``-M -N -f``) that later commands share."""
    argv = base_argv() + [
        "-M", "-S", control_path_arg(control_path),
        "-o", f"ControlPersist={persist}",
        "-o", "ServerAliveInterval=30",
        "-o", "ServerAliveCountMax=4",
        "-o", "ConnectTimeout=20",
        # The master only carries FiberBrowser's sessions: none of the user's
        # configured forwards or RemoteCommand.
        "-o", "ClearAllForwardings=yes",
        "-o", "RemoteCommand=none",
        "-N", "-f",
    ]
    if batch:
        argv += ["-o", "BatchMode=yes"]
    return argv + target_args(host, user)


def validate_remote_socket(path: str) -> str:
    if not isinstance(path, str) or not REMOTE_SOCKET_RE.fullmatch(path) or "/../" in path + "/":
        raise SshCommandError("The helper reported an unexpected socket path.")
    return path


def forward_argv(host: str, user: Optional[str], control_path: Optional[str],
                 local_port: int, remote: "int | str", *, cancel: bool = False) -> list[str]:
    """Forward 127.0.0.1:<local_port> on this computer to the helper.

    ``remote`` is the helper's Unix socket path on the login node (an OpenSSH
    local-to-socket forward: only this account can reach the socket) or,
    when the site refuses socket forwarding, its 127.0.0.1 port there.
    """
    if isinstance(remote, str):
        spec = f"127.0.0.1:{int(local_port)}:{validate_remote_socket(remote)}"
    else:
        spec = f"127.0.0.1:{int(local_port)}:127.0.0.1:{int(remote)}"
    return (base_argv() + mux_args(control_path)
            + ["-O", "cancel" if cancel else "forward", "-L", spec]
            + target_args(host, user))


def config_user_argv(host: str, user: Optional[str] = None) -> list[str]:
    """``ssh -G``: the settings ssh would use for this host, without connecting."""
    return base_argv() + ["-G"] + target_args(host, user)


def parse_config_user(output: str) -> Optional[str]:
    """The ``user`` line of ``ssh -G`` output (the account ssh would sign in as)."""
    for line in (output or "").splitlines():
        key, _sep, value = line.strip().partition(" ")
        if key.lower() == "user" and value.strip():
            try:
                return validate_user(value.strip())
            except SshCommandError:
                return None
    return None


def remote_command(remote_python: Optional[str] = None) -> str:
    """The one fixed remote command: find Python >= 3.6, run the stdin bootstrap.

    Wrapped in ``sh -c '...'`` so csh/tcsh login shells run it the same way.
    It contains no single quotes of its own, so the outer quoting is exact.
    """
    candidates = list(DEFAULT_PYTHONS)
    python = validate_remote_python(remote_python)
    if python:
        candidates.insert(0, python)
    check = "import sys; sys.exit(0 if sys.version_info >= (3, 6) else 1)"
    script = (
        f"for p in {' '.join(candidates)}; do "
        f"if command -v \"$p\" >/dev/null 2>&1 && \"$p\" -c \"{check}\" >/dev/null 2>&1; then "
        f"exec \"$p\" -u -c \"{BOOTSTRAP}\"; fi; done; "
        f"echo {NO_PYTHON_MARKER} >&2; exit {NO_PYTHON_EXIT}"
    )
    assert "'" not in script
    return f"sh -c '{script}'"


def helper_argv(host: str, user: Optional[str], control_path: Optional[str],
                remote_python: Optional[str] = None) -> list[str]:
    """Run the helper over the shared connection; never prompts (BatchMode)."""
    return (base_argv() + mux_args(control_path)
            + ["-o", "ControlMaster=no", "-o", "BatchMode=yes", "-o", "RemoteCommand=none",
               "-o", "ClearAllForwardings=yes", "-T"]
            + target_args(host, user) + [remote_command(remote_python)])


def shell_command(argv: list[str]) -> str:
    """The argv as one line a user can paste into a terminal."""
    return " ".join(shlex.quote(part) for part in argv)


# --------------------------------------------------------------------------
# ~/.ssh/config Host aliases (for the host picker)
# --------------------------------------------------------------------------

def _config_files(path: str, seen: set[str], depth: int = 0) -> list[str]:
    path = os.path.expanduser(path)
    if depth > 4 or path in seen or not os.path.isfile(path):
        return []
    seen.add(path)
    files = [path]
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            lines = handle.readlines()
    except OSError:
        return files
    for line in lines:
        parts = line.strip().split(None, 1)
        if len(parts) == 2 and parts[0].lower() == "include":
            for pattern in shlex.split(parts[1]):
                pattern = os.path.expanduser(pattern)
                if not os.path.isabs(pattern):
                    pattern = os.path.join(os.path.expanduser("~/.ssh"), pattern)
                for match in sorted(glob.glob(pattern)):
                    files.extend(_config_files(match, seen, depth + 1))
    return files


def ssh_config_hosts(config_path: Optional[str] = None) -> list[dict]:
    """Concrete ``Host`` aliases (no wildcards) with their HostName/User, if given."""
    path = config_path or ssh_config_path() or "~/.ssh/config"
    hosts: dict[str, dict] = {}
    for file in _config_files(path, set()):
        try:
            with open(file, encoding="utf-8", errors="replace") as handle:
                lines = handle.readlines()
        except OSError:
            continue
        current: list[str] = []
        for line in lines:
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            match = re.match(r"^([A-Za-z]+)(?:\s*=\s*|\s+)(.*)$", stripped)
            if not match:
                continue
            key, value = match.group(1).lower(), match.group(2).strip()
            if key == "host":
                current = []
                for alias in value.split():
                    if any(ch in alias for ch in "*?!") or not HOST_RE.fullmatch(alias):
                        continue
                    hosts.setdefault(alias, {"alias": alias})
                    current.append(alias)
            elif key == "match":
                current = []
            elif key in ("hostname", "user") and current:
                for alias in current:
                    hosts[alias].setdefault(key, value)
    return sorted(hosts.values(), key=lambda h: h["alias"].lower())


def terminal_script(command: str) -> str:
    """A small sh script that runs the sign-in command in a terminal window.

    It holds no secret: only the fixed ssh command. The user types the
    password / answers Duo there; FiberBrowser only waits for the master.
    """
    return (
        "#!/bin/sh\n"
        "echo 'FiberBrowser: signing in to the cluster. Answer the password / Duo prompts below.'\n"
        f"{command}\n"
        "status=$?\n"
        "echo\n"
        "if [ $status -eq 0 ]; then echo 'Connected. You can close this window and go back to FiberBrowser.';"
        " else echo \"ssh exited with status $status.\"; fi\n"
        "printf 'Press Enter to close. '; read _\n"
    )


def terminal_launch_argv(script_path: str) -> Optional[list[str]]:
    """A local terminal window running ``script_path``, or None (the UI then shows the command).

    macOS: ``open -a Terminal`` (no Automation permission needed). WSL (the
    Windows app): a Windows console window running the script in this
    distribution. Linux: the first terminal emulator found. Windows has no
    ControlMaster support.
    """
    if sys.platform == "darwin" and shutil.which("open"):
        return ["open", "-a", "Terminal", script_path]
    if sys.platform.startswith("linux"):
        from services import wsl_interop
        if wsl_interop.is_wsl():
            argv = wsl_interop.terminal_argv(script_path)
            if argv:
                return argv
        for term, flag in (("x-terminal-emulator", "-e"), ("gnome-terminal", "--"),
                           ("konsole", "-e"), ("xfce4-terminal", "-x"), ("xterm", "-e")):
            if shutil.which(term):
                return [term, flag, "sh", script_path]
    return None
