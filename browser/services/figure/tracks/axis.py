"""Coordinate axis (AxisTrack.tsx)."""
from __future__ import annotations

import math

from services.figure.tracks import register


def _format_position(bp: float, region_size: float) -> str:
    if region_size < 100_000:
        return f"{int(round(bp)):,}"
    if region_size < 1_000_000:
        return f"{bp / 1_000:.1f}kb"
    if region_size < 10_000_000:
        return f"{bp / 1_000_000:.2f}Mb"
    return f"{bp / 1_000_000:.1f}Mb"


def _tick_step(size: float, pixel_width: float) -> float:
    max_ticks = max(2, math.floor(pixel_width / 80))
    target = min(6, max_ticks)
    raw = size / target
    magnitude = 10 ** math.floor(math.log10(raw))
    normalized = raw / magnitude
    nice = 1 if normalized <= 1.5 else 2 if normalized <= 3 else 5 if normalized <= 7 else 10
    return nice * magnitude


def _relative_label(pos: float, tss: float, reversed_: bool) -> str:
    delta = pos - tss
    if reversed_:
        delta = -delta
    if delta == 0:
        return "TSS"
    return f"{'+' if delta > 0 else ''}{int(delta):,}"


def _circular_size(ctx) -> int:
    """Chromosome size when it is circular (plasmid, mito), else 0."""
    try:
        from services.circular_genome import chrom_circular_metadata
        meta = chrom_circular_metadata(ctx.state, ctx.chrom)
        return int(meta["size"]) if meta and meta.get("size") else 0
    except Exception:
        return 0


def _circular_region_label(chrom: str, start: int, end: int, size: int, region_size: int, compact: bool = False) -> str:
    normalize = lambda pos: ((round(pos) % size) + size) % size
    fmt = (lambda v: _format_position(v, region_size)) if compact else (lambda v: f"{v:,}")
    wraps = size > 0 and (start < 0 or end > size or start // size != (end - 1) // size)
    # The end is exclusive: a view ending at the contig's length ends at `size`, not 0.
    a, b = fmt(normalize(start)), fmt(normalize(end - 1) + 1)
    return f"{chrom}:{a}..{b} (wrap)" if wraps else f"{chrom}:{a}-{b} circular"


def measure(ctx, track) -> float:
    return float(track.height or ctx.heights()["axis"])


def draw(surface, ctx, track, height: float) -> None:
    width, start, end = ctx.width, ctx.start, ctx.end
    size = end - start
    surface.rect(0, 0, width, height, fill="#fafafa")
    surface.line(0, height - 1, width, height - 1, "#cccccc", 1)

    fe = ctx.fe
    tss = fe.get("relativeTSS")
    relative = bool(fe.get("showRelativeCoords")) and tss is not None
    step = _tick_step(size, width)
    if relative:
        nice = [25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000]
        target = min(20, max(2, math.floor(width / 50)))
        step = next((s for s in nice if s >= size / target), nice[-1])
    base = float(tss) if relative else 0.0
    pos = base + math.ceil((start - base) / step) * step
    circular = _circular_size(ctx)
    normalize = (lambda p: ((p % circular) + circular) % circular) if circular else (lambda p: p)
    genes = fe.get("selectedGenes") or []
    rel_gene = genes[0] if relative and genes and isinstance(genes[0], dict) else None
    while pos < end:
        x = ctx.x_of(pos)
        if 30 <= x <= width - 30:
            surface.line(x, height - 6, x, height - 1, "#cccccc", 1)
            label = (_relative_label(pos, float(tss), (rel_gene or {}).get("strand") == "-") if relative
                     else _format_position(normalize(pos), size))
            surface.text(x, height - 10, label, size=9, color="#666666", anchor="middle")
        pos += step

    if relative and rel_gene:
        region = f"{rel_gene.get('name', '')} TSS ±{round(size / 2000)}kb"
    elif width < 250:
        region = (_circular_region_label(ctx.chrom, start, end, circular, size, compact=True) if circular
                  else f"{ctx.chrom}:{_format_position(start, size)}-{_format_position(end, size)}")
    else:
        region = ((_circular_region_label(ctx.chrom, start, end, circular, size) if circular
                   else f"{ctx.chrom}:{start:,}-{end:,}") + (" ◄ 3'→5'" if ctx.reversed else ""))
    surface.text(4, 12, region, size=10, color="#333333", weight="bold")
    size_str = f"{size / 1000:.1f}kb" if size >= 1000 else f"{size}bp"
    surface.text(width - 4, 12, size_str, size=9, color="#666666", anchor="end")


register("axis", measure, draw)
