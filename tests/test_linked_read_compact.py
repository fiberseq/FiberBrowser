from __future__ import annotations

from services.linked_read_compact import (
    compact_intervals_from_entry,
    linked_reads_compact_response,
    paired_ligated_reads,
)


def test_compact_intervals_from_entry_preserves_internal_gaps():
    entry = {
        "name": "read_a",
        "start": 100,
        "end": 200,
        "blockSizes": "20,10,",
        "blockStarts": "10,60,",
    }

    assert compact_intervals_from_entry(entry, 100, 200) == [
        [10, 30, 20],
        [30, 60, -30],
        [60, 70, 10],
    ]


def test_compact_intervals_from_entry_filters_terminal_gap_outliers():
    entry = {
        "name": "read_a",
        "start": 100,
        "end": 200,
        "blockSizes": "20,",
        "blockStarts": "10,",
    }

    assert compact_intervals_from_entry(entry, 100, 200, terminal_gap_threshold=5) is None


def test_paired_ligated_reads_requires_segments_in_both_regions():
    valid, skipped = paired_ligated_reads([
        {"read_id": "r1", "x_segments": [{"start": 1}], "y_segments": [{"start": 2}]},
        {"read_id": "r2", "x_segments": [{"start": 1}], "y_segments": []},
        {"read_id": "r3", "x_segments": [], "y_segments": [{"start": 2}]},
    ])

    assert [r["read_id"] for r in valid] == ["r1"]
    assert skipped == 2


def test_linked_compact_sampling_is_identical_for_x_and_y():
    session = {
        "regions": {"chrom": "chr2L", "x_start": 100, "x_end": 200, "y_start": 500, "y_end": 600},
        "reads": [
            {
                "read_id": f"r{i}",
                "x_segments": [{"start": 110 + i, "end": 120 + i, "blockSizes": "", "blockStarts": ""}],
                "y_segments": [{"start": 510 + i, "end": 520 + i, "blockSizes": "", "blockStarts": ""}],
            }
            for i in range(8)
        ],
        "contact_mode": "dafc",
    }
    query = lambda *args, **kwargs: []

    x_result = linked_reads_compact_response("session1", session, "x", 3, "x", "paper-seed", query)
    y_result = linked_reads_compact_response("session1", session, "y", 3, "x", "paper-seed", query)

    assert x_result["count"] == y_result["count"] == 3
    assert x_result["paired_count"] == y_result["paired_count"] == 8
    assert [r["id"] for r in x_result["reads"]] == [r["id"] for r in y_result["reads"]]
    assert [r["order_index"] for r in x_result["reads"]] == [0, 1, 2]
    assert [r["order_index"] for r in y_result["reads"]] == [0, 1, 2]
    assert x_result["sample_seed"] == y_result["sample_seed"] == "paper-seed"


def test_linked_compact_zero_max_reads_means_uncapped():
    session = {
        "regions": {"chrom": "chr2L", "x_start": 100, "x_end": 200, "y_start": 500, "y_end": 600},
        "reads": [
            {
                "read_id": f"r{i}",
                "x_segments": [{"start": 110 + i, "end": 120 + i, "blockSizes": "", "blockStarts": ""}],
                "y_segments": [{"start": 510 + i, "end": 520 + i, "blockSizes": "", "blockStarts": ""}],
            }
            for i in range(5)
        ],
        "contact_mode": "dafc",
    }
    query = lambda *args, **kwargs: []

    result = linked_reads_compact_response("session1", session, "x", 0, "x", "seed", query)

    assert result["count"] == 5
    assert result["paired_count"] == 5


def test_linked_compact_empty_responses_keep_split_metadata():
    query = lambda *args, **kwargs: []
    no_regions = linked_reads_compact_response(
        "session1",
        {"reads": [], "contact_mode": "microc", "split_view_mode": "coordinate_synced"},
        "x",
        10,
        "x",
        "seed",
        query,
    )
    no_reads = linked_reads_compact_response(
        "session1",
        {
            "regions": {"chrom": "chr2L", "x_start": 100, "x_end": 200, "y_start": 500, "y_end": 600},
            "reads": [],
            "contact_mode": "dafc",
        },
        "x",
        10,
        "x",
        "seed",
        query,
    )

    assert no_regions["split_view_mode"] == "coordinate_synced"
    assert no_regions["split_view_semantics"]["read_source"] == "per_region_query"
    assert no_regions["sample_seed"] == "seed"
    assert no_reads["split_view_mode"] == "molecule_linked"
    assert no_reads["split_view_semantics"]["row_coupling"] == "molecule"


def test_linked_compact_filters_terminal_gap_pairs_from_both_regions():
    session = {
        "regions": {"chrom": "chr2L", "x_start": 100, "x_end": 250, "y_start": 500, "y_end": 650},
        "reads": [
            {
                "read_id": "keep",
                "x_segments": [{"start": 100, "end": 120, "blockSizes": "20,", "blockStarts": "0,"}],
                "y_segments": [{"start": 500, "end": 520, "blockSizes": "20,", "blockStarts": "0,"}],
            },
            {
                "read_id": "drop",
                "x_segments": [{"start": 100, "end": 200, "blockSizes": "20,", "blockStarts": "20,"}],
                "y_segments": [{"start": 500, "end": 550, "blockSizes": "20,", "blockStarts": "0,"}],
            },
        ],
        "contact_mode": "dafc",
    }
    query = lambda *args, **kwargs: []

    x_result = linked_reads_compact_response(
        "session1", session, "x", 10, "x", "seed", query, terminal_gap_threshold=5
    )
    y_result = linked_reads_compact_response(
        "session1", session, "y", 10, "x", "seed", query, terminal_gap_threshold=5
    )

    assert [r["id"] for r in x_result["reads"]] == ["keep"]
    assert [r["id"] for r in y_result["reads"]] == ["keep"]
    assert x_result["paired_count"] == y_result["paired_count"] == 1
    assert x_result["total"] == y_result["total"] == 2


def test_microc_compact_queries_independent_region_reads():
    session = {
        "regions": {"chrom": "chr2L", "x_start": 100, "x_end": 200, "y_start": 500, "y_end": 600},
        "reads": [],
        "contact_mode": "microc",
    }
    entries = [
        {
            "name": "read_a",
            "start": 100,
            "end": 200,
            "blockSizes": "20,",
            "blockStarts": "10,",
        }
    ]

    def query(chrom, start, end, **kwargs):
        assert (chrom, start, end) == ("chr2L", 100, 200)
        return entries

    result = linked_reads_compact_response("session1", session, "x", 10, "x", "seed", query)

    assert result["contact_mode"] == "microc"
    assert result["split_view_mode"] == "region_independent"
    assert result["count"] == 1
    assert result["total"] == 1
    assert result["reads"][0]["id"] == "read_a"


def test_microc_compact_sampling_is_reproducible_and_uncapped_with_zero():
    session = {
        "regions": {"chrom": "chr2L", "x_start": 100, "x_end": 200, "y_start": 500, "y_end": 600},
        "reads": [],
        "contact_mode": "microc",
    }
    entries = [
        {
            "name": f"read_{i}",
            "start": 100 + i,
            "end": 150 + i,
            "blockSizes": "20,",
            "blockStarts": "0,",
        }
        for i in range(12)
    ]
    query = lambda *args, **kwargs: entries

    first = linked_reads_compact_response("session1", session, "x", 4, "x", "paper-seed", query)
    second = linked_reads_compact_response("session1", session, "x", 4, "x", "paper-seed", query)
    uncapped = linked_reads_compact_response("session1", session, "x", 0, "x", "paper-seed", query)

    assert [r["id"] for r in first["reads"]] == [r["id"] for r in second["reads"]]
    assert first["count"] == 4
    assert first["total"] == 12
    assert first["sample_seed"] == "paper-seed"
    assert uncapped["count"] == 12


def test_coordinate_synced_compact_queries_panel_specific_chromosomes():
    session = {
        "regions": {
            "chrom": "chr2L_hap1",
            "x_chrom": "chr2L_hap1",
            "x_start": 100,
            "x_end": 200,
            "y_chrom": "chr2L_hap2",
            "y_start": 500,
            "y_end": 600,
        },
        "reads": [
            {
                "read_id": "linked_should_not_be_used",
                "x_segments": [{"start": 110, "end": 120, "blockSizes": "", "blockStarts": ""}],
                "y_segments": [{"start": 510, "end": 520, "blockSizes": "", "blockStarts": ""}],
            }
        ],
        "contact_mode": "microc",
        "split_view_mode": "coordinate_synced",
    }
    calls = []

    def query(chrom, start, end, **kwargs):
        calls.append((chrom, start, end))
        return [{
            "name": f"{chrom}_read",
            "start": start,
            "end": end,
            "blockSizes": "20,",
            "blockStarts": "0,",
        }]

    x_result = linked_reads_compact_response("session1", session, "x", 10, "x", "seed", query)
    y_result = linked_reads_compact_response("session1", session, "y", 10, "x", "seed", query)

    assert calls == [("chr2L_hap1", 100, 200), ("chr2L_hap2", 500, 600)]
    assert x_result["split_view_mode"] == "coordinate_synced"
    assert y_result["split_view_mode"] == "coordinate_synced"
    assert x_result["reads"][0]["id"] == "chr2L_hap1_read"
    assert y_result["reads"][0]["id"] == "chr2L_hap2_read"


def test_linked_compact_honors_sort_anchor_before_sampling():
    session = {
        "regions": {"chrom": "chr2L", "x_start": 0, "x_end": 1000, "y_start": 0, "y_end": 1000},
        "reads": [
            {
                "read_id": "r1",
                "x_segments": [{"start": 300, "end": 320, "blockSizes": "", "blockStarts": ""}],
                "y_segments": [{"start": 100, "end": 120, "blockSizes": "", "blockStarts": ""}],
            },
            {
                "read_id": "r2",
                "x_segments": [{"start": 100, "end": 120, "blockSizes": "", "blockStarts": ""}],
                "y_segments": [{"start": 300, "end": 320, "blockSizes": "", "blockStarts": ""}],
            },
            {
                "read_id": "r3",
                "x_segments": [{"start": 200, "end": 220, "blockSizes": "", "blockStarts": ""}],
                "y_segments": [{"start": 200, "end": 220, "blockSizes": "", "blockStarts": ""}],
            },
        ],
        "contact_mode": "dafc",
    }
    query = lambda *args, **kwargs: []

    sort_x = linked_reads_compact_response("session1", session, "x", 10, "x", "seed", query)
    sort_y = linked_reads_compact_response("session1", session, "x", 10, "y", "seed", query)

    assert [r["id"] for r in sort_x["reads"]] == ["r2", "r3", "r1"]
    assert [r["id"] for r in sort_y["reads"]] == ["r1", "r3", "r2"]
