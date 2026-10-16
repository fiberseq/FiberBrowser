"""Port probing helpers used by browser launch/runtime code."""
from __future__ import annotations

import errno
import socket
import subprocess
import sys


def something_listens(port: int, host: str = "127.0.0.1", timeout: float = 0.5) -> bool:
    """True when a server accepts connections on ``host:port``.

    Only a listener counts. A port with nothing but leftovers of a stopped
    server (its TIME_WAIT entries, or an open tab's CLOSE_WAIT client sockets)
    is free: the next server binds it with SO_REUSEADDR, as uvicorn does. A
    test bind would get this wrong both ways (without SO_REUSEADDR it fails on
    TIME_WAIT; with it, a 0.0.0.0 bind succeeds next to a 127.0.0.1 listener
    on macOS), so ask the port instead.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        try:
            code = sock.connect_ex((host, port))
        except OSError:
            return True
    # Refused: nobody listens. A timeout or anything else: assume taken.
    return code not in (errno.ECONNREFUSED, getattr(errno, "WSAECONNREFUSED", errno.ECONNREFUSED))


def _listening_pid(port: int) -> int | None:
    """The PID of a process listening on the TCP port (lsof), or None.

    Raises FileNotFoundError / TimeoutExpired / ValueError when lsof can't say.
    """
    # -sTCP:LISTEN: only listeners. `lsof -i :PORT` alone also names any
    # client connected to the port, e.g. the browser tab of a server that just
    # crashed, and the relaunch then moved to the next port (a new origin,
    # without the page's autosave).
    result = subprocess.run(
        ["lsof", "-nP", "-t", f"-iTCP:{port}", "-sTCP:LISTEN"],
        capture_output=True,
        text=True,
        timeout=5,
    )
    out = result.stdout.strip()
    if result.returncode == 0 and out:
        return int(out.split("\n")[0])
    if result.returncode not in (0, 1):  # 1: nothing matched
        raise ValueError(result.stderr)
    return None


def can_bind(port: int, host: str = "127.0.0.1") -> bool:
    """Whether a server can bind ``host:port`` the way uvicorn does.

    SO_REUSEADDR on POSIX (asyncio's default there), so a stopped server's
    TIME_WAIT entries don't count; plain on Windows, where SO_REUSEADDR would
    share a live port. This catches what the connect probe can't: a socket
    bound but not listening, or (Linux, --public's 0.0.0.0) a listener on
    another address only.
    """
    try:
        infos = socket.getaddrinfo(host or None, port, type=socket.SOCK_STREAM, flags=socket.AI_PASSIVE)
    except (OSError, UnicodeError):
        return True  # can't tell; let the server's own bind report it
    family, socktype, proto, _, address = infos[0]
    with socket.socket(family, socktype, proto) as sock:
        if sys.platform != "win32":
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(address)
        except OSError:
            return False
    return True


def check_port_in_use(port: int, host: str = "127.0.0.1") -> int | None:
    """Return the PID listening on a port, -1 if taken with unknown PID, or None if free.

    ``host`` is the address the server will bind (127.0.0.1, or 0.0.0.0 in
    public mode).
    """
    try:
        pid = _listening_pid(port)
        if pid is not None:
            return pid
    except (FileNotFoundError, subprocess.TimeoutExpired, ValueError, OSError):
        pass
    # No lsof (Windows), or something lsof doesn't list: another user's
    # listener, a socket bound but not listening.
    if something_listens(port) or not can_bind(port, host):
        return -1
    return None
