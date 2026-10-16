"""Dataset management, S3, file upload, and chromosome listing endpoints.

Extracted from server.py.
"""
from __future__ import annotations

from fastapi import APIRouter, Query, Depends, HTTPException, UploadFile, File
from fastapi.responses import JSONResponse
from typing import Optional

from models.requests import AddDatasetRequest, DatasetChemistryRequest, MergeDatasetsRequest, UnmergeDatasetsRequest
from state.dependencies import get_state
from services.dataset_endpoint import (
    add_dataset_for_request,
    add_grouped_datasets_for_request,
    merge_datasets_for_request,
    unmerge_dataset_for_request,
    launch_drop_window_for_state,
    upload_general_file_for_request,
)
from services.dataset_registration import refresh_dataset_capabilities
from services.query_params import resolve_dataset_id
from services.s3_endpoint import (
    configure_s3_for_request,
    get_presigned_url_for_request,
    get_s3_status_payload,
    list_s3_bucket_for_request,
    test_s3_access_for_request,
)

import asyncio
import os
import threading

router = APIRouter(tags=["datasets"])

# Opening a file may build its index first (minutes for a large unindexed BAM): that part runs off the
# event loop, one at a time, so the page (its other panels, the Library) stays live; registering the
# dataset stays on the loop (it is published before its layers are known, so no other request may run
# in between).
_INDEX_LOCK = threading.Lock()


def _prepare(req) -> None:
    from services.dataset_endpoint import prepare_local_indexes_for_request
    with _INDEX_LOCK:
        prepare_local_indexes_for_request(req)


@router.get("/api/chroms")
async def get_chroms(state=Depends(get_state)):
    """Get chromosome list. Response is cached for 1 hour as it rarely changes."""
    plasmids = getattr(state, "plasmid_metadata", None) or {}
    data = {
        "chroms": [
            {
                "name": c.name,
                "size": c.size,
                "circular": bool(getattr(c, "circular", False)),
                "circular_source": getattr(c, "circular_source", None),
                # A loaded plasmid map, circular or linear.
                "plasmid": c.name in plasmids,
            }
            for c in state.chroms
        ]
    }
    return JSONResponse(content=data, headers={"Cache-Control": "max-age=3600"})


@router.get("/api/datasets")
async def get_datasets(state=Depends(get_state)):
    """Get list of loaded datasets, each with whether it fits the loaded genome
    (``genome_check``: its assembly and a status; services/genome_check.py)."""
    from services.genome_check import dataset_genome_summaries
    import asyncio
    from services.panel_genomes import dataset_genome
    summaries = await asyncio.to_thread(dataset_genome_summaries, state)  # reads headers once per dataset
    return {
        "datasets": [{**state.datasets[did].to_dict(),
                      **({"genome_check": summaries[did]} if did in summaries else {}),
                      # Its own reference (another assembly than the main genome), if any.
                      **({"genome": dataset_genome(state, did)} if dataset_genome(state, did) else {})}
                     for did in state.dataset_order]
    }


@router.post("/api/datasets/add")
async def add_dataset(req: AddDatasetRequest,
    state=Depends(get_state)):
    """Add a new dataset (BigBed file(s), directory, BAM file, or remote URL).

    Supports:
    - Local file paths (absolute or relative)
    - Remote HTTP/HTTPS URLs for BAM or BigBed files
    - Lists of paths or URLs for multiple files

    For remote BAM files, the server must support byte-range requests
    and have an index (.bai) available at the same URL + '.bai'.
    """
    await asyncio.to_thread(_prepare, req)
    # In a worker: a failed add removes what it registered (state.remove_dataset prunes panel references,
    # which takes the process-wide registry lock).
    return await asyncio.to_thread(add_dataset_for_request, state, req)


@router.get("/api/demo")
async def get_demo(demo: Optional[str] = None, state=Depends(get_state)):
    """The bundled demo dataset the guided tour uses: available here?, its region, loaded id
    (the main demo's, or ``?demo=<id>``'s), and every bundled demo under ``demos``."""
    from services.demo_data import DEMOS, demo_info
    if demo and demo not in DEMOS:
        raise HTTPException(status_code=404, detail=f"No demo dataset called {demo!r}")
    return demo_info(state, demo)


@router.post("/api/demo/load")
async def load_demo_dataset(demo: Optional[str] = None, state=Depends(get_state)):
    """Load a bundled demo dataset (once; the main demo, or ``?demo=<id>``); returns its id
    and the region to show. In a tour tab it also loads the demo's genome from the local
    cache (seconds), so it runs off the event loop."""
    import asyncio
    from services.demo_data import load_demo
    return await asyncio.to_thread(load_demo, state, demo)


@router.post("/api/datasets/add_grouped")
async def add_grouped_datasets(req: AddDatasetRequest,
    state=Depends(get_state)):
    """Add multiple files, pairing BigBed layer companions into one dataset each.

    Use this for a multi-file selection: BigBed files belonging to the same
    sample (e.g. *_footprint.bb / *_tf.bb / *_msp.bb) collapse into a single
    layered dataset, while unrelated files and BAMs each load separately.
    Returns {"success", "datasets": [...]}.
    """
    await asyncio.to_thread(_prepare, req)
    return await asyncio.to_thread(add_grouped_datasets_for_request, state, req)


@router.post("/api/datasets/add_url")
async def add_dataset_url(url: str, label: Optional[str] = None, state=Depends(get_state)):
    """Add a remote dataset from a URL (convenience endpoint).

    This is a simplified endpoint specifically for adding remote URLs.
    The main /api/datasets/add endpoint also supports URLs.
    """
    return await asyncio.to_thread(add_dataset_for_request, state, AddDatasetRequest(url=url, label=label))


@router.delete("/api/datasets/{dataset_id}")
async def remove_dataset(dataset_id: str,
    state=Depends(get_state)):
    """Remove a dataset."""
    try:
        dataset_id = resolve_dataset_id(state, dataset_id)
        if not dataset_id:
            return {"success": False, "error": "No dataset loaded"}
        # In a worker: removing prunes panel references under the process-wide registry lock.
        await asyncio.to_thread(state.remove_dataset, dataset_id)
        return {"success": True}
    except Exception as e:
        return {"success": False, "error": str(e)}


@router.post("/api/datasets/{dataset_id}/refresh_capabilities")
async def refresh_dataset_capabilities_endpoint(dataset_id: str,
    state=Depends(get_state)):
    """Re-detect available dataset layers and clear stale read caches."""
    try:
        resolved_id = resolve_dataset_id(state, dataset_id)
        if not resolved_id:
            return {"success": False, "error": f"Dataset not found: {dataset_id}"}
        dataset = refresh_dataset_capabilities(state, resolved_id)
        return {
            "success": True,
            "dataset": dataset.to_dict(),
            "available_layers": dataset.available_layers,
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


@router.get("/api/datasets/with_contig")
def datasets_with_contig_route(chrom: str, state=Depends(get_state)):
    """Datasets whose files have this contig (where a plasmid's reads are)."""
    from services.dataset_contigs import datasets_with_contig
    return {"chrom": chrom, "dataset_ids": datasets_with_contig(state, chrom)}


@router.get("/api/datasets/{dataset_id}/assembly")
def dataset_assembly_route(dataset_id: str, state=Depends(get_state)):
    """The assembly this dataset was aligned to (from its header) and how it
    fits the loaded reference: status, message, evidence and the registry
    genome to load, if any. Report only; nothing is loaded."""
    from fastapi import HTTPException
    from services.genome_check import check_dataset
    resolved_id = resolve_dataset_id(state, dataset_id)
    if not resolved_id or resolved_id not in (state.datasets or {}):
        raise HTTPException(status_code=404, detail=f"Dataset not found: {dataset_id}")
    return check_dataset(state, resolved_id)


@router.post("/api/datasets/{dataset_id}/chemistry")
def set_dataset_chemistry(dataset_id: str, req: DatasetChemistryRequest,
    state=Depends(get_state)):
    """Set session metadata when source files do not declare assay chemistry."""
    resolved_id = resolve_dataset_id(state, dataset_id)
    if not resolved_id:
        return {"success": False, "error": f"Dataset not found: {dataset_id}"}
    dataset = state.datasets[resolved_id]
    chemistry = req.chemistry
    from pysam import SamtoolsError
    from services.chemistry_metadata import DECLARATIONS, save_bam_chemistry, inspect_dataset_chemistry
    saved_paths = []
    from services.runtime import get_public_mode
    if req.persist and get_public_mode():
        return {"success": False, "error": "Saving chemistry into the BAM is disabled on a public server."}
    if req.persist:
        if dataset.data_type != "bam":
            return {"success": False, "error": "Persistent chemistry metadata currently supports BAM datasets."}
        try:
            saved_paths = save_bam_chemistry(dataset.paths or [dataset.path], chemistry, req.platform)
        except (OSError, ValueError, RuntimeError, SamtoolsError) as error:
            return {"success": False, "error": str(error)}
    previous = dict(getattr(dataset, "chemistry_metadata", {}) or {})
    dataset.consensus_chemistry = chemistry
    dataset.chemistry_metadata = {
        **previous,
        "chemistry": chemistry,
        "source": "user-selection",
        "status": "declared",
        "message": "Assay chemistry selected in the Footprints dataset setup tab.",
        "declaration": {**DECLARATIONS[chemistry], **({"platform": req.platform} if req.platform else {})},
    }
    if req.persist:
        dataset.chemistry_metadata = inspect_dataset_chemistry(dataset.paths or [dataset.path])
        from services.dataset_registration import invalidate_dataset_caches
        invalidate_dataset_caches(state, resolved_id)
    return {"success": True, "dataset": dataset.to_dict(), "saved_paths": saved_paths}


@router.post("/api/datasets/merge")
async def merge_datasets(req: MergeDatasetsRequest,
    state=Depends(get_state)):
    """Merge 2+ datasets into one multi-file dataset."""
    return await asyncio.to_thread(merge_datasets_for_request, state, req)


@router.post("/api/datasets/unmerge")
async def unmerge_dataset(req: UnmergeDatasetsRequest,
    state=Depends(get_state)):
    """Split a multi-file dataset back into individual single-file datasets."""
    return await asyncio.to_thread(unmerge_dataset_for_request, state, req)


@router.post("/api/files/upload")
def upload_file_general(file: UploadFile = File(...)):
    """Upload any file and return the saved path. Used for browser drag-and-drop."""
    from services.upload_store import upload_dir
    return upload_general_file_for_request(file, upload_dir())


@router.post("/api/datasets/drop_window")
async def open_drop_window(state=Depends(get_state)):
    """
    Open a native drag-drop window that can receive files with full path access.
    Uses tkinterdnd2 for drag-drop support, with file browser fallback.
    """
    return launch_drop_window_for_state(state)


@router.get("/api/s3/status")
async def s3_status():
    """Get S3 configuration status."""
    return get_s3_status_payload()


@router.post("/api/s3/configure")
async def configure_s3(
    profile: Optional[str] = Query(None, description="AWS profile name"),
    region: Optional[str] = Query(None, description="AWS region"),
    endpoint_url: Optional[str] = Query(None, description="Custom S3 endpoint URL (Cloudflare R2, MinIO, DigitalOcean Spaces, etc.). Omit for AWS S3."),
):
    """
    Configure S3 credentials + (optional) custom S3-compatible endpoint.

    Credential methods (any combination works):
    1. AWS profile from ~/.aws/credentials
    2. Environment variables (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
    3. IAM roles (EC2/ECS/Lambda)
    4. None — the loader falls back to anonymous access for public buckets.

    For non-AWS S3 (Cloudflare R2, MinIO, ...), pass the service's
    endpoint URL. Requests will be routed there instead of AWS.
    """
    return configure_s3_for_request(profile=profile, region=region, endpoint_url=endpoint_url)


@router.get("/api/s3/test")
async def test_s3_access(url: str = Query(..., description="S3 URL to test (s3://bucket/key)")):
    """
    Test access to an S3 URL.

    Returns accessibility status and file metadata if accessible.
    """
    return test_s3_access_for_request(url)


@router.get("/api/s3/list")
async def list_s3_bucket(
    bucket: str = Query(..., description="S3 bucket name"),
    prefix: str = Query("", description="Key prefix filter"),
    max_keys: int = Query(100, description="Maximum objects to return")
):
    """
    List objects in an S3 bucket.

    Useful for browsing available datasets in a bucket.
    """
    return list_s3_bucket_for_request(bucket, prefix=prefix, max_keys=max_keys)


@router.get("/api/s3/presign")
async def get_presigned_url(
    url: str = Query(..., description="S3 URL (s3://bucket/key)"),
    expiration: int = Query(3600, description="URL expiration in seconds")
):
    """
    Generate a pre-signed URL for an S3 object.

    Pre-signed URLs allow temporary access without exposing credentials.
    Useful for BigBed files which don't support S3 natively.
    """
    return get_presigned_url_for_request(url, expiration=expiration)
