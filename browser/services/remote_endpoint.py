"""Route logic for /api/remote/* ("Connect to cluster…" and the remote file browser).

Local, personal servers only: every call refuses in --public mode and in tour
sandboxes (both run under public rules). Listing entries carry the reference
(``ssh://host/abs/path``) the rest of the app loads; no live URL or token is
ever returned.
"""
from __future__ import annotations

import posixpath
from typing import Any, Iterable, Optional

from services.remote_sources import all_sources, get_source, ref_scheme, source_for_ref
from services.remote_sources.base import NotConnectedError, RemoteSourceError
from services.remote_sources.ssh_command import SshCommandError

LOCAL_ONLY_MESSAGE = "Connecting to clusters is only available in a FiberBrowser running on your own computer."
LAB_MESSAGE = ("Connect to cluster is not available on a shared lab server: it would sign in with the "
               "server's own SSH credentials for every member. Put the files under one of this server's "
               "data folders, or run FiberBrowser on your own computer and connect from there.")

KIND_BY_SUFFIX = (
    ((".bam",), "bam"),
    ((".bb", ".bigbed"), "bigbed"),
    ((".bw", ".bigwig"), "bigwig"),
    ((".fa", ".fasta", ".fna", ".fa.gz", ".fasta.gz", ".fna.gz"), "fasta"),
    ((".dna", ".gb", ".gbk", ".genbank", ".embl", ".emb", ".sbol", ".rdf", ".ttl"), "map"),
    ((".bai", ".csi", ".fai", ".gzi", ".tbi"), "index"),
    ((".gtf", ".gff", ".gff3", ".gtf.gz", ".gff.gz", ".gff3.gz", ".bed", ".bed.gz"), "annotation"),
    ((".json",), "session"),
)
OPENABLE = {"bam", "bigbed", "fasta", "map"}


def ensure_local_mode() -> None:
    from services.runtime import get_lab_mode, get_public_mode
    if get_public_mode():
        raise PermissionError(LOCAL_ONLY_MESSAGE)
    if get_lab_mode():
        raise PermissionError(LAB_MESSAGE)


def file_kind(name: str) -> str:
    lower = name.lower()
    for suffixes, kind in KIND_BY_SUFFIX:
        if lower.endswith(suffixes):
            return kind
    return "other"


def _index_for(name: str, kind: str, names: set[str]) -> Optional[str]:
    if kind == "bam":
        stem = name[:-4] if name.lower().endswith(".bam") else name
        for candidate in (name + ".bai", stem + ".bai", name + ".csi", stem + ".csi"):
            if candidate in names:
                return candidate
        return None
    if kind == "fasta":
        if name + ".fai" not in names:
            return None
        if name.lower().endswith(".gz") and name + ".gzi" not in names:
            return None
        return name + ".fai"
    return None


def annotate_listing(payload: dict[str, Any], base_ref: str,
                     roots: Optional[list[str]] = None) -> dict[str, Any]:
    """Add each entry's reference, kind and (from sibling names) index presence."""
    entries = payload.get("entries") or []
    names = {e.get("name") for e in entries if e.get("type") == "file"}
    base = base_ref.rstrip("/")
    out = []
    for entry in entries:
        name = str(entry.get("name") or "")
        item = dict(entry)
        item["ref"] = f"{base}/{name}"
        if entry.get("type") == "dir":
            item["kind"] = "dir"
        else:
            kind = file_kind(name)
            item["kind"] = kind
            item["openable"] = kind in OPENABLE and not (kind == "fasta" and base.startswith("s3://"))
            if kind in ("bam", "fasta"):
                index = _index_for(name, kind, names)
                item["has_index"] = index is not None
                item["index"] = index
        out.append(item)
    payload = dict(payload)
    payload["entries"] = out
    payload["parent_ref"] = _parent_ref(base, roots)
    return payload


def _parent_ref(ref: str, roots: Optional[list[str]]) -> Optional[str]:
    """The folder above ``ref`` when it can still be listed (inside a shared root)."""
    scheme, _sep, rest = ref.partition("://")
    target, _slash, path = rest.partition("/")
    path = "/" + path.rstrip("/")
    if path == "/":
        return None
    parent = posixpath.dirname(path)
    if roots is not None and not any(parent == r or parent.startswith(r.rstrip("/") + "/") for r in roots):
        return None
    return f"{scheme}://{target}{parent if parent != '/' else '/'}"


def _source_or_error(scheme: str):
    source = get_source(scheme)
    if source is None:
        raise RemoteSourceError(f"Unknown source '{scheme}'")
    return source


def sources_status(*, probe: bool = True) -> dict[str, Any]:
    ensure_local_mode()
    sources = []
    for source in all_sources():
        try:
            sources.append(source.describe(probe=probe))
        except Exception as exc:  # a broken optional source must not hide the others
            sources.append({"scheme": source.scheme, "label": source.label, "available": False,
                            "problem": str(exc), "connections": []})
    return {"sources": sources}


def connect(params: dict[str, Any]) -> dict[str, Any]:
    ensure_local_mode()
    scheme = str(params.get("source") or "ssh")
    source = _source_or_error(scheme)
    try:
        result = {"success": True, "connection": source.connect(params)}
    except (RemoteSourceError, SshCommandError) as exc:
        return {"success": False, "error": str(exc)}
    _forget_cached_handles()  # a (re)connection may reach files that changed meanwhile
    return result


def disconnect(params: dict[str, Any]) -> dict[str, Any]:
    ensure_local_mode()
    scheme = str(params.get("source") or "ssh")
    target = str(params.get("target") or "")
    source = _source_or_error(scheme)
    try:
        result = source.disconnect(target, close_master=bool(params.get("close_master")))
    except (RemoteSourceError, SshCommandError) as exc:
        return {"success": False, "error": str(exc)}
    _forget_cached_handles()
    return result


def _forget_cached_handles() -> None:
    """Open handles to a closed connection are dead; the next read reopens."""
    # Handles are keyed by the live URL, so nothing reads a dead one after a
    # reconnect; only the memos keyed by reference are worth clearing.
    from services.remote_sources import opening
    opening.forget_remote_state()


def list_folder(ref: str) -> dict[str, Any]:
    ensure_local_mode()
    source = source_for_ref(ref)
    if source is None:
        return {"success": False, "error": f"Not a remote reference: {ref}"}
    try:
        payload = source.list(ref)
    except NotConnectedError as exc:
        return {"success": False, "error": str(exc), "not_connected": True, "target": exc.target}
    except (RemoteSourceError, SshCommandError) as exc:
        return {"success": False, "error": str(exc)}
    base = payload.get("ref") or ref
    roots = None
    if ref_scheme(ref) == "ssh":
        conn = source.connection_for(ref, required=False)
        roots = list(conn.roots) if conn is not None else None
    return {"success": True, **annotate_listing(payload, base, roots)}


def _parent_folder(ref: str) -> Optional[str]:
    rest = ref.split("://", 1)[1]
    _target, _slash, path = rest.partition("/")
    parent = posixpath.dirname("/" + path)
    return parent or "/"


def refs_status(refs: Iterable[str]) -> dict[str, Any]:
    """Which references can be opened now; per target, the folders they sit in.

    Session restore and the Library use this to ask "Connect to <host>?"
    before loading, with the right folders pre-filled.
    """
    ensure_local_mode()
    targets: dict[tuple[str, str], dict[str, Any]] = {}
    items = []
    for ref in refs or []:
        if not isinstance(ref, str):
            continue
        scheme = ref_scheme(ref)
        source = source_for_ref(ref) if scheme else None
        if source is None:
            continue
        try:
            connected = bool(source.is_connected(ref))
        except Exception:
            connected = False
        target = ref.split("://", 1)[1].split("/", 1)[0]
        items.append({"ref": ref, "source": scheme, "target": target, "connected": connected})
        group = targets.setdefault((scheme, target), {"source": scheme, "target": target, "connected": connected,
                                                      "folders": [], "refs": 0})
        group["connected"] = group["connected"] and connected
        group["refs"] += 1
        folder = _parent_folder(ref)
        if folder and folder not in group["folders"]:
            group["folders"].append(folder)
    for group in targets.values():
        if group["source"] == "ssh":
            user, _at, host = group["target"].rpartition("@")
            group["host"] = host
            group["user"] = user or None
        group["folders"] = _collapse_folders(group["folders"])
    return {"refs": items, "targets": list(targets.values()),
            "disconnected": sum(1 for item in items if not item["connected"])}


def _collapse_folders(folders: list[str]) -> list[str]:
    """Drop folders inside another listed folder (the helper serves subfolders)."""
    kept: list[str] = []
    for folder in sorted(set(folders), key=len):
        if not any(folder == k or folder.startswith(k.rstrip("/") + "/") for k in kept):
            kept.append(folder)
    return kept


def shutdown_remote_sources() -> None:
    try:
        from services.remote_sources import _SOURCES
        source = _SOURCES.get("ssh")
        if source is not None:
            source.disconnect_all()
    except Exception:
        pass
