import numpy as np

from services.microc_matrix import (
    apply_distance_expected,
    cooler_has_balance_weights,
    fetch_cooler_matrix,
    local_expected_per_distance,
    matrix_to_ndarray,
    resolve_cooler_chrom,
    cooler_at_resolution,
)


class _State:
    def __init__(self, clr):
        self.clr = clr


class _SparseLike:
    def __init__(self, matrix):
        self.matrix = matrix

    def toarray(self):
        return self.matrix


class _MatrixSelector:
    def __init__(self, matrix):
        self.matrix = matrix
        self.calls = []

    def fetch(self, *regions):
        self.calls.append(regions)
        return _SparseLike(self.matrix)


class _Cooler:
    def __init__(self, chromsizes=None, matrix=None):
        self.chromsizes = chromsizes or {}
        self.selector = _MatrixSelector(matrix if matrix is not None else np.eye(2))
        self.balance_requested = None

    def matrix(self, balance=False):
        self.balance_requested = balance
        return self.selector


class _FakeWeights:
    def __init__(self, all_nan):
        self.all_nan = all_nan

    def isna(self):
        return self

    def all(self):
        return self.all_nan


class _FakeBins:
    columns = ["weight"]

    def __init__(self, all_nan=False):
        self.all_nan = all_nan

    def __getitem__(self, key):
        if key == "weight":
            return _FakeWeights(self.all_nan)
        raise KeyError(key)


class _BinsSelector:
    def __init__(self, bins):
        self.bins = bins

    def __getitem__(self, _key):
        return self.bins


class _BalancedCooler:
    def __init__(self, bins):
        self._bins = bins

    def bins(self):
        return _BinsSelector(self._bins)


class _ResolutionState:
    def __init__(self):
        self.cool_file = "/tmp/test.mcool"
        self.current_resolution = 1000
        self.resolutions = [1000, 5000]
        self.clr = "initial"


class _CoolerModule:
    opened = []

    @classmethod
    def Cooler(cls, uri):
        cls.opened.append(uri)
        return f"cooler:{uri}"


def test_cooler_at_resolution_never_switches_the_shared_handle():
    import services.microc_matrix as mm
    mm._COOLER_HANDLES.clear()
    state = _ResolutionState()
    shared_clr, shared_res = state.clr, state.current_resolution
    _CoolerModule.opened = []

    view, requested = cooler_at_resolution(state, 5000, _CoolerModule)
    same, invalid = cooler_at_resolution(state, 10000, _CoolerModule)
    again, _ = cooler_at_resolution(state, 5000, _CoolerModule)

    # An unknown resolution: the loaded handle, and its own resolution (so coordinates match).
    assert requested == 5000 and invalid == shared_res
    assert view.current_resolution == 5000
    assert view.clr == "cooler:/tmp/test.mcool::/resolutions/5000"
    # Unknown resolution: the loaded one, as a request-local snapshot.
    assert same is not state and (same.clr, same.current_resolution) == (shared_clr, shared_res)
    assert (state.clr, state.current_resolution) == (shared_clr, shared_res)
    assert again.clr is view.clr  # handles are reused
    assert _CoolerModule.opened == ["/tmp/test.mcool::/resolutions/5000"]


def test_resolve_cooler_chrom_tries_browser_variants():
    state = _State(_Cooler(chromsizes={"chr2R": 1000}))

    assert resolve_cooler_chrom(state, "2R") == "chr2R"
    assert resolve_cooler_chrom(state, "chr2R") == "chr2R"
    assert resolve_cooler_chrom(state, "3L") is None


def test_matrix_to_ndarray_converts_sparse_like_output():
    out = matrix_to_ndarray(_SparseLike([[1, 2], [3, 4]]), dtype=np.float32)

    assert out.dtype == np.float32
    np.testing.assert_array_equal(out, np.array([[1, 2], [3, 4]], dtype=np.float32))


def test_fetch_cooler_matrix_handles_square_and_rectangular_regions():
    clr = _Cooler(matrix=np.array([[1, 2], [3, 4]]))

    square = fetch_cooler_matrix(clr, "chr1:0-100", balance=True)
    rectangular = fetch_cooler_matrix(clr, "chr1:0-100", "chr1:200-300", balance=False)

    assert clr.selector.calls == [("chr1:0-100",), ("chr1:0-100", "chr1:200-300")]
    np.testing.assert_array_equal(square, np.array([[1, 2], [3, 4]], dtype=np.float64))
    np.testing.assert_array_equal(rectangular, np.array([[1, 2], [3, 4]], dtype=np.float64))


def test_cooler_has_balance_weights_rejects_missing_or_all_nan_weights():
    assert cooler_has_balance_weights(_BalancedCooler(_FakeBins(all_nan=False))) is True
    assert cooler_has_balance_weights(_BalancedCooler(_FakeBins(all_nan=True))) is False


def test_local_expected_per_distance_supports_nanmean_and_positive_floor():
    matrix = np.array(
        [
            [2.0, 4.0, 0.0],
            [4.0, np.nan, 8.0],
            [0.0, 8.0, 10.0],
        ]
    )

    nanmean_expected = local_expected_per_distance(matrix, max_dist=3)
    positive_expected = local_expected_per_distance(
        np.zeros((3, 3)),
        max_dist=3,
        start_dist=1,
        use_nanmean=False,
        positive_only=True,
    )

    np.testing.assert_allclose(nanmean_expected, [6.0, 6.0, 0.001])
    np.testing.assert_allclose(positive_expected, [0.001, 0.001, 0.001])


def test_apply_distance_expected_preserves_or_zeros_out_of_range_cells():
    matrix = np.array([[4.0, 6.0], [8.0, 10.0]])
    expected = np.array([2.0])

    preserved = apply_distance_expected(matrix, expected, invalid_fill="matrix")
    zeroed = apply_distance_expected(matrix, expected, invalid_fill="zero")

    np.testing.assert_allclose(preserved, [[2.0, 6.0], [8.0, 5.0]])
    np.testing.assert_allclose(zeroed, [[2.0, 0.0], [0.0, 5.0]])
