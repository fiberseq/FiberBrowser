"""DAF-seq read strand from deamination marks (1 = C->T / CT, 0 = G->A / GA)."""
import pytest

from services.read_strand import filter_reads_by_strand, normalize_strand, read_strand


def test_majority_of_marks_decides_the_strand():
    assert read_strand({"deam": [[10, 1], [20, 1], [30, 0]]}) == "CT"
    assert read_strand({"deam": [[10, 0], [20, 0]]}) == "GA"
    assert read_strand({"deam": [[10, 0], [20, 1]]}) is None  # tie
    assert read_strand({"deam": []}) is None
    assert read_strand({}) is None
    reads = [{"id": "a", "deam": [[1, 1]]}, {"id": "b", "deam": [[1, 0]]}, {"id": "c"}]
    assert [r["id"] for r in filter_reads_by_strand(reads, "GA")] == ["b"]


def test_normalize_strand():
    assert normalize_strand("ct") == "CT"
    assert normalize_strand("both") is None and normalize_strand(None) is None
    with pytest.raises(ValueError):
        normalize_strand("XY")


def test_strand_totals_scale_when_the_read_list_is_partial():
    from services.read_strand import strand_totals
    before = [{"intervals": [[0, 100, 0]]}] * 10
    after = before[:4]
    # Complete list: exact counts.
    assert strand_totals(before, after, 10, 100) == (4, 4)
    # Spanning-only list of 10 out of 30 overlapping reads: the strand's share.
    assert strand_totals(before, after, 30, 100) == (12, 4)


def test_strand_calls_are_dropped_with_the_dataset_caches():
    from types import SimpleNamespace
    from services.dataset_registration import invalidate_dataset_caches
    from services.read_strand import strand_calls
    state = SimpleNamespace(_broad_cache={}, _working_set_cache={})
    strand_calls(state, "ds")["r1"] = "CT"
    strand_calls(state, "other")["r1"] = "GA"
    invalidate_dataset_caches(state, "ds")
    assert strand_calls(state, "ds") == {} and strand_calls(state, "other") == {"r1": "GA"}
