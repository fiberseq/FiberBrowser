"""Micro-C normalization and accessibility-correction helpers."""
from __future__ import annotations

import time
from importlib.util import find_spec
from typing import Dict, Optional, Tuple

import numpy as np

from services.dafc_diagnostics import log_dafc_diagnostic
from state.dependencies import get_dafc_state, get_state

HAS_COOLER = find_spec("cooler") is not None
_cooler_module = None


def _load_cooler_module():
    global HAS_COOLER, _cooler_module
    if _cooler_module is not None:
        return _cooler_module
    try:
        import cooler as cooler_module
    except ImportError:
        HAS_COOLER = False
        return None
    _cooler_module = cooler_module
    HAS_COOLER = True
    return _cooler_module


def _log(message: str) -> None:
    log_dafc_diagnostic(message)


def compute_chrom_expected(
    chrom: str,
    resolution: int,
    allow_compute: bool = False,
    dafc_state=None,
    balance: bool = False,
) -> Optional[np.ndarray]:
    """
    Get cached expected contact frequency per distance for a chromosome.

    Returns an array where index d gives the mean contact count over every
    valid bin pair d bins apart (pairs with no stored contacts count as 0).
    ``balance`` must match the observations it divides: the O/E endpoints fetch
    raw counts, so the default is raw.
    """
    if dafc_state is None:
        dafc_state = get_dafc_state()
    cooler_module = _load_cooler_module()
    if cooler_module is None or dafc_state.clr is None:
        return None

    cache_key = (chrom, resolution, bool(balance))
    if cache_key in dafc_state.chrom_expected_cache:
        return dafc_state.chrom_expected_cache[cache_key]
    if not allow_compute:
        return None
    if cache_key in dafc_state.chrom_expected_computing:
        return None

    # The map this computation reads: if another one is loaded meanwhile, the
    # result is dropped instead of landing in the new map's cache.
    source_file = dafc_state.cool_file
    cache = dafc_state.chrom_expected_cache
    try:
        dafc_state.chrom_expected_computing.add(cache_key)
        start_time = time.time()

        clr = dafc_state.clr
        if resolution != dafc_state.current_resolution and resolution in dafc_state.resolutions:
            from services.cooler_open import open_cooler
            clr = open_cooler(cooler_module, dafc_state.cool_file, resolution)

        has_balance = bool(balance) and "weight" in clr.bins().columns
        chrom_matrix = clr.matrix(balance=has_balance, sparse=True).fetch(chrom)
        chrom_n = chrom_matrix.shape[0]
        max_dist_bins = min(chrom_n, 10000)

        coo = chrom_matrix.tocoo()
        rows, cols, data = coo.row, coo.col, coo.data.astype(np.float64)

        mask = (cols > rows) & ((cols - rows) >= 2)
        distances = (cols - rows)[mask]
        values = data[mask]

        valid_vals = ~np.isnan(values)
        distances = distances[valid_vals]
        values = values[valid_vals]

        valid_mask = distances <= max_dist_bins
        distances = distances[valid_mask]
        values = values[valid_mask]

        if len(distances) > 0:
            dist_sums = np.bincount(distances, weights=values, minlength=max_dist_bins + 1)[:max_dist_bins + 1]
            # The mean is over all valid bin pairs at each distance, not just the
            # stored (nonzero) pixels: n - d pairs, or with balancing only pairs
            # of bins that have a weight.
            dist_valid_counts = valid_pair_counts(
                chrom_n, max_dist_bins,
                clr.bins().fetch(chrom)["weight"].to_numpy() if has_balance else None,
            )
            with np.errstate(divide="ignore", invalid="ignore"):
                expected_per_dist = np.where(
                    dist_valid_counts > 0,
                    dist_sums / dist_valid_counts,
                    np.nan,
                )
        else:
            expected_per_dist = np.full(max_dist_bins + 1, np.nan)

        from scipy.ndimage import uniform_filter1d

        log_expected = np.log1p(np.nan_to_num(expected_per_dist, nan=0.0))
        smoothed = uniform_filter1d(log_expected, size=5)
        expected_per_dist = np.expm1(smoothed)

        nonzero = expected_per_dist[expected_per_dist > 0]
        floor = float(nonzero.min()) * 0.01 if len(nonzero) > 0 else 1e-6
        expected_per_dist[expected_per_dist <= 0] = floor
        expected_per_dist[np.isnan(expected_per_dist)] = floor

        elapsed = time.time() - start_time
        if dafc_state.cool_file != source_file or dafc_state.chrom_expected_cache is not cache:
            _log(f"[MICROC] Dropped expected for {chrom}: another contact map was loaded meanwhile")
            return None
        dafc_state.chrom_expected_cache[cache_key] = expected_per_dist
        _log(
            f"[MICROC] Cached expected values for {chrom} at {resolution}bp "
            f"({max_dist_bins} distances, balanced={has_balance}) in {elapsed:.2f}s"
        )
        return expected_per_dist

    except Exception as e:
        _log(f"[MICROC] Failed to compute expected for {chrom}: {e}")
        return None
    finally:
        dafc_state.chrom_expected_computing.discard(cache_key)


def valid_pair_counts(n_bins: int, max_dist: int, weights=None) -> np.ndarray:
    """Number of bin pairs (i, i+d) for d = 0..max_dist, counting only bins with
    a finite weight when ``weights`` is given (an autocorrelation of the valid mask)."""
    n = int(n_bins)
    d = np.arange(int(max_dist) + 1)
    if weights is None:
        return np.maximum(n - d, 0).astype(np.float64)
    valid = np.isfinite(np.asarray(weights, dtype=np.float64)).astype(np.float64)[:n]
    size = 1 << int(np.ceil(np.log2(max(2, 2 * n))))
    spectrum = np.fft.rfft(valid, size)
    auto = np.fft.irfft(spectrum * np.conj(spectrum), size)[: len(d)]
    counts = np.rint(np.clip(auto, 0, None))
    if len(counts) < len(d):
        counts = np.concatenate([counts, np.zeros(len(d) - len(counts))])
    return counts


from services.byte_cache import shared_cache
_bin_accessibility_cache = shared_cache('profiles')


def clear_bin_accessibility_cache() -> None:
    _bin_accessibility_cache.clear()


def compute_bin_accessibility(chrom: str, start: int, end: int, bin_size: int, state=None) -> np.ndarray:
    """Compute per-bin accessibility from fiber-seq data."""
    if state is None:
        state = get_state()
    # The datasets it's computed from are part of the key: another session, or
    # a replaced dataset, must not get this signal.
    sources = tuple(sorted(
        (str(getattr(d, "id", "")), tuple(str(p) for p in (getattr(d, "paths", None) or ())))
        for d in state.datasets.values() if getattr(d, "data_type", None) in ("bam", "bigbed")
    ))
    cache_key = (chrom, start, end, bin_size, sources)
    if cache_key in _bin_accessibility_cache:
        return _bin_accessibility_cache[cache_key]

    n_bins = (end - start + bin_size - 1) // bin_size
    base_accessibility = np.zeros(end - start, dtype=np.float64)
    base_counts = np.zeros(end - start, dtype=np.float64)

    for dataset in state.datasets.values():
        if dataset.data_type not in ("bam", "bigbed"):
            continue

        try:
            reads_df = dataset.get_reads(chrom, start, end, spanning=False)
            if reads_df is None or reads_df.empty:
                continue

            numeric_cols = sorted([
                c for c in reads_df.columns
                if c != "read_id" and not str(c).startswith("_") and isinstance(c, (int, np.integer))
            ])
            if not numeric_cols:
                continue

            arr = reads_df[numeric_cols].to_numpy(dtype=np.float32)
            col_positions = np.array([int(c) - start for c in numeric_cols])

            has_coverage = arr != 0
            is_accessible = (arr < 90) & has_coverage

            for i, pos in enumerate(col_positions):
                if 0 <= pos < (end - start):
                    base_counts[pos] += has_coverage[:, i].sum()
                    base_accessibility[pos] += is_accessible[:, i].sum()

        except Exception as e:
            _log(f"[ACC] Error computing accessibility for dataset {dataset.id}: {e}")
            continue

    bin_accessibility = np.zeros(n_bins)
    for b in range(n_bins):
        bin_start = b * bin_size
        bin_end = min((b + 1) * bin_size, end - start)
        bin_counts = base_counts[bin_start:bin_end].sum()
        bin_acc = base_accessibility[bin_start:bin_end].sum()
        bin_accessibility[b] = bin_acc / bin_counts if bin_counts > 0 else 0.5

    bin_accessibility = np.clip(bin_accessibility, 0.01, 0.99)

    _bin_accessibility_cache[cache_key] = bin_accessibility
    _log(
        f"[ACC] Computed bin accessibility for {chrom}:{start}-{end} "
        f"({n_bins} bins): mean={bin_accessibility.mean():.3f}, "
        f"min={bin_accessibility.min():.3f}, max={bin_accessibility.max():.3f}"
    )
    return bin_accessibility
