"""Text export helpers for orthogonal track signal data."""
from __future__ import annotations

from collections.abc import Sequence
from typing import Any


def clamp_export_bins(bins: int, region_width: int | None = None) -> int:
    """Bins to export: at most 100k, and at most one per base of the region
    (more bins than bases would repeat 1-bp rows and run past the end)."""
    limit = 100_000 if region_width is None else max(1, min(100_000, int(region_width)))
    return max(1, min(int(bins), limit))


def safe_track_value(values: Sequence[Any], index: int) -> Any:
    value = values[index] if index < len(values) and values[index] is not None else 0
    try:
        if value != value:
            return 0
    except Exception:
        return 0
    return value


def sanitize_track_label(label: Any, fallback: str) -> str:
    return str(label or fallback).replace(" ", "_")


def track_export_rows(chrom: str, start: int, end: int, bins: int,
                      values: Sequence[Any]) -> list[str]:
    bin_size = (end - start) / bins
    rows = []
    for i in range(bins):
        bin_start = int(round(start + i * bin_size))
        bin_end = int(round(start + (i + 1) * bin_size))
        if bin_end <= bin_start:
            bin_end = bin_start + 1
        rows.append(f"{chrom}\t{bin_start}\t{bin_end}\t{safe_track_value(values, i)}")
    return rows


def build_single_track_export(
    chrom: str,
    start: int,
    end: int,
    bins: int,
    values: Sequence[Any],
    label: Any,
    description: Any,
    format: str = "bedgraph",
    fallback_label: str = "track",
) -> dict[str, str]:
    fmt = (format or "bedgraph").lower()
    clean_label = sanitize_track_label(label, fallback_label)
    if fmt == "tsv":
        rows = [f"chrom\tstart\tend\t{clean_label}"]
        media_type = "text/tab-separated-values"
        suffix = "tsv"
    else:
        rows = [f'track type=bedGraph name="{clean_label}" description="{description or clean_label}"']
        media_type = "text/plain"
        suffix = "bedGraph"

    rows.extend(track_export_rows(chrom, start, end, bins, values))
    return {
        "content": "\n".join(rows) + "\n",
        "media_type": media_type,
        "filename": f"{clean_label}_{chrom}_{start}_{end}.{suffix}",
    }


def build_multi_track_export(
    chrom: str,
    start: int,
    end: int,
    bins: int,
    labels: Sequence[Any],
    columns: Sequence[Sequence[Any]],
) -> dict[str, str]:
    clean_labels = [sanitize_track_label(label, f"track_{i}") for i, label in enumerate(labels)]
    bin_size = (end - start) / bins
    rows = ["chrom\tstart\tend\t" + "\t".join(clean_labels)]
    for j in range(bins):
        bin_start = int(round(start + j * bin_size))
        bin_end = int(round(start + (j + 1) * bin_size))
        if bin_end <= bin_start:
            bin_end = bin_start + 1
        cells = [str(safe_track_value(col, j)) for col in columns]
        rows.append(f"{chrom}\t{bin_start}\t{bin_end}\t" + "\t".join(cells))
    return {
        "content": "\n".join(rows) + "\n",
        "media_type": "text/tab-separated-values",
        "filename": f"tracks_{chrom}_{start}_{end}.tsv",
    }
