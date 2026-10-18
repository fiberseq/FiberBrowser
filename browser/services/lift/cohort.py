"""Prepare display rows and analysis cohorts before viewport filters (§3.8)."""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from collections import defaultdict
from copy import deepcopy

_scope = ContextVar("lift_cohort_scope", default=("display", None, None))


@contextmanager
def using_lift_cohort(purpose="analysis", lift_hap=None, strand=None):
    token = _scope.set((purpose, lift_hap, strand))
    try:
        yield
    finally:
        _scope.reset(token)


def cohort_scope(dataset):
    from services.lift.reads import _display_hap
    purpose, hap, strand = _scope.get()
    return purpose, hap if purpose == "analysis" else _display_hap.get(), strand


def cohort_key(dataset):
    from services.lift.capability import is_lifted
    return cohort_scope(dataset) if is_lifted(dataset) else None


def analysis_id(read, settings):
    ll = read["live_lift"]
    parts = [ll["molecule"]]
    if not settings.fold_molecule:
        parts.append(str(ll["record"]))
        if not settings.fold_orientation_rows:
            parts.append(str(ll.get("row_index", 0)))
    parts.append(str(ll.get("placement", "primary")))
    return "|".join(parts)


def raw_qnames(ids, dataset):
    """Only QNAMEs reach Sampler.keep; exact cohort matching happens later.

    The number of right-hand identity components is fixed by the fold mode.
    QNAME is the final molecule component (SAM QNAMEs cannot contain spaces).
    """
    settings = dataset.live_lift.settings
    count = 1 if settings.fold_molecule else (2 if settings.fold_orientation_rows else 3)
    out = set()
    for value in ids:
        value = str(value)
        parts = value.rsplit("|", count)
        out.add(parts[0].split("|", 1)[1] if len(parts) == count + 1 and "|" in parts[0] else value)
    return out


@dataclass
class PreparedCohort:
    rows: list
    row_to_cohort: dict
    description: dict


def prepare_lift_cohort(rows, purpose, settings, lift_hap=None):
    from services.lift.reads import filter_lift_hap
    from services.background_work import checkpoint
    # Resolve inferred strand once over a molecule, before any row is removed.
    rows = list(rows)
    strands, marks = {}, defaultdict(set)
    for r in rows:
        molecule = r["live_lift"]["molecule"]
        if r.get("strand") in ("CT", "GA", "."):
            strands[molecule] = r["strand"]
        if not r["live_lift"].get("alt"):
            marks[molecule].update(tuple(e) for e in r.get("deam", []))
    from services.read_strand import read_strand
    for molecule, events in marks.items():
        if molecule not in strands:
            inferred = read_strand({"deam": events})
            if inferred:
                strands[molecule] = inferred
    selected = filter_lift_hap(rows, lift_hap)
    excluded_alt = sum(bool(r["live_lift"].get("alt")) for r in selected
                       if purpose == "analysis" and settings.cohort_alternatives == "exclude")
    kept = []
    for i, read in enumerate(selected):
        if not i % 256:
            checkpoint()
        ll = read["live_lift"]
        supp = (ll.get("source") or {}).get("supplementary")
        if purpose == "display":
            if (ll.get("alt") and not settings.alternatives) or (supp and settings.supplementary_display == "hide"):
                continue
        else:
            if ll.get("alt") and settings.cohort_alternatives == "exclude":
                continue
            if supp and (settings.cohort_supplementaries == "primary_only" or
                         (settings.cohort_supplementaries == "follow_display" and settings.supplementary_display == "hide")):
                continue
        kept.append({**read, "analysis_id": analysis_id(read, settings),
                     **({"strand": strands[ll["molecule"]]} if ll["molecule"] in strands else {})})
    mapping = {r["analysis_id"]: r["analysis_id"] for r in kept}
    desc = dict(records=len({(r["live_lift"]["molecule"], r["live_lift"]["record"]) for r in kept}),
                supplementary_rows=sum(bool(r["live_lift"].get("source", {}).get("supplementary")) for r in kept),
                folded=False, excluded_alt=excluded_alt, alternative_rows=sum(bool(r["live_lift"].get("alt")) for r in kept),
                hap=lift_hap, input_rows=len(kept), purpose=purpose,
                cohort_supplementaries=settings.cohort_supplementaries, cohort_alternatives=settings.cohort_alternatives)
    if purpose == "analysis" and (settings.fold_molecule or settings.fold_orientation_rows):
        groups = defaultdict(list)
        for read in kept:
            groups[read["analysis_id"]].append(read)
        kept = [_fold(group) for _, group in sorted(groups.items())]
        desc["folded"] = True
    desc["rows"] = len(kept)
    return PreparedCohort(kept, mapping, desc)


def _fold(rows):
    """Merge geometry and annotations, preserving record-local call provenance.

    Primary records and primary chains win overlapping molecular placements.
    Geometry clipping is shared with the feature preparation pass.
    """
    from services.lift.reads import _merge
    rows = sorted(rows, key=lambda r: (bool(r["live_lift"].get("source", {}).get("supplementary")),
                                      bool(r["live_lift"].get("alt")),
                                      r.get("reference_start", 0), r["analysis_id"],
                                      r["live_lift"]["record"], r["live_lift"].get("row_index", 0)))
    out = deepcopy(rows[0])
    ll = out["live_lift"]
    ll["records"] = sorted({r["live_lift"]["record"] for r in rows})
    ll["calls"], ll["call_parts"] = {}, {}
    # Keep provenance on every interval; identical call IDs in different records
    # must never collapse. Cropping can remove any part, including the first.
    groups = {"intervals", "fire"} | {"layer:" + n for r in rows for n in r.get("layers", {})}
    out["layers"] = {}
    for group in sorted(groups):
        entries = []
        template = None
        for r in rows:
            src = r["live_lift"]
            layer = r.get("layers", {}).get(group[6:]) if group.startswith("layer:") else None
            ivs = (layer or {}).get("intervals", []) if group.startswith("layer:") else r.get(group, [])
            template = template or layer
            calls = src.get("calls", {}).get(group, [])
            parts = src.get("call_parts", {}).get(group, [])
            for i, iv in enumerate(ivs or []):
                call = calls[i] if i < len(calls) else None
                call = f"{src['record']}|{call}" if call is not None else None
                entries.append((iv, call, parts[i] if i < len(parts) else None))
        entries.sort(key=lambda e: (e[0][0], e[0][1], str(e[1])))
        ivs = [e[0] for e in entries]
        if group.startswith("layer:"):
            out["layers"][group[6:]] = {**(template or {}), "intervals": ivs, "qualities": None}
        else:
            out[group] = ivs
        ll["calls"][group] = [e[1] for e in entries]
        ll["call_parts"][group] = [e[2] for e in entries]
    for field in ("segments", "connectors", "badges", "badge_ids"):
        ll[field] = [v for r in rows for v in r["live_lift"].get(field, [])]
    for field in ("methyl", "methyl_m6a", "methyl_m5c", "deam", "possible_deam_ct", "possible_deam_ga"):
        if any(field in r for r in rows):
            out[field] = sorted({tuple(v) if isinstance(v, list) else v for r in rows for v in r.get(field, [])})
    out["alignment_spans"] = _merge(s for r in rows for s in r.get("alignment_spans", []))
    out["reference_start"] = min(r.get("reference_start", 0) for r in rows)
    out["reference_end"] = max(r.get("reference_end", 0) for r in rows)
    out.pop("qualities", None)
    return out
