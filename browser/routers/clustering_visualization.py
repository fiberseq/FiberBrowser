"""Cluster visualization endpoints."""
from __future__ import annotations

from typing import Dict

import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Query

from models.requests import ClusterVPlotRequest
from services.analysis_query import AnalysisReadQuery
from services.vplot_matrix import VPLOT_MODES, accumulate_vplot, finish_vplot, footprint_arrays
from state.dependencies import get_state

router = APIRouter(tags=["clustering"])


def _pick_vplot_intervals(read: dict, target_layer: str | None):
    """Resolve V-plot interval source, keeping FIRE user-facing.

    MSP is the internal storage key for older accessibility layers. Public UI
    and Python calls should be able to request `fire` and get the same data.
    """
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
    """Compute V-plot matrices per (dataset, cluster) for the viewport region."""
    if request is None:
        request = ClusterVPlotRequest()

    query = AnalysisReadQuery.from_request(
        state,
        chrom=chrom,
        start=region_start,
        end=region_end,
        spanning=False,
        sample_seed=request.sample_seed,
        include_methylation=False,
        include_layers=bool(request.layer),
        requested_layers=[request.layer] if request.layer else None,
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

    assignment_overrides = request.cluster_assignments or {}
    result = {}
    # Every matrix is kept for the answer: on a public server each dataset's
    # clusters, and the cells of all matrices together, are bounded.
    kept_matrices = 0
    for ds_id in query.dataset_ids:
        dataset = state.get_dataset(ds_id)
        # Prefer the frontend's active-branch assignments over the backend's
        # stored map so the V-plot reflects the branch currently shown in the UI.
        assigns = assignment_overrides.get(ds_id) or (dataset.cluster_assignments if dataset else None)
        if not dataset or not assigns:
            continue
        try:
            ws = query.build_working_set(state, ds_id)
            cluster_reads: dict = {}
            for read in ws.reads:
                cluster = assigns.get(read['id'])
                if cluster is not None:
                    cluster_reads.setdefault(cluster, []).append(read)

            kept_matrices += len(cluster_reads)
            check_public_allocation(vplot_cells_=n_size_bins * n_pos_bins * kept_matrices,
                                    clusters=len(cluster_reads))

            raw_matrices: Dict[int, np.ndarray] = {}
            for cluster_id, reads in cluster_reads.items():
                starts, ends, sizes = [], [], []
                for read in reads:
                    s_arr, e_arr, z_arr = footprint_arrays(_pick_vplot_intervals(read, target_layer), ws.start - region_start)
                    starts.append(s_arr); ends.append(e_arr); sizes.append(z_arr)
                row_counts = np.zeros(n_size_bins, dtype=np.int64)
                vp_matrix = accumulate_vplot(
                    np.concatenate(starts) if starts else np.zeros(0, dtype=np.int64),
                    np.concatenate(ends) if ends else np.zeros(0, dtype=np.int64),
                    np.concatenate(sizes) if sizes else np.zeros(0, dtype=np.int64),
                    size_min=size_min, size_bin=size_bin, n_size_bins=n_size_bins,
                    pos_bin=pos_bin, n_pos_bins=n_pos_bins, mode=mode, row_counts=row_counts,
                )
                raw_matrices[int(cluster_id)] = finish_vplot(
                    vp_matrix, smooth=request.smooth, row_normalize=row_normalize, log=request.log_norm,
                    row_counts=row_counts, row_min_footprints=row_min_footprints,
                )

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

    return {"success": True, "data": result, "sample_seed": sample_seed}
