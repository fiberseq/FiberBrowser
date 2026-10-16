import numpy as np

from services.microc_apa import compute_apa_from_matrix


def test_compute_apa_from_matrix_extracts_and_scores_peak_pair_window():
    full_matrix = np.arange(100, dtype=float).reshape(10, 10)
    peaks = [
        {"start": 10, "end": 20},
        {"start": 50, "end": 60},
    ]

    result = compute_apa_from_matrix(full_matrix, peaks, resolution=10, window=10, chrom_nbins=10)

    expected = full_matrix[0:3, 4:7]
    np.testing.assert_array_equal(result["matrix"], expected)
    assert result["n_pairs"] == 1
    assert result["matrix_size"] == 3
    assert result["center_value"] == 15.0
    assert result["corner_mean"] == np.mean([4.0, 6.0, 24.0, 26.0])
    assert result["apa_score"] == 15.0 / result["corner_mean"]


def test_compute_apa_from_matrix_applies_distance_expected_normalization():
    full_matrix = np.ones((8, 8), dtype=float) * 10
    peaks = [
        {"start": 10, "end": 20},
        {"start": 40, "end": 50},
    ]
    expected_per_dist = np.arange(1, 20, dtype=float)

    result = compute_apa_from_matrix(
        full_matrix,
        peaks,
        resolution=10,
        window=10,
        chrom_nbins=8,
        expected_per_dist=expected_per_dist,
    )

    # Peak bins are 1 and 4, so the APA center is distance 3.
    assert result["matrix"][1, 1] == 10 / expected_per_dist[3]
    # Top-left cell is also distance 3; top-right is distance 5.
    assert result["matrix"][0, 0] == 10 / expected_per_dist[3]
    assert result["matrix"][0, 2] == 10 / expected_per_dist[5]


def test_compute_apa_from_matrix_returns_empty_when_no_valid_peak_pairs():
    full_matrix = np.ones((5, 5), dtype=float)
    peaks = [
        {"start": 0, "end": 10},
        {"start": 10, "end": 20},
    ]

    result = compute_apa_from_matrix(full_matrix, peaks, resolution=10, window=30, chrom_nbins=5)

    assert result == {
        "matrix": [],
        "apa_score": 0,
        "center_value": 0,
        "corner_mean": 0,
        "n_pairs": 0,
        "matrix_size": 7,
        "pairs_beyond_expected": 0,
    }
