"""Keep other websites (and DNS-rebound hostnames) away from the API.

The browser app and the Jupyter client talk to the server from its own
origin (or, for the Vite dev server, through its same-origin proxy), so no
cross-origin access is needed. Without this guard any web page open in the
same browser could drive a local FiberBrowser: send it requests (CSRF) or,
by rebinding a hostname to 127.0.0.1, read the replies.

- Requests a browser marks as cross-site (Sec-Fetch-Site, or an Origin that
  isn't this server) are refused unless the origin is listed in
  FIBERBROWSER_CORS_ORIGINS (comma-separated), which also enables CORS for it.
- When the server listens on loopback only, the Host header must be a
  loopback name (FIBERBROWSER_ALLOWED_HOSTS adds more), which stops DNS
  rebinding. Set with set_allowed_hosts() at startup; unset means no check.
"""
from __future__ import annotations

import os
from typing import Optional
from urllib.parse import urlparse

from fastapi import FastAPI
from fastapi.responses import JSONResponse

LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})

_allowed_hosts: Optional[frozenset[str]] = None


def cors_origins() -> list[str]:
    return [o.strip().rstrip("/") for o in os.environ.get("FIBERBROWSER_CORS_ORIGINS", "").split(",") if o.strip()]


def extra_allowed_hosts() -> set[str]:
    return {h.strip().lower() for h in os.environ.get("FIBERBROWSER_ALLOWED_HOSTS", "").split(",") if h.strip()}


def set_allowed_hosts(hosts: Optional[set[str]]) -> None:
    """Host names the server answers to (None: any)."""
    global _allowed_hosts
    _allowed_hosts = frozenset(h.lower() for h in hosts) if hosts is not None else None


def allowed_hosts_for_bind(bind_host: str) -> Optional[set[str]]:
    """Loopback-only servers answer to loopback names; others to any host unless configured."""
    extra = extra_allowed_hosts()
    if bind_host in LOOPBACK_HOSTS:
        return set(LOOPBACK_HOSTS) | extra
    return extra or None


def _hostname(value: str) -> str:
    value = (value or "").strip().lower()
    if value.startswith("["):  # [::1]:8000
        return value[1:value.find("]")] if "]" in value else value
    return value.rsplit(":", 1)[0] if value.count(":") == 1 else value


def _origin_matches_host(origin: str, host_header: str, scheme: str = "http") -> bool:
    """Same scheme-independent host and the same effective port as this request."""
    parsed = urlparse(origin)
    if not parsed.hostname:
        return False
    origin_host = parsed.hostname.lower()
    try:
        origin_port = parsed.port or (443 if parsed.scheme == "https" else 80)
    except ValueError:
        return False
    host = (host_header or "").strip().lower()
    req_host = _hostname(host)
    req_port = host.rsplit(":", 1)[1] if host.count(":") == 1 or (host.startswith("[") and "]:" in host) else None
    if origin_host != req_host:
        return False
    effective = int(req_port) if req_port and req_port.isdigit() else (443 if scheme == "https" else 80)
    return origin_port == effective


def forwarded_headers_believed(peer: Optional[str]) -> bool:
    """X-Forwarded-Host/-Proto may describe the page's origin (and the cookie scheme).

    - A lab server: only from a proxy listed explicitly (auth.trusted_proxies in
      the config file, --trusted-proxy, FIBERBROWSER_TRUSTED_PROXIES); with no
      list, never. Behind Open OnDemand (no list: the portal's proxy address isn't
      known) the browser's own Fetch Metadata (Sec-Fetch-Site: same-origin) is
      what lets its requests through.
    - A --public server: from a listed proxy; with no list configured, from any
      peer (a browser can't set these headers on a cross-site request).
    - A personal server: always (Uvicorn may already have replaced the peer).
    """
    if peer is None:
        return True
    from services.runtime import get_host_public_mode, get_lab_mode
    if not (get_lab_mode() or get_host_public_mode()):
        # A personal server: Uvicorn's proxy-header handling may already have
        # replaced the peer by the browser's address, so it can't be judged here.
        return True
    from services.public_protection import explicitly_trusted_proxies, is_trusted_proxy
    if get_lab_mode():
        return explicitly_trusted_proxies() and is_trusted_proxy(peer)
    return not explicitly_trusted_proxies() or is_trusted_proxy(peer)


def request_allowed(headers, path: str, scheme: str = "http", peer: Optional[str] = None) -> Optional[str]:
    """None when allowed, else the reason for refusing (``peer``: the TCP peer's
    address, which decides whether forwarded headers are believed)."""
    host = headers.get("host", "")
    believe_forwarded = forwarded_headers_believed(peer)
    forwarded = (headers.get("x-forwarded-proto") or "").split(",")[0].strip().lower() if believe_forwarded else ""
    scheme = forwarded or scheme
    if _allowed_hosts is not None and _hostname(host) not in _allowed_hosts:
        return "Unknown Host header"
    if not ("/" + path.lstrip("/")).startswith("/api/"):
        return None
    origin = (headers.get("origin") or "").rstrip("/")
    if origin and origin in cors_origins():
        return None
    site = (headers.get("sec-fetch-site") or "").lower()
    if site == "cross-site":
        return "Cross-site request"
    if site == "same-site":
        # e.g. another port on localhost: only this server's own origin.
        if not origin or not _origin_matches_host(origin, host, scheme):
            return "Cross-origin request"
        return None
    if origin and origin != "null" and not _origin_matches_host(origin, host, scheme) and site != "same-origin":
        # Behind a reverse proxy that rewrites Host (Open OnDemand, Apache
        # without ProxyPreserveHost) the page's origin is the proxy's host,
        # which the proxy passes on as X-Forwarded-Host. A cross-site page
        # can't set that header on a browser request (it isn't CORS-safelisted).
        forwarded_host = (headers.get("x-forwarded-host") or "").split(",")[0].strip() if believe_forwarded else ""
        if not (forwarded_host and _origin_matches_host(origin, forwarded_host, scheme)):
            return "Cross-origin request"
    if origin == "null" and site != "same-origin":
        return "Cross-origin request"
    return None


def install_request_origin_guard(app: FastAPI) -> None:
    origins = cors_origins()
    if origins:
        from fastapi.middleware.cors import CORSMiddleware
        app.add_middleware(CORSMiddleware, allow_origins=origins, allow_credentials=True,
                           allow_methods=["*"], allow_headers=["*"])

    @app.middleware("http")
    async def request_origin_guard(request, call_next):
        peer = request.client.host if request.client else ""
        reason = request_allowed(request.headers, request.url.path, request.url.scheme, peer=peer)
        if reason:
            return JSONResponse(status_code=403, content={"success": False, "message": f"{reason}: refused"})
        return await call_next(request)
