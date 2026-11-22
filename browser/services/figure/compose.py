"""Lay out the browser's panels and tracks and draw them on one surface."""
from __future__ import annotations

from utils.responses import content_disposition
from fastapi.responses import Response

from services.figure.data import DataCache
from services.figure.spec import FigureSpec, TrackSpec
from services.figure.surface import make_surface
from dataclasses import replace

from services.figure.tracks import TrackContext, load_all, module_for

# Once any panel has clusters the browser gives every track a 16 px gutter
# (the read track draws the cluster colours in it; other tracks shift right).
CLUSTER_GUTTER = 16


def cluster_gutter(fe: dict) -> float:
    return CLUSTER_GUTTER if any(a for a in (fe.get("clusterAssignments") or {}).values()) else 0

MEDIA_TYPES = {"png": "image/png", "svg": "image/svg+xml", "pdf": "application/pdf"}
TITLE_HEIGHT = 36
COORDS_HEIGHT = 20
PANEL_GAP = 1  # the 1 px border between panels in the browser


def _columns(row_panels):
    """groupByColumns: panels sharing a layoutColumn stack; others get their own column."""
    groups, index_of, implicit = [], {}, -1
    for panel in row_panels:
        col = panel.column
        if col is not None and col in index_of:
            groups[index_of[col]].append(panel)
        else:
            key = col if col is not None else implicit
            implicit -= 1 if col is None else 0
            index_of[key] = len(groups)
            groups.append([panel])
    return groups


def _column_widths(columns, total: float) -> list[float]:
    """computeColumnWidths: equal, or by the first panel's widthFraction."""
    n = len(columns)
    gaps = PANEL_GAP * (n - 1)
    if not any(col[0].width_fraction is not None for col in columns):
        return [(total - gaps) / n] * n
    fractions = [max(0.0, col[0].width_fraction) if col[0].width_fraction is not None else 1 / n for col in columns]
    if sum(fractions) <= 0:
        return [(total - gaps) / n] * n
    return [(total - gaps) * f / sum(fractions) for f in fractions]


def _panel_rows(spec, state, data, panel, width, gutter):
    ctx = TrackContext(state, spec, panel, data, width)
    rows = []
    header = [] if "header" in spec.hidden() else [TrackSpec("header", None)]
    tracks = panel.tracks
    annotations = (spec.options or {}).get("annotations")
    if annotations and "annotation" not in spec.hidden() and (annotations.get("draw") or "both") in ("track", "both"):
        # Scripted figures: the BED annotation row, above the reads (services/figure/annotations.py).
        import services.figure.annotations  # noqa: F401  (registers the track)
        at = next((i for i, t in enumerate(tracks) if t.type in ("sv", "coverage", "reads")), len(tracks))
        tracks = tracks[:at] + [TrackSpec("annotation", None)] + tracks[at:]
    for track in header + tracks:
        module = module_for(track.type)
        if module is None:
            continue  # a track type this renderer doesn't draw (yet)
        # Most ports place the gutter themselves, as their browser tracks do
        # (labels stay at the left edge, data starts after it); the rest shift.
        own_gutter = (track.type in ("header", "reads", "sv", "coverage", "fire", "consensus", "gene", "sequence",
                                     "annotation")
                      or track.type.startswith("composite-"))
        offset = 0 if own_gutter else gutter
        track_ctx = replace(ctx, width=width - offset) if offset else ctx
        height = float(module.measure(track_ctx, track) or 0)
        if height > 0:
            rows.append((track, module, height, offset, track_ctx))
    return rows


def _layout(spec: FigureSpec, state, data: DataCache):
    """Browser panel layout: rows (layoutRow) top to bottom; in a row, columns
    side by side (widthFraction); panels sharing a column stack vertically.
    Returns placed panels [(x, y, width, rows)] and the body height."""
    load_all()
    gutter = cluster_gutter(spec.fe)
    by_row: dict[int, list] = {}
    for panel in spec.panels:
        by_row.setdefault(panel.row, []).append(panel)
    placed, y = [], 0.0
    for row_index in sorted(by_row):
        columns = _columns(by_row[row_index])
        widths = _column_widths(columns, spec.width)
        x, row_height = 0.0, 0.0
        for column, width in zip(columns, widths):
            cy = y
            for panel in column:
                rows = _panel_rows(spec, state, data, panel, width, gutter)
                height = sum(r[2] for r in rows)
                placed.append((x, cy, width, height, rows))
                cy += height + (PANEL_GAP if panel is not column[-1] else 0)
            row_height = max(row_height, cy - y)
            x += width + PANEL_GAP
        y += row_height + PANEL_GAP
    return placed, max(0.0, y - PANEL_GAP)


def view_filters(spec: FigureSpec, state):
    """The quality and signal filters saved with the view, for the duration of a ``with`` block."""
    import contextlib
    from services.read_quality_filters import backend_quality_filters, quality_filters_for_request
    from services.signal_evidence import signal_filters_for_request, state_carries_signal

    colormap = spec.fe.get("activeColormap") or {}
    # As in the browser: saved signal filters apply only while a loaded dataset carries signal tags.
    signal_filters = spec.fe.get("signalFilters") if state_carries_signal(state) else None
    stack = contextlib.ExitStack()
    stack.enter_context(signal_filters_for_request(signal_filters))
    stack.enter_context(quality_filters_for_request(backend_quality_filters(colormap.get("qualityFilters"))))
    return stack


def render(spec: FigureSpec, state, fmt: str = "png", scale: float = 2.0, max_pixels: float = None) -> bytes:
    """The figure, with the quality filters saved with its view (not the server's current ones)."""
    with view_filters(spec, state):
        return _render(spec, state, fmt, scale, max_pixels)


def render_with_manifest(spec: FigureSpec, state, fmt: str = "png", scale: float = 2.0, max_pixels: float = None,
                         read_ids: bool = False) -> tuple[bytes, dict]:
    """(figure bytes, manifest): the manifest lists what each panel drew (services/figure/manifest.py)."""
    with view_filters(spec, state):
        body, data, page = _render_parts(spec, state, fmt, scale, max_pixels)
        from services.figure.manifest import build_manifest
        return body, build_manifest(spec, state, data, page, read_ids=read_ids)


def _render(spec: FigureSpec, state, fmt: str, scale: float, max_pixels: float) -> bytes:
    return _render_parts(spec, state, fmt, scale, max_pixels)[0]


def _render_parts(spec: FigureSpec, state, fmt: str, scale: float, max_pixels: float):
    """(file bytes, the figure's DataCache, page geometry)."""
    data = DataCache(state, spec)
    placed, body = _layout(spec, state, data)
    top = TITLE_HEIGHT if spec.title else 0
    bottom = COORDS_HEIGHT if spec.include_coords else 0
    height = max(1.0, top + body + bottom)
    page = {"width_px": spec.width, "height_px": height, "format": fmt}
    printing = _print_setup(spec, fmt, height)
    if printing:
        if fmt == "png":
            scale = printing["scale"] or scale
            raster = max(scale, 2.0) if not printing["scale"] else scale
        else:
            raster = printing["raster_scale"] or max(scale, 2.0)
        page.update(printing["page"])
    else:
        raster = max(scale, 2.0)
    # A PNG on a physical page is a second canvas of its own (page size × dpi): within the same budget, checked before
    # anything is allocated.
    if max_pixels and fmt == "png" and printing and printing.get("geometry") is not None and printing.get("png_dpi"):
        g = printing["geometry"]
        page_px = max(1, round(g.width_pt / 72 * printing["png_dpi"])) * max(1, round(g.height_pt / 72 * printing["png_dpi"]))
        if page_px > max_pixels:
            raise ValueError(
                f"Figure page too large ({g.width_pt / 72:g} x {g.height_pt / 72:g} in at {printing['png_dpi']:g} dpi): "
                "a smaller page_size or raster_dpi")
    # Reads are rasterised at output resolution in every format.
    if max_pixels and spec.width * height * raster ** 2 > max_pixels:
        raise ValueError(
            f"Figure too large ({int(spec.width)}x{int(height)} px at scale {raster:g}): "
            "draw fewer reads (max_reads), a smaller row_height, width, scale or raster_dpi")
    surface = make_surface(fmt, spec.width, height, scale=scale)
    if printing:
        _apply_print(surface, fmt, printing)
    if spec.title:
        surface.text(spec.width / 2, 26, spec.title, size=18, color="#1f2937", weight="bold", anchor="middle")
    for x, py, width, height, rows in placed:
        y = top + py
        for track, module, track_height, offset, track_ctx in rows:
            surface.save()
            surface.translate(x + offset, y)
            surface.clip_rect(0, 0, width - offset, track_height)
            module.draw(surface, track_ctx, track, track_height)
            surface.restore()
            y += track_height
        # The browser's 1 px panel border (right and bottom).
        if x + width < spec.width - 0.5:
            surface.line(x + width + PANEL_GAP / 2, top + py, x + width + PANEL_GAP / 2, top + py + height, "#e5e7eb", PANEL_GAP)
    if spec.include_coords:
        surface.text(spec.width / 2, top + body + 14, f"{spec.chrom}:{spec.start:,}-{spec.end:,}",
                     size=11, color="#4b5563", anchor="middle")
    return surface.to_bytes(), data, page


def render_response(spec: FigureSpec, state, fmt: str = "png", scale: float = 2.0, max_pixels: float = None,
                    manifest: bool = False, manifest_read_ids: bool = False) -> Response:
    fmt = (fmt or "png").lower()
    if fmt not in MEDIA_TYPES:
        raise ValueError(f"format must be png, svg or pdf, not {fmt!r}")
    if manifest:
        import base64
        from fastapi.responses import JSONResponse
        body, info = render_with_manifest(spec, state, fmt, scale, max_pixels, read_ids=manifest_read_ids)
        return JSONResponse(content={"format": fmt, "media_type": MEDIA_TYPES[fmt],
                                     "figure_b64": base64.b64encode(body).decode("ascii"), "manifest": info},
                            headers={"X-Figure-Source": spec.source})
    body = render(spec, state, fmt, scale, max_pixels)
    return Response(content=body, media_type=MEDIA_TYPES[fmt], headers={
        "X-Figure-Source": spec.source,
        "Content-Disposition": content_disposition(f"fiberbrowser_{spec.chrom}_{spec.start}_{spec.end}.{fmt}", "inline"),
    })


def _print_setup(spec: FigureSpec, fmt: str, height: float) -> dict:
    """Physical page, minimum text, raster resolution and PDF fonts (services/figure/page.py); {} when unset."""
    opts = spec.options or {}
    size_pt, dpi = opts.get("page_size_pt"), opts.get("raster_dpi")
    if not (size_pt or dpi or opts.get("min_font_pt") or opts.get("pdf_fonts") == "truetype"):
        return {}
    from services.figure.page import (DEFAULT_PNG_DPI, PX_TO_PT, min_text_px, page_geometry, raster_scale)
    geom = page_geometry(spec.width, height, size_pt, opts.get("page_fit") or "contain")
    png_dpi = float(dpi or DEFAULT_PNG_DPI) if (size_pt or dpi) else None
    out = {
        "geometry": geom if size_pt else None,
        "min_text_px": min_text_px(geom, opts.get("min_font_pt")),
        "raster_scale": raster_scale(geom, dpi),
        "png_dpi": png_dpi,
        "truetype": opts.get("pdf_fonts") == "truetype",
        # PNG: pixels per CSS px at the page's resolution (the request's scale otherwise).
        "scale": PX_TO_PT * geom.k * png_dpi / 72.0 if png_dpi else None,
        "page": {"width_pt": round(geom.width_pt, 3), "height_pt": round(geom.height_pt, 3),
                 "fit": geom.fit, "scale_x": geom.sx, "scale_y": geom.sy,
                 "raster_dpi": dpi, "min_font_pt": opts.get("min_font_pt"),
                 "pdf_fonts": opts.get("pdf_fonts") or "standard"},
    }
    return out


def _apply_print(surface, fmt: str, printing: dict) -> None:
    surface.page = printing["geometry"]
    surface.min_text_px = printing["min_text_px"]
    if fmt == "png":
        if printing["png_dpi"]:
            surface.png_dpi = printing["png_dpi"]
    elif printing["raster_scale"]:
        surface.scale = printing["raster_scale"]  # read rasters (tracks read surface.scale; default 2)
    if fmt == "pdf" and printing["truetype"]:
        surface.use_truetype()
