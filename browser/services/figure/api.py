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

# Charts the browser draws itself (Plots, the Gallery, Quantify a window, analysis panels): no figure engine draws
# them. Asking for one is an error that says where to export it, not a figure silently without it.
BROWSER_ONLY_TRACKS = {"plots", "plot", "gallery", "quantify", "window-quant", "panels"}
BROWSER_ONLY_MESSAGE = ("Plots, Gallery, Quantify and analysis-panel charts are drawn by the browser, not by figure "
                        "engines: export them from the browser (Plots → Save, a Gallery card's Save, a panel's chart "
                        "Save). Figures draw the read view: axis, peaks, reads, genes, sequence and composite tracks.")

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

    meta = None  # a meta-locus view clone: leased while this request draws it (released below)
    try:
        explicit = _explicit(request)
        if {str(t).lower() for t in (request.tracks or [])} & BROWSER_ONLY_TRACKS:
            raise FigureError(BROWSER_ONLY_MESSAGE)
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

        # A meta-locus (pooled loci): the request's spec or pool id, else a session saved on a meta:<pool> view.
        # The figure draws a view clone of the pool (the open tab's view is never changed); a saved session's old
        # contig is renamed to the rebuilt pool's (services/figure/meta_locus.py).
        meta = None
        if getattr(request, "meta_locus", None) is not None or session is not None:
            from services.figure.meta_locus import MetaLocusError, resolve as resolve_meta, session_region
            from services.figure.meta_locus import _session_meta_chroms
            if _public_mode() and (getattr(request, "meta_locus", None) is not None or _session_meta_chroms(session)):
                # Pools read a host BED and the host's BAMs: never on a public server, from a request or a session.
                raise FigureError("Meta-locus figures are not available on a public server", status=403)
            try:
                meta = resolve_meta(state, getattr(request, "meta_locus", None), session)
            except MetaLocusError as exc:
                raise FigureError(str(exc), status=exc.status) from None
            if meta is not None:
                if meta.session is not None:
                    session = meta.session
                if not any(given) and not getattr(request, "region", None):
                    chrom, start, end = session_region(meta, session) or meta.region(meta.spec.get("window"))
        # Scripted-figure options: the request's, else the session's headless_figure block (unset: unchanged).
        from services.figure.options import resolve as resolve_options
        opts = resolve_options(request, session)
        if opts.get("annotations") and _public_mode():
            from services.figure.annotations import check_public
            check_public(opts["annotations"])
        overrides = {}
        if "spanning_only" in opts:
            overrides["spanningOnly"] = bool(opts["spanning_only"])
        if opts.get("sample_seed"):
            overrides["analysisSampleSeed"] = opts["sample_seed"]
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
        if meta is not None:
            overrides["_metaLocus"] = meta.axis()
            if dataset_ids is None and meta.source != "session" and meta.spec.get("dataset_ids"):
                dataset_ids = list(meta.pool.order)
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
            max_reads=opts.get("max_reads") or None,
            overrides=overrides,
            read_ids=list(request.read_ids) if request.read_ids is not None else None,
            options=opts,
        )
        if meta is None and str(spec.chrom).startswith("meta:"):
            # A meta contig without a meta-locus request (the open tab's view): the axis from that contig's pool.
            from services.figure.meta_locus import axis_for_chrom
            axis = axis_for_chrom(spec.chrom)
            if axis:
                spec.fe["_metaLocus"] = axis
        if meta is not None:
            from services.figure.meta_locus import draw_whole_working_set
            draw_whole_working_set(spec, meta, explicit_cap=bool(opts.get("max_reads") or opts.get("max_reads_by_dataset")))
            spec.meta = meta.record()
        return render_response(spec, state, request.format, float(request.scale), max_pixels=MAX_OUTPUT_PIXELS,
                               manifest=bool(request.manifest), manifest_read_ids=bool(request.manifest_read_ids))
    except FigureError as exc:
        return JSONResponse(status_code=exc.status, content={"error": str(exc), **exc.extra})
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})
    finally:
        if meta is not None:
            meta.release()
