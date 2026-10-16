"""Rendering helpers for DAF-C/Micro-C contact views."""
from __future__ import annotations

from typing import Dict, List, Optional

import numpy as np
from PIL import Image

from services.dafc_reads import build_read_footprint_array


def render_linked_reads_image(
    ligated_reads: List[Dict],
    region: str,
    region_start: int,
    region_end: int,
    max_width: int = 2000,
    row_height: int = 3,
) -> Image.Image:
    """Render linked reads to a PNG image with matched row ordering."""
    if not ligated_reads:
        return Image.new("RGB", (100, 50), (255, 255, 255))

    link_colors = [
        (255, 127, 80), (100, 149, 237), (144, 238, 144), (255, 215, 0),
        (221, 160, 221), (135, 206, 250), (255, 182, 193), (152, 251, 152),
    ]

    reads_data = []
    for read in ligated_reads:
        segments = read["x_segments"] if region == "x" else read["y_segments"]
        reads_data.append(build_read_footprint_array(segments, region_start, region_end))

    if not reads_data:
        return Image.new("RGB", (100, 50), (255, 255, 255))

    width = max(len(r) for r in reads_data)
    n_reads = len(reads_data)
    sidebar_width = 8
    img_width = sidebar_width + width
    img_height = n_reads * row_height

    if width > max_width:
        scale = max_width / width
        width = max_width
        img_width = sidebar_width + width
    else:
        scale = 1.0

    img_arr = np.full((img_height, img_width, 3), 255, dtype=np.uint8)

    for i in range(n_reads):
        color = link_colors[i % len(link_colors)]
        y_start = i * row_height
        y_end = (i + 1) * row_height
        img_arr[y_start:y_end, 0:sidebar_width - 1] = color

    for i, read_arr in enumerate(reads_data):
        y_start = i * row_height
        y_end = (i + 1) * row_height

        for x in range(width):
            src_x = int(x / scale) if scale < 1 else x
            if src_x >= len(read_arr):
                continue

            val = read_arr[src_x]
            if val == 0:
                color = (255, 255, 255)
            elif val < 0:
                color = (204, 204, 204)
            elif val < 90:
                color = (140, 140, 140)
            else:
                color = (51, 160, 64)

            img_arr[y_start:y_end, sidebar_width + x] = color

    return Image.fromarray(img_arr, "RGB")


def aggregate_matrix(matrix: np.ndarray, target_h: int, target_w: int) -> np.ndarray:
    """Aggregate a 2D matrix to target dimensions using mean-pooling."""
    h, w = matrix.shape
    result = matrix
    if w > target_w:
        col_edges = np.linspace(0, w, target_w + 1).astype(int)
        agg = np.zeros((result.shape[0], target_w), dtype=np.float64)
        for j in range(target_w):
            s, e = col_edges[j], col_edges[j + 1]
            if e > s:
                agg[:, j] = np.nanmean(result[:, s:e], axis=1)
        result = agg
    if result.shape[0] > target_h:
        row_edges = np.linspace(0, result.shape[0], target_h + 1).astype(int)
        agg = np.zeros((target_h, result.shape[1]), dtype=np.float64)
        for i in range(target_h):
            s, e = row_edges[i], row_edges[i + 1]
            if e > s:
                agg[i, :] = np.nanmean(result[s:e, :], axis=0)
        result = agg
    return result


def render_contact_matrix_image(
    matrix: np.ndarray,
    target_size: int = 800,
    scaling: str = "log",
    colormap: str = "fall",
    vmin: Optional[float] = None,
    vmax: Optional[float] = None,
) -> Image.Image:
    """Render a contact matrix to a PNG with configurable scaling and colormap."""
    if matrix.size == 0:
        return Image.new("RGB", (100, 100), (255, 255, 255))

    h, w = matrix.shape

    if max(h, w) > target_size:
        aspect = w / h if h > 0 else 1.0
        if w >= h:
            target_w = target_size
            target_h = max(1, int(target_size / aspect))
        else:
            target_h = target_size
            target_w = max(1, int(target_size * aspect))
        matrix = aggregate_matrix(matrix, target_h, target_w)
        h, w = matrix.shape

    scale = max(1, target_size // max(h, w))
    out_h, out_w = h * scale, w * scale

    plot_matrix = matrix.astype(float)
    if scaling == "log":
        nonzero = plot_matrix[plot_matrix > 0]
        pseudocount = float(np.min(nonzero)) if len(nonzero) > 0 else 1.0
        plot_matrix = np.log(plot_matrix + pseudocount)
    elif scaling == "sqrt":
        plot_matrix = np.sqrt(np.maximum(plot_matrix, 0))

    zero_mask = (matrix == 0) | np.isnan(matrix)
    plot_matrix[zero_mask] = np.nan

    valid = plot_matrix[~np.isnan(plot_matrix)]
    if len(valid) == 0:
        small_img = Image.new("RGB", (w, h), (255, 255, 255))
        if scale > 1:
            return small_img.resize((out_w, out_h), Image.Resampling.NEAREST)
        return small_img

    lo = vmin if vmin is not None else float(np.nanmin(valid))
    hi = vmax if vmax is not None else float(np.nanmax(valid))
    if hi <= lo:
        hi = lo + 1.0

    normalized = np.clip((plot_matrix - lo) / (hi - lo), 0.0, 1.0)
    normalized[np.isnan(plot_matrix)] = 0.0

    rgb = apply_colormap(normalized, colormap)
    rgb[zero_mask] = [255, 255, 255]

    small_img = Image.fromarray(rgb, "RGB")
    if scale > 1:
        return small_img.resize((out_w, out_h), Image.Resampling.NEAREST)
    return small_img


def render_matrix_strip_image(
    strip: np.ndarray,
    width: int = 800,
    height: int = 150,
    scaling: str = "log",
    colormap: str = "fall",
) -> Image.Image:
    """Render a triangular matrix strip as a heatmap image."""
    if strip.size == 0:
        return Image.new("RGB", (width, height), (255, 255, 255))

    row_sums = np.sum(strip, axis=1)
    nonzero_rows = np.where(row_sums > 0)[0]
    if len(nonzero_rows) > 0:
        max_data_row = nonzero_rows[-1] + 1
        max_row = min(strip.shape[0], int(max_data_row * 1.1) + 1)
        strip = strip[:max_row, :]

    if strip.size == 0:
        return Image.new("RGB", (width, height), (255, 255, 255))

    strip = aggregate_matrix(strip, height, width)

    if scaling == "log":
        nonzero = strip[strip > 0]
        pseudocount = float(np.min(nonzero)) if len(nonzero) > 0 else 1.0
        scaled = np.log(strip + pseudocount)
    elif scaling == "sqrt":
        scaled = np.sqrt(np.maximum(strip, 0))
    else:
        scaled = strip.astype(float)

    valid_scaled = scaled[np.isfinite(scaled)]
    max_val = np.max(valid_scaled) if len(valid_scaled) > 0 else 0
    min_val = np.min(valid_scaled) if len(valid_scaled) > 0 else 0
    val_range = max_val - min_val
    if val_range > 0:
        normalized = np.clip((scaled - min_val) / val_range, 0.0, 1.0)
    else:
        normalized = np.zeros_like(scaled)

    rgb = apply_colormap(normalized, colormap)
    rgb = np.flipud(rgb)

    img = Image.fromarray(rgb, "RGB")
    return img.resize((width, height), Image.Resampling.BILINEAR)


def apply_colormap(normalized: np.ndarray, colormap: str) -> np.ndarray:
    """Apply a named colormap to normalized 0-1 values."""
    rgb = np.zeros((*normalized.shape, 3), dtype=np.uint8)
    n = (normalized * 255).astype(np.uint8)

    if colormap == "red":
        rgb[:, :, 0] = 255
        rgb[:, :, 1] = 255 - n
        rgb[:, :, 2] = 255 - n

    elif colormap == "fall":
        v = normalized
        t1 = v / 0.25
        t2 = (v - 0.25) / 0.25
        t3 = (v - 0.5) / 0.25
        t4 = (v - 0.75) / 0.25
        m1, m2, m3, m4 = v < 0.25, (v >= 0.25) & (v < 0.5), (v >= 0.5) & (v < 0.75), v >= 0.75
        rgb[:, :, 0] = np.where(m4, (255 - t4 * 116).astype(np.uint8), 255)
        rgb[:, :, 1] = np.where(
            m1,
            255,
            np.where(m2, (255 * (1 - t2 * 0.35)).astype(np.uint8),
                     np.where(m3, (165 * (1 - t3)).astype(np.uint8), 0)),
        )
        rgb[:, :, 2] = np.where(m1, (255 * (1 - t1)).astype(np.uint8), 0)

    elif colormap == "hot":
        v = normalized
        t1 = v / 0.33
        t2 = (v - 0.33) / 0.33
        t3 = (v - 0.66) / 0.34
        m1, m2, m3 = v < 0.33, (v >= 0.33) & (v < 0.66), v >= 0.66
        rgb[:, :, 0] = np.where(m1, (255 * t1).astype(np.uint8), 255)
        rgb[:, :, 1] = np.where(m1, 0, np.where(m2, (255 * t2).astype(np.uint8), 255))
        rgb[:, :, 2] = np.where(m3, (255 * t3).astype(np.uint8), 0)

    elif colormap == "viridis":
        viridis_colors = [
            (68, 1, 84), (72, 40, 120), (62, 74, 137), (49, 104, 142),
            (38, 130, 142), (31, 158, 137), (53, 183, 121), (110, 206, 88),
            (181, 222, 43), (253, 231, 37),
        ]
        lut = np.zeros((256, 3), dtype=np.uint8)
        nc = len(viridis_colors)
        for li in range(256):
            frac = li / 255.0
            idx = min(int(frac * (nc - 1)), nc - 2)
            t = frac * (nc - 1) - idx
            c0, c1 = viridis_colors[idx], viridis_colors[idx + 1]
            lut[li] = [int(c0[k] + t * (c1[k] - c0[k])) for k in range(3)]
        indices = (normalized * 255).clip(0, 255).astype(np.uint8)
        rgb = lut[indices]

    elif colormap == "blues":
        rgb[:, :, 0] = 255 - n
        rgb[:, :, 1] = 255 - n
        rgb[:, :, 2] = 255

    else:
        rgb[:, :, 0] = 255
        rgb[:, :, 1] = 255 - n
        rgb[:, :, 2] = 255 - n

    return rgb


# Backwards-compatible aliases for older imports.
_aggregate_matrix = aggregate_matrix
_apply_colormap = apply_colormap
