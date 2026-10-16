"""Connect to cluster…: remote storage sources and their file browser (local servers only).

Datasets, FASTA and plasmid maps on a connected cluster are then loaded with
the usual routes (/api/datasets/add, /api/load_fasta, /api/load_plasmids,
/api/plasmid/open) using their ``ssh://host/abs/path`` reference.
"""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Body, HTTPException, Query

from services import remote_endpoint

router = APIRouter(tags=["remote"])


def _guard() -> None:
    try:
        remote_endpoint.ensure_local_mode()
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc


@router.get("/api/remote/sources")
def remote_sources(probe: bool = Query(True)):  # sync: may ping the helpers
    """Available sources (SSH, S3), the SSH hosts in ~/.ssh/config, and live connections."""
    _guard()
    return remote_endpoint.sources_status(probe=probe)


@router.post("/api/remote/connect")
async def remote_connect(
    source: str = Body("ssh", embed=True),
    host: str | None = Body(None, embed=True),
    user: str | None = Body(None, embed=True),
    roots: list[str] = Body(default_factory=list, embed=True),
    remote_python: str | None = Body(None, embed=True),
    open_terminal: bool = Body(True, embed=True),
    profile: str | None = Body(None, embed=True),
    region: str | None = Body(None, embed=True),
    endpoint_url: str | None = Body(None, embed=True),
):
    """Start connecting (returns at once; poll /api/remote/sources for the state).

    SSH: reuses an open ControlMaster, else signs in with keys, else opens a
    terminal for password/Duo. Then runs the read-only helper over SSH.
    """
    _guard()
    params = {"source": source, "host": host, "user": user, "roots": roots, "remote_python": remote_python,
              "open_terminal": open_terminal, "profile": profile, "region": region, "endpoint_url": endpoint_url}
    return await asyncio.to_thread(remote_endpoint.connect, params)


@router.post("/api/remote/disconnect")
async def remote_disconnect(
    source: str = Body("ssh", embed=True),
    target: str = Body(..., embed=True),
    close_master: bool = Body(False, embed=True),
):
    """Stop the helper and the port forward (and, if asked, FiberBrowser's SSH master)."""
    _guard()
    return await asyncio.to_thread(remote_endpoint.disconnect,
                                   {"source": source, "target": target, "close_master": close_master})


@router.get("/api/remote/list")
def remote_list(ref: str = Query(..., max_length=4096)):  # sync: network I/O in the threadpool
    """One folder of a connected source: entries with reference, kind and index presence."""
    _guard()
    return remote_endpoint.list_folder(ref)


@router.post("/api/remote/refs_status")
def remote_refs_status(refs: list[str] = Body(..., embed=True)):
    """Which references can be opened now, grouped by host with their folders."""
    _guard()
    return remote_endpoint.refs_status(refs[:2000])
