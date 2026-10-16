"""Small primer-design filtering helpers.

These helpers are kept out of the FastAPI router so the endpoint module can
focus on request orchestration rather than dataframe/vector utilities.
"""
from __future__ import annotations

from typing import Optional

import numpy as np

from services.read_metrics import random_state_from_seed


def filter_by_exclude_regions(df, is_fwd: bool, exclude_regions):
    """Drop primer candidates whose genomic footprint overlaps excluded intervals.

    Footprint ranges:
      - fwd (+ strand): [starts, starts + length)
      - rev (- strand): [starts - length, starts)
    """
    if df is None or getattr(df, 'empty', True):
        return df
    if not exclude_regions:
        return df
    if is_fwd:
        lo = df['starts'].values
        hi = lo + df['length'].values
    else:
        hi = df['starts'].values
        lo = hi - df['length'].values
    keep = np.ones(len(df), dtype=bool)
    for ex in exclude_regions:
        if not ex or len(ex) < 2:
            continue
        ex_lo, ex_hi = int(ex[0]), int(ex[1])
        if ex_hi <= ex_lo:
            continue
        keep &= ~((lo < ex_hi) & (hi > ex_lo))
    return df[keep].copy()


def subsample_pair_indices(fwd_idx, rev_idx, max_pairs: int, sample_seed: Optional[str], *context):
    """Reproducibly cap large DAF-C pair sets without touching global RNG state."""
    if len(fwd_idx) <= max_pairs:
        return fwd_idx, rev_idx
    rng = np.random.default_rng(random_state_from_seed(sample_seed, "dafc_pair_cap", *context))
    sel = rng.choice(len(fwd_idx), max_pairs, replace=False)
    return fwd_idx[sel], rev_idx[sel]
