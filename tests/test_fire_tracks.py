"""Regression tests for extracted FIRE track helpers."""

import numpy as np
import pandas as pd

from services import fire_tracks


def test_load_fire_data_reads_bed_files(tmp_path):
    (tmp_path / "peaks.bed").write_text("chr1\t0\t10\tname1\nchr1\t20\t30\tname2\n")
    (tmp_path / "ignored.txt").write_text("chr1\t40\t50\n")

    fire_df = fire_tracks.load_fire_data(str(tmp_path))

    assert fire_df is not None
    assert list(fire_df.columns) == ["chrom", "start", "end", "col3"]
    assert len(fire_df) == 2
    assert list(fire_df["chrom"]) == ["chr1", "chr1"]


def test_load_fire_data_diagnostics_are_opt_in(tmp_path, capsys, monkeypatch):
    (tmp_path / "peaks.bed").write_text("chr1\t0\t10\tname1\n")
    monkeypatch.delenv(fire_tracks.TRACK_DIAGNOSTICS_ENV, raising=False)

    assert fire_tracks.load_fire_data(str(tmp_path)) is not None
    assert capsys.readouterr().out == ""

    monkeypatch.setenv(fire_tracks.TRACK_DIAGNOSTICS_ENV, "1")
    assert fire_tracks.load_fire_data(str(tmp_path)) is not None
    output = capsys.readouterr().out
    assert "Loading FIRE data from" in output
    assert "Loaded 1 FIRE peaks" in output


def test_compute_fire_track_vectorized_signal_matches_expected():
    fire_df = pd.DataFrame(
        [
            ["chr1", 0, 300],
            ["chr1", 100, 250],
            ["chr1", 350, 450],
            ["chr2", 0, 500],
        ],
        columns=["chrom", "start", "end"],
    )

    track, peaks, regions = fire_tracks.compute_fire_track(fire_df, "chr1", 0, 500)

    expected = np.zeros(500)
    expected[0:300] += 1
    expected[100:250] += 1
    expected[350:450] += 1

    assert np.array_equal(track, expected)
    assert peaks == [174, 399]
    assert regions == [[74, 274], [299, 499]]


def test_compute_fire_track_maps_circular_segments_to_logical_viewport():
    fire_df = pd.DataFrame(
        [
            ["chr1", 970, 990],
            ["chr1", 10, 30],
        ],
        columns=["chrom", "start", "end"],
    )

    track, _peaks, _regions = fire_tracks.compute_fire_track(
        fire_df,
        "chr1",
        950,
        1050,
        query_segments=[(950, 1000, 0), (0, 50, 1000)],
    )

    expected = np.zeros(100)
    expected[20:40] += 1
    expected[60:80] += 1
    assert np.array_equal(track, expected)


def test_compute_fire_track_handles_missing_data():
    track, peaks, regions = fire_tracks.compute_fire_track(None, "chr1", 0, 25)

    assert np.array_equal(track, np.zeros(25))
    assert peaks == []
    assert regions == []
