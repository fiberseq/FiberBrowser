"""Shared read ordering helpers for render/compile paths."""
from __future__ import annotations

from typing import Optional, Sequence

import math

import numpy as np

from services.clustering_features import extract_features_from_compact
from services.read_metrics import DEFAULT_SAMPLE_SEED


def accessibility_score(read: dict) -> int:
    """Score a compact read by inaccessible footprint bases."""
    return sum(-iv[2] for iv in read.get("intervals", []) if iv[2] < 0)


def sort_reads_by_accessibility(reads: Sequence[dict]) -> list[dict]:
    """Order reads by decreasing accessibility score."""
    return sorted(reads, key=accessibility_score, reverse=True)


def sort_reads_by_kmeans(
    reads: Sequence[dict],
    region_width: int,
    n_clusters: int = 5,
    random_state: int = 42,
    max_bins: int = 200,
) -> list[dict]:
    """Cluster reads by binned inaccessible intervals and return label order."""
    reads = list(reads)
    if len(reads) < 2 or region_width <= 0:
        return reads

    from sklearn.cluster import MiniBatchKMeans

    n_bins = max(1, min(max_bins, region_width))
    # Bin i covers [i*W/n, (i+1)*W/n): fractional widths span the whole region,
    # so trailing bases are binned too (integer widths dropped them).
    scale = n_bins / region_width
    features = np.zeros((len(reads), n_bins), dtype=np.float32)

    for read_idx, read in enumerate(reads):
        for iv in read.get("intervals", []):
            if iv[2] >= 0:
                continue
            # Half-open [start, end): the bins it touches.
            b0 = max(0, int(math.floor(iv[0] * scale)))
            b1 = min(n_bins, int(math.ceil(iv[1] * scale)))
            if b1 > b0:
                features[read_idx, b0:b1] = 1.0

    cluster_count = max(1, min(int(n_clusters), len(reads)))
    labels = MiniBatchKMeans(
        n_clusters=cluster_count,
        random_state=random_state,
        n_init=3,
    ).fit_predict(features)

    return [reads[i] for i in np.argsort(labels)]


def sort_similarity_for_dataset(
    state,
    ds_id: str,
    chrom: str,
    start: int,
    end: int,
    spanning: bool,
    sample_seed: str = DEFAULT_SAMPLE_SEED,
    read_ids: Optional[Sequence[str]] = None,
    cluster_assignments_override: Optional[dict] = None,
) -> dict:
    """Sort clusters for one dataset by pattern or centroid similarity."""
    dataset = state.get_dataset(ds_id)
    if not dataset:
        return {"cluster_order": [], "read_sort_order": []}

    # An explicit (even empty) override is the branch shown; only an absent one
    # falls back to the dataset's stored clustering.
    cluster_assignments = (cluster_assignments_override if cluster_assignments_override is not None
                           else dataset.cluster_assignments)
    if read_ids is not None:
        wanted = {str(read_id) for read_id in read_ids}
        cluster_assignments = {
            read_id: cluster
            for read_id, cluster in cluster_assignments.items()
            if read_id in wanted
        }
    element_info = dataset.cluster_element_info
    # Stored patterns describe the dataset's latest clustering. An override for
    # another branch (or a copy clustered on its own) can reuse the same cluster
    # IDs for other reads, so its patterns are rebuilt from its own members below.
    if cluster_assignments_override is not None:
        stored = dataset.cluster_assignments or {}
        if any(stored.get(read_id) != cluster for read_id, cluster in cluster_assignments_override.items()):
            element_info = None

    if not cluster_assignments:
        return {"cluster_order": [], "read_sort_order": []}

    unique_clusters = sorted(set(cluster_assignments.values()))
    if len(unique_clusters) <= 1:
        return {"cluster_order": unique_clusters, "read_sort_order": []}

    # (Clusterings stored before the compact path returned patterns have None.)
    if element_info and element_info.get("cluster_patterns"):
        cluster_patterns = element_info["cluster_patterns"]
        pattern_vectors = []
        cluster_ids = []
        for cluster_id in unique_clusters:
            if cluster_id in cluster_patterns:
                pattern_vectors.append(cluster_patterns[cluster_id])
                cluster_ids.append(cluster_id)

        if len(pattern_vectors) >= 2:
            try:
                from scipy.cluster.hierarchy import linkage, leaves_list
                from scipy.spatial.distance import pdist

                x = np.array(pattern_vectors, dtype=np.float32)
                distances = pdist(x, metric="hamming")
                z = linkage(distances, method="average", optimal_ordering=True)
                leaf_order = leaves_list(z)
                sorted_clusters = [cluster_ids[i] for i in leaf_order]
                for cluster in unique_clusters:
                    if cluster not in sorted_clusters:
                        sorted_clusters.append(cluster)
                return {"cluster_order": sorted_clusters, "read_sort_order": []}
            except (ImportError, Exception) as exc:
                print(f"  {ds_id}: pattern similarity failed ({exc}), falling back")

        def pattern_sort_key(cluster_id):
            pattern = cluster_patterns.get(cluster_id, [])
            n_open = sum(pattern) if pattern else 0
            return (-n_open, tuple(pattern) if pattern else ())

        sorted_clusters = sorted(unique_clusters, key=pattern_sort_key)
        return {"cluster_order": sorted_clusters, "read_sort_order": []}

    peak_regions = dataset.cluster_peak_regions
    if chrom and start is not None and end is not None and peak_regions:
        try:
            from scipy.cluster.hierarchy import linkage, leaves_list
            from scipy.spatial.distance import pdist

            chrom_t = state.translate_chrom(chrom)
            # A lifted dataset's rows in its analysis cohort, keyed as its clustering is (cohort identities).
            from services.lift.cohort import using_lift_cohort
            with using_lift_cohort("analysis"):
                working_set = state.build_working_set(
                    ds_id,
                    chrom_t,
                    start,
                    end,
                    spanning,
                    read_ids=read_ids,
                    sample_seed=sample_seed,
                )
            if working_set.reads:
                rel_peaks = [(p["start"] - start, p["end"] - start) for p in peak_regions]
                # The same features the clustering was built from: each peak's
                # mode, and the run's feature rules and subnucleosomal threshold.
                settings = getattr(dataset, "cluster_feature_settings", None) or {}
                feature_rules = settings.get("cluster_feature_rules") or None
                feature_kwargs = {}
                if feature_rules:
                    from services.clustering_endpoint import build_cluster_rule_context
                    feature_kwargs = dict(
                        cluster_feature_rules=feature_rules,
                        cluster_rule_context=build_cluster_rule_context(state, chrom_t, start, end),
                    )
                x, read_ids, _peak_widths, _ = extract_features_from_compact(
                    # Saved footprint-class features look reads up by dataset
                    # and chromosome (as cluster_all tags them).
                    [{**read, '_consensus_dataset_id': ds_id, '_consensus_chrom': chrom_t}
                     for read in working_set.reads],
                    rel_peaks,
                    start,
                    step=10,
                    subnucleosomal_threshold=settings.get("subnucleosomal_threshold", 90),
                    peak_modes=[p.get("mode") or "accessibility" for p in peak_regions],
                    **feature_kwargs,
                )
                if x.size > 0 and len(read_ids) > 0:
                    read_id_to_idx = {rid: i for i, rid in enumerate(read_ids)}
                    cluster_centroids = []
                    cluster_ids = []
                    for cluster_id in unique_clusters:
                        indices = [
                            read_id_to_idx[read_id]
                            for read_id, cluster in cluster_assignments.items()
                            if cluster == cluster_id and read_id in read_id_to_idx
                        ]
                        if indices:
                            cluster_centroids.append(x[indices].mean(axis=0))
                            cluster_ids.append(cluster_id)
                    if len(cluster_centroids) >= 2:
                        centroids_arr = np.array(cluster_centroids)
                        distances = pdist(centroids_arr, metric="euclidean")
                        z = linkage(distances, method="average", optimal_ordering=True)
                        leaf_order = leaves_list(z)
                        sorted_clusters = [cluster_ids[i] for i in leaf_order]
                        for cluster in unique_clusters:
                            if cluster not in sorted_clusters:
                                sorted_clusters.append(cluster)
                        return {"cluster_order": sorted_clusters, "read_sort_order": []}
        except (ImportError, Exception) as exc:
            print(f"  {ds_id}: centroid clustering failed ({exc})")

    cluster_sizes = {}
    for cluster in cluster_assignments.values():
        cluster_sizes[cluster] = cluster_sizes.get(cluster, 0) + 1
    sorted_clusters = sorted(unique_clusters, key=lambda cluster: -cluster_sizes.get(cluster, 0))
    return {"cluster_order": sorted_clusters, "read_sort_order": []}
