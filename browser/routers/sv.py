"""Structural-variant endpoints: allele split and inserted sequence (fb-n9-sv)."""
from __future__ import annotations

import asyncio
from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse

from services.sv_endpoint import SvRequestError, sv_insert_seq_payload, sv_split_payload
from state.dependencies import get_state
from utils.request_body import json_object_body
from utils.responses import ORJSONResponse

router = APIRouter(tags=["reads"])


def _int(body: dict, key: str, default=None):
    value = body.get(key, default)
    if value is None:
        raise SvRequestError(f"missing {key}")
    try:
        return int(value)
    except (TypeError, ValueError):
        raise SvRequestError(f"{key} must be an integer") from None


@router.post("/api/sv/split")
async def post_sv_split(request: Request, state=Depends(get_state)):
    """Classify every read in a region by one SV: carrier, reference or not informative."""
    body = await json_object_body(request)
    try:
        payload = await asyncio.to_thread(
            sv_split_payload, state,
            dataset_id=str(body.get("dataset_id") or ""),
            chrom=str(body.get("chrom") or ""),
            start=_int(body, "start"), end=_int(body, "end"),
            t=str(body.get("t") or ""), ref=_int(body, "ref"), length=_int(body, "len"),
            margin=body.get("margin"),
            include_duplicates=bool(body.get("include_duplicates", False)),
            include_putative=bool(body.get("include_putative", True)),
            include_ambiguous=bool(body.get("include_ambiguous", False)),
            target_end=_int(body, 'ref_end') if body.get('ref_end') is not None else None,
        )
    except SvRequestError as exc:
        return JSONResponse({"detail": str(exc)}, status_code=exc.status)
    return ORJSONResponse(payload)


@router.get("/api/sv/insert_seq")
async def get_sv_insert_seq(
    dataset_id: str = Query(...), chrom: str = Query(...), ref: int = Query(...),
    read_id: str = Query(...), q: int = Query(...), length: int = Query(..., alias="len"),
    state=Depends(get_state),
):
    """The inserted bases of one read's insertion (SEQ frame)."""
    try:
        payload = await asyncio.to_thread(
            sv_insert_seq_payload, state, dataset_id=dataset_id, chrom=chrom, ref=ref,
            read_id=read_id, q=q, length=length)
    except SvRequestError as exc:
        return JSONResponse({"detail": str(exc)}, status_code=exc.status)
    return ORJSONResponse(payload)
