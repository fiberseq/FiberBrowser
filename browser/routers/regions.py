"""Regions: found in a dataset's reads, and the user's region catalog (services/region_*.py)."""
from __future__ import annotations

import asyncio
from typing import Any, Optional

from fastapi import APIRouter, Body, Depends, Query
from fastapi.responses import JSONResponse

from state.dependencies import get_state
from utils.responses import ORJSONResponse

router = APIRouter(tags=["regions"])


@router.get("/api/reads/regions")
async def detect_dataset_regions(
    dataset_id: str = Query(..., description="The dataset whose reads are searched"),
    chrom: Optional[str] = Query(None, description="Only this chromosome (default: the whole dataset, when small enough)"),
    start: Optional[int] = Query(None, ge=0, description="With chrom and end: only this view"),
    end: Optional[int] = Query(None, ge=1),
    min_reads: Optional[int] = Query(None, ge=1, le=1_000_000, description="Smallest cluster listed (default 0.2% of the reads, at least 3)"),
    max_regions: int = Query(500, ge=1, le=500),
    force: bool = Query(False, description="Read the reads whatever the scope's size (slow: the user asked)"),
    state=Depends(get_state),
):
    """A dataset's amplicons (amplicon data) or best-covered regions, each named after
    the nearest gene. Bounded: refused (``refused: true`` and why) where it would scan
    a whole genome's reads. The path is under /api/reads/ so a dataset on its own
    reference is answered on that reference (state/dependencies.get_state)."""
    from services.region_detect import detect_regions

    if (start is None) != (end is None) or (start is not None and chrom is None):
        return {"success": False, "error": "A view needs chrom, start and end.", "regions": []}
    if start is not None and end is not None and end <= start:
        return {"success": False, "error": "end must be after start.", "regions": []}
    return await asyncio.to_thread(detect_regions, state, dataset_id, chrom=chrom, start=start, end=end,
                                   min_reads=min_reads, max_regions=max_regions, force=force)


@router.get("/api/regions/label")
def region_label(
    chrom: str = Query(...),
    start: int = Query(..., ge=0),
    end: int = Query(..., ge=1),
    state=Depends(get_state),
):
    """The nearest-gene name for a region (``panel_genome=`` for a panel's own reference)."""
    from services.region_detect import nearest_gene_label, region_genome_key

    return {**nearest_gene_label(state, chrom, start, max(start + 1, end)), "genome": region_genome_key(state)}


@router.get("/api/regions/catalog")
def get_region_catalog(genome: str = Query(..., min_length=1, max_length=200), state=Depends(get_state)):
    """The user's saved regions on one reference (a lab member's own; a FASTA
    reference's by its contigs, services/region_catalog.reference_identity)."""
    from services.region_catalog import read_catalog, reference_identity

    reference = reference_identity(state, genome)
    # ``identity``: what the browser sends back with its writes (services/region_catalog.bound_reference).
    # Plain JSON from disk: orjson directly, not FastAPI's jsonable_encoder,
    # which walked a 50,000-entry catalog for 0.6-1.0 s on the event loop.
    return ORJSONResponse({"success": True, "catalog": read_catalog(genome, reference),
                           "identity": reference.identity if reference else ""})


@router.put("/api/regions/catalog")
def put_region_catalog(
    genome: str = Body(..., min_length=1, max_length=200),
    catalog: Any = Body(...),
    base_revision: Optional[int] = Body(None, ge=0, description="The revision the catalog was read at: refused (409) when saved since"),
    identity: Optional[str] = Body(None, max_length=64, description="The identity GET answered (the catalog read); default: the reference loaded now"),
    state=Depends(get_state),
):
    """Replace one reference's saved regions (the whole catalog; unknown fields dropped).
    409 with the current catalog when another window saved since ``base_revision``;
    413 when it holds more regions or categories than are kept (nothing is saved)."""
    from services.region_catalog import CatalogConflict, CatalogTooLarge, bound_reference, write_catalog

    try:
        saved = write_catalog(genome, catalog, base_revision, bound_reference(state, genome, identity))
    except CatalogConflict as conflict:
        return JSONResponse(status_code=409, content={"success": False, "conflict": True, "catalog": conflict.current})
    except CatalogTooLarge as too_large:
        return JSONResponse(status_code=413, content={"success": False, "too_large": True, "error": str(too_large),
                                                      "detail": str(too_large), "entries": too_large.entries,
                                                      "categories": too_large.categories})
    return {"success": True, "revision": saved["revision"], "categories": len(saved["categories"]), "entries": len(saved["entries"])}


@router.delete("/api/regions/catalog")
def delete_region_catalog(genome: str = Query(..., min_length=1, max_length=200),
                          identity: Optional[str] = Query(None, max_length=64),
                          state=Depends(get_state)):
    """Forget one reference's saved regions (Reset)."""
    from services.region_catalog import bound_reference, delete_catalog

    return {"success": True, **delete_catalog(genome, bound_reference(state, genome, identity))}
