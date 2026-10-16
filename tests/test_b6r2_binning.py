"""Half-open interval binning and one-bin correlation (B6 review round 2)."""
import numpy as np


def test_interval_on_a_bin_boundary_fills_only_its_bins():
    from services.orthogonal_tracks import _add_binned_interval
    values = [0.0, 0.0, 0.0]
    _add_binned_interval(values, target_start=0, target_end=30, interval_start=0, interval_end=10)
    assert values == [1.0, 0.0, 0.0]
    values = [0.0, 0.0, 0.0]
    _add_binned_interval(values, target_start=0, target_end=30, interval_start=5, interval_end=11)
    assert values == [1.0, 1.0, 0.0]


def test_annotation_profile_is_half_open():
    from services.annotation_profiles import build_annotation_profiles
    profiles = build_annotation_profiles([{"r": [(0, 10, "x", 1.0)]}], start=0, end=30, bins=3)
    assert profiles["x"] == [1.0, 0.0, 0.0]


def test_correlation_with_a_single_bin_is_an_empty_matrix():
    from services.coaccessibility import normalize_correlation
    out = normalize_correlation(np.array([[0.5], [1.0], [0.0]], dtype=np.float32), min_coverage=1)
    assert out.shape == (1, 1) and np.isnan(out[0, 0])
