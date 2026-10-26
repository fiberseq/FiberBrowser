"""Source-neutral Differences inspection; legacy analysis gates remain intact."""
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from state.dependencies import get_state

router = APIRouter(tags=["differences"])


class WorkspaceRequest(BaseModel):
    dataset_id: str
    chrom: str
    start: int = Field(ge=0)
    end: int = Field(ge=0)
    target: dict
    include_duplicates: bool = False
    include_putative: bool = True
    include_conflicting: bool = False
    include_ambiguous: bool = False
    analysis_scope: Optional[str] = None
    native_dataset_id: Optional[str] = None
    policy: Optional[dict] = None
    row_ids: Optional[list[str]] = Field(None, max_length=500)
    layer_options: Optional[dict] = None
    include_sequences: bool = False
    consensus: bool = True
    flank: int = Field(0, ge=0, le=5000)
    max_reference: int = Field(500, ge=0, le=500)
    frozen_calls: Optional[dict] = None
    record_id: Optional[str] = None
    offset: int = Field(0, ge=0)
    limit: int = Field(1000, ge=1, le=50_000)
    layers: Optional[list[str]] = Field(None, max_length=32)


async def _workspace(req, request, state, operation):
    from services.background_work import Cancelled, cancelled_response, run_background
    from services.differences.identity import content_id
    from services.differences import workspace
    from services.reconstruction_budget import ResourceResult
    from services.panel_genomes import for_datasets
    dataset_ids = [req.dataset_id, *([req.native_dataset_id] if req.native_dataset_id else [])]
    state = for_datasets(state, dataset_ids)
    dataset = state.datasets.get(req.dataset_id)
    if dataset is None:
        raise HTTPException(404, "Dataset not found")
    if not req.start < req.end or req.end-req.start > 2_000_000:
        raise HTTPException(422, "Inspection requires a nonempty region of at most 2 Mb")
    if dataset.data_type == "bam_livelift":
        from services.lift.registration import require_enabled
        require_enabled()
    options = dict(chrom=req.chrom, start=req.start, end=req.end, target=req.target,
                   include_duplicates=req.include_duplicates)
    if operation == "inspect":
        options.update(policy=req.policy, include_putative=req.include_putative,
            include_conflicting=req.include_conflicting, include_ambiguous=req.include_ambiguous,
            analysis_scope=req.analysis_scope, native_dataset_id=req.native_dataset_id)
    elif operation == "lens":
        options.update(frozen_calls=req.frozen_calls, include_sequences=req.include_sequences, consensus=req.consensus, flank=req.flank, max_reference=req.max_reference)
    else:
        options.update(row_ids=req.row_ids, layers=req.layers, layer_options=req.layer_options)
        if operation == "sequence":
            options.update(record_id=req.record_id, offset=req.offset, limit=req.limit)
    try:
        identity = workspace._workspace_revision(state, dataset_ids)
        key = ("difference_workspace:v1", operation, id(state), identity, content_id("request", req.model_dump()))
        result=await run_background(request, key, getattr(workspace, operation), state, dataset, **options)
        import json
        if len(json.dumps(result).encode())>workspace.MAX_BYTES:
            raise ResourceResult("budget_exceeded","workspace_response_bytes")
        return result
    except (ValueError, TypeError) as exc:
        raise HTTPException(422, str(exc)) from exc
    except ResourceResult as exc:
        return exc.payload()
    except Cancelled:
        return cancelled_response()


@router.post("/api/differences/inspect")
async def inspect_difference(req: WorkspaceRequest, request: Request, state=Depends(get_state)):
    return await _workspace(req, request, state, "inspect")


@router.post("/api/differences/alternate-blocks")
async def difference_alternate_blocks(req: WorkspaceRequest, request: Request, state=Depends(get_state)):
    return await _workspace(req, request, state, "alternate_blocks")


@router.post("/api/differences/sequence")
async def difference_sequence(req: WorkspaceRequest, request: Request, state=Depends(get_state)):
    return await _workspace(req, request, state, "sequence")


@router.post("/api/differences/lens")
async def difference_lens(req: WorkspaceRequest, request: Request, state=Depends(get_state)):
    return await _workspace(req, request, state, "lens")


@router.post("/api/differences/observations")
async def difference_observations(req: WorkspaceRequest, request: Request, state=Depends(get_state)):
    return await _workspace(req, request, state, "observations")


class ReadDifference(BaseModel):
    id: str = Field(min_length=1, max_length=256)
    ref_start: int = Field(ge=0)
    ref_end: int = Field(ge=0)
    alt_bp: int = Field(ge=0)
    geometry_members: Optional[list[list[int]]] = Field(None, max_length=256)


class ComparisonRequest(BaseModel):
    dataset_id: str
    chrom: str
    start: int = Field(ge=0)
    end: int = Field(ge=0)
    reads: list[ReadDifference] = Field(default_factory=list, max_length=256)
    read_sequences: Optional[dict[str, str]] = None
    read_scope: Optional[dict] = None
    ledger: Optional[dict] = None
    matching_policy: Optional[dict] = None
    comparison_policy: Optional[dict] = None


@router.post("/api/differences/compare")
async def compare_with_assembly(req: ComparisonRequest, request: Request, state=Depends(get_state)):
    """Assembly comparison: exact IDs, typed links, labels, novelty, exact
    targets and the session identity ledger with any merge/split lineage."""
    from services.background_work import Cancelled, cancelled_response, run_background
    from services.differences.comparison import ComparisonPolicy, assembly_comparison
    from services.differences.identity import content_id
    from services.differences.matching import MatchingPolicy
    from services.lift.registration import require_enabled
    from services.reconstruction_budget import ResourceResult
    require_enabled()
    dataset = state.datasets.get(req.dataset_id)
    if dataset is None:
        raise HTTPException(404, "Dataset not found")
    if sum(len(v) for v in (req.read_sequences or {}).values()) > 200_000:
        raise HTTPException(422, "read sequences exceed 200,000 bases")
    try:
        matching = dict(req.matching_policy or {})
        matching = MatchingPolicy(**{k: v for k, v in matching.items() if k in MatchingPolicy.__dataclass_fields__})
        policy = ComparisonPolicy(**{k: v for k, v in (req.comparison_policy or {}).items()
                                     if k in ComparisonPolicy.__dataclass_fields__ and k != "version"})
        key = ("difference_compare:v1", id(state), content_id("request", req.model_dump()),
               getattr(dataset.live_lift, "key", lambda: None)() if getattr(dataset, "live_lift", None) else None)
        return await run_background(request, key, assembly_comparison, state, dataset, chrom=req.chrom,
            start=req.start, end=req.end, reads=[r.model_dump() for r in req.reads], read_sequences=req.read_sequences,
            read_scope=req.read_scope, ledger=req.ledger, matching_policy=matching, policy=policy)
    except (ValueError, TypeError) as exc:
        raise HTTPException(422, str(exc)) from exc
    except ResourceResult as exc:
        return exc.payload()
    except Cancelled:
        return cancelled_response()
