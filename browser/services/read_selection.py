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


def read_id_keys(read):
    """Display identity and cohort identity; never infer molecule sharing from QNAME."""
    if isinstance(read, Mapping):
        keys = {str(v) for v in (read.get("id"), read.get("analysis_id")) if v is not None}
        # Its record key (DESIGN_GRAPH_PRIMARY §3.1): an id set written in another view (a graph row's record)
        # names the record, never the row index or placement.
        if read.get("analysis_id") is not None:
            from services.lift.cohort import record_key
            rk = record_key(read["analysis_id"])
            if rk:
                keys.add(rk)
        # A display row folded from several records (supplementary_display='fold')
        # answers to each member's cohort identity.
        folded = (read.get("live_lift") or {}).get("folded") if isinstance(read.get("live_lift"), Mapping) else None
        if folded:
            from services.lift.cohort import record_key
            for v in folded.get("analysis_ids") or ():
                if v is not None:
                    keys.add(str(v))
                    rk = record_key(v)
                    if rk:
                        keys.add(rk)
        return keys
    from services.lift.cohort import record_key
    rk = record_key(read) if read is not None else None
    return {str(read), rk} if rk and rk != str(read) else {str(read)}


def _graph_identity_record_key(value):
    """The record key of a graph row's cohort identity (its placement is "primary", which linear rows never carry:
    they name their chain), else None. A graph row stands for its record in every view (DESIGN_GRAPH_PRIMARY §3.1)."""
    if not isinstance(value, str) or not value.startswith("lift-cohort:v1 ") or '"primary"]' not in value[-12:]:
        return None
    from services.lift.cohort import record_key
    return record_key(value)


def with_graph_record_keys(ids):
    """A requested id set that also names the records of graph rows' identities (graph features): a graph band's
    shown reads (Read Stats, a sort's preview scope) are graph identities, which match linear and analysis rows of
    the same record by record key. Linear identities stay exact (split rows of one record stay apart)."""
    if ids is None:
        return None
    out = set(ids)
    for value in list(out):
        rk = _graph_identity_record_key(value)
        if rk:
            out.add(rk)
    return out


def cohort_read_id(read):
    return read.get("analysis_id") or read.get("id", "")


def read_matches_id_filter(read_id, filter_ids: set[str]) -> bool:
    """Match either exact read IDs or base IDs with numeric segment suffixes."""
    return any(key in filter_ids or base_read_id(key) in filter_ids for key in read_id_keys(read_id))


def filter_reads_by_id_set(reads: Sequence[Mapping[str, Any]], filter_ids: set[str]) -> list[dict]:
    return [
        dict(read)
        for read in reads
        if read_matches_id_filter(read, filter_ids)
    ]


def is_read_spanning(read: Mapping[str, Any], region_width: int) -> bool:
    if read.get("live_lift"):
        from services.lift.reads import body_spans_view
        return body_spans_view(read["live_lift"], 0, region_width)
    intervals = read.get("intervals") or []
    return bool(intervals and intervals[0][0] <= 0 and intervals[-1][1] >= region_width)


def count_footprints(read: Mapping[str, Any]) -> int:
    ll = read.get("live_lift")
    if not ll:
        return sum(1 for interval in read.get("intervals", []) if interval[2] > 0)
    calls = ll.get("calls", {}).get("intervals", [])
    return len({(ll.get("record"), calls[i] if i < len(calls) and calls[i] is not None else ("interval", i))
                for i, iv in enumerate(read.get("intervals", [])) if iv[2] > 0})


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
        if cluster_assignments.get(cohort_read_id(read)) in focus_clusters
    ]


def read_body_spans(read):
    """Continuous target body; connectors and off-target payloads are holes."""
    ll = read.get("live_lift")
    if ll:
        from services.lift.reads import _body_spans, _merge
        return _merge(_body_spans(ll))
    intervals = read.get("intervals") or []
    return [[intervals[0][0], intervals[-1][1]]] if intervals else []


def body_overlap(read, start, end):
    return sum(max(0, min(end, b) - max(start, a)) for a, b in read_body_spans(read))
