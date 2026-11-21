"""Meta-locus: keep the workspace full (cluster refill) and "find more like this", with honest frequencies.

Both scan the pool past the view in key order, decode reads in batches (intervals only, the display's read filters),
describe each read by the same features (footprint coverage per feature region in view coordinates; the user's
peak regions when given, else fixed bins over the window), and assign it:

- **refill**: to the nearest centroid of the current clusters (computed from the view's reads and the cluster labels
  the client sends: the clusterer's own labels, so any method works), topping up each cluster to a target;
- **find more**: to a template (the centroid of the selected reads), when its distance is within a radius set from
  the selection's own spread.

Matched reads join the view (``view_extra``), which is then *enriched*: the counts it shows are not frequencies.
The frequency is reported from the scan alone: matches / read-site observations scanned (assignable ones, i.e.
covering enough of the feature regions), with a Wilson 95% interval, plus the number not assignable. Each (read,
site) pair is one observation (owner); ``count_unit="molecule"`` counts read names once instead.
"""
from __future__ import annotations

import math
from typing import Callable, Optional

import numpy as np

from services import meta_locus_jobs as mj
from services import meta_locus_pool as mp

REFILL_DEFAULTS = {
    "bin_bp": 500,              # feature bins over the window when no peak regions are given
    "min_covered": 0.8,         # a read must cover this share of the feature regions to be assigned
    "batch": 1000,              # pool entries decoded per scan batch
    "max_scan": 50_000,         # pool entries scanned at most per request
    "radius_q": 0.5,            # find more: the radius is this quantile of the selection's own distances ...
    "radius_mult": 1.0,         # ... times this
    "k": 200,                   # find more: matches to find
    "count_unit": "observation",
}
SCAN_LOADER = dict(include_methylation=False, include_layers=False, include_layer_qualities=False)


def wilson(k: int, n: int, z: float = 1.959964) -> list:
    from services.differential import wilson as _wilson
    if n <= 0:
        return [0.0, 1.0]
    lo, hi = _wilson(int(k), int(n), z)
    return [round(float(lo), 6), round(float(hi), 6)]


def feature_regions(peak_regions, width: int, bin_bp: int) -> list:
    if peak_regions:
        out = [(max(0, int(a)), min(width, int(b))) for a, b in peak_regions if int(b) > int(a)]
        if out:
            return out
    step = max(1, int(bin_bp))
    return [(a, min(width, a + step)) for a in range(0, width, step)]


def read_features(row: dict, regions: list) -> tuple:
    """(footprint coverage per region 0..1, covered share per region 0..1) of a view read (window coordinates)."""
    feats = np.zeros(len(regions), np.float32)
    cover = np.zeros(len(regions), np.float32)
    ivs = row.get("intervals") or []
    if not ivs:
        return feats, cover
    span_lo = min(int(iv[0]) for iv in ivs)
    span_hi = max(int(iv[1]) for iv in ivs)
    fps = [(int(iv[0]), int(iv[1])) for iv in ivs if len(iv) > 2 and iv[2] is not None and iv[2] > 0]
    for j, (a, b) in enumerate(regions):
        lo, hi = max(a, span_lo), min(b, span_hi)
        if hi <= lo:
            continue
        cover[j] = (hi - lo) / (b - a)
        covered = sum(max(0, min(hi, fb) - max(lo, fa)) for fa, fb in fps)
        feats[j] = covered / (hi - lo)
    return feats, cover


def _distance(x, m, centroid) -> float:
    w = (m > 0).astype(np.float32)
    if w.sum() <= 0:
        return math.inf
    return float((((x - centroid) ** 2) * w).sum() / w.sum())


def _scan_loader() -> dict:
    """The read filters a refill / find-more scan decodes with: the display's, and the request's uncalled rule (3.0.6:
    uncalled reads are hidden by default and so never scanned or added; "All reads, including uncalled" scans them)."""
    return dict(SCAN_LOADER, hide_terminal_gaps=True, terminal_gap_threshold=500, hide_uncalled=mj._hide_uncalled())


def _view_rows(pool, dataset_ids) -> dict:
    return {d: mj._decode_view(pool, d, _scan_loader()) for d in dataset_ids}


def _scan(pool, opts: dict, accept: Callable, done: Callable[[], bool], cancelled: Optional[Callable] = None) -> dict:
    """Decode pool entries past the view (key order, datasets interleaved in batches) and call accept(d, e, row,
    x, m) for assignable ones; stops at done(), max_scan, pool end or cancel. -> scan counts."""
    scan_loader = _scan_loader()
    from services.meta_locus_decode import decode_entries_parallel
    in_view = {d: set(mj.view_entries(pool, d)) for d in pool.order}
    cursor = mj.view_cursor(pool)
    pos = {d: cursor.get(d, 0) for d in pool.order}
    counts = {"scanned": 0, "assignable": 0, "unassignable": 0, "filtered": 0, "molecules_scanned": set()}
    max_scan = int(opts["max_scan"])
    batch = max(50, int(opts["batch"]))
    regions = opts["_regions"]
    min_cov = float(opts["min_covered"])
    unit_molecule = opts.get("count_unit") == "molecule"
    while counts["scanned"] < max_scan and not done():
        progressed = False
        for d in pool.order:
            if done() or counts["scanned"] >= max_scan or (cancelled and cancelled()):
                break
            ix = pool.index_for(d)
            if ix is None:
                continue
            ranked = ix.ranked(pool.view_seed, scan_loader["hide_uncalled"])
            a = pos[d]
            if a >= len(ranked):
                continue
            ents = [int(e) for e in ranked[a:a + batch] if int(e) not in in_view[d]]
            pos[d] = min(len(ranked), a + batch)
            progressed = True
            decoded = decode_entries_parallel(pool.paths[d], ix, pool.sites, ents,
                                              loader_options=scan_loader,
                                              chrom_map=pool.chrom_map)
            for e in ents:
                counts["scanned"] += 1
                row = decoded.get(e)
                if row is None:
                    counts["filtered"] += 1
                    continue
                x, m = read_features(row, regions)
                if float(m.mean()) < min_cov:
                    counts["unassignable"] += 1
                    continue
                if unit_molecule:
                    key = (d, int(ix.mol[e]))
                    if key in counts["molecules_scanned"]:
                        continue
                    counts["molecules_scanned"].add(key)
                counts["assignable"] += 1
                accept(d, e, row, x, m)
                if done():
                    break
        if not progressed:
            break
    counts.pop("molecules_scanned")
    counts["exhausted"] = all(pos[d] >= len(pool.index_for(d)) for d in pool.order if pool.index_for(d) is not None)
    return counts


def refill(pool, body: dict, cancelled=None) -> dict:
    opts = {**REFILL_DEFAULTS, **{k: body[k] for k in REFILL_DEFAULTS if k in body}}
    width = 2 * pool.sites.flank
    regions = feature_regions(body.get("peak_regions"), width, int(opts["bin_bp"]))
    opts["_regions"] = regions
    assignments = {str(d): {str(r): int(c) for r, c in (v or {}).items()} for d, v in (body.get("assignments") or {}).items()}
    rows = _view_rows(pool, [d for d in pool.order if d in assignments])
    by_cluster: dict = {}
    in_view: dict = {}
    for d, drows in rows.items():
        for row in drows:
            c = assignments[d].get(str(row.get("id")))
            if c is None or c < 0:
                continue
            x, m = read_features(row, regions)
            in_view[c] = in_view.get(c, 0) + 1
            if float(m.mean()) >= float(opts["min_covered"]):
                by_cluster.setdefault(c, []).append(x)
    if not by_cluster:
        raise ValueError("No assignable reads of the clusters in view (the reads must cover the feature regions)")
    labels = sorted(by_cluster)
    centroids = np.stack([np.mean(by_cluster[c], axis=0) for c in labels])
    target = int(body.get("target_per_cluster") or max(in_view.values()))
    added = {c: 0 for c in labels}
    found = {c: 0 for c in labels}
    new_labels: dict = {}
    need = {c: max(0, target - in_view.get(c, 0)) for c in labels}

    def accept(d, e, row, x, m):
        w = (m > 0).astype(np.float32)
        dist = (((x[None, :] - centroids) ** 2) * w[None, :]).sum(1) / max(1.0, float(w.sum()))
        c = labels[int(np.argmin(dist))]
        found[c] += 1
        if added[c] < need[c]:
            added[c] += 1
            pool.view_extra.append((d, e))
            ix = pool.index_for(d)
            name = ix.names[int(ix.mol[e])]
            rid = f"{name}#site{int(ix.site[e])}" if bool(ix.shared[e]) else name
            new_labels.setdefault(d, {})[rid] = int(c)

    counts = _scan(pool, opts, accept, lambda: all(added[c] >= need[c] for c in labels), cancelled)
    if any(added.values()):
        pool.view_generation = next(mj._GENERATIONS)
        pool._decoded.clear()
    n = counts["assignable"]
    per = [{"cluster": int(c), "in_view": int(in_view.get(c, 0)), "added": int(added[c]), "found": int(found[c]),
            "scanned": int(n), "freq": round(found[c] / n, 6) if n else None, "wilson": wilson(found[c], n)} for c in labels]
    return {"success": True, "per_cluster": per, **counts, "unit": _unit(opts), "enriched": bool(pool.view_extra),
            "target_per_cluster": target, "assignments": new_labels, "view": mj.view_payload(pool)}


def find_more(pool, body: dict, cancelled=None) -> dict:
    opts = {**REFILL_DEFAULTS, **{k: body[k] for k in REFILL_DEFAULTS if k in body}}
    width = 2 * pool.sites.flank
    regions = feature_regions(body.get("peak_regions"), width, int(opts["bin_bp"]))
    opts["_regions"] = regions
    wanted = {str(d): {str(r) for r in (v or [])} for d, v in (body.get("read_ids") or {}).items()}
    rows = _view_rows(pool, [d for d in pool.order if d in wanted])
    xs = []
    for d, drows in rows.items():
        for row in drows:
            if str(row.get("id")) in wanted[d]:
                x, m = read_features(row, regions)
                if float(m.mean()) >= float(opts["min_covered"]):
                    xs.append((x, m))
    if not xs:
        raise ValueError("None of the selected reads covers the feature regions")
    centroid = np.mean([x for x, _ in xs], axis=0)
    spread = np.array([_distance(x, m, centroid) for x, m in xs])
    radius = max(float(np.quantile(spread, float(opts["radius_q"]))) * float(opts["radius_mult"]), 1e-3)
    k = int(opts["k"])
    state = {"found": 0, "added": 0}

    def accept(d, e, row, x, m):
        if _distance(x, m, centroid) <= radius:
            state["found"] += 1
            state["added"] += 1
            pool.view_extra.append((d, e))

    counts = _scan(pool, opts, accept, lambda: state["found"] >= k, cancelled)
    if state["added"]:
        pool.view_generation = next(mj._GENERATIONS)
        pool._decoded.clear()
    n = counts["assignable"]
    return {"success": True, "found": state["found"], "added": state["added"], **counts,
            "freq": round(state["found"] / n, 6) if n else None, "wilson": wilson(state["found"], n),
            "radius": round(radius, 6), "template_reads": len(xs), "unit": _unit(opts), "enriched": bool(pool.view_extra),
            "view": mj.view_payload(pool)}


def _unit(opts) -> str:
    return "molecules" if opts.get("count_unit") == "molecule" else "read-site observations"
