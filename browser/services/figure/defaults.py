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
from typing import Any, Iterable

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


def layer_color(name: str) -> str:
    """Same as the browser's getLayerColor: curated, else a #rrggbb from a hash-based hue."""
    known = defaults()["layers"].get(name)
    if known and not str(known["color"]).startswith("hsl"):
        return known["color"]
    return _hue_hex(abs(_js_hash(name)) % 360)


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


def default_metaprofile(datasets: Iterable[dict]) -> dict:
    """The browser's seeded default metaprofile composite for these datasets."""
    d = defaults()
    sources = [
        {
            "id": f"default-{entry['key']}",
            "ref": {"kind": "metaprofile", "ruleId": entry["key"]},
            "color": layer_color(entry["key"]),
            "visible": entry["key"] in ("nuc", "footprint", "tf"),
            "negate": False,
            "scale": 1,
        }
        for entry in metaprofile_source_entries(datasets)
    ]
    return {
        "id": d["defaultMetaprofileId"], "label": "Metaprofile", "kind": "metaprofile", "sources": sources,
        "scaleMode": "per-source", "logScale": False, "visible": True, "showAxes": True, "removable": False,
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
