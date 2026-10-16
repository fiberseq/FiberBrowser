"""Watched folders: find the user's datasets on disk and add them to the Library.

A scan walks one chosen folder (no symlinked folders, nothing outside it),
up to its maximum depth, skipping hidden folders, app bundles, package and
cache trees, and folders with more than ``MAX_DIR_ENTRIES`` entries (listed
only that far, and reported: ``big_dirs``). It stops at a file/time budget,
checked before every folder, and says so (``truncated``). It reads headers
only (``library_inspect``) and writes nothing next to the data: the only
file written is the Library itself. Files unchanged since the last scan
(same size, mtime and inode) are not re-read.

Scans run in a background thread, one at a time; ``status()`` reports the
running scan's progress and each folder's last result. On startup every
watched folder is rescanned once (``FIBERBROWSER_LIBRARY_NO_STARTUP_SCAN``
turns that off; tests set it).
"""
from __future__ import annotations

import os
import threading
import time
from typing import Any, Optional

from services import library_inspect as inspect
from services import library_store as store

NO_STARTUP_SCAN_ENV = "FIBERBROWSER_LIBRARY_NO_STARTUP_SCAN"
MAX_DIR_ENTRIES = 20_000
MAX_VISITED = 400_000
MAX_CANDIDATES = 5_000
TIME_BUDGET_S = 600.0
SKIP_DIR_NAMES = {
    "node_modules", "__pycache__", "site-packages", "$RECYCLE.BIN", "System Volume Information",
    "lost+found", "venv", ".venv", "conda", "miniconda3", "anaconda3", "Trash",
}
SKIP_DIR_SUFFIXES = (".app", ".bundle", ".framework", ".photoslibrary", ".zarr", ".egg-info")
BAM_INDEX_SUFFIXES = (".bai", ".csi")


def _inside(path: str, root: str) -> bool:
    return path == root or path.startswith(root.rstrip(os.sep) + os.sep)


def _has_index(path: str, names: set[str]) -> bool:
    base = os.path.basename(path)
    stem = base[:-4]
    return any(n in names for n in (base + ".bai", base + ".csi", stem + ".bai"))


MAX_BIG_DIR_EXAMPLES = 10
DEADLINE_CHECK_EVERY = 1000  # entries, while listing one folder


def _list_folder(path: str, deadline: Optional[float]) -> tuple[Optional[list[str]], list[str], Optional[str]]:
    """(sub-folders, files, why it was not listed) of one folder, enumerating at most
    ``MAX_DIR_ENTRIES + 1`` entries (never the whole of a huge folder). Symlinks are
    files here (a symlinked folder is never entered)."""
    dirs: list[str] = []
    files: list[str] = []
    with os.scandir(path) as listing:
        for count, entry in enumerate(listing, 1):
            if count > MAX_DIR_ENTRIES:
                return None, [], "big"
            if deadline is not None and count % DEADLINE_CHECK_EVERY == 0 and time.monotonic() > deadline:
                return None, [], "deadline"
            try:
                is_dir = entry.is_dir(follow_symlinks=False)
            except OSError:
                is_dir = False
            (dirs if is_dir else files).append(entry.name)
    return dirs, files, None


def find_candidates(root: str, max_depth: int, *, deadline: Optional[float] = None,
                    progress: Optional[dict] = None, only_subdirs: Optional[frozenset] = None,
                    max_candidates: Optional[int] = None) -> dict:
    """Files the Library can show under ``root`` (a real, existing folder).

    Depth-first in name order. The time and file/folder budgets are checked
    before every folder (and while listing a large one), so no branch --
    not even a skipped huge folder -- runs past them unnoticed.

    ``only_subdirs``: enter only sub-folders with these names (a pipeline's
    own output folders, for a one-folder scan); every other rule is the same."""
    root = os.path.realpath(root)
    max_candidates = MAX_CANDIDATES if max_candidates is None else max_candidates
    found: list[tuple[str, str]] = []
    counts = {"dirs": 0, "files": 0, "skipped_dirs": 0, "big_dirs": 0, "no_index": 0, "outside": 0,
              "errors": 0}
    truncated = None
    folders_with_bams: dict[str, int] = {}
    big_dirs: list[str] = []
    stack: list[tuple[str, int]] = [(root, 0)]
    while stack:
        if deadline is not None and time.monotonic() > deadline:
            truncated = "stopped at the time limit"
            break
        if counts["files"] + counts["dirs"] >= MAX_VISITED:
            truncated = f"stopped after {MAX_VISITED:,} files and folders"
            break
        dirpath, depth = stack.pop()
        counts["dirs"] += 1
        try:
            dirnames, filenames, skipped = _list_folder(dirpath, deadline)
        except OSError:
            counts["errors"] += 1
            continue
        if skipped == "deadline":
            truncated = "stopped at the time limit"
            break
        if skipped == "big":
            counts["big_dirs"] += 1
            if len(big_dirs) < MAX_BIG_DIR_EXAMPLES:
                big_dirs.append(dirpath)
            continue
        kept = []
        for name in dirnames:
            if name.startswith(".") or name in SKIP_DIR_NAMES or name.endswith(SKIP_DIR_SUFFIXES) \
                    or depth >= max_depth or (only_subdirs is not None and name not in only_subdirs):
                counts["skipped_dirs"] += 1
                continue
            kept.append(name)
        stack.extend((os.path.join(dirpath, name), depth + 1) for name in sorted(kept, reverse=True))
        names = set(filenames)
        for name in sorted(filenames):
            counts["files"] += 1
            if name.startswith("."):
                continue
            kind = inspect.file_kind(name)
            if kind is None:
                continue
            path = os.path.join(dirpath, name)
            if os.path.islink(path) and not _inside(os.path.realpath(path), root):
                counts["outside"] += 1
                continue
            if kind == "bam":
                if not _has_index(path, names):
                    counts["no_index"] += 1
                    continue
                folders_with_bams[dirpath] = folders_with_bams.get(dirpath, 0) + 1
            found.append((path, kind))
            if len(found) >= max_candidates:
                truncated = f"stopped at {max_candidates:,} files"
                break
        if progress is not None:
            progress.update(dirs=counts["dirs"], files=counts["files"], candidates=len(found))
        if truncated:
            break
    return {"root": root, "candidates": found, "counts": counts, "truncated": truncated,
            "folders": folders_with_bams, "big_dirs": big_dirs}


def scan_folder(folder_id: str, *, progress: Optional[dict] = None,
                time_budget_s: float = TIME_BUDGET_S) -> dict:
    """Scan one watched folder into the Library and record the result on it."""
    started = time.time()
    t0 = time.monotonic()
    data = store.load()
    watched = data["watched"].get(folder_id)
    if watched is None:
        raise KeyError(folder_id)
    root = watched["path"]
    if not os.path.isdir(root):
        result = {"finished": time.time(), "elapsed_s": 0.0, "error": "folder not found", "root": root}
        store.set_scan_result(folder_id, result)
        return result
    deadline = t0 + time_budget_s
    walk = find_candidates(root, int(watched.get("max_depth", store.DEFAULT_MAX_DEPTH)),
                           deadline=deadline, progress=progress)
    known = {e.get("canonical_path"): e for e in data["entries"].values() if e.get("canonical_path")}
    infos = []
    unchanged = cloud_only = errors = 0
    for index, (path, kind) in enumerate(walk["candidates"]):
        if progress is not None:
            progress.update(inspected=index, current=path)
        if time.monotonic() > deadline:
            walk["truncated"] = walk["truncated"] or "stopped at the time limit"
            break
        identity = inspect.stat_identity(path)
        if identity is None:
            errors += 1
            continue
        previous = known.get(store.canonical_path(path))
        # An entry recorded before content digests is read once more while its file is
        # here (and not online-only), so it gets one: relocation needs it later.
        needs_digest = not identity["cloud_only"] and not (previous or {}).get("identity", {}).get("content_sha256")
        if previous is not None and inspect.same_stat(previous.get("identity"), identity) \
                and not previous.get("error") and bool(previous.get("cloud_only")) == identity["cloud_only"] \
                and not needs_digest and not inspect.extras_stale(previous, path):
            unchanged += 1
            continue
        try:
            info = inspect.inspect_file(path, kind, identity=identity, root=walk["root"])
        except Exception as exc:  # one bad file never costs the rest of the folder
            info = {"kind": kind, "path": path, "folder": os.path.dirname(path), "label": os.path.basename(path),
                    "identity": {k: identity[k] for k in ("size", "mtime_ns", "inode")},
                    "cloud_only": identity["cloud_only"], "error": f"{type(exc).__name__}: {exc}"}
        cloud_only += bool(info.get("cloud_only"))
        errors += bool(info.get("error"))
        infos.append(info)

    source = f"watched:{folder_id}"

    def change(lib: dict) -> dict:
        actions = {"added": 0, "updated": 0, "relocated": 0}
        for info in infos:
            _, action = store.upsert(lib, info, source)
            actions[action] += 1
        return actions

    actions = store.update(change) if infos else {"added": 0, "updated": 0, "relocated": 0}
    result = {
        "started": started,
        "finished": time.time(),
        "elapsed_s": round(time.monotonic() - t0, 2),
        "root": root,
        "files_seen": walk["counts"]["files"],
        "dirs_seen": walk["counts"]["dirs"],
        "candidates": len(walk["candidates"]),
        "inspected": len(infos),
        "unchanged": unchanged,
        "cloud_only": cloud_only,
        "errors": errors,
        "bam_without_index": walk["counts"]["no_index"],
        "skipped_dirs": walk["counts"]["skipped_dirs"] + walk["counts"]["big_dirs"],
        "big_dirs": walk["counts"]["big_dirs"],
        "big_dir_examples": walk["big_dirs"],
        "truncated": walk["truncated"],
        **actions,
    }
    store.set_scan_result(folder_id, result)
    return result


# ---------------------------------------------------------------------------
# Background runner
# ---------------------------------------------------------------------------

class ScanRunner:
    """One scan at a time, in a daemon thread; later requests queue behind it."""

    def __init__(self):
        self._lock = threading.Lock()
        self._queue: list[str] = []
        self._thread: Optional[threading.Thread] = None
        self.current: Optional[dict] = None
        self.last_error: Optional[str] = None

    def request(self, folder_ids: list[str]) -> list[str]:
        with self._lock:
            for folder_id in folder_ids:
                if folder_id not in self._queue and (self.current or {}).get("folder_id") != folder_id:
                    self._queue.append(folder_id)
            if self._thread is None or not self._thread.is_alive():
                self._thread = threading.Thread(target=self._run, name="library-scan", daemon=True)
                self._thread.start()
            return list(self._queue)

    def _run(self) -> None:
        while True:
            with self._lock:
                if not self._queue:
                    self.current = None
                    return
                folder_id = self._queue.pop(0)
                self.current = {"folder_id": folder_id, "started": time.time(), "progress": {}}
            try:
                scan_folder(folder_id, progress=self.current["progress"])
                self.last_error = None
            except KeyError:
                pass  # removed meanwhile
            except Exception as exc:  # never kill the server over a scan
                self.last_error = f"{type(exc).__name__}: {exc}"

    def status(self) -> dict:
        with self._lock:
            current = dict(self.current) if self.current else None
            if current:
                current["progress"] = dict(current.get("progress") or {})
            return {"running": current, "queued": list(self._queue), "last_error": self.last_error}

    def wait(self, timeout: float = 30.0) -> bool:
        """For tests: until the queue is empty."""
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            thread = self._thread
            if thread is None or not thread.is_alive():
                return True
            thread.join(0.05)
        return False


_runner = ScanRunner()


def runner() -> ScanRunner:
    return _runner


def start_startup_scan() -> Optional[list[str]]:
    """Rescan every watched folder once, in the background (local servers only)."""
    if os.environ.get(NO_STARTUP_SCAN_ENV):
        return None
    try:
        folders = list(store.load()["watched"])
    except Exception:
        return None
    if not folders:
        return []
    return _runner.request(folders)


def status() -> dict[str, Any]:
    return _runner.status()
