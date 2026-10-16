"""Locus-level primer search helpers for capture-primer workflows."""
from __future__ import annotations

import numpy as np

from services.primer_candidates import fast_find_primers
from services.primer_filters import filter_by_exclude_regions


def find_valid_pair_indices(fwd_df, rev_df, req):
    """Find valid pair indices from fwd/rev DataFrames. Returns (fwd_idx, rev_idx) or None."""
    fwd_starts = fwd_df['starts'].values
    fwd_tms = fwd_df['tms'].values
    rev_starts = rev_df['starts'].values
    rev_tms = rev_df['tms'].values
    product_sizes = rev_starts[np.newaxis, :] - fwd_starts[:, np.newaxis]
    tm_diffs = np.abs(fwd_tms[:, np.newaxis] - rev_tms[np.newaxis, :])
    valid_mask = (
        (product_sizes >= req.min_product) &
        (product_sizes <= req.max_product) &
        (tm_diffs <= req.max_tm_diff)
    )
    fi, ri = np.where(valid_mask)
    return (fi, ri) if len(fi) > 0 else None


def find_locus_primers(fetch_seq, chrom_key, chrom_len, target_start, target_end,
                       req, rc_fn, exclude_regions=None, progress_callback=None):
    """Find fwd/rev primer candidates for a single capture locus."""
    fwd_search_start = max(0, target_end - req.max_product)
    fwd_search_end = target_start
    rev_search_start = target_end
    rev_search_end = min(chrom_len, target_start + req.max_product)

    if fwd_search_end - fwd_search_start < req.min_len + 10:
        return None, "Not enough upstream space for forward primers"
    if rev_search_end - rev_search_start < req.min_len + 10:
        return None, "Not enough downstream space for reverse primers"

    fwd_seq = fetch_seq(chrom_key, fwd_search_start, fwd_search_end)
    fwd_primers = fast_find_primers(
        fwd_seq, fwd_search_start, req.min_len, req.max_len, req.min_tm, req.max_tm, req.max_g_count,
        max_run_length=req.max_run_length, max_gc_pct=req.max_gc_pct,
        tm_method=req.tm_method, check_tandem_repeats=req.check_tandem_repeats,
        progress_callback=(
            (lambda primer_len, done, total, valid_count:
             progress_callback("forward", primer_len, done, total, valid_count,
                               fwd_search_end - fwd_search_start))
            if progress_callback else None
        ),
    )
    fwd_primers['strand'] = '+'

    rev_seq = fetch_seq(chrom_key, rev_search_start, rev_search_end)
    rev_seq_rc = rc_fn(rev_seq)
    rev_primers = fast_find_primers(
        rev_seq_rc, rev_search_start, req.min_len, req.max_len, req.min_tm, req.max_tm, req.max_g_count,
        max_run_length=req.max_run_length, max_gc_pct=req.max_gc_pct,
        tm_method=req.tm_method, check_tandem_repeats=req.check_tandem_repeats,
        progress_callback=(
            (lambda primer_len, done, total, valid_count:
             progress_callback("reverse", primer_len, done, total, valid_count,
                               rev_search_end - rev_search_start))
            if progress_callback else None
        ),
    )
    if not rev_primers.empty:
        rev_primers['starts'] = rev_search_end - (rev_primers['starts'] - rev_search_start)
        rev_primers['strand'] = '-'

    if exclude_regions:
        fwd_primers = filter_by_exclude_regions(fwd_primers, True, exclude_regions)
        rev_primers = filter_by_exclude_regions(rev_primers, False, exclude_regions)

    if fwd_primers.empty or rev_primers.empty:
        return None, "No valid primer candidates found"

    fwd_df = fwd_primers.copy()
    fwd_df['ends'] = fwd_df['starts'] + fwd_df['length']
    valid_fwd = fwd_df[fwd_df['ends'] <= target_start].copy()

    rev_df = rev_primers.copy()
    rev_df['left_edge'] = rev_df['starts'] - rev_df['length']
    valid_rev = rev_df[rev_df['left_edge'] >= target_end].copy()

    if valid_fwd.empty or valid_rev.empty:
        return None, "No primers found outside target region"

    valid_fwd = valid_fwd.reset_index(drop=True)
    valid_rev = valid_rev.reset_index(drop=True)

    fwd_starts = valid_fwd['starts'].values
    fwd_tms = valid_fwd['tms'].values
    rev_starts = valid_rev['starts'].values
    rev_tms = valid_rev['tms'].values

    product_sizes = rev_starts[np.newaxis, :] - fwd_starts[:, np.newaxis]
    tm_diffs = np.abs(fwd_tms[:, np.newaxis] - rev_tms[np.newaxis, :])
    valid_mask = (
        (product_sizes >= req.min_product) &
        (product_sizes <= req.max_product) &
        (tm_diffs <= req.max_tm_diff)
    )
    fwd_idx, rev_idx = np.where(valid_mask)

    if len(fwd_idx) == 0:
        return None, "No valid pairs within product size range"

    return (valid_fwd, valid_rev, fwd_idx, rev_idx), None
