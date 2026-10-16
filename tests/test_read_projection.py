"""t-SNE as a first-class read projection: reproducible maps, the neighbourhood
graph clustering, sort by projection and the per-read export."""
from __future__ import annotations

from types import SimpleNamespace

import numpy as np
import pytest

from models.domain import WorkingSet
from models.requests import ClusterAllRequest, ProjectionRequest, SortReadsRequest
from services import clustering_endpoint, read_projection
from services.cluster_assignment import CLUSTER_METHODS, check_cluster_method, cluster_compact_reads


def planted(n_per=(60, 50, 40), d=40, seed=0, p_on=0.85, p_off=0.1):
    """Binary reads from three prototypes (blocks of open features)."""
    rng = np.random.default_rng(seed)
    rows, truth = [], []
    block = d // 3
    for g, n in enumerate(n_per):
        proto = np.full(d, p_off)
        proto[g * block:(g + 1) * block] = p_on
        rows.append((rng.random((n, d)) < proto).astype(np.float32))
        truth += [g] * n
    return np.vstack(rows), np.array(truth)


def ari(a, b):
    from sklearn.metrics import adjusted_rand_score

    return adjusted_rand_score(a, b)


@pytest.fixture(autouse=True)
def _fresh_cache():
    read_projection.clear_tsne_cache()
    yield
    read_projection.clear_tsne_cache()


# ── 1. Reproducible map ─────────────────────────────────────────────────────

def test_tsne_map_same_reads_same_seed_same_map_whatever_the_order():
    X, _ = planted()
    keys = [f"ds::r{i:03d}" for i in range(len(X))]
    a = read_projection.compute_tsne_map(X, random_state=7, keys=keys)
    read_projection.clear_tsne_cache()  # recompute, not a cache hit
    b = read_projection.compute_tsne_map(X, random_state=7, keys=keys)
    assert not b["cache_hit"]
    np.testing.assert_array_equal(a["coords"], b["coords"])

    perm = np.random.default_rng(1).permutation(len(X))
    read_projection.clear_tsne_cache()
    c = read_projection.compute_tsne_map(X[perm], random_state=7, keys=[keys[i] for i in perm])
    np.testing.assert_array_equal(c["coords"], a["coords"][perm])
    assert a["feature_digest"] == c["feature_digest"]

    # Under the cap the map is a function of the reads alone (deterministic
    # neighbours and initial layout); the seed picks the subsample above it.
    d = read_projection.compute_tsne_map(X, random_state=8, keys=keys)
    np.testing.assert_array_equal(d["coords"], a["coords"])
    e = read_projection.compute_tsne_map(X, random_state=7, keys=keys, max_reads=100)
    f = read_projection.compute_tsne_map(X, random_state=8, keys=keys, max_reads=100)
    assert not np.array_equal(e["embedded"], f["embedded"])
    assert a["random_state"] == 7 and a["perplexity"] == 30.0 and a["n_neighbors"] == 91


def test_tsne_map_is_cached_by_feature_digest():
    X, _ = planted()
    first = read_projection.compute_tsne_map(X, random_state=3)
    again = read_projection.compute_tsne_map(X.copy(), random_state=3)
    assert not first["cache_hit"] and again["cache_hit"]
    np.testing.assert_array_equal(first["coords"], again["coords"])
    other = read_projection.compute_tsne_map(X[:-1], random_state=3)
    assert not other["cache_hit"]


def test_tsne_cap_embeds_a_seeded_subsample_and_places_the_rest():
    X, truth = planted()
    out = read_projection.compute_tsne_map(X, random_state=5, max_reads=90)
    assert out["n_embedded"] == 90 and int(out["embedded"].sum()) == 90
    assert np.isfinite(out["coords"]).all()
    read_projection.clear_tsne_cache()
    again = read_projection.compute_tsne_map(X, random_state=5, max_reads=90)
    np.testing.assert_array_equal(out["coords"], again["coords"])
    np.testing.assert_array_equal(out["embedded"], again["embedded"])
    # A placed read lands among its own group: nearest embedded read shares its label.
    emb = np.flatnonzero(out["embedded"])
    placed = np.flatnonzero(~out["embedded"])
    hits = 0
    for i in placed:
        j = emb[np.argmin(((out["coords"][emb] - out["coords"][i]) ** 2).sum(axis=1))]
        hits += truth[j] == truth[i]
    assert hits / len(placed) > 0.9


def test_tsne_map_needs_four_reads():
    with pytest.raises(ValueError):
        read_projection.compute_tsne_map(np.zeros((3, 4), dtype=np.float32), random_state=1)


# ── 2. The neighbourhood graph is t-SNE's own ───────────────────────────────

def test_affinity_graph_is_scikit_learns_tsne_graph():
    """scikit-learn's neighbours (up to ties among equally distant reads) and
    its own affinity routine."""
    from sklearn.manifold import _t_sne
    from sklearn.neighbors import NearestNeighbors

    X, _ = planted()
    n = X.shape[0]
    perplexity = read_projection.tsne_perplexity(n)
    k = read_projection.tsne_n_neighbors(n, perplexity)
    ours = read_projection.knn_sqdist_graph(X, k)
    ref = NearestNeighbors(n_neighbors=k).fit(X).kneighbors_graph(mode="distance")
    ref.data **= 2
    for i in range(n):
        a = np.sort(ours.data[ours.indptr[i]:ours.indptr[i + 1]])
        b = np.sort(ref.data[ref.indptr[i]:ref.indptr[i + 1]])
        np.testing.assert_allclose(a, b, atol=1e-4)
    P = read_projection.tsne_affinity_graph(X)
    expected = _t_sne._joint_probabilities_nn(ours.copy(), perplexity, 0)
    assert abs(P - expected).max() < 1e-12
    assert P.shape == (n, n) and abs(P - P.T).max() < 1e-12 and abs(P.sum() - 1) < 1e-6


def test_numpy_perplexity_search_matches_scikit_learn():
    from sklearn.manifold import _utils
    from sklearn.neighbors import NearestNeighbors

    X, _ = planted()
    dist = NearestNeighbors(n_neighbors=40).fit(X).kneighbors_graph(mode="distance")
    dist.data **= 2
    dist.sort_indices()
    d = dist.data.reshape(X.shape[0], -1).astype(np.float32)
    ours = read_projection._binary_search_perplexity_numpy(d, 12.0)
    ref = _utils._binary_search_perplexity(d, 12.0, 0)
    np.testing.assert_allclose(ours, ref, atol=1e-5)


# ── 3. Graph clustering ─────────────────────────────────────────────────────

def test_graph_clustering_recovers_three_planted_groups():
    X, truth = planted()
    keys = [f"r{i:03d}" for i in range(len(X))]
    labels = read_projection.graph_cluster_labels(X, resolution=1.0, random_state=11, keys=keys)
    assert len(set(labels.tolist())) == 3
    assert ari(truth, labels) > 0.98
    # Numbered by size: the 60-read group is cluster 0.
    assert np.bincount(labels).tolist() == sorted(np.bincount(labels).tolist(), reverse=True)


def test_graph_clustering_is_deterministic_and_order_independent():
    X, _ = planted(seed=4)
    keys = [f"r{i:03d}" for i in range(len(X))]
    a = read_projection.graph_cluster_labels(X, random_state=2, keys=keys)
    b = read_projection.graph_cluster_labels(X, random_state=2, keys=keys)
    np.testing.assert_array_equal(a, b)
    perm = np.random.default_rng(9).permutation(len(X))
    c = read_projection.graph_cluster_labels(X[perm], random_state=2, keys=[keys[i] for i in perm])
    np.testing.assert_array_equal(c, a[perm])


def test_graph_resolution_controls_the_number_of_clusters():
    X, _ = planted(n_per=(150, 120, 100), d=60)
    counts = [len(set(read_projection.graph_cluster_labels(X, resolution=r, random_state=1).tolist()))
              for r in (0.3, 1.0, 3.0)]
    assert counts[0] <= counts[1] <= counts[2]
    assert counts[2] > counts[0]


def test_louvain_matches_a_reference_modularity_on_two_cliques():
    from scipy.sparse import csr_matrix

    A = np.zeros((10, 10))
    A[:5, :5] = 1
    A[5:, 5:] = 1
    A[4, 5] = A[5, 4] = 1
    np.fill_diagonal(A, 0)
    labels = read_projection.louvain_communities(csr_matrix(A), random_state=0)
    assert labels[:5].tolist() == [0] * 5 and labels[5:].tolist() == [1] * 5


def test_graph_is_a_cluster_method_with_a_resolution():
    assert "graph" in CLUSTER_METHODS and check_cluster_method("graph") == "graph"
    assert ClusterAllRequest(method="graph").resolution == 1.0
    with pytest.raises(Exception):
        ClusterAllRequest(method="graph", resolution=0)


def test_cluster_compact_reads_graph_method(monkeypatch):
    X, truth = planted()
    ids = [f"ds::r{i:03d}" for i in range(len(X))]
    from services import cluster_assignment

    monkeypatch.setattr(cluster_assignment, "extract_features_grouped",
                        lambda reads, *a, **k: (X, ids, [X.shape[1]], ["accessibility"]))
    assignments, counts, _order, info = cluster_compact_reads(
        [{"id": i} for i in ids], [[0, 400]], 0, 5, "graph", random_state=3, resolution=1.0)
    labels = np.array([assignments[i] for i in ids])
    assert info is None and len(counts) == 3 and ari(truth, labels) > 0.98


# ── 4. Ordering along the map ───────────────────────────────────────────────

def test_order_by_projection_keeps_map_neighbours_adjacent():
    # Two clusters, each a line of points, given in shuffled order.
    xs = np.linspace(0, 10, 11)
    pts = np.vstack([np.c_[xs, np.zeros(11)], np.c_[xs + 30, np.full(11, 5.0)]])
    labels = np.array([0] * 11 + [1] * 11)
    perm = np.random.default_rng(0).permutation(len(pts))
    keys = [f"r{i:02d}" for i in range(len(pts))]
    out = read_projection.order_by_projection(pts[perm], labels[perm], keys=[keys[i] for i in perm])
    ordered = pts[perm][out["order"]]
    steps = np.linalg.norm(np.diff(ordered, axis=0), axis=1)
    # Within a cluster every step is to the adjacent point on the line.
    assert np.sum(steps > 1.01) == 1
    assert sorted(out["order"]) == list(range(len(pts)))
    assert out["cluster_order"] in ([0, 1], [1, 0])
    again = read_projection.order_by_projection(pts[perm], labels[perm], keys=[keys[i] for i in perm])
    assert again == out
    # Input order doesn't matter.
    back = read_projection.order_by_projection(pts, labels, keys=keys)
    assert [keys[i] for i in back["order"]] == [keys[perm[i]] for i in out["order"]]


def test_order_by_projection_puts_unassigned_last():
    pts = np.array([[0, 0], [1, 0], [5, 5], [6, 5]], dtype=float)
    out = read_projection.order_by_projection(pts, [0, 0, -1, -1])
    assert out["cluster_order"][-1] == -1 and set(out["order"][-2:]) == {2, 3}


# ── 5. Endpoint: default method, parameters, export columns, sort ───────────

class PlantedState:
    dataset_order = ["ds1"]

    def __init__(self, n_per=(30, 25, 20)):
        X, truth = planted(n_per=n_per, d=30)
        self.truth = truth
        self.reads = []
        for i, row in enumerate(X):
            # Feature j covers bases j*10..j*10+10 of a 300 bp window: open there when 1.
            intervals = []
            for j, v in enumerate(row):
                intervals.append([j * 10, j * 10 + 10, 30 if v else 150])
            self.reads.append({
                "id": f"read{i:03d}",
                "intervals": intervals,
                "alignment_orientation": "reverse" if i % 2 else "forward",
                "deam": [[5, 1], [9, 1]] if i % 3 == 0 else [],
            })
        self.datasets = {"ds1": SimpleNamespace(
            cluster_assignments={r["id"]: int(t) for r, t in zip(self.reads, truth)},
            cluster_peak_regions=[{"start": 0, "end": 300, "mode": "accessibility"}],
            cluster_feature_settings={},
        )}
        self.max_working_reads = None

    def translate_chrom(self, chrom):
        return chrom

    def resolve_dataset_id(self, dataset_id=None):
        return "ds1" if dataset_id in (None, "", "primary") else dataset_id

    def get_dataset(self, dataset_id):
        return self.datasets.get(dataset_id)

    def build_working_set(self, dataset_id, chrom, start, end, spanning=False, min_footprints=0, **kwargs):
        self.methylation_calls = getattr(self, "methylation_calls", []) + [kwargs.get("include_methylation")]
        return WorkingSet(list(self.reads), total_overlapping=len(self.reads), total_spanning=len(self.reads),
                          chrom=chrom, start=start, end=end)


def _project(state, **kw):
    return clustering_endpoint.run_cluster_projection_endpoint(
        state=state, req=ProjectionRequest(dataset_ids=["ds1"], **kw),
        chrom="chr1", start=0, end=300, spanning=False)


def test_projection_defaults_to_tsne_and_records_its_parameters():
    assert ProjectionRequest().method == "tsne"
    state = PlantedState()
    out = _project(state, sample_seed="seed-a")
    assert out["method"] == "tsne"
    params = out["projection_params"]
    for key in ("random_state", "sample_seed", "perplexity", "n_neighbors", "feature_digest",
                "max_reads", "n_embedded", "fiberbrowser_version"):
        assert key in params, key
    assert params["random_state"] == out["projection_random_state"]
    assert params["sample_seed"] == "seed-a"
    n = out["n_reads"]
    assert n == len(state.reads)
    assert len(out["strands"]) == len(out["alignment_strands"]) == len(out["embedded"]) == n
    by_id = dict(zip(out["read_ids"], zip(out["strands"], out["alignment_strands"])))
    assert by_id["read000"] == ("CT", "+") and by_id["read001"] == ("", "-")
    # The same request again: the same map (served from the cache).
    again = _project(state, sample_seed="seed-a")
    assert again["coords_x"] == out["coords_x"] and again["projection_params"]["cache_hit"]
    other = _project(state, sample_seed="seed-b")
    assert other["projection_params"]["random_state"] != params["random_state"]


def test_projection_export_table_columns_and_header(tmp_path):
    import browser_client

    state = PlantedState()
    out = _project(state)
    df = browser_client.projection_table_from_response(out)
    assert list(df.columns) == ["read_name", "dataset", "strand", "alignment_strand", "cluster",
                                "tsne_x", "tsne_y", "embedded"]
    assert len(df) == out["n_reads"]
    assert df.attrs["projection"]["random_state"] == out["projection_random_state"]
    path = browser_client.write_projection_table(df, str(tmp_path / "proj.tsv"))
    text = open(path).read().splitlines()
    assert text[0] == "# fiberbrowser_export: read_projection"
    assert any(line.startswith("# perplexity: ") for line in text)
    assert any(line.startswith("# random_state: ") for line in text)
    back = browser_client.read_projection_table(path)
    assert list(back.columns) == list(df.columns) and len(back) == len(df)
    np.testing.assert_allclose(back["tsne_x"].to_numpy(), df["tsne_x"].to_numpy(), rtol=1e-6)


def test_sort_by_projection_orders_reads_along_the_map():
    from services.filtering_endpoint import sort_reads_for_request

    state = PlantedState()
    res = sort_reads_for_request(state, SortReadsRequest(dataset_ids=["ds1"], sort_by="projection"),
                                 chrom="chr1", start=0, end=300)
    order = res["results"]["ds1"]["read_sort_order"]
    assert sorted(order) == sorted(r["id"] for r in state.reads)
    assert sorted(res["results"]["ds1"]["cluster_order"]) == [0, 1, 2]
    assert res["projection_params"]["method"] == "tsne"
    # Clusters are contiguous in the order.
    assignments = state.datasets["ds1"].cluster_assignments
    runs = [assignments[r] for r in order]
    assert sum(1 for a, b in zip(runs, runs[1:]) if a != b) == 2
    # Consecutive reads are near each other on the map (vs a random order).
    proj = _project(state)
    xy = dict(zip(proj["read_ids"], zip(proj["coords_x"], proj["coords_y"])))
    pts = np.array([xy[r] for r in order])
    step = np.linalg.norm(np.diff(pts, axis=0), axis=1).mean()
    shuffled = pts[np.random.default_rng(0).permutation(len(pts))]
    assert step < 0.5 * np.linalg.norm(np.diff(shuffled, axis=0), axis=1).mean()
    # Deterministic.
    again = sort_reads_for_request(state, SortReadsRequest(dataset_ids=["ds1"], sort_by="projection"),
                                   chrom="chr1", start=0, end=300)
    assert again["results"] == res["results"]


def test_sort_by_projection_without_clusters_says_so():
    from services.filtering_endpoint import sort_reads_for_request

    state = PlantedState()
    state.datasets["ds1"].cluster_assignments = {}
    res = sort_reads_for_request(state, SortReadsRequest(dataset_ids=["ds1"], sort_by="projection"),
                                 chrom="chr1", start=0, end=300)
    assert res["results"]["ds1"]["read_sort_order"] == [] and "cluster" in res["error"]


def test_projection_preview_of_graph_clusters_matches_the_cluster_run():
    """Clustering with method=graph on the projected reads gives the planted groups on the map."""
    state = PlantedState()
    out = _project(state)
    from services.clustering_features import extract_features_from_compact
    from services.clustering_inputs import prefix_compact_read

    feats, ids, _, _ = extract_features_from_compact(
        [prefix_compact_read(r, "ds1") for r in state.reads], [(0, 300)], 0, step=10,
        subnucleosomal_threshold=90, peak_modes=["accessibility"])
    labels = read_projection.graph_cluster_labels(feats, keys=ids, random_state=1)
    assert ari(state.truth, labels) > 0.95
    assert out["n_reads"] == len(ids)


# ── 6. Python client ────────────────────────────────────────────────────────

def test_client_projection_table_and_sort_requests(tmp_path):
    import browser_client

    state = PlantedState()
    response = _project(state)

    class Recorder(browser_client.BrowserClient):
        def __init__(self):
            self.url = "http://test"
            self.calls = []

        def _post(self, endpoint, data=None, params=None):
            self.calls.append((endpoint, data, params))
            return response if endpoint == "/api/cluster_projection" else {"results": {}}

    client = Recorder()
    path = tmp_path / "map.tsv"
    df = client.get_projection_table(chrom="chr1", start=0, end=300, dataset_ids=["ds1"],
                                     sample_seed="s1", max_reads=3000, path=str(path))
    endpoint, body, params = client.calls[-1]
    assert endpoint == "/api/cluster_projection"
    assert body["method"] == "tsne" and body["max_reads"] == 3000 and body["sample_seed"] == "s1"
    assert body["include_strands"] is True
    assert body["peak_regions"] == []  # the peaks each dataset was clustered on
    assert params == {"chrom": "chr1", "start": 0, "end": 300, "spanning": "false"}
    assert list(df.columns)[:5] == ["read_name", "dataset", "strand", "alignment_strand", "cluster"]
    assert df.attrs["projection"]["feature_digest"] == response["projection_params"]["feature_digest"]
    assert path.read_text().startswith("# fiberbrowser_export: read_projection\n")
    # The default projection method is t-SNE.
    client.get_cluster_projection(peak_regions=[], chrom="chr1", start=0, end=300)
    assert client.calls[-1][1]["method"] == "tsne"

    client.sort_by_projection(chrom="chr1", start=0, end=300, dataset_ids=["ds1"],
                              peak_regions=[{"start": 0, "end": 300, "mode": "nuc"}])
    endpoint, body, _ = client.calls[-1]
    assert endpoint == "/api/sort_reads" and body["sort_by"] == "projection"
    assert body["projection"] == {"peak_regions": [{"start": 0, "end": 300, "mode": "nuc"}],
                                  "subnucleosomal_threshold": 90}


def test_client_and_browser_exports_share_columns():
    """browser_client and the frontend (utils/projectionExport.ts) write the same columns."""
    import re
    from pathlib import Path

    import browser_client

    ts = (Path(__file__).resolve().parents[1] / "browser" / "frontend" / "src" / "utils" / "projectionExport.ts").read_text()
    block = re.search(r"PROJECTION_TABLE_COLUMNS = \[(.*?)\]", ts, re.S).group(1)
    ts_columns = tuple(re.findall(r"'([^']+)'", block))
    assert ts_columns == browser_client.PROJECTION_TABLE_COLUMNS


# ── 7. Review fixes (Codex, 1 Oct) ──────────────────────────────────────────

def test_identical_reads_fall_back_instead_of_crashing():
    # scikit-learn's PCA initialisation divides by zero here and segfaults.
    X = np.zeros((75, 30), dtype=np.float32)
    with pytest.raises(ValueError, match="same features"):
        read_projection.compute_tsne_map(X, random_state=1)
    state = PlantedState()
    for read in state.reads:
        read["intervals"] = [[0, 300, 150]]
    out = _project(state)
    assert out["method"] == "pca" and "same features" in out["projection_params"]["fallback_reason"]


def test_small_caps_still_give_a_tsne_map():
    X, _ = planted()
    out = read_projection.compute_tsne_map(X, random_state=1, max_reads=4)
    assert out["n_embedded"] == 4 and out["perplexity"] < 4 and np.isfinite(out["coords"]).all()


def test_map_is_computed_on_one_thread(monkeypatch):
    """Barnes-Hut sums across OpenMP threads in finishing order: on 2, 4 or 8
    threads the same reads and seed gave maps up to ~20 units apart (3,000
    reads), even between runs. The map is computed on one thread."""
    from threadpoolctl import threadpool_info, threadpool_limits

    seen = []
    original = read_projection._run_tsne

    def spy(*args, **kwargs):
        seen.append({info["user_api"]: info["num_threads"] for info in threadpool_info()})
        return original(*args, **kwargs)

    monkeypatch.setattr(read_projection, "_run_tsne", spy)
    X, _ = planted()
    with threadpool_limits(limits=8):
        out = read_projection.compute_tsne_map(X, random_state=3)
    assert out["threads"] == 1
    # OpenMP (the Barnes-Hut sums) on one thread; BLAS isn't used for the map.
    assert seen and seen[0].get("openmp") == 1


def test_three_component_projection_is_a_real_embedding():
    from services import cluster_analysis

    X, _ = planted()
    coords, _, method = cluster_analysis.compute_cluster_projection(X, method="tsne", n_components=3)
    assert method == "tsne" and coords.shape == (len(X), 3) and np.ptp(coords[:, 2]) > 0


def test_scoped_sort_orders_the_subset_along_the_full_map():
    from services.filtering_endpoint import sort_reads_for_request
    from models.requests import ProjectionSortSettings

    state = PlantedState()
    full = dict(state.datasets["ds1"].cluster_assignments)
    scoped = {r: c for r, c in full.items() if c == 0}
    res = sort_reads_for_request(state, SortReadsRequest(
        dataset_ids=["ds1"], sort_by="projection", cluster_assignments={"ds1": scoped},
        projection=ProjectionSortSettings(cluster_assignments={"ds1": full})), chrom="chr1", start=0, end=300)
    whole = sort_reads_for_request(state, SortReadsRequest(dataset_ids=["ds1"], sort_by="projection"),
                                   chrom="chr1", start=0, end=300)
    assert res["projection_params"]["feature_digest"] == whole["projection_params"]["feature_digest"]
    assert res["results"]["ds1"]["read_sort_order"] == [
        r for r in whole["results"]["ds1"]["read_sort_order"] if r in scoped]
    assert res["results"]["ds1"]["cluster_order"] == [0]


def test_unlinked_datasets_are_ordered_by_their_own_clusters():
    from services.filtering_endpoint import sort_reads_for_request

    state = PlantedState()
    other = PlantedState(n_per=(20, 25, 30))
    state.dataset_order = ["ds1", "ds2"]
    # ds2: its own reads and its own (independently numbered) clusters.
    state.datasets["ds2"] = SimpleNamespace(
        cluster_assignments={f"b{r['id']}": int(2 - t) for r, t in zip(other.reads, other.truth)},
        cluster_peak_regions=[{"start": 0, "end": 300, "mode": "accessibility"}],
        cluster_feature_settings={},
    )
    base_build = state.build_working_set

    def build(dataset_id, *a, **k):
        if dataset_id == "ds2":
            return WorkingSet([{**r, "id": f"b{r['id']}"} for r in other.reads], total_overlapping=75,
                              total_spanning=75, chrom="chr1", start=0, end=300)
        return base_build(dataset_id, *a, **k)

    state.build_working_set = build
    res = sort_reads_for_request(state, SortReadsRequest(dataset_ids=["ds1", "ds2"], sort_by="projection", linked=False),
                                 chrom="chr1", start=0, end=300)
    proj = clustering_endpoint.run_cluster_projection_endpoint(
        state=state, req=ProjectionRequest(dataset_ids=["ds1", "ds2"]), chrom="chr1", start=0, end=300, spanning=False)
    for ds in ("ds1", "ds2"):
        rows = [i for i, d in enumerate(proj["dataset_ids"]) if d == ds]
        own = read_projection.order_by_projection(
            np.c_[proj["coords_x"], proj["coords_y"]][rows], np.asarray(proj["labels_before"])[rows],
            keys=[f"{ds}::{proj['read_ids'][i]}" for i in rows])
        assert res["results"][ds]["cluster_order"] == own["cluster_order"]
        assert res["results"][ds]["read_sort_order"] == [proj["read_ids"][rows[i]] for i in own["order"]]


def test_deamination_marks_load_only_when_strands_are_asked_for():
    state = PlantedState()
    state.datasets["ds1"].available_layers = {"deam": True}
    _project(state)
    assert state.methylation_calls[-1] is False
    _project(state, include_strands=True)
    assert state.methylation_calls[-1] is True


def test_read_id_scoped_sort_still_uses_the_whole_map():
    from services.filtering_endpoint import sort_reads_for_request

    state = PlantedState()
    ids = sorted(state.datasets["ds1"].cluster_assignments)[:30]
    res = sort_reads_for_request(state, SortReadsRequest(
        dataset_ids=["ds1"], sort_by="projection", read_ids={"ds1": ids}), chrom="chr1", start=0, end=300)
    whole = sort_reads_for_request(state, SortReadsRequest(dataset_ids=["ds1"], sort_by="projection"),
                                   chrom="chr1", start=0, end=300)
    assert res["projection_params"]["feature_digest"] == whole["projection_params"]["feature_digest"]
    assert res["results"]["ds1"]["read_sort_order"] == [r for r in whole["results"]["ds1"]["read_sort_order"] if r in set(ids)]


def test_maps_do_not_depend_on_thread_settings_in_a_fresh_process(tmp_path):
    """A fresh process (thread pools first loaded during the map) with many
    OpenMP and BLAS threads gives the same map as one with one thread each."""
    import os
    import subprocess
    import sys
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    script = (
        "import hashlib, numpy as np\n"
        "from test_read_projection import planted\n"
        "from services import read_projection as rp\n"
        "X, _ = planted(n_per=(300, 250, 200), d=40)\n"
        "a = rp.compute_tsne_map(X, random_state=3)['coords']\n"
        "e = rp.compute_tsne_embedding(X[:200], n_components=3, random_state=3)\n"
        "print(hashlib.md5(a.tobytes() + e.tobytes()).hexdigest())\n"
    )
    digests = []
    for threads in ("1", "8"):
        env = {**os.environ, "OMP_NUM_THREADS": threads, "OPENBLAS_NUM_THREADS": threads,
               "PYTHONPATH": os.pathsep.join([str(root / "browser"), str(root / "tests")])}
        out = subprocess.run([sys.executable, "-c", script], env=env, capture_output=True, text=True, timeout=600)
        assert out.returncode == 0, out.stderr[-2000:]
        digests.append(out.stdout.strip().splitlines()[-1])
    assert digests[0] == digests[1]
