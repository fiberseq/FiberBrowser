"""Auxiliary read endpoints for images, metadata, signals, and compiled views."""
from __future__ import annotations

import asyncio
from typing import Optional

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse, Response

from models.requests import CompileRequest
from services.read_auxiliary_endpoint import (
    clear_cache_payload,
    compile_regions_payload,
    get_coverage_payload,
    get_fire_payload,
    get_genes_payload,
    get_legacy_layer_inference_payload,
    read_end_footprints_payload,
    get_meta_all_payload,
    get_meta_payload,
    get_quality_filters_payload,
    get_reads_image_payload,
    get_reads_info_payload,
    render_compiled_image_bytes,
    set_legacy_layer_inference_payload,
    set_read_end_footprints_payload,
    set_quality_filters_payload,
)
from services.query_params import parse_optional_csv_list
from state.dependencies import get_state
from utils.request_body import json_object_body

router = APIRouter(tags=["reads"])


@router.get("/api/reads/image")
async def get_reads_image(
    chrom: str = Query(...),
    start: int = Query(...),
    end: int = Query(...),
    spanning: bool = Query(False),
    max_reads: int = Query(1000),
    row_height: int = Query(3),
    use_cluster: bool = Query(False),
    dataset_id: Optional[str] = Query(None),
    width: Optional[int] = Query(None, ge=1, le=20000),
    height: Optional[int] = Query(None, ge=1, le=20000),
    state=Depends(get_state),
):
    """Render reads as PNG (at width x height when given)."""
    payload = get_reads_image_payload(
        state,
        chrom=chrom,
        start=start,
        end=end,
        spanning=spanning,
        max_reads=max_reads,
        row_height=row_height,
        use_cluster=use_cluster,
        dataset_id=dataset_id,
        width=width,
        height=height,
    )
    return Response(
        content=payload["content"],
        media_type=payload["media_type"],
        headers=payload["headers"],
    )


@router.get("/api/reads/info")
async def get_reads_info(
    chrom: str = Query(...),
    start: int = Query(...),
    end: int = Query(...),
    spanning: bool = Query(False),
    dataset_id: Optional[str] = Query(None),
    state=Depends(get_state),
):
    return get_reads_info_payload(state, chrom=chrom, start=start, end=end, spanning=spanning,
                                  dataset_id=dataset_id)


@router.post("/api/clear_cache")
async def clear_cache(state=Depends(get_state)):
    """Clear all read caches to force fresh data loading."""
    return clear_cache_payload(state)


@router.post("/api/quality_filters")
async def set_quality_filters(request: Request, state=Depends(get_state)):
    """Set per-layer quality filters applied at working-set level."""
    return set_quality_filters_payload(state, await json_object_body(request))


@router.get("/api/quality_filters")
async def get_quality_filters(state=Depends(get_state)):
    """Get current per-layer quality filters."""
    return get_quality_filters_payload(state)


@router.post("/api/legacy_layer_inference")
async def set_legacy_layer_inference(request: Request, state=Depends(get_state)):
    """Set legacy footprint-stream layer inference used by working-set caches."""
    return set_legacy_layer_inference_payload(state, await json_object_body(request))


@router.post("/api/read_end_footprints")
async def set_read_end_footprints(request: Request, state=Depends(get_state)):
    """Hide (default) or keep footprints under 90 bp cut off at read ends, in reads and analyses."""
    return set_read_end_footprints_payload(state, await json_object_body(request))


@router.get("/api/read_end_footprints")
async def get_read_end_footprints(state=Depends(get_state)):
    """Whether read-end footprints under the cutoff are hidden."""
    return read_end_footprints_payload(state)


@router.get("/api/legacy_layer_inference")
async def get_legacy_layer_inference(state=Depends(get_state)):
    """Get current legacy footprint-stream layer inference settings."""
    return get_legacy_layer_inference_payload(state)


@router.get("/api/meta")
async def get_meta(
    chrom: str = Query(...),
    start: int = Query(...),
    end: int = Query(...),
    dataset_id: Optional[str] = Query(None),
    read_ids: Optional[str] = Query(
        None,
        description=(
            "Optional comma-separated read IDs. When supplied, the profile is "
            "computed only over these reads (no need to call /api/jupyter/filter "
            "first). Each subset gets its own cache entry."
        ),
    ),
    state=Depends(get_state),
):
    """Get meta profile for a region. Uses LRU cache to avoid recomputation."""
    return get_meta_payload(
        state,
        chrom=chrom,
        start=start,
        end=end,
        dataset_id=dataset_id,
        # Present but empty (read_ids=) is an explicit empty subset.
        read_ids=[] if read_ids is not None and not read_ids.strip() else parse_optional_csv_list(read_ids),
    )


@router.get("/api/meta_all")
async def get_meta_all(
    chrom: str = Query(...),
    start: int = Query(...),
    end: int = Query(...),
    spanning: bool = Query(True),
    dataset_ids: Optional[str] = Query(None),
    state=Depends(get_state),
):
    """Fetch meta profiles for all (or the listed) datasets in one call."""
    return get_meta_all_payload(
        state, chrom=chrom, start=start, end=end, spanning=spanning,
        dataset_ids=parse_optional_csv_list(dataset_ids),
    )


@router.get("/api/genes")
async def get_genes(
    chrom: str = Query(...),
    start: int = Query(...),
    end: int = Query(...),
    state=Depends(get_state),
):
    """Get genes in region. Response is cached for 5 minutes as gene annotations rarely change."""
    # Requested on every navigation (for a padded window): pandas work, so off the event loop.
    payload = await asyncio.to_thread(get_genes_payload, state, chrom=chrom, start=start, end=end)
    return JSONResponse(content=payload["content"], headers=payload["headers"])


@router.get("/api/fire")
async def get_fire(
    chrom: str = Query(...),
    start: int = Query(...),
    end: int = Query(...),
    state=Depends(get_state),
):
    return get_fire_payload(state, chrom=chrom, start=start, end=end)


@router.get("/api/coverage")
async def get_coverage(
    chrom: str = Query(...),
    start: int = Query(0),
    end: int = Query(...),
    bins: int = Query(1000),
    dataset_id: Optional[str] = Query(None),
    include_duplicates: bool = Query(False),
    lift_hap: Optional[str] = Query(None, description="Live lift: one haplotype's coverage (a split panel)"),
    state=Depends(get_state),
):
    """Return binned read counts across a region (duplicate-flagged molecules
    only with ``include_duplicates``, as the read panel shows them). A live-lift
    dataset's payload adds ``live_lift``: per-haplotype depth and correspondence
    (hatching where a bin has no correspondence)."""
    # Reads every alignment in the region (3.3 s for 5 Mb of the E02 DddB BAM):
    # off the event loop.
    return await asyncio.to_thread(
        get_coverage_payload,
        state,
        chrom=chrom,
        start=start,
        end=end,
        bins=bins,
        dataset_id=dataset_id,
        include_duplicates=include_duplicates,
        lift_hap=lift_hap,
    )


@router.post("/api/reads/compile")
async def compile_regions(
    req: CompileRequest,
    state=Depends(get_state),
):
    """Compile reads from multiple genomic regions into a single normalized view."""
    return await asyncio.to_thread(compile_regions_payload, state, req)


@router.post("/api/render/compile")
async def render_compiled(
    req: CompileRequest,
    width: int = Query(2000),
    row_height: int = Query(3),
    max_reads: int = Query(500),
    show_mods: bool = Query(False),
    show_fire: bool = Query(False),
    sort_by: Optional[str] = Query(None),
    title: Optional[str] = Query(None),
    state=Depends(get_state),
):
    """Compile reads from multiple regions and render as a single image."""
    if not req.regions:
        return JSONResponse(status_code=400, content={"error": "No regions"})

    try:
        content = await asyncio.to_thread(
            render_compiled_image_bytes,
            state,
            req,
            width=width,
            row_height=row_height,
            max_reads=max_reads,
            show_mods=show_mods,
            show_fire=show_fire,
            sort_by=sort_by,
            title=title,
        )
        return Response(content=content, media_type="image/png")
    except Exception as exc:
        return JSONResponse(status_code=500, content={"error": str(exc)})
