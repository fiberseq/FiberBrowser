"""Exact shift-null windows with reused integer prefix sums and compact convolution storage.

Keep NumPy's convolution, molecule order and final full-length tail reduction: trimming the
polynomials themselves or using an FFT changes floating-point p-values. Zero margins are
retained around the compact support so NumPy uses the original boundary/interior kernels.
"""
from __future__ import annotations

import numpy as np
from numba import njit
from fiberhmm.nuc.enrichment import MeasuredTrack


@njit(cache=True)
def _counts(x, m, K):
    L = len(x)
    counts = np.zeros(K + 1, dtype=np.int64)
    c = 0
    for i in range(m):
        c += x[i % L]
    for i in range(L):
        v = int(np.floor(K * c / m + 1e-9))
        counts[min(K, max(0, v))] += 1
        c += x[(i + m) % L] - x[i]
    return counts


class WindowTrack(MeasuredTrack):
    def __init__(self, measured):
        super().__init__(measured)
        self.prefix = {}
        self.info = {}

    def set_kind(self, kind, intervals):
        x = np.zeros(self.length, dtype=np.int8)
        for a, b in intervals:
            i, j = self.index(int(a)), self.index(int(b))
            if j > i:
                x[i:j] = 1
        self.x[kind] = x
        dtype = np.int32 if self.length < 2**31 else np.int64
        self.prefix[kind] = np.concatenate((np.zeros(1, dtype=dtype), np.cumsum(x, dtype=dtype)))

    def pmf(self, kind, m, K=10):
        key = kind, m, K
        got = self.info.get(key)
        if got is None:
            total = self.prefix[kind][-1]
            if total == 0 or total == self.length:
                p = np.zeros(K + 1)
                p[K if total else 0] = 1.0
            else:
                p = _counts(self.x[kind], m, K) / float(self.length)
            nz = np.flatnonzero(p)
            got = p, float(np.dot(np.arange(K + 1), p)), int(nz[0]), int(nz[-1])
            self.info[key] = got
        return got


def tail_probability(pmfs, obs):
    """Same sequential convolutions and tail sum as window_test, skipping zero-only work."""
    d, offset, size = np.ones(1), 0, 1
    for index, (p, _expected, lo, hi) in enumerate(pmfs):
        K = len(p) - 1
        if lo == hi and p[lo] == 1.0:
            offset += lo
            size += K
            continue
        left, right = min(K, offset), min(K, size - offset - len(d))
        if left or right:
            d = np.pad(d, (left, right))
        d = np.convolve(d, p)
        offset -= left
        size += K
        # Amortise support searches; all skipped entries are exact zeros, including underflow.
        if index % 32 == 0:
            nz = np.flatnonzero(d)
            if not len(nz):
                return 0.0
            a, b = int(nz[0]), int(nz[-1]) + 1
            offset += a
            d = d[a:b]
    full = np.zeros(size)
    full[offset:offset + len(d)] = d
    return float(min(1.0, full[obs:].sum()))


def window_tests(tracks, kinds, starts, width, K, minimum):
    """All kinds on the same grid, sharing membership and integer covered-base queries."""
    starts = np.asarray(starts, dtype=np.int64)
    by_window = [[] for _ in starts]
    for t in tracks:
        # MeasuredTrack.index, evaluated over the grid with identical half-open interval rules.
        def indices(pos):
            k = np.searchsorted(t.ends, pos + 1)
            offsets = np.asarray(t.offsets)
            origins = np.asarray(t.starts + [0])
            return np.where(k < len(t.starts), offsets[k] + np.maximum(0, pos - origins[k]), t.length)
        a, b = indices(starts), indices(starts + width)
        sizes = b - a
        for w in np.flatnonzero((2 * sizes >= width) & (sizes > 0)):
            by_window[w].append((t, int(a[w]), int(b[w]), int(sizes[w])))
    out = {}
    for kind in kinds:
        values = []
        for members in by_window:
            if len(members) < minimum:
                values.append(None)
                continue
            obs, pmfs = 0, []
            for t, a, b, m in members:
                c = int(t.prefix[kind][b] - t.prefix[kind][a])
                obs += int(np.floor(K * c / m + 1e-9))
                pmfs.append(t.pmf(kind, m, K))
            n = len(pmfs)
            exp = float(sum(p[1] for p in pmfs))
            values.append(dict(n=n, obs=obs / (K * n), exp=exp / (K * n),
                               p=tail_probability(pmfs, obs) if obs else 1.0))
        out[kind] = values
    return out
