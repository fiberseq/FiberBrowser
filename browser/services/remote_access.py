"""Who is asking: the owner at this computer, or a client from elsewhere.

A personal FiberBrowser (not ``--public``, not a lab server) can read the
owner's files, start processes, use their SSH and S3 credentials and stop
itself. Those powers belong to the owner's own browser on this computer. A
request that reaches the server from anywhere else gets at most a read-only
set of routes, whatever credential it carries.

Request scopes (``request_scope``):

``owner``
    The TCP peer is a loopback address **and** the request carries no sign of
    having passed through a proxy **and** its Host header is a loopback name.
    The owner's browser tab, the desktop app's window, ``browser_client`` and
    the headless render worker all talk to ``127.0.0.1``/``localhost``
    directly and never send proxy headers.
``remote``
    Anything else. A reverse proxy on this computer (``tailscale serve``,
    Caddy, nginx, an SSH tunnel's far end on another host) connects from
    loopback, so the peer address alone never decides: proxy markers
    (``X-Forwarded-*``, ``Forwarded``, ``X-Real-IP``, ``Via``, Tailscale's
    ``Tailscale-User-*`` identity headers) or a non-loopback Host header make
    the request remote. A peer that isn't an IP address (a Unix socket, an
    unparseable value) is remote too: the check fails closed.
``viewer``
    Reserved for the mobile plan's viewer credentials (a revocable viewer
    token, a tailnet identity or a viewer PIN). Nothing issues it yet; when
    something does, ``request_scope`` returns it and the guard below limits
    it to ``VIEWER_ALLOWED`` (see docs/deployment/index.md, "Remote access").

Headers can only make a request *more* remote, never the owner: every marker
is checked for presence, none is believed for an address. Uvicorn rewrites the
peer from ``X-Forwarded-For`` only when the connecting peer is itself
``127.0.0.1`` (its ``forwarded_allow_ips`` default), so a client on the
network can't make its peer look like loopback; and a client that sends
``X-Forwarded-For`` through such a proxy is remote anyway, because the header
is a proxy marker.

What each scope may do (``install_remote_access_guard``):

- owner: everything (the token check in ``services/local_auth.py`` still applies);
- remote: only ``REMOTE_ALLOWED``, a subset of the public server's allowlist
  (``services/public_mode_guard.PUBLIC_ALLOWED``). New routes are owner-only
  until someone adds them here (tests/test_remote_access.py fails for a
  public-allowlisted route that is in neither ``REMOTE_ALLOWED`` nor
  ``REMOTE_EXCLUDED``);
- a personal server with the access token turned off answers no remote
  client at all: on a loopback bind the only way in from elsewhere is a proxy,
  and nothing would identify the caller.

Lifecycle routes (shutdown beacon, Quit, tab heartbeats) are owner-only on top
of that (``owner_request``, checked in routers/utility.py), so a phone tab can
never stop the owner's server or count as one of its open tabs.

Public and lab servers keep their own rules (public_mode_guard, services/lab/auth.py).

``bind_refusal`` is the startup half: a personal server never listens on a
network interface with the access token off.
"""
from __future__ import annotations

import contextvars
import ipaddress
from collections.abc import Callable
from typing import Optional

from fastapi import FastAPI
from fastapi.responses import JSONResponse

from services.public_mode_guard import route_template

OWNER = "owner"
REMOTE = "remote"
VIEWER = "viewer"

# Present on a request that came through a reverse proxy (or that pretends to:
# either way it is not the owner's direct connection). Lower-case, as ASGI has them.
PROXY_MARKER_HEADERS: frozenset[bytes] = frozenset({
    b"x-forwarded-for", b"x-forwarded-proto", b"x-forwarded-host", b"x-forwarded-port",
    b"x-forwarded-server", b"x-forwarded-prefix", b"x-forwarded-user", b"forwarded",
    b"x-real-ip", b"via", b"true-client-ip", b"cf-connecting-ip", b"x-client-ip",
    # Tailscale Serve's identity headers (tailscale.com/kb/1312/serve, "Identity headers")
    b"tailscale-user-login", b"tailscale-user-name", b"tailscale-user-profile-pic",
    b"tailscale-headers-info",
})

LOOPBACK_NAMES = frozenset({"localhost", "127.0.0.1", "::1"})

_GET, _POST, _DELETE = "GET", "POST", "DELETE"

# Routes on the public allowlist that a remote client of a personal server may
# NOT use, with the reason. A personal server shares one state between every
# client, and the public allowlist relies on in-route checks that only fire on
# a public server.
REMOTE_EXCLUDED: dict[tuple[str, str], str] = {
    # in-route safeguards that only apply on a --public server
    (_POST, "/api/render"): "may read session files by path (checked in the route only on public servers)",
    (_POST, "/api/load_genome"): "loads any genome/FASTA by path (catalog-only on public servers)",
    (_POST, "/api/datasets/{dataset_id}/chemistry"): "may write the chemistry into the BAM",
    # jobs (footprint classes run FiberHMM consensus on this computer)
    (_POST, "/api/footprint/consensus/jobs"): "starts a job",
    (_DELETE, "/api/footprint/consensus/jobs/{job_id}"): "job management",
    (_POST, "/api/footprint/consensus/jobs/{job_id}/activate"): "job management",
    (_POST, "/api/footprint/consensus/jobs/{job_id}/curation"): "job management",
    (_POST, "/api/footprint/consensus/jobs/{job_id}/filters"): "job management",
    (_POST, "/api/footprint/consensus/jobs/{job_id}/stage"): "job management",
    # what the owner's session has loaded (one shared state on a personal server)
    (_POST, "/api/catalog/load"): "loads datasets into the owner's session",
    (_POST, "/api/catalog/unload"): "unloads the owner's datasets",
    (_POST, "/api/catalog/tracks/load"): "loads tracks into the owner's session",
    (_POST, "/api/catalog/tracks/unload"): "unloads the owner's tracks",
    (_DELETE, "/api/datasets/{dataset_id}"): "unloads the owner's dataset",
    (_POST, "/api/datasets/merge"): "changes the owner's datasets",
    (_POST, "/api/datasets/unmerge"): "changes the owner's datasets",
    (_POST, "/api/datasets/{dataset_id}/refresh_capabilities"): "re-reads the owner's files",
    (_DELETE, "/api/tracks/{track_idx}"): "removes the owner's track",
    (_POST, "/api/tracks/reorder"): "track management",
    (_POST, "/api/tracks/add_motif_sequence"): "track management",
    (_POST, "/api/tracks/add_motif_pwm"): "track management",
    (_POST, "/api/tracks/add_motif_jaspar"): "track management",
    (_DELETE, "/api/overlays/{overlay_id}"): "removes the owner's overlay",
    (_DELETE, "/api/annotations/{file_id}"): "removes the owner's annotation file",
    # server control
    (_POST, "/api/clear_cache"): "server control",
    # session links: the server fetches the linked document and opens its files
    (_POST, "/api/session-links"): "the server fetches a URL the client names",
    (_GET, "/api/session-links/{link_id}"): "the server fetches a URL the client named",
    (_POST, "/api/session-links/{link_id}/open"): "opens files into the owner's session",
    (_DELETE, "/api/session-links/{link_id}"): "link management",
    (_GET, "/api/session-links/status"): "the server probes the owner's signed URLs",
    (_GET, "/api/footprint/consensus/jobs/{job_id}/export"): "writes an export file into the job's folder",
}

# Viewing and per-view analysis (clustering, filters, sorting, peak scans,
# read lookups, exports of what is on screen). On a personal server these act
# on the owner's single state until viewer scopes get their own view state.
# Listed one by one (not derived from PUBLIC_ALLOWED): a route added to the
# public allowlist stays owner-only here until someone decides, and
# tests/test_remote_access.py fails until it is in this set or REMOTE_EXCLUDED.
REMOTE_ALLOWED: frozenset[tuple[str, str]] = frozenset({
    # the app's pages and read-only data
    (_GET, "/"), (_GET, "/dafc"), (_GET, "/favicon.ico"), (_GET, "/open"),
    (_GET, "/api/health"), (_GET, "/api/status"), (_GET, "/api/version"), (_GET, "/api/chroms"),
    (_GET, "/api/genomes"), (_GET, "/api/genome/check"), (_GET, "/api/panel_genomes"),
    (_GET, "/api/datasets"), (_GET, "/api/datasets/with_contig"), (_GET, "/api/datasets/{dataset_id}/assembly"),
    (_GET, "/api/catalog"), (_GET, "/api/plugins/registry"),
    (_GET, "/api/genes"), (_GET, "/api/gene_search"), (_GET, "/api/sequence"),
    (_GET, "/api/fire"), (_GET, "/api/coverage"), (_GET, "/api/meta"), (_GET, "/api/meta_all"),
    (_GET, "/api/reads/compact"), (_GET, "/api/reads/compact_all"), (_GET, "/api/reads/random_window"),
    (_GET, "/api/reads/top_windows"), (_GET, "/api/reads/info"), (_GET, "/api/working_set_info"),
    (_GET, "/api/reference_pairs"), (_GET, "/api/insertions/clusters"), (_GET, "/api/insertions/lens"),
    (_GET, "/api/quality_filters"), (_GET, "/api/legacy_layer_inference"), (_GET, "/api/read_end_footprints"),
    (_GET, "/api/tracks"), (_GET, "/api/tracks/{track_idx}"), (_GET, "/api/tracks/{track_idx}/annotations"),
    (_GET, "/api/tracks/{track_idx}/export"), (_POST, "/api/tracks/batch"), (_POST, "/api/tracks/export"),
    (_GET, "/api/overlays"), (_GET, "/api/overlays/{overlay_id}/marks"),
    (_GET, "/api/annotations/files"), (_GET, "/api/annotations/region"), (_GET, "/api/annotations/profile"),
    (_GET, "/api/render/live_state"),
    (_GET, "/api/coacc/arcs"), (_GET, "/api/coacc/matrix/data"), (_GET, "/api/coacc/matrix/image"),
    (_GET, "/api/coacc/metadata"), (_GET, "/api/coacc/slice"), (_GET, "/api/coacc/strip"),
    (_GET, "/api/dafc/status"), (_GET, "/api/dafc/matrix/data"), (_GET, "/api/dafc/matrix/image"),
    (_GET, "/api/dafc/select"),
    (_GET, "/api/microc/arcs"), (_GET, "/api/microc/expected_status"), (_GET, "/api/microc/matrix/data"),
    (_GET, "/api/microc/matrix/strip"), (_GET, "/api/microc/virtual4c"),
    (_GET, "/api/motifs/jaspar/search"), (_POST, "/api/motifs/parse"),
    (_GET, "/api/sv/insert_seq"), (_GET, "/api/session-links/config"),
    # results of footprint-class runs (reading only; running and curating are owner-only)
    (_GET, "/api/footprint/consensus/schema"), (_GET, "/api/footprint/consensus/jobs"),
    (_GET, "/api/footprint/consensus/jobs/{job_id}"), (_GET, "/api/footprint/consensus/jobs/{job_id}/call"),
    (_GET, "/api/footprint/consensus/jobs/{job_id}/catalog"),
    (_GET, "/api/footprint/consensus/jobs/{job_id}/curation"),
    (_GET, "/api/footprint/consensus/jobs/{job_id}/state-reads"),
    (_POST, "/api/footprint/consensus/lattice"),
    # view settings and per-view analysis (the one shared view on a personal server)
    (_POST, "/api/quality_filters"), (_POST, "/api/legacy_layer_inference"), (_POST, "/api/read_end_footprints"),
    (_POST, "/api/tracks/{track_idx}/filter"),
    (_POST, "/api/annotations/activate"), (_POST, "/api/annotations/deactivate"),
    (_POST, "/api/annotations/filter"), (_POST, "/api/annotations/set_threshold"),
    (_POST, "/api/annotations/cluster"),
    (_POST, "/api/scan_peaks"), (_POST, "/api/detect_peaks"),
    (_POST, "/api/cluster"), (_POST, "/api/cluster_all"), (_POST, "/api/cluster_expand"),
    (_POST, "/api/cluster_matched_views"), (_POST, "/api/cluster_projection"), (_POST, "/api/cluster/vplot"),
    (_POST, "/api/assign_to_clusters"), (_POST, "/api/dissolve_cluster"), (_POST, "/api/auto_cull_clusters"),
    (_POST, "/api/filter"), (_POST, "/api/filter_by_analysis_rule"), (_POST, "/api/filter_by_transcription_state"),
    (_POST, "/api/sort_reads"), (_POST, "/api/pol2_com"), (_POST, "/api/autozoom"),
    (_POST, "/api/footprint/analyze"), (_POST, "/api/reads/stats"), (_POST, "/api/reads/compile"),
    (_POST, "/api/render/compile"), (_POST, "/api/quality/impact"), (_POST, "/api/reads/locate"),
    (_POST, "/api/sv/split"),
    # fb-n11 (integ/fb35): a filtered read set's names (bounded, in memory) and the selected features'
    # read states (read-only, cached per view)
    (_POST, "/api/read_sets"), (_POST, "/api/features/states"),
    # the Variants panel's scans (read-only, cached per view)
    (_POST, "/api/variants/snps"), (_POST, "/api/variants/alleles"), (_POST, "/api/variants/svs"),
    (_POST, "/api/variants/sv_linkage"),
    (_POST, "/api/session/export"),  # the session JSON as a download (nothing written on the server)
})

# Plugin packs' routes a remote viewer may call (plugins/packs.py).
from plugins.packs import pack_routes as _pack_routes  # noqa: E402

REMOTE_ALLOWED = REMOTE_ALLOWED | _pack_routes("remote")

# The viewer scope (mobile plan, "Show on phone" / no-QR access). Today the
# same set as REMOTE_ALLOWED; narrowing it later never touches the guard.
VIEWER_ALLOWED: frozenset[tuple[str, str]] = REMOTE_ALLOWED

ALLOWED_BY_SCOPE: dict[str, frozenset[tuple[str, str]]] = {REMOTE: REMOTE_ALLOWED, VIEWER: VIEWER_ALLOWED}

# Server lifecycle: owner only (also checked in the routes, routers/utility.py).
LIFECYCLE_ROUTES: frozenset[tuple[str, str]] = frozenset({
    (_GET, "/api/shutdown"), (_POST, "/api/shutdown"), (_POST, "/api/quit"),
    (_POST, "/api/tabs/heartbeat"), (_GET, "/api/cancel_shutdown"), (_POST, "/api/cancel_shutdown"),
})

REMOTE_DENIED_MESSAGE = ("This action is only available in FiberBrowser on the computer it runs on "
                         "(requests from other devices get a read-only view).")
NO_TOKEN_REMOTE_MESSAGE = ("This FiberBrowser has its access token turned off, so it only answers "
                           "browsers on the computer it runs on.")
OWNER_ONLY_MESSAGE = "Only FiberBrowser on the computer it runs on can do this."


# --- classification -------------------------------------------------------------

def address_is_loopback(value) -> bool:
    """A loopback IP address (127.0.0.0/8, ::1, ::ffff:127.x); anything else is not.

    ``IPv6Address('::ffff:127.0.0.1').is_loopback`` is False before Python 3.13,
    so a mapped IPv4 address is unwrapped first.
    """
    text = str(value or "").strip()
    if text.startswith("[") and text.endswith("]"):
        text = text[1:-1]
    text = text.split("%", 1)[0]  # an IPv6 zone (fe80::1%en0)
    try:
        ip = ipaddress.ip_address(text)
    except ValueError:
        return False
    mapped = getattr(ip, "ipv4_mapped", None)
    if mapped is not None:
        ip = mapped
    return ip.is_loopback


def host_is_loopback(host_header: str) -> bool:
    """The Host header names this computer's loopback (localhost, 127.x, [::1]), any port."""
    from services.request_origin_guard import _hostname
    name = _hostname(host_header or "")
    if not name:
        return False
    return name in LOOPBACK_NAMES or address_is_loopback(name)


def proxy_markers(scope) -> list[str]:
    """Names of the proxy headers on this request (empty for a direct connection)."""
    return sorted({name.decode("latin-1") for name, _ in scope.get("headers") or []
                   if name.lower() in PROXY_MARKER_HEADERS})


def owner_request(scope) -> bool:
    """A direct connection from this computer to a loopback name, through no proxy."""
    client = scope.get("client")
    peer = client[0] if client else None
    if not address_is_loopback(peer):
        return False
    if proxy_markers(scope):
        return False
    host = ""
    for name, value in scope.get("headers") or []:
        if name == b"host":
            host = value.decode("latin-1")
            break
    return host_is_loopback(host)


def request_scope(scope) -> str:
    """owner, remote (or, once viewer credentials exist, viewer)."""
    return OWNER if owner_request(scope) else REMOTE


def _matched_route(app: FastAPI, scope):
    """The route entry that will handle this request (first full match), else None."""
    from starlette.routing import Match

    from services.public_mode_guard import iter_route_entries
    for entry in iter_route_entries(app):
        if entry.matches(scope) == Match.FULL:
            return entry
    return None


def _is_cors_preflight(scope) -> bool:
    from services.request_origin_guard import cors_origins
    origin = ""
    for name, value in scope.get("headers") or []:
        if name == b"origin":
            origin = value.decode("latin-1").rstrip("/")
    return bool(origin) and origin in cors_origins()


def remote_request_allowed(app: FastAPI, scope, allowed: frozenset[tuple[str, str]] = REMOTE_ALLOWED) -> bool:
    """Whether a non-owner request may reach its route (default deny).

    - OPTIONS only as a CORS preflight from an origin the owner configured
      (FIBERBROWSER_CORS_ORIGINS), which CORSMiddleware answers;
    - GET/HEAD of the frontend's static ``/assets`` mount (or nothing: a 404);
    - HEAD only when a GET route on the list answers it (Starlette adds HEAD to
      GET routes; a separate HEAD handler is not covered by its GET entry);
    - otherwise the matched (method, route template) must be on ``allowed``;
      unknown non-API pages 404 as usual. WebSockets are never allowed.
    """
    if scope.get("type") != "http":
        return False
    path = "/" + (scope.get("path") or "").lstrip("/")
    method = scope.get("method") or ""
    if method == "OPTIONS":
        return _is_cors_preflight(scope)
    entry = _matched_route(app, scope)
    if entry is None:
        if path.startswith("/api/"):
            return False
        # No route takes it: a 404 (or a 405 from a partial match, which runs nothing).
        return route_template(app, scope) is None or method in ("GET", "HEAD")
    if path.startswith("/assets/") and entry.path == "/assets" and method in ("GET", "HEAD"):
        return True  # the frontend's static files (services/frontend_mount.py)
    if method == "HEAD":
        return "GET" in entry.methods and ("GET", entry.path) in allowed
    return (method, entry.path) in allowed


def _guard_applies() -> bool:
    from services.runtime import get_host_public_mode, get_lab_mode
    return not (get_host_public_mode() or get_lab_mode())


_current_scope: contextvars.ContextVar[str] = contextvars.ContextVar("fiberbrowser_request_scope", default=OWNER)


def current_request_is_remote() -> bool:
    """Inside a request of a personal server: whether a non-owner client sent it."""
    return _current_scope.get() != OWNER


class RemoteAccessGuard:
    """ASGI middleware: HTTP and WebSocket requests of non-owner clients of a
    personal server reach only their scope's allowlist; WebSockets never."""

    def __init__(self, app, fastapi_app: FastAPI, auth_enabled: Callable[[], bool]):
        self.app = app
        self.fastapi_app = fastapi_app
        self.auth_enabled = auth_enabled

    async def __call__(self, scope, receive, send):
        if scope.get("type") not in ("http", "websocket") or not _guard_applies():
            return await self.app(scope, receive, send)
        scope_name = request_scope(scope)
        if scope_name == OWNER:
            return await self.app(scope, receive, send)
        if scope["type"] == "websocket":
            return await send({"type": "websocket.close", "code": 1008})
        if not self.auth_enabled():
            message = NO_TOKEN_REMOTE_MESSAGE
        elif not remote_request_allowed(self.fastapi_app, scope, ALLOWED_BY_SCOPE.get(scope_name, frozenset())):
            message = REMOTE_DENIED_MESSAGE
        else:
            token = _current_scope.set(scope_name)
            try:
                return await self.app(scope, receive, send)
            finally:
                _current_scope.reset(token)
        response = JSONResponse(status_code=403, content={"success": False, "message": message, "detail": message})
        return await response(scope, receive, send)


def install_remote_access_guard(app: FastAPI, auth_enabled: Optional[Callable[[], bool]] = None) -> None:
    """Limit non-owner requests of a personal server to their scope's allowlist."""
    if auth_enabled is None:
        from services.local_auth import auth_enabled as _auth_enabled
        auth_enabled = _auth_enabled
    app.add_middleware(RemoteAccessGuard, fastapi_app=app, auth_enabled=auth_enabled)


def lifecycle_refusal(request) -> Optional[JSONResponse]:
    """403 unless the owner asks (personal servers; public and lab servers have their own rules)."""
    if not _guard_applies() or owner_request(request.scope):
        return None
    return JSONResponse(status_code=403, content={"success": False, "message": OWNER_ONLY_MESSAGE,
                                                  "detail": OWNER_ONLY_MESSAGE})


# --- startup --------------------------------------------------------------------

def bind_is_loopback(host: Optional[str]) -> bool:
    """The server listens on loopback only (127.0.0.1, localhost, ::1)."""
    text = (host or "").strip().lower()
    return text in LOOPBACK_NAMES or address_is_loopback(text)


def personal_token_required(host: str, *, no_token_flag: bool) -> tuple[bool, Optional[str]]:
    """Whether a personal server requires its access token, and a note to print.

    ``--no-token`` and ``FIBERBROWSER_NO_TOKEN`` turn it off on any bind (a
    network bind then refuses to start, ``bind_refusal``); the settings file's
    ``require_token: false`` is a default for the loopback-only server and
    leaves the token on for a network bind.
    """
    from services.user_settings import token_disabled_source
    if no_token_flag:
        return False, None
    source = token_disabled_source()
    if source is None:
        return True, None
    if source == "settings" and not bind_is_loopback(host):
        return True, (f"Note: require_token=false in ~/.fiberhmm/browser_settings.json applies to 127.0.0.1 "
                      f"only; listening on {host}, the access token is on.")
    return False, None


def bind_refusal(host: str, *, token_required: bool, public_mode: bool, lab_mode: bool) -> Optional[str]:
    """Why a personal server must not start on this interface (None: it may)."""
    if public_mode or lab_mode or token_required or bind_is_loopback(host):
        return None
    return (
        f"FiberBrowser: refusing to listen on {host} with the access token off.\n"
        "  Every machine that can reach this address could read your files, run jobs, use your SSH and\n"
        "  S3 credentials and stop the server. Either:\n"
        "  - listen on this computer only (drop --host; the default is 127.0.0.1) and reach it through an\n"
        "    SSH tunnel or `tailscale serve` (docs/deployment/index.md, \"Remote access\"), or\n"
        "  - keep the access token on: remove --no-token and FIBERBROWSER_NO_TOKEN for this launch\n"
        "    (a require_token=false in ~/.fiberhmm/browser_settings.json only applies to 127.0.0.1).\n"
        "  Shared servers: use a lab server (--config, profile = \"lab\") or a read-only --public server."
    )
