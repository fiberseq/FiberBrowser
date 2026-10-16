"""Micro-C review round 2 (B6): APA windows, virtual 4C O/E, arc positions, expected generations."""
import numpy as np


class _FakeCooler:
    """A cooler whose matrix().fetch((chrom, start, end), ...) slices a dense test matrix."""

    def __init__(self, dense, res):
        self.dense, self.res, self.fetches = dense, res, []

    def matrix(self, balance=False, sparse=False):
        outer = self

        class Sel:
            def fetch(self, rows, cols=None):
                cols = cols or rows
                outer.fetches.append((rows, cols))
                r0, r1 = rows[1] // outer.res, rows[2] // outer.res
                c0, c1 = cols[1] // outer.res, cols[2] // outer.res
                return outer.dense[r0:r1, c0:c1]
        return Sel()


def test_apa_reads_only_peak_windows_and_matches_the_dense_result():
    from services.microc_apa import CoolerWindows, compute_apa_from_matrix
    rng = np.random.default_rng(0)
    n, res = 60, 1000
    dense = rng.random((n, n))
    dense = dense + dense.T
    peaks = [{"start": 10_000, "end": 11_000}, {"start": 30_000, "end": 31_000}, {"start": 50_000, "end": 51_000}]
    want = compute_apa_from_matrix(dense, peaks, resolution=res, window=3000, chrom_nbins=n)
    clr = _FakeCooler(dense, res)
    got = compute_apa_from_matrix(CoolerWindows(clr, "chr1", res, n), peaks, resolution=res, window=3000, chrom_nbins=n)
    np.testing.assert_allclose(np.asarray(got["matrix"]), np.asarray(want["matrix"]))
    assert got["n_pairs"] == want["n_pairs"] == 3
    assert all((r[2] - r[1]) // res == 7 for r, _c in clr.fetches)  # 7x7 windows, never the chromosome


def test_expected_for_a_replaced_map_is_dropped(monkeypatch):
    from types import SimpleNamespace
    import scipy.sparse as sp
    import services.microc_metrics as mm

    state = SimpleNamespace(cool_file="a.mcool", chrom_expected_cache={}, chrom_expected_computing=set(),
                            current_resolution=1000, resolutions=[1000])

    class Matrix:
        def fetch(self, _chrom):
            # Another map is loaded while this one is being read.
            state.cool_file = "b.mcool"
            state.chrom_expected_cache = {}
            return sp.coo_matrix(np.ones((6, 6)))

    class Clr:
        def bins(self):
            return SimpleNamespace(columns=[])

        def matrix(self, balance, sparse):
            return Matrix()

    state.clr = Clr()
    monkeypatch.setattr(mm, "_load_cooler_module", lambda: object())
    assert mm.compute_chrom_expected("chr1", 1000, allow_compute=True, dafc_state=state) is None
    assert state.chrom_expected_cache == {}  # map B's cache stays clean


def test_virtual4c_oe_sums_expected_over_the_viewpoint_bins():
    from routers.microc import virtual4c_oe
    matrix = np.ones((2, 6))  # two viewpoint bins
    expected = np.ones(20)
    np.testing.assert_allclose(virtual4c_oe(matrix, expected, viewpoint_first_bin=2, profile_first_bin=0), 1.0)
    expected = np.arange(1, 21, dtype=float)  # expected[d] = d + 1
    out = virtual4c_oe(matrix, expected, viewpoint_first_bin=2, profile_first_bin=0)
    # profile bin 0: viewpoint bins 2, 3 -> distances 2, 3 -> expected 3 + 4
    assert out[0] == 2 / 7


def test_arc_positions_use_the_cooler_bin_grid(monkeypatch):
    from services.microc_arcs import build_interaction_arcs
    matrix = np.zeros((3, 3))
    matrix[0, 1] = matrix[1, 0] = 50.0
    arcs = build_interaction_arcs(matrix, start=(1500 // 1000) * 1000, resolution=1000, min_dist_bins=1,
                                  max_dist_bins=5, expected_per_dist=None, bin_accessibility=None,
                                  mean_accessibility=None, acc_log=False)
    assert (arcs[0]["start"], arcs[0]["end"]) == (1500, 2500)  # centres of bins [1000,2000) and [2000,3000)
