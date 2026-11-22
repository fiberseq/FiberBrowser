"""k-means cluster numbers are canonical (3.1.1): numbered by size, largest first, ties by the cluster's smallest read
id, whatever order the reads arrive in and whichever path fitted them (cluster_all's full fit, a fit on given rows as
the headless re-cluster and graph Cluster use, the DataFrame path, matched views, the k-means read sort). Before,
cluster_all's k-means kept sklearn's arbitrary numbers, so the same reads could come back with swapped numbers (and
colours) between a refined run and a full-only rerun (e2e cluster-preparation.spec)."""
import numpy as np
import pandas as pd
import pytest

from services import cluster_assignment
from services.cluster_assignment import cluster_compact_reads, cluster_reads


def _blobs():
    """Three well-separated blobs of 30, 20 and 20 reads (a size tie between the last two)."""
    rng = np.random.default_rng(0)
    centres = {"a": (0.0, 0.0, 0.0), "b": (10.0, 0.0, 10.0), "c": (0.0, 10.0, 10.0)}
    sizes = {"a": 30, "b": 20, "c": 20}
    ids, rows = [], []
    for name, n in sizes.items():
        for i in range(n):
            ids.append(f"{name}{i:03d}")
            rows.append(np.asarray(centres[name]) + rng.normal(0, 0.3, 3))
    return ids, np.asarray(rows)


def _expected(ids):
    # 'a' is largest; 'b' and 'c' tie at 20 and 'b000' < 'c000'.
    return {rid: {"a": 0, "b": 1, "c": 2}[rid[0]] for rid in ids}


def _orders(n):
    rng = np.random.default_rng(7)
    return [np.arange(n), np.arange(n)[::-1]] + [rng.permutation(n) for _ in range(6)]


def _compact(monkeypatch, ids, X, order, **kwargs):
    idx = list(order)
    rows_ids = [ids[i] for i in idx]
    feats = X[idx]
    monkeypatch.setattr(cluster_assignment, "extract_features_grouped",
                        lambda reads, *a, **k: (feats, [r["id"] for r in reads], [3], ["accessibility"]))
    reads = [{"id": rid} for rid in rows_ids]
    return cluster_compact_reads(reads, [(0, 3)], 0, 3, **kwargs)


@pytest.mark.parametrize("method", ["kmeans", "minibatch"])
def test_cluster_all_full_fit_numbers_do_not_depend_on_read_order(monkeypatch, method):
    ids, X = _blobs()
    for seed in (0, 1, 2, 42):
        for order in _orders(len(ids)):
            assignments, counts, _sorted, _info = _compact(monkeypatch, ids, X, order, method=method, random_state=seed)
            assert assignments == _expected(ids), (seed, list(order)[:5])
            assert counts == {0: 30, 1: 20, 2: 20}


@pytest.mark.parametrize("method", ["kmeans", "minibatch"])
def test_a_fit_on_given_rows_numbers_as_the_full_fit(monkeypatch, method):
    """The headless re-cluster / graph Cluster path (fit_rows, matched_view_clustering._fit_predict) and the full fit
    give the same numbers for the same reads."""
    ids, X = _blobs()
    for order in _orders(len(ids))[:3]:
        centres = {}
        full, *_ = _compact(monkeypatch, ids, X, order, method=method, random_state=3)
        fitted, *_ = _compact(monkeypatch, ids, X, order, method=method, random_state=3,
                              fit_rows=list(range(len(ids))), centers_out=centres)
        assert fitted == full == _expected(ids)
        # The fitted centres follow the numbers: centre 0 is blob 'a' (near the origin).
        assert np.linalg.norm(centres[0]) < 1.5


@pytest.mark.parametrize("method", ["kmeans", "minibatch"])
def test_dataframe_path_numbers_canonically(method):
    ids, _X = _blobs()
    # Footprint sizes per base (columns 100..102 with start 100); accessibility features: open where < 90 bp.
    shape = {"a": [200, 200, 200], "b": [0, 200, 0], "c": [200, 0, 0]}
    for order in _orders(len(ids))[:4]:
        rows = [ids[i] for i in order]
        df = pd.DataFrame([{"read_id": rid, 100: shape[rid[0]][0], 101: shape[rid[0]][1], 102: shape[rid[0]][2]}
                           for rid in rows])
        assignments, counts, *_ = cluster_reads(df, [(0, 3)], 3, 100, method=method, random_state=5)
        assert assignments == _expected(ids)


def test_canonical_rule_and_negative_labels():
    from services.cluster_assignment import canonical_cluster_labels
    labels = np.array([5, 5, 2, 2, 9, -1, 9, 9])
    ids = ["r7", "r8", "r1", "r2", "r9", "rx", "r0", "r3"]
    out = canonical_cluster_labels(labels, ids)
    # 9 (3 reads) -> 0; 5 and 2 tie at 2 reads: 2 holds 'r1' < 'r7' -> 1, 5 -> 2; -1 stays.
    assert out.tolist() == [2, 2, 1, 1, 0, -1, 0, 0]
    # Without ids: ties by the cluster centre (lexicographic), then the old label.
    out = canonical_cluster_labels(np.array([1, 1, 0, 0]), centers={0: [5.0, 0.0], 1: [1.0, 0.0]})
    assert out.tolist() == [0, 0, 1, 1]


def test_matched_view_fit_numbers_by_size_then_smallest_read_id():
    from services.matched_view_clustering import _fit_predict
    ids, X = _blobs()
    for order in _orders(len(ids))[:4]:
        idx = list(order)
        labels = _fit_predict(X[idx], np.arange(len(idx)), 3, "kmeans", 11, ids=[ids[i] for i in idx])
        assert dict(zip([ids[i] for i in idx], labels.tolist())) == _expected(ids)


def test_kmeans_read_sort_orders_blocks_canonically():
    from services.read_sorting import sort_reads_by_kmeans
    # Two read shapes: 6 closed at the start, 4 closed at the end (well separated).
    reads = [{"id": f"s{i}", "intervals": [[0, 50, -1]]} for i in range(6)] + \
            [{"id": f"e{i}", "intervals": [[50, 100, -1]]} for i in range(4)]
    for order in _orders(len(reads)):
        out = sort_reads_by_kmeans([reads[i] for i in order], 100, n_clusters=2, random_state=1)
        assert [r["id"][0] for r in out] == ["s"] * 6 + ["e"] * 4


def test_annotation_pattern_kmeans_numbers_canonically():
    from services.annotation_analysis import cluster_reads_by_annotation_patterns
    # 6 reads with a TF call in peak 1, 4 with a nucleosome in peak 2, 4 with both (a tie between the last two).
    reads = {f"t{i}": [(100, 140, "tf", 1.0)] for i in range(6)}
    reads.update({f"n{i}": [(160, 190, "nuc", 1.0)] for i in range(4)})
    reads.update({f"b{i}": [(100, 140, "tf", 1.0), (160, 190, "nuc", 1.0)] for i in range(4)})
    names = list(reads)
    want = {name: {"t": 0, "b": 1, "n": 2}[name[0]] for name in names}
    for order in _orders(len(names)):
        shuffled = {names[i]: reads[names[i]] for i in order}
        out = cluster_reads_by_annotation_patterns([shuffled], [{"start": 90, "end": 150}, {"start": 150, "end": 210}],
                                                   ["tf", "nuc"], method="kmeans", k=3, random_state=2)
        assert out["assignments"] == want
