from scripts.distill_session_logs import distill_session


def test_distill_session_captures_recent_analysis_and_track_state_changes():
    payload = {
        "session_id": "s1",
        "started_at": 123,
        "snapshots": [
            {
                "timestamp": 1000,
                "label": "before",
                "state": {
                    "chrom": "2R",
                    "start": 100,
                    "end": 200,
                    "analysisSortRules": [],
                    "analysisFilterRules": [],
                    "orthogonalTracks": [],
                    "enabledAnnotationTypes": {"5mC": True},
                    "activeColormap": {"rules": [], "qualityFilters": []},
                },
            },
            {
                "timestamp": 2000,
                "label": "after",
                "state": {
                    "chrom": "2R",
                    "start": 100,
                    "end": 200,
                    "analysisSortRules": [
                        {
                            "id": "sort_pol2",
                            "name": "Paused Pol II first",
                            "terms": [{"source": "transcription_state", "transcriptionState": "pause"}],
                        }
                    ],
                    "analysisFilterRules": [
                        {"id": "filter_tf", "name": "TF count >= 2"}
                    ],
                    "orthogonalTracks": [
                        {"index": 0, "label": "ATAC", "path": "https://example.org/atac.bw"}
                    ],
                    "enabledAnnotationTypes": {"5mC": False},
                    "activeColormap": {
                        "rules": [],
                        "qualityFilters": [{"layer": "fire", "quality": "aq", "min": 230}],
                    },
                },
            },
        ],
        "activity_log": [],
    }

    transitions = distill_session(payload)

    assert len(transitions) == 1
    diffs = transitions[0]["diffs"]
    assert diffs["analysis_rules"]["analysisSortRules"]["added"][0]["id"] == "sort_pol2"
    assert diffs["analysis_rules"]["analysisFilterRules"]["added"][0]["id"] == "filter_tf"
    assert diffs["orthogonalTracks"]["added"][0]["label"] == "ATAC"
    assert diffs["enabledAnnotationTypes"]["after"] == {"5mC": False}
    assert diffs["color_settings"]["qualityFilters"] == "changed"


def test_activity_only_distillation_keeps_new_analysis_api_calls():
    payload = {
        "session_id": "s2",
        "started_at": 123,
        "snapshots": [{"state": {"chrom": "2R", "start": 100, "end": 200}}],
        "activity_log": [
            {
                "kind": "api",
                "timestamp": 100,
                "method": "POST",
                "path": "/api/filter_by_analysis_rule",
                "body": {"transcription_state": "pause"},
            },
            {
                "kind": "api",
                "timestamp": 101,
                "method": "POST",
                "path": "/api/add_track?path=https%3A%2F%2Fexample.org%2Fatac.bw",
                "body": None,
            },
            {
                "kind": "api",
                "timestamp": 102,
                "method": "POST",
                "path": "/api/tracks/2/filter",
                "body": {"filter_names": ["MA0007"]},
            },
            {
                "kind": "api",
                "timestamp": 103,
                "method": "GET",
                "path": "/api/pick_file",
                "body": None,
            },
        ],
    }

    transitions = distill_session(payload)

    assert len(transitions) == 1
    paths = [entry["path"] for entry in transitions[0]["api_calls"]]
    assert "/api/filter_by_analysis_rule" in paths
    assert "/api/add_track?path=https%3A%2F%2Fexample.org%2Fatac.bw" in paths
    assert "/api/tracks/2/filter" in paths
    assert "/api/pick_file" not in paths
