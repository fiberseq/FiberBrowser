"""Scripted-figure options for the headless engine: from the request, else the session's ``headless_figure`` block.

Every option is off unless a request names it or the session's ``headless_figure`` block sets it, so a
session without the block renders exactly as before. A request's own value wins over the session's.

    session["headless_figure"] = {
        "spanning_only": true, "sample_seed": "fig-2", "max_reads": 200,     # or {"<dataset id>": 200, ...}
        "hide_tracks": ["sv"], "page_size": "180x120mm", "page_fit": "contain",
        "min_font_pt": 6, "raster_dpi": 600, "pdf_fonts": "truetype",
        "annotations": {...}                                                  # services/figure/annotations.py
    }

The browser keeps this block in the session file it was loaded from but does not read it; saving the
session again from the browser drops it.
"""
from __future__ import annotations

import re
from typing import Any, Optional

SESSION_KEY = "headless_figure"

# Request fields (models/requests.py RenderRequest) that the session block may also set.
OPTION_FIELDS = ("spanning_only", "sample_seed", "max_reads", "max_reads_by_dataset", "hide_tracks",
                 "annotations", "page_size", "page_fit", "min_font_pt", "raster_dpi", "pdf_fonts")

# Rows a figure can leave out (hide_tracks). Browser sub-track names, plus the older /api/render names.
TRACK_ALIASES = {"peaks": "fire", "genes": "gene", "meta": "composite", "metaprofile": "composite",
                 "sv_strip": "sv", "coverage_histogram": "coverage"}
HIDEABLE = {"header", "axis", "fire", "consensus", "microc", "coacc", "composite", "capture", "primer", "sv",
            "sv_marks", "coverage", "reads", "sequence", "gene", "annotation"}
PAGE_FITS = ("contain", "width", "height", "stretch")
PDF_FONTS = ("standard", "truetype")
UNITS_PT = {"pt": 1.0, "mm": 72 / 25.4, "cm": 72 / 2.54, "in": 72.0, "px": 0.75}


def normalize_track_name(name: str) -> str:
    raw = str(name).strip()
    low = raw.lower()
    if low.startswith("composite-") or low.startswith("ortho-"):
        return raw
    return TRACK_ALIASES.get(low, low)


def normalize_hidden(names) -> set:
    if names is None:
        return set()
    if isinstance(names, str):
        names = [n for n in re.split(r"[,\s]+", names) if n]
    out = set()
    for name in names:
        norm = normalize_track_name(name)
        if norm not in HIDEABLE and not norm.startswith(("composite-", "ortho-")):
            raise ValueError(f"hide_tracks: unknown track {name!r}; use one of {', '.join(sorted(HIDEABLE))}, "
                             "composite-<id> or ortho-<id>")
        out.add(norm)
    return out


def parse_page_size(value) -> Optional[tuple[float, float]]:
    """'180x120mm', '7x5in', '510x340pt', [180, 120, 'mm'] or {'width':, 'height':, 'unit':} -> (w, h) in pt.

    A side given as 0 (or omitted with '180mm') follows the figure's aspect ratio."""
    if value is None or value == "":
        return None
    unit = "pt"
    if isinstance(value, dict):
        w, h, unit = value.get("width"), value.get("height"), value.get("unit", "pt")
    elif isinstance(value, (list, tuple)):
        w, h = value[0], value[1]
        unit = value[2] if len(value) > 2 else "pt"
    else:
        m = re.fullmatch(r"\s*([\d.]+)\s*(?:[x×*]\s*([\d.]+))?\s*(pt|mm|cm|in|px)?\s*", str(value).lower())
        if not m:
            raise ValueError(f"page_size {value!r}: use e.g. '180x120mm', '7x5in' or '510x340pt'")
        w, h, unit = m.group(1), m.group(2) or 0, m.group(3) or "pt"
    unit = str(unit).lower()
    if unit not in UNITS_PT:
        raise ValueError(f"page_size unit {unit!r}: use pt, mm, cm, in or px")
    try:
        w_pt, h_pt = float(w or 0) * UNITS_PT[unit], float(h or 0) * UNITS_PT[unit]
    except (TypeError, ValueError):
        raise ValueError(f"page_size {value!r}: width and height must be numbers") from None
    if w_pt < 0 or h_pt < 0 or (w_pt == 0 and h_pt == 0) or max(w_pt, h_pt) > 14400:
        raise ValueError(f"page_size {value!r}: sides must be positive and at most 200 in")
    return w_pt, h_pt


def _explicit(request) -> set:
    return set(getattr(request, "model_fields_set", None) or getattr(request, "__fields_set__", set()))


def resolve(request, session: Optional[dict]) -> dict:
    """The scripted-figure options in force: {field: value} for only the options that are set."""
    block = (session or {}).get(SESSION_KEY) if isinstance(session, dict) else None
    if block is not None and not isinstance(block, dict):
        raise ValueError(f"session {SESSION_KEY!r} must be an object")
    block = dict(block or {})
    unknown = sorted(set(block) - set(OPTION_FIELDS))
    if unknown:
        raise ValueError(f"session {SESSION_KEY!r}: unknown option(s) {', '.join(unknown)}; "
                         f"known: {', '.join(OPTION_FIELDS)}")
    explicit = _explicit(request)
    opts: dict[str, Any] = {}
    for name in OPTION_FIELDS:
        if name in explicit and getattr(request, name, None) is not None:
            opts[name] = getattr(request, name)
        elif block.get(name) is not None:
            opts[name] = block[name]
    # The session block's max_reads may be per dataset ({id: n}); a request's per-dataset caps add to it.
    if isinstance(opts.get("max_reads"), dict):
        by = {**opts.pop("max_reads"), **(opts.get("max_reads_by_dataset") or {})}
        opts["max_reads_by_dataset"] = by
    if "max_reads" in opts:
        opts["max_reads"] = int(opts["max_reads"])
        if opts["max_reads"] < 0:
            raise ValueError("max_reads must be at least 1 (0: the view's own count)")
    if "max_reads_by_dataset" in opts:
        by = opts["max_reads_by_dataset"]
        if not isinstance(by, dict) or any(int(v) < 1 for v in by.values()):
            raise ValueError("max_reads per dataset must map dataset ids (or panel ids or labels) to counts >= 1")
        opts["max_reads_by_dataset"] = {str(k): int(v) for k, v in by.items()}
    if "hide_tracks" in opts:
        opts["hide_tracks"] = sorted(normalize_hidden(opts["hide_tracks"]))
    if "page_size" in opts:
        opts["page_size_pt"] = parse_page_size(opts["page_size"])
    if "page_fit" in opts and opts["page_fit"] not in PAGE_FITS:
        raise ValueError(f"page_fit must be one of {', '.join(PAGE_FITS)}")
    if "pdf_fonts" in opts and opts["pdf_fonts"] not in PDF_FONTS:
        raise ValueError(f"pdf_fonts must be one of {', '.join(PDF_FONTS)}")
    if "min_font_pt" in opts:
        opts["min_font_pt"] = float(opts["min_font_pt"])
        if not 0 < opts["min_font_pt"] <= 72:
            raise ValueError("min_font_pt must be between 0 and 72")
    if "raster_dpi" in opts:
        opts["raster_dpi"] = float(opts["raster_dpi"])
        if not 36 <= opts["raster_dpi"] <= 2400:
            raise ValueError("raster_dpi must be between 36 and 2400")
    if "sample_seed" in opts:
        opts["sample_seed"] = str(opts["sample_seed"])
    return opts
