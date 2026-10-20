"""Finding the native graph helper and checking that it speaks our protocol.

Resolution order (DESIGN_GRAPH_PANEL.md §2):

1. ``FIBERBROWSER_GRAPH_HELPER``: a developer's executable (it must pass the
   same handshake as any other);
2. the copy bundled in the macOS app (``Contents/Helpers/fiberbrowser-graph``);
3. the ``fiberbrowser-graph-native`` companion wheel
   (``pip install "fiberbrowser[graph]"``).

Without one, the graph panel says "Graph helper unavailable" with
``INSTALL_HINT``; nothing else in FiberBrowser depends on it.
"""
from __future__ import annotations

import os
import subprocess
import struct
import threading
from dataclasses import dataclass, field
from typing import Optional

from services.graph_panel.frames import MAX_CONTROL_BYTES, FrameError, decode_payload

HELPER_NAME = "fiberbrowser-graph"
ENV_HELPER = "FIBERBROWSER_GRAPH_HELPER"
COMPANION_MODULE = "fiberbrowser_graph_native"
INSTALL_HINT = ('Install the graph helper: pip install "fiberbrowser[graph]" '
                "(the fiberbrowser-graph-native companion package), then restart FiberBrowser. "
                "The macOS app includes it.")
SUPPORTED_DB_SCHEMA = "GBZ-base version 4"
SUPPORTED_PACKAGE_SCHEMA = 1
SUPPORTED_MAP_SCHEMA = 2
HANDSHAKE_TIMEOUT_S = 2.0


@dataclass
class HelperStatus:
    available: bool
    source: Optional[str] = None          # env | bundled | companion
    path: Optional[str] = None
    handshake: dict = field(default_factory=dict)
    error: Optional[str] = None
    hint: Optional[str] = None
    searched: list = field(default_factory=list)

    def public(self) -> dict:
        hs = self.handshake or {}
        return {
            "available": self.available, "source": self.source, "path": self.path,
            "producer": hs.get("producer"), "build_target": hs.get("build_target"),
            "graphlift_revision": hs.get("graphlift_revision"), "limits": hs.get("limits"),
            "dispatch_deadline_ms": hs.get("dispatch_deadline_ms"), "startup_deadline_ms": hs.get("startup_deadline_ms"),
            "error": self.error, "hint": self.hint, "searched": self.searched,
        }


def _bundled_candidates() -> list[str]:
    dirs: list[str] = []
    try:
        from fiberbrowser._paths import bundle_bin_dirs
        dirs = [str(d) for d in bundle_bin_dirs()]
    except Exception:
        dirs = []
    return [os.path.join(d, HELPER_NAME) for d in dirs]


def _companion_candidate() -> tuple[Optional[str], Optional[str]]:
    try:
        import importlib
        module = importlib.import_module(COMPANION_MODULE)
    except ImportError:
        return None, None
    except Exception as exc:  # a broken install: say so rather than hiding it
        return None, f"{COMPANION_MODULE} failed to import: {exc}"
    try:
        return str(module.helper_path()), None
    except Exception as exc:
        return None, f"{COMPANION_MODULE}.helper_path() failed: {exc}"


def candidates(environ: Optional[dict] = None) -> list[tuple[str, str]]:
    """(source, path) in resolution order; paths may not exist."""
    env = os.environ if environ is None else environ
    out: list[tuple[str, str]] = []
    override = (env.get(ENV_HELPER) or "").strip()
    if override:
        out.append(("env", override))
    for path in _bundled_candidates():
        out.append(("bundled", path))
    path, _ = _companion_candidate()
    if path:
        out.append(("companion", path))
    return out


def probe_handshake(path: str, timeout_s: float = HANDSHAKE_TIMEOUT_S) -> dict:
    """Run ``<helper> handshake`` and return its capability object. Raises RuntimeError."""
    try:
        proc = subprocess.run([path, "handshake"], stdin=subprocess.DEVNULL, capture_output=True,
                              timeout=timeout_s, check=False)
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"handshake took longer than {timeout_s:g} s") from None
    except OSError as exc:
        raise RuntimeError(f"cannot run it: {exc.strerror or exc}") from None
    out = proc.stdout
    if proc.returncode != 0 or len(out) < 4:
        tail = proc.stderr.decode("utf-8", "replace")[-300:].strip()
        raise RuntimeError(f"handshake failed (exit {proc.returncode}){': ' + tail if tail else ''}")
    (length,) = struct.unpack(">I", out[:4])
    if length > MAX_CONTROL_BYTES or len(out) < 4 + length:
        raise RuntimeError("handshake frame is oversized or truncated")
    try:
        frame = decode_payload(out[4:4 + length])
    except FrameError as exc:
        raise RuntimeError(f"handshake frame rejected ({exc})") from None
    hs = frame.body.get("handshake")
    if frame.type != "ready" or not isinstance(hs, dict):
        raise RuntimeError(f"unexpected handshake reply type {frame.type!r}")
    check_capabilities(hs)
    return hs


def check_capabilities(hs: dict) -> None:
    """The helper's schemas must include the ones this FiberBrowser reads (no automatic migration)."""
    if SUPPORTED_DB_SCHEMA not in (hs.get("db_schemas") or []):
        raise RuntimeError(f"helper does not read {SUPPORTED_DB_SCHEMA!r} databases; reinstall the graph helper")
    if SUPPORTED_PACKAGE_SCHEMA not in (hs.get("package_schemas") or []):
        raise RuntimeError(f"helper does not read package schema {SUPPORTED_PACKAGE_SCHEMA}; reinstall the graph helper")
    if SUPPORTED_MAP_SCHEMA not in (hs.get("map_schemas") or []):
        raise RuntimeError(f"helper does not read map schema {SUPPORTED_MAP_SCHEMA}; reinstall the graph helper")


_lock = threading.Lock()
_cache: dict = {}


def _fingerprint(path: str):
    try:
        st = os.stat(path)
        return (st.st_size, st.st_mtime_ns, st.st_ino)
    except OSError:
        return None


def resolve(environ: Optional[dict] = None, *, refresh: bool = False) -> HelperStatus:
    """The first candidate that exists and passes the handshake (cached per file identity)."""
    searched: list = []
    errors: list[str] = []
    _, companion_error = _companion_candidate()
    if companion_error:
        errors.append(companion_error)
    for source, path in candidates(environ):
        searched.append({"source": source, "path": path})
        if not os.path.isfile(path) or not os.access(path, os.X_OK):
            if source == "env":
                # A configured developer helper that is missing is an error, never a silent fallback.
                errors.append(f"{ENV_HELPER}={path} does not exist or is not executable")
                break
            if os.path.exists(path):
                errors.append(f"{path} is not executable")
            continue
        key = (os.path.realpath(path), _fingerprint(path))
        with _lock:
            cached = None if refresh else _cache.get(key)
        if cached is None:
            try:
                cached = ("ok", probe_handshake(path))
            except RuntimeError as exc:
                cached = ("error", str(exc))
            with _lock:
                _cache[key] = cached
        if cached[0] == "ok":
            return HelperStatus(True, source, path, cached[1], searched=searched)
        errors.append(f"{source} helper {path}: {cached[1]}")
        if source == "env":
            # A configured developer helper that fails is an error, not a reason to fall back silently.
            break
    return HelperStatus(False, error="; ".join(errors) or "no graph helper found", hint=INSTALL_HINT, searched=searched)


def clear_cache() -> None:
    with _lock:
        _cache.clear()
