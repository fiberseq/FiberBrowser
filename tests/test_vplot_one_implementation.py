"""The V-plot paths share one counting and one finishing (services/vplot_matrix.py): the Footprints class V-plot
(accumulate_profile_and_vplot, normalized_vplot_matrix) gives the numbers its replaced code gave (kept here)."""
import random
from types import SimpleNamespace

import numpy as np
import pytest

from services.footprint_analysis import accumulate_profile_and_vplot
from services.footprint_endpoint import normalized_vplot_matrix


def old_accumulate(table, footprints, profile_window, size_min, size_max, size_bin, pos_bin):
    n_size_bins = max(0, (size_max - size_min) // size_bin) if size_bin > 0 else 0
    n_pos_bins = max(0, (2 * profile_window) // pos_bin) if pos_bin > 0 else 0
    agg = np.zeros(2 * profile_window + 1, dtype=float)
    vp = np.zeros((n_size_bins, n_pos_bins), dtype=float)
    centers = (table.starts + table.ends) // 2
    size_idx = ((table.sizes - size_min) // size_bin).astype(np.intp) if size_bin > 0 else np.zeros_like(table.sizes)
    size_valid = (size_bin > 0) & (table.sizes >= size_min) & (table.sizes < size_max) & (size_idx >= 0) & (size_idx < n_size_bins)
    for f in footprints:
        center = (int(f["absStart"]) + int(f["absEnd"])) // 2
        rel = centers - center
        inp = (rel >= -profile_window) & (rel <= profile_window)
        if np.any(inp):
            np.add.at(agg, (rel[inp] + profile_window).astype(np.intp), 1)
        if n_size_bins == 0 or n_pos_bins == 0 or pos_bin <= 0:
            continue
        pos_idx = ((rel + profile_window) // pos_bin).astype(np.intp)
        inv = size_valid & (pos_idx >= 0) & (pos_idx < n_pos_bins)
        if np.any(inv):
            np.add.at(vp, (size_idx[inv], pos_idx[inv]), 1)
    return agg, vp


def old_normalized(vp, smooth=0, log=False):
    if vp.size == 0:
        return [[] for _ in range(vp.shape[0])]
    if smooth > 0:
        from scipy.ndimage import gaussian_filter
        vp = gaussian_filter(vp.astype(float), sigma=smooth)
    if log:
        vp = np.log1p(vp)
    m = float(vp.max()) if vp.max() > 0 else 1
    return [[float(x / m) for x in row] for row in vp]


def table(seed, n=3000):
    rnd = np.random.default_rng(seed)
    starts = rnd.integers(9000, 13000, n)
    sizes = rnd.integers(1, 400, n)
    ends = starts + sizes
    return SimpleNamespace(starts=starts, ends=ends, sizes=sizes, empty=False, centers=(starts + ends) // 2)


@pytest.mark.parametrize("seed", range(4))
@pytest.mark.parametrize("bins", [(10, 300, 5, 10), (0, 200, 7, 3), (30, 250, 20, 25)])
def test_class_vplot_counts_unchanged(seed, bins, monkeypatch):
    import services.public_limits as pl
    monkeypatch.setattr(pl, "check_public_allocation", lambda **k: None)
    t = table(seed)
    rnd = random.Random(seed)
    fps = [{"absStart": (a := rnd.randint(10000, 12000)), "absEnd": a + rnd.randint(1, 80)} for _ in range(5)]
    size_min, size_max, size_bin, pos_bin = bins
    agg, vp = accumulate_profile_and_vplot(t, fps, 400, size_min, size_max, size_bin, pos_bin)
    agg0, vp0 = old_accumulate(t, fps, 400, size_min, size_max, size_bin, pos_bin)
    assert np.array_equal(agg, agg0) and np.array_equal(vp, vp0)


@pytest.mark.parametrize("smooth,log", [(0, False), (0, True), (1.0, False), (1.5, True)])
def test_class_vplot_finishing_unchanged(smooth, log):
    vp = np.random.default_rng(3).poisson(2.0, (12, 40)).astype(float)
    assert normalized_vplot_matrix(vp, smooth, log) == old_normalized(vp, smooth, log)
    assert normalized_vplot_matrix(np.zeros((0, 5))) == old_normalized(np.zeros((0, 5)))
