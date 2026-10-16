"""Every clustering method the Cluster control offers runs as itself; unknown ones are refused."""
import pytest

import services.cluster_assignment as ca


def _reads():
    groups = {
        "open": [[0, 100, -100]],
        "closed": [[0, 100, 150]],
        "half": [[0, 50, -50], [50, 100, 150]],
    }
    return [{"id": f"{name}-{i}", "intervals": ivs} for name, ivs in groups.items() for i in range(20)]


def _groups(assignments):
    by_group = {}
    for read_id, cluster in assignments.items():
        by_group.setdefault(read_id.split("-")[0], set()).add(cluster)
    return by_group


@pytest.mark.parametrize("method", ["hdbscan", "agglom"])
def test_hdbscan_and_hierarchical_run_themselves_on_the_compact_path(method, monkeypatch):
    monkeypatch.setattr(ca, "_kmeans_labels", lambda *a, **k: pytest.fail(f"{method} fell back to k-means"))
    assignments, counts, _, _ = ca.cluster_compact_reads(_reads(), [(0, 100)], 0, n_clusters=2, method=method)
    groups = _groups(assignments)
    # Three clean groups: each is one cluster, and they differ (no K was needed).
    assert all(len(clusters) == 1 for clusters in groups.values())
    assert len({next(iter(c)) for c in groups.values()}) == 3


def test_kmeans_uses_k():
    assignments, _, _, _ = ca.cluster_compact_reads(_reads(), [(0, 100)], 0, n_clusters=2, method="kmeans")
    assert len(set(assignments.values())) == 2


def test_tf_density_peaks_cluster_on_the_tf_feature():
    from services.clustering_features import extract_features_from_compact
    from services.clustering_inputs import active_peak_regions
    from models.requests import PeakRegion
    peaks, modes = active_peak_regions([PeakRegion(start=0, end=100, mode="tf_density")], 0)
    assert modes == ["tf"]
    reads = [{"id": "tf", "intervals": [[0, 100, 40]]}, {"id": "nuc", "intervals": [[0, 100, 147]]}]
    X, ids, _, _ = extract_features_from_compact(reads, peaks, 0, peak_modes=modes)
    assert X[ids.index("tf")].sum() > 0 and X[ids.index("nuc")].sum() == 0


def test_unknown_methods_are_refused():
    with pytest.raises(ValueError, match="Unknown clustering method"):
        ca.cluster_compact_reads(_reads(), [(0, 100)], 0, n_clusters=2, method="spectral")


def test_cluster_all_refuses_an_unknown_method_before_loading_reads():
    from models.requests import ClusterAllRequest, PeakRegion
    from services import clustering_endpoint

    class State:
        def translate_chrom(self, c):
            return c

    with pytest.raises(ValueError, match="Unknown clustering method"):
        clustering_endpoint.run_cluster_all_endpoint(
            state=State(), req=ClusterAllRequest(method="spectral", peak_regions=[PeakRegion(start=0, end=10)]),
            chrom="chr1", start=0, end=100, spanning=False)


def test_fire_features_come_only_from_fire_calls():
    from services.clustering_features import extract_features_from_compact
    reads = [
        {"id": "gap-no-fire", "intervals": [[0, 100, -100]]},  # no FIRE calls at all
        {"id": "filtered", "intervals": [[0, 100, -100]], "layers": {"msp": {"intervals": []}}},
        {"id": "fire", "intervals": [[0, 100, 150]], "layers": {"msp": {"intervals": [[0, 100, 200]]}}},
        {"id": "bam-fire", "intervals": [[0, 100, 150]], "fire": [[0, 100, 200]]},
    ]
    for mode in ("fire", "msp"):
        X, ids, _, _ = extract_features_from_compact(reads, [(0, 100)], 0, peak_modes=[mode])
        row = {i: X[ids.index(i)].sum() for i in ids}
        assert row["gap-no-fire"] == 0 and row["filtered"] == 0
        assert row["fire"] > 0 and row["bam-fire"] > 0
    # Accessibility still reads gaps when there are no FIRE calls.
    X, ids, _, _ = extract_features_from_compact(reads[:1], [(0, 100)], 0, peak_modes=["accessibility"])
    assert X[0].sum() > 0
