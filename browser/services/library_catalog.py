"""Export Library groups as a ``--catalog`` JSON for public/reviewer deployments.

The output is exactly what ``catalog_endpoint`` reads::

    {"name", "genome"?, "groups": [{"name", "description", "merge",
      "datasets": [{"path", "label"}]}], "tracks": []}

With ``relative=True`` paths are written relative to the folder all the files
share, so the JSON can sit in that folder (``--catalog`` resolves relative
paths against the JSON's own folder) and the folder can be moved or copied to
a server as a whole. Plasmid maps and other non-dataset entries are reported
as ``skipped``: a catalog lists BAM/BigBed datasets and a genome only.
"""
from __future__ import annotations

import os
from typing import Optional

DATASET_KINDS = ("bam", "bigbed")


def _label(entry: dict) -> str:
    return entry.get("label_override") or entry.get("sample") or os.path.basename(entry.get("path") or "")


def build_catalog(data: dict, group_ids: list[str], *, name: Optional[str] = None,
                  relative: bool = False) -> dict:
    groups = [data["groups"][g] for g in group_ids if g in data["groups"]]
    if not groups:
        raise KeyError("No such group.")
    skipped: list[dict] = []
    rows: list[tuple[dict, list[dict]]] = []
    for group in groups:
        members = []
        for entry_id in group.get("entry_ids") or []:
            entry = data["entries"].get(entry_id)
            if entry is None:
                continue
            if entry.get("kind") not in DATASET_KINDS:
                skipped.append({"id": entry_id, "path": entry.get("path"), "reason": f"{entry.get('kind')} is not a catalog dataset"})
                continue
            members.append(entry)
        rows.append((group, members))
    paths = [os.path.abspath(e["path"]) for _, members in rows for e in members]
    base_dir = None
    if relative and paths:
        base_dir = os.path.commonpath([os.path.dirname(p) for p in paths])
    genomes = {(e.get("reference") or {}).get("genome") for _, members in rows for e in members}
    catalog: dict = {"name": name or (groups[0]["name"] if len(groups) == 1 else "FiberBrowser datasets")}
    if len(genomes) == 1 and None not in genomes:
        catalog["genome"] = next(iter(genomes))
    catalog["groups"] = []
    for group, members in rows:
        datasets = []
        for entry in members:
            path = os.path.abspath(entry["path"])
            datasets.append({"path": os.path.relpath(path, base_dir) if base_dir else path, "label": _label(entry)})
        catalog["groups"].append({"name": group.get("name") or "Group", "description": group.get("description") or "",
                                  "merge": False, "datasets": datasets})
    catalog["tracks"] = []
    return {"catalog": catalog, "base_dir": base_dir, "skipped": skipped}
