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
from typing import Optional

LIFT_PROGRAM = "fiberhmm-lift"
TAG_SOURCE_MAPQ = "Yq"
TAG_SOURCE_LOCUS = "Yp"
TAG_STASH_FLAG = "Yf"        # fiberhmm-lift stash (removed by the repair): source FLAG
REPAIR_COMMAND = ("fiberhmm-lift --repair-only -i <lifted.bam> --source <source.bam> "
                  "--target-fasta <target.fa> -o <repaired.bam>")


def _header_dict(header) -> dict:
    try:
        return header.to_dict() if hasattr(header, "to_dict") else dict(header or {})
    except Exception:
        return {}


def _is_vg(pg: dict) -> bool:
    return str(pg.get("PN", "") or "").strip().lower() == "vg"


def _is_ft_lift(pg: dict) -> bool:
    tokens = str(pg.get("CL", "") or "").split()
    return bool(tokens) and os.path.basename(tokens[0]) in ("ft", "fibertools", "fibertools-rs") \
        and any(t in ("pg-pansn", "pg-lift", "pg-inject") for t in tokens[1:3])


def _is_vg_lift_cl(pg: dict) -> bool:
    return re.match(r"^\S*\bvg\s+(surject|inject)\b", str(pg.get("CL", "") or "")) is not None


def _is_lift_pg(pg: dict) -> bool:
    """A @PG line that by itself shows a graph lift (FiberHMM ``is_lift_pg``): ft
    pg-pansn / pg-lift / pg-inject, or vg inject/surject in CL. vg's own bare
    ``@PG ID:0 PN:vg`` is not: a native vg giraffe alignment writes the same."""
    return _is_ft_lift(pg) or _is_vg_lift_cl(pg)


def _is_repair_pg(pg: dict) -> bool:
    pn = str(pg.get("PN", "") or "").strip().lower()
    ident = str(pg.get("ID", "") or "").strip().lower()
    return pn == LIFT_PROGRAM or re.match(rf"^{LIFT_PROGRAM}(?:\.\d+)?$", ident) is not None


def _pending_lift_indices(pgs: list) -> list:
    """FiberHMM ``pending_lift_indices`` (without the source BAM's @PG): an
    :func:`_is_lift_pg` line is pending unless a fiberhmm-lift @PG descends
    from it through PP. A bare ``PN:vg`` line (no CL) belongs to a pending
    lift only when one exists, has no PP, and is not the root of other
    history: of identical-ID bare lines the first is the lift's, and a single
    one some other line names as its PP is a native alignment's."""
    bare = {i for i, pg in enumerate(pgs) if _is_vg(pg) and not _is_lift_pg(pg) and not pg.get("PP")}
    by_id = {}
    for i, pg in enumerate(pgs):
        if i not in bare:
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
    pending = {i for i, pg in enumerate(pgs) if _is_lift_pg(pg) and i not in repaired}
    if not pending:
        return []
    referenced = {pg.get("PP") for i, pg in enumerate(pgs)
                  if i not in bare and not _is_lift_pg(pg) and not _is_repair_pg(pg)}
    by_bare_id: dict = {}
    for i in sorted(bare):
        by_bare_id.setdefault(pgs[i].get("ID"), []).append(i)
    for ident, indices in by_bare_id.items():
        if len(indices) > 1 or ident not in referenced:
            pending.add(indices[0])
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
    """One line for file details: ``asmA → asmB · graph graph.gbz · MD/NM recomputed``."""
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

def _stash_flag(read) -> Optional[int]:
    try:
        return int(read.get_tag(TAG_STASH_FLAG)) if read.has_tag(TAG_STASH_FLAG) else None
    except (AttributeError, KeyError, TypeError, ValueError):
        return None


def is_lift_ex_supplementary(read) -> bool:
    """A primary of an unrepaired lift that fiberhmm-lift's stash marks as a
    source supplementary or secondary: ``Yf:i`` (the source FLAG) has 0x800
    or 0x100.

    ``ft pg-lift`` drops 0x800, so a molecule's supplementaries come out as
    extra primaries. Only the stash says which record was which: a record
    without ``Yf`` is always shown (a hard-clipped primary can look like a
    supplementary by length or SA), and so is a source primary with hard
    clips (``Yf:i:0`` plus ``Yh``). The decision uses the record alone, so
    every view agrees. An unrepaired lift without stash tags shows all its
    records; file diagnose recommends ``fiberhmm-lift --repair-only``.
    """
    if read.is_unmapped or read.is_secondary or read.is_supplementary:
        return False
    flag = _stash_flag(read)
    return flag is not None and bool(flag & 0x900)


def lift_hidden_predicate(header):
    """The one rule every BAM reader applies: ``is_lift_ex_supplementary`` for
    an unrepaired lift, None (nothing hidden) for any other BAM."""
    try:
        return is_lift_ex_supplementary if is_unrepaired_lift(header) else None
    except Exception:
        return None
