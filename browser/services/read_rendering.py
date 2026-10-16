"""Server-side read image rendering helpers."""
from __future__ import annotations

import numpy as np
from PIL import Image

from utils.colors import COLORMAP, cluster_rgb


def render_reads_to_image(
    reads_df,
    cluster_assignments=None,
    sorted_indices=None,
    max_width=2000,
    row_height=3,
):
    """Render a dense read DataFrame to a PNG-compatible PIL image."""
    if reads_df.empty:
        return None

    numeric_cols = sorted([
        column
        for column in reads_df.columns
        if column != "read_id" and isinstance(column, (int, np.integer))
    ])
    if not numeric_cols:
        return None

    if sorted_indices is not None:
        reads_df = reads_df.iloc[sorted_indices].reset_index(drop=True)

    arr = reads_df[numeric_cols].to_numpy(dtype=np.int32)  # signed sizes exceed int16 (a 40-kb gap)
    n_reads, width = arr.shape

    if width > max_width:
        bin_size = width // max_width
        new_width = width // bin_size
        arr_binned = np.zeros((n_reads, new_width), dtype=np.int32)
        for i in range(new_width):
            chunk = arr[:, i * bin_size:(i + 1) * bin_size]
            max_idx = np.argmax(np.abs(chunk), axis=1)
            arr_binned[:, i] = chunk[np.arange(n_reads), max_idx]
        arr = arr_binned
        width = new_width

    has_cluster = cluster_assignments is not None and len(cluster_assignments) > 0
    sidebar_width = 8 if has_cluster else 0
    img_width = sidebar_width + width
    img_height = n_reads * row_height

    img_arr = np.full((img_height, img_width, 3), 255, dtype=np.uint8)

    if has_cluster:
        read_ids = (
            reads_df["read_id"].tolist()
            if "read_id" in reads_df.columns
            else [str(i) for i in range(n_reads)]
        )
        for i, read_id in enumerate(read_ids):
            cluster = cluster_assignments.get(read_id)
            if cluster is not None:
                color = cluster_rgb(cluster)
                img_arr[i * row_height:(i + 1) * row_height, 0:sidebar_width - 1] = color

    idx_arr = np.zeros_like(arr, dtype=np.uint8)
    idx_arr[arr == 0] = 0
    idx_arr[arr == 2] = 1
    idx_arr[arr < 0] = np.clip(2 + np.abs(arr[arr < 0]) // 10, 2, 50).astype(np.uint8)
    idx_arr[(arr > 2) & (arr < 90)] = np.clip(51 + arr[(arr > 2) & (arr < 90)], 51, 139).astype(np.uint8)
    idx_arr[arr >= 90] = np.clip(140 + (arr[arr >= 90] - 90), 140, 255).astype(np.uint8)

    colors = COLORMAP[idx_arr]
    for i in range(n_reads):
        y_start = i * row_height
        y_end = (i + 1) * row_height
        img_arr[y_start:y_end, sidebar_width:] = colors[i]

    return Image.fromarray(img_arr, "RGB")
