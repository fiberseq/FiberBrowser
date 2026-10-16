"""How the previous FiberBrowser run on this port ended (for "Reopen last session").

The page keeps its autosave in the browser (IndexedDB, per origin, so per
port). On the next launch it needs to know whether the server it saved for was
quit normally or died:

- quit normally (the Quit button, the app's Quit, Ctrl+C, SIGTERM, the last
  tab closed): the page's welcome card offers "Reopen last session";
- crashed or killed (no clean shutdown ran): the page offers its crash recovery.

Each local server records itself in ``browser_run_<port>.json`` next to the
runtime file (``~/.fiberhmm/``, or the directory of ``FIBERBROWSER_RUNTIME_FILE``;
one file per port, so servers on other ports never overwrite it) with a random
boot id, and marks the entry ``clean_exit`` at shutdown. The page
stores the boot id with each autosave, so it can tell a save from an earlier
run (offer to reopen) from one of this run (a reload: crash recovery).
"""
from __future__ import annotations

import json
import os
import secrets
import time
from pathlib import Path
from typing import Optional

PREVIOUS_EXITS = ("none", "clean", "crash", "unknown")

_boot_id = secrets.token_hex(8)
_started = time.time()
_port: Optional[int] = None
_previous_exit = "unknown"
_previous_boot_id: Optional[str] = None


def run_file(port: int) -> Path:
    from services.local_auth import runtime_file
    return runtime_file().with_name(f"browser_run_{int(port)}.json")


def _read(path: Path) -> Optional[dict]:
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _write(path: Path, entry: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        tmp.write_text(json.dumps(entry, indent=1))
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink()


def classify_previous(entry: Optional[dict]) -> str:
    """How the run in ``entry`` ended: none (no earlier run), clean, crash, or
    unknown (its process is still alive: another server took over the port)."""
    from services.local_auth import pid_alive
    if not entry:
        return "none"
    if entry.get("clean_exit"):
        return "clean"
    pid = entry.get("pid")
    if pid != os.getpid() and pid_alive(pid):
        return "unknown"
    return "crash"


def record_launch(port: int) -> str:
    """Note how the last run on ``port`` ended, then record this one (not yet clean)."""
    global _port, _previous_exit, _previous_boot_id
    path = run_file(port)
    entry = _read(path)
    _previous_exit = classify_previous(entry)
    _previous_boot_id = entry.get("boot_id") if entry else None
    try:
        _write(path, {"pid": os.getpid(), "boot_id": _boot_id, "started": _started, "clean_exit": False})
        _port = port
    except OSError:
        _port = None
    return _previous_exit


def record_clean_exit() -> None:
    """Mark this run as ended normally (at shutdown; safe to call twice)."""
    global _port
    if _port is None:
        return
    path = run_file(_port)
    entry = _read(path)
    if entry is not None and entry.get("boot_id") == _boot_id:
        entry.update(clean_exit=True, ended=time.time())
        try:
            _write(path, entry)
        except OSError:
            pass
    _port = None


def launch_info() -> dict:
    """What GET /api/session/launch returns."""
    return {
        "boot_id": _boot_id,
        "started": _started,
        "previous_exit": _previous_exit,
        "previous_boot_id": _previous_boot_id,
    }


def _reset_for_tests(boot_id: Optional[str] = None) -> None:
    global _boot_id, _port, _previous_exit, _previous_boot_id, _started
    _boot_id = boot_id or secrets.token_hex(8)
    _started = time.time()
    _port = None
    _previous_exit = "unknown"
    _previous_boot_id = None
