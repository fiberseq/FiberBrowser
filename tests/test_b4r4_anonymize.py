"""B4 round 4: anonymized usage logs drop the user's own names and exact positions."""
import asyncio
import json

from routers import natural_language as nl


def _share(tmp_path, monkeypatch, **fields):
    monkeypatch.setattr(nl, "USAGE_LOG_DIR", tmp_path / "usage_logs")
    monkeypatch.setattr(nl, "SHARED_USAGE_FILE", tmp_path / "shared_usage.jsonl")
    asyncio.run(nl.log_session(nl.SessionLogRequest(session_id="s1", started_at=1.0, share=True, **fields)))
    return (tmp_path / "shared_usage.jsonl").read_text()


def test_user_names_are_redacted_everywhere(tmp_path, monkeypatch):
    text = _share(
        tmp_path, monkeypatch,
        command_history=[{
            "id": "cmd-1727170000000",
            "text": "make a cluster rule called Patient_42_trial",
            "messages": ['Added cluster rule "Patient_42_trial".'],
            "actions": [{"type": "add_cluster_rule", "payload": {"type": "add_cluster_rule", "name": "Patient_42_trial"}}],
        }],
        activity_log=[
            {"label": "change:savedClusters", "details": {"value": {"items": [{"name": "Cohort_B_saved", "k": 3}]}}},
            {"label": "change:footprintGroups", "details": {"value": {"items": [{"name": "MyGroupX"}, {"name": "TF"}]}}},
            {"label": "change:savedTracks", "details": {"value": {"items": [{"label": "lab_secret_track"}]}}},
        ],
        snapshots=[{"state": {"peakRules": [{"name": "Nucleosome"}, {"name": "LabRuleZ"}]}}],
    )
    for name in ("Patient_42_trial", "Cohort_B_saved", "MyGroupX", "lab_secret_track", "LabRuleZ"):
        assert name not in text, name
    # The browser's own default names carry no identity and stay.
    assert '"TF"' in text and '"Nucleosome"' in text
    record = json.loads(text)
    assert record["command_history"][0]["id"] == "cmd-1727170000000"


def test_positions_in_text_are_bucketed_and_raw_diagnostics_dropped(tmp_path, monkeypatch):
    text = _share(
        tmp_path, monkeypatch,
        command_history=[{
            "text": "go to chr17:7661779-7687550",
            "trace": ["Viewport: hg38 chr17:7,661,779-7,687,550"],
            "messages": ["Moved to chr17:7661779-7687550."],
            "debug": {"rawContent": '{"chrom": "chr17", "start": 7661779}', "thinking": "exact 7661779"},
            "actions": [{"type": "navigate", "payload": {"type": "navigate", "region": "chr17:7661779-7687550"}}],
        }],
    )
    for exact in ("7661779", "7687550", "7,661,779", "7,687,550"):
        assert exact not in text, exact
    record = json.loads(text)
    entry = record["command_history"][0]
    assert entry["text"] == "go to chr17:7661000-7687000"
    assert entry["trace"] == ["Viewport: hg38 chr17:7,661,000-7,687,000"]
    assert entry["debug"] == "<redacted>"


def test_full_details_keep_names_and_positions(tmp_path, monkeypatch):
    text = _share(
        tmp_path, monkeypatch, share_full_details=True,
        command_history=[{"text": "go to chr17:7661779", "debug": {"rawContent": "x"},
                          "actions": [{"type": "add_cluster_rule", "name": "Patient_42_trial"}]}],
    )
    assert "7661779" in text and "Patient_42_trial" in text and "rawContent" in text
