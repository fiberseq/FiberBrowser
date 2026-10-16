"""Shared cooler matrix helpers for DAF-C and Micro-C endpoints."""
from __future__ import annotations

import copy
import threading
from typing import Callable, Optional

import numpy as np

from utils.chrom import get_chrom_variants


_COOLER_HANDLES: dict = {}
_COOLER_HANDLES_LOCK = threading.Lock()


def cooler_at_resolution(dafc_state, resolution: Optional[int], cooler_module):
    """(state for this request, resolution): the loaded cooler at a requested resolution.

    The contact map is shared by every browser tab (and every visitor on a
    public server), so a request never switches the shared handle: it gets a
    shallow copy with its own handle and resolution. Caches stay shared.
    The copy is taken at every resolution: loading another map rebinds the
    shared state's handle, file and expected cache, and a request that awaits
    mid-way must keep reading one map's counts and expectations.
    """
    requested = resolution or dafc_state.current_resolution
    if requested == dafc_state.current_resolution or requested not in dafc_state.resolutions:
        # A resolution the file doesn't have: the loaded one is what the matrix
        # is binned at, so that's the resolution coordinates must use.
        return copy.copy(dafc_state), dafc_state.current_resolution
    from services.cooler_open import map_token
    key = (dafc_state.cool_file, requested, map_token(dafc_state.cool_file))  # a reloaded s3:// map is reread
    with _COOLER_HANDLES_LOCK:
        handle = _COOLER_HANDLES.get(key)
        if handle is None:
            from services.cooler_open import open_cooler
            handle = open_cooler(cooler_module, dafc_state.cool_file, requested)
            _COOLER_HANDLES[key] = handle
    view = copy.copy(dafc_state)
    view.clr = handle
    view.current_resolution = requested
    return view, requested


def resolve_cooler_chrom(dafc_state, chrom: str) -> Optional[str]:
    """Resolve a browser chromosome name against the loaded cooler."""
    clr = getattr(dafc_state, "clr", None)
    if clr is None or chrom is None:
        return None

    chromsizes = getattr(clr, "chromsizes", {})
    if chrom in chromsizes:
        return chrom

    for variant in get_chrom_variants(chrom):
        if variant in chromsizes:
            return variant
    return None


def matrix_to_ndarray(matrix, dtype=np.float64) -> np.ndarray:
    """Convert cooler/sparse matrix output into a dense numpy array."""
    if hasattr(matrix, "toarray"):
        matrix = matrix.toarray()
    return np.asarray(matrix, dtype=dtype)


# Dense matrices are fetched whole; past this many cells (6,000 x 6,000 bins,
# ~290 MB as float64) a request is refused instead of exhausting memory.
MAX_MATRIX_CELLS = 36_000_000


class MatrixTooLarge(ValueError):
    """A dense contact-matrix request larger than MAX_MATRIX_CELLS."""


def _region_bins(clr, region: str) -> Optional[int]:
    try:
        lo, hi = clr.extent(region)
        return max(0, int(hi) - int(lo))
    except Exception:
        return None  # a cooler without extent(): no budget check


def fetch_cooler_matrix(
    clr,
    row_region: str,
    col_region: Optional[str] = None,
    *,
    balance: bool = False,
    dtype=np.float64,
    max_cells: int = MAX_MATRIX_CELLS,
) -> np.ndarray:
    """Fetch a dense cooler matrix for square or rectangular regions.

    Raises MatrixTooLarge before fetching when the region holds more than
    ``max_cells`` cells at this resolution.
    """
    rows = _region_bins(clr, row_region)
    cols = rows if col_region is None else _region_bins(clr, col_region)
    if rows is not None and cols is not None and rows * cols > max_cells:
        raise MatrixTooLarge(
            f"That region is {rows:,} x {cols:,} bins at this resolution, more than the "
            f"{max_cells:,}-cell limit; zoom in or choose a coarser resolution")
    selector = clr.matrix(balance=balance)
    if col_region is None:
        matrix = selector.fetch(row_region)
    else:
        matrix = selector.fetch(row_region, col_region)
    return matrix_to_ndarray(matrix, dtype=dtype)


def cooler_has_balance_weights(clr, logger: Optional[Callable[[str], None]] = None) -> bool:
    """Return whether the cooler exposes usable balance weights."""
    try:
        bins = clr.bins()[:]
        return "weight" in bins.columns and not bins["weight"].isna().all()
    except Exception as exc:
        if logger is not None:
            logger(f"[MICROC] Error checking balance weights: {exc}")
        return False


def local_expected_per_distance(
    matrix,
    max_dist: Optional[int] = None,
    *,
    start_dist: int = 0,
    use_nanmean: bool = True,
    positive_only: bool = False,
    floor: float = 0.001,
    row_origin: int = 0,
    col_origin: int = 0,
) -> np.ndarray:
    """Compute local expected contact values from matrix diagonals.

    ``row_origin``/``col_origin`` are the first row/column bins on the
    chromosome: an off-diagonal block (two different regions) groups its cells
    by their true genomic distance instead of by matrix diagonal.
    """
    matrix = np.asarray(matrix, dtype=np.float64)
    # An off-diagonal block, or a rectangle (whose diagonals past the row
    # count still hold cells): group cells by absolute bin distance.
    if matrix.ndim == 2 and matrix.size > 0 and (row_origin != col_origin or matrix.shape[0] != matrix.shape[1]):
        dist = absolute_bin_distances(matrix.shape, row_origin, col_origin)
        n_dist = int(max_dist) if max_dist is not None else int(dist.max()) + 1
        vals = matrix.ravel()
        d = dist.ravel()
        keep = (d < n_dist) & (d >= max(0, start_dist))
        if use_nanmean or positive_only:
            keep &= ~np.isnan(vals)
        sums = np.bincount(d[keep], weights=vals[keep], minlength=n_dist)[:n_dist]
        counts = np.bincount(d[keep], minlength=n_dist)[:n_dist]
        with np.errstate(divide="ignore", invalid="ignore"):
            expected = np.where(counts > 0, sums / counts, 0.0)
        expected[np.isnan(expected) | (expected == 0)] = floor
        return expected
    if matrix.ndim != 2 or matrix.size == 0:
        return np.array([], dtype=np.float64)

    n_dist = int(max_dist) if max_dist is not None else max(matrix.shape)
    n_dist = max(0, n_dist)
    expected = np.zeros(n_dist, dtype=np.float64)

    limit = min(n_dist, matrix.shape[0])
    for dist in range(max(0, start_dist), limit):
        diag = np.diag(matrix, dist)
        if len(diag) == 0:
            continue
        if positive_only:
            expected[dist] = np.mean(diag) if np.any(diag > 0) else floor
        elif use_nanmean:
            expected[dist] = np.nanmean(diag)
        else:
            expected[dist] = np.mean(diag)

    expected[np.isnan(expected) | (expected == 0)] = floor
    return expected


def absolute_bin_distances(shape, row_origin: int = 0, col_origin: int = 0) -> np.ndarray:
    """Genomic distance in bins of every cell of a (rows x cols) block whose
    first row/column are the chromosome bins ``row_origin``/``col_origin``."""
    h, w = shape
    return np.abs((int(row_origin) + np.arange(h))[:, None] - (int(col_origin) + np.arange(w))[None, :])


def apply_distance_expected(
    matrix,
    expected_per_dist,
    *,
    invalid_fill: str = "matrix",
    row_origin: int = 0,
    col_origin: int = 0,
) -> np.ndarray:
    """Divide a matrix by expected values indexed by bin distance (genomic
    distance, for an off-diagonal block with different row/column origins)."""
    matrix = np.asarray(matrix, dtype=np.float64)
    expected = np.asarray(expected_per_dist, dtype=np.float64)
    if matrix.ndim != 2 or matrix.size == 0 or expected.size == 0:
        return matrix

    dist_matrix = absolute_bin_distances(matrix.shape, row_origin, col_origin)
    valid = dist_matrix < len(expected)
    exp_vals = expected[np.clip(dist_matrix, 0, len(expected) - 1)]
    exp_vals[exp_vals == 0] = 1.0

    normalized = matrix / exp_vals
    if invalid_fill == "zero":
        return np.where(valid, normalized, 0.0)
    return np.where(valid, normalized, matrix)
