"""Compact-read feature extraction for clustering.

This module is intentionally pure: no FastAPI state, no global server state,
and no file handles. Keep hot-path compute here so it can be tested and
optimized without importing the full backend app.
"""
from __future__ import annotations

from bisect import bisect_left, bisect_right
from typing import Any, Iterable

import numpy as np

from services.read_marks import m6a_positions

CLUSTER_RULE_MODE_PREFIX = "cluster_rule:"


def _camel_or_snake(mapping: dict[str, Any], camel: str, snake: str, default=None):
    if camel in mapping:
        return mapping.get(camel)
    if snake in mapping:
        return mapping.get(snake)
    return default


def _normalize_layer_name(layer: Any) -> str | None:
    if layer is None:
        return None
    value = str(layer)
    if value in ("", "primary", "footprint"):
        return None
    if value == "msp":
        return "fire"
    return value


def _layer_aliases(layer: str | None) -> list[str | None]:
    if layer is None:
        return [None]
    if layer == "fire":
        return ["fire", "msp"]
    if layer == "msp":
        return ["msp", "fire"]
    return [layer]


def _interval_quality_map(layer: dict[str, Any] | None, index: int) -> dict[str, float]:
    if not layer:
        return {}
    names = layer.get("quality_names") or []
    qualities = layer.get("qualities") or []
    out = {}
    for qi, name in enumerate(names):
        if qi < len(qualities) and index < len(qualities[qi]):
            out[str(name)] = qualities[qi][index]
    return out


def _iter_layer_interval_entries(
    read: dict[str, Any],
    target_layer: str | None,
) -> list[tuple[int, int, float, str | None, dict[str, float]]]:
    """Return interval entries with layer and quality context for rule matching."""
    if target_layer is None:
        intervals = read.get("intervals") or []
        qualities = read.get("qualities") or []
        entries = []
        # Primary qualities index the footprints (positive sizes) only, not gaps.
        positive_idx = 0
        for iv in intervals:
            if len(iv) < 3:
                continue
            qmap = {}
            if iv[2] > 0:
                if positive_idx < len(qualities):
                    qmap = {"nq": qualities[positive_idx]}
                positive_idx += 1
            entries.append((iv[0], iv[1], iv[2], None, qmap))
        return entries

    layers = read.get("layers") or {}
    for alias in _layer_aliases(target_layer):
        if alias is None:
            continue
        layer = layers.get(alias)
        if layer and layer.get("intervals"):
            entries = []
            for idx, iv in enumerate(layer["intervals"]):
                if len(iv) < 2:
                    continue
                size = iv[2] if len(iv) > 2 else iv[1] - iv[0]
                entries.append((iv[0], iv[1], size, alias, _interval_quality_map(layer, idx)))
            return entries

    if target_layer in {"fire", "msp"} and read.get("fire"):
        entries = []
        for iv in read.get("fire") or []:
            if len(iv) < 2:
                continue
            quality = iv[2] if len(iv) > 2 else 255
            entries.append((iv[0], iv[1], iv[1] - iv[0], "fire", {"aq": quality}))
        return entries
    return []


def _rule_targets_layer(rule: dict[str, Any], layer_name: str | None) -> bool:
    targets = _camel_or_snake(rule, "targetLayers", "target_layers", []) or []
    if not targets:
        return True
    normalized_targets = {_normalize_layer_name(target) for target in targets}
    normalized_layer = _normalize_layer_name(layer_name)
    return normalized_layer in normalized_targets


def _quality_gates_pass(rule: dict[str, Any], qualities: dict[str, float]) -> bool:
    gates = _camel_or_snake(rule, "qualityGates", "quality_gates", []) or []
    for gate in gates:
        if not isinstance(gate, dict):
            continue
        name = str(_camel_or_snake(gate, "qualityName", "quality_name", ""))
        if not name or name not in qualities:
            return False
        value = qualities[name]
        min_value = float(_camel_or_snake(gate, "minValue", "min_value", 0) or 0)
        max_value = _camel_or_snake(gate, "maxValue", "max_value", None)
        if value < min_value:
            return False
        if max_value is not None and value > float(max_value):
            return False
    return True


# Nucleosome size conditions of a labeling rule (frontend ColorRule nucCoarse / nucNamed / zMin / zMax / nucTf; the
# Filter/Sort payload spells them nuc_coarse / nuc_named / z_min / z_max / nuc_tf). An item matches through its nucsz
# mark (CONTRACTS §11.3 bytes: coarse, named, posterior, z), as the browser's utils/ruleMatching.ts nucMarkMatchesRule
# reads it through utils/nucLayers.ts nucSizeMarkFor.
NUC_RULE_FIELDS = (("nucCoarse", "nuc_coarse"), ("nucNamed", "nuc_named"), ("zMin", "z_min"), ("zMax", "z_max"),
                   ("nucTf", "nuc_tf"))
NUC_Z_MISSING = 255
NUC_TF_BIT = 16
# Items that carry a nucsz mark: primary footprints (None, the browser's 'footprint'), nucleosome and TF calls.
NUC_MARK_ITEM_LAYERS = frozenset({None, "footprint", "nuc", "tf"})


def _finite_number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if np.isfinite(number) else None


def _code_set(value: Any) -> frozenset | None:
    if not isinstance(value, (list, tuple)):
        return None
    codes = frozenset(n for n in (_finite_number(v) for v in value) if n is not None)
    return codes or None


def nuc_rule_conditions(rule: dict[str, Any] | None) -> dict[str, Any] | None:
    """The rule's nucleosome conditions, or None when it sets none (empty lists and null bounds are no condition)."""
    if not isinstance(rule, dict):
        return None
    tf = _camel_or_snake(rule, "nucTf", "nuc_tf", None)
    conditions = {
        "coarse": _code_set(_camel_or_snake(rule, "nucCoarse", "nuc_coarse", None)),
        "named": _code_set(_camel_or_snake(rule, "nucNamed", "nuc_named", None)),
        "z_min": _finite_number(_camel_or_snake(rule, "zMin", "z_min", None)),
        "z_max": _finite_number(_camel_or_snake(rule, "zMax", "z_max", None)),
        "tf": tf if isinstance(tf, bool) else None,
    }
    return conditions if any(value is not None for value in conditions.values()) else None


def nuc_size_index(read: dict[str, Any]) -> tuple[list, list[dict[str, float]], float] | None:
    """A read's nucsz marks sorted by span, ``(starts, marks, longest)``; None without the layer or its coarse bytes
    (a mark without its bytes cannot answer a class condition)."""
    layer = (read.get("layers") or {}).get("nucsz")
    if not isinstance(layer, dict):
        return None
    intervals = layer.get("intervals")
    qualities = layer.get("qualities")
    if intervals is None or not len(intervals) or qualities is None or not len(qualities):
        return None
    coarse = qualities[0]
    if coarse is None:
        return None

    def byte(track: int, index: int, default: float) -> float:
        values = qualities[track] if track < len(qualities) else None
        value = values[index] if values is not None and index < len(values) else None
        return default if value is None else value

    marks = []
    for i, iv in enumerate(intervals):
        if i >= len(coarse) or coarse[i] is None or len(iv) < 2:
            continue
        start, end = _finite_number(iv[0]), _finite_number(iv[1])
        if start is None or end is None:
            continue
        mark = {"start": start, "end": end, "coarse": coarse[i], "named": byte(1, i, 0),
                "posterior": byte(2, i, 0), "z": byte(3, i, NUC_Z_MISSING)}
        # The footprint's molecular length (the interval's third value), kept through clipping.
        length = _finite_number(iv[2]) if len(iv) > 2 else None
        if length is not None:
            mark["len"] = length
        marks.append(mark)
    if not marks:
        return None
    marks.sort(key=lambda mark: (mark["start"], mark["end"]))
    return [mark["start"] for mark in marks], marks, max(mark["end"] - mark["start"] for mark in marks)


def _same_mark_bytes(a: dict[str, float], b: dict[str, float]) -> bool:
    return all(a[key] == b[key] for key in ("coarse", "named", "posterior", "z"))


def nuc_size_mark_for(index, start: float, end: float, length: float | None = None) -> dict[str, float] | None:
    """The mark of an item spanning [start, end) whose molecular length is ``length`` (the item interval's third
    value): the mark with the identical span, else a mark containing the item's midpoint. Among overlapping marks one
    of the item's own length wins, else the one overlapping the item most (ties: the shorter mark). A mark of another
    known length is never the item's (a filter may have removed the item's own mark: no mark, not a neighbour's);
    marks or items without a length match by span. A tie that stays ambiguous (marks with different bytes) gives no
    mark rather than another footprint's."""
    if not index:
        return None
    starts, marks, longest = index
    has_length = length is not None and np.isfinite(length)

    def of_length(pool):
        if not has_length:
            return pool
        same = [mark for mark in pool if mark.get("len") == length]
        return same or [mark for mark in pool if mark.get("len") is None]

    exact = []
    k = bisect_left(starts, start)
    while k < len(marks) and marks[k]["start"] == start:
        if marks[k]["end"] == end:
            exact.append(marks[k])
        k += 1
    pool = of_length(exact)
    if pool:
        return pool[0] if all(_same_mark_bytes(mark, pool[0]) for mark in pool) else None
    mid = (start + end) / 2
    covering = []
    k = bisect_right(starts, mid) - 1
    while k >= 0 and marks[k]["start"] + longest > mid:
        if marks[k]["end"] > mid:
            covering.append(marks[k])
        k -= 1
    best = None
    best_overlap = -np.inf
    ambiguous = False
    for mark in of_length(covering):
        overlap = min(end, mark["end"]) - max(start, mark["start"])
        span = mark["end"] - mark["start"]
        if best is None or overlap > best_overlap or (overlap == best_overlap and span < best["end"] - best["start"]):
            best, best_overlap, ambiguous = mark, overlap, False
        elif overlap == best_overlap and span == best["end"] - best["start"] and not _same_mark_bytes(mark, best):
            ambiguous = True
    return None if ambiguous else best


def nuc_mark_matches(conditions: dict[str, Any], mark: dict[str, float] | None) -> bool:
    """Every set nucleosome condition against an item's mark; no mark never matches."""
    if mark is None:
        return False
    coarse = int(mark["coarse"])
    if conditions["coarse"] is not None and (coarse & 15) not in conditions["coarse"]:
        return False
    if conditions["named"] is not None and mark["named"] not in conditions["named"]:
        return False
    z_min, z_max = conditions["z_min"], conditions["z_max"]
    if z_min is not None or z_max is not None:
        if mark["z"] >= NUC_Z_MISSING:
            return False
        z = (mark["z"] - 128) / 20
        if (z_min is not None and z < z_min) or (z_max is not None and z > z_max):
            return False
    if conditions["tf"] is not None and bool(coarse & NUC_TF_BIT) != conditions["tf"]:
        return False
    return True


def nuc_item_matches(conditions: dict[str, Any] | None, index, layer_name: str | None,
                     start: float, end: float, length: float | None = None) -> bool:
    """An item of ``layer_name`` (None: primary footprints) against a rule's nucleosome conditions (None: none)."""
    if conditions is None:
        return True
    mark = nuc_size_mark_for(index, start, end, length) if layer_name in NUC_MARK_ITEM_LAYERS else None
    return nuc_mark_matches(conditions, mark)


def _conditions_pass(
    rule: dict[str, Any],
    midpoint_abs: float,
    *,
    region_start: int,
    peak_regions: list[tuple[int, int]] | list[list[int]],
    rule_context: dict[str, Any] | None = None,
) -> bool:
    """Evaluate portable conditions supported by backend feature extraction.

    Track/motif conditions require frontend-only signal context and are treated
    as pass-through. Gene, peak, and fixed-region conditions are honored when
    their genomic context is available.
    """
    rule_context = rule_context or {}
    for cond in rule.get("conditions") or []:
        if not isinstance(cond, dict):
            continue
        target = cond.get("target")
        negate = bool(cond.get("negate"))
        matched = True
        if target == "gene":
            gene_regions_by_key = rule_context.get("gene_regions_by_key") or {}
            gene_regions = rule_context.get("gene_regions") or []
            gene_id = cond.get("geneId") or cond.get("gene_id")
            gene_name = cond.get("geneName") or cond.get("gene_name")
            id_regions = gene_regions_by_key.get(f"id:{gene_id}", []) if gene_id else []
            name_regions = gene_regions_by_key.get(f"name:{str(gene_name).lower()}", []) if gene_name else []
            # A named gene that isn't in view matches nothing; only a condition
            # naming no gene means "any gene".
            regions = (id_regions or name_regions) if (gene_id or gene_name) else gene_regions
            matched = any(start <= midpoint_abs < end for start, end in regions)
        elif target == "peak":
            rel_mid = midpoint_abs - region_start
            matched = any(start <= rel_mid < end for start, end in peak_regions)
        elif target == "region":
            chrom_start = cond.get("regionStart", cond.get("region_start"))
            chrom_end = cond.get("regionEnd", cond.get("region_end"))
            if chrom_start is not None and chrom_end is not None:
                left = min(float(chrom_start), float(chrom_end))
                right = max(float(chrom_start), float(chrom_end))
                matched = left <= midpoint_abs < right
        else:
            matched = True
        if negate:
            matched = not matched
        if not matched:
            return False
    return True


def _base_rule_from_term(term: dict[str, Any]) -> dict[str, Any]:
    source = term.get("source", "layer")
    if source == "label_rule" and isinstance(term.get("rule"), dict):
        return term["rule"]
    if source == "footprint_group" and isinstance(term.get("group"), dict):
        return term["group"]
    return term


def _layers_for_term(term: dict[str, Any], base_rule: dict[str, Any]) -> list[str | None]:
    source = term.get("source", "layer")
    if source == "label_rule":
        targets = _camel_or_snake(base_rule, "targetLayers", "target_layers", []) or []
        if targets:
            return [_normalize_layer_name(layer) for layer in targets]
        return [None, "nuc", "tf", "fire"]
    layer = term.get("layer", term.get("source_layer"))
    if layer is None:
        layer = base_rule.get("layer", base_rule.get("source_layer"))
    return [_normalize_layer_name(layer)]


def _size_bounds(term: dict[str, Any], base_rule: dict[str, Any]) -> tuple[float, float | None]:
    size_min = _camel_or_snake(term, "sizeMin", "size_min", None)
    if size_min is None:
        size_min = _camel_or_snake(base_rule, "sizeMin", "size_min", 0)
    size_max = _camel_or_snake(term, "sizeMax", "size_max", None)
    if size_max is None:
        size_max = _camel_or_snake(base_rule, "sizeMax", "size_max", None)
    return float(size_min or 0), (float(size_max) if size_max is not None else None)


def _term_to_rule(term: dict[str, Any], base_rule: dict[str, Any]) -> dict[str, Any]:
    source = term.get("source", "layer")
    size_min, size_max = _size_bounds(term, base_rule)
    quality_gates = (
        _camel_or_snake(term, "qualityGates", "quality_gates", None)
        or _camel_or_snake(base_rule, "qualityGates", "quality_gates", [])
        or []
    )
    if source == "label_rule":
        target_layers = _camel_or_snake(base_rule, "targetLayers", "target_layers", []) or []
    else:
        target_layers = [layer for layer in _layers_for_term(term, base_rule) if layer is not None]
    normalized = {
        "sizeMin": size_min,
        "sizeMax": size_max,
        "targetLayers": target_layers,
        "qualityGates": quality_gates,
        "conditions": base_rule.get("conditions") or term.get("conditions") or [],
    }
    # A labeling rule's nucleosome conditions (only when set, so other rules normalize as before).
    for camel, snake in NUC_RULE_FIELDS:
        value = _camel_or_snake(base_rule, camel, snake, None)
        if value is None:
            value = _camel_or_snake(term, camel, snake, None)
        if value is not None:
            normalized[camel] = value
    return normalized


def _merge_binary_intervals(intervals: list[tuple[int, int, float]]) -> list[tuple[int, int, float]]:
    if not intervals:
        return []
    sorted_intervals = sorted(intervals, key=lambda item: (item[0], item[1]))
    merged: list[tuple[int, int, float]] = []
    for start, end, value in sorted_intervals:
        if end <= start:
            continue
        if not merged or start > merged[-1][1]:
            merged.append((start, end, value))
            continue
        prev_start, prev_end, prev_value = merged[-1]
        merged[-1] = (prev_start, max(prev_end, end), max(prev_value, value))
    return merged


def _cluster_feature_rule_intervals(
    read: dict[str, Any],
    rule: dict[str, Any] | None,
    *,
    region_start: int,
    peak_regions: list[tuple[int, int]] | list[list[int]],
    rule_context: dict[str, Any] | None = None,
) -> list[tuple[int, int, float]]:
    if not rule or rule.get("enabled") is False:
        return []
    matched: list[tuple[int, int, float]] = []
    terms = rule.get("terms") or []
    for term in terms:
        if not isinstance(term, dict):
            continue
        if term.get("source") == "transcription_state":
            # Pol II state terms are evaluated by the sort/filter routes, where
            # transcript IDs and strand-aware state definitions are available.
            continue
        if term.get("source") in ("molecule_metric", "feature_hub"):
            # Not positional: a molecule metric is a column of its own (extract_features_from_compact); hub states
            # drive Filter/Sort and Combinatorial grouping, not interval features.
            continue
        if term.get('source') == 'footprint_class' or (
                term.get('source') == 'footprint_group' and (term.get('group') or {}).get('consensusStateId')):
            if (rule_context or {}).get('_separate_class_columns'):
                continue
            resolver = (rule_context or {}).get('resolve_footprint_class')
            if not resolver:
                raise ValueError('Saved footprint class analysis is required for this clustering rule')
            group = term.get('group') or {}
            if not group.get('consensusStateId') or not group.get('consensusJobId'):
                raise ValueError('Choose a saved footprint class from the Cart')
            matched.extend(resolver(read, group, region_start))
            continue
        base_rule = _base_rule_from_term(term)
        if not isinstance(base_rule, dict):
            continue
        normalized_rule = _term_to_rule(term, base_rule)
        size_min, size_max = _size_bounds(term, base_rule)
        nuc_conditions = nuc_rule_conditions(normalized_rule)
        nuc_index = nuc_size_index(read) if nuc_conditions is not None else None
        for layer_name in _layers_for_term(term, base_rule):
            for iv_start, iv_end, size, actual_layer, qualities in _iter_layer_interval_entries(read, layer_name):
                if size <= 0 or size < size_min:
                    continue
                if size_max is not None and size > size_max:
                    continue
                if not _rule_targets_layer(normalized_rule, actual_layer):
                    continue
                if not _quality_gates_pass(normalized_rule, qualities):
                    continue
                # Nucleosome conditions read the item's own nucsz mark; an item without one fails them.
                if not nuc_item_matches(nuc_conditions, nuc_index, actual_layer, iv_start, iv_end, size):
                    continue
                midpoint_abs = region_start + (iv_start + iv_end) / 2
                if not _conditions_pass(
                    normalized_rule,
                    midpoint_abs,
                    region_start=region_start,
                    peak_regions=peak_regions,
                    rule_context=rule_context,
                ):
                    continue
                matched.append((iv_start, iv_end, 1.0))
    return _merge_binary_intervals(matched)


def _feature_rule_map(cluster_feature_rules) -> dict[str, dict[str, Any]]:
    if isinstance(cluster_feature_rules, dict):
        return {str(key): value for key, value in cluster_feature_rules.items() if isinstance(value, dict)}
    if not isinstance(cluster_feature_rules, list):
        return {}
    return {
        str(rule.get("id")): rule
        for rule in cluster_feature_rules
        if isinstance(rule, dict) and rule.get("id")
    }


def _weighted_intervals_for_mode(
    read: dict[str, Any],
    mode: str,
    intervals: Iterable[list],
    subnucleosomal_threshold: int,
    *,
    region_start: int = 0,
    peak_regions: list[tuple[int, int]] | list[list[int]] | None = None,
    cluster_feature_rules: dict[str, dict[str, Any]] | None = None,
    cluster_rule_context: dict[str, Any] | None = None,
) -> list[tuple[int, int, float]]:
    """Resolve a peak mode into weighted intervals for one read.

    Most modes are binary presence features. The legacy `tf` fallback keeps
    its historic normalized footprint-size behavior so the compact fast path
    matches the older DataFrame clustering path.
    """
    layers = read.get("layers") or {}
    intervals = list(intervals)

    if mode.startswith(CLUSTER_RULE_MODE_PREFIX):
        rule_id = mode[len(CLUSTER_RULE_MODE_PREFIX):]
        rule = (cluster_feature_rules or {}).get(rule_id)
        return _cluster_feature_rule_intervals(
            read,
            rule,
            region_start=region_start,
            peak_regions=peak_regions or [],
            rule_context=cluster_rule_context,
        )

    if mode in ("msp", "fire"):
        # FIRE calls only: a read without any (or whose calls were all filtered
        # out, leaving an empty layer) has none here, not accessible gaps.
        layer = layers.get("msp")
        if layer is not None:
            return [(iv[0], iv[1], 1.0) for iv in layer.get("intervals") or []]
        return [(iv[0], iv[1], 1.0) for iv in read.get("fire") or []]

    if mode == "accessibility":
        # A present layer is authoritative, even when a quality gate emptied it.
        layer = layers.get("msp")
        if layer is not None:
            return [(iv[0], iv[1], 1.0) for iv in layer.get("intervals") or []]
        fire_intervals = read.get("fire")
        if fire_intervals:
            return [(iv[0], iv[1], 1.0) for iv in fire_intervals]
        # No FIRE calls (e.g. DAF-seq): accessible = gaps and short footprints.
        return [
            (iv[0], iv[1], 1.0)
            for iv in intervals
            if iv[2] < subnucleosomal_threshold
        ]

    # (tf_density: the peak scan's TF-footprint-density source; the same feature.)
    if mode in ("tf", "tf_layer", "tf_density"):
        layer = layers.get("tf")
        if layer is not None:
            return [
                (
                    iv[0],
                    iv[1],
                    float(np.clip((iv[2] if len(iv) > 2 else subnucleosomal_threshold) / subnucleosomal_threshold, 0, 1)),
                )
                for iv in layer.get("intervals") or []
            ]
        return [
            (iv[0], iv[1], float(np.clip(iv[2] / subnucleosomal_threshold, 0, 1)))
            for iv in intervals
            if 0 < iv[2] < subnucleosomal_threshold
        ]

    if mode in ("nuc", "nuc_layer"):
        layer = layers.get("nuc")
        if layer is not None:
            return [(iv[0], iv[1], 1.0) for iv in layer.get("intervals") or []]
        return [
            (iv[0], iv[1], 1.0)
            for iv in intervals
            if iv[2] >= subnucleosomal_threshold
        ]

    if mode.startswith(NUC_MODE_PREFIXES):
        return _nuc_mode_intervals(layers, mode)

    layer = layers.get(mode)
    if layer and layer.get("intervals"):
        return [(iv[0], iv[1], 1.0) for iv in layer["intervals"]]
    return []


# Nucleosome modes (NUC §7.1 Cluster): a coarse size class of the nucsz marks, a segment state or an event of nucseg.
NUC_MODE_PREFIXES = ("nuc.size.", "nuc.seg.", "nuc.event.")
NUC_SIZE_CODES = {"cant_tell": 0, "short": 1, "mono": 2, "long": 3, "multi2": 4, "multi3": 5, "edge_truncated": 6}
NUC_SEG_CODES = {"regular": 1, "disordered": 2, "low_information": 3, "undetermined": 4}
NUC_EVENT_CODES = {"undersized": 16, "missing": 17}


def _nuc_mode_intervals(layers: dict, mode: str) -> list[tuple[int, int, float]]:
    """The intervals of a nucleosome mode: nucsz marks of one coarse class ('tf': TF calls or footprints overlapping
    one), nucseg segments of one state, or nucseg events of one kind (first byte of each mark)."""
    group = "nucsz" if mode.startswith("nuc.size.") else "nucseg"
    layer = layers.get(group) or {}
    ivs = layer.get("intervals") or []
    codes = (layer.get("qualities") or [None])[0]
    if not ivs or codes is None:
        return []
    name = mode.split(".", 2)[2]
    if mode.startswith("nuc.size."):
        if name == "tf":
            keep = lambda q: bool(int(q) & 16)
        elif name in NUC_SIZE_CODES:
            code = NUC_SIZE_CODES[name]
            keep = lambda q: (int(q) & 15) == code
        else:
            return []
    else:
        code = (NUC_SEG_CODES if mode.startswith("nuc.seg.") else NUC_EVENT_CODES).get(name)
        if code is None:
            return []
        keep = lambda q: int(q) == code
    return [(iv[0], iv[1], 1.0) for iv, q in zip(ivs, codes) if keep(q)]


def _molecule_metric_terms(terms) -> list:
    return [t for t in terms or () if t.get("source") == "molecule_metric" and t.get("moleculeMetric")]


def class_aware_pattern_slices(peak_widths, peak_modes, rules):
    """Keep each class bit separate in combinatorial clustering and reassignment."""
    lookup = _feature_rule_map(rules)
    offset = 0
    output = []
    for i, width in enumerate(peak_widths):
        mode = peak_modes[i] if i < len(peak_modes) else ''
        rule = lookup.get(mode[len(CLUSTER_RULE_MODE_PREFIX):], {}) if mode.startswith(CLUSTER_RULE_MODE_PREFIX) else {}
        terms = rule.get('terms', []) if rule.get('enabled') is not False else []
        count = sum(t.get('source') == 'footprint_class' or
                    (t.get('source') == 'footprint_group' and bool((t.get('group') or {}).get('consensusStateId'))) for t in terms)
        # Molecule metric columns are binary-like too: a percentile rank, split at the median (0.5).
        count += len(_molecule_metric_terms(terms))
        spatial = width - count
        if spatial > 0 or not count:
            output.append((i, offset, max(0, spatial), False))
        for j in range(count):
            output.append((i, offset + spatial + j, 1, True))
        offset += width
    return output


def extract_features_from_compact(
    compact_reads,
    peak_regions,
    region_start,
    step=10,
    subnucleosomal_threshold=90,
    peak_modes=None,
    cluster_feature_rules=None,
    cluster_rule_context=None,
    peak_positions=None,
    metric_cohort=None,
):
    """Extract clustering features directly from compact reads.

    The return shape and mode semantics match the legacy
    `server.extract_features_from_compact` API:
    `(features, read_ids, peak_widths, peak_modes_used)`.

    `metric_cohort` (:func:`molecule_metric_cohort`, or a fit's :func:`fitted_metric_cohort`): the known values
    each molecule metric column ranks against, when these reads are a part (a window, a view) of a larger or an
    earlier cohort; by default the reads given.
    """
    if not compact_reads or not peak_regions:
        return np.array([]), [], [], []

    if peak_modes is None:
        peak_modes = ["accessibility"] * len(peak_regions)
    cluster_feature_rules_by_id = _feature_rule_map(cluster_feature_rules)

    peak_col_info = []
    class_columns = []
    metric_columns = []
    class_widths = []
    cluster_rule_context = {**(cluster_rule_context or {}), '_separate_class_columns': True}
    total_cols = 0

    for i, (left, right) in enumerate(peak_regions):
        mode = peak_modes[i] if i < len(peak_modes) else "accessibility"
        if mode == "off":
            peak_col_info.append((total_cols, [], mode))
            class_widths.append(0)
            continue

        positions = list(peak_positions[i]) if peak_positions is not None else list(range(region_start + left, region_start + right, step))
        rule = cluster_feature_rules_by_id.get(mode[len(CLUSTER_RULE_MODE_PREFIX):], {}) if mode.startswith(CLUSTER_RULE_MODE_PREFIX) else {}
        terms = rule.get('terms', []) if rule.get('enabled') is not False else []
        class_terms = [t for t in terms if t.get('source') == 'footprint_class' or
                       (t.get('source') == 'footprint_group' and (t.get('group') or {}).get('consensusStateId'))]
        metric_terms = _molecule_metric_terms(terms)
        if (class_terms or metric_terms) and len(class_terms) + len(metric_terms) == len(terms):
            positions = []
        peak_col_info.append((total_cols, positions, mode))
        total_cols += len(positions)
        for term in class_terms:
            class_columns.append((total_cols, term, left, right))
            total_cols += 1
        for term in metric_terms:
            metric_columns.append((total_cols, term))
            total_cols += 1
        class_widths.append(len(class_terms) + len(metric_terms))

    if total_cols == 0:
        return np.array([]), [], [], [info[2] for info in peak_col_info]

    features = np.zeros((len(compact_reads), total_cols), dtype=np.float32)
    read_ids = [read.get("analysis_id") or read["id"] for read in compact_reads]

    for read_idx, read in enumerate(compact_reads):
        for col, term, left, right in class_columns:
            resolver = cluster_rule_context.get('resolve_footprint_class')
            group = term.get('group') or {}
            if not resolver or not group.get('consensusStateId') or not group.get('consensusJobId'):
                raise ValueError('Choose a saved footprint class from the Cart and restore its analysis')
            spans = resolver(read, group, region_start)
            features[read_idx, col] = float(any(a < right and b > left for a, b, _ in spans))
        intervals = read.get("intervals", [])
        methyl_m6a = m6a_positions(read)
        methyl_m5c = read.get("methyl_m5c") or []
        deam_events = read.get("deam") or []
        deam_positions = sorted(event[0] for event in deam_events) if deam_events else []
        interval_cache: dict[str, tuple[list[tuple[int, int, float]], list[int]]] = {}

        for start_col_idx, positions, mode in peak_col_info:
            if mode == "off" or not positions:
                continue

            if mode in ("mod", "modification", "m6a", "m5c", "deam"):
                if mode == "m5c":
                    mark_list = methyl_m5c
                elif mode == "deam":
                    mark_list = deam_positions
                else:
                    mark_list = methyl_m6a
                if not mark_list:
                    continue

                for pos_offset, abs_pos in enumerate(positions):
                    rel_pos = abs_pos - region_start
                    lo = bisect_left(mark_list, rel_pos - step // 2)
                    hi = bisect_right(mark_list, rel_pos + step // 2)
                    if hi > lo:
                        features[read_idx, start_col_idx + pos_offset] = 1.0
                continue

            cached = interval_cache.get(mode)
            if cached is None:
                weighted_intervals = _weighted_intervals_for_mode(
                    read,
                    mode,
                    intervals,
                    subnucleosomal_threshold,
                    region_start=region_start,
                    peak_regions=peak_regions,
                    cluster_feature_rules=cluster_feature_rules_by_id,
                    cluster_rule_context=cluster_rule_context,
                )
                if read.get("live_lift"):
                    from services.read_selection import read_body_spans
                    weighted_intervals = sorted((max(a, x), min(b, y), value)
                        for a, b, value in weighted_intervals for x, y in read_body_spans(read)
                        if min(b, y) > max(a, x))
                starts = [start for start, _, _ in weighted_intervals]
                interval_cache[mode] = (weighted_intervals, starts)
            else:
                weighted_intervals, starts = cached

            if not weighted_intervals:
                continue

            for pos_offset, abs_pos in enumerate(positions):
                rel_pos = abs_pos - region_start
                interval_idx = bisect_right(starts, rel_pos) - 1
                if interval_idx < 0:
                    continue
                start, end, value = weighted_intervals[interval_idx]
                if start <= rel_pos < end:
                    features[read_idx, start_col_idx + pos_offset] = value

    if metric_columns:
        _fill_metric_columns(features, compact_reads, metric_columns, metric_cohort)

    peak_widths = [len(info[1]) + class_widths[i] for i, info in enumerate(peak_col_info)]
    peak_modes_used = [info[2] for info in peak_col_info]
    return features, read_ids, peak_widths, peak_modes_used


def molecule_metric_ids(peak_modes, cluster_feature_rules) -> list[str]:
    """The molecule metrics the cluster columns of these modes read (enabled cluster rules' molecule_metric terms)."""
    lookup = _feature_rule_map(cluster_feature_rules)
    ids: list[str] = []
    for mode in peak_modes or ():
        if not str(mode).startswith(CLUSTER_RULE_MODE_PREFIX):
            continue
        rule = lookup.get(str(mode)[len(CLUSTER_RULE_MODE_PREFIX):], {})
        if rule.get("enabled") is False:
            continue
        for term in _molecule_metric_terms(rule.get("terms")):
            if term["moleculeMetric"] not in ids:
                ids.append(term["moleculeMetric"])
    return ids


def molecule_metric_values(compact_reads, metric_id) -> list:
    """Each read's scalar (None: missing)."""
    from services.nuc.scalars import metric_value
    return [metric_value(read, metric_id) for read in compact_reads]


def molecule_metric_cohort(compact_reads, metric_ids) -> dict[str, list[float]]:
    """Each metric's known values over a whole cohort, sorted: what every block or window of it ranks against."""
    return {metric_id: sorted(v for v in molecule_metric_values(compact_reads, metric_id) if v is not None)
            for metric_id in metric_ids}


def metric_cohort_counts(known) -> dict[str, list]:
    """A cohort's known values as distinct sorted ``values`` with their ``counts``: every multiplicity kept, so
    :func:`metric_percentile_ranks` gives exactly the full cohort's ranks, in the space of its distinct values."""
    values: list[float] = []
    counts: list[int] = []
    for v in sorted(float(x) for x in known if x is not None):
        if values and values[-1] == v:
            counts[-1] += 1
        else:
            values.append(v)
            counts.append(1)
    return {"values": values, "counts": counts}


def fitted_metric_cohort(compact_reads, peak_modes, cluster_feature_rules) -> dict:
    """The cohort each molecule metric column of a fit ranked against (the fitted reads), exact
    (:func:`metric_cohort_counts`), to keep with the fitted model (patterns, centroids) so assigning reads later
    ranks them the same way; {} when the fit has no metric column."""
    ids = molecule_metric_ids(peak_modes, cluster_feature_rules)
    if not ids:
        return {}
    return {metric_id: metric_cohort_counts(known) for metric_id, known in molecule_metric_cohort(compact_reads, ids).items()}


def metric_percentile_ranks(values, known=None) -> np.ndarray:
    """Molecule metric column values (NUC §7.1 Cluster): each value's percentile rank among the known values
    (mid-rank, 0..1, so a median split is 0.5, as combinatorial grouping reads class bits); a missing value, or a
    cohort of fewer than two known values, gives the median (0.5). ``known``: the sorted known values, or their
    distinct values with counts (:func:`metric_cohort_counts`); by default ``values``' own."""
    if isinstance(known, dict):
        distinct = [float(v) for v in known.get("values") or ()]
        counts = [int(c) for c in known.get("counts") or ()]
        if len(counts) != len(distinct):
            raise ValueError("A metric cohort needs one count per value")
        below = [0]   # below[k]: known values smaller than distinct[k]
        for c in counts:
            below.append(below[-1] + c)
        n = below[-1]
        ranks = np.full(len(values), 0.5, dtype=np.float32)
        if n < 2:
            return ranks
        for i, v in enumerate(values):
            if v is None:
                continue
            k = bisect_left(distinct, v)
            lo = below[k]
            hi = lo + (counts[k] if k < len(distinct) and distinct[k] == v else 0)
            ranks[i] = ((lo + hi) / 2) / n
        return ranks
    if known is None:
        known = sorted(v for v in values if v is not None)
    n = len(known)
    ranks = np.full(len(values), 0.5, dtype=np.float32)
    if n < 2:
        return ranks
    for i, v in enumerate(values):
        if v is None:
            continue
        lo, hi = bisect_left(known, v), bisect_right(known, v)
        ranks[i] = ((lo + hi) / 2) / n
    return ranks


def molecule_metric_slots(peak_widths, peak_modes, cluster_feature_rules) -> dict[int, str]:
    """Feature column -> molecule metric, for the metric columns of an extraction (the last columns of each rule
    peak's block, in term order, as :func:`extract_features_from_compact` lays them out)."""
    lookup = _feature_rule_map(cluster_feature_rules)
    slots: dict[int, str] = {}
    offset = 0
    for i, width in enumerate(peak_widths):
        mode = str(peak_modes[i]) if i < len(peak_modes) else ""
        rule = lookup.get(mode[len(CLUSTER_RULE_MODE_PREFIX):], {}) if mode.startswith(CLUSTER_RULE_MODE_PREFIX) else {}
        terms = rule.get("terms", []) if rule.get("enabled") is not False else []
        metric_terms = _molecule_metric_terms(terms)
        first = offset + width - len(metric_terms)
        for j, term in enumerate(metric_terms):
            slots[first + j] = term["moleculeMetric"]
        offset += width
    return slots


def _fill_metric_columns(features, compact_reads, metric_columns, metric_cohort=None) -> None:
    """Molecule metric columns: percentile ranks (:func:`metric_percentile_ranks`) against the cohort's known values
    (``metric_cohort``; by default these reads')."""
    for col, term in metric_columns:
        metric_id = term.get("moleculeMetric")
        known = (metric_cohort or {}).get(metric_id)
        features[:, col] = metric_percentile_ranks(molecule_metric_values(compact_reads, metric_id), known)


def extract_features_grouped(compact_reads, peak_regions, region_start, groups=None, **kwargs):
    """`extract_features_from_compact`, per window for reads at other loci.

    `groups` maps a read's `_cluster_group` (a clustering window) to that
    window's `(peaks, region_start, cluster_rule_context)`. Its peaks are
    matched one-to-one and in width to `peak_regions`, so every window's
    features share columns. Reads of other groups use the arguments as given.
    """
    if not groups:
        return extract_features_from_compact(compact_reads, peak_regions, region_start, **kwargs)
    # Molecule metric columns rank against the whole cohort, not each window's reads.
    if kwargs.get("metric_cohort") is None:
        metric_ids = molecule_metric_ids(kwargs.get("peak_modes"), kwargs.get("cluster_feature_rules"))
        if metric_ids:
            kwargs = {**kwargs, "metric_cohort": molecule_metric_cohort(compact_reads, metric_ids)}
    by_group = {}
    for read in compact_reads:
        by_group.setdefault(read.get("_cluster_group"), []).append(read)
    blocks, read_ids, peak_widths, peak_modes_used = [], [], None, None
    for group, reads in by_group.items():
        if group in groups:
            peaks, start, context, *positions = groups[group]
            X, ids, widths, modes = extract_features_from_compact(
                reads, peaks, start, **{**kwargs, "cluster_rule_context": context, **({"peak_positions": positions[0]} if positions else {})})
        else:
            X, ids, widths, modes = extract_features_from_compact(reads, peak_regions, region_start, **kwargs)
        if len(ids) == 0:
            continue
        if peak_widths is None:
            peak_widths, peak_modes_used = widths, modes
        elif list(widths) != list(peak_widths):
            raise ValueError("Matched peaks differ in width between windows")
        blocks.append(X)
        read_ids.extend(ids)
    if not blocks:
        return np.array([]), [], [], []
    return np.vstack(blocks), read_ids, peak_widths, peak_modes_used


def resample_feature_blocks(
    features: np.ndarray,
    peak_widths: list[int],
    bins_per_feature: int,
    *,
    reverse: bool = False,
) -> np.ndarray:
    """Resample variable-width feature blocks onto one shared geometry.

    ``features`` holds one block of ``peak_widths[i]`` columns per feature (as
    returned by :func:`extract_features_from_compact`). Every block becomes
    exactly ``bins_per_feature`` columns by linear interpolation along the
    feature, so two views whose matched features differ in width and absolute
    position fill the same columns; the 0..1 values are not rescaled.

    ``reverse`` reads the view the other way round: the features are taken
    last to first and each block is flipped, i.e. the whole resampled row is
    mirrored. Use it for an inverted locus, so feature 1 of one view is matched
    with the last feature of the other and both are read in the same direction.
    """
    n_rows = features.shape[0] if features.ndim == 2 else 0
    if n_rows == 0 or not peak_widths:
        return np.empty((n_rows, 0), dtype=np.float32)
    bins = max(2, int(bins_per_feature))
    target_x = np.linspace(0.0, 1.0, bins)
    blocks = []
    offset = 0
    for width in peak_widths:
        width = max(0, int(width))
        block = features[:, offset:offset + width].astype(np.float32, copy=False)
        offset += width
        if block.shape[1] == 0:
            resized = np.zeros((n_rows, bins), dtype=np.float32)
        elif block.shape[1] == 1:
            resized = np.repeat(block, bins, axis=1)
        else:
            source_x = np.linspace(0.0, 1.0, block.shape[1])
            resized = np.vstack([np.interp(target_x, source_x, row) for row in block]).astype(np.float32)
        blocks.append(resized)
    out = np.hstack(blocks)
    return out[:, ::-1].copy() if reverse else out
