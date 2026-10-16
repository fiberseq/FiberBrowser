"""Per-user FiberBrowser settings (``~/.fiberhmm/browser_settings.json``).

Machine-level defaults that should not have to be repeated on every launch or
in every script that starts a server:

``fiberhmm_source_dir``
    A FiberHMM source tree for **source runs** (``python browser.py``, pip
    installs) to use instead of the installed package (same as
    ``FIBERHMM_SOURCE_DIR``; the environment variable wins). Packaged apps
    ignore it and run their bundled FiberHMM unless their own Settings or
    ``FIBERHMM_SOURCE_DIR`` say otherwise (services/fiberhmm_runtime.py).
``require_token``
    ``false`` turns the per-launch access token off, as ``--no-token`` does.
    Only for a single-user computer: any program or account that can reach the
    port can then use the server. ``FIBERBROWSER_NO_TOKEN=1`` does the same
    for one environment. Public servers never use the token. Only a server
    listening on 127.0.0.1 honours it: with ``--host 0.0.0.0`` the token stays
    on (``--no-token`` or ``FIBERBROWSER_NO_TOKEN`` there refuse to start).

``tools`` / ``blast_dir``
    Where external programs are, when they are somewhere FiberBrowser doesn't
    look by itself: ``{"tools": {"blastn": "/path/to/blastn"}}`` (a program
    or its folder) or ``"blast_dir"`` for the BLAST+ ``bin`` folder. These are
    tried first (services/external_tools.py).

``FIBERBROWSER_SETTINGS`` points at a different file. A missing file means
defaults; an unreadable one is reported once and ignored.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

_cache: dict[str, Any] | None = None
_cache_path: str | None = None


def settings_path() -> Path:
    override = os.environ.get("FIBERBROWSER_SETTINGS")
    return Path(override).expanduser() if override else Path.home() / ".fiberhmm" / "browser_settings.json"


def load_user_settings() -> dict[str, Any]:
    """The settings file as a dict ({} when absent or invalid); cached per path."""
    global _cache, _cache_path
    path = settings_path()
    if _cache is not None and _cache_path == str(path):
        return _cache
    settings: dict[str, Any] = {}
    if path.is_file():
        try:
            loaded = json.loads(path.read_text())
            if isinstance(loaded, dict):
                settings = loaded
            else:
                print(f"  WARNING: {path} is not a JSON object; ignoring it.", file=sys.stderr)
        except (OSError, ValueError) as error:
            print(f"  WARNING: could not read {path} ({error}); ignoring it.", file=sys.stderr)
    _cache, _cache_path = settings, str(path)
    return settings


def _truthy(value: str | None) -> bool:
    return str(value or "").strip().lower() in ("1", "true", "yes", "on")


def token_disabled_by_user() -> bool:
    """True when this user turned the access token off (env or settings file)."""
    return token_disabled_source() is not None


def token_disabled_source() -> str | None:
    """'env' (FIBERBROWSER_NO_TOKEN), 'settings' (require_token=false), or None.

    The settings file is a machine default for the loopback-only personal
    server; a network bind ignores it (services/remote_access.py).
    """
    if _truthy(os.environ.get("FIBERBROWSER_NO_TOKEN")):
        return "env"
    if load_user_settings().get("require_token", True) is False:
        return "settings"
    return None


def settings_file_fiberhmm_source_dir() -> str | None:
    """``fiberhmm_source_dir`` of the settings file (source runs only; services/fiberhmm_runtime.py)."""
    value = load_user_settings().get("fiberhmm_source_dir")
    return str(value) if value else None


def fiberhmm_source_dir() -> str | None:
    """A source run's FiberHMM source tree: FIBERHMM_SOURCE_DIR, else the settings file's."""
    explicit = os.environ.get("FIBERHMM_SOURCE_DIR")
    if explicit:
        return explicit
    return settings_file_fiberhmm_source_dir()
