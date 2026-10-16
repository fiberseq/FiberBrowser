"""Gene track (GeneTrack.tsx): gene models packed into rows, strand colours, labels.

Genes come from the same server function as the browser's /api/genes.
"""
from __future__ import annotations

from services.figure.surface import measure_text
from services.figure.tracks import register
from services.figure.tracks._util import cluster_sidebar_width

PLUS_COLOR = "#2563eb"
MINUS_COLOR = "#dc2626"
SELECTION_COLOR = "#fbbf24"
MIN_ROW_HEIGHT = 14


def load_genes(ctx) -> list[dict]:
    """/api/genes for the view (get_genes_payload), limited to visible genes."""
    def load():
        from services.read_auxiliary_endpoint import get_genes_payload
        try:
            payload = get_genes_payload(ctx.state, chrom=ctx.chrom, start=ctx.start, end=ctx.end)
        except Exception:
            return []
        genes = (payload.get("content") or {}).get("genes") or []
        return [g for g in genes if g.get("end", 0) > ctx.start and g.get("start", 0) < ctx.end]

    return ctx.data.get(("genes", ctx.chrom, ctx.start, ctx.end), load)


def merge_isoforms(genes: list[dict]) -> tuple[list[dict], dict[str, int]]:
    """mergeIsoforms: same-name transcripts -> one gene with union exons."""
    groups: dict[str, list[dict]] = {}
    no_name: list[dict] = []
    for g in genes:
        name = g.get("name")
        if not name:
            no_name.append(g)
        else:
            groups.setdefault(name, []).append(g)
    merged = list(no_name)
    counts: dict[str, int] = {}
    for name, isoforms in groups.items():
        if len(isoforms) == 1:
            merged.append(isoforms[0])
            continue
        counts[name] = len(isoforms)
        exons = sorted((e for g in isoforms for e in g.get("exons") or []), key=lambda e: e["start"])
        union: list[dict] = []
        for ex in exons:
            if union and ex["start"] <= union[-1]["end"]:
                union[-1]["end"] = max(union[-1]["end"], ex["end"])
            else:
                union.append({"start": ex["start"], "end": ex["end"]})
        merged.append({
            "id": f"merged-{name}", "name": name, "chrom": isoforms[0].get("chrom"),
            "start": min(g["start"] for g in isoforms), "end": max(g["end"] for g in isoforms),
            "strand": isoforms[0].get("strand"), "biotype": isoforms[0].get("biotype"), "exons": union,
        })
    return merged, counts


def _assign_rows(genes: list[dict], x_of) -> tuple[dict, int]:
    rows: dict = {}
    row_ends: list[float] = []
    # Pack by screen edges, left to right (in a reversed view a gene's start
    # is its right edge); same as GeneTrack.tsx.
    spans = []
    for gene in genes:
        a, b = x_of(gene["start"]), x_of(gene["end"])
        spans.append((min(a, b), max(a, b), gene))
    for left, right, gene in sorted(spans, key=lambda item: item[0]):  # stable, like Array.sort
        row = 0
        while row < len(row_ends) and row_ends[row] > left - 20:
            row += 1
        if row >= len(row_ends):
            row_ends.append(right)
        else:
            row_ends[row] = right
        rows[gene.get("id")] = row
    return rows, len(row_ends) or 1


def layout(ctx, width: float, height: float):
    """(display genes, gene id -> row, collapsed?, isoform counts)."""
    genes = load_genes(ctx)
    x_of = _x_mapper(ctx, width)
    if not genes:
        return genes, {}, False, {}
    rows, n_rows = _assign_rows(genes, x_of)
    if (height - 10) / n_rows >= MIN_ROW_HEIGHT:
        return genes, rows, False, {}
    merged, counts = merge_isoforms(genes)
    rows, _ = _assign_rows(merged, x_of)
    return merged, rows, True, counts


def _x_mapper(ctx, width: float):
    start, end, rev = ctx.start, ctx.end, ctx.reversed

    def x_of(pos: float) -> float:
        frac = (pos - start) / max(1, end - start)
        return (1 - frac) * width if rev else frac * width
    return x_of


def measure(ctx, track) -> float:
    return float(track.height or ctx.heights()["gene"])


def draw(surface, ctx, track, height: float) -> None:
    # The gene canvas sits right of the cluster gutter (marginLeft) at width - gutter.
    sidebar = cluster_sidebar_width(ctx)
    width = ctx.width - sidebar
    surface.save()
    surface.translate(sidebar, 0)
    try:
        _draw(surface, ctx, width, height)
    finally:
        surface.restore()


def _draw(surface, ctx, width: float, height: float) -> None:
    start, end = ctx.start, ctx.end
    x_of = _x_mapper(ctx, width)
    surface.rect(0, 0, width, height, fill="#ffffff")
    genes, rows, collapsed, iso_counts = layout(ctx, width, height)
    if not genes:
        surface.text(width / 2, height / 2, "No genes in region", size=11, color="#999999", anchor="middle")
        return

    selected_ids = {g.get("id") for g in ctx.fe.get("selectedGenes") or [] if isinstance(g, dict)}
    n_rows = max([1] + list(rows.values())) + 1
    row_h = min(22, (height - 10) / n_rows)
    bp_per_px = (end - start) / max(1e-9, width)

    for gene in genes:
        row = rows.get(gene.get("id"), 0)
        y = 5 + row * row_h + row_h / 2
        color = PLUS_COLOR if gene.get("strand") == "+" else MINUS_COLOR
        is_selected = gene.get("id") in selected_ids
        name = gene.get("name")
        iso = iso_counts.get(name, 0) if name else 0
        r1, r2 = x_of(max(gene["start"], start)), x_of(min(gene["end"], end))
        x1, x2 = min(r1, r2), max(r1, r2)

        if is_selected:
            surface.rect(x1, y - row_h * 0.4, x2 - x1, row_h * 0.8, fill=SELECTION_COLOR + "40")
            surface.rect(x1, y - row_h * 0.4, x2 - x1, row_h * 0.8, stroke=SELECTION_COLOR, stroke_width=2)

        if bp_per_px > 100:
            surface.rect(x1, y - row_h * 0.2, max(1, x2 - x1), row_h * 0.4, fill=color)
        else:
            surface.line(x1, y, x2, y, color, 1.5)
            for exon in gene.get("exons") or []:
                e1, e2 = x_of(max(exon["start"], start)), x_of(min(exon["end"], end))
                ex1, ex2 = min(e1, e2), max(e1, e2)
                if ex2 > ex1:
                    surface.rect(ex1, y - row_h * 0.25, ex2 - ex1, row_h * 0.5, fill=color)

        if name:
            label = f"{name} ({iso})" if iso > 1 else name
            weight = "bold" if is_selected else "normal"
            # Browser: italic 9px sans-serif.
            if measure_text(label, 9, weight) + 4 <= x2 - x1:
                surface.text((x1 + x2) / 2, y - row_h * 0.3 - 2, label, size=9,
                             color=SELECTION_COLOR if is_selected else color, anchor="middle", weight=weight,
                             italic=True)

        spacing = max(50, (x2 - x1) / 5)
        forward = (gene.get("strand") == "-") if ctx.reversed else (gene.get("strand") == "+")
        ax = x1 + spacing / 2
        while ax < x2 - 10:
            d = -3 if forward else 3
            surface.polyline([(ax + d, y - 2), (ax, y), (ax + d, y + 2)], color=color, width=0.8)
            ax += spacing

    # (The browser's 'N isoforms merged — resize to expand' is an on-screen hint.)


register("gene", measure, draw)
