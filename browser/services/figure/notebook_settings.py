"""Settings a notebook pushed (``BrowserClient.set_*``), for figures drawn with no browser tab.

``/api/jupyter/settings`` queues a settings update for the open tab, which applies it and pushes its view back
(``live_figure_state``). With no tab (``BrowserClient.headless()``, a server nobody has opened) nothing applies it,
so a figure from the defaults ignored every ``set_*`` call. The server now also keeps what the notebook set
(``JupyterState.notebook_settings``, merged call by call) and a figure from the defaults starts from it, mapped to
the browser's field names, as the tab would have applied it. A figure of the open tab's view or of a session is
unchanged: the tab already applied the settings, and a session is what it saved.

``FIGURE_FIELDS`` maps each notebook setting that changes a figure to its frontend field; ``NOT_FIGURE_FIELDS`` lists
the rest with the reason. tests/test_notebook_figure_settings.py fails when a new notebook setting is in neither, so
the next setting is decided on, not missed.
"""
from __future__ import annotations

import copy
from typing import Any, Optional

# Notebook setting -> the frontend field it sets (merged ones are handled in apply()).
FIGURE_FIELDS: dict[str, str] = {
    "analysis_sample_seed": "analysisSampleSeed",
    "display_sample_count": "downsampleCount",
    "read_display_mode": "readDisplayMode",
    "all_reads_display_cap": "allReadsDisplayCap",
    "background_read_cap": "backgroundReadCap",
    "spanning_only": "spanningOnly",
    "peaks_locked": "peaksLocked",
    "peak_rules": "peakRules",
    "selected_peaks": "selectedPeaks",
    "peak_modes": "peakModes",
    "peaks_by_rule": "peaksByRule",
    "active_colormap": "activeColormap",
    "catalog": "catalog",
    "composite_tracks": "compositeTracks",
    "selected_genes": "selectedGenes",
    "enabled_mod_types": "enabledModTypes",          # merged into the defaults' toggles
    "enabled_meta_profiles": "compositeTracks",      # the default metaprofile's sources (manual)
    "metaprofile_follow_active_layers": "compositeTracks",
    "legacy_layer_inference": "legacyLayerInference",
    "legacy_nuc_min_size": "legacyNucMinSize",
    "read_row_height": "readRowHeight",
    "min_footprints": "minFootprints",
    "min_fp_quality": "minFpQuality",
    "show_duplicate_reads": "showDuplicateReads",
    "show_qc_fail_reads": "showQcFailReads",
    "layer_color_overrides": "layerColorOverrides",  # merged; null forgets one
    "replace_layer_color_overrides": "layerColorOverrides",
    "reversed": "isReversed",
}

# Notebook settings that do not change a figure (headless or from the browser), with why.
NOT_FIGURE_FIELDS: dict[str, str] = {
    "analysis_sample_count": "the analysis working-set cap (clustering, scans), not what a figure draws",
    "profile_read_cap": "renamed to background_read_cap before it is stored",
    "cluster_feature_rules": "rules the Analysis panel applies when asked; their result (clusters, order) is drawn",
    "analysis_sort_rules": "as cluster_feature_rules",
    "analysis_filter_rules": "as cluster_feature_rules",
    "cluster_method": "used when clustering runs, not when drawing",
    "cluster_k": "as cluster_method",
    "small_footprint_threshold_bp": "a clustering/analysis threshold",
    "accessibility_threshold": "a clustering/analysis threshold",
    "capture_regions": "the Capture panel's list",
    "capture_padding": "the Capture panel's list",
    "saved_tracks": "the saved-tracks list (an added track is in composite_tracks / catalog)",
    "footprint_groups": "the Footprints panel's groups",
    "transcription_state_filters": "the Transcription panel's filters (applied as a read filter when used)",
    "primer_saved_primers": "the primer cart",
    "primer_mode": "the primer designer",
    "primer_cart_track_display": "the primer cart track, which figures do not draw",
    "cached_layer_types": "read-cache prefetching",
    "click_target_layer": "what a click selects",
    "footprint_analysis_layer": "the Footprints panel's layer",
    "coacc_settings": "the Co-accessibility panel (figures do not draw analysis panels)",
    "show_coverage_histogram": "a sidebar histogram",
    "fill_read_height": "fits rows to the tab's panel height; a figure sizes rows by row_height / its read count",
    "max_region_for_reads": "the browser's zoom-out limit for reads; a figure's region is given",
    "show_genome_overview": "the navigator strip",
    "open_panel": "analysis panels (figures do not draw them)",
    "close_panel": "analysis panels",
    "hidden_strip_panels": "the analysis strip",
    "user_layer_colors": "saved to the preferences file, which figures read directly (layer_colours.saved_defaults)",
    "window_quant": "the Quantify card and its window band, left out of figure exports in the browser too",
    "plot": "Plots (figures do not draw the Plots workspace)",
    "plots_region_sets": "Plots' BED region sets",
    "metaprofile_follow_first": "ordering hint in the tab's merged summary (figures replay the calls in order)",
    "workspace": "which workspace covers the reads in the tab",
}


def _merge_colors(current: Any, patch: Any, replace: bool = False) -> dict:
    from services.figure.layer_colours import layer_key, normalize_hex
    out = {} if replace else dict(current or {})
    for key, value in (patch or {}).items():
        if not isinstance(key, str) or not key.strip():
            continue
        k = layer_key(key.strip()[:80])
        if value is None:
            out.pop(k, None)
            continue
        color = normalize_hex(value)
        if color:
            out[k] = color
    return out


def record(store: dict, updates: dict) -> dict:
    """Merge one settings call into what the notebook has set so far (later values win; maps merge as the tab
    merges them: layer toggles key by key, layer colours with null forgetting one)."""
    out = dict(store or {})
    for key, value in updates.items():
        if key in ("open_panel", "close_panel", "panel_ops"):
            continue  # operations, not settings
        if key in ("enabled_mod_types", "enabled_meta_profiles", "cached_layer_types") and isinstance(value, dict):
            out[key] = {**(out.get(key) or {}), **value}
        elif key == "layer_color_overrides":
            out[key] = _merge_colors(out.get(key), value, replace=bool(updates.get("replace_layer_color_overrides")))
        elif key == "replace_layer_color_overrides":
            if value and "layer_color_overrides" not in updates:
                out["layer_color_overrides"] = {}
        else:
            out[key] = copy.deepcopy(value)
    # The default metaprofile depends on the order of layer toggles, source toggles and the follow switch (a toggle
    # that changes nothing keeps it following; a frozen track keeps the sources it had): kept as ordered operations,
    # in the order the tab applies one update (layers, then sources, then follow), and replayed by apply().
    ops = list(out.get(METAPROFILE_OPS) or [])
    if isinstance(updates.get("composite_tracks"), list):
        ops.append(["composites", copy.deepcopy(updates["composite_tracks"])])
    if isinstance(updates.get("enabled_mod_types"), dict):
        ops.append(["mods", dict(updates["enabled_mod_types"])])
    if isinstance(updates.get("enabled_meta_profiles"), dict):
        ops.append(["toggles", dict(updates["enabled_meta_profiles"])])
    if isinstance(updates.get("metaprofile_follow_active_layers"), bool):
        ops.append(["follow", updates["metaprofile_follow_active_layers"]])
    if ops:
        out[METAPROFILE_OPS] = _compact_ops(ops)
    return out


METAPROFILE_OPS = "_metaprofile_ops"


def _compact_ops(ops: list) -> list:
    """Drop what a later operation makes irrelevant, never what the result depends on: everything before the last
    whole-cart replacement (composite_tracks) goes, except the layer toggles, merged into one (they still set the
    layers the replay continues from). Repeated layer toggles in a row merge into one."""
    last_cart = max((i for i, op in enumerate(ops) if op[0] == "composites"), default=-1)
    if last_cart > 0:
        mods: dict = {}
        for kind, value in ops[:last_cart]:
            if kind == "mods":
                mods.update(value)
        ops = ([["mods", mods]] if mods else []) + ops[last_cart:]
    out: list = []
    for op in ops:
        if out and op[0] == "mods" and out[-1][0] == "mods":
            out[-1] = ["mods", {**out[-1][1], **op[1]}]
        else:
            out.append(op)
    return out


def _default_metaprofile_toggles(composites: list, toggles: dict) -> list:
    """Port of utils/defaultMetaprofile.ts applyDefaultMetaprofileToggles: named sources take the given visibility;
    a change makes the track manual."""
    from services.figure.defaults import _canonical_metaprofile_key, defaults
    default_id = defaults()["defaultMetaprofileId"]
    wanted = {_canonical_metaprofile_key(k): bool(v) for k, v in (toggles or {}).items() if isinstance(v, bool)}
    out = []
    for comp in composites:
        if not isinstance(comp, dict) or comp.get("id") != default_id:
            out.append(comp)
            continue
        changed = False
        sources = []
        for src in comp.get("sources") or []:
            ref = (src or {}).get("ref") or {}
            on = wanted.get(_canonical_metaprofile_key(ref.get("ruleId"))) if ref.get("kind") == "metaprofile" else None
            if on is not None and on != bool(src.get("visible", True)):
                src = {**src, "visible": on}
                changed = True
            sources.append(src)
        out.append({**comp, "sources": sources, **({"followActiveLayers": False} if changed else {})})
    return out


def _allowed() -> bool:
    """Notebook settings exist only on a local server (the Jupyter routes are refused on public and lab servers);
    never apply them to a public visitor's or a tour tab's figure."""
    try:
        from services.runtime import current_sandbox_id, get_public_mode
        return not get_public_mode() and current_sandbox_id() is None
    except Exception:  # noqa: BLE001
        return True


def notebook_state() -> Optional[Any]:
    try:
        from state.runtime_state import get_jupyter_runtime_state
        return get_jupyter_runtime_state()
    except Exception:  # noqa: BLE001
        return None


# Settings whose None is a value the browser stores (not "left unset").
NULLABLE_SETTINGS = frozenset({"background_read_cap"})


def apply(fe: dict, state, jupyter_state=None) -> dict:
    """Apply what the notebook set to a figure's frontend state drawn from the defaults (in place; returns fe)."""
    if not _allowed():
        return fe
    js = jupyter_state if jupyter_state is not None else notebook_state()
    if js is None:
        return fe
    settings = dict(getattr(js, "notebook_settings", None) or {})
    start_mods = dict(fe.get("enabledModTypes") or {})  # before the notebook's layer toggles
    start_composites = list(fe.get("compositeTracks") or [])  # and its cart replacements
    for key, value in settings.items():
        field = FIGURE_FIELDS.get(key)
        if field is None or field == "compositeTracks" and key != "composite_tracks":
            continue
        # None is a value for nullable settings (background_read_cap None = no cap); for the others it means unset.
        if value is None and key not in NULLABLE_SETTINGS:
            continue
        if key == "enabled_mod_types":
            fe["enabledModTypes"] = {**(fe.get("enabledModTypes") or {}), **value}
        elif key in ("layer_color_overrides", "replace_layer_color_overrides"):
            if key == "layer_color_overrides":
                fe["layerColorOverrides"] = _merge_colors(fe.get("layerColorOverrides"), value)
        elif key == "selected_peaks":
            fe["selectedPeaks"] = list(value)
        else:
            fe[field] = copy.deepcopy(value)
    # Read filter and read order set from the notebook (set_read_filter / set_read_order), per dataset.
    read_filter = getattr(js, "read_filter", None) or {}
    if read_filter:
        fe["filteredReadIds"] = {**(fe.get("filteredReadIds") or {}), **{k: list(v) for k, v in read_filter.items()}}
    read_order = getattr(js, "read_order", None) or {}
    if read_order:
        fe["readSortOrder"] = {**(fe.get("readSortOrder") or {}), **{k: list(v) for k, v in read_order.items()}}
    # The default metaprofile: replay layer toggles, source toggles and the follow switch in order, from the toggles
    # the figure started with, as the tab applied them one by one.
    ops = settings.get(METAPROFILE_OPS) or []
    if any(op[0] in ("toggles", "follow") for op in ops):
        # The cart replacements are replayed in order too (a later toggle applies to the replaced cart).
        from services.figure.defaults import apply_follow_active_layers, dataset_dict, default_metaprofile, defaults
        datasets = [dataset_dict(ds) for ds in (getattr(state, "datasets", {}) or {}).values()]
        default_id = defaults()["defaultMetaprofileId"]
        enabled = dict(start_mods)
        composites = [c for c in start_composites if isinstance(c, dict)]
        if not any(c.get("id") == default_id for c in composites):
            composites = [default_metaprofile(datasets, enabled), *composites]
        for kind, value in ops:
            if kind == "composites":
                composites = [c for c in value if isinstance(c, dict)]
                if not any(c.get("id") == default_id for c in composites):
                    composites = [default_metaprofile(datasets, enabled), *composites]
                # A following track in the new cart follows the layers at once, as the tab's subscription does.
                composites = apply_follow_active_layers(composites, enabled, datasets)
            elif kind == "mods":
                enabled.update(value)
                composites = apply_follow_active_layers(composites, enabled, datasets)  # a following track follows
            elif kind == "toggles":
                composites = _default_metaprofile_toggles(composites, value)
            elif kind == "follow":
                composites = [{**c, "followActiveLayers": bool(value)} if c.get("id") == default_id else c
                              for c in composites]
                if value:
                    composites = apply_follow_active_layers(composites, enabled, datasets)
        fe["compositeTracks"] = composites
    return fe
