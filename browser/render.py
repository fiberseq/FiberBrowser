"""
Server-side track rendering for headless mode.

All renderers produce PIL.Image.Image objects. The composite stacks them vertically.
No matplotlib dependency — pure PIL/Pillow + numpy.
"""
from __future__ import annotations

import math
from typing import List, Optional, Tuple, Dict

import numpy as np
from PIL import Image, ImageDraw, ImageFont


# ---------------------------------------------------------------------------
# Font helpers
# ---------------------------------------------------------------------------

_FONT_CACHE: Dict[int, ImageFont.FreeTypeFont] = {}

def _get_font(size: int = 11) -> ImageFont.FreeTypeFont:
    """Try system TrueType fonts, fall back to PIL default."""
    if size in _FONT_CACHE:
        return _FONT_CACHE[size]

    candidates = [
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/SFNSMono.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/TTF/DejaVuSans.ttf",
    ]
    for path in candidates:
        try:
            font = ImageFont.truetype(path, size)
            _FONT_CACHE[size] = font
            return font
        except (OSError, IOError):
            continue

    font = ImageFont.load_default()
    _FONT_CACHE[size] = font
    return font


# ---------------------------------------------------------------------------
# Nice-number axis helpers
# ---------------------------------------------------------------------------

def _nice_step(range_size: float, target_ticks: int = 5) -> int:
    """Compute a human-friendly tick step for an axis range."""
    raw = range_size / max(target_ticks, 1)
    magnitude = 10 ** math.floor(math.log10(max(raw, 1)))
    residual = raw / magnitude
    if residual <= 1.5:
        nice = 1
    elif residual <= 3.5:
        nice = 2
    elif residual <= 7.5:
        nice = 5
    else:
        nice = 10
    return max(1, int(nice * magnitude))


def _format_pos(pos: int) -> str:
    """Format genomic position as human-readable string."""
    if pos >= 1_000_000:
        return f"{pos / 1_000_000:.2f} Mb"
    if pos >= 1_000:
        return f"{pos / 1_000:.1f} kb"
    return str(pos)


def _format_axis_tick(pos: int, step: int) -> str:
    """Format a genomic tick without collapsing distinct nearby positions.

    The headless renderer previously rounded every megabase-scale coordinate to
    two decimals.  That is fine for chromosome-scale views but turns all ticks
    in a kilobase-scale locus into the same label.  Choose the number of decimal
    places from the actual tick spacing instead.
    """
    if pos >= 1_000_000:
        spacing_mb = max(step, 1) / 1_000_000
        decimals = min(6, max(2, int(math.ceil(-math.log10(spacing_mb)))))
        return f"{pos / 1_000_000:.{decimals}f} Mb"
    if pos >= 1_000:
        spacing_kb = max(step, 1) / 1_000
        decimals = min(3, max(1, int(math.ceil(-math.log10(spacing_kb)))))
        return f"{pos / 1_000:.{decimals}f} kb"
    return str(pos)


# ---------------------------------------------------------------------------
# Track renderers
# ---------------------------------------------------------------------------

def render_axis_track(width: int, chrom: str, start: int, end: int,
                      height: int = 30) -> Image.Image:
    """Render a genomic coordinate axis with tick marks and labels."""
    img = Image.new("RGB", (width, height), (255, 255, 255))
    draw = ImageDraw.Draw(img)
    font = _get_font(10)

    region_size = end - start
    step = _nice_step(region_size)
    first_tick = (start // step + 1) * step

    # Keep the exact viewport label on its own row.  The ruler occupies the
    # lower half of the compact track so it cannot collide with the label.
    axis_y = 13
    draw.line([(0, axis_y), (width - 1, axis_y)], fill=(0, 0, 0), width=1)

    for pos in range(first_tick, end, step):
        x = int((pos - start) / region_size * width)
        if x < 0 or x >= width:
            continue
        # Tick
        draw.line([(x, axis_y), (x, axis_y + 5)], fill=(0, 0, 0), width=1)
        # Label
        label = _format_axis_tick(pos, step)
        bbox = font.getbbox(label)
        tw = bbox[2] - bbox[0]
        lx = max(0, min(width - tw, x - tw // 2))
        draw.text((lx, axis_y + 6), label, fill=(60, 60, 60), font=_get_font(8))

    # Region label at top-left
    region_label = f"{chrom}:{start:,}-{end:,}"
    draw.text((4, 1), region_label, fill=(0, 0, 0), font=_get_font(9))

    return img


def render_meta_track(nuc_profile: np.ndarray, subnuc_profile: np.ndarray,
                      width: int, height: int = 60) -> Image.Image:
    """Render nucleosome + subnucleosomal metaprofile as line charts.

    Args:
        nuc_profile: Nucleosome occupancy array (0-1 per position).
        subnuc_profile: Subnucleosomal occupancy array (0-1 per position).
        width: Output image width in pixels.
        height: Output image height in pixels.
    """
    img = Image.new("RGB", (width, height), (255, 255, 255))
    draw = ImageDraw.Draw(img)

    # Colors: green for nucleosome, gray for subnucleosomal
    nuc_color = (51, 160, 64)
    sub_color = (140, 140, 140)

    padding_top = 4
    padding_bottom = 4
    plot_h = height - padding_top - padding_bottom

    def _draw_profile(profile: np.ndarray, color: Tuple[int, int, int]):
        if len(profile) == 0:
            return
        # Resample to width
        if len(profile) != width:
            x_old = np.linspace(0, 1, len(profile))
            x_new = np.linspace(0, 1, width)
            profile = np.interp(x_new, x_old, profile)

        max_val = max(profile.max(), 0.01)
        points = []
        for i in range(width):
            y = padding_top + plot_h - int(profile[i] / max_val * plot_h)
            y = max(padding_top, min(padding_top + plot_h, y))
            points.append((i, y))
        if len(points) >= 2:
            draw.line(points, fill=color, width=1)

    _draw_profile(nuc_profile, nuc_color)
    _draw_profile(subnuc_profile, sub_color)

    # Baseline
    draw.line([(0, height - padding_bottom), (width - 1, height - padding_bottom)],
              fill=(200, 200, 200), width=1)

    return img


def render_peaks_track(peaks: list, width: int, start: int, end: int,
                       height: int = 25) -> Image.Image:
    """Render FIRE / scanned peaks as colored rectangles.

    Args:
        peaks: List of dicts with 'start' and 'end' keys (genomic coords).
        width: Image width.
        start, end: Genomic region.
        height: Image height.
    """
    img = Image.new("RGB", (width, height), (255, 255, 255))
    draw = ImageDraw.Draw(img)

    region_size = end - start
    if region_size <= 0:
        return img

    peak_color = (245, 130, 48)  # Orange (FIRE-style)
    peak_border = (200, 100, 30)

    for peak in peaks:
        ps = peak.get("start", 0)
        pe = peak.get("end", 0)
        x0 = int((ps - start) / region_size * width)
        x1 = int((pe - start) / region_size * width)
        x0 = max(0, x0)
        x1 = min(width - 1, max(x0 + 1, x1))
        draw.rectangle([x0, 2, x1, height - 3], fill=peak_color, outline=peak_border)

    return img


def render_reads_track(reads_df, width: int = 2000, row_height: int = 3,
                       cluster_assignments: dict = None) -> Optional[Image.Image]:
    """Render reads as a heatmap image using the shared renderer.

    Args:
        reads_df: DataFrame with signed footprint values (from state.get_reads()).
        width: Max image width.
        row_height: Pixels per read row.
        cluster_assignments: Optional {read_id: cluster_num} dict.

    Returns:
        PIL Image or None if no reads.
    """
    from services.read_rendering import render_reads_to_image

    if reads_df is None or reads_df.empty:
        return None
    return render_reads_to_image(
        reads_df,
        cluster_assignments=cluster_assignments,
        max_width=width,
        row_height=row_height,
    )


# Mod overlay colors (matching frontend MOD_COLORS)
_MOD_COLOR = (107, 33, 168)   # purple (#6b21a8) — m6A / deamination
_FIRE_COLOR = (234, 88, 12)   # orange (#ea580c) — FIRE elements

# Footprint colormap: gap=light gray, subnuc=dark gray, nuc=green
_FP_GAP_COLOR = (204, 204, 204)
_FP_SUBNUC_COLOR = (140, 140, 140)
_FP_NUC_COLOR = (51, 160, 64)
_FP_BG_COLOR = (255, 255, 255)


def _hex_to_rgb(hex_color: str) -> Tuple[int, int, int]:
    """Convert '#rrggbb' hex string to RGB tuple."""
    h = hex_color.lstrip('#')
    if len(h) == 6:
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
    return (128, 128, 128)


# CIGAR event colors (matching frontend)
_CIGAR_COLORS = {
    'A': (34, 197, 94),   # green
    'T': (239, 68, 68),   # red
    'C': (59, 130, 246),  # blue
    'G': (234, 179, 8),   # yellow
    'I': (168, 85, 247),  # purple (insertion)
    'D': (100, 116, 139), # gray (deletion)
}


def render_compact_reads_track(
    reads: list, region_width: int, width: int = 2000, row_height: int = 3,
    show_mods: bool = False, show_fire: bool = False, show_cigar: bool = False,
    show_layers: bool = False,
    show_deam_opportunities: bool = False,
    cluster_assignments: dict = None, max_reads: int = 500,
    subnuc_threshold: int = 90,
    dataset_label: str = None, dataset_color: str = None,
    colormap_rules: list = None,
    colors: dict = None,
    quality_shading: bool = False,
    tf_overlay: dict = None,     # {'enabled': bool, 'layer': 'tf', 'qualityName': 'tq', ...}
) -> Optional[Image.Image]:
    """Render compact reads (with intervals + methyl) as a PIL image.

    Args:
        reads: List of compact read dicts from build_working_set
               ({id, intervals: [[s,e,sz],...], methyl?: [pos,...], fire?: [...]})
        region_width: Viewport width in bp (end - start)
        width: Output image width in pixels
        row_height: Pixels per read row
        show_mods: Draw methylation marks (purple ticks)
        show_fire: Draw FIRE/MSP overlay intervals (orange)
        cluster_assignments: Optional {read_id: cluster_num}
        max_reads: Maximum reads to render
        subnuc_threshold: Footprint size boundary (< threshold = subnuc)
        colors: Optional color overrides dict. Keys: 'gap', 'subnuc', 'nuc',
            'mod', 'fire'. Values: '#rrggbb' hex strings or (r,g,b) tuples.
            Example: ``{'subnuc': '#3b82f6', 'nuc': '#16a34a'}``

    Returns:
        PIL Image or None if no reads.
    """
    if not reads:
        return None

    # Resolve colors (allow hex string or RGB tuple overrides)
    c = colors or {}
    def _resolve(key, default):
        v = c.get(key)
        if v is None:
            return default
        if isinstance(v, str):
            return _hex_to_rgb(v)
        return tuple(v)

    gap_color = _resolve('gap', _FP_GAP_COLOR)
    subnuc_color = _resolve('subnuc', _FP_SUBNUC_COLOR)
    nuc_color = _resolve('nuc', _FP_NUC_COLOR)
    mod_color = _resolve('mod', _MOD_COLOR)
    fire_color = _resolve('fire', _FIRE_COLOR)

    # Limit read count
    if len(reads) > max_reads:
        step = len(reads) / max_reads
        reads = [reads[int(i * step)] for i in range(max_reads)]

    n_reads = len(reads)
    scale = width / region_width  # pixels per bp

    has_clusters = cluster_assignments and len(cluster_assignments) > 0
    sidebar_w = 8 if has_clusters else 0

    # Build colormap rule lookup for footprint coloring
    has_rules = colormap_rules and len(colormap_rules) > 0
    rule_colors = []
    if has_rules:
        for rule in colormap_rules:
            if not rule.get('enabled', True):
                continue
            c = rule.get('color', '#888888')
            rgb = _hex_to_rgb(c) if isinstance(c, str) else (128, 128, 128)
            size_min = rule.get('sizeMin', 0)
            size_max = rule.get('sizeMax', 999999)
            rule_colors.append((size_min, size_max, rgb))

    # Dataset header
    header_h = 0
    header_img = None
    if dataset_label:
        dc = _hex_to_rgb(dataset_color) if dataset_color else (100, 100, 100)
        header_img = render_dataset_header(sidebar_w + width, dataset_label, dc)
        header_h = header_img.height

    img_width = sidebar_w + width
    img_height = header_h + n_reads * row_height

    if img_height == 0:
        return None

    img_arr = np.full((img_height, img_width, 3), 255, dtype=np.uint8)

    # Paste header
    if header_img is not None:
        header_arr = np.array(header_img)
        img_arr[:header_h, :] = header_arr[:, :img_width]

    for i, read in enumerate(reads):
        y_start = header_h + i * row_height
        y_end = y_start + row_height
        # ``methyl`` is a compatibility projection and can represent m6A in
        # mixed-chemistry reads.  Opportunity mode must use the explicit DAF
        # event channel so black observations cannot accidentally denote m6A.
        if show_deam_opportunities:
            observed_mod_positions = [
                event[0] for event in (read.get('deam') or []) if event
            ]
            base_mod_positions = sorted(set(
                (read.get('methyl_m6a') or [])
                + (read.get('methyl_m5c') or [])
            ))
        else:
            observed_mod_positions = read.get('methyl') or []
            base_mod_positions = observed_mod_positions

        # Cluster sidebar
        if has_clusters:
            from utils.colors import cluster_rgb
            cluster = cluster_assignments.get(read['id'])
            if cluster is not None:
                color = cluster_rgb(cluster)
                img_arr[y_start:y_end, 0:sidebar_w - 1] = color

        # Draw intervals (footprints + gaps)
        qualities = read.get('qualities')
        fp_idx = 0
        for iv in read.get('intervals', []):
            iv_start, iv_end, size = iv[0], iv[1], iv[2]
            # Clip to viewport
            x0 = max(0, int(iv_start * scale))
            x1 = min(width, int(iv_end * scale))
            if x1 <= x0:
                if size > 0:
                    fp_idx += 1
                continue

            px0 = sidebar_w + x0
            px1 = sidebar_w + x1

            if size <= 0:
                # Gap / linker
                img_arr[y_start:y_end, px0:px1] = gap_color
            else:
                # Footprint — use colormap rules if available
                fp_color = None
                if has_rules:
                    for size_min, size_max, rgb in rule_colors:
                        if size_min <= size <= size_max:
                            fp_color = rgb
                            break

                if fp_color is None:
                    fp_color = subnuc_color if size < subnuc_threshold else nuc_color

                # Apply quality shading (nq scores → opacity)
                if quality_shading and qualities and fp_idx < len(qualities):
                    q = qualities[fp_idx]
                    alpha = 0.3 + 0.7 * (q / 255)
                    fp_color = tuple(int(c * alpha + 255 * (1 - alpha)) for c in fp_color)

                img_arr[y_start:y_end, px0:px1] = fp_color
                fp_idx += 1

        # Draw methylation/deamination marks
        if show_mods:
            if base_mod_positions:
                mark_h = max(2, row_height)
                mark_w = max(1, int(scale * 0.8))
                for pos in base_mod_positions:
                    if pos < 0 or pos >= region_width:
                        continue
                    px = sidebar_w + int(pos * scale)
                    mx0 = max(sidebar_w, px - mark_w // 2)
                    mx1 = min(img_width, mx0 + max(1, mark_w))
                    img_arr[y_start:y_start + mark_h, mx0:mx1] = mod_color

        # Draw FIRE/MSP overlay
        if show_fire:
            fire = read.get('fire')
            if fire:
                for fiv in fire:
                    fs, fe = fiv[0], fiv[1]
                    fq = fiv[2] if len(fiv) > 2 else 128
                    if fe < 0 or fs >= region_width:
                        continue
                    fx0 = sidebar_w + max(0, int(fs * scale))
                    fx1 = sidebar_w + min(width, int(fe * scale))
                    if fx1 <= fx0:
                        continue
                    alpha = 0.3 + 0.5 * (fq / 255)
                    existing = img_arr[y_start:y_end, fx0:fx1].astype(np.float32)
                    fire_c = np.array(fire_color, dtype=np.float32)
                    blended = (existing * (1 - alpha) + fire_c * alpha).astype(np.uint8)
                    img_arr[y_start:y_end, fx0:fx1] = blended

        # Draw a named TF-like footprint overlay. ``tf``/``tq`` remain the
        # defaults for API compatibility, while callers can render any named
        # interval layer (for example targeted-consensus ``tf_sr``/``q0``).
        if show_layers and tf_overlay and tf_overlay.get('enabled'):
            tf_layer_name = tf_overlay.get('layer', 'tf')
            tf_quality_name = tf_overlay.get('qualityName', 'tq')
            tf_layer = read.get('layers', {}).get(tf_layer_name)
            if tf_layer and tf_layer.get('intervals'):
                tf_color_rgb = _hex_to_rgb(tf_overlay.get('color', '#e040fb'))
                tf_min_opacity = tf_overlay.get('minOpacity', 0.2)
                tf_max_opacity = tf_overlay.get('maxOpacity', 0.85)
                tf_min_tq = tf_overlay.get('minTq', 0)
                tq_names = tf_layer.get('quality_names') or []
                tq_idx = (
                    tq_names.index(tf_quality_name)
                    if tf_quality_name in tq_names
                    else -1
                )
                tq_arr = (tf_layer.get('qualities') or [])[tq_idx] if tq_idx >= 0 and tq_idx < len(tf_layer.get('qualities') or []) else []
                annotation_names = tf_layer.get('annotation_names') or []
                require_annotation_name = bool(tf_overlay.get('requireAnnotationName', False))
                for ti, tfiv in enumerate(tf_layer['intervals']):
                    if require_annotation_name and (
                        ti >= len(annotation_names) or not annotation_names[ti]
                    ):
                        continue
                    # A declared-but-truncated quality track is invalid evidence
                    # and fails closed. A layer with no quality track remains a
                    # supported visualization shape and uses neutral confidence.
                    if tq_idx >= 0 and ti >= len(tq_arr):
                        continue
                    ts, te = tfiv[0], tfiv[1]
                    tq_val = tq_arr[ti] if tq_idx >= 0 else 128
                    if tq_val < tf_min_tq:
                        continue
                    if te < 0 or ts >= region_width:
                        continue
                    tx0 = sidebar_w + max(0, int(ts * scale))
                    tx1 = sidebar_w + min(width, int(te * scale))
                    if tx1 <= tx0:
                        continue
                    alpha = tf_min_opacity + (tf_max_opacity - tf_min_opacity) * (tq_val / 255)
                    existing = img_arr[y_start:y_end, tx0:tx1].astype(np.float32)
                    tf_c = np.array(tf_color_rgb, dtype=np.float32)
                    blended = (existing * (1 - alpha) + tf_c * alpha).astype(np.uint8)
                    img_arr[y_start:y_end, tx0:tx1] = blended

        # Evidence rugs are explanatory overlays and must remain above the
        # consensus footprint fill. Redraw them after the named layer overlay;
        # observed events stay full-height black through the row center.
        if show_deam_opportunities:
            opportunity_h = max(1, min(3, row_height // 3))
            mark_w = max(1, int(scale * 0.8))
            for positions, opportunity_color, oy0, oy1 in (
                (read.get('possible_deam_ct'), (13, 148, 136), y_start, y_start + opportunity_h),
                (read.get('possible_deam_ga'), (217, 119, 6), y_end - opportunity_h, y_end),
            ):
                for pos in positions or []:
                    if pos < 0 or pos >= region_width:
                        continue
                    px = sidebar_w + int(pos * scale)
                    mx0 = max(sidebar_w, px - mark_w // 2)
                    mx1 = min(img_width, mx0 + max(1, mark_w))
                    img_arr[oy0:oy1, mx0:mx1] = opportunity_color
            if show_mods:
                for pos in observed_mod_positions:
                    if pos < 0 or pos >= region_width:
                        continue
                    px = sidebar_w + int(pos * scale)
                    mx0 = max(sidebar_w, px - mark_w // 2)
                    mx1 = min(img_width, mx0 + max(1, mark_w))
                    img_arr[y_start:y_end, mx0:mx1] = (17, 24, 39)

        # Draw CIGAR events (mismatches, insertions, deletions)
        if show_cigar:
            cigar = read.get('cigar')
            if cigar:
                for event in cigar:
                    epos = event.get('pos', 0)
                    etype = event.get('type', '')
                    elen = event.get('len', 1)
                    if epos < 0 or epos >= region_width:
                        continue
                    if etype == 'M':
                        # Mismatch — color by base
                        seq = event.get('seq', '')
                        for ci, ch in enumerate(seq):
                            cpos = epos + ci
                            if cpos >= region_width:
                                break
                            cpx = sidebar_w + int(cpos * scale)
                            cw = max(1, int(scale))
                            cc = _CIGAR_COLORS.get(ch.upper(), (128, 128, 128))
                            cx0 = max(sidebar_w, cpx)
                            cx1 = min(img_width, cpx + cw)
                            img_arr[y_start:y_end, cx0:cx1] = cc
                    elif etype == 'I':
                        # Insertion — purple tick
                        cpx = sidebar_w + int(epos * scale)
                        cx0 = max(sidebar_w, cpx)
                        cx1 = min(img_width, cpx + max(1, int(scale * 0.5)))
                        img_arr[y_start:y_end, cx0:cx1] = _CIGAR_COLORS['I']
                    elif etype == 'D':
                        # Deletion — gray span
                        dx0 = sidebar_w + max(0, int(epos * scale))
                        dx1 = sidebar_w + min(width, int((epos + elen) * scale))
                        if dx1 > dx0:
                            img_arr[y_start:y_end, dx0:dx1] = _CIGAR_COLORS['D']

    return Image.fromarray(img_arr, 'RGB')


def render_genes_track(genes: list, width: int, start: int, end: int,
                       row_height: int = 20, max_rows: int = 15) -> Image.Image:
    """Render gene annotations with exons, introns, strand arrows, and labels.

    Args:
        genes: List of gene dicts with 'name', 'start', 'end', 'strand', 'exons'.
        width: Image width.
        start, end: Genomic region.
        row_height: Pixels per gene row.
        max_rows: Maximum number of gene rows.
    """
    region_size = end - start
    if region_size <= 0 or not genes:
        return Image.new("RGB", (width, 10), (255, 255, 255))

    font = _get_font(9)

    def _gene_x(pos: int) -> int:
        return int((pos - start) / region_size * width)

    # Row allocation: place genes in rows to avoid horizontal overlap
    rows: List[List[dict]] = []
    for gene in sorted(genes, key=lambda g: g["start"]):
        gx0 = _gene_x(gene["start"])
        gx1 = _gene_x(gene["end"])
        # Estimate label width
        name = gene.get("name", "")
        lw = font.getbbox(name)[2] if name else 0
        extent_right = max(gx1, gx0 + lw + 4)

        placed = False
        for row in rows:
            last = row[-1]
            last_x1 = _gene_x(last["end"])
            last_name = last.get("name", "")
            last_lw = font.getbbox(last_name)[2] if last_name else 0
            last_extent = max(last_x1, _gene_x(last["start"]) + last_lw + 4)
            if gx0 > last_extent + 4:
                row.append(gene)
                placed = True
                break
        if not placed:
            if len(rows) < max_rows:
                rows.append([gene])
            # else: gene is dropped (too many rows)

    n_rows = max(len(rows), 1)
    img_height = n_rows * row_height + 4
    img = Image.new("RGB", (width, img_height), (255, 255, 255))
    draw = ImageDraw.Draw(img)

    gene_color = (30, 80, 160)
    exon_color = (30, 80, 160)

    for row_idx, row in enumerate(rows):
        y_mid = row_idx * row_height + row_height // 2 + 2
        for gene in row:
            gx0 = max(0, _gene_x(gene["start"]))
            gx1 = min(width - 1, _gene_x(gene["end"]))

            # Intron line
            draw.line([(gx0, y_mid), (gx1, y_mid)], fill=gene_color, width=1)

            # Exons
            for exon in gene.get("exons", []):
                ex0 = max(0, _gene_x(exon["start"]))
                ex1 = min(width - 1, _gene_x(exon["end"]))
                if ex1 > ex0:
                    draw.rectangle([ex0, y_mid - 4, ex1, y_mid + 4],
                                   fill=exon_color)

            # Strand arrow
            strand = gene.get("strand", "+")
            arrow_x = gx1 + 2 if strand == "+" else gx0 - 2
            if 0 < arrow_x < width:
                if strand == "+":
                    draw.polygon([(arrow_x, y_mid - 3), (arrow_x + 4, y_mid),
                                  (arrow_x, y_mid + 3)], fill=gene_color)
                else:
                    draw.polygon([(arrow_x, y_mid - 3), (arrow_x - 4, y_mid),
                                  (arrow_x, y_mid + 3)], fill=gene_color)

            # Label
            name = gene.get("name", "")
            if name:
                draw.text((gx0, y_mid - row_height // 2), name,
                          fill=(0, 0, 0), font=font)

    return img


# ---------------------------------------------------------------------------
# Composite
# ---------------------------------------------------------------------------

def render_composite(track_images: List[Tuple[str, Image.Image]],
                     title: str = None, width: int = 2000) -> Image.Image:
    """Stack track images vertically with optional title.

    Args:
        track_images: List of (label, image) tuples.
        title: Optional title text rendered at top.
        width: Target width (images wider or narrower are resized).

    Returns:
        Composite PIL Image.
    """
    parts: List[Image.Image] = []

    # Title
    if title:
        title_h = 24
        title_img = Image.new("RGB", (width, title_h), (255, 255, 255))
        draw = ImageDraw.Draw(title_img)
        draw.text((8, 4), title, fill=(0, 0, 0), font=_get_font(13))
        parts.append(title_img)

    for _label, img in track_images:
        if img is None:
            continue
        # Resize to match width if needed
        if img.width != width:
            ratio = width / img.width
            new_h = max(1, int(img.height * ratio))
            img = img.resize((width, new_h), Image.NEAREST)
        parts.append(img)

    if not parts:
        return Image.new("RGB", (width, 20), (255, 255, 255))

    total_h = sum(p.height for p in parts)
    composite = Image.new("RGB", (width, total_h), (255, 255, 255))
    y = 0
    for p in parts:
        composite.paste(p, (0, y))
        y += p.height

    return composite


# ---------------------------------------------------------------------------
# Phase 1: Additional track renderers
# ---------------------------------------------------------------------------

# Base colors for nucleotides (matching IGV / frontend SequenceTrack)
_SEQ_COLORS = {
    'A': (0, 200, 0),    # green
    'T': (255, 0, 0),    # red
    'C': (0, 0, 255),    # blue
    'G': (209, 113, 5),  # orange/brown
    'N': (128, 128, 128),
}


def render_sequence_track(ref_seq: str, width: int, start: int, end: int,
                          height: int = 20) -> Optional[Image.Image]:
    """Render reference sequence as colored ATCG letters.

    Only renders when the region is small enough for letters to be legible
    (~2000bp or less). Returns None for larger regions.
    """
    region_size = end - start
    if region_size > 2000 or not ref_seq:
        return None

    img = Image.new("RGB", (width, height), (255, 255, 255))
    draw = ImageDraw.Draw(img)

    bp_per_px = region_size / width
    font_size = max(6, min(14, int(width / region_size * 0.8)))
    font = _get_font(font_size)

    for i, base in enumerate(ref_seq[:region_size]):
        if base == " ":
            continue  # off the end of a linear contig
        x = int(i / region_size * width)
        x_end = int((i + 1) / region_size * width)
        char_w = x_end - x
        if char_w < 3:
            # Too narrow for letters — draw colored rectangles
            color = _SEQ_COLORS.get(base.upper(), (128, 128, 128))
            draw.rectangle([x, 2, x_end, height - 2], fill=color)
        else:
            color = _SEQ_COLORS.get(base.upper(), (128, 128, 128))
            draw.text((x + char_w // 4, 1), base.upper(), fill=color, font=font)

    return img


def render_signal_track(values: list, width: int, height: int = 50,
                        color: Tuple[int, int, int] = (70, 130, 180),
                        label: str = None,
                        fill_alpha: float = 0.3) -> Image.Image:
    """Render a 1D signal track (BigWig, coverage, etc.) as area fill + line.

    Args:
        values: List of signal values (one per bin)
        width: Image width in pixels
        height: Track height
        color: RGB color tuple
        label: Optional track label
        fill_alpha: Fill opacity (0-1)
    """
    img = Image.new("RGB", (width, height), (255, 255, 255))
    if not values or all(v == 0 for v in values):
        return img

    draw = ImageDraw.Draw(img)
    n = len(values)
    max_val = max(abs(v) for v in values if v is not None) or 1
    pad_top = 4
    pad_bot = 4
    plot_h = height - pad_top - pad_bot

    # Draw filled area
    fill_color = tuple(int(c * fill_alpha + 255 * (1 - fill_alpha)) for c in color)
    for i in range(n):
        x = int(i / n * width)
        x_end = int((i + 1) / n * width)
        v = values[i] if values[i] is not None else 0
        bar_h = int(abs(v) / max_val * plot_h)
        y_top = pad_top + plot_h - bar_h
        draw.rectangle([x, y_top, x_end, pad_top + plot_h], fill=fill_color)

    # Draw line on top
    points = []
    for i in range(n):
        x = int((i + 0.5) / n * width)
        v = values[i] if values[i] is not None else 0
        y = pad_top + plot_h - int(abs(v) / max_val * plot_h)
        points.append((x, y))

    if len(points) >= 2:
        draw.line(points, fill=color, width=1)

    # Baseline
    draw.line([(0, pad_top + plot_h), (width, pad_top + plot_h)],
              fill=(200, 200, 200), width=1)

    # Label
    if label:
        font = _get_font(9)
        draw.text((3, 1), label, fill=(100, 100, 100), font=font)

    # Y-axis max
    font = _get_font(8)
    max_str = f"{max_val:.1f}" if max_val < 100 else f"{max_val:.0f}"
    draw.text((width - 30, 1), max_str, fill=(150, 150, 150), font=font)

    return img


def render_coverage_track(reads: list, region_width: int, width: int,
                          height: int = 40, color: Tuple[int, int, int] = (100, 149, 237),
                          label: str = "Coverage") -> Image.Image:
    """Render a coverage histogram from compact reads.

    Args:
        reads: List of compact read dicts with 'intervals' field
        region_width: Viewport size in bp
        width: Image width in pixels
        height: Track height
    """
    if not reads or region_width <= 0:
        return Image.new("RGB", (width, height), (255, 255, 255))

    # Compute per-bin coverage
    n_bins = min(width, region_width)
    bin_size = region_width / n_bins
    coverage = [0] * n_bins

    for read in reads:
        for iv in read.get('intervals', []):
            s = max(0, iv[0])
            e = min(region_width, iv[1])
            b0 = int(s / bin_size)
            b1 = min(n_bins, int(e / bin_size) + 1)
            for b in range(b0, b1):
                coverage[b] += 1

    return render_signal_track(coverage, width, height, color=color, label=label)


def render_annotation_track(annotations: list, width: int, start: int, end: int,
                            height: int = 20, color: Tuple[int, int, int] = (100, 100, 200),
                            label: str = None) -> Image.Image:
    """Render BED-style annotation intervals.

    Args:
        annotations: List of dicts with 'start', 'end', and optionally 'name', 'strand'
        width: Image width
        start, end: Genomic region
        label: Track label
    """
    region_size = end - start
    if region_size <= 0 or not annotations:
        return Image.new("RGB", (width, height), (255, 255, 255))

    img = Image.new("RGB", (width, height), (255, 255, 255))
    draw = ImageDraw.Draw(img)
    font = _get_font(8)

    # Simple single-row rendering
    bar_h = max(4, height - 8)
    y_mid = (height - bar_h) // 2

    for ann in annotations:
        a_start = ann.get('start', 0)
        a_end = ann.get('end', 0)
        if a_end <= start or a_start >= end:
            continue

        x0 = max(0, int((a_start - start) / region_size * width))
        x1 = min(width, int((a_end - start) / region_size * width))
        if x1 <= x0:
            x1 = x0 + 1

        draw.rectangle([x0, y_mid, x1, y_mid + bar_h], fill=color, outline=(80, 80, 160))

        name = ann.get('name')
        if name and (x1 - x0) > 20:
            tw = font.getlength(name) if hasattr(font, 'getlength') else len(name) * 5
            if tw < (x1 - x0 - 4):
                draw.text((x0 + 2, y_mid + 1), name, fill=(255, 255, 255), font=font)

    if label:
        draw.text((3, 1), label, fill=(100, 100, 100), font=_get_font(9))

    return img


def render_dataset_header(width: int, label: str, color: Tuple[int, int, int],
                          height: int = 16) -> Image.Image:
    """Render a colored dataset header bar."""
    img = Image.new("RGB", (width, height), (240, 240, 240))
    draw = ImageDraw.Draw(img)

    # Color bar on left
    draw.rectangle([0, 0, 5, height], fill=color)

    # Label text
    font = _get_font(10)
    draw.text((10, 2), label, fill=(60, 60, 60), font=font)

    return img
