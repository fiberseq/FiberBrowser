"""/api/render with engine="headless": map a RenderRequest onto a FigureSpec."""
from __future__ import annotations

from fastapi.responses import JSONResponse

from services.figure.compose import render_response
from services.figure.spec import resolve_spec

# /api/render options the headless engine has no equivalent for. A request
# that relies on one without choosing an engine keeps the legacy compositor,
# so scripts written for it behave as before.
LEGACY_ONLY = {
    "use_clusters", "sort_by", "n_clusters", "colors", "quality_shading", "tf_overlay", "show_cigar",
    "show_deam_opportunities", "subnuc_threshold", "dpi", "show_labels",
}

# /api/render track names only the legacy compositor draws (the headless engine
# shows signals as composite tracks and coverage above the reads instead).
LEGACY_ONLY_TRACKS = {"signal", "coverage"}

# Limits: page size in CSS px, output scale, and total output pixels.
MAX_WIDTH = 12000
SCALE_RANGE = (0.25, 8.0)
MAX_OUTPUT_PIXELS = 160_000_000


def _explicit(request) -> set:
    return set(getattr(request, "model_fields_set", None) or getattr(request, "__fields_set__", set()))


def _legacy_only_tracks(request) -> list:
    if "tracks" not in _explicit(request):
        return []
    return [t for t in (request.tracks or []) if t in LEGACY_ONLY_TRACKS]


def wants_legacy_engine(request) -> bool:
    """Engine not chosen and a legacy-only option or track asked for: keep the old compositor."""
    explicit = _explicit(request)
    return "engine" not in explicit and (bool(explicit & LEGACY_ONLY) or bool(_legacy_only_tracks(request)))


def _public_mode() -> bool:
    from services.runtime import get_public_mode
    return get_public_mode()


def render_request(request, state, dafc_state=None):
    from services.figure_render import FigureError, _session_source, parse_region

    try:
        explicit = _explicit(request)
        unsupported = _legacy_only_tracks(request)
        if unsupported:
            # Asked for the headless engine by name: say so rather than leave them out.
            raise FigureError(
                "The headless engine can't draw " + ", ".join(unsupported)
                + " tracks; use engine='numpy' (or add signal tracks to the view as composite tracks)")
        if request.session_path and _public_mode():
            raise FigureError("session_path is not available on a public server; send the session JSON instead", status=403)
        if not (SCALE_RANGE[0] <= float(request.scale) <= SCALE_RANGE[1]):
            raise FigureError(f"scale must be between {SCALE_RANGE[0]} and {SCALE_RANGE[1]}")
        if "width" in explicit and not (100 <= int(request.width) <= MAX_WIDTH):
            raise FigureError(f"width must be 100-{MAX_WIDTH} CSS pixels")

        chrom, start, end = request.chrom, request.start, request.end
        given = [v is not None for v in (chrom, start, end)]
        if any(given) and not all(given):
            raise FigureError("Pass chrom, start and end together (or region), or none of them")
        if getattr(request, "region", None):
            chrom, start, end = parse_region(request.region)

        session = None
        if request.session is not None or request.session_path:
            # Checks the session's datasets are loaded here (or loads them
            # with load_session) instead of silently drawing other datasets.
            _viewport, _frontend, _ = _session_source(request, state, dafc_state)
            session = request.session
            if session is None:
                from services.figure_render import read_session_path
                session = read_session_path(request.session_path)

        overrides = {}
        if "spanning_only" in explicit:
            overrides["spanningOnly"] = bool(request.spanning_only)
        if "sample_seed" in explicit and request.sample_seed:
            overrides["analysisSampleSeed"] = request.sample_seed
        if request.cluster_order:
            overrides["clusterOrder"] = request.cluster_order
        if request.read_sort_order:
            overrides["readSortOrder"] = request.read_sort_order
        # Layer toggles the request names turn those layers on or off; the
        # ones it leaves out keep the view's setting.
        mods = {}
        if "show_mods" in explicit:
            mods.update(dict.fromkeys(("m6a", "m5c", "deam", "mod"), bool(request.show_mods)))
        if "show_fire" in explicit:
            mods["fire"] = bool(request.show_fire)
        if "show_layers" in explicit:
            mods.update(dict.fromkeys(("tf", "nuc"), bool(request.show_layers)))
        if mods:
            overrides["_enableModTypes"] = mods
        dataset_ids = request.dataset_ids or ([request.dataset_id] if request.dataset_id else None)
        spec = resolve_spec(
            state,
            chrom=chrom, start=start, end=end,
            source="session" if session is not None else request.source, session=session,
            width=request.width if "width" in explicit else None,
            dataset_ids=dataset_ids,
            tracks=request.tracks if "tracks" in explicit else None,
            title=request.title,
            include_coords=bool(getattr(request, "include_coords", False)),
            read_row_height=request.row_height if "row_height" in explicit else None,
            max_reads=request.max_reads if "max_reads" in explicit else None,
            overrides=overrides,
            read_ids=list(request.read_ids) if request.read_ids is not None else None,
        )
        return render_response(spec, state, request.format, float(request.scale), max_pixels=MAX_OUTPUT_PIXELS)
    except FigureError as exc:
        return JSONResponse(status_code=exc.status, content={"error": str(exc), **exc.extra})
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})
