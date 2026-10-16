"""Resource limits for anonymous visitors of a ``--public`` server.

On a public server a visitor must not be able to take the host's CPU and
memory: before these limits one anonymous POST could start a consensus run
with 128 cores and a 10 Mb region, and read requests had no span or read cap.

- Footprint-class (consensus) jobs: the client's ``compute`` group is replaced
  by server-set values (region span, cores, matrix budget, CPU backends, a
  short per-neighbourhood time limit). Each session may run one job (the
  consensus workflow enforces that) and at most ``consensus_queue`` jobs may be
  queued or running on the whole server.
- Read and analysis requests that take ``chrom/start/end`` in the query string
  are refused beyond ``max_span_bp`` (whole-chromosome coverage for the genome
  overview has its own, larger ``max_coverage_span_bp`` and a bin cap), and
  ``max_reads``-style parameters are clamped.
- ``--public`` sets a default ``--max-working-reads``.

Every limit comes from ``configure_public_limits`` (CLI flags, see
``services/cli_args.py``) or ``FIBERBROWSER_PUBLIC_*`` environment variables.
Local (non-public) servers and tour sandboxes of a local server are unaffected.
"""
from __future__ import annotations

import math
import os
import re
import threading
from dataclasses import dataclass, fields, replace
from typing import Any, Optional
from urllib.parse import parse_qsl, urlencode

from fastapi import FastAPI
from fastapi.responses import JSONResponse


def _env_int(name: str, default: int) -> int:
    try:
        return int(float(os.environ.get(name, "") or default))
    except ValueError:
        return default


@dataclass(frozen=True)
class PublicLimits:
    max_span_bp: int = 1_000_000
    max_coverage_span_bp: int = 300_000_000
    max_coverage_bins: int = 2_000
    max_reads: int = 2_000
    max_working_reads: int = 20_000
    consensus_region_bp: int = 50_000
    consensus_cores: int = 2
    consensus_matrix_mb: int = 1_024
    consensus_neighborhood_seconds: int = 60
    consensus_queue: int = 3
    # Request contents: region lists (regions, viewports, extra_regions, ...),
    # cluster counts (k), signal bins and per-session tracks / footprint-class runs.
    max_regions: int = 50
    # Footprint profiles (profile_window, flank_bp: bp each side) and V-plots (cells).
    max_profile_window: int = 5_000
    max_vplot_cells: int = 1_000_000
    max_clusters: int = 50
    max_bins: int = 10_000
    session_max_tracks: int = 40
    session_max_consensus_runs: int = 4
    # --- open-internet protection (services/public_protection.py) ---
    # Requests per client IP (IPv6: per /64): a token bucket refilled at
    # rate_per_minute, holding at most rate_burst. A page load fires ~20 API
    # requests and each view change a few; several people behind one NAT
    # share a bucket. Static /assets files don't count.
    rate_per_minute: int = 1_200
    rate_burst: int = 300
    # Analysis requests (clustering, peak scans, co-accessibility, figures,
    # footprint classes, ...; HEAVY_ROUTES) per client IP, on their own bucket.
    # (Each view change runs a peak scan and a quality-impact preview.)
    heavy_per_minute: int = 120
    heavy_burst: int = 30
    # Analysis requests running at once: per client IP, and server-wide (0 =
    # half the CPU cores, at least 2). A request waits up to heavy_wait_seconds
    # for a server-wide slot, then gets 503 with Retry-After.
    heavy_concurrent_per_ip: int = 3
    heavy_concurrent: int = 0
    heavy_wait_seconds: int = 15
    # An analysis request still running after this gets 503 (its slot stays
    # taken until the work really ends, so retries can't pile up).
    heavy_timeout_seconds: int = 180
    # View requests (reads, coverage, signal tracks) computed at once, server-wide
    # (0 = 4) and per client; identical ones are computed once and shared.
    read_concurrent: int = 0
    read_concurrent_per_ip: int = 6
    read_wait_seconds: int = 30
    # Every request, all clients together (a backstop against floods from many IPs).
    global_rate_per_second: int = 400
    # Largest request body; multipart uploads are always refused.
    max_body_kb: int = 1_024
    # Visitor sessions one client IP may hold (FIBERBROWSER_MAX_SESSIONS caps
    # them all). Past it the IP's own idle sessions are dropped, never anyone
    # else's; if none is idle, new sessions from that IP get 429.
    sessions_per_ip: int = 24
    # Per-session read caches (entries; the local default is 20 regions), and
    # how long a visitor may be idle before its caches are emptied (0: never).
    session_cache_entries: int = 2
    idle_cache_seconds: int = 120
    # Resident memory (MB) past which idle sessions' caches are dropped and new
    # sessions are refused until it falls (0 = no check).
    memory_mb: int = 0
    # Shared cache of identical anonymous read/coverage/track responses.
    cache_mb: int = 256
    cache_ttl_seconds: int = 300

    @classmethod
    def from_env(cls) -> "PublicLimits":
        base = cls(consensus_cores=max(1, min(2, os.cpu_count() or 1)))
        values = {f.name: _env_int(f"FIBERBROWSER_PUBLIC_{f.name.upper()}", getattr(base, f.name))
                  for f in fields(cls)}
        return cls(**values)


_limits: Optional[PublicLimits] = None


def get_public_limits() -> PublicLimits:
    global _limits
    if _limits is None:
        _limits = PublicLimits.from_env()
    return _limits


def configure_public_limits(**overrides: Any) -> PublicLimits:
    """Environment defaults, then any non-None override (CLI flags)."""
    global _limits
    base = PublicLimits.from_env()
    _limits = replace(base, **{k: int(v) for k, v in overrides.items() if v is not None})
    return _limits


def limit_names() -> tuple[str, ...]:
    """Every configurable limit (a config file may set any of them by this name)."""
    return tuple(f.name for f in fields(PublicLimits))


def apply_public_cli(args) -> PublicLimits:
    """Configure the limits from --public-* flags; --public implies a working-set cap.

    Each PublicLimits field ``name`` is read from ``args.public_<name>`` when the
    parser (or a server config file) set it, so every limit is also a plain
    option: ``--public-rate-per-minute``, ``FIBERBROWSER_PUBLIC_RATE_PER_MINUTE``.
    """
    limits = configure_public_limits(**{name: getattr(args, f"public_{name}", None) for name in limit_names()})
    from services.public_protection import configure_trusted_proxies
    proxies = getattr(args, "trusted_proxy", None)
    if proxies:
        configure_trusted_proxies(proxies)
    if not getattr(args, "max_working_reads", 0):
        args.max_working_reads = limits.max_working_reads
    return limits


def reset_public_limits() -> None:
    global _limits
    _limits = None


# --- footprint-class (consensus) jobs -------------------------------------------

def public_consensus_compute(limits: Optional[PublicLimits] = None) -> dict[str, Any]:
    """The compute group every public consensus job runs with (client values ignored)."""
    limits = limits or get_public_limits()
    return {
        "maximum_region_bp": limits.consensus_region_bp,
        "cores": limits.consensus_cores,
        "maximum_matrix_mb": limits.consensus_matrix_mb,
        "neighborhood_seconds": limits.consensus_neighborhood_seconds,
        "predictive_backend": "cpu",
        "fit_backend": "cpu",
    }


_jobs_lock = threading.Lock()
_active_jobs: list[Any] = []  # futures of public consensus jobs


def _prune() -> None:
    _active_jobs[:] = [f for f in _active_jobs if not f.done()]


def consensus_queue_full(limits: Optional[PublicLimits] = None) -> bool:
    limits = limits or get_public_limits()
    with _jobs_lock:
        _prune()
        return len(_active_jobs) >= limits.consensus_queue


def track_consensus_job(future: Any) -> None:
    if future is None:
        return
    with _jobs_lock:
        _prune()
        _active_jobs.append(future)


def active_consensus_jobs() -> int:
    with _jobs_lock:
        _prune()
        return len(_active_jobs)


# --- read and analysis requests ------------------------------------------------

# Routes that load reads for a chrom/start/end window (every public route's
# window is checked, see limit_query/limit_body; this names the read loaders
# the tests make sure stay bounded).
SPAN_LIMITED_ROUTES: frozenset[str] = frozenset({
    "/api/reads/compact", "/api/reads/compact_all", "/api/reads/info", "/api/working_set_info",
    "/api/meta", "/api/meta_all", "/api/fire", "/api/reads/stats",
    "/api/coacc/arcs", "/api/coacc/matrix/data", "/api/coacc/matrix/image", "/api/coacc/metadata",
    "/api/coacc/slice", "/api/coacc/strip",
    "/api/scan_peaks", "/api/detect_peaks", "/api/cluster", "/api/cluster_all", "/api/cluster_expand",
    "/api/cluster_projection", "/api/cluster/vplot", "/api/assign_to_clusters", "/api/dissolve_cluster",
    "/api/auto_cull_clusters", "/api/filter", "/api/filter_by_analysis_rule",
    "/api/filter_by_transcription_state", "/api/sort_reads", "/api/pol2_com", "/api/autozoom",
    "/api/quality/impact", "/api/footprint/analyze",
})
# Genome-overview style requests: whole chromosomes, binned.
COVERAGE_ROUTES: frozenset[str] = frozenset({"/api/coverage", "/api/reads/top_windows"})
# Views that stay available zoomed out (reference annotations and signal
# tracks, read from indexed/zoom-level files): the coverage span limit.
WIDE_ROUTES: frozenset[str] = COVERAGE_ROUTES | frozenset({
    "/api/genes", "/api/sequence", "/api/tracks/{track_idx}", "/api/tracks/{track_idx}/annotations",
    "/api/tracks/batch", "/api/annotations/region", "/api/overlays/{overlay_id}/marks",
    "/api/microc/arcs", "/api/microc/matrix/data", "/api/microc/matrix/strip", "/api/microc/virtual4c",
    "/api/dafc/matrix/data", "/api/dafc/matrix/image",
})
# Query parameters that cap how many reads a request returns or profiles; 0
# means "no cap" for some of them, so 0 is clamped too.
READ_COUNT_PARAMS = ("max_reads", "profile_max_reads", "downsample", "n_reads", "sample_size",
                     "max_reads_per_region")
BIN_PARAMS = ("bins", "n_bins", "signal_bins")
CLUSTER_PARAMS = ("k", "n_clusters")
# Region pairs a request may carry, as (start key, end key).
_SPAN_KEYS = (("start", "end"), ("region_start", "region_end"))
# Lists of regions or items in a JSON body.
REGION_LIST_KEYS = frozenset({"regions", "viewports", "views", "extra_regions", "peak_regions",
                              "extra_chroms", "footprints", "custom_pwms", "track_indices",
                              "matrix_ids", "gene_ids", "dataset_ids"})


class Refusal(str):
    """A refusal message with its HTTP status (413 too large, 400 malformed)."""

    status = 413

    def __new__(cls, message: str, status: int = 413):
        obj = super().__new__(cls, message)
        obj.status = status
        return obj


class _Refused(ValueError):
    def __init__(self, message: str, status: int = 413):
        super().__init__(message)
        self.status = status


_INVALID_NUMBER = "Invalid number in the request (it must be finite)."
# "chr19:47,514,000-47,518,000" (a region given as one string).
_REGION_RE = re.compile(r"^\s*[^:\s]+:\s*([0-9][0-9,_]*)\s*[-\u2013]\s*([0-9][0-9,_]*)\s*$")
REGION_STRING_KEYS = frozenset({"region", "locus", "loc", "position", "view"})


# Coordinates beyond this are no genome's: refused as malformed (a JSON
# integer can be arbitrarily large and would overflow a float).
_MAX_COORDINATE = 2 ** 53
# A number written with more characters than this is malformed (2^53 has 16
# digits; a float in exponent form fits easily).
_MAX_NUMBER_TEXT = 64


def _number(value: Any) -> Optional[float]:
    """The value as a finite number (an exact int for integers), None when it
    isn't numeric; non-finite or overflowing numbers are refused (400)."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        if abs(value) > _MAX_COORDINATE:
            raise _Refused(_INVALID_NUMBER, 400)
        return value
    if isinstance(value, str):
        text = value.strip().replace("_", "")
        if len(text) > _MAX_NUMBER_TEXT:
            # (no conversion at all: Python refuses long digit strings with a ValueError)
            raise _Refused(_INVALID_NUMBER, 400)
        if re.fullmatch(r"[+-]?\d+", text):
            number = int(text)
            if abs(number) > _MAX_COORDINATE:
                raise _Refused(_INVALID_NUMBER, 400)
            return number
    try:
        number = float(value)
    except OverflowError:
        raise _Refused(_INVALID_NUMBER, 400)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number) or abs(number) > _MAX_COORDINATE:
        raise _Refused(_INVALID_NUMBER, 400)
    return number


def _span_pairs(keys) -> list[tuple[str, str]]:
    """start/end, and every <name>_start/<name>_end pair a request carries
    (region_, x_, y_, viewpoint_, profile_, focus_, ...)."""
    pairs = [("start", "end")]
    for key in keys:
        if isinstance(key, str) and key.endswith("_start") and key[:-6] + "_end" in keys:
            pairs.append((key, key[:-6] + "_end"))
    return pairs


def _spans(params: dict[str, Any]) -> list[int]:
    """Every window a request (query or JSON object) names: each start/end
    pair, and a region given as one string or a [chrom, start, end] list."""
    spans = []
    for start_key, end_key in _span_pairs(set(params)):
        if start_key in params or end_key in params:
            start, end = _number(params.get(start_key)), _number(params.get(end_key))
            if start is not None and end is not None:
                spans.append(int(end) - int(start))
    for key in REGION_STRING_KEYS & set(params):
        value = params[key]
        if isinstance(value, str):
            match = _REGION_RE.match(value)
            if match:
                start, end = (_number(g.replace(",", "")) for g in match.groups())
                spans.append(int(end) - int(start))
        elif isinstance(value, (list, tuple)) and len(value) == 3:
            start, end = _number(value[1]), _number(value[2])
            if start is not None and end is not None:
                spans.append(int(end) - int(start))
    return spans


def _span(params: dict[str, Any]) -> Optional[int]:
    """The largest window a request names (None: none)."""
    spans = _spans(params)
    return max(spans) if spans else None


def _span_limit(template: str, limits: PublicLimits) -> int:
    return limits.max_coverage_span_bp if template in WIDE_ROUTES else limits.max_span_bp


def _too_large(template: str, limits: PublicLimits) -> str:
    if template in WIDE_ROUTES:
        return f"Region too large for this public server (at most {limits.max_coverage_span_bp:,} bp)."
    return (f"Region too large for this public server: reads load for at most "
            f"{limits.max_span_bp:,} bp at a time. Zoom in.")


def _clamp(key: str, value: Any, template: str, limits: PublicLimits):
    """(clamped value, changed) for a count-like parameter, else (value, False)."""
    if key in READ_COUNT_PARAMS:
        cap, zero_is_cap = limits.max_reads, True
    elif key in BIN_PARAMS:
        cap = limits.max_coverage_bins if template in COVERAGE_ROUTES else limits.max_bins
        zero_is_cap = True
    elif key in CLUSTER_PARAMS:
        cap, zero_is_cap = limits.max_clusters, False
    elif key in PROFILE_WINDOW_PARAMS:
        cap, zero_is_cap = limits.max_profile_window, False
    else:
        return value, False
    if isinstance(value, bool):
        return value, False
    number = _number(value)
    if number is None:
        return (str(cap) if isinstance(value, str) else cap), True
    if number > cap or (zero_is_cap and number <= 0):
        return (str(cap) if isinstance(value, str) else cap), True
    return value, False


# Footprint profiles and V-plots: the aggregate spans 2 x profile_window + 1
# positions, a V-plot has (size range / size bin) x (positions / position bin) cells.
PROFILE_WINDOW_PARAMS = ("profile_window", "flank_bp")


def _model_defaults(model: str, names: tuple[str, ...]) -> dict[str, Any]:
    """The request model's defaults (what the route uses for a field left out)."""
    import models.requests as requests_models
    fields_ = getattr(requests_models, model).model_fields
    return {name: fields_[name].default for name in names}


# The V-plot routes: (request model, size min, size max, size bin, position bin keys).
VPLOT_ROUTES: dict[str, tuple[str, str, str, str, str]] = {
    "/api/footprint/analyze": ("FootprintAnalysisRequest", "vplot_size_min", "vplot_size_max",
                               "vplot_size_bin", "vplot_pos_bin"),
    "/api/cluster/vplot": ("ClusterVPlotRequest", "size_min", "size_max", "size_bin", "pos_bin"),
}


def vplot_cells(size_min: int, size_max: int, size_bin: int, positions: int, pos_bin: int) -> int:
    """Cells of the matrix a V-plot allocates (as footprint_analysis and the
    cluster V-plot compute it; no V-plot when a bin is not positive)."""
    if size_bin <= 0 or pos_bin <= 0:
        return 0
    return max(0, (size_max - size_min) // size_bin) * max(0, positions // pos_bin)


def _check_vplot(payload: dict, template: str, positions: Optional[int], limits: PublicLimits) -> None:
    """The matrix a V-plot route will allocate, from the values it will use
    (the model's defaults for fields left out): footprint analysis spans
    2 x profile_window positions, a cluster V-plot its query region."""
    spec = VPLOT_ROUTES.get(template)
    if spec is None:
        return
    model, size_min_key, size_max_key, size_bin_key, pos_bin_key = spec
    names = (size_min_key, size_max_key, size_bin_key, pos_bin_key)
    if template == "/api/footprint/analyze":
        # Only a V-plot that is made counts (include_read_analysis and
        # include_vplot, as footprint_endpoint reads them).
        flags = _model_defaults(model, ("include_read_analysis", "include_vplot"))
        flags.update({k: payload[k] for k in flags if k in payload})
        if not all(_truthy(v) for v in flags.values()):
            return
        names += ("profile_window",)
    effective = {**_model_defaults(model, names), **{k: payload[k] for k in names if k in payload}}
    numbers = {}
    for key, value in effective.items():
        number = _number(value)
        if number is None:
            return  # not a number: the route's own validation refuses it
        numbers[key] = int(number)
    if template == "/api/footprint/analyze":
        window = min(max(numbers["profile_window"], 0), limits.max_profile_window)
        positions = 2 * window
    elif positions is None:
        return  # no region, no V-plot (the route needs one)
    cells = vplot_cells(numbers[size_min_key], numbers[size_max_key], numbers[size_bin_key],
                        int(positions), numbers[pos_bin_key])
    # (A cluster V-plot keeps one such matrix per cluster drawn; which clusters
    # are drawn depends on the reads in view, so the route itself bounds
    # their number and total cells: routers/clustering_visualization.py.)
    if cells > limits.max_vplot_cells:
        raise _Refused(f"V-plot too fine for this public server ({cells:,} cells, at most "
                       f"{limits.max_vplot_cells:,}): use larger size or position bins, or a smaller size range.")


def _truthy(value: Any) -> bool:
    """A flag's value as the request model will read it (pydantic's own bool
    parsing: false, 0, "0", "f", "n", "no", "off", ... are False). A value
    the model would refuse counts as True here (the route answers 422)."""
    from pydantic import ValidationError
    try:
        return bool(_BOOL.validate_python(value))
    except ValidationError:
        return True


def _bool_adapter():
    from pydantic import TypeAdapter
    return TypeAdapter(bool)


_BOOL = _bool_adapter()


class AllocationTooLarge(ValueError):
    """A public visitor's request would allocate more than its limits allow."""


def check_public_allocation(*, vplot_cells_: int = 0, profile_window: int = 0, clusters: int = 0) -> None:
    """Backstop inside the allocators (footprint profiles, V-plots): whatever
    route led here, a public visitor's request can't allocate past the limits.
    ``vplot_cells_`` is everything the request keeps (all its matrices)."""
    from services.runtime import get_visitor_public_mode
    if not get_visitor_public_mode():
        return
    limits = get_public_limits()
    if clusters > limits.max_clusters:
        raise AllocationTooLarge(f"Too many clusters for a V-plot on this public server "
                                 f"(at most {limits.max_clusters} per dataset).")
    if profile_window > limits.max_profile_window:
        raise AllocationTooLarge(f"Profile window too wide for this public server "
                                 f"(at most {limits.max_profile_window:,} bp each side).")
    if vplot_cells_ > limits.max_vplot_cells:
        raise AllocationTooLarge(f"V-plot too fine for this public server ({vplot_cells_:,} cells, at most "
                                 f"{limits.max_vplot_cells:,}).")


def limit_query(template: str, query: list[tuple[str, str]], limits: PublicLimits):
    """(new query, None) when allowed, or (None, Refusal) when the request is too large.

    Every public route is covered: every start/end or region_start/region_end
    pair and region string is refused past max_span_bp (WIDE_ROUTES:
    max_coverage_span_bp); read counts, bins, cluster counts and profile
    windows are clamped; non-finite numbers are refused.
    """
    try:
        # A repeated parameter counts by its last value, as the routes read it.
        spans = _spans(dict(query))
        if spans and max(spans) > _span_limit(template, limits):
            return None, Refusal(_too_large(template, limits))
        if template == "/api/reads/random_window":
            for key, value in query:
                number = _number(value) if key == "span" else None
                if number is not None and number > limits.max_span_bp:
                    return None, Refusal(_too_large(template, limits))
        changed = False
        clamped = []
        for key, value in query:
            value, did = _clamp(key, value, template, limits)
            changed = changed or did
            clamped.append((key, value))
    except _Refused as refused:
        return None, Refusal(str(refused), refused.status)
    return (clamped if changed else None), None


def query_positions(query: list[tuple[str, str]]) -> Optional[int]:
    """The widest window the query string names (a V-plot's positions)."""
    try:
        return _span(dict(query))
    except _Refused:
        return None


def limit_body(template: str, payload: Any, limits: PublicLimits, positions: Optional[int] = None):
    """The JSON-body form of limit_query: (new payload or None, Refusal or None).

    Walks the whole body: every object's windows are span-checked, region/item
    lists are capped at max_regions, count-like fields are clamped, V-plot
    dimensions are bounded (``positions``: the query's window, for a cluster
    V-plot) and non-finite numbers are refused.
    """
    changed = False

    def walk(value: Any, depth: int = 0):
        nonlocal changed
        if depth > 32:
            raise _Refused("Request body nested too deeply.", 400)
        if isinstance(value, float) and not math.isfinite(value):
            raise _Refused(_INVALID_NUMBER, 400)
        if isinstance(value, dict):
            span = _span(value)
            if span is not None and span > _span_limit(template, limits):
                raise _Refused(_too_large(template, limits))
            out = {}
            for key, item in value.items():
                if key in REGION_LIST_KEYS and isinstance(item, list) and len(item) > limits.max_regions:
                    raise _Refused(f"Too many {key} for this public server (at most {limits.max_regions}).")
                clamped, did = _clamp(key, item, template, limits)
                if did:
                    changed = True
                    out[key] = clamped
                else:
                    out[key] = walk(item, depth + 1)
            return out
        if isinstance(value, list):
            return [walk(item, depth + 1) for item in value]
        return value

    try:
        new_payload = walk(payload)
        if isinstance(new_payload, dict):
            _check_vplot(new_payload, template, positions, limits)
        elif template in VPLOT_ROUTES:
            _check_vplot({}, template, positions, limits)
    except _Refused as refused:
        return None, Refusal(str(refused), refused.status)
    return (new_payload if changed else None), None


def install_public_request_limits(app: FastAPI, is_host_public) -> None:
    """Refuse oversized read windows and clamp read counts on a --public server."""
    from services.public_mode_guard import route_template

    @app.middleware("http")
    async def public_request_limits(request, call_next):
        if is_host_public() and request.url.path.startswith("/api/"):
            template = route_template(app, request.scope)
            if template is not None:
                query = parse_qsl(request.scope.get("query_string", b"").decode("latin-1"),
                                  keep_blank_values=True)
                new_query, refusal = limit_query(template, query, get_public_limits())
                if refusal:
                    return JSONResponse(status_code=getattr(refusal, "status", 413),
                                        content={"success": False, "message": refusal, "detail": refusal})
                if new_query is not None:
                    request.scope["query_string"] = urlencode(new_query).encode("latin-1")
        return await call_next(request)
