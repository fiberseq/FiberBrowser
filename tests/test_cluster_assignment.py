"""Regression tests for extracted cluster assignment helpers."""

import numpy as np
import pandas as pd

from helpers import make_compact_read
from services import cluster_assignment


def test_compact_cluster_assignment_groups_combinatorial_patterns():
    reads = [
        make_compact_read("r0", [[0, 100, 30], [150, 250, 150]]),
        make_compact_read("r1", [[0, 100, 30], [150, 250, 150]]),
        make_compact_read("r2", [[0, 100, 150], [150, 250, 30]]),
    ]
    peaks = [(0, 100), (150, 250)]

    assignments, counts, sorted_idx, info = cluster_assignment.cluster_compact_reads(
        reads,
        peaks,
        region_start=0,
        n_clusters=4,
        method="combinatorial",
    )

    assert assignments["r0"] == assignments["r1"]
    assert assignments["r0"] != assignments["r2"]
    assert sum(counts.values()) == 3
    assert np.array_equal(np.sort(sorted_idx), np.array([0, 1, 2]))
    assert info is not None


def test_dataframe_cluster_assignment_groups_combinatorial_patterns():
    reads_df = pd.DataFrame(
        {
            "read_id": ["r0", "r1", "r2"],
            0: [30, 30, 150],
            10: [30, 30, 150],
            150: [150, 150, 30],
            160: [150, 150, 30],
            "_dataset_id": ["ds", "ds", "ds"],
        }
    )
    peaks = [(0, 20), (150, 170)]

    assignments, counts, sorted_idx, info = cluster_assignment.cluster_reads(
        reads_df,
        peaks,
        n_clusters=4,
        start=0,
        method="combinatorial",
    )

    assert assignments["r0"] == assignments["r1"]
    assert assignments["r0"] != assignments["r2"]
    assert sum(counts.values()) == 3
    assert np.array_equal(np.sort(sorted_idx), np.array([0, 1, 2]))
    assert info is not None


def test_kmeans_compact_assignment_handles_single_eligible_read():
    reads = [make_compact_read("r0", [[0, 100, 30]])]

    assignments, counts, sorted_idx, info = cluster_assignment.cluster_compact_reads(
        reads,
        [(0, 100)],
        region_start=0,
        n_clusters=5,
        method="kmeans",
    )

    assert assignments == {"r0": 0}
    assert counts == {0: 1}
    assert np.array_equal(sorted_idx, np.array([0]))
    assert info is None


def test_kmeans_dataframe_assignment_handles_single_eligible_read():
    reads_df = pd.DataFrame({"read_id": ["r0"], 0: [30], 10: [30]})

    assignments, counts, sorted_idx, info = cluster_assignment.cluster_reads(
        reads_df,
        [(0, 20)],
        n_clusters=5,
        start=0,
        method="kmeans",
    )

    assert assignments == {"r0": 0}
    assert counts == {0: 1}
    assert np.array_equal(sorted_idx, np.array([0]))
    assert info is None
