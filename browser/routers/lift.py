"""Live-lift endpoints (DESIGN_LIVE_LIFT.md §3.1): open a lifted dataset,
inspect a graphlift map, change a lifted dataset's settings. Every route
answers 404 while the ``FIBERBROWSER_LIVE_LIFT`` flag is off."""
from __future__ import annotations

import asyncio
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
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


def _navigation_config(state, dataset_id):
    from services.lift.registration import require_enabled
    from services.lift.capability import is_lifted
    require_enabled()
    dataset = state.datasets.get(dataset_id)
    if dataset is None:
        raise HTTPException(404, "Dataset not found")
    if not is_lifted(dataset):
        raise HTTPException(409, "Navigation tables require a live-lift dataset")
    try:
        return dataset.live_lift
    except OSError as exc:
        raise HTTPException(409, f"Lift map unavailable: {exc}") from exc


@router.get("/api/lift/summary")
async def lift_summary(dataset_id: str, state=Depends(get_state)):
    """Map summary (§5.1): one row per chain ``[target, t_start, t_end, source,
    q_start, q_end, strand, hap, primary_span_bp, aligned_bp]`` (row index =
    chain index) with ``selected`` flags for the dataset's haplotypes."""
    from services.lift.navigation import served_summary
    config = _navigation_config(state, dataset_id)
    try:
        return await asyncio.to_thread(served_summary, config)
    except OSError as exc:
        raise HTTPException(409, f"Lift map unavailable: {exc}") from exc


@router.get("/api/lift/outline")
async def lift_outline(dataset_id: str, chrom: Optional[str] = None, source: Optional[str] = None,
                       state=Depends(get_state)):
    """Coarse outline (§5.1) of a target chromosome (``chrom``) or of one
    source contig (``source``): ``[t_start, t_end, q_start, q_end, strand,
    chain, max_drift]`` (source rows add the target name), selected
    haplotypes only."""
    from services.lift.navigation import served_outline
    if (chrom is None) == (source is None):
        raise HTTPException(422, "Give exactly one of chrom or source")
    config = _navigation_config(state, dataset_id)
    try:
        return await asyncio.to_thread(served_outline, config, chrom=chrom, source=source)
    except KeyError:
        raise HTTPException(404, "Not in this dataset's lift map") from None
    except OSError as exc:
        raise HTTPException(409, f"Lift map unavailable: {exc}") from exc


@router.get("/api/lift/tiles")
async def lift_tile(dataset_id: str, side: str = Query(..., pattern="^(target|source)$"), contig: str = Query(...),
                    tile: int = Query(..., ge=0), state=Depends(get_state)):
    """One exact 1 Mb navigation tile (delta-varint, services/lift/navigation.py)."""
    from fastapi.responses import Response
    from services.lift.navigation import served_tile
    config = _navigation_config(state, dataset_id)
    try:
        blob = await asyncio.to_thread(served_tile, config, side, contig, tile)
    except KeyError:
        raise HTTPException(404, "Not in this dataset's lift map") from None
    except OSError as exc:
        raise HTTPException(409, f"Lift map unavailable: {exc}") from exc
    return Response(blob, media_type="application/octet-stream",
                    headers={"Cache-Control": "private, max-age=3600", "X-Lift-Key": config.key()})


@router.get("/api/lift/pieces")
async def lift_pieces(dataset_id: str, chrom: str, start: int = Query(..., ge=0), end: int = Query(..., ge=1),
                      hap: Optional[str] = None, alternatives: Optional[bool] = None,
                      min_bp: int = Query(0, ge=0), state=Depends(get_state)):
    """Ribbon data (§5.2): pieces and primary-chain gaps of a target window."""
    from services.lift.navigation import served_pieces
    if end <= start:
        raise HTTPException(422, "end must be greater than start")
    if end - start > 50_000_000:
        raise HTTPException(413, "Zoom in to draw the lift ribbon")
    config = _navigation_config(state, dataset_id)
    try:
        return await asyncio.to_thread(served_pieces, config, chrom, start, end, hap=hap,
                                       alternatives=alternatives, min_bp=min_bp)
    except KeyError:
        raise HTTPException(404, "Not in this dataset's lift map") from None
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except OSError as exc:
        raise HTTPException(409, f"Lift map unavailable: {exc}") from exc


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
    assembly items (``read_candidates``). The legacy ``novel`` array contains
    unmatched read events with explicitly unassessed assembly comparison.
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
            support = {i["id"]: {k: i[k] for k in ("read_support", "read_candidates")} for i in all_items if "read_support" in i}
            for item in payload["items"]:
                if item["id"] in support:
                    item.update(support[item["id"]])
        return payload

    return await asyncio.to_thread(build)


@router.get("/api/lift/difference_sequence")
async def lift_difference_sequence(dataset_id: str, chrom: str, item_id: str, pos: int = Query(..., ge=0),
                                   offset: int = Query(0, ge=0), limit: int = Query(50_000, ge=1, le=50_000),
                                   allele: str = Query("alternate", pattern="^(reference|alternate)$"),
                                   state=Depends(get_state)):
    from services.lift.differences import difference_sequence
    dataset = _difference_dataset(state, dataset_id, chrom)
    return await asyncio.to_thread(difference_sequence, dataset, chrom, pos, item_id, offset=offset, limit=limit,
                                   allele=allele, reference=getattr(state, "fasta", None))


@router.get("/api/lift/difference_reads")
async def lift_difference_reads(dataset_id: str, chrom: str, pos: int = Query(..., ge=0),
                                end: Optional[int] = Query(None, ge=0), lift_hap: Optional[str] = None,
                                item_id: Optional[str] = None,
                                include_sequence: bool = False,
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
    return await asyncio.to_thread(difference_reads, state, dataset, chrom, pos, end, lift_hap=lift_hap, item_id=item_id, include_sequence=include_sequence)


class MoleculeProvenanceRequest(BaseModel):
    molecule_groups: list[list[str]] = Field(default_factory=list)
    joint_dedup: str = "off"


class DifferenceAnalysisRequest(BaseModel):
    dataset_id: str
    chrom: str
    start: int = Field(ge=0)
    end: int = Field(ge=0)
    target: Optional[dict] = None
    analysis_scope: str = "lifted_only"
    native_dataset_id: Optional[str] = None
    include_duplicates: bool = False
    projection_policy: Optional[dict] = None
    contexts: Optional[dict] = None


async def _projected_analysis(req, feature, request, state):
    from services.background_work import Cancelled, cancelled_response, dataset_identity, run_background
    from services.differences.identity import content_id
    from services.differences.projection import ProjectionPolicy
    from services.differences.projected_service import projected_analysis
    from services.differences.policy import SearchPolicy
    from services.reconstruction_budget import ResourceResult
    try:
        dataset = _difference_dataset(state, req.dataset_id, req.chrom)
    except OSError as exc:
        from services.lift.capability import is_lifted
        dataset = state.datasets.get(req.dataset_id)
        if req.analysis_scope != "combined" or not req.native_dataset_id or not is_lifted(dataset):
            raise HTTPException(409, "Lift map unavailable") from exc
    try:
        options = dict(req.projection_policy or {})
        if "search" in options:
            options["search"] = SearchPolicy(**options["search"])
        options.setdefault("cohort_alternatives", dataset.live_lift.settings.cohort_alternatives)
        policy = ProjectionPolicy(**options)
        ids = [req.dataset_id, *([req.native_dataset_id] if req.native_dataset_id else [])]
        try:
            identity = dataset_identity(state, ids)
        except OSError:
            from services.background_work import file_identity
            identity = (dataset_identity(state, [req.native_dataset_id]),
                        "map_unavailable", file_identity(dataset.paths), repr(dataset.live_lift.settings))
        key = ("difference_"+feature, id(state), policy.version, content_id("request", req.model_dump()), identity)
        return await run_background(request, key, projected_analysis, state, dataset,
            chrom=req.chrom, start=req.start, end=req.end, feature=feature, target=req.target,
            policy=policy, include_duplicates=req.include_duplicates, contexts=req.contexts,
            native_dataset_id=req.native_dataset_id, analysis_scope=req.analysis_scope)
    except (ValueError, TypeError) as exc:
        raise HTTPException(422, str(exc)) from exc
    except ResourceResult as exc:
        return {**exc.payload(), "targets": []}
    except Cancelled:
        return cancelled_response()


@router.post("/api/lift/analysis/summary")
async def lift_difference_summary(req: DifferenceAnalysisRequest, request: Request, state=Depends(get_state)):
    """Composed read discovery at the fixed 10 bp floor, one molecule per target."""
    return await _projected_analysis(req, "summary", request, state)


@router.post("/api/lift/analysis/split")
async def lift_difference_split(req: DifferenceAnalysisRequest, request: Request, state=Depends(get_state)):
    """Frozen geometry/exact target calls and qualified row fan-out for splits/highlights."""
    return await _projected_analysis(req, "split", request, state)


@router.post("/api/lift/provenance/{dataset_id}")
async def lift_molecule_provenance(dataset_id: str, req: MoleculeProvenanceRequest, state=Depends(get_state)):
    """Declare sharing with a native BAM; QNAME alone never establishes identity."""
    from services.lift.registration import require_enabled, update_settings
    from services.lift.capability import is_bam_backed, is_lifted
    from services.lift.live_lift import LiftSettings
    require_enabled()
    dataset = state.get_dataset(dataset_id)
    if not dataset or not is_bam_backed(dataset):
        raise HTTPException(422, "Molecule provenance requires a BAM dataset")
    try:
        settings = LiftSettings(molecule_groups=req.molecule_groups, joint_dedup=req.joint_dedup)
        if any(path not in dataset.paths for path, label in settings.molecule_groups):
            raise ValueError("Provenance must name a BAM in this dataset")
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    if is_lifted(dataset):
        return update_settings(state, dataset_id, dict(molecule_groups=settings.as_dict()["molecule_groups"], joint_dedup=settings.joint_dedup), None)
    dataset.molecule_groups = settings.as_dict()["molecule_groups"]
    dataset.joint_dedup = settings.joint_dedup
    from services.dataset_registration import invalidate_dataset_caches
    invalidate_dataset_caches(state, dataset_id)
    return {"success": True, "dataset": dataset.to_dict()}
