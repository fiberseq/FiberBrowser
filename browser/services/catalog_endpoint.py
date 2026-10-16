"""Endpoint workflow helpers for read-only dataset catalogs."""
from __future__ import annotations

import os
from typing import Any

from services.diagnostics import env_flag_enabled, log_if_enabled

_catalog: dict[str, Any] | None = None
CATALOG_DIAGNOSTICS_ENV = "FIBERBROWSER_CATALOG_DIAGNOSTICS"


def catalog_diagnostics_enabled() -> bool:
    return env_flag_enabled(CATALOG_DIAGNOSTICS_ENV)


def log_catalog_diagnostic(message: str) -> None:
    log_if_enabled(CATALOG_DIAGNOSTICS_ENV, message)


def set_catalog(catalog: dict[str, Any] | None, base_dir: str | None = None) -> None:
    """Configure the process-wide read-only catalog loaded at startup."""
    global _catalog
    if catalog is None:
        _catalog = None
        return
    configured = dict(catalog)
    if base_dir:
        configured["_base_dir"] = os.path.abspath(base_dir)
    _catalog = configured
    configure_catalog_s3(configured.get("s3"))


def configure_catalog_s3(settings) -> dict | None:
    """Apply a catalog's ``"s3"`` block: where its ``s3://`` entries live.

    ``{"endpoint_url": "https://<account>.r2.cloudflarestorage.com",
    "region": "auto", "profile": "lab-readonly"}`` (every key optional), so a
    catalog on Cloudflare R2, Backblaze B2, MinIO or an institutional store
    works without any setting on the reading computer. Credentials never go
    in the catalog: a profile names them in the reader's ~/.aws files, and a
    public bucket needs none.
    """
    if not isinstance(settings, dict):
        return None
    params = {key: str(settings[key]).strip() for key in ("endpoint_url", "region", "profile")
              if isinstance(settings.get(key), str) and settings[key].strip()}
    if not params:
        return None
    from services import s3_support
    result = s3_support.configure(**params)
    if result.get("success"):
        print(f"  Catalog S3: {params.get('endpoint_url') or 'AWS S3'}"
              + (f" (profile {params['profile']})" if params.get("profile") else ""))
    else:
        print(f"  Catalog S3 settings not applied: {result.get('error')}")
    return result


def _resolve_catalog_path(path: str) -> str:
    expanded = os.path.expanduser(os.path.expandvars(path))
    if os.path.isabs(expanded):
        return expanded
    base_dir = _catalog.get("_base_dir") if _catalog else None
    if base_dir:
        return os.path.abspath(os.path.join(base_dir, expanded))
    return expanded


def catalog_genome() -> str | None:
    """The genome the configured catalog asks for, if any."""
    return (_catalog or {}).get("genome") or None


def _catalog_entry_path(spec: dict[str, Any]) -> str:
    """Resolve a catalog entry's location."""
    url = spec.get("url")
    if url:
        return url
    path = spec.get("path")
    if path:
        return _resolve_catalog_path(path)
    raise KeyError("Catalog entry missing both `url` and `path`")


def _loc_of(spec: dict[str, Any]) -> str:
    """Best-effort location for label fallback. Tolerates missing fields."""
    return spec.get("url") or spec.get("path") or ""


def _reconcile_catalog_tracks(state) -> set:
    """The catalog tracks really loaded: those with a track in the list.

    A catalog track removed by another route (the track list's own remove, a
    session import) must read as unloaded, or loading it again is a no-op.
    """
    present = {
        track.get("_catalog_index")
        for track in getattr(state, "orthogonal_tracks", []) or []
        if track.get("_catalog_index") is not None
    }
    state._catalog_loaded_tracks = set(state._catalog_loaded_tracks) & present
    return state._catalog_loaded_tracks


def _workspace(state):
    """Catalog membership belongs to the workspace: a panel genome's view resolves to its base state."""
    base = getattr(state, "__dict__", {}).get("_genome_base")
    return base if base is not None else state


def _expected_members(group_index: int):
    """The member keys a complete load of this group has (entry indexes, or 'merged'); None: no such group."""
    groups = (_catalog or {}).get("groups", [])
    if not 0 <= group_index < len(groups):
        return None
    specs = groups[group_index].get("datasets", [])
    return {"merged"} if groups[group_index].get("merge", False) and len(specs) >= 2 else set(range(len(specs)))


def _sync_group(state, group_index: int) -> None:
    """Membership keeps the members still open as the very objects loaded (partial or not); the group reads as
    loaded only when every expected member is among them. Datasets of unknown provenance are never members."""
    members = _catalog_members(state)
    open_members = {k: m for k, m in (members.get(group_index) or {}).items() if _member_open(state, m)}
    if open_members:
        members[group_index] = open_members
    else:
        members.pop(group_index, None)
    expected = _expected_members(group_index)
    if open_members and expected is not None and expected <= set(open_members):
        state._catalog_loaded[group_index] = [m["id"] for _k, m in sorted(open_members.items(), key=lambda kv: str(kv[0]))]
    else:
        state._catalog_loaded.pop(group_index, None)


def _reconcile_catalog_groups(state) -> dict:
    """Catalog groups loaded now: complete, every member still the dataset object the group loaded (one removed,
    replaced or imported under a member's id makes the group read as not loaded; loading it again brings the
    missing members back)."""
    for group_index in set(state._catalog_loaded) | set(_catalog_members(state)):
        _sync_group(state, group_index)
    return state._catalog_loaded


def get_catalog_payload(state) -> dict:
    if _catalog is None:
        return {"catalog": None}
    state = _workspace(state)

    loaded_groups = _reconcile_catalog_groups(state)
    loaded_tracks = _reconcile_catalog_tracks(state)
    groups = []
    for i, group in enumerate(_catalog.get("groups", [])):
        groups.append({
            "name": group.get("name", f"Group {i + 1}"),
            "description": group.get("description", ""),
            "dataset_count": len(group.get("datasets", [])),
            "loaded": i in loaded_groups,
            "merge": group.get("merge", False),
            "dataset_labels": [
                dataset.get("label", os.path.basename(_loc_of(dataset)))
                for dataset in group.get("datasets", [])
            ],
        })

    tracks = []
    for i, track in enumerate(_catalog.get("tracks", [])):
        tracks.append({
            "label": track.get("label", os.path.basename(_loc_of(track))),
            "loaded": i in loaded_tracks,
        })

    return {
        "catalog": {
            "name": _catalog.get("name", "Dataset Catalog"),
            "genome": _catalog.get("genome"),
            "groups": groups,
            "tracks": tracks,
        }
    }


def _remote_entry_problems(locations: list[str]) -> list[str]:
    """Why remote entries can't be read (missing object or index, refused access),
    checked as a URL opened from the sidebar is: otherwise such an entry loads as
    a dataset with no contigs and no reads, and no error."""
    from utils.validation import is_url
    remote = [location for location in locations if is_url(location)]
    if not remote:
        return []
    from services.dataset_endpoint import validate_dataset_paths
    return validate_dataset_paths(remote)


def _catalog_op_lock(state, group_index: int):
    """One load/unload of one catalog group in one workspace at a time (level 0, before the state lock)."""
    from services.lock_order import operation_lock
    return operation_lock("catalog", id(_workspace(state)), group_index)


def _dataset_paths(dataset) -> tuple:
    paths = getattr(dataset, "paths", None) or [getattr(dataset, "path", None)]
    return tuple(str(p) for p in paths if p)


def _member(dataset, dataset_id) -> dict:
    """A catalog member: the dataset object this group loaded, its id and its files (its provenance)."""
    return {"id": getattr(dataset, "id", None) or dataset_id, "paths": _dataset_paths(dataset), "dataset": dataset}


def _member_open(state, member) -> bool:
    """The member is still the very dataset the group loaded (not another loaded under its id since)."""
    return (getattr(state, "datasets", {}) or {}).get(member["id"]) is member["dataset"]


def rebuild_catalog_membership(state, previous: dict) -> None:
    """After a session import: each member that came back as a dataset of the same files under the same id stays
    a member (naming the imported object); a group reads as loaded only when all its members did (otherwise a later
    load retries the missing ones). Anything else is dropped."""
    members = _catalog_members(state)
    members.clear()
    state._catalog_loaded = {}
    for group_index, group_members in (previous or {}).items():
        rebuilt = {}
        for key, member in group_members.items():
            dataset = (getattr(state, "datasets", {}) or {}).get(member["id"])
            if dataset is not None and _dataset_paths(dataset) == tuple(member["paths"]):
                rebuilt[key] = _member(dataset, member["id"])
        if rebuilt:
            members[group_index] = rebuilt
        _sync_group(state, group_index)


def _catalog_members(state) -> dict:
    """group_index -> {member key: _member(...)} (member key: entry index or 'merged')."""
    members = getattr(state, "__dict__", {}).get("_catalog_members")
    if members is None:
        members = {}
        object.__setattr__(state, "_catalog_members", members)
    return members


def catalog_load_payload(state, group_index: int) -> dict:
    """Load a catalog group: one load/unload of the group at a time per workspace, the datasets' actual ids
    (as add_dataset returned them) recorded under the state lock."""
    if _catalog is None:
        return {"success": False, "message": "No catalog configured"}
    groups = _catalog.get("groups", [])
    if group_index < 0 or group_index >= len(groups):
        return {"success": False, "message": f"Invalid group index {group_index}"}
    state = _workspace(state)
    with _catalog_op_lock(state, group_index):
        return _catalog_load(state, group_index, groups[group_index])


def _catalog_load(state, group_index: int, group: dict) -> dict:
    from services.genome_loading import state_lock
    with state_lock(state):
        if group_index in _reconcile_catalog_groups(state):
            return {"success": True, "message": "Already loaded", "dataset_ids": list(state._catalog_loaded[group_index])}
        # Members still open from an earlier, partly failed load are kept; only the missing ones are tried again.
        members = {key: member for key, member in (_catalog_members(state).get(group_index) or {}).items()
                   if _member_open(state, member)}

    dataset_specs = group.get("datasets", [])
    merge = group.get("merge", False)
    errors = []

    def added(key, dataset, requested_id, color, what):
        if dataset is None:   # an add_dataset that returns nothing (minimal states): the one under that id
            dataset = state.datasets.get(requested_id)
        if color:
            dataset.color = color
        members[key] = _member(dataset, requested_id)   # the object and id add_dataset gave it
        log_catalog_diagnostic(f"  [catalog] Loaded: {what}")

    if merge and len(dataset_specs) >= 2:
        if "merged" not in members:
            all_paths = [_catalog_entry_path(spec) for spec in dataset_specs]
            merged_label = group.get("name", "Merged")
            try:
                problems = _remote_entry_problems(all_paths)
                if problems:
                    raise ValueError("; ".join(problems))
                requested = f"catalog_{group_index}_merged"
                dataset = state.add_dataset(requested, all_paths, merged_label)
                added("merged", dataset, requested, group.get("color"), f"merged {merged_label} ({len(all_paths)} entries)")
            except Exception as exc:
                errors.append(f"{merged_label}: {exc}")
    else:
        for j, dataset_spec in enumerate(dataset_specs):
            if j in members:
                continue
            try:
                location = _catalog_entry_path(dataset_spec)
            except KeyError as exc:
                errors.append(str(exc))
                continue
            label = dataset_spec.get("label", os.path.basename(location))
            try:
                problems = _remote_entry_problems([location])
                if problems:
                    raise ValueError("; ".join(problems))
                requested = f"catalog_{group_index}_{j}"
                dataset = state.add_dataset(requested, location, label)
                added(j, dataset, requested, dataset_spec.get("color"), f"{label} ({location})")
            except Exception as exc:
                errors.append(f"{label}: {exc}")

    with state_lock(state):
        kept = {k: m for k, m in members.items() if _member_open(state, m)}
        loaded_ids = [m["id"] for _key, m in sorted(kept.items(), key=lambda kv: str(kv[0]))]
        _catalog_members(state)[group_index] = kept
        # Loaded only when every expected member is: a failed member is retried by the next load.
        _sync_group(state, group_index)
        for dataset_id in loaded_ids:
            dataset = state.datasets.get(dataset_id)
            if dataset is None:
                continue
            if not hasattr(dataset, "available_layers") or getattr(dataset, "available_layers", None) is None:
                try:
                    dataset.available_layers = {}
                except AttributeError:
                    continue
            dataset.available_layers.setdefault("footprint", True)

    message = f"Loaded {len(loaded_ids)} dataset(s)"
    if errors:
        message += f" ({len(errors)} failed: {'; '.join(errors)})"
    if not loaded_ids:
        return {"success": False, "message": message, "dataset_ids": []}
    return {"success": True, "message": message, "dataset_ids": loaded_ids}


def catalog_unload_payload(state, group_index: int) -> dict:
    """Unload a catalog group's datasets: the ids its loads recorded (operation lock, then the state lock)."""
    from services.genome_loading import state_lock
    if _catalog is None:
        return {"success": False, "message": "No catalog configured"}
    state = _workspace(state)
    with _catalog_op_lock(state, group_index), state_lock(state):
        return _catalog_unload_locked(state, group_index)


def _catalog_unload_locked(state, group_index: int) -> dict:
    recorded = list((_catalog_members(state).pop(group_index, None) or {}).values())
    state._catalog_loaded.pop(group_index, None)
    # Only the very datasets this group loaded: an id reused since (a session import, another load) stays, and a
    # dataset of unknown provenance is never removed.
    dataset_ids = [m["id"] for m in recorded if _member_open(state, m)]
    if not dataset_ids:
        return {"success": True, "message": "Not loaded"}
    for dataset_id in dataset_ids:
        dataset = state.datasets.pop(dataset_id, None)
        if dataset is not None:
            from services.file_handles import release_dataset_handles
            release_dataset_handles(dataset)
        if dataset_id in state.dataset_order:
            state.dataset_order.remove(dataset_id)
        for cache_attr in (
            "_broad_cache",
            "_meta_profile_cache",
            "_methylation_cache",
            "_working_set_cache",
        ):
            cache = getattr(state, cache_attr, None)
            if cache:
                keys_to_remove = [
                    key for key in cache
                    if isinstance(key, tuple) and dataset_id in key
                ]
                for key in keys_to_remove:
                    del cache[key]

    log_catalog_diagnostic(f"  [catalog] Unloaded group {group_index} ({len(dataset_ids)} datasets)")
    return {
        "success": True,
        "message": f"Unloaded {len(dataset_ids)} dataset(s)",
        "removed_ids": dataset_ids,
    }


def catalog_track_load_payload(state, track_index: int) -> dict:
    if _catalog is None:
        return {"success": False, "message": "No catalog configured"}

    tracks = _catalog.get("tracks", [])
    if track_index < 0 or track_index >= len(tracks):
        return {"success": False, "message": f"Invalid track index {track_index}"}
    if track_index in _reconcile_catalog_tracks(state):
        return {"success": True, "message": "Already loaded"}

    track = tracks[track_index]
    try:
        track_path = _catalog_entry_path(track)
    except KeyError as exc:
        return {"success": False, "message": str(exc)}

    track_label = track.get(
        "label",
        os.path.basename(track_path).replace(".bw", "").replace(".bigWig", ""),
    )
    track_dict = {
        "path": track_path,
        "label": track_label,
        "format": "bigWig",
        "render_mode": "signal",
        "_catalog_index": track_index,
    }
    if track_path.endswith((".bb", ".bigbed", ".bigBed")):
        track_dict["format"] = "bigBed"
        track_dict["render_mode"] = "annotation"
    if track.get("color"):
        track_dict["color"] = track["color"]

    state.orthogonal_tracks.append(track_dict)
    state._catalog_loaded_tracks.add(track_index)
    log_catalog_diagnostic(f"  [catalog] Track loaded: {track_label}")
    return {
        "success": True,
        "message": f"Loaded track: {track_label}",
        "track_index": len(state.orthogonal_tracks) - 1,
    }


def catalog_track_unload_payload(state, track_index: int) -> dict:
    if track_index not in state._catalog_loaded_tracks:
        return {"success": True, "message": "Not loaded"}

    state.orthogonal_tracks = [
        track for track in state.orthogonal_tracks
        if track.get("_catalog_index") != track_index
    ]
    for cache_attr in ("_track_data_cache", "_track_region_cache"):
        cache = getattr(state, cache_attr, None)
        if cache is not None:
            cache.clear()
    state._catalog_loaded_tracks.discard(track_index)
    log_catalog_diagnostic(f"  [catalog] Track unloaded: index {track_index}")
    return {"success": True, "message": "Unloaded"}
