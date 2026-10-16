from services.dynamic_clustering import (
    UNASSIGNED_CLUSTER_ID,
    assign_reads_to_centroids,
    assign_reads_to_cluster_patterns,
    build_pattern_to_cluster,
    compute_cluster_centroids_from_compact,
    match_pattern_to_cluster,
    read_accessibility_pattern,
    read_accessibility_pattern_by_overlap,
    read_peak_overlap_weights,
)


def _read(rid, intervals):
    return {"id": rid, "intervals": intervals}


def test_build_pattern_to_cluster_normalizes_json_string_keys():
    assert build_pattern_to_cluster({"2": [1, 0], "5": [0, 1]}) == {
        (1, 0): 2,
        (0, 1): 5,
    }


def test_read_accessibility_pattern_uses_spanning_and_nucleosomal_overlap():
    read = {
        "id": "r1",
        "intervals": [
            [0, 20, 90],
            [40, 70, 20],
            [80, 100, 100],
        ],
    }

    pattern = read_accessibility_pattern(
        read,
        [[0, 20], [40, 70], [90, 110], [200, 210]],
        subnucleosomal_threshold=90,
        accessibility_threshold=0.5,
    )

    assert pattern == (0, 1, 0, 0)


def test_match_pattern_to_cluster_uses_exact_then_hamming_nearest():
    lookup = {(1, 0, 0): 3, (0, 1, 1): 7}

    assert match_pattern_to_cluster((1, 0, 0), lookup) == 3
    assert match_pattern_to_cluster((0, 0, 1), lookup) == 7


def test_match_pattern_to_cluster_ignores_non_overlapped_peaks():
    lookup = {(1, 0, 0): 3, (0, 0, 0): 7}

    assert match_pattern_to_cluster((1, 0, 0), lookup, (25, 0, 0)) == 3
    assert match_pattern_to_cluster((0, 0, 0), lookup, (25, 0, 0)) == 7


def test_accessibility_pattern_by_overlap_scores_partial_peak_overlap():
    read = {
        "id": "r1",
        "intervals": [
            [0, 20, 90],
            [40, 70, 20],
            [80, 100, 100],
        ],
    }

    pattern, weights = read_accessibility_pattern_by_overlap(
        read,
        [[0, 20], [40, 70], [90, 110], [200, 210]],
        subnucleosomal_threshold=90,
        accessibility_threshold=0.5,
    )

    assert pattern == (0, 1, 0, 0)
    assert weights == (20, 30, 10, 0)
    assert read_peak_overlap_weights(read, [[0, 20], [90, 110], [200, 210]]) == (20, 10, 0)


def test_assign_reads_to_cluster_patterns_returns_assignments_counts_and_order():
    reads = [
        {"id": "accessible", "intervals": [[0, 100, 20]]},
        {"id": "covered_nuc", "intervals": [[0, 100, 100]]},
        {"id": "no_intervals", "intervals": []},
    ]

    result = assign_reads_to_cluster_patterns(
        reads,
        [[10, 30]],
        {"1": [1], "2": [0]},
        subnucleosomal_threshold=90,
        accessibility_threshold=0.5,
    )

    assert result == {
        "assignments": {
            "accessible": 1,
            "covered_nuc": 2,
            "no_intervals": UNASSIGNED_CLUSTER_ID,
        },
        "cluster_counts": {1: 1, 2: 1, UNASSIGNED_CLUSTER_ID: 1},
        "filtered_read_ids": ["accessible", "covered_nuc", "no_intervals"],
    }


def test_assign_reads_to_cluster_patterns_matches_on_overlapped_peak_subset():
    reads = [
        {"id": "left_only_accessible", "intervals": [[0, 50, 20]]},
        {"id": "left_only_nuc", "intervals": [[0, 50, 100]]},
        {"id": "no_overlap", "intervals": [[250, 300, 20]]},
    ]

    result = assign_reads_to_cluster_patterns(
        reads,
        [[0, 50], [150, 200]],
        {"1": [1, 0], "2": [0, 1], "9": [0, 0]},
        subnucleosomal_threshold=90,
        accessibility_threshold=0.5,
    )

    assert result["assignments"] == {
        "left_only_accessible": 1,
        "left_only_nuc": 9,
        "no_overlap": UNASSIGNED_CLUSTER_ID,
    }
    assert result["cluster_counts"] == {1: 1, 9: 1, UNASSIGNED_CLUSTER_ID: 1}


def test_compute_and_assign_centroids_kmeans_style():
    peaks = [[0, 30]]
    train = [
        _read("a1", [[0, 30, 20]]),   # accessible footprint over the peak
        _read("a2", [[0, 30, 20]]),
        _read("n1", [[0, 30, 100]]),  # nucleosome over the peak
        _read("n2", [[0, 30, 100]]),
    ]
    assignments = {"a1": 0, "a2": 0, "n1": 1, "n2": 1}

    centroids, widths = compute_cluster_centroids_from_compact(
        train, peaks, 0, assignments, subnucleosomal_threshold=90,
    )
    assert set(centroids) == {0, 1}
    assert widths == [3]  # range(0, 30, 10)
    assert centroids[0] != centroids[1]

    new_reads = [
        _read("acc", [[0, 30, 20]]),
        _read("nuc", [[0, 30, 100]]),
        _read("away", [[200, 230, 20]]),
    ]
    result = assign_reads_to_centroids(
        new_reads, peaks, centroids, widths,
        region_start=0, subnucleosomal_threshold=90, overlap_mode="conservative",
    )
    assert result["assignments"]["acc"] == 0
    assert result["assignments"]["nuc"] == 1
    assert result["assignments"]["away"] == UNASSIGNED_CLUSTER_ID


def test_centroid_overlap_mode_conservative_vs_aggressive():
    peaks = [[0, 30], [100, 130]]
    train = [
        _read("a", [[0, 30, 20], [100, 130, 20]]),    # accessible over both peaks
        _read("b", [[0, 30, 20], [100, 130, 20]]),
        _read("c", [[0, 30, 100], [100, 130, 100]]),  # nucleosome over both peaks
        _read("d", [[0, 30, 100], [100, 130, 100]]),
    ]
    centroids, widths = compute_cluster_centroids_from_compact(
        train, peaks, 0, {"a": 0, "b": 0, "c": 1, "d": 1}, subnucleosomal_threshold=90,
    )

    partial = [_read("p", [[0, 30, 20]])]  # overlaps peak 0 only, accessible

    conservative = assign_reads_to_centroids(
        partial, peaks, centroids, widths,
        region_start=0, subnucleosomal_threshold=90, overlap_mode="conservative",
    )
    assert conservative["assignments"]["p"] == UNASSIGNED_CLUSTER_ID

    aggressive = assign_reads_to_centroids(
        partial, peaks, centroids, widths,
        region_start=0, subnucleosomal_threshold=90, overlap_mode="aggressive",
    )
    assert aggressive["assignments"]["p"] == 0


def test_reassigning_unchanged_reads_keeps_their_combinatorial_clusters():
    from services.cluster_assignment import cluster_compact_reads
    peaks = [[0, 100]]
    reads = [
        # 51% accessible by base, 5 of 10 10-bp samples: the initial clustering calls it closed.
        _read("edge", [[0, 1, 100], [1, 52, -51], [52, 100, 100]]),
        _read("open", [[0, 100, -100]]),
        _read("closed", [[0, 100, 147]]),
        # FIRE calls decide accessibility when present, in both passes.
        {"id": "fire", "intervals": [[0, 100, 147]], "layers": {"msp": {"intervals": [[0, 100, 200]]}}},
    ]
    assignments, _, _, info = cluster_compact_reads(reads, peaks, 0, n_clusters=4, method="combinatorial")
    again = assign_reads_to_cluster_patterns(
        reads, peaks, info["cluster_patterns"], subnucleosomal_threshold=90, accessibility_threshold=0.5)
    assert again["assignments"] == assignments
    assert assignments["edge"] == assignments["closed"] and assignments["fire"] == assignments["open"]


def test_a_partially_covering_read_is_judged_on_the_samples_it_covers():
    # Accessible over the first 40 bp of a 100-bp peak, not covering the rest.
    result = assign_reads_to_cluster_patterns(
        [_read("part", [[0, 40, -40]])], [[0, 100]], {"1": [1], "2": [0]},
        subnucleosomal_threshold=90, accessibility_threshold=0.5)
    assert result["assignments"]["part"] == 1
