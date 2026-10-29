"""Session export/import payload helpers."""
from __future__ import annotations

import os
from datetime import datetime, timezone

from plugins.packs import PACK_PARTS_KEY, dataset_session_fields, loaded_packs, restorer_for, run_hooks
from utils.validation import is_url


def load_gtf(path):
    from services.gene_annotations import load_gtf as _load_gtf

    return _load_gtf(path)


def _portable_path(path):
    """Absolute local paths, so a session does not depend on the directory the
    server was started from; URLs and virtual paths (motif://) unchanged."""
    if not path or not isinstance(path, str) or is_url(path) or "://" in path or os.path.isabs(path):
        return path
    return os.path.abspath(path)


def _fiberbrowser_version() -> str:
    from version import __version__
    return __version__


def _fiberhmm_version():
    try:
        from services.fiberhmm_runtime import fiberhmm_version
        return fiberhmm_version()
    except Exception:
        return None


def build_session_export_for_request(state, req, *, now: datetime | None = None, dafc_state=None) -> dict:
    """Build a complete session export payload from frontend and server state."""
    timestamp = now or datetime.now(timezone.utc)
    session = {
        "version": "2.0",  # session file format, not the app version
        "timestamp": timestamp.isoformat(),
        "fiberbrowser_version": _fiberbrowser_version(),
        # The FiberHMM this Browser imports (None when it isn't installed).
        "fiberhmm_version": _fiberhmm_version(),
        "viewport": {
            "chrom": req.chrom or (state.chroms[0].name if state.chroms else "chr1"),
            "start": req.start or 0,
            "end": req.end or 10000,
        },
        "datasets": [
            {
                "id": dataset.id,
                "label": dataset.label,
                "paths": [_portable_path(p) for p in dataset.paths],
                "color": dataset.color,
                "data_type": dataset.data_type,
                "is_remote": dataset.is_remote,
                "layer_type": dataset.layer_type,
                "available_layers": dataset.available_layers,
                "derived_layers": getattr(dataset, "derived_layers", {}),
                **({"molecule_groups": [[_portable_path(p), g] for p, g in getattr(dataset, "molecule_groups", [])],
                    "joint_dedup": getattr(dataset, "joint_dedup", "off")}
                   if getattr(dataset, "molecule_groups", None) or getattr(dataset, "joint_dedup", "off") != "off" else {}),
                # A chemistry chosen in the browser (not saved into the file).
                **_chemistry_override(dataset),
                # A live-lift source view's BAM (shown only in its source view).
                **({"lift_source_of": dataset.lift_source_of} if getattr(dataset, "lift_source_of", None) else {}),
                # Fields a plugin pack keeps for a dataset of its own (rebuilt from them on import).
                **dataset_session_fields(dataset),
            }
            for dataset in [state.datasets[dataset_id] for dataset_id in state.dataset_order]
        ],
        "overlays": [
            {
                "id": overlay_id,
                "label": info["label"],
                "path": _portable_path(info["path"]),
                "type": info["type"],
                "color": info["color"],
            }
            for overlay_id, info in getattr(state, "modification_overlays", {}).items()
        ],
        "orthogonal_tracks": [
            {
                "path": _portable_path(track.get("path", "")),
                "label": track.get("label", ""),
                # How it was added, so restoring re-registers it the same way
                # (a BED track stays a BED annotation, a UCSC track keeps its source).
                **{key: track[key] for key in _TRACK_SETTINGS if track.get(key) not in (None, "", [])},
                **(
                    {
                        "format": track["format"],
                        "category": track.get("category"),
                        "counts": track.get("counts"),
                        "threshold": track.get("threshold"),
                        "motif_name": track.get("motif_name"),
                        "motif_type": track.get("motif_type"),
                        "motif_source": track.get("motif_source"),
                        "render_mode": track.get("render_mode"),
                    }
                    if track.get("format") == "custom_motif"
                    else {}
                ),
            }
            for track in getattr(state, "orthogonal_tracks", []) or []
            if isinstance(track, dict)
        ],
        "gtf": {
            "loaded": state.gtf_data is not None,
            "path": _portable_path(_gtf_path_without_plasmids(state)),
            "gene_count": len(state.gtf_data.get("transcripts", [])) if state.gtf_data else 0,
        },
        "reference": {
            "genome": getattr(state, "current_genome", None),
            "fasta_path": _portable_path(getattr(state, "fasta_path", None)),
            **({"pairs": state.reference_pairs} if getattr(state, "reference_pairs", None) else {}),
            # Plasmid maps loaded beside the genome (their sequence and features).
            **({"plasmids": [_portable_path(p) for p in _plasmid_map_paths(state)]} if _plasmid_map_paths(state) else {}),
            # Which BAM contig is which map (renamed/rotated references, links you confirmed).
            **({"plasmid_links": _plasmid_links(state)} if _plasmid_links(state) else {}),
            # The genome declared for custom FASTAs (an insert's contig...): [{fasta_path, genome}] (paths as
            # values, so relinking a moved FASTA carries its declaration).
            **({"genome_declarations": [{"fasta_path": path, "genome": genome}
                                        for path, genome in sorted(getattr(state, "genome_declarations").items())]}
               if getattr(state, "genome_declarations", None) else {}),
        },
    }

    # Datasets on another assembly with a reference of their own (services/panel_genomes.py).
    from services.panel_genomes import session_export as _panel_genomes_export
    panel_genomes = _panel_genomes_export(state, _portable_path)
    if panel_genomes:
        session["panel_genomes"] = panel_genomes

    clustering_data = {}
    for dataset_id, dataset in state.datasets.items():
        if dataset.cluster_assignments:
            clustering_data[dataset_id] = {
                "assignments": dataset.cluster_assignments,
                "peak_regions": dataset.cluster_peak_regions,
                "feature_settings": getattr(dataset, "cluster_feature_settings", None),
                **({"preparation_sampling": dataset.cluster_preparation_sampling}
                   if getattr(dataset, "cluster_preparation_sampling", None) else {}),
            }
    if clustering_data:
        session["clustering"] = clustering_data

    if req.frontend_state:
        session["frontend"] = req.frontend_state

    # Completed footprint-class runs the saved classes (and the active view) refer to, frozen into the session:
    # their artifacts are temporary and gone after a restart.
    from services.consensus_workflow import export_session_runs

    consensus_runs = export_session_runs(state, req.frontend_state or {})
    if consensus_runs:
        session["consensus_runs"] = consensus_runs
    # Plugin packs add their own parts (their runs, frozen the same way), and say which packs wrote the session.
    run_hooks("session_export", state, req.frontend_state or {}, session)
    parts = session.pop(PACK_PARTS_KEY, None) or {}
    packs = loaded_packs()
    if packs:
        session["packs"] = {info.name: {**info.to_dict(), "parts": sorted(set(parts.get(info.name, [])))} for info in packs}

    annotation_state = getattr(state, "annotation_state", None)
    if annotation_state is not None and getattr(annotation_state, "files", None):
        session["annotations"] = {
            "files": [annotation_file.to_dict() for annotation_file in annotation_state.files.values()],
            "enabled_types": dict(annotation_state.enabled_types),
            "confidence_thresholds": dict(annotation_state.confidence_thresholds),
            "type_colors": dict(annotation_state.type_colors),
        }

    if dafc_state is not None and getattr(dafc_state, "cool_file", None):
        session["contact_map"] = {
            "cool_file": _portable_path(dafc_state.cool_file),
            "bigbed_file": _portable_path(getattr(dafc_state, "bigbed_file", None)),
            "current_resolution": getattr(dafc_state, "current_resolution", None),
        }

    # Lets a restore on another computer confirm relinked files are the same.
    from services.session_files import session_file_fingerprints

    session["file_fingerprints"] = session_file_fingerprints(session)

    return {
        "session": session,
        "filename": f'fiberhmm_session_{timestamp.strftime("%Y%m%d_%H%M%S")}.json',
    }


# Track settings a session keeps (not the loaded data: BED intervals, motif PSSMs).
_TRACK_SETTINGS = ("format", "render_mode", "track_type", "category", "ucsc_genome", "ucsc_track", "filter_names")


def _plasmid_map_paths(state) -> list[str]:
    """Source files of the plasmid maps loaded as supplemental references."""
    paths = []
    for meta in (getattr(state, "plasmid_metadata", None) or {}).values():
        path = (meta or {}).get("path")
        if (meta or {}).get("source") == "plasmid_map" and path and path not in paths:
            paths.append(path)
    return paths


def _plasmid_links(state) -> list[dict]:
    from services.plasmid_reconcile import session_links
    links = session_links(state)
    for link in links:
        link["map_path"] = _portable_path(link.get("map_path"))
        link["paths"] = [_portable_path(p) for p in link.get("paths") or []]
    return links


def _gtf_path_without_plasmids(state):
    """The GTF path, without the plasmid maps whose features were merged into it
    (those are saved, and restored, as plasmids)."""
    gtf_path = getattr(state, "gtf_path", None)
    plasmids = set(_plasmid_map_paths(state))
    if not gtf_path or not plasmids:
        return gtf_path
    parts = [p for p in str(gtf_path).split(os.pathsep) if p and p not in plasmids]
    return os.pathsep.join(parts) or None


def _restore_plasmids(state, paths, results: dict) -> None:
    """Load the session's plasmid maps after its reference (a FASTA load clears them)."""
    if not paths:
        return
    from routers.genome import _load_plasmid_into_state, _parse_map
    from services.local_paths import source_ref_access_error
    from services.remote_sources import is_browsable_ref

    for path in paths:
        try:
            if path and is_browsable_ref(path):
                # A map on a cluster or bucket: the same access check and
                # cached copy as opening it from the sidebar.
                problem = source_ref_access_error(path, expected="file")
                if problem:
                    raise FileNotFoundError(problem)
            elif not path or not os.path.isfile(path):
                raise FileNotFoundError(f"Plasmid map not found: {path}")
            _load_plasmid_into_state(state, _parse_map(path), path)
            results.setdefault("plasmids_restored", []).append(path)
        except Exception as exc:
            results.setdefault("plasmids_failed", []).append({"path": path, "error": str(exc)})


def _replace_reference(state, session: dict) -> None:
    """A session that records its reference replaces the current one.

    Exported sessions always carry `reference` and `gtf` (empty when none was
    loaded), so importing one without a FASTA or GTF must not keep the previous
    session's: its sequence and genes would sit beside unrelated reads. Older
    sessions without those keys keep the current reference. The chromosome list
    is rebuilt from the session's datasets (and FASTA, when it has one).
    """
    if "reference" not in session and "gtf" not in session:
        return
    fasta = getattr(state, "fasta", None)
    try:
        for name, value in (
            ("fasta", None), ("fasta_path", None), ("fasta_error", None),
            ("gtf_data", None), ("gtf_path", None), ("current_genome", None),
            ("reference_pairs", None), ("plasmid_sequences", {}), ("plasmid_metadata", {}),
            ("circular_chroms", {}), ("chroms", []), ("chrom_map", {}), ("genome_declarations", {}),
        ):
            setattr(state, name, value)
    except PermissionError:
        return  # a shared reference on a public server stays as it is
    # Never the template's handle (a sandbox may borrow it).
    if fasta is not None and fasta is not getattr(state.__dict__.get("_template"), "fasta", None):
        try:
            fasta.close()
        except Exception:
            pass


def import_session_for_request(state, req, *, dafc_state=None) -> dict:
    """Restore browser state from a session import request.

    A session is a whole workspace: a request scoped to a panel genome (``panel_genome=``, a view) imports into
    its workspace, never through the view (that took the context's lock and then the workspace's, inverting the
    hierarchy). The whole import holds the workspace's state lock (services/genome_loading, level 1): clearing the
    reference, its annotation, genome id, declarations, FASTA or collection and plasmid maps are replaced as one,
    never interleaved with a genome or FASTA load. Call it from a worker thread (the route does)."""
    from services.genome_loading import state_lock
    state = workspace_state(state)
    with state_lock(state):
        return _import_session(state, req, dafc_state=dafc_state)


def workspace_state(state):
    """The workspace a request's state belongs to: a panel genome's view resolves to its base state."""
    base = getattr(state, "__dict__", {}).get("_genome_base")
    return base if base is not None else state


def _import_session(state, req, *, dafc_state=None) -> dict:
    session = req.session

    if not session:
        return {"success": False, "error": "Empty session data"}

    path_mapping = getattr(req, "path_mapping", None)
    if path_mapping:
        from services.session_files import apply_path_mapping

        session = apply_path_mapping(session, path_mapping)

    # Restoring a session counts as using its drag-and-drop uploads, so the
    # upload cache keeps them past its retention window.
    from services.session_files import session_file_refs
    from services.upload_store import mark_uploads_used

    mark_uploads_used(ref["path"] for ref in session_file_refs(session))

    version = session.get("version", "1.0")
    if version not in ["1.0", "2.0"]:
        return {"success": False, "error": f"Unsupported session version: {version}"}

    results = {
        "datasets_loaded": 0,
        "datasets_failed": [],
        "overlays_loaded": 0,
        "overlays_failed": [],
        "clustering_restored": False,
        "annotations_failed": [],
        "tracks_failed": [],
        "derived_layers_failed": [],
    }

    # Consensus runs and their overlays belong to the datasets being replaced:
    # cancel them and detach the active result (a running job never installs).
    from services.consensus_workflow import dispose_session as dispose_consensus, session_run_ids
    # Runs the session carries (its saved classes refer to them) stay as they are; the rest go. None is deleted
    # before its replacement exists: they are restored under their own ids once the datasets are open.
    dispose_consensus(state, keep_fit_cache=True, keep_job_ids=session_run_ids(session))
    # Scans open in the workspace and live scans belong to it too (the feature hub reopens the session's own).
    from services.scan.jobs import dispose_session as dispose_scans
    dispose_scans(state)
    # Plugin packs drop their work for the replaced session (keeping what the new one carries).
    run_hooks("session_import_begin", state, session)
    # Loads still running for the replaced datasets must not refill the caches.
    from services.dataset_generation import bump_dataset_generation
    for old_id in list(state.datasets):
        bump_dataset_generation(state, old_id)
    from services.file_handles import release_dataset_handles
    for dataset in state.datasets.values():
        release_dataset_handles(dataset)
    state.datasets.clear()
    state.dataset_order.clear()
    state.modification_overlays.clear()
    state.orthogonal_tracks.clear() if isinstance(state.orthogonal_tracks, list) else None
    # Every cache keyed by dataset ID: the session may reuse an ID for another file.
    for cache_name in ("_broad_cache", "_meta_profile_cache", "_working_set_cache",
                       "_track_data_cache", "_track_region_cache",
                       "_methylation_cache", "_read_strand_calls"):
        cache = getattr(state, cache_name, None)
        if cache is not None:
            cache.clear()
    _replace_reference(state, session)
    # Catalog groups/tracks loaded before are gone with the datasets and tracks
    # (a group whose datasets the session brings back is kept, below).
    previous_catalog_members = {g: dict(m) for g, m in (getattr(state, "__dict__", {}).get("_catalog_members") or {}).items()}
    if hasattr(state, "_catalog_loaded"):
        state._catalog_loaded = {}
    if hasattr(state, "_catalog_loaded_tracks"):
        state._catalog_loaded_tracks = set()

    pack_datasets = []
    for dataset_data in session.get("datasets", []):
        try:
            paths = dataset_data.get("paths", [])
            if not paths:
                continue
            restorer = restorer_for(dataset_data)
            if restorer is not None:
                # A plugin pack's dataset: built once the plain datasets and references are back (below).
                pack_datasets.append((restorer, dataset_data))
                continue
            if dataset_data.get("pack"):
                # Written by a plugin pack this build doesn't have: skipped (not a failure), and said so (missing_packs).
                results.setdefault("datasets_skipped", []).append({
                    "id": dataset_data.get("id", "unknown"),
                    "reason": "needs features this build doesn't include",
                    "pack": dataset_data.get("pack"),
                })
                continue

            path_arg = paths if len(paths) > 1 else paths[0]
            dataset_id = dataset_data.get("id", f"imported_{results['datasets_loaded']}")
            label = dataset_data.get("label")

            dataset = state.add_dataset(dataset_id, path_arg, label=label)
            if dataset_data.get("color"):
                dataset.color = dataset_data["color"]
            _restore_chemistry_override(dataset, dataset_data)
            # Derived layers attached from elsewhere (not found beside the
            # reads) come back from the bundles the session recorded.
            from services.dataset_registration import register_derived_layer_file
            from services.session_files import derived_bundle_paths

            for bundle in derived_bundle_paths(dataset_data):
                if any(bundle in ((meta or {}).get("bundle_paths") or [(meta or {}).get("bundle_path")])
                       for meta in (getattr(dataset, "derived_layers", None) or {}).values()):
                    continue  # already found beside the reads
                try:
                    if not register_derived_layer_file(dataset, bundle):
                        raise ValueError("no layers for this dataset in the bundle")
                except Exception as exc:
                    results["derived_layers_failed"].append({"id": dataset_id, "path": bundle, "error": str(exc)})

            results["datasets_loaded"] += 1

        except Exception as exc:
            results["datasets_failed"].append({
                "id": dataset_data.get("id", "unknown"),
                "error": str(exc),
            })

    if hasattr(state, "_catalog_loaded"):
        # Catalog membership names objects: a group stays loaded only if its members came back as datasets of
        # the same files under the same ids (an unrelated dataset under a reused id is not a member).
        from services.catalog_endpoint import rebuild_catalog_membership
        # Without recorded members there is no provenance, so nothing reads as loaded.
        rebuild_catalog_membership(state, previous_catalog_members)

    for overlay_data in session.get("overlays", []):
        try:
            overlay_id = overlay_data.get("id")
            overlay_path = overlay_data.get("path")
            if not overlay_path:
                continue

            if not is_url(overlay_path) and not os.path.exists(overlay_path):
                results["overlays_failed"].append({
                    "id": overlay_id,
                    "error": "File not found",
                })
                continue

            state.modification_overlays[overlay_id] = {
                "label": overlay_data.get("label", overlay_id),
                "path": overlay_path,
                "type": overlay_data.get("type", "unknown"),
                "color": overlay_data.get("color", "#9333ea"),
            }
            results["overlays_loaded"] += 1

        except Exception as exc:
            results["overlays_failed"].append({
                "id": overlay_data.get("id", "unknown"),
                "error": str(exc),
            })

    for track_data in session.get("orthogonal_tracks", []):
        try:
            track_path = track_data.get("path", "")
            track_label = track_data.get("label", "")

            if track_path.startswith("motif://") and track_data.get("format") == "custom_motif":
                counts = track_data.get("counts")
                if counts and all(base in counts for base in "ACGT"):
                    from services import motifs as motif_service

                    pssm = motif_service.pwm_to_pssm(counts)
                    state.orthogonal_tracks.append({
                        "path": track_path,
                        "label": track_label,
                        "format": "custom_motif",
                        "render_mode": track_data.get("render_mode", "annotation"),
                        "category": track_data.get("category", "motif"),
                        "motif_name": track_data.get("motif_name", ""),
                        "motif_type": track_data.get("motif_type", ""),
                        "motif_source": track_data.get("motif_source"),
                        "counts": counts,
                        "pssm": pssm,
                        "threshold": track_data.get("threshold", 0.85),
                    })
            elif track_path:
                # Through the normal loader: BED files are parsed, remote URLs and
                # UCSC tracks are accepted, and a track that can't load is reported.
                from services.tracks_endpoint import add_track_for_request

                filters = track_data.get("filter_names")
                added = add_track_for_request(
                    state,
                    path=track_path,
                    label=track_label or None,
                    render_mode=track_data.get("render_mode"),
                    track_type=track_data.get("track_type"),
                    ucsc_genome=track_data.get("ucsc_genome"),
                    ucsc_track=track_data.get("ucsc_track"),
                    filter_names=",".join(filters) if isinstance(filters, list) else filters,
                    category=track_data.get("category"),
                )
                if not added.get("success"):
                    results["tracks_failed"].append({"path": track_path, "error": added.get("message", "could not load")})
        except Exception as exc:
            results["tracks_failed"].append({"path": track_data.get("path", ""), "error": str(exc)})

    gtf_info = session.get("gtf", {})
    gtf_path = gtf_info.get("path")
    if gtf_path and os.path.isfile(gtf_path):
        try:
            state.gtf_data = load_gtf(gtf_path)
            state.gtf_path = gtf_path
        except Exception as exc:
            print(f"  Warning: session restore failed for GTF '{gtf_path}': {exc}")

    ref_info = session.get("reference", {})
    declarations = ref_info.get("genome_declarations")
    if declarations:
        from services.motifs import normalize_declarations
        # Older sessions keep {path: genome}: their keys are relinked here (apply_path_mapping maps values).
        # A list was already relinked by apply_path_mapping (its paths are values): mapping it again would move a
        # declaration twice (swapped relinks). Only the older {path: genome} keys still need the mapping.
        state.genome_declarations = normalize_declarations(
            declarations, path_mapping if isinstance(declarations, dict) else None)
        state.genome_declaration_rev = int(getattr(state, "genome_declaration_rev", 0) or 0) + 1
    ref_genome = ref_info.get("genome")
    ref_fasta = ref_info.get("fasta_path")
    if ref_genome:
        state.current_genome = ref_genome
    if ref_info.get("pairs"):
        try:
            from services.genome_loading import reference_lock
            from services.reference_collection import load_reference_pairs
            with reference_lock(state):
                load_reference_pairs(state, ref_info["pairs"])
        except Exception as exc:
            results["fasta_error"] = str(exc)
    elif ref_fasta:
        try:
            from services.genome_loading import reference_lock
            with reference_lock(state):
                err = state._load_fasta(ref_fasta)
            if err:
                print(f"  Session restore: FASTA load warning: {err}")
                results["fasta_error"] = err
            else:
                print(f"  Session restore: FASTA loaded: {ref_fasta}")
        except Exception as exc:
            print(f"  Session restore: FASTA load failed: {exc}")
            results["fasta_error"] = str(exc)
    _restore_plasmids(state, ref_info.get("plasmids") or [], results)
    if results.get("plasmids_restored"):
        # The datasets were restored before their maps: link them now, as saved.
        try:
            from services.plasmid_reconcile import restore_session_links
            results["plasmid_links_restored"] = len(restore_session_links(state, ref_info.get("plasmid_links") or []))
        except Exception as exc:
            results["plasmid_links_error"] = str(exc)

    # Each dataset's own reference (another assembly), after the datasets and
    # the main reference are back. A session without them clears any loaded.
    from services.panel_genomes import session_restore as _restore_panel_genomes
    restored_genomes = _restore_panel_genomes(state, session.get("panel_genomes"))
    if session.get("panel_genomes"):
        results["panel_genomes_restored"] = restored_genomes["restored"]
        if restored_genomes["failed"]:
            results["panel_genomes_failed"] = restored_genomes["failed"]
    # Plugin packs' datasets (built from their definition, or their built files reused) now that the sources and
    # every reference are back. They were not registered when the panel references were restored, so a saved
    # FASTA of theirs never stands in for the one built now.
    for restorer, dataset_data in pack_datasets:
        try:
            opened = restorer.restore(state, dataset_data)
            restored_dataset = state.datasets.get(opened["dataset"]["id"])
            if restored_dataset is not None and dataset_data.get("color"):
                restored_dataset.color = dataset_data["color"]
            if restored_dataset is not None:
                _restore_chemistry_override(restored_dataset, dataset_data)
            results["datasets_loaded"] += 1
        except Exception as exc:
            results["datasets_failed"].append({"id": dataset_data.get("id", "unknown"), "error": str(exc)})
    if pack_datasets:
        # Back in the session's dataset order.
        saved_order = [d.get("id") for d in session.get("datasets", []) if d.get("id") in state.datasets]
        rest = [d for d in state.dataset_order if d not in saved_order]
        state.dataset_order[:] = saved_order + rest
        for restorer in {id(r): r for r, _ in pack_datasets}.values():
            if restorer.finish is not None:
                restorer.finish(state)

    clustering = session.get("clustering", {})
    if clustering:
        for dataset_id, cluster_data in clustering.items():
            if dataset_id in state.datasets:
                state.datasets[dataset_id].cluster_assignments = cluster_data.get("assignments", {})
                state.datasets[dataset_id].cluster_peak_regions = cluster_data.get("peak_regions")
                state.datasets[dataset_id].cluster_feature_settings = cluster_data.get("feature_settings")
                state.datasets[dataset_id].cluster_preparation_sampling = cluster_data.get("preparation_sampling")
                results["clustering_restored"] = True

    annotations = session.get("annotations", {})
    if hasattr(state, "annotation_state"):
        from models.domain import AnnotationFile, AnnotationState, AnnotationType

        state.annotation_state = AnnotationState()
        annotation_state = state.annotation_state
        annotation_state.enabled_types = dict(annotations.get("enabled_types", {}))
        annotation_state.confidence_thresholds = dict(annotations.get("confidence_thresholds", {}))
        annotation_state.type_colors = dict(annotations.get("type_colors", {}))
        for annotation_data in annotations.get("files", []):
            path = annotation_data.get("path")
            if not path or (not is_url(path) and not os.path.isfile(path)):
                results["annotations_failed"].append({
                    "id": annotation_data.get("id", "unknown"),
                    "error": "File not found",
                })
                continue
            annotation_file = AnnotationFile(
                annotation_data.get("id", "annotation"),
                path,
                annotation_data.get("label"),
            )
            annotation_file.active = bool(annotation_data.get("active", False))
            annotation_file.dataset_ids = list(annotation_data.get("dataset_ids", []))
            for type_data in annotation_data.get("annotation_types", []):
                annotation_type = AnnotationType(
                    name=type_data.get("name", "annotation"),
                    category=type_data.get("category", ""),
                    description=type_data.get("description", ""),
                    color=type_data.get("color"),
                )
                annotation_file.annotation_types[annotation_type.name] = annotation_type
            annotation_state.files[annotation_file.id] = annotation_file

    from services.consensus_workflow import restore_session_runs

    restored_runs, run_problems = restore_session_runs(state, session)
    results["consensus_runs_restored"] = len(restored_runs)
    results["consensus_runs_failed"] = run_problems
    # Plugin packs restore their parts; a session written with packs this build doesn't have is said so.
    run_hooks("session_import_end", state, session, results)
    from services.hub.migration import legacy_runs
    hub_legacy = legacy_runs(state)
    results["hub_legacy"] = hub_legacy
    missing = _missing_packs(session)
    if missing:
        results["missing_packs"] = missing

    contact_map = session.get("contact_map")
    loaded_map = getattr(dafc_state, "cool_file", None) if dafc_state is not None else None
    if loaded_map and not _same_contact_map(contact_map, loaded_map):
        # The imported session has no contact map, or another one: the one
        # loaded before goes, or saving this session would bring it back (the
        # browser loads the session's own map after import; if that fails, or
        # nothing loads it, no map is better than the wrong one). Session
        # import and map loading are both local-only, so no other visitor
        # shares it.
        clear_contact_map(dafc_state)
    # Linked-session registries contain live, process-local IDs and may be
    # shared by several browser tabs/users. They are intentionally neither
    # imported nor replaced by portable session JSON.

    return {
        **state_import_payload(
            state,
            viewport=session.get("viewport", {}),
            frontend=session.get("frontend", {}),
            contact_map=contact_map,
        ),
        "results": results,
        "message": f"Loaded {results['datasets_loaded']} datasets, {results['overlays_loaded']} overlays",
    }


def _chemistry_override(dataset) -> dict:
    """The dataset's chemistry when it was chosen in the browser, for the session.

    A chemistry declared in the file itself is read again from the file on import.
    """
    metadata = getattr(dataset, "chemistry_metadata", None) or {}
    from services.chemistry_metadata import dataset_consensus_chemistry

    chemistry = dataset_consensus_chemistry(dataset)
    if not chemistry or metadata.get("source") != "user-selection":
        return {}
    # family_scan_chemistry: the name before 3.0, for older Browsers opening this session.
    return {"consensus_chemistry": chemistry, "family_scan_chemistry": chemistry, "chemistry_metadata": metadata}


def _missing_packs(session: dict) -> list[str]:
    """Labels of the plugin packs that wrote parts of this session and aren't in this build."""
    loaded = {info.name for info in loaded_packs()}
    written = session.get("packs") if isinstance(session.get("packs"), dict) else {}
    missing = {}
    for name, info in written.items():
        if name in loaded:
            continue
        # A pack that says which parts it wrote is missing only when the session holds one. A marker from before packs
        # listed their parts can't say: the browser, which knows each part the pack wrote and which this build has
        # (api/sessionPacks.ts), says what was left out; here only its datasets count (below).
        parts = info.get("parts") if isinstance(info, dict) else None
        if not isinstance(parts, list) or not any(session.get(k) for k in parts):
            continue
        missing[name] = (info or {}).get("label") or name if isinstance(info, dict) else name
    labels = {name: (info.get("label") if isinstance(info, dict) else None) or name for name, info in written.items()}
    for dataset_data in session.get("datasets", []) or []:
        name = dataset_data.get("pack") if isinstance(dataset_data, dict) else None
        # A dataset entry this build restores itself (a feature that left the pack for core) isn't missing.
        if name and name not in loaded and name not in missing and restorer_for(dataset_data) is None:
            missing[name] = labels.get(name, name)
    return sorted(set(missing.values()))


def _restore_chemistry_override(dataset, dataset_data: dict) -> None:
    """Put back a chemistry the session's user chose in the browser."""
    from services.chemistry_metadata import DECLARATIONS

    dataset.molecule_groups = dataset_data.get("molecule_groups") or []
    dataset.joint_dedup = dataset_data.get("joint_dedup", "off")
    if dataset_data.get("lift_source_of"):
        dataset.lift_source_of = str(dataset_data["lift_source_of"])
    # consensus_chemistry; sessions saved before 3.0 call it family_scan_chemistry.
    chemistry = dataset_data.get("consensus_chemistry") or dataset_data.get("family_scan_chemistry")
    metadata = dataset_data.get("chemistry_metadata")
    if chemistry not in DECLARATIONS or not isinstance(metadata, dict):
        return
    if metadata.get("source") != "user-selection":
        return
    dataset.consensus_chemistry = chemistry
    if not hasattr(type(dataset), "family_scan_chemistry"):
        dataset.family_scan_chemistry = chemistry   # a plain object without the Dataset alias property
    dataset.chemistry_metadata = {**metadata, "chemistry": chemistry}


def _same_contact_map(contact_map, loaded_path) -> bool:
    """Whether the session's contact map is the file loaded now."""
    if not isinstance(contact_map, dict) or not contact_map.get("cool_file"):
        return False
    def norm(path):
        return os.path.realpath(os.path.expanduser(str(path)))
    return norm(contact_map["cool_file"]) == norm(loaded_path)


def clear_contact_map(dafc_state) -> None:
    """Unload the contact map: its handles, resolutions and expected caches
    (new objects, so a computation still running drops its result). The
    linked-session registry is kept."""
    if getattr(dafc_state, 'bb', None) is not None:
        dafc_state.bb.close()
    dafc_state.clr = None
    dafc_state.cool_file = None
    dafc_state.bigbed_file = None
    dafc_state.bb = None
    dafc_state.resolutions = []
    dafc_state.current_resolution = 0
    dafc_state.chroms = []
    from services.byte_cache import shared_cache
    dafc_state.chrom_expected_cache = shared_cache('profiles')
    dafc_state.chrom_expected_computing = set()


def state_import_payload(state, *, viewport: dict, frontend: dict, contact_map=None) -> dict:
    """What the frontend's applyImportedState needs to show ``frontend`` on
    this server's loaded data. Shared by session import and figure rendering."""
    response_datasets = []
    for dataset_id in state.dataset_order:
        dataset = state.datasets[dataset_id]
        # Match dataset listing/registration, including live_lift and source
        # identity: restored controls and coverage caches need both immediately.
        # Older embedded callers still supply the lightweight dataset protocol.
        if hasattr(dataset, "to_dict"):
            response_datasets.append(dataset.to_dict())
            continue
        response_datasets.append({
            "id": dataset.id,
            "label": dataset.label,
            "path": dataset.paths[0] if dataset.paths else "",
            "paths": dataset.paths,
            "color": dataset.color,
            "data_type": dataset.data_type,
            "layer_type": dataset.layer_type,
            "available_layers": dataset.available_layers,
            "derived_layers": getattr(dataset, "derived_layers", {}),
            "consensus_chemistry": getattr(dataset, "consensus_chemistry", None) or getattr(dataset, "family_scan_chemistry", None),
            "family_scan_chemistry": getattr(dataset, "consensus_chemistry", None) or getattr(dataset, "family_scan_chemistry", None),
            "chemistry_metadata": getattr(dataset, "chemistry_metadata", None),
        })

    response_overlays = [
        {
            "id": overlay_id,
            "label": info["label"],
            "path": info["path"],
            "type": info["type"],
            "color": info["color"],
        }
        for overlay_id, info in getattr(state, "modification_overlays", {}).items()
    ]

    return {
        "success": True,
        "viewport": viewport or {},
        "datasets": response_datasets,
        "overlays": response_overlays,
        "has_gtf": state.gtf_data is not None,
        "has_fasta": state.fasta is not None,
        "fasta_path": getattr(state, "fasta_path", None),
        "current_genome": getattr(state, "current_genome", None),
        "frontend": frontend or {},
        "contact_map": contact_map,
        "annotations": [
            annotation_file.to_dict()
            for annotation_file in getattr(getattr(state, "annotation_state", None), "files", {}).values()
        ],
    }
