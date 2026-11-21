"""Benjamini-Hochberg adjusted p-values (q-values): the one implementation FiberBrowser's own tests use.

Not covered here: q-values the FiberHMM package computes itself (the hub's association tables, fiberhmm.assoc) and the
nucleosome-patch rejections, which keep fiberhmm.nuc.enrichment.bh so they match the engine exactly.

q_i = min over ranks r >= rank(i) of p_(r) * m / r, capped at 1, returned in the input order. Ties keep their input
order (they get the same q either way).

Missing p-values (None or not finite):
- missing="skip" (default): they stay None and are not counted in m.
- missing="one": they count as p = 1 (and in m).
"""
from __future__ import annotations

import math
from typing import Iterable, List, Optional


def _clean(p) -> Optional[float]:
    if p is None:
        return None
    try:
        v = float(p)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(v):
        return None
    return min(1.0, max(0.0, v))


def bh_qvalues(p_values: Iterable, missing: str = "skip") -> List[Optional[float]]:
    if missing not in ("skip", "one"):
        raise ValueError("missing must be 'skip' or 'one'")
    vals = [_clean(p) for p in p_values]
    if missing == "one":
        vals = [1.0 if v is None else v for v in vals]
    idx = [i for i, v in enumerate(vals) if v is not None]
    q: List[Optional[float]] = [None] * len(vals)
    m = len(idx)
    if not m:
        return q
    order = sorted(idx, key=lambda i: (vals[i], i))
    running = 1.0
    for rank in range(m, 0, -1):
        i = order[rank - 1]
        running = min(running, vals[i] * m / rank)
        q[i] = min(1.0, running)
    return q

