import numpy as np

from services.microc_arcs import (
    build_interaction_arcs,
    merge_interaction_arcs,
    score_interaction_arcs,
)


def test_build_interaction_arcs_adds_positions_counts_and_oe_ratios():
    matrix = np.array(
        [
            [0, 4, 0],
            [4, 0, 6],
            [0, 6, 0],
        ],
        dtype=float,
    )

    arcs = build_interaction_arcs(
        matrix,
        start=100,
        resolution=10,
        min_dist_bins=1,
        max_dist_bins=2,
        expected_per_dist=np.array([1.0, 2.0, 3.0]),
    )

    assert arcs == [
        {"start": 105, "end": 115, "count": 4, "oe_ratio": 2.0, "oe_ratio_raw": 2.0, "distance": 10},
        {"start": 115, "end": 125, "count": 6, "oe_ratio": 3.0, "oe_ratio_raw": 3.0, "distance": 10},
    ]


def test_build_interaction_arcs_keeps_viewer_order_across_distances():
    matrix = np.array(
        [
            [0, 2, 3, 0],
            [2, 0, 0, 4],
            [3, 0, 0, 5],
            [0, 4, 5, 0],
        ],
        dtype=float,
    )

    arcs = build_interaction_arcs(
        matrix,
        start=0,
        resolution=10,
        min_dist_bins=1,
        max_dist_bins=2,
    )

    assert [(arc["start"], arc["end"], arc["count"]) for arc in arcs] == [
        (5, 15, 2),
        (5, 25, 3),
        (15, 35, 4),
        (25, 35, 5),
    ]


def test_build_interaction_arcs_applies_one_sided_accessibility_correction():
    matrix = np.array([[0, 8], [8, 0]], dtype=float)

    arcs = build_interaction_arcs(
        matrix,
        start=0,
        resolution=100,
        min_dist_bins=1,
        max_dist_bins=1,
        expected_per_dist=np.array([1.0, 2.0]),
        bin_accessibility=np.array([1.0, 0.5]),
        mean_accessibility=0.5,
    )

    assert arcs[0]["oe_ratio_raw"] == 4.0
    assert arcs[0]["oe_ratio"] == 2.0


def test_merge_interaction_arcs_clusters_nearby_endpoints():
    arcs = [
        {"start": 100, "end": 300, "count": 2, "oe_ratio": 4.0},
        {"start": 110, "end": 310, "count": 6, "oe_ratio": 2.0},
        {"start": 500, "end": 700, "count": 1, "oe_ratio": None},
    ]

    merged = merge_interaction_arcs(arcs, merge_bin=20)

    assert len(merged) == 2
    assert merged[0]["start"] == 107
    assert merged[0]["end"] == 307
    assert merged[0]["count"] == 8
    assert merged[0]["oe_ratio"] == 2.5
    assert merged[0]["start_range"] == (100, 110)
    assert merged[0]["end_range"] == (300, 310)


def test_score_interaction_arcs_supports_raw_and_stable_oe_modes():
    raw_arcs = [
        {"count": 2, "oe_ratio": None},
        {"count": 5, "oe_ratio": None},
    ]
    oe_arcs = [
        {"count": 2, "oe_ratio": 1.2},
        {"count": 5, "oe_ratio": 3.0},
        {"count": 1, "oe_ratio": 0.5},
    ]

    scored_raw = score_interaction_arcs(
        raw_arcs,
        normalization="none",
        oe_floor=0,
        min_count=0,
        stable_strength=False,
        threshold=0.0,
        max_arcs=10,
    )
    scored_oe = score_interaction_arcs(
        oe_arcs,
        normalization="oe",
        oe_floor=1.0,
        min_count=0,
        stable_strength=True,
        threshold=2.0,
        max_arcs=10,
    )

    assert [arc["count"] for arc in scored_raw] == [5, 2]
    assert [arc["strength"] for arc in scored_raw] == [1.0, 0.4]
    assert [arc["count"] for arc in scored_oe] == [5]
    assert scored_oe[0]["strength"] == 3.0
