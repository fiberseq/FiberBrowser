"""Lift maps a BAM could be viewed through ("View on another assembly (live
lift)…", P3): graphlift sidecars next to the BAM or in its parent folder, in
the Library, and those of the live-lift datasets already open. Each says
whether the BAM's contigs are the map's source contigs."""
from __future__ import annotations

import os
from typing import Iterable, Optional

SUFFIX = ".graphlift.json"


def is_map_name(name: str) -> bool:
    """A graphlift sidecar manifest or a plain UCSC chain (services/lift/chain_map.py)."""
    from services.lift.chain_map import is_chain_path
    return str(name).endswith(SUFFIX) or is_chain_path(name)
MAX_SUGGESTIONS = 20
# A folder next to a BAM can be large or on a slow network share: each scan
# reads at most this many entries, and at most this many subfolders.
MAX_DIR_ENTRIES = 2000
MAX_SUBFOLDERS = 64


def _bam_contigs(path: str) -> Optional[set]:
    try:
        import pysam
        with pysam.AlignmentFile(path, "rb") as bam:
            return set(bam.references)
    except Exception:  # noqa: BLE001 - an unreadable header leaves the match unknown
        return None


def _entries(folder: str, want) -> list:
    """Paths of the first MAX_DIR_ENTRIES entries of ``folder`` that ``want``
    accepts, sorted (unreadable: none)."""
    out = []
    try:
        with os.scandir(folder) as it:
            for i, entry in enumerate(it):
                if i >= MAX_DIR_ENTRIES:
                    break
                try:
                    if want(entry):
                        out.append(entry.path)
                except OSError:
                    continue
    except OSError:
        return []
    return sorted(out)


def _maps_in(folder: str) -> list:
    return _entries(folder, lambda e: is_map_name(e.name) and e.is_file())


def _candidates(state, near: str) -> Iterable[tuple[str, str]]:
    """Candidate maps, nearest first, scanned lazily: the caller stops reading
    (and scanning) once it has enough."""
    folder = os.path.dirname(os.path.abspath(os.path.expanduser(near)))
    for path in _maps_in(folder):
        yield path, "next to the BAM"
    for path in _maps_in(os.path.dirname(folder)):
        yield path, "in its parent folder"
    subfolders = _entries(folder, lambda e: not e.name.startswith(".") and e.is_dir(follow_symlinks=False))
    for sub in subfolders[:MAX_SUBFOLDERS]:
        for path in _maps_in(sub):
            yield path, "in a subfolder"
    try:
        from services import library_store
        # Read-only: no lock (nothing is written), so a suggestion never touches the Library's files.
        for entry in library_store._read_unlocked().get("entries", {}).values():
            path = str(entry.get("path") or "")
            if is_map_name(path):
                yield path, "in the Library"
    except Exception:  # noqa: BLE001 - the Library is optional here
        pass
    for dataset in getattr(state, "datasets", {}).values():
        config = getattr(dataset, "live_lift", None)
        if config is not None:
            yield config.manifest, "used by an open live-lift dataset"


def suggest_maps(state, near: str) -> dict:
    from services.lift.registration import require_enabled
    from services.lift.live_lift import open_lift_map
    from services.lift.dataset import label_order
    require_enabled()
    contigs = _bam_contigs(os.path.expanduser(near)) if near else None
    out, seen = [], set()
    candidates = iter(_candidates(state, near))
    # The cap is checked before the next candidate is asked for: that may scan another folder.
    while len(out) < MAX_SUGGESTIONS:
        try:
            path, where = next(candidates)
        except StopIteration:
            break
        real = os.path.realpath(path)
        if real in seen:
            continue
        seen.add(real)
        try:
            handle = open_lift_map(path)
        except Exception as exc:  # noqa: BLE001 - listed as unreadable rather than hidden
            out.append({"manifest": path, "where": where, "error": str(exc)[:200]})
            continue
        sources = {s["name"] for s in handle.manifest["sources"]}
        shared = len(sources & contigs) if contigs is not None else None
        out.append({"manifest": handle.path, "where": where,
                    "haplotypes": [handle.haplotype_labels.get(h, h) for h in sorted(handle.haplotypes,
                                   key=lambda h: label_order(handle.haplotype_labels.get(h, h)))],
                    "targets": len(handle.manifest["targets"]), "shared_contigs": shared,
                    "matches_bam": None if shared is None else shared > 0})
    out.sort(key=lambda s: (s.get("matches_bam") is not True, "error" in s))
    return {"near": near, "maps": out,
            "help": "A lift map, either a graphlift map (.graphlift.json) or a plain UCSC chain (.chain, .chain.gz), relates the BAM's assembly (its contig names) to this genome. "
                    "Build one with graphlift from the assemblies' chains and place it next to the BAM, or add it to the "
                    "Library, then pick it here."}
