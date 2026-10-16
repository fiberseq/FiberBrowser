"""B4 round 6: anonymized sharing scrubs the frontend's camelCase labels and positions."""
import asyncio
import json

from routers import natural_language as nl


def _share(tmp_path, monkeypatch, **fields):
    monkeypatch.setattr(nl, "USAGE_LOG_DIR", tmp_path / "usage_logs")
    monkeypatch.setattr(nl, "SHARED_USAGE_FILE", tmp_path / "shared_usage.jsonl")
    asyncio.run(nl.log_session(nl.SessionLogRequest(session_id="s1", started_at=1.0, share=True, **fields)))
    return (tmp_path / "shared_usage.jsonl").read_text()


def test_history_snapshot_camel_case_labels_and_positions_are_scrubbed(tmp_path, monkeypatch):
    # The shape the browser sends: _historyStack entries, frontend field names.
    snapshot = {
        "label": "Prepend labeling rule",
        "timestamp": 1727170000000,
        "kind": "labeling",
        "state": {
            "chrom": "chr17", "start": 7661000, "end": 7662000,
            "activeColormap": {
                "name": "Default",
                "rules": [{
                    "id": "rule-1", "name": "Patient_42 tumor", "color": "#22c55e",
                    "conditions": [{
                        "target": "region", "regionChrom": "chr17",
                        "regionStart": 7661779, "regionEnd": 7661859,
                        "regionLabel": "Patient_42 tumor",
                    }],
                }],
            },
            "footprintGroups": [{"id": "g1", "name": "TF", "referenceAbsStart": 7661801,
                                 "referenceAbsEnd": 7661843, "referenceChrom": "chr17"}],
        },
    }
    text = _share(
        tmp_path, monkeypatch, snapshots=[snapshot],
        command_history=[{"text": "label Patient_42 tumor green"}],
    )
    for secret in ("Patient_42", "7661779", "7661859", "7661801", "7661843"):
        assert secret not in text, secret
    state = json.loads(text)["snapshots"][0]["state"]
    condition = state["activeColormap"]["rules"][0]["conditions"][0]
    assert condition["regionLabel"] == "<note>"
    assert condition["regionStart"] == 7661000 and condition["regionEnd"] == 7661000
    assert state["footprintGroups"][0]["referenceAbsStart"] == 7661000


def test_norm_key_snake_cases_frontend_names():
    assert nl._norm_key("regionLabel") == "region_label"
    assert nl._norm_key("relativeTSS") == "relative_tss"
    assert nl._norm_key("fastaPath") == "fasta_path"
    assert nl._norm_key("region-label") == "region_label"
