"""Default-deny for live-lift datasets at the HTTP edge (DESIGN_LIVE_LIFT.md §3.10).

The services refuse lifted datasets themselves (``capability.require``,
``AnalysisReadQuery`` and ``Dataset.get_reads``); this guard is the safety net
that makes the refusal uniform. A request that names a ``bam_livelift``
dataset (``dataset_id`` / ``dataset_ids`` in the query or the JSON body,
``read_ids_by_dataset`` keys, a ``{dataset_id}`` path parameter, or a
``dataset_id`` inside ``viewports``/``windows``/``extra_regions``, including
their dataset-keyed selections) is answered 409 with
one notice unless its route is on ``LIFT_ALLOWED``: the display paths, the
lift routes and dataset bookkeeping. Routes added later are therefore closed
to lifted datasets until someone teaches them (tests/test_live_lift_refusals.py
walks every route).
"""
from __future__ import annotations

import json
from typing import Callable, Iterable, Optional

from fastapi.responses import JSONResponse
from starlette.routing import Match

_GET, _POST, _DELETE = "GET", "POST", "DELETE"

# Routes a lifted dataset may be named in (method, route template).
LIFT_ALLOWED: frozenset = frozenset({
    # Display paths (compact reads, coverage, locate) and the lift routes.
    (_GET, "/api/reads/compact"), (_GET, "/api/reads/compact_all"), (_GET, "/api/coverage"),
    (_GET, "/api/reads/locate"), (_POST, "/api/reads/locate"),
    # Prepared-cohort clustering only. All other analysis routes stay closed.
    (_POST, "/api/cluster_all"), (_POST, "/api/cluster_matched_views"),
    (_POST, "/api/cluster_projection"), (_POST, "/api/assign_to_clusters"),
    (_POST, "/api/dissolve_cluster"), (_POST, "/api/auto_cull_clusters"),
    # Toolbar Sort/Filter and Read Stats on the analysis cohort (graph features; capability "sort", "filter",
    # "read_stats"). Transcription-state filters and every other analysis stay closed.
    (_POST, "/api/sort_reads"), (_POST, "/api/filter"), (_POST, "/api/filter_by_analysis_rule"),
    (_POST, "/api/reads/stats"),
    # Versioned Differences workspace. Each service checks its own capability: inspect and lens use the projected
    # difference_split/difference_lens gates, compare reads only the map and FASTAs, and alternate blocks, observations
    # and sequence refuse anything but a native BAM.
    (_POST, "/api/differences/inspect"), (_POST, "/api/differences/lens"), (_POST, "/api/differences/compare"),
    (_POST, "/api/differences/alternate-blocks"), (_POST, "/api/differences/observations"),
    (_POST, "/api/differences/sequence"),
    # Dataset bookkeeping (list, remove, its assembly report).
    (_DELETE, "/api/datasets/{dataset_id}"), (_GET, "/api/datasets/{dataset_id}/assembly"),
    (_POST, "/api/datasets/{dataset_id}/refresh_capabilities"),
    # Browser-side read order, filter, highlights and selection (client state, no read access).
    (_GET, "/api/jupyter/order"), (_POST, "/api/jupyter/order"), (_DELETE, "/api/jupyter/order"),
    (_GET, "/api/jupyter/browser_order"), (_POST, "/api/jupyter/browser_order"),
    (_GET, "/api/jupyter/filter"), (_POST, "/api/jupyter/filter"), (_DELETE, "/api/jupyter/filter"),
    (_POST, "/api/jupyter/highlights"), (_GET, "/api/jupyter/selection"), (_POST, "/api/jupyter/selection"),
})
# Every /api/lift/* route takes lifted datasets (they are flag-gated on their own).
LIFT_PREFIX = "/api/lift/"
# Feature names for the notice, by route prefix (the rest: "This analysis").
_FEATURES = (
    ("/api/quality/impact", "quality_impact"),
    ("/api/datasets/merge", "merge"), ("/api/render", "figure"), ("/api/reads/compile", "figure"),
    ("/api/cluster", "clustering"), ("/api/assign_to_clusters", "clustering"), ("/api/dissolve_cluster", "clustering"),
    ("/api/auto_cull_clusters", "clustering"), ("/api/lab/cluster", "clustering"), ("/api/scan_peaks", "peaks"),
    ("/api/scan-correspondence", "peaks"), ("/api/coacc", "coaccessibility"), ("/api/reads/stats", "read_stats"),
    ("/api/reads/random_window", "random_window"), ("/api/reads/top_windows", "random_window"),
    ("/api/insertions", "insertion_lens"), ("/api/alt_allele", "alt_allele"), ("/api/sv/", "sv_summary"),
    ("/api/variants", "variants"), ("/api/footprint", "consensus"), ("/api/reads/export", "export"),
    ("/api/dafc", "dafc"), ("/api/meta", "metaprofile"), ("/api/reads/info", "dense_reads"),
    ("/api/reads/image", "dense_reads"), ("/api/reads/regions", "dense_reads"),
)
_NESTED = ("viewports", "windows", "extra_regions")
_DATASET_MAPS = ("read_ids_by_dataset", "read_ids", "cluster_assignments", "cluster_patterns")
_MAX_BODY = 4 * 1024 * 1024


def _route_template(app, scope) -> Optional[str]:
    for route in app.router.routes:
        match, _child = route.matches(scope)
        if match == Match.FULL:
            return getattr(route, "path", None)
    return None


def _split(values: Iterable) -> list:
    out = []
    for value in values or ():
        if isinstance(value, str):
            out += [v.strip() for v in value.split(",") if v.strip()]
        elif value is not None:
            out.append(str(value))
    return out


def named_dataset_ids(query_params, path_params: dict, body) -> list:
    """Every dataset id a request names, including nested scopes and dataset-keyed selections."""
    ids = _split(query_params.getlist("dataset_id")) + _split(query_params.getlist("dataset_ids"))
    ids += _split([path_params.get("dataset_id")])
    return ids + _body_dataset_ids(body)


def _body_dataset_ids(body) -> list:
    ids = []
    if isinstance(body, dict):
        ids += _split([body.get("dataset_id"), body.get("source_dataset_id")])
        raw = body.get("dataset_ids")
        ids += _split(raw if isinstance(raw, list) else [raw])
        for key in _DATASET_MAPS:
            if isinstance(body.get(key), dict):
                ids += list(body[key])
        for key in _NESTED:
            for item in body.get(key) or () if isinstance(body.get(key), list) else ():
                if isinstance(item, dict):
                    ids += _body_dataset_ids(item)
    return ids


def feature_for(path: str) -> str:
    for prefix, feature in _FEATURES:
        if path.startswith(prefix):
            return feature
    return "analysis"


def install_live_lift_guard(app, get_state: Callable) -> None:
    """Middleware refusing (409, one notice) lifted datasets outside ``LIFT_ALLOWED``."""
    from services.lift.capability import LiveLiftUnsupported, is_lifted

    @app.middleware("http")
    async def live_lift_guard(request, call_next):
        path = request.url.path
        if not path.startswith("/api/") or path.startswith(LIFT_PREFIX):
            return await call_next(request)
        try:
            state = get_state(request)
            datasets = getattr(state, "datasets", {}) or {}
        except Exception:  # noqa: BLE001 - no state (a bare app): nothing to guard
            return await call_next(request)
        lifted = {d for d, ds in list(datasets.items()) if is_lifted(ds)}
        if not lifted:
            return await call_next(request)
        template = _route_template(app, request.scope)
        if template is None or (request.method, template) in LIFT_ALLOWED:
            return await call_next(request)
        body = None
        if request.method in (_POST, "PUT", "PATCH") and "json" in request.headers.get("content-type", ""):
            size = int(request.headers.get("content-length") or 0)
            if size <= _MAX_BODY:
                try:
                    body = json.loads(await request.body() or b"null")
                except (ValueError, UnicodeDecodeError):
                    body = None
        # Rule grouping reads config only; every SNP/SV variant path stays denied.
        if request.method == _POST and template == "/api/variants/alleles" and isinstance(body, dict) and body.get("source") == "lift_hap":
            return await call_next(request)
        path_params = {}
        for route in app.router.routes:
            match, child = route.matches(request.scope)
            if match == Match.FULL:
                path_params = child.get("path_params", {})
                break
        named = [d for d in named_dataset_ids(request.query_params, path_params, body) if d in lifted]
        if not named:
            return await call_next(request)
        exc = LiveLiftUnsupported(feature_for(path), getattr(datasets.get(named[0]), "label", None))
        return JSONResponse(status_code=409, content={"success": False, "detail": str(exc), "error": str(exc),
                                                      "notice": str(exc), "live_lift_unsupported": exc.feature})
