"""One folder, on demand: what a suggested experiment's folder holds.

Library > Suggested experiments groups the files already listed by folder.
Before "Open" or "Save as group", the folder is scanned once with the
watched-folder scanner (``library_scan.find_candidates``: the same skipped
folders, huge-folder and time limits, no symlink leading outside, BAMs
without an index left out), without becoming a watched folder.

``preview`` only lists: a stat per file (so online-only files are flagged,
never downloaded) and a pipeline's small outputs.json, to leave out
aligned-only BAMs. ``add`` inspects the files the user kept (headers only,
as a watched scan does) and records them as ordinary entries, so the group
or Open covers the whole folder.

Scope (``mode``): ``folder`` is the folder itself plus the sub-folders a
FiberHMM run writes datasets to (``tracks/``; ``calls/``); ``deep`` is the
watched-folder default (``DEFAULT_MAX_DEPTH`` levels).

Paths are reported under the folder as the user knows it (the suggestion's
folder), not its resolved location, so a folder reached through a symlink
(e.g. a cloud-storage folder) keeps the entries' folder and the existing
entries' paths unchanged.
"""
from __future__ import annotations

import os
import re
import time
from typing import Optional

from services import library_inspect as inspect
from services import library_scan as scan
from services import library_store as store

PIPELINE_SUBDIRS = frozenset({"tracks", "calls"})
MODES = {"folder": (1, PIPELINE_SUBDIRS), "deep": (store.DEFAULT_MAX_DEPTH, None)}
PREVIEW_TIME_S = 30.0
ADD_TIME_S = 300.0
MAX_FOLDER_FILES = 2000
SOURCE = "folder-scan"
_ALIGNED_NAME = re.compile(r"\.aligned(\.sorted)?\.bam$", re.IGNORECASE)


def folder_error(folder: str) -> Optional[str]:
    """Why ``folder`` can't be scanned (in words), or None."""
    if not os.path.lexists(folder):
        return f"This folder no longer exists: {folder}"
    if not os.path.isdir(folder):
        return f"Not a folder (or a link to a missing one): {folder}"
    real = os.path.realpath(folder)
    if os.path.dirname(real) == real:  # "/" or a drive root: every file on the disk
        return "Choose the folder your data is in, not the whole disk."
    try:
        with os.scandir(folder) as listing:
            next(listing, None)
    except PermissionError:
        return f"FiberBrowser can't read this folder (permission denied): {folder}"
    except OSError as exc:
        return f"FiberBrowser can't read this folder ({exc.strerror or type(exc).__name__}): {folder}"
    return None


def _walk(folder: str, mode: str, deadline: float) -> tuple[dict, list[tuple[str, str, str]]]:
    """The scanner's walk, and (path under ``folder``, canonical path, kind) per distinct file."""
    depth, subdirs = MODES[mode]
    walk = scan.find_candidates(folder, depth, deadline=deadline, only_subdirs=subdirs,
                                max_candidates=MAX_FOLDER_FILES)
    from services.lab.paths import readable
    real_root = walk["root"]
    seen: set[tuple[str, str]] = set()
    files = []
    for found, kind in walk["candidates"]:
        shown = os.path.join(folder, os.path.relpath(found, real_root))
        canonical = store.canonical_path(shown)
        if (kind, canonical) in seen:  # one file reached twice (a symlink beside it)
            continue
        if not readable(canonical):  # a lab server: only inside its data folders
            walk["counts"]["denied"] = walk["counts"].get("denied", 0) + 1
            continue
        seen.add((kind, canonical))
        files.append((shown, canonical, kind))
    return walk, files


def _looks_aligned(path: str, real_root: str) -> bool:
    """An aligned-only BAM (a pipeline's ``aligned_bam``, or ``*.aligned.bam`` without a
    run record), judged as ``inspect_file`` does but reading only an outputs.json
    inside the folder (never an online-only one)."""
    try:
        outputs = inspect.find_outputs_json(path, inspect.Sidecars([real_root], fixed=True))
    except Exception:
        outputs = None
    if outputs is not None:
        return inspect.pipeline_summary(outputs, path)["role"] == "aligned"
    return bool(_ALIGNED_NAME.search(path))


def _left_out(walk: dict, aligned: int, unreadable: int) -> dict:
    counts = walk["counts"]
    return {
        "aligned": aligned,
        "no_index": counts["no_index"],
        "outside": counts["outside"] + counts.get("denied", 0),
        "other_files": max(0, counts["files"] - len(walk["candidates"]) - counts["no_index"] - counts["outside"]),
        "skipped_dirs": counts["skipped_dirs"],
        "big_dirs": counts["big_dirs"],
        "unreadable": unreadable + counts["errors"],
    }


def preview(folder: str, mode: str = "folder") -> dict:
    """What ``folder`` holds that the Library lists (nothing is recorded)."""
    if mode not in MODES:
        return {"success": False, "error": f"Unknown scan mode: {mode}"}
    error = folder_error(folder)
    if error:
        return {"success": False, "error": error, "folder": folder}
    t0 = time.monotonic()
    deadline = t0 + PREVIEW_TIME_S  # one budget for the walk and the per-file checks
    walk, found = _walk(folder, mode, deadline)
    data = store.load()
    watched = [w["path"] for w in data["watched"].values() if w.get("path")]
    rows = []
    aligned = unreadable = 0
    for shown, canonical, kind in found:
        if time.monotonic() > deadline:
            walk["truncated"] = walk["truncated"] or "stopped at the time limit"
            break
        identity = inspect.stat_identity(shown)
        if identity is None:
            unreadable += 1
            continue
        entry_id = store.find_by_path(data, shown, kind)
        entry = data["entries"].get(entry_id) if entry_id else None
        if kind == "bam":
            known_aligned = entry is not None and entry.get("role") == "aligned" \
                and inspect.same_stat(entry.get("identity"), identity)
            if known_aligned or (not identity["cloud_only"] and _looks_aligned(shown, walk["root"])) \
                    or (identity["cloud_only"] and _ALIGNED_NAME.search(shown)):
                aligned += 1
                continue
        rows.append({
            "path": shown,
            "name": os.path.relpath(shown, folder),
            "kind": kind,
            "size": identity["size"],
            "cloud_only": identity["cloud_only"],
            "entry_id": entry_id,
        })
    kinds: dict[str, int] = {}
    for row in rows:
        kinds[row["kind"]] = kinds.get(row["kind"], 0) + 1
    real = os.path.realpath(folder)
    return {
        "success": True,
        "folder": folder,
        "mode": mode,
        "subdirs": sorted(MODES[mode][1]) if MODES[mode][1] is not None else None,
        "max_depth": MODES[mode][0],
        "files": rows,
        "kinds": kinds,
        "new": sum(1 for r in rows if not r["entry_id"]),
        "cloud_only": sum(1 for r in rows if r["cloud_only"]),
        "left_out": _left_out(walk, aligned, unreadable),
        "big_dir_examples": walk["big_dirs"],
        "truncated": walk["truncated"],
        "watched": any(inspect.inside(real, os.path.realpath(w)) for w in watched),
        "elapsed_s": round(time.monotonic() - t0, 2),
    }


def add(folder: str, paths: list[str], mode: str = "folder") -> dict:
    """Record the chosen files of ``folder`` (each must be one its scan finds) and
    return their entry ids, existing entries included, in the order given."""
    error = f"Unknown scan mode: {mode}" if mode not in MODES else folder_error(folder)
    if error:
        return {"success": False, "error": error, "folder": folder, "ids": [], "added": 0, "updated": 0,
                "relocated": 0, "unchanged": 0, "aligned": 0, "not_found": [], "errors": [], "truncated": None}
    t0 = time.monotonic()
    deadline = t0 + ADD_TIME_S
    walk, found = _walk(folder, mode, t0 + PREVIEW_TIME_S)
    by_canonical = {canonical: (shown, kind) for shown, canonical, kind in found}
    chosen: list[tuple[str, str, str]] = []
    not_found: list[str] = []
    for raw in list(dict.fromkeys(paths))[:MAX_FOLDER_FILES]:
        canonical = store.canonical_path(raw)
        if canonical not in by_canonical:
            not_found.append(raw)  # not (or no longer) a file this folder's scan finds
            continue
        shown, kind = by_canonical[canonical]
        if all(c != canonical for _s, c, _k in chosen):
            chosen.append((shown, canonical, kind))

    data = store.load()
    known = {e.get("canonical_path"): (entry_id, e) for entry_id, e in data["entries"].items()
             if e.get("canonical_path")}
    infos: list[dict] = []
    order: list[tuple[str, Optional[str]]] = []  # (canonical, id of an unchanged entry)
    unchanged = aligned = 0
    errors: list[str] = []
    truncated = walk["truncated"]
    for shown, canonical, kind in chosen:
        if time.monotonic() > deadline:
            truncated = truncated or "stopped at the time limit"
            break
        identity = inspect.stat_identity(shown)
        if identity is None:
            errors.append(f"{os.path.basename(shown)}: not found")
            continue
        entry_id, previous = known.get(canonical, (None, None))
        needs_digest = not identity["cloud_only"] and not (previous or {}).get("identity", {}).get("content_sha256")
        if previous is not None and previous.get("kind") == kind \
                and inspect.same_stat(previous.get("identity"), identity) \
                and not previous.get("error") and bool(previous.get("cloud_only")) == identity["cloud_only"] \
                and not needs_digest and not inspect.extras_stale(previous, shown):
            if previous.get("role") == "aligned":
                aligned += 1
                continue
            unchanged += 1
            order.append((canonical, entry_id))
            continue
        if previous is not None and previous.get("path") \
                and store.canonical_path(previous["path"]) == canonical:
            shown = previous["path"]  # listed under another alias of this file: keep its path and folder
        try:
            # Files beside it are read as for a file added by hand (its own folder and
            # its run folder), so a later re-scan of the entry reads the same ones.
            info = inspect.inspect_file(shown, kind, identity=identity)
        except Exception as exc:  # one bad file never costs the rest of the folder
            info = {"kind": kind, "path": shown, "folder": os.path.dirname(shown), "label": os.path.basename(shown),
                    "identity": {k: identity[k] for k in ("size", "mtime_ns", "inode")},
                    "cloud_only": identity["cloud_only"], "error": f"{type(exc).__name__}: {exc}"}
        if info.get("role") == "aligned":
            aligned += 1
            continue
        if info.get("error"):
            errors.append(f"{os.path.basename(shown)}: {info['error']}")
        infos.append(info)
        order.append((canonical, None))

    def change(lib: dict) -> dict:
        ids: dict[str, str] = {}
        actions = {"added": 0, "updated": 0, "relocated": 0}
        for info in infos:
            try:
                entry_id, action = store.upsert(lib, info, SOURCE)
            except RuntimeError as exc:  # the Library is full
                errors.append(str(exc))
                break
            ids[store.canonical_path(info["path"])] = entry_id
            actions[action] += 1
        return {"ids": ids, **actions}

    result = store.update(change) if infos else {"ids": {}, "added": 0, "updated": 0, "relocated": 0}
    ids: list[str] = []
    for canonical, entry_id in order:
        entry_id = entry_id or result["ids"].get(canonical)
        if entry_id and entry_id not in ids:
            ids.append(entry_id)
    return {
        "success": bool(ids) or not (errors or not_found),
        "folder": folder,
        "ids": ids,
        "added": result["added"],
        "updated": result["updated"],
        "relocated": result["relocated"],
        "unchanged": unchanged,
        "aligned": aligned,
        "not_found": not_found,
        "errors": list(dict.fromkeys(errors))[:20],
        "truncated": truncated,
        "elapsed_s": round(time.monotonic() - t0, 2),
    }
