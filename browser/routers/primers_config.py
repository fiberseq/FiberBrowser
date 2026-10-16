"""Primer configuration, setup, progress, and latest-result routes."""
from __future__ import annotations

import asyncio
import os
from typing import Optional
from fastapi import APIRouter, Query, Depends

from state.dependencies import get_state
from services.primer_config import (
    auto_detect_blast_db as _auto_detect_blast_db,
    blast_db_exists as _blast_db_exists,
    build_blast_db_from_fasta as _build_blast_db_from_fasta,
    primer_config_payload as _primer_config_payload,
    scan_blast_dbs as _scan_blast_dbs,
)
from services.file_picker import pick_file_payload, pick_folder_payload
from services.primer_blast_runtime import request_primer_design_abort as _request_primer_design_abort
from services.primer_state import (
    clear_primer_result as _clear_primer_result,
    get_primer_progress as _get_primer_progress,
    get_primer_result as _get_primer_result,
    set_primer_progress_payload as _set_primer_progress_payload,
)

router = APIRouter(tags=["primers"])

@router.post("/api/primer_config")
async def set_primer_config(
    fasta_path: str = Query(None),
    blast_db_path: str = Query(None),
    state=Depends(get_state),
):
    """Configure paths for primer design"""
    from services.primer_config import set_primer_paths
    
    if fasta_path:
        if not os.path.isfile(fasta_path):
            return {"success": False, "message": f"FASTA file not found: {fasta_path}"}
        await asyncio.to_thread(set_primer_paths, state, fasta=fasta_path)
        
    if blast_db_path:
        if not _blast_db_exists(blast_db_path):
            from services.primer_config import blast_db_missing_message
            return {"success": False, "message": blast_db_missing_message(blast_db_path)}
        await asyncio.to_thread(set_primer_paths, state, blast_db=blast_db_path)

    return {"success": True, **(await asyncio.to_thread(_primer_config_payload, state))}


@router.get("/api/primer_config")
async def get_primer_config(state=Depends(get_state)):
    """Get current primer design configuration"""
    # In a worker: resolving the BLAST DB may switch it to the current genome's (published under the lock).
    return await asyncio.to_thread(_primer_config_payload, state)


@router.post("/api/primer_blast_db/build")
async def build_primer_blast_db(
    force: bool = Query(False),
    output_dir: Optional[str] = Query(None),
    state=Depends(get_state),
):
    """Build a local primer BLAST DB from the loaded/reference FASTA."""
    # In a worker: makeblastdb runs, and the paths are published under the state lock.
    return await asyncio.to_thread(_build_blast_db_from_fasta, state, output_dir=output_dir, force=force)


@router.get("/api/pick_file_primer")
def pick_file_primer(
    file_type: str = Query("fasta"),
    dir: Optional[str] = Query(None),
    state=Depends(get_state),
):
    """Open native file/directory picker for primer design files.

    For BLAST, opens a directory picker (or uses ``dir`` when the folder was
    chosen in the in-page browser), scans for .nin files, and returns
    the list of database prefixes found. If exactly one DB is found, ``path``
    is set directly; otherwise ``databases`` contains the choices.
    """
    try:
        if file_type == "blast":
            if dir:
                dir_path = os.path.abspath(os.path.expanduser(dir))
            else:
                # Same dialog handling as every other picker, so a dialog
                # that cannot open is reported as such (not as a cancel).
                picked = pick_folder_payload("Select directory containing BLAST database files")
                if not picked.get("success"):
                    return picked
                dir_path = picked["path"].rstrip("/") or "/"
            if not os.path.isdir(dir_path):
                return {"success": False, "path": None, "message": f"Not a folder: {dir_path}"}

            prefixes = _scan_blast_dbs(dir_path)
            if not prefixes:
                from services.primer_config import blast_db_missing_message, unopenable_blast_dbs
                unopenable = unopenable_blast_dbs(dir_path)
                message = (blast_db_missing_message(unopenable[0]) if unopenable
                           else f"No BLAST databases found in {dir_path}")
                return {"success": False, "path": None, "message": message}
            if len(prefixes) == 1:
                return {"success": True, "path": prefixes[0]}
            # Multiple DBs — try auto-detect from genome/fasta name
            recommended = _auto_detect_blast_db(prefixes, state)
            if recommended:
                return {"success": True, "path": recommended, "databases": prefixes}
            return {"success": True, "path": None, "databases": prefixes}
        return pick_file_payload("fasta")

    except Exception as e:
        return {"success": False, "path": None, "message": str(e)}



@router.get("/api/primer_progress")
async def get_primer_progress():
    """Get primer design progress"""
    return _get_primer_progress()


@router.post("/api/primer_abort")
async def abort_primer_design():
    """Abort a running primer design."""
    _request_primer_design_abort()
    _set_primer_progress_payload({"active": False, "stage": "aborted", "progress": 0, "message": "Aborted"})
    return {"success": True}

@router.get("/api/primers")
async def get_primers(state=Depends(get_state)):
    """Get currently designed primers"""
    result = _get_primer_result(state)
    if result:
        return {"success": True, **result}
    return {"success": False, "message": "No primers designed"}


@router.delete("/api/primers")
async def clear_primers(state=Depends(get_state)):
    """Clear designed primers"""
    _clear_primer_result(state)
    return {"success": True}
