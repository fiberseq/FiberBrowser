"""The app's own settings and its update check (owner only: not on a public server, a lab server or a remote
device; services/public_mode_guard.py, services/lab/auth.py, services/remote_access.py).

- ``GET /api/app/info``: the build, which FiberHMM runs (and why), the update settings and what can sign in to
  GitHub (never a token).
- ``POST /api/app/fiberhmm``: the app's FiberHMM choice (bundled or a custom source tree); takes effect at the
  next start.
- ``GET /api/app/update``: the update check (``startup=1``: the quiet check at startup; ``force=1``: not cached).
- ``POST /api/app/update/settings``: the check at startup, the manifest address, the repository.
- ``POST`` / ``DELETE /api/app/update/token``: a GitHub token kept in the OS keychain.
- ``POST /api/app/update/download``, ``GET`` it, ``POST .../cancel``, ``POST /api/app/update/open``.
"""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException
from state.dependencies import get_state
from models.requests import PerformanceModeRequest

router = APIRouter(tags=["app"])


@router.get("/api/app/performance")
def get_performance(state=Depends(get_state)):
    from services.performance import diagnostics
    return diagnostics(state)


@router.post("/api/app/performance")
def set_performance(request: PerformanceModeRequest, state=Depends(get_state)):
    from services import app_settings
    from services.performance import apply_machine_mode, effective_mode, machine_hardware
    mode = request.mode
    tier = request.browser_tier
    try:
        effective_mode(mode, machine_hardware(), tier)
        if request.persist:
            app_settings.update('performance', {'mode': mode})
        return apply_machine_mode(state, mode, tier)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


def _info() -> dict:
    from services import app_settings, app_update, github_auth
    from services.app_build import build_info, is_packaged, platform_key
    from services.fiberhmm_runtime import describe_fiberhmm, fiberhmm_selection
    from version import __version__
    config = app_update.channel_config()
    return {
        "version": __version__,
        "packaged": is_packaged(),
        "build": build_info(),
        "platform": platform_key(),
        "fiberhmm": {**fiberhmm_selection(), "running": describe_fiberhmm()},
        "updates": {**app_settings.load()["updates"], "channel": config["channel"], "source": config["source"],
                    "where": config["manifest_url"] or " or ".join(config["repos"]),
                    "manifest_from": config["manifest_from"], "private": config["private"],
                    "disabled": app_update.disabled_reason(), "pip_command": app_update.PIP_COMMAND,
                    # Unset, the check at startup follows the kind of run (on in an app, off in a source run).
                    "check_at_startup_default": app_settings.default_check_at_startup(),
                    "check_at_startup_set": app_settings.check_at_startup_is_set()},
        "auth": github_auth.auth_status() if config["private"] else None,
    }


@router.get("/api/app/info")
async def app_info():
    return await asyncio.to_thread(_info)


@router.post("/api/app/fiberhmm")
async def set_fiberhmm(request: dict):
    from services import app_settings
    from services.fiberhmm_runtime import _valid_source_tree, missing_features, package_version
    source = request.get("source")
    path = str(request.get("custom_path") or "").strip()
    report = None
    if source == "custom":
        if not path:
            raise HTTPException(status_code=422, detail="Choose the FiberHMM source folder.")
        root = _valid_source_tree(path)
        if root is None:
            raise HTTPException(status_code=422, detail=f"{path} is not a FiberHMM source tree "
                                                        "(no fiberhmm/ package in it).")
        missing = missing_features(root / "fiberhmm")
        report = {"path": str(root), "version": package_version(root / "fiberhmm"), "missing": missing}
    try:
        values = {"source": source} if source != "custom" else {"source": source, "custom_path": path}
        await asyncio.to_thread(app_settings.update, "fiberhmm", values)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    info = await asyncio.to_thread(_info)
    return {**info, "checked": report}


@router.get("/api/app/update")
async def update_check(startup: bool = False, force: bool = False):
    from services import app_update
    return await asyncio.to_thread(app_update.check, startup=startup, force=force)


@router.post("/api/app/update/settings")
async def update_settings(request: dict):
    from services import app_settings, app_update
    try:
        await asyncio.to_thread(app_settings.update, "updates", request)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    app_update.forget_check()
    return await asyncio.to_thread(_info)


@router.post("/api/app/update/token")
async def set_token(request: dict):
    from services import app_update, github_auth
    token = str(request.get("token") or "").strip()
    if not github_auth.valid_token(token):
        raise HTTPException(status_code=422, detail="That doesn't look like a GitHub token.")
    try:
        await asyncio.to_thread(github_auth.token_store().set, token)
    except github_auth.GitHubError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    app_update.forget_check()
    return {"auth": await asyncio.to_thread(github_auth.auth_status)}


@router.delete("/api/app/update/token")
async def delete_token():
    from services import app_update, github_auth
    await asyncio.to_thread(github_auth.token_store().delete)
    app_update.forget_check()
    return {"auth": await asyncio.to_thread(github_auth.auth_status)}


@router.post("/api/app/update/download")
async def start_download():
    from services import app_update
    try:
        return await asyncio.to_thread(app_update.start_download)
    except app_update.UpdateError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@router.get("/api/app/update/download")
async def download_status():
    from services import app_update
    return app_update.download_status()


@router.post("/api/app/update/download/cancel")
async def cancel_download():
    from services import app_update
    return app_update.cancel_download()


@router.post("/api/app/update/open")
async def open_download():
    from services import app_update
    try:
        return await asyncio.to_thread(app_update.open_download)
    except app_update.UpdateError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
