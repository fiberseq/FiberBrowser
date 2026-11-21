"""Differential features: one test per feature between two groups of reads (A and B), then Benjamini-Hochberg.

A feature is anything the per-read feature states answer (``services/feature_states.py``): a peak ('1' open over the
peak), a footprint class ('1' a member), a nucleosome geometry ('1' carrying it), a hub set's hit. Each read of a group
counts once per feature as '1' or '0'; '.' (not evaluated: the read does not cover the feature, the class was not
scored on it, another dataset's class) is not counted, so the fractions are of evaluated reads only. A feature with
no evaluated reads in A or in B is not testable (no p, no q).

Per feature, a 2 x 2 table [[A '1', A '0'], [B '1', B '0']]:
- unstratified: Fisher's exact test (default) or a chi-squared test (with Yates' correction);
- stratified (``strata``: m6A density bins for density matching, replicate pairs or datasets for replicate-aware
  tests, or both): the Cochran-Mantel-Haenszel test with the continuity correction over the strata that hold both
  groups and both states.

Effect sizes, A - B:
- delta: fraction A - fraction B, with the Newcombe (hybrid score) 95% interval; stratified: the Mantel-Haenszel
  weighted difference (weights nA nB / n) with its Wald interval.
- log2 OR: log2 of the odds ratio with Woolf's interval, a 0.5 continuity correction when a cell is 0; stratified:
  the Mantel-Haenszel odds ratio with the Robins-Breslow-Greenland interval (0.5 added to every cell of a stratum
  holding a 0).
q: BH (``services.fdr``) over the testable features.
"""
from __future__ import annotations

import math
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

Z95 = 1.959963984540054
Table = Tuple[int, int, int, int]


def wilson(k: int, n: int, z: float = Z95) -> Tuple[float, float]:
    if n <= 0:
        return (0.0, 1.0)
    p = k / n
    den = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / den
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return (max(0.0, centre - half), min(1.0, centre + half))


def newcombe_delta(k1: int, n1: int, k2: int, n2: int) -> Tuple[float, float, float]:
    """p1 - p2 and its Newcombe hybrid score interval (method 10)."""
    p1, p2 = k1 / n1, k2 / n2
    l1, u1 = wilson(k1, n1)
    l2, u2 = wilson(k2, n2)
    d = p1 - p2
    lo = d - math.sqrt((p1 - l1) ** 2 + (u2 - p2) ** 2)
    hi = d + math.sqrt((u1 - p1) ** 2 + (p2 - l2) ** 2)
    return d, max(-1.0, lo), min(1.0, hi)


def log2_odds_ratio(a: float, b: float, c: float, d: float) -> Tuple[float, float, float]:
    """log2 OR of [[a, b], [c, d]] with Woolf's 95% interval; 0.5 added to every cell when one is 0."""
    if min(a, b, c, d) == 0:
        a, b, c, d = a + .5, b + .5, c + .5, d + .5
    ln = math.log(a * d / (b * c))
    se = math.sqrt(1 / a + 1 / b + 1 / c + 1 / d)
    k = 1 / math.log(2)
    return ln * k, (ln - Z95 * se) * k, (ln + Z95 * se) * k


def unstratified_p(table: Table, test: str = "fisher") -> float:
    a, b, c, d = table
    if test == "chi2":
        from scipy.stats import chi2_contingency
        if (a + b) == 0 or (c + d) == 0 or (a + c) == 0 or (b + d) == 0:
            return 1.0
        return float(chi2_contingency([[a, b], [c, d]], correction=True)[1])
    from scipy.stats import fisher_exact
    return float(fisher_exact([[a, b], [c, d]])[1])


def informative(t: Table) -> bool:
    a, b, c, d = t
    return (a + b) > 0 and (c + d) > 0 and (a + c) > 0 and (b + d) > 0 and (a + b + c + d) >= 2


def cmh(tables: Iterable[Table]) -> Dict[str, Optional[float]]:
    """Cochran-Mantel-Haenszel over the informative strata: p (continuity corrected), the MH odds ratio (None when 0
    or infinite) and how many strata were used."""
    from scipy.stats import chi2
    used = [t for t in tables if informative(t)]
    num = den = s_a = s_e = s_v = 0.0
    for a, b, c, d in used:
        n = a + b + c + d
        num += a * d / n
        den += b * c / n
        s_a += a
        s_e += (a + b) * (a + c) / n
        s_v += (a + b) * (c + d) * (a + c) * (b + d) / (n * n * (n - 1))
    if not used or s_v <= 0:
        return dict(strata=len(used), odds_ratio=None, p=None, direction=0)
    stat = max(0.0, abs(s_a - s_e) - 0.5) ** 2 / s_v
    orr = num / den if den > 0 and num > 0 else None
    return dict(strata=len(used), odds_ratio=orr, p=float(chi2.sf(stat, 1)),
                direction=1 if s_a > s_e else -1 if s_a < s_e else 0)


def mh_log2_or(tables: Sequence[Table]) -> Optional[Tuple[float, float, float]]:
    """Mantel-Haenszel log2 OR with the Robins-Breslow-Greenland 95% interval (strata with a 0 cell get 0.5 added)."""
    R = S = PR = PS_QR = QS = 0.0
    for t in tables:
        if (t[0] + t[1]) == 0 or (t[2] + t[3]) == 0:
            continue
        a, b, c, d = (x + .5 for x in t) if min(t) == 0 else t
        n = a + b + c + d
        r, s = a * d / n, b * c / n
        p, q = (a + d) / n, (b + c) / n
        R += r
        S += s
        PR += p * r
        PS_QR += p * s + q * r
        QS += q * s
    if R <= 0 or S <= 0:
        return None
    ln = math.log(R / S)
    var = PR / (2 * R * R) + PS_QR / (2 * R * S) + QS / (2 * S * S)
    se = math.sqrt(max(var, 0.0))
    k = 1 / math.log(2)
    return ln * k, (ln - Z95 * se) * k, (ln + Z95 * se) * k


def mh_delta(tables: Sequence[Table]) -> Optional[Tuple[float, float, float]]:
    """Weighted difference of fractions (weights nA nB / n) with its Wald 95% interval."""
    wsum = dsum = vsum = 0.0
    for a, b, c, d in tables:
        n1, n2 = a + b, c + d
        if n1 == 0 or n2 == 0:
            continue
        w = n1 * n2 / (n1 + n2)
        p1, p2 = a / n1, c / n2
        wsum += w
        dsum += w * (p1 - p2)
        vsum += w * w * (p1 * (1 - p1) / n1 + p2 * (1 - p2) / n2)
    if wsum <= 0:
        return None
    dd = dsum / wsum
    se = math.sqrt(vsum) / wsum
    return dd, max(-1.0, dd - Z95 * se), min(1.0, dd + Z95 * se)


def feature_test(strata: Dict[str, Table], test: str = "fisher", stratified: bool = False, min_reads: int = 1) -> dict:
    """The row of one feature: counts (summed over strata), fractions, delta and log2 OR with intervals, p."""
    tables = [tuple(int(x) for x in t) for t in strata.values()]
    a = sum(t[0] for t in tables)
    b = sum(t[1] for t in tables)
    c = sum(t[2] for t in tables)
    d = sum(t[3] for t in tables)
    nA, nB = a + b, c + d
    row = dict(kA=a, nA=nA, kB=c, nB=nB, fracA=a / nA if nA else None, fracB=c / nB if nB else None,
               delta=None, deltaLo=None, deltaHi=None, log2or=None, log2orLo=None, log2orHi=None, p=None,
               strata=None, testable=False, reason=None)
    if nA < max(1, min_reads) or nB < max(1, min_reads):
        row["reason"] = "too few evaluated reads in A" if nA < max(1, min_reads) else "too few evaluated reads in B"
        return row
    if stratified:
        res = cmh(tables)
        row["strata"] = res["strata"]
        dl = mh_delta(tables)
        orr = mh_log2_or(tables)
        if res["p"] is None:
            # No stratum holds both groups and both states: nothing to test (identical fractions within strata).
            row["p"] = 1.0 if res["strata"] == 0 and (a + c == 0 or b + d == 0) else None
            if row["p"] is None:
                row["reason"] = "no stratum holds both groups"
                return row
        else:
            row["p"] = res["p"]
    else:
        row["p"] = unstratified_p((a, b, c, d), test)
        dl = newcombe_delta(a, nA, c, nB)
        orr = log2_odds_ratio(a, b, c, d)
    row["testable"] = True
    if dl:
        row["delta"], row["deltaLo"], row["deltaHi"] = dl
    if orr:
        row["log2or"], row["log2orLo"], row["log2orHi"] = orr
    return row


def differential_rows(features: List[dict], test: str = "fisher", stratified: bool = False, min_reads: int = 1) -> List[dict]:
    """features: [{key, ..., strata: {stratum: (a, b, c, d)}}] -> rows with q (BH over the testable features)."""
    from services.fdr import bh_qvalues
    rows = []
    for f in features:
        row = {k: v for k, v in f.items() if k != "strata"}
        row.update(feature_test(f.get("strata") or {}, test, stratified, min_reads))
        rows.append(row)
    qs = bh_qvalues([r["p"] if r["testable"] else None for r in rows])
    for r, q in zip(rows, qs):
        r["q"] = q
    return rows


def density_bins(values: Sequence[float], bins: int = 5) -> List[float]:
    """Inner edges of equal-count bins of the values (the m6A/kb densities of the tested reads)."""
    import numpy as np
    v = np.asarray([x for x in values if x is not None and math.isfinite(x)], dtype=float)
    if v.size == 0 or bins <= 1:
        return []
    edges = np.quantile(v, [i / bins for i in range(1, bins)])
    return sorted(set(float(e) for e in edges))


def bin_of(value: Optional[float], edges: Sequence[float]) -> Optional[int]:
    if value is None or not math.isfinite(value):
        return None
    from bisect import bisect_right
    return bisect_right(list(edges), value)


def count_tables(features: List[dict], columns: List[List[int]], by_dataset: Dict[str, Dict[str, str]],
                 side_of, stratum_of) -> List[dict]:
    """Tables per feature from the per-read state strings.

    columns[i]: the state-string positions of feature i (its refs; the first evaluated one counts). side_of(ds, read)
    -> iterable of 'A' / 'B' (a read in neither is skipped); stratum_of(ds, read, side) -> a stratum key, or None to
    skip the read (no density for density matching)."""
    out = []
    for f, cols in zip(features, columns):
        strata: Dict[str, List[int]] = {}
        for ds, reads in by_dataset.items():
            for read, states in reads.items():
                s = next((states[c] for c in cols if c < len(states) and states[c] != '.'), '.')
                if s == '.':
                    continue
                for side in side_of(ds, read):
                    key = stratum_of(ds, read, side)
                    if key is None:
                        continue
                    t = strata.setdefault(str(key), [0, 0, 0, 0])
                    t[(0 if side == 'A' else 2) + (0 if s == '1' else 1)] += 1
        out.append(dict(f, strata={k: tuple(v) for k, v in strata.items()}))
    return out
