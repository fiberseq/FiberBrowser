"""Annotation overlay endpoints for per-read BigBed annotations."""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse

from models.requests import (
    ActivateAnnotationRequest,
    AddAnnotationRequest,
    AnnotationClusterRequest,
    AnnotationFilterRequest,
    AnnotationThresholdRequest,
    DetectPeaksRequest,
)
from services.annotation_bigbed import load_annotations_from_bigbed
from state.dependencies import get_state

router = APIRouter(tags=["annotations"])


def _annotations_endpoint():
    from services import annotations_endpoint

    return annotations_endpoint


def _json_or_payload(payload: dict):
    status_code = payload.get("status_code")
    if status_code is None:
        return payload
    content = {key: value for key, value in payload.items() if key != "status_code"}
    return JSONResponse(status_code=status_code, content=content)


@router.get("/api/annotations/files")
async def list_annotation_files(state=Depends(get_state)):
    return _annotations_endpoint().list_annotation_files_payload(state)


@router.post("/api/annotations/activate")
async def activate_annotation_file(req: ActivateAnnotationRequest, state=Depends(get_state)):
    return _json_or_payload(_annotations_endpoint().activate_annotation_file_payload(state, req))


@router.post("/api/annotations/deactivate")
async def deactivate_annotation_file(req: ActivateAnnotationRequest, state=Depends(get_state)):
    return _json_or_payload(_annotations_endpoint().deactivate_annotation_file_payload(state, req))


@router.post("/api/annotations/add")
async def add_annotation_file(req: AddAnnotationRequest, state=Depends(get_state)):
    return _json_or_payload(_annotations_endpoint().add_annotation_file_payload(state, req))


@router.get("/api/annotations/browse")
async def browse_annotation_files(dir: str = Query(...), state=Depends(get_state)):
    """List BigBed annotation files (*.bb, *.bigBed) in a directory."""
    return _json_or_payload(_annotations_endpoint().browse_annotation_files_payload(dir))


@router.delete("/api/annotations/{file_id}")
async def remove_annotation_file(file_id: str, state=Depends(get_state)):
    return _json_or_payload(_annotations_endpoint().remove_annotation_file_payload(state, file_id))


@router.get("/api/annotations/region")
async def get_annotations_for_region(
    chrom: str = Query(...),
    start: int = Query(...),
    end: int = Query(...),
    dataset_id: str = Query(""),
    dataset_ids: str = Query(""),
    file_ids: str = Query(""),
    sample_seed: str = Query(None, description="Seed for reproducible backend working-set caps"),
    state=Depends(get_state),
):
    return _annotations_endpoint().get_annotations_for_region_payload(
        state,
        chrom=chrom,
        start=start,
        end=end,
        dataset_id=dataset_id,
        dataset_ids=dataset_ids,
        file_ids=file_ids,
        sample_seed=sample_seed,
        load_annotations=load_annotations_from_bigbed,
    )


@router.post("/api/annotations/filter")
async def filter_by_annotations(req: AnnotationFilterRequest, state=Depends(get_state)):
    return _annotations_endpoint().filter_by_annotations_payload(
        state,
        req,
        load_annotations=load_annotations_from_bigbed,
    )


@router.post("/api/annotations/cluster")
async def cluster_by_annotations(req: AnnotationClusterRequest, state=Depends(get_state)):
    return _json_or_payload(
        _annotations_endpoint().cluster_by_annotations_payload(
            state,
            req,
            load_annotations=load_annotations_from_bigbed,
        )
    )


@router.get("/api/annotations/profile")
async def get_annotation_profile(
    chrom: str = Query(...),
    start: int = Query(...),
    end: int = Query(...),
    dataset_id: Optional[str] = Query(None),
    annotation_types: str = Query(""),
    bins: int = Query(500),
    state=Depends(get_state),
):
    return _annotations_endpoint().get_annotation_profile_payload(
        state,
        chrom=chrom,
        start=start,
        end=end,
        dataset_id=dataset_id,
        annotation_types=annotation_types,
        bins=bins,
        load_annotations=load_annotations_from_bigbed,
    )


@router.post("/api/annotations/set_threshold")
async def set_annotation_threshold(req: AnnotationThresholdRequest, state=Depends(get_state)):
    return _annotations_endpoint().set_annotation_threshold_payload(state, req)


@router.post("/api/detect_peaks")
async def detect_peaks(req: DetectPeaksRequest):
    """Detect peaks from an arbitrary 1D signal array."""
    return _annotations_endpoint().detect_peaks_payload(req)
