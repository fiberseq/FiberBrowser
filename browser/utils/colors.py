"""Colormap and cluster color utilities."""

import numpy as np


def make_colormap():
    """Create RGB colormap for footprint sizes."""
    cmap = np.zeros((256, 3), dtype=np.uint8)
    cmap[0] = [255, 255, 255]  # No coverage
    cmap[1] = [255, 255, 255]  # Read end marker
    for i in range(2, 51):
        cmap[i] = [204, 204, 204]  # Gaps - light gray
    for i in range(51, 140):
        cmap[i] = [140, 140, 140]  # Subnucleosomal - gray
    for i in range(140, 256):
        cmap[i] = [51, 160, 64]  # Nucleosome - green
    return cmap


COLORMAP = make_colormap()

# The cluster palette of the app (frontend/src/components/tracks/read-track/
# constants.ts, CLUSTER_COLORS; tests/test_cluster_palette_parity.py keeps the
# two the same): 12 colours distinct for full colour vision and the common
# colour-vision deficiencies, then 12 more for clusters 12-23.
CLUSTER_COLORS_HEX = [
    '#ef3a7d', '#0f46e1', '#c3b503', '#057558', '#8c418b', '#46d6d1',
    '#bd854d', '#963d3b', '#acb8fe', '#6c760a', '#f8a49e', '#2c94b0',
    '#05e857', '#fb86fc', '#7a4800', '#f13e18', '#83a777', '#7577ac',
    '#055f73', '#a543ff', '#1387fe', '#b682a6', '#fcb02b', '#ae7167',
]
UNASSIGNED_CLUSTER_ID = -1
UNASSIGNED_CLUSTER_COLOR_HEX = '#9ca3af'


def _hex_rgb(color: str) -> tuple[int, int, int]:
    return tuple(int(color[i:i + 2], 16) for i in (1, 3, 5))


CLUSTER_COLORS = [_hex_rgb(c) for c in CLUSTER_COLORS_HEX]


def cluster_color_hex(cluster: int) -> str:
    """A cluster's colour, as the app draws it (unassigned reads grey)."""
    if int(cluster) == UNASSIGNED_CLUSTER_ID:
        return UNASSIGNED_CLUSTER_COLOR_HEX
    n = len(CLUSTER_COLORS_HEX)
    return CLUSTER_COLORS_HEX[((int(cluster) % n) + n) % n]


def cluster_rgb(cluster: int) -> tuple[int, int, int]:
    return _hex_rgb(cluster_color_hex(cluster))

DATASET_COLORS = ['#3b82f6', '#ef4444', '#22c55e', '#8b5cf6', '#ec4899', '#06b6d4', '#0e7490', '#d63384']


def value_to_colormap_index(val):
    """Convert footprint value to colormap index."""
    if val == 0:
        return 0
    elif val == 2:
        return 1
    elif val < 0:
        return min(50, max(2, 2 + abs(val) // 10))
    elif val < 90:
        return min(139, 51 + val)
    else:
        return min(255, 140 + (val - 90))
