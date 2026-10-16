"""Regression tests for read image rendering service."""

import numpy as np
import pandas as pd

from render import _format_axis_tick, render_axis_track
from services.read_rendering import render_reads_to_image


def test_render_reads_to_image_outputs_expected_size_and_pixels():
    reads_df = pd.DataFrame({
        100: [10, -20],
        101: [10, -20],
        102: [100, 0],
        "read_id": ["r1", "r2"],
    })

    service_img = render_reads_to_image(
        reads_df,
        cluster_assignments={"r1": 1, "r2": 2},
        row_height=2,
    )
    assert service_img.size == (11, 4)
    assert np.asarray(service_img).shape == (4, 11, 3)
    assert np.asarray(service_img).sum() > 0


def test_headless_axis_ticks_retain_locus_scale_precision():
    labels = [_format_axis_tick(position, 200) for position in (47_514_600, 47_514_800)]
    assert labels == ["47.5146 Mb", "47.5148 Mb"]
    assert len(set(labels)) == 2

    image = render_axis_track(1200, "chr19", 47_514_596, 47_516_174)
    assert image.size == (1200, 30)
