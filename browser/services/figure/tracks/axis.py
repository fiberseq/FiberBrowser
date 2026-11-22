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
    # A meta-locus (AxisTrack metaZero): -flank..+flank around the sites' anchor, drawn like relative coordinates,
    # the anchor's tick labelled with its word (TSS / centre / end); minus-strand sites are already flipped.
    meta = fe.get("_metaLocus") if str(ctx.chrom).startswith("meta:") else None
    if meta:
        tss, relative = float(meta["zero"]), True
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
    # AxisTrack: a meta-locus axis never takes a selected gene's strand (relReversed needs metaZero === null).
    rel_gene = genes[0] if relative and not meta and genes and isinstance(genes[0], dict) else None
    # A meta-locus axis leaves out tick labels that would touch the pool's label or the width label, as AxisTrack does
    # (audit L1); ordinary axes keep their drawing unchanged.
    skip_left = skip_right = None
    if meta:
        from services.figure.surface import measure_text
        skip_left = 4 + measure_text(str(meta["label"]), 10, "bold") + 6
        size_text = f"{size / 1000:.1f}kb" if size >= 1000 else f"{size}bp"
        skip_right = width - 4 - measure_text(size_text, 9) - 6
    while pos < end:
        x = ctx.x_of(pos)
        if 30 <= x <= width - 30:
            surface.line(x, height - 6, x, height - 1, "#cccccc", 1)
            label = (_relative_label(pos, float(tss), (rel_gene or {}).get("strand") == "-") if relative
                     else _format_position(normalize(pos), size))
            if meta and round(pos - float(tss)) == 0:
                label = meta["anchor_word"]
            if skip_left is not None:
                from services.figure.surface import measure_text
                half = measure_text(label, 9) / 2
                if x - half < skip_left or x + half > skip_right:
                    pos += step
                    continue
            surface.text(x, height - 10, label, size=9, color="#666666", anchor="middle")
        pos += step

    if meta:
        region = str(meta["label"])
        _anchor_mark(surface, ctx, float(tss), height)
    elif relative and rel_gene:
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


def _anchor_mark(surface, ctx, zero: float, height: float) -> None:
    """The anchor on a meta-locus axis: a small downward triangle at x(anchor) on the axis line (headless figures mark
    it so a printed panel shows where the sites sit; ``meta_locus.anchor_mark: false`` leaves it out)."""
    if not (ctx.fe.get("_metaLocus") or {}).get("anchor_mark", True):
        return
    if not ctx.start <= zero <= ctx.end:
        return
    x = ctx.x_of(zero)
    surface.polygon([(x - 4, height - 7), (x + 4, height - 7), (x, height - 1)], fill="#333333")


register("axis", measure, draw)
