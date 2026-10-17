"""Which strand a DAF-seq read comes from (CT or GA), from its deamination marks.

Each DAF read is one strand of one molecule: deamination shows as C->T on
one strand and G->A on the other (deam events carry type 1 = C->T / Y and
0 = G->A / R). A read with an ``st:Z`` tag takes its strand from the tag, as FiberHMM does
(the loader stores it as the read's ``strand``); otherwise the strand is the
majority type among its events in the loaded region, as FiberHMM's class run
assigns reads to its ::CT / ::GA channels. Reads with neither have no call.
"""
from __future__ import annotations

from typing import Iterable, Optional

STRANDS = ("CT", "GA")
# A read's ``strand`` when its st:Z tag is present but neither CT nor GA:
# FiberHMM gives such a read no strand ('.'), whatever its R/Y marks say.
ST_UNKNOWN = "."


def normalize_strand(value: Optional[str]) -> Optional[str]:
    value = (value or "").strip().upper()
    if not value or value in ("BOTH", "ALL"):
        return None
    if value not in STRANDS:
        raise ValueError(f"strand must be CT or GA (got {value!r})")
    return value


def read_strand(read: dict) -> Optional[str]:
    """'CT', 'GA', or None (no deamination marks, or a tie)."""
    cached = read.get("strand")
    if cached in STRANDS:
        return cached
    if cached == ST_UNKNOWN:
        return None  # an st tag FiberHMM reads as no strand: the marks do not decide
    ct = ga = 0
    for event in read.get("deam") or ():
        kind = event[1] if isinstance(event, (list, tuple)) and len(event) > 1 else None
        if kind == 1:
            ct += 1
        elif kind == 0:
            ga += 1
    if ct == ga:
        return None
    return "CT" if ct > ga else "GA"


def st_tag_strand(value) -> Optional[str]:
    """FiberHMM's DAF strand from an ``st:Z`` tag: ``CT`` or ``GA``, else None.

    Mirrors ``fiberhmm.core.bam_reader.extract_daf_iupac_positions`` (and
    ``fiberhmm.inference.engine.daf_iupac_strand``): with an ``st`` tag the
    tag decides; only without one does the R/Y majority in SEQ."""
    value = str(value or "").strip().upper()
    return value if value in STRANDS else None


def seq_ry_strand(sequence: Optional[str]) -> Optional[str]:
    """The R/Y majority of a SEQ (Y = C->T marks, R = G->A): FiberHMM's rule
    when a read has no ``st`` tag. None on a tie or no marks."""
    upper = (sequence or "").upper()
    y, r = upper.count("Y"), upper.count("R")
    if y == r:
        return None
    return "CT" if y > r else "GA"


def record_strand_fields(read) -> dict:
    """``{'strand': 'CT'|'GA'}`` from a record's ``st:Z`` (FiberHMM's rule; it
    then decides the read's strand over its deamination marks, see
    :func:`read_strand`), plus ``strand_conflict: True`` when the SEQ's R/Y
    marks say the other strand (``st`` not swapped when a lift reversed the
    read, ``fiberhmm-lift`` repairs it). An ``st`` that is neither CT nor GA
    gives ``{'strand': '.'}`` (present, no strand, as in FiberHMM); empty
    without an ``st`` tag (the marks decide)."""
    try:
        if not read.has_tag("st"):
            return {}
        strand = st_tag_strand(read.get_tag("st"))
    except (AttributeError, KeyError):
        return {}
    if strand is None:
        return {"strand": ST_UNKNOWN}
    seq_strand = seq_ry_strand(getattr(read, "query_sequence", None))
    if seq_strand is not None and seq_strand != strand:
        return {"strand": strand, "strand_conflict": True}
    return {"strand": strand}


_MAX_CACHED_CALLS = 500_000


def strand_calls(state, dataset_id: Optional[str]) -> dict:
    """Per-session, per-dataset strand calls, so a read keeps its strand
    whichever region it was first classified from (a wider cached region can
    see marks a clipped view doesn't)."""
    calls_by_dataset = getattr(state, "_read_strand_calls", None)
    if calls_by_dataset is None:
        calls_by_dataset = {}
        try:
            state._read_strand_calls = calls_by_dataset
        except Exception:
            return {}
    calls = calls_by_dataset.setdefault(dataset_id or "", {})
    if len(calls) > _MAX_CACHED_CALLS:
        calls.clear()
    return calls


def cached_read_strand(read: dict, calls: Optional[dict]) -> Optional[str]:
    if calls is None:
        return read_strand(read)
    read_id = read.get("id")
    known = calls.get(read_id)
    if known is not None:
        return known
    call = read_strand(read)
    if call is not None and read_id is not None:
        calls[read_id] = call
    return call


def filter_reads_by_strand(reads: Iterable[dict], strand: str, calls: Optional[dict] = None) -> list[dict]:
    return [read for read in reads if cached_read_strand(read, calls) == strand]


def strand_totals(before: list, after: list, total_overlapping: int, width: int) -> tuple[int, int]:
    """(overlapping, spanning) read totals for one strand.

    `before` is the unstranded read list and `after` its one-strand subset.
    When `before` is only part of the overlapping reads (spanning-only, or
    capped), the overlapping total is scaled by the strand's share.
    """
    from services.read_selection import is_read_spanning
    spanning = sum(1 for read in after if is_read_spanning(read, width))
    if len(before) >= total_overlapping:
        return len(after), spanning
    share = len(after) / max(1, len(before))
    return max(len(after), round(total_overlapping * share)), spanning
