"""Dataset registration helpers for BrowserState."""
from __future__ import annotations

from services.dataset_generation import bump_dataset_generation
import os
import re
from collections.abc import Callable
from typing import Any

from models.domain import AnnotationFile, Dataset
from services.annotation_bigbed import (
    find_annotation_bigbed_files,
    is_annotation_bigbed,
    load_annotation_manifest,
)
from services.bam_diagnostics import diagnose_bam_tags
from services.bigbed_detection import (
    detect_overlay_type,
    find_companion_bigbed_files,
    fire_bigbed_mark_layers,
    m5c_bigbed_has_ddda_spans,
)
from services.chemistry_metadata import inspect_dataset_chemistry
from services.diagnostics import env_flag_enabled, log_if_enabled
from services.derived_layers import (
    find_derived_layer_bigbeds,
    is_derived_layer_bigbed,
    load_derived_layer_definitions,
)
from utils.chrom import build_chrom_map
from utils.colors import DATASET_COLORS
from utils.validation import detect_data_format, is_url

BIGBED_EXTENSIONS = ('.bb', '.bigbed', '.bigBed')
DATASET_DIAGNOSTICS_ENV = "FIBERBROWSER_DATASET_DIAGNOSTICS"


def dataset_id_from_source(source, fallback: str = "dataset") -> str:
    """Create a stable dataset id from a loaded path/list without using `primary`."""
    if isinstance(source, list):
        base = f"combined_{len(source)}_files" if source else fallback
    else:
        base = os.path.basename(str(source).rstrip("/")) or fallback
        for ext in (".bam", ".bb", ".bigbed", ".bigBed"):
            if base.endswith(ext):
                base = base[: -len(ext)]
                break
    dataset_id = re.sub(r"[^0-9A-Za-z_]+", "_", base).strip("_")
    return dataset_id or fallback


def dataset_diagnostics_enabled() -> bool:
    return env_flag_enabled(DATASET_DIAGNOSTICS_ENV)


def log_dataset_diagnostic(message: str) -> None:
    log_if_enabled(DATASET_DIAGNOSTICS_ENV, message)


def _is_bigbed_file(path: str) -> bool:
    return path.endswith(BIGBED_EXTENSIONS) and os.path.isfile(path)


def _remote_bigbed_urls(path_or_paths) -> list[str]:
    """Remote BigBed URLs among an explicit file list (a merge may mix local and remote)."""
    if not isinstance(path_or_paths, list):
        return []
    return [
        path for path in path_or_paths
        if isinstance(path, str) and is_url(path)
        and path.split('?', 1)[0].split('#', 1)[0].lower().endswith(('.bb', '.bigbed'))
    ]


def _local_bigbed_files(path_or_paths) -> list[str]:
    """Return local BigBed files represented by a file, directory, or file list."""
    if isinstance(path_or_paths, list):
        files: list[str] = []
        for path in path_or_paths:
            if is_url(path):
                continue
            if os.path.isdir(path):
                files.extend(_local_bigbed_files(path))
            elif _is_bigbed_file(path):
                files.append(path)
        return files

    if is_url(path_or_paths):
        return []
    if os.path.isdir(path_or_paths):
        return [
            os.path.join(path_or_paths, fname)
            for fname in sorted(os.listdir(path_or_paths))
            if fname.endswith(BIGBED_EXTENSIONS)
        ]
    if _is_bigbed_file(path_or_paths):
        return [path_or_paths]
    return []


def _bigbed_has_circular_groups(paths: list[str], sample_per_chrom: int = 20) -> bool:
    """Lightweight probe for FiberHMM BED12+ circular grouping fields."""
    if not paths:
        return False
    try:
        import pyBigWig
        from services.compact_read_loader import parse_bed_circular_group_fields
    except Exception:
        return False

    for path in paths[:4]:
        try:
            from services.remote_sources.opening import open_bigwig
            with open_bigwig(path) as bw:
                for chrom, size in list((bw.chroms() or {}).items())[:3]:
                    entries = bw.entries(chrom, 0, min(int(size), 200_000))
                    for _start, _end, rest in (entries or [])[:sample_per_chrom]:
                        if parse_bed_circular_group_fields(str(rest).split("\t")):
                            return True
        except Exception:
            continue
    return False


def validate_dataset_source(path) -> tuple[str, bool]:
    """Validate a dataset path/list and return primary path plus BAM status."""
    if isinstance(path, list):
        if not path:
            raise ValueError("No dataset paths provided")
        for p in path:
            if not is_url(p) and not os.path.isfile(p):
                raise ValueError(f"File not found: {p}")
        bam_flags = {detect_data_format(p) == 'bam' for p in path}
        if len(bam_flags) > 1:
            # One dataset reads one kind of file: listed with BigBeds, the
            # BAMs would be opened as BigBed and their reads lost.
            raise ValueError("Can't combine BAM and BigBed files in one dataset; load them as separate datasets.")
        return path[0], all(detect_data_format(p) == 'bam' for p in path)

    primary_path = path
    remote = is_url(path)
    is_bam = detect_data_format(path) == 'bam'
    is_bigbed_file = (
        detect_data_format(path) == 'bigbed'
        and (remote or os.path.isfile(path))
    )

    if remote:
        if not (is_bam or is_bigbed_file):
            raise ValueError(f"Unsupported remote URL (expected .bam / .bb): {path}")
    elif is_bam:
        if not os.path.isfile(path):
            raise ValueError(f"BAM file not found: {path}")
    elif is_bigbed_file:
        pass
    elif os.path.isdir(path):
        pass
    elif not os.path.exists(path):
        raise ValueError(f"File or directory not found: {path}")
    else:
        from services.supported_files import not_openable_message
        raise ValueError(not_openable_message(path))

    return primary_path, is_bam


def _reserved(state) -> set:
    """Dataset ids being registered (allocated, not yet published): unique against both."""
    base = getattr(state, "__dict__", {}).get("_genome_base", state)
    reserved = getattr(base, "__dict__", {}).get("_reserved_dataset_ids")
    if reserved is None:
        reserved = set()
        object.__setattr__(base, "_reserved_dataset_ids", reserved)
    return reserved


def unique_dataset_id(dataset_id: str, existing: dict[str, Dataset]) -> str:
    """Return dataset_id or a suffixed variant that does not collide."""
    if dataset_id not in existing:
        return dataset_id
    base_id = dataset_id
    i = 1
    while dataset_id in existing:
        dataset_id = f"{base_id}_{i}"
        i += 1
    return dataset_id


def invalidate_dataset_caches(state: Any, dataset_id: str) -> None:
    """Drop per-dataset broad and working-set cache entries."""
    # Loads still running for the old source must not refill these caches.
    bump_dataset_generation(state, dataset_id)
    from services.working_sets import _broad_cache_sync
    cache_lock, _inflight = _broad_cache_sync(state)
    with cache_lock:
        for key in [k for k in state._broad_cache if k[0] == dataset_id]:
            state._broad_cache.pop(key, None)
        for key in [k for k in state._working_set_cache if k[0] == dataset_id]:
            state._working_set_cache.pop(key, None)
        # Metaprofiles (keys lead with the dataset id): an id reused for another
        # file must not serve the old file's profile.
        meta = getattr(state, "_meta_profile_cache", None)
        if meta:
            for key in [k for k in list(meta) if isinstance(k, tuple) and k and k[0] == dataset_id]:
                meta.pop(key, None)
        direct = getattr(state, "_methylation_cache", None)
        if direct:
            for key in [k for k in list(direct) if k[0] == dataset_id]:
                direct.pop(key, None)
    # Reloaded data may call reads' strands differently.
    getattr(state, "_read_strand_calls", {}).pop(dataset_id, None)
    # Coverage computed from this dataset (keys lead with each dataset's identity).
    coverage = getattr(state, "_coverage_payload_cache", None)
    if coverage:
        for key in [k for k in coverage if any(ident and ident[0] == dataset_id for ident in k[0])]:
            del coverage[key]


BAM_LAYER_DETECTION_SAMPLE_LIMIT = 50


def add_legacy_inferred_layers(dataset: Dataset) -> None:
    """Advertise canonical inferred layers for legacy footprint-only sources."""
    if not (dataset.available_layers or {}).get('footprint'):
        return
    dataset.available_layers.setdefault('nuc', True)
    dataset.available_layers.setdefault('tf', True)
    # User-facing FIRE aliases this internal MSP key in the frontend. This
    # inferred MSP is the gap between adjacent inferred nucleosomes.
    if not dataset.available_layers.get('fire'):
        dataset.available_layers.setdefault('msp', True)


def m5c_bigbed_paths(dataset: Dataset) -> list[str]:
    """The dataset's m5c BigBeds: its m5c companions, or its own files when it is an m5c source."""
    companions = (getattr(dataset, 'companion_layers', None) or {}).get('m5c') or []
    paths = [companions] if isinstance(companions, str) else list(companions)
    if getattr(dataset, 'layer_type', None) == 'm5c':
        paths.extend(getattr(dataset, 'paths', None) or [])
    return list(dict.fromkeys(paths))


def add_m5c_interval_layer(dataset: Dataset) -> None:
    """Offer the DddA mCG span layer (ddda_mcg) of m5c BigBeds that carry it.

    FiberHMM's m5c BigBed holds either native 5mC calls or the ddda_mcg spans
    of DddA reads; the spans are an interval layer, not per-base 5mC marks.
    """
    if any(m5c_bigbed_has_ddda_spans(path) for path in m5c_bigbed_paths(dataset)):
        dataset.available_layers['ddda_mcg'] = True


def _union_bam_diagnostics(left: dict, right: dict) -> dict:
    """Layer capabilities of two BAMs read together: a layer either one has."""
    merged = dict(left)
    for key, value in right.items():
        if key == 'ma_layers':
            merged[key] = list(dict.fromkeys([*(left.get(key) or []), *(value or [])]))
        elif key == 'circular_contigs':
            merged[key] = {**(value or {}), **(left.get(key) or {})}
        elif isinstance(value, bool):
            merged[key] = bool(left.get(key)) or value
        else:
            merged.setdefault(key, value)
    return merged


def configure_bam_dataset_layers(dataset: Dataset, primary_path: str) -> None:
    try:
        # Recalled DAF/FiberHMM BAMs can have sparse MA/TF blocks. The
        # diagnostic probe samples deterministic random windows so sorted-file
        # prefixes do not decide which layers the frontend can request.
        diag = diagnose_bam_tags(primary_path, limit=BAM_LAYER_DETECTION_SAMPLE_LIMIT)
        # A merged dataset reads every BAM: a layer present only in a later
        # file (e.g. 5mC calls in B.bam but not A.bam) is still available.
        others = [p for p in (getattr(dataset, 'paths', None) or [])
                  if isinstance(p, str) and p != primary_path
                  and p.split('?', 1)[0].split('#', 1)[0].lower().endswith('.bam')]
        for other in others:
            try:
                extra = diagnose_bam_tags(other, limit=BAM_LAYER_DETECTION_SAMPLE_LIMIT)
            except Exception as exc:
                log_dataset_diagnostic(f"  Could not probe {other}: {exc}")
                continue
            diag = _union_bam_diagnostics(diag, extra)
        dataset.layer_type = 'bam'
        has_fire = diag.get('has_fire', False)
        dataset.available_layers = {
            'footprint': diag.get('has_nucleosomes', False),
            'm6a': diag.get('has_m6a', False),
            'm5c': diag.get('has_m5c', False),
            'deam': diag.get('has_deam', False),
            'msp': diag.get('has_msps', False) and not has_fire,
            'fire': has_fire,
        }
        for ma_layer in diag.get('ma_layers', []):
            dataset.available_layers[ma_layer] = True
        dataset.has_circular_annotations = bool(diag.get('has_circular_annotations', False))
        dataset.circular_contigs = dict(diag.get('circular_contigs') or {})
        add_legacy_inferred_layers(dataset)
        log_dataset_diagnostic(f"  BAM layers: {dataset.available_layers}")
        discover_derived_layer_files(dataset, primary_path)
    except Exception as exc:
        print(f"  Warning: Could not detect BAM layers: {exc}")
        dataset.layer_type = 'bam'
        dataset.available_layers = {
            'footprint': True,
            'm6a': False,
            'msp': False,
            'm5c': False,
            'deam': False,
        }
        dataset.has_circular_annotations = False
        dataset.circular_contigs = {}
        add_legacy_inferred_layers(dataset)
        discover_derived_layer_files(dataset, primary_path)

    try:
        metadata = inspect_dataset_chemistry(list(dataset.paths))
        dataset.chemistry_metadata = metadata
        dataset.consensus_chemistry = metadata.get("chemistry")
        log_dataset_diagnostic(
            "  BAM chemistry: "
            f"{dataset.consensus_chemistry or metadata.get('status', 'unknown')} "
            f"({metadata.get('source', 'none')})"
        )
    except Exception as exc:
        dataset.consensus_chemistry = None
        dataset.chemistry_metadata = {
            "chemistry": None,
            "source": "inspection-error",
            "status": "unknown",
            "message": str(exc),
            "files": [],
        }
        print(f"  Warning: Could not inspect BAM chemistry: {exc}")


def refresh_dataset_capabilities(state: Any, dataset_id: str) -> Dataset:
    """Re-detect a loaded dataset's layer capabilities and invalidate caches."""
    dataset = state.datasets.get(dataset_id)
    if dataset is None:
        raise KeyError(f"Dataset not found: {dataset_id}")

    source = dataset.paths if len(dataset.paths) > 1 else dataset.path
    if not is_url(dataset.path) and os.path.isdir(dataset.path):
        source = dataset.path
    primary_path, is_bam = validate_dataset_source(source)
    if is_bam:
        configure_bam_dataset_layers(dataset, primary_path)
    else:
        configure_bigbed_dataset_layers(state, dataset_id, dataset, primary_path)
    invalidate_dataset_caches(state, dataset_id)
    return dataset


def configure_bigbed_dataset_layers(state: Any, dataset_id: str, dataset: Dataset, primary_path: str) -> None:
    local_bigbeds = _local_bigbed_files(dataset.paths if len(dataset.paths) > 1 else primary_path)
    # Remote members of a merge are sources too: grouping only the local files
    # dropped the remote reads, and an all-remote [footprint, m6a] pair was read
    # as two primary sources (every molecule counted twice) with no companions.
    remote_bigbeds = _remote_bigbed_urls(dataset.paths if len(dataset.paths) > 1 else primary_path)
    dataset.has_circular_annotations = _bigbed_has_circular_groups(local_bigbeds)
    is_group_source = (len(local_bigbeds) + len(remote_bigbeds) > 1
                       or (not is_url(primary_path) and os.path.isdir(primary_path)))
    if is_group_source:
        layer_files: dict[str, list[str]] = {}
        annotation_paths: list[str] = []
        data_paths: list[str] = []
        path_layers: dict[str, str] = {}
        for path in local_bigbeds + remote_bigbeds:
            if is_annotation_bigbed(path):
                annotation_paths.append(path)
                continue
            if is_derived_layer_bigbed(path):
                register_derived_layer_file(dataset, path)
                continue
            data_paths.append(path)
            detected_type = detect_overlay_type(path)
            if detected_type == 'unknown':
                detected_type = 'footprint'
            path_layers[path] = detected_type
            # Keep EVERY file of a given layer type: merging several samples
            # produces multiple files per type (N footprints, N tf, N m5c, ...).
            # Collapsing to one (the old setdefault) dropped the rest and leaked
            # them into the primary read source.
            layer_files.setdefault(detected_type, []).append(path)

        primary_layer = 'footprint' if 'footprint' in layer_files else next(iter(layer_files), 'footprint')
        dataset.layer_type = primary_layer
        dataset.available_layers = {layer_type: True for layer_type in layer_files} or {primary_layer: True}
        if primary_layer not in dataset.available_layers:
            dataset.available_layers[primary_layer] = True
        add_legacy_inferred_layers(dataset)
        # fibertools/FIRE per-fiber bigBeds carry m6A / 5mC marks themselves.
        for path in data_paths:
            for mark_layer in fire_bigbed_mark_layers(path):
                dataset.available_layers[mark_layer] = True
        for layer_id in getattr(dataset, "derived_layers", {}) or {}:
            dataset.available_layers[layer_id] = True
        dataset.companion_layers = {
            layer_type: list(paths)
            for layer_type, paths in layer_files.items()
            if layer_type != primary_layer
        }
        add_m5c_interval_layer(dataset)
        if data_paths:
            priority = {
                'footprint': 0, 'nuc': 0, 'tf': 1, 'msp': 2,
                'fire': 2, 'deam': 3, 'm6a': 4, 'm5c': 5,
            }
            data_paths = sorted(
                data_paths,
                key=lambda path: (priority.get(path_layers.get(path, ''), 99), path),
            )
            dataset.paths = data_paths
        log_dataset_diagnostic(f"  BigBed group layer_type: {primary_layer}")
        if dataset.companion_layers:
            log_dataset_diagnostic(f"  Companion layers: {dataset.companion_layers}")

        for ann_path in annotation_paths:
            register_dataset_annotation_bigbed(state, dataset_id, ann_path)
        discover_annotation_bigbeds(state, dataset_id, primary_path)
        discover_derived_layer_files(dataset, primary_path)
        return

    detected_type = 'unknown' if is_annotation_bigbed(primary_path) else detect_overlay_type(primary_path)
    if detected_type == 'unknown':
        detected_type = 'footprint'
    dataset.layer_type = detected_type
    dataset.available_layers = {detected_type: True}
    add_legacy_inferred_layers(dataset)
    # fibertools/FIRE per-fiber bigBeds carry m6A / 5mC marks themselves.
    for mark_layer in fire_bigbed_mark_layers(primary_path):
        dataset.available_layers[mark_layer] = True
    add_m5c_interval_layer(dataset)
    log_dataset_diagnostic(f"  BigBed layer_type: {detected_type}")

    if dataset.is_remote or len(dataset.paths) != 1:
        return

    companions = find_companion_bigbed_files(primary_path, detected_type)
    if companions:
        dataset.companion_layers = {ctype: [path] for ctype, path in companions.items()}
        for layer_type in companions:
            dataset.available_layers[layer_type] = True
        add_m5c_interval_layer(dataset)
        log_dataset_diagnostic(f"  Companion layers: {companions}")

    update_existing_companion_layers(state, dataset_id)
    discover_annotation_bigbeds(state, dataset_id, primary_path)
    discover_derived_layer_files(dataset, primary_path)


def update_existing_companion_layers(state: Any, dataset_id: str) -> None:
    for existing_id, existing_ds in state.datasets.items():
        if existing_id == dataset_id:
            continue
        if existing_ds.data_type != 'bigbed' or existing_ds.is_remote:
            continue
        if len(existing_ds.paths) != 1:
            continue

        companions = find_companion_bigbed_files(existing_ds.paths[0], existing_ds.layer_type)
        new_companions = {ctype: [path] for ctype, path in companions.items()}
        if companions and existing_ds.companion_layers != new_companions:
            existing_ds.companion_layers = new_companions
            for layer_type in companions:
                existing_ds.available_layers[layer_type] = True
            add_m5c_interval_layer(existing_ds)
            invalidate_dataset_caches(state, existing_id)
            log_dataset_diagnostic(f"  Reciprocal companion update for {existing_id}: {companions}")


def associate_annotation_file(ann_file: Any, dataset_id: str) -> None:
    """Also associate an already-registered annotation file with ``dataset_id``.

    An empty ``dataset_ids`` means shared by every dataset, which already
    includes this one.
    """
    ids = getattr(ann_file, "dataset_ids", None)
    if ids and dataset_id not in ids:
        ids.append(dataset_id)


def _same_file(a: Any, b: Any) -> bool:
    if not a or not b:
        return False
    a, b = str(a), str(b)
    if is_url(a) or is_url(b):
        return a == b
    return os.path.abspath(a) == os.path.abspath(b)


def register_dataset_annotation_bigbed(state: Any, dataset_id: str, ann_path: str) -> Any:
    """Register an annotation BigBed found with ``dataset_id``.

    Files are identified by their full path: two samples' ``calls.annotations.bb``
    in different folders are two files, each tied to its own dataset (the second
    gets a numbered ID). The same file found again is only associated.
    """
    files = state.annotation_state.files
    existing = next((f for f in files.values() if _same_file(getattr(f, "path", None), ann_path)), None)
    if existing is not None:
        associate_annotation_file(existing, dataset_id)
        return existing
    base_id = f"ann_{os.path.splitext(os.path.basename(str(ann_path).split('?', 1)[0]))[0]}"
    ann_id, index = base_id, 1
    while ann_id in files:
        ann_id = f"{base_id}_{index}"
        index += 1
    ann_file = AnnotationFile(ann_id, ann_path)
    ann_file.dataset_ids.append(dataset_id)
    manifest = load_annotation_manifest(ann_path)
    if manifest:
        ann_file.manifest = manifest
    files[ann_id] = ann_file
    log_dataset_diagnostic(f"  Discovered annotation file: {ann_path}")
    return ann_file


def discover_annotation_bigbeds(state: Any, dataset_id: str, primary_path: str) -> None:
    for ann_path in find_annotation_bigbed_files(primary_path):
        register_dataset_annotation_bigbed(state, dataset_id, ann_path)


def _derived_definition_matches_source(meta: dict, primary_path: str) -> bool:
    source = (meta.get("source_dataset") or {}).get("path")
    if not source:
        return True
    try:
        if os.path.abspath(str(source)) == os.path.abspath(primary_path):
            return True
    except Exception:
        pass
    return os.path.basename(str(source)) == os.path.basename(primary_path)


def register_derived_layer_file(dataset: Dataset, path: str, primary_path: str | None = None) -> list[str]:
    """Attach classes from a `.fiberlayers` bundle to a dataset."""
    definitions = load_derived_layer_definitions(path)
    if primary_path:
        definitions = {
            layer_id: meta
            for layer_id, meta in definitions.items()
            if _derived_definition_matches_source(meta, primary_path)
        }
    if not definitions:
        return []
    if not getattr(dataset, "derived_layers", None):
        dataset.derived_layers = {}
    loaded_ids = []
    for layer_id, meta in definitions.items():
        # A merged dataset can get the same class from several samples'
        # bundles: keep every bundle (bundle_paths) so none of them is dropped.
        previous = dataset.derived_layers.get(layer_id)
        paths = list((previous or {}).get("bundle_paths") or ([previous.get("bundle_path")] if previous and previous.get("bundle_path") else []))
        if meta.get("bundle_path") and meta["bundle_path"] not in paths:
            paths.append(meta["bundle_path"])
        meta = {**meta, "bundle_paths": paths} if paths else meta
        dataset.derived_layers[layer_id] = meta
        dataset.available_layers[layer_id] = True
        loaded_ids.append(layer_id)
    log_dataset_diagnostic(f"  Derived layer bundle: {os.path.basename(path)} ({len(definitions)} classes)")
    return loaded_ids


def discover_derived_layer_files(dataset: Dataset, primary_path: str) -> None:
    for layer_path in find_derived_layer_bigbeds(primary_path):
        register_derived_layer_file(dataset, layer_path, primary_path=primary_path)


def add_dataset_to_state(
    state: Any,
    dataset_id: str,
    path,
    label: str | None = None,
    *,
    detect_bam_chroms: Callable[[str], list],
    detect_bigbed_chroms: Callable[[str], list],
    data_type: str | None = None,
    configure: Callable[[Dataset], None] | None = None,
) -> Dataset:
    """Add a dataset to BrowserState while preserving legacy side effects.

    Slow work first, outside the state lock (services/genome_loading lock order): the file inspection and, when
    the state has no chromosomes yet, the header's. Then, under the lock: a unique id (also against ids reserved
    by other registrations in flight), the dataset published with its order entry, and the chromosomes only if
    they are still empty (a FASTA or genome loaded meanwhile wins).

    ``data_type``: set instead of detected (a live-lift dataset, ``bam_livelift``); ``configure(dataset)``
    runs after its layers are configured, before it is published."""
    from services.genome_loading import state_lock
    primary_path, is_bam = validate_dataset_source(path)
    lock = state_lock(state)
    with lock:
        dataset_id = unique_dataset_id(dataset_id, {**state.datasets, **dict.fromkeys(_reserved(state))})
        _reserved(state).add(dataset_id)
    dataset = Dataset(dataset_id, path, label, data_type=data_type)
    try:
        try:
            if is_bam:
                configure_bam_dataset_layers(dataset, primary_path)
            else:
                configure_bigbed_dataset_layers(state, dataset_id, dataset, primary_path)
            if configure is not None:
                configure(dataset)
            detect = detect_bam_chroms if is_bam else detect_bigbed_chroms
            chroms = None if state.chroms else detect(primary_path)
            while True:
                with lock:
                    if state.chroms or chroms is not None:
                        dataset.color = DATASET_COLORS[len(state.datasets) % len(DATASET_COLORS)]
                        state.datasets[dataset_id] = dataset
                        state.dataset_order.append(dataset_id)
                        if not state.chroms and chroms is not None:
                            state.chroms = chroms
                            state.chrom_map = build_chrom_map(state.chroms)
                            if state.chrom_map:
                                log_dataset_diagnostic(f"  Chromosome mapping enabled (detected {len(state.chroms)} chromosomes)")
                        if hasattr(state, "infer_circular_chroms_from_dataset"):
                            state.infer_circular_chroms_from_dataset(dataset)
                        break
                # The chromosomes were cleared meanwhile: read the header (outside the lock) and try again.
                chroms = detect(primary_path)
        except Exception:
            # A failed registration leaves nothing behind: the caller reports the
            # failure, so the dataset must not stay half-loaded in the state.
            from services.file_handles import release_dataset_handles
            release_dataset_handles(dataset)
            raise
    finally:
        with lock:
            _reserved(state).discard(dataset_id)

    return dataset
