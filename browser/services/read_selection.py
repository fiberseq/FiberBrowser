"""Shared read selection helpers for display and analysis request scopes."""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any


def base_read_id(read_id: str) -> str:
    """Strip numeric segment suffixes used by split/linked read views."""
    head, sep, tail = read_id.rpartition("_")
    if sep and tail.isdigit():
        return head
    return read_id


def read_matches_id_filter(read_id: str, filter_ids: set[str]) -> bool:
    """Match either exact read IDs or base IDs with numeric segment suffixes."""
    return read_id in filter_ids or base_read_id(read_id) in filter_ids


def filter_reads_by_id_set(reads: Sequence[Mapping[str, Any]], filter_ids: set[str]) -> list[dict]:
    return [
        dict(read)
        for read in reads
        if read_matches_id_filter(str(read.get("id", "")), filter_ids)
    ]


def is_read_spanning(read: Mapping[str, Any], region_width: int) -> bool:
    intervals = read.get("intervals") or []
    return bool(intervals and intervals[0][0] <= 0 and intervals[-1][1] >= region_width)


def count_footprints(read: Mapping[str, Any]) -> int:
    return sum(1 for interval in read.get("intervals", []) if interval[2] > 0)


def filter_reads_by_min_footprints(
    reads: Sequence[Mapping[str, Any]],
    min_footprints: int,
    *,
    has_footprint_layer: bool,
) -> list[dict]:
    if min_footprints <= 0 or not has_footprint_layer:
        return [dict(read) for read in reads]
    return [
        dict(read)
        for read in reads
        if count_footprints(read) >= min_footprints
    ]


def filter_reads_by_cluster_focus(
    reads: Sequence[Mapping[str, Any]],
    cluster_assignments: Mapping[str, int],
    focus_clusters: set[int] | None,
) -> list[dict]:
    if not focus_clusters:
        return [dict(read) for read in reads]
    return [
        dict(read)
        for read in reads
        if cluster_assignments.get(str(read.get("id", ""))) in focus_clusters
    ]
