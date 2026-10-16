"""User-facing layer alias normalization shared by API/Jupyter boundaries."""
from __future__ import annotations

from typing import Any


_ALIASES = {
    "tf_layer": "tf",
    "nuc_layer": "nuc",
    "nucleosome": "nuc",
    "nucleosomes": "nuc",
    "msp": "fire",
    "msp_layer": "fire",
    "methyl_m6a": "m6a",
    "methyl_m5c": "m5c",
}


def normalize_annotation_layer(layer: Any) -> str | None:
    if layer is None:
        return None
    raw = str(layer).strip()
    if not raw:
        return None
    lookup = raw.lower().replace("-", "_")
    if lookup in {"none", "null", "default", "all"}:
        return None
    return _ALIASES.get(lookup, raw)


def normalize_layer_list(layers: Any) -> list[str]:
    if layers is None:
        return []
    values = layers.split(",") if isinstance(layers, str) else layers
    if not isinstance(values, (list, tuple, set)):
        return []
    out: list[str] = []
    seen = set()
    for value in values:
        layer = normalize_annotation_layer(value)
        if layer and layer not in seen:
            out.append(layer)
            seen.add(layer)
    return out


def normalize_layer_toggle_map(values: Any) -> dict[str, Any]:
    if not isinstance(values, dict):
        return {}
    out: dict[str, Any] = {}
    for key, value in values.items():
        layer = normalize_annotation_layer(key)
        if layer:
            out[layer] = value
    return out


def normalize_quality_filters(filters: Any) -> list[dict[str, Any]]:
    if not isinstance(filters, list):
        return []
    out: list[dict[str, Any]] = []
    for filt in filters:
        if not isinstance(filt, dict):
            continue
        layer = filt.get("layer", "*")
        normalized = "*" if str(layer or "*").strip() == "*" else normalize_annotation_layer(layer)
        out.append({**filt, "layer": normalized or "*"})
    return out


def normalize_colormap_layers(colormap: Any) -> Any:
    if not isinstance(colormap, dict):
        return colormap
    out = dict(colormap)
    if "qualityFilters" in out:
        out["qualityFilters"] = normalize_quality_filters(out.get("qualityFilters"))
    rules = out.get("rules")
    if isinstance(rules, list):
        normalized_rules = []
        for rule in rules:
            if not isinstance(rule, dict):
                normalized_rules.append(rule)
                continue
            normalized_rules.append({
                **rule,
                "targetLayers": normalize_layer_list(rule.get("targetLayers", [])),
            })
        out["rules"] = normalized_rules
    return out


def normalize_footprint_groups(groups: Any) -> list[dict[str, Any]]:
    if not isinstance(groups, list):
        return []
    out: list[dict[str, Any]] = []
    for group in groups:
        if isinstance(group, dict):
            out.append({**group, "layer": normalize_annotation_layer(group.get("layer"))})
    return out


def normalize_coacc_settings(settings: Any) -> Any:
    if not isinstance(settings, dict):
        return settings
    out = dict(settings)
    if "coaccLayer" in out:
        out["coaccLayer"] = normalize_annotation_layer(out.get("coaccLayer"))
    return out


def normalize_jupyter_settings(updates: dict[str, Any]) -> dict[str, Any]:
    """Normalize user-facing layer aliases in Jupyter settings payloads."""
    normalized = dict(updates)
    if "profile_read_cap" in normalized:
        normalized["background_read_cap"] = normalized.pop("profile_read_cap")
    for key in ("enabled_mod_types", "enabled_meta_profiles", "cached_layer_types"):
        if key in normalized:
            normalized[key] = normalize_layer_toggle_map(normalized[key])
    for key in ("click_target_layer", "footprint_analysis_layer"):
        if key in normalized:
            normalized[key] = normalize_annotation_layer(normalized[key])
    if "active_colormap" in normalized:
        normalized["active_colormap"] = normalize_colormap_layers(normalized["active_colormap"])
    if "active_quality_filters" in normalized:
        normalized["active_quality_filters"] = normalize_quality_filters(normalized["active_quality_filters"])
    if "footprint_groups" in normalized:
        normalized["footprint_groups"] = normalize_footprint_groups(normalized["footprint_groups"])
    if "coacc_settings" in normalized:
        normalized["coacc_settings"] = normalize_coacc_settings(normalized["coacc_settings"])
    return normalized
