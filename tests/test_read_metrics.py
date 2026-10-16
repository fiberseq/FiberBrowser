"""Regression tests for compact-read metric and filtering helpers."""

from services import read_metrics


def test_fill_small_gaps_in_read():
    read = {
        "id": "r1",
        "intervals": [
            [0, 40, 40],
            [40, 50, -10],
            [50, 90, 40],
            [90, 140, -50],
            [140, 180, 40],
        ],
    }

    expected = {
        **read,
        "intervals": [
            [0, 90, 80],
            [90, 140, -50],
            [140, 180, 40],
        ],
    }

    assert read_metrics.fill_small_gaps_in_read(read, 20) == expected


def test_compact_reads_to_dataframe():
    reads = [
        {"id": "r1", "intervals": [[0, 20, 20], [20, 40, -20]]},
        {"id": "r2", "intervals": [[10, 30, 30]]},
    ]

    df = read_metrics.compact_reads_to_dataframe(reads, 100, 140)

    assert list(df.columns) == [100, 110, 120, 130, "read_id"]
    assert df["read_id"].tolist() == ["r1", "r2"]
    assert df.loc[0, 100] == 20
    assert df.loc[0, 120] == 20
    assert df.loc[0, 130] == 2
    assert df.loc[1, 110] == 30


def test_read_covers_regions_requires_complete_target_coverage():
    full = {"id": "full", "intervals": [[0, 50, -50], [50, 100, 30]]}
    missing_middle = {"id": "gap", "intervals": [[0, 40, 30], [60, 100, 30]]}
    partial = {"id": "partial", "intervals": [[20, 100, 30]]}

    targets = [(10, 30), (70, 90)]

    assert read_metrics.read_covers_regions(full, targets)
    assert read_metrics.read_covers_regions(missing_middle, targets)
    assert not read_metrics.read_covers_regions(missing_middle, [(30, 70)])
    assert not read_metrics.read_covers_regions(partial, targets)


def test_filter_reads_covering_regions():
    reads = [
        {"id": "a", "intervals": [[0, 100, 30]]},
        {"id": "b", "intervals": [[0, 40, 30], [60, 100, 30]]},
        {"id": "c", "intervals": [[80, 100, 30]]},
    ]
    targets = [(30, 70)]

    expected = [reads[0]]

    assert read_metrics.filter_reads_covering_regions(reads, targets) == expected


def test_sample_stable_by_id_is_reproducible_and_order_independent():
    reads = [{"id": f"read_{i}", "intervals": [[0, 100, 30]]} for i in range(20)]
    reversed_reads = list(reversed(reads))

    sample = read_metrics.sample_stable_by_id(reads, 5, seed="same-seed")
    sample_again = read_metrics.sample_stable_by_id(reads, 5, seed="same-seed")
    reversed_sample = read_metrics.sample_stable_by_id(reversed_reads, 5, seed="same-seed")

    assert [r["id"] for r in sample] == [r["id"] for r in sample_again]
    assert {r["id"] for r in sample} == {r["id"] for r in reversed_sample}


def test_stable_seed_int_is_process_stable_and_context_sensitive():
    seed = read_metrics.stable_seed_int("seed", "compact_all", "chr2L", 10, 20)

    assert seed == read_metrics.stable_seed_int("seed", "compact_all", "chr2L", 10, 20)
    assert seed != read_metrics.stable_seed_int("seed", "compact_all", "chr2L", 10, 21)
    assert 0 <= seed < 2**31


def test_random_state_from_seed_preserves_default_and_honors_custom_seed():
    assert read_metrics.random_state_from_seed(None, "cluster") == 42
    assert read_metrics.random_state_from_seed("  ", "cluster") == 42

    seed = read_metrics.random_state_from_seed("custom", "cluster", "kmeans")

    assert seed == read_metrics.random_state_from_seed("custom", "cluster", "kmeans")
    assert seed != 42
    assert seed != read_metrics.random_state_from_seed("custom", "cluster", "minibatch")


def test_normalize_sample_seed_uses_canonical_default():
    assert read_metrics.normalize_sample_seed(None) == read_metrics.DEFAULT_SAMPLE_SEED
    assert read_metrics.normalize_sample_seed("  custom-seed  ") == "custom-seed"
    assert read_metrics.normalize_sample_seed("  ") == read_metrics.DEFAULT_SAMPLE_SEED


def test_layer_interval_and_fp_metrics():
    read = {
        "id": "r1",
        "intervals": [[0, 20, 20], [20, 40, -20], [40, 100, 60]],
        "layers": {"tf": {"intervals": [[10, 15, 5], [70, 90, 20]]}},
    }

    assert read_metrics.get_layer_intervals(read, None) == read["intervals"]
    assert read_metrics.get_layer_intervals(read, "tf") == read["layers"]["tf"]["intervals"]
    assert read_metrics.get_layer_intervals(read, "missing") == []

    expected_primary = (2, 80, 100)
    expected_scoped = (1, 60, 60)
    expected_tf = (2, 25, 25)

    assert read_metrics.compute_fp_metrics(read, 100) == expected_primary
    assert read_metrics.compute_fp_metrics(read, 100, scope_windows=[(160, 190)]) == expected_scoped
    assert read_metrics.compute_fp_metrics(read, 100, layer="tf") == expected_tf


def test_layer_interval_resolution_aliases_fire_and_legacy_msp():
    read_with_msp = {
        "id": "r1",
        "intervals": [[0, 100, 100]],
        "layers": {"msp": {"intervals": [[10, 40, 30]]}},
    }
    read_with_fire = {
        "id": "r2",
        "intervals": [[0, 100, 100]],
        "layers": {"fire": {"intervals": [[20, 50, 30]]}},
    }
    raw_fire_only = {
        "id": "r3",
        "intervals": [[0, 100, 100]],
        "fire": [[30, 60, 240]],
    }

    assert read_metrics.get_layer_intervals(read_with_msp, "fire") == [[10, 40, 30]]
    assert read_metrics.get_layer_intervals(read_with_fire, "msp") == [[20, 50, 30]]
    assert read_metrics.get_layer_intervals(raw_fire_only, "fire") == [[30, 60, 240]]


def test_compact_metaprofile_payload_includes_layer_profiles_and_aliases():
    reads = [
        {
            "id": "r1",
            "intervals": [[0, 10, 10]],
            "layers": {
                "tf": {"intervals": [[2, 4, 2]]},
                "nuc": {"intervals": [[5, 9, 4]]},
            },
        },
        {
            "id": "r2",
            "intervals": [[0, 10, 10]],
            "layers": {
                "msp": {"intervals": [[1, 3, 2]]},
            },
        },
    ]

    payload = read_metrics.compute_compact_metaprofile_payload(
        reads,
        10,
        ["tf", "fire", "msp", "nuc"],
        max_bins=10,
    )

    assert payload["layers"]["tf"][2:4] == [0.5, 0.5]
    assert payload["layers"]["fire"][1:3] == [0.5, 0.5]
    assert "msp" not in payload["layers"]
    assert payload["layers"]["nuc"][5:9] == [0.5, 0.5, 0.5, 0.5]
    assert len(payload["nucleosome_profile"]) == 10
    assert len(payload["subnuc_profile"]) == 10


def test_compact_metaprofile_payload_supports_coordinate_offsets():
    reads = [{
        "id": "r1",
        "intervals": [[100, 200, 100]],
        "layers": {"tf": {"intervals": [[110, 120, 10]]}},
    }]

    payload = read_metrics.compute_compact_metaprofile_payload(
        reads,
        100,
        ["tf"],
        max_bins=100,
        include_legacy_profiles=False,
        coordinate_offset=100,
    )

    assert payload["layers"]["tf"][10:21] == [1.0] * 11
    assert payload["nucleosome_profile"] == []
    assert payload["subnuc_profile"] == []


def test_all_fp_layer_interval_resolution_unions_structured_fp_layers():
    read = {
        "id": "r1",
        "intervals": [[0, 100, 100]],
        "layers": {
            "nuc": {"intervals": [[0, 50, 50], [0, 50, 50]]},
            "tf": {"intervals": [[60, 80, 20]]},
            "fire": {"intervals": [[10, 90, 80]]},
            "deam": {"intervals": [[25, 25, 1]]},
        },
    }

    assert read_metrics.get_layer_intervals(read, "all_fp") == [[0, 50, 50], [60, 80, 20]]


def test_rule_metric_for_primary_and_layers():
    read = {
        "id": "r1",
        "intervals": [[0, 20, 20], [20, 40, -20], [40, 100, 60]],
        "layers": {"tf": {"intervals": [[10, 15, 5], [70, 90, 20]]}},
    }
    rule = {"size_min": 10, "size_max": 70, "conditions": [{"target": "gene"}]}
    gene_regions = [(160, 185)]
    peak_regions = []

    assert read_metrics.midpoint_in_regions(170, gene_regions)
    assert not read_metrics.midpoint_in_regions(140, gene_regions)
    assert read_metrics.compute_rule_metric(read, 100, rule, gene_regions, peak_regions) == 1
    assert read_metrics.compute_rule_metric(read, 100, rule, gene_regions, peak_regions, layer="tf") == 1


def test_rule_metric_applies_scope_windows_separately_from_peak_conditions():
    read = {
        "id": "r1",
        "intervals": [[0, 20, 20], [100, 130, 30], [200, 240, 40]],
    }
    rule = {"size_min": 10, "size_max": 50, "conditions": [{"target": "peak"}]}
    peak_regions = [(1_010, 1_020), (1_110, 1_120), (1_210, 1_230)]

    assert read_metrics.compute_rule_metric(read, 1_000, rule, [], peak_regions) == 3
    assert read_metrics.compute_rule_metric(
        read,
        1_000,
        rule,
        [],
        peak_regions,
        scope_windows=[(1_090, 1_150)],
    ) == 1


def test_rule_metric_supports_specific_gene_conditions():
    read = {
        "id": "r1",
        "intervals": [[40, 100, 60], [120, 170, 50]],
    }
    gene_regions = [(160, 185), (230, 250)]
    gene_regions_by_key = {
        "id:gene_a": [(160, 185)],
        "name:gene b": [(230, 250)],
    }
    peak_regions = []

    in_gene_a = {"size_min": 10, "size_max": 70, "conditions": [{"target": "gene", "geneId": "gene_a"}]}
    not_gene_a = {"size_min": 10, "size_max": 70, "conditions": [{"target": "gene", "geneId": "gene_a", "negate": True}]}
    in_gene_b = {"size_min": 10, "size_max": 70, "conditions": [{"target": "gene", "geneName": "Gene B"}]}
    fallback_name = {
        "size_min": 10,
        "size_max": 70,
        "conditions": [{"target": "gene", "geneId": "missing_id", "geneName": "Gene B"}],
    }

    assert read_metrics.compute_rule_metric(
        read, 100, in_gene_a, gene_regions, peak_regions, gene_regions_by_key=gene_regions_by_key
    ) == 1
    assert read_metrics.compute_rule_metric(
        read, 100, not_gene_a, gene_regions, peak_regions, gene_regions_by_key=gene_regions_by_key
    ) == 1
    assert read_metrics.compute_rule_metric(
        read, 100, in_gene_b, gene_regions, peak_regions, gene_regions_by_key=gene_regions_by_key
    ) == 1
    assert read_metrics.compute_rule_metric(
        read, 100, fallback_name, gene_regions, peak_regions, gene_regions_by_key=gene_regions_by_key
    ) == 1
