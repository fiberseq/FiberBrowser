"""Cluster assignment helpers for legacy DataFrame and compact read inputs."""
from __future__ import annotations

import time
from collections import defaultdict

import numpy as np

from services.clustering_features import extract_features_from_compact, extract_features_grouped
from services.diagnostics import env_flag_enabled, log_if_enabled

CLUSTER_DIAGNOSTICS_ENV = "FIBERBROWSER_CLUSTER_DIAGNOSTICS"


def cluster_assignment_diagnostics_enabled() -> bool:
    return env_flag_enabled(CLUSTER_DIAGNOSTICS_ENV)


def log_cluster_assignment_diagnostic(message: str) -> None:
    log_if_enabled(CLUSTER_DIAGNOSTICS_ENV, message)


def _kmeans_labels(X, n_clusters: int, random_state: int):
    from sklearn.cluster import KMeans

    return KMeans(n_clusters=n_clusters, random_state=random_state, n_init=10).fit_predict(X)


def _bounded_cluster_count(requested: int, n_samples: int) -> int:
    return max(1, min(int(requested), int(n_samples)))


# The methods the Cluster control offers (ClusterPanel CLUSTER_METHODS), plus 'binary'.
CLUSTER_METHODS = ("combinatorial", "binary", "hdbscan", "agglom", "minibatch", "kmeans", "graph")


def _graph_labels(X: np.ndarray, read_ids, resolution: float, random_state: int) -> np.ndarray:
    """Communities of the t-SNE neighbourhood graph (services/read_projection.py):
    the number of clusters follows from the data and the resolution."""
    from services.read_projection import graph_cluster_labels

    labels = graph_cluster_labels(X, resolution=resolution, random_state=random_state,
                                  keys=[str(read_id) for read_id in read_ids])
    log_cluster_assignment_diagnostic(
        f"  Neighbourhood graph: {len(np.unique(labels))} clusters at resolution {resolution}")
    return labels


def check_cluster_method(method: str) -> str:
    if method not in CLUSTER_METHODS:
        raise ValueError(f"Unknown clustering method {method!r}; use one of {', '.join(CLUSTER_METHODS)}")
    return method


def _agglom_labels(X: np.ndarray) -> np.ndarray:
    """Hierarchical (Ward) clustering cut at a distance scaled to the feature count;
    more than 20 clusters are folded to the 15 largest plus one 'other'."""
    from sklearn.cluster import AgglomerativeClustering

    n_samples, n_features = X.shape
    if n_samples <= 1:
        return np.zeros(n_samples, dtype=np.int32)
    labels = AgglomerativeClustering(
        n_clusters=None,
        distance_threshold=0.3 * max(1, n_features),
        linkage="ward",
    ).fit_predict(X)
    n_found = len(np.unique(labels))
    log_cluster_assignment_diagnostic(f"  Agglomerative: {n_found} clusters")
    if n_found > 20:
        unique, counts = np.unique(labels, return_counts=True)
        top_clusters = unique[np.argsort(-counts)[:15]]
        new_labels = np.zeros_like(labels)
        for i, c in enumerate(top_clusters):
            new_labels[labels == c] = i
        new_labels[~np.isin(labels, top_clusters)] = len(top_clusters)
        labels = new_labels
    return labels.astype(np.int32)


def _hdbscan_labels(X: np.ndarray) -> np.ndarray:
    """HDBSCAN; its noise points form one extra cluster. Falls back to hierarchical
    clustering when this scikit-learn has no HDBSCAN."""
    n_samples = X.shape[0]
    try:
        from sklearn.cluster import HDBSCAN
    except ImportError:
        log_cluster_assignment_diagnostic("  HDBSCAN not available, using agglomerative")
        return _agglom_labels(X)
    if n_samples < 2:
        return np.zeros(n_samples, dtype=np.int32)
    labels = HDBSCAN(min_cluster_size=max(2, min(n_samples, max(5, n_samples // 50))), min_samples=2).fit_predict(X)
    labels[labels == -1] = labels.max() + 1 if labels.max() >= 0 else 0
    log_cluster_assignment_diagnostic(f"  HDBSCAN: {len(np.unique(labels))} clusters")
    return labels.astype(np.int32)


def cluster_reads(reads_df, peak_regions, n_clusters, start, method="kmeans",
                  subnucleosomal_threshold=90, accessibility_threshold=0.5,
                  peak_modes=None, random_state=42, resolution=1.0):
    """
    Cluster reads by per-base footprint patterns within peak regions.

    Uses full per-base footprint data for accurate pattern matching.
    """
    check_cluster_method(method)
    t0 = time.time()

    if reads_df.empty or not peak_regions:
        return {}, {}, None, None

    if peak_modes is None:
        peak_modes = ["accessibility"] * len(peak_regions)

    numeric_cols = [
        c for c in reads_df.columns
        if c != "read_id" and not str(c).startswith("_")
    ]
    features = []
    peak_widths = []

    for i, (l, r) in enumerate(peak_regions):
        mode = peak_modes[i] if i < len(peak_modes) else "accessibility"
        cols = [
            c for c in numeric_cols
            if isinstance(c, (int, np.integer)) and l <= (c - start) < r
        ]
        if cols:
            raw_data = reads_df[cols].fillna(0).values.astype(np.float32)

            if mode == "tf":
                data = np.clip(raw_data / subnucleosomal_threshold, 0, 1)
            else:
                data = (raw_data < subnucleosomal_threshold).astype(np.float32)

            features.append(data)
            peak_widths.append(len(cols))
        else:
            peak_widths.append(0)

    if not features:
        return {}, {}, None, None

    X = np.hstack(features)
    n_samples, n_features = X.shape

    t1 = time.time()
    log_cluster_assignment_diagnostic(f"  Feature extraction: {n_samples} reads x {n_features} features in {t1-t0:.3f}s")

    read_ids = (
        reads_df["read_id"].tolist()
        if "read_id" in reads_df.columns
        else [str(i) for i in range(n_samples)]
    )

    if n_samples <= 1 and method not in ("binary", "combinatorial"):
        labels = np.zeros(n_samples, dtype=np.int32)
        log_cluster_assignment_diagnostic("  Single eligible read: assigning one cluster")
        return (
            {read_ids[i]: int(labels[i]) for i in range(len(read_ids))},
            {0: int(n_samples)},
            np.argsort(labels),
            None,
        )

    if method in ("binary", "combinatorial"):
        n_peaks = len(peak_regions)
        pattern_to_reads = defaultdict(list)
        read_patterns = []

        for i in range(n_samples):
            pattern_bits = []
            offset = 0
            for p_idx in range(n_peaks):
                pw = peak_widths[p_idx]
                if pw > 0:
                    peak_data = X[i, offset:offset + pw]
                    is_open = peak_data.mean() > accessibility_threshold
                    pattern_bits.append(1 if is_open else 0)
                    offset += pw
                else:
                    pattern_bits.append(0)

            pattern = tuple(pattern_bits)
            pattern_to_reads[pattern].append(i)
            read_patterns.append(pattern)

        sorted_patterns = sorted(
            pattern_to_reads.keys(),
            key=lambda p: (-len(pattern_to_reads[p]), p),
        )

        max_combinatorial = 50
        if len(sorted_patterns) > max_combinatorial:
            top_patterns = sorted_patterns[:max_combinatorial]
            pattern_to_label = {p: idx for idx, p in enumerate(top_patterns)}
            # Rarer patterns join the nearest kept pattern (as dynamic reassignment does).
            from services.dynamic_clustering import match_pattern_to_cluster
            labels = np.array(
                [
                    pattern_to_label[read_patterns[i]] if read_patterns[i] in pattern_to_label
                    else match_pattern_to_cluster(read_patterns[i], pattern_to_label)
                    for i in range(n_samples)
                ],
                dtype=np.int32,
            )
            log_cluster_assignment_diagnostic(
                f"  Combinatorial: {len(sorted_patterns)} unique patterns, "
                f"showing top {max_combinatorial}"
            )
        else:
            top_patterns = sorted_patterns
            max_clusters = len(sorted_patterns)
            pattern_to_label = {p: idx for idx, p in enumerate(top_patterns)}
            labels = np.array(
                [
                    pattern_to_label.get(read_patterns[i], max_clusters - 1)
                    for i in range(n_samples)
                ],
                dtype=np.int32,
            )
            log_cluster_assignment_diagnostic(f"  Combinatorial: {len(sorted_patterns)} unique patterns")

        element_read_ids = {i: [] for i in range(n_peaks)}
        for read_idx, pattern in enumerate(read_patterns):
            for elem_idx, is_open in enumerate(pattern):
                if is_open:
                    element_read_ids[elem_idx].append(read_ids[read_idx])

        cluster_patterns = {}
        for pattern, label in pattern_to_label.items():
            cluster_patterns[int(label)] = list(pattern)

        combinatorial_info = {
            "n_elements": n_peaks,
            "cluster_patterns": cluster_patterns,
            "element_read_ids": {int(k): v for k, v in element_read_ids.items()},
            "method": "combinatorial",
        }

        for p in sorted_patterns[:5]:
            pstr = "".join(str(b) for b in p)
            log_cluster_assignment_diagnostic(f"    Pattern {pstr}: {len(pattern_to_reads[p])} reads")

    elif method == "hdbscan":
        labels = _hdbscan_labels(X)

    elif method == "graph":
        labels = _graph_labels(X, read_ids, resolution, random_state)

    elif method == "agglom":
        labels = _agglom_labels(X)

    elif method == "minibatch":
        from sklearn.cluster import MiniBatchKMeans

        actual_k = _bounded_cluster_count(n_clusters, n_samples)
        clusterer = MiniBatchKMeans(
            n_clusters=actual_k,
            random_state=random_state,
            batch_size=256,
            n_init=3,
        )
        labels = clusterer.fit_predict(X)
        log_cluster_assignment_diagnostic(f"  MiniBatch KMeans: k={actual_k}")

    elif method == "kmeans":
        actual_k = _bounded_cluster_count(n_clusters, n_samples)
        labels = _kmeans_labels(X, actual_k, random_state)
        log_cluster_assignment_diagnostic(f"  KMeans: k={actual_k}")

    t2 = time.time()

    unique, counts = np.unique(labels, return_counts=True)
    log_cluster_assignment_diagnostic(f"  Clustering: {t2-t1:.3f}s, {len(unique)} clusters")

    assignments = {read_ids[i]: int(labels[i]) for i in range(len(read_ids))}
    element_info = combinatorial_info if method in ("binary", "combinatorial") else None

    return assignments, {int(u): int(c) for u, c in zip(unique, counts)}, np.argsort(labels), element_info


def cluster_compact_reads(compact_reads, peak_regions, region_start, n_clusters,
                          method="kmeans", subnucleosomal_threshold=90,
                          accessibility_threshold=0.5, peak_modes=None,
                          random_state=42, cluster_feature_rules=None,
                          cluster_rule_context=None, window_groups=None,
                          resolution=1.0, fit_rows=None, missing_feature_groups=None,
                          features_out=None):
    """
    Cluster reads directly from compact format, skipping DataFrame intermediate.

    This is significantly faster than cluster_reads() for large viewports because
    it extracts features only at peak positions rather than creating a wide DataFrame.

    `window_groups`: reads tagged `_cluster_group` (a clustering window) use
    that window's peaks, start and rule context (see extract_features_grouped).
    """
    check_cluster_method(method)
    t0 = time.time()

    if not compact_reads or not peak_regions:
        return {}, {}, None, None

    X, read_ids, peak_widths, peak_modes_used = extract_features_grouped(
        compact_reads,
        peak_regions,
        region_start,
        window_groups,
        step=10,
        subnucleosomal_threshold=subnucleosomal_threshold,
        peak_modes=peak_modes,
        cluster_feature_rules=cluster_feature_rules,
        cluster_rule_context=cluster_rule_context,
    )

    if features_out is not None:
        features_out.update(features=X, read_ids=read_ids, peak_widths=peak_widths)

    if X.size == 0:
        return {}, {}, None, None

    missing_by_id = {r['id']: set(missing_feature_groups.get(r.get('_cluster_group'), []))
                     for r in compact_reads} if missing_feature_groups else {}

    n_samples, _n_features = X.shape
    t1 = time.time()
    log_cluster_assignment_diagnostic(f"  Direct feature extraction: {n_samples} reads x {_n_features} features in {t1-t0:.3f}s")

    combinatorial_info = None

    if n_samples <= 1 and method not in ("binary", "combinatorial"):
        labels = np.zeros(n_samples, dtype=np.int32)
        log_cluster_assignment_diagnostic("  Single eligible read: assigning one cluster")
        return (
            {read_ids[i]: int(labels[i]) for i in range(len(read_ids))},
            {0: int(n_samples)},
            np.argsort(labels),
            None,
        )

    if method in ("binary", "combinatorial"):
        n_peaks = len(peak_regions)
        from services.clustering_features import class_aware_pattern_slices
        pattern_slices = class_aware_pattern_slices(peak_widths, peak_modes_used, cluster_feature_rules)
        pattern_to_reads = defaultdict(list)
        read_patterns = []

        for i in range(n_samples):
            pattern_bits = []
            offset = 0
            for p_idx, offset, pw, is_class in pattern_slices:
                if p_idx in missing_by_id.get(read_ids[i], ()):
                    pattern_bits.append(-1)
                    continue
                if pw > 0:
                    peak_data = X[i, offset:offset + pw]
                    is_open = peak_data.mean() > (0.5 if is_class else accessibility_threshold)
                    pattern_bits.append(1 if is_open else 0)
                    offset += pw
                else:
                    pattern_bits.append(0)

            pattern = tuple(pattern_bits)
            pattern_to_reads[pattern].append(i)
            read_patterns.append(pattern)

        sorted_patterns = sorted(
            pattern_to_reads.keys(),
            key=lambda p: (-len(pattern_to_reads[p]), p),
        )

        max_combinatorial = 50
        if len(sorted_patterns) > max_combinatorial:
            top_patterns = sorted_patterns[:max_combinatorial]
            pattern_to_label = {p: idx for idx, p in enumerate(top_patterns)}
            # A read with a rarer pattern joins the nearest kept pattern, by the
            # rule dynamic reassignment uses (match_pattern_to_cluster, weighted
            # by how much of each peak the read covers), so reassigning an
            # unchanged read keeps its cluster.
            from services.dynamic_clustering import match_pattern_to_cluster, read_peak_overlap_weights
            reads_by_id = {}
            for read in compact_reads:
                reads_by_id.setdefault(read.get("analysis_id") or read.get("id"), read)
            labels = np.empty(n_samples, dtype=np.int32)
            for i in range(n_samples):
                pattern = read_patterns[i]
                if pattern in pattern_to_label:
                    labels[i] = pattern_to_label[pattern]
                    continue
                read = reads_by_id.get(read_ids[i])
                weights = None
                if read is not None:
                    # A read of another window (its own locus) is weighted by
                    # that window's peaks, which are in its own coordinates.
                    group = read.get("_cluster_group")
                    own_peaks = (window_groups[group][0]
                                 if window_groups and group in window_groups else peak_regions)
                    peak_weights = read_peak_overlap_weights(read, own_peaks)
                    weights = tuple(peak_weights[p_idx] for p_idx, _o, _w, _c in pattern_slices)
                labels[i] = match_pattern_to_cluster(pattern, pattern_to_label, weights)
        else:
            pattern_to_label = {p: idx for idx, p in enumerate(sorted_patterns)}
            labels = np.array(
                [pattern_to_label[read_patterns[i]] for i in range(n_samples)],
                dtype=np.int32,
            )

        # The same schema as cluster_reads, which cluster_all, dynamic
        # reassignment (cluster_patterns) and similarity sorting read; each
        # cluster's detail is under "clusters". One element per pattern bit: a
        # peak with saved footprint classes has a bit per class (see
        # "elements" for which peak and whether it is a class).
        elements = [{"index": bit, "peak": int(p_idx), "class": bool(is_class)}
                    for bit, (p_idx, _offset, _pw, is_class) in enumerate(pattern_slices)]
        element_read_ids = {i: [] for i in range(len(elements))}
        for read_idx, pattern in enumerate(read_patterns):
            for elem_idx, is_open in enumerate(pattern):
                if is_open and elem_idx in element_read_ids:
                    element_read_ids[elem_idx].append(read_ids[read_idx])
        clusters = {}
        for pattern, label in pattern_to_label.items():
            clusters[int(label)] = {
                "pattern": pattern,
                "peak_states": {f"peak_{i}": bool(bit) for i, bit in enumerate(pattern)},
                "read_ids": [read_ids[i] for i in range(n_samples) if labels[i] == label],
            }
        combinatorial_info = {
            "n_elements": len(elements),
            "elements": elements,
            "cluster_patterns": {label: list(info["pattern"]) for label, info in clusters.items()},
            "element_read_ids": element_read_ids,
            "method": "combinatorial",
            "clusters": clusters,
        }

        log_cluster_assignment_diagnostic(f"  Combinatorial: {len(sorted_patterns)} unique patterns")

    elif fit_rows is not None and method in ("kmeans", "minibatch"):
        from services.matched_view_clustering import _fit_predict
        labels = _fit_predict(X, np.asarray(fit_rows, dtype=np.int64), n_clusters, method, random_state)

    elif method == "minibatch":
        try:
            from sklearn.cluster import MiniBatchKMeans

            actual_k = _bounded_cluster_count(n_clusters, n_samples)
            labels = MiniBatchKMeans(
                n_clusters=actual_k,
                random_state=random_state,
                batch_size=min(1000, n_samples),
            ).fit_predict(X)
        except ImportError:
            actual_k = _bounded_cluster_count(n_clusters, n_samples)
            labels = _kmeans_labels(X, actual_k, random_state)

    elif method == "kmeans":
        actual_k = _bounded_cluster_count(n_clusters, n_samples)
        labels = _kmeans_labels(X, actual_k, random_state)

    elif method == "hdbscan":
        labels = _hdbscan_labels(X)

    elif method == "graph":
        labels = _graph_labels(X, read_ids, resolution, random_state)

    elif method == "agglom":
        labels = _agglom_labels(X)

    t2 = time.time()

    unique, counts = np.unique(labels, return_counts=True)
    log_cluster_assignment_diagnostic(f"  Clustering complete: {t2-t1:.3f}s, {len(unique)} clusters")

    assignments = {read_ids[i]: int(labels[i]) for i in range(len(read_ids))}

    return assignments, {int(u): int(c) for u, c in zip(unique, counts)}, np.argsort(labels), combinatorial_info
