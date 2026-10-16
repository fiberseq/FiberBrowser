"""Jupyter endpoint round-trip tests for browser reproducibility controls."""


def test_jupyter_settings_update_is_delivered_once(client):
    import server as srv

    srv.jupyter_state.clear_all()

    resp = client.post("/api/jupyter/settings", json={
        "analysis_sample_seed": "paper-v1",
        "analysis_sample_count": 20000,
        "display_sample_count": None,
        "spanning_only": False,
        "selected_peaks": [3],
        "peaks_by_rule": {"rule-a": [{"index": 3, "start": 10, "end": 20}]},
        "active_colormap": {"name": "paper labels", "rules": []},
        "cluster_method": "kmeans",
        "cluster_k": 8,
        "small_footprint_threshold_bp": 85,
        "accessibility_threshold": 0.4,
    })
    assert resp.status_code == 200
    assert resp.json() == {
        "success": True,
        "updated": [
            "accessibility_threshold",
            "active_colormap",
            "analysis_sample_count",
            "analysis_sample_seed",
            "cluster_k",
            "cluster_method",
            "display_sample_count",
            "peaks_by_rule",
            "selected_peaks",
            "small_footprint_threshold_bp",
            "spanning_only",
        ],
    }

    state = client.get("/api/jupyter/state").json()
    assert state["settings_update"] == {
        "analysis_sample_seed": "paper-v1",
        "analysis_sample_count": 20000,
        "active_colormap": {"name": "paper labels", "rules": []},
        "selected_peaks": [3],
        "peaks_by_rule": {"rule-a": [{"index": 3, "start": 10, "end": 20}]},
        "cluster_method": "kmeans",
        "cluster_k": 8,
        "small_footprint_threshold_bp": 85,
        "accessibility_threshold": 0.4,
        "display_sample_count": None,
        "spanning_only": False,
    }

    state = client.get("/api/jupyter/state").json()
    assert "settings_update" not in state


def test_jupyter_settings_normalize_legacy_msp_aliases(client):
    import server as srv

    srv.jupyter_state.clear_all()

    resp = client.post("/api/jupyter/settings", json={
        "enabled_mod_types": {"msp": True},
        "enabled_meta_profiles": {"msp": True},
        "cached_layer_types": {"msp": False},
        "click_target_layer": "msp",
        "footprint_analysis_layer": "all",
        "active_colormap": {
            "name": "Legacy MSP labels",
            "rules": [{"id": "r1", "targetLayers": ["msp", "fire"]}],
            "qualityFilters": [{"layer": "msp", "qualityName": "aq", "minValue": 230, "enabled": True}],
        },
        "footprint_groups": [{"id": "fg1", "layer": "msp"}],
        "coacc_settings": {"coaccLayer": "msp", "coaccTrackMode": "heatmap"},
    })
    assert resp.status_code == 200

    pending = client.get("/api/jupyter/state").json()["settings_update"]
    assert pending["enabled_mod_types"] == {"fire": True}
    assert pending["enabled_meta_profiles"] == {"fire": True}
    assert pending["cached_layer_types"] == {"fire": False}
    assert pending["click_target_layer"] == "fire"
    assert pending["footprint_analysis_layer"] is None
    assert pending["active_colormap"]["rules"][0]["targetLayers"] == ["fire"]
    assert pending["active_colormap"]["qualityFilters"][0]["layer"] == "fire"
    assert pending["footprint_groups"][0]["layer"] == "fire"
    assert pending["coacc_settings"]["coaccLayer"] == "fire"


def test_jupyter_browser_settings_snapshot_round_trip(client):
    import server as srv

    srv.jupyter_state.clear_all()
    version = srv.jupyter_state.version

    resp = client.post("/api/jupyter/settings/sync", json={
        "analysis_sample_seed": "paper-v2",
        "analysis_sample_count": None,
        "display_sample_count": 1000,
        "spanning_only": True,
        "peaks_locked": True,
        "peak_rules": [{"id": "rule-a", "source": "accessibility", "enabled": True}],
        "active_colormap": {"name": "Default", "rules": [], "qualityFilters": []},
        "cluster_method": "combinatorial",
        "cluster_k": 12,
        "small_footprint_threshold_bp": 90,
        "accessibility_threshold": 0.5,
        "selected_peak_count": 3,
        "coacc_settings": {
            "coaccTrackMode": "heatmap",
            "coaccNormalization": "correlation",
            "coaccBinSize": 100,
        },
    })
    assert resp.status_code == 200
    assert resp.json()["success"] is True
    assert srv.jupyter_state.version == version

    resp = client.get("/api/jupyter/settings")
    assert resp.status_code == 200
    assert resp.json()["settings"] == {
        "analysis_sample_seed": "paper-v2",
        "analysis_sample_count": None,
        "display_sample_count": 1000,
        "spanning_only": True,
        "peaks_locked": True,
        "peak_rules": [{"id": "rule-a", "source": "accessibility", "enabled": True}],
        "active_colormap": {"name": "Default", "rules": [], "qualityFilters": []},
        "cluster_method": "combinatorial",
        "cluster_k": 12,
        "small_footprint_threshold_bp": 90,
        "accessibility_threshold": 0.5,
        "selected_peak_count": 3,
        "coacc_settings": {
            "coaccTrackMode": "heatmap",
            "coaccNormalization": "correlation",
            "coaccBinSize": 100,
        },
    }

    state = client.get("/api/jupyter/state").json()
    assert state["browser_settings"]["analysis_sample_seed"] == "paper-v2"
    assert "settings_update" not in state

    resp = client.post("/api/jupyter/settings/sync", json={
        "active_quality_filters": [{"layer": "msp", "quality_name": "aq", "min_value": 230}],
        "coacc_settings": {"coaccLayer": "msp"},
    })
    assert resp.status_code == 200
    settings = client.get("/api/jupyter/settings").json()["settings"]
    assert settings["active_quality_filters"][0]["layer"] == "fire"
    assert settings["coacc_settings"]["coaccLayer"] == "fire"


def test_jupyter_analysis_state_and_manifest_round_trip(client):
    import server as srv

    srv.jupyter_state.clear_all()

    snapshot = {
        "analysis_sample_seed": "paper-v3",
        "analysis_sample_count": 5000,
        "display_sample_count": 1000,
        "spanning_only": True,
        "peaks_locked": True,
        "peak_rules": [{"id": "rule-a", "source": "accessibility", "enabled": True}],
        "selected_peaks": [1, 2],
        "selected_read_ids": {"primary": ["read_a", "read_b"]},
        "selected_peak_count": 2,
        "peaks_by_rule": {"rule-a": [{"chrom": "chr2L", "start": 10, "end": 20}]},
        "capture_regions": [{"id": "cap1", "chrom": "chr2L", "start": 10, "end": 30}],
        "capture_padding": 100,
        "active_colormap": {"name": "Paper", "rules": [], "qualityFilters": [{"layer": "fire", "qualityName": "aq", "minValue": 230, "enabled": True}]},
        "active_quality_filters": [{"layer": "fire", "quality_name": "aq", "min_value": 230}],
        "catalog": [{"id": "cat1", "kind": "bigbed", "label": "TF"}],
        "composite_tracks": [{"id": "comp1", "label": "TF"}],
        "saved_tracks": [{"id": "saved1", "name": "TF saved"}],
        "active_panels": [{"id": "panel-cluster-detail", "content_type": "cluster-detail"}],
        "hidden_strip_panels": ["history"],
        "cluster_assignments": {"primary": {"read_a": 0}},
        "cluster_order": {"primary": [0]},
        "read_sort_order": {"primary": ["read_a"]},
        "coacc_settings": {
            "coaccTrackMode": "arc",
            "coaccNormalization": "oe_distance",
            "coaccBinSize": 250,
        },
        "session_manifest": {
            "sessionName": "Paper session",
            "reproducibility": {"seed": "paper-v3"},
            "warnings": [],
        },
    }

    resp = client.post("/api/jupyter/settings/sync", json=snapshot)
    assert resp.status_code == 200
    assert resp.json()["settings"]["session_manifest"]["sessionName"] == "Paper session"

    manifest = client.get("/api/jupyter/session_manifest")
    assert manifest.status_code == 200
    assert manifest.json()["manifest"]["sessionName"] == "Paper session"

    state = client.get("/api/jupyter/analysis_state")
    assert state.status_code == 200
    payload = state.json()
    assert payload["manifest"]["reproducibility"]["seed"] == "paper-v3"
    assert payload["selected_peaks"] == [1, 2]
    assert payload["selected_read_ids"] == {"primary": ["read_a", "read_b"]}
    assert payload["capture_regions"][0]["id"] == "cap1"
    assert payload["active_quality_filters"][0]["quality_name"] == "aq"
    assert payload["catalog"][0]["id"] == "cat1"
    assert payload["composite_tracks"][0]["id"] == "comp1"
    assert payload["saved_tracks"][0]["id"] == "saved1"
    assert payload["active_panels"][0]["content_type"] == "cluster-detail"
    assert payload["hidden_strip_panels"] == ["history"]
    assert payload["coaccessibility"]["coaccTrackMode"] == "arc"
    assert payload["clusters"]["read_sort_order"]["primary"] == ["read_a"]

    resp = client.post("/api/jupyter/settings", json={
        "capture_regions": [{"id": "cap2", "chrom": "chr3R", "start": 1, "end": 5}],
        "capture_padding": 25,
        "catalog": [{"id": "cat2"}],
        "composite_tracks": [{"id": "comp2"}],
        "saved_tracks": [{"id": "saved2"}],
        "peaks_locked": False,
        "selected_peaks": [4, 5],
        "peaks_by_rule": {"rule-b": [{"index": 4, "start": 40, "end": 60}]},
        "open_panel": "cluster-detail",
        "close_panel": "history",
        "hidden_strip_panels": ["history", "read-stats"],
        "coacc_settings": {"coaccTrackMode": "virtual4c", "coaccBinSize": 500},
    })
    assert resp.status_code == 200
    assert set(resp.json()["updated"]) == {
        "capture_regions",
        "capture_padding",
        "catalog",
        "composite_tracks",
        "saved_tracks",
        "peaks_locked",
        "selected_peaks",
        "peaks_by_rule",
        "open_panel",
        "close_panel",
        "hidden_strip_panels",
        "coacc_settings",
    }
    pending = client.get("/api/jupyter/state").json()["settings_update"]
    assert pending["capture_regions"][0]["id"] == "cap2"
    assert pending["capture_padding"] == 25
    assert pending["peaks_locked"] is False
    assert pending["selected_peaks"] == [4, 5]
    assert pending["peaks_by_rule"]["rule-b"][0]["start"] == 40
    assert pending["panel_ops"] == [["close", "history"], ["open", "cluster-detail"]]
    assert "open_panel" not in pending and "close_panel" not in pending
    assert pending["hidden_strip_panels"] == ["history", "read-stats"]
    assert pending["coacc_settings"]["coaccTrackMode"] == "virtual4c"


def test_jupyter_peak_import_and_lock_only_update_round_trip(client):
    import server as srv

    srv.jupyter_state.clear_all()

    resp = client.post("/api/jupyter/import_peaks", json={
        "peaks": [{"chrom": "2R", "start": 100, "end": 150, "name": "peak_a"}],
        "chrom": "2R",
        "label": "saved peaks",
        "lock": True,
        "select": True,
        "replace_existing": True,
    })
    assert resp.status_code == 200
    assert resp.json()["count"] == 1

    state = client.get("/api/jupyter/state").json()
    assert state["peak_import"]["peaks"] == [
        {"chrom": "2R", "start": 100, "end": 150, "name": "peak_a"}
    ]
    assert state["peak_import"]["chrom"] == "2R"
    assert state["peak_import"]["label"] == "saved peaks"
    assert state["peak_import"]["lock"] is True
    assert state["peak_import"]["select"] is True
    assert state["peak_import"]["replace_existing"] is True

    resp = client.post("/api/jupyter/peak_rules", json={
        "rules": [],
        "lock": False,
        "clear_peaks": False,
        "rescan": False,
    })
    assert resp.status_code == 200

    state = client.get("/api/jupyter/state").json()
    assert state["peak_rules_update"] == {
        "id": state["peak_rules_update"]["id"],
        "rules": [],
        "lock": False,
        "clear_peaks": False,
        "rescan": False,
    }
