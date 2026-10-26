"""Peak scanning on graph node columns (graph features, item 3; DESIGN_GRAPH_PRIMARY §2.5 "scanning peaks over the
graph read source").

A window of the target is laid out as its node columns (services/graph_panel/columns.py, from the same fixed tiles
as graph clustering): the target walk's columns, plus each non-target node run (an insertion some paths carry) on
its canonical frame. Every observation of the run (a lifted dataset's path, read on its own coordinates; a native
dataset on the target, by identity) adds its per-base scan counts to the columns it carries, so the signal at a
column pools every haplotype that carries it. The linear scanner's detection (smoothing, tiers, widths) then runs on
the target walk and on each insertion's frame.

Peaks on the target walk are target spans, as linear peaks are, and feed Cluster unchanged. A peak inside an
insertion is reported as the insertion's region: its anchor on the target widened to a span that holds it, so a
Cluster run at that region clusters on the inserted columns (carrier-only features, refined within carriers).
"""
from __future__ import annotations

import asyncio
import time
from typing import Optional

import numpy as np

from services.graph_panel import columns as gc
from services.graph_panel.analysis import GraphRunError, GraphSource, fetch_tiles, graph_window_rows, needed_tiles, parse

# An insertion peak's region reaches this far onto the target on each side of its anchor (a span that holds the
# insertion's node run, so Cluster sees its columns).
INSERTION_PAD_BP = 20


def _settings(body: dict):
    from models.requests import ScanPeaksRequest
    raw = body.get("scan") or {}
    if not isinstance(raw, dict):
        raise GraphRunError("scan must be an object of peak scan settings")
    try:
        return ScanPeaksRequest(**{k: v for k, v in raw.items() if k not in ("dataset_ids", "read_ids", "read_ids_by_dataset")})
    except Exception as exc:  # noqa: BLE001 - pydantic validation
        raise GraphRunError(f"scan settings: {exc}") from None


def _add_block_counts(dest_num, dest_tot, src_num, src_tot, src_start, u0, u1, g0, g1, rev):
    """Add a path's counts at path positions [g0, g1) to frame positions [u0, u1) (reversed blocks run backwards)."""
    n = u1 - u0
    if n <= 0:
        return
    if rev:
        idx = np.arange(g1 - 1, g1 - 1 - n, -1) - src_start
    else:
        idx = np.arange(g0, g0 + n) - src_start
    ok = (idx >= 0) & (idx < len(src_num))
    if not ok.any():
        return
    us = np.arange(u0, u1)[ok]
    dest_num[us] += src_num[idx[ok]]
    dest_tot[us] += src_tot[idx[ok]]


def _detect(num, tot, n_reads, req):
    from services.peak_scanning import (DEFAULT_MAX_PEAK_WIDTH, build_peak_thresholds, detect_threshold_layers,
                                        scan_signal_from_counts, smooth_scan_signal)
    if not len(num) or not n_reads:
        return [], [], np.zeros(len(num), dtype=np.float32)
    smooth = max(req.smooth_width, req.min_width)
    signal = smooth_scan_signal(scan_signal_from_counts(num, tot), smooth)
    thresholds = build_peak_thresholds(req.threshold_strong, req.threshold_medium, req.threshold_weak,
                                       req.threshold_rare, req.min_reads, n_reads)
    broad: list = []
    peaks, info = detect_threshold_layers(signal, tot, thresholds, req.min_width, req.min_reads, smooth,
                                          max_width=getattr(req, "max_peak_width", DEFAULT_MAX_PEAK_WIDTH), broad_out=broad)
    return peaks, info, signal


def scan(state, reg, body: dict, tiles: dict, spec: dict) -> dict:
    """The scan's work (a worker thread): counts per column, pooled over the observations, then peaks."""
    from services.peak_scanning import compute_scan_counts, downsample_signal_for_response, is_read_signal_source
    t0 = time.perf_counter()
    req = _settings(body)
    source = req.signal_source or "accessibility"
    if not is_read_signal_source(source):
        raise GraphRunError(f"Graph peak scanning reads the reads' own calls; {source!r} is not one of them")
    window = spec["regions"][0]
    start, end = window["start"], window["end"]
    length = end - start
    target = spec["target"]
    observations = [gc.Observation(o["id"], o["binding"]) for o in spec["observations"]]
    cells = gc.cells_for(start, end)
    all_results = [res for per in tiles.values() for c, res in per.items() if c in cells]
    target_occs = gc.merge_occurrences(all_results, target)
    path_occs, cell_results = {}, {}
    for src, per in tiles.items():
        if src is None:
            continue
        path_occs[src] = gc.merge_occurrences([per[c] for c in cells if c in per], src)
        cell_results[src] = {c: per[c] for c in cells if c in per}
    cols = gc.region_columns(0, start, end, target, target_occs, observations, path_occs, cell_results,
                             insertions=True, binding_order=spec.get("binding_order"))
    insertions = [f for f in cols.features if f.kind == "insertion"]
    t_num, t_tot = np.zeros(length, dtype=np.int64), np.zeros(length, dtype=np.int64)
    i_counts = [(np.zeros(f.length, dtype=np.int64), np.zeros(f.length, dtype=np.int64)) for f in insertions]
    reads_by_obs: dict = {}
    cache: dict = {}
    loaded: list = []
    from services.read_selection import read_matches_id_filter, with_graph_record_keys
    from services.read_strand import filter_reads_by_strand, strand_calls
    for ob in spec["observations"]:
        oid = ob["id"]
        carried = cols.carried.get(oid) or {}
        if ob["kind"] == "graph":
            spans = [g for g, _r in carried.values()]
            for f in insertions:
                for _u0, _u1, g0, g1, _rev in f.blocks.get(oid) or ():
                    spans += [g0, g1 - 1]
            if not spans:
                reads_by_obs[oid] = 0
                continue
            a, b = min(spans), max(spans) + 1
            rows, _desc = graph_window_rows(state, GraphSource(ob["dataset_id"], ob["binding"], ob["contig"]), a, b, cache)
            origin = a
        else:
            from services.analysis_query import AnalysisReadQuery
            query = AnalysisReadQuery.from_request(state, chrom=ob["chrom"], start=start, end=end, dataset_ids=[ob["dataset_id"]],
                                                   include_methylation=True, include_layers=True, capability="graph_peaks",
                                                   **({"lift_hap_by_dataset": {ob["dataset_id"]: ob["lift_hap"]}} if ob.get("lift_hap") else {}))
            rows = query.build_working_set(state, ob["dataset_id"]).reads
            origin, a, b = start, start, end
        if ob.get("read_ids") is not None:
            wanted = with_graph_record_keys(ob["read_ids"])
            rows = [r for r in rows if read_matches_id_filter(r, wanted)]
        if ob.get("strand"):
            rows = filter_reads_by_strand(rows, ob["strand"], strand_calls(state, ob["dataset_id"]))
        loaded.append((ob, rows, origin, a, b, carried))
    # One row per folded molecule of a dataset (fold_molecule: one analysis_id on two paths), as graph clustering
    # arbitrates it: among its rows that overlap their observation's usable columns (a row inside an excluded repeat
    # never displaces one that counts), the primary record's, then the most usable bases, then more body bases, then
    # the observation id (Codex review, group B).
    from services.lift.cohort import folded_identity
    from services.read_selection import read_body_spans

    def runs(points):
        pts = sorted(set(points))
        out, lo, prev = [], None, None
        for p in pts:
            if lo is None:
                lo = prev = p
            elif p == prev + 1:
                prev = p
            else:
                out.append((lo, prev + 1)); lo = prev = p
        if lo is not None:
            out.append((lo, prev + 1))
        return out

    usable: dict = {}
    for ob, rows, origin, a, b, carried in loaded:
        pts = [g - origin for g, _rev in carried.values()] if ob["kind"] == "graph" else list(carried.keys())
        if ob["kind"] == "graph":
            for f in insertions:
                for _u0, _u1, g0, g1, _rev in f.blocks.get(ob["id"]) or ():
                    pts.extend(range(g0 - origin, g1 - origin))
        usable[ob["id"]] = runs(pts)

    def usable_overlap(oid, r):
        return sum(max(0, min(y, v) - max(x, u)) for x, y in read_body_spans(r) for u, v in usable[oid])

    folded_best: dict = {}
    for ob, rows, *_rest in loaded:
        for r in rows:
            aid = r.get("analysis_id")
            if not folded_identity(aid):
                continue
            over = usable_overlap(ob["id"], r)
            sup = bool(((r.get("live_lift") or {}).get("source") or {}).get("supplementary"))
            rank = (over == 0, sup, -over, -sum(y - x for x, y in read_body_spans(r)), ob["id"])
            key = (ob["dataset_id"], aid)
            if key not in folded_best or rank < folded_best[key][0]:
                folded_best[key] = (rank, id(r))
    keep = {v[1] for v in folded_best.values()}
    loaded = [(ob, [r for r in rows if not folded_identity(r.get("analysis_id")) or id(r) in keep], *rest)
              for ob, rows, *rest in loaded]
    # Molecules shared by datasets: the datasets' joint policy (joint_dedup by_molecule keeps one row), as graph
    # clustering's joint cohort applies it.
    # One row per (dataset, row identity) across observations: a pooled panel and a haplotype or strand panel of the
    # same dataset overlap (agy review, group B).
    # A lifted row is named by its cohort identity; a native row by its record (library, QNAME, digest, occurrence,
    # bounds), never by its QNAME alone: distinct records sharing a QNAME both count (Codex review, group G). Rows of
    # one observation are distinct records; only repeats across observations are dropped.
    from services.lift.cohort import _IDENTITY_PREFIX

    def row_key(r):
        aid = r.get("analysis_id")
        if isinstance(aid, str) and aid.startswith(_IDENTITY_PREFIX):
            return ("lifted", aid)
        return ("native", r.get("library_id"), r.get("id"), r.get("record_sha256"), r.get("alignment_occurrence"),
                r.get("reference_start", r.get("start")), r.get("reference_end", r.get("end")), r.get("alignment_orientation"))

    seen_rows: set = set()
    deduped = []
    for ob, rows, *rest in loaded:
        keys = [(ob["dataset_id"], row_key(r)) for r in rows]
        mine = [r for r, key in zip(rows, keys) if key not in seen_rows]
        seen_rows.update(keys)
        deduped.append((ob, mine, *rest))
    loaded = deduped
    dataset_ids = sorted({ob["dataset_id"] for ob, *_r in loaded})
    if len(dataset_ids) > 1:
        from services.lift.joint import prepare_joint_cohort
        tagged = [{**r, "_consensus_dataset_id": ob["dataset_id"], "_scan_row": id(r)} for ob, rows, *_r in loaded for r in rows]
        kept_rows, _joint = prepare_joint_cohort(state, tagged, dataset_ids)
        retained = {r["_scan_row"] for r in kept_rows}
        loaded = [(ob, [r for r in rows if id(r) in retained], *rest) for ob, rows, *rest in loaded]
    for ob, rows, origin, a, b, carried in loaded:
        oid = ob["id"]
        reads_by_obs[oid] = len(rows)
        if not rows:
            continue
        num, tot = compute_scan_counts(rows, source, b - a)
        num, tot = num.astype(np.int64), tot.astype(np.int64)
        if ob["kind"] == "graph":
            us = np.fromiter(carried.keys(), dtype=np.int64, count=len(carried))
            gs = np.fromiter((g for g, _r in carried.values()), dtype=np.int64, count=len(carried)) - origin
            ok = (gs >= 0) & (gs < len(num))
            np.add.at(t_num, us[ok], num[gs[ok]])
            np.add.at(t_tot, us[ok], tot[gs[ok]])
            for f, (fn, ft) in zip(insertions, i_counts):
                for u0, u1, g0, g1, rev in f.blocks.get(oid) or ():
                    _add_block_counts(fn, ft, num, tot, origin, u0, u1, g0, g1, rev)
        else:
            us = np.fromiter(carried.keys(), dtype=np.int64, count=len(carried))
            np.add.at(t_num, us, num[us])
            np.add.at(t_tot, us, tot[us])
    n_reads = sum(reads_by_obs.values())
    peaks_t, info, signal = _detect(t_num, t_tot, n_reads, req)
    peaks: list = []
    for p in peaks_t:
        peaks.append({"start": start + p["start"], "end": start + p["end"], "layer": p["layer"], "score": p["score"],
                      "threshold": p["threshold"], "width": p["end"] - p["start"], "graph": {"kind": "target"}})
    inserted = []
    for f, (fn, ft) in zip(insertions, i_counts):
        if not ft.any():
            continue
        found, _info, _sig = _detect(fn, ft, n_reads, req)
        if not found:
            continue
        best = max(found, key=lambda p: (p["score"], -p["layer"]))
        lo, hi = f.anchor if f.anchor else (start, start)
        region = (max(start, lo - INSERTION_PAD_BP), min(end, max(hi, lo) + INSERTION_PAD_BP))
        inserted.append({"start": region[0], "end": region[1], "layer": min(p["layer"] for p in found),
                         "score": best["score"], "threshold": best["threshold"], "width": region[1] - region[0],
                         "graph": {"kind": "insertion", "label": f.label, "length": f.length, "carriers": list(f.carriers),
                                   "frame_peaks": [[int(p["start"]), int(p["end"])] for p in found]}})
    # An insertion's region that meets a target peak joins it (Cluster regions never overlap).
    for ins in inserted:
        hit = [p for p in peaks if p["start"] < ins["end"] and p["end"] > ins["start"]]
        if not hit:
            peaks.append(ins)
            continue
        for p in hit:
            p["start"], p["end"] = min(p["start"], ins["start"]), max(p["end"], ins["end"])
            p["width"] = p["end"] - p["start"]
            p["graph"] = {**ins["graph"], "kind": "target+insertion"}
    peaks.sort(key=lambda p: (p["start"], p["end"]))
    merged: list = []
    for p in peaks:
        if merged and p["start"] < merged[-1]["end"]:
            q = merged[-1]
            q["end"] = max(q["end"], p["end"])
            q["width"] = q["end"] - q["start"]
            q["score"] = max(q["score"], p["score"])
            q["layer"] = min(q["layer"], p["layer"])
            continue
        merged.append(p)
    for i, p in enumerate(merged):
        p["index"] = i
    unresolved = int(sum(1 for w in cols.walk if not w))
    out = {
        "peaks": merged, "layer_info": info, "n_reads": n_reads, "mode": "Graph columns",
        "columns": {"target_bp": length, "target_unresolved_bp": unresolved,
                    "insertions": [{"label": f.label, "length": f.length, "carriers": list(f.carriers),
                                    "anchor": list(f.anchor) if f.anchor else None} for f in insertions],
                    "observations": {o["id"]: reads_by_obs.get(o["id"], 0) for o in spec["observations"]},
                    "report": {k: v for k, v in cols.report.items() if v}},
        "server_elapsed_ms": round((time.perf_counter() - t0) * 1000, 1),
    }
    if req.return_signal and len(signal):
        out["signal"] = downsample_signal_for_response(signal, req.signal_bins)
    return out


async def handle(state, reg, body: dict) -> dict:
    """The route's work: the window's tiles on the event loop (the helper pool), the scan in a worker thread."""
    window = body.get("window") or {}
    if not isinstance(window, dict):
        raise GraphRunError("window must be {start, end}")
    spec = parse(state, reg, {**body, "regions": [{"start": window.get("start"), "end": window.get("end")}]})
    sources, cells = needed_tiles(spec)
    started = time.perf_counter()
    tiles = await fetch_tiles(reg, spec["target"], sources, cells)
    tiles_ms = round((time.perf_counter() - started) * 1000, 1)
    out = await asyncio.to_thread(scan, state, reg, body, tiles, spec)
    out["tiles_ms"] = tiles_ms
    return out
