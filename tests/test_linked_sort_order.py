"""A linked sort's shared cluster order also orders each dataset's reads."""
from types import SimpleNamespace

import services.filtering_endpoint as fe


def test_linked_sort_regroups_reads_to_the_shared_cluster_order(monkeypatch):
    # Pooled: cluster 0 mean 4.5, cluster 1 mean 8 -> shared order [0, 1]; ds2 alone would put 1 first.
    metric = {"a1": 1, "a2": 2, "b1": 10, "b2": 11, "c1": 5, "c2": 6, "d1": 7, "d2": 8}
    monkeypatch.setattr(fe, "_compute_sort_metric", lambda read, **k: metric[read["id"]])
    assignments = {"ds1": {"a1": 0, "a2": 0, "b1": 1, "b2": 1}, "ds2": {"c1": 1, "c2": 1, "d1": 0, "d2": 0}}
    reads = {ds: [{"id": r} for r in a] for ds, a in assignments.items()}
    state = SimpleNamespace(get_dataset=lambda ds: SimpleNamespace(cluster_assignments=assignments[ds]))
    query = SimpleNamespace(dataset_ids=["ds1", "ds2"],
                            build_working_set=lambda st, ds: SimpleNamespace(reads=reads[ds]))
    req = SimpleNamespace(linked=True, descending=False, sort_by="x", rule=None, layer=None,
                          transcription_state=None, cluster_assignments=None)
    # Each dataset sorted on its own: ds1 puts cluster 0 first, ds2 cluster 1 first.
    results = {
        "ds1": {"cluster_order": [0, 1], "read_sort_order": ["a1", "a2", "b1", "b2"]},
        "ds2": {"cluster_order": [1, 0], "read_sort_order": ["c1", "c2", "d1", "d2"]},
    }
    fe._apply_linked_sort_order(state, req, query, results, start=0, end=100, gene_regions=[], peak_regions=[],
                                scope_windows=None, gene_regions_by_key={}, transcription_genes=[])
    order = results["ds1"]["cluster_order"]
    assert results["ds2"]["cluster_order"] == order
    for ds in ("ds1", "ds2"):
        clusters = [assignments[ds][r] for r in results[ds]["read_sort_order"]]
        assert clusters == sorted(clusters, key=order.index)  # grouped in the shared order
    assert order == [0, 1] and results["ds2"]["read_sort_order"] == ["d1", "d2", "c1", "c2"]


def test_linked_sort_can_order_pooled_clusters_when_each_dataset_is_tied():
    from models.requests import SortReadsRequest

    assignments = {
        'a': {'a0': 0, 'a1': 1, 'a2': 1, 'a3': 1},
        'b': {'b0': 0, 'b1': 0, 'b2': 0, 'b3': 1},
    }
    reads = {ds: [{'id': rid, 'intervals': [[0, 10 if ds == 'a' else 90, 100]]} for rid in mapping]
             for ds, mapping in assignments.items()}
    req = SortReadsRequest(dataset_ids=['a', 'b'], sort_by='occupancy', linked=True, cluster_assignments=assignments)
    state = SimpleNamespace(get_dataset=lambda ds: SimpleNamespace(cluster_assignments=assignments[ds]))
    query = SimpleNamespace(dataset_ids=['a', 'b'], build_working_set=lambda st, ds: SimpleNamespace(reads=reads[ds]))
    kwargs = dict(start=0, end=100, gene_regions=[], peak_regions=[], scope_windows=None,
                  gene_regions_by_key={}, transcription_genes=[])
    results = {ds: fe._sort_dataset_reads(reads[ds], assignments[ds], req=req, **kwargs) for ds in assignments}
    assert all('same value' in result['no_op_reason'] for result in results.values())
    fe._apply_linked_sort_order(state, req, query, results, **kwargs)
    assert all('no_op_reason' not in result for result in results.values())
    assert all(result['cluster_order'] == [0, 1] for result in results.values())
