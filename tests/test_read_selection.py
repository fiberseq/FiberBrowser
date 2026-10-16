from services.read_selection import (
    base_read_id,
    filter_reads_by_cluster_focus,
    filter_reads_by_id_set,
    filter_reads_by_min_footprints,
    is_read_spanning,
    read_matches_id_filter,
)


READS = [
    {"id": "readA_1", "intervals": [(0, 80, 30), (80, 100, 20), (100, 180, -80)]},
    {"id": "readB", "intervals": [(-5, 60, 25), (60, 205, 40)]},
    {"id": "readC", "intervals": [(20, 150, 50)]},
]


def test_base_read_id_matches_split_read_suffixes_only():
    assert base_read_id("readA_1") == "readA"
    assert base_read_id("readA_part") == "readA_part"
    assert read_matches_id_filter("readA_1", {"readA"})
    assert read_matches_id_filter("readA_1", {"readA_1"})
    assert not read_matches_id_filter("readA_1", {"readB"})


def test_filter_reads_by_id_set_accepts_exact_and_base_ids():
    filtered = filter_reads_by_id_set(READS, {"readA", "readB"})
    assert [r["id"] for r in filtered] == ["readA_1", "readB"]


def test_spanning_and_min_footprint_filters_use_active_scope():
    assert not is_read_spanning(READS[0], 200)
    assert is_read_spanning(READS[1], 200)

    filtered = filter_reads_by_min_footprints(
        READS,
        2,
        has_footprint_layer=True,
    )
    assert [r["id"] for r in filtered] == ["readA_1", "readB"]

    assert filter_reads_by_min_footprints(
        READS,
        2,
        has_footprint_layer=False,
    ) == READS


def test_filter_reads_by_cluster_focus_preserves_matching_assignments():
    filtered = filter_reads_by_cluster_focus(
        READS,
        {"readA_1": 2, "readB": 1, "readC": 2},
        {2},
    )
    assert [r["id"] for r in filtered] == ["readA_1", "readC"]
