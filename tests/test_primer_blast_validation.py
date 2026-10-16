from services.primer_blast_validation import (
    blast_filter_label,
    validate_shared_blast_result,
    validate_stranded_blast_execution,
    validate_stranded_blast_passing,
)


def test_blast_filter_label_reflects_three_prime_setting():
    assert blast_filter_label(True) == "one home hit + no off-target + no 3'-end threat"
    assert blast_filter_label(False) == "one home hit + no off-target (3'-end check OFF)"


def test_shared_blast_validation_reports_subprocess_failure():
    result = validate_shared_blast_result(set(), {}, "bad db")

    assert result["progress"]["stage"] == "error"
    assert result["response"] == {"success": False, "message": "BLAST failed. bad db"}


def test_shared_blast_validation_reports_no_home_hits():
    counts = {"AAA": {"on_target": 0, "off_target": 0, "three_prime_threats": 0}}

    result = validate_shared_blast_result(set(), counts, "")

    assert result["progress"]["stage"] == "error"
    assert "BLAST found no home hits" in result["response"]["message"]


def test_shared_blast_validation_reports_no_passing_primers():
    counts = {"AAA": {"on_target": 1, "off_target": 1, "three_prime_threats": 0}}

    result = validate_shared_blast_result(set(), counts, "", no_pass_message="none passed")

    assert result["progress"]["stage"] == "done"
    assert result["response"] == {"success": False, "message": "none passed"}


def test_shared_blast_validation_allows_passing_primers():
    counts = {"AAA": {"on_target": 1, "off_target": 0, "three_prime_threats": 0}}

    assert validate_shared_blast_result({"AAA"}, counts, "") is None


def test_stranded_blast_validation_reports_any_subprocess_failure():
    result = validate_stranded_blast_execution(
        ({"AAA": {"on_target": 1}}, ""),
        ({}, "missing db"),
    )

    assert result["progress"]["stage"] == "error"
    assert result["response"] == {"success": False, "message": "BLAST failed. missing db"}


def test_stranded_blast_validation_requires_both_strands_to_pass():
    result = validate_stranded_blast_passing({"AAA"}, set())

    assert result["progress"]["stage"] == "done"
    assert "1 fwd, 0 rev" in result["response"]["message"]


def test_stranded_blast_validation_allows_both_strands():
    assert validate_stranded_blast_passing({"AAA"}, {"TTT"}) is None
