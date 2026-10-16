"""Version endpoint for the welcome-screen update banner.

For the owner of a personal server, the answer comes from the app's update check (services/app_update.py: this
build's channel, cached for an hour, a failure for ten minutes), as the quiet check at startup: nothing is fetched
when that check is off (off by default in source runs; Settings > FiberHMM & Updates, or ``FIBERBROWSER_NO_UPDATE_CHECK``). Fails gracefully: when the check can't answer, the
endpoint returns the local version with ``update_available: false`` so the banner stays hidden. Anyone else (a
public or lab server's visitors, another device) gets the local version only.
"""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Request

from version import __version__

router = APIRouter(tags=["version"])


def _owner_of_a_personal_server(request: Request) -> bool:
    """Only the owner of a personal server sees the update check: never a public server's visitor, a lab
    server's member or another device (the check may use this computer's GitHub sign-in)."""
    from services.remote_access import owner_request
    from services.runtime import get_lab_mode, get_public_mode
    return not get_public_mode() and not get_lab_mode() and owner_request(request.scope)


def _latest() -> dict:
    from services import app_update
    try:
        return app_update.check(startup=True)
    except Exception as error:  # never fail the page over the banner
        return {"status": "error", "message": str(error)}


@router.get("/api/version")
async def get_version(request: Request):
    """Return current FiberBrowser version and update-available status.

    Response shape:
      current:          "2.10.0"
      latest:           "2.11.0" | null  (null when the check is off or can't answer)
      update_available: bool             (false when latest is null or <= current)
      release_url:      str | null       (the release notes when known)
      release_name:     str | null
      flavor:           "public" (the unified release; plugins/packs.py)
    """
    # The check may be a blocking HTTPS request: off the event loop, so it never stalls the other requests.
    result = await asyncio.to_thread(_latest) if _owner_of_a_personal_server(request) else {}
    from plugins.packs import build_flavor
    latest = result.get("latest")
    return {
        "flavor": build_flavor(),
        "current": __version__,
        "latest": latest,
        "update_available": result.get("status") == "update_available",
        "release_url": result.get("notes_url") if latest else None,
        "release_name": f"FiberBrowser {latest}" if latest else None,
    }
