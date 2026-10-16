"""Regression tests for extracted clustering post-processing helpers."""

import numpy as np

from services import cluster_analysis


def test_run_autocull_dissolves_low_abundance_cluster():
    features = np.array(
        [
            [0.0, 0.0],
            [0.1, 0.0],
            [5.0, 5.0],
            [5.1, 5.0],
            [0.2, 0.0],
        ],
        dtype=np.float32,
    )
    assignments = np.array([0, 0, 1, 1, 2], dtype=np.int32)

    new_assignments, dissolved = cluster_analysis.run_autocull_on(
        features,
        assignments,
        min_fraction=0.25,
        max_cosine_similarity=0.99,
        min_remaining=2,
    )

    assert 2 not in set(new_assignments.tolist())
    assert dissolved == [
        {
            "cluster": 2,
            "count": 1,
            "reason": "low abundance (20.0%)",
            "merged_into": {0: 1},
            "dominant_target": 0,
        }
    ]
    assert assignments.tolist() == [0, 0, 1, 1, 2]


def test_dissolve_cluster_to_nearest_reassigns_to_remaining_centroids():
    features = np.array(
        [
            [0.0, 0.0],
            [0.2, 0.0],
            [5.0, 5.0],
            [5.2, 5.0],
            [0.1, 0.0],
            [5.1, 5.0],
        ],
        dtype=np.float32,
    )
    assignments = np.array([0, 0, 1, 1, 2, 2], dtype=np.int32)

    new_assignments, info = cluster_analysis.dissolve_cluster_to_nearest(features, assignments, 2)

    assert new_assignments.tolist() == [0, 0, 1, 1, 0, 1]
    assert info == {
        "changed": True,
        "reason": "reassigned",
        "dissolved_count": 2,
        "remaining_clusters": [0, 1],
    }
    assert assignments.tolist() == [0, 0, 1, 1, 2, 2]


def test_dissolve_cluster_to_nearest_reports_noop_conditions():
    features = np.array([[0.0], [1.0]], dtype=np.float32)
    assignments = np.array([1, 1], dtype=np.int32)

    unchanged, no_reads = cluster_analysis.dissolve_cluster_to_nearest(features, assignments, 2)
    no_remaining_assignments, no_remaining = cluster_analysis.dissolve_cluster_to_nearest(features, assignments, 1)

    assert unchanged.tolist() == [1, 1]
    assert no_reads["changed"] is False
    assert no_reads["reason"] == "no_reads"
    assert no_remaining_assignments.tolist() == [1, 1]
    assert no_remaining["changed"] is False
    assert no_remaining["reason"] == "no_remaining_clusters"


def test_projection_pca_shape():
    features = np.array(
        [
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ],
        dtype=np.float32,
    )

    coords, variance, method = cluster_analysis.compute_cluster_projection(features)

    assert method == "pca"
    assert coords.shape == (3, 2)
    assert variance is not None
    assert len(variance) == 2


def test_projection_fallback_is_quiet_by_default(capsys, monkeypatch):
    monkeypatch.delenv(cluster_analysis.CLUSTER_DIAGNOSTICS_ENV, raising=False)
    features = np.array([[1.0, 0.0], [0.0, 1.0]], dtype=np.float32)

    coords, variance, method = cluster_analysis.compute_cluster_projection(features, method="tsne")

    assert method == "pca"
    assert coords.shape == (2, 2)
    assert variance is not None
    assert capsys.readouterr().out == ""


def test_projection_fallback_can_print_cluster_diagnostics(capsys, monkeypatch):
    monkeypatch.setenv(cluster_analysis.CLUSTER_DIAGNOSTICS_ENV, "1")
    features = np.array([[1.0, 0.0], [0.0, 1.0]], dtype=np.float32)

    _, _, method = cluster_analysis.compute_cluster_projection(features, method="tsne")

    assert method == "pca"
    assert "compute_cluster_projection: TSNE failed" in capsys.readouterr().out
