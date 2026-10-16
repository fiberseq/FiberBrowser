"""Annotation BigBed detection, loading, and read-join helpers."""
from __future__ import annotations

from services.bigbed_bounds import bigbed_entries_in_bounds
import json
import os

from services.diagnostics import env_flag_enabled, log_if_enabled
from utils.chrom import get_chrom_variants

ANNOTATION_DIAGNOSTICS_ENV = "FIBERBROWSER_ANNOTATION_DIAGNOSTICS"


def annotation_diagnostics_enabled() -> bool:
    return env_flag_enabled(ANNOTATION_DIAGNOSTICS_ENV)


def log_annotation_diagnostic(message: str) -> None:
    log_if_enabled(ANNOTATION_DIAGNOSTICS_ENV, message)


def get_bigbed_handle(path: str):
    from services.bigbed_handles import get_bigbed_handle as _get_bigbed_handle

    return _get_bigbed_handle(path)


def _get_bigbed_handle(path: str):
    return get_bigbed_handle(path)


def _manifest_candidates(annotation_path: str) -> list[str]:
    directory = os.path.dirname(annotation_path)
    stem = os.path.splitext(os.path.basename(annotation_path))[0]

    candidates = [os.path.join(directory, f"{stem}_manifest.json")]
    for suffix in (".annotations", ".ann"):
        if stem.endswith(suffix):
            base_stem = stem[: -len(suffix)]
            candidates.append(os.path.join(directory, f"{base_stem}_manifest.json"))
            break
    candidates.append(os.path.join(directory, "manifest.json"))
    return candidates


def load_annotation_manifest(annotation_path: str):
    """Load a manifest JSON for an annotation BigBed file when present."""
    from services.lab.paths import readable
    for path in _manifest_candidates(annotation_path):
        if os.path.isfile(path) and readable(path):  # a lab server's data roots
            try:
                with open(path) as f:
                    return json.load(f)
            except Exception:
                pass
    return None


def is_annotation_bigbed(path: str) -> bool:
    """Return True when a BigBed appears to be BED6+2 annotation data."""
    basename = os.path.basename(path).lower()

    if basename.endswith(".annotations.bb") or basename.endswith(".ann.bb"):
        return True
    stem = basename.rsplit(".", 1)[0] if "." in basename else basename
    if stem.endswith(".annotations") or stem.endswith(".ann"):
        return True

    manifest = load_annotation_manifest(path)
    if manifest and ("types" in manifest or "source" in manifest):
        return True

    try:
        bb = _get_bigbed_handle(path)
        if bb is None:
            return False
        chroms = bb.chroms()
        if not chroms:
            return False
        for chrom_name, chrom_size in chroms.items():
            entries = bb.entries(chrom_name, 0, min(chrom_size, 100000))
            if entries:
                _, _, rest = entries[0]
                fields = rest.split("\t")
                if len(fields) == 5:
                    try:
                        float(fields[4])
                        return True
                    except ValueError:
                        pass
                break
    except Exception:
        pass

    return False


def find_annotation_bigbed_files(primary_path: str) -> list[str]:
    """Scan the primary path directory for annotation BigBed files."""
    if not primary_path or not os.path.exists(primary_path):
        return []

    directory = os.path.dirname(primary_path) if os.path.isfile(primary_path) else primary_path
    if not os.path.isdir(directory):
        return []

    results = []
    for fname in os.listdir(directory):
        if not fname.endswith((".bb", ".bigbed", ".bigBed")):
            continue
        full_path = os.path.join(directory, fname)
        if full_path == primary_path:
            continue
        if is_annotation_bigbed(full_path):
            results.append(full_path)
    return results


def load_annotations_from_bigbed(
    path,
    chrom,
    start,
    end,
    confidence_thresholds=None,
    read_names=None,
    max_entries=500000,
):
    """Load BED6+2 annotations keyed by read name from a BigBed file."""
    bb = _get_bigbed_handle(path)
    if bb is None:
        log_annotation_diagnostic(f"  [ann-load] BigBed handle is None for {path}")
        return {}, set()

    available_chroms = bb.chroms()
    matching_chrom = None
    for variant in get_chrom_variants(chrom):
        if variant in available_chroms:
            matching_chrom = variant
            break

    if matching_chrom is None:
        log_annotation_diagnostic(f"  [ann-load] No matching chrom for '{chrom}' in {os.path.basename(path)}, available={list(available_chroms.keys())[:6]}")
        return {}, set()

    try:
        entries = bigbed_entries_in_bounds(bb, matching_chrom, start, end)
    except Exception as exc:
        log_annotation_diagnostic(f"  [ann-load] entries() failed for {matching_chrom}:{start}-{end}: {exc}")
        return {}, set()

    if not entries:
        log_annotation_diagnostic(f"  [ann-load] No entries in {matching_chrom}:{start}-{end} ({os.path.basename(path)})")
        return {}, set()

    log_annotation_diagnostic(f"  [ann-load] {len(entries)} entries in {matching_chrom}:{start}-{end}, filtering by {len(read_names) if read_names else 'ALL'} read names")

    annotations = {}
    discovered_types = set()
    matched = 0
    scanned = 0
    max_scan = 5_000_000

    for entry_start, entry_end, rest in entries:
        scanned += 1
        if scanned > max_scan:
            break

        fields = rest.split("\t")
        if len(fields) < 5:
            continue

        read_name = fields[0]
        if read_names is not None and read_name not in read_names:
            continue

        ann_type = fields[3]
        try:
            confidence = float(fields[4])
        except ValueError:
            confidence = 1.0

        if confidence_thresholds and ann_type in confidence_thresholds:
            if confidence < confidence_thresholds[ann_type]:
                continue

        discovered_types.add(ann_type)
        annotations.setdefault(read_name, []).append((entry_start, entry_end, ann_type, confidence))

        matched += 1
        if matched >= max_entries:
            break

    return annotations, discovered_types


def discover_annotation_types(path, sample_size=1000):
    """Read a sample of annotation entries and count annotation types."""
    bb = _get_bigbed_handle(path)
    if bb is None:
        return {}

    types_count = {}
    total = 0
    try:
        chroms = bb.chroms()
        for chrom_name, chrom_size in chroms.items():
            if total >= sample_size:
                break
            entries = bb.entries(chrom_name, 0, chrom_size)
            if not entries:
                continue
            for _, _, rest in entries:
                if total >= sample_size:
                    break
                fields = rest.split("\t")
                if len(fields) >= 5:
                    ann_type = fields[3]
                    types_count[ann_type] = types_count.get(ann_type, 0) + 1
                    total += 1
    except Exception:
        pass

    return types_count


def join_annotations_to_reads(compact_reads, annotation_dict, region_start):
    """Join absolute annotation intervals to compact reads by read name."""
    result = {}

    for read in compact_reads:
        read_id = read["id"] if isinstance(read, dict) else read.id
        anns = annotation_dict.get(read_id)

        if anns is None and "_" in read_id:
            base_name = read_id.rsplit("_", 1)[0]
            anns = annotation_dict.get(base_name)

        if anns:
            result[read_id] = [
                {
                    "start": ann[0] - region_start,
                    "end": ann[1] - region_start,
                    "type": ann[2],
                    "confidence": ann[3],
                }
                for ann in anns
            ]

    return result
