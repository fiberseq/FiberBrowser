"""Locate a saved session's input files on another computer.

Sessions store absolute paths. When a session is opened elsewhere, those
paths rarely exist, so restore first checks every referenced local file and
lets the user relink missing ones: locating one file infers the folder
change for the rest, and a folder search matches the remaining basenames.
Each saved file also carries a small fingerprint (size + hash of the first
MiB) so a relinked candidate can be confirmed as the same file.
"""
from __future__ import annotations

import hashlib
import os
import re
import time
from typing import Iterable, Optional

from plugins.packs import pack_rebuilds_reference, restorer_for
from utils.validation import is_url

FINGERPRINT_HEAD_BYTES = 1 << 20
SEARCH_MAX_ENTRIES = 200_000
SEARCH_MAX_DEPTH = 8
SEARCH_MAX_SECONDS = 15.0

_REMOTE_PREFIXES = ("s3://", "gs://", "http://", "https://", "ftp://", "motif://", "ssh://")


def _is_local_path(path) -> bool:
    return (
        isinstance(path, str)
        and bool(path.strip())
        and not path.startswith(_REMOTE_PREFIXES)
        and not is_url(path)
    )


def _path_parts(path: str) -> list[str]:
    # Sessions can move between macOS/Linux and Windows.
    return [part for part in re.split(r"[\\/]+", path) if part]


def _basename(path: str) -> str:
    parts = _path_parts(path)
    return parts[-1] if parts else path


def derived_bundle_paths(dataset: dict) -> list[str]:
    """The `.fiberlayers` bundles a saved dataset had attached (its derived layers' sources)."""
    paths: list[str] = []
    for meta in (dataset.get("derived_layers") or {}).values():
        if not isinstance(meta, dict):
            continue
        for path in meta.get("bundle_paths") or [meta.get("bundle_path")]:
            if isinstance(path, str) and path and path not in paths:
                paths.append(path)
    return paths


def session_file_refs(session: dict) -> list[dict]:
    """Every local file a session restore would open, with a display label."""
    return _session_refs(session, _is_local_path)


def session_remote_refs(session: dict) -> list[dict]:
    """Every cluster file (``ssh://`` reference) a session restore would open."""
    from services.remote_sources import is_source_ref
    return _session_refs(session, is_source_ref)


def _session_refs(session: dict, keep) -> list[dict]:
    refs: list[dict] = []
    seen: set[str] = set()

    def add(kind: str, label: Optional[str], path) -> None:
        if not keep(path) or path in seen:
            return
        seen.add(path)
        refs.append({"kind": kind, "label": label or _basename(path), "path": path})

    for dataset in session.get("datasets", []) or []:
        if dataset.get("pack") or restorer_for(dataset) is not None:
            # A plugin pack's dataset: rebuilt from its source dataset (listed itself) on import,
            # or skipped by a build without that pack; its built files need no relinking.
            continue
        for path in dataset.get("paths", []) or []:
            add("dataset", dataset.get("label") or dataset.get("id"), path)
        for path in derived_bundle_paths(dataset):
            add("derived layers", dataset.get("label") or dataset.get("id"), path)
    for overlay in session.get("overlays", []) or []:
        add("overlay", overlay.get("label"), overlay.get("path"))
    for track in session.get("orthogonal_tracks", []) or []:
        add("track", track.get("label"), track.get("path"))

    reference = session.get("reference", {}) or {}
    pairs = reference.get("pairs") or []
    for pair in pairs:
        if isinstance(pair, dict):
            add("reference", pair.get("label"), pair.get("fasta"))
            add("annotation", pair.get("label"), pair.get("annotation"))
    if not pairs:
        # With reference pairs, gtf.path is a joined list derived from them.
        add("reference", "FASTA", reference.get("fasta_path"))
        add("annotation", "Gene annotation", (session.get("gtf", {}) or {}).get("path"))

    for path in reference.get("plasmids") or []:
        add("reference", "Plasmid map", path)

    # Datasets on another assembly with a FASTA/annotation of their own (services/panel_genomes.py).
    for key, source in ((session.get("panel_genomes", {}) or {}).get("contexts", {}) or {}).items():
        if pack_rebuilds_reference("panel_genome", str(key), source):
            continue  # a plugin pack's own reference (rebuilt with its dataset)
        if isinstance(source, dict):
            label = str(key).split(":", 1)[-1]
            add("reference", f"{label} FASTA (own panel)", source.get("fasta_path"))
            add("annotation", f"{label} annotation (own panel)", source.get("gtf_path"))

    for annotation in (session.get("annotations", {}) or {}).get("files", []) or []:
        add("annotation", annotation.get("label"), annotation.get("path"))

    contact_map = session.get("contact_map", {}) or {}
    add("contact_map", "Contact map", contact_map.get("cool_file"))
    add("contact_map", "Contact map footprints", contact_map.get("bigbed_file"))
    return refs


def file_fingerprint(path: str) -> Optional[dict]:
    from services.lab.paths import open_read
    try:
        digest = hashlib.sha256()
        # A lab server: only inside its data roots, hashed from the checked descriptor.
        with open_read(path) as handle:
            size = os.fstat(handle.fileno()).st_size
            digest.update(handle.read(FINGERPRINT_HEAD_BYTES))
    except OSError:  # PathDenied is a PermissionError
        return None
    return {"size": size, "head_sha256": digest.hexdigest()}


def session_file_fingerprints(session: dict) -> dict:
    """Fingerprints for the session's local files that exist right now."""
    fingerprints = {}
    for ref in session_file_refs(session):
        if os.path.isfile(ref["path"]):
            fingerprint = file_fingerprint(ref["path"])
            if fingerprint:
                fingerprints[ref["path"]] = fingerprint
    return fingerprints


def _status(original: str, candidate: str, fingerprints: dict) -> str:
    from services.lab.paths import readable
    # A lab server: a file resolving outside its data roots is as good as missing
    # (never compared, so its size and content can't be probed).
    if not os.path.exists(candidate) or not readable(candidate):
        return "missing"
    expected = fingerprints.get(original)
    if expected and os.path.isfile(candidate) and file_fingerprint(candidate) != expected:
        return "changed"
    return "ok"


def _separator(path: str) -> str:
    return "\\" if "\\" in path and "/" not in path else "/"


def _split_root(path: str) -> tuple[str, list[str]]:
    """(root, components): root is "/", "C:", "\\\\server\\share" or "" (relative)."""
    unc = re.match(r"^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)", path)
    if unc:
        return f"\\\\{unc.group(1)}\\{unc.group(2)}", _path_parts(path[unc.end():])
    drive = re.match(r"^([A-Za-z]:)", path)
    if drive:
        return drive.group(1), _path_parts(path[2:])
    if path[:1] in ("/", "\\"):
        return path[0], _path_parts(path)
    return "", _path_parts(path)


def _build(root: str, parts: list[str], style: str) -> str:
    sep = _separator(style)
    body = sep.join(parts)
    if root.startswith("\\\\") or re.fullmatch(r"[A-Za-z]:", root):
        return root + sep + body if body else root + sep
    return root + body if root else body


def infer_prefix_change(old: str, new: str) -> Optional[tuple[str, list[str], str]]:
    """Folder change implied by relinking one file.

    ``/Users/a/data/x/r.bam`` -> ``/home/b/lab/x/r.bam`` shares the suffix
    ``x/r.bam``, so any path under ``/Users/a/data`` maps under ``/home/b/lab``.
    Roots (``/``, drive letters, UNC shares) are never treated as folders.
    """
    old_root, old_parts = _split_root(old)
    new_root, new_parts = _split_root(new)
    shared = 0
    while (
        shared < min(len(old_parts), len(new_parts))
        and old_parts[-1 - shared] == new_parts[-1 - shared]
    ):
        shared += 1
    # Nothing shared, or the whole old path shared: no folder change to apply.
    if shared == 0 or shared == len(old_parts):
        return None
    return old_root, old_parts[: len(old_parts) - shared], _build(new_root, new_parts[: len(new_parts) - shared], new)


def _apply_prefix(path: str, old_root: str, old_prefix: list[str], new_prefix: str, style: str) -> Optional[str]:
    root, parts = _split_root(path)
    # Same drive/share/root only: C:\old\x must not match D:\old\x.
    if root.lower() != old_root.lower():
        return None
    if len(parts) <= len(old_prefix) or parts[: len(old_prefix)] != old_prefix:
        return None
    sep = _separator(style)
    rest = sep.join(parts[len(old_prefix):])
    if not new_prefix:
        return rest  # relative stays relative
    return new_prefix + ("" if new_prefix.endswith(("/", "\\")) else sep) + rest


def _sibling(new: str, name: str) -> str:
    root, parts = _split_root(new)
    return _build(root, [*parts[:-1], name], new)


def _search_folder(root: str, basenames: set[str]) -> dict[str, list[str]]:
    from services.lab.paths import readable
    found: dict[str, list[str]] = {}
    root = os.path.abspath(os.path.expanduser(root))
    base_depth = root.rstrip(os.sep).count(os.sep)
    visited = 0
    deadline = time.monotonic() + SEARCH_MAX_SECONDS
    for directory, subdirs, files in os.walk(root):
        visited += len(files) + len(subdirs)
        if visited > SEARCH_MAX_ENTRIES or time.monotonic() > deadline:
            break
        if directory.count(os.sep) - base_depth >= SEARCH_MAX_DEPTH:
            subdirs[:] = []
        subdirs[:] = [name for name in subdirs if not name.startswith(".")]
        for name in files:
            if name in basenames and readable(os.path.join(directory, name)):  # a lab server's data roots
                found.setdefault(name, []).append(os.path.join(directory, name))
    return found


def _is_searchable_root(root: str) -> bool:
    from services.lab.paths import readable
    if not readable(root):
        return False  # a lab server: outside its data roots
    path = os.path.abspath(os.path.expanduser(root))
    # A whole-filesystem walk is never what the user meant.
    return os.path.isdir(path) and os.path.dirname(path) != path


def check_session_files(
    session: dict,
    *,
    mapping: Optional[dict] = None,
    anchor: Optional[dict] = None,
    search_root: Optional[str] = None,
) -> dict:
    """Status of every session file, extending ``mapping`` from optional hints.

    ``anchor`` is ``{"old": path, "new": path}`` for a file the user located;
    its folder change is tried on every other unresolved file. ``search_root``
    is a folder searched for the remaining files by basename.
    """
    fingerprints = session.get("file_fingerprints", {}) or {}
    mapping = {old: new for old, new in (mapping or {}).items() if isinstance(new, str) and new}
    refs = session_file_refs(session)

    def unresolved() -> Iterable[dict]:
        for ref in refs:
            if _status(ref["path"], mapping.get(ref["path"], ref["path"]), fingerprints) == "missing":
                yield ref

    def identity(path: str) -> str:
        return os.path.normcase(os.path.abspath(os.path.expanduser(path)))

    def claimed() -> set[str]:
        # Files the session already uses (found in place or relinked) can't
        # also stand in for a different missing file.
        in_use = [mapping.get(ref["path"], ref["path"]) for ref in refs]
        return {identity(path) for path in in_use if os.path.exists(path)}

    if anchor and anchor.get("old") and anchor.get("new"):
        old, new = anchor["old"], os.path.expanduser(anchor["new"])
        mapping[old] = new
        change = infer_prefix_change(old, new)
        old_dir = _path_parts(old)[:-1]
        for ref in list(unresolved()):
            candidates = []
            if change:
                candidates.append(_apply_prefix(ref["path"], *change, new))
            # Files that sat beside the located one usually still do. Only
            # true siblings: a same-named file from another folder is not it.
            if _path_parts(ref["path"])[:-1] == old_dir:
                candidates.append(_sibling(new, _basename(ref["path"])))
            for candidate in candidates:
                if candidate and os.path.exists(candidate) and identity(candidate) not in claimed():
                    mapping[ref["path"]] = candidate
                    break

    if search_root and _is_searchable_root(search_root):
        pending = list(unresolved())
        found = _search_folder(search_root, {_basename(ref["path"]) for ref in pending})
        for ref in pending:
            candidates = [c for c in found.get(_basename(ref["path"]), []) if identity(c) not in claimed()]
            matching = [c for c in candidates if _status(ref["path"], c, fingerprints) == "ok"
                        and ref["path"] in fingerprints]
            # Only relink when the match is unambiguous; otherwise the user
            # locates it, rather than silently getting a same-named file.
            if len(matching) == 1:
                mapping[ref["path"]] = matching[0]
            elif not matching and len(candidates) == 1:
                mapping[ref["path"]] = candidates[0]

    files = []
    for ref in refs:
        resolved = mapping.get(ref["path"], ref["path"])
        files.append({
            **ref,
            "resolved_path": resolved,
            "status": _status(ref["path"], resolved, fingerprints),
            "relinked": resolved != ref["path"],
        })
    mapping = {old: new for old, new in mapping.items() if old != new}
    return {
        "files": files,
        # Files on a cluster: restore asks to connect to their host first.
        "remote": _remote_status(session),
        "mapping": mapping,
        "missing": sum(1 for f in files if f["status"] == "missing"),
        "changed": sum(1 for f in files if f["status"] == "changed"),
    }


def apply_path_mapping(value, mapping: dict):
    """Replace every string exactly equal to a relinked path, anywhere in the session."""
    if not mapping:
        return value
    if isinstance(value, str):
        return mapping.get(value, value)
    if isinstance(value, list):
        return [apply_path_mapping(item, mapping) for item in value]
    if isinstance(value, dict):
        return {key: apply_path_mapping(item, mapping) for key, item in value.items()}
    return value


def _remote_status(session: dict) -> dict:
    refs = [ref["path"] for ref in session_remote_refs(session)]
    if not refs:
        return {"refs": [], "targets": [], "disconnected": 0}
    from services.remote_endpoint import refs_status
    try:
        return refs_status(refs)
    except PermissionError:
        return {"refs": [], "targets": [], "disconnected": 0}
