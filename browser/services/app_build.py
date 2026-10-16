"""Is this a packaged FiberBrowser (the Mac app, the Windows app's WSL distribution), and what build is it?

The build scripts write a small JSON file into the bundle (``FiberBrowser.app/Contents/Resources/
fiberbrowser-build.json``; ``/opt/fiberbrowser/share/fiberbrowser/build.json`` in the WSL distribution):

    {"schema": "fiberbrowser.build.v1", "flavor": "lab", "channel": "lab", "version": "3.0.0",
     "build": "20261005.1432", "commit": "6ca63fa7", "platform": "macos-arm64",
     "fiberhmm_version": "3.0.0", "update_manifest_url": "", "update_repo": ""}

A process is a packaged app when it is the frozen Mac app or that file is present. Source runs (``python
browser.py``) and pip installs have neither: they keep their own rules (services/fiberhmm_runtime.py).
"""
from __future__ import annotations

import json
import platform
import sys
from pathlib import Path
from typing import Optional

BUILD_INFO_SCHEMA = "fiberbrowser.build.v1"
MAC_BUILD_INFO = "fiberbrowser-build.json"


def is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def build_info_candidates() -> list[Path]:
    out: list[Path] = []
    if is_frozen():
        out.append(Path(sys.executable).resolve().parent.parent / "Resources" / MAC_BUILD_INFO)
    out.append(Path(sys.prefix) / "share" / "fiberbrowser" / "build.json")
    return out


def build_info() -> Optional[dict]:
    """The bundle's build information, or None outside a packaged app."""
    for path in build_info_candidates():
        try:
            data = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        if isinstance(data, dict):
            data.setdefault("path", str(path))
            return data
    return None


def is_packaged() -> bool:
    """The Mac app (frozen) or the WSL distribution (its build file): runs its bundled FiberHMM by default."""
    return is_frozen() or build_info() is not None


def platform_key() -> str:
    """The download a newer build of this one would be: ``macos-arm64``, ``macos-x86_64``, ``windows-x64``
    (the WSL distribution comes with the Windows installer), or ``linux-<machine>`` / ``other``."""
    info = build_info() or {}
    if info.get("platform"):
        return str(info["platform"])
    if sys.platform == "darwin":
        return f"macos-{platform.machine() or 'arm64'}"
    if sys.platform.startswith("linux"):
        try:
            from services.wsl_interop import is_wsl
            if is_wsl():
                return "windows-x64"
        except Exception:
            pass
        return f"linux-{platform.machine() or 'x86_64'}"
    if sys.platform.startswith("win"):
        return "windows-x64"
    return "other"
