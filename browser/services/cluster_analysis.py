"""Pure clustering post-processing helpers."""
from __future__ import annotations

from typing import Dict

import numpy as np

from services.diagnostics import log_if_enabled

CLUSTER_DIAGNOSTICS_ENV = "FIBERBROWSER_CLUSTER_DIAGNOSTICS"
# Reads no cluster fits (dynamic reassignment): not a cluster to merge into or count.
UNASSIGNED = -1


def log_cluster_diagnostic(message: str) -> None:
    """Print clustering diagnostics only when explicitly enabled."""
    log_if_enabled(CLUSTER_DIAGNOSTICS_ENV, message)


def dissolve_cluster_to_nearest(
    features: np.ndarray,
    assignments: np.ndarray,
    dissolve_id: int,
) -> tuple[np.ndarray, dict]:
    """Reassign one cluster's reads to the nearest remaining cluster centroid."""
    features = np.asarray(features, dtype=np.float32)
    assignments = np.asarray(assignments, dtype=np.int32).copy()

    remaining_mask = assignments != dissolve_id
    dissolve_mask = assignments == dissolve_id
    dissolved_count = int(dissolve_mask.sum())

    if dissolved_count == 0:
        return assignments, {
            "changed": False,
            "reason": "no_reads",
            "dissolved_count": 0,
            "remaining_clusters": [],
        }

    remaining_clusters = sorted(set(assignments[remaining_mask].tolist()) - {UNASSIGNED})
    if not remaining_clusters:
        return assignments, {
            "changed": False,
            "reason": "no_remaining_clusters",
            "dissolved_count": dissolved_count,
            "remaining_clusters": [],
        }

    centroids = {}
    for cluster_id in remaining_clusters:
        mask = assignments == cluster_id
        centroids[cluster_id] = features[mask].mean(axis=0)

    centroid_ids = list(centroids.keys())
    centroid_matrix = np.array([centroids[cluster_id] for cluster_id in centroid_ids], dtype=np.float32)
    dissolve_features = features[dissolve_mask]
    distances = np.linalg.norm(
        dissolve_features[:, None, :] - centroid_matrix[None, :, :],
        axis=2,
    )
    nearest = np.argmin(distances, axis=1)

    dissolve_indices = np.where(dissolve_mask)[0]
    for index, read_idx in enumerate(dissolve_indices):
        assignments[read_idx] = centroid_ids[nearest[index]]

    return assignments, {
        "changed": True,
        "reason": "reassigned",
        "dissolved_count": dissolved_count,
        "remaining_clusters": remaining_clusters,
    }


# "Merge by": how Merge similar clusters decides two clusters are alike.
MERGE_STRATEGIES = ("cosine", "correlation", "difference", "js", "connectivity")
# Each strategy's threshold when none is given (cosine: max_cosine_similarity).
MERGE_DEFAULT_THRESHOLDS = {
    "cosine": 0.95,
    "correlation": 0.95,
    "difference": 0.20,
    "js": 0.10,
    "connectivity": 1.0,
}
MERGE_DEFAULT_ALPHA = 0.01
# Reads added to each cluster at the pair's pooled profile before the JS distance.
JS_PSEUDOCOUNT = 5.0
CONNECTIVITY_NEIGHBORS = 15


def check_merge_strategy(strategy: str | None) -> str:
    """The strategy name, lower case; a plain error for an unknown one."""
    name = (strategy or "cosine").strip().lower()
    if name not in MERGE_STRATEGIES:
        raise ValueError(
            f"Unknown merge strategy '{strategy}': use one of {', '.join(MERGE_STRATEGIES)}"
        )
    return name


def resolve_merge_threshold(strategy: str, threshold: float | None, max_cosine_similarity: float = 0.95) -> float:
    """The threshold a strategy uses (None: its default; cosine: max_cosine_similarity)."""
    strategy = check_merge_strategy(strategy)
    if threshold is not None:
        return float(threshold)
    if strategy == "cosine":
        return float(max_cosine_similarity)
    return float(MERGE_DEFAULT_THRESHOLDS[strategy])


def _two_proportion_qvalues(p1: np.ndarray, p2: np.ndarray, n1: int, n2: int,
                            var1: np.ndarray | None = None, var2: np.ndarray | None = None,
                            binary: np.ndarray | None = None) -> np.ndarray:
    """Benjamini–Hochberg q-values of per-column tests of the two clusters' means.

    Columns of 0/1 values (accessible or not; `binary`, default all): pooled
    two-proportion z-test. Other columns (e.g. TF footprint sizes, fractions):
    a Welch z-test on the clusters' own variances (`var1`, `var2`); equal
    constant values give p = 1, different constant values p = 0."""
    from scipy.special import erfc

    p1 = np.asarray(p1, dtype=np.float64)
    p2 = np.asarray(p2, dtype=np.float64)
    if p1.size == 0 or n1 <= 0 or n2 <= 0:
        return np.ones_like(p1)
    if binary is None:
        binary = np.ones(p1.shape, dtype=bool)
    b1, b2 = np.clip(p1, 0.0, 1.0), np.clip(p2, 0.0, 1.0)
    pooled = (n1 * b1 + n2 * b2) / (n1 + n2)
    se = np.sqrt(pooled * (1.0 - pooled) * (1.0 / n1 + 1.0 / n2))
    if var1 is not None and var2 is not None:
        welch = np.sqrt(np.asarray(var1, dtype=np.float64) / n1 + np.asarray(var2, dtype=np.float64) / n2)
        se = np.where(binary, se, welch)
    diff = np.abs(p1 - p2)
    pvals = np.ones_like(p1)
    ok = se > 0
    z = diff[ok] / se[ok]
    pvals[ok] = erfc(z / np.sqrt(2.0))
    # No spread at all but different values: as different as it gets.
    pvals[(~ok) & (diff > 1e-9)] = 0.0
    # Benjamini–Hochberg.
    m = pvals.size
    order = np.argsort(pvals, kind="stable")
    ranked = pvals[order] * m / np.arange(1, m + 1)
    ranked = np.minimum.accumulate(ranked[::-1])[::-1]
    q = np.empty_like(pvals)
    q[order] = np.minimum(ranked, 1.0)
    return q


def _bernoulli_entropy(p: np.ndarray) -> np.ndarray:
    p = np.clip(p, 0.0, 1.0)
    out = np.zeros_like(p)
    for v in (p, 1.0 - p):
        nz = v > 0
        out[nz] -= v[nz] * np.log2(v[nz])
    return out


def _js_distance(p1: np.ndarray, p2: np.ndarray, n1: int, n2: int, pseudo: float = JS_PSEUDOCOUNT) -> float:
    """sqrt(mean over columns of the Bernoulli Jensen–Shannon divergence), in [0, 1].

    Each cluster's proportions are shrunk toward the pair's pooled proportions
    by `pseudo` reads, so a small cluster's noise reads as less different."""
    p1 = np.clip(np.asarray(p1, dtype=np.float64), 0.0, 1.0)
    p2 = np.clip(np.asarray(p2, dtype=np.float64), 0.0, 1.0)
    if p1.size == 0:
        return 0.0
    pooled = (n1 * p1 + n2 * p2) / max(n1 + n2, 1)
    a = (n1 * p1 + pseudo * pooled) / (n1 + pseudo)
    b = (n2 * p2 + pseudo * pooled) / (n2 + pseudo)
    mid = (a + b) / 2.0
    jsd = _bernoulli_entropy(mid) - (_bernoulli_entropy(a) + _bernoulli_entropy(b)) / 2.0
    return float(np.sqrt(max(0.0, float(np.mean(np.clip(jsd, 0.0, 1.0))))))


def _knn_adjacency(features: np.ndarray, k: int = CONNECTIVITY_NEIGHBORS):
    """Symmetric 0/1 kNN graph of the rows (ball tree: no BLAS threads, no randomness)."""
    from scipy.sparse import csr_matrix
    from sklearn.neighbors import NearestNeighbors

    n = features.shape[0]
    k = int(min(k, n - 1))
    if k < 1:
        return csr_matrix((n, n), dtype=np.float64)
    graph = NearestNeighbors(n_neighbors=k, algorithm="ball_tree").fit(features).kneighbors_graph(mode="connectivity")
    graph = graph.maximum(graph.T).tocsr()
    graph.setdiag(0)
    graph.eliminate_zeros()
    graph.data[:] = 1.0
    return graph


def _cluster_connectivity(adjacency, assignments: np.ndarray, cluster_ids: list[int]):
    """Between-cluster edge weights W and each cluster's total degree, plus 2m."""
    from scipy.sparse import csr_matrix

    index = {c: i for i, c in enumerate(cluster_ids)}
    rows = np.array([i for i, c in enumerate(assignments.tolist()) if c in index], dtype=np.int64)
    cols = np.array([index[int(assignments[i])] for i in rows], dtype=np.int64)
    n = assignments.shape[0]
    membership = csr_matrix((np.ones(rows.size), (rows, cols)), shape=(n, len(cluster_ids)))
    between = (membership.T @ adjacency @ membership).toarray()
    degree = np.asarray(adjacency.sum(axis=1)).ravel()
    cluster_degree = np.asarray(membership.T @ degree).ravel()
    two_m = float(degree.sum())
    return between, cluster_degree, two_m


def _pair_scores(strategy, ids, centroids, counts, threshold, alpha, connectivity, variances=None, binary=None):
    """The best mergeable pair (smaller, larger, score) by `strategy`, or None.

    Pairs are visited in sorted cluster order; a tie keeps the first pair."""
    best = None
    best_key = None
    if strategy == "connectivity":
        if connectivity is None:
            return None
        between, cluster_degree, two_m = connectivity
        if two_m <= 0:
            return None
    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            a_id, b_id = ids[i], ids[j]
            a, b = centroids[a_id], centroids[b_id]
            if strategy == "correlation":
                ac = a - a.mean()
                bc = b - b.mean()
                na, nb = float(np.linalg.norm(ac)), float(np.linalg.norm(bc))
                if na <= 0 or nb <= 0:
                    continue
                score = float(np.dot(ac, bc) / (na * nb))
                if not score > threshold:
                    continue
                key = -score
            elif strategy == "difference":
                delta = np.abs(a - b).astype(np.float64)
                q = _two_proportion_qvalues(
                    a, b, counts[a_id], counts[b_id],
                    variances[a_id] if variances else None, variances[b_id] if variances else None, binary,
                )
                if np.any((q < alpha) & (delta >= threshold)):
                    continue
                score = float(delta.max()) if delta.size else 0.0
                key = score
            elif strategy == "js":
                score = _js_distance(a, b, counts[a_id], counts[b_id])
                if not score < threshold:
                    continue
                key = score
            elif strategy == "connectivity":
                expected = cluster_degree[i] * cluster_degree[j] / two_m
                if expected <= 0:
                    continue
                score = float(between[i, j] / expected)
                if not score > threshold:
                    continue
                key = -score
            else:  # pragma: no cover - checked by check_merge_strategy
                raise ValueError(strategy)
            if best_key is None or key < best_key:
                best_key = key
                if counts[a_id] <= counts[b_id]:
                    best = (a_id, b_id, score)
                else:
                    best = (b_id, a_id, score)
    return best


def _similarity_reason(strategy: str, other: int, score: float) -> str:
    if strategy == "correlation":
        return f"profile correlates with C{other} (r={score:.2f})"
    if strategy == "difference":
        return f"no position differs from C{other} (largest difference {score:.0%})"
    if strategy == "js":
        return f"close to C{other} (JS distance {score:.2f})"
    if strategy == "connectivity":
        return f"linked to C{other} on the neighbour graph (connectivity {score:.2f})"
    return f"similar to C{other} (cos={score:.3f})"


def run_autocull_on(
    features: np.ndarray,
    assignments: np.ndarray,
    min_fraction: float = 0.05,
    max_cosine_similarity: float = 0.95,
    min_remaining: int = 2,
    max_iter: int = 50,
    strategy: str = "cosine",
    threshold: float | None = None,
    alpha: float = MERGE_DEFAULT_ALPHA,
):
    """Dissolve low-abundance or redundant clusters and reassign reads.

    Clusters under `min_fraction` of the reads go first; then the smaller of
    the most alike pair, where "alike" is `strategy` ("Merge by"):

    - cosine: cosine of the two average profiles above `threshold`
      (default `max_cosine_similarity`);
    - correlation: Pearson r of the centred average profiles above `threshold`;
    - difference: no feature differs (Benjamini–Hochberg q < `alpha`) by at
      least `threshold`: a two-proportion z-test on 0/1 columns (the share of
      accessible reads), a Welch z-test on other columns (e.g. TF sizes);
    - js: Jensen–Shannon distance of the per-feature profiles (shrunk toward
      the pair's pooled profile by a few reads) below `threshold`;
    - connectivity: reads of the two clusters are neighbours (kNN graph) at
      least `threshold` times as often as expected by chance (above 1: merging
      raises the graph's modularity).

    Either way a dissolved cluster's reads go to the nearest remaining centroid.
    """
    strategy = check_merge_strategy(strategy)
    threshold = resolve_merge_threshold(strategy, threshold, max_cosine_similarity)
    assignments = np.asarray(assignments, dtype=np.int32).copy()
    features = np.asarray(features, dtype=np.float32)
    total_reads = int((assignments != UNASSIGNED).sum())
    dissolved_log = []
    adjacency = None
    if strategy == "connectivity" and features.shape[0] >= 3:
        adjacency = _knn_adjacency(features)
    # The difference test: which columns are 0/1 (proportions) and each cluster's spread for the others.
    binary_columns = None
    if strategy == "difference" and features.size:
        binary_columns = np.all((features == 0) | (features == 1), axis=0)

    for _ in range(max_iter):
        remaining_clusters = sorted(set(assignments.tolist()) - {UNASSIGNED})
        if len(remaining_clusters) <= min_remaining:
            break

        centroids = {}
        counts = {}
        variances = {} if strategy == "difference" else None
        for cluster_id in remaining_clusters:
            mask = assignments == cluster_id
            counts[cluster_id] = int(mask.sum())
            centroids[cluster_id] = features[mask].mean(axis=0)
            if variances is not None:
                variances[cluster_id] = features[mask].var(axis=0, ddof=1) if counts[cluster_id] > 1 else np.zeros(features.shape[1])

        smallest_cluster = None
        smallest_frac = 1.0
        for cluster_id in remaining_clusters:
            frac = counts[cluster_id] / total_reads if total_reads else 0
            if frac < min_fraction and frac < smallest_frac:
                smallest_frac = frac
                smallest_cluster = cluster_id

        most_similar_pair = None
        cluster_ids = list(centroids.keys())
        if smallest_cluster is None:
            if strategy == "cosine":
                best_sim = -1.0
                for i in range(len(cluster_ids)):
                    for j in range(i + 1, len(cluster_ids)):
                        a = centroids[cluster_ids[i]]
                        b = centroids[cluster_ids[j]]
                        norm_a = np.linalg.norm(a)
                        norm_b = np.linalg.norm(b)
                        if norm_a <= 0 or norm_b <= 0:
                            continue
                        similarity = float(np.dot(a, b) / (norm_a * norm_b))
                        if similarity > threshold and similarity > best_sim:
                            best_sim = similarity
                            if counts[cluster_ids[i]] <= counts[cluster_ids[j]]:
                                most_similar_pair = (cluster_ids[i], cluster_ids[j], similarity)
                            else:
                                most_similar_pair = (cluster_ids[j], cluster_ids[i], similarity)
            else:
                connectivity = (
                    _cluster_connectivity(adjacency, assignments, cluster_ids)
                    if adjacency is not None else None
                )
                most_similar_pair = _pair_scores(
                    strategy, cluster_ids, centroids, counts, threshold, alpha, connectivity,
                    variances, binary_columns,
                )

        dissolve_id = None
        reason = ""
        score = None
        if smallest_cluster is not None:
            dissolve_id = smallest_cluster
            reason = f"low abundance ({smallest_frac:.1%})"
        elif most_similar_pair is not None:
            dissolve_id = most_similar_pair[0]
            score = float(most_similar_pair[2])
            reason = _similarity_reason(strategy, most_similar_pair[1], score)
        else:
            break

        dissolve_mask = assignments == dissolve_id
        remaining_mask = assignments != dissolve_id
        remaining_ids = sorted(set(assignments[remaining_mask].tolist()) - {UNASSIGNED})
        if not remaining_ids:
            break

        centroid_matrix = np.array([centroids[cluster_id] for cluster_id in remaining_ids], dtype=np.float32)
        dissolve_features = features[dissolve_mask]
        distances = np.linalg.norm(
            dissolve_features[:, None, :] - centroid_matrix[None, :, :],
            axis=2,
        )
        nearest = np.argmin(distances, axis=1)

        merged_into: Dict[int, int] = {}
        dissolve_indices = np.where(dissolve_mask)[0]
        for i, read_idx in enumerate(dissolve_indices):
            target = remaining_ids[nearest[i]]
            assignments[read_idx] = target
            merged_into[target] = merged_into.get(target, 0) + 1

        dominant_target = max(merged_into.items(), key=lambda kv: kv[1])[0] if merged_into else None
        entry = {
            "cluster": int(dissolve_id),
            "count": int(counts[dissolve_id]),
            "reason": reason,
            "merged_into": {int(k): int(v) for k, v in merged_into.items()},
            "dominant_target": int(dominant_target) if dominant_target is not None else None,
        }
        if score is not None:
            # Which "Merge by" rule merged it, and its score (cosine, r, largest
            # difference, JS distance or connectivity ratio).
            entry["strategy"] = strategy
            entry["score"] = score
        dissolved_log.append(entry)

    return assignments, dissolved_log


def compute_cluster_projection(
    features: np.ndarray,
    method: str = "pca",
    n_components: int = 2,
    random_state: int = 42,
):
    """Project a feature matrix to low dimensions for visualization."""
    features = np.asarray(features, dtype=np.float32)
    n_samples = features.shape[0]
    if n_samples < 2:
        zeros = np.zeros((n_samples, n_components), dtype=np.float32)
        return zeros, None, method

    method = (method or "pca").lower()

    if method == "umap":
        try:
            import umap  # type: ignore

            reducer = umap.UMAP(
                n_components=n_components,
                n_neighbors=min(15, max(2, n_samples - 1)),
                min_dist=0.1,
                random_state=random_state,
            )
            coords = reducer.fit_transform(features).astype(np.float32)
            return coords, None, "umap"
        except ImportError:
            log_cluster_diagnostic("  compute_cluster_projection: umap-learn not installed, falling back to PCA")
            method = "pca"
        except Exception as exc:
            log_cluster_diagnostic(f"  compute_cluster_projection: UMAP failed ({exc}), falling back to PCA")
            method = "pca"

    if method == "tsne":
        try:
            from services.read_projection import compute_tsne_map

            if n_components == 2:
                # The reproducible, cached map the Projection tab uses.
                coords = compute_tsne_map(features, random_state=random_state)["coords"]
                return coords.astype(np.float32), None, "tsne"
            # Same reproducible route (one thread, BLAS-free neighbours and init).
            from services.read_projection import compute_tsne_embedding

            coords = compute_tsne_embedding(features, n_components=n_components, random_state=random_state)
            return coords, None, "tsne"
        except Exception as exc:
            log_cluster_diagnostic(f"  compute_cluster_projection: TSNE failed ({exc}), falling back to PCA")
            method = "pca"

    from sklearn.decomposition import PCA

    pca = PCA(n_components=min(n_components, features.shape[1], n_samples), random_state=random_state)
    coords = np.nan_to_num(pca.fit_transform(features)).astype(np.float32)
    if coords.shape[1] < n_components:
        pad = np.zeros((coords.shape[0], n_components - coords.shape[1]), dtype=np.float32)
        coords = np.hstack([coords, pad])

    # Identical features (e.g. every read closed at the peaks) give 0/0 = NaN,
    # which JSON can't carry: no variance is explained.
    variance_explained = [float(v) if np.isfinite(v) else 0.0 for v in pca.explained_variance_ratio_.tolist()]
    while len(variance_explained) < n_components:
        variance_explained.append(0.0)
    return coords, variance_explained, "pca"
