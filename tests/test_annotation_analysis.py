from services.annotation_analysis import (
    build_annotation_feature_matrix,
    cluster_reads_by_annotation_patterns,
    filter_reads_by_annotation_types,
    merge_annotation_dicts,
)


ANNOTATIONS_A = {
    "read1": [(100, 140, "tf", 0.9), (160, 190, "nuc", 1.0)],
    "read2": [(110, 130, "tf", 0.8)],
}

ANNOTATIONS_B = {
    "read2": [(170, 195, "nuc", 0.7)],
    "read3": [(300, 340, "tf", 0.6)],
}


def test_filter_reads_by_annotation_types_preserves_current_modes():
    assert filter_reads_by_annotation_types([ANNOTATIONS_A, ANNOTATIONS_B], ["tf"]) == {
        "read_ids": ["read1", "read2", "read3"],
        "total": 3,
        "filtered": 3,
    }
    assert filter_reads_by_annotation_types(
        [ANNOTATIONS_A, ANNOTATIONS_B],
        ["tf", "nuc"],
        "has_all",
    ) == {
        "read_ids": ["read1", "read2"],
        "total": 3,
        "filtered": 2,
    }
    assert filter_reads_by_annotation_types(
        [ANNOTATIONS_A, ANNOTATIONS_B],
        ["nuc"],
        "lacks_all",
    ) == {
        "read_ids": ["read3"],
        "total": 3,
        "filtered": 1,
    }


def test_filter_reads_by_annotation_types_can_use_working_set_universe():
    result = filter_reads_by_annotation_types(
        [ANNOTATIONS_A, ANNOTATIONS_B],
        ["nuc"],
        "lacks_all",
        universe_read_ids=["read1", "read2", "read4"],
    )

    assert result == {
        "read_ids": ["read4"],
        "total": 3,
        "filtered": 1,
    }


def test_build_annotation_feature_matrix_matches_peak_type_overlap_order():
    merged = merge_annotation_dicts([ANNOTATIONS_A, ANNOTATIONS_B])
    matrix, read_names = build_annotation_feature_matrix(
        merged,
        peak_regions=[{"start": 90, "end": 150}, {"start": 150, "end": 210}],
        annotation_types=["tf", "nuc"],
    )

    assert read_names == ["read1", "read2", "read3"]
    assert matrix.tolist() == [
        [1, 0, 0, 1],
        [1, 0, 0, 1],
        [0, 0, 0, 0],
    ]


def test_cluster_reads_by_annotation_patterns_combinatorial_matches_router_behavior():
    result = cluster_reads_by_annotation_patterns(
        [ANNOTATIONS_A, ANNOTATIONS_B],
        peak_regions=[{"start": 90, "end": 150}, {"start": 150, "end": 210}],
        annotation_types=["tf", "nuc"],
        method="combinatorial",
    )

    assert result["assignments"] == {"read1": 0, "read2": 0, "read3": 1}
    assert result["order"] == [0, 1]
    assert result["patterns"] == {0: [1, 0, 0, 1], 1: [0, 0, 0, 0]}


def test_cluster_reads_by_annotation_patterns_handles_empty_and_single_kmeans():
    assert cluster_reads_by_annotation_patterns([], [], []) == {
        "assignments": {},
        "order": [],
        "patterns": {},
    }

    result = cluster_reads_by_annotation_patterns(
        [{"only": [(100, 150, "tf", 1.0)]}],
        peak_regions=[{"start": 90, "end": 160}],
        annotation_types=["tf"],
        method="kmeans",
        k=5,
    )

    assert result == {"assignments": {"only": 0}, "order": [0], "patterns": {}}
