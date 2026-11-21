"""One Benjamini-Hochberg: services.fdr, checked against the five copies it replaced (kept here as references) and
against hand-computed values."""
import math
import random

import numpy as np
import pytest

from services.fdr import bh_qvalues


# --- the replaced implementations, verbatim in logic ---------------------------------------------------------------
def old_motif_bh(pvalues):
    idx = [i for i, p in enumerate(pvalues) if p is not None]
    q = [None] * len(pvalues)
    m = len(idx)
    if not m:
        return q
    order = sorted(idx, key=lambda i: pvalues[i])
    running = 1.0
    for rank in range(m, 0, -1):
        i = order[rank - 1]
        running = min(running, pvalues[i] * m / rank)
        q[i] = min(1.0, running)
    return q


def old_patches_bh(p):
    n = len(p)
    order = sorted(range(n), key=lambda i: p[i])
    q = [0.0] * n
    running = 1.0
    for rank in range(n - 1, -1, -1):
        i = order[rank]
        running = min(running, p[i] * n / (rank + 1))
        q[i] = min(1.0, running)
    return q


def old_footprint_bh(p_values):
    if not p_values:
        return []
    clean = [min(1.0, max(0.0, float(p))) if np.isfinite(p) else 1.0 for p in p_values]
    order = sorted(range(len(clean)), key=lambda index: (clean[index], index))
    adjusted = [1.0] * len(clean)
    running_min = 1.0
    for reverse_index in range(len(order) - 1, -1, -1):
        original_index = order[reverse_index]
        rank = reverse_index + 1
        running_min = min(running_min, clean[original_index] * len(clean) / rank)
        adjusted[original_index] = min(1.0, running_min)
    return adjusted


def old_cluster_bh(pvals):
    pvals = np.asarray(pvals, dtype=np.float64)
    m = pvals.size
    order = np.argsort(pvals, kind="stable")
    ranked = pvals[order] * m / np.arange(1, m + 1)
    ranked = np.minimum.accumulate(ranked[::-1])[::-1]
    q = np.empty_like(pvals)
    q[order] = np.minimum(ranked, 1.0)
    return q


def old_ts_bh(p_values):  # utils/statistics.ts benjaminiHochberg
    if not p_values:
        return []
    idx = sorted(((max(0, min(1, p if math.isfinite(p) else 1)), i) for i, p in enumerate(p_values)))
    out = [0.0] * len(p_values)
    running = 1.0
    for k in range(len(idx) - 1, -1, -1):
        running = min(running, idx[k][0] * len(idx) / (k + 1))
        out[idx[k][1]] = min(1.0, running)
    return out


def _cases():
    rnd = random.Random(7)
    yield []
    yield [0.5]
    yield [0.01, 0.04, 0.03]
    yield [0.02, 0.02, 0.02, 0.5, 0.0]
    for n in (5, 37, 400):
        yield [rnd.random() ** 3 for _ in range(n)]
        yield [round(rnd.random(), 2) for _ in range(n)]  # many ties


@pytest.mark.parametrize("ps", list(_cases()))
def test_unchanged_against_every_replaced_copy(ps):
    new = bh_qvalues(ps)
    assert new == old_motif_bh(ps)
    assert new == old_patches_bh(ps)
    assert new == old_footprint_bh(ps)
    assert new == old_ts_bh(ps)
    assert np.array_equal(np.asarray(new, dtype=float), old_cluster_bh(ps)) or not ps


def test_missing_values():
    ps = [0.01, None, float("nan"), 0.04, float("inf"), 0.03]
    assert bh_qvalues(ps) == old_motif_bh([0.01, None, None, 0.04, None, 0.03])
    assert bh_qvalues(ps, missing="one") == old_footprint_bh([0.01, 1.0, float("nan"), 0.04, float("inf"), 0.03])
    with pytest.raises(ValueError):
        bh_qvalues(ps, missing="drop")


def test_hand_values():
    assert bh_qvalues([0.01, 0.04, 0.03]) == [0.03, 0.04, 0.04]
    assert bh_qvalues([1.5, -0.1]) == [1.0, 0.0]  # clipped to [0, 1]


def test_callers_use_it():
    from services.cluster_analysis import _two_proportion_qvalues
    from services.footprint_analysis import benjamini_hochberg
    from services.motif_scoring import bh
    from services.nuc.patches import _bh_adjusted
    ps = [0.2, 0.001, 0.05, 0.05, 0.9]
    assert bh(ps) == _bh_adjusted(ps) == benjamini_hochberg(ps) == bh_qvalues(ps)
    q = _two_proportion_qvalues(np.array([0.1, 0.5, 0.9]), np.array([0.1, 0.6, 0.2]), 100, 100)
    assert q.shape == (3,) and q[0] == 1.0 and q[2] < 1e-10
