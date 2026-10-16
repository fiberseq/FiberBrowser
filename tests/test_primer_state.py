from types import SimpleNamespace

from services.primer_state import (
    clear_primer_result,
    get_primer_progress,
    get_primer_result,
    set_primer_progress,
    set_primer_progress_payload,
    set_primer_result,
)


def test_primer_progress_normalizes_payload_and_preserves_details():
    set_primer_progress_payload({
        "active": True,
        "stage": "blast",
        "progress": 150,
        "message": "BLASTing",
        "details": {"unique_primers": 12},
    })

    payload = get_primer_progress()

    assert payload == {
        "active": True,
        "stage": "blast",
        "progress": 100,
        "message": "BLASTing",
        "details": {"unique_primers": 12},
    }


def test_set_primer_progress_builds_active_payload():
    set_primer_progress("pairs", 42, "Checking pairs", candidate_pairs=100)

    payload = get_primer_progress()

    assert payload["active"] is True
    assert payload["stage"] == "pairs"
    assert payload["progress"] == 42
    assert payload["details"] == {"candidate_pairs": 100}


def test_primer_result_helpers_store_and_clear_on_browser_state():
    state = SimpleNamespace()
    result = {"pairs": [{"name": "pair1"}]}

    set_primer_result(state, result)
    assert get_primer_result(state) == result

    clear_primer_result(state)
    assert get_primer_result(state) is None
