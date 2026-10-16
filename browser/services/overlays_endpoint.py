"""Modification overlay endpoint helpers."""
from __future__ import annotations

from services.bigbed_bounds import bigbed_entries_in_bounds
import os

import pyBigWig

from services.bigbed_detection import OVERLAY_COLORS, detect_overlay_type, display_layer_type
from services.local_paths import normalize_local_path, path_access_error
from utils.chrom import get_chrom_variants


def get_overlays_payload(state) -> dict:
    overlays = getattr(state, "modification_overlays", {})
    return {
        "overlays": [
            {
                "id": overlay_id,
                "label": info["label"],
                "path": info["path"],
                "type": info["type"],
                "color": info["color"],
            }
            for overlay_id, info in overlays.items()
        ]
    }


def add_overlay_for_request(state, data: dict) -> dict:
    path = data.get("path")
    explicit_type = data.get("type")

    if not path:
        return {"success": False, "error": "No path provided"}

    original_path = path
    path = normalize_local_path(path)

    access_error = path_access_error(path, original_path=original_path, expected="file")
    if access_error:
        return {"success": False, "error": access_error}

    overlay_type = explicit_type or detect_overlay_type(path)
    color = OVERLAY_COLORS.get(overlay_type, OVERLAY_COLORS["unknown"])
    # First free id: counting the overlays reuses a live one after a removal.
    index = len(state.modification_overlays)
    while f"overlay_{index}" in state.modification_overlays:
        index += 1
    overlay_id = f"overlay_{index}"
    label = os.path.basename(path)
    for ext in [".bb", ".bigbed", ".bigBed"]:
        if label.endswith(ext):
            label = label[:-len(ext)]
            break

    type_label = display_layer_type(overlay_type)
    if type_label != "Unknown":
        label = f"{label} ({type_label})"

    state.modification_overlays[overlay_id] = {
        "path": path,
        "type": overlay_type,
        "label": label,
        "color": color,
    }

    return {
        "success": True,
        "overlay": {
            "id": overlay_id,
            "label": label,
            "path": path,
            "type": overlay_type,
            "color": color,
        },
    }


def remove_overlay_for_request(state, overlay_id: str) -> dict:
    overlays = getattr(state, "modification_overlays", {})
    if overlay_id in overlays:
        del overlays[overlay_id]
        return {"success": True}
    return {"success": False, "error": "Overlay not found"}


def _load_overlay_marks_from_bigbed(marks: dict, bb_path: str, chrom_variants: list[str], start: int, end: int) -> None:
    try:
        from services.remote_sources.opening import open_bigwig
        with open_bigwig(bb_path) as bw:
            available_chroms = bw.chroms()
            matching_chrom = None
            for variant in chrom_variants:
                if variant in available_chroms:
                    matching_chrom = variant
                    break

            if matching_chrom is None:
                return

            entries = bigbed_entries_in_bounds(bw, matching_chrom, start, end)
            if not entries:
                return

            for entry_start, _entry_end, rest in entries:
                entry_start = int(entry_start)
                parts = rest.split("\t")
                if len(parts) < 9:
                    continue

                read_id = parts[0]
                block_count = int(parts[6]) if parts[6] else 0
                if block_count == 0:
                    continue

                block_sizes_str = parts[7].rstrip(",")
                block_starts_str = parts[8].rstrip(",")

                try:
                    block_sizes = [int(x) for x in block_sizes_str.split(",") if x]
                    block_starts = [int(x) for x in block_starts_str.split(",") if x]
                except ValueError:
                    continue

                positions = []
                for block_start, block_size in zip(block_starts, block_sizes):
                    abs_start = entry_start + block_start
                    abs_end = abs_start + block_size
                    for pos in range(abs_start, abs_end):
                        if start <= pos < end:
                            positions.append(int(pos - start))

                if positions:
                    marks.setdefault(read_id, []).extend(positions)
    except Exception as exc:
        print(f"Error loading overlay from {bb_path}: {exc}")


def get_overlay_marks_payload(state, overlay_id: str, chrom: str, start: int, end: int) -> dict:
    overlays = getattr(state, "modification_overlays", {})
    if overlay_id not in overlays:
        return {"marks": {}}

    path = overlays[overlay_id]["path"]
    chrom_variants = get_chrom_variants(chrom)
    marks = {}

    if os.path.isdir(path):
        for filename in os.listdir(path):
            if filename.endswith((".bb", ".bigbed", ".bigBed")):
                _load_overlay_marks_from_bigbed(
                    marks,
                    os.path.join(path, filename),
                    chrom_variants,
                    start,
                    end,
                )
    else:
        _load_overlay_marks_from_bigbed(marks, path, chrom_variants, start, end)

    return {"marks": marks}
