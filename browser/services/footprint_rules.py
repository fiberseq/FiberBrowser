"""Portable Footprint Analysis rule-set save/load helpers."""
from __future__ import annotations

import json
import os
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from services.derived_layers import is_derived_layer_manifest, load_derived_layer_manifest_file
from services.layer_aliases import normalize_annotation_layer
from services.local_paths import normalize_local_path, path_access_error


RULE_SCHEMA = "fiberbrowser.footprint_rules.v1"


def _slug(value: str) -> str:
    text = str(value or "").strip()
    text = re.sub(r"[^A-Za-z0-9_.-]+", "_", text)
    text = re.sub(r"_+", "_", text).strip("_.-")
    return text or "footprint_rules"


def _dedupe_path(output_dir: str, base: str) -> str:
    candidate = base
    suffix = 2
    while os.path.exists(os.path.join(output_dir, f"{candidate}.fiberlayer-rules.json")):
        candidate = f"{base}_{suffix}"
        suffix += 1
    return os.path.join(output_dir, f"{candidate}.fiberlayer-rules.json")


def _jsonable(value: Any) -> Any:
    try:
        json.dumps(value)
        return value
    except TypeError:
        if isinstance(value, dict):
            return {str(k): _jsonable(v) for k, v in value.items()}
        if isinstance(value, (list, tuple, set)):
            return [_jsonable(v) for v in value]
        return str(value)


def _cart_layer_from_source(source_layer: Any) -> Optional[str]:
    layer = normalize_annotation_layer(source_layer)
    if layer in {None, "footprint", "primary"}:
        return None
    return layer


_SAVED_CLASS_ID = re.compile(r"^S\d+$")


def _finite_number(value: Any) -> bool:
    import math
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def normalize_saved_class(info: Any) -> Optional[dict[str, Any]]:
    """A saved lattice-recaller class definition (frontend SavedClassInfo), validated, or None when malformed.

    It carries the definition's identity (S1, S2, ...), the class in its run, every channel the run quantified it on,
    the channels picked for this definition and that run's per-channel statistics."""
    if not isinstance(info, dict):
        return None
    text = lambda key: isinstance(info.get(key), str)
    if not (text("id") and _SAVED_CLASS_ID.match(info["id"]) and text("family") and info["family"]):
        return None
    if not (_finite_number(info.get("start")) and _finite_number(info.get("end"))):
        return None
    channels = info.get("channels")
    if not isinstance(channels, list):
        return None
    clean_channels = []
    for channel in channels:
        if not isinstance(channel, dict) or not all(isinstance(channel.get(k), str) for k in ("key", "datasetId", "strand", "label")):
            return None
        clean_channels.append({**({"source": _jsonable(channel["source"])} if isinstance(channel.get("source"), dict) else {}), "key": channel["key"], "datasetId": channel["datasetId"], "strand": channel["strand"],
                               "label": channel["label"], "daf": bool(channel.get("daf", False))})
    keys = {c["key"] for c in clean_channels}
    picked = info.get("picked")
    if not isinstance(picked, list) or not all(isinstance(k, str) and k in keys for k in picked):
        return None
    stats = info.get("stats")
    if not isinstance(stats, dict) or not all(isinstance(k, str) and isinstance(v, dict) for k, v in stats.items()):
        return None
    return {
        "id": info["id"],
        "family": info["family"],
        "className": str(info.get("className") or info["family"]),
        "runLabel": str(info.get("runLabel") or ""),
        "start": info["start"],
        "end": info["end"],
        "channels": clean_channels,
        "stats": _jsonable(stats),
        "picked": list(picked),
    }


def normalize_footprint_group(group: dict[str, Any], *, idx: int = 0, preserve_id: bool = True) -> dict[str, Any]:
    """Normalize a saved/imported cart group to the frontend FootprintGroup shape."""
    if not isinstance(group, dict):
        group = {}

    source_layer = group.get("layer", group.get("source_layer"))
    if source_layer is None and isinstance(group.get("rules"), dict):
        source_layer = group["rules"].get("source_layer")
    rules = group.get("rules") if isinstance(group.get("rules"), dict) else {}

    def pick(*keys, default=None):
        for key in keys:
            if key in group:
                return group.get(key)
            if key in rules:
                return rules.get(key)
        return default

    raw_id = group.get("id") if preserve_id else None
    group_id = str(raw_id or f"rule_{uuid.uuid4().hex[:12]}")

    size_bp = pick("size_bp", default=None)
    size_min = pick("sizeMin", "size_min", default=None)
    size_max = pick("sizeMax", "size_max", default=None)
    if isinstance(size_bp, (list, tuple)) and len(size_bp) >= 2:
        size_min = size_min if size_min is not None else size_bp[0]
        size_max = size_max if size_max is not None else size_bp[1]
    if size_max == "":
        size_max = None
    source_index = group.get("sourceIndex", group.get("source_index", -1))

    out = {
        "id": group_id,
        "name": str(group.get("name") or group.get("label") or f"Footprint rule {idx + 1}"),
        "color": str(group.get("color") or "#2f9e44"),
        "layer": _cart_layer_from_source(source_layer),
        "derivedLayerId": group.get("derivedLayerId") or group.get("derived_layer_id"),
        "derivedBundlePath": group.get("derivedBundlePath") or group.get("derived_bundle_path"),
        "sizeMin": int(size_min or 0),
        "sizeMax": int(size_max) if size_max is not None else None,
        "referenceAbsStart": pick("referenceAbsStart", "reference_abs_start", default=None),
        "referenceAbsEnd": pick("referenceAbsEnd", "reference_abs_end", default=None),
        "referenceChrom": pick("referenceChrom", "reference_chrom", default=None),
        "minFpCoverage": pick("minFpCoverage", "min_fp_coverage", default=None),
        "minTargetCoverage": pick("minTargetCoverage", "min_target_coverage", default=None),
        "overlapMode": pick("overlapMode", "overlap_mode", default=None),
        "overlapFraction": float(pick("overlapFraction", "overlap_fraction", default=0) or 0),
        "conditions": _jsonable(pick("conditions", default=[])) or [],
        "enabled": bool(group.get("enabled", True)),
        "sourceIndex": int(source_index) if source_index is not None else -1,
        # Links back to a found footprint state / tagged family. Without these,
        # a saved state reloads as a plain positional rule.
        "consensusStateId": pick("consensusStateId", "consensus_state_id", default=None),
        "consensusJobId": pick("consensusJobId", "consensus_job_id", default=None),
        "sourceDatasetId": pick("sourceDatasetId", "source_dataset_id", default=None),
        "consensusDatasetId": pick("consensusDatasetId", "consensus_dataset_id", default=None),
        "familyId": pick("familyId", "family_id", default=None),
        "familyAnnotationName": pick("familyAnnotationName", "family_annotation_name", default=None),
        # A family's model bounds take precedence over the reference bounds in matching.
        "familyModelAbsStart": pick("familyModelAbsStart", "family_model_abs_start", default=None),
        "familyModelAbsEnd": pick("familyModelAbsEnd", "family_model_abs_end", default=None),
        "consensusStage": pick("consensusStage", "consensus_stage", default=None),
        "consensusStrand": pick("consensusStrand", "consensus_strand", default=None),
        "consensusTier": pick("consensusTier", "consensus_tier", default=None),
        "minFamilyConfidence": pick("minFamilyConfidence", "min_family_confidence", default=None),
        # A saved recaller class (S1, S2, ...): without it the entry reloads as a plain class link, losing its card,
        # channels, counts and its place in the saved prevalence plot and TSV.
        "savedClass": normalize_saved_class(group.get("savedClass", group.get("saved_class"))),
    }

    # Drop null-ish optional fields so saved files stay compact.
    return {key: value for key, value in out.items() if value is not None}


def groups_from_fiberlayers_manifest(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    """Convert a materialized fiberlayers manifest back into portable cart rules."""
    raw_classes = manifest.get("classes") or manifest.get("layers") or {}
    if isinstance(raw_classes, dict):
        iterable = list(raw_classes.items())
    elif isinstance(raw_classes, list):
        iterable = [
            (str(item.get("id") or item.get("class_id") or item.get("name") or f"class_{idx + 1}"), item)
            for idx, item in enumerate(raw_classes)
            if isinstance(item, dict)
        ]
    else:
        iterable = []

    groups = []
    for idx, (class_id, meta) in enumerate(iterable):
        if not isinstance(meta, dict):
            meta = {}
        rules = meta.get("rules") if isinstance(meta.get("rules"), dict) else {}
        groups.append(normalize_footprint_group({
            "id": f"rule_{class_id}",
            "name": meta.get("label") or meta.get("name") or class_id,
            "color": meta.get("color") or "#2f9e44",
            "layer": rules.get("source_layer") or meta.get("source_layer"),
            "derivedLayerId": class_id,
            "rules": rules,
            "enabled": True,
            "sourceIndex": -1,
        }, idx=idx, preserve_id=True))
    return groups


def build_rule_payload(
    *,
    groups: list[dict[str, Any]],
    name: Optional[str] = None,
    context: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    normalized = [
        normalize_footprint_group(group, idx=idx, preserve_id=True)
        for idx, group in enumerate(groups or [])
    ]
    return {
        "schema": RULE_SCHEMA,
        "name": name or "Footprint rules",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "context": _jsonable(context or {}),
        "groups": normalized,
    }


def save_footprint_rule_file(
    *,
    groups: list[dict[str, Any]],
    output_dir: str,
    bundle_name: Optional[str] = None,
    context: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    from services.lab.paths import confine
    confine(output_dir, write=True)  # a lab server: only in a writable data root
    os.makedirs(output_dir, exist_ok=True)
    base = _slug(bundle_name or "footprint_rules")
    path = _dedupe_path(output_dir, base)
    payload = build_rule_payload(groups=groups, name=bundle_name or base, context=context)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")
    return {
        "path": path,
        "groups": payload["groups"],
        "n_rules": len(payload["groups"]),
        "schema": payload["schema"],
    }


def load_footprint_rule_file(path: str) -> dict[str, Any]:
    from services.lab.paths import confine
    confine(path)  # a lab server's data roots
    original_path = path
    path = normalize_local_path(path)
    access_error = path_access_error(path, original_path=original_path, expected="file")
    if access_error:
        raise ValueError(access_error)

    manifest = load_derived_layer_manifest_file(path)
    if manifest is None:
        try:
            with open(path, "r", encoding="utf-8") as handle:
                manifest = json.load(handle)
        except Exception as exc:
            raise ValueError(f"Could not read footprint rule file: {exc}") from exc

    if not isinstance(manifest, dict):
        raise ValueError("Footprint rule file must be a JSON object")

    schema = str(manifest.get("schema") or manifest.get("schema_version") or "")
    if schema == RULE_SCHEMA or schema.startswith("fiberbrowser.footprint_rules."):
        groups = [
            normalize_footprint_group(group, idx=idx, preserve_id=True)
            for idx, group in enumerate(manifest.get("groups") or [])
            if isinstance(group, dict)
        ]
    elif "footprint_groups" in manifest:
        groups = [
            normalize_footprint_group(group, idx=idx, preserve_id=True)
            for idx, group in enumerate(manifest.get("footprint_groups") or [])
            if isinstance(group, dict)
        ]
    elif is_derived_layer_manifest(manifest):
        groups = groups_from_fiberlayers_manifest(manifest)
    else:
        raise ValueError("Selected JSON is not a footprint-rule or fiberlayers manifest")

    return {
        "path": path,
        "groups": groups,
        "n_rules": len(groups),
        "schema": schema or RULE_SCHEMA,
        "name": manifest.get("name"),
        "context": manifest.get("context") or manifest.get("scope") or {},
    }
