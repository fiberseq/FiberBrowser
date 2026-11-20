"""What the browser does by default, for renders with no browser state.

The static parts (settings, labeling, track order and heights, layer colours)
come from browser/data/figure_defaults.json, generated from the frontend by
src/utils/figureDefaults.test.ts. The few bits of logic that depend on the
loaded datasets are ported here and checked against that file's cases
(tests/test_figure_defaults.py).
"""
from __future__ import annotations

import colorsys
import math
import json
import os
from functools import lru_cache
from typing import Any, Iterable, Optional

_FILE = os.path.join(os.path.dirname(__file__), "..", "..", "data", "figure_defaults.json")


@lru_cache(maxsize=1)
def defaults() -> dict:
    with open(_FILE, "r", encoding="utf-8") as handle:
        return json.load(handle)


def _js_hash(name: str) -> int:
    """JavaScript's ``hash = ((hash << 5) - hash + c) | 0`` over UTF-16 code units."""
    h = 0
    for code in name.encode("utf-16-le").decode("utf-16-le"):
        h = ((h << 5) - h + ord(code)) & 0xFFFFFFFF
    return h - 0x100000000 if h >= 0x80000000 else h


def _hue_hex(hue: float, saturation: float = 0.7, lightness: float = 0.5) -> str:
    """Port of the browser's hslToHex (layerColors.ts), rounding like Math.round."""
    h = hue % 360
    c = (1 - abs(2 * lightness - 1)) * saturation
    x = c * (1 - abs((h / 60) % 2 - 1))
    m = lightness - c / 2
    r, g, b = ((c, x, 0) if h < 60 else (x, c, 0) if h < 120 else (0, c, x) if h < 180
               else (0, x, c) if h < 240 else (x, 0, c) if h < 300 else (c, 0, x))
    return "#" + "".join("%02x" % math.floor((channel + m) * 255 + 0.5) for channel in (r, g, b))


_FILE_LAYER_TYPES = {"bam", "bigbed", "bb", "cram"}


def _js_round(x: float) -> int:
    return math.floor(x + 0.5)


def _extra_palette_color(slot: int) -> str:
    """Port of extraLayerPaletteColor (layerColors.ts): past the palette, a lightness step."""
    palette = defaults()["extraLayerPalette"]
    n = len(palette)
    base = palette[slot % n]
    cycle = max(0, slot) // n
    if cycle == 0:
        return base
    step = min(math.ceil(cycle / 2) * 0.28, 0.7)
    toward = 0 if cycle % 2 == 1 else 255
    rgb = [int(base[i:i + 2], 16) for i in (1, 3, 5)]
    return "#" + "".join("%02x" % _js_round(c + (toward - c) * step) for c in rgb)


def assign_extra_layer_colors(datasets: Iterable[dict]) -> dict:
    """Port of assignExtraLayerColors (layerColors.ts): the loaded datasets' layers without a
    curated colour get palette slots in sorted key order; a layer's own colour (derived
    layer ``color``) is kept and its palette slot skipped."""
    datasets = [dataset_dict(d) for d in (datasets or [])]
    curated = set(defaults()["curatedLayerKeys"])
    keys, taken, own = set(), set(), set()
    for d in datasets:
        for name, meta in (d.get("derived_layers") or {}).items():
            color = meta.get("color") if isinstance(meta, dict) else None
            if isinstance(color, str) and color:
                taken.add(color.lower())
                own.add(name)
            else:
                keys.add(name)
        for name, present in (d.get("available_layers") or {}).items():
            if present:
                keys.add(name)
        lt = d.get("layer_type")
        if lt and lt not in _FILE_LAYER_TYPES:
            keys.add(lt)
    keys -= own
    out, slot, n = {}, 0, len(defaults()["extraLayerPalette"])
    for key in sorted(k for k in keys if k not in curated):
        color = _extra_palette_color(slot)
        guard = 0
        while color.lower() in taken and guard < 4 * n:
            slot += 1
            guard += 1
            color = _extra_palette_color(slot)
        out[key] = color
        taken.add(color.lower())
        slot += 1
    return out




def layer_color(name: str, extra: dict | None = None) -> str:
    """Same as the browser's getLayerColor: curated; else the loaded set's palette colour
    (``extra``, from ``assign_extra_layer_colors``); else a palette colour by name hash."""
    known = defaults()["layers"].get(name)
    if known and name in set(defaults()["curatedLayerKeys"]) and not str(known["color"]).startswith("hsl"):
        return known["color"]
    if extra and extra.get(name):
        return extra[name]
    palette = defaults()["extraLayerPalette"]
    return palette[abs(_js_hash(name)) % len(palette)]


def layer_label(name: str) -> str:
    known = defaults()["layers"].get(name)
    return known["label"] if known else name


def hsl_to_hex(text: str) -> str:
    """'hsl(210 70% 50%)' -> '#rrggbb' (for backends that need RGB)."""
    inner = text[text.index("(") + 1:text.rindex(")")].replace(",", " ").replace("%", "")
    h, s, l = (float(v) for v in inner.split()[:3])
    r, g, b = colorsys.hls_to_rgb(h / 360, l / 100, s / 100)
    return "#%02x%02x%02x" % (round(r * 255), round(g * 255), round(b * 255))


_HANDLED = {
    "nuc", "footprint", "tf", "msp", "fire", "deam", "mod", "m6a", "m5c",
    "nuc_sr", "tf_sr", "tf_consensus", "tf_cross_consensus", "deam_opportunity",
}
_FILE_TYPES = {"bam", "bigbed", "bb", "cram"}


def metaprofile_source_entries(datasets: Iterable[dict]) -> list[dict]:
    """Port of getMetaprofileSourceEntries: which layers a metaprofile can show."""
    datasets = list(datasets)

    def has(name: str) -> bool:
        for d in datasets:
            layers = d.get("available_layers") or {}
            if layers.get(name) or d.get("layer_type") == name:
                return True
            if name == "m6a" and (layers.get("mod") or d.get("layer_type") == "mod"):
                return True
            if name == "fire" and (layers.get("msp") or d.get("layer_type") == "msp"):
                return True
        return False

    derived: dict[str, dict] = {}
    for d in datasets:
        for key, meta in (d.get("derived_layers") or {}).items():
            derived[key] = meta or {}

    entries: list[dict] = []
    seen: set[str] = set()

    def push(key: str, label: str) -> None:
        if key not in seen:
            seen.add(key)
            entries.append({"key": key, "label": label})

    has_tf = has("tf")
    if has("nuc"):
        push("nuc", "Nuc" if has_tf else "FP")
    elif has("footprint"):
        push("footprint", "Nuc" if has_tf else "FP")
    if has_tf:
        push("tf", "TF")
    if has("fire"):
        push("fire", layer_label("fire"))
    if has("deam"):
        push("deam", "Deam")
    if has("m6a"):
        push("m6a", "m6A")
    if has("m5c"):
        push("m5c", "5mC")
    for d in datasets:
        lt = d.get("layer_type")
        if lt and lt not in _HANDLED and lt not in _FILE_TYPES:
            push(lt, layer_label(lt))
        for name, present in (d.get("available_layers") or {}).items():
            if present and name not in _HANDLED and name not in derived:
                push(name, layer_label(name))
    for key, meta in derived.items():
        if has(key):
            push(key, meta.get("label") or key)
    return entries


def layer_toggle_on(key: str, enabled: Optional[dict]) -> bool:
    """Port of utils/defaultMetaprofile.ts layerToggleOn: is this layer's Tracks checkbox on?"""
    enabled = enabled or {}
    k = _normalize_layer(key)
    if k == "nuc":
        return bool(enabled["nuc"] if "nuc" in enabled else enabled.get("footprint"))
    if k == "footprint":
        return bool(enabled["footprint"] if "footprint" in enabled else enabled.get("nuc"))
    if k == "fire":
        return bool(enabled.get("fire") or enabled.get("msp"))
    if k in ("m6a", "mod"):
        return bool(enabled.get("m6a") or enabled.get("mod"))
    return bool(enabled.get(k))


def _default_enabled_mod_types() -> dict:
    return dict((defaults().get("settings") or {}).get("enabledModTypes") or {})


_LAYER_ALIASES = {"tf_layer": "tf", "nuc_layer": "nuc", "nucleosome": "nuc", "nucleosomes": "nuc", "msp": "fire",
                  "msp_layer": "fire", "methyl_m6a": "m6a", "methyl_m5c": "m5c"}


def _normalize_layer(layer) -> str:
    """Port of utils/layerAliases.ts normalizeAnnotationLayer (the raw name when it is no alias)."""
    raw = str(layer or "").strip()
    return _LAYER_ALIASES.get(raw.lower().replace("-", "_"), raw)


def _canonical_metaprofile_key(rule_id) -> str:
    """Port of canonicalMetaprofileKey: aliases normalised, then footprint -> nuc, mod -> m6a."""
    k = _normalize_layer(rule_id)
    return {"footprint": "nuc", "mod": "m6a"}.get(k, k)


def refresh_auto_source_colors(composites: list, datasets: Iterable[dict]) -> list:
    """Port of refreshAutoSourceColors: the default metaprofile's sources with a default colour (autoColor, or
    3.0.6's name-hash colour on an older source) of an uncurated layer take the loaded set's colour."""
    default_id = defaults()["defaultMetaprofileId"]
    curated = set(defaults()["curatedLayerKeys"])
    extra = assign_extra_layer_colors(datasets)
    out = []
    for comp in composites:
        if not isinstance(comp, dict) or comp.get("id") != default_id:
            out.append(comp)
            continue
        sources = []
        for src in comp.get("sources") or []:
            ref = (src or {}).get("ref") or {}
            key = ref.get("ruleId")
            if ref.get("kind") == "metaprofile" and key and key not in curated:
                auto = src.get("autoColor")
                legacy = _hue_hex(abs(_js_hash(key)) % 360)
                if auto is True or (auto is None and str(src.get("color") or "").lower() == legacy):
                    src = {**src, "color": layer_color(key, extra), "autoColor": True}
            sources.append(src)
        out.append({**comp, "sources": sources})
    return out


def apply_follow_active_layers(composites: list, enabled: Optional[dict], datasets: Iterable[dict]) -> list:
    """Port of applyFollowActiveLayers: while the default metaprofile follows (followActiveLayers not false), its
    layer sources are visible exactly when their layer is on. Rule-id and other sources are left alone."""
    default_id = defaults()["defaultMetaprofileId"]
    datasets = list(datasets)
    # Layer sources match by alias (footprint/nuc, mod/m6a, msp/fire), as utils/defaultMetaprofile.ts isLayerSource.
    layer_keys = {_canonical_metaprofile_key(e["key"]) for e in metaprofile_source_entries(datasets)}
    toggles = enabled if enabled is not None else _default_enabled_mod_types()
    out = []
    for comp in composites:
        if not isinstance(comp, dict) or comp.get("id") != default_id or comp.get("followActiveLayers") is False:
            out.append(comp)
            continue
        sources = []
        for src in comp.get("sources") or []:
            ref = (src or {}).get("ref") or {}
            if ref.get("kind") == "metaprofile" and _canonical_metaprofile_key(ref.get("ruleId")) in layer_keys:
                src = {**src, "visible": layer_toggle_on(ref["ruleId"], toggles)}
            sources.append(src)
        out.append({**comp, "sources": sources})
    return out


def default_metaprofile(datasets: Iterable[dict], enabled_mod_types: Optional[dict] = None) -> dict:
    """The browser's seeded default metaprofile composite for these datasets (following the active layers)."""
    datasets = list(datasets)
    extra = assign_extra_layer_colors(datasets)
    d = defaults()
    toggles = enabled_mod_types if enabled_mod_types is not None else _default_enabled_mod_types()
    sources = [
        {
            "id": f"default-{entry['key']}",
            "ref": {"kind": "metaprofile", "ruleId": entry["key"]},
            "color": layer_color(entry["key"], extra),
            **({} if entry["key"] in set(d["curatedLayerKeys"]) else {"autoColor": True}),
            "visible": layer_toggle_on(entry["key"], toggles),
            "negate": False,
            "scale": 1,
        }
        for entry in metaprofile_source_entries(datasets)
    ]
    return {
        "id": d["defaultMetaprofileId"], "label": "Metaprofile", "kind": "metaprofile", "sources": sources,
        "scaleMode": "per-source", "logScale": False, "visible": True, "showAxes": True, "removable": False,
        "followActiveLayers": True,
    }


def default_sub_tracks(composites: Iterable[dict]) -> list[dict]:
    """createDefaultSubTracks: fixed order, composites where the default metaprofile sits."""
    out: list[dict] = []
    for track in defaults()["defaultSubTracks"]:
        if str(track["type"]).startswith("composite-"):
            out.extend({"type": f"composite-{c['id']}", "visible": True} for c in composites)
        else:
            out.append(dict(track))
    return out


def dataset_dict(ds: Any) -> dict:
    """Server dataset object -> the dict shape the browser receives (/api/datasets)."""
    if isinstance(ds, dict):
        return ds
    if hasattr(ds, "to_dict"):
        return ds.to_dict()
    get = lambda name, default=None: getattr(ds, name, default)
    return {
        "id": get("id"), "label": get("label") or get("id"), "color": get("color") or "#3b82f6",
        "layer_type": get("layer_type"), "available_layers": dict(get("available_layers") or {}),
        "derived_layers": dict(get("derived_layers") or {}),
    }
