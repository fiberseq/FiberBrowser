"""Composite tracks (CompositeTrack.tsx), including the default Metaprofile.

A composite overlays 1..N sources: metaprofile layers of the panel's dataset
(the server metaprofile the browser gets with its reads), and bigWig/bigBed
signals from the catalog (the same /api/tracks/batch data, padded and sliced
to the view like useBrowserDataFetch). A one-source ``annotation`` composite
draws its intervals as boxes (AnnotationTrack.tsx), as the browser does.
"""
from __future__ import annotations

import math

from services.figure.tracks import register
from services.figure.tracks._util import cluster_sidebar_width, rounded_rect_points, with_alpha

AUXILIARY_PREFETCH_WINDOWS = 1.5
POINTS_PER_PIXEL = 1.5
STEPPED_POINT_DENSITY = 0.75


# --- signal sampling (utils/signalSampling.ts) --------------------------------

def signal_point_limit(pixel_width: float) -> int:
    width = pixel_width if math.isfinite(pixel_width) else 1
    return max(2, math.ceil(max(1, width) * POINTS_PER_PIXEL))


def should_draw_stepped(point_count: int, pixel_width: float) -> bool:
    width = pixel_width if math.isfinite(pixel_width) else 1
    return 0 < point_count < max(1, width) * STEPPED_POINT_DENSITY


def _finite(v) -> float:
    return float(v) if isinstance(v, (int, float)) and math.isfinite(v) else 0.0


def reduce_signal_values(values: list, max_points: int, reversed_: bool = False) -> list:
    n = len(values)
    if n == 0:
        return []
    limit = max(1, int(max_points))
    if n <= limit:
        return [_finite(values[n - 1 - i]) for i in range(n)] if reversed_ else list(values)
    out = []
    per = n / limit
    for i in range(limit):
        s = math.floor(i * per)
        e = max(s + 1, min(n, math.floor((i + 1) * per)))
        total = 0.0
        for j in range(s, e):
            total += _finite(values[(n - 1 - j) if reversed_ else j])
        out.append(total / (e - s))
    return out


def transform_value(v: float, src: dict, log_scale: bool) -> float:
    x = v * float(src.get("scale") if src.get("scale") is not None else 1)
    if src.get("negate"):
        x = -x
    if log_scale:
        sign = -1 if x < 0 else 1
        x = sign * math.log10(abs(x) + 1)
    return x


def _valid(v) -> bool:
    return v is not None and isinstance(v, (int, float)) and not math.isnan(v)


# --- source resolution (hooks/useSourceValues.ts) ------------------------------

def _metaprofile_key(layer: str | None) -> str | None:
    """ReadTrack metaprofileLayerKey: msp -> fire, footprint -> nuc."""
    if not layer:
        return None
    key = "fire" if layer == "msp" else layer
    return "nuc" if key == "footprint" else key


def active_metaprofile_keys(fe: dict) -> list[str]:
    """activeMetaprofileSourceIds: visible metaprofile sources of visible metaprofile composites."""
    keys: set[str] = set()
    for comp in fe.get("compositeTracks") or []:
        if not isinstance(comp, dict) or not comp.get("visible", True) or comp.get("kind") != "metaprofile":
            continue
        for src in comp.get("sources") or []:
            ref = src.get("ref") or {}
            if not src.get("visible", True) or ref.get("kind") != "metaprofile":
                continue
            rid = ref.get("ruleId")
            key = _metaprofile_key("m6a" if rid == "mod" else rid)
            if key:
                keys.add(key)
    return sorted(keys)


def dataset_profile(ctx, dataset_id: str) -> dict | None:
    """datasetProfiles[dataset]: datasetProfileFromServerMetaprofile of the compact payload."""
    keys = active_metaprofile_keys(ctx.fe)
    if not keys:
        return None
    local = _local_profile(ctx, dataset_id, set(keys))
    if local is not None:
        return local
    # A filtered, branch or focused panel profiles its own reads.
    from services.figure.tracks.reads import panel_cohort_ids
    cohort = panel_cohort_ids(ctx) if ctx.panel.dataset_id == dataset_id else None
    strand = ctx.panel.strand if ctx.panel.dataset_id == dataset_id else None
    if cohort is not None and not cohort:
        # A filter matching no reads: nothing to profile (an empty filter_ids
        # would mean every read to the server).
        return {"mod": [], "fire": [], "rules": {}, "layers": {}}

    def load():
        try:
            # ReadTrack requests the metaprofile layers as payload layers too
            # (include_layers + layer_names); without them the server's tf/nuc
            # split differs from the browser's.
            payload = ctx.data.compact_reads(dataset_id, layer_names=keys, include_metaprofile=True,
                                             metaprofile_layers=keys, filter_ids=cohort, strand=strand,
                                             include_methylation=bool(strand), region=ctx.region)
        except Exception:
            return None
        meta = payload.get("metaprofile") if isinstance(payload, dict) else None
        if not meta:
            return {"mod": [], "fire": [], "rules": {}, "layers": {}}
        layers = dict(meta.get("layers") or {})
        if not layers.get("nuc") and meta.get("nucleosome_profile"):
            layers["nuc"] = meta["nucleosome_profile"]
        if not layers.get("footprint") and layers.get("nuc"):
            layers["footprint"] = layers["nuc"]
        if not layers.get("nuc") and layers.get("footprint"):
            layers["nuc"] = layers["footprint"]
        return {"mod": layers.get("m6a") or layers.get("mod") or [], "fire": layers.get("fire") or [],
                "rules": {}, "layers": layers}

    return ctx.data.get(("composite.profile", dataset_id, tuple(keys), tuple(cohort or ()), strand) + ctx.region, load)


def _local_profile(ctx, dataset_id: str, active_ids: set) -> dict | None:
    """computeMetaprofileFromReads when the browser can't use the server's profile.

    That is whenever a source is a Labeling rule, the panel is clustered or
    filtered, or several datasets are loaded. None: use the server's.
    """
    from dataclasses import replace

    from services.figure.tracks._metaprofile import compute_metaprofile, metaprofile_rules
    from services.figure.tracks._read_colors import RuleContext
    from services.figure.tracks.reads import _all_peaks, _genes, profile_view

    # Another dataset's reads only from a panel showing this same region.
    panel = ctx.panel if ctx.panel.dataset_id == dataset_id else next(
        (p for p in ctx.spec.panels if p.dataset_id == dataset_id and replace(ctx, panel=p).region == ctx.region), None)
    if panel is None:
        return None
    target = ctx if panel is ctx.panel else replace(ctx, panel=panel)
    try:
        view = profile_view(target)
    except Exception:
        return None
    if view["use_server_meta"]:
        return None
    if view["zoomed_out"]:
        # The browser has no reads to profile here and shows "No data".
        return {"mod": [], "fire": [], "rules": {}, "layers": {}}

    def load():
        rules = metaprofile_rules(ctx.fe, active_ids)
        rctx = (RuleContext(_genes(target), _all_peaks(target), ctx.start, ctx.end, ctx.chrom,
                            tracks=RuleTracks(target)) if rules else None)
        pool = view["pool"]
        if not pool:
            return {"mod": [], "fire": [], "rules": {}, "layers": {}}
        return compute_metaprofile(pool, ctx.end - ctx.start, rules, rctx)

    return ctx.data.get(("composite.local_profile", panel.id, tuple(sorted(active_ids))) + ctx.region, load)


def _metaprofile_values(profile: dict | None, rule_id: str) -> tuple[list, bool]:
    if profile is None:
        return [], False
    pid = "m6a" if rule_id == "mod" else rule_id
    layers = profile.get("layers") or {}
    vals = layers.get(pid) or (layers.get("mod") if pid == "m6a" else None)
    if vals:
        return list(vals), True
    if pid == "m6a" and profile.get("mod"):
        return list(profile["mod"]), True
    if pid == "fire" and profile.get("fire"):
        return list(profile["fire"]), True
    vals = (profile.get("rules") or {}).get(pid)
    if vals:
        return list(vals), True
    if pid == "nuc":
        vals = layers.get("footprint") or (profile.get("rules") or {}).get("footprint")
        if vals:
            return list(vals), True
    return [], True


def _server_tracks(state) -> list[dict]:
    return list(getattr(state, "orthogonal_tracks", []) or [])


def resolve_catalog_track(ctx, entry_id: str) -> int | None:
    """Catalog entry -> server orthogonal track index (trackIndex, else path/url)."""
    entry = next((e for e in ctx.fe.get("catalog") or [] if isinstance(e, dict) and e.get("id") == entry_id), None)
    if not entry:
        return None
    tracks = _server_tracks(ctx.state)
    target = entry.get("path") or entry.get("url")
    idx = entry.get("trackIndex")
    if isinstance(idx, int) and 0 <= idx < len(tracks):
        if not target or tracks[idx].get("path") == target:
            return idx
    if not target:
        return None
    for i, t in enumerate(tracks):
        if t.get("path") == target:
            return i
    return None


def _chrom_size(ctx) -> int | None:
    # Chromosomes are ChromInfo objects on a live server (dicts in some tests).
    for c in getattr(ctx.state, "chroms", None) or []:
        name = c.get("name") if isinstance(c, dict) else getattr(c, "name", None)
        if name == ctx.chrom:
            size = (c.get("size") or c.get("length")) if isinstance(c, dict) else (getattr(c, "size", None) or getattr(c, "length", None))
            return int(size) if size else None
    return None


def track_batch(ctx, index: int) -> dict:
    """One /api/tracks/batch item over the browser's padded window, cut to the view."""
    def load():
        from models.requests import TracksBatchBody
        from services.tracks_endpoint import get_tracks_batch_payload

        from services.circular_genome import circular_chrom_size, circular_query_segments_for_region

        start, end = ctx.start, ctx.end
        view_bp = max(3, end - start)
        pad = round(view_bp * AUXILIARY_PREFETCH_WINDOWS)
        if circular_chrom_size(ctx.state, ctx.chrom):
            # Circular contig: keep logical coordinates so a window across the
            # origin is fetched on both sides of it (clamping lost the wrap).
            q_start, q_end = start - pad, end + pad
        else:
            q_start = max(0, start - pad)
            size = _chrom_size(ctx)
            q_end = max(q_start + 1, min(size, end + pad) if size else end + pad)
        q_width = max(1, q_end - q_start)
        requested = round(ctx.spec.width) if ctx.spec.width > 0 else 500
        bins = max(1, min(round(requested * (q_width / view_bp)), q_width))
        filters = {}
        tracks = _server_tracks(ctx.state)
        if 0 <= index < len(tracks) and tracks[index].get("render_mode") == "annotation":
            names = (ctx.fe.get("trackFilters") or {}).get(str(index)) or (ctx.fe.get("trackFilters") or {}).get(index)
            if names:
                filters[index] = names
        def fetch(a, b):
            res = get_tracks_batch_payload(ctx.state, TracksBatchBody(
                track_indices=[index], chrom=ctx.chrom, start=a, end=b, bins=bins,
                annotation_filters=filters))
            return (res.get("tracks") or [{}])[0]

        try:
            segments = circular_query_segments_for_region(ctx.state, ctx.chrom, q_start, q_end)
            item = fetch(q_start, q_end)
            if segments and item.get("render_mode") == "annotation" and not item.get("error"):
                # Signal follows the logical window itself; annotations are
                # fetched per reference segment and shifted into it.
                intervals = []
                for seg_start, seg_end, shift in segments:
                    for iv in fetch(seg_start, seg_end).get("intervals") or []:
                        iv = dict(iv)
                        iv["start"] = int(iv.get("start", 0)) + shift
                        iv["end"] = int(iv.get("end", 0)) + shift
                        intervals.append(iv)
                item["intervals"] = intervals
        except Exception:
            return {}
        if item.get("error"):
            return {}
        if item.get("render_mode") == "annotation":
            item["intervals"] = [iv for iv in item.get("intervals") or [] if iv.get("end", 0) > start and iv.get("start", 0) < end]
        else:
            vals = item.get("values") or []
            if vals:
                s_idx = max(0, math.floor((start - q_start) / q_width * len(vals)))
                e_idx = min(len(vals), math.ceil((end - q_start) / q_width * len(vals)))
                if not (s_idx <= 0 and e_idx >= len(vals)):
                    vals = vals[s_idx:max(s_idx + 1, e_idx)]
            item["values"] = vals
        return item

    return ctx.data.get(("composite.track", index, ctx.chrom, ctx.start, ctx.end), load)


class RuleTracks:
    """Orthogonal track data for labeling-rule 'track'/'motif' conditions
    (the browser's orthogonalTracks hydrated with the view's batch data)."""

    def __init__(self, ctx):
        self.ctx = ctx

    def track(self, index: int) -> dict | None:
        if not 0 <= index < len(_server_tracks(self.ctx.state)):
            return None
        return track_batch(self.ctx, index) or None

    def motifs(self) -> list[dict]:
        return [track_batch(self.ctx, i) for i, t in enumerate(_server_tracks(self.ctx.state))
                if isinstance(t, dict) and t.get("category") == "motif"]


def resolve_sources(ctx, composite: dict) -> list[dict]:
    """[{source, values, ready}] like useResolvedSources for the panel's dataset."""
    out = []
    for src in composite.get("sources") or []:
        ref = src.get("ref") or {}
        if ref.get("kind") == "metaprofile":
            ds = ref.get("datasetId") or ctx.panel.dataset_id
            values, ready = _metaprofile_values(dataset_profile(ctx, ds), ref.get("ruleId"))
        else:
            idx = resolve_catalog_track(ctx, ref.get("catalogEntryId"))
            values = (track_batch(ctx, idx).get("values") or []) if idx is not None else []
            ready = bool(values)
        out.append({"source": src, "values": values, "ready": ready})
    return out


def _annotation_target(ctx, composite: dict):
    """(ortho index, track type) when the browser draws this composite as annotation boxes."""
    if composite.get("kind") != "annotation" or len(composite.get("sources") or []) != 1:
        return None
    ref = composite["sources"][0].get("ref") or {}
    if ref.get("kind") == "metaprofile":
        return None
    idx = resolve_catalog_track(ctx, ref.get("catalogEntryId"))
    if idx is None:
        return None
    entry = next((e for e in ctx.fe.get("catalog") or [] if isinstance(e, dict) and e.get("id") == ref.get("catalogEntryId")), {})
    track = _server_tracks(ctx.state)[idx]
    motif = entry.get("kind") == "motif" or track.get("category") == "motif" or track.get("format") == "custom_motif"
    return idx, ("motif" if motif else track.get("format"))


# --- measure / draw -----------------------------------------------------------

def measure(ctx, track) -> float:
    composite = track.composite
    if not composite or not composite.get("visible", True):
        return 0.0
    heights = ctx.heights()
    default = heights["annotation"] if _annotation_target(ctx, composite) else heights["ortho"]
    return float(track.height or default)


def draw(surface, ctx, track, height: float) -> None:
    composite = track.composite or {}
    sidebar = cluster_sidebar_width(ctx)
    target = _annotation_target(ctx, composite)
    if target:
        idx, track_type = target
        item = track_batch(ctx, idx)
        surface.save()
        surface.translate(sidebar, 0)
        label = composite.get("label") or _server_tracks(ctx.state)[idx].get("label") or ""
        draw_annotation(surface, ctx, ctx.width - sidebar, height, label, item.get("intervals") or [],
                        composite["sources"][0].get("color"), track_type, composite.get("annotationStyle"))
        surface.restore()
        return
    draw_signal(surface, ctx, composite, resolve_sources(ctx, composite), ctx.width, height, sidebar)


def _path(values: list, y_for, sidebar: float, track_width: float) -> list[tuple[float, float]]:
    n = len(values)
    stepped = should_draw_stepped(n, track_width)
    denom = max(n - 1, 1)
    pts: list[tuple[float, float]] = []
    for i in range(n):
        y = y_for(values[i] if values[i] is not None else 0)
        if stepped:
            pts.append((sidebar + i / n * track_width, y))
            pts.append((sidebar + (i + 1) / n * track_width, y))
        else:
            pts.append((sidebar + i / denom * track_width if i else sidebar, y))
    return pts


def _drop_nan(points):
    """Canvas ignores lineTo(NaN): the line runs on to the next finite point."""
    return [p for p in points if not math.isnan(p[1])]


def draw_signal(surface, ctx, composite: dict, resolved: list[dict], width: float, height: float, sidebar: float) -> None:
    surface.rect(0, 0, width, height, fill="#fafafa")
    surface.text(4, 10, str(composite.get("label") or ""), size=9, color="#666666")
    visible = [r for r in resolved if r["source"].get("visible", True) and len(r["values"]) > 0]
    if not visible:
        # The browser says "computing…" while a source is still loading; a static
        # figure has nothing further coming, so it reads as no data.
        surface.text(width / 2, height / 2, "No data", size=10, color="#aaaaaa", anchor="middle")
        return

    padding, label_pad = 4, 12
    plot_top = padding + label_pad
    plot_bottom = height - padding
    plot_h = max(plot_bottom - plot_top, 1)
    track_width = width - sidebar
    log_scale = bool(composite.get("logScale"))

    def to_y(raw, y_of):
        if not _valid(raw):
            return y_of(0.0) if raw is None else float("nan")
        return y_of(raw)

    if composite.get("scaleMode") == "per-source":
        for r in visible:
            src, values = r["source"], r["values"]
            max_abs = 0.0
            for raw in values:
                if not _valid(raw):
                    continue
                max_abs = max(max_abs, abs(transform_value(raw, src, log_scale)))
            if max_abs <= 0:
                max_abs = 0.01
            draw_vals = reduce_signal_values(values, signal_point_limit(track_width), ctx.reversed)
            pts = _path(draw_vals, lambda raw, s=src, m=max_abs: to_y(
                raw, lambda v: plot_bottom - (transform_value(v, s, log_scale) / m) * plot_h), sidebar, track_width)
            surface.polyline(_drop_nan(pts), color=src.get("color") or "#2563eb", width=1.5)
        return

    mode = composite.get("scaleMode")
    if mode in ("manual", "group") and composite.get("yMin") is not None and composite.get("yMax") is not None:
        data_min, data_max = float(composite["yMin"]), float(composite["yMax"])
    else:
        data_min, data_max = math.inf, -math.inf
        for r in visible:
            for raw in r["values"]:
                if not _valid(raw):
                    continue
                v = transform_value(raw, r["source"], log_scale)
                data_min, data_max = min(data_min, v), max(data_max, v)
        if not math.isfinite(data_min):
            data_min = data_max = 0.0
    min_val, max_val = min(0.0, data_min), max(0.0, data_max)
    rng = max(max_val - min_val, 1e-9)

    def y_of(v: float) -> float:
        return plot_bottom - ((v - min_val) / rng) * plot_h

    baseline = y_of(0.0)
    if data_min < 0:
        surface.line(sidebar, baseline, width, baseline, "#bbbbbb", 1, dash=(2, 2))
    for r in visible:
        src = r["source"]
        draw_vals = reduce_signal_values(r["values"], signal_point_limit(track_width), ctx.reversed)
        pts = _path(draw_vals, lambda raw, s=src: to_y(raw, lambda v: y_of(transform_value(v, s, log_scale))),
                    sidebar, track_width)
        color = src.get("color") or "#2563eb"
        pts = _drop_nan(pts)
        fill_pts = [(sidebar, baseline)] + pts + [(width, baseline)]
        if len(fill_pts) >= 3:
            surface.polygon(fill_pts, fill=with_alpha(color, "30"))
        surface.polyline(pts, color=color, width=1.5)


# --- annotation composites (AnnotationTrack.tsx) --------------------------------

ANNOTATION_COLORS = {"gene": "#1e40af", "bed": "#2563eb", "bigBed": "#7c3aed", "motif": "#db2777",
                     "custom_motif": "#db2777", "rmsk": "#ea580c", "narrowPeak": "#dc2626",
                     "genePred": "#1e40af", "default": "#059669"}
DEFAULT_MOTIF_STYLE = {"scoreMin": 0, "scoreMax": 1, "scoreScale": "linear", "strandMode": "split",
                       "showScoreLegend": True}


def _clamp01(v) -> float:
    try:
        v = float(v)
    except (TypeError, ValueError):
        return 0.0
    return max(0.0, min(1.0, v if math.isfinite(v) else 0.0))


def _interval_score(iv: dict) -> float:
    s = iv.get("score")
    if not isinstance(s, (int, float)) or not math.isfinite(s):
        return 0.7
    return _clamp01(s if s <= 1 else s / 1000)


def _score_scale(v: float, scale: str) -> float:
    t = _clamp01(v)
    if scale == "sqrt":
        return math.sqrt(t)
    if scale == "square":
        return t * t
    if scale == "log":
        return math.log1p(t * 9) / math.log(10)
    return t


def _motif_intensity(iv: dict, style: dict):
    score = _interval_score(iv)
    lo = _clamp01(style["scoreMin"])
    hi = max(lo + 0.001, _clamp01(style["scoreMax"]))
    if score < lo:
        return None
    return _score_scale((score - lo) / (hi - lo), style["scoreScale"])


def draw_annotation(surface, ctx, width: float, height: float, label: str, intervals: list[dict],
                    color: str | None, track_type: str | None, style: dict | None) -> None:
    track_type = track_type or "bed"
    base = color or ANNOTATION_COLORS.get(track_type) or ANNOTATION_COLORS["default"]
    is_motif = track_type in ("motif", "custom_motif")
    motif_style = {**DEFAULT_MOTIF_STYLE, **(style or {})}
    view_start, view_end = ctx.start, ctx.end

    surface.rect(0, 0, width, height, fill="#fafafa")
    surface.text(4, 10, label, size=9, color="#666666")
    if is_motif and motif_style["showScoreLegend"] and width >= 190:
        lw, lx, ly, lh = 46, width - 46 - 6, 4, 5
        for i in range(lw):
            intensity = _score_scale(i / max(lw - 1, 1), motif_style["scoreScale"])
            surface.rect(lx + i, ly, 1, lh, fill=base, opacity=0.18 + intensity * 0.74)
        surface.rect(lx, ly, lw, lh, stroke="#9ca3af", stroke_width=0.5)
        surface.text(lx - 3, ly + lh + 1, "score", size=8, color="#777777", anchor="end")
        surface.text(lx, ly + 15, f"{round(_clamp01(motif_style['scoreMin']) * 100)}%", size=8, color="#777777")
        surface.text(lx + lw, ly + 15, f"{round(_clamp01(motif_style['scoreMax']) * 100)}%", size=8,
                     color="#777777", anchor="end")

    shown = [iv for iv in intervals if _motif_intensity(iv, motif_style) is not None] if is_motif else list(intervals)
    if not shown:
        surface.text(width / 2, height / 2, "No annotations", size=10, color="#999999", anchor="middle")
        return

    size = max(1, view_end - view_start)
    pad = 14
    inner = height - pad - 2

    def bp_x(bp: float) -> float:
        frac = (bp - view_start) / size
        return width * (1 - frac) if ctx.reversed else width * frac

    ordered = sorted(shown, key=lambda iv: iv["start"])
    split = is_motif and motif_style["strandMode"] == "split"
    rows: list[list[dict]] = []
    if split:
        rows.append(ordered)
    else:
        for iv in ordered:
            for row in rows:
                if iv["start"] >= row[-1]["end"]:
                    row.append(iv)
                    break
            else:
                rows.append([iv])
    max_rows = min(len(rows), 4 if is_motif else 5)
    gap = 1
    row_h = (max(2, math.floor((inner - gap * max(0, max_rows - 1)) / max_rows)) if is_motif
             else min(math.floor(inner / max_rows), 12))

    for r in range(max_rows):
        y = pad + r * (row_h + gap)
        if split:
            mid = y + row_h / 2
            surface.line(0, mid, width, mid, "#d1d5db", 0.5)
        for iv in rows[r]:
            a, b = bp_x(max(iv["start"], view_start)), bp_x(min(iv["end"], view_end))
            left, rect_w = min(a, b), max(abs(b - a), 1)
            blocks = iv.get("blocks") or []
            if blocks and track_type == "genePred":
                mid = y + row_h / 2
                surface.line(left, mid, left + rect_w, mid, base, 1)
                for blk in blocks:
                    b1 = bp_x(max(blk["start"], view_start))
                    b2 = bp_x(min(blk["start"] + blk["size"], view_end))
                    cds = (iv.get("cdsStart") is not None and iv.get("cdsEnd") is not None
                           and blk["start"] + blk["size"] > iv["cdsStart"] and blk["start"] < iv["cdsEnd"])
                    bh = row_h if cds else row_h * 0.5
                    surface.rect(min(b1, b2), y + (row_h - bh) / 2, max(abs(b2 - b1), 1), bh, fill=base)
                if iv.get("strand") and rect_w > 20:
                    ax = left + 30
                    while ax < left + rect_w - 5:
                        surface.text(ax, mid + 3, ">" if iv["strand"] == "+" else "<", size=min(row_h - 2, 10),
                                     color="#ffffff", anchor="middle")
                        ax += 30
            elif is_motif:
                intensity = _motif_intensity(iv, motif_style)
                if intensity is None:
                    continue
                alpha = 0.2 + intensity * 0.75
                mw = max(rect_w, 3)
                center = left + rect_w / 2
                strand = iv.get("strand") if iv.get("strand") in ("+", "-") else None
                split_strands = motif_style["strandMode"] == "split" and strand is not None
                half = max(2, math.floor((row_h - 1) / 2))
                lane_y = y + math.ceil(row_h / 2) if split_strands and strand == "-" else y
                lane_h = half if split_strands else row_h
                surface.polygon(rounded_rect_points(center - mw / 2, lane_y, mw, lane_h, min(3, lane_h / 2)),
                                fill=base, opacity=alpha)
                surface.line(center, lane_y, center, lane_y + lane_h, base, 0.75)
                if motif_style["strandMode"] != "none" and strand and mw >= 8 and lane_h >= 7:
                    # Browser: a white ▸/◂ glyph; drawn as a triangle so PDF keeps it.
                    right = (strand == "+") != ctx.reversed
                    s = max(8, min(lane_h - 1, 12 if mw > 16 else 10)) * 0.35
                    cy = lane_y + lane_h / 2 + 0.5
                    tri = ([(center - s * 0.6, cy - s), (center + s * 0.8, cy), (center - s * 0.6, cy + s)] if right
                           else [(center + s * 0.6, cy - s), (center - s * 0.8, cy), (center + s * 0.6, cy + s)])
                    surface.polygon(tri, fill="#ffffff", stroke="rgba(0,0,0,0.28)", stroke_width=1)
            else:
                surface.rect(left, y, rect_w, row_h, fill=with_alpha(base, "80"), stroke=base, stroke_width=0.5)
                if iv.get("strand") and rect_w > 8:
                    surface.text(left + rect_w / 2, y + row_h - 2, ">" if iv["strand"] == "+" else "<",
                                 size=min(row_h - 2, 9), color=base, anchor="middle")
            if iv.get("name") and rect_w > (50 if is_motif else 30):
                surface.save()
                surface.clip_rect(left, y, rect_w, row_h)
                surface.text(left + 2, y + row_h - 2, str(iv["name"]), size=min(row_h - 3, 9), color="#333333")
                surface.restore()

    if len(rows) > max_rows:
        surface.text(width - 4, height - 2, f"+{len(rows) - max_rows} more rows", size=8, color="#999999",
                     anchor="end")


register("composite", measure, draw)
