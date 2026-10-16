"""Gene search, file picker, BAM diagnostics, folder loading endpoints.

Extracted from server.py.
"""
from __future__ import annotations

from fastapi import APIRouter, Query, Depends

from state.dependencies import get_state
from services.file_picker import pick_file_payload, pick_folder_payload
from services.files_endpoint import (
    diagnose_bam_payload,
    load_folder_for_request,
    search_gene_payload,
)

router = APIRouter(tags=["files"])


@router.get("/api/gene_search")
async def search_gene(query: str = Query(...), chrom: str = Query(None),
    state=Depends(get_state)):
    return search_gene_payload(state, query, chrom)


# Sync handlers: a native dialog blocks for as long as it is open, which must
# not freeze the event loop (and every other request) meanwhile.
@router.get("/api/pick_folder")
def pick_folder(prompt: str = Query("Select Fiber-seq BigBed Folder")):
    """Open native file picker dialog to select a folder"""
    return pick_folder_payload(prompt)


@router.get("/api/pick_file")
def pick_file(file_type: str = Query("gtf"), overlay_type: str = Query(None), multiple: bool = Query(False)):
    """Open native file picker dialog to select a file (or multiple files if multiple=True)"""
    return pick_file_payload(file_type, overlay_type, multiple)


@router.get("/api/files/list")
def list_server_directory(path: str = Query(None, description="Directory to list; default: home")):
    """List a server directory for the in-page file browser.

    Used when the browser is not on the server's machine (so a native dialog
    would open on the wrong screen) or no native dialog is available.
    """
    from services.file_picker import list_directory_payload

    return list_directory_payload(path)


@router.get("/api/diagnose_bam")
async def diagnose_bam_endpoint(
    bam_path: str = Query(None, description="Path to BAM file to diagnose"),
    dataset_idx: int = Query(0, description="Dataset index to diagnose (if bam_path not provided)"),
    chrom: str = Query(None, description="Chromosome to sample reads from"),
    limit: int = Query(10, description="Number of reads to check"),
    state=Depends(get_state)):
    """
    Diagnose a BAM file to check what Fiber-seq tags are present.
    
    This helps debug loading issues by showing:
    - What tags are present in the BAM file
    - Whether required Fiber-seq tags (ns/nl, as/al, MM/ML) exist
    - Example values for each tag
    """
    return diagnose_bam_payload(
        state,
        bam_path=bam_path,
        dataset_idx=dataset_idx,
        chrom=chrom,
        limit=limit,
    )


@router.post("/api/load_folder")
async def load_folder(path: str = Query(...),
    state=Depends(get_state)):
    """Load a BigBed folder as a new dataset"""
    try:
        import asyncio
        # In a worker: registering the dataset waits for the state lock (services/genome_loading).
        return await asyncio.to_thread(load_folder_for_request, state, path)
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"success": False, "message": str(e)}
