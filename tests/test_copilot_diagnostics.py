"""Copilot troubleshooting context: the Diagnostics / State details blocks of
the user message, server-side diagnostics, and anonymized sharing of both."""
import asyncio
import json
from types import SimpleNamespace

import pandas as pd

import services.natural_language_commands as nlc
from routers import natural_language as nl


def _state(datasets=None, gtf=True):
    datasets = datasets or {}
    return SimpleNamespace(
        dataset_order=list(datasets),
        datasets=datasets,
        gtf_data={"transcripts": pd.DataFrame([{"transcript_id": "t1"}])} if gtf else None,
        motif_tracks=[],
    )


CONTEXT = {"chrom": "chr2L", "start": 1000, "end": 2000, "currentGenome": "dm6"}


def test_message_without_troubleshooting_is_unchanged():
    state = _state()
    plain = nlc._user_message(state, "why are no reads visible?", CONTEXT)
    assert "Diagnostics:" not in plain and "State details:" not in plain
    assert plain == nlc._user_message(state, "why are no reads visible?", CONTEXT,
                                      diagnostics=None, raw_state=None)


def test_diagnostics_block_lists_causes_worst_first_with_fix_anchors():
    msg = nlc._user_message(_state(), "why are no reads visible?", CONTEXT, diagnostics=[
        {"code": "panel_at_other_locus", "severity": "info", "message": "The copy shows its own region."},
        {"code": "filter_matches_none", "severity": "blocking",
         "message": "A read filter on \"A3\" matched no reads, so none are shown.", "fix_anchor": "clear-filter"},
        {"code": "Bad Code!", "severity": "nonsense", "message": "  spaced   out  "},
    ], raw_state={"viewport": {"chrom": "chr2L", "start": 1000, "end": 2000}})
    lines = msg.splitlines()
    block = lines[lines.index("Diagnostics:") + 1:]
    assert block[0] == ('- [blocking] filter_matches_none: A read filter on "A3" matched no reads, '
                        'so none are shown. (fix: clear-filter)')
    assert block[1] == "- [info] panel_at_other_locus: The copy shows its own region."
    assert block[2] == "- [info] badcode: spaced out"
    # A blocking cause explains it: no raw state.
    assert "State details:" not in msg
    assert msg.index("Diagnostics:") < msg.index("User request:")


def test_state_details_when_nothing_explains_the_problem():
    raw = {
        "viewport": {"chrom": "chr2L", "start": 1000, "end": 2000},
        "panels": [{"id": "p1", "dataset_id": "ds1", "filter": "none", "reads": {"shown": 12, "in_scope": 12}}],
        "settings": {"spanning_only": False, "read_window_bp": 100000, "layers": {"nuc": True}},
    }
    msg = nlc._user_message(_state(), "why are the reads grey?", CONTEXT,
                            diagnostics=[{"code": "still_loading", "severity": "info", "message": "Reads are loading."}],
                            raw_state=raw)
    assert "- [info] still_loading: Reads are loading." in msg
    assert "State details:" in msg
    assert "  viewport: chr2L:1,000-2,000" in msg
    assert '  panels: [{"id":"p1","dataset_id":"ds1","filter":"none","reads":{"shown":12,"in_scope":12}}]' in msg


def test_state_details_are_bounded():
    raw = {f"key{i}": "x" * 600 for i in range(20)}
    msg = nlc._user_message(_state(), "stuck", CONTEXT, diagnostics=[], raw_state=raw)
    details = msg.split("State details:\n", 1)[1].split("\n\nUser request:", 1)[0]
    assert len(details) < 2200
    assert details.rstrip().endswith("...")


def test_server_adds_no_gtf_and_a_dataset_missing_the_chromosome(monkeypatch):
    ds = SimpleNamespace(label="Sample A", paths=["/data/a.bam"], path="/data/a.bam", companion_layers={})
    monkeypatch.setattr(nlc, "_dataset_chrom_names", lambda dataset: ["chr3R", "chrX"])
    msg = nlc._user_message(_state({"ds1": ds}, gtf=False), "why no reads?", CONTEXT, diagnostics=[])
    assert ('- [blocking] chrom_missing_in_dataset: "Sample A" has no reads on chr2L '
            "(its files don't contain that chromosome). (fix: search-bar)") in msg
    assert "- [info] no_gtf:" in msg and "(fix: load-gtf)" in msg
    # Aliases match: '2L' is the same contig.
    monkeypatch.setattr(nlc, "_dataset_chrom_names", lambda dataset: ["2L"])
    msg = nlc._user_message(_state({"ds1": ds}), "why no reads?", CONTEXT, diagnostics=[])
    assert "chrom_missing_in_dataset" not in msg and "no_gtf" not in msg


def test_dataset_chrom_names_skip_remote_and_companions():
    remote = SimpleNamespace(paths=["https://x/a.bb"], path="https://x/a.bb", companion_layers={})
    assert nlc._dataset_chrom_names(remote) is None
    only_companion = SimpleNamespace(paths=["/d/a_tf.bb"], path="/d/a_tf.bb", companion_layers={"tf": ["/d/a_tf.bb"]})
    assert nlc._dataset_chrom_names(only_companion) is None


def test_training_record_fields_render_like_a_live_request():
    import sys
    from pathlib import Path
    root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(root))
    from data.copilot_dataset import records as rec

    record = rec._r(id="t", command="why are no reads visible?", context=CONTEXT, thinking="x",
                    summary="s", actions=[],
                    diagnostics=[{"code": "zoomed_out_past_reads", "severity": "blocking",
                                  "message": "View is 250 kb; reads show up to 100 kb.",
                                  "fix_anchor": "read-window-setting"}],
                    raw_state={"viewport": {"chrom": "chr2L", "start": 1, "end": 2}})
    assert record["diagnostics"][0]["code"] == "zoomed_out_past_reads"
    assert record["raw_state"]["viewport"]["end"] == 2
    plain = rec._r(id="p", command="c", context=CONTEXT, thinking="x", summary="s", actions=[])
    assert "diagnostics" not in plain and "raw_state" not in plain


def test_shared_activity_log_anonymizes_troubleshooting_context(tmp_path, monkeypatch):
    monkeypatch.setattr(nl, "USAGE_LOG_DIR", tmp_path / "usage_logs")
    monkeypatch.setattr(nl, "SHARED_USAGE_FILE", tmp_path / "shared_usage.jsonl")
    body = {
        "text": "why are no reads visible?",
        "context": {"chrom": "chr17", "start": 7661779, "end": 7687550},
        "diagnostics": [
            {"code": "fetch_failed", "severity": "blocking", "panel_id": "panel-1", "dataset_id": "patient42",
             "message": 'Reads for "Patient42 tumor" failed to load: index missing for /Users/me/data/p42.bam'},
            {"code": "filter_active", "severity": "warning", "dataset_id": "patient42",
             "message": 'A read filter on "Patient42 tumor" shows 3 of 40 reads.', "fix_anchor": "clear-filter"},
        ],
        "raw_state": {
            "viewport": {"chrom": "chr17", "start": 7661779, "end": 7687550},
            "datasets": [{"id": "patient42", "label": "Patient42 tumor", "type": "bam"}],
            "panels": [{"id": "panel-1", "dataset_id": "patient42",
                        "own_view": {"chrom": "chr17", "start": 7661779, "end": 7662000}}],
        },
    }
    entry = {"timestamp": 1, "kind": "api", "method": "POST", "path": "/api/nl/stream", "body": body}
    asyncio.run(nl.log_session(nl.SessionLogRequest(session_id="s1", started_at=1.0, share=True,
                                                    activity_log=[entry])))
    text = (tmp_path / "shared_usage.jsonl").read_text()
    for secret in ("Patient42", "patient42", "7661779", "7687550", "p42.bam", "/Users/me"):
        assert secret not in text, secret
    shared = json.loads(text)["activity_log"][0]["body"]
    assert shared["diagnostics"][1]["fix_anchor"] == "clear-filter"
    assert shared["diagnostics"][1]["code"] == "filter_active"
    assert shared["raw_state"]["viewport"]["start"] == 7661000


def test_quoted_names_in_diagnostic_messages_are_redacted_even_when_unlisted(tmp_path, monkeypatch):
    # A label past raw_state's dataset cap appears only inside a message.
    monkeypatch.setattr(nl, "USAGE_LOG_DIR", tmp_path / "usage_logs")
    monkeypatch.setattr(nl, "SHARED_USAGE_FILE", tmp_path / "shared_usage.jsonl")
    body = {"text": "why?", "diagnostics": [
        {"code": "panel_collapsed", "severity": "info", "message": 'The "Mouse7 liver" panel is minimized.'}]}
    entry = {"timestamp": 1, "kind": "api", "method": "POST", "path": "/api/nl/plan", "body": body}
    asyncio.run(nl.log_session(nl.SessionLogRequest(session_id="s2", started_at=1.0, share=True,
                                                    activity_log=[entry])))
    text = (tmp_path / "shared_usage.jsonl").read_text()
    assert "Mouse7" not in text
    shared = json.loads(text)["activity_log"][0]["body"]["diagnostics"][0]
    assert shared["message"] == 'The "<name>" panel is minimized.'
    # Full-details sharing keeps it.
    monkeypatch.setattr(nl, "SHARED_USAGE_FILE", tmp_path / "full.jsonl")
    asyncio.run(nl.log_session(nl.SessionLogRequest(session_id="s3", started_at=1.0, share=True,
                                                    share_full_details=True, activity_log=[entry])))
    assert "Mouse7 liver" in (tmp_path / "full.jsonl").read_text()
