"""The Library: the user's own datasets, kept across sessions and restarts.

One JSON file per user, ``~/.fiberhmm/library.json`` (``FIBERBROWSER_LIBRARY``
overrides), shared by every workspace and tab of every local server — never
per session, never on a ``--public`` server. It records where files are and
what their headers say (see ``library_inspect``), plus what the user adds:
tags, notes and experiment groups. Nothing here ever writes, moves or deletes
a data file; removing an entry only forgets it.

Writes are atomic (temp file + ``os.replace``) and serialized across threads
and, on POSIX, across server processes (``flock`` on a sibling lock file).
The file is versioned (``schema``); an older or unknown layout is migrated or
read as empty, never overwritten blindly.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Callable, Iterator, Optional

try:  # POSIX: lock across server processes sharing the file
    import fcntl
except ImportError:  # pragma: no cover - Windows falls back to the thread lock
    fcntl = None

LIBRARY_ENV = "FIBERBROWSER_LIBRARY"
SCHEMA = "fiberbrowser.library.v1"
MAX_ENTRIES = 20_000
MAX_TAGS = 32
MAX_TAG_LEN = 48
MAX_NOTE_LEN = 4000
MAX_GROUP_NAME = 120
USER_FIELDS = ("tags", "notes", "added", "last_opened", "sources", "label_override")
_LOCK = threading.RLock()
_TAG_RE = re.compile(r"[^\w .:+/-]+", re.UNICODE)


def library_file() -> Path:
    configured = os.environ.get(LIBRARY_ENV)
    if configured:
        return Path(configured).expanduser()
    return Path.home() / ".fiberhmm" / "library.json"


def empty_library() -> dict:
    return {"schema": SCHEMA, "updated": None, "entries": {}, "groups": {}, "watched": {}, "imported_jobs": {}}


def new_id(prefix: str, seed: str = "") -> str:
    raw = f"{seed}\0{time.time_ns()}\0{os.getpid()}\0{threading.get_ident()}"
    return prefix + hashlib.sha1(raw.encode("utf-8", "replace")).hexdigest()[:12]


def canonical_path(path: str) -> str:
    path = str(path)
    if "://" in path:  # a cluster/bucket reference (ssh://host/abs/path) is its own identity
        return path
    return os.path.realpath(os.path.abspath(os.path.expanduser(path)))


# ---------------------------------------------------------------------------
# File I/O
# ---------------------------------------------------------------------------

@contextlib.contextmanager
def _locked() -> Iterator[None]:
    """Serialize read-modify-write across threads and (on POSIX) processes."""
    with _LOCK:
        if fcntl is None:
            yield
            return
        lock_path = library_file().with_suffix(".lock")
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        with open(lock_path, "a") as lock_file:
            fcntl.flock(lock_file, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lock_file, fcntl.LOCK_UN)


def migrate(data: Any) -> Optional[dict]:
    """Bring a stored library to the current schema; None when it can't be read safely."""
    if not isinstance(data, dict):
        return None
    schema = data.get("schema")
    if schema == SCHEMA:
        out = empty_library()
        for key in ("entries", "groups", "watched", "imported_jobs"):
            value = data.get(key)
            if key == "imported_jobs":
                out[key] = dict(value) if isinstance(value, dict) else {}
            else:
                out[key] = {k: v for k, v in value.items() if isinstance(v, dict)} if isinstance(value, dict) else {}
        out["updated"] = data.get("updated")
        return out
    if schema is None and isinstance(data.get("entries"), list):
        # Pre-release draft: entries as a list with their own ids.
        out = empty_library()
        for row in data["entries"]:
            if isinstance(row, dict) and row.get("id") and row.get("path"):
                out["entries"][str(row["id"])] = row
        return out
    return None  # a newer FiberBrowser wrote it: leave it alone


def _read_unlocked() -> dict:
    path = library_file()
    try:
        with open(path, "r", encoding="utf-8") as handle:
            raw = json.load(handle)
    except FileNotFoundError:
        return empty_library()
    except (OSError, ValueError):
        return empty_library() | {"_unreadable": True}
    data = migrate(raw)
    if data is None:
        return empty_library() | {"_unreadable": True, "_schema": raw.get("schema") if isinstance(raw, dict) else None}
    return data


def _write_unlocked(data: dict) -> None:
    if data.get("_unreadable"):
        raise RuntimeError(
            f"{library_file()} was written by a newer FiberBrowser or is damaged; "
            "it is left as it is (move it away to start a new Library).")
    path = library_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {k: v for k, v in data.items() if not k.startswith("_")}
    payload["schema"] = SCHEMA
    payload["updated"] = time.time()
    fd, tmp = tempfile.mkstemp(prefix=".library.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=1, default=str)
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def load() -> dict:
    with _locked():
        return _read_unlocked()


def update(change: Callable[[dict], Any]) -> Any:
    """Read, apply ``change(data)`` (which mutates it), write; returns its result."""
    with _locked():
        data = _read_unlocked()
        result = change(data)
        _write_unlocked(data)
        return result


# ---------------------------------------------------------------------------
# Entries
# ---------------------------------------------------------------------------

def _index(data: dict) -> dict:
    """Lookups by path and by content, built once per read-modify-write (``_`` keys are never saved)."""
    index = data.get("_index")
    if index is None:
        index = {"path": {}, "content": {}}
        for entry_id, entry in data["entries"].items():
            _index_add(index, entry_id, entry)
        data["_index"] = index
    return index


def _index_add(index: dict, entry_id: str, entry: dict) -> None:
    where = entry.get("canonical_path") or (canonical_path(entry["path"]) if entry.get("path") else None)
    if where:
        index["path"][(entry.get("kind"), where)] = entry_id
    identity = entry.get("identity") or {}
    if identity.get("header_sha256"):
        key = (entry.get("kind"), identity["header_sha256"], identity.get("size"))
        ids = index["content"].setdefault(key, [])
        if entry_id not in ids:
            ids.append(entry_id)


def find_by_path(data: dict, path: str, kind: Optional[str] = None) -> Optional[str]:
    target = canonical_path(path)
    paths = _index(data)["path"]
    if kind is not None:
        return paths.get((kind, target))
    return next((entry_id for (_kind, where), entry_id in paths.items() if where == target), None)


def find_moved(data: dict, info: dict) -> Optional[str]:
    """An entry whose file is gone and whose content (header digest + size, and the
    sampled content digest, which both must have) is this file's.

    Only local files take part: a cluster/bucket/URL reference (``ssh://``,
    ``s3://``, ``https://``) is never "gone" because it is not on this computer,
    and one never replaces another entry -- different hosts, users or paths
    stay different entries. A remote file is relocated only by the user."""
    identity = info.get("identity") or {}
    if not identity.get("header_sha256") or "://" in str(info.get("path") or ""):
        return None
    key = (info.get("kind"), identity["header_sha256"], identity.get("size"))
    for entry_id in _index(data)["content"].get(key, []):
        entry = data["entries"].get(entry_id)
        if entry is None:
            continue
        if entry.get("path") and ("://" in entry["path"] or os.path.exists(entry["path"])):
            continue  # a copy: both stay; a remote reference is never taken for a missing file
        recorded = (entry.get("identity") or {}).get("content_sha256")
        if not recorded or not identity.get("content_sha256") or recorded != identity["content_sha256"]:
            # Automatic relocation needs both content digests, equal: header and size alone
            # don't identify data (an entry from before digests is relocated only by Locate).
            continue
        return entry_id
    return None


def _merge(entry: dict, info: dict, source: Optional[str]) -> dict:
    """New inspection results over an entry, keeping what the user added.

    Everything read from the file and its sidecars (outputs.json, QC, run
    records) is stored with held or pre-signed URLs in their display form: a
    signature is a credential and never goes to disk."""
    from services.signed_urls import redact_structure
    info = redact_structure(info)
    kept = {k: entry[k] for k in USER_FIELDS if k in entry}
    advisories = entry.get("advisories")
    merged = {**entry, **{k: v for k, v in info.items() if k not in USER_FIELDS}}
    # Fields a new inspection didn't produce (e.g. QC that disappeared) are dropped.
    for key in ("qc", "pipeline", "role", "error", "advisories", "sidecars", "sidecar_roots", "basecaller",
                "sidecar_errors", "sidecars_online_only", "frame_unverifiable"):
        if key not in info:
            merged.pop(key, None)
    if advisories and "advisories" not in info and (advisories.get("key") or "").split("|")[0] == \
            (info.get("identity") or {}).get("header_sha256"):
        merged["advisories"] = advisories  # same header, FiberHMM not re-asked this time
    merged.update(kept)
    sources = list(merged.get("sources") or [])
    if source and source not in sources:
        sources.append(source)
    merged["sources"] = sources[-20:]
    merged["canonical_path"] = canonical_path(merged["path"])
    merged["inspected"] = time.time()
    return merged


def upsert(data: dict, info: dict, source: Optional[str] = None) -> tuple[str, str]:
    """Add or refresh the entry for ``info['path']`` (in ``data``). Returns (id, action)
    where action is added / updated / relocated."""
    entry_id = find_by_path(data, info["path"], info.get("kind"))
    action = "updated"
    if entry_id is None:
        entry_id = find_moved(data, info)
        action = "relocated" if entry_id else "added"
    if entry_id is None:
        if len(data["entries"]) >= MAX_ENTRIES:
            raise RuntimeError(f"The Library holds at most {MAX_ENTRIES:,} files.")
        entry_id = new_id("e", info["path"])
        data["entries"][entry_id] = {"id": entry_id, "added": time.time(), "tags": [], "notes": ""}
    entry = data["entries"][entry_id]
    if action == "relocated":
        entry["previous_paths"] = (list(entry.get("previous_paths") or []) + [entry.get("path")])[-5:]
    data["entries"][entry_id] = _merge(entry, info, source)
    data["entries"][entry_id]["id"] = entry_id
    index = _index(data)
    if action == "relocated":
        index["path"] = {k: v for k, v in index["path"].items() if v != entry_id}
    _index_add(index, entry_id, data["entries"][entry_id])
    return entry_id, action


def record(info: dict, source: Optional[str] = None, *, opened: bool = False) -> dict:
    """Store one inspected file (thread/process safe)."""
    def change(data: dict) -> dict:
        entry_id, action = upsert(data, info, source)
        if opened:
            data["entries"][entry_id]["last_opened"] = time.time()
        return {"id": entry_id, "action": action}
    return update(change)


def clean_tags(tags: Any) -> list[str]:
    out: list[str] = []
    for raw in tags if isinstance(tags, (list, tuple)) else []:
        tag = _TAG_RE.sub("", str(raw)).strip()[:MAX_TAG_LEN]
        if tag and tag not in out:
            out.append(tag)
    return out[:MAX_TAGS]


def annotate(entry_id: str, *, tags: Any = None, notes: Optional[str] = None,
             label: Optional[str] = None) -> dict:
    def change(data: dict) -> dict:
        entry = data["entries"].get(entry_id)
        if entry is None:
            raise KeyError(entry_id)
        if tags is not None:
            entry["tags"] = clean_tags(tags)
        if notes is not None:
            entry["notes"] = str(notes)[:MAX_NOTE_LEN]
        if label is not None:
            text = str(label).strip()[:MAX_GROUP_NAME]
            if text:
                entry["label_override"] = text
            else:
                entry.pop("label_override", None)
        return entry
    return update(change)


def remove_entries(entry_ids: list[str]) -> int:
    """Forget entries (their files are never touched); they leave every group too."""
    def change(data: dict) -> int:
        removed = 0
        for entry_id in entry_ids:
            if data["entries"].pop(entry_id, None) is not None:
                removed += 1
        for group in data["groups"].values():
            group["entry_ids"] = [e for e in group.get("entry_ids") or [] if e in data["entries"]]
        return removed
    return update(change)


# ---------------------------------------------------------------------------
# Groups (experiments)
# ---------------------------------------------------------------------------

def create_group(name: str, entry_ids: list[str], description: str = "") -> dict:
    name = str(name or "").strip()[:MAX_GROUP_NAME]
    if not name:
        raise ValueError("A group needs a name.")

    def change(data: dict) -> dict:
        ids = [e for e in dict.fromkeys(entry_ids or []) if e in data["entries"]]
        group_id = new_id("g", name)
        data["groups"][group_id] = {"id": group_id, "name": name, "description": str(description or "")[:MAX_NOTE_LEN],
                                    "entry_ids": ids, "created": time.time()}
        return data["groups"][group_id]
    return update(change)


def edit_group(group_id: str, *, name: Optional[str] = None, description: Optional[str] = None,
               add: Optional[list[str]] = None, remove: Optional[list[str]] = None) -> dict:
    def change(data: dict) -> dict:
        group = data["groups"].get(group_id)
        if group is None:
            raise KeyError(group_id)
        if name is not None:
            text = str(name).strip()[:MAX_GROUP_NAME]
            if not text:
                raise ValueError("A group needs a name.")
            group["name"] = text
        if description is not None:
            group["description"] = str(description)[:MAX_NOTE_LEN]
        ids = list(group.get("entry_ids") or [])
        for entry_id in add or []:
            if entry_id in data["entries"] and entry_id not in ids:
                ids.append(entry_id)
        drop = set(remove or [])
        group["entry_ids"] = [e for e in ids if e not in drop]
        return group
    return update(change)


def delete_group(group_id: str) -> bool:
    return bool(update(lambda data: data["groups"].pop(group_id, None)))


# ---------------------------------------------------------------------------
# Watched folders
# ---------------------------------------------------------------------------

DEFAULT_MAX_DEPTH = 6
MAX_MAX_DEPTH = 12


def add_watched(path: str, max_depth: int = DEFAULT_MAX_DEPTH) -> dict:
    folder = canonical_path(path)
    depth = max(0, min(int(max_depth), MAX_MAX_DEPTH))

    def change(data: dict) -> dict:
        for watched in data["watched"].values():
            if watched.get("path") == folder:
                watched["max_depth"] = depth
                return watched
        folder_id = new_id("w", folder)
        data["watched"][folder_id] = {"id": folder_id, "path": folder, "max_depth": depth, "added": time.time()}
        return data["watched"][folder_id]
    return update(change)


def remove_watched(folder_id: str) -> bool:
    return bool(update(lambda data: data["watched"].pop(folder_id, None)))


def set_scan_result(folder_id: str, result: dict) -> None:
    def change(data: dict) -> None:
        watched = data["watched"].get(folder_id)
        if watched is not None:
            watched["last_scan"] = result
    update(change)
