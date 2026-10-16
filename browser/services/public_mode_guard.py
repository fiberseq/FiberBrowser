"""Public/read-only mode request guard.

In ``--public`` mode every ``/api`` route is denied unless its (method,
route template) is on ``PUBLIC_ALLOWED``: browsing, catalog loading and
per-visitor analysis. New routes are therefore closed until someone
decides they are safe for anonymous visitors (tests/test_public_mode_guard.py
fails for a route that is on neither list).

Routes on the allowlist that take something dangerous in some forms check
public mode themselves: /api/render (headless only, no session files),
/api/load_genome (the catalog's genome only), /api/datasets/{id}/chemistry
(not saved to the BAM) and consensus jobs (no client-chosen cache directory).

A public server shows the host's curated catalog and nothing else: no route
reachable by a visitor takes a URL or a path the server would open or fetch.
Adding tracks by URL (/api/add_track) and the external track search
(UCSC, ENCODE, ChIP-Atlas, which the server fetches on the visitor's behalf)
are refused; the host offers reference tracks through the catalog's
``tracks`` instead. A tour tab of a local server (a sandbox) is the owner's own
machine and keeps the track search (EXTERNAL_TRACK_ROUTES).
"""
from __future__ import annotations

import ipaddress
from collections.abc import Callable
from urllib.parse import urlparse

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from starlette.routing import Match

_GET = "GET"
_POST = "POST"
_DELETE = "DELETE"

PUBLIC_ALLOWED: frozenset[tuple[str, str]] = frozenset({
    # --- the app itself and read-only data
    (_GET, "/"), (_GET, "/dafc"), (_GET, "/favicon.ico"),
    (_GET, "/api/health"), (_GET, "/api/status"), (_GET, "/api/version"), (_GET, "/api/chroms"), (_GET, "/api/genomes"),
    (_GET, "/api/datasets"), (_GET, "/api/datasets/with_contig"),
    (_GET, "/api/catalog"), (_GET, "/api/plugins/registry"),
    (_GET, "/api/datasets/{dataset_id}/assembly"), (_GET, "/api/genome/check"),  # genome mismatch: report only
    (_GET, "/api/panel_genomes"),  # datasets' own references: listing only (loading one is local work)
    (_GET, "/api/genes"), (_GET, "/api/gene_search"), (_GET, "/api/sequence"),
    (_GET, "/api/fire"), (_GET, "/api/coverage"), (_GET, "/api/meta"), (_GET, "/api/meta_all"),
    (_GET, "/api/reads/compact"), (_GET, "/api/reads/compact_all"), (_GET, "/api/reads/random_window"), (_GET, "/api/reads/top_windows"),
    # insertion lens: read-only views of loaded datasets
    (_GET, "/api/insertions/clusters"), (_GET, "/api/insertions/lens"),
    (_GET, "/api/reads/info"), (_GET, "/api/working_set_info"), (_GET, "/api/reference_pairs"),
    (_GET, "/api/quality_filters"), (_GET, "/api/legacy_layer_inference"), (_GET, "/api/read_end_footprints"),
    (_GET, "/api/tracks"), (_GET, "/api/tracks/{track_idx}"), (_GET, "/api/tracks/{track_idx}/annotations"),
    (_GET, "/api/tracks/{track_idx}/export"),
    (_GET, "/api/overlays"), (_GET, "/api/overlays/{overlay_id}/marks"),
    (_GET, "/api/annotations/files"), (_GET, "/api/annotations/region"), (_GET, "/api/annotations/profile"),
    (_GET, "/api/render/live_state"),
    # contact maps / co-accessibility (read-only views of data loaded at startup)
    (_GET, "/api/coacc/arcs"), (_GET, "/api/coacc/matrix/data"), (_GET, "/api/coacc/matrix/image"),
    (_GET, "/api/coacc/metadata"), (_GET, "/api/coacc/slice"), (_GET, "/api/coacc/strip"),
    (_GET, "/api/dafc/status"), (_GET, "/api/dafc/matrix/data"), (_GET, "/api/dafc/matrix/image"),
    (_GET, "/api/dafc/select"),
    (_GET, "/api/microc/arcs"), (_GET, "/api/microc/expected_status"), (_GET, "/api/microc/matrix/data"),
    (_GET, "/api/microc/matrix/strip"), (_GET, "/api/microc/virtual4c"),
    (_GET, "/api/motifs/jaspar/search"),  # the bundled offline JASPAR database
    (_POST, "/api/motifs/parse"),  # parses pasted motif text; no files, no network
    # consensus results of this visitor's own jobs
    (_GET, "/api/footprint/consensus/schema"), (_GET, "/api/footprint/consensus/jobs"),
    (_GET, "/api/footprint/consensus/jobs/{job_id}"), (_GET, "/api/footprint/consensus/jobs/{job_id}/call"),
    (_GET, "/api/footprint/consensus/jobs/{job_id}/catalog"),
    (_GET, "/api/footprint/consensus/jobs/{job_id}/curation"),
    (_GET, "/api/footprint/consensus/jobs/{job_id}/export"),
    (_GET, "/api/footprint/consensus/jobs/{job_id}/state-reads"),
    # per-read states of selected features (footprint classes, a plugin pack's kinds) of this visitor's own runs
    (_POST, "/api/features/states"),
    # read-name sets for this visitor's own read requests (a split panel's subset)
    (_POST, "/api/read_sets"),

    # --- this visitor's own session (per-session state only)
    (_POST, "/api/catalog/load"), (_POST, "/api/catalog/unload"),
    (_POST, "/api/catalog/tracks/load"), (_POST, "/api/catalog/tracks/unload"),
    (_POST, "/api/load_genome"),  # the catalog's genome only (checked in the route)
    (_DELETE, "/api/datasets/{dataset_id}"), (_POST, "/api/datasets/merge"), (_POST, "/api/datasets/unmerge"),
    (_POST, "/api/datasets/{dataset_id}/chemistry"),  # never saved to the BAM (checked in the route)
    (_POST, "/api/datasets/{dataset_id}/refresh_capabilities"),
    (_POST, "/api/quality_filters"), (_POST, "/api/legacy_layer_inference"), (_POST, "/api/clear_cache"),
    (_POST, "/api/read_end_footprints"),
    (_POST, "/api/tracks/batch"), (_POST, "/api/tracks/export"), (_POST, "/api/tracks/reorder"),
    (_POST, "/api/tracks/{track_idx}/filter"), (_DELETE, "/api/tracks/{track_idx}"),
    (_POST, "/api/tracks/add_motif_sequence"), (_POST, "/api/tracks/add_motif_pwm"),
    (_POST, "/api/tracks/add_motif_jaspar"),
    (_DELETE, "/api/overlays/{overlay_id}"),
    (_POST, "/api/annotations/activate"), (_POST, "/api/annotations/deactivate"),
    (_POST, "/api/annotations/filter"), (_POST, "/api/annotations/set_threshold"),
    (_POST, "/api/annotations/cluster"), (_DELETE, "/api/annotations/{file_id}"),
    (_POST, "/api/session/export"),

    # --- analysis on this visitor's reads
    (_POST, "/api/scan_peaks"), (_POST, "/api/detect_peaks"),
    (_POST, "/api/cluster"), (_POST, "/api/cluster_all"), (_POST, "/api/cluster_expand"),
    (_POST, "/api/cluster_matched_views"),
    (_POST, "/api/cluster_projection"), (_POST, "/api/cluster/vplot"), (_POST, "/api/assign_to_clusters"),
    (_POST, "/api/dissolve_cluster"), (_POST, "/api/auto_cull_clusters"),
    (_POST, "/api/filter"), (_POST, "/api/filter_by_analysis_rule"), (_POST, "/api/filter_by_transcription_state"),
    (_POST, "/api/sort_reads"), (_POST, "/api/pol2_com"), (_POST, "/api/autozoom"),
    (_POST, "/api/footprint/analyze"), (_POST, "/api/footprint/consensus/lattice"),
    (_POST, "/api/reads/stats"), (_POST, "/api/reads/compile"), (_POST, "/api/render/compile"),
    (_POST, "/api/quality/impact"),
    (_POST, "/api/reads/locate"),  # read names in the open datasets (budgeted scan)
    (_POST, "/api/sv/split"), (_GET, "/api/sv/insert_seq"),  # SV alleles / inserted bases of the catalog's reads
    # SNPs, allele groups, SVs and SV-SNP linkage of the catalog's reads (a bounded view)
    (_POST, "/api/variants/snps"), (_POST, "/api/variants/alleles"),
    (_POST, "/api/variants/svs"), (_POST, "/api/variants/sv_linkage"),
    (_POST, "/api/render"),  # headless engine, no session files (checked in the route)
    (_POST, "/api/footprint/consensus/jobs"),  # no client-chosen cache dir (checked in the route)
    (_DELETE, "/api/footprint/consensus/jobs/{job_id}"),
    (_POST, "/api/footprint/consensus/jobs/{job_id}/activate"),
    (_POST, "/api/footprint/consensus/jobs/{job_id}/curation"),
    (_POST, "/api/footprint/consensus/jobs/{job_id}/filters"),
    (_POST, "/api/footprint/consensus/jobs/{job_id}/stage"),

    # --- session links (routes check FIBERBROWSER_LINK_HOSTS themselves: off
    # on a public server unless the operator lists link hosts)
    (_GET, "/open"), (_GET, "/api/session-links/config"), (_POST, "/api/session-links"),
    (_GET, "/api/session-links/status"), (_GET, "/api/session-links/{link_id}"),
    (_POST, "/api/session-links/{link_id}/open"), (_DELETE, "/api/session-links/{link_id}"),
})

# Plugin packs' routes a public server serves (plugins/packs.py).
from plugins.packs import pack_routes as _pack_routes  # noqa: E402

PUBLIC_ALLOWED = PUBLIC_ALLOWED | _pack_routes("public")

# External track search and add-by-URL: the server fetches what the visitor
# names. Refused on a --public server; a tour tab of a local server keeps them.
EXTERNAL_TRACK_ROUTES: frozenset[tuple[str, str]] = frozenset({
    (_GET, "/api/ucsc/browse"), (_GET, "/api/ucsc/curated"), (_GET, "/api/ucsc/search"),
    (_GET, "/api/encode/facets"), (_GET, "/api/encode/search"),
    (_GET, "/api/chipatlas/facets"), (_GET, "/api/chipatlas/search"), (_GET, "/api/chipatlas/status"),
    (_POST, "/api/add_track"),
})

# Hosts /api/add_track may fetch from in a tour tab (the external track
# browsers' sources).
PUBLIC_TRACK_HOSTS = ("ucsc.edu", "encodeproject.org", "chip-atlas.dbcls.jp", "dbcls.jp")

DENIED_MESSAGE = "This action is disabled on a public FiberBrowser server."


def public_track_url_allowed(path: str) -> bool:
    """An https URL on a known external track host (tour tabs; no local paths, no internal hosts)."""
    try:
        url = urlparse(str(path))
    except ValueError:
        return False
    host = (url.hostname or "").lower().rstrip(".")
    if url.scheme != "https" or not host:
        return False
    try:
        ipaddress.ip_address(host)
        return False  # bare IPs are never a known track host
    except ValueError:
        pass
    return any(host == h or host.endswith("." + h) for h in PUBLIC_TRACK_HOSTS)


class RouteEntry:
    """One servable route, flattened: its full path template, methods and matcher.

    FastAPI < 0.142 keeps every included route in ``app.router.routes`` with
    its prefixed ``path``. FastAPI 0.142 keeps ``_IncludedRouter`` branches
    there instead (no ``path``) and exposes the effective routes through
    ``fastapi.routing.iter_route_contexts``. Both shapes flatten to this.
    """

    __slots__ = ("path", "methods", "_matcher", "_regex")

    def __init__(self, path: str, methods, matcher=None):
        self.path = path
        self.methods = frozenset(m.upper() for m in (methods or ()))
        self._matcher = matcher
        self._regex = None
        if matcher is None:
            from starlette.routing import compile_path
            self._regex = compile_path(path)[0]

    def matches(self, scope) -> Match:
        if self._matcher is not None:
            match, _ = self._matcher.matches(scope)
            return match
        if scope.get("type") != "http" or not self._regex.match(scope.get("path") or ""):
            return Match.NONE
        method = scope.get("method") or ""
        return Match.FULL if not self.methods or method in self.methods else Match.PARTIAL


def _iter_route_entries_uncached(app: FastAPI):
    routes = list(app.router.routes)
    try:
        from fastapi.routing import iter_route_contexts  # FastAPI >= 0.142
    except ImportError:
        iter_route_contexts = None
    if iter_route_contexts is None:
        for route in routes:
            path = getattr(route, "path", None)
            if path is not None:
                yield RouteEntry(path, getattr(route, "methods", None), route)
        return
    for context in iter_route_contexts(routes):
        path = context.path
        if path is None:
            continue
        original = context.route
        try:
            starlette_route = getattr(context, "starlette_route", None)
        except AttributeError:
            starlette_route = None
        if starlette_route is not None and hasattr(starlette_route, "matches"):
            matcher = starlette_route  # mounts and plain routes of included routers
        elif getattr(original, "path", None) == path and hasattr(original, "matches"):
            matcher = original  # a route on the app itself
        else:
            matcher = None  # an APIRoute under a router prefix: match its full template
        yield RouteEntry(path, context.methods, matcher)


_entries_cache: dict[int, tuple[tuple, list[RouteEntry]]] = {}


def iter_route_entries(app: FastAPI) -> list[RouteEntry]:
    """Every route of ``app`` with its full path template (any FastAPI version).

    Cached per app until its top-level route list changes (plugins are
    included after the first requests in ``main()``).
    """
    key = tuple(id(r) for r in app.router.routes)
    cached = _entries_cache.get(id(app))
    if cached is not None and cached[0] == key:
        return cached[1]
    entries = list(_iter_route_entries_uncached(app))
    _entries_cache[id(app)] = (key, entries)
    return entries


def route_template(app: FastAPI, scope) -> str | None:
    """The matched route's path template (e.g. /api/tracks/{track_idx}), or None."""
    partial = None
    for entry in iter_route_entries(app):
        match = entry.matches(scope)
        if match == Match.FULL:
            return entry.path
        if match == Match.PARTIAL and partial is None:
            partial = entry.path
    return partial


def public_request_allowed(app: FastAPI, scope) -> bool:
    path = "/" + (scope.get("path") or "").lstrip("/")
    method = scope.get("method") or ""
    if method == "OPTIONS":
        # CORS preflight from an origin the host configured; the real request
        # is still checked against the allowlist.
        from services.request_origin_guard import cors_origins
        origin = ""
        for name, value in scope.get("headers") or []:
            if name == b"origin":
                origin = value.decode("latin-1").rstrip("/")
        return bool(origin) and origin in cors_origins()
    if path.startswith("/assets/"):
        return method in ("GET", "HEAD")
    template = route_template(app, scope)
    if template is None:
        # Unknown paths 404 as usual; nothing to guard. (A --public server has
        # no /docs, /redoc or /openapi.json at all: public_protection.remove_api_docs.)
        return not path.startswith("/api/")
    if method == "HEAD":
        method = "GET"
    if (method, template) in PUBLIC_ALLOWED:
        return True
    from services.runtime import current_sandbox_id
    if current_sandbox_id() is not None:
        # A tour tab (a sandbox inside a local server) may also load the demo.
        from state.sandbox import SANDBOX_EXTRA_ALLOWED
        return (method, template) in SANDBOX_EXTRA_ALLOWED or (method, template) in EXTERNAL_TRACK_ROUTES
    return False


def install_public_mode_guard(app: FastAPI, is_public_mode: Callable[[], bool]) -> None:
    """Install middleware that allows only PUBLIC_ALLOWED routes in public mode."""

    @app.middleware("http")
    async def public_mode_guard(request, call_next):
        if is_public_mode() and not public_request_allowed(app, request.scope):
            return JSONResponse(status_code=403, content={"success": False, "message": DENIED_MESSAGE})
        return await call_next(request)
