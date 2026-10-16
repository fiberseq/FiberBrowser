"""Merge similar clusters: the "Merge by" strategies (fb-n5-projection).

Cosine of the average profiles stays the default and behaves exactly as
before; the other strategies (correlation, a per-position difference test,
Jensen–Shannon distance, neighbour-graph connectivity) only change how the
most alike pair is chosen.
"""

import numpy as np
import pytest
from pydantic import ValidationError

from models.requests import AutoCullRequest, PeakRegion, ProjectionRequest
from services import cluster_analysis, clustering_endpoint
from services.cluster_analysis import MERGE_STRATEGIES, run_autocull_on


def one_peak_case(seed=0):
    """Four clusters x 50 positions, 200 reads each.

    C0 and C1 are the same everywhere except one 40 bp peak (positions 20-23),
    open in 90% of C0's reads and 10% of C1's; C2 and C3 are unlike both.
    """
    rng = np.random.default_rng(seed)
    base = np.full(50, 0.85)
    base[40:] = 0.5
    p0 = base.copy()
    p1 = base.copy()
    p0[20:24] = 0.9
    p1[20:24] = 0.1
    p2 = np.where(np.arange(50) % 2 == 0, 0.9, 0.05)
    p3 = 1.0 - base
    rows, labels = [], []
    for cluster, p in enumerate([p0, p1, p2, p3]):
        rows.append((rng.random((200, 50)) < p).astype(np.float32))
        labels += [cluster] * 200
    return np.vstack(rows), np.array(labels, dtype=np.int32)


def split_cluster_case(seed=1):
    """Three distinct profiles; the first one's reads are split at random into C0 and C1."""
    rng = np.random.default_rng(seed)
    pa = np.where(np.arange(40) < 20, 0.8, 0.2)
    pb = np.where(np.arange(40) % 2 == 0, 0.85, 0.1)
    pc = np.where(np.arange(40) >= 20, 0.9, 0.15)
    a = (rng.random((300, 40)) < pa).astype(np.float32)
    b = (rng.random((200, 40)) < pb).astype(np.float32)
    c = (rng.random((200, 40)) < pc).astype(np.float32)
    split = rng.permutation(np.r_[np.zeros(150, int), np.ones(150, int)])
    labels = np.r_[split, np.full(200, 2), np.full(200, 3)].astype(np.int32)
    return np.vstack([a, b, c]), labels


def test_cosine_merges_clusters_that_differ_at_one_peak_but_the_difference_test_keeps_them():
    features, labels = one_peak_case()

    cosine_labels, cosine_log = run_autocull_on(features, labels, min_fraction=0.05, max_cosine_similarity=0.95)
    assert [d["cluster"] for d in cosine_log] == [0]
    assert sorted(set(cosine_labels.tolist())) == [1, 2, 3]

    diff_labels, diff_log = run_autocull_on(features, labels, min_fraction=0.05, strategy="difference")
    assert diff_log == []
    assert diff_labels.tolist() == labels.tolist()


def test_cosine_is_unchanged_frozen_expectation():
    # Frozen from the function before "Merge by" existed: same labels, same reason.
    features, labels = one_peak_case()
    new_labels, log = run_autocull_on(features, labels, min_fraction=0.05, max_cosine_similarity=0.95)
    assert np.bincount(new_labels).tolist() == [0, 400, 200, 200]
    assert int((new_labels != labels).sum()) == 200
    assert len(log) == 1
    entry = log[0]
    assert {k: entry[k] for k in ("cluster", "count", "reason", "merged_into", "dominant_target")} == {
        "cluster": 0, "count": 200, "reason": "similar to C1 (cos=0.958)",
        "merged_into": {1: 200}, "dominant_target": 1,
    }
    assert entry["strategy"] == "cosine"
    assert entry["score"] == pytest.approx(0.9578, abs=1e-3)
    # threshold=None with cosine is max_cosine_similarity, as before.
    same_labels, same_log = run_autocull_on(features, labels, max_cosine_similarity=0.95, strategy="cosine", threshold=None)
    assert same_labels.tolist() == new_labels.tolist() and same_log == log


def test_low_abundance_step_is_the_same_for_every_strategy():
    features, labels = split_cluster_case()
    labels = labels.copy()
    labels[:10] = 9  # a tiny cluster
    for strategy in MERGE_STRATEGIES:
        _, log = run_autocull_on(features, labels, min_fraction=0.05, strategy=strategy)
        assert log[0]["cluster"] == 9
        assert log[0]["reason"].startswith("low abundance")
        assert "strategy" not in log[0]


@pytest.mark.parametrize("strategy", MERGE_STRATEGIES)
def test_every_strategy_merges_a_randomly_split_cluster_and_nothing_else(strategy):
    features, labels = split_cluster_case()
    new_labels, log = run_autocull_on(features, labels, min_fraction=0.05, strategy=strategy)
    assert [d["cluster"] for d in log] == [0], log
    assert log[0]["strategy"] == strategy
    assert isinstance(log[0]["score"], float)
    assert "C1" in log[0]["reason"]
    assert sorted(set(new_labels.tolist())) == [1, 2, 3]


@pytest.mark.parametrize("strategy", MERGE_STRATEGIES)
def test_strategies_are_deterministic(strategy):
    for case in (one_peak_case, split_cluster_case):
        features, labels = case()
        first = run_autocull_on(features, labels, strategy=strategy, threshold=None)
        second = run_autocull_on(features.copy(), labels.copy(), strategy=strategy, threshold=None)
        assert first[0].tolist() == second[0].tolist()
        assert first[1] == second[1]


def test_connectivity_merges_halves_of_one_blob_but_not_separate_blobs():
    rng = np.random.default_rng(3)
    centres = np.array([[0.0] * 8, [6.0] * 8, [-6.0, 6.0] * 4])
    blobs = [rng.normal(c, 1.0, size=(200, 8)) for c in centres]
    features = np.vstack(blobs).astype(np.float32)
    halves = rng.permutation(np.r_[np.zeros(100, int), np.ones(100, int)])
    labels = np.r_[halves, np.full(200, 2), np.full(200, 3)].astype(np.int32)

    new_labels, log = run_autocull_on(features, labels, min_fraction=0.05, strategy="connectivity")
    assert [d["cluster"] for d in log] == [0]
    assert log[0]["score"] > 1.0
    assert "neighbour graph" in log[0]["reason"]
    assert sorted(set(new_labels.tolist())) == [1, 2, 3]

    # Separated blobs alone: nothing is linked more than by chance.
    labels_sep = np.r_[np.zeros(200, int), np.full(200, 2), np.full(200, 3)].astype(np.int32)
    _, log_sep = run_autocull_on(features, labels_sep, min_fraction=0.05, strategy="connectivity", min_remaining=1)
    assert log_sep == []


def test_js_and_correlation_keep_distinct_profiles_apart():
    features, labels = one_peak_case()
    for strategy in ("js", "correlation"):
        _, log = run_autocull_on(features, labels, min_fraction=0.05, strategy=strategy)
        assert log == [], strategy
    # A looser JS cutoff merges the one-peak pair (and only it).
    _, log = run_autocull_on(features, labels, min_fraction=0.05, strategy="js", threshold=0.3)
    assert [d["cluster"] for d in log][:1] == [0]
    assert "JS distance" in log[0]["reason"]


def test_difference_test_threshold_is_the_effect_size():
    features, labels = one_peak_case()
    # A 0.9 cutoff: differences up to 80 points no longer keep clusters apart;
    # the pair whose largest difference is smallest goes first.
    _, log = run_autocull_on(features, labels, min_fraction=0.05, strategy="difference", threshold=0.9)
    assert log
    assert log[0]["reason"].startswith("no position differs from C")
    assert log[0]["score"] < 0.9
    scores = [d["score"] for d in log]
    assert all(0 <= s < 0.9 for s in scores)


def test_difference_test_on_non_binary_columns_uses_the_clusters_own_spread():
    """TF features hold footprint sizes (not 0/1): two clusters with consistently
    different values there differ, even though a proportion test would not see
    it (Codex review: 10 x 0.3 vs 10 x 0.6 merged)."""
    rng = np.random.default_rng(3)
    accessible = (rng.random((40, 10)) < 0.5).astype(np.float32)
    sizes = np.r_[np.full(20, 0.3), np.full(20, 0.6)].astype(np.float32)[:, None]
    third = (rng.random((20, 11)) < 0.95).astype(np.float32)
    features = np.vstack([np.hstack([accessible, sizes]), third])
    labels = np.r_[np.zeros(20), np.ones(20), np.full(20, 2)].astype(np.int32)
    merged, log = run_autocull_on(features, labels, min_fraction=0.0, strategy="difference", threshold=0.2)
    assert all({d["cluster"], d.get("dominant_target")} != {0, 1} for d in log)
    assert {0, 1} <= set(merged.tolist())


def test_qvalues_are_benjamini_hochberg():
    q = cluster_analysis._two_proportion_qvalues(
        np.array([0.9, 0.5, 0.5, 0.0]), np.array([0.1, 0.5, 0.52, 0.0]), 100, 100)
    assert q[0] < 1e-10
    assert q[1] == 1.0 and q[3] == 1.0  # no difference / both constant
    assert 0.5 < q[2] <= 1.0


def test_unknown_strategy_is_refused():
    with pytest.raises(ValueError, match="Unknown merge strategy"):
        run_autocull_on(np.zeros((4, 2), np.float32), np.array([0, 0, 1, 1]), strategy="euclid")
    with pytest.raises(ValidationError, match="Unknown merge strategy"):
        AutoCullRequest(current_assignments={}, merge_strategy="euclid")
    with pytest.raises(ValidationError, match="Unknown merge strategy"):
        ProjectionRequest(merge_strategy="nope")


def test_request_defaults_keep_cosine():
    for model in (AutoCullRequest(current_assignments={}), ProjectionRequest()):
        assert model.merge_strategy == "cosine"
        assert model.merge_threshold is None
        assert model.merge_alpha == 0.01
    assert AutoCullRequest(current_assignments={}, merge_strategy="Difference").merge_strategy == "difference"


def _FakeState():
    from test_clustering_endpoint import FakeClusterState

    return FakeClusterState()


def _fake_rows(*args, **kwargs):
    return (
        [np.array([0.0], dtype=np.float32), np.array([1.0], dtype=np.float32)],
        [("ds1", "read-a"), ("ds1", "read-b")],
        [0, 1],
    )


def test_autocull_endpoint_passes_the_strategy_and_reports_it(monkeypatch):
    seen = {}

    def fake_autocull(features, assignments, min_fraction, max_cosine_similarity, **kwargs):
        seen.update(kwargs)
        return np.array([0, 0], dtype=np.int32), []

    monkeypatch.setattr(clustering_endpoint, "collect_assigned_feature_rows", _fake_rows)
    monkeypatch.setattr(clustering_endpoint, "run_autocull_on", fake_autocull)
    req = AutoCullRequest(
        current_assignments={"ds1": {"read-a": 0, "read-b": 1}},
        peak_regions=[PeakRegion(start=10, end=20, mode="accessibility")],
        dataset_ids=["ds1"], merge_strategy="difference", merge_threshold=0.3,
    )
    result = clustering_endpoint.run_auto_cull_clusters_endpoint(
        state=_FakeState(), req=req, chrom="chr2R", start=0, end=30, spanning=False)
    assert seen == {"strategy": "difference", "threshold": 0.3, "alpha": 0.01}
    assert result["merge"] == {"strategy": "difference", "threshold": 0.3, "alpha": 0.01, "min_fraction": 0.05}

    # Default cosine: called as before (no extra arguments), threshold = max_cosine_similarity.
    seen.clear()
    req = AutoCullRequest(current_assignments={"ds1": {"read-a": 0, "read-b": 1}},
                          peak_regions=[PeakRegion(start=10, end=20)], dataset_ids=["ds1"], max_cosine_similarity=0.9)
    result = clustering_endpoint.run_auto_cull_clusters_endpoint(
        state=_FakeState(), req=req, chrom="chr2R", start=0, end=30, spanning=False)
    assert seen == {}
    assert result["merge"]["strategy"] == "cosine" and result["merge"]["threshold"] == 0.9
