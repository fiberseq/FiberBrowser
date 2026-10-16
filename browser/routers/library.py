"""The Library: the user's own datasets, watched folders and experiment groups.

Local servers only: every route refuses a ``--public`` server and a tour-tab
sandbox (``local_only``; the public-mode guard refuses them too). Routes
address entries, groups and folders by id; only adding files or a watched
folder and "Locate…" take a path from the client, and those are checked
like every other local path the browser opens.
"""
from __future__ import annotations

import asyncio
import os
from typing import Any, Optional

from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import BaseModel, Field

from services.local_paths import normalize_local_path, path_access_error

router = APIRouter(tags=["library"])

LOCAL_ONLY = "The Library is only available in FiberBrowser on your own computer."


def local_only() -> None:
    from services.runtime import get_public_mode
    if get_public_mode():  # --public, and tour-tab sandboxes
        raise HTTPException(status_code=403, detail=LOCAL_ONLY)


LOCAL = [Depends(local_only)]


def runs_allowed() -> None:
    """Re-call starts a run: on a lab server only with ``[jobs] enabled = true``."""
    from services.lab.jobs import refusal
    lab_refusal = refusal()
    if lab_refusal:
        raise HTTPException(status_code=403, detail=lab_refusal)


class EntryEdit(BaseModel):
    tags: Optional[list[str]] = None
    notes: Optional[str] = None
    label: Optional[str] = None


class IdList(BaseModel):
    ids: list[str] = Field(default_factory=list)


class GroupCreate(BaseModel):
    name: str
    entry_ids: list[str] = Field(default_factory=list)
    description: str = ""


class GroupEdit(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    add: list[str] = Field(default_factory=list)
    remove: list[str] = Field(default_factory=list)


class CatalogRequest(BaseModel):
    group_ids: list[str] = Field(default_factory=list)
    name: Optional[str] = None
    relative: bool = False


class WatchRequest(BaseModel):
    path: str
    max_depth: int = 6
    scan: bool = True


def _checked_path(raw: str, expected: str) -> str:
    from services.lab.paths import confine
    path = normalize_local_path(raw)
    if "://" in path:
        raise HTTPException(status_code=400, detail="The Library lists files on this computer (not URLs).")
    confine(raw)  # a lab server: only inside its data folders (403)
    error = path_access_error(path, original_path=raw, expected=expected)
    if error:
        raise HTTPException(status_code=400, detail=error)
    return os.path.abspath(os.path.expanduser(path))


def _not_found(exc: KeyError) -> HTTPException:
    return HTTPException(status_code=404, detail="Not in the Library.")


@router.get("/api/library", dependencies=LOCAL)
async def library_list():
    """Every entry (with availability and re-run flags), groups, watched folders and scan status."""
    from services.library_endpoint import library_payload
    return await asyncio.to_thread(library_payload)


@router.post("/api/library/entries", dependencies=LOCAL)
async def library_add_files(paths: list[str] = Body(..., embed=True)):
    """Add files (BAM, BigBed, plasmid map) to the Library without opening them."""
    from services.library_endpoint import add_files
    checked = [_checked_path(p, "file") for p in paths[:500]]
    return await asyncio.to_thread(add_files, checked)


@router.get("/api/library/entries/{entry_id}", dependencies=LOCAL)
async def library_get_entry(entry_id: str):
    """One entry in full (every contig, FiberHMM programs, run settings)."""
    from services.library_endpoint import get_entry_view
    try:
        return {"entry": await asyncio.to_thread(get_entry_view, entry_id)}
    except KeyError as exc:
        raise _not_found(exc) from exc


@router.patch("/api/library/entries/{entry_id}", dependencies=LOCAL)
async def library_edit_entry(entry_id: str, body: EntryEdit):
    """Tags, notes and display label (what the user adds; never the file)."""
    from services.library_store import annotate
    try:
        entry = await asyncio.to_thread(annotate, entry_id, tags=body.tags, notes=body.notes, label=body.label)
    except KeyError as exc:
        raise _not_found(exc) from exc
    return {"success": True, "entry": entry}


@router.post("/api/library/entries/remove", dependencies=LOCAL)
async def library_remove_entries(body: IdList):
    """Forget entries. Files on disk are never deleted."""
    from services.library_store import remove_entries
    return {"success": True, "removed": await asyncio.to_thread(remove_entries, body.ids)}


@router.post("/api/library/entries/{entry_id}/rescan", dependencies=LOCAL)
async def library_rescan_entry(entry_id: str):
    """Read the file's header (and QC files) again."""
    from services.library_endpoint import rescan_entry
    try:
        return await asyncio.to_thread(rescan_entry, entry_id)
    except KeyError as exc:
        raise _not_found(exc) from exc


@router.post("/api/library/entries/{entry_id}/locate", dependencies=LOCAL)
async def library_locate_entry(entry_id: str, path: str = Body(..., embed=True),
                               confirm: bool = Body(False, embed=True)):
    """A moved file: point the entry at its new location (only if it is the same data;
    an entry without a content digest needs ``confirm``)."""
    from services.library_endpoint import locate_entry
    checked = _checked_path(path, "file")
    try:
        return await asyncio.to_thread(locate_entry, entry_id, checked, confirm=bool(confirm))
    except KeyError as exc:
        raise _not_found(exc) from exc


@router.post("/api/library/entries/{entry_id}/reveal", dependencies=LOCAL)
async def library_reveal_entry(entry_id: str):
    """Show the file in Finder / Explorer / the file manager."""
    from services.library_endpoint import reveal_entry
    try:
        return await asyncio.to_thread(reveal_entry, entry_id)
    except KeyError as exc:
        raise _not_found(exc) from exc


@router.get("/api/library/entries/{entry_id}/qc", dependencies=LOCAL)
async def library_entry_qc(entry_id: str):
    """fiberhmm-qc verdicts, metrics and curves found beside the BAM (for the QC panel)."""
    from services.library_endpoint import entry_qc_payload
    try:
        return await asyncio.to_thread(entry_qc_payload, entry_id)
    except KeyError as exc:
        raise _not_found(exc) from exc


@router.post("/api/library/entries/{entry_id}/qc/run", dependencies=[*LOCAL, Depends(runs_allowed)])
async def library_run_entry_qc(entry_id: str, confirm: bool = Body(False, embed=True)):
    """Run fiberhmm-qc on the entry's BAM without opening it (cached per file version, kept
    with the entry). An online-only file answers ``needs_confirmation`` first: running
    downloads it; ``confirm`` runs anyway."""
    from services.library_qc import run_entry_qc
    try:
        return await asyncio.to_thread(run_entry_qc, entry_id, confirm=bool(confirm))
    except KeyError as exc:
        raise _not_found(exc) from exc


@router.get("/api/library/entries/{entry_id}/qc/files/{name}", dependencies=LOCAL)
async def library_entry_qc_file(entry_id: str, name: str):
    """A QC figure/report of the entry (only files its QC lists)."""
    from services.library_endpoint import open_entry_qc_file
    try:
        opened = await asyncio.to_thread(open_entry_qc_file, entry_id, name)
    except KeyError as exc:
        raise _not_found(exc) from exc
    if not opened:
        raise HTTPException(status_code=404, detail="No such file.")
    handle, filename, size = opened
    from services.file_responses import opened_file_response
    return opened_file_response((handle, filename, size), filename)  # Range/ETag from the checked descriptor


@router.post("/api/library/entries/{entry_id}/recall", dependencies=[*LOCAL, Depends(runs_allowed)])
async def library_recall_entry(entry_id: str, body: dict[str, Any] = Body(default_factory=dict)):
    """Re-call with the current FiberHMM, keeping the original run's settings: ``dry_run`` returns
    the plan (with its ``plan_id``); starting needs that ``plan_id`` and runs exactly that plan."""
    from services.library_endpoint import recall_entry
    options = {k: body.get(k) for k in ("dry_run", "cores", "plan_id") if k in body}
    if body.get("outdir"):
        options["outdir"] = _checked_output(str(body["outdir"]))
    if body.get("input"):  # the input the BAM header names, located by the user
        options["input"] = _checked_input(str(body["input"]))
    keep_old = body.get("keep_old")
    if keep_old:
        if not isinstance(keep_old, list) or not all(isinstance(k, str) and len(k) < 64 for k in keep_old):
            raise HTTPException(status_code=400, detail="keep_old: a list of default changes to undo.")
        options["keep_old"] = keep_old
    try:
        return await asyncio.to_thread(recall_entry, entry_id, options)
    except KeyError as exc:
        raise _not_found(exc) from exc


def _checked_input(raw: str) -> str:
    from services.lab.paths import confine
    path = normalize_local_path(raw)
    if "://" in path:
        raise HTTPException(status_code=400, detail="Choose a file on this computer.")
    confine(raw)  # a lab server: inside a data root (403)
    return os.path.abspath(os.path.expanduser(path))


def _checked_output(raw: str) -> str:
    from services.lab.paths import confine
    path = normalize_local_path(raw)
    if "://" in path:
        raise HTTPException(status_code=400, detail="Choose a folder on this computer.")
    confine(raw, write=True)  # a lab server: a writable data root (403)
    return os.path.abspath(os.path.expanduser(path))


@router.post("/api/library/groups", dependencies=LOCAL)
async def library_create_group(body: GroupCreate):
    from services.library_store import create_group
    try:
        return {"success": True, "group": await asyncio.to_thread(create_group, body.name, body.entry_ids, body.description)}
    except ValueError as exc:
        return {"success": False, "error": str(exc)}


@router.patch("/api/library/groups/{group_id}", dependencies=LOCAL)
async def library_edit_group(group_id: str, body: GroupEdit):
    from services.library_store import edit_group
    try:
        group = await asyncio.to_thread(edit_group, group_id, name=body.name, description=body.description,
                                        add=body.add, remove=body.remove)
    except KeyError as exc:
        raise _not_found(exc) from exc
    except ValueError as exc:
        return {"success": False, "error": str(exc)}
    return {"success": True, "group": group}


@router.delete("/api/library/groups/{group_id}", dependencies=LOCAL)
async def library_delete_group(group_id: str):
    """Delete a group (its entries stay in the Library)."""
    from services.library_store import delete_group
    return {"success": await asyncio.to_thread(delete_group, group_id)}


@router.post("/api/library/catalog", dependencies=LOCAL)
async def library_export_catalog(body: CatalogRequest):
    """Groups as a --catalog JSON for a public or reviewer deployment."""
    from services.library_catalog import build_catalog
    from services.library_store import load
    try:
        result = await asyncio.to_thread(lambda: build_catalog(load(), body.group_ids, name=body.name,
                                                               relative=body.relative))
    except KeyError as exc:
        raise _not_found(exc) from exc
    return {"success": True, **result}


@router.post("/api/library/watched", dependencies=LOCAL)
async def library_add_watched(body: WatchRequest):
    """Watch a folder: its BAMs, BigBeds and plasmid maps are added (headers only; nothing is written there)."""
    from services.library_scan import runner
    from services.library_store import add_watched
    folder = _checked_path(body.path, "folder")
    if not os.path.isdir(folder):
        raise HTTPException(status_code=400, detail=f"Not a folder: {folder}")
    real = os.path.realpath(folder)
    if os.path.dirname(real) == real:  # "/" or a drive root: every file on the disk
        raise HTTPException(status_code=400, detail="Choose the folder your data is in, not the whole disk.")
    watched = await asyncio.to_thread(add_watched, folder, body.max_depth)
    if body.scan:
        runner().request([watched["id"]])
    return {"success": True, "watched": watched}


@router.delete("/api/library/watched/{folder_id}", dependencies=LOCAL)
async def library_remove_watched(folder_id: str):
    """Stop watching a folder (its entries stay; remove them separately)."""
    from services.library_store import remove_watched
    return {"success": await asyncio.to_thread(remove_watched, folder_id)}


@router.post("/api/library/scan", dependencies=LOCAL)
async def library_scan(folder_ids: list[str] = Body(default_factory=list, embed=True)):
    """Rescan watched folders now (all of them when none is named)."""
    from services.library_scan import runner
    from services.library_store import load
    watched = (await asyncio.to_thread(load))["watched"]
    ids = [f for f in folder_ids if f in watched] if folder_ids else list(watched)
    return {"success": True, "queued": runner().request(ids) if ids else [], "requested": ids}


@router.get("/api/library/scan", dependencies=LOCAL)
async def library_scan_status():
    from services.library_scan import status
    return status()


class FolderScanRequest(BaseModel):
    path: str
    mode: str = "folder"  # the folder and its run-output sub-folders; "deep": the watched-folder depth
    paths: list[str] = Field(default_factory=list)


def _checked_scan_folder(raw: str) -> str:
    """A suggested experiment's folder: a local folder this request may read. A
    missing or unreadable folder is answered in words by the scan (not refused here)."""
    from services.lab.paths import confine
    path = normalize_local_path(raw)
    if "://" in path:
        raise HTTPException(status_code=400, detail="Only folders on this computer can be scanned.")
    confine(raw)  # a lab server: only inside its data folders (403)
    return os.path.abspath(os.path.expanduser(path))


@router.post("/api/library/folder/preview", dependencies=LOCAL)
async def library_folder_preview(body: FolderScanRequest):
    """What one folder holds that the Library lists, before a suggested experiment is
    opened or saved (the watched-folder scanner's rules; nothing is recorded or watched)."""
    from services.library_folder_scan import preview
    folder = _checked_scan_folder(body.path)
    return await asyncio.to_thread(preview, folder, body.mode)


@router.post("/api/library/folder/add", dependencies=LOCAL)
async def library_folder_add(body: FolderScanRequest):
    """Add the chosen files of a scanned folder (each must be one its scan finds);
    answers every chosen file's entry id, already-listed ones included."""
    from services.library_folder_scan import add
    folder = _checked_scan_folder(body.path)
    return await asyncio.to_thread(add, folder, body.paths, body.mode)
