"""The native graph helper for FiberBrowser's graph view (``fiberbrowser-graph``, from graphlift).

FiberBrowser finds it through ``helper_path()`` (``pip install "fiberbrowser[graph]"``
installs this package). It is a platform wheel: one executable built for this
platform, with the licence notices of everything compiled into it.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

__all__ = ["helper_path", "main", "__version__"]
__version__ = "0.0.0"  # replaced by packaging/graph-native/build_wheel.py

_HERE = Path(__file__).resolve().parent


def helper_path() -> Path:
    """The bundled ``fiberbrowser-graph`` executable."""
    name = "fiberbrowser-graph.exe" if sys.platform == "win32" else "fiberbrowser-graph"
    path = _HERE / "bin" / name
    if not path.is_file():
        raise FileNotFoundError(f"{path} is missing: reinstall fiberbrowser-graph-native")
    return path


def main() -> None:
    """The ``fiberbrowser-graph`` console command: run the helper with these arguments."""
    path = str(helper_path())
    if sys.platform == "win32":
        import subprocess
        raise SystemExit(subprocess.call([path, *sys.argv[1:]]))
    os.execv(path, [path, *sys.argv[1:]])
