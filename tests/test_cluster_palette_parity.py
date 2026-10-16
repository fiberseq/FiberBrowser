"""One cluster palette everywhere (fb-n1-bugs 2).

The frontend (constants.ts) is the source; the figure renderer and the
legacy PNG renderers (render.py, read_rendering.py) draw the same colours for
the same cluster ids, unassigned reads (-1) in the app's grey. Before, the
PNG renderers used an older 10-colour list with yellow and peach, and drew
unassigned reads in the last cluster colour.
"""
import re
from pathlib import Path

import numpy as np

from services.figure.tracks import _read_colors as rc
from utils.colors import CLUSTER_COLORS, CLUSTER_COLORS_HEX, UNASSIGNED_CLUSTER_COLOR_HEX, cluster_color_hex, cluster_rgb

CONSTANTS = Path(__file__).resolve().parents[1] / "browser" / "frontend" / "src" / "components" / "tracks" / "read-track" / "constants.ts"


def _ts_palette():
    text = CONSTANTS.read_text()
    block = re.search(r"export const CLUSTER_COLORS = \[(.*?)\];", text, re.S).group(1)
    block = "\n".join(line.split("//")[0] for line in block.splitlines())
    unassigned = re.search(r"UNASSIGNED_CLUSTER_COLOR = '(#[0-9a-f]{6})'", text).group(1)
    return re.findall(r"'(#[0-9a-fA-F]{6})'", block), unassigned


def test_python_palette_is_the_frontend_palette():
    colors, unassigned = _ts_palette()
    assert colors == CLUSTER_COLORS_HEX
    assert unassigned == UNASSIGNED_CLUSTER_COLOR_HEX
    assert rc.CLUSTER_COLORS == CLUSTER_COLORS_HEX


def test_every_renderer_colours_ids_the_same_way():
    n = len(CLUSTER_COLORS_HEX)
    for cluster in (0, 1, 9, 11, n, n + 3):
        assert rc.cluster_color(cluster) == cluster_color_hex(cluster) == CLUSTER_COLORS_HEX[cluster % n]
        assert cluster_rgb(cluster) == CLUSTER_COLORS[cluster % n]
    assert rc.cluster_color(-1) == cluster_color_hex(-1) == UNASSIGNED_CLUSTER_COLOR_HEX
    assert cluster_rgb(-1) == (0x9c, 0xa3, 0xaf)


def test_clusters_zero_and_nine_are_no_longer_both_red():
    assert cluster_color_hex(0) != cluster_color_hex(9)
    r0, r9 = np.array(cluster_rgb(0)), np.array(cluster_rgb(9))
    assert np.abs(r0 - r9).sum() > 150
