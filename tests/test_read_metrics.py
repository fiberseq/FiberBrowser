"""Regression tests for compact-read metric and filtering helpers."""

import pytest
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

    assert payload["layers"]["tf"][10:20] == [1.0] * 10
    assert payload["layers"]["tf"][20] == 0.0
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


@pytest.mark.parametrize("width", [1000, 1001, 1337, 2999])
def test_compact_metaprofile_bins_match_the_headless_and_client_rule(width):
    """The server's profile bins a call [s, e) like ReadTrack and the headless engine (no extra end bin), also
    when bins are fractional bases wide."""
    import numpy as np
    from services.figure.tracks._metaprofile import compute_metaprofile

    rng = np.random.default_rng(7)
    reads = []
    for i in range(40):
        start = int(rng.integers(0, width * 3 // 10))
        end = int(rng.integers(width * 7 // 10, width))
        calls = []
        for _ in range(6):
            s = int(rng.integers(start, end - 5))
            calls.append([s, s + int(rng.integers(1, 40)), 0])
        calls += [[start, start + 2, 0], [end - 4, end, 0]]  # calls that end on a bin edge
        calls = [[s, min(e, end), min(e, end) - s] for s, e, _ in calls]
        reads.append({"id": f"r{i}", "intervals": [[start, end, end - start]], "layers": {"tf": {"intervals": calls}}})

    server = read_metrics.compute_compact_metaprofile_payload(
        reads, width, ["tf"], max_bins=500, include_legacy_profiles=False)["layers"]["tf"]
    headless = compute_metaprofile(reads, float(width), [], None)["layers"]["tf"]

    assert len(server) == len(headless) == 500
    assert np.allclose(server, headless, atol=1e-6)


def test_compact_metaprofile_counts_a_read_once_per_bin_and_covers_every_interval():
    """Two calls of one read meeting inside a bin count the read once there; a layer call past the read's primary
    intervals brings its own coverage. Every profile stays within [0, 1] (server and headless engine alike)."""
    import numpy as np
    from services.figure.tracks._metaprofile import compute_metaprofile

    reads = [
        # Two nucleosomes with a 1 bp linker inside one 8 bp bin (bins of 8 bp over 4000 bp / 500).
        {"id": "a", "intervals": [[0, 4000, 4000]], "layers": {"nuc": {"intervals": [[100, 245, 145], [246, 391, 145]]}}},
        # Abutting, overlapping and duplicated calls.
        {"id": "b", "intervals": [[0, 4000, 4000]],
         "layers": {"nuc": {"intervals": [[100, 245, 145], [245, 390, 145], [300, 380, 80], [300, 380, 80]]}}},
        # An MSP past the last footprint (terminal gaps hidden): its signal needs coverage under it.
        {"id": "c", "intervals": [[1000, 2000, 1000]], "layers": {"msp": {"intervals": [[2000, 2600, 600]]}}},
    ]
    server = read_metrics.compute_compact_metaprofile_payload(
        reads, 4000, ["nuc", "fire"], max_bins=500, include_legacy_profiles=False)["layers"]
    headless = compute_metaprofile(reads, 4000.0, [], None)["layers"]

    for name in ("nuc", "fire"):
        assert max(server[name]) <= 1.0 and min(server[name]) >= 0.0, name
        assert np.allclose(server[name], headless[name], atol=1e-6), name
    assert server["nuc"][30] == 1.0          # bin 240-248 holds both of read a's calls: counted once, 2 of 2 reads
    # Bin 2160-2168: reads a and b cover it, and read c through its MSP: 1 of 3 (without c's coverage, 1 of 2).
    assert server["fire"][270] == round(1 / 3, 6)
    assert server["fire"][320] == round(1 / 3, 6)  # bin 2560-2568, inside the MSP


def test_compact_metaprofile_coverage_does_not_depend_on_the_requested_sources():
    """Adding a profile source must not change another profile: coverage spans every layer/FIRE interval a read has."""
    reads = [
        {"id": "a", "intervals": [[0, 4000, 4000]], "layers": {"nuc": {"intervals": [[2100, 2250, 150]]}}},
        {"id": "b", "intervals": [[1000, 2000, 1000]], "layers": {"msp": {"intervals": [[2000, 2600, 600]]}}},
    ]
    nuc_only = read_metrics.compute_compact_metaprofile_payload(
        reads, 4000, ["nuc"], max_bins=500, include_legacy_profiles=False)["layers"]["nuc"]
    both = read_metrics.compute_compact_metaprofile_payload(
        reads, 4000, ["nuc", "fire"], max_bins=500, include_legacy_profiles=False)["layers"]["nuc"]
    assert nuc_only == both
    assert nuc_only[270] == 0.5  # bin 2160-2168: read b covers it through its MSP


def test_headless_metaprofile_counts_msp_and_fire_aliases_once():
    from services.figure.tracks._metaprofile import compute_metaprofile

    reads = [{"id": "a", "intervals": [[0, 1000, 1000]],
              "layers": {"msp": {"intervals": [[100, 200, 100]]}, "fire": {"intervals": [[100, 200, 100]]}}}]
    fire = compute_metaprofile(reads, 1000.0, [], None)["layers"]["fire"]
    assert max(fire) == 1.0


def test_compact_metaprofile_coverage_reads_the_intervals_as_they_are_now():
    """The coverage span comes from the current intervals, not a cached index (keyed on identity and length)."""
    reads = [
        {"id": "a", "intervals": [[40, 60, 20]], "layers": {"tf": {"intervals": [[40, 60, 20]]}}},
        {"id": "b", "intervals": [[0, 100, 100]], "layers": {"tf": {"intervals": [[0, 100, 100]]}}},
    ]
    read_metrics.compute_compact_metaprofile_payload(reads, 100, ["tf"], max_bins=100, include_legacy_profiles=False)
    reads[0]["layers"]["tf"]["intervals"][0] = [10, 90, 80]  # same list, same length
    tf = read_metrics.compute_compact_metaprofile_payload(
        reads, 100, ["tf"], max_bins=100, include_legacy_profiles=False)["layers"]["tf"]
    assert max(tf) <= 1.0
