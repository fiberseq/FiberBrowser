"""The box mean's bootstrap interval for size plots (Size enrichment, V-plot): each unit (a read, or a BED region)
keeps its own raw counts; a resample weights the units by Poisson(1) draws from their own seeded streams
(services/stable_sample), sums them, finishes the matrix exactly as the plot is finished (finish_vplot) and takes
the mean over the box. The interval is the percentile interval over the resamples."""
from __future__ import annotations

from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

from services.stable_sample import percentile_interval, poisson_weight_matrix


class UnitCounts:
    """Raw counts per unit (matrix, row and column footprint counts), added to as reads arrive."""

    def __init__(self, n_size: int, n_pos: int):
        self.shape = (n_size, n_pos)
        self.units: Dict[str, Tuple[np.ndarray, np.ndarray, np.ndarray]] = {}

    def add(self, unit: str, matrix: np.ndarray, row: np.ndarray, col: np.ndarray) -> None:
        cur = self.units.get(unit)
        if cur is None:
            self.units[unit] = (matrix.astype(np.float64).copy(), row.astype(np.float64).copy(), col.astype(np.float64).copy())
        else:
            cur[0][...] += matrix
            cur[1][...] += row
            cur[2][...] += col


def box_mean(m: np.ndarray, size_lo: int, size_hi: int, pos_lo: int, pos_hi: int, transform: str = "none") -> float:
    """The box's mean on the plot's scale: log2 of the cells (enrichment drawn as log2; cells <= 0 left out), log1p
    (counts drawn as log1p), or the values; blank cells left out (as the browser's boxMean)."""
    box = m[size_lo:size_hi, pos_lo:pos_hi]
    vals = box[np.isfinite(box)]
    if transform == "log2":
        vals = np.log2(vals[vals > 0])
    elif transform == "log1p":
        vals = np.log1p(np.maximum(vals, 0))
    return float(vals.mean()) if vals.size else float("nan")


def box_bootstrap(units: UnitCounts, *, seed: int, resamples: int, finish_kw: dict, box: Tuple[int, int, int, int],
                  level: float = 0.95, transform: str = "none") -> Tuple[Optional[float], Optional[float], int]:
    """(lo, hi, units) of the box mean over Poisson-bootstrap resamples of the units."""
    from services.vplot_matrix import finish_vplot
    ids = sorted(units.units)
    if not ids:
        return None, None, 0
    n_size, n_pos = units.shape
    x = np.stack([units.units[u][0].reshape(-1) for u in ids])
    rows = np.stack([units.units[u][1] for u in ids])
    cols = np.stack([units.units[u][2] for u in ids])
    w = poisson_weight_matrix(seed, ids, resamples).T.astype(np.float64)  # resamples × units
    mats, rs, cs = w @ x, w @ rows, w @ cols
    vals = []
    for b in range(w.shape[0]):
        f = finish_vplot(mats[b].reshape(n_size, n_pos), row_counts=rs[b].round().astype(np.int64), col_counts=cs[b].round().astype(np.int64), blank=float("nan"), **finish_kw)
        vals.append(box_mean(f, *box, transform=transform))
    lo, hi = percentile_interval([v for v in vals if np.isfinite(v)], level)
    return lo, hi, len(ids)


def box_indices(size_min: int, size_bin: int, n_size: int, pos_start: int, pos_bin: int, n_pos: int,
                size_from: float, size_to: float, pos_from: Optional[float], pos_to: Optional[float]) -> Tuple[int, int, int, int]:
    """The box as matrix index ranges: size rows whose start is in [size_from, size_to), position columns overlapping
    [pos_from, pos_to) (None: open), as the browser's boxMean picks them."""
    s_lo = next((i for i in range(n_size) if size_min + i * size_bin >= size_from), n_size)
    s_hi = next((i for i in range(n_size) if size_min + i * size_bin >= size_to), n_size)
    p_lo = 0 if pos_from is None else next((j for j in range(n_pos) if pos_start + (j + 1) * pos_bin > pos_from), n_pos)
    p_hi = n_pos if pos_to is None else next((j for j in range(n_pos) if pos_start + j * pos_bin >= pos_to), n_pos)
    return s_lo, s_hi, p_lo, p_hi
