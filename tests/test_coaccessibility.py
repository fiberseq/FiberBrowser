"""Smoke tests for browser/services/coaccessibility.py pure helpers.

Complements test_coaccessibility_scope.py, which exercises the router-side
scoping logic and a couple of numeric helpers (_add_interval_bp,
normalize_oe_distance). This file covers the rest of the public surface so
each module-level function has at least one direct test.
"""

import numpy as np
import pytest

from models.domain import WorkingSet
from services import coaccessibility as coacc


# ---------------------------------------------------------------------------
# pick_bin_size
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "region_width,expected",
    [
        (5_000, 50),
        (15_000, 100),
        (30_000, 200),
        (75_000, 500),
        (150_000, 1000),
        (1_500_000, 10000),
    ],
)
def test_pick_bin_size_lands_on_nice_bin(region_width, expected):
    assert coacc.pick_bin_size(region_width) == expected


def test_pick_bin_size_handles_tiny_region():
    # A region smaller than the smallest nice bin should still snap to NICE_BINS.
    assert coacc.pick_bin_size(100) in coacc.NICE_BINS


# ---------------------------------------------------------------------------
# interval_matches_signal
# ---------------------------------------------------------------------------

def test_interval_matches_signal_categories():
    # accessibility = small footprint (<90) or non-positive (gap/linker)
    assert coacc.interval_matches_signal(50, "accessibility") is True
    assert coacc.interval_matches_signal(-100, "accessibility") is True
    assert coacc.interval_matches_signal(150, "accessibility") is False

    # nucleosome = footprints >= subnuc_threshold
    assert coacc.interval_matches_signal(150, "nucleosome") is True
    assert coacc.interval_matches_signal(50, "nucleosome") is False

    # small_fp = positive but below threshold
    assert coacc.interval_matches_signal(50, "small_fp") is True
    assert coacc.interval_matches_signal(150, "small_fp") is False
    assert coacc.interval_matches_signal(0, "small_fp") is False
    assert coacc.interval_matches_signal(-5, "small_fp") is False

    # linker = non-positive sizes
    assert coacc.interval_matches_signal(-100, "linker") is True
    assert coacc.interval_matches_signal(0, "linker") is True
    assert coacc.interval_matches_signal(50, "linker") is False

    # all_fp = any positive
    assert coacc.interval_matches_signal(50, "all_fp") is True
    assert coacc.interval_matches_signal(200, "all_fp") is True
    assert coacc.interval_matches_signal(0, "all_fp") is False


def test_interval_matches_signal_size_range():
    assert coacc.interval_matches_signal(80, "size:50-100") is True
    assert coacc.interval_matches_signal(50, "size:50-100") is True  # inclusive low
    assert coacc.interval_matches_signal(100, "size:50-100") is True  # inclusive high
    assert coacc.interval_matches_signal(120, "size:50-100") is False


def test_interval_matches_signal_size_range_malformed_returns_false():
    assert coacc.interval_matches_signal(50, "size:abc-xyz") is False
    assert coacc.interval_matches_signal(50, "size:50") is False


def test_interval_matches_signal_unknown_signal_falls_back_to_accessibility():
    # Documented behavior: unrecognized signal falls through to the
    # accessibility predicate (size < threshold or size <= 0).
    assert coacc.interval_matches_signal(50, "made_up_signal") is True
    assert coacc.interval_matches_signal(150, "made_up_signal") is False


def test_interval_matches_signal_respects_subnuc_threshold():
    # Custom threshold pushes the boundary up.
    assert coacc.interval_matches_signal(100, "small_fp", subnuc_threshold=120) is True
    assert coacc.interval_matches_signal(100, "nucleosome", subnuc_threshold=120) is False


# ---------------------------------------------------------------------------
# compute_raw_matrix
# ---------------------------------------------------------------------------

def test_compute_raw_matrix_handles_empty_input():
    raw, coverage = coacc.compute_raw_matrix(np.zeros((0, 5), dtype=np.float32))
    assert raw.shape == (5, 5)
    assert coverage.shape == (5, 5)
    assert np.all(np.isnan(raw))
    assert np.all(coverage == 0)


def test_compute_raw_matrix_marks_undercovered_bins_nan():
    # 2 reads, fully accessible everywhere — coverage = 2 < min_coverage (3).
    accessibility = np.ones((2, 3), dtype=np.float32)
    raw, coverage = coacc.compute_raw_matrix(accessibility, min_coverage=3)
    assert np.all(np.isnan(raw))
    assert np.all(coverage == 2)


def test_compute_raw_matrix_computes_co_accessibility():
    # 4 reads, all fully accessible at all 2 bins → expected co-acc = 1.
    accessibility = np.ones((4, 2), dtype=np.float32)
    raw, coverage = coacc.compute_raw_matrix(accessibility, min_coverage=2)
    np.testing.assert_allclose(raw, np.ones((2, 2), dtype=np.float32))
    np.testing.assert_allclose(coverage, np.full((2, 2), 4, dtype=np.float32))


# ---------------------------------------------------------------------------
# normalize_oe_marginal
# ---------------------------------------------------------------------------

def test_normalize_oe_marginal_uses_diagonal_as_marginal():
    # Diagonal = 0.5, off-diagonal = 0.25 → expected = 0.25, O/E = 1.
    raw = np.array(
        [
            [0.5, 0.25, 0.25],
            [0.25, 0.5, 0.25],
            [0.25, 0.25, 0.5],
        ],
        dtype=np.float32,
    )
    result = coacc.normalize_oe_marginal(raw)
    # Diagonal blanked.
    assert np.all(np.isnan(np.diag(result)))
    # Off-diagonal = raw / (0.5 * 0.5) = 1.0
    off_mask = ~np.eye(3, dtype=bool)
    np.testing.assert_allclose(result[off_mask], 1.0, rtol=1e-5)


def test_normalize_oe_marginal_preserves_nan_inputs():
    raw = np.array([[1.0, np.nan], [np.nan, 1.0]], dtype=np.float32)
    result = coacc.normalize_oe_marginal(raw)
    assert np.all(np.isnan(result))  # diagonal blanked + nan entries stay nan


# ---------------------------------------------------------------------------
# normalize_correlation
# ---------------------------------------------------------------------------

def test_normalize_correlation_perfectly_correlated_columns():
    # Two columns that move together → corr = 1; diagonal blanked.
    accessibility = np.array(
        [
            [0.1, 0.1],
            [0.5, 0.5],
            [0.9, 0.9],
            [0.4, 0.4],
        ],
        dtype=np.float32,
    )
    corr = coacc.normalize_correlation(accessibility, min_coverage=2)
    assert np.isnan(corr[0, 0]) and np.isnan(corr[1, 1])
    np.testing.assert_allclose(corr[0, 1], 1.0, atol=1e-5)
    np.testing.assert_allclose(corr[1, 0], 1.0, atol=1e-5)


def test_normalize_correlation_nans_when_overlap_below_threshold():
    accessibility = np.array(
        [
            [0.1, 0.2],
            [0.5, 0.6],
        ],
        dtype=np.float32,
    )
    corr = coacc.normalize_correlation(accessibility, min_coverage=10)
    assert np.all(np.isnan(corr))


# ---------------------------------------------------------------------------
# build_accessibility_matrix + compute_normalized_matrix
# ---------------------------------------------------------------------------

class _FakeQuery:
    """Minimal AnalysisReadQuery stand-in for build_accessibility_matrix."""

    def __init__(self, reads, region_width=200):
        self._reads = reads
        self.region_width = region_width

    def iter_working_sets(self, _state):
        ws = WorkingSet(
            self._reads,
            total_overlapping=len(self._reads),
            total_spanning=len(self._reads),
            chrom="chr1",
            start=0,
            end=self.region_width,
        )
        yield "ds1", ws


def test_build_accessibility_matrix_with_no_reads_returns_empty():
    query = _FakeQuery([], region_width=200)
    matrix, n_reads = coacc.build_accessibility_matrix(state=None, query=query, bin_size=100)
    assert n_reads == 0
    assert matrix.shape == (0, 2)


def test_build_accessibility_matrix_separates_signal_from_coverage():
    # One read, 200bp region, bin_size=100 → 2 bins.
    # Intervals: [0, 100, 50] (small fp, accessible) + [100, 200, 150] (nucleosome).
    reads = [
        {"id": "r1", "intervals": [[0, 100, 50], [100, 200, 150]]},
    ]
    query = _FakeQuery(reads, region_width=200)
    matrix, n = coacc.build_accessibility_matrix(
        state=None, query=query, bin_size=100, signal_type="accessibility"
    )
    assert n == 1
    # Bin 0: 100bp covered, 100bp accessibility-matching → fraction 1.
    # Bin 1: 100bp covered, 0bp matches accessibility (it's a nucleosome) → 0.
    np.testing.assert_allclose(matrix, np.array([[1.0, 0.0]], dtype=np.float32))


def test_compute_normalized_matrix_runs_with_synthetic_reads():
    # Smoke test: end-to-end with 3 perfectly accessible reads should yield a
    # square output and a non-zero coverage matrix.
    reads = [{"id": f"r{i}", "intervals": [[0, 200, 50]]} for i in range(3)]
    query = _FakeQuery(reads, region_width=200)
    matrix, accessibility, n_reads, raw, coverage = coacc.compute_normalized_matrix(
        state=None,
        query=query,
        actual_bin_size=100,
        normalization="oe",
        min_coverage=1,
        signal_type="accessibility",
    )
    assert n_reads == 3
    assert matrix.shape == (2, 2)
    assert accessibility.shape == (3, 2)
    assert raw.shape == (2, 2)
    np.testing.assert_array_equal(coverage, np.full((2, 2), 3, dtype=np.float32))
