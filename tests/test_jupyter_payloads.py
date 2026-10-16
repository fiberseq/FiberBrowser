from models.domain import JupyterState
from services.layer_aliases import normalize_jupyter_settings
from services.jupyter_payloads import build_analysis_state, build_jupyter_poll_state


def test_build_jupyter_poll_state_reports_and_clears_one_shot_commands():
    state = JupyterState()
    state.version = 3
    state.custom_reads["_pushed"] = [{"id": "r1"}]
    state.read_order["ds1"] = ["r2", "r1"]
    state.read_filter["ds1"] = ["r1"]
    state.highlights["h1"] = {"id": "h1", "read_ids": ["r1"]}
    state.selected_reads = ["r1"]
    state.selected_read_ids_by_dataset["ds1"] = ["r1"]
    state.browser_settings["analysis_sample_seed"] = "paper"
    state.target_region = {"chrom": "chr2L", "start": 10, "end": 20}
    state.refresh_requested = True
    state.pending_peak_import = {"id": "p1"}
    state.pending_peak_rules_update = {"id": "rules1"}
    state.pending_settings_update = {"analysis_sample_seed": "paper"}
    state.pending_browser_actions = [{"id": "a1", "action": {"type": "cluster_selected_peaks"}}]

    payload = build_jupyter_poll_state(state)
    second_payload = build_jupyter_poll_state(state)

    assert payload["version"] == 3
    assert payload["has_pushed_reads"] is True
    assert payload["pushed_reads"] == [{"id": "r1"}]
    assert payload["read_order"] == {"ds1": ["r2", "r1"]}
    assert payload["read_filter"] == {"ds1": ["r1"]}
    assert payload["highlights"] == [{"id": "h1", "read_ids": ["r1"]}]
    assert payload["selected_read_ids"] == {"ds1": ["r1"]}
    assert payload["browser_settings"]["analysis_sample_seed"] == "paper"
    assert payload["goto"] == {"chrom": "chr2L", "start": 10, "end": 20}
    assert payload["refresh"] is True
    assert payload["peak_import"] == {"id": "p1"}
    assert payload["peak_rules_update"] == {"id": "rules1"}
    assert payload["settings_update"] == {"analysis_sample_seed": "paper"}
    assert payload["browser_actions"] == [{"id": "a1", "action": {"type": "cluster_selected_peaks"}}]

    assert "goto" not in second_payload
    assert "refresh" not in second_payload
    assert "peak_import" not in second_payload
    assert "peak_rules_update" not in second_payload
    assert "settings_update" not in second_payload
    assert "browser_actions" not in second_payload


def test_build_analysis_state_maps_browser_settings_for_notebooks():
    settings = {
        "session_manifest": {"sessionName": "Paper"},
        "analysis_sample_seed": "seed-1",
        "analysis_sample_count": 5000,
        "display_sample_count": 600,
        "read_display_mode": "sample",
        "all_reads_display_cap": 10000,
        "background_read_cap": None,
        "spanning_only": True,
        "cluster_method": "kmeans",
        "cluster_k": 8,
        "legacy_layer_inference": True,
        "legacy_nuc_min_size": 90,
        "peaks_locked": True,
        "peak_rules": [{"id": "rule1"}],
        "selected_peaks": [1, 2],
        "peak_modes": {"1": "accessibility"},
        "selected_read_ids": {"ds1": ["r1", "r2"]},
        "selected_peak_count": 2,
        "cluster_feature_rules": [{"id": "cluster-rule"}],
        "analysis_sort_rules": [{"id": "sort-rule"}],
        "analysis_filter_rules": [{"id": "filter-rule"}],
        "selected_genes": [{"id": "tx1", "name": "GeneA"}],
        "transcription_state_filters": {"pause": True},
        "primer_saved_primers": [{"name": "PrimerA"}],
        "primer_mode": "standard",
        "primer_cart_track_display": "design",
        "active_quality_filters": [{"layer": "fire", "qualityName": "aq", "minValue": 230}],
        "enabled_mod_types": {"tf": True, "nuc": True},
        "coacc_settings": {"coaccLayer": "fire"},
        "cluster_assignments": {"ds1": {"r1": 0}},
        "cluster_order": {"ds1": [0]},
        "read_sort_order": {"ds1": ["r1"]},
    }

    payload = build_analysis_state(settings)

    assert payload["manifest"] == {"sessionName": "Paper"}
    assert payload["reproducibility"]["analysis_sample_seed"] == "seed-1"
    assert payload["reproducibility"]["analysis_sample_count"] == 5000
    assert payload["reproducibility"]["read_display_mode"] == "sample"
    assert payload["reproducibility"]["all_reads_display_cap"] == 10000
    assert payload["reproducibility"]["background_read_cap"] is None
    assert payload["reproducibility"]["spanning_only"] is True
    assert payload["peaks_locked"] is True
    assert payload["peak_rules"] == [{"id": "rule1"}]
    assert payload["peak_modes"] == {"1": "accessibility"}
    assert payload["selected_read_ids"] == {"ds1": ["r1", "r2"]}
    assert payload["analysis_rules"] == {
        "cluster_feature_rules": [{"id": "cluster-rule"}],
        "analysis_sort_rules": [{"id": "sort-rule"}],
        "analysis_filter_rules": [{"id": "filter-rule"}],
    }
    assert payload["selected_genes"] == [{"id": "tx1", "name": "GeneA"}]
    assert payload["transcription_state_filters"] == {"pause": True}
    assert payload["primers"] == {
        "saved_primers": [{"name": "PrimerA"}],
        "mode": "standard",
        "cart_track_display": "design",
    }
    assert payload["active_quality_filters"] == [{"layer": "fire", "qualityName": "aq", "minValue": 230}]
    assert payload["display"]["enabled_mod_types"] == {"tf": True, "nuc": True}
    assert payload["coaccessibility"] == {"coaccLayer": "fire"}
    assert payload["clusters"]["assignments"] == {"ds1": {"r1": 0}}
    assert payload["clusters"]["order"] == {"ds1": [0]}
    assert payload["clusters"]["read_sort_order"] == {"ds1": ["r1"]}


def test_normalize_jupyter_settings_accepts_profile_read_cap_alias():
    payload = normalize_jupyter_settings({"profile_read_cap": 750, "background_read_cap": 100})

    assert payload == {"background_read_cap": 750}
