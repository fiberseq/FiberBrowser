"""Tests for compact-read quality filtering."""

from services.read_quality_filters import apply_quality_filters


def test_apply_quality_filters_filters_layer_intervals_without_mutating_input():
    read = {
        "id": "r1",
        "intervals": [[0, 10, -1], [10, 20, 10], [20, 30, 10]],
        "qualities": [50, 250],
        "layers": {
            "tf": {
                "intervals": [[10, 20, 10], [20, 30, 10]],
                "quality_names": ["tq"],
                "qualities": [[100, 240]],
            },
            "msp": {
                "intervals": [[0, 10, 10]],
                "quality_names": ["aq"],
                "qualities": [[200]],
            },
        },
    }

    filtered = apply_quality_filters(read, [
        {"layer": "tf", "quality_name": "tq", "min_value": 200},
    ])

    assert filtered["layers"]["tf"]["intervals"] == [[20, 30, 10]]
    assert filtered["layers"]["tf"]["qualities"] == [[240]]
    assert filtered["layers"]["msp"] == read["layers"]["msp"]
    assert read["layers"]["tf"]["intervals"] == [[10, 20, 10], [20, 30, 10]]


def test_layer_filter_preserves_annotation_alignment_and_fails_closed_on_short_aq():
    read = {
        "id": "r1",
        "intervals": [[0, 30, 0]],
        "layers": {
            "tf_sr": {
                "intervals": [[0, 10, 10], [10, 20, 10], [20, 30, 10]],
                "quality_names": ["q0"],
                "qualities": [[240, 100]],
                "annotation_names": ["keep", "low", "missing"],
                "circular_ids": ["keep", "low", "missing"],
                "source_intervals": [[-2, 10, 12], [10, 20, 10], [20, 34, 14]],
            }
        },
    }

    filtered = apply_quality_filters(read, [
        {"layer": "tf_sr", "quality_name": "q0", "min_value": 128},
    ])

    assert filtered["layers"]["tf_sr"]["intervals"] == [[0, 10, 10]]
    assert filtered["layers"]["tf_sr"]["qualities"] == [[240]]
    assert filtered["layers"]["tf_sr"]["annotation_names"] == ["keep"]
    assert filtered["layers"]["tf_sr"]["circular_ids"] == ["keep"]
    assert filtered["layers"]["tf_sr"]["source_intervals"] == [[-2, 10, 12]]


def test_explicit_missing_quality_dimension_fails_closed_but_wildcard_skips_it():
    read = {
        "id": "r1",
        "intervals": [[0, 20, 0]],
        "layers": {
            "tf_sr": {
                "intervals": [[0, 20, 20]],
                "quality_names": ["tq", "el", "er", "fi", "fq"],
                "qualities": [[240], [0], [0], [7], [230]],
            },
        },
    }

    explicit = apply_quality_filters(read, [
        {"layer": "tf_sr", "quality_name": "q0", "min_value": 128},
    ])
    # Every call failed the gate: the layer stays, explicitly empty, so analyses
    # don't fall back to the unfiltered primary intervals.
    assert explicit["layers"]["tf_sr"]["intervals"] == []

    wildcard = apply_quality_filters(read, [
        {"layer": "*", "quality_name": "q0", "min_value": 128},
    ])
    assert wildcard["layers"]["tf_sr"] == read["layers"]["tf_sr"]


def test_fire_quality_filter_aliases_internal_msp_layer():
    read = {
        "id": "r1",
        "intervals": [[0, 10, 10], [20, 30, 10]],
        "layers": {
            "msp": {
                "intervals": [[0, 10, 10], [20, 30, 10]],
                "quality_names": ["aq"],
                "qualities": [[200, 245]],
            },
        },
    }

    filtered = apply_quality_filters(read, [
        {"layer": "fire", "quality_name": "aq", "min_value": 230},
    ])

    assert filtered["layers"]["msp"]["intervals"] == [[20, 30, 10]]
    assert filtered["layers"]["msp"]["qualities"] == [[245]]


def test_fire_quality_filter_keeps_msp_with_all_placeholder_aq():
    read = {
        "id": "r1",
        "intervals": [[0, 30, 0]],
        "layers": {
            "msp": {
                "intervals": [[0, 10, 10], [20, 30, 10]],
                "quality_names": ["aq"],
                "qualities": [[0, 0]],
            },
        },
    }

    filtered = apply_quality_filters(read, [
        {"layer": "fire", "quality_name": "aq", "min_value": 230},
    ])

    assert filtered["layers"]["msp"] == read["layers"]["msp"]


def test_fire_quality_filter_keeps_unqualified_inferred_msp():
    read = {
        "id": "r1",
        "intervals": [[0, 30, 0]],
        "layers": {
            "msp": {
                "intervals": [[0, 10, 10], [20, 30, 10]],
                "quality_names": [],
                "qualities": None,
            },
        },
    }

    filtered = apply_quality_filters(read, [
        {"layer": "fire", "quality_name": "aq", "min_value": 230},
    ])

    assert filtered["layers"]["msp"] == read["layers"]["msp"]


def test_fire_quality_filter_filters_legacy_fire_intervals_when_no_layer_payload():
    read = {
        "id": "r1",
        "intervals": [[0, 10, 10], [20, 30, 10], [40, 50, 10]],
        "fire": [[0, 10, 200], [20, 30, 245], [40, 50, None]],
    }

    filtered = apply_quality_filters(read, [
        {"layer": "fire", "quality_name": "aq", "min_value": 230},
    ])

    assert filtered["fire"] == [[20, 30, 245], [40, 50, None]]


def test_fire_quality_filter_keeps_placeholder_legacy_fire_quality():
    read = {
        "id": "r1",
        "intervals": [[0, 10, 10], [20, 30, 10]],
        "fire": [[0, 10, 0], [20, 30, 128]],
    }

    filtered = apply_quality_filters(read, [
        {"layer": "fire", "quality_name": "aq", "min_value": 230},
    ])

    assert filtered["fire"] == [[0, 10, 0], [20, 30, 128]]


def test_apply_quality_filters_filters_primary_nuc_qualities():
    read = {
        "id": "r1",
        "intervals": [[0, 10, -1], [10, 20, 10], [20, 30, -1], [30, 40, 10]],
        "qualities": [50, 250],
        "layers": {
            "nuc": {
                "intervals": [[10, 20, 10], [30, 40, 10]],
                "quality_names": ["nq"],
                "qualities": [[50, 250]],
            },
        },
    }

    filtered = apply_quality_filters(read, [
        {"layer": "nuc", "quality_name": "nq", "min_value": 200},
    ])

    assert filtered["intervals"] == [[0, 10, -1], [20, 30, -1], [30, 40, 10]]
    assert filtered["qualities"] == [250]
    assert filtered["layers"]["nuc"]["intervals"] == [[30, 40, 10]]
