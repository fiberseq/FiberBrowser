"""Where the FiberBrowser application files are.

The backend (``browser/``) imports its modules as top-level names
(``services``, ``routers``, ``state``, ...) from its own folder on
``sys.path``, and a few modules find files relative to the application root
(``data/copilot_dataset/models.json``, ``browser/frontend/...``). So the
installed package mirrors the repository root:

    site-packages/fiberbrowser/          <- application root (installed)
        browser/  browser.py  browser_client.py  data/  plugins/  icons/

In a source checkout this package sits at ``<repo>/fiberbrowser`` and the
application root is the repository itself.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Optional

PACKAGE_DIR = Path(__file__).resolve().parent


def app_root() -> Path:
    """The folder holding ``browser/`` and ``browser.py``."""
    for candidate in (PACKAGE_DIR, PACKAGE_DIR.parent):
        if (candidate / "browser" / "server.py").is_file() and (candidate / "browser.py").is_file():
            return candidate
    raise RuntimeError(
        f"FiberBrowser's application files are missing next to {PACKAGE_DIR} "
        "(expected browser/server.py and browser.py). Reinstall FiberBrowser.")


def browser_dir() -> Path:
    return app_root() / "browser"


def browser_script() -> Path:
    return app_root() / "browser.py"


def icons_dir() -> Path:
    return PACKAGE_DIR / "icons"


def is_frozen() -> bool:
    """Running inside the macOS app (PyInstaller bundle)."""
    return bool(getattr(sys, "frozen", False))


def bundle_bin_dirs() -> list[Path]:
    """The Mac app's helper-program folders, for PATH (empty outside the app).

    ``Contents/Helpers`` holds bundled programs (minimap2, blastn, makeblastdb), and
    ``Contents/Resources/bin`` the ``fiberhmm-*`` commands (small scripts that
    run the app binary as that command); see packaging/macos/build_app.sh.
    """
    if not is_frozen():
        return []
    contents = Path(sys.executable).resolve().parent.parent
    return [d for d in (contents / "Helpers", contents / "Resources" / "bin") if d.is_dir()]


def build_flavor() -> str:
    """The build's flavour: the flavour a plugin pack of this build names (``browser/<pack>/fiberbrowser-pack.json``:
    the release channel), else "public". Read without importing the backend (the About box)."""
    import json
    try:
        manifests = sorted(browser_dir().glob("*/fiberbrowser-pack.json"))
    except OSError:
        manifests = []
    for manifest in manifests:
        try:
            data = json.loads(manifest.read_text())
        except (OSError, ValueError):
            continue
        return str(data.get("flavor") or data.get("name") or manifest.parent.name)
    return "public"


def version() -> str:
    """FiberBrowser's version (browser/version.py), without importing the backend."""
    text = (browser_dir() / "version.py").read_text()
    for line in text.splitlines():
        if line.startswith("__version__"):
            return line.split("=", 1)[1].strip().strip("\"'")
    return "unknown"
