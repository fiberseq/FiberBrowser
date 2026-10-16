"""The ports test servers may use (FIBERBROWSER_TEST_PORTS), and a probe that sees every listener.

A comma-separated FIBERBROWSER_TEST_PORTS replaces the default list. The default is 8880-8889 without 8886 and
8888, which a developer's own FiberBrowser and Jupyter servers use. A port counts as free only when nothing accepts
a connection on 127.0.0.1 (or ::1) and it can be bound: with SO_REUSEADDR (which servers use, so TIME_WAIT leftovers
don't count) a macOS bind succeeds next to a listener bound to another address, so a bind alone is fooled.
"""
from __future__ import annotations

import errno
import os
import socket
import sys

DEFAULT_TEST_PORTS = (8880, 8881, 8882, 8883, 8884, 8885, 8887, 8889)


def test_ports_from_env(environ=None) -> tuple[int, ...]:
    raw = (os.environ if environ is None else environ).get("FIBERBROWSER_TEST_PORTS", "").strip()
    if not raw:
        return DEFAULT_TEST_PORTS
    ports = tuple(int(p) for p in raw.replace(" ", "").split(",") if p)
    if not ports or any(not 1 <= p <= 65535 for p in ports):
        raise ValueError(f"FIBERBROWSER_TEST_PORTS must list ports: {raw!r}")
    return ports


test_ports_from_env.__test__ = False  # not a pytest test
TEST_PORTS = test_ports_from_env()


def _listens(port: int, host: str) -> bool:
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    try:
        with socket.socket(family, socket.SOCK_STREAM) as sock:
            sock.settimeout(0.5)
            code = sock.connect_ex((host, port))
    except OSError:
        return False  # no such address family / interface here
    return code not in (errno.ECONNREFUSED, errno.EADDRNOTAVAIL, errno.ENETUNREACH)


def port_is_free(port: int) -> bool:
    """Nothing listens on the port (any local address) and both 127.0.0.1 and 0.0.0.0 can be bound."""
    if _listens(port, "127.0.0.1") or (socket.has_ipv6 and _listens(port, "::1")):
        return False
    for host in ("127.0.0.1", "0.0.0.0"):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            # As uvicorn binds: a stopped test server's TIME_WAIT entries leave the port free.
            if sys.platform != "win32":
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind((host, port))
            except OSError:
                return False
    return True


def free_ports(exclude=()) -> list[int]:
    return [p for p in TEST_PORTS if p not in exclude and port_is_free(p)]


def no_free_port_error() -> RuntimeError:
    return RuntimeError(f"No free test port in {', '.join(map(str, TEST_PORTS))} (FIBERBROWSER_TEST_PORTS)")


def bind_test_port(sock, host="127.0.0.1"):
    """Bind a test listener without taking over another task's port (tests/port_list.py)."""
    import socket
    import sys
    if sys.platform != "win32":
        # As servers bind: a stopped test server's TIME_WAIT entries don't keep the port (a short port list
        # would otherwise run out between tests).
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    for port in free_ports():
        try:
            sock.bind((host, port))
            return port
        except OSError:
            continue
    raise no_free_port_error()


def free_test_port():
    import socket
    with socket.socket() as sock:
        return bind_test_port(sock)
