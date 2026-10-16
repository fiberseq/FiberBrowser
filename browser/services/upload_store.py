"""Where drag-and-drop uploads live, and how long they are kept.

Browsers never reveal a dropped file's real path, so dropped files are
copied to the server. They go to a per-user cache (never inside the
installed package), identical re-drops reuse the existing copy, and copies
unused for FIBERBROWSER_UPLOAD_RETENTION_DAYS are removed at startup.
Restoring a session marks its uploaded files as used; a session restored
after its upload was cleaned up asks the user to locate the original file.
"""
from __future__ import annotations

import hashlib
import os
import re
import time
import uuid
from typing import BinaryIO, Iterable, Optional

UPLOAD_DIR_ENV = "FIBERBROWSER_UPLOAD_DIR"
RETENTION_DAYS_ENV = "FIBERBROWSER_UPLOAD_RETENTION_DAYS"
DEFAULT_RETENTION_DAYS = 30
PARTIAL_MARKER = ".partial-"
INDEX_SUFFIXES = (".bai", ".csi", ".crai", ".tbi", ".fai")
_CHUNK = 8 << 20

# Pre-1.0 releases wrote uploads inside the package; kept only for a notice.
LEGACY_UPLOAD_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "routers", "uploads")


def upload_dir() -> str:
    configured = os.environ.get(UPLOAD_DIR_ENV)
    path = configured or os.path.join(os.path.expanduser("~"), ".fiberhmm", "uploads")
    return os.path.abspath(os.path.expanduser(path))


def retention_days() -> float:
    try:
        return float(os.environ.get(RETENTION_DAYS_ENV, DEFAULT_RETENTION_DAYS))
    except ValueError:
        return DEFAULT_RETENTION_DAYS


def _is_inside(path: str, directory: str) -> bool:
    try:
        return os.path.commonpath([os.path.abspath(path), directory]) == directory
    except ValueError:
        return False


def _sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(_CHUNK), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _candidate_names(filename: str) -> Iterable[str]:
    """``name.ext``, then ``name_1.ext``, ``name_2.ext``, … (see unique_upload_path)."""
    base, extension = os.path.splitext(filename)
    yield filename
    counter = 1
    while True:
        yield f"{base}_{counter}{extension}"
        counter += 1


def safe_upload_name(filename: Optional[str]) -> str:
    """Bare file name from a client-supplied upload name; never a path.

    Drops directories and drive qualifiers (``D:x``) and replaces ``:`` so a
    name can never resolve outside the cache on any platform.
    """
    name = re.split(r"[\\/]", (filename or "").rstrip("\\/ "))[-1].strip()
    name = re.sub(r"^[A-Za-z]:", "", name).replace(":", "_")
    if set(name) <= {"."}:
        name = ""
    return name or "uploaded"


def _claim(path: str) -> bool:
    """Atomically reserve a destination name (fails if it already exists)."""
    try:
        os.close(os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644))
        return True
    except FileExistsError:
        return False


def save_upload(stream: BinaryIO, directory: str, filename: str) -> str:
    """Store an uploaded stream, reusing an identical earlier upload of the same file."""
    filename = safe_upload_name(filename)
    directory = os.path.abspath(directory)
    os.makedirs(directory, exist_ok=True)
    partial = os.path.join(directory, f".{filename}{PARTIAL_MARKER}{uuid.uuid4().hex}")
    digest = hashlib.sha256()
    size = 0
    try:
        with open(partial, "wb") as handle:
            for chunk in iter(lambda: stream.read(_CHUNK), b""):
                handle.write(chunk)
                digest.update(chunk)
                size += len(chunk)
        content_hash = digest.hexdigest()
        for name in _candidate_names(filename):
            existing = os.path.join(directory, name)
            if os.path.dirname(os.path.abspath(existing)) != directory:
                raise ValueError(f"Refusing upload name {filename!r}")
            if _claim(existing):
                # Name reserved; concurrent uploads now see it as taken.
                try:
                    os.replace(partial, existing)
                except BaseException:
                    os.remove(existing)  # release the empty reservation
                    raise
                # A new copy never inherits an index left from an older file
                # of this name; the BAM is re-indexed when it is loaded.
                for suffix in INDEX_SUFFIXES:
                    if os.path.isfile(existing + suffix):
                        os.remove(existing + suffix)
                if existing.lower().endswith(".bam"):
                    for stem_index in (existing[:-4] + ".bai", existing[:-4] + ".csi"):
                        if os.path.isfile(stem_index):
                            os.remove(stem_index)
                stored = existing
                break
            if os.path.getsize(existing) == size and _sha256_file(existing) == content_hash:
                os.remove(partial)
                mark_uploads_used([existing], directory=directory)
                stored = existing
                break
    finally:
        if os.path.exists(partial):
            os.remove(partial)
    return stored




def mark_uploads_used(paths: Iterable[Optional[str]], directory: Optional[str] = None) -> None:
    """Refresh last-used time for uploaded files (and their indexes) so cleanup keeps them."""
    directory = directory or upload_dir()
    now = time.time()
    for path in paths:
        if not path or not _is_inside(path, directory):
            continue
        for target in (path, *(path + suffix for suffix in INDEX_SUFFIXES)):
            if os.path.isfile(target):
                try:
                    os.utime(target, (now, now))
                except OSError:
                    pass


def cleanup_uploads(directory: Optional[str] = None, max_age_days: Optional[float] = None) -> dict:
    """Delete uploads unused for ``max_age_days`` (0 or less keeps everything)."""
    directory = directory or upload_dir()
    max_age_days = retention_days() if max_age_days is None else max_age_days
    removed, freed = [], 0
    if max_age_days <= 0 or not os.path.isdir(directory):
        return {"removed": removed, "freed_bytes": freed}
    cutoff = time.time() - max_age_days * 86400
    entries = [os.path.join(directory, name) for name in os.listdir(directory)]
    files = [path for path in entries if os.path.isfile(path)]
    stale = set()
    for path in files:
        name = os.path.basename(path)
        if PARTIAL_MARKER in name:
            # Interrupted uploads; anything older than a day is abandoned.
            if os.path.getmtime(path) < time.time() - 86400:
                stale.add(path)
            continue
        if name.endswith(INDEX_SUFFIXES):
            # Removed with the data file it indexes, unless that file is gone.
            stem = os.path.splitext(path)[0]  # x.bam.bai -> x.bam; x.bai -> x (for x.bam)
            has_data = any(os.path.exists(stem + ext) for ext in ("", ".bam", ".cram"))
            if not has_data and os.path.getmtime(path) < cutoff:
                stale.add(path)
            continue
        if os.path.getmtime(path) < cutoff:
            stale.add(path)
            stale.update(path + suffix for suffix in INDEX_SUFFIXES if os.path.isfile(path + suffix))
    for path in sorted(stale):
        try:
            size = os.path.getsize(path)
            os.remove(path)
        except OSError:
            continue
        removed.append(path)
        freed += size
    return {"removed": removed, "freed_bytes": freed}


def _dir_size(directory: str) -> int:
    total = 0
    for root, _dirs, files in os.walk(directory):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except OSError:
                pass
    return total


def dataset_file_paths(dataset) -> list[str]:
    """Every file a dataset reads: its paths, companion layer files (found next
    to it) and derived-layer bundles with their manifests."""
    paths: list[str] = list(getattr(dataset, "paths", None) or [])
    for value in (getattr(dataset, "companion_layers", None) or {}).values():
        paths.extend([value] if isinstance(value, str) else list(value or []))
    for meta in (getattr(dataset, "derived_layers", None) or {}).values():
        if not isinstance(meta, dict):
            continue
        paths.extend(meta.get("bundle_paths") or [meta.get("bundle_path")])
        paths.append(meta.get("manifest_path"))
    return [path for path in paths if isinstance(path, str)]


def loaded_file_paths(state, dafc_state=None) -> list[str]:
    """Files the running server has open (CLI datasets, tracks, reference)."""
    paths: list[str] = []
    for dataset in (getattr(state, "datasets", None) or {}).values():
        paths.extend(dataset_file_paths(dataset))
    for track in getattr(state, "orthogonal_tracks", None) or []:
        if isinstance(track, dict):
            paths.append(track.get("path"))
    gtf_paths = (getattr(state, "gtf_path", None) or "").split(os.pathsep)  # joined for reference pairs
    paths.extend([*gtf_paths, getattr(state, "fasta_path", None),
                  getattr(dafc_state, "cool_file", None), getattr(dafc_state, "bigbed_file", None)])
    for pair in getattr(state, "reference_pairs", None) or []:
        if isinstance(pair, dict):
            paths.extend([pair.get("fasta"), pair.get("annotation")])
    return [path for path in paths if isinstance(path, str)]


def startup_upload_maintenance(state=None, dafc_state=None) -> None:
    """Prune stale uploads and point out the pre-1.0 in-package upload folder."""
    try:
        # Files loaded from the command line are in use even if old.
        mark_uploads_used(loaded_file_paths(state, dafc_state))
        result = cleanup_uploads()
        if result["removed"]:
            print(f"  Removed {len(result['removed'])} unused upload(s) "
                  f"({result['freed_bytes'] / 1e6:.0f} MB) from {upload_dir()}")
    except Exception as exc:  # never block startup on housekeeping
        print(f"  Warning: upload cleanup failed: {exc}")
    if os.path.isdir(LEGACY_UPLOAD_DIR) and os.listdir(LEGACY_UPLOAD_DIR):
        size_mb = _dir_size(LEGACY_UPLOAD_DIR) / 1e6
        print(f"  Note: {LEGACY_UPLOAD_DIR} holds {size_mb:.0f} MB of uploads from an older "
              f"version. New uploads go to {upload_dir()}. Delete the old folder once no "
              f"saved session needs it.")
