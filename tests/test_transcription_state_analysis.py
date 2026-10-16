from services.transcription_state import (
    filter_reads_by_transcription_state,
    has_active_transcription_filters,
    read_passes_transcription_filters,
)


GENES = [
    {"id": "geneA", "start": 90, "end": 210, "strand": "+", "name": "geneA"},
    {"id": "geneB", "start": 180, "end": 320, "strand": "+", "name": "geneB"},
]

READS = [
    {"id": "r1", "intervals": [(100, 140, 40)]},
    {"id": "r2", "intervals": [(190, 230, 40)]},
    {"id": "r3", "intervals": [(400, 430, 40)]},
]


def fake_evaluator(read, gene, region_start):
    _ = region_start
    states = {
        ("r1", "geneA"): {
            "pause": True,
            "pic": False,
            "elongating_count": 1
        },
        ("r2", "geneA"): {
            "pause": False,
            "pic": True,
            "elongating_count": 2
        },
        ("r2", "geneB"): {
            "pause": False,
            "pic": False,
            "elongating_count": 5
        },
    }
    return states.get(
        (read["id"], gene["id"]),
        {"pause": False, "pic": False, "elongating_count": 0},
    )


def test_transcription_filter_activity_detects_false_and_threshold_values():
    assert not has_active_transcription_filters({})
    assert not has_active_transcription_filters({"pause": False, "pic": False})
    assert has_active_transcription_filters({"pause": True})
    assert has_active_transcription_filters({"elongating": 0})


def test_read_passes_transcription_filters_supports_max_elongating():
    states = {"pause": False, "pic": False, "elongating_count": 6}

    assert read_passes_transcription_filters(states, {"elongating": 5})
    assert not read_passes_transcription_filters(states, {"elongating": 5, "elongating_max": 5})


def test_filter_reads_by_transcription_state_merges_genes_and_summarizes_counts():
    result = filter_reads_by_transcription_state(
        READS,
        GENES,
        {"pause": True, "elongating": 3, "elongating_max": 5},
        region_start=0,
        evaluator=fake_evaluator,
    )

    assert result["filtered_ids"] == ["r1", "r2"]
    assert result["read_states"]["r2"] == {
        "pause": False,
        "pic": True,
        "elongating_count": 5,
    }
    assert result["summary"] == {
        "total": 3,
        "overlapping_genes": 2,
        "pause": 1,
        "pic": 1,
        "elongating_gte_1": 2,
        "elongating_gte_3": 1,
        "elongating_gte_5": 1,
        "elongating_dist": {"1": 1, "2": 0, "3": 0, "4+": 1},
        "total_matching": 2,
    }


def test_filter_reads_by_transcription_state_handles_empty_reads():
    assert filter_reads_by_transcription_state([], GENES, {"pause": True}, 0) == {
        "filtered_ids": [],
        "read_states": {},
        "summary": {
            "total": 0, "overlapping_genes": 0, "pause": 0, "pic": 0,
            "elongating_gte_1": 0, "elongating_gte_3": 0, "elongating_gte_5": 0,
            "elongating_dist": {"1": 0, "2": 0, "3": 0, "4+": 0},
            "total_matching": 0,
        },
    }


def test_legacy_hyperburst_filter_flag_is_ignored():
    # Old sessions / API callers may still send the removed hyperburst flag.
    legacy = {"hyperburst": True}
    assert not has_active_transcription_filters(legacy)
    assert not read_passes_transcription_filters(
        {"pause": False, "pic": False, "elongating_count": 3}, legacy
    )
    assert has_active_transcription_filters({"pause": True, "hyperburst": True})
    result = filter_reads_by_transcription_state(
        READS, GENES, {"pause": True, "hyperburst": True}, region_start=0, evaluator=fake_evaluator,
    )
    assert result["filtered_ids"] == ["r1"]
    assert "hyperburst" not in result["summary"]


def test_legacy_hyperburst_rule_kind_is_rejected_with_clear_message():
    import pytest
    from pydantic import ValidationError
    from models.requests import AnalysisFilterRequest, SortReadsRequest

    for model in (SortReadsRequest, AnalysisFilterRequest):
        assert model(transcription_state="pause").transcription_state == "pause"
        with pytest.raises(ValidationError, match="hyperburst.*has been removed"):
            model(transcription_state="hyperburst")
