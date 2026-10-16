"""Endpoint workflow helper for standard PCR primer design."""
from __future__ import annotations

import os
from typing import Optional
import numpy as np

from models.requests import PrimerDesignRequest
from services.primer_candidates import (
    count_valid_pairs_chunked,
    fast_find_pairs_vectorized,
    fast_find_primers,
    find_pair_participation,
)
from services.primer_config import log_primer_diagnostic
from services.primer_orchestration import resolve_primer_runtime_config as _resolve_primer_runtime_config
from services.primer_state import (
    set_primer_progress as _set_primer_progress,
    set_primer_progress_payload as _set_primer_progress_payload,
    set_primer_result as _set_primer_result,
)
from services.primer_blast_runtime import (
    PrimerDesignAborted,
    blast_and_score_cached,
    check_abort as _check_abort,
    primer_design_run as _primer_design_run,
    run_in_design_context as _run_in_design_context,
)
from services.primer_blast_validation import (
    blast_filter_label as _blast_filter_label,
    validate_stranded_blast_execution as _validate_stranded_blast_execution,
    validate_stranded_blast_passing as _validate_stranded_blast_passing,
)
from services.primer_filters import filter_by_exclude_regions as _filter_by_exclude_regions
from services.primer_reference import (
    get_fasta_interface as _get_fasta_interface,
    resolve_chrom as _resolve_chrom,
)


def design_standard_primers_payload(req: PrimerDesignRequest, state):
    """One design run (its own abort token, released when it ends); see _design_standard_primers_payload."""
    with _primer_design_run():
        return _design_standard_primers_payload(req, state)


def _design_standard_primers_payload(req: PrimerDesignRequest, state):
    """Design primers for a genomic region - optimized with progress tracking"""

    runtime_config, config_error = _resolve_primer_runtime_config(
        state,
        missing_fasta_message="FASTA file not configured. Load a reference genome or set BLAST config.",
        missing_blast_message="BLAST database not configured. Set the BLAST DB path in Primer Design settings.",
    )
    if config_error:
        return config_error
    fasta_path = runtime_config.fasta_path
    blast_db_mismatch_warning = None

    try:
        _set_primer_progress_payload({"active": True, "stage": "init", "progress": 0, "message": "Starting..."})

        # Import dependencies
        import sys
        backend_dir = os.path.dirname(os.path.abspath(__file__))
        if backend_dir not in sys.path:
            sys.path.insert(0, backend_dir)

        from primer_designer import rc
        import primer3

        log_primer_diagnostic("\n=== PRIMER DESIGN ===")
        log_primer_diagnostic(f"Target region: {req.chrom}:{req.start}-{req.end}")
        log_primer_diagnostic(f"Product size: {req.min_product}-{req.max_product}bp")

        # Stage 1: Load FASTA (prefer pysam for speed)
        _set_primer_progress_payload({"active": True, "stage": "fasta", "progress": 10, "message": "Loading reference genome..."})

        fetch_seq, get_chrom_len, available_chroms = _get_fasta_interface(state, fasta_path)

        # Resolve chromosome name (handle chr prefix mismatch)
        chrom_key = _resolve_chrom(req.chrom, available_chroms)
        if chrom_key is None:
            _set_primer_progress_payload({"active": False, "stage": "error", "progress": 0, "message": ""})
            avail = ', '.join(sorted(available_chroms)[:10])
            return {"success": False, "message": f"Chromosome {req.chrom} not in FASTA (available: {avail}...)"}

        chrom_len = get_chrom_len(chrom_key)

        # Validate target coordinates against chromosome length
        target_start = req.start
        target_end = req.end

        if target_start < 0 or target_end <= target_start:
            _set_primer_progress_payload({"active": False, "stage": "error", "progress": 0, "message": ""})
            return {"success": False, "message": f"Invalid target region: {req.chrom}:{req.start:,}-{req.end:,}"}

        if target_start >= chrom_len or target_end > chrom_len:
            _set_primer_progress_payload({"active": False, "stage": "error", "progress": 0, "message": ""})
            return {
                "success": False,
                "message": (
                    f"Target region {req.chrom}:{req.start:,}-{req.end:,} exceeds "
                    f"chromosome length ({chrom_len:,} bp). "
                    f"Check that the FASTA matches the genome assembly used for alignment."
                ),
            }

        # Validate target size vs product size — target must fit within product
        target_size = target_end - target_start
        if target_size > req.max_product:
            _set_primer_progress_payload({"active": False, "stage": "error", "progress": 0, "message": ""})
            return {
                "success": False,
                "message": (
                    f"Target region is {target_size:,} bp but max product size is {req.max_product:,} bp. "
                    f"Primers must flank the target, so the product is always larger than the target. "
                    f"Increase max product size to at least {target_size:,} bp, or select fewer/closer peaks."
                ),
            }

        # Stage 2: Define search regions OUTSIDE the target
        _set_primer_progress_payload({"active": True, "stage": "search", "progress": 20, "message": "Finding primer candidates..."})

        # Search for forward primers UPSTREAM of target (before target_start)
        # Product = rev_end - fwd_start, and product must include target,
        # so farthest fwd is max_product bp from target_end (not target_start)
        fwd_search_start = max(0, target_end - req.max_product)
        fwd_search_end = target_start  # Forward primers must be before target

        # Search for reverse primers DOWNSTREAM of target (after target_end)
        # Similarly, farthest rev is max_product bp from target_start
        rev_search_start = target_end  # Reverse primers must be after target
        rev_search_end = min(chrom_len, target_start + req.max_product)

        log_primer_diagnostic(f"Chromosome {chrom_key} length: {chrom_len:,}")
        log_primer_diagnostic(
            f"Forward primer search: {fwd_search_start:,}-{fwd_search_end:,} "
            f"({fwd_search_end - fwd_search_start:,} bp)"
        )
        log_primer_diagnostic(
            f"Reverse primer search: {rev_search_start:,}-{rev_search_end:,} "
            f"({rev_search_end - rev_search_start:,} bp)"
        )

        # Validate search ranges have enough room for primers
        min_search_len = req.min_len + 10  # Need at least primer length + some margin
        if fwd_search_end - fwd_search_start < min_search_len:
            _set_primer_progress_payload({"active": False, "stage": "error", "progress": 0, "message": ""})
            return {"success": False, "message": f"Not enough upstream space for forward primers (only {fwd_search_end - fwd_search_start} bp before target, need >{min_search_len})"}

        if rev_search_end - rev_search_start < min_search_len:
            _set_primer_progress_payload({"active": False, "stage": "error", "progress": 0, "message": ""})
            return {"success": False, "message": f"Not enough downstream space for reverse primers (only {rev_search_end - rev_search_start} bp after target, need >{min_search_len})"}

        def _candidate_progress(stage: str, label: str, base: int, span: int, window_bp: int):
            def _callback(primer_len: int, done: int, total: int, valid_count: Optional[int]):
                pct = base + int(span * done / max(1, total))
                if valid_count is None:
                    status = "scanning"
                else:
                    status = f"{valid_count:,} valid at this length"
                _set_primer_progress(
                    stage, pct,
                    f"{label}: {primer_len} bp primers ({done}/{total}); {status}",
                    window_bp=window_bp,
                    primer_length=primer_len,
                    completed_lengths=done,
                    total_lengths=total,
                )
            return _callback

        # Stage 3: Find forward primers (upstream of target)
        _set_primer_progress_payload({
            "active": True, "stage": "forward", "progress": 30,
            "message": f"Finding forward primers in {fwd_search_end - fwd_search_start:,} bp upstream window..."
        })

        fwd_seq = fetch_seq(chrom_key, fwd_search_start, fwd_search_end)
        fwd_primers = fast_find_primers(fwd_seq, fwd_search_start, req.min_len, req.max_len, req.min_tm, req.max_tm, req.max_g_count,
                                        max_run_length=req.max_run_length, max_gc_pct=req.max_gc_pct,
                                        tm_method=req.tm_method, check_tandem_repeats=req.check_tandem_repeats,
                                        progress_callback=_candidate_progress(
                                            "forward", "Forward candidates", 30, 15,
                                            fwd_search_end - fwd_search_start,
                                        ))
        fwd_primers['strand'] = '+'
        log_primer_diagnostic(f"Found {len(fwd_primers)} forward primer candidates")

        # Stage 4: Find reverse primers (downstream of target)
        _set_primer_progress_payload({
            "active": True, "stage": "reverse", "progress": 45,
            "message": f"Found {len(fwd_primers):,} forward candidates; finding reverse primers in {rev_search_end - rev_search_start:,} bp downstream window..."
        })

        rev_seq = fetch_seq(chrom_key, rev_search_start, rev_search_end)
        rev_seq_rc = rc(rev_seq)  # Reverse complement for finding - strand primers
        rev_primers = fast_find_primers(rev_seq_rc, rev_search_start, req.min_len, req.max_len, req.min_tm, req.max_tm, req.max_g_count,
                                        max_run_length=req.max_run_length, max_gc_pct=req.max_gc_pct,
                                        tm_method=req.tm_method, check_tandem_repeats=req.check_tandem_repeats,
                                        progress_callback=_candidate_progress(
                                            "reverse", "Reverse candidates", 45, 10,
                                            rev_search_end - rev_search_start,
                                        ))

        # Adjust reverse primer positions (they're on - strand)
        # The starts we calculated are relative to the RC sequence, need to convert
        if not rev_primers.empty:
            # Convert RC positions to half-open right boundary: position i in RC → genomic (end - i)
            rev_primers['starts'] = rev_search_end - (rev_primers['starts'] - rev_search_start)
            rev_primers['strand'] = '-'
        log_primer_diagnostic(f"Found {len(rev_primers)} reverse primer candidates")

        # Exclude cart-primer footprints before any further filtering / BLAST
        # so we don't waste time evaluating primers the caller already has.
        if req.exclude_regions:
            before_f, before_r = len(fwd_primers), len(rev_primers)
            fwd_primers = _filter_by_exclude_regions(fwd_primers, True, req.exclude_regions)
            rev_primers = _filter_by_exclude_regions(rev_primers, False, req.exclude_regions)
            log_primer_diagnostic(
                f"Excluded {before_f - len(fwd_primers)} fwd / {before_r - len(rev_primers)} "
                f"rev primers overlapping {len(req.exclude_regions)} cart region(s)"
            )

        if fwd_primers.empty:
            _set_primer_progress_payload({"active": False, "stage": "done", "progress": 100, "message": ""})
            return {"success": False, "message": "No valid forward primers found upstream of target"}
        
        if rev_primers.empty:
            _set_primer_progress_payload({"active": False, "stage": "done", "progress": 100, "message": ""})
            return {"success": False, "message": "No valid reverse primers found downstream of target"}
        
        # Stage 5: Find which primers form valid pairs (vectorized, don't store all pairs yet)
        _set_primer_progress_payload({"active": True, "stage": "pairs", "progress": 55, "message": "Finding valid primer combinations..."})
        
        # Get primers that could form valid pairs (OUTSIDE target region)
        fwd_df = fwd_primers.copy()
        fwd_df['ends'] = fwd_df['starts'] + fwd_df['length']
        valid_fwd = fwd_df[fwd_df['ends'] <= target_start].copy()
        
        rev_df = rev_primers.copy()
        rev_df['left_edge'] = rev_df['starts'] - rev_df['length']
        valid_rev = rev_df[rev_df['left_edge'] >= target_end].copy()
        
        if valid_fwd.empty or valid_rev.empty:
            _set_primer_progress_payload({"active": False, "stage": "done", "progress": 100, "message": ""})
            return {"success": False, "message": "No primers found outside target region"}
        
        log_primer_diagnostic(f"Primers outside target: {len(valid_fwd)} fwd, {len(valid_rev)} rev")
        _set_primer_progress(
            "pairs", 56,
            f"Checking {len(valid_fwd):,} x {len(valid_rev):,} candidate combinations...",
            forward_candidates=len(valid_fwd),
            reverse_candidates=len(valid_rev),
        )
        
        # Which primers are part of at least one valid pair? This is chunked
        # to avoid a dense fwd x rev matrix on primer-rich search windows.
        fwd_in_valid_pair, rev_in_valid_pair = find_pair_participation(
            valid_fwd,
            valid_rev,
            req.min_product,
            req.max_product,
            req.max_tm_diff,
        )
        
        fwd_to_blast = valid_fwd[fwd_in_valid_pair].copy()
        rev_to_blast = valid_rev[rev_in_valid_pair].copy()
        
        log_primer_diagnostic(f"Primers in valid pairs: {len(fwd_to_blast)} fwd, {len(rev_to_blast)} rev")
        _set_primer_progress(
            "pairs", 60,
            f"{len(fwd_to_blast):,} forward + {len(rev_to_blast):,} reverse primers can form valid pairs",
            forward_in_pairs=len(fwd_to_blast),
            reverse_in_pairs=len(rev_to_blast),
        )
        
        if fwd_to_blast.empty or rev_to_blast.empty:
            _set_primer_progress_payload({"active": False, "stage": "done", "progress": 100, "message": ""})
            return {
                "success": False,
                "message": (
                    f"No valid primer pairs found within product size range "
                    f"({req.min_product:,}-{req.max_product:,} bp). "
                    f"Target region is {target_size:,} bp. "
                    f"Try widening the product size range or adjusting Tm/length parameters."
                ),
            }
        
        # Stage 6: BLAST primers that form valid pairs, using the cached
        # orchestrator + ranked two-pass early stop.
        unique_fwd_seqs = list(fwd_to_blast['sequences'].unique())
        unique_rev_seqs = list(rev_to_blast['sequences'].unique())
        _set_primer_progress_payload({"active": True, "stage": "blast", "progress": 65,
                                  "message": f"BLASTing {len(unique_fwd_seqs)}+{len(unique_rev_seqs)} unique primers..."})

        # Rank candidates toward their ideal pair-forming position, not
        # toward the target center. A fwd primer (upstream of target) and
        # rev primer (downstream) form a product of roughly (rev - fwd).
        # For a product of ideal size L, the ideal fwd sits at
        # target_mid - L/2 and the ideal rev at target_mid + L/2. Ranking
        # by distance to target_mid would push both strands toward the
        # inside edges of their search windows, and pass 1 candidates
        # would all pair below min_product — producing 0 valid pairs
        # even after hundreds of BLASTs pass. Ties broken by Tm deviation.
        target_mid = (target_start + target_end) / 2
        tm_mid = (req.min_tm + req.max_tm) / 2
        ideal_product = (req.min_product + req.max_product) / 2
        ideal_fwd_pos = target_mid - ideal_product / 2
        ideal_rev_pos = target_mid + ideal_product / 2

        def _ranked_seqs(df: 'pd.DataFrame', ideal_pos: float) -> list:
            if df.empty:
                return []
            mids = (df['starts'].values + (df['length'].values / 2))
            dists = np.abs(mids - ideal_pos)
            tm_dev = np.abs(df['tms'].values - tm_mid)
            fitness = dists + tm_dev * 50   # ~50bp equivalent per °C Tm deviation
            idx = np.argsort(fitness)
            # Preserve first occurrence per unique seq
            seen = set()
            out = []
            for i in idx:
                s = df['sequences'].iloc[int(i)]
                if s in seen:
                    continue
                seen.add(s)
                out.append(s)
            return out

        ranked_fwd = _ranked_seqs(fwd_to_blast, ideal_fwd_pos)
        ranked_rev = _ranked_seqs(rev_to_blast, ideal_rev_pos)
        fwd_set_all = set(ranked_fwd)
        rev_set_all = set(ranked_rev)

        PASS1_SIZE = 300  # primers of each strand; empirically enough on most targets
        ENOUGH_MULT = 3   # stop when we have this many more pairs than max_results

        def _run_blast_pass(seqs: list) -> tuple:
            """Dispatch a BLAST batch via the cached orchestrator. Returns
            (passing_set, counts_dict, n_cached, n_blasted, stderr_text)."""
            if not seqs:
                return set(), {}, 0, 0, ""
            try:
                passing, counts, n_cached, n_blasted, stderr_text = blast_and_score_cached(
                    seqs, runtime_config.blast_db_path,
                    check_three_prime=req.check_three_prime_specificity,
                )
            except PrimerDesignAborted:
                raise
            return passing, counts, n_cached, n_blasted, stderr_text

        # Pass-1 fwd and rev BLAST are independent subprocess calls — run
        # them concurrently. Each blastn is already multithreaded via
        # -num_threads, but disk I/O + genome load overlap so this is
        # usually a 1.5-1.8x wall-clock win on top.
        from concurrent.futures import ThreadPoolExecutor
        from services.background_work import auxiliary_worker_count

        def _run_blast_pair_concurrent(fwd_seqs: list, rev_seqs: list) -> tuple:
            """Return fwd and rev BLAST batch tuples."""
            # The worker threads carry this run's abort token (run_in_design_context).
            with ThreadPoolExecutor(max_workers=auxiliary_worker_count(2)) as exc:
                f_fut = _run_in_design_context(exc, _run_blast_pass, fwd_seqs) if fwd_seqs else None
                r_fut = _run_in_design_context(exc, _run_blast_pass, rev_seqs) if rev_seqs else None
                f_res = f_fut.result() if f_fut else (set(), {}, 0, 0, "")
                r_res = r_fut.result() if r_fut else (set(), {}, 0, 0, "")
            return (*f_res, *r_res)

        # ---- Pass 1: top-ranked slice ----
        pass1_fwd = ranked_fwd[:PASS1_SIZE]
        pass1_rev = ranked_rev[:PASS1_SIZE]
        _set_primer_progress(
            "blast", 66,
            f"BLAST pass 1: checking top {len(pass1_fwd):,} forward + {len(pass1_rev):,} reverse primers...",
            pass_number=1,
            forward_primers=len(pass1_fwd),
            reverse_primers=len(pass1_rev),
        )
        passing_fwd_p1, counts_fwd_p1, cf1, bf1, \
            sf1, passing_rev_p1, counts_rev_p1, cr1, br1, sr1 = _run_blast_pair_concurrent(pass1_fwd, pass1_rev)
        validation = _validate_stranded_blast_execution((counts_fwd_p1, sf1), (counts_rev_p1, sr1))
        if validation:
            _set_primer_progress_payload(validation["progress"])
            return validation["response"]
        blast_passing_fwd = set(passing_fwd_p1)
        blast_passing_rev = set(passing_rev_p1)
        blast_hit_counts = {**counts_fwd_p1, **counts_rev_p1}
        total_cached = cf1 + cr1
        total_blasted = bf1 + br1
        log_primer_diagnostic(
            f"BLAST pass1: fwd {len(passing_fwd_p1)}/{len(pass1_fwd)} pass "
            f"({cf1} cached, {bf1} blasted); rev {len(passing_rev_p1)}/{len(pass1_rev)} pass "
            f"({cr1} cached, {br1} blasted)"
        )

        # Diagnostic: if pass-rate is very low, break down the failure modes
        # so the user can see whether off-target or 3'-end is the blocker,
        # or whether BLAST is finding nothing at all (DB mismatch). Only
        # print when informative.
        def _failure_breakdown(counts_dict: dict, pool: list, label: str):
            if not pool or not counts_dict:
                return
            n_total = len(pool)
            n_pass = sum(1 for s in pool
                         if (c := counts_dict.get(s))
                         and c['on_target'] == 1
                         and c['off_target'] == 0
                         and c['three_prime_threats'] == 0)
            if n_pass / max(1, n_total) >= 0.10:
                return
            n_no_home = sum(1 for s in pool if (c := counts_dict.get(s)) and c['on_target'] == 0)
            n_off = sum(1 for s in pool if (c := counts_dict.get(s)) and c['off_target'] > 0)
            n_3p = sum(1 for s in pool if (c := counts_dict.get(s)) and c['three_prime_threats'] > 0)
            log_primer_diagnostic(
                f"  [diag] {label} failure modes: "
                f"no-home={n_no_home}/{n_total}, off-target>0={n_off}/{n_total}, "
                f"3'-threats>0={n_3p}/{n_total}"
            )
            if n_no_home >= 0.8 * n_total:
                log_primer_diagnostic(
                    "  [diag] Most primers produced no home hit — BLAST DB may not match the "
                    "reference FASTA, or candidates sit in a masked/low-complexity region."
                )
        _failure_breakdown(counts_fwd_p1, pass1_fwd, 'fwd pass1')
        _failure_breakdown(counts_rev_p1, pass1_rev, 'rev pass1')

        # Pair check: do we already have enough valid pairs?
        def _count_valid_pairs(fwd_seqs_ok: set, rev_seqs_ok: set) -> int:
            if not fwd_seqs_ok or not rev_seqs_ok:
                return 0
            mask_f = fwd_to_blast['sequences'].isin(fwd_seqs_ok).values
            mask_r = rev_to_blast['sequences'].isin(rev_seqs_ok).values
            if not mask_f.any() or not mask_r.any():
                return 0
            fs = fwd_to_blast['starts'].values[mask_f]
            rs = rev_to_blast['starts'].values[mask_r]
            ft = fwd_to_blast['tms'].values[mask_f]
            rt = rev_to_blast['tms'].values[mask_r]
            return count_valid_pairs_chunked(
                fs, ft, rs, rt,
                req.min_product,
                req.max_product,
                req.max_tm_diff,
            )

        enough_target = max(req.max_results * ENOUGH_MULT, 5)
        n_pairs_p1 = _count_valid_pairs(blast_passing_fwd, blast_passing_rev)
        log_primer_diagnostic(
            f"BLAST pass1: {n_pairs_p1} valid pairs (need >= {enough_target} to skip pass2)"
        )
        _set_primer_progress(
            "blast", 74,
            f"BLAST pass 1 complete: {n_pairs_p1:,} valid pairs ({total_cached:,} cached, {total_blasted:,} newly BLASTed)",
            valid_pairs=n_pairs_p1,
            cached=total_cached,
            blasted=total_blasted,
        )

        # ---- Pass 2: chunked with per-chunk progress + early-stop ----
        # Previously pass 2 BLASTed the entire remainder in one silent
        # shot — on dense regions that's minutes with no UI feedback.
        # Now we chunk, update progress + pair count each chunk, and
        # stop as soon as we have enough valid pairs.
        if n_pairs_p1 < enough_target:
            rest_fwd = ranked_fwd[PASS1_SIZE:]
            rest_rev = ranked_rev[PASS1_SIZE:]
            if rest_fwd or rest_rev:
                CHUNK = 200
                total_rest = len(rest_fwd) + len(rest_rev)
                p2_fwd_added = p2_rev_added = 0
                i_f = i_r = 0
                stopped_early = False
                while i_f < len(rest_fwd) or i_r < len(rest_rev):
                    _check_abort()
                    fchunk = rest_fwd[i_f:i_f + CHUNK]
                    rchunk = rest_rev[i_r:i_r + CHUNK]
                    done = i_f + i_r
                    n_pairs_cur = _count_valid_pairs(blast_passing_fwd, blast_passing_rev)
                    _set_primer_progress_payload({
                        "active": True, "stage": "blast",
                        "progress": 75 + int(20 * done / max(1, total_rest)),
                        "message": (f"Pass 2: BLASTed {done}/{total_rest} primers "
                                    f"({n_pairs_cur} valid pairs so far)..."),
                    })
                    p_fwd, c_fwd, cf2, bf2, sf2, p_rev, c_rev, cr2, br2, sr2 = \
                        _run_blast_pair_concurrent(fchunk, rchunk)
                    validation = _validate_stranded_blast_execution((c_fwd, sf2), (c_rev, sr2))
                    if validation:
                        _set_primer_progress_payload(validation["progress"])
                        return validation["response"]
                    blast_passing_fwd |= p_fwd
                    blast_passing_rev |= p_rev
                    blast_hit_counts.update(c_fwd); blast_hit_counts.update(c_rev)
                    total_cached += cf2 + cr2
                    total_blasted += bf2 + br2
                    p2_fwd_added += len(p_fwd)
                    p2_rev_added += len(p_rev)
                    i_f += len(fchunk)
                    i_r += len(rchunk)
                    n_pairs_cur = _count_valid_pairs(blast_passing_fwd, blast_passing_rev)
                    if n_pairs_cur >= enough_target:
                        log_primer_diagnostic(
                            f"BLAST pass2: early stop at {i_f + i_r}/{total_rest} "
                            f"({n_pairs_cur} valid pairs >= target {enough_target})"
                        )
                        stopped_early = True
                        break
                if not stopped_early:
                    log_primer_diagnostic(
                        f"BLAST pass2: fwd +{p2_fwd_added}, rev +{p2_rev_added} "
                        f"(swept all {total_rest} remaining primers)"
                    )
        else:
            log_primer_diagnostic("BLAST pass2: skipped (pass1 produced enough pairs)")

        n_fwd_total = len(ranked_fwd)
        n_rev_total = len(ranked_rev)
        _filter_label = _blast_filter_label(req.check_three_prime_specificity)
        log_primer_diagnostic(
            f"BLAST total: {len(blast_passing_fwd)}/{n_fwd_total} fwd, "
            f"{len(blast_passing_rev)}/{n_rev_total} rev pass ({_filter_label}) "
            f"[{total_cached} cache hits, {total_blasted} newly BLASTed]"
        )

        # Intersect with fwd/rev sets so pass1 rev-seq matches don't leak into fwd and vice versa
        blast_passing_fwd &= fwd_set_all
        blast_passing_rev &= rev_set_all

        validation = _validate_stranded_blast_passing(blast_passing_fwd, blast_passing_rev)
        if validation:
            _set_primer_progress_payload(validation["progress"])
            return validation["response"]
        
        # Stage 7: Build pairs only from BLAST-passing primers
        _set_primer_progress_payload({"active": True, "stage": "building", "progress": 80, "message": "Building validated pairs..."})
        _check_abort()

        # Filter to BLAST-passing primers
        fwd_final = fwd_to_blast[fwd_to_blast['sequences'].isin(blast_passing_fwd)].reset_index(drop=True)
        rev_final = rev_to_blast[rev_to_blast['sequences'].isin(blast_passing_rev)].reset_index(drop=True)

        # Iterative window: start tight, expand if no results (fast — only pairing changes)
        product_range = req.max_product - req.min_product
        step = max(1000, product_range // 5)
        pairs = []

        for effective_max in range(req.min_product + step, req.max_product + step + 1, step):
            effective_max = min(effective_max, req.max_product)
            _set_primer_progress_payload({"active": True, "stage": "building", "progress": 80,
                                      "message": f"Trying product range {req.min_product:,}-{effective_max:,}bp..."})
            _check_abort()

            result = fast_find_pairs_vectorized(
                fwd_final, rev_final,
                target_start, target_end,
                req.min_product, effective_max, req.max_tm_diff
            )

            if result[0] is None:
                if effective_max >= req.max_product:
                    break
                log_primer_diagnostic(f"  Window {req.min_product}-{effective_max}: no pairs, expanding...")
                continue

            valid_fwd_final, valid_rev_final, (fwd_idx, rev_idx) = result
            log_primer_diagnostic(f"  Window {req.min_product}-{effective_max}: {len(fwd_idx)} pairs")

            # Build pair dicts
            fwd_starts = valid_fwd_final['starts'].values
            fwd_ends = valid_fwd_final['ends'].values
            fwd_seqs = valid_fwd_final['sequences'].values
            fwd_tms = valid_fwd_final['tms'].values
            fwd_lens = valid_fwd_final['length'].values

            rev_starts = valid_rev_final['starts'].values
            rev_left = valid_rev_final['left_edge'].values
            rev_seqs = valid_rev_final['sequences'].values
            rev_tms = valid_rev_final['tms'].values
            rev_lens = valid_rev_final['length'].values

            pairs = []
            for fi, ri in zip(fwd_idx, rev_idx):
                product_size = int(rev_starts[ri] - fwd_starts[fi])
                pairs.append({
                    'fwd_seq': fwd_seqs[fi],
                    'fwd_start': int(fwd_starts[fi]),
                    'fwd_end': int(fwd_ends[fi]),
                    'fwd_tm': round(float(fwd_tms[fi]), 1),
                    'fwd_len': int(fwd_lens[fi]),
                    'rev_seq': rev_seqs[ri],
                    'rev_start': int(rev_left[ri]),
                    'rev_end': int(rev_starts[ri]),
                    'rev_tm': round(float(rev_tms[ri]), 1),
                    'rev_len': int(rev_lens[ri]),
                    'product_size': product_size,
                    'tm_diff': round(abs(float(fwd_tms[fi]) - float(rev_tms[ri])), 1),
                    'g_count': fwd_seqs[fi].count('G') + rev_seqs[ri].count('G'),
                    'fwd_distance': int(target_start - fwd_ends[fi]),
                    'rev_distance': int(rev_left[ri] - target_end),
                    'fwd_blast_hits': blast_hit_counts.get(fwd_seqs[fi], 0),
                    'rev_blast_hits': blast_hit_counts.get(rev_seqs[ri], 0),
                })

            if pairs:
                log_primer_diagnostic(f"  Found {len(pairs)} pairs in window {req.min_product}-{effective_max}")
                break

        if not pairs:
            _set_primer_progress_payload({"active": False, "stage": "done", "progress": 100, "message": ""})
            return {"success": False, "message": "No valid pairs from BLAST-passing primers across all product size windows"}

        # Stage 8: Score, dimer check, return top N
        _set_primer_progress_payload({"active": True, "stage": "dimers", "progress": 90, "message": f"Scoring {len(pairs)} pairs..."})

        # Sort by score
        for p in pairs:
            if req.optimize_for == "closest":
                total_distance = p['fwd_distance'] + p['rev_distance']
                p['score'] = (
                    total_distance +
                    p['g_count'] * 0.1 +
                    p['tm_diff'] * 0.05
                )
            else:
                target_size = (req.min_product + req.max_product) / 2
                p['score'] = (
                    p['g_count'] * 10 +
                    p['tm_diff'] * 5 +
                    abs(p['product_size'] - target_size) / 100
                )

        pairs.sort(key=lambda x: x['score'])

        # Collect top N pairs that pass dimer check + minimum spacing
        top_pairs = []
        accepted_fwd_starts = []
        accepted_rev_starts = []
        checked = 0
        for p in pairs:
            if checked >= 200:
                break
            checked += 1

            # Dimer check
            try:
                dimer_tm = primer3.bindings.calc_heterodimer(p['rev_seq'], p['fwd_seq']).tm
                if dimer_tm >= 40:
                    continue
            except Exception:
                pass

            # Diversity: skip if too close to an already-accepted pair
            if top_pairs and req.min_spacing > 0:
                too_close = False
                for af, ar in zip(accepted_fwd_starts, accepted_rev_starts):
                    if abs(p['fwd_start'] - af) < req.min_spacing and abs(p['rev_start'] - ar) < req.min_spacing:
                        too_close = True
                        break
                if too_close:
                    continue

            top_pairs.append({k: v for k, v in p.items() if k != 'score'})
            accepted_fwd_starts.append(p['fwd_start'])
            accepted_rev_starts.append(p['rev_start'])
            if len(top_pairs) >= req.max_results:
                break

        if not top_pairs:
            _set_primer_progress_payload({"active": False, "stage": "done", "progress": 100, "message": ""})
            return {"success": False, "message": "All primer pairs failed dimer check"}

        log_primer_diagnostic(f"Returning {len(top_pairs)} primer pairs")

        # Done
        _set_primer_progress_payload({"active": False, "stage": "done", "progress": 100, "message": "Complete!"})

        # Store in state for display
        _set_primer_result(state, {
            'chrom': req.chrom,
            'target_start': target_start,
            'target_end': target_end,
            'pairs': top_pairs,
            'pair': top_pairs[0]
        })

        return {
            "success": True,
            "chrom": req.chrom,
            "target_start": target_start,
            "target_end": target_end,
            "pairs": top_pairs,
            "pair": top_pairs[0],
            "message": f"Found {len(top_pairs)} primer pair(s)",
            **({"warning": blast_db_mismatch_warning} if blast_db_mismatch_warning else {})
        }
        
    except PrimerDesignAborted:
        _set_primer_progress_payload({"active": False, "stage": "aborted", "progress": 0, "message": "Aborted"})
        return {"success": False, "message": "Design aborted"}
    except ImportError as e:
        _set_primer_progress_payload({"active": False, "stage": "error", "progress": 0, "message": str(e)})
        return {"success": False, "message": f"Missing dependency: {e}. Install with: pip install seqfold primer3-py"}
    except Exception as e:
        import traceback
        traceback.print_exc()
        _set_primer_progress_payload({"active": False, "stage": "error", "progress": 0, "message": str(e)})
        return {"success": False, "message": str(e)}
