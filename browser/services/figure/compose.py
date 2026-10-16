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
    for track in [TrackSpec("header", None)] + panel.tracks:
        module = module_for(track.type)
        if module is None:
            continue  # a track type this renderer doesn't draw (yet)
        # Most ports place the gutter themselves, as their browser tracks do
        # (labels stay at the left edge, data starts after it); the rest shift.
        own_gutter = (track.type in ("header", "reads", "sv", "coverage", "fire", "consensus", "gene", "sequence")
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


def render(spec: FigureSpec, state, fmt: str = "png", scale: float = 2.0, max_pixels: float = None) -> bytes:
    """The figure, with the quality filters saved with its view (not the server's current ones)."""
    from services.read_quality_filters import backend_quality_filters, quality_filters_for_request

    colormap = spec.fe.get("activeColormap") or {}
    from services.signal_evidence import signal_filters_for_request
    with signal_filters_for_request(spec.fe.get("signalFilters")), quality_filters_for_request(backend_quality_filters(colormap.get("qualityFilters"))):
        return _render(spec, state, fmt, scale, max_pixels)


def _render(spec: FigureSpec, state, fmt: str, scale: float, max_pixels: float) -> bytes:
    data = DataCache(state, spec)
    placed, body = _layout(spec, state, data)
    top = TITLE_HEIGHT if spec.title else 0
    bottom = COORDS_HEIGHT if spec.include_coords else 0
    height = max(1.0, top + body + bottom)
    # Reads are rasterised at output resolution in every format.
    if max_pixels and spec.width * height * max(scale, 2.0) ** 2 > max_pixels:
        raise ValueError(
            f"Figure too large ({int(spec.width)}x{int(height)} px at scale {scale}): "
            "draw fewer reads (max_reads), a smaller row_height, width or scale")
    surface = make_surface(fmt, spec.width, height, scale=scale)
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
    return surface.to_bytes()


def render_response(spec: FigureSpec, state, fmt: str = "png", scale: float = 2.0, max_pixels: float = None) -> Response:
    fmt = (fmt or "png").lower()
    if fmt not in MEDIA_TYPES:
        raise ValueError(f"format must be png, svg or pdf, not {fmt!r}")
    body = render(spec, state, fmt, scale, max_pixels)
    return Response(content=body, media_type=MEDIA_TYPES[fmt], headers={
        "X-Figure-Source": spec.source,
        "Content-Disposition": content_disposition(f"fiberbrowser_{spec.chrom}_{spec.start}_{spec.end}.{fmt}", "inline"),
    })
