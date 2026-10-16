"""Regression tests for extracted accessibility track helpers."""

import numpy as np
import pandas as pd

from services import accessibility_tracks


def _example_reads_df():
    return pd.DataFrame(
        {
            "read_id": ["r1", "r2", "r3"],
            100: [50, 0, 120],
            101: [150, 100, 100],
            102: [2, 80, 120],
            "_cluster": [0, 0, 1],
        }
    )


def test_meta_line_plot():
    reads_df = _example_reads_df()

    profile = accessibility_tracks.meta_line_plot(reads_df, 100, 103, 10, 90)

    # r2's 0 at 100 is outside the read (dense rows are 0 where a read doesn't
    # reach), so it isn't in that base's denominator; 2 is the legacy no-data code.
    assert np.allclose(profile, [1 / 2, 0, 1 / 2])


def test_compute_accessibility_track():
    reads_df = _example_reads_df()

    track, peaks, regions = accessibility_tracks.compute_accessibility_track(
        reads_df,
        100,
        103,
        window=1,
    )

    # Base 100: one of its two covering reads is accessible; base 102: two of three.
    assert np.allclose(track, [75, 0, 100])
    assert peaks == []
    assert regions == []


def test_empty_accessibility_inputs_return_empty_tracks():
    empty = pd.DataFrame(columns=["read_id"])

    track, peaks, regions = accessibility_tracks.compute_accessibility_track(empty, 10, 15)

    assert np.array_equal(track, np.zeros(5))
    assert peaks == []
    assert regions == []
    assert accessibility_tracks.scan_for_peaks(empty, 10, 15) == []
    assert np.array_equal(accessibility_tracks.meta_line_plot(empty, 10, 15, 10, 90), np.array([]))
