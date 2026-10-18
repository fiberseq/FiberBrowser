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
    groups = settings.molecule_group_map(getattr(dataset, "paths", []), getattr(dataset, "id", ""))
    prefixes = sorted(set(groups.values()), key=len, reverse=True)
    for value in ids:
        value = str(value)
        parts = value.rsplit("|", count)
        molecule = parts[0] if len(parts) == count + 1 else ""
        prefix = next((g for g in prefixes if molecule.startswith(g + "|")), None)
        out.add(molecule[len(prefix) + 1:] if prefix is not None else
                molecule.split("|", 1)[1] if "|" in molecule else value)
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
    ordered = sorted(rows, key=lambda r: (bool(r["live_lift"].get("source", {}).get("supplementary")),
                                          bool(r["live_lift"].get("alt")), r["live_lift"]["record"], r["live_lift"].get("row_index", 0)))
    for i, r in enumerate(ordered):
        if i % 256 == 0:
            checkpoint()
        molecule = r["live_lift"]["molecule"]
        if molecule not in strands and r.get("strand") in ("CT", "GA", ".") and not r.get("_fiberbrowser_inferred_strand"):
            strands[molecule] = r["strand"]
        if not r["live_lift"].get("alt"):
            marks[molecule].update(tuple(e) for e in r.get("deam", []))
    authoritative = set(strands)
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
                     **({"strand": strands[ll["molecule"]], "_fiberbrowser_inferred_strand": ll["molecule"] not in authoritative} if ll["molecule"] in strands else {})})
    mapping = {r["analysis_id"]: r["analysis_id"] for r in kept}
    desc = dict(records=len({(r["live_lift"]["molecule"], r["live_lift"]["record"]) for r in kept}),
                supplementary_rows=sum(bool(r["live_lift"].get("source", {}).get("supplementary")) for r in kept),
                folded=False, excluded_alt=excluded_alt, alternative_rows=sum(bool(r["live_lift"].get("alt")) for r in kept),
                hap=lift_hap, input_rows=len(kept), purpose=purpose,
                primary_metadata_fallback_records=len({(r["live_lift"]["molecule"], r["live_lift"]["record"])
                    for r in kept if r["live_lift"].get("hap_source") == "record"}),
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
    from services.background_work import checkpoint
    rows = sorted(rows, key=lambda r: (bool(r["live_lift"].get("source", {}).get("supplementary")),
                                      bool(r["live_lift"].get("alt")),
                                      r.get("reference_start", 0), r["analysis_id"],
                                      r["live_lift"]["record"], r["live_lift"].get("row_index", 0)))
    rows = arbitrate_molecular_placements(rows)
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
        quality_names = []
        for r in rows:
            checkpoint()
            src = r["live_lift"]
            layer = r.get("layers", {}).get(group[6:]) if group.startswith("layer:") else None
            ivs = (layer or {}).get("intervals", []) if group.startswith("layer:") else r.get(group, [])
            template = template or layer
            for name in (layer or {}).get("quality_names", []):
                if name not in quality_names:
                    quality_names.append(name)
            positive_rank = -1
            calls = src.get("calls", {}).get(group, [])
            parts = src.get("call_parts", {}).get(group, [])
            for i, iv in enumerate(ivs or []):
                if i % 256 == 0:
                    checkpoint()
                call = calls[i] if i < len(calls) else None
                call = f"{src['record']}|{call}" if call is not None else None
                qualities = {}
                extras = {}
                if layer:
                    for k, name in enumerate(layer.get("quality_names") or []):
                        values = (layer.get("qualities") or [])
                        qualities[name] = values[k][i] if k < len(values) and i < len(values[k]) else 0
                    for key in ("source_intervals", "family_intervals", "annotation_names", "circular_ids"):
                        values = layer.get(key)
                        if values is not None:
                            extras[key] = values[i] if i < len(values) else None
                elif group == "intervals" and len(iv) > 2 and iv[2] > 0:
                    positive_rank += 1
                    values = r.get("qualities") or []
                    if positive_rank < len(values):
                        qualities["primary"] = values[positive_rank]
                entries.append((iv, call, parts[i] if i < len(parts) else None, qualities, extras))
        entries.sort(key=lambda e: (e[0][0], e[0][1], str(e[1])))
        ivs = [e[0] for e in entries]
        if group.startswith("layer:"):
            layer = {**(template or {}), "intervals": ivs, "quality_names": quality_names,
                     "qualities": [[e[3].get(name, 0) for e in entries] for name in quality_names] or None}
            for key in {key for e in entries for key in e[4]}:
                layer[key] = [e[4].get(key) for e in entries]
            out["layers"][group[6:]] = layer
        else:
            out[group] = ivs
            if group == "intervals":
                out["qualities"] = [e[3].get("primary", 0) for e in entries if e[0][2] > 0]
        ll["calls"][group] = [e[1] for e in entries]
        ll["call_parts"][group] = [e[2] for e in entries]
    for field in ("segments", "connectors", "badges", "badge_ids", "molecular_spans"):
        ll[field] = [v for r in rows for v in r["live_lift"].get(field, [])]
    for field in ("methyl", "methyl_m6a", "methyl_m5c", "deam", "possible_deam_ct", "possible_deam_ga"):
        if any(field in r for r in rows):
            out[field] = sorted({tuple(v) if isinstance(v, list) else v for r in rows for v in r.get(field, [])})
    out["alignment_spans"] = _merge(s for r in rows for s in r.get("alignment_spans", []))
    out["reference_start"] = min(r.get("reference_start", 0) for r in rows)
    out["reference_end"] = max(r.get("reference_end", 0) for r in rows)
    if len({r.get("alignment_orientation") for r in rows}) > 1:
        out["alignment_orientation"] = None
    from services.read_selection import read_body_spans
    ll["segments"] = [[a, b, 0, "+", True] for a, b in _merge(s for r in rows for s in read_body_spans(r))]
    ll["connectors"] = []
    ll["insertions"] = {}
    return out


def _subtract_spans(a, b, occupied):
    cursor = a
    for x, y in occupied:
        if y <= cursor:
            continue
        if x >= b:
            break
        if x > cursor:
            yield cursor, min(x, b)
        cursor = max(cursor, y)
    if cursor < b:
        yield cursor, b


def arbitrate_molecular_placements(rows):
    """One placement per molecular base: primary record, primary chain, target.

    Run before merging calls, so two records' local call IDs never imply
    equivalence. Source insertion payloads never participate.
    """
    from services.lift.reads import _merge
    from services.background_work import checkpoint
    from services.read_selection import read_body_spans
    placements = []
    for i, row in enumerate(rows):
        ll = row["live_lift"]
        for a, b, m, step, primary in ll.get("molecular_spans", []):
            placements.append((bool(ll.get("source", {}).get("supplementary")), not primary,
                               a, ll["record"], ll.get("row_index", 0), i, b, m, step))
    if not placements:
        return rows  # compatibility for synthetic/older rows without the map
    occupied, allowed = [], defaultdict(list)
    for n, (_, _, a, _, _, i, b, m, step) in enumerate(sorted(placements)):
        if n % 256 == 0:
            checkpoint()
        last = m + (b - a - 1) * step
        lo, hi = min(m, last), max(m, last) + 1
        for x, y in _subtract_spans(lo, hi, occupied):
            ta = a + (x - m if step == 1 else m - y + 1)
            allowed[i].append([ta, ta + y - x])
        occupied = _merge([*occupied, [lo, hi]])
    result = []
    for i, row in enumerate(rows):
        masks = _merge(allowed[i])
        if not masks:
            continue
        result.append(_clip_row(row, masks))
    return result or rows[:1]


def _clip_row(row, masks):
    """Clip parallel annotation/call arrays to the winning target placements."""
    out = deepcopy(row)
    ll = out["live_lift"]
    groups = {"intervals": out.get("intervals", []), "fire": out.get("fire", [])}
    groups.update({"layer:" + name: layer.get("intervals", []) for name, layer in out.get("layers", {}).items()})
    for group, intervals in groups.items():
        clipped, calls, parts, kept_indices = [], [], [], []
        ids = ll.get("calls", {}).get(group, [])
        provenance = ll.get("call_parts", {}).get(group, [])
        for j, iv in enumerate(intervals):
            for a, b in masks:
                x, y = max(a, iv[0]), min(b, iv[1])
                if y > x or (iv[0] == iv[1] and a <= iv[0] <= b):
                    clipped.append([x, y, *iv[2:]])
                    kept_indices.append(j)
                    calls.append(ids[j] if j < len(ids) else None)
                    parts.append(provenance[j] if j < len(provenance) else None)
        if group.startswith("layer:"):
            out["layers"][group[6:]]["intervals"] = clipped
            layer = out["layers"][group[6:]]
            for key in ("source_intervals", "family_intervals", "annotation_names", "circular_ids"):
                if layer.get(key) is not None:
                    values = layer[key]
                    layer[key] = [values[j] if j < len(values) else None for j in kept_indices]
            if layer.get("qualities"):
                layer["qualities"] = [[values[j] if j < len(values) else 0 for j in kept_indices] for values in layer["qualities"]]
        else:
            out[group] = clipped
            if group == "intervals" and row.get("qualities"):
                ranks = {j: n for n, j in enumerate(j for j, iv in enumerate(intervals) if iv[2] > 0)}
                out["qualities"] = [row["qualities"][ranks[j]] if ranks[j] < len(row["qualities"]) else 0
                                    for j in kept_indices if j in ranks]
        ll.setdefault("calls", {})[group] = calls
        ll.setdefault("call_parts", {})[group] = parts
    for field in ("methyl", "methyl_m6a", "methyl_m5c", "deam", "possible_deam_ct", "possible_deam_ga"):
        if field in out:
            out[field] = [v for v in out[field] if any(a <= (v[0] if isinstance(v, (list, tuple)) else v) < b for a, b in masks)]
    ll["segments"] = [[a, b, 0, "+", True] for a, b in masks]
    ll["connectors"] = []
    return out
