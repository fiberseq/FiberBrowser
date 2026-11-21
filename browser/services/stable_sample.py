"""Seeded, stable sampling: the one rule every Plots sampler follows (owner, 19 Nov).

An item's sampling key is blake2b-64 of (seed, its identity parts), e.g. (seed, dataset, read name) for reads or
(seed, set, region) for BED regions. A sample of k is the k smallest keys (ties by identity); a sample by fraction p
keeps the keys below p * 2^64. Nothing depends on Python's hash(), set or dict order, the random module or numpy's
global state, so the same seed gives the same items across runs, machines, operating systems, restarts, chunk sizes
and region order. The browser's utils/stableSample.ts computes the same keys (golden values in both test suites).
"""
from __future__ import annotations

import hashlib
from typing import Callable, Iterable, List, Sequence, TypeVar

T = TypeVar("T")
KEY_SPACE = 1 << 64
_PREFIX = b"fiberbrowser.sample.v1"


def stable_key(seed: int, *parts: str) -> int:
    """blake2b-64 of the seed and the identity parts (UTF-8, unit-separated), big-endian."""
    h = hashlib.blake2b(digest_size=8)
    h.update(_PREFIX)
    h.update(b"\x1f" + str(int(seed)).encode("ascii"))
    for p in parts:
        h.update(b"\x1f" + str(p).encode("utf-8"))
    return int.from_bytes(h.digest(), "big")


def lowest_k(items: Iterable[T], k: int, key: Callable[[T], int], ident: Callable[[T], str] = str) -> List[T]:
    """The k items with the smallest keys (ties by identity), in key order."""
    ranked = sorted(items, key=lambda it: (key(it), ident(it)))
    return ranked if k < 0 else ranked[:max(0, k)]


def below(key: int, fraction: float) -> bool:
    """Whether a key falls in a sample by fraction (0..1)."""
    return key < fraction * KEY_SPACE


def sample_names(names: Sequence[str], k: int, seed: int, *scope: str) -> List[str]:
    """k names (read names) by the rule, scoped (e.g. by dataset)."""
    return lowest_k(names, k, key=lambda n: stable_key(seed, *scope, n))


def seed_int(seed) -> int:
    """An integer seed from the app's sample seed (an integer, or a string such as the analysis sample seed: its
    stable 31-bit digest, services.read_metrics.stable_seed_int)."""
    if isinstance(seed, int):
        return seed
    text = str(seed if seed is not None else "")
    if text.isdigit():
        return int(text)
    from services.read_metrics import stable_seed_int
    return stable_seed_int(text)


# Poisson(1) cumulative probabilities (k = 0..17), as literals so the browser uses the very same thresholds.
_POISSON1_CDF = (0.36787944117144233, 0.7357588823428847, 0.9196986029286058, 0.9810118431238463, 0.9963401531726563,
                 0.9994058151824183, 0.999916758850712, 0.9999897508033253, 0.999998874797402, 0.9999998885745216,
                 0.9999999899522336, 0.9999999991683892, 0.9999999999364022, 0.9999999999954802, 0.9999999999997,
                 0.9999999999999813, 0.9999999999999989, 0.9999999999999999)


def unit_seed(seed: int, unit: str) -> int:
    """A bootstrap unit's 32-bit stream seed: the low 32 bits of its stable key."""
    return stable_key(seed, "bootstrap", unit) & 0xFFFFFFFF


def _mulberry32(state: int) -> float:
    """The mulberry32 output for a state (the browser computes the same with Math.imul)."""
    t = state & 0xFFFFFFFF
    t = ((t ^ (t >> 15)) * (t | 1)) & 0xFFFFFFFF
    t ^= (t + (((t ^ (t >> 7)) * (t | 61)) & 0xFFFFFFFF)) & 0xFFFFFFFF
    return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296


def poisson_weights(seed: int, unit: str, resamples: int) -> List[int]:
    """A unit's multiplicity in each of the bootstrap resamples: Poisson(1) draws from its own stream (the Poisson
    bootstrap: a unit's weights depend only on the seed and its identity, never on the other units or their order)."""
    s0 = unit_seed(seed, unit)
    out = []
    for b in range(int(resamples)):
        u = _mulberry32((s0 + (b + 1) * 0x6D2B79F5) & 0xFFFFFFFF)
        k = 0
        while k < len(_POISSON1_CDF) and u >= _POISSON1_CDF[k]:
            k += 1
        out.append(k)
    return out


def poisson_weight(seed: int, resample: int, unit: str) -> int:
    return poisson_weights(seed, unit, int(resample) + 1)[-1]


def percentile_interval(values, level: float = 0.95):
    """The (lo, hi) percentile interval of the bootstrap values (linear interpolation, numpy's default)."""
    v = sorted(x for x in values if x == x)
    if not v:
        return None, None

    def q(p):
        h = (len(v) - 1) * p
        lo = int(h // 1)
        return v[lo] + (v[min(lo + 1, len(v) - 1)] - v[lo]) * (h - lo)
    a = (1 - level) / 2
    return q(a), q(1 - a)


def poisson_weight_matrix(seed: int, units, resamples: int):
    """Every unit's Poisson(1) multiplicities (units × resamples), vectorised: the same draws as poisson_weights."""
    import numpy as np
    mask = np.uint64(0xFFFFFFFF)
    s0 = np.array([unit_seed(seed, u) for u in units], dtype=np.uint64)
    b = np.arange(1, int(resamples) + 1, dtype=np.uint64)
    t = (s0[:, None] + b[None, :] * np.uint64(0x6D2B79F5)) & mask
    t = ((t ^ (t >> np.uint64(15))) * (t | np.uint64(1))) & mask
    t = (t ^ ((t + (((t ^ (t >> np.uint64(7))) * (t | np.uint64(61))) & mask)) & mask)) & mask
    u = ((t ^ (t >> np.uint64(14))) & mask).astype(np.float64) / 4294967296.0
    return np.searchsorted(np.asarray(_POISSON1_CDF), u, side="right").astype(np.uint8)
