"""t-SNE read maps, the neighbourhood graph they are built from, and what uses it.

One t-SNE map of a set of reads (their clustering features) is used three ways:

- the Clusters > Projection scatter (and its per-read export),
- Sort "By projection (t-SNE)": reads ordered so neighbours on the map sit
  next to each other in the read panel,
- the "Neighbourhoods (t-SNE graph)" cluster method: communities of the same
  nearest-neighbour affinity graph t-SNE lays out.

Reproducibility: rows are put in a canonical order (by their keys) before
anything is computed, so the same reads give the same map whatever order they
arrive in. Neighbours come from a ball tree and the initial layout from
einsum (no BLAS), and t-SNE's Barnes-Hut sums run on one OpenMP thread, so
the map doesn't change with thread counts or between runs. Under the cap the
map depends on the reads alone; the seed picks the subsample above it and
orders the graph clustering's moves. Maps are cached by a
digest of the features and settings, so re-colouring (merging, dissolving)
and sorting reuse the map instead of recomputing it.

t-SNE keeps each read's nearest neighbours together but not distances between
groups or group sizes, which is why the graph method clusters the
neighbourhood graph rather than the 2-D picture.
"""
from __future__ import annotations

import hashlib
import threading
from collections import OrderedDict
from typing import Any, Dict, Optional, Sequence

import numpy as np

# Reads embedded per map. Above this, a seeded subsample is embedded and every
# other read is placed at the mean position of its nearest embedded reads
# (marked embedded=False in the export). The map is computed on one thread
# (see _single_threaded): 3,000 reads take about 10 s, then come from the cache.
TSNE_MAX_READS = 3000
# Barnes-Hut t-SNE sums over threads in whatever order they finish, so the
# same reads and seed give a different map on 2, 4 or 8 threads, and even
# between runs on the same count. One thread makes the map exactly
# reproducible on a machine (given the same scikit-learn/numpy/BLAS). Set
# FIBERBROWSER_TSNE_THREADS to trade that for speed (the map then depends on
# the count and can vary between runs); the count is recorded with the map.
def _tsne_threads() -> int:
    import os

    try:
        return max(1, int(os.environ.get("FIBERBROWSER_TSNE_THREADS", "1")))
    except ValueError:
        return 1


TSNE_THREADS = _tsne_threads()
# Placed reads sit at the mean of this many nearest embedded reads.
PLACEMENT_NEIGHBORS = 10
GRAPH_DEFAULT_RESOLUTION = 1.0

_CACHE_MAX = 16
from services.byte_cache import shared_cache
_cache = shared_cache()
_cache_lock = threading.Lock()


def tsne_perplexity(n_samples: int) -> float:
    """The perplexity used for n reads (30, lower for small sets; always below n)."""
    return float(min(30.0, max(5.0, (n_samples - 1) / 3), max(1.0, n_samples - 1)))


_threads_lock = threading.Lock()


def _load_numerics() -> None:
    """Import what the maps use before limiting threads: a thread pool first
    loaded inside the limit would escape it."""
    import sklearn.manifold  # noqa: F401
    import sklearn.manifold._barnes_hut_tsne  # noqa: F401
    import sklearn.manifold._t_sne  # noqa: F401
    import sklearn.neighbors  # noqa: F401


class _single_threaded:
    """Run a map's numerical work on TSNE_THREADS OpenMP threads, one map at a time.

    The OpenMP limit is per calling thread, so it never changes other
    requests' threads. BLAS (whose thread count is process-wide) is not
    used: neighbours come from a ball tree and the initial layout from
    einsum, both independent of BLAS threads.
    """

    def __enter__(self):
        _load_numerics()
        _threads_lock.acquire()
        try:
            from threadpoolctl import threadpool_limits

            self._limits = threadpool_limits(limits=TSNE_THREADS, user_api="openmp")
        except Exception:  # pragma: no cover - threadpoolctl ships with scikit-learn
            self._limits = None
        return self

    def __exit__(self, *exc):
        try:
            if self._limits is not None:
                self._limits.restore_original_limits()
        finally:
            _threads_lock.release()
        return False


def tsne_n_neighbors(n_samples: int, perplexity: float) -> int:
    """Neighbours per read in the t-SNE graph (scikit-learn: 3 x perplexity + 1)."""
    return int(max(1, min(n_samples - 1, int(3.0 * perplexity + 1))))


def canonical_order(keys: Optional[Sequence[str]], n: int) -> np.ndarray:
    """Row order by key (stable), so input order never changes the result."""
    if keys is None:
        return np.arange(n)
    if len(keys) != n:
        raise ValueError("one key per row")
    return np.array(sorted(range(n), key=lambda i: (str(keys[i]), i)), dtype=np.int64)


def feature_digest(features: np.ndarray) -> str:
    """Short digest of a feature matrix (shape and values)."""
    x = np.ascontiguousarray(np.asarray(features, dtype=np.float32))
    h = hashlib.sha256()
    h.update(repr(x.shape).encode())
    h.update(x.tobytes())
    return h.hexdigest()[:16]


def subsample_indices(n: int, cap: Optional[int], random_state: int) -> Optional[np.ndarray]:
    """Sorted seeded subsample of n rows, or None when all fit under the cap."""
    if cap is None or cap <= 0 or n <= cap:
        return None
    rng = np.random.default_rng(int(random_state))
    return np.sort(rng.choice(n, size=int(cap), replace=False))


# ── The neighbourhood graph ─────────────────────────────────────────────────

def _binary_search_perplexity_numpy(sqdist: np.ndarray, perplexity: float,
                                    n_steps: int = 100, tol: float = 1e-5) -> np.ndarray:
    """Per-row Gaussian bandwidths matching the perplexity (scikit-learn's search, vectorised)."""
    d = np.asarray(sqdist, dtype=np.float64)
    n = d.shape[0]
    beta = np.ones(n)
    beta_min = np.full(n, -np.inf)
    beta_max = np.full(n, np.inf)
    desired = np.log(perplexity)
    P = np.zeros_like(d)
    done = np.zeros(n, dtype=bool)
    for _ in range(n_steps):
        P = np.exp(-d * beta[:, None])
        sum_p = P.sum(axis=1)
        sum_p[sum_p == 0.0] = 1e-8
        P /= sum_p[:, None]
        entropy = np.log(sum_p) + beta * (d * P).sum(axis=1)
        diff = entropy - desired
        done |= np.abs(diff) <= tol
        if done.all():
            break
        up = (diff > 0) & ~done
        down = (diff <= 0) & ~done
        beta_min[up] = beta[up]
        beta[up] = np.where(np.isinf(beta_max[up]), beta[up] * 2.0, (beta[up] + beta_max[up]) / 2.0)
        beta_max[down] = beta[down]
        beta[down] = np.where(np.isinf(beta_min[down]), beta[down] / 2.0, (beta[down] + beta_min[down]) / 2.0)
    return P.astype(np.float32)


def tsne_affinity_graph(features: np.ndarray, perplexity: Optional[float] = None):
    """The symmetric affinity matrix P that t-SNE (Barnes-Hut) builds from these rows.

    scikit-learn's construction: Euclidean k nearest neighbours (k = 3 x
    perplexity + 1), Gaussian affinities whose bandwidth per read matches the
    perplexity, symmetrised and normalised to sum 1. The map is fitted on
    this same neighbour graph (_run_tsne passes it to TSNE).
    """
    from scipy.sparse import csr_matrix

    X = np.asarray(features, dtype=np.float32)
    n = X.shape[0]
    if n < 2:
        return csr_matrix((n, n), dtype=np.float64)
    perplexity = tsne_perplexity(n) if perplexity is None else float(perplexity)
    distances = knn_sqdist_graph(X, tsne_n_neighbors(n, perplexity))
    try:
        # scikit-learn's own routine, so the graph is exactly the one TSNE fits.
        from sklearn.manifold._t_sne import _joint_probabilities_nn

        P = _joint_probabilities_nn(distances, perplexity, 0)
    except Exception:
        distances.sort_indices()
        cond = _binary_search_perplexity_numpy(distances.data.reshape(n, -1).astype(np.float32), perplexity)
        P = csr_matrix((cond.ravel(), distances.indices, distances.indptr), shape=(n, n))
        P = P + P.T
        P = P / max(float(P.sum()), np.finfo(np.double).eps)
    return csr_matrix(P, dtype=np.float64)


# ── Louvain communities (modularity with a resolution) ──────────────────────

def _local_moving(indptr, indices, data, k, m2, resolution, order, max_sweeps=50):
    """One Louvain level: move nodes to the neighbouring community with the best gain."""
    n = k.shape[0]
    comm = np.arange(n)
    tot = k.astype(np.float64).copy()
    moved_any = False
    for _ in range(max_sweeps):
        moved = 0
        for i in order:
            lo, hi = indptr[i], indptr[i + 1]
            nb = indices[lo:hi]
            w = data[lo:hi]
            keep = nb != i
            nb = nb[keep]
            w = w[keep]
            ci = comm[i]
            ki = k[i]
            tot[ci] -= ki
            if nb.size == 0:
                tot[ci] += ki
                continue
            uc, inv = np.unique(comm[nb], return_inverse=True)
            kin = np.bincount(inv, weights=w)
            gains = kin - resolution * tot[uc] * ki / m2
            pos = np.searchsorted(uc, ci)
            own_gain = gains[pos] if pos < uc.size and uc[pos] == ci else -resolution * tot[ci] * ki / m2
            best = int(np.argmax(gains))
            target = int(uc[best]) if gains[best] > own_gain + 1e-15 else int(ci)
            tot[target] += ki
            if target != ci:
                comm[i] = target
                moved += 1
        if moved == 0:
            break
        moved_any = True
    return comm, moved_any


def louvain_communities(W, resolution: float = GRAPH_DEFAULT_RESOLUTION, random_state: int = 0) -> np.ndarray:
    """Louvain modularity communities of a symmetric weighted graph.

    Higher resolution gives more, smaller communities. Communities that are
    not connected within themselves are split (as Leiden guarantees), and
    labels are numbered by size, largest first. Deterministic for a seed.
    """
    from scipy.sparse import csr_matrix
    from scipy.sparse.csgraph import connected_components

    W = csr_matrix(W, dtype=np.float64)
    n = W.shape[0]
    if n == 0:
        return np.zeros(0, dtype=np.int32)
    m2 = float(W.sum())
    if m2 <= 0:
        return np.zeros(n, dtype=np.int32)
    rng = np.random.default_rng(int(random_state))
    membership = np.arange(n)
    G = W
    for _level in range(32):
        G = csr_matrix(G)
        G.sort_indices()
        k = np.asarray(G.sum(axis=1)).ravel()
        order = rng.permutation(G.shape[0])
        comm, moved = _local_moving(G.indptr, G.indices, G.data, k, m2, float(resolution), order)
        if not moved:
            break
        _, comm = np.unique(comm, return_inverse=True)
        membership = comm[membership]
        n_comm = int(comm.max()) + 1
        M = csr_matrix((np.ones(G.shape[0]), (np.arange(G.shape[0]), comm)), shape=(G.shape[0], n_comm))
        G = (M.T @ G @ M).tocsr()
        if n_comm == 1:
            break

    # Split communities that are not connected within themselves.
    labels = np.full(n, -1, dtype=np.int64)
    next_label = 0
    for c in np.unique(membership):
        idx = np.flatnonzero(membership == c)
        if idx.size == 1:
            labels[idx] = next_label
            next_label += 1
            continue
        n_parts, parts = connected_components(W[idx][:, idx], directed=False)
        labels[idx] = next_label + parts
        next_label += n_parts
    return relabel_by_size(labels)


def relabel_by_size(labels: np.ndarray) -> np.ndarray:
    """Number groups 0.. by size, largest first (ties: earliest first member)."""
    labels = np.asarray(labels)
    uniq, first, counts = np.unique(labels, return_index=True, return_counts=True)
    rank = sorted(range(len(uniq)), key=lambda i: (-counts[i], first[i]))
    mapping = {int(uniq[r]): new for new, r in enumerate(rank)}
    return np.array([mapping[int(v)] for v in labels], dtype=np.int32)


def graph_cluster_labels(features: np.ndarray, *, resolution: float = GRAPH_DEFAULT_RESOLUTION,
                         random_state: int = 0, keys: Optional[Sequence[str]] = None) -> np.ndarray:
    """Communities of the t-SNE neighbourhood graph of these rows (input order)."""
    X = np.asarray(features, dtype=np.float32)
    n = X.shape[0]
    if n <= 2:
        return np.zeros(n, dtype=np.int32)
    order = canonical_order(keys, n)
    # Ball-tree neighbours: no thread pools involved.
    P = tsne_affinity_graph(X[order])
    labels_sorted = louvain_communities(P, resolution=resolution, random_state=random_state)
    # Numbered by size, ties by canonical position, so input order never matters.
    labels = np.empty(n, dtype=np.int32)
    labels[order] = labels_sorted
    return labels


# ── The t-SNE map ───────────────────────────────────────────────────────────

def knn_sqdist_graph(X: np.ndarray, k: int):
    """Squared Euclidean distances to each row's k nearest other rows (CSR).

    A ball tree, not BLAS: the neighbours (and ties) don't depend on how
    many threads BLAS uses.
    """
    from sklearn.neighbors import NearestNeighbors

    graph = NearestNeighbors(n_neighbors=int(k), algorithm="ball_tree").fit(X).kneighbors_graph(mode="distance")
    graph.data **= 2
    graph.sort_indices()
    return graph


def _with_self(graph):
    """The neighbour graph with each row's own zero distance stored first.

    TSNE asks a precomputed graph for k + 1 neighbours and drops the row
    itself; without it stored, it would drop the nearest real neighbour."""
    from scipy.sparse import csr_matrix

    n = graph.shape[0]
    counts = np.diff(graph.indptr)
    indptr = np.concatenate([[0], np.cumsum(counts + 1)])
    indices = np.empty(indptr[-1], dtype=graph.indices.dtype)
    data = np.zeros(indptr[-1], dtype=graph.data.dtype)
    starts = indptr[:-1]
    indices[starts] = np.arange(n)
    rest = np.ones(indptr[-1], dtype=bool)
    rest[starts] = False
    indices[rest] = graph.indices
    data[rest] = graph.data
    return csr_matrix((data, indices, indptr), shape=graph.shape)


def _pca_init(X: np.ndarray, n_components: int, random_state: int) -> np.ndarray:
    """scikit-learn's PCA initialisation (top components, PC1 scaled to sd 1e-4),
    by einsum and power iteration so no step depends on BLAS threads."""
    Xc = np.asarray(X, dtype=np.float64)
    Xc = Xc - Xc.mean(axis=0)
    cov = np.einsum("ij,ik->jk", Xc, Xc)
    rng = np.random.default_rng(int(random_state))
    vectors = []
    for _ in range(n_components):
        v = rng.standard_normal(cov.shape[0])
        for _it in range(300):
            for u in vectors:
                v = v - np.einsum("i,i->", u, v) * u
            w = np.einsum("jk,k->j", cov, v)
            norm = np.sqrt(np.einsum("i,i->", w, w))
            if norm == 0:
                break
            v = w / norm
        for u in vectors:
            v = v - np.einsum("i,i->", u, v) * u
        norm = np.sqrt(np.einsum("i,i->", v, v))
        v = v / norm if norm > 0 else v
        # A fixed sign: the largest entry positive.
        if v[np.argmax(np.abs(v))] < 0:
            v = -v
        vectors.append(v)
    embedding = np.einsum("ij,kj->ik", Xc, np.array(vectors))
    sd = embedding[:, 0].std()
    if sd > 0:
        embedding = embedding / sd * 1e-4
    return embedding.astype(np.float32)


def _run_tsne(X: np.ndarray, perplexity: float, random_state: int, n_components: int = 2) -> np.ndarray:
    """Barnes-Hut t-SNE on the neighbour graph tsne_affinity_graph uses."""
    from sklearn.manifold import TSNE

    graph = _with_self(knn_sqdist_graph(X, tsne_n_neighbors(X.shape[0], perplexity)))
    try:  # scikit-learn >= 1.2; older ones sort it themselves (with a warning)
        from sklearn.neighbors import sort_graph_by_row_values

        graph = sort_graph_by_row_values(graph, copy=False, warn_when_not_sorted=False)
    except ImportError:  # pragma: no cover
        pass
    return TSNE(
        n_components=n_components,
        perplexity=perplexity,
        random_state=int(random_state),
        init=_pca_init(X, n_components, random_state),
        learning_rate="auto",
        # Squared distances, as TSNE squares its own Euclidean ones.
        metric="precomputed",
    ).fit_transform(graph).astype(np.float32)


def compute_tsne_embedding(features: np.ndarray, *, n_components: int, random_state: int) -> np.ndarray:
    """An n-dimensional (1-3) t-SNE embedding by the same reproducible route as the map."""
    X = np.asarray(features, dtype=np.float32)
    n = X.shape[0]
    if n < 4 or not (X != X[0]).any():
        raise ValueError("t-SNE needs at least 4 reads with differing features")
    if not 1 <= n_components <= 3:
        raise ValueError("t-SNE here embeds in 1 to 3 dimensions")
    with _single_threaded():
        return _run_tsne(X, tsne_perplexity(n), random_state, n_components)


def _embed(Xc: np.ndarray, sub: Optional[np.ndarray], perplexity: float, random_state: int):
    """t-SNE of the rows (or of the subsample, the rest placed by their nearest embedded rows)."""
    n = Xc.shape[0]
    if sub is None:
        return _run_tsne(Xc, perplexity, random_state), np.ones(n, dtype=bool)
    from sklearn.neighbors import NearestNeighbors

    coords = np.zeros((n, 2), dtype=np.float32)
    embedded = np.zeros(n, dtype=bool)
    embedded[sub] = True
    coords[sub] = _run_tsne(Xc[sub], perplexity, random_state)
    rest = np.flatnonzero(~embedded)
    nn = NearestNeighbors(n_neighbors=min(PLACEMENT_NEIGHBORS, sub.size), algorithm="ball_tree").fit(Xc[sub])
    _, idx = nn.kneighbors(Xc[rest])
    coords[rest] = coords[sub][idx].mean(axis=1)
    return coords, embedded


def compute_tsne_map(features: np.ndarray, *, random_state: int, keys: Optional[Sequence[str]] = None,
                     max_reads: Optional[int] = TSNE_MAX_READS) -> Dict[str, Any]:
    """A reproducible 2-D t-SNE map of these rows.

    Returns coords (input order), embedded (False for reads placed by their
    nearest embedded reads because the set was over the cap), and the
    parameters that define the map (perplexity, n_neighbors, random_state,
    feature_digest, cap). Raises ValueError for fewer than 4 rows or when
    every read has the same features (nothing to lay out; scikit-learn's
    PCA initialisation divides by zero there and crashes the process).
    """
    X = np.asarray(features, dtype=np.float32)
    n = X.shape[0]
    if n < 4:
        raise ValueError("t-SNE needs at least 4 reads")
    order = canonical_order(keys, n)
    Xc = np.ascontiguousarray(X[order])
    sub = subsample_indices(n, max_reads, random_state)
    n_embedded = n if sub is None else int(sub.size)
    embed_rows = Xc if sub is None else Xc[sub]
    if not (embed_rows != embed_rows[0]).any():
        raise ValueError("every read has the same features: no t-SNE map")
    perplexity = tsne_perplexity(n_embedded)
    digest = feature_digest(Xc)
    cache_key = f"{digest}|tsne|{int(random_state)}|{perplexity}|{max_reads}|{TSNE_THREADS}"
    with _cache_lock:
        hit = _cache.get(cache_key)
        if hit is not None:
            _cache.move_to_end(cache_key)
    if hit is None:
        with _single_threaded():
            coords_c, embedded_c = _embed(Xc, sub, perplexity, random_state)
        hit = {"coords": coords_c, "embedded": embedded_c}
        with _cache_lock:
            _cache[cache_key] = hit
        cache_hit = False
    else:
        cache_hit = True
    coords = np.empty((n, 2), dtype=np.float32)
    coords[order] = hit["coords"]
    embedded = np.empty(n, dtype=bool)
    embedded[order] = hit["embedded"]
    return {
        "coords": coords,
        "embedded": embedded,
        "perplexity": perplexity,
        "n_neighbors": tsne_n_neighbors(n_embedded, perplexity),
        "random_state": int(random_state),
        "feature_digest": digest,
        "max_reads": max_reads,
        "n_embedded": n_embedded,
        "threads": TSNE_THREADS,
        "cache_hit": cache_hit,
    }


def clear_tsne_cache() -> None:
    with _cache_lock:
        _cache.clear()


# ── Ordering reads along the map ────────────────────────────────────────────

def _nn_path(points: np.ndarray, start: int) -> list[int]:
    """Greedy nearest-neighbour path through the points from start (ties: lowest index)."""
    m = points.shape[0]
    remaining = np.ones(m, dtype=bool)
    path = [start]
    remaining[start] = False
    current = start
    for _ in range(m - 1):
        cand = np.flatnonzero(remaining)
        d = ((points[cand] - points[current]) ** 2).sum(axis=1)
        current = int(cand[int(np.argmin(d))])
        path.append(current)
        remaining[current] = False
    return path


def _extreme_point(points: np.ndarray) -> int:
    """One end of the points' long axis (deterministic)."""
    if points.shape[0] <= 2:
        return 0
    centred = points - points.mean(axis=0)
    _u, _s, vt = np.linalg.svd(centred.astype(np.float64), full_matrices=False)
    axis = vt[0]
    # Fix the sign so the start doesn't flip between runs.
    if axis[np.argmax(np.abs(axis))] < 0:
        axis = -axis
    proj = centred @ axis
    return int(np.argmin(proj))


def order_by_projection(coords: np.ndarray, labels: Sequence[int],
                        keys: Optional[Sequence[str]] = None) -> Dict[str, Any]:
    """Order reads so neighbours on the map are next to each other.

    Clusters follow a nearest-neighbour path through their centroids (from one
    end of the map); within each cluster, reads follow a nearest-neighbour
    path through their map positions, starting next to where the previous
    cluster ended. Deterministic: ties go to the canonical (key) order.
    Returns {"order": row indices, "cluster_order": [cluster ids]}.
    """
    coords = np.asarray(coords, dtype=np.float64)
    labels = np.asarray(labels)
    n = coords.shape[0]
    if n == 0:
        return {"order": [], "cluster_order": []}
    canon = canonical_order(keys, n)
    coords_c = coords[canon]
    labels_c = labels[canon]
    clusters = sorted({int(c) for c in labels_c.tolist()})
    assigned = [c for c in clusters if c >= 0]
    centroids = np.array([coords_c[labels_c == c].mean(axis=0) for c in assigned]) if assigned else np.zeros((0, 2))
    if len(assigned) > 1:
        cpath = _nn_path(centroids, _extreme_point(centroids))
        cluster_order = [assigned[i] for i in cpath]
    else:
        cluster_order = list(assigned)
    if any(c < 0 for c in clusters):
        cluster_order += [c for c in clusters if c < 0]

    order: list[int] = []
    last_point = None
    for c in cluster_order:
        members = np.flatnonzero(labels_c == c)
        pts = coords_c[members]
        if last_point is None:
            start = _extreme_point(pts)
        else:
            start = int(np.argmin(((pts - last_point) ** 2).sum(axis=1)))
        path = _nn_path(pts, start)
        order.extend(int(canon[members[i]]) for i in path)
        last_point = pts[path[-1]]
    return {"order": order, "cluster_order": cluster_order}
