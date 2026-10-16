"""Helpers for CLI-loaded datasets during server startup."""
from __future__ import annotations

import os
from collections.abc import Iterable

from services.dataset_registration import dataset_id_from_source


def resolve_primary_data_source(bam: str | None, bigbed_dir: str | None):
    """Resolve the legacy --bam/--bigbed_dir primary source."""
    if bam and ',' in bam:
        return [path.strip() for path in bam.split(',')]
    return bam or bigbed_dir


def parse_dataset_spec(ds_spec: str) -> tuple[str, str | None]:
    """Parse the PATH[:LABEL] startup dataset syntax.

    Absolute paths, Windows drive letters (C:\\...) and URLs (https://,
    host:port) all contain ':'; a trailing ':LABEL' is split off only when
    the whole spec isn't an existing path and the text after the last ':'
    isn't part of a path (no '/' or '\\').
    """
    if ':' in ds_spec and not os.path.exists(ds_spec):
        path, label = ds_spec.rsplit(':', 1)
        # An existing file before the last ':' takes any label (even with '/').
        if path and label and (os.path.exists(path) or ('/' not in label and '\\' not in label)):
            return path, label
    return ds_spec, None


def default_dataset_label(path: str) -> str:
    label = os.path.basename(path.rstrip('/'))
    if label.endswith(('.bam', '.bb', '.bigbed', '.bigBed')):
        label = label.rsplit('.', 1)[0]
    return label


def split_remote_primary(data_source):
    """``(local_source, [url])``: a single remote ``--bam`` (https://, s3://) is
    opened like a ``--dataset`` (it was silently ignored: the primary source
    must be a file or folder on this computer)."""
    from utils.validation import is_url
    if isinstance(data_source, str) and is_url(data_source):
        return None, [data_source]
    return data_source, []


def add_cli_datasets(state, dataset_specs: Iterable[str] | None) -> None:
    """Add repeated --dataset arguments to an initialized BrowserState.

    Remote files (https://, s3://) are checked first, as Load Remote URL
    checks them: one that can't be read is reported instead of opening as a
    dataset with no reads."""
    if not dataset_specs:
        return
    from utils.validation import is_url
    for i, ds_spec in enumerate(dataset_specs):
        path, label = parse_dataset_spec(ds_spec)
        dataset_id = dataset_id_from_source(path, f"dataset_{i + 1}")
        label = label or default_dataset_label(path)

        if is_url(path):
            from services.dataset_endpoint import validate_dataset_paths
            try:
                problems = validate_dataset_paths([path])
            except Exception as exc:  # e.g. the connection dropped mid-download
                problems = [f"{type(exc).__name__}: {exc}"]
            if problems:
                print(f"  Warning: Failed to add dataset {path}: {'; '.join(problems)}")
                continue
        try:
            state.add_dataset(dataset_id, path, label)
            print(f"  Added dataset: {label} ({path})")
        except Exception as exc:
            print(f"  Warning: Failed to add dataset {path}: {exc}")
