"""Peaks track (FireTrack.tsx): one row per enabled peak rule, named by the rule.

Peaks are the browser's own ``peaksByRule`` when the view carries them. Like
the browser, a view without peaks for an enabled rule gets them from the
server peak scan (Browser.tsx handleScanPeaks -> /api/scan_peaks), run here
in-process through the same endpoint function.
"""
from __future__ import annotations

from typing import Optional

from services.figure.tracks import register
from services.figure.tracks._util import cluster_sidebar_width, generate_layer_colors, track_x

LABEL_HEIGHT = 14
PADDING = 2

# FireTrack MODE_COLORS: selected-peak fill/stroke by peak mode.
MODE_COLORS = {
    "accessibility": ("rgba(16, 185, 129, 0.8)", "#059669"),
    "tf": ("rgba(249, 115, 22, 0.8)", "#ea580c"),
    "tf_layer": ("rgba(224, 64, 251, 0.8)", "#c026d3"),
    "nuc": ("rgba(22, 163, 74, 0.8)", "#15803d"),
    "nuc_layer": ("rgba(22, 163, 74, 0.8)", "#15803d"),
    "msp": ("rgba(251, 146, 60, 0.8)", "#f97316"),
    "fire": ("rgba(251, 146, 60, 0.8)", "#f97316"),
    "modification": ("rgba(139, 92, 246, 0.8)", "#7c3aed"),
    "mod": ("rgba(139, 92, 246, 0.8)", "#7c3aed"),
    "annotation": ("rgba(99, 102, 241, 0.8)", "#4f46e5"),
}

# Rule sources the browser scans on the server (scanPeaksForRule backendSources):
# every read signal the peak scanner reads, modification marks included.
from services.peak_scanning import READ_SIGNAL_SOURCES as BACKEND_SOURCES, is_read_signal_source  # noqa: E402,F401


def _rules(ctx) -> list[dict]:
    return [r for r in ctx.fe.get("peakRules") or [] if isinstance(r, dict)]


def _selected(ctx) -> set:
    raw = ctx.fe.get("selectedPeaks") or []
    out = set()
    for v in raw:
        try:
            out.add(int(v))
        except (TypeError, ValueError):
            continue
    return out


def _scan_rule(ctx, rule: dict, region: Optional[tuple] = None) -> list[dict]:
    """handleScanPeaks for one rule: the server scan over the panels' datasets.

    `region`: scan the panels at that other locus instead of the main view's.
    """
    from models.requests import ScanPeaksRequest
    from services.clustering_endpoint import run_scan_peaks_endpoint

    fe, spec = ctx.fe, ctx.spec
    main = (spec.chrom, spec.start, spec.end)
    panels = [p for p in spec.panels if (p.region if p.region != main else None) == region]
    chrom, start, end = region or (spec.chrom, spec.start, spec.end)
    dataset_ids: list[str] = []
    for panel in panels:
        if panel.dataset_id not in dataset_ids:
            dataset_ids.append(panel.dataset_id)
    # The browser scans the reads each panel shows (activeReadIds); ask the
    # read track for them (it is laid out after this track).
    from dataclasses import replace
    from services.figure.tracks.reads import display_read_ids
    # Every panel of a dataset here counts (CT and GA panels, a filtered copy):
    # the union of what they show, as the browser's collectScanReadIds does.
    by_dataset: dict[str, list[str]] = {}
    for panel in panels:
        try:
            ids = display_read_ids(replace(ctx, panel=panel))
        except Exception:
            ids = None
        if ids:
            seen = by_dataset.setdefault(panel.dataset_id, [])
            have = set(seen)
            seen.extend(i for i in ids if i not in have)
    # A dataset shown only in one-strand panels, none with reads, has nothing to
    # scan (not both strands), as the browser's collectScanReadIds decides.
    empty_strand = {
        ds for ds in dataset_ids
        if ds not in by_dataset
        and all(p.strand for p in panels if p.dataset_id == ds)
    }
    dataset_ids = [ds for ds in dataset_ids if ds not in empty_strand]
    if not dataset_ids:
        return []
    thresholds = list(rule.get("thresholds") or [0.5, 0.3, 0.15, 0.08]) + [0.08] * 4
    key = ("peaks.scan", chrom, start, end, rule.get("source"), tuple(thresholds[:4]),
           rule.get("smoothWidth"), rule.get("minPeakWidth"), rule.get("minReads"), tuple(dataset_ids),
           tuple(sorted((k, len(v)) for k, v in by_dataset.items())))

    def load():
        req = ScanPeaksRequest(
            min_width=int(rule.get("minPeakWidth") or 80),
            min_reads=int(rule.get("minReads") if rule.get("minReads") is not None else 5),
            smooth_width=int(rule.get("smoothWidth") or 100),
            threshold_strong=float(thresholds[0]), threshold_medium=float(thresholds[1]),
            threshold_weak=float(thresholds[2]), threshold_rare=float(thresholds[3]),
            read_ids_by_dataset=by_dataset or None,
            dataset_ids=[d for d in dataset_ids if not by_dataset or d in by_dataset] or dataset_ids,
            signal_source=str(rule.get("source") or "accessibility"),
            return_signal=False,
            sample_seed=fe.get("analysisSampleSeed"),
        )
        try:
            res = run_scan_peaks_endpoint(
                state=ctx.state, req=req, chrom=chrom, start=start, end=end,
                dataset_id=dataset_ids[0] if len(dataset_ids) == 1 else None, spanning=False,
            )
        except Exception:
            return []
        return [{"start": p["start"], "end": p["end"], "index": p.get("index", 0), "layer": p.get("layer", 0),
                 "score": p.get("score"), "threshold": p.get("threshold")} for p in res.get("peaks") or []]

    return ctx.data.get(key, load)


def peaks_by_rule(ctx) -> dict[str, list[dict]]:
    """The peaks the browser would show for this view, per rule id."""
    def load():
        fe = ctx.fe
        stored = {k: list(v or []) for k, v in (fe.get("peaksByRule") or {}).items() if isinstance(v, list)}
        rules = [r for r in _rules(ctx) if r.get("enabled") and r.get("source") != "custom"]
        # The browser's auto-scan: skipped while peaks are locked, while a peak
        # selection exists, or under dynamic clustering; otherwise any enabled
        # rule without peaks triggers a scan of every enabled rule.
        frozen = bool(fe.get("peaksLocked")) or bool(_selected(ctx)) or bool(fe.get("dynamicClustering"))
        needs_scan = bool(fe.get("_peaksFromAnotherView")) or any(not stored.get(r.get("id")) for r in rules)
        if frozen or not needs_scan or not ctx.spec.panels:
            return stored
        out = dict(stored)
        spec = ctx.spec
        # Panels at other loci are scanned too; their peaks carry their chromosome.
        others = sorted({p.region for p in spec.panels if p.region and p.region != (spec.chrom, spec.start, spec.end)})
        for rule in rules:
            if is_read_signal_source(rule.get("source")):
                main = (spec.chrom, spec.start, spec.end)
                peaks = _scan_rule(ctx, rule) if any(p.region in (None, main) for p in spec.panels) else []
                for region in others:
                    for p in _scan_rule(ctx, rule, region):
                        overlaps = [q for q in peaks if (q.get("chrom") or spec.chrom) == region[0]
                                    and p["start"] < q["end"] and p["end"] > q["start"]]
                        if not overlaps:
                            peaks.append({**p, "chrom": region[0]})
                out[rule["id"]] = peaks
        return out

    return ctx.data.get(("peaks.byRule",), load)


def _visible_rules(ctx, by_rule) -> list[dict]:
    """Enabled rules; an empty Custom row (on screen, somewhere to draw) is left out of figures."""
    def in_view(p):
        # A peak without a chrom was scanned in the main view.
        return (p.get("chrom") or ctx.spec.chrom) == ctx.chrom and p.get("end", 0) > ctx.start and p.get("start", 0) < ctx.end
    return [r for r in _rules(ctx) if r.get("enabled")
            and (r.get("source") != "custom" or any(in_view(p) for p in by_rule.get(r.get("id"), []) or []))]


def measure(ctx, track) -> float:
    return float(track.height or ctx.heights()["fire"])


def draw(surface, ctx, track, height: float) -> None:
    width = ctx.width
    sidebar = cluster_sidebar_width(ctx)
    by_rule = peaks_by_rule(ctx)
    rules = _visible_rules(ctx, by_rule)
    num_rows = max(1, len(rules))
    selected = _selected(ctx)
    modes = {str(k): v for k, v in (ctx.fe.get("peakModes") or {}).items()}

    surface.rect(0, 0, width, height, fill="#ffffff")
    surface.text(4, 11, "Peaks", size=10, color="#666666")

    grid_top = LABEL_HEIGHT
    grid_height = height - LABEL_HEIGHT - PADDING
    row_height = int(grid_height // num_rows)
    peak_height = row_height - 4

    for r in range(num_rows):
        surface.rect(0, grid_top + r * row_height, width, row_height, fill="#f8f9fa" if r % 2 == 0 else "#ffffff")
        if r > 0:
            surface.line(0, grid_top + r * row_height, width, grid_top + r * row_height, "#e0e0e0", 1)

    for r, rule in enumerate(rules):
        surface.text(4, grid_top + r * row_height + row_height / 2 + 3, str(rule.get("name") or ""),
                     size=9, color=rule.get("color") or "#666666")

    chrom = ctx.chrom
    for r, rule in enumerate(rules):
        colors = generate_layer_colors(rule.get("color") or "#1d4ed8", float(rule.get("opacity", 0.7)),
                                       bool(rule.get("useGradient")))
        is_custom = rule.get("source") == "custom"
        y = grid_top + r * row_height + 2
        h = row_height - 2 if is_custom else peak_height
        for peak in by_rule.get(rule.get("id"), []) or []:
            if (peak.get("chrom") or ctx.spec.chrom) != chrom:
                continue
            if not (peak["end"] > ctx.start and peak["start"] < ctx.end):
                continue
            x1r, x2r = track_x(ctx, peak["start"], sidebar), track_x(ctx, peak["end"], sidebar)
            x1 = min(x1r, x2r)
            w = max(abs(x2r - x1r), 3)
            index = peak.get("index")
            if index in selected:
                surface.rect(x1, y, w, h, stroke="#000000", stroke_width=3)
                fill, _ = MODE_COLORS.get(modes.get(str(index)) or "accessibility", MODE_COLORS["accessibility"])
                surface.rect(x1, y, w, h, fill=fill)
            else:
                layer = int(peak.get("layer") or 0)
                lc = colors[max(0, min(layer, len(colors) - 1))]
                surface.rect(x1, y, w, h, fill=lc["fill"], stroke=lc["stroke"], stroke_width=2 if is_custom else 1)

    # Locked cluster peak regions (dynamic clustering), dashed teal on the last row.
    regions = ctx.fe.get("clusterPeakRegions") or []
    if ctx.fe.get("dynamicClustering") and regions:
        # The last scanned row (the Custom row below it only holds drawn peaks).
        scanned = [i for i, r in enumerate(rules) if r.get("source") != "custom"]
        y_auto = grid_top + (scanned[-1] if scanned else num_rows - 1) * row_height + 2
        for region in regions:
            # Another locus's peak (FireTrack skips those too), or off screen.
            if not isinstance(region, dict) or (region.get("chrom") or ctx.spec.chrom) != ctx.chrom:
                continue
            try:
                if not (region["end"] > ctx.start and region["start"] < ctx.end):
                    continue
                x1r, x2r = track_x(ctx, region["start"], sidebar), track_x(ctx, region["end"], sidebar)
            except (KeyError, TypeError):
                continue
            x1 = min(x1r, x2r)
            w = max(abs(x2r - x1r), 3)
            for seg in ((x1, y_auto, x1 + w, y_auto), (x1 + w, y_auto, x1 + w, y_auto + peak_height),
                        (x1 + w, y_auto + peak_height, x1, y_auto + peak_height), (x1, y_auto + peak_height, x1, y_auto)):
                surface.line(*seg, color="#0d9488", width=2, dash=(3, 2))


register("fire", measure, draw)
