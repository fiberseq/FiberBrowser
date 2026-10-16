"""Contact and co-accessibility normalisation review fixes (B6)."""
from types import SimpleNamespace

import numpy as np
import pandas as pd


def test_marginal_oe_is_one_for_independent_fractional_accessibility():
    from services.coaccessibility import compute_raw_matrix, normalize_oe_marginal
    # 20 reads, each 50% accessible in every bin: independent, so O/E = 1 (not 4).
    acc = np.full((20, 4), 0.5, dtype=np.float32)
    raw, _ = compute_raw_matrix(acc, min_coverage=1)
    oe = normalize_oe_marginal(raw, acc)
    off = ~np.eye(4, dtype=bool)
    np.testing.assert_allclose(oe[off], 1.0, rtol=1e-6)


def test_marginal_oe_uses_the_reads_covering_each_pair():
    from services.coaccessibility import compute_raw_matrix, normalize_oe_marginal
    # Bin 2 is covered only by reads 0-1 (open), so bins 0/1 marginals for the
    # (0,2) pair come from those reads too.
    acc = np.array([[1, 1, 1], [1, 0, 1], [0, 1, np.nan], [0, 0, np.nan]], dtype=np.float32)
    raw, _ = compute_raw_matrix(acc, min_coverage=1)
    oe = normalize_oe_marginal(raw, acc)
    # Pair (0,2): reads 0,1 -> E[a0]=1, E[a2]=1, E[a0 a2]=1 -> O/E 1.
    assert oe[0, 2] == 1.0
    # Pair (0,1): all 4 reads -> E[a0]=.5, E[a1]=.5, E[a0 a1]=.25 -> O/E 1.
    assert abs(oe[0, 1] - 1.0) < 1e-6


def test_valid_pair_counts_count_zero_contact_pairs():
    from services.microc_metrics import valid_pair_counts
    np.testing.assert_array_equal(valid_pair_counts(10, 3), [10, 9, 8, 7])
    weights = np.array([1, np.nan, 1, 1, 1], dtype=float)  # bin 1 masked
    # d=0: 4 valid bins; d=1: (2,3),(3,4); d=2: (0,2),(2,4); d=3: (0,3); d=4: (0,4)
    np.testing.assert_array_equal(valid_pair_counts(5, 4, weights), [4, 2, 2, 1, 1])


def test_off_diagonal_blocks_use_genomic_distance():
    from services.microc_matrix import apply_distance_expected, local_expected_per_distance
    matrix = np.ones((2, 3))
    expected = np.arange(1, 200, dtype=float)  # expected[d] = d + 1
    # Rows start at bin 100 (Y), columns at bin 0 (X): cell [0, 0] is 100 bins apart.
    out = apply_distance_expected(matrix, expected, row_origin=100, col_origin=0)
    assert out[0, 0] == 1.0 / 101
    assert out[1, 2] == 1.0 / 100  # |101 - 2| = 99
    local = local_expected_per_distance(np.array([[4.0, 2.0]]), row_origin=10, col_origin=0)
    assert local[10] == 4.0 and local[9] == 2.0


def test_chrom_expected_averages_over_all_valid_pairs_and_matches_raw_observations(monkeypatch):
    import scipy.sparse as sp
    import services.microc_metrics as mm

    n = 12
    dense = np.zeros((n, n))
    dense[0, 3] = 10.0  # one count at distance 3; the other n-3-1 pairs are zero

    class FakeMatrix:
        def __init__(self, balance):
            self.balance = balance

        def fetch(self, _chrom):
            return sp.coo_matrix(dense)

    class FakeCooler:
        def bins(self):
            return SimpleNamespace(columns=["weight"], fetch=lambda _c: pd.DataFrame({"weight": np.ones(n)}))

        def matrix(self, balance, sparse):
            FakeCooler.balance_used = balance
            return FakeMatrix(balance)

    monkeypatch.setattr(mm, "_load_cooler_module", lambda: object())
    import scipy.ndimage
    monkeypatch.setattr(scipy.ndimage, "uniform_filter1d", lambda a, size: a)  # no smoothing: check the mean
    state = SimpleNamespace(clr=FakeCooler(), chrom_expected_cache={}, chrom_expected_computing=set(),
                            current_resolution=1000, resolutions=[1000], cool_file="x")
    expected = mm.compute_chrom_expected("chr1", 1000, allow_compute=True, dafc_state=state)
    assert FakeCooler.balance_used is False  # raw, like the O/E observations
    assert abs(expected[3] - 10.0 / (n - 3)) < 1e-9  # mean over all 9 pairs, not the one stored pixel
    assert ("chr1", 1000, False) in state.chrom_expected_cache


def test_bin_accessibility_cache_is_per_dataset_set():
    import services.microc_metrics as mm
    mm.clear_bin_accessibility_cache()

    def dataset(ds_id, value):
        df = pd.DataFrame({"read_id": ["r"], 100: [value], 101: [value]})
        return SimpleNamespace(id=ds_id, paths=[f"/{ds_id}.bam"], data_type="bam",
                               get_reads=lambda *a, **k: df)

    a = SimpleNamespace(datasets={"a": dataset("a", 10)})    # small footprint -> accessible
    b = SimpleNamespace(datasets={"b": dataset("b", 150)})   # nucleosome -> closed
    acc_a = mm.compute_bin_accessibility("chr1", 100, 102, 2, state=a)
    acc_b = mm.compute_bin_accessibility("chr1", 100, 102, 2, state=b)
    assert not np.array_equal(acc_a, acc_b)
