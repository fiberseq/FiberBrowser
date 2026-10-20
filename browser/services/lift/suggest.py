"""Lift maps a BAM could be viewed through ("View on another assembly (live
lift)…", P3): graphlift sidecars next to the BAM or in its parent folder, in
the Library, and those of the live-lift datasets already open. Each says
whether the BAM's contigs are the map's source contigs."""
from __future__ import annotations

import glob
import os
from typing import Iterable, Optional

SUFFIX = ".graphlift.json"
MAX_SUGGESTIONS = 20


def _bam_contigs(path: str) -> Optional[set]:
    try:
        import pysam
        with pysam.AlignmentFile(path, "rb") as bam:
            return set(bam.references)
    except Exception:  # noqa: BLE001 - an unreadable header leaves the match unknown
        return None


def _candidates(state, near: str) -> Iterable[tuple[str, str]]:
    folder = os.path.dirname(os.path.abspath(os.path.expanduser(near)))
    for where, pattern in (("next to the BAM", os.path.join(folder, "*" + SUFFIX)),
                           ("in its parent folder", os.path.join(os.path.dirname(folder), "*" + SUFFIX)),
                           ("in a subfolder", os.path.join(folder, "*", "*" + SUFFIX))):
        for path in sorted(glob.glob(pattern)):
            yield path, where
    try:
        from services import library_store
        # Read-only: no lock (nothing is written), so a suggestion never touches the Library's files.
        for entry in library_store._read_unlocked().get("entries", {}).values():
            path = str(entry.get("path") or "")
            if path.endswith(SUFFIX):
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
    for path, where in _candidates(state, near):
        real = os.path.realpath(path)
        if real in seen or len(out) >= MAX_SUGGESTIONS:
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
            "help": "A graphlift map (.graphlift.json) relates the BAM's assembly (its contig names) to this genome. "
                    "Build one with graphlift from the assemblies' chains and place it next to the BAM, or add it to the "
                    "Library, then pick it here."}
