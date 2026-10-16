"""Endpoint workflow helpers for annotation overlays."""
from __future__ import annotations

import hashlib
import os

from models.domain import AnnotationFile, AnnotationType
from services.annotation_analysis import (
    cluster_reads_by_annotation_patterns,
    filter_reads_by_annotation_types,
)
from services.annotation_bigbed import (
    discover_annotation_types,
    load_annotation_manifest,
    load_annotations_from_bigbed,
    log_annotation_diagnostic,
)
from services.annotation_profiles import build_annotation_profiles
from services.analysis_query import AnalysisReadQuery
from services.local_paths import normalize_local_path, path_access_error
from services.query_params import parse_csv_list, resolve_dataset_id
from services.read_metrics import normalize_sample_seed, random_state_from_seed
from services.signal_peaks import detect_signal_peaks

ANNOTATION_COLORS = [
    "#6366f1", "#ec4899", "#14b8a6", "#f59e0b", "#8b5cf6",
    "#06b6d4", "#ef4444", "#10b981", "#3b82f6", "#d946ef",
    "#0ea5e9", "#84cc16",
]


def _error(status_code: int, error: str) -> dict:
    return {"status_code": status_code, "error": error}


def _assign_color(ann_state, type_name: str) -> str:
    """Assign a color to an annotation type if not already assigned."""
    if type_name in ann_state.type_colors:
        return ann_state.type_colors[type_name]
    used = set(ann_state.type_colors.values())
    for color in ANNOTATION_COLORS:
        if color not in used:
            ann_state.type_colors[type_name] = color
            return color
    idx = len(ann_state.type_colors) % len(ANNOTATION_COLORS)
    ann_state.type_colors[type_name] = ANNOTATION_COLORS[idx]
    return ANNOTATION_COLORS[idx]


def list_annotation_files_payload(state) -> dict:
    ann = state.annotation_state
    return {"files": [f.to_dict() for f in ann.files.values()]}


def activate_annotation_file_payload(state, req) -> dict:
    ann = state.annotation_state
    af = ann.files.get(req.file_id)
    if not af:
        return _error(404, "File not found")

    if af.manifest is None:
        af.manifest = load_annotation_manifest(af.path)

    if af.manifest and "types" in af.manifest:
        type_names = list(af.manifest["types"].keys())
    else:
        types_count = discover_annotation_types(af.path, sample_size=10000)
        type_names = list(types_count.keys())

    af.annotation_types = {}
    for type_name in type_names:
        category = ""
        description = ""
        if af.manifest and "types" in af.manifest:
            type_info = af.manifest["types"].get(type_name, {})
            category = type_info.get("category", "")
            description = type_info.get("description", "")

        color = _assign_color(ann, type_name)
        af.annotation_types[type_name] = AnnotationType(
            name=type_name,
            category=category,
            description=description,
            color=color,
        )
        if type_name not in ann.enabled_types:
            ann.enabled_types[type_name] = True

    af.active = True
    return {"file": af.to_dict(), "types_discovered": len(type_names)}


def deactivate_annotation_file_payload(state, req) -> dict:
    ann = state.annotation_state
    af = ann.files.get(req.file_id)
    if not af:
        return _error(404, "File not found")
    af.active = False
    keys_to_remove = [k for k in ann._cache if k[0] == req.file_id]
    for key in keys_to_remove:
        del ann._cache[key]
    return {"status": "ok"}


def add_annotation_file_payload(state, req) -> dict:
    original_path = req.path
    req.path = normalize_local_path(req.path)
    if not os.path.isfile(req.path):
        return _error(400, path_access_error(req.path, original_path=original_path, expected="file") or "File not found")

    if not req.path.endswith((".bb", ".bigbed", ".bigBed")):
        return _error(400, "Not a BigBed file")

    ann = state.annotation_state
    file_id = f"ann_{os.path.splitext(os.path.basename(req.path))[0]}"

    base_id = file_id
    index = 1
    while file_id in ann.files:
        file_id = f"{base_id}_{index}"
        index += 1

    af = AnnotationFile(file_id, req.path, req.label)
    af.dataset_ids = req.dataset_ids
    ann.files[file_id] = af

    return {"file": af.to_dict()}


def browse_annotation_files_payload(dir_path: str) -> dict:
    original_path = dir_path
    dir_path = normalize_local_path(dir_path)
    if not os.path.isdir(dir_path):
        return _error(400, path_access_error(dir_path, original_path=original_path, expected="directory") or f"Not a directory: {dir_path}")
    entries = []
    try:
        for name in sorted(os.listdir(dir_path)):
            if name.startswith("."):
                continue
            full = os.path.join(dir_path, name)
            if os.path.isfile(full) and name.lower().endswith((".bb", ".bigbed")):
                entries.append({"name": name, "path": full, "size": os.path.getsize(full)})
    except PermissionError:
        return _error(403, "Permission denied")
    return {"files": entries, "dir": dir_path}


def remove_annotation_file_payload(state, file_id: str) -> dict:
    ann = state.annotation_state
    if file_id not in ann.files:
        return _error(404, "File not found")
    del ann.files[file_id]
    keys_to_remove = [k for k in ann._cache if k[0] == file_id]
    for key in keys_to_remove:
        del ann._cache[key]
    return {"status": "ok"}


def get_annotations_for_region_payload(
    state,
    *,
    chrom: str,
    start: int,
    end: int,
    dataset_id: str = "",
    dataset_ids: str = "",
    file_ids: str = "",
    sample_seed: str | None = None,
    load_annotations=load_annotations_from_bigbed,
) -> dict:
    ann = state.annotation_state

    if file_ids:
        query_file_ids = parse_csv_list(file_ids)
    else:
        query_file_ids = [fid for fid, af in ann.files.items() if af.active]

    if not query_file_ids:
        return {"annotations": {}, "types": []}

    query = AnalysisReadQuery.from_request(
        state,
        chrom=chrom,
        start=start,
        end=end,
        dataset_id=dataset_id,
        dataset_ids=dataset_ids,
        sample_seed=sample_seed,
        include_methylation=False,
        include_layers=False,
    )
    chrom = query.chrom
    ds_ids = query.dataset_ids
    sample_seed = query.sample_seed
    # Files tied to other datasets stay out (shared files apply to all).
    if ds_ids:
        scoped = {id(af) for af in _active_files_for(ann, ds_ids)}
        query_file_ids = [fid for fid in query_file_ids if id(ann.files.get(fid)) in scoped]
    if not query_file_ids:
        return {"annotations": {}, "types": []}

    read_name_set = set()
    reads_by_dataset: dict[str, set] = {}
    total_ws_reads = 0
    for did in ds_ids:
        try:
            ws = query.build_working_set(state, did)
            if ws and ws.reads:
                ids = set(ws.get_read_ids())
                reads_by_dataset[did] = ids
                read_name_set |= ids
                total_ws_reads += len(ws.reads)
        except Exception as exc:
            log_annotation_diagnostic(f"  Warning: working set failed for dataset {did}: {exc}")

    if read_name_set:
        log_annotation_diagnostic(
            f"  [annotations] Combined working set: {total_ws_reads} reads, "
            f"{len(read_name_set)} unique names across {len(ds_ids)} datasets"
        )
    else:
        # No reads here: nothing to annotate (an empty set is not "all reads").
        log_annotation_diagnostic(f"  [annotations] No reads found across {len(ds_ids)} datasets")
        return {"annotations": {}, "types": []}

    all_annotations = {}
    # Per dataset: only files that apply to it, over its own reads, so an
    # annotation of dataset A's read never lands on B's read of the same name.
    by_dataset: dict[str, dict] = {did: {} for did in reads_by_dataset}
    all_types = {}
    ds_key = ",".join(sorted(ds_ids))
    read_filter_sig = None
    if read_name_set is not None:
        joined = "\0".join(sorted(read_name_set))
        read_filter_sig = (len(read_name_set), hashlib.sha1(joined.encode("utf-8")).hexdigest()[:16])

    for file_id in query_file_ids:
        af = ann.files.get(file_id)
        if not af or not af.active:
            continue

        cache_key = (file_id, chrom, start, end, ds_key, sample_seed, read_filter_sig)
        cached = ann.get_cached(cache_key)

        if cached is not None:
            ann_dict, types_set = cached
        else:
            ann_dict, types_set = load_annotations(
                af.path,
                chrom,
                start,
                end,
                confidence_thresholds=ann.confidence_thresholds,
                read_names=read_name_set,
            )
            ann.set_cached(cache_key, (ann_dict, types_set))
            log_annotation_diagnostic(
                f"  [annotations] Loaded: {sum(len(v) for v in ann_dict.values())} "
                f"annotations for {len(ann_dict)} reads, types={types_set}"
            )

        for type_name in (af.annotation_types.keys() if af.annotation_types else types_set):
            if type_name not in all_types:
                color = ann.type_colors.get(type_name, _assign_color(ann, type_name))
                at = af.annotation_types.get(type_name) if af.annotation_types else None
                all_types[type_name] = {
                    "name": type_name,
                    "color": color,
                    "category": at.category if at else "",
                    "count": 0,
                }

        for anns_list in ann_dict.values():
            for annotation in anns_list:
                if annotation[2] in all_types:
                    all_types[annotation[2]]["count"] += 1

        for read_name, anns_list in ann_dict.items():
            if read_name not in all_annotations:
                all_annotations[read_name] = []
            all_annotations[read_name].extend(anns_list)

        file_datasets = set(getattr(af, "dataset_ids", None) or [])
        for did, names in reads_by_dataset.items():
            if file_datasets and did not in file_datasets:
                continue
            target = by_dataset[did]
            for read_name, anns_list in ann_dict.items():
                if read_name in names:
                    target.setdefault(read_name, []).extend(anns_list)

    def as_payload(annotations: dict) -> dict:
        return {
            read_name: [
                {
                    "start": annotation[0] - start,
                    "end": annotation[1] - start,
                    "type": annotation[2],
                    "confidence": annotation[3],
                }
                for annotation in anns_list
            ]
            for read_name, anns_list in annotations.items()
        }

    result = as_payload(all_annotations)

    total_anns = sum(len(v) for v in result.values())
    log_annotation_diagnostic(
        f"  [annotations] Returning {total_anns} annotations for {len(result)} reads, {len(all_types)} types"
    )
    return {
        "annotations": result,
        "annotations_by_dataset": {did: as_payload(anns) for did, anns in by_dataset.items()},
        "types": list(all_types.values()),
    }


def _active_files_for(ann, dataset_ids) -> list:
    """Active annotation files for these datasets: files tied to one of them, or
    shared (no datasets). With no datasets requested, every active file."""
    wanted = set(dataset_ids or ())
    return [af for af in ann.files.values()
            if af.active and (not wanted or not getattr(af, "dataset_ids", None) or wanted & set(af.dataset_ids))]


def _dataset_read_names(state, chrom, start, end, dataset_ids, sample_seed=None):
    """(dataset ids, names of their reads in the region): annotations of other
    datasets' reads stay out of an analysis of these."""
    query = AnalysisReadQuery.from_request(
        state, chrom=chrom, start=start, end=end, dataset_ids=list(dataset_ids or []),
        sample_seed=sample_seed, include_methylation=False, include_layers=False,
    )
    names: set[str] = set()
    for did in query.dataset_ids:
        try:
            ws = query.build_working_set(state, did)
            if ws and ws.reads:
                names.update(ws.get_read_ids())
        except Exception as exc:
            log_annotation_diagnostic(f"  Warning: annotation working set failed for dataset {did}: {exc}")
    return query.dataset_ids, names


def _per_dataset_read_names(state, chrom, start, end, dataset_ids, sample_seed=None, *, context="annotation"):
    """(query, {dataset id: names of its reads in the region}). Datasets are kept
    apart: a read name in two datasets is two molecules."""
    query = AnalysisReadQuery.from_request(
        state, chrom=chrom, start=start, end=end, dataset_ids=list(dataset_ids or []),
        sample_seed=sample_seed, include_methylation=False, include_layers=False,
    )
    names_by_dataset: dict[str, set[str]] = {}
    for did in query.dataset_ids:
        try:
            ws = query.build_working_set(state, did)
            names_by_dataset[did] = set(ws.get_read_ids()) if ws and ws.reads else set()
        except Exception as exc:
            log_annotation_diagnostic(f"  Warning: {context} working set failed for dataset {did}: {exc}")
            names_by_dataset[did] = set()
    return query, names_by_dataset


def _dataset_annotation_dicts(ann, did, names, chrom, start, end, load_annotations):
    """Annotations of this dataset's reads, from its own files and shared ones."""
    dicts = []
    for af in _active_files_for(ann, [did]):
        ann_dict, _ = load_annotations(
            af.path, chrom, start, end,
            confidence_thresholds=ann.confidence_thresholds,
            read_names=names,
        )
        dicts.append({name: anns for name, anns in ann_dict.items() if name in names})
    return dicts


def filter_by_annotations_payload(state, req, *, load_annotations=load_annotations_from_bigbed) -> dict:
    ann = state.annotation_state
    active_files = _active_files_for(ann, req.dataset_ids)

    if not active_files:
        return {"read_ids": [], "total": 0, "filtered": 0, "by_dataset": {}}

    query, names_by_dataset = _per_dataset_read_names(
        state, req.chrom, req.start, req.end, req.dataset_ids, req.sample_seed, context="annotation filter")

    # Each dataset on its own: its reads against its own annotation files (and
    # shared ones), so a read name two datasets share can't combine their types.
    by_dataset: dict[str, dict] = {}
    for did, names in names_by_dataset.items():
        if not names:
            # This dataset has no reads here: nothing of it passes.
            by_dataset[did] = {"read_ids": [], "total": 0, "filtered": 0}
            continue
        by_dataset[did] = filter_reads_by_annotation_types(
            _dataset_annotation_dicts(ann, did, names, query.chrom, query.start, query.end, load_annotations),
            annotation_types=req.annotation_types,
            filter_mode=req.filter_mode,
            universe_read_ids=sorted(names),
        )

    # The flat list (older callers): every dataset's passing names.
    union = sorted({rid for result in by_dataset.values() for rid in result["read_ids"]})
    return {
        "read_ids": union,
        "total": sum(r["total"] for r in by_dataset.values()),
        "filtered": sum(r["filtered"] for r in by_dataset.values()),
        "by_dataset": by_dataset,
    }


_DATASET_READ_SEP = "\x1f"


def cluster_by_annotations_payload(state, req, *, load_annotations=load_annotations_from_bigbed) -> dict:
    ann = state.annotation_state
    requested = list(getattr(req, "dataset_ids", None) or [])
    active_files = _active_files_for(ann, requested)

    if not active_files or not req.peak_regions or not req.annotation_types:
        return _error(400, "Need active files, peaks, and types")

    annotation_dicts = []
    names_by_dataset: dict[str, set[str]] = {}
    if requested:
        # Only the requested datasets' reads, each dataset's molecules kept apart
        # (keyed dataset + name) so a shared read name is two rows, not one.
        _query, names_by_dataset = _per_dataset_read_names(
            state, req.chrom, req.start, req.end, requested,
            getattr(req, "sample_seed", None), context="annotation cluster")
        if not any(names_by_dataset.values()):
            return _error(400, "The selected datasets have no reads in this region")
        for did, names in names_by_dataset.items():
            if not names:
                continue
            for ann_dict in _dataset_annotation_dicts(ann, did, names, req.chrom, req.start, req.end, load_annotations):
                annotation_dicts.append({f"{did}{_DATASET_READ_SEP}{name}": anns for name, anns in ann_dict.items()})
    else:
        # No datasets named (older callers): every read, by name.
        for af in active_files:
            ann_dict, _ = load_annotations(
                af.path, req.chrom, req.start, req.end,
                confidence_thresholds=ann.confidence_thresholds,
            )
            annotation_dicts.append(ann_dict)

    sample_seed = normalize_sample_seed(req.sample_seed)
    annotation_random_state = random_state_from_seed(
        sample_seed,
        "annotations_cluster",
        req.method,
    )
    result = cluster_reads_by_annotation_patterns(
        annotation_dicts,
        peak_regions=req.peak_regions,
        annotation_types=req.annotation_types,
        method=req.method,
        k=req.k,
        random_state=annotation_random_state,
    )
    if requested:
        by_dataset: dict[str, dict[str, int]] = {did: {} for did in names_by_dataset}
        for key, cluster in result["assignments"].items():
            did, _, name = key.partition(_DATASET_READ_SEP)
            by_dataset.setdefault(did, {})[name] = cluster
        result["assignments_by_dataset"] = by_dataset
        # The flat map (older callers) by name; with a name in two datasets the
        # per-dataset map is the one to use.
        result["assignments"] = {name: c for per in by_dataset.values() for name, c in per.items()}
    result["sample_seed"] = sample_seed
    result["annotation_random_state"] = annotation_random_state
    return result


def get_annotation_profile_payload(
    state,
    *,
    chrom: str,
    start: int,
    end: int,
    dataset_id: str | None = None,
    annotation_types: str = "",
    bins: int = 500,
    load_annotations=load_annotations_from_bigbed,
) -> dict:
    ann = state.annotation_state
    requested = dataset_id
    dataset_id = resolve_dataset_id(state, dataset_id)
    active_files = _active_files_for(ann, [dataset_id] if dataset_id else [])

    if not active_files:
        return {"profiles": {}}

    types_list = parse_csv_list(annotation_types)

    # A profile of one dataset counts only its reads.
    read_names = None
    if requested and dataset_id:
        _ids, read_names = _dataset_read_names(state, chrom, start, end, [dataset_id])
        if not read_names:
            return {"profiles": {}}  # this dataset has no reads here

    annotation_dicts = []
    for af in active_files:
        ann_dict, _ = load_annotations(
            af.path,
            chrom,
            start,
            end,
            confidence_thresholds=ann.confidence_thresholds,
            **({"read_names": read_names} if read_names is not None else {}),
        )
        if read_names is not None:
            ann_dict = {name: anns for name, anns in ann_dict.items() if name in read_names}
        annotation_dicts.append(ann_dict)

    return {
        "profiles": build_annotation_profiles(
            annotation_dicts,
            start=start,
            end=end,
            bins=bins,
            annotation_types=types_list,
        )
    }


def set_annotation_threshold_payload(state, req) -> dict:
    ann = state.annotation_state
    ann.confidence_thresholds[req.type_name] = req.threshold
    ann.clear_cache()
    return {"status": "ok", "type": req.type_name, "threshold": req.threshold}


def detect_peaks_payload(req) -> dict:
    return {
        "peaks": detect_signal_peaks(
            signal=req.signal,
            start=req.start,
            end=req.end,
            min_distance_bp=req.min_distance_bp,
            min_width_bp=req.min_width_bp,
            threshold_percentile=req.threshold_percentile,
            threshold_value=req.threshold_value,
        )
    }
