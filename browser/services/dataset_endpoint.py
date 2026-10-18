"""Endpoint orchestration helpers for dataset management routes."""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import threading
import urllib.parse

from models.requests import AddDatasetRequest, MergeDatasetsRequest, UnmergeDatasetsRequest
from services.dataset_registration import register_derived_layer_file
from services.query_params import resolve_dataset_id
from services.local_paths import normalize_local_paths, path_access_error
from services.supported_files import attach_remote_indexes, not_openable_message, partition_sidecars
from utils.validation import (
    detect_data_format,
    is_s3_url,
    is_source_ref,
    is_url,
    validate_remote_bam,
    validate_source_ref,
    validate_remote_url,
    validate_s3_url,
)


DATASET_EXTENSIONS = [".bam", ".bb", ".bigbed", ".bigBed"]


def _looks_like_dataset(path: str) -> bool:
    """A file a dataset can be opened from (BAM or BigBed, any case)."""
    return os.path.basename(path).lower().endswith((".bam", ".bb", ".bigbed"))


def _named(path: str, error: str) -> str:
    """An error that names its file, so a list of them says which file failed why."""
    from services.supported_files import display_name
    base = display_name(path)
    return error if base in error else f"{base}: {error}"


def add_dataset_paths_from_request(req: AddDatasetRequest) -> list[str]:
    if req.url:
        return [req.url]
    if req.paths:
        return list(req.paths)
    if req.path:
        return [req.path]
    return []


def _remote_error(path: str, error) -> str:
    """A remote file's validation error; a refused pre-signed link says it expired."""
    text = str(error or "not accessible")
    if "HTTP 401" in text or "HTTP 403" in text:
        from services import signed_urls
        if signed_urls.is_registered(path) or signed_urls.looks_signed(path):
            signed_urls.mark_expired(path)
            return signed_urls.expired_message(path)
    return f"{path}: {text}"


def validate_dataset_paths(paths: list[str], original_paths: list[str] | None = None) -> list[str]:
    validation_errors = []
    originals = original_paths or paths
    from services.lab.paths import PathDenied, confine
    for path, original in zip(paths, originals):
        if not is_url(path):
            try:
                confine(original)  # a lab server: only inside its data folders
            except PathDenied as exc:
                validation_errors.append(f"{exc} ({original})")
                continue
            # An online-only (cloud placeholder) or empty file: say so instead of
            # opening a dataset with no reads (metadata only; never reads it).
            from services.cloud_placeholders import dataset_unavailable_message
            unavailable = dataset_unavailable_message(path)
            access_error = unavailable or path_access_error(path, original_path=original, expected="file or directory")
            if access_error:
                validation_errors.append(access_error)
            elif os.path.isfile(path) and not _looks_like_dataset(path):
                # An index, a track, a FASTA...: say what it is instead of failing later.
                validation_errors.append(not_openable_message(original))
            continue

        data_format = detect_data_format(path)
        if data_format == "bam":
            validation = validate_remote_bam(path)
            if not validation["valid"]:
                validation_errors.append(_remote_error(path, validation["error"]))
        elif data_format == "bigbed":
            if is_source_ref(path):
                validation = validate_source_ref(path, "bigbed")
            elif is_s3_url(path):
                validation = validate_s3_url(path)
            else:
                validation = validate_remote_url(path)
            if not validation["valid"]:
                validation_errors.append(_remote_error(path, validation["error"]))
            elif not is_s3_url(path) and not validation.get("supports_range"):
                validation_errors.append(
                    f"{path}: Server does not support byte-range requests (required for BigBed/BigWig)"
                )
        else:
            validation_errors.append(not_openable_message(original))
    return validation_errors


def _basename_for_path(path: str) -> str:
    if is_url(path):
        parsed = urllib.parse.urlparse(path)
        return os.path.basename(parsed.path)
    return os.path.basename(path.rstrip("/"))


def _strip_dataset_extension(base_name: str) -> str:
    for extension in DATASET_EXTENSIONS:
        if base_name.endswith(extension):
            return base_name[:-len(extension)]
    return base_name


def infer_dataset_label_and_id(paths: list[str]) -> tuple[str, str]:
    if len(paths) == 1:
        default_label = _strip_dataset_extension(_basename_for_path(paths[0]))
        base_name = default_label
    else:
        basenames = [_basename_for_path(path) for path in paths]
        prefix = os.path.commonprefix(basenames).rstrip("_.-") if basenames else ""
        if len(prefix) > 3:
            default_label = f"{prefix} ({len(paths)} files)"
        else:
            default_label = f"{len(paths)} files"
        base_name = default_label.replace(" ", "_")

    dataset_id = (
        base_name
        .replace(" ", "_")
        .replace(".", "_")
        .replace("(", "")
        .replace(")", "")
    )
    return default_label, dataset_id


def ensure_local_bam_indexes(paths: list[str]) -> dict | None:
    for path in paths:
        if is_url(path) or not path.lower().endswith(".bam"):
            continue

        from services.bam_handles import local_bam_index_exists
        bai1 = path + ".bai"
        if local_bam_index_exists(path):
            continue
        from services.lab.paths import PathDenied, confine_sidecar
        try:
            confine_sidecar(bai1)  # a lab server: never into a read-only data root
        except PathDenied:
            return {"success": False, "error": (
                f"BAM index (.bai) not found for {path}, and its folder is read-only on this server. "
                "Ask a lab admin to index it (samtools index), or copy the BAM into a writable folder.")}

        import shutil
        from services.external_tools import tool_path
        samtools = tool_path("samtools")
        if samtools:
            print("  BAM index not found, creating with samtools...")
            try:
                subprocess.run([samtools, "index", path], check=True, capture_output=True, timeout=300)
                print(f"  Index created: {bai1}")
                continue
            except Exception as exc:
                print(f"  WARNING: samtools index failed: {exc}")

        try:
            import pysam
            print("  BAM index not found, creating with pysam...")
            pysam.index(path)
            print("  Index created via pysam")
        except Exception as exc:
            print(f"  WARNING: pysam index failed: {exc}")
            tool_hint = "samtools not in PATH" if not samtools else "auto-creation failed"
            return {
                "success": False,
                "error": (
                    f"BAM index (.bai) not found for {path}, and {tool_hint}. "
                    "FiberBrowser needs a .bai next to local BAM files to fetch reads. "
                    f"Run: samtools index {os.path.basename(path)}, or place an existing .bai beside the BAM."
                ),
            }
    return None


def prepare_local_indexes_for_request(req: AddDatasetRequest) -> None:
    """Build a missing local BAM index before the add (minutes for a large BAM): the router runs this in
    a worker thread so the server stays live, then registers the dataset on the event loop as before
    (registration publishes the dataset before its layers are known: no request may see it half-made).
    Anything wrong is left for the add itself to report."""
    try:
        raw_paths = add_dataset_paths_from_request(req)
        raw_paths, _indexes, _messages = partition_sidecars(raw_paths)
        paths = [p for p in normalize_local_paths(raw_paths) if isinstance(p, str) and "://" not in p]
        if paths and not validate_dataset_paths(paths, raw_paths):
            ensure_local_bam_indexes(paths)
    except Exception:
        pass


def add_dataset_for_request(state, req: AddDatasetRequest) -> dict:
    """Add a dataset from local paths, remote URLs, or explicit path lists."""
    try:
        raw_paths = add_dataset_paths_from_request(req)
        if not raw_paths:
            return {"success": False, "error": "No path or URL provided"}
        # Index files chosen with their BAM are not datasets: leave them out
        # (the BAM finds its index); one chosen on its own says what to open.
        raw_paths, indexes, index_messages = partition_sidecars(raw_paths)
        if not raw_paths:
            return {"success": False, "error": "\n\n".join(index_messages)}
        raw_paths = attach_remote_indexes(raw_paths, indexes)

        from services.tracks_endpoint import _held_url
        paths = [_held_url(p) for p in normalize_local_paths(raw_paths)]
        validation_errors = validate_dataset_paths(paths, raw_paths)
        if validation_errors:
            # Each message names its file and says what is wrong (no "Validation failed" preamble).
            return {"success": False, "error": "\n\n".join(validation_errors)}

        default_label, dataset_id = infer_dataset_label_and_id(paths)
        index_error = ensure_local_bam_indexes(paths)
        if index_error:
            return index_error

        path_arg = paths if len(paths) > 1 else paths[0]
        dataset = state.add_dataset(dataset_id, path_arg, label=req.label or default_label)
        result = {"success": True, "dataset": dataset.to_dict()}
        if dataset.is_remote:
            result["message"] = "Remote dataset loaded successfully"
        # In the Windows app (WSL): large files on a Windows drive are slower to read.
        from services.wsl_interop import slow_mount_note
        notes = [note for note in (slow_mount_note(p) for p in paths if isinstance(p, str)) if note]
        # A header without frame evidence over frame-dependent footprints (FiberHMM 3.0.1 warns the same way).
        if getattr(dataset, "data_type", None) == "bam" and not getattr(dataset, "is_remote", False):
            from services.bam_tags import UNVERIFIABLE_FRAME_WARNING, bam_frame_unverifiable
            notes += [f"{os.path.basename(p)}: {UNVERIFIABLE_FRAME_WARNING}"
                      for p in paths if isinstance(p, str) and bam_frame_unverifiable(p)]
        if index_messages or notes:
            result["warnings"] = [*index_messages, *notes]
        return result
    except Exception as exc:
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(exc)}


def add_grouped_datasets_for_request(state, req: AddDatasetRequest) -> dict:
    """Add multiple files, grouping BigBed layer companions into one dataset each.

    When several BigBed files belonging to the same sample are loaded together
    (e.g. ``sample_1_footprint.bb`` + ``sample_1_tf.bb`` + ``sample_1_msp.bb``),
    create ONE dataset per sample with the layers paired — instead of one
    dataset per file. Files that don't pair (and BAMs) each become their own
    dataset, so a mixed multi-select still does the sensible thing. Grouping
    uses the same companion detection as a single-file load, so what gets paired
    here is exactly what would pair when loading any one of the files alone.
    """
    from services.bigbed_detection import detect_overlay_type, find_companion_bigbed_files

    raw_paths = add_dataset_paths_from_request(req)
    if not raw_paths:
        return {"success": False, "error": "No path or URL provided"}
    # A BAM's index chosen with it is used, not opened; an index alone is reported.
    raw_paths, indexes, errors = partition_sidecars(raw_paths)
    paths = normalize_local_paths(attach_remote_indexes(raw_paths, indexes))

    def _is_local_bigbed(path: str) -> bool:
        return not is_url(path) and path.lower().endswith((".bb", ".bigbed"))

    # Lead each sample group with a sensible primary layer (the read layer when
    # present) so the dataset's primary reflects footprint/MSP rather than TF/5mC.
    _layer_priority = {
        "footprint": 0, "msp": 1, "fire": 1, "tf": 2,
        "m6a": 3, "mod": 3, "m5c": 4, "deam": 5,
    }

    def _sort_key(path: str):
        if not _is_local_bigbed(path):
            return (9, path)
        return (_layer_priority.get(detect_overlay_type(path), 8), path)

    datasets: list[dict] = []
    consumed: set[str] = set()
    for path in sorted(paths, key=_sort_key):
        abspath = os.path.abspath(path)
        if abspath in consumed:
            continue
        consumed.add(abspath)
        if _is_local_bigbed(path):
            companions = find_companion_bigbed_files(path, detect_overlay_type(path))
            for companion_path in companions.values():
                consumed.add(os.path.abspath(companion_path))
        result = add_dataset_for_request(state, AddDatasetRequest(path=path))
        if result.get("success") and result.get("dataset"):
            datasets.append(result["dataset"])
        else:
            # Each file on its own: one that fails never stops the others.
            errors.append(_named(path, result.get("error") or "could not be opened"))

    if not datasets:
        message = "Failed to load datasets:\n" + "\n\n".join(errors) if errors else "No datasets loaded"
        return {"success": False, "error": message}
    out = {"success": True, "datasets": datasets}
    if errors:
        out["errors"] = errors
    return out


def merge_datasets_for_request(state, req: MergeDatasetsRequest) -> dict:
    """Merge 2+ datasets into one multi-file dataset."""
    # Live-lift datasets are never merged (a merge would register their source BAMs as a plain
    # BAM dataset, drawn in source coordinates): refused (409) before anything changes.
    from services.lift.capability import require
    for raw_id in req.dataset_ids or ():
        require(state.get_dataset(resolve_dataset_id(state, raw_id)), "merge")
    try:
        resolved_ids = [
            dataset_id
            for dataset_id in (resolve_dataset_id(state, raw_id) for raw_id in req.dataset_ids)
            if dataset_id
        ]
        if len(resolved_ids) < 2:
            return {"success": False, "error": "Need at least 2 datasets to merge"}

        all_paths = []
        derived_bundles: list[str] = []
        labels = []
        data_types = set()
        sources = {}          # id -> the dataset object merged (identity is re-checked at commit)
        for dataset_id in resolved_ids:
            dataset = state.get_dataset(dataset_id)
            if dataset is None:
                return {"success": False, "error": f"Dataset not found: {dataset_id}"}
            sources[dataset_id] = dataset
            data_types.add(getattr(dataset, "data_type", None))
            all_paths.extend(dataset.paths)
            # Single-file BigBed datasets keep their tf/msp/m5c/... overlays in
            # companion_layers (auto-detected from the directory), NOT in .paths.
            # Collect them too, otherwise merging silently drops every companion
            # layer and the merged dataset shows only footprint-inferred layers.
            for comp in (getattr(dataset, "companion_layers", None) or {}).values():
                all_paths.extend([comp] if isinstance(comp, str) else list(comp))
            # Derived-layer bundles (.fiberlayers.bb/.json) are attached to the
            # merged dataset afterwards, not listed as read sources: in the path
            # list a BAM merge would be taken for BigBed and lose its reads.
            for derived in (getattr(dataset, "derived_layers", None) or {}).values():
                if not isinstance(derived, dict):
                    continue
                for bundle_path in derived.get("bundle_paths") or [derived.get("bundle_path")]:
                    if bundle_path and bundle_path not in derived_bundles:
                        derived_bundles.append(bundle_path)
            labels.append(dataset.label)

        # One dataset reads one kind of file: a BAM listed with BigBeds would be
        # opened as BigBed and its reads lost. Refuse before changing anything.
        data_types.discard(None)
        if len(data_types) > 1:
            return {
                "success": False,
                "error": "Can't merge BAM and BigBed datasets; merge datasets of the same kind.",
            }

        # Dedup while preserving order (a footprint and its companion can already
        # both be in .paths for directory-loaded groups).
        seen_paths: set[str] = set()
        all_paths = [p for p in all_paths if not (p in seen_paths or seen_paths.add(p))]

        merged_label = req.label or " + ".join(labels)
        basenames = [os.path.basename(path).split(".")[0] for path in all_paths]
        merged_id = "_".join(basenames[:3])
        if len(basenames) > 3:
            merged_id += f"_+{len(basenames) - 3}"
        merged_id = merged_id.replace(" ", "_").replace("(", "").replace(")", "")

        # Build the merged dataset before removing the originals, so a failure
        # leaves them in place.
        path_arg = all_paths if len(all_paths) > 1 else all_paths[0]
        # The merged dataset is registered on its own (its file inspection outside the state lock); a failure
        # registers nothing. The originals go in one step under the lock, only if they are all still there.
        merged_dataset = state.add_dataset(merged_id, path_arg, label=merged_label)
        for bundle_path in derived_bundles:
            try:
                register_derived_layer_file(merged_dataset, bundle_path)
            except Exception as exc:
                print(f"  Warning: could not attach derived layers {bundle_path}: {exc}")

        removed_ids = list(resolved_ids)
        from services.genome_loading import state_lock
        with state_lock(state):
            # Each source still the very dataset merged (not removed, nor replaced by another under its id).
            gone = [d for d in removed_ids if state.datasets.get(d) is not sources[d]]
            if gone:
                # Undo only what this merge created.
                _remove_created(state, [merged_dataset])
                return {"success": False, "error": f"Dataset changed meanwhile: {', '.join(gone)}"}
            # Annotation files tied to a merged dataset belong to the merge now.
            annotation_state = getattr(state, "annotation_state", None)
            for ann_file in (getattr(annotation_state, "files", None) or {}).values():
                ids = getattr(ann_file, "dataset_ids", None)
                if ids and any(dataset_id in ids for dataset_id in removed_ids):
                    ann_file.dataset_ids = [i for i in ids if i not in removed_ids]
                    if merged_dataset.id not in ann_file.dataset_ids:
                        ann_file.dataset_ids.append(merged_dataset.id)
            for dataset_id in removed_ids:
                _remove_if(state, dataset_id, sources[dataset_id])
        return {
            "success": True,
            "dataset": merged_dataset.to_dict(),
            "removed_ids": removed_ids,
        }
    except Exception as exc:
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(exc)}


def _remove_if(state, dataset_id, dataset) -> bool:
    """Remove ``dataset_id`` only while it is this dataset object."""
    remove_if = getattr(state, "remove_dataset_if", None)
    if remove_if is not None:
        return remove_if(dataset_id, dataset)
    if (getattr(state, "datasets", {}) or {}).get(dataset_id) is dataset:   # minimal states (tests)
        state.remove_dataset(dataset_id)
        return True
    return False


def _remove_created(state, created) -> None:
    """Undo the dataset objects this operation registered (a merge/unmerge that failed part-way): each only
    while its id still holds that object, never another request's dataset loaded under the same id."""
    for dataset in created:
        try:
            _remove_if(state, dataset.id, dataset)
        except Exception:
            pass


def unmerge_dataset_for_request(state, req: UnmergeDatasetsRequest) -> dict:
    """Split a multi-file dataset back into individual single-file datasets."""
    try:
        dataset_id = resolve_dataset_id(state, req.dataset_id)
        dataset = state.get_dataset(dataset_id) if dataset_id else None
        if dataset is None:
            return {"success": False, "error": f"Dataset not found: {req.dataset_id}"}
        source = dataset          # identity re-checked at commit
        if len(dataset.paths) < 2:
            return {"success": False, "error": "Dataset has only one file, nothing to unmerge"}

        # Only split the PRIMARY read sources (footprints). Companion overlay
        # files (tf/msp/m5c/...) live in dataset.paths too, but each re-created
        # single-file dataset auto-detects its own companions from the directory,
        # so splitting every path would produce 4x the datasets (one per overlay).
        companion_paths = {
            p
            for values in (getattr(dataset, "companion_layers", None) or {}).values()
            for p in ([values] if isinstance(values, str) else values)
        }
        primary_paths = [p for p in dataset.paths if p not in companion_paths] or list(dataset.paths)
        removed_id = dataset_id

        # Create the single-file datasets first; the combined one goes only
        # once they all exist, so a file that fails to open loses nothing.
        new_datasets = []
        created: list = []
        try:
            for path in primary_paths:
                base_name = _strip_dataset_extension(os.path.basename(path))
                new_id = base_name.replace(" ", "_").replace(".", "_")
                new_dataset = state.add_dataset(new_id, path)
                created.append(new_dataset)
                new_datasets.append(new_dataset.to_dict())
        except Exception:
            _remove_created(state, created)
            raise
        from services.genome_loading import state_lock
        with state_lock(state):
            if state.datasets.get(removed_id) is not source:
                _remove_created(state, created)
                return {"success": False, "error": f"Dataset changed meanwhile: {req.dataset_id}"}
            _remove_if(state, removed_id, source)

        return {
            "success": True,
            "datasets": new_datasets,
            "removed_id": removed_id,
        }
    except Exception as exc:
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(exc)}


def unique_upload_path(upload_dir: str, filename: str) -> str:
    file_path = os.path.join(upload_dir, filename)
    base, extension = os.path.splitext(filename)
    counter = 1
    while os.path.exists(file_path):
        file_path = os.path.join(upload_dir, f"{base}_{counter}{extension}")
        counter += 1
    return file_path


def upload_general_file_for_request(file, upload_dir: str) -> dict:
    """Save a dragged/uploaded helper file and return its server-side path."""
    from services.upload_store import safe_upload_name, save_upload

    filename = safe_upload_name(file.filename)
    if filename.lower().endswith((".bai", ".csi")):
        # A browser drop cannot prove which BAM an index belongs to (same-named
        # files, concurrent drops), so uploaded indexes are not kept; each
        # stored BAM is indexed from its own bytes when it is loaded.
        return {"success": True, "path": None, "filename": filename, "is_index": True}

    file_path = save_upload(file.file, upload_dir, filename)
    return {"success": True, "path": file_path, "filename": filename}


def build_drop_window_script(port: int) -> str:
    """Build the standalone Tk drag/drop launcher script."""
    return f'''
import sys
import os
import urllib.request
import json

SERVER_URL = "http://localhost:{port}"
# The server's access token (services/local_auth.py), passed in the environment.
AUTH = {{"X-FiberBrowser-Token": os.environ["FIBERBROWSER_TOKEN"]}} if os.environ.get("FIBERBROWSER_TOKEN") else {{}}

# Try to import tkinterdnd2, fall back to regular tkinter with file dialog
try:
    import tkinter as tk
    from tkinterdnd2 import DND_FILES, TkinterDnD
    HAS_DND = True
except ImportError:
    import tkinter as tk
    HAS_DND = False

from tkinter import filedialog

def add_files_to_server(paths):
    """Send file paths to the server."""
    added = 0
    errors = []
    for path in paths:
        try:
            data = json.dumps({{"path": path}}).encode('utf-8')
            req = urllib.request.Request(
                SERVER_URL + "/api/datasets/add",
                data=data,
                headers={{"Content-Type": "application/json", **AUTH}}
            )
            resp = urllib.request.urlopen(req, timeout=30)
            result = json.loads(resp.read().decode('utf-8'))

            if result.get('success'):
                added += 1
            else:
                errors.append(result.get('error', 'Unknown error'))
        except Exception as e:
            errors.append(str(e))

    # Trigger browser refresh
    if added > 0:
        try:
            urllib.request.urlopen(urllib.request.Request(SERVER_URL + "/api/jupyter/refresh", headers=AUTH), timeout=5)
        except Exception:
            pass

    return added, errors

class DropWindow:
    def __init__(self):
        if HAS_DND:
            self.root = TkinterDnD.Tk()
        else:
            self.root = tk.Tk()

        self.root.title("Add Dataset Files")
        self.root.geometry("380x250")
        self.root.attributes('-topmost', True)
        self.root.configure(bg='#e0e7ff')

        title = tk.Label(
            self.root,
            text="\\U0001F4C1 Add Dataset Files",
            font=('Arial', 16, 'bold'),
            bg='#e0e7ff',
            fg='#4338ca'
        )
        title.pack(pady=(15, 5))

        if HAS_DND:
            instr_text = "Drag files here or click Browse"
        else:
            instr_text = "Click Browse to select files\\n(install tkinterdnd2 for drag-drop)"

        self.instr = tk.Label(
            self.root,
            text=instr_text,
            font=('Arial', 10),
            bg='#e0e7ff',
            fg='#666'
        )
        self.instr.pack(pady=(0, 15))

        self.browse_btn = tk.Button(
            self.root,
            text="\\U0001F4C2  Browse Files...",
            font=('Arial', 12),
            command=self.browse_files,
            bg='#4338ca',
            fg='white',
            activebackground='#3730a3',
            activeforeground='white',
            padx=20,
            pady=8,
            cursor='hand2'
        )
        self.browse_btn.pack(pady=10)

        self.status = tk.Label(
            self.root,
            text="Accepts: .bam, .bb, .bigbed files",
            font=('Arial', 9),
            fg='gray',
            bg='#e0e7ff'
        )
        self.status.pack(pady=(15, 5))

        if HAS_DND:
            self.root.drop_target_register(DND_FILES)
            self.root.dnd_bind('<<Drop>>', self.on_drop)
            self.root.dnd_bind('<<DragEnter>>', self.on_drag_enter)
            self.root.dnd_bind('<<DragLeave>>', self.on_drag_leave)

    def browse_files(self):
        """Open native file browser."""
        filetypes = [
            ('BAM files', '*.bam'),
            ('BigBed files', '*.bb *.bigbed'),
            ('All supported', '*.bam *.bb *.bigbed'),
        ]

        paths = filedialog.askopenfilenames(
            title='Select BAM or BigBed files',
            filetypes=filetypes,
        )

        if paths:
            self.status.config(text=f"Adding {{len(paths)}} file(s)...", fg='blue')
            self.root.update()

            added, errors = add_files_to_server(paths)

            if added > 0:
                self.status.config(text=f"Added {{added}} file(s) ✓", fg='green')
            elif errors:
                self.status.config(text=f"Error: {{errors[0][:50]}}", fg='red')

    def on_drag_enter(self, event):
        self.root.configure(bg='#c7d2fe')
        self.instr.configure(bg='#c7d2fe', text='Release to add files', fg='#4338ca')
        self.status.configure(bg='#c7d2fe')
        return event.action

    def on_drag_leave(self, event):
        self.root.configure(bg='#e0e7ff')
        self.instr.configure(bg='#e0e7ff', text='Drag files here or click Browse', fg='#666')
        self.status.configure(bg='#e0e7ff')

    def on_drop(self, event):
        self.root.configure(bg='#e0e7ff')
        self.instr.configure(bg='#e0e7ff', text='Drag files here or click Browse', fg='#666')
        self.status.configure(bg='#e0e7ff')

        data = event.data

        if '{{' in data:
            import re
            files = re.findall(r'\\{{([^}}]+)\\}}', data)
            remaining = re.sub(r'\\{{[^}}]+\\}}', '', data)
            files.extend([f for f in remaining.split() if f])
        else:
            try:
                files = self.root.tk.splitlist(data)
            except Exception:
                files = data.split()

        files = [f.strip() for f in files if f.strip()]
        valid_files = [f for f in files if f.lower().endswith(('.bam', '.bb', '.bigbed'))]

        if not valid_files:
            self.status.config(text="No valid BAM/BigBed files found", fg='red')
            return

        self.status.config(text=f"Adding {{len(valid_files)}} file(s)...", fg='blue')
        self.root.update()

        added, errors = add_files_to_server(valid_files)

        if added > 0:
            self.status.config(text=f"Added {{added}} file(s) ✓", fg='green')
        elif errors:
            self.status.config(text=f"Error: {{errors[0][:50]}}", fg='red')

    def run(self):
        self.root.mainloop()

if __name__ == "__main__":
    app = DropWindow()
    app.run()
'''


def launch_drop_window_for_state(state) -> dict:
    """Launch the native drag/drop helper window in a detached subprocess."""
    port = getattr(state, "port", 5000)

    def run_drop_window():
        script = build_drop_window_script(port)
        with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False) as handle:
            handle.write(script)
            script_path = handle.name

        try:
            from services.local_auth import auth_enabled, get_token
            env = dict(os.environ)
            if auth_enabled():
                env["FIBERBROWSER_TOKEN"] = get_token()
            subprocess.Popen([sys.executable, script_path], start_new_session=True, env=env)
        except Exception as exc:
            print(f"Failed to launch drop window: {exc}")

    thread = threading.Thread(target=run_drop_window, daemon=True)
    thread.start()

    return {"success": True, "message": "Drop window launched"}
