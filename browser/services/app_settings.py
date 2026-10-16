"""App-level settings of a packaged FiberBrowser (``~/.fiberhmm/app_settings.json``).

The choices the app's Settings make for this computer, kept apart from ``browser_settings.json`` (the machine
defaults scripts and source runs read, which the app never writes):

``fiberhmm``
    ``{"source": "bundled" | "custom", "custom_path": "/path/to/FiberHMM"}``: which FiberHMM a packaged app runs
    (services/fiberhmm_runtime.py). Read once per process: a change takes effect at the next start.
``updates``
    ``{"check_at_startup": true, "manifest_url": "", "repo": ""}``: the update check (services/app_update.py).
    ``check_at_startup`` left unset follows the kind of run: on in a packaged app (the Mac app, the Windows app's
    WSL distribution), off in a source run or a pip install (``python browser.py``, scripts that start a server).
    A value set in Settings applies to every run on this computer. *Check for Updates…* works either way.

``FIBERBROWSER_APP_SETTINGS`` points at a different file. A missing file means defaults; an unreadable one is
reported once and ignored. Written atomically, readable by this user only. Never holds a secret: a GitHub token
lives in the OS keychain (services/github_auth.py).
"""
from __future__ import annotations

import copy
import json
import os
import sys
import tempfile
import threading
from pathlib import Path
from typing import Any

DEFAULTS: dict[str, Any] = {
    "performance": {"mode": "auto"},
    "fiberhmm": {"source": "bundled", "custom_path": ""},
    # check_at_startup None: the kind of run decides (default_check_at_startup).
    "updates": {"check_at_startup": None, "manifest_url": "", "repo": ""},
}
FIBERHMM_SOURCES = ("bundled", "custom")

_lock = threading.Lock()
_cache: tuple[str, tuple, dict] | None = None
_warned: set[str] = set()


def settings_path() -> Path:
    override = os.environ.get("FIBERBROWSER_APP_SETTINGS")
    return Path(override).expanduser() if override else Path.home() / ".fiberhmm" / "app_settings.json"


def default_check_at_startup() -> bool:
    """The quiet update check at startup when Settings haven't set it: on in a packaged app, off in a source run
    or a pip install (the owner's scripts and servers stay quiet; *Check for Updates…* still works)."""
    try:
        from services import app_build
        return bool(app_build.is_packaged())
    except Exception:
        return False


def _with_run_defaults(settings: dict) -> dict:
    updates = settings["updates"]
    if not isinstance(updates.get("check_at_startup"), bool):
        updates["check_at_startup"] = default_check_at_startup()
    return settings


def _merged(stored: dict) -> dict:
    out = copy.deepcopy(DEFAULTS)
    for section, values in stored.items():
        if section in out and isinstance(values, dict):
            out[section].update({k: v for k, v in values.items() if k in out[section]})
    return out


def load() -> dict:
    """The settings with defaults filled in (a fresh copy; cached per path and file version)."""
    global _cache
    path = settings_path()
    try:
        st = path.stat()
        # Not the mtime alone: Linux (WSL) file times move in clock ticks of a few ms, so a
        # save right after another kept the mtime and load() served the settings before it.
        # update() replaces the file, so its inode (and usually its size) changes too.
        version: tuple = (st.st_mtime_ns, st.st_size, st.st_ino)
    except OSError:
        version = ()
    with _lock:
        if _cache is not None and _cache[0] == str(path) and _cache[1] == version:
            return _with_run_defaults(copy.deepcopy(_cache[2]))
        stored: dict = {}
        if version:
            try:
                loaded = json.loads(path.read_text())
                if isinstance(loaded, dict):
                    stored = loaded
                else:
                    raise ValueError("not a JSON object")
            except (OSError, ValueError) as error:
                if str(path) not in _warned:
                    _warned.add(str(path))
                    print(f"  WARNING: could not read {path} ({error}); using the default app settings.",
                          file=sys.stderr)
        merged = _merged(stored)
        _cache = (str(path), version, merged)
        return _with_run_defaults(copy.deepcopy(merged))


def check_at_startup_is_set() -> bool:
    """Whether Settings set the check at startup (else it follows the kind of run)."""
    path = settings_path()
    try:
        stored = json.loads(path.read_text())
    except (OSError, ValueError):
        return False
    updates = stored.get("updates") if isinstance(stored, dict) else None
    return isinstance(updates, dict) and isinstance(updates.get("check_at_startup"), bool)


def _clean(section: str, values: dict) -> dict:
    if section == "performance":
        from services.performance import MODES
        if values.get("mode") not in MODES:
            raise ValueError("Choose Auto, Low memory, Standard, or High performance.")
        return {"mode": values["mode"]}
    if section == "fiberhmm":
        out = {}
        if "source" in values:
            if values["source"] not in FIBERHMM_SOURCES:
                raise ValueError(f"FiberHMM source must be one of {', '.join(FIBERHMM_SOURCES)}")
            out["source"] = values["source"]
        if "custom_path" in values:
            if not isinstance(values["custom_path"], str):
                raise ValueError("custom_path must be text")
            out["custom_path"] = values["custom_path"].strip()
        return out
    if section == "updates":
        out = {}
        if "check_at_startup" in values:
            if not isinstance(values["check_at_startup"], bool):
                raise ValueError("check_at_startup must be true or false")
            out["check_at_startup"] = values["check_at_startup"]
        for key in ("manifest_url", "repo"):
            if key in values:
                if not isinstance(values[key], str):
                    raise ValueError(f"{key} must be text")
                out[key] = values[key].strip()
        if out.get("manifest_url"):
            from urllib.parse import urlparse
            scheme = urlparse(out["manifest_url"]).scheme.lower()
            if scheme not in ("https", "file") and not out["manifest_url"].startswith(("/", "~")):
                raise ValueError("The update manifest must be an https:// or file:// address, or a file path")
        if out.get("repo"):
            import re
            if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", out["repo"]):
                raise ValueError("The repository must be owner/name")
        return out
    raise ValueError(f"Unknown app settings section: {section}")


def update(section: str, values: dict) -> dict:
    """Change some values of one section; returns the full settings."""
    if not isinstance(values, dict):
        raise ValueError("values must be an object")
    clean = _clean(section, values)
    path = settings_path()
    with _lock:
        stored: dict = {}
        if path.is_file():
            try:
                loaded = json.loads(path.read_text())
                stored = loaded if isinstance(loaded, dict) else {}
            except (OSError, ValueError):
                stored = {}
        current = stored.get(section) if isinstance(stored.get(section), dict) else {}
        stored[section] = {**current, **clean}
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".app_settings.", dir=str(path.parent))
        try:
            with os.fdopen(fd, "w") as handle:
                json.dump(stored, handle, indent=2, sort_keys=True)
                handle.write("\n")
            os.chmod(tmp, 0o600)
            os.replace(tmp, path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
    return load()
