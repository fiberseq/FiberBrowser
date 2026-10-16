"""Regression tests for named-layer overlays in the numpy renderer."""

import numpy as np

from render import render_compact_reads_track


def test_tf_overlay_can_target_named_layer_and_quality():
    reads = [
        {
            "id": "read1",
            "intervals": [[0, 20, 0]],
            "layers": {
                "tf": {
                    "intervals": [[1, 3]],
                    "quality_names": ["tq"],
                    "qualities": [[255]],
                },
                "tf_sr": {
                    "intervals": [[5, 10]],
                    "quality_names": ["q0"],
                    "qualities": [[255]],
                },
            },
        }
    ]
    image = render_compact_reads_track(
        reads,
        region_width=20,
        width=20,
        row_height=2,
        show_layers=True,
        colors={"gap": "#FFFFFF"},
        tf_overlay={
            "enabled": True,
            "layer": "tf_sr",
            "qualityName": "q0",
            "color": "#7C3AED",
            "minOpacity": 1.0,
            "maxOpacity": 1.0,
        },
    )
    pixels = np.asarray(image)
    assert np.all(pixels[:, 5:10] == (124, 58, 237))
    assert np.all(pixels[:, 1:3] == (255, 255, 255))


def test_tf_overlay_defaults_remain_tf_and_tq():
    reads = [
        {
            "id": "read1",
            "intervals": [[0, 10, 0]],
            "layers": {
                "tf": {
                    "intervals": [[2, 6]],
                    "quality_names": ["tq"],
                    "qualities": [[255]],
                }
            },
        }
    ]
    image = render_compact_reads_track(
        reads,
        region_width=10,
        width=10,
        row_height=1,
        show_layers=True,
        colors={"gap": "#FFFFFF"},
        tf_overlay={
            "enabled": True,
            "color": "#7C3AED",
            "minOpacity": 1.0,
            "maxOpacity": 1.0,
        },
    )
    assert np.all(np.asarray(image)[:, 2:6] == (124, 58, 237))


def test_named_overlay_without_quality_track_uses_neutral_confidence():
    reads = [{
        "id": "read1",
        "intervals": [[0, 10, 0]],
        "layers": {
            "tf_sr": {
                "intervals": [[2, 6]],
                "quality_names": [],
                "qualities": None,
            },
        },
    }]
    image = render_compact_reads_track(
        reads,
        region_width=10,
        width=10,
        row_height=1,
        show_layers=True,
        colors={"gap": "#FFFFFF"},
        tf_overlay={
            "enabled": True,
            "layer": "tf_sr",
            "qualityName": "q0",
            "color": "#7C3AED",
            "minOpacity": 1.0,
            "maxOpacity": 1.0,
        },
    )

    assert np.all(np.asarray(image)[:, 2:6] == (124, 58, 237))


def test_tf_overlay_can_hide_unnamed_baseline_shadow_rows():
    reads = [
        {
            "id": "read1",
            "intervals": [[0, 15, 0]],
            "layers": {
                "tf_sr": {
                    "intervals": [[1, 5], [8, 12]],
                    "quality_names": ["q0"],
                    "qualities": [[255, 255]],
                    "annotation_names": ["", "rescue_R"],
                }
            },
        }
    ]
    image = render_compact_reads_track(
        reads,
        region_width=15,
        width=15,
        row_height=1,
        show_layers=True,
        colors={"gap": "#FFFFFF"},
        tf_overlay={
            "enabled": True,
            "layer": "tf_sr",
            "qualityName": "q0",
            "requireAnnotationName": True,
            "color": "#7C3AED",
            "minOpacity": 1.0,
            "maxOpacity": 1.0,
        },
    )
    pixels = np.asarray(image)
    assert np.all(pixels[:, 1:5] == (255, 255, 255))
    assert np.all(pixels[:, 8:12] == (124, 58, 237))


def test_tf_overlay_fails_closed_when_quality_byte_is_missing():
    reads = [
        {
            "id": "read1",
            "intervals": [[0, 15, 0]],
            "layers": {
                "tf_sr": {
                    "intervals": [[1, 5], [8, 12]],
                    "quality_names": ["q0"],
                    "qualities": [[255]],
                    "annotation_names": ["rescue_with_q", "rescue_without_q"],
                }
            },
        }
    ]
    image = render_compact_reads_track(
        reads,
        region_width=15,
        width=15,
        row_height=1,
        show_layers=True,
        colors={"gap": "#FFFFFF"},
        tf_overlay={
            "enabled": True,
            "layer": "tf_sr",
            "qualityName": "q0",
            "requireAnnotationName": True,
            "color": "#7C3AED",
            "minOpacity": 1.0,
            "maxOpacity": 1.0,
        },
    )
    pixels = np.asarray(image)
    assert np.all(pixels[:, 1:5] == (124, 58, 237))
    assert np.all(pixels[:, 8:12] == (255, 255, 255))


def test_deamination_opportunities_use_edge_rugs_with_observed_event_on_top():
    reads = [{
        "id": "read1",
        "intervals": [[0, 12, 0]],
        # ``methyl`` may be an m6A compatibility projection in a mixed read;
        # opportunity mode must use the explicit DAF channel below.
        "methyl": [5],
        "deam": [[6, 1]],
        "possible_deam_ct": [2, 6],
        "possible_deam_ga": [9],
        "layers": {
            "tf_sr": {
                "intervals": [[0, 12, 12]],
                "quality_names": ["q0"],
                "qualities": [[255]],
            },
        },
    }]
    image = render_compact_reads_track(
        reads,
        region_width=12,
        width=12,
        row_height=6,
        show_mods=True,
        show_deam_opportunities=True,
        show_layers=True,
        tf_overlay={
            "enabled": True,
            "layer": "tf_sr",
            "qualityName": "q0",
            "color": "#7c3aed",
            "minOpacity": 1.0,
            "maxOpacity": 1.0,
        },
        colors={"gap": "#FFFFFF"},
    )
    pixels = np.asarray(image)

    assert np.all(pixels[0:2, 2] == (13, 148, 136))
    assert np.all(pixels[4:6, 9] == (217, 119, 6))
    assert np.all(pixels[:, 5] == (124, 58, 237))
    assert np.all(pixels[:, 6] == (17, 24, 39))


def test_opportunity_mode_never_relabels_m6a_as_observed_deamination():
    reads = [{
        "id": "read1",
        "intervals": [[0, 12, 0]],
        "methyl": [6],
        "methyl_m6a": [6],
        "possible_deam_ct": [2],
        # Deliberately no explicit ``deam`` events in this window.
    }]
    image = render_compact_reads_track(
        reads,
        region_width=12,
        width=12,
        row_height=6,
        show_mods=True,
        show_deam_opportunities=True,
        colors={"gap": "#FFFFFF"},
    )
    pixels = np.asarray(image)

    assert np.all(pixels[0:2, 2] == (13, 148, 136))
    assert np.all(pixels[:, 6] == (107, 33, 168))
