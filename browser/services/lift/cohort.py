"""Prepare display rows and analysis cohorts before viewport filters (§3.8)."""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from collections import defaultdict
from copy import deepcopy
from functools import lru_cache
import json

_scope = ContextVar("lift_cohort_scope", default=("display", None, None))
_IDENTITY_PREFIX = "lift-cohort:v1 "  # A space cannot occur in a SAM QNAME.


_RECORD_PREFIX = "lift-record:v1 "  # A record key (DESIGN_GRAPH_PRIMARY §3.1): molecule, QNAME, record.


def _encode_identity(parts):
    return _IDENTITY_PREFIX + json.dumps(parts, separators=(",", ":"), ensure_ascii=True)


def _encode_record(parts):
    return _RECORD_PREFIX + json.dumps(parts, separators=(",", ":"), ensure_ascii=True)


@lru_cache(maxsize=65536)
def _record_key_cached(value):
    return _record_key(value)


def record_key(value):
    """The record key of a row identity (cached: identities are immutable strings); see ``_record_key``."""
    return _record_key_cached(str(value)) if value is not None else None


def _record_key(value):
    """The record key of a row identity (DESIGN_GRAPH_PRIMARY §3.1), independent of row index and placement, so a
    graph row and the linear rows of the same record match across views: ``lift-record:v1 [molecule, QNAME,
    record]`` (``record`` null under ``fold_molecule``). ``value`` is a versioned ``analysis_id``, a record key
    itself, or anything else (a QNAME, a native id): None for those."""
    value = str(value)
    if value.startswith(_RECORD_PREFIX):
        try:
            parts = json.loads(value[len(_RECORD_PREFIX):])
        except (ValueError, RecursionError):
            return None
        ok = (isinstance(parts, list) and len(parts) == 3 and isinstance(parts[0], str) and isinstance(parts[1], str)
              and parts[1] and (parts[2] is None or isinstance(parts[2], str)))
        return value if ok and _encode_record(parts) == value else None
    if not value.startswith(_IDENTITY_PREFIX):
        return None
    try:
        parts = json.loads(value[len(_IDENTITY_PREFIX):])
    except (ValueError, RecursionError):
        return None
    if not (isinstance(parts, list) and len(parts) == 5 and isinstance(parts[0], str) and isinstance(parts[1], str)
            and parts[1] and (parts[2] is None or isinstance(parts[2], str)) and _encode_identity(parts) == value):
        return None
    return _encode_record(parts[:3])


def folded_identity(value) -> bool:
    """Whether a cohort identity is a folded molecule's (``fold_molecule``: no record), which two paths of one
    dataset can share."""
    if not isinstance(value, str) or not value.startswith(_IDENTITY_PREFIX):
        return False
    try:
        parts = json.loads(value[len(_IDENTITY_PREFIX):])
    except (ValueError, RecursionError):
        return False
    return isinstance(parts, list) and len(parts) == 5 and parts[2] is None


def record_qname(value):
    """The QNAME a record key names (None: not a record key)."""
    value = str(value)
    if not value.startswith(_RECORD_PREFIX) or record_key(value) != value:
        return None
    return json.loads(value[len(_RECORD_PREFIX):])[1]


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
    # Retain the QNAME as its own JSON component: both names and provenance
    # groups can contain pipes. Null components encode the folding mode.
    return _encode_identity([
        ll["molecule"], read["id"],
        None if settings.fold_molecule else str(ll["record"]),
        None if settings.fold_molecule or settings.fold_orientation_rows else int(ll.get("row_index", 0)),
        str(ll.get("placement", "primary")),
    ])


def raw_qnames(ids, dataset):
    """Only QNAMEs reach Sampler.keep; exact cohort matching happens later.

    Decode only versioned identities for this dataset's provenance and folding
    mode. Every unrecognized value passes through verbatim, including pipes.
    """
    from services.lift.joint import molecule_key
    settings = dataset.live_lift.settings
    out = set()
    groups = settings.molecule_group_map(getattr(dataset, "paths", []), getattr(dataset, "id", ""))
    for value in ids:
        value = str(value)
        qname = value
        rq = record_qname(value) if value.startswith(_RECORD_PREFIX) else None
        if rq is not None:
            # A record key (graph mode, DESIGN_GRAPH_PRIMARY §3.1) of this dataset's provenance: its QNAME.
            molecule = json.loads(value[len(_RECORD_PREFIX):])[0]
            if any(molecule in (molecule_key(group, rq), group + "|" + rq) for group in groups.values()):
                qname = rq
        if value.startswith(_IDENTITY_PREFIX):
            try:
                parts = json.loads(value[len(_IDENTITY_PREFIX):])
            except (ValueError, RecursionError):
                parts = None
            if isinstance(parts, list) and len(parts) == 5:
                molecule, name, record, orientation, placement = parts
                valid_record = record is None if settings.fold_molecule else isinstance(record, str) and bool(record)
                valid_orientation = (orientation is None if settings.fold_molecule or settings.fold_orientation_rows
                                     else type(orientation) is int and orientation >= 0)
                if (isinstance(molecule, str) and isinstance(name, str) and name and not any(c.isspace() for c in name)
                        and isinstance(placement, str) and placement and valid_record and valid_orientation
                        and any(molecule in (molecule_key(group, name), group + "|" + name) for group in groups.values())  # legacy unescaped keys still decode
                        and _encode_identity(parts) == value):
                    qname = name
        out.add(qname)
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
    folded_display = 0
    if purpose == "display" and settings.supplementary_display == "fold":
        kept, folded_display = fold_display_supplementaries(kept)
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
    desc["folded_display_rows"] = folded_display
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
    out = _merge_rows(rows)
    ll = out["live_lift"]
    from services.read_selection import read_body_spans
    ll["segments"] = [[a, b, 0, "+", True] for a, b in _merge(s for r in rows for s in read_body_spans(r))]
    ll["connectors"] = []
    ll["insertions"] = {}
    return out


def _is_supplementary(row):
    return bool((row["live_lift"].get("source") or {}).get("supplementary"))


def _target_gap(a, b):
    return max(0, b.get("reference_start", 0) - a.get("reference_end", 0),
               a.get("reference_start", 0) - b.get("reference_end", 0))


def fold_display_supplementaries(rows):
    """``supplementary_display='fold'`` (§2.3, P3): a molecule's supplementary
    rows are drawn on its primary record's row. Each supplementary row joins
    the primary row nearest it on the target (overlapping first, then the
    lower target start); a molecule with no primary row loaded folds its
    supplementaries onto the lowest one. Alternative rows never fold.

    Returns ``(rows, number of folded rows)``. A folded row keeps the anchor's
    ``analysis_id`` and lists every member's in ``live_lift.folded``; analysis
    cohorts are unaffected (display only)."""
    by_molecule = defaultdict(list)
    for r in rows:
        if not r["live_lift"].get("alt"):
            by_molecule[r["live_lift"]["molecule"]].append(r)
    attach = {}          # id(anchor row) -> member rows (anchor first)
    consumed = set()
    for members in by_molecule.values():
        supps = [r for r in members if _is_supplementary(r)]
        if not supps:
            continue
        prims = [r for r in members if not _is_supplementary(r)]
        if prims:
            for supp in supps:
                best = min(prims, key=lambda p: (_target_gap(p, supp), p.get("reference_start", 0), p["analysis_id"]))
                attach.setdefault(id(best), [best]).append(supp)
                consumed.add(id(supp))
        else:
            ordered = sorted(supps, key=lambda r: (r.get("reference_start", 0), r["analysis_id"]))
            if len(ordered) > 1:
                attach[id(ordered[0])] = ordered
                consumed.update(id(r) for r in ordered[1:])
    if not attach:
        return rows, 0
    out = []
    for r in rows:
        if id(r) in consumed:
            continue
        out.append(_fold_display_row(attach[id(r)]) if id(r) in attach else r)
    return out, len(attach)


def _fold_display_row(members):
    """Merge one anchor row and its supplementary rows for display: overlapping
    molecular bases are arbitrated as in ``fold_molecule``, but each member's
    segments keep their chain, strand and primary flag (clipped to what it
    keeps), and connectors, badges, insertion payloads and map observations
    stay drawn."""
    anchor = members[0]
    masks = _placement_masks(members)
    clipped = []
    for i, row in enumerate(members):
        if masks is None or not row["live_lift"].get("molecular_spans"):
            clipped.append(deepcopy(row))
            continue
        keep = masks.get(i)
        if not keep:
            continue
        c = _clip_row(row, keep)
        ll = c["live_lift"]
        ll["segments"] = [[max(a, x), min(b, y), *rest] for a, b, *rest in row["live_lift"].get("segments", [])
                          for x, y in keep if min(b, y) > max(a, x)]
        lo, hi = keep[0][0], keep[-1][1]
        ll["connectors"] = [list(cn) for cn in row["live_lift"].get("connectors", []) if lo <= cn[0] and cn[1] <= hi]
        clipped.append(c)
    if not clipped:
        clipped = [deepcopy(anchor)]
    if clipped[0]["live_lift"]["record"] != anchor["live_lift"]["record"]:
        clipped.insert(0, {**deepcopy(anchor), "intervals": [], "fire": [], "layers": {},
                           "live_lift": {**deepcopy(anchor["live_lift"]), "segments": [], "connectors": [],
                                         "badges": [], "badge_ids": [], "calls": {}, "call_parts": {}}})
    out = _merge_rows(clipped)
    ll = out["live_lift"]
    order = sorted(range(len(ll["badges"])), key=lambda i: ll["badges"][i][0])
    ids = ll["badge_ids"]
    ll["badges"] = [ll["badges"][i] for i in order]
    ll["badge_ids"] = [ids[i] if i < len(ids) else None for i in order]
    ll["segments"] = sorted(ll["segments"], key=lambda s: (s[0], s[1]))
    ll["connectors"] = sorted(ll["connectors"])
    ll["molecular_spans"] = sorted(ll.get("molecular_spans", []))
    ll["insertions"] = {k: v for r in clipped for k, v in (r["live_lift"].get("insertions") or {}).items()}
    if any("gap_observations" in r["live_lift"] for r in clipped):
        ll["gap_observations"] = [g for r in clipped for g in r["live_lift"].get("gap_observations", [])]
    out["analysis_id"] = anchor["analysis_id"]
    ll["folded"] = {"records": len({r["live_lift"]["record"] for r in members}),
                    "analysis_ids": [r["analysis_id"] for r in members],
                    "supplementary_rows": sum(_is_supplementary(r) for r in members)}
    return out


def _merge_rows(rows):
    """One row with every member's annotations: intervals, fire and layers with
    record-qualified call IDs (identical local IDs of two records never
    collapse), concatenated geometry lists, marks, alignment spans and hull."""
    from services.lift.reads import _merge
    from services.background_work import checkpoint
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
    allowed = _placement_masks(rows)
    if allowed is None:
        return rows  # compatibility for synthetic/older rows without the map
    result = []
    for i, row in enumerate(rows):
        masks = allowed.get(i)
        if not masks:
            continue
        result.append(_clip_row(row, masks))
    return result or rows[:1]


def _placement_masks(rows):
    """``{row index: merged target spans it keeps}`` under the arbitration
    order (primary record, primary chain, target), or None without molecular
    spans."""
    from services.lift.reads import _merge
    from services.background_work import checkpoint
    placements = []
    for i, row in enumerate(rows):
        ll = row["live_lift"]
        for a, b, m, step, primary in ll.get("molecular_spans", []):
            placements.append((bool(ll.get("source", {}).get("supplementary")), not primary,
                               a, ll["record"], ll.get("row_index", 0), i, b, m, step))
    if not placements:
        return None
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
    return {i: _merge(spans) for i, spans in allowed.items()}


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
