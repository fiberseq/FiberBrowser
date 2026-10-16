from services.read_sorting import sort_reads_by_accessibility, sort_reads_by_kmeans


def test_sort_reads_by_accessibility_orders_by_negative_interval_bases():
    reads = [
        {"id": "low", "intervals": [[0, 10, -3]]},
        {"id": "high", "intervals": [[0, 10, -20], [20, 30, -5]]},
        {"id": "none", "intervals": [[0, 10, 10]]},
    ]

    ordered = sort_reads_by_accessibility(reads)

    assert [read["id"] for read in ordered] == ["high", "low", "none"]


def test_sort_reads_by_kmeans_is_seeded_and_preserves_reads():
    reads = [
        {"id": "left_a", "intervals": [[0, 25, -10]]},
        {"id": "left_b", "intervals": [[5, 30, -10]]},
        {"id": "right_a", "intervals": [[70, 95, -10]]},
        {"id": "right_b", "intervals": [[75, 99, -10]]},
    ]

    ordered = sort_reads_by_kmeans(reads, region_width=100, n_clusters=2, random_state=7)
    ordered_again = sort_reads_by_kmeans(reads, region_width=100, n_clusters=2, random_state=7)

    assert [read["id"] for read in ordered] == [read["id"] for read in ordered_again]
    assert {read["id"] for read in ordered} == {read["id"] for read in reads}
