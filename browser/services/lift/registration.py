"""Opening, inspecting and restoring live-lift datasets (DESIGN_LIVE_LIFT.md §2.1, §4).

A lifted dataset is registered like a BAM dataset (layers from the source BAM's
tags) with ``data_type='bam_livelift'`` and a ``live_lift`` config; it seeds an
empty state's chromosomes from the map's targets (never from the source
header) and is never put through the main-genome check (its BAM is aligned to
another assembly by design; ``validate.validate_live_lift`` checks it).
"""
from __future__ import annotations

import os
from typing import Iterable, Optional

from services.lift.dataset import LiveLiftConfig, label_order, live_lift_enabled
from services.lift.live_lift import LiftSettings, LiftSettingsError, open_lift_map

DISABLED_MESSAGE = ("This session or request uses a live-lift dataset, which is turned off in this server. "
                    "Start FiberBrowser with FIBERBROWSER_LIVE_LIFT=1 to open it.")


class LiveLiftDisabled(Exception):
    status_code = 404

    def __init__(self):
        super().__init__(DISABLED_MESSAGE)


def require_enabled() -> None:
    if not live_lift_enabled():
        raise LiveLiftDisabled()


def inspect_map(manifest: str) -> dict:
    """What the add dialog shows for a sidecar: its haplotypes (key and label)
    and target/source names."""
    require_enabled()
    handle = open_lift_map(os.path.expanduser(manifest))
    return {
        "manifest": handle.path,
        "haplotypes": [{"key": hap, "label": handle.haplotype_labels.get(hap, hap)}
                       for hap in sorted(handle.haplotypes, key=lambda h: label_order(handle.haplotype_labels.get(h, h)))],
        "targets": [t["name"] for t in handle.manifest["targets"]],
        "sources": len(handle.manifest["sources"]),
        "chains": len(handle.map.chains),
    }


def _map_chroms(handle):
    from models.domain import ChromInfo
    return [ChromInfo(name=t["name"], size=int(t.get("size") or 0)) for t in handle.manifest["targets"]]


def add_live_lift_dataset(state, *, paths: Iterable[str], manifest: str, haplotypes: Iterable[str] = (),
                          settings: Optional[dict] = None, label: Optional[str] = None,
                          dataset_id: Optional[str] = None, source_fasta: Optional[str] = None) -> dict:
    """Validate and register a live-lift dataset; the payload is the dataset
    add route's (``{success, dataset, warnings}`` or ``{success: False, error}``)
    plus ``validation``."""
    require_enabled()
    from services.dataset_endpoint import (ensure_local_bam_indexes, infer_dataset_label_and_id,
                                           normalize_local_paths, validate_dataset_paths)
    from services.lift.validate import validate_live_lift

    raw = [p for p in paths if p]
    if not raw:
        return {"success": False, "error": "Choose the source BAM file(s)."}
    if not manifest:
        return {"success": False, "error": "Choose the lift map: a graphlift sidecar (.graphlift.json) or a UCSC chain (.chain, .chain.gz)."}
    # Absolute paths (a relative one would not reopen from a session started elsewhere).
    bam_paths = [p if "://" in str(p) else os.path.abspath(os.path.expanduser(str(p))) for p in normalize_local_paths(raw)]
    errors = validate_dataset_paths(bam_paths, raw)
    if errors:
        return {"success": False, "error": "\n\n".join(errors)}
    if any(not str(p).lower().endswith(".bam") for p in bam_paths):
        return {"success": False, "error": "Live lift reads BAM files only."}
    index_error = ensure_local_bam_indexes(bam_paths)
    if index_error:
        return index_error
    # Provenance groups are keyed by the BAMs as the user named them: key them by the same normalized
    # paths the dataset keeps, so cohort identities survive a relative path, a symlink or a session restore.
    settings = _portable_groups(settings, dict(zip(raw, bam_paths)))
    try:
        config = LiveLiftConfig(manifest, list(haplotypes), LiftSettings.from_dict(settings), source_fasta=source_fasta)
    except (LiftSettingsError, ValueError, OSError) as exc:
        return {"success": False, "error": f"Live lift: {exc}"}
    target_sizes = {c.name: c.size for c in (state.chroms or [])} or None
    validation = validate_live_lift(config.handle, bam_paths, config.haplotypes, target_sizes=target_sizes,
                                    target_fasta=getattr(state, "fasta", None), source_fasta=config.source_fasta)
    if not validation.ok:
        return {"success": False, "error": "Live lift: " + " ".join(validation.errors), "validation": validation.as_dict()}
    config.haplotypes = list(validation.haplotypes)
    config.validation = validation.as_dict()
    default_label, base_id = infer_dataset_label_and_id(bam_paths)
    hap_names = "+".join(config.labels()[h] for h in config.haplotypes)
    label = label or f"{default_label} · live lift {hap_names}"

    def configure(dataset):
        dataset.live_lift = config

    path_arg = bam_paths if len(bam_paths) > 1 else bam_paths[0]
    dataset = state.add_dataset(dataset_id or f"{base_id}_livelift", path_arg, label=label, data_type="bam_livelift",
                                configure=configure, detect_chroms=lambda _path: _map_chroms(config.handle))
    result = {"success": True, "dataset": dataset.to_dict(), "validation": validation.as_dict()}
    notes = [*validation.warnings, *validation.info]
    if notes:
        result["warnings"] = notes
    return result


def update_settings(state, dataset_id: str, settings: Optional[dict] = None,
                    haplotypes: Optional[Iterable[str]] = None) -> dict:
    """Change a lifted dataset's advanced settings and/or haplotypes; the new
    ``lift_key`` makes every cache built under the old one unreachable."""
    require_enabled()
    dataset = state.get_dataset(dataset_id) if hasattr(state, "get_dataset") else state.datasets.get(dataset_id)
    config = getattr(dataset, "live_lift", None)
    if config is None:
        return {"success": False, "error": "Not a live-lift dataset."}
    try:
        merged = {**config.settings.as_dict(), **(settings or {})}
        new = LiveLiftConfig(config.manifest, list(haplotypes) if haplotypes is not None else config.haplotypes,
                             LiftSettings.from_dict(merged), source_fasta=config.source_fasta)
    except (LiftSettingsError, ValueError) as exc:
        return {"success": False, "error": f"Live lift: {exc}"}
    from services.lift.validate import validate_live_lift
    validation = validate_live_lift(new.handle, dataset.paths, new.haplotypes,
                                    target_sizes={c.name: c.size for c in (state.chroms or [])} or None,
                                    target_fasta=getattr(state, "fasta", None), source_fasta=new.source_fasta)
    if not validation.ok:
        # Validate the candidate before mutating anything: rejected haplotypes
        # must leave both the dataset and its warm caches under the old key.
        return {"success": False, "error": "Live lift: " + " ".join(validation.errors), "validation": validation.as_dict()}
    new.validation = validation.as_dict()
    dataset.live_lift = new
    dataset.cluster_assignments = {}
    dataset.cluster_element_info = None
    dataset.cluster_peak_regions = None
    dataset.cluster_feature_settings = None
    dataset.sorted_indices = None
    from services.dataset_registration import invalidate_dataset_caches
    invalidate_dataset_caches(state, dataset_id)
    return {"success": True, "dataset": dataset.to_dict()}


def _portable_groups(settings: Optional[dict], renamed: dict) -> Optional[dict]:
    """``settings`` with ``molecule_groups`` keys renamed through ``renamed`` (raw -> normalized path),
    then made absolute (records are matched to them through resolved paths, services/lift/joint.group_for)."""
    if not settings or not settings.get("molecule_groups"):
        return settings
    groups = settings["molecule_groups"]
    pairs = groups.items() if isinstance(groups, dict) else groups
    out = []
    for path, label in pairs:
        path = str(path)
        out.append([os.path.abspath(os.path.expanduser(renamed.get(path) or path)), label])
    return {**settings, "molecule_groups": out}


# ── Sessions (built-in plugin hooks, plugins/builtin_features.py) ───────────

def session_entry(dataset) -> Optional[dict]:
    config = getattr(dataset, "live_lift", None)
    if config is None:
        return None
    return {"live_lift": {"manifest": config.manifest, "haplotypes": list(config.haplotypes),
                          "settings": config.settings.as_dict(), "source_fasta": config.source_fasta}}


def owns_session_entry(entry: dict) -> bool:
    return bool(entry.get("live_lift")) or entry.get("data_type") == "bam_livelift"


def restore_from_session(state, entry: dict, *, path_mapping: Optional[dict] = None) -> dict:
    """Reopen a session's lifted dataset under its id and label (refused, with
    the "enable live lift" notice, while the flag is off)."""
    require_enabled()
    # Session import maps the entire entry already; direct restorers can use
    # the same rule, including manifest/source FASTA rather than just BAMs.
    original_paths = [str(p) for p in entry.get("paths") or []]
    if path_mapping:
        from services.session_files import apply_path_mapping
        entry = apply_path_mapping(entry, path_mapping)
    spec = dict(entry.get("live_lift") or {})
    # Provenance keys follow their BAMs through relocation (saved path i -> restored path i).
    spec["settings"] = _portable_groups(spec.get("settings"), dict(zip(original_paths, [str(p) for p in entry.get("paths") or []])))
    result = add_live_lift_dataset(state, paths=entry.get("paths") or [], manifest=spec.get("manifest"),
                                   haplotypes=spec.get("haplotypes") or (), settings=spec.get("settings"),
                                   label=entry.get("label"), dataset_id=entry.get("id"), source_fasta=spec.get("source_fasta"))
    if not result.get("success"):
        raise RuntimeError(result.get("error") or "live lift failed")
    return result
