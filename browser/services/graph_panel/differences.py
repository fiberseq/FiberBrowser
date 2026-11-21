"""Graph-panel inspection (DESIGN_GRAPH_PANEL.md §6, Gate F): a graph difference's
canonical live-lift difference, when one exists, and allele sequence.

**Canonical reuse.** A graph allele is a selected path's walk between two target
flanks. It reuses a live-lift dataset's canonical difference only when the
dataset's map *is* the package's map for that (target, source) pair: the
SHA-256 of the dataset's map manifest equals the package manifest's digest for
the pair. The difference must then sit at the same target boundary/span and the
same source placement (contig and span). Equal-flank grouping, a path name or a
nearest coordinate never stands in for that: a dataset on another map, or an
item at another placement, is listed with its reason and not reused. Without a
match the selection stays a graph-derived observation (provisional identity).
"""
from __future__ import annotations

import hashlib
import os
import threading
from typing import Optional

from services.graph_panel.reads import ReadsError, dataset_revision, path_name

MAX_SEQUENCE_BP = 60_000

_SHA: dict = {}
_SHA_LOCK = threading.Lock()


def file_sha256(path: str) -> Optional[str]:
    """A file's SHA-256, cached by (path, size, mtime)."""
    try:
        st = os.stat(path)
    except OSError:
        return None
    key = (os.path.abspath(path), st.st_size, st.st_mtime_ns)
    with _SHA_LOCK:
        hit = _SHA.get(key)
    if hit:
        return hit
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    out = h.hexdigest()
    with _SHA_LOCK:
        _SHA[key] = out
    return out


def _span(value, name: str) -> tuple:
    if not isinstance(value, dict) or not all(isinstance(value.get(k), int) and not isinstance(value.get(k), bool)
                                             for k in ("start", "end")):
        raise ReadsError("invalid_request", f"{name} must be {{start, end}} integers")
    a, b = value["start"], value["end"]
    if a < 0 or b < a:
        raise ReadsError("invalid_request", f"{name} must have 0 <= start <= end")
    return a, b


def canonical_differences(state, reg, body: dict) -> dict:
    """``{matches, rejected}`` for one graph allele: ``body`` names the target binding and its span (an empty span
    at an insertion boundary), the allele's path binding and its source span."""
    from services.lift.reads import is_lifted

    target = reg.binding(str(body.get("target") or ""))
    path = reg.binding(str(body.get("path") or ""))
    if target is None or path is None:
        raise ReadsError("invalid_request", "target and path must be bindings of this package")
    t0, t1 = _span(body.get("target_span"), "target_span")
    s0, s1 = _span(body.get("source_span"), "source_span")
    pair = next((m for m in reg.maps if m.get("target") == target["key"] and m.get("source") == path["key"]), None)
    want = (pair or {}).get("manifest_sha256")
    matches, rejected = [], []
    if pair is None:
        return {"matches": [], "rejected": [], "map": None,
                "reason": f"the package has no map from {target['key']} to {path['key']}"}
    contig = target["path"]["contig"]
    for dataset in list((getattr(state, "datasets", None) or {}).values()):
        if not is_lifted(dataset) or getattr(dataset, "is_remote", False):
            continue
        config = dataset.live_lift
        handle = config.handle
        source = next((s for s in handle.manifest.get("sources") or () if s.get("path") == path_name(path)), None)
        if source is None:
            continue   # not a dataset of this path: nothing to reuse or reject
        label = getattr(dataset, "label", dataset.id)
        have = file_sha256(handle.path)
        if not want or have != want:
            rejected.append({"dataset_id": dataset.id, "label": label, "reason": "map_differs",
                             "message": "its map is not this package's map for the path (different map file)"})
            continue
        if contig not in handle.map.targets:
            rejected.append({"dataset_id": dataset.id, "label": label, "reason": "no_target",
                             "message": f"its map has no {contig}"})
            continue
        from services.lift.differences import assembly_items_for_region
        hap = source.get("haplotype")
        items = assembly_items_for_region(config, contig, max(0, t0 - 1), max(t0, t1) + 1, lift_hap=hap)
        for item in items:
            src = item.get("src") or {}
            same_target = (item["t_start"], item["t_end"]) == (t0, t1)
            same_source = src.get("contig") == source.get("name") and (src.get("start"), src.get("end")) == (s0, s1)
            if same_target and same_source:
                matches.append({"dataset_id": dataset.id, "label": label, "id": item["id"],
                                "revision": dataset_revision(dataset), "kind": item.get("kind"),
                                "hap_label": item.get("hap_label"), "ref_bp": item.get("ref_bp"),
                                "alt_bp": item.get("alt_bp"), "t_start": item["t_start"], "t_end": item["t_end"],
                                "src": src})
            elif same_target or same_source:
                rejected.append({"dataset_id": dataset.id, "label": label, "reason": "other_placement",
                                 "id": item["id"], "message": (
                                     f"{item.get('kind')} at target {item['t_start']:,}-{item['t_end']:,}, source "
                                     f"{src.get('contig')}:{src.get('start')}-{src.get('end')}: another placement")})
    return {"matches": matches, "rejected": rejected, "map": {"target": target["key"], "source": path["key"],
                                                              "manifest_sha256": want}}
