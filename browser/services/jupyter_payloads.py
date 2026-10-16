"""Payload builders for Jupyter/browser synchronization endpoints."""
from __future__ import annotations

from services.jupyter_collections import list_collection


def build_jupyter_poll_state(jupyter_state) -> dict:
    """Build the browser polling payload and clear one-shot commands."""
    pushed_reads = jupyter_state.custom_reads.get("_pushed", None)
    result = {
        "version": jupyter_state.version,
        "has_custom_reads": bool(jupyter_state.custom_reads),
        "has_pushed_reads": pushed_reads is not None,
        "pushed_reads": pushed_reads,
        "has_order": bool(jupyter_state.read_order),
        "has_filter": bool(jupyter_state.read_filter),
        "has_highlights": bool(jupyter_state.highlights),
        "has_markers": bool(jupyter_state.markers),
        "has_footprint_colors": bool(jupyter_state.footprint_colors),
        "highlights": list_collection(jupyter_state.highlights),
        "markers": list_collection(jupyter_state.markers),
        "footprint_colors": list_collection(jupyter_state.footprint_colors),
        "read_order": jupyter_state.read_order,
        "read_filter": jupyter_state.read_filter,
        "selected_reads": jupyter_state.selected_reads,
        "selected_read_ids": getattr(jupyter_state, "selected_read_ids_by_dataset", {}),
        "browser_settings": jupyter_state.browser_settings,
    }
    if jupyter_state.selected_reads or getattr(jupyter_state, "selected_read_ids_by_dataset", {}):
        jupyter_state.selection_delivered = True

    if jupyter_state.target_region:
        result["goto"] = jupyter_state.target_region
        jupyter_state.target_region = None

    if jupyter_state.refresh_requested:
        result["refresh"] = True
        jupyter_state.refresh_requested = False

    if jupyter_state.pending_peak_import:
        result["peak_import"] = jupyter_state.pending_peak_import
        jupyter_state.pending_peak_import = None

    if jupyter_state.pending_peak_rules_update:
        result["peak_rules_update"] = jupyter_state.pending_peak_rules_update
        jupyter_state.pending_peak_rules_update = None

    if jupyter_state.pending_settings_update:
        result["settings_update"] = jupyter_state.pending_settings_update
        jupyter_state.pending_settings_update = None

    if getattr(jupyter_state, "pending_browser_actions", None):
        result["browser_actions"] = list(jupyter_state.pending_browser_actions)
        jupyter_state.pending_browser_actions.clear()

    return result


def build_analysis_state(browser_settings: dict) -> dict:
    """Return the browser-synced reproducibility state for notebooks."""
    settings = browser_settings
    return {
        "manifest": settings.get("session_manifest", {}),
        "reproducibility": {
            "analysis_sample_seed": settings.get("analysis_sample_seed"),
            "analysis_sample_count": settings.get("analysis_sample_count"),
            "display_sample_count": settings.get("display_sample_count"),
            "read_display_mode": settings.get("read_display_mode"),
            "all_reads_display_cap": settings.get("all_reads_display_cap"),
            "background_read_cap": settings.get("background_read_cap"),
            "spanning_only": settings.get("spanning_only"),
            "cluster_method": settings.get("cluster_method"),
            "cluster_k": settings.get("cluster_k"),
            "small_footprint_threshold_bp": settings.get("small_footprint_threshold_bp"),
            "accessibility_threshold": settings.get("accessibility_threshold"),
            "legacy_layer_inference": settings.get("legacy_layer_inference"),
            "legacy_nuc_min_size": settings.get("legacy_nuc_min_size"),
        },
        "peaks_locked": settings.get("peaks_locked"),
        "peak_rules": settings.get("peak_rules", []),
        "selected_peaks": settings.get("selected_peaks", []),
        "peak_modes": settings.get("peak_modes", {}),
        "selected_read_ids": settings.get("selected_read_ids", {}),
        "selected_peak_count": settings.get("selected_peak_count", 0),
        "peaks_by_rule": settings.get("peaks_by_rule", {}),
        "analysis_rules": {
            "cluster_feature_rules": settings.get("cluster_feature_rules", []),
            "analysis_sort_rules": settings.get("analysis_sort_rules", []),
            "analysis_filter_rules": settings.get("analysis_filter_rules", []),
        },
        "capture_regions": settings.get("capture_regions", []),
        "capture_padding": settings.get("capture_padding", 0),
        "selected_genes": settings.get("selected_genes", []),
        "transcription_state_filters": settings.get("transcription_state_filters", {}),
        "primers": {
            "saved_primers": settings.get("primer_saved_primers", []),
            "mode": settings.get("primer_mode"),
            "cart_track_display": settings.get("primer_cart_track_display"),
        },
        "active_colormap": settings.get("active_colormap"),
        "active_quality_filters": settings.get("active_quality_filters", []),
        "display": {
            "read_display_mode": settings.get("read_display_mode"),
            "all_reads_display_cap": settings.get("all_reads_display_cap"),
            "background_read_cap": settings.get("background_read_cap"),
            "enabled_mod_types": settings.get("enabled_mod_types", {}),
            "enabled_meta_profiles": settings.get("enabled_meta_profiles", {}),
            "cached_layer_types": settings.get("cached_layer_types", {}),
            "legacy_layer_inference": settings.get("legacy_layer_inference"),
            "legacy_nuc_min_size": settings.get("legacy_nuc_min_size"),
            "click_target_layer": settings.get("click_target_layer"),
            "footprint_analysis_layer": settings.get("footprint_analysis_layer"),
            "fill_read_height": settings.get("fill_read_height"),
            "read_row_height": settings.get("read_row_height"),
            "show_coverage_histogram": settings.get("show_coverage_histogram"),
            "max_region_for_reads": settings.get("max_region_for_reads"),
            "show_genome_overview": settings.get("show_genome_overview"),
        },
        "coaccessibility": settings.get("coacc_settings", {}),
        "catalog": settings.get("catalog", []),
        "composite_tracks": settings.get("composite_tracks", []),
        "saved_tracks": settings.get("saved_tracks", []),
        "footprint_groups": settings.get("footprint_groups", []),
        "active_panels": settings.get("active_panels", []),
        "hidden_strip_panels": settings.get("hidden_strip_panels", []),
        "clusters": {
            "assignments": settings.get("cluster_assignments", {}),
            "order": settings.get("cluster_order", {}),
            "read_sort_order": settings.get("read_sort_order", {}),
        },
    }
