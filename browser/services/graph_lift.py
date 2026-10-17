"""BAMs lifted through a pangenome graph (``ft pg-lift`` / ``fiberhmm-lift``).

``ft pg-lift`` (vg inject/surject between two ``ft pg-pansn`` passes) copies
SEQ, QUAL and every aux tag from the source alignment, but supplementaries
lose 0x800 and come out as extra primaries, hard clips are dropped and
``st:Z`` is not swapped on reads that changed strand. ``fiberhmm-lift``
repairs all of that, writes ``@PG ID:fiberhmm-lift`` (``coord=molecular``,
source/target/graph/calmd in its DS) and keeps two provenance tags per
record: ``Yq:i`` (source MAPQ) and ``Yp:Z`` (source locus
``contig:POS:strand``).

The header rule mirrors FiberHMM's ``fiberhmm.io.graph_lift``
(``is_lift_pg``, ``is_repair_pg``, ``pending_lift_indices``,
``header_lift_state``); the FiberHMM bundled with FiberBrowser 3.0.1
predates that module, so it is used only when importable.
"""
from __future__ import annotations

import os
import re
from typing import Iterable, Optional

LIFT_PROGRAM = "fiberhmm-lift"
TAG_SOURCE_MAPQ = "Yq"
TAG_SOURCE_LOCUS = "Yp"
REPAIR_COMMAND = ("fiberhmm-lift --repair-only -i <lifted.bam> --source <source.bam> "
                  "--target-fasta <target.fa> -o <repaired.bam>")


def _header_dict(header) -> dict:
    try:
        return header.to_dict() if hasattr(header, "to_dict") else dict(header or {})
    except Exception:
        return {}


def _is_lift_pg(pg: dict) -> bool:
    """A @PG line written by a graph lift: vg, or ft pg-pansn / pg-lift (FiberHMM ``is_lift_pg``)."""
    pn = str(pg.get("PN", "") or "").strip().lower()
    ident = str(pg.get("ID", "") or "").strip().lower()
    cl = str(pg.get("CL", "") or "")
    if pn == "vg" or re.match(r"^vg(?:[ .-]|$)", ident) or re.match(r"^\S*\bvg\s+(surject|inject)\b", cl):
        return True
    tokens = cl.split()
    if tokens and os.path.basename(tokens[0]) in ("ft", "fibertools", "fibertools-rs"):
        return any(t in ("pg-pansn", "pg-lift", "pg-inject") for t in tokens[1:3])
    return False


def _is_repair_pg(pg: dict) -> bool:
    pn = str(pg.get("PN", "") or "").strip().lower()
    ident = str(pg.get("ID", "") or "").strip().lower()
    return pn == LIFT_PROGRAM or re.match(rf"^{LIFT_PROGRAM}(?:\.\d+)?$", ident) is not None


def _pending_lift_indices(pgs: list) -> list:
    """FiberHMM ``pending_lift_indices``: a vg line without PP, or a lift line
    no fiberhmm-lift @PG descends from through PP."""
    pending = {i for i, pg in enumerate(pgs)
               if _is_lift_pg(pg) and str(pg.get("PN", "") or "").strip().lower() == "vg" and not pg.get("PP")}
    by_id = {}
    for i, pg in enumerate(pgs):
        if i not in pending:
            by_id.setdefault(pg.get("ID"), i)
    repaired = set()
    for pg in pgs:
        if not _is_repair_pg(pg):
            continue
        seen, parent = set(), pg.get("PP")
        while parent in by_id and by_id[parent] not in seen:
            j = by_id[parent]
            seen.add(j)
            parent = pgs[j].get("PP")
        repaired |= seen
    pending |= {i for i, pg in enumerate(pgs) if _is_lift_pg(pg) and i not in repaired}
    return sorted(pending)


_UNSET = object()
_fiberhmm_rule = _UNSET


def _fiberhmm_header_lift_state():
    """FiberHMM's own ``header_lift_state`` when the installed FiberHMM has it (looked up once)."""
    global _fiberhmm_rule
    if _fiberhmm_rule is _UNSET:
        try:
            from fiberhmm.io.graph_lift import header_lift_state as rule
        except Exception:
            rule = None
        _fiberhmm_rule = rule
    return _fiberhmm_rule


def header_lift_state(header) -> dict:
    """``{'lift': [IDs of unrepaired lift @PG lines], 'repaired': bool}`` (FiberHMM's rule)."""
    rule = _fiberhmm_header_lift_state()
    if rule is not None:
        try:
            return rule(header)
        except Exception:
            pass
    pgs = [pg for pg in (_header_dict(header).get("PG", []) or []) if isinstance(pg, dict)]
    pending = _pending_lift_indices(pgs)
    return {"lift": [str(pgs[i].get("ID", "?")) for i in pending],
            "repaired": not pending and any(_is_repair_pg(pg) for pg in pgs)}


def is_unrepaired_lift(header) -> bool:
    """A lift (vg / ft pg-pansn @PG) that no fiberhmm-lift @PG repaired."""
    return bool(header_lift_state(header)["lift"])


_DS_FIELD_RE = re.compile(r"\b(mode|source|target|graph|calmd|st_swapped)=(\S+?)(?=[;\s]|$)")


def lift_summary(header) -> Optional[dict]:
    """The latest ``fiberhmm-lift`` @PG as ``{'mode', 'source', 'target',
    'graph', 'calmd', 'version', 'lifts'}`` (``lifts``: how many fiberhmm-lift
    lines the history has), plus ``unrepaired`` (IDs of a later lift left
    unrepaired); None when the header records no lift at all."""
    pgs = [pg for pg in (_header_dict(header).get("PG", []) or []) if isinstance(pg, dict)]
    repairs = [pg for pg in pgs if _is_repair_pg(pg)]
    state = header_lift_state(header)
    if not repairs and not state["lift"]:
        return None
    out: dict = {"repaired": bool(state["repaired"]), "unrepaired": list(state["lift"]), "lifts": len(repairs)}
    if repairs:
        pg = repairs[-1]
        for key, value in _DS_FIELD_RE.findall(str(pg.get("DS", "") or "")):
            out.setdefault(key, value)
        if pg.get("VN"):
            out["version"] = str(pg["VN"])
    return out


def lift_summary_text(summary: Optional[dict]) -> str:
    """One line for file details: ``HG002 → GRCh38 · graph hprc.gbz · MD/NM recomputed``."""
    if not summary:
        return ""
    if not summary.get("lifts"):
        return "unrepaired (vg / ft pg-lift); run fiberhmm-lift --repair-only"
    source, target = summary.get("source", "unknown"), summary.get("target", "unknown")
    parts = ([f"{source} → {target}"] if (source, target) != ("unknown", "unknown")
             else ["repaired by fiberhmm-lift"])
    if summary.get("graph") and summary["graph"] != "unknown":
        parts.append(f"graph {summary['graph']}")
    if summary.get("calmd") == "yes":
        parts.append("MD/NM recomputed")
    elif summary.get("calmd") == "no":
        parts.append("MD/NM/SA dropped")
    if summary.get("unrepaired"):
        parts.append("a later lift is unrepaired (fiberhmm-lift --repair-only)")
    return " · ".join(parts)


def read_lift_provenance(read) -> Optional[dict]:
    """``{'from': Yp, 'mapq': Yq}`` for a record a fiberhmm-lift repaired, else None."""
    try:
        if not read.has_tag(TAG_SOURCE_LOCUS):
            return None
        out = {"from": str(read.get_tag(TAG_SOURCE_LOCUS))}
        if read.has_tag(TAG_SOURCE_MAPQ):
            out["mapq"] = int(read.get_tag(TAG_SOURCE_MAPQ))
        return out
    except (AttributeError, KeyError, TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# Ex-supplementaries of an unrepaired lift
# ---------------------------------------------------------------------------

def _declared_read_length(read) -> Optional[int]:
    """The molecule length an ``MA``/``Ma`` tag (first field) or ``MN:i`` records."""
    for tag in ("MA", "Ma"):
        try:
            if read.has_tag(tag):
                head = str(read.get_tag(tag)).split(";", 1)[0]
                if head.isdigit():
                    return int(head)
        except (AttributeError, KeyError):
            pass
    try:
        if read.has_tag("MN"):
            return int(read.get_tag("MN"))
    except (AttributeError, KeyError, TypeError, ValueError):
        pass
    return None


def _record_key(read) -> tuple:
    return (read.query_name, read.reference_start, read.reference_end,
            bool(read.is_reverse), getattr(read, "mapping_quality", 0))


def _rank(read) -> tuple:
    span = (read.reference_end or 0) - (read.reference_start or 0)
    return (int(read.query_length or 0), span, int(getattr(read, "mapping_quality", 0) or 0))


def lift_duplicate_records(records: Iterable) -> set:
    """Record keys (:func:`is_lift_duplicate`) of an unrepaired lift's extra primaries.

    ``ft pg-lift`` drops 0x800, so a molecule's supplementaries come out as
    more primaries with the same QNAME. A record is an ex-supplementary when

    - its ``MA``/``Ma``/``MN`` molecule length is longer than its SEQ (a
      hard-clipped supplementary whose clips the lift dropped), whatever else
      is in view; or
    - another primary of its QNAME in ``records`` ranks higher: longer SEQ
      (the primary carries the whole molecule), then longer reference span,
      then higher MAPQ, then the first one met.

    A soft-clipped ex-supplementary whose primary lies outside ``records`` is
    still shown. Only used for unrepaired lifts (merged libraries can share
    QNAMEs legitimately); a repaired lift restores 0x800.
    """
    best: dict = {}
    drop: set = set()
    for read in records:
        if read.is_unmapped or read.is_secondary or read.is_supplementary:
            continue
        key = _record_key(read)
        declared = _declared_read_length(read)
        if declared is not None and read.query_length and declared > int(read.query_length):
            drop.add(key)
            continue
        rank = _rank(read)
        held = best.get(read.query_name)
        if held is None or held[1] == key:
            best[read.query_name] = (rank, key)
        elif rank > held[0]:
            drop.add(held[1])
            best[read.query_name] = (rank, key)
        else:
            drop.add(key)
    return drop


def is_lift_duplicate(read, drop: set) -> bool:
    return bool(drop) and _record_key(read) in drop
