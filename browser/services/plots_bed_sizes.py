"""Plots: footprint size × position (size enrichment, V-plot) pooled over BED anchors.

Each chosen region's window (anchor ± flank; minus-strand regions flipped so downstream is to the right) is counted
with the one V-plot counting (services/vplot_matrix.accumulate_vplot, midpoint or span) from the reads over it (the
same interval source as the view's size plots: routers/clustering_visualization._pick_vplot_intervals), and the
windows' raw counts add per set (× dataset). Finishing is the one V-plot finishing (finish_vplot) on the pooled raw
counts. Region subsampling, reads per region and the plot's Random N reads follow the stable sampling rule.
"""
from __future__ import annotations

from typing import Dict, List, Optional

import numpy as np


def window_arrays(read: dict, ws_start: int, w0: int, width: int, strand: str, layer: Optional[str]):
    """(starts, ends, sizes) of a read's footprints in window coordinates (flipped on the minus strand)."""
    from routers.clustering_visualization import _pick_vplot_intervals
    from services.vplot_matrix import footprint_arrays
    s, e, z = footprint_arrays(_pick_vplot_intervals(read, layer), ws_start - w0)
    if strand == "-":
        s, e = width - e, width - s
    return s, e, z


def read_span(read: dict, ws_start: int):
    blocks = read.get("aligned_blocks") or []
    if blocks:
        return min(b[0] for b in blocks), max(b[1] for b in blocks)
    ivs = read.get("intervals") or []
    if ivs:
        return ws_start + min(i[0] for i in ivs), ws_start + max(i[1] for i in ivs)
    return None


def centre_occluded(read: dict, ws_start: int, centre: int) -> bool:
    """A nucleosome (the Nuc layer, else the calls of nucleosome size) covers the window's centre."""
    layer = (read.get("layers") or {}).get("nuc")
    ivs = layer.get("intervals") if layer else [iv for iv in (read.get("intervals") or []) if len(iv) > 2 and iv[2] >= 90]
    return any(ws_start + int(iv[0]) <= centre < ws_start + int(iv[1]) for iv in ivs or [] if len(iv) >= 2)


class Acc:
    def __init__(self, n_size: int, n_pos: int):
        self.matrix = np.zeros((n_size, n_pos), dtype=float)
        self.row = np.zeros(n_size, dtype=np.int64)
        self.col = np.zeros(n_pos, dtype=np.int64)
        self.n_reads = 0

    def payload(self) -> dict:
        return dict(matrix=self.matrix.round(6).tolist(), row=self.row.tolist(), col=self.col.tolist(), n_reads=int(self.n_reads))


def finish(groups: List[dict], *, normalization: str, sigma_size_bp: float, sigma_pos_bp: float, size_bin: int, pos_bin: int,
           row_min_footprints: int) -> List[dict]:
    """The pooled raw counts finished as the view's size plots are (raw values: no log, no max; blanks null)."""
    from services.vplot_matrix import VPLOT_NORMALIZATIONS, finish_vplot, sigma_bins
    norm = normalization if normalization in VPLOT_NORMALIZATIONS else "row"
    out = []
    for g in groups:
        m = np.asarray(g["matrix"], dtype=float)
        row = np.asarray(g.get("row") or np.zeros(m.shape[0]), dtype=np.int64)
        col = np.asarray(g.get("col") or np.zeros(m.shape[1] if m.ndim == 2 else 0), dtype=np.int64)
        f = finish_vplot(m, normalization=norm, log=False, sigma_bins_size=sigma_bins(sigma_size_bp, size_bin), sigma_bins_pos=sigma_bins(sigma_pos_bp, pos_bin),
                         row_counts=row, col_counts=col, row_min_footprints=row_min_footprints, blank=float("nan"))
        out.append(dict(id=g["id"], matrix=[[None if not np.isfinite(x) else round(float(x), 6) for x in r] for r in f],
                        n_reads=int(g.get("n_reads") or 0), n_footprints=int(row.sum())))
    return out


def group_key(set_id: str, dataset: str, pooled: bool) -> str:
    return f"{set_id}|{'*' if pooled else dataset}"


def count_windows(state, query, jobs, windows, members, sets, *, dataset_ids, layer, size_min, size_bin, n_size, pos_bin, n_pos, mode,
                  per_region, seed, key_max: Dict[str, int], occlusion: str, pooled: bool, block, names_only: bool = False,
                  units: Optional[dict] = None, unit_kind: str = "regions"):
    """Raw counts (or, names_only, the read names with their keys) of a block's windows. ``units`` (group key ->
    services.box_bootstrap.UnitCounts): each region's (or read's) own counts too, for the box mean's bootstrap."""
    from bisect import bisect_left
    from services.stable_sample import lowest_k, stable_key
    from services.vplot_matrix import accumulate_vplot
    chrom, bstart, bend, _m = block
    accs: Dict[str, Acc] = {}
    names: Dict[str, Dict[str, int]] = {}
    for ds in dataset_ids:
        ws = query.build_working_set(state, ds, chrom=chrom, start=bstart, end=bend)
        spans = []
        for r in ws.reads:
            sp = read_span(r, ws.start)
            if sp:
                spans.append((sp[0], sp[1], str(r.get("id")), r))
        spans.sort(key=lambda x: (x[0], x[2]))
        starts = [x[0] for x in spans]
        for j in members:
            si, ri = jobs[j]
            region = sets[si]["regions"][ri]
            strand = region[3] if len(region) > 3 else "."
            _c, w0, w1 = windows[j]
            width = w1 - w0
            hits = [x for x in spans[:bisect_left(starts, w1)] if x[1] > w0]
            if per_region > 0 and len(hits) > per_region:
                hits = lowest_k(hits, per_region, key=lambda x: stable_key(seed, ds, x[2]), ident=lambda x: x[2])
            if ds in key_max:
                hits = [x for x in hits if stable_key(seed, ds, x[2]) <= key_max[ds]]
            if occlusion == "centre":
                centre = (w0 + w1) // 2
                hits = [x for x in hits if not centre_occluded(x[3], ws.start, centre)]
            if names_only:
                d = names.setdefault(ds, {})
                for x in hits:
                    d[x[2]] = stable_key(seed, ds, x[2])
                continue
            key = group_key(str(sets[si].get("id")), ds, pooled)
            acc = accs.setdefault(key, Acc(n_size, n_pos))
            ss, ee, zz = [], [], []
            for x in hits:
                s, e, z = window_arrays(x[3], ws.start, w0, width, strand, layer)
                ss.append(s); ee.append(e); zz.append(z)
            if ss:
                acc.matrix += accumulate_vplot(np.concatenate(ss), np.concatenate(ee), np.concatenate(zz), size_min=size_min, size_bin=size_bin,
                                               n_size_bins=n_size, pos_bin=pos_bin, n_pos_bins=n_pos, mode=mode, row_counts=acc.row, col_counts=acc.col)
                if units is not None:
                    from services.box_bootstrap import UnitCounts
                    from services.plots_regions import region_identity
                    uc = units.setdefault(key, UnitCounts(n_size, n_pos))
                    parts = [(f"{sets[si].get('id')}:{region_identity(region)}", ss, ee, zz)] if unit_kind != "reads" \
                        else [(f"{ds}:{x[2]}", [a], [b], [c]) for x, a, b, c in zip(hits, ss, ee, zz)]
                    for uid, s1, e1, z1 in parts:
                        row = np.zeros(n_size, dtype=np.int64)
                        col = np.zeros(n_pos, dtype=np.int64)
                        m = accumulate_vplot(np.concatenate(s1), np.concatenate(e1), np.concatenate(z1), size_min=size_min, size_bin=size_bin,
                                             n_size_bins=n_size, pos_bin=pos_bin, n_pos_bins=n_pos, mode=mode, row_counts=row, col_counts=col)
                        uc.add(uid, m, row, col)
            acc.n_reads += len(hits)
    if names_only:
        return {ds: [[n, str(k)] for n, k in d.items()] for ds, d in names.items()}
    return {k: a.payload() for k, a in accs.items()}
