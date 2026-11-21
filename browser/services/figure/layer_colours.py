"""The user's layer colours in the figure engine, as the browser applies them (features/layerColours/state.ts,
utils/layerColourFollow.ts).

Two maps, layer key -> ``#rrggbb``: the session's own (``layerColorOverrides`` in the frontend state) over the user's
saved defaults (``layer_colors`` in ~/.fiberhmm/analysis_preferences.json). With any set:

- the built-in Nucleosome, Accessibility and Subnucleosome (TF-layer) rules, and the TF overlay, still holding their stock colours take the
  layer's colour (a rule the user recoloured keeps its own);
- the default metaprofile's sources that follow (``autoColor``, or a curated layer's source still at its layer's
  colour) take it;
- the read track's layer and mark colours take it (``layer_colors_for`` / ``mark_color``).
"""
from __future__ import annotations

import re
from typing import Any, Optional

ALIASES = {"msp": "fire", "mod": "m6a", "footprint": "nuc"}
# Built-in rule id -> the layer whose colour it follows (utils/layerColourFollow.ts RULE_LAYER_FOLLOW).
RULE_LAYER_FOLLOW = {"nuc": "nuc", "fire": "fire", "subnuc": "tf"}
EFFECTIVE_KEY = "_effectiveLayerColors"
_HEX = re.compile(r"^#[0-9a-f]{6}$")


def layer_key(name: str) -> str:
    return ALIASES.get(name, name)


def normalize_hex(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    v = value.strip().lower()
    if re.fullmatch(r"#[0-9a-f]{3}", v):
        v = "#" + "".join(c * 2 for c in v[1:])
    return v if _HEX.match(v) else None


def normalize_map(raw: Any, max_keys: int = 200) -> dict:
    out: dict = {}
    if not isinstance(raw, dict):
        return out
    for key, value in list(raw.items())[:max_keys]:
        k = key.strip()[:80] if isinstance(key, str) else ""
        color = normalize_hex(value)
        if k and color:
            out[layer_key(k)] = color
    return out


def saved_defaults() -> dict:
    """The user's saved default colours (an unreadable preferences file: none). None on a public server or in a tour
    tab: their pages never load the host's preferences, so a figure must not draw with them either."""
    try:
        from services.runtime import current_sandbox_id, get_public_mode
        if get_public_mode() or current_sandbox_id() is not None:
            return {}
        from services.analysis_preferences import load_preferences
        return normalize_map(load_preferences().get("layer_colors"))
    except Exception:  # noqa: BLE001 - a figure never fails over a preference
        return {}


def effective(fe: dict, defaults_map: Optional[dict] = None) -> dict:
    """The session's colours over the saved defaults."""
    base = saved_defaults() if defaults_map is None else normalize_map(defaults_map)
    return {**base, **normalize_map((fe or {}).get("layerColorOverrides"))}


def override(fe: dict, name: str) -> Optional[str]:
    colors = (fe or {}).get(EFFECTIVE_KEY) or {}
    return colors.get(name) or colors.get(layer_key(name))


def layer_colors_for(fe: dict) -> dict:
    """The effective colours keyed by every alias too (fire/msp, m6a/mod, nuc/footprint)."""
    colors = dict((fe or {}).get(EFFECTIVE_KEY) or {})
    for alias, key in ALIASES.items():
        if key in colors:
            colors[alias] = colors[key]
    return colors


def _darken(hex_color: str, amount: float) -> str:
    v = normalize_hex(hex_color) or hex_color
    rgb = [round(int(v[i:i + 2], 16) * (1 - amount)) for i in (1, 3, 5)]
    return "#" + "".join(f"{c:02x}" for c in rgb)


def mark_color(fe: dict, key: str, fallback: str) -> str:
    """A per-base mark colour (MOD_COLORS key) with the user's layer colour applied."""
    layer = {"m6a": "m6a", "mod": "m6a", "m5c": "m5c", "fire": "fire", "msp": "fire", "tf": "tf", "nuc": "nuc",
             "footprint": "nuc", "deam": "deam", "deam_r": "deam", "deam_y": "deam"}.get(key)
    color = override(fe, layer) if layer else None
    if not color:
        return fallback
    return _darken(color, 0.55) if key == "deam_y" else color


def _stock_rules() -> dict:
    from services.figure.defaults import defaults
    return {r.get("id"): normalize_hex(r.get("color")) for r in (defaults().get("activeColormap") or {}).get("rules") or []
            if isinstance(r, dict)}


def _stock_tf_color() -> Optional[str]:
    from services.figure.defaults import defaults
    return normalize_hex(((defaults().get("activeColormap") or {}).get("tfOverlay") or {}).get("color"))


def apply(fe: dict, defaults_map: Optional[dict] = None) -> dict:
    """Put the effective colours into ``fe`` (its colormap as drawn and the default metaprofile). In place; returns fe."""
    colors = effective(fe, defaults_map)
    fe[EFFECTIVE_KEY] = colors
    if not colors:
        if fe.get("compositeTracks"):
            fe["compositeTracks"] = _follow_sources(fe["compositeTracks"], colors)
        return fe
    cmap = fe.get("activeColormap")
    if isinstance(cmap, dict):
        stock = _stock_rules()
        rules = []
        for rule in cmap.get("rules") or []:
            if isinstance(rule, dict):
                layer = RULE_LAYER_FOLLOW.get(rule.get("id"))
                solid = (rule.get("colorMode") or "solid") == "solid"
                if layer and solid and colors.get(layer) and normalize_hex(rule.get("color")) == stock.get(rule.get("id")):
                    rule = {**rule, "color": colors[layer]}
            rules.append(rule)
        cmap = {**cmap, "rules": rules}
        tf = cmap.get("tfOverlay")
        if isinstance(tf, dict) and colors.get("tf") and normalize_hex(tf.get("color")) == _stock_tf_color():
            cmap["tfOverlay"] = {**tf, "color": colors["tf"]}
        fe["activeColormap"] = cmap
    fe["compositeTracks"] = _follow_sources(fe.get("compositeTracks") or [], colors)
    return fe


def follow_sources(composites: list, fe: dict) -> list:
    """The composites with the effective colours (set by ``apply``) on the sources that follow them; a following
    curated-layer source without a colour set goes back to its built-in colour (a session saved under a saved
    default that no longer applies)."""
    return _follow_sources(composites, (fe or {}).get(EFFECTIVE_KEY) or {})


def _follow_sources(composites: list, colors: dict) -> list:
    """Default-metaprofile sources that follow their layer's colour (refreshAutoSourceColors with overrides)."""
    from services.figure.defaults import defaults, layer_color
    default_id = defaults()["defaultMetaprofileId"]
    curated = set(defaults()["curatedLayerKeys"])
    out = []
    for comp in composites:
        if not isinstance(comp, dict) or comp.get("id") != default_id:
            out.append(comp)
            continue
        sources = []
        for src in comp.get("sources") or []:
            ref = (src or {}).get("ref") or {}
            key = ref.get("ruleId")
            chosen = colors.get(layer_key(key)) if key else None
            if ref.get("kind") == "metaprofile" and key:
                auto = src.get("autoColor")
                current = normalize_hex(src.get("color"))
                builtin = normalize_hex(layer_color(key))
                if chosen:
                    follows = auto is True or (auto is None and key in curated and current in (builtin, chosen))
                    if follows:
                        src = {**src, "color": chosen, "autoColor": True}
                elif auto is True and key in curated and current != builtin:
                    # No colour set any more: the built-in one (uncurated layers: refresh_auto_source_colors).
                    src = {**src, "color": layer_color(key), "autoColor": True}
            sources.append(src)
        out.append({**comp, "sources": sources})
    return out
