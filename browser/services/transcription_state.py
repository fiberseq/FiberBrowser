"""Pure transcription-state evaluation helpers.

The FastAPI layer passes compact reads and gene dictionaries in; this module
does not touch backend globals, caches, file handles, or request state.
"""
from __future__ import annotations

import statistics
from typing import Any, List


def resolve_tf_source(read: dict[str, Any] | list) -> List:
    """Return intervals to use as TF-sized footprints for a read."""
    if isinstance(read, list):
        return read
    layers = read.get("layers") or {}
    tf_layer = layers.get("tf")
    # A present layer is authoritative, even when a quality gate emptied it.
    if tf_layer is not None:
        return tf_layer.get("intervals") or []
    return read.get("intervals") or []


def resolve_nuc_source(read: dict[str, Any] | list) -> List:
    """Return intervals to use as nucleosomes for a read."""
    if isinstance(read, list):
        return read
    layers = read.get("layers") or {}
    nuc_layer = layers.get("nuc")
    if nuc_layer is not None:
        return nuc_layer.get("intervals") or []
    return read.get("intervals") or []


def get_footprints_in_region(
    read_intervals: List,
    tss: int,
    offset_start: int,
    offset_end: int,
    strand: str,
    region_start: int,
) -> List[int]:
    """Get footprint sizes within a strand-aware region relative to TSS."""
    if strand == "+":
        region_from = tss + offset_start
        region_to = tss + offset_end
    else:
        region_from = tss - offset_end
        region_to = tss - offset_start

    if region_from > region_to:
        region_from, region_to = region_to, region_from

    footprint_sizes = []
    for interval in read_intervals:
        int_start, int_end, size = interval[0], interval[1], interval[2]
        if size <= 0:
            continue
        abs_start = region_start + int_start
        abs_end = region_start + int_end
        if abs_end > region_from and abs_start < region_to:
            footprint_sizes.append(size)

    return footprint_sizes


def get_footprints_in_gene_body(
    read_intervals: List,
    tss: int,
    tes: int,
    strand: str,
    region_start: int,
) -> List[int]:
    """Get footprint sizes within the gene body."""
    _ = strand
    gene_from = min(tss, tes)
    gene_to = max(tss, tes)

    footprint_sizes = []
    for interval in read_intervals:
        int_start, int_end, size = interval[0], interval[1], interval[2]
        if size <= 0:
            continue
        abs_start = region_start + int_start
        abs_end = region_start + int_end
        if abs_end > gene_from and abs_start < gene_to:
            footprint_sizes.append(size)

    return footprint_sizes


def calc_nucleosome_coverage(read_intervals: List, gene_start: int, gene_end: int, region_start: int) -> float:
    """Calculate fraction of the gene body covered by nucleosomes."""
    gene_from = min(gene_start, gene_end)
    gene_to = max(gene_start, gene_end)
    gene_length = gene_to - gene_from

    if gene_length <= 0:
        return 0.0

    nuc_coverage = 0
    for interval in read_intervals:
        int_start, int_end, size = interval[0], interval[1], interval[2]
        if size < 90:
            continue
        abs_start = region_start + int_start
        abs_end = region_start + int_end
        overlap_start = max(abs_start, gene_from)
        overlap_end = min(abs_end, gene_to)
        if overlap_end > overlap_start:
            nuc_coverage += overlap_end - overlap_start

    return nuc_coverage / gene_length


def evaluate_read_states(read, gene: dict, region_start: int) -> dict:
    """Evaluate transcription-state criteria for one read against one gene."""
    tf_intervals = resolve_tf_source(read)

    strand = gene["strand"]
    if strand == "+":
        tss = gene["start"]
        tes = gene["end"]
    else:
        tss = gene["end"] - 1  # the TSS base; ends are exclusive
        tes = gene["start"]

    results = {
        "pause": False,
        "pic": False,
        "elongating_count": 0,
    }

    pause_fps = get_footprints_in_region(tf_intervals, tss, 10, 50, strand, region_start)
    if pause_fps:
        results["pause"] = 35 <= statistics.median(pause_fps) <= 65

    pic_fps = get_footprints_in_region(tf_intervals, tss, -50, 25, strand, region_start)
    if pic_fps:
        median = statistics.median(pic_fps)
        results["pic"] = (20 <= median <= 40) or (60 <= median <= 80)

    body_fps = get_footprints_in_gene_body(tf_intervals, tss, tes, strand, region_start)
    results["elongating_count"] = sum(1 for fp in body_fps if 35 <= fp <= 65)

    return results


def has_active_transcription_filters(filters: dict | None) -> bool:
    # Unknown keys (e.g. the removed legacy "hyperburst" flag from old
    # sessions) are ignored.
    filters = filters or {}
    return bool(
        filters.get("pause", False)
        or filters.get("pic", False)
        or filters.get("elongating") is not None
    )


def read_overlaps_gene(read: dict[str, Any], gene: dict[str, Any], region_start: int) -> bool:
    intervals = read.get("intervals") or []
    if not intervals:
        return False

    gene_from = min(gene["start"], gene["end"])
    gene_to = max(gene["start"], gene["end"])
    read_min = region_start + min(interval[0] for interval in intervals)
    read_max = region_start + max(interval[1] for interval in intervals)

    return read_max >= gene_from and read_min <= gene_to


def merge_read_states(current: dict[str, Any] | None, incoming: dict[str, Any]) -> dict[str, Any]:
    if current is None:
        return dict(incoming)
    return {
        "pause": current["pause"] or incoming["pause"],
        "pic": current["pic"] or incoming["pic"],
        "elongating_count": max(current["elongating_count"], incoming["elongating_count"]),
    }


def read_passes_transcription_filters(read_states: dict[str, Any], filters: dict | None) -> bool:
    filters = filters or {}
    passes = False

    if filters.get("pause", False) and read_states["pause"]:
        passes = True
    if filters.get("pic", False) and read_states["pic"]:
        passes = True

    want_elongating = filters.get("elongating")
    want_elongating_max = filters.get("elongating_max")
    if want_elongating is not None:
        elongating_count = read_states["elongating_count"]
        if (
            elongating_count >= want_elongating
            and (want_elongating_max is None or elongating_count <= want_elongating_max)
        ):
            passes = True

    return passes


def filter_reads_by_transcription_state(
    reads: list[dict[str, Any]],
    genes: list[dict[str, Any]],
    filters: dict | None,
    region_start: int,
    *,
    evaluator=evaluate_read_states,
) -> dict[str, Any]:
    """Aggregate read states across genes and return filtered IDs + summary."""
    if not reads:
        return {
            "filtered_ids": [],
            "read_states": {},
            "summary": {
                "total": 0, "overlapping_genes": 0, "pause": 0, "pic": 0,
                "elongating_gte_1": 0, "elongating_gte_3": 0, "elongating_gte_5": 0,
                "elongating_dist": {"1": 0, "2": 0, "3": 0, "4+": 0},
                "total_matching": 0,
            },
        }

    filtered_ids: list[str] = []
    read_states: dict[str, dict[str, Any]] = {}

    pause_count = 0
    pic_count = 0
    elongating_counts = {1: 0, 3: 0, 5: 0}
    elongating_dist = {1: 0, 2: 0, 3: 0}

    for read in reads:
        read_id = read["id"]
        if not read.get("intervals"):
            continue

        best_states = None
        for gene in genes:
            if not read_overlaps_gene(read, gene, region_start):
                continue
            best_states = merge_read_states(
                best_states,
                evaluator(read, gene, region_start),
            )

        if best_states is None:
            continue

        read_states[read_id] = best_states

        if best_states["pause"]:
            pause_count += 1
        if best_states["pic"]:
            pic_count += 1

        elongating_count = best_states["elongating_count"]
        if elongating_count >= 1:
            elongating_counts[1] += 1
        if elongating_count >= 3:
            elongating_counts[3] += 1
        if elongating_count >= 5:
            elongating_counts[5] += 1
        if elongating_count in (1, 2, 3):
            elongating_dist[elongating_count] += 1

        if read_passes_transcription_filters(best_states, filters):
            filtered_ids.append(read_id)

    return {
        "filtered_ids": filtered_ids,
        "read_states": read_states,
        "summary": {
            "total": len(reads),
            "overlapping_genes": len(read_states),
            "pause": pause_count,
            "pic": pic_count,
            "elongating_gte_1": elongating_counts[1],
            "elongating_gte_3": elongating_counts[3],
            "elongating_gte_5": elongating_counts[5],
            "elongating_dist": {
                "1": elongating_dist[1],
                "2": elongating_dist[2],
                "3": elongating_dist[3],
                "4+": (
                    elongating_counts[1]
                    - elongating_dist[1]
                    - elongating_dist[2]
                    - elongating_dist[3]
                ),
            },
            "total_matching": len(filtered_ids),
        },
    }
