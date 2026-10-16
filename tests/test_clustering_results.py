from types import SimpleNamespace

from services.clustering_results import (
    assemble_assignment_array_results,
    assemble_cluster_all_results,
    count_cluster_assignments,
    element_read_ids_for_result,
    split_prefixed_assignments,
)


class _State:
    def __init__(self):
        self.datasets = {
            "ds1": SimpleNamespace(),
            "ds2": SimpleNamespace(),
        }

    def get_dataset(self, dataset_id):
        return self.datasets.get(dataset_id)


def test_count_cluster_assignments_counts_labels_without_relabeling():
    assert count_cluster_assignments({"r1": 2, "r2": 2, "r3": 5}) == {2: 2, 5: 1}


def test_split_prefixed_assignments_filters_one_result_key_in_assignment_order():
    assignments = {
        "ds1::r1": 0,
        "ds2::rA": 1,
        "ds1::r2": 0,
        "unprefixed": 9,
    }

    split, filtered = split_prefixed_assignments(assignments, "ds1")

    assert split == {"r1": 0, "r2": 0}
    assert filtered == ["r1", "r2"]


def test_element_read_ids_for_result_strips_dataset_prefixes():
    element_info = {
        "element_read_ids": {
            0: ["ds1::r1", "ds2::rA", "ds1::r2"],
            1: ["ds2::rB"],
        }
    }

    assert element_read_ids_for_result(element_info, "ds1") == {0: ["r1", "r2"], 1: []}


def test_assemble_cluster_all_results_updates_only_base_dataset_state():
    state = _State()
    element_info = {
        "n_elements": 2,
        "cluster_patterns": {0: [1, 0]},
        "element_read_ids": {0: ["ds1::r1", "ds1_extra::rX", "ds2::rA"]},
        "method": "binary",
    }

    results = assemble_cluster_all_results(
        assignments={
            "ds1::r1": 0,
            "ds1::r2": 1,
            "ds1_extra::rX": 0,
            "ds2::rA": 1,
        },
        dataset_read_ids={
            "ds1": ["r1", "r2"],
            "ds1_extra": ["rX"],
            "ds2": ["rA"],
        },
        dataset_read_stats={
            "ds1": {"eligible_read_count": 3, "peak_covering_read_count": 2, "analysis_read_count": 2},
            "ds1_extra": {"eligible_read_count": 1, "peak_covering_read_count": 1, "analysis_read_count": 1},
        },
        dataset_ids=["ds1", "ds2"],
        state=state,
        element_info=element_info,
        peaks=[[10, 20], [30, 40]],
        peak_modes=["tf", "nuc"],
        start=100,
    )

    assert results["ds1"]["assignments"] == {"r1": 0, "r2": 1}
    assert results["ds1"]["cluster_counts"] == {0: 1, 1: 1}
    assert results["ds1"]["filtered_read_ids"] == ["r1", "r2"]
    assert results["ds1"]["working_count"] == 2
    assert results["ds1"]["eligible_read_count"] == 3
    assert results["ds1_extra"]["assignments"] == {"rX": 0}
    assert not hasattr(state.datasets["ds1"], "cluster_assignments") or state.datasets["ds1"].cluster_assignments == {"r1": 0, "r2": 1}
    assert not hasattr(state.datasets["ds2"], "cluster_assignments") or state.datasets["ds2"].cluster_assignments == {"rA": 1}
    assert state.datasets["ds1"].cluster_element_info == {
        "n_elements": 2,
        "cluster_patterns": {0: [1, 0]},
        "element_read_ids": {0: ["r1"]},
        "method": "binary",
    }
    assert state.datasets["ds1"].cluster_peak_regions == [
        {"start": 110, "end": 120, "mode": "tf"},
        {"start": 130, "end": 140, "mode": "nuc"},
    ]
    assert not hasattr(state.datasets["ds1"], "cluster_assignments_extra")


def test_assemble_assignment_array_results_splits_and_updates_dataset_state():
    state = _State()

    results = assemble_assignment_array_results(
        all_read_ids=[("ds1", "r1"), ("ds2", "rA"), ("ds1", "r2")],
        assignments=[2, 1, 2],
        dataset_ids=["ds1", "ds2", "missing"],
        state=state,
    )

    assert results == {
        "ds1": {
            "assignments": {"r1": 2, "r2": 2},
            "cluster_counts": {2: 2},
        },
        "ds2": {
            "assignments": {"rA": 1},
            "cluster_counts": {1: 1},
        },
    }
    assert state.datasets["ds1"].cluster_assignments == {"r1": 2, "r2": 2}
    assert state.datasets["ds2"].cluster_assignments == {"rA": 1}
