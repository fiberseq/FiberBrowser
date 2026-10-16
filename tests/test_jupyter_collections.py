from models.domain import JupyterState
from models.requests import (
    FootprintColorRequest,
    HighlightRequest,
    ImportPeaksRequest,
    JupyterPeakRulesRequest,
    MarkerRequest,
)
from services.jupyter_collections import (
    add_footprint_colors_for_request,
    add_highlight_for_request,
    add_markers_for_request,
    clear_footprint_colors_for_request,
    clear_highlights_for_request,
    clear_markers_for_request,
    get_footprint_colors_payload,
    get_highlights_payload,
    get_markers_payload,
    queue_peak_import_for_request,
    queue_peak_rules_update_for_request,
    remove_footprint_colors_for_request,
    remove_highlight_for_request,
    remove_marker_for_request,
)


def test_highlight_endpoint_helpers_round_trip_collection_payload():
    state = JupyterState()

    added = add_highlight_for_request(
        state,
        HighlightRequest(type="read", read_ids=["r1"], color="#ff0000", label="hit", dataset_id="ds1"),
    )

    highlight_id = added["highlight_id"]
    assert added["success"] is True
    assert get_highlights_payload(state)["highlights"] == [{
        "id": highlight_id,
        "type": "read",
        "color": "#ff0000",
        "label": "hit",
        "dataset_id": "ds1",
        "read_ids": ["r1"],
    }]

    assert remove_highlight_for_request(state, highlight_id) == {"success": True}
    assert get_highlights_payload(state) == {"highlights": []}
    assert state.version == 2

    add_highlight_for_request(state, HighlightRequest(type="read", read_ids=["r2"]))
    assert clear_highlights_for_request(state) == {"success": True}
    assert get_highlights_payload(state) == {"highlights": []}


def test_marker_endpoint_helpers_support_group_clear():
    state = JupyterState()

    added_a = add_markers_for_request(
        state,
        MarkerRequest(group="a", markers=[{"position": 10, "color": "#111111"}]),
    )
    add_markers_for_request(
        state,
        MarkerRequest(group="b", markers=[{"position": 20, "color": "#222222"}]),
    )

    assert len(get_markers_payload(state)["markers"]) == 2
    assert remove_marker_for_request(state, added_a["marker_id"]) == {"success": True}
    assert get_markers_payload(state)["markers"][0]["group"] == "b"

    add_markers_for_request(state, MarkerRequest(group="a", markers=[]))
    assert clear_markers_for_request(state, "a") == {"success": True}
    assert [marker["group"] for marker in get_markers_payload(state)["markers"]] == ["b"]


def test_footprint_color_endpoint_helpers_support_group_clear():
    state = JupyterState()

    added = add_footprint_colors_for_request(
        state,
        FootprintColorRequest(group="a", footprint_colors={"r1": [{"start": 1, "end": 2, "color": "#00f"}]}),
    )
    add_footprint_colors_for_request(
        state,
        FootprintColorRequest(group="b", footprint_colors={"r2": []}),
    )

    assert remove_footprint_colors_for_request(state, added["color_id"]) == {"success": True}
    assert get_footprint_colors_payload(state)["footprint_colors"][0]["group"] == "b"

    add_footprint_colors_for_request(state, FootprintColorRequest(group="a", footprint_colors={}))
    assert clear_footprint_colors_for_request(state, "a") == {"success": True}
    assert [group["group"] for group in get_footprint_colors_payload(state)["footprint_colors"]] == ["b"]


def test_peak_import_and_rules_helpers_queue_one_shot_payloads():
    state = JupyterState()

    imported = queue_peak_import_for_request(
        state,
        ImportPeaksRequest(
            chrom="chr2L",
            label="Saved",
            peaks=[{"start": 10, "end": 20}],
            lock=True,
            select=True,
            replace_existing=True,
        ),
    )
    updated = queue_peak_rules_update_for_request(
        state,
        JupyterPeakRulesRequest(
            rules=[{"id": "rule-a", "enabled": True}],
            lock=False,
            clear_peaks=True,
            rescan=False,
        ),
    )

    assert imported["success"] is True
    assert imported["count"] == 1
    assert state.pending_peak_import["chrom"] == "chr2L"
    assert updated["success"] is True
    assert updated["count"] == 1
    assert state.pending_peak_rules_update["rules"][0]["id"] == "rule-a"
    assert state.version == 2
