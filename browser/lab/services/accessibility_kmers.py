"""Accessibility (preview): de novo k-mer enrichment in variant-specific openings, pooled across NFRs (EXPERIMENTAL).

For factors JASPAR lacks. Per k-mer (a k-mer and its reverse complement are one), counted in the part of each
variant's span no sibling covers, against (a) the siblings' own parts and (b) the local background (the region minus
every NFR and variant span of the run); each comparison pooled over variants and NFRs as a Mantel-Haenszel rate
ratio with the exact conditional test; BH across k-mers. Each enriched k-mer is matched to the JASPAR matrix that
scores it best (its share of the matrix's score range at the best offset and strand).
"""
from __future__ import annotations

import itertools

import numpy as np

COMP = str.maketrans('ACGT', 'TGCA')


def canonical(kmer):
    rc = kmer.translate(COMP)[::-1]
    return min(kmer, rc)


def kmers_of(k):
    return sorted({canonical(''.join(p)) for p in itertools.product('ACGT', repeat=k)})


def count(seq, lo, intervals, k, index):
    """(counts per canonical k-mer index, positions) of the k-mers starting inside the intervals (half-open, absolute
    coordinates; ``seq`` starts at ``lo``), skipping windows with other bases."""
    counts = np.zeros(len(index), dtype=np.int64)
    n = 0
    s = seq.upper()
    for a, b in intervals:
        i0, i1 = max(0, int(np.ceil(a)) - lo), min(len(s) - k + 1, int(np.floor(b)) - lo - k + 1)
        for i in range(i0, max(i0, i1)):
            w = s[i:i + k]
            j = index.get(w)
            if j is None:
                continue
            counts[j] += 1
            n += 1
    return counts, n


def best_matrix(kmer, scored):
    """(name, matrix id, share of the score range) of the matrix that scores the k-mer best, or None."""
    from services.motifs import _BASE_CODE_LUT
    codes = _BASE_CODE_LUT[np.frombuffer(kmer.encode(), dtype=np.uint8)]
    best = None
    for name, mid, ip, rc in scored:
        L = ip.shape[1]
        if L < len(kmer):
            continue
        rng = float(ip.max(axis=0).sum() - ip.min(axis=0).sum()) or 1.
        for mat in (ip, rc):
            for off in range(L - len(kmer) + 1):
                sub = mat[:, off:off + len(kmer)]
                got = float(sub[codes, np.arange(len(kmer))].sum() - sub.min(axis=0).sum())
                top = float(sub.max(axis=0).sum() - sub.min(axis=0).sum()) or 1.
                share = got/top
                if best is None or share > best[2] or (share == best[2] and top/rng > best[3]):
                    best = (name, mid, share, top/rng)
    return None if best is None else (best[0], best[1], round(best[2], 3))


def enrich(strata_own, strata_bg, index, top=40):
    """strata_*: per stratum (counts_a, n_a, counts_b, n_b). Mantel-Haenszel rate ratio per k-mer for each
    comparison, BH across k-mers; the ``top`` k-mers by the siblings comparison's q (enriched only)."""
    from lab.services.accessibility_pooled import mh_rate_ratio
    from services.motif_scoring import bh
    keys = sorted(index, key=index.get)
    res = []
    for j, kmer in enumerate(keys):
        own = mh_rate_ratio([(ca[j], na, cb[j], nb) for ca, na, cb, nb in strata_own])
        bg = mh_rate_ratio([(ca[j], na, cb[j], nb) for ca, na, cb, nb in strata_bg])
        res.append(dict(kmer=kmer, siblings=own, background=bg))
    for key in ('siblings', 'background'):
        for r, q in zip(res, bh([r[key]['p'] for r in res])):
            r[key]['q'] = q
    # ranked by the comparison with the siblings (same NFR, same composition); the background comparison is shown
    # but not used to rank: open DNA and nucleosomal flanks differ in base composition, which alone enriches k-mers
    upward = lambda st: (st.get('direction') or 0) > 0  # noqa: E731  (an infinite ratio has no log2, but a direction)
    sq = lambda r: r['siblings']['q'] if r['siblings']['q'] is not None and upward(r['siblings']) else 2  # noqa: E731
    up = [r for r in res if upward(r['siblings'])]
    up.sort(key=lambda r: (sq(r), -(r['siblings']['log2'] if r['siblings']['log2'] is not None else 99), -(r['siblings']['events'] or 0)))
    return up[:top], len(res)
