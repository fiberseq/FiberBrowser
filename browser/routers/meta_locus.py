"""Meta-locus endpoints (services/meta_locus_jobs): a BED file's reads pooled into one virtual locus.

Not on a --public server (local BED paths and background builds; tests/test_public_mode_guard.py lists them denied).
"""
from __future__ import annotations

from fastapi import APIRouter, Body, Depends, HTTPException, Request

from state.dependencies import get_state

router = APIRouter(tags=["meta_locus"])


def _read_bed(path: str) -> tuple[list, str]:
    import os
    from routers.files import parse_bed_regions, read_bed_text

    text, full = read_bed_text(path)
    return parse_bed_regions(text)["regions"], os.path.basename(full).removesuffix(".gz").removesuffix(".bed")


MAX_UPLOADED_BED_CHARS = 64 * 1024 * 1024


def _uploaded_bed_folder(cache_root):
    """Where an uploaded BED is kept. On a lab server: a folder in the lab's uploads directory (a read root), so
    the returned path passes the lab's path rules when a session, a link or the dialog reopens it (the cache folder
    is outside them). Elsewhere: the meta-locus cache. (Not swept by the upload retention, which keeps to the
    uploads directory's own files.)"""
    from pathlib import Path
    from services.lab import get_config
    cfg = get_config()
    if cfg is not None and getattr(cfg, "uploads_dir", None):
        return Path(cfg.uploads_dir) / "meta_locus_beds"
    return cache_root() / "beds"


def _store_uploaded_bed(text: str, filename: str) -> tuple[list, str, str]:
    import hashlib
    import os
    from routers.files import parse_bed_regions
    from services.meta_locus_pool import cache_root
    if len(text) > MAX_UPLOADED_BED_CHARS:
        raise HTTPException(status_code=413, detail="BED file too large to upload (over 64 MB); give its path instead")
    parsed = parse_bed_regions(text)
    if not parsed["regions"]:
        raise HTTPException(status_code=422, detail=f"No BED regions in {filename} ({parsed['skipped']} lines could not be read)")
    name = os.path.basename(filename).removesuffix(".gz").removesuffix(".bed") or "regions"
    folder = _uploaded_bed_folder(cache_root)
    folder.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]
    path = folder / f"{name}.{digest}.bed"
    if not path.exists():
        tmp = path.with_suffix(f".tmp{os.getpid()}")
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, path)
    return parsed["regions"], name, str(path)


@router.post("/api/meta_locus/pools")
def start_meta_locus_pool(body: dict = Body(...), state=Depends(get_state)):
    """Start building a pool in the background (or return the running / finished pool of the same spec).

    Body: bed_path or regions [[chrom, start, end, strand, name]...], name, dataset_ids, and any pool rule
    (services/meta_locus_pool.DEFAULTS: anchor, flank_bp, policy, min_overlap_bp, block_max_gap_bp, block_max_len_bp,
    bam_threads, max_entries) plus workers. Answer: the pool's status (poll GET /api/meta_locus/pools/{id})."""
    from services.meta_locus_jobs import PoolsFull, start_pool

    if body.get("bed_text") is not None:
        # A BED chosen in the browser (a file input gives contents, not a path): parsed here and kept in the cache
        # folder under its content hash, so the URL and sessions name a file the server can reopen.
        regions, name, saved = _store_uploaded_bed(str(body["bed_text"]), str(body.get("bed_name") or "regions.bed"))
        body = {**body, "bed_path": saved}
    elif body.get("bed_path"):
        regions, name = _read_bed(body["bed_path"])
    else:
        regions, name = [r for r in (body.get("regions") or []) if isinstance(r, (list, tuple)) and len(r) >= 3], "regions"
    if not regions:
        raise HTTPException(status_code=422, detail="The BED has no usable regions (each line needs chrom, start, end with start < end)")
    try:
        pool = start_pool(state, body, regions, str(body.get("name") or name))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=f"No dataset {exc}") from exc
    except PoolsFull as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return pool.as_status()


@router.post("/api/meta_locus/pools/probe")
def probe_meta_locus_pool(body: dict = Body(...), state=Depends(get_state)):
    """Is the pool of this spec built already? (cached: opens instantly). A missing BED answers cached false."""
    from services.meta_locus_jobs import probe_pool
    try:
        if body.get("bed_path"):
            regions, _name = _read_bed(body["bed_path"])
        else:
            regions = [r for r in (body.get("regions") or []) if isinstance(r, (list, tuple)) and len(r) >= 3]
        return probe_pool(state, body, regions)
    except HTTPException:
        return {"success": True, "cached": False}
    except (KeyError, ValueError):
        return {"success": True, "cached": False}


@router.get("/api/meta_locus/pools")
def list_meta_locus_pools():
    from services.meta_locus_jobs import list_pools
    return {"success": True, "pools": list_pools()}


def _pool(pool_id: str):
    from services.meta_locus_jobs import get_pool
    pool = get_pool(pool_id)
    if pool is None:
        raise HTTPException(status_code=404, detail=f"No meta-locus pool {pool_id}")
    return pool


@router.get("/api/meta_locus/pools/{pool_id}")
def meta_locus_pool_status(pool_id: str):
    """Status and progress: sites, compressed bytes and entries done, fraction, ETA; per dataset cached / building."""
    return _pool(pool_id).as_status()


@router.post("/api/meta_locus/pools/{pool_id}/cancel")
def cancel_meta_locus_pool(pool_id: str):
    from services.meta_locus_jobs import cancel_pool
    _pool(pool_id)
    return cancel_pool(pool_id).as_status()


@router.delete("/api/meta_locus/pools/{pool_id}")
def drop_meta_locus_pool(pool_id: str):
    from services.meta_locus_jobs import drop_pool
    return {"success": drop_pool(pool_id)}


@router.post("/api/meta_locus/pools/{pool_id}/reads")
async def meta_locus_reads(pool_id: str, request: Request, body: dict = Body(default={}), state=Depends(get_state)):
    """A working set, More reads or Resample (services/meta_locus_jobs.working_set): body seed, cursor
    {dataset: ranks taken}, count, and the display's read filters. Reads are in window coordinates [0, width)
    (virtual = x + offset), minus-strand sites flipped, each with its provenance in ``meta``."""
    import asyncio
    import threading
    from starlette.concurrency import run_in_threadpool
    from services.meta_locus_jobs import working_set

    pool = _pool(pool_id)
    gone = threading.Event()

    async def watch():
        while not gone.is_set():
            if await request.is_disconnected():
                gone.set()
                return
            await asyncio.sleep(0.25)

    watcher = asyncio.create_task(watch())
    try:
        out = await run_in_threadpool(working_set, pool, body or {}, state, gone.is_set)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    finally:
        gone.set()
        watcher.cancel()
    return out


@router.get("/api/meta_locus/pools/{pool_id}/view")
def meta_locus_view(pool_id: str):
    from services.meta_locus_jobs import view_payload
    return {"success": True, **view_payload(_pool(pool_id))}


@router.post("/api/meta_locus/pools/{pool_id}/view")
def meta_locus_set_view(pool_id: str, body: dict = Body(default={})):
    """What the virtual contig shows: seed, count, more, resample, clear_extra, extra_entries (a session's)."""
    from services.meta_locus_jobs import set_view
    pool = _pool(pool_id)
    if pool.status != "ready" and not pool.indexes and not pool.partial:
        raise HTTPException(status_code=409, detail="The pool has no reads yet")
    try:
        return {"success": True, **set_view(pool, body or {})}
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


async def _scan_route(request: Request, fn, pool, body):
    import asyncio
    import threading
    from starlette.concurrency import run_in_threadpool
    gone = threading.Event()

    async def watch():
        while not gone.is_set():
            if await request.is_disconnected():
                gone.set()
                return
            await asyncio.sleep(0.25)

    watcher = asyncio.create_task(watch())
    try:
        return await run_in_threadpool(fn, pool, body or {}, gone.is_set)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    finally:
        gone.set()
        watcher.cancel()


@router.post("/api/meta_locus/pools/{pool_id}/refill")
async def meta_locus_refill(pool_id: str, request: Request, body: dict = Body(default={})):
    """Keep the workspace full: top up each cluster from the pool (services/meta_locus_refill)."""
    from services.meta_locus_refill import refill
    return await _scan_route(request, refill, _pool(pool_id), body)


@router.post("/api/meta_locus/pools/{pool_id}/find_more")
async def meta_locus_find_more(pool_id: str, request: Request, body: dict = Body(default={})):
    """Find more like the selected reads, with matches / read-site observations scanned (Wilson 95%)."""
    from services.meta_locus_refill import find_more
    return await _scan_route(request, find_more, _pool(pool_id), body)
