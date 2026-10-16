"""Recently used track sources, kept across browser sessions and restarts.

Only where each track comes from is stored (path or URL, label, kind, motif
filter/threshold), never the data. The browser lists these as "Recent" when
adding a track, so old tracks don't have to be found again from scratch.
"""
from __future__ import annotations

import contextlib
import json
import os
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Iterator

try:  # POSIX: lock across server processes sharing the file
    import fcntl
except ImportError:  # pragma: no cover - Windows falls back to the thread lock
    fcntl = None

MAX_RECENT = 300
_LOCK = threading.Lock()
_FIELDS = ("source", "kind", "label", "path", "url", "catalogId", "filterNames", "meta")


def recent_tracks_file() -> Path:
    configured = os.environ.get("FIBERBROWSER_RECENT_TRACKS_FILE")
    if configured:
        return Path(configured).expanduser()
    return Path.home() / ".fiberhmm" / "recent_tracks.json"


def entry_key(entry: dict[str, Any]) -> str:
    where = entry.get("path") or entry.get("url") or ""
    names = ",".join(sorted(str(n) for n in (entry.get("filterNames") or [])))
    return f"{entry.get('source') or ''}|{where}|{names}"


@contextlib.contextmanager
def _locked() -> Iterator[None]:
    """Serialize read-modify-write across threads and (on POSIX) processes."""
    with _LOCK:
        if fcntl is None:
            yield
            return
        lock_path = recent_tracks_file().with_suffix(".lock")
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        with open(lock_path, "a") as lock_file:
            fcntl.flock(lock_file, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lock_file, fcntl.LOCK_UN)


def _read() -> list[dict[str, Any]]:
    path = recent_tracks_file()
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        return [row for row in data if isinstance(row, dict)] if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def _write(rows: list[dict[str, Any]]) -> None:
    path = recent_tracks_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".recent_tracks.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(rows, handle, indent=1)
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def list_recent() -> list[dict[str, Any]]:
    """Most recent first; local files that no longer exist are marked."""
    with _locked():
        rows = _read()
    out = []
    for row in rows:
        row = dict(row)
        path = row.get("path")
        local = row.get("source") == "local" and isinstance(path, str) and "://" not in path
        row["available"] = (not local) or os.path.exists(os.path.expanduser(path))
        row["key"] = entry_key(row)
        out.append(row)
    return out


def remember(entry: dict[str, Any]) -> dict[str, Any]:
    clean = {k: entry[k] for k in _FIELDS if entry.get(k) not in (None, "", [])}
    from services import signed_urls
    for key in ("url", "path"):
        # A pre-signed URL is a credential: remembered without its query string.
        if signed_urls.looks_signed(clean.get(key)) or signed_urls.is_registered(clean.get(key)):
            clean[key] = signed_urls.display_url(clean[key])
    if not clean.get("path") and not clean.get("url"):
        raise ValueError("A recent track needs a path or URL")
    if not clean.get("label"):
        raise ValueError("A recent track needs a label")
    clean["lastUsed"] = time.time()
    key = entry_key(clean)
    with _locked():
        rows = [row for row in _read() if entry_key(row) != key]
        rows.insert(0, clean)
        _write(rows[:MAX_RECENT])
    return {"success": True, "key": key}


def forget(key: str) -> dict[str, Any]:
    with _locked():
        rows = _read()
        kept = [row for row in rows if entry_key(row) != key]
        if len(kept) != len(rows):
            _write(kept)
    return {"success": True, "removed": len(rows) - len(kept)}
