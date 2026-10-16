"""Vectorised rectangle painter for the read track.

The browser paints reads with thousands of ``fillRect`` calls on an
antialiased canvas. Here every call becomes one row of an op batch
(read row, x0, x1, colour, alpha, vertical band) and a whole drawing pass
("phase") is composited at once:

* Horizontal edges get fractional pixel coverage, like canvas antialiasing.
* Vertically, every read row has the same structure (fill height, 1 px
  bottom border, mark height, ...), so pixel lines inside a row that see the
  same band coverage are composited once per read row and then repeated.
* Within a phase, ops are assumed not to overlap in a row (true for the
  intervals of one layer), which lets a phase be summed with difference
  arrays and composited with a single source-over.

Phases are composited in the order they are added, which reproduces the
browser's z-order (background, FIRE, primary nuc/FP, marks, overlays...).
"""
from __future__ import annotations

import math

import numpy as np


class RowRaster:
    def __init__(self, n_rows: int, width: float, stride: float, scale: float, background):
        self.n = int(n_rows)
        self.width = float(width)
        self.stride = float(stride)
        self.W = max(1, int(round(width * scale)))
        self.sx = self.W / max(1e-9, width)
        self.P = max(1, int(round(stride * scale)))
        self.sy = self.P / max(1e-9, stride)
        self.background = np.asarray(background, dtype=np.float32)
        self.phases: list[list[tuple]] = []

    def phase(self) -> None:
        self.phases.append([])

    def add(self, band: tuple[float, float], rows, x0, x1, color, alpha, clip_left: float = 0.0) -> None:
        """Queue rectangles: rows (N,), x0/x1 in CSS px, color (N,3)|(3,), alpha (N,)|scalar."""
        rows = np.asarray(rows, dtype=np.int64)
        if rows.size == 0:
            return
        y0, y1 = max(0.0, float(band[0])), min(self.stride, float(band[1]))
        if y1 <= y0:
            return
        x0 = np.broadcast_to(np.asarray(x0, dtype=np.float64), rows.shape)
        x1 = np.broadcast_to(np.asarray(x1, dtype=np.float64), rows.shape)
        color = np.asarray(color, dtype=np.float32)
        color = np.broadcast_to(color, rows.shape + (3,)) if color.ndim == 1 else color
        alpha = np.broadcast_to(np.asarray(alpha, dtype=np.float32), rows.shape)
        lo = max(0.0, clip_left)
        x0c = np.clip(x0, lo, self.width) * self.sx
        x1c = np.clip(x1, lo, self.width) * self.sx
        keep = (x1c > x0c) & (alpha > 0) & (rows >= 0) & (rows < self.n)
        if not keep.any():
            return
        if not self.phases:
            self.phase()
        self.phases[-1].append(((y0, y1), rows[keep], x0c[keep], x1c[keep], color[keep], alpha[keep]))

    # ------------------------------------------------------------------
    def _band_weights(self, band: tuple[float, float]) -> np.ndarray:
        k = np.arange(self.P, dtype=np.float64)
        lo = k / self.sy
        hi = (k + 1) / self.sy
        return np.clip((np.minimum(hi, band[1]) - np.maximum(lo, band[0])) * self.sy, 0, 1)

    def _accumulate(self, ops, weights: dict):
        """One pass for one line class -> [(pixel indices, premultiplied RGB, alpha)] (disjoint sets)."""
        rows_l, x0_l, x1_l, col_l, a_l = [], [], [], [], []
        for band, rows, x0, x1, color, alpha in ops:
            w = weights[band]
            if w <= 0:
                continue
            rows_l.append(rows)
            x0_l.append(x0)
            x1_l.append(x1)
            col_l.append(color)
            a_l.append(alpha * np.float32(w))
        if not rows_l:
            return None
        rows = np.concatenate(rows_l)
        x0 = np.concatenate(x0_l)
        x1 = np.concatenate(x1_l)
        color = np.concatenate(col_l).astype(np.float32)
        alpha = np.concatenate(a_l).astype(np.float32)
        W = self.W
        size = self.n * W
        base = rows * W
        i0 = np.minimum(np.floor(x0).astype(np.int64), W - 1)
        i1 = np.floor(x1).astype(np.int64)
        same = i1 <= i0
        left_cov = np.where(same, x1 - x0, (i0 + 1) - x0).astype(np.float32)
        right_ok = ~same & (i1 < W) & (x1 > i1)
        # Partly covered end pixels.
        p_idx = np.concatenate([base + i0, (base + i1)[right_ok]])
        p_cov = np.concatenate([left_cov, (x1 - i1)[right_ok].astype(np.float32)])
        p_op = np.concatenate([np.arange(len(rows)), np.flatnonzero(right_ok)])
        # Fully covered pixels [i0 + 1, i1): paint the op id with a running sum
        # (ops of one pass never overlap in a row).
        full = ~same & (i1 > i0 + 1)
        f_idx = np.zeros(0, dtype=np.int64)
        f_op = np.zeros(0, dtype=np.int64)
        if full.any():
            ops_f = np.flatnonzero(full)
            s_idx = base[full] + i0[full] + 1
            e_idx = base[full] + np.minimum(i1[full], W)
            tag = (ops_f + 1).astype(np.float64)
            diff = np.bincount(s_idx, weights=tag, minlength=size + 1)
            diff[:len(diff)] -= np.bincount(e_idx, weights=tag, minlength=len(diff))[:len(diff)]
            ids = np.rint(np.cumsum(diff[:size])).astype(np.int64)
            f_idx = np.flatnonzero(ids > 0)
            f_op = ids[f_idx] - 1
        groups = []
        if len(f_idx):
            # Fully covered pixels are distinct: one op each.
            a = alpha[f_op]
            groups.append((f_idx, color[f_op] * a[:, None], a))
        # Edge pixels can be shared by neighbouring ops: sum their coverage.
        a = alpha[p_op] * p_cov
        prem = color[p_op] * a[:, None]
        uniq, inv = np.unique(p_idx, return_inverse=True)
        if len(uniq) != len(p_idx):
            a = np.bincount(inv, weights=a, minlength=len(uniq)).astype(np.float32)
            prem = np.stack([np.bincount(inv, weights=prem[:, c], minlength=len(uniq)) for c in range(3)],
                            axis=1).astype(np.float32)
        else:
            order = np.argsort(p_idx)
            a, prem = a[order], prem[order]
        over = a > 1
        if over.any():
            prem[over] /= a[over, None]
            a[over] = 1.0
        groups.append((uniq, prem, a))
        return groups

    @staticmethod
    def _split_overlaps(ops):
        """Split a phase into passes whose rectangles don't overlap within a row."""
        if not ops:
            return []
        rows = np.concatenate([o[1] for o in ops])
        x0 = np.concatenate([o[2] for o in ops])
        x1 = np.concatenate([o[3] for o in ops])
        owner = np.concatenate([np.full(len(o[1]), i) for i, o in enumerate(ops)])
        local = np.concatenate([np.arange(len(o[1])) for o in ops])
        order = np.lexsort((np.arange(len(rows)), x0, rows))
        big = float(np.max(x1) + 10.0) if len(x1) else 1.0
        key_end = rows[order] * big + x1[order]
        key_start = rows[order] * big + x0[order]
        run_max = np.maximum.accumulate(key_end)
        clash = np.zeros(len(order), dtype=bool)
        clash[1:] = key_start[1:] < run_max[:-1] - 1e-6
        if not clash.any():
            return [ops]
        second = np.zeros(len(rows), dtype=bool)
        second[order[clash]] = True
        first_ops, rest_ops = [], []
        for i, (band, r, a0, a1, col, al) in enumerate(ops):
            sel = second[owner == i][np.argsort(local[owner == i])]
            if (~sel).any():
                first_ops.append((band, r[~sel], a0[~sel], a1[~sel], col[~sel], al[~sel]))
            if sel.any():
                rest_ops.append((band, r[sel], a0[sel], a1[sel], col[sel], al[sel]))
        return [first_ops] + RowRaster._split_overlaps(rest_ops)

    def render(self) -> np.ndarray:
        """-> (n * P, W, 3) uint8 image."""
        bands = sorted({op[0] for phase in self.phases for op in phase})
        weights = {band: self._band_weights(band) for band in bands}
        # Pixel lines inside a row with the same band coverage look the same.
        classes: dict[tuple, list[int]] = {}
        for k in range(self.P):
            key = tuple(round(float(weights[b][k]), 6) for b in bands)
            classes.setdefault(key, []).append(k)
        passes = []
        for ops in self.phases:
            by_band: dict = {}
            for op in ops:
                by_band.setdefault(op[0], []).append(op)
            # Ops of different bands cover different pixel lines; overlaps
            # only matter between ops that share a line, so split per band.
            split = [self._split_overlaps(group) for group in by_band.values()]
            depth = max((len(s) for s in split), default=0)
            for level in range(depth):
                passes.append([op for s in split if level < len(s) for op in s[level]])
        image = np.empty((self.n, self.P, self.W, 3), dtype=np.uint8)
        for key, lines in classes.items():
            w = dict(zip(bands, key))
            dst = np.empty((self.n * self.W, 3), dtype=np.float32)
            dst[:] = self.background
            for ops in passes:
                for idx, prem, a in self._accumulate(ops, w) or ():
                    if a.min() >= 1.0:
                        dst[idx] = prem          # opaque: plain overwrite
                    else:
                        dst[idx] = dst[idx] * (1.0 - a)[:, None] + prem
            px = np.clip(np.floor(dst + 0.5), 0, 255).astype(np.uint8).reshape(self.n, self.W, 3)
            for k in lines:
                image[:, k] = px
        return image.reshape(self.n * self.P, self.W, 3)


def gaussian_blur(img: np.ndarray, sigma_x: float, sigma_y: float) -> np.ndarray:
    """applyGaussianSmoothing: separable blur with clamped edges (sigmas in image px)."""
    out = img.astype(np.float32)
    for axis, sigma in ((1, sigma_x), (0, sigma_y)):
        if sigma <= 0:
            continue
        radius = max(1, math.ceil(sigma * 3))
        k = np.exp(-(np.arange(-radius, radius + 1) ** 2) / (2 * sigma * sigma))
        k /= k.sum()
        pad = [(0, 0)] * out.ndim
        pad[axis] = (radius, radius)
        padded = np.pad(out, pad, mode='edge')
        acc = np.zeros_like(out)
        n = out.shape[axis]
        for i, wt in enumerate(k):
            sl = [slice(None)] * out.ndim
            sl[axis] = slice(i, i + n)
            acc += wt * padded[tuple(sl)]
        out = acc
    return np.clip(np.floor(out), 0, 255).astype(np.uint8)
