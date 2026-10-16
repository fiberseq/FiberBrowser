"""Tests for shared API query parameter parsing."""

from services.query_params import (
    parse_csv_int_set,
    parse_csv_list,
    parse_csv_set,
    parse_optional_csv_list,
    resolve_dataset_id,
    resolve_dataset_ids,
)


class FakeState:
    dataset_order = ["primary", "secondary", "missing"]
    datasets = {"primary": object(), "secondary": object()}

    def get_dataset(self, dataset_id):
        return self.datasets.get(dataset_id)


def test_parse_csv_list_accepts_strings_and_iterables():
    assert parse_csv_list("a,b, c ,,") == ["a", "b", "c"]
    assert parse_csv_list([" a ", "b", ""]) == ["a", "b"]
    assert parse_csv_list(None) == []


def test_parse_optional_csv_list_returns_none_for_empty_values():
    assert parse_optional_csv_list("") is None
    assert parse_optional_csv_list(None) is None
    assert parse_optional_csv_list("r1,r2") == ["r1", "r2"]


def test_parse_csv_sets_normalize_values():
    assert parse_csv_set(" r1, r2,,r1 ") == {"r1", "r2"}
    assert parse_csv_set(None) == set()
    assert parse_csv_int_set("1, 2,,1") == {1, 2}


def test_resolve_dataset_ids_prefers_multi_then_single_then_loaded_order():
    state = FakeState()

    assert resolve_dataset_ids(state, dataset_ids="a,b", dataset_id="primary") == ["a", "b"]
    assert resolve_dataset_ids(state, dataset_ids="", dataset_id="primary") == ["primary"]
    assert resolve_dataset_ids(state) == ["primary", "secondary"]


def test_legacy_primary_alias_resolves_to_first_loaded_dataset():
    class ExplicitState:
        dataset_order = ["sample_a", "sample_b"]
        datasets = {"sample_a": object(), "sample_b": object()}

    state = ExplicitState()

    assert resolve_dataset_id(state, "primary") == "sample_a"
    assert resolve_dataset_id(state, None) == "sample_a"
    assert resolve_dataset_ids(state, dataset_id="primary") == ["sample_a"]
    assert resolve_dataset_ids(state, dataset_ids="primary,sample_a,sample_b") == ["sample_a", "sample_b"]
