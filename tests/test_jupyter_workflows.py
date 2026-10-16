"""Workflow-level tests for the Jupyter/API bridge.

These cover the bidirectional contract:
  * Python/Jupyter commands are queued once for browser polling.
  * Browser-synced GUI state is readable back from notebooks.
"""

import pytest


@pytest.fixture
def jupyter_workflow_state():
    import server as srv
    from models.domain import Dataset, JupyterState

    old_jupyter_state = srv.jupyter_state
    old_datasets = dict(srv.state.datasets)
    old_order = list(srv.state.dataset_order)
    old_chroms = list(srv.state.chroms)

    srv.jupyter_state = JupyterState()
    srv.state.datasets.clear()
    srv.state.dataset_order.clear()
    srv.state.datasets["ds1"] = Dataset("ds1", "/tmp/ds1.bam", "Dataset 1", data_type="bam")
    srv.state.dataset_order.append("ds1")
    srv.state.chroms = []

    try:
        yield srv
    finally:
        srv.jupyter_state = old_jupyter_state
        srv.state.datasets.clear()
        srv.state.datasets.update(old_datasets)
        srv.state.dataset_order[:] = old_order
        srv.state.chroms = old_chroms


def test_jupyter_command_queue_round_trip_for_active_browser_control(client, jupyter_workflow_state):
    client.post("/api/jupyter/goto", json={"chrom": "chr2L", "start": 100, "end": 300})
    client.post("/api/jupyter/push_reads", json={
        "label": "Notebook subset",
        "reads": [{"id": "read_a", "intervals": [[0, 100, 100]]}],
    })
    client.post("/api/jupyter/order", json={"dataset_id": "ds1", "read_ids": ["read_b", "read_a"]})
    client.post("/api/jupyter/filter", json={"dataset_id": "ds1", "read_ids": ["read_a"]})
    client.post("/api/jupyter/selection?dataset_id=ds1", json=["read_a"])
    client.post("/api/jupyter/highlights", json={
        "type": "read",
        "dataset_id": "ds1",
        "read_ids": ["read_a"],
        "color": "#ff0000",
        "label": "A",
    })
    client.post("/api/jupyter/markers", json={
        "group": "notebook",
        "markers": [{"position": 150, "color": "#00ff00"}],
    })
    client.post("/api/jupyter/footprint_colors", json={
        "group": "notebook",
        "footprint_colors": {"read_a": [{"start": 10, "end": 20, "color": "#0000ff"}]},
    })
    client.post("/api/jupyter/import_peaks", json={
        "chrom": "chr2L",
        "label": "Saved peaks",
        "peaks": [{"start": 120, "end": 160, "name": "peak_a"}],
        "lock": True,
        "select": True,
        "replace_existing": True,
    })
    client.post("/api/jupyter/peak_rules", json={
        "rules": [{"id": "rule-a", "name": "TF", "source": "tf_layer", "enabled": True}],
        "lock": True,
        "clear_peaks": True,
        "rescan": False,
    })
    client.post("/api/jupyter/settings", json={
        "analysis_sample_seed": "paper-v1",
        "analysis_sample_count": 5000,
        "display_sample_count": 600,
        "read_display_mode": "all",
        "all_reads_display_cap": 12000,
        "background_read_cap": 900,
        "spanning_only": True,
        "enabled_mod_types": {"msp": True},
        "enabled_meta_profiles": {"msp": True},
        "cached_layer_types": {"msp": False},
        "click_target_layer": "msp",
        "footprint_analysis_layer": "tf_layer",
        "active_colormap": {
            "name": "Notebook labels",
            "rules": [{"id": "r1", "name": "FIRE", "targetLayers": ["msp"]}],
            "qualityFilters": [{"layer": "msp", "qualityName": "aq", "minValue": 230, "enabled": True}],
        },
        "coacc_settings": {"coaccLayer": "msp", "coaccTrackMode": "arc"},
        "fill_read_height": True,
        "show_coverage_histogram": True,
        "open_panel": "read-stats",
    })

    state = client.get("/api/jupyter/state").json()

    assert state["goto"] == {"chrom": "chr2L", "start": 100, "end": 300}
    assert state["pushed_reads"] == [{"id": "read_a", "intervals": [[0, 100, 100]]}]
    assert state["read_order"] == {"ds1": ["read_b", "read_a"]}
    assert state["read_filter"] == {"ds1": ["read_a"]}
    assert state["selected_reads"] == ["read_a"]
    assert state["selected_read_ids"] == {"ds1": ["read_a"]}
    assert state["highlights"][0]["read_ids"] == ["read_a"]
    assert state["markers"][0]["markers"][0]["position"] == 150
    assert state["footprint_colors"][0]["footprint_colors"]["read_a"][0]["start"] == 10
    assert state["peak_import"]["peaks"][0]["name"] == "peak_a"
    assert state["peak_rules_update"]["rules"][0]["id"] == "rule-a"
    assert state["settings_update"]["enabled_mod_types"] == {"fire": True}
    assert state["settings_update"]["read_display_mode"] == "all"
    assert state["settings_update"]["all_reads_display_cap"] == 12000
    assert state["settings_update"]["background_read_cap"] == 900
    assert state["settings_update"]["enabled_meta_profiles"] == {"fire": True}
    assert state["settings_update"]["cached_layer_types"] == {"fire": False}
    assert state["settings_update"]["click_target_layer"] == "fire"
    assert state["settings_update"]["footprint_analysis_layer"] == "tf"
    assert state["settings_update"]["active_colormap"]["qualityFilters"][0]["layer"] == "fire"
    assert state["settings_update"]["active_colormap"]["rules"][0]["targetLayers"] == ["fire"]
    assert state["settings_update"]["coacc_settings"]["coaccLayer"] == "fire"
    assert state["settings_update"]["fill_read_height"] is True
    assert state["settings_update"]["show_coverage_histogram"] is True

    second_poll = client.get("/api/jupyter/state").json()
    assert "goto" not in second_poll
    assert "peak_import" not in second_poll
    assert "peak_rules_update" not in second_poll
    assert "settings_update" not in second_poll
    assert second_poll["read_order"] == {"ds1": ["read_b", "read_a"]}


def test_browser_synced_gui_state_is_available_to_notebooks(client, jupyter_workflow_state):
    resp = client.post("/api/jupyter/settings/sync", json={
        "analysis_sample_seed": "paper-v1",
        "analysis_sample_count": None,
        "display_sample_count": 600,
        "read_display_mode": "sample",
        "all_reads_display_cap": 9000,
        "background_read_cap": 750,
        "spanning_only": True,
        "peaks_locked": True,
        "selected_peaks": [1, 2],
        "selected_peak_count": 2,
        "selected_read_ids": {"ds1": ["read_a", "read_b"]},
        "peak_rules": [{"id": "rule-a", "source": "tf_layer", "enabled": True}],
        "peaks_by_rule": {"rule-a": [{"index": 1, "start": 120, "end": 160}]},
        "active_colormap": {
            "name": "Browser labels",
            "rules": [{"id": "r1", "targetLayers": ["msp"]}],
            "qualityFilters": [{"layer": "msp", "qualityName": "aq", "minValue": 230, "enabled": True}],
        },
        "active_quality_filters": [{"layer": "msp", "quality_name": "aq", "min_value": 230}],
        "enabled_mod_types": {"msp": True},
        "enabled_meta_profiles": {"msp": True},
        "cached_layer_types": {"msp": False},
        "click_target_layer": "msp",
        "footprint_analysis_layer": "tf_layer",
        "coacc_settings": {"coaccLayer": "msp", "coaccTrackMode": "arc"},
        "fill_read_height": True,
        "read_row_height": "auto",
        "show_coverage_histogram": True,
        "max_region_for_reads": 250000,
        "show_genome_overview": False,
        "active_panels": [{"id": "panel-read-stats", "content_type": "read-stats"}],
        "hidden_strip_panels": ["history"],
        "cluster_assignments": {"ds1": {"read_a": 1}},
        "cluster_order": {"ds1": [1]},
        "read_sort_order": {"ds1": ["read_a"]},
        "session_manifest": {"sessionName": "Browser session"},
    })
    assert resp.status_code == 200

    analysis = client.get("/api/jupyter/analysis_state").json()
    assert analysis["manifest"]["sessionName"] == "Browser session"
    assert analysis["reproducibility"]["analysis_sample_seed"] == "paper-v1"
    assert analysis["reproducibility"]["read_display_mode"] == "sample"
    assert analysis["reproducibility"]["all_reads_display_cap"] == 9000
    assert analysis["reproducibility"]["background_read_cap"] == 750
    assert analysis["selected_peaks"] == [1, 2]
    assert analysis["selected_read_ids"] == {"ds1": ["read_a", "read_b"]}
    assert analysis["active_colormap"]["qualityFilters"][0]["layer"] == "fire"
    assert analysis["active_quality_filters"][0]["layer"] == "fire"
    assert analysis["display"]["enabled_mod_types"] == {"fire": True}
    assert analysis["display"]["read_display_mode"] == "sample"
    assert analysis["display"]["all_reads_display_cap"] == 9000
    assert analysis["display"]["background_read_cap"] == 750
    assert analysis["display"]["cached_layer_types"] == {"fire": False}
    assert analysis["display"]["click_target_layer"] == "fire"
    assert analysis["display"]["footprint_analysis_layer"] == "tf"
    assert analysis["display"]["fill_read_height"] is True
    assert analysis["display"]["show_coverage_histogram"] is True
    assert analysis["coaccessibility"]["coaccLayer"] == "fire"
    assert analysis["clusters"]["read_sort_order"] == {"ds1": ["read_a"]}
    assert analysis["active_panels"] == [{"id": "panel-read-stats", "content_type": "read-stats"}]
    assert analysis["hidden_strip_panels"] == ["history"]

    selection = client.get("/api/jupyter/selection?dataset_id=ds1").json()
    assert selection["read_ids"] == ["read_a", "read_b"]
    assert selection["read_ids_by_dataset"] == {"ds1": ["read_a", "read_b"]}
