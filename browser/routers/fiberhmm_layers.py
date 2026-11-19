"""FiberHMM variant-allele and structural-event layers (services/fiberhmm_variant_layers.py).

The Variants panel and the SV split reach these layers through their own
endpoints (variants.py, sv.py); these routes serve the read rows' overlay
(toggled on per dataset, so nothing is read until asked) and the lift of the
layers through a UCSC chain.
"""
from __future__ import annotations

import asyncio
import os
from typing import Optional

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse

from state.dependencies import get_state
from utils.request_body import json_object_body
from utils.responses import ORJSONResponse

router = APIRouter(tags=["reads"])


def _dataset(state, dataset_id: str):
    dataset = state.get_dataset(dataset_id) if dataset_id else None
    if dataset is None:
        return None, JSONResponse({"detail": f"Dataset '{dataset_id}' not found"}, status_code=404)
    return dataset, None


@router.get("/api/fiberhmm_layers/info")
async def fiberhmm_layers_info(dataset_id: str = Query(...), state=Depends(get_state)):
    """Which variant layers a dataset has, their files, the source VCF named in the var layer, and the lift."""
    from services import fiberhmm_variant_layers as fvl
    dataset, error = _dataset(state, dataset_id)
    if error:
        return error
    var_paths = fvl.layer_paths(dataset, fvl.VAR_LAYER)
    lift = getattr(dataset, "fiberhmm_variant_lift", None)
    return {
        "dataset_id": dataset_id,
        "var": bool(var_paths), "sv": fvl.has_layer(dataset, fvl.SV_LAYER),
        "var_paths": var_paths, "sv_paths": fvl.layer_paths(dataset, fvl.SV_LAYER),
        "vcf": next((fvl.source_vcf_name(p) for p in var_paths if fvl.source_vcf_name(p)), None),
        "vcf_sample": next((fvl.source_vcf_sample(p) for p in var_paths if fvl.source_vcf_sample(p)), None),
        "lift": getattr(lift, "path", None),
    }


@router.get("/api/fiberhmm_layers/reads")
async def fiberhmm_layers_reads(
    dataset_id: str = Query(...), chrom: str = Query(...), start: int = Query(...), end: int = Query(...),
    layers: str = Query("sv,var", description="comma list: sv, var"),
    min_sv_len: int = Query(50), min_mapq: int = Query(0), hide_supplementary: bool = Query(False),
    link_split: bool = Query(True),
    include_qcfail: bool = Query(False, description="Show QC-fail reads (as the read track)"),
    include_duplicates: bool = Query(False, description="Show duplicate reads (as the read track)"),
    hide_uncalled: Optional[bool] = Query(None, description="false: Min footprints' All reads, including uncalled"),
    min_footprints: Optional[int] = Query(None), state=Depends(get_state),
):
    """Per-read SV events and alleles in a view, for the read rows (absolute coordinates)."""
    from services import fiberhmm_variant_layers as fvl
    dataset, error = _dataset(state, dataset_id)
    if error:
        return error
    wanted = [x.strip() for x in layers.split(",") if x.strip() in fvl.VARIANT_LAYER_TYPES]
    try:
        payload = await asyncio.to_thread(
            fvl.read_overlay_payload, state, dataset, chrom=chrom, start=max(0, int(start)), end=int(end),
            layers=wanted, min_sv_len=max(1, int(min_sv_len)), min_mapq=max(0, int(min_mapq)),
            hide_supplementary=bool(hide_supplementary), link_split=bool(link_split),
            include_qcfail=bool(include_qcfail), include_duplicates=bool(include_duplicates),
            hide_uncalled=(False if (min_footprints is not None and min_footprints < 0) else hide_uncalled))
    except fvl.VariantLayerError as exc:
        return JSONResponse({"detail": str(exc)}, status_code=exc.status)
    return ORJSONResponse(payload)


@router.post("/api/fiberhmm_layers/lift")
async def fiberhmm_layers_lift(request: Request, state=Depends(get_state)):
    """Draw a dataset's variant layers through a UCSC chain (``{"dataset_id", "chain"}``; no chain: as stored)."""
    from services import fiberhmm_variant_layers as fvl
    from services.local_paths import normalize_local_path, path_access_error
    body = await json_object_body(request)
    dataset, error = _dataset(state, str(body.get("dataset_id") or ""))
    if error:
        return error
    chain: Optional[str] = body.get("chain") or None
    if chain is None:
        fvl.set_lift(dataset, None)
        return {"success": True, "lift": None}
    path = normalize_local_path(str(chain))
    # A lab server: only a chain inside this request's data roots (relative paths included).
    from services.lab.paths import PathDenied, confine
    try:
        confine(path)
        confine(os.path.realpath(path))
    except PathDenied as exc:
        return JSONResponse({"detail": str(exc)}, status_code=403)
    problem = path_access_error(path, original_path=str(chain), expected="chain file")
    if problem:
        return JSONResponse({"detail": problem}, status_code=404)
    try:
        mapper = await asyncio.to_thread(fvl.ChainMapper, path)
    except (OSError, ValueError, IndexError) as exc:
        return JSONResponse({"detail": f"Cannot read the chain: {exc}"}, status_code=400)
    fvl.set_lift(dataset, mapper)
    return {"success": True, "lift": path}
