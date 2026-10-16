"""Co-accessibility matrix endpoints.

Computes single-molecule co-accessibility from fiber-seq reads and renders
as a symmetric heatmap, reusing the existing contact matrix rendering pipeline.

O/E normalization uses the same distance-based expected approach as the
Micro-C viewer in dafc.py: expected(d) = mean of all cells at distance d,
then O/E = observed / expected. This removes the strong diagonal signal
inherent in co-accessibility (nearby bins are trivially co-accessible).
"""
from __future__ import annotations

import asyncio
from typing import Optional
from fastapi import APIRouter, Query, Depends, Response

from state.dependencies import get_state
from services.contact_rendering import _apply_colormap, render_contact_matrix_image
from services.coaccessibility_endpoint import (
    _coacc_scope,
    get_coacc_arcs_payload,
    get_coacc_matrix_image_bytes,
    get_coacc_matrix_data_payload,
    get_coacc_metadata_payload,
    get_coacc_slice_payload,
    get_coacc_strip_image_bytes,
)

router = APIRouter(tags=["coaccessibility"])


@router.get("/api/coacc/matrix/image")
async def get_coacc_matrix_image(
    chrom: str = Query(...),
    start: int = Query(...),
    end: int = Query(...),
    bin_size: int = Query(0, description="Bin size in bp (0 = auto)"),
    dataset_ids: Optional[str] = Query(None, description="Comma-separated dataset IDs"),
    normalization: str = Query('oe', description="raw | oe | oe_distance | correlation"),
    scaling: str = Query('linear', description="linear | log | sqrt"),
    colormap: str = Query('fall', description="fall | red | hot | viridis | blues"),
    vmin: Optional[float] = Query(None),
    vmax: Optional[float] = Query(None),
    min_coverage: int = Query(20),
    read_ids: Optional[str] = Query(None, description="Comma-separated read IDs"),
    read_ids_by_dataset: Optional[str] = Query(None, description="JSON object mapping dataset IDs to read ID lists"),
    signal_type: str = Query('accessibility', description="Signal: accessibility | nucleosome | small_fp | linker | all_fp | size:MIN-MAX"),
    layer: Optional[str] = Query(None, description="Annotation layer name (e.g. 'fire', 'tf'). If set, overrides signal_type size heuristics."),
    sample_seed: Optional[str] = Query(None, description="Seed for reproducible backend working-set caps"),
    state=Depends(get_state),
):
    """Render co-accessibility matrix as a PNG image."""
    scope = _coacc_scope(
        state,
        chrom=chrom,
        start=start,
        end=end,
        bin_size=bin_size,
        dataset_ids=dataset_ids,
        read_ids=read_ids,
        read_ids_by_dataset=read_ids_by_dataset,
        layer=layer,
        sample_seed=sample_seed,
    )
    if scope.region_width <= 0:
        return Response(content=b'', media_type="image/png")

    def _compute():
        return get_coacc_matrix_image_bytes(
            state,
            scope,
            normalization,
            min_coverage,
            render_contact_matrix_image=render_contact_matrix_image,
            scaling=scaling,
            colormap=colormap,
            vmin=vmin,
            vmax=vmax,
            signal_type=signal_type,
            layer=layer,
        )

    content = await asyncio.to_thread(_compute)
    return Response(content=content, media_type="image/png")


@router.get("/api/coacc/metadata")
async def get_coacc_metadata(
    chrom: str = Query(...),
    start: int = Query(...),
    end: int = Query(...),
    bin_size: int = Query(0),
    dataset_ids: Optional[str] = Query(None),
    normalization: str = Query('oe', description="raw | oe | oe_distance | correlation"),
    min_coverage: int = Query(20),
    read_ids: Optional[str] = Query(None),
    read_ids_by_dataset: Optional[str] = Query(None, description="JSON object mapping dataset IDs to read ID lists"),
    signal_type: str = Query('accessibility'),
    layer: Optional[str] = Query(None, description="Annotation layer name (e.g. 'fire', 'tf'). If set, overrides signal_type size heuristics."),
    sample_seed: Optional[str] = Query(None, description="Seed for reproducible backend working-set caps"),
    state=Depends(get_state),
):
    """Return metadata about the co-accessibility computation."""
    scope = _coacc_scope(
        state,
        chrom=chrom,
        start=start,
        end=end,
        bin_size=bin_size,
        dataset_ids=dataset_ids,
        read_ids=read_ids,
        read_ids_by_dataset=read_ids_by_dataset,
        layer=layer,
        sample_seed=sample_seed,
    )
    if scope.region_width <= 0:
        return {"n_bins": 0, "bin_size": 0, "n_reads": 0}

    def _compute():
        return get_coacc_metadata_payload(
            state,
            scope,
            normalization,
            min_coverage,
            signal_type=signal_type,
            layer=layer,
        )

    result = await asyncio.to_thread(_compute)
    return result


@router.get("/api/coacc/matrix/data")
async def get_coacc_matrix_data(
    chrom: str = Query(...),
    start: int = Query(...),
    end: int = Query(...),
    bin_size: int = Query(0, description="Bin size in bp (0 = auto)"),
    dataset_ids: Optional[str] = Query(None),
    normalization: str = Query('oe', description="raw | oe | oe_distance | correlation"),
    min_coverage: int = Query(20),
    read_ids: Optional[str] = Query(None),
    read_ids_by_dataset: Optional[str] = Query(None, description="JSON object mapping dataset IDs to read ID lists"),
    signal_type: str = Query('accessibility'),
    layer: Optional[str] = Query(None, description="Annotation layer name (e.g. 'fire', 'tf'). If set, overrides signal_type size heuristics."),
    sample_seed: Optional[str] = Query(None, description="Seed for reproducible backend working-set caps"),
    state=Depends(get_state),
):
    """Return co-accessibility matrix as JSON (for Jupyter / programmatic use)."""
    scope = _coacc_scope(
        state,
        chrom=chrom,
        start=start,
        end=end,
        bin_size=bin_size,
        dataset_ids=dataset_ids,
        read_ids=read_ids,
        read_ids_by_dataset=read_ids_by_dataset,
        layer=layer,
        sample_seed=sample_seed,
    )
    if scope.region_width <= 0:
        return {"matrix": [], "coverage": [], "n_bins": 0, "n_reads": 0}

    def _compute():
        return get_coacc_matrix_data_payload(
            state,
            scope,
            normalization,
            min_coverage,
            signal_type=signal_type,
            layer=layer,
        )

    result = await asyncio.to_thread(_compute)
    return result


@router.get("/api/coacc/slice")
async def get_coacc_slice(
    chrom: str = Query(...),
    start: int = Query(...),
    end: int = Query(...),
    position: int = Query(..., description="Genomic position of viewpoint"),
    bin_size: int = Query(0),
    dataset_ids: Optional[str] = Query(None),
    normalization: str = Query('oe'),
    min_coverage: int = Query(20),
    read_ids: Optional[str] = Query(None),
    read_ids_by_dataset: Optional[str] = Query(None, description="JSON object mapping dataset IDs to read ID lists"),
    signal_type: str = Query('accessibility'),
    layer: Optional[str] = Query(None, description="Annotation layer name (e.g. 'fire', 'tf'). If set, overrides signal_type size heuristics."),
    sample_seed: Optional[str] = Query(None, description="Seed for reproducible backend working-set caps"),
    state=Depends(get_state),
):
    """Return 1D co-accessibility profile at a given genomic position (virtual 4C)."""
    scope = _coacc_scope(
        state,
        chrom=chrom,
        start=start,
        end=end,
        bin_size=bin_size,
        dataset_ids=dataset_ids,
        read_ids=read_ids,
        read_ids_by_dataset=read_ids_by_dataset,
        layer=layer,
        sample_seed=sample_seed,
    )
    if scope.region_width <= 0 or position < scope.start or position >= scope.end:
        return {"profile": [], "coverage": [], "bin_size": 0, "n_bins": 0,
                "viewpoint_bin": 0, "viewpoint_start": 0, "viewpoint_end": 0}

    def _compute():
        return get_coacc_slice_payload(
            state,
            scope,
            position,
            normalization,
            min_coverage,
            signal_type=signal_type,
            layer=layer,
        )

    result = await asyncio.to_thread(_compute)
    return result


@router.get("/api/coacc/arcs")
async def get_coacc_arcs(
    chrom: str = Query(...),
    start: int = Query(...),
    end: int = Query(...),
    bin_size: int = Query(0),
    dataset_ids: Optional[str] = Query(None),
    normalization: str = Query('oe'),
    min_coverage: int = Query(20),
    threshold: float = Query(1.5, description="Minimum value to include as arc"),
    max_arcs: int = Query(200, description="Maximum number of arcs to return"),
    min_distance: int = Query(2, description="Minimum bin distance between arc endpoints"),
    read_ids: Optional[str] = Query(None),
    read_ids_by_dataset: Optional[str] = Query(None, description="JSON object mapping dataset IDs to read ID lists"),
    signal_type: str = Query('accessibility'),
    layer: Optional[str] = Query(None, description="Annotation layer name (e.g. 'fire', 'tf'). If set, overrides signal_type size heuristics."),
    sample_seed: Optional[str] = Query(None, description="Seed for reproducible backend working-set caps"),
    state=Depends(get_state),
):
    """Return top co-accessible bin pairs as arcs (for arc display)."""
    scope = _coacc_scope(
        state,
        chrom=chrom,
        start=start,
        end=end,
        bin_size=bin_size,
        dataset_ids=dataset_ids,
        read_ids=read_ids,
        read_ids_by_dataset=read_ids_by_dataset,
        layer=layer,
        sample_seed=sample_seed,
    )
    if scope.region_width <= 0:
        return {"arcs": [], "bin_size": 0, "n_arcs": 0}

    def _compute():
        return get_coacc_arcs_payload(
            state,
            scope,
            normalization,
            min_coverage,
            threshold=threshold,
            max_arcs=max_arcs,
            min_distance=min_distance,
            signal_type=signal_type,
            layer=layer,
        )

    result = await asyncio.to_thread(_compute)
    return result


@router.get("/api/coacc/strip")
async def get_coacc_strip(
    chrom: str = Query(...),
    start: int = Query(...),
    end: int = Query(...),
    width: int = Query(800, description="Output image width in pixels"),
    height: int = Query(120, description="Output image height in pixels"),
    bin_size: int = Query(0),
    dataset_ids: Optional[str] = Query(None),
    normalization: str = Query('oe'),
    scaling: str = Query('linear'),
    colormap: str = Query('fall'),
    min_coverage: int = Query(20),
    read_ids: Optional[str] = Query(None),
    read_ids_by_dataset: Optional[str] = Query(None, description="JSON object mapping dataset IDs to read ID lists"),
    signal_type: str = Query('accessibility'),
    layer: Optional[str] = Query(None, description="Annotation layer name (e.g. 'fire', 'tf'). If set, overrides signal_type size heuristics."),
    sample_seed: Optional[str] = Query(None, description="Seed for reproducible backend working-set caps"),
    state=Depends(get_state),
):
    """Render upper-triangle of co-accessibility matrix as a triangular strip PNG (for track display).

    X-axis = genomic position, Y-axis = interaction distance (0 at bottom, max at top).
    Same visual pattern as /api/microc/matrix/strip.
    """
    scope = _coacc_scope(
        state,
        chrom=chrom,
        start=start,
        end=end,
        bin_size=bin_size,
        dataset_ids=dataset_ids,
        read_ids=read_ids,
        read_ids_by_dataset=read_ids_by_dataset,
        layer=layer,
        sample_seed=sample_seed,
    )
    if scope.region_width <= 0:
        return Response(content=b'', media_type="image/png")

    def _compute():
        return get_coacc_strip_image_bytes(
            state,
            scope,
            normalization,
            min_coverage,
            apply_colormap=_apply_colormap,
            width=width,
            height=height,
            scaling=scaling,
            colormap=colormap,
            signal_type=signal_type,
            layer=layer,
        )

    content = await asyncio.to_thread(_compute)
    return Response(content=content, media_type="image/png")
