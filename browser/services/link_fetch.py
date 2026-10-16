"""Fetching link documents (session JSON, track hub files) without SSRF.

A session link names a URL the *server* fetches. On a public server any
visitor can send one, and on a local server any web page can put one in
front of the user, so every fetch here:

- takes http(s) only (``https`` only where ``LinkPolicy.https_only``), and on
  a public server only hosts on the operator's allowlist;
- resolves the host name once, refuses private, loopback, link-local,
  multicast and reserved addresses (unless the policy allows private
  networks), and connects to exactly the address it checked (no second DNS
  lookup a rebinding name could change);
- follows at most ``MAX_REDIRECTS`` redirects, checking every hop again
  (scheme, allowlist, address);
- stops reading at ``max_bytes`` (a Content-Length over it is refused before
  the body is read) and after ``timeout`` seconds per read.
"""
from __future__ import annotations

import http.client
import ipaddress
import os
import socket
import ssl
from dataclasses import dataclass, field
from typing import Callable, Optional
from urllib.parse import urljoin, urlsplit

from services import signed_urls

MAX_REDIRECTS = 3
DEFAULT_TIMEOUT_S = 10.0
USER_AGENT = "FiberBrowser (session link)"

HOSTS_ENV = "FIBERBROWSER_LINK_HOSTS"


class LinkError(Exception):
    """A link that can't be fetched or used; the message is for the user."""


@dataclass(frozen=True)
class LinkPolicy:
    public: bool = False
    # Host names (and their subdomains) links may come from; empty: any host
    # (local servers only; a public server with no hosts accepts no links).
    allowed_hosts: tuple[str, ...] = ()
    https_only: bool = False
    allow_private: bool = True
    allow_s3: bool = True

    def host_allowed(self, host: str) -> bool:
        host = (host or "").lower().rstrip(".")
        if not self.allowed_hosts:
            return not self.public
        return any(host == h or host.endswith("." + h) for h in self.allowed_hosts)


def configured_hosts() -> tuple[str, ...]:
    raw = os.environ.get(HOSTS_ENV, "")
    return tuple(h.strip().lower().lstrip(".") for h in raw.split(",") if h.strip())


def policy_for_server(*, public: bool) -> LinkPolicy:
    """Links on a public server: https, allowlisted hosts, public addresses, no s3://."""
    hosts = configured_hosts()
    if public:
        return LinkPolicy(public=True, allowed_hosts=hosts, https_only=True, allow_private=False, allow_s3=False)
    return LinkPolicy(public=False, allowed_hosts=hosts, https_only=False, allow_private=True, allow_s3=True)


# ---------------------------------------------------------------------------- addresses

_ALWAYS_BLOCKED = [ipaddress.ip_network(n) for n in (
    "0.0.0.0/8", "169.254.0.0/16", "224.0.0.0/4", "240.0.0.0/4", "255.255.255.255/32",
    "::/128", "fe80::/10", "ff00::/8",
)]
_PRIVATE = [ipaddress.ip_network(n) for n in (
    "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8", "100.64.0.0/10",
    "192.0.0.0/24", "198.18.0.0/15", "::1/128", "fc00::/7", "fec0::/10",
)]


def address_problem(ip: str, *, allow_private: bool) -> Optional[str]:
    """Why a connection to ``ip`` is refused (None: allowed)."""
    try:
        addr = ipaddress.ip_address(ip.split("%", 1)[0])
    except ValueError:
        return "not an IP address"
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
        addr = addr.ipv4_mapped
    if any(addr in net for net in _ALWAYS_BLOCKED) or addr.is_multicast or addr.is_unspecified:
        return "a link-local, multicast or reserved address"
    if not allow_private and (addr.is_private or addr.is_loopback or addr.is_reserved
                              or any(addr in net for net in _PRIVATE)):
        return "a private or local-network address"
    return None


def resolve(host: str, port: int) -> list[str]:
    """Every address of ``host`` (tests replace this)."""
    infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return list(dict.fromkeys(info[4][0] for info in infos))


def check_url(url: str, policy: LinkPolicy, *, what: str = "link") -> None:
    """Scheme and host rules (no network); raises LinkError."""
    try:
        parts = urlsplit(url)
        parts.port  # out-of-range / non-numeric ports raise ValueError here
        parts.hostname
    except (ValueError, TypeError) as exc:
        raise LinkError(f"The {what} is not a valid URL.") from exc
    scheme = parts.scheme.lower()
    if scheme == "s3":
        if not policy.allow_s3:
            raise LinkError(f"The {what} is an s3:// URL; this server opens https links only.")
        if not parts.netloc:
            raise LinkError(f"The {what} is not a valid s3:// URL.")
        return
    if scheme not in ("http", "https"):
        raise LinkError(f"The {what} must be an https URL (got {scheme or 'no scheme'}).")
    if scheme == "http" and policy.https_only:
        raise LinkError(f"The {what} must use https.")
    host = (parts.hostname or "").lower()
    if not host:
        raise LinkError(f"The {what} has no host.")
    if parts.username or parts.password:
        raise LinkError(f"The {what} must not contain a user name or password.")
    if not policy.host_allowed(host):
        if policy.public and not policy.allowed_hosts:
            raise LinkError("Opening links is turned off on this server.")
        raise LinkError(f"{host} is not on this server's list of allowed link hosts.")
    if policy.public:
        try:
            ipaddress.ip_address(host)
            raise LinkError(f"The {what} must name a host, not an IP address.")
        except ValueError:
            pass


def checked_addresses(url: str, policy: LinkPolicy) -> list[str]:
    parts = urlsplit(url)
    port = parts.port or (443 if parts.scheme == "https" else 80)
    try:
        addresses = resolve(parts.hostname or "", port)
    except OSError as exc:
        raise LinkError(f"Cannot find the host {parts.hostname}.") from exc
    if not addresses:
        raise LinkError(f"Cannot find the host {parts.hostname}.")
    for ip in addresses:
        problem = address_problem(ip, allow_private=policy.allow_private)
        if problem:
            raise LinkError(f"{parts.hostname} points at {problem}; links may not reach it.")
    return addresses


# ---------------------------------------------------------------------------- connections

class _PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, host, port, ip, timeout):
        super().__init__(host, port, timeout=timeout)
        self._ip = ip

    def connect(self):
        self.sock = socket.create_connection((self._ip, self.port), self.timeout)


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host, port, ip, timeout, context=None):
        super().__init__(host, port, timeout=timeout, context=context or ssl.create_default_context())
        self._ip = ip

    def connect(self):
        sock = socket.create_connection((self._ip, self.port), self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


# Tests may point https at a local test server with its own certificate.
_ssl_context_factory: Callable[[], ssl.SSLContext] = ssl.create_default_context


@dataclass
class FetchResult:
    body: bytes
    url: str
    status: int
    headers: dict = field(default_factory=dict)


def _describe_status(status: int, url: str) -> str:
    shown = signed_urls.display_url(url)
    if status in (401, 403):
        return (f"{shown}: access denied (HTTP {status}). If this is a pre-signed link it has "
                "expired: reopen it from the source.")
    if status == 404:
        return f"{shown}: not found (HTTP 404)."
    return f"{shown}: the server answered HTTP {status}."


def needs_pinned_transport(policy: LinkPolicy) -> bool:
    """Whether files opened under ``policy`` must be read through the pinned
    transport (services.link_proxy) rather than by htslib / pyBigWig directly.

    Native readers resolve host names themselves and follow redirects anywhere,
    so they can only be handed a URL directly when the policy restricts nothing
    beyond what ``check_url`` checks up front: a local server with no host
    allowlist (any address, any redirect). Public and lab servers (public
    addresses only, allowlisted hosts) and local servers with an allowlist go
    through the pinned transport."""
    return bool(policy.public or not policy.allow_private or policy.allowed_hosts)


def open_pinned(url: str, policy: LinkPolicy, *, method: str = "GET", timeout: float = DEFAULT_TIMEOUT_S,
                what: str = "link", headers: Optional[dict] = None):
    """Send ``method`` to ``url`` under ``policy`` (see the module docstring),
    following checked redirects. Returns ``(response, connection, final_url)``
    with the response unread (any status but a redirect); the caller closes
    the connection. Raises LinkError."""
    current = url
    for _hop in range(MAX_REDIRECTS + 1):
        check_url(current, policy, what=what)
        if urlsplit(current).scheme.lower() == "s3":
            raise LinkError(f"The {what} must be an http(s) URL.")
        addresses = checked_addresses(current, policy)
        parts = urlsplit(current)
        port = parts.port or (443 if parts.scheme == "https" else 80)
        target = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
        last_error: Optional[Exception] = None
        response = None
        conn = None
        for ip in addresses:
            if parts.scheme == "https":
                conn = _PinnedHTTPSConnection(parts.hostname, port, ip, timeout, _ssl_context_factory())
            else:
                conn = _PinnedHTTPConnection(parts.hostname, port, ip, timeout)
            try:
                conn.request(method, target, headers={"User-Agent": USER_AGENT, "Accept": "*/*",
                                                      **(headers or {}), "Accept-Encoding": "identity"})
                response = conn.getresponse()
                break
            except (OSError, http.client.HTTPException) as exc:
                last_error = exc
                conn.close()
                conn = None
        if response is None:
            raise LinkError(f"Cannot reach {parts.hostname}: {signed_urls.redact_text(str(last_error))}")
        status = response.status
        if status in (301, 302, 303, 307, 308):
            location = response.getheader("Location")
            conn.close()
            if not location:
                raise LinkError(_describe_status(status, current))
            try:
                current = urljoin(current, location)
            except ValueError as exc:
                raise LinkError(f"{signed_urls.display_url(current)} redirected to an invalid address.") from exc
            continue
        return response, conn, current
    raise LinkError(f"Too many redirects fetching the {what}.")


def fetch(url: str, policy: LinkPolicy, *, max_bytes: int, timeout: float = DEFAULT_TIMEOUT_S,
          what: str = "link", headers: Optional[dict] = None) -> FetchResult:
    """GET ``url`` under ``policy`` (see the module docstring); raises LinkError."""
    response, conn, current = open_pinned(url, policy, timeout=timeout, what=what, headers=headers)
    try:
        status = response.status
        if status not in (200, 206):
            raise LinkError(_describe_status(status, current))
        length = response.getheader("Content-Length")
        if length and length.isdigit() and int(length) > max_bytes:
            raise LinkError(f"{signed_urls.display_url(current)} is too large "
                            f"({int(length):,} bytes; the limit is {max_bytes:,}).")
        body = response.read(max_bytes + 1)
        if len(body) > max_bytes:
            raise LinkError(f"{signed_urls.display_url(current)} is too large "
                            f"(more than {max_bytes:,} bytes).")
        return FetchResult(body=body, url=current, status=status,
                           headers={k.lower(): v for k, v in response.getheaders()})
    except (OSError, http.client.HTTPException) as exc:
        raise LinkError(f"Reading {signed_urls.display_url(current)} failed: {exc}") from exc
    finally:
        conn.close()


def probe_status(url: str, policy: LinkPolicy, *, timeout: float = 5.0) -> int:
    """HTTP status of a one-byte range read of ``url`` under ``policy`` (redirects
    followed and checked). Raises LinkError when the policy refuses the URL, a
    redirect, or the address, or the host can't be reached."""
    response, conn, _final = open_pinned(url, policy, timeout=timeout, what="file",
                                         headers={"Range": "bytes=0-0"})
    try:
        return int(response.status)
    finally:
        conn.close()
