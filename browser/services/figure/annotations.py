"""Annotation overlays for scripted headless figures: a BED track, boxes through the reads, opening-width
classes per read and per-panel / per-cluster side statistics.

    annotations = {
        "bed": "/path/regions.bed",            # or "intervals": [{"chrom", "start", "end", "name"}, ...]
        "draw": "both",                        # "track" (a labelled row above the reads), "through" (boxes over
                                               # the reads), "both" or "none"
        "color": "#7c3aed", "track_height": 18, "label_size": 10, "through_opacity": 0.10,
        "target": 0,                           # the interval the classes and statistics use: an index into the
                                               # intervals in view, a BED name, or [start, end]
        "patch_layer": "msp",                  # which read layer is the "accessible patch" (see below)
        "patch_window": 5000,                  # bp each side of the target read for full patch lengths
        "classes": true,                       # or {"thresholds": [175, 300, 500], "names": [...], "colors": [...]}
        "stats": true,                         # or {"per": "both" | "panel" | "cluster", "position": "right",
                                               #     "size": 9}
    }

Nothing is drawn or computed unless ``annotations`` is set.

Accessible patch
    An interval of the read's ``patch_layer`` layer as /api/reads/compact serves it for the drawn reads:
    by default ``msp``, the methylation-sensitive patches (fibertools/FiberHMM ``as``/``al`` tags, the
    ``msp`` MA layer, or an ``_msp`` bigBed). Any other layer name ("fire", "linker", ...) can be named. A
    dataset whose reads carry no interval of that layer anywhere in the view is an error, not "no opening".

Opening width and class
    For each drawn read, the patches overlapping the target interval (half-open: patch start < target end
    and patch end > target start). The width is the whole patch length, not the overlap: patches are read
    over the target plus ``patch_window`` bp (default 5000) on each side, so a patch running past the view
    keeps its length; one reaching that window's edge is counted in ``patches_at_window_edge`` (its width
    is then at least the window, far above any default class threshold). With several overlapping patches
    the widest counts. Class i holds widths in [thresholds[i-1], thresholds[i]): with the defaults
    < 175 bp, 175-300, 300-500 and >= 500 bp, named by ``names`` (defaults below). The overlapping patch
    is painted over the read in its class colour, across its drawn extent.

No opening
    Among reads spanning the target (an aligned block of the read covers the whole target interval), those
    with no patch overlapping it. ``n`` is the number of spanning reads; the side annotation shows ``n`` and
    the percentage with no opening, per panel and per cluster. Drawn reads that do not span the target
    are left out of both and counted as ``not_spanning``.
"""
from __future__ import annotations

import os
from typing import Optional

DEFAULT_THRESHOLDS = (175, 300, 500)
DEFAULT_CLASS_NAMES = ("<175 bp", "potentiated", "merged", "actuated")
DEFAULT_CLASS_COLORS = ("#9ca3af", "#f59e0b", "#ea580c", "#b91c1c")
DEFAULT_COLOR = "#7c3aed"
DRAW_MODES = ("track", "through", "both", "none")
STAT_SCOPES = ("panel", "cluster", "both")


# ---------------------------------------------------------------------------
# options
# ---------------------------------------------------------------------------
def check_public(annotations: dict) -> None:
    if isinstance(annotations, dict) and annotations.get("bed"):
        from services.figure_render import FigureError
        raise FigureError("annotations.bed reads a file; on a public server send annotations.intervals", status=403)


def read_bed(path: str) -> list[dict]:
    """BED3+ rows (name from column 4 when present); track/browser/# lines are skipped."""
    rows = []
    # Through the lab file gate (plain open off the lab profile): a BED named in a session or request is confined to
    # the member's read roots like every other file a figure reads.
    from services.lab.paths import open_read
    with open_read(os.path.expanduser(path), text=True) as handle:
        for line_no, line in enumerate(handle, 1):
            if not line.strip() or line.startswith(("#", "track", "browser")):
                continue
            cols = line.rstrip("\n").split("\t")
            if len(cols) < 3:
                cols = line.split()
            try:
                rows.append({"chrom": cols[0], "start": int(cols[1]), "end": int(cols[2]),
                             "name": cols[3] if len(cols) > 3 and cols[3] != "." else ""})
            except (IndexError, ValueError):
                raise ValueError(f"{path}:{line_no}: not a BED line") from None
    return rows


def _intervals(spec: dict) -> list[dict]:
    rows = []
    if spec.get("bed"):
        rows.extend(read_bed(spec["bed"]))
    for item in spec.get("intervals") or []:
        if isinstance(item, dict):
            rows.append({"chrom": str(item["chrom"]), "start": int(item["start"]), "end": int(item["end"]),
                         "name": str(item.get("name") or "")})
        else:
            rows.append({"chrom": str(item[0]), "start": int(item[1]), "end": int(item[2]),
                         "name": str(item[3]) if len(item) > 3 else ""})
    for r in rows:
        if r["end"] <= r["start"]:
            raise ValueError(f"annotation interval {r['chrom']}:{r['start']}-{r['end']} is empty")
    return rows


def _ramp(n: int) -> list[str]:
    lo, hi = (0x9c, 0xa3, 0xaf), (0xb9, 0x1c, 0x1c)
    if n == 1:
        return ["#%02x%02x%02x" % hi]
    return ["#%02x%02x%02x" % tuple(round(a + (b - a) * i / (n - 1)) for a, b in zip(lo, hi)) for i in range(n)]


def _as_dict(value, defaults: dict) -> Optional[dict]:
    if not value:
        return None
    out = dict(defaults)
    if isinstance(value, dict):
        out.update({k: v for k, v in value.items() if v is not None})
    return out


def resolve(raw: dict) -> dict:
    """Validated annotation options with defaults (cached on the dict by the caller)."""
    if not isinstance(raw, dict):
        raise ValueError("annotations must be an object")
    known = {"bed", "intervals", "draw", "color", "track_height", "label_size", "through_opacity", "target",
             "patch_layer", "patch_window", "classes", "stats"}
    unknown = sorted(set(raw) - known)
    if unknown:
        raise ValueError(f"annotations: unknown option(s) {', '.join(unknown)}")
    draw = raw.get("draw") or "both"
    if draw not in DRAW_MODES:
        raise ValueError(f"annotations.draw must be one of {', '.join(DRAW_MODES)}")
    raw_classes = raw.get("classes")
    classes = _as_dict(raw_classes, {"thresholds": list(DEFAULT_THRESHOLDS), "names": list(DEFAULT_CLASS_NAMES),
                                     "colors": list(DEFAULT_CLASS_COLORS), "opacity": 1.0})
    if classes:
        th = [float(t) for t in classes["thresholds"]]
        given = raw_classes if isinstance(raw_classes, dict) else {}
        if len(th) != len(DEFAULT_THRESHOLDS):
            # Other class counts: width-range names and a grey-to-red ramp unless given.
            if not given.get("names"):
                classes["names"] = ([f"<{th[0]:g} bp"] + [f"{lo:g}-{hi:g} bp" for lo, hi in zip(th, th[1:])]
                                    + [f">={th[-1]:g} bp"]) if th else ["all"]
            if not given.get("colors"):
                classes["colors"] = _ramp(len(th) + 1)
        if th != sorted(th) or len(set(th)) != len(th) or any(t <= 0 for t in th):
            raise ValueError("annotations.classes.thresholds must be increasing positive widths (bp)")
        n = len(th) + 1
        names = list(classes["names"])
        colors = list(classes["colors"])
        if len(names) != n or len(colors) != n:
            raise ValueError(f"annotations.classes: {len(th)} thresholds make {n} classes; give {n} names and colours")
        classes.update(thresholds=th, names=[str(x) for x in names], colors=[str(c) for c in colors])
    stats = _as_dict(raw.get("stats"), {"per": "both", "position": "right", "size": 9})
    if stats and stats["per"] not in STAT_SCOPES:
        raise ValueError(f"annotations.stats.per must be one of {', '.join(STAT_SCOPES)}")
    return {
        "intervals": _intervals(raw), "draw": draw, "color": raw.get("color") or DEFAULT_COLOR,
        "track_height": float(raw.get("track_height") or 18), "label_size": float(raw.get("label_size") or 10),
        "through_opacity": float(raw.get("through_opacity") if raw.get("through_opacity") is not None else 0.10),
        "target": raw.get("target", 0), "patch_layer": str(raw.get("patch_layer") or "msp"),
        "patch_window": int(raw.get("patch_window") or 5000),
        "classes": classes, "stats": stats,
    }


def options_of(ctx) -> Optional[dict]:
    raw = (ctx.spec.options or {}).get("annotations")
    if not raw:
        return None
    return ctx.data.get(("annotation-options",), lambda: resolve(raw))


def _in_view(ctx, ann: dict) -> list[dict]:
    from utils.chrom import same_chrom
    return [r for r in ann["intervals"] if same_chrom(r["chrom"], ctx.chrom) and r["end"] > ctx.start
            and r["start"] < ctx.end]


def target_interval(ctx, ann: dict) -> Optional[tuple]:
    """(start, end, name) of the interval the classes and statistics use, or None."""
    target = ann["target"]
    if isinstance(target, (list, tuple)) and len(target) >= 2:
        return int(target[0]), int(target[1]), str(target[2]) if len(target) > 2 else ""
    rows = _in_view(ctx, ann)
    if isinstance(target, str):
        hit = [r for r in rows if r["name"] == target]
        if not hit:
            raise ValueError(f"annotations.target {target!r}: no interval of that name in view")
        r = hit[0]
    else:
        if not rows:
            return None
        index = int(target or 0)
        if not 0 <= index < len(rows):
            raise ValueError(f"annotations.target {index}: {len(rows)} interval(s) in view")
        r = rows[index]
    return r["start"], r["end"], r["name"]


# ---------------------------------------------------------------------------
# the annotation track (a labelled row above the reads)
# ---------------------------------------------------------------------------
def measure(ctx, track) -> float:
    ann = options_of(ctx)
    if not ann or ann["draw"] not in ("track", "both"):
        return 0.0
    return float(track.height or ann["track_height"])


def draw(surface, ctx, track, height: float) -> None:
    from services.figure.tracks.reads import SIDEBAR_WIDTH, _has_any_clusters
    ann = options_of(ctx)
    sidebar = SIDEBAR_WIDTH if _has_any_clusters(ctx.fe) else 0
    region = max(1, ctx.end - ctx.start)
    scale = (ctx.width - sidebar) / region

    def x(pos):
        rel = pos - ctx.start
        return sidebar + ((region - rel) if ctx.reversed else rel) * scale

    for r in _in_view(ctx, ann):
        x0, x1 = sorted((x(max(r["start"], ctx.start)), x(min(r["end"], ctx.end))))
        box_h = max(3.0, height * 0.35)
        surface.rect(x0, height - box_h - 1, max(1.0, x1 - x0), box_h, fill=ann["color"], opacity=0.85)
        if r["name"]:
            surface.text((x0 + x1) / 2, height - box_h - 3, r["name"], size=ann["label_size"], color=ann["color"],
                         anchor="middle", weight="bold")


# ---------------------------------------------------------------------------
# over the reads: boxes, opening classes, statistics
# ---------------------------------------------------------------------------
def _spans(read: dict, t0: int, t1: int, view_start: int) -> bool:
    blocks = read.get("aligned_blocks")
    if blocks:
        return any(int(a) <= t0 and int(b) >= t1 for a, b in blocks)
    from services.figure.tracks.reads import _extent
    ext = _extent(read)
    return bool(ext) and view_start + ext[0] <= t0 and view_start + ext[1] >= t1


def opening_table(ctx, reads: list, ann: dict, target: tuple) -> list[dict]:
    """Per drawn read (in row order): spans, widest overlapping patch (abs start/end/width), class index."""
    t0, t1, _name = target
    layer = ann["patch_layer"]
    ids = [r["id"] for r in reads]
    # Patches are fetched over the target plus ``patch_window`` bp each side, not the view, so a patch running
    # past the view keeps its full length (the served intervals are clipped to the fetched window).
    pad = int(ann["patch_window"])
    w0, w1 = max(0, t0 - pad), t1 + pad
    payload = ctx.data.compact_reads(ctx.panel.dataset_id, max_reads=0, layer_names=[layer], filter_ids=ids,
                                     strand=ctx.panel.strand, region=(ctx.chrom, w0, w1),
                                     spanning=False)  # the drawn reads, whether or not they span the wider window
    by_id = {r["id"]: r for r in payload.get("reads") or []}
    any_layer = any(((r.get("layers") or {}).get(layer) or {}).get("intervals") for r in by_id.values())
    if reads and not any_layer:
        available = sorted(set(payload.get("available_layers") or []))
        raise ValueError(f"annotations.patch_layer {layer!r}: no read of {ctx.panel.label} carries it in this view"
                         + (f" (layers: {', '.join(available)})" if available else ""))
    # An explicit empty list is one class ("all"); only an absent list takes the defaults.
    th = (ann["classes"] or {}).get("thresholds")
    thresholds = list(DEFAULT_THRESHOLDS) if th is None else th
    rows = []
    for read in reads:
        src = by_id.get(read["id"]) or read
        best = None
        clipped = False
        for iv in ((src.get("layers") or {}).get(layer) or {}).get("intervals") or []:
            s, e = w0 + int(iv[0]), w0 + int(iv[1])
            if s < t1 and e > t0 and (best is None or e - s > best[2]):
                best = (s, e, e - s)
                clipped = (s <= w0 and w0 > 0) or e >= w1
        cls = None
        if best is not None:
            cls = sum(1 for t in thresholds if best[2] >= t)
        rows.append({"id": read["id"], "spans": _spans(src, t0, t1, w0 if src is not read else ctx.start),
                     "patch": best, "class": cls, "clipped": bool(best is not None and clipped)})
    return rows


def _summary(rows: list, ann: dict) -> dict:
    spanning = [r for r in rows if r["spans"]]
    closed = [r for r in spanning if r["patch"] is None]
    out = {"n": len(spanning), "no_opening": len(closed),
           "pct_no_opening": round(100.0 * len(closed) / len(spanning), 2) if spanning else None,
           "not_spanning": len(rows) - len(spanning),
           "patches_at_window_edge": sum(1 for r in spanning if r.get("clipped"))}
    if ann["classes"]:
        names = ann["classes"]["names"]
        out["classes"] = {name: sum(1 for r in spanning if r["class"] == i) for i, name in enumerate(names)}
    return out


def draw_over_reads(surface, ctx, view: dict, geo: dict, painter) -> None:
    """Called by the read track after it draws: boxes, class colours and side statistics."""
    ann = options_of(ctx)
    if not ann:
        return
    reads = view.get("reads") or []
    top, stride = geo["hist"], geo["stride"]
    rows_h = len(reads) * stride
    for r in _in_view(ctx, ann) if ann["draw"] in ("through", "both") else []:
        x0, x1 = painter.span(max(r["start"], ctx.start) - ctx.start, min(r["end"], ctx.end) - ctx.start)
        x0, x1 = float(x0), float(x1)
        surface.rect(x0, top, x1 - x0, rows_h, fill=ann["color"], opacity=ann["through_opacity"])
        surface.line(x0, top, x0, top + rows_h, ann["color"], 0.75, opacity=0.6)
        surface.line(x1, top, x1, top + rows_h, ann["color"], 0.75, opacity=0.6)
    if not (ann["classes"] or ann["stats"]) or not reads:
        return
    target = target_interval(ctx, ann)
    if target is None:
        return
    table = ctx.data.get(("annotation-table", ctx.panel.id), lambda: opening_table(ctx, reads, ann, target))
    if ann["classes"]:
        colors, alpha = ann["classes"]["colors"], float(ann["classes"].get("opacity", 1.0))
        h = max(0.5, painter.fh)
        for i, row in enumerate(table):
            if row["patch"] is None:
                continue
            s, e, _w = row["patch"]
            a, b = max(s, ctx.start) - ctx.start, min(e, ctx.end) - ctx.start
            if b <= a:
                continue
            x0, x1 = painter.span(a, b)
            surface.rect(float(x0), top + i * stride, float(x1 - x0), h, fill=colors[row["class"]], opacity=alpha)
    from services.figure.tracks.reads import _panel_state, cluster_for
    assignments = _panel_state(ctx.fe, ctx.panel.state_key)["assignments"]
    stats = {"target": {"chrom": ctx.chrom, "start": target[0], "end": target[1], "name": target[2]},
             "patch_layer": ann["patch_layer"], "panel": _summary(table, ann)}
    blocks = []
    if assignments:
        current, first = object(), 0
        for i, read in enumerate(reads + [None]):
            c = cluster_for(assignments, read["id"]) if read is not None else object()
            if i == 0:
                current = c
                continue
            if read is None or c != current:
                blocks.append((current, first, i))
                current, first = c, i
        stats["clusters"] = {("unclustered" if c is None else str(c)): _summary(table[a:b], ann) for c, a, b in blocks}
    if ann["classes"]:
        stats["class_thresholds"] = ann["classes"]["thresholds"]
        stats["class_names"] = ann["classes"]["names"]
    ctx.data._cache[("annotation-stats", ctx.panel.id)] = stats
    if ann["stats"]:
        _draw_stats(surface, ctx, ann["stats"], stats, blocks, top, stride)


def _stat_label(s: dict) -> str:
    if not s["n"]:
        return "n=0"
    return f"n={s['n']} · {s['pct_no_opening']:.0f}% no opening"


def _draw_stats(surface, ctx, opt: dict, stats: dict, blocks: list, top: float, stride: float) -> None:
    from services.figure.surface import measure_text
    size = float(opt.get("size") or 9)
    right = opt.get("position", "right") != "left"
    x = ctx.width - 3 if right else 3

    def label(y, text):
        w = measure_text(text, size)
        bx = x - w - 2 if right else x - 2
        surface.rect(bx, y - size, w + 4, size + 3, fill="#ffffff", opacity=0.8)
        surface.text(x, y, text, size=size, color="#111827", anchor="end" if right else "start")

    per = opt.get("per", "both")
    if per in ("panel", "both"):
        label(top + size + 1, _stat_label(stats["panel"]))
    if per in ("cluster", "both") and blocks:
        for c, a, b in blocks:
            key = "unclustered" if c is None else str(c)
            shift = size + 3 if (per == "both" and a == 0) else 0
            # A cluster too short for its label keeps its numbers in the manifest only.
            if (b - a) * stride >= size + 3 + shift:
                label(top + a * stride + size + 1 + shift, f"C{key}: " + _stat_label(stats["clusters"][key]))


def register_track() -> None:
    from services.figure.tracks import register
    register("annotation", measure, draw)


register_track()
