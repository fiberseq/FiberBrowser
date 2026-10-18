"""Live-lift endpoints (DESIGN_LIVE_LIFT.md §3.1): open a lifted dataset,
inspect a graphlift map, change a lifted dataset's settings. Every route
answers 404 while the ``FIBERBROWSER_LIVE_LIFT`` flag is off."""
from __future__ import annotations

import asyncio
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from state.dependencies import get_state

router = APIRouter(tags=["live lift"])


class LiftDatasetRequest(BaseModel):
    paths: list[str] = Field(default_factory=list, description="Source BAM file(s), aligned to the source assembly")
    manifest: str = Field(..., description="The graphlift sidecar manifest (.graphlift.json)")
    haplotypes: list[str] = Field(default_factory=list, description="Haplotype keys or labels (MAT/PAT); empty: all")
    settings: Optional[dict] = None
    label: Optional[str] = None
    source_fasta: Optional[str] = Field(None, description="Source assembly FASTA for anchor sequence spot checks")


class LiftSettingsRequest(BaseModel):
    settings: Optional[dict] = None
    haplotypes: Optional[list[str]] = None


@router.get("/api/lift/enabled")
async def lift_enabled():
    from services.lift.dataset import live_lift_enabled
    return {"enabled": live_lift_enabled()}


@router.get("/api/lift/inspect")
async def lift_inspect(manifest: str = Query(..., description="graphlift sidecar manifest")):
    from services.lift.registration import inspect_map
    try:
        return await asyncio.to_thread(inspect_map, manifest)
    except (OSError, ValueError) as exc:
        return {"success": False, "error": f"Cannot read the map: {exc}"}


@router.post("/api/lift/datasets")
async def lift_add_dataset(req: LiftDatasetRequest, state=Depends(get_state)):
    from services.lift.registration import add_live_lift_dataset
    return await asyncio.to_thread(add_live_lift_dataset, state, paths=req.paths, manifest=req.manifest,
                                   haplotypes=req.haplotypes, settings=req.settings, label=req.label,
                                   source_fasta=req.source_fasta)


@router.post("/api/lift/datasets/{dataset_id}/settings")
async def lift_update_settings(dataset_id: str, req: LiftSettingsRequest, state=Depends(get_state)):
    from services.lift.registration import update_settings
    return update_settings(state, dataset_id, req.settings, req.haplotypes)


def _difference_dataset(state, dataset_id, chrom):
    from services.lift.registration import require_enabled
    from services.lift.capability import is_lifted, require
    require_enabled()
    dataset = state.datasets.get(dataset_id)
    if dataset is None:
        raise HTTPException(404, "Dataset not found")
    if not is_lifted(dataset):
        raise HTTPException(409, "Differences require a live-lift dataset")
    require(dataset, "differences")
    if chrom not in dataset.live_lift.handle.map.targets:
        raise HTTPException(404, "Chromosome not in lift map")
    return dataset


@router.get("/api/lift/differences")
async def lift_differences(dataset_id: str, chrom: str, start: int = Query(..., ge=0),
                           end: int = Query(..., ge=0), lift_hap: Optional[str] = None,
                           min_bp: int = Query(0, ge=0), detail_bp: int = Query(250_000, ge=1),
                           native_dataset_id: Optional[str] = None, state=Depends(get_state)):
    """Assembly strip; exact JSON schema is in services.lift.differences.
    Optional native_dataset_id attaches the existing display SV summary at a
    50 bp floor as ``native_summary`` and matches its indexed clusters to
    assembly items (``read_support``); unmatched clusters become ``novel``.
    """
    dataset = _difference_dataset(state, dataset_id, chrom)
    if end <= start:
        raise HTTPException(422, "end must be greater than start")
    if native_dataset_id:
        native = state.datasets.get(native_dataset_id)
        if native is None or native.data_type != "bam":
            raise HTTPException(422, "native_dataset_id must name a native BAM dataset")

    def build():
        from services.lift.differences import differences_for_region, annotate_read_evidence, assembly_items_for_region
        payload = differences_for_region(state, dataset, chrom, start, end, lift_hap=lift_hap,
                                          min_bp=min_bp, detail_bp=detail_bp)
        if native_dataset_id:
            from services.read_endpoint import _compact_reads_payload
            native_payload = _compact_reads_payload(state, dataset_id=native_dataset_id, chrom=chrom,
                                                      start=start, end=end, min_sv_len=50, include_sv_summary=True)
            summary = native_payload.get("sv_summary") or {"min_len": 50, "clusters": [], "scope": "display"}
            summary = {**summary, "dataset_id": native_dataset_id,
                       "clusters": [{**c, "source": "reads"} for c in summary.get("clusters", [])]}
            payload["native_summary"] = summary
            all_items = assembly_items_for_region(dataset.live_lift, chrom, start, end, lift_hap=lift_hap)
            payload["novel"] = annotate_read_evidence(all_items, summary["clusters"])
            support = {i["id"]: i["read_support"] for i in all_items if "read_support" in i}
            for item in payload["items"]:
                if item["id"] in support:
                    item["read_support"] = support[item["id"]]
        return payload

    return await asyncio.to_thread(build)


@router.get("/api/lift/difference_reads")
async def lift_difference_reads(dataset_id: str, chrom: str, pos: int = Query(..., ge=0),
                                end: Optional[int] = Query(None, ge=0), lift_hap: Optional[str] = None,
                                item_id: Optional[str] = None,
                                state=Depends(get_state)):
    """Inspect lifted read alleles and chromatin; end defaults to pos+1.
    Explicit end=pos inspects a map insertion. At most 500 source records;
    ``capped`` reports truncation. The source/target strings have a 50 kb
    inspection limit, matching expandable insertion blocks.
    """
    from services.lift.differences import difference_reads
    dataset = _difference_dataset(state, dataset_id, chrom)
    end = pos + 1 if end is None else end
    if end < pos or end - pos > 50_000:
        raise HTTPException(422, "Inspection requires pos <= end <= pos+50000")
    return await asyncio.to_thread(difference_reads, state, dataset, chrom, pos, end, lift_hap=lift_hap, item_id=item_id)
