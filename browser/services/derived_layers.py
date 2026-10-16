"""Derived-layer sidecar discovery and manifest helpers."""
from __future__ import annotations

import json
import os
from typing import Any

from services.local_paths import normalize_local_path, path_access_error
from utils.validation import is_url


FIBERLAYERS_SCHEMA_PREFIX = "fiberlayers."
FIBERLAYERS_BASENAME_MARKER = ".fiberlayers."
FIBERLAYERS_EXTENSIONS = (".bb", ".bigbed", ".bigBed")
FIBERLAYERS_BED_EXTENSIONS = (".bed",)


def _manifest_candidates(path: str) -> list[str]:
    """Return likely manifest paths for a `.fiberlayers.bb` sidecar."""
    if is_url(path):
        return []

    base, _ext = os.path.splitext(path)
    candidates = [
        f"{base}.json",
        f"{base}_manifest.json",
    ]
    if base.endswith(".fiberlayers"):
        candidates.append(f"{base[:-len('.fiberlayers')]}.fiberlayers.json")
    parent = os.path.dirname(path)
    if parent:
        candidates.append(os.path.join(parent, "fiberlayers.json"))
    # Keep order, drop duplicates.
    out: list[str] = []
    seen = set()
    for candidate in candidates:
        if candidate not in seen:
            out.append(candidate)
            seen.add(candidate)
    return out


def load_derived_layer_manifest(path: str) -> dict[str, Any] | None:
    """Load the sidecar manifest for a derived-layer BigBed, if present."""
    from services.lab.paths import open_read
    for candidate in _manifest_candidates(path):
        if not os.path.exists(candidate):
            continue
        try:
            with open_read(candidate) as handle:  # a lab server: inside its data roots, by descriptor
                manifest = json.loads(handle.read().decode("utf-8"))
            if isinstance(manifest, dict):
                return manifest
        except Exception:
            continue
    return None


def load_derived_layer_manifest_file(path: str) -> dict[str, Any] | None:
    """Load a `.fiberlayers.json` manifest selected directly by the user."""
    if is_url(path) or not os.path.exists(path):
        return None
    from services.lab.paths import confine, open_read
    confine(path)  # a lab server's data roots
    try:
        with open_read(path) as handle:  # by descriptor on a lab server
            manifest = json.loads(handle.read().decode("utf-8"))
    except Exception:
        return None
    return manifest if is_derived_layer_manifest(manifest) else None


def is_derived_layer_manifest(manifest: Any) -> bool:
    if not isinstance(manifest, dict):
        return False
    schema = str(manifest.get("schema") or manifest.get("schema_version") or "")
    return schema.startswith(FIBERLAYERS_SCHEMA_PREFIX)


def is_derived_layer_bigbed(path: str) -> bool:
    """Return True for FiberBrowser derived-layer BigBed bundles."""
    basename = os.path.basename(path).lower()
    if FIBERLAYERS_BASENAME_MARKER in basename and basename.endswith(
        tuple(ext.lower() for ext in FIBERLAYERS_EXTENSIONS)
    ):
        return True
    return is_derived_layer_manifest(load_derived_layer_manifest(path))


def is_derived_layer_bed(path: str) -> bool:
    """Return True for local FiberBrowser derived-layer BED fallback bundles."""
    basename = os.path.basename(path).lower()
    if FIBERLAYERS_BASENAME_MARKER not in basename:
        return False
    if not basename.endswith(tuple(ext.lower() for ext in FIBERLAYERS_BED_EXTENSIONS)):
        return False
    return is_derived_layer_manifest(load_derived_layer_manifest(path))


def resolve_derived_layer_payload_path(path: str) -> tuple[str | None, str | None]:
    """Resolve a user-selected `.fiberlayers` manifest, BigBed, or BED payload.

    The JSON manifest is the catalog; interval payloads can come from the
    indexed BigBed when present, or from the local BED fallback for small sets.
    """
    if not path:
        return None, "No derived-layer bundle selected"

    original_path = path
    if not is_url(path):
        path = normalize_local_path(path)
    lower = path.lower()
    if lower.endswith(".json"):
        access_error = None if is_url(path) else path_access_error(path, original_path=original_path, expected="file")
        if access_error:
            return None, access_error
        manifest = load_derived_layer_manifest_file(path)
        if not manifest:
            return None, "Selected JSON is not a FiberBrowser `.fiberlayers` manifest"

        parent = os.path.dirname(os.path.abspath(path))
        candidates: list[str] = []
        files = manifest.get("files") if isinstance(manifest.get("files"), dict) else {}
        bigbed_name = files.get("bigbed") if isinstance(files, dict) else None
        bed_name = files.get("bed") if isinstance(files, dict) else None
        if bigbed_name:
            candidates.append(
                bigbed_name if os.path.isabs(str(bigbed_name))
                else os.path.join(parent, str(bigbed_name))
            )
        if lower.endswith(".fiberlayers.json"):
            candidates.append(path[:-len(".fiberlayers.json")] + ".fiberlayers.bb")
        candidates.append(os.path.splitext(path)[0] + ".bb")
        if bed_name:
            candidates.append(
                bed_name if os.path.isabs(str(bed_name))
                else os.path.join(parent, str(bed_name))
            )
        if lower.endswith(".fiberlayers.json"):
            candidates.append(path[:-len(".fiberlayers.json")] + ".fiberlayers.bed")
        candidates.append(os.path.splitext(path)[0] + ".bed")

        seen = set()
        for candidate in candidates:
            if not candidate or candidate in seen:
                continue
            seen.add(candidate)
            if os.path.exists(candidate):
                return candidate, None
        return (
            None,
            "Derived-layer manifest found, but neither the `.fiberlayers.bb` nor `.fiberlayers.bed` payload is present."
        )

    payload_extensions = tuple(ext.lower() for ext in FIBERLAYERS_EXTENSIONS + FIBERLAYERS_BED_EXTENSIONS)
    if not lower.endswith(payload_extensions):
        return None, "Select a `.fiberlayers.json`, `.fiberlayers.bb`, or `.fiberlayers.bed` bundle"
    if not is_url(path) and not os.path.exists(path):
        return None, path_access_error(path, original_path=original_path, expected="file") or f"Derived-layer payload not found: {path}"
    if lower.endswith(tuple(ext.lower() for ext in FIBERLAYERS_BED_EXTENSIONS)):
        basename = os.path.basename(path).lower()
        if ".fiberlayers." not in basename:
            return None, "Selected BED is not a FiberBrowser `.fiberlayers` bundle"
        return path, None
    if not is_derived_layer_bigbed(path):
        return None, "Selected BigBed is not a FiberBrowser `.fiberlayers` bundle"
    return path, None


def resolve_derived_layer_bigbed_path(path: str) -> tuple[str | None, str | None]:
    """Backward-compatible wrapper for callers using the old helper name."""
    return resolve_derived_layer_payload_path(path)


def find_derived_layer_bigbeds(primary_path: str) -> list[str]:
    """Find sibling `.fiberlayers` payloads next to a local dataset path.

    The public name is kept for compatibility, but discovery now accepts the
    local `.fiberlayers.bed` fallback written when `bedToBigBed` is absent.
    """
    if is_url(primary_path):
        return []
    parent = primary_path if os.path.isdir(primary_path) else os.path.dirname(os.path.abspath(primary_path))
    if not parent or not os.path.isdir(parent):
        return []

    paths = []
    payload_extensions = tuple(ext.lower() for ext in FIBERLAYERS_EXTENSIONS + FIBERLAYERS_BED_EXTENSIONS)
    for fname in sorted(os.listdir(parent)):
        lower = fname.lower()
        if not lower.endswith(payload_extensions):
            continue
        full_path = os.path.join(parent, fname)
        if is_derived_layer_bigbed(full_path) or is_derived_layer_bed(full_path):
            paths.append(full_path)
    return paths


def derived_layer_definitions_from_manifest(
    manifest: dict[str, Any] | None,
    *,
    bundle_path: str,
) -> dict[str, dict[str, Any]]:
    """Normalize manifest classes into dataset.derived_layers entries."""
    if not manifest:
        return {}

    raw_classes = manifest.get("classes") or manifest.get("layers") or {}
    if isinstance(raw_classes, list):
        iterable = []
        for item in raw_classes:
            if isinstance(item, dict):
                layer_id = item.get("id") or item.get("class_id") or item.get("name")
                if layer_id:
                    iterable.append((str(layer_id), item))
    elif isinstance(raw_classes, dict):
        iterable = [(str(layer_id), meta) for layer_id, meta in raw_classes.items()]
    else:
        iterable = []

    source_dataset = manifest.get("source_dataset") if isinstance(manifest.get("source_dataset"), dict) else {}
    provenance = manifest.get("provenance") if isinstance(manifest.get("provenance"), dict) else {}

    out: dict[str, dict[str, Any]] = {}
    for layer_id, meta in iterable:
        if not isinstance(meta, dict):
            meta = {}
        label = meta.get("label") or meta.get("name") or layer_id
        source_layer = meta.get("source_layer") or meta.get("sourceLayer") or ""
        out[layer_id] = {
            "id": layer_id,
            "label": str(label),
            "source_layer": str(source_layer) if source_layer is not None else "",
            "kind": str(meta.get("kind") or "derived_layer"),
            "color": meta.get("color"),
            "rules": meta.get("rules") or {},
            "version": meta.get("version"),
            "bundle_path": bundle_path,
            "manifest_path": _manifest_candidates(bundle_path)[0] if _manifest_candidates(bundle_path) else None,
            "source_dataset": source_dataset,
            "provenance": provenance,
        }
    return out


def load_derived_layer_definitions(path: str) -> dict[str, dict[str, Any]]:
    """Load normalized derived-layer definitions for a bundle path."""
    return derived_layer_definitions_from_manifest(
        load_derived_layer_manifest(path),
        bundle_path=path,
    )
