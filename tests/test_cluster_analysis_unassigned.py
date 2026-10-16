"""Merge/dissolve leave 'Unassigned' (-1) alone; projection copes with identical reads."""
import json

import numpy as np

from services.cluster_analysis import compute_cluster_projection, dissolve_cluster_to_nearest, run_autocull_on


def test_merging_never_touches_unassigned_reads():
    # One unassigned read, two distinct real clusters of 20: nothing to merge.
    features = np.array([[0.0, 0.0]] + [[1.0, 0.0]] * 20 + [[0.0, 1.0]] * 20)
    assignments = np.array([-1] + [0] * 20 + [1] * 20)
    out, dissolved = run_autocull_on(features, assignments)
    assert out[0] == -1 and dissolved == []


def test_dissolving_a_cluster_never_sends_reads_to_unassigned():
    # Cluster 2's reads look like the unassigned (zero) reads: they still go to a real cluster.
    features = np.array([[0.0, 0.0]] * 5 + [[1.0, 0.0]] * 5 + [[0.1, 0.1]] * 3 + [[0.0, 1.0]] * 5)
    assignments = np.array([-1] * 5 + [0] * 5 + [2] * 3 + [1] * 5)
    out, info = dissolve_cluster_to_nearest(features, assignments, 2)
    assert info["changed"] and set(out[10:13].tolist()) <= {0, 1}
    assert out[:5].tolist() == [-1] * 5 and -1 not in info["remaining_clusters"]


def test_projection_of_identical_reads_is_json_safe():
    coords, variance, method = compute_cluster_projection(np.zeros((6, 4), dtype=np.float32), method="pca")
    json.dumps({"coords": coords.tolist(), "variance": variance}, allow_nan=False)
    assert method == "pca" and variance == [0.0, 0.0]
