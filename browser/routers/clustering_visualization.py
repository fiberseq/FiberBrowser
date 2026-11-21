"""Cluster visualization endpoints."""
from __future__ import annotations

from typing import Dict

import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Query

from models.requests import ClusterVPlotRequest
from services.analysis_query import AnalysisReadQuery
from services.vplot_matrix import (
    VPLOT_MODES, VPLOT_NORMALIZATIONS, accumulate_vplot, finish_vplot, footprint_arrays, legacy_sigmas_bp, sigma_bins,
)
from state.dependencies import get_state

router = APIRouter(tags=["clustering"])

# The cluster key of a dataset's all-reads matrix (group_by="all").
ALL_READS_KEY = -1
# group_by="pooled": every named dataset's reads summed into one matrix, answered under this key (cluster key -1).
POOLED_KEY = "__pooled__"


# Every footprint of a read: the footprint layers together, Nuc + TF, each footprint counted once. A read
# without a Nuc layer uses its calls instead (nucleosome-sized in FiberHMM output). The footprint size plots'
# default source.
ALL_FOOTPRINTS = "all_footprints"


def _all_footprint_intervals(read: dict):
    seen = set()
    out = []
    layers = read.get('layers') or {}
    nuc_layer = layers.get('nuc')
    nuc = (nuc_layer.get('intervals') or []) if nuc_layer else (read.get('intervals') or [])
    tf = (layers.get('tf') or {}).get('intervals') or []
    for iv in list(nuc) + list(tf):
        if iv is None or len(iv) < 3:
            continue
        key = (int(iv[0]), int(iv[1]))
        if key in seen:
            continue
        seen.add(key)
        out.append(iv)
    return out


def _pick_vplot_intervals(read: dict, target_layer: str | None):
    """Resolve V-plot interval source, keeping FIRE user-facing.

    MSP is the internal storage key for older accessibility layers. Public UI
    and Python calls should be able to request `fire` and get the same data.
    """
    if target_layer == ALL_FOOTPRINTS:
        return _all_footprint_intervals(read)
    if target_layer:
        layers = read.get('layers') or {}
        layer_data = layers.get(target_layer)
        if not layer_data and target_layer == "fire":
            layer_data = layers.get("msp")
        elif not layer_data and target_layer == "msp":
            layer_data = layers.get("fire")
        if layer_data:
            return layer_data.get('intervals') or []
        if target_layer in {"fire", "msp"}:
            return read.get("fire") or []
        return []
    return read.get('intervals') or []


@router.post("/api/cluster/vplot")
async def cluster_vplot(
    chrom: str = Query(...),
    region_start: int = Query(...),
    region_end: int = Query(...),
    request: ClusterVPlotRequest = None,
    state=Depends(get_state)):
    """Compute V-plot / footprint size enrichment matrices for the viewport region.

    Per (dataset, cluster) by default; with ``group_by="all"`` one matrix per
    dataset from all of its reads (key -1), no clustering needed.
    """
    if request is None:
        request = ClusterVPlotRequest()

    # Named datasets: live-lifted ones are left out, as the implicit all-datasets scope leaves them out
    # (this analysis does not read lifted rows yet); one lifted panel never fails the others' plots.
    named_ids = None
    if request.dataset_ids:
        from services.lift.capability import is_lifted
        datasets = getattr(state, "datasets", {}) or {}
        named_ids = [d for d in request.dataset_ids if not is_lifted(datasets.get(d))]
        if not named_ids:
            return {"success": True, "data": {}, "sample_seed": request.sample_seed}

    query = AnalysisReadQuery.from_request(
        state,
        chrom=chrom,
        start=region_start,
        end=region_end,
        spanning=False,
        sample_seed=request.sample_seed,
        include_methylation=False,
        include_layers=bool(request.layer),
        requested_layers=(["nuc", "tf"] if request.layer == ALL_FOOTPRINTS else [request.layer]) if request.layer else None,
        dataset_ids=named_ids,
    )
    sample_seed = query.sample_seed
    size_min = request.size_min
    size_max = request.size_max
    size_bin = request.size_bin
    pos_bin = request.pos_bin
    region_len = region_end - region_start
    n_size_bins = (size_max - size_min) // size_bin
    n_pos_bins = region_len // pos_bin
    if n_size_bins <= 0 or n_pos_bins <= 0:
        return {"success": False, "error": "Invalid bin parameters"}
    # A public server's cell limit, whatever reached this route (no-op locally).
    from services.public_limits import AllocationTooLarge, check_public_allocation
    try:
        check_public_allocation(vplot_cells_=n_size_bins * n_pos_bins)
    except AllocationTooLarge as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc

    target_layer = request.layer
    normalize_mode = request.normalize if request.normalize in ("per_cluster", "shared") else "per_cluster"
    mode = request.mode if request.mode in VPLOT_MODES else "midpoint"
    row_normalize = bool(request.row_normalize)
    row_min_footprints = max(0, int(request.row_min_footprints))
    group_pooled = request.group_by == "pooled"
    group_all = request.group_by in ("all", "pooled")
    raw_values = bool(request.raw_values) or group_pooled
    # Pooled: raw sums across datasets (counts add exactly), finished once after the loop.
    pooled_acc: dict = {"matrix": None, "row": None, "col": None, "n_reads": 0}
    normalization = request.normalization if request.normalization in VPLOT_NORMALIZATIONS else (
        "row" if row_normalize else "raw")
    if request.sigma_size_bp is None and request.sigma_pos_bp is None:
        sigma_size_bp, sigma_pos_bp = legacy_sigmas_bp(request.smooth, size_bin, pos_bin)
    else:
        sigma_size_bp, sigma_pos_bp = float(request.sigma_size_bp or 0), float(request.sigma_pos_bp or 0)
    s_size_bins, s_pos_bins = sigma_bins(sigma_size_bp, size_bin), sigma_bins(sigma_pos_bp, pos_bin)

    assignment_overrides = request.cluster_assignments or {}
    result = {}
    # The box mean's bootstrap (Plots summaries): per-read raw counts, resampled (services/box_bootstrap).
    bb = request.box_bootstrap if isinstance(request.box_bootstrap, dict) else None
    from services.box_bootstrap import UnitCounts, box_bootstrap, box_indices
    box = box_indices(size_min, size_bin, n_size_bins, region_start, pos_bin, n_pos_bins, float(bb.get("size_from") or 0), float(bb.get("size_to") or 1e9),
                      None if bb.get("pos_from") is None else float(bb["pos_from"]), None if bb.get("pos_to") is None else float(bb["pos_to"])) if bb else None
    boot_kw = dict(normalization=normalization, log=False, sigma_bins_size=s_size_bins, sigma_bins_pos=s_pos_bins, row_min_footprints=row_min_footprints) if bb else None
    boot_resamples = max(50, min(10000, int((bb or {}).get("resamples") or 1000)))
    boot_seed = int((bb or {}).get("seed") or 1)
    boot_tf = str((bb or {}).get("transform") or "none")
    pooled_units = UnitCounts(n_size_bins, n_pos_bins) if bb and group_pooled else None

    def read_units(into, ds_id, reads, offset):
        for read in reads:
            s1, e1, z1 = footprint_arrays(_pick_vplot_intervals(read, target_layer), offset)
            rc, cc = np.zeros(n_size_bins, dtype=np.int64), np.zeros(n_pos_bins, dtype=np.int64)
            m = accumulate_vplot(s1, e1, z1, size_min=size_min, size_bin=size_bin, n_size_bins=n_size_bins, pos_bin=pos_bin, n_pos_bins=n_pos_bins,
                                 mode=mode, row_counts=rc, col_counts=cc)
            into.add(f"{ds_id}:{read.get('id')}", m, rc, cc)
    # Every matrix is kept for the answer: on a public server each dataset's
    # clusters, and the cells of all matrices together, are bounded.
    kept_matrices = 0
    for ds_id in query.dataset_ids:
        dataset = state.get_dataset(ds_id)
        # Prefer the frontend's active-branch assignments over the backend's
        # stored map so the V-plot reflects the branch currently shown in the UI.
        assigns = assignment_overrides.get(ds_id) or (dataset.cluster_assignments if dataset else None)
        if not dataset or (not assigns and not group_all):
            continue
        try:
            ws = query.build_working_set(state, ds_id)
            ws_reads = list(ws.reads)
            if request.sample_n:
                # Plots' Random N reads: the stable sampling rule over the dataset's reads in view.
                from services.stable_sample import lowest_k, stable_key
                ws_reads = lowest_k(ws_reads, int(request.sample_n), key=lambda r: stable_key(int(request.sample_seed_int), ds_id, str(r.get('id'))),
                                    ident=lambda r: str(r.get('id')))
            cluster_reads: dict = {}
            if group_all:
                cluster_reads[ALL_READS_KEY] = ws_reads
            else:
                for read in ws_reads:
                    cluster = assigns.get(read['id'])
                    if cluster is not None:
                        cluster_reads.setdefault(cluster, []).append(read)

            kept_matrices += len(cluster_reads)
            check_public_allocation(vplot_cells_=n_size_bins * n_pos_bins * kept_matrices,
                                    clusters=len(cluster_reads))

            raw_matrices: Dict[int, np.ndarray] = {}
            counts: Dict[int, dict] = {}
            for cluster_id, reads in cluster_reads.items():
                starts, ends, sizes = [], [], []
                for read in reads:
                    s_arr, e_arr, z_arr = footprint_arrays(_pick_vplot_intervals(read, target_layer), ws.start - region_start)
                    starts.append(s_arr); ends.append(e_arr); sizes.append(z_arr)
                row_counts = np.zeros(n_size_bins, dtype=np.int64)
                col_counts = np.zeros(n_pos_bins, dtype=np.int64)
                vp_matrix = accumulate_vplot(
                    np.concatenate(starts) if starts else np.zeros(0, dtype=np.int64),
                    np.concatenate(ends) if ends else np.zeros(0, dtype=np.int64),
                    np.concatenate(sizes) if sizes else np.zeros(0, dtype=np.int64),
                    size_min=size_min, size_bin=size_bin, n_size_bins=n_size_bins,
                    pos_bin=pos_bin, n_pos_bins=n_pos_bins, mode=mode, row_counts=row_counts,
                    col_counts=col_counts,
                )
                if bb:
                    uc = pooled_units if group_pooled else UnitCounts(n_size_bins, n_pos_bins)
                    read_units(uc, ds_id, reads, ws.start - region_start)
                    if not group_pooled:
                        lo, hi, nu = box_bootstrap(uc, seed=boot_seed, resamples=boot_resamples, finish_kw=boot_kw, box=box, transform=boot_tf)
                        boot_ci = {"lo": lo, "hi": hi, "units": nu}
                if group_pooled:
                    acc = pooled_acc
                    acc["matrix"] = vp_matrix.astype(np.float64) if acc["matrix"] is None else acc["matrix"] + vp_matrix
                    acc["row"] = row_counts.copy() if acc["row"] is None else acc["row"] + row_counts
                    acc["col"] = col_counts.copy() if acc["col"] is None else acc["col"] + col_counts
                    acc["n_reads"] += len(reads)
                    continue
                raw_matrices[int(cluster_id)] = finish_vplot(
                    vp_matrix, normalization=normalization, log=request.log_norm and not raw_values,
                    sigma_bins_size=s_size_bins, sigma_bins_pos=s_pos_bins,
                    row_counts=row_counts, col_counts=col_counts, row_min_footprints=row_min_footprints,
                    blank=float("nan") if raw_values else 0.0,
                )
                counts[int(cluster_id)] = {"n_reads": len(reads), "n_footprints": int(row_counts.sum()), **({"box_ci": boot_ci} if bb else {})}

            if group_pooled:
                continue
            if raw_values:
                result[ds_id] = {
                    int(cluster_id): {
                        'matrix': [[None if not np.isfinite(x) else round(float(x), 6) for x in row] for row in vp_matrix],
                        'size_min': size_min,
                        'size_max': size_max,
                        'size_bin': size_bin,
                        'pos_bin': pos_bin,
                        'mode': mode,
                        'normalization': normalization,
                        'row_normalize': normalization == "row",
                        'row_min_footprints': row_min_footprints,
                        'sigma_size_bp': sigma_size_bp,
                        'sigma_pos_bp': sigma_pos_bp,
                        'raw_values': True,
                        'group_by': "all" if group_all else "cluster",
                        'layer': target_layer,
                        **counts[int(cluster_id)],
                    }
                    for cluster_id, vp_matrix in raw_matrices.items()
                }
                continue

            global_max = 1.0
            if normalize_mode == "shared" and raw_matrices:
                gm = max((m.max() for m in raw_matrices.values()), default=0)
                if gm > 0:
                    global_max = float(gm)

            ds_result = {}
            for cluster_id, vp_matrix in raw_matrices.items():
                if normalize_mode == "shared":
                    denom = global_max
                else:
                    denom = float(vp_matrix.max()) if vp_matrix.max() > 0 else 1.0
                ds_result[int(cluster_id)] = {
                    'matrix': [[float(x / denom) for x in row] for row in vp_matrix],
                    'size_min': size_min,
                    'size_max': size_max,
                    'size_bin': size_bin,
                    'pos_bin': pos_bin,
                    'normalize': normalize_mode,
                    'mode': mode,
                    'row_normalize': row_normalize,
                    'row_min_footprints': row_min_footprints if row_normalize else None,
                    'layer': target_layer,
                }
            result[ds_id] = ds_result
        except AllocationTooLarge as exc:
            raise HTTPException(status_code=413, detail=str(exc)) from exc
        except Exception as e:
            result[ds_id] = {'error': str(e)}

    if group_pooled and pooled_acc["matrix"] is not None:
        pooled = finish_vplot(
            pooled_acc["matrix"], normalization=normalization, log=False,
            sigma_bins_size=s_size_bins, sigma_bins_pos=s_pos_bins,
            row_counts=pooled_acc["row"], col_counts=pooled_acc["col"], row_min_footprints=row_min_footprints,
            blank=float("nan"),
        )
        result[POOLED_KEY] = {ALL_READS_KEY: {
            'matrix': [[None if not np.isfinite(x) else round(float(x), 6) for x in row] for row in pooled],
            'size_min': size_min, 'size_max': size_max, 'size_bin': size_bin, 'pos_bin': pos_bin, 'mode': mode,
            'normalization': normalization, 'row_normalize': normalization == "row", 'row_min_footprints': row_min_footprints,
            'sigma_size_bp': sigma_size_bp, 'sigma_pos_bp': sigma_pos_bp, 'raw_values': True, 'group_by': "pooled",
            'layer': target_layer, 'n_reads': int(pooled_acc["n_reads"]), 'n_footprints': int(pooled_acc["row"].sum()),
            'dataset_ids': [d for d in query.dataset_ids],
            **({'box_ci': dict(zip(("lo", "hi", "units"), box_bootstrap(pooled_units, seed=boot_seed, resamples=boot_resamples, finish_kw=boot_kw, box=box, transform=boot_tf)))} if bb and pooled_units else {}),
        }}

    return {"success": True, "data": result, "sample_seed": sample_seed}
