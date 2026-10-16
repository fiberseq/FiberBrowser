"""Endpoint workflow helper for 4C inverse-PCR primer design."""
from __future__ import annotations

import numpy as np
from typing import Optional

from models.requests import FourCPrimerDesignRequest
from services.primer_candidates import fast_find_primers
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
)
from services.primer_blast_validation import (
    blast_filter_label as _blast_filter_label,
    validate_shared_blast_result as _validate_shared_blast_result,
)
from services.primer_filters import filter_by_exclude_regions as _filter_by_exclude_regions
from services.primer_reference import (
    get_fasta_interface as _get_fasta_interface,
    resolve_chrom as _resolve_chrom,
)

# =============================================================================
# 4C Primer Design — inverse PCR primers facing outward from a viewpoint
# =============================================================================

def design_4c_primers_payload(req: FourCPrimerDesignRequest, state):
    """One design run (its own abort token, released when it ends); see _design_4c_primers_payload."""
    with _primer_design_run():
        return _design_4c_primers_payload(req, state)


def _design_4c_primers_payload(req: FourCPrimerDesignRequest, state):
    """Design outward-facing inverse PCR primers for a 4C viewpoint.

    The two primers sit INSIDE the viewpoint and face OUTWARD:
    - Reverse primer (faces left) near the left side of the viewpoint
    - Forward primer (faces right) near the right side
    When a captured fragment ligates and circularizes, they amplify across the junction.
    """

    runtime_config, config_error = _resolve_primer_runtime_config(state)
    if config_error:
        return config_error
    fasta_path = runtime_config.fasta_path

    try:
        _set_primer_progress_payload({"active": True, "stage": "init", "progress": 0, "message": "Starting 4C design..."})

        from primer_designer import rc
        import primer3

        fetch_seq, get_chrom_len, available_chroms = _get_fasta_interface(state, fasta_path)
        chrom_key = _resolve_chrom(req.chrom, available_chroms)
        if chrom_key is None:
            _set_primer_progress_payload({"active": False, "stage": "error", "progress": 0, "message": ""})
            return {"success": False, "message": f"Chromosome {req.chrom} not in FASTA"}

        chrom_len = get_chrom_len(chrom_key)
        target_start = req.start
        target_end = req.end
        target_size = target_end - target_start

        # As standard design: a viewpoint past the contig end would be clipped
        # by the sequence fetch while reverse primers are placed from its end.
        if target_start < 0 or target_end <= target_start:
            _set_primer_progress_payload({"active": False, "stage": "error", "progress": 0, "message": ""})
            return {"success": False, "message": f"Invalid viewpoint: {req.chrom}:{req.start:,}-{req.end:,}"}
        if target_start >= chrom_len or target_end > chrom_len:
            _set_primer_progress_payload({"active": False, "stage": "error", "progress": 0, "message": ""})
            return {
                "success": False,
                "message": (
                    f"Viewpoint {req.chrom}:{req.start:,}-{req.end:,} exceeds chromosome length "
                    f"({chrom_len:,} bp). Check that the FASTA matches the assembly used for alignment."
                ),
            }

        if target_size < req.min_len * 2 + req.min_spacing:
            _set_primer_progress_payload({"active": False, "stage": "error", "progress": 0, "message": ""})
            return {"success": False, "message": f"Viewpoint too small ({target_size}bp). Need at least {req.min_len * 2 + req.min_spacing}bp for two primers."}

        log_primer_diagnostic("\n=== 4C PRIMER DESIGN ===")
        log_primer_diagnostic(f"Viewpoint: {req.chrom}:{target_start}-{target_end} ({target_size}bp)")

        # Stage 1: Find primers WITHIN the viewpoint
        _set_primer_progress_payload({"active": True, "stage": "search", "progress": 20, "message": "Finding primers within viewpoint..."})
        _check_abort()

        vp_seq = fetch_seq(chrom_key, target_start, target_end)
        vp_seq_rc = rc(vp_seq)

        def _fourc_candidate_progress(label: str, base: int, span: int):
            def _callback(primer_len: int, done: int, total: int, valid_count: Optional[int]):
                status = "scanning" if valid_count is None else f"{valid_count:,} valid at this length"
                _set_primer_progress(
                    "search", base + int(span * done / max(1, total)),
                    f"{label}: {primer_len} bp primers ({done}/{total}); {status}",
                    viewpoint_bp=target_size,
                    primer_length=primer_len,
                    completed_lengths=done,
                    total_lengths=total,
                )
            return _callback

        # Forward primers (face right/outward) — searched on + strand within viewpoint
        fwd_primers = fast_find_primers(vp_seq, target_start, req.min_len, req.max_len, req.min_tm, req.max_tm, req.max_g_count,
                                        max_run_length=req.max_run_length, max_gc_pct=req.max_gc_pct,
                                        tm_method=req.tm_method, check_tandem_repeats=req.check_tandem_repeats,
                                        progress_callback=_fourc_candidate_progress("4C forward candidates", 20, 10))
        fwd_primers['strand'] = '+'
        if not fwd_primers.empty:
            fwd_primers['ends'] = fwd_primers['starts'] + fwd_primers['length']

        # Reverse primers (face left/outward) — searched on - strand within viewpoint
        rev_primers = fast_find_primers(vp_seq_rc, target_start, req.min_len, req.max_len, req.min_tm, req.max_tm, req.max_g_count,
                                        max_run_length=req.max_run_length, max_gc_pct=req.max_gc_pct,
                                        tm_method=req.tm_method, check_tandem_repeats=req.check_tandem_repeats,
                                        progress_callback=_fourc_candidate_progress("4C reverse candidates", 30, 10))
        if not rev_primers.empty:
            rev_primers['starts'] = target_end - (rev_primers['starts'] - target_start)
            rev_primers['strand'] = '-'
            rev_primers['left_edge'] = rev_primers['starts'] - rev_primers['length']

        log_primer_diagnostic(f"Found {len(fwd_primers)} fwd (→) and {len(rev_primers)} rev (←) candidates")

        # Exclude cart-primer footprints before pairing / BLAST.
        if req.exclude_regions:
            before_f, before_r = len(fwd_primers), len(rev_primers)
            fwd_primers = _filter_by_exclude_regions(fwd_primers, True, req.exclude_regions)
            rev_primers = _filter_by_exclude_regions(rev_primers, False, req.exclude_regions)
            if not rev_primers.empty and 'left_edge' not in rev_primers.columns:
                rev_primers['left_edge'] = rev_primers['starts'] - rev_primers['length']
            log_primer_diagnostic(
                f"Excluded {before_f - len(fwd_primers)} fwd / {before_r - len(rev_primers)} "
                "rev 4C primers overlapping cart regions"
            )

        if fwd_primers.empty or rev_primers.empty:
            _set_primer_progress_payload({"active": False, "stage": "done", "progress": 100, "message": ""})
            return {"success": False, "message": "No valid primer candidates within viewpoint"}

        # Stage 2: Find outward-facing pairs
        # Rev primer (faces left) should be to the LEFT of Fwd primer (faces right)
        # rev_left_edge < fwd_start, with spacing constraints
        _set_primer_progress_payload({"active": True, "stage": "pairs", "progress": 40, "message": "Finding outward-facing pairs..."})
        _check_abort()

        fwd_starts = fwd_primers['starts'].values
        fwd_tms = fwd_primers['tms'].values
        rev_left_edges = rev_primers['left_edge'].values
        rev_starts_5p = rev_primers['starts'].values  # 5' end (rightmost)
        rev_tms = rev_primers['tms'].values

        # Spacing = distance between inner edges: fwd_start - rev_starts_5p (rev 5' end)
        # For outward-facing: fwd must be to the RIGHT of rev
        spacing = fwd_starts[np.newaxis, :] - rev_starts_5p[:, np.newaxis]  # (Nrev, Nfwd)
        tm_diffs = np.abs(rev_tms[:, np.newaxis] - fwd_tms[np.newaxis, :])

        valid_mask = (
            (spacing >= req.min_spacing) &
            (spacing <= req.max_spacing) &
            (tm_diffs <= req.max_tm_diff)
        )
        rev_idx, fwd_idx = np.where(valid_mask)

        log_primer_diagnostic(f"Found {len(fwd_idx)} valid outward-facing pairs")
        _set_primer_progress(
            "pairs", 45,
            f"Found {len(fwd_idx):,} outward-facing candidate pairs",
            candidate_pairs=len(fwd_idx),
        )

        if len(fwd_idx) == 0:
            _set_primer_progress_payload({"active": False, "stage": "done", "progress": 100, "message": ""})
            return {"success": False, "message": f"No valid outward-facing pairs (tried spacing {req.min_spacing}-{req.max_spacing}bp). Try adjusting spacing or Tm parameters."}

        # Stage 3: BLAST
        _set_primer_progress_payload({"active": True, "stage": "blast", "progress": 55, "message": "BLASTing primers..."})

        unique_fwd_seqs = fwd_primers['sequences'].values[np.unique(fwd_idx)]
        unique_rev_seqs = rev_primers['sequences'].values[np.unique(rev_idx)]
        all_seqs = set(unique_fwd_seqs) | set(unique_rev_seqs)
        _set_primer_progress("blast", 55, f"BLASTing {len(all_seqs):,} unique primers...", unique_primers=len(all_seqs))
        log_primer_diagnostic(f"BLASTing {len(all_seqs)} unique primers")

        blast_passing, _4c_hit_counts, n_cached, n_blasted, stderr_text = blast_and_score_cached(
            list(all_seqs),
            runtime_config.blast_db_path,
            check_three_prime=req.check_three_prime_specificity,
        )
        validation = _validate_shared_blast_result(blast_passing, _4c_hit_counts, stderr_text)
        if validation:
            _set_primer_progress_payload(validation["progress"])
            return validation["response"]
        _filter_label = _blast_filter_label(req.check_three_prime_specificity)
        log_primer_diagnostic(
            f"BLAST: {len(blast_passing)}/{len(all_seqs)} primers pass ({_filter_label}) "
            f"[{n_cached} cache hits, {n_blasted} newly BLASTed]"
        )

        # Stage 4: Build pairs from BLAST-passing primers
        _set_primer_progress_payload({"active": True, "stage": "building", "progress": 80, "message": "Building validated pairs..."})
        _check_abort()

        pairs = []
        for ri, fi in zip(rev_idx, fwd_idx):
            fwd = fwd_primers.iloc[fi]
            rev = rev_primers.iloc[ri]
            if fwd['sequences'] not in blast_passing or rev['sequences'] not in blast_passing:
                continue

            # Dimer check
            try:
                dt = primer3.bindings.calc_heterodimer(fwd['sequences'], rev['sequences']).tm
                if dt >= 40:
                    continue
            except Exception:
                pass

            inner_spacing = int(fwd['starts'] - rev['starts'])
            outer_span = int(fwd['ends'] - rev['left_edge'])

            pairs.append({
                'fwd_seq': fwd['sequences'],
                'fwd_start': int(fwd['starts']),
                'fwd_end': int(fwd['ends']),
                'fwd_tm': round(float(fwd['tms']), 1),
                'fwd_len': int(fwd['length']),
                'rev_seq': rev['sequences'],
                'rev_start': int(rev['left_edge']),
                'rev_end': int(rev['starts']),
                'rev_tm': round(float(rev['tms']), 1),
                'rev_len': int(rev['length']),
                'product_size': outer_span,  # repurpose as viewpoint span
                'tm_diff': round(abs(float(fwd['tms']) - float(rev['tms'])), 1),
                'g_count': fwd['sequences'].count('G') + rev['sequences'].count('G'),
                'fwd_distance': int(fwd['starts'] - target_start),   # distance from left edge
                'rev_distance': int(target_end - rev['starts']),      # distance from right edge
            })

        log_primer_diagnostic(f"Built {len(pairs)} BLAST-validated 4C pairs")

        if not pairs:
            _set_primer_progress_payload({"active": False, "stage": "done", "progress": 100, "message": ""})
            return {"success": False, "message": "No valid 4C pairs after BLAST + dimer filtering"}

        # Score: tightest pair wins
        for p in pairs:
            p['score'] = p['product_size'] + p['tm_diff'] * 5 + p['g_count'] * 2

        pairs.sort(key=lambda x: x['score'])

        # Deduplicate + select top N
        top_pairs = []
        for p in pairs:
            if len(top_pairs) >= req.max_results:
                break
            # Diversity: skip if too close to accepted pair
            too_close = any(
                abs(p['fwd_start'] - a['fwd_start']) < 20 and abs(p['rev_start'] - a['rev_start']) < 20
                for a in top_pairs
            )
            if too_close:
                continue
            top_pairs.append({k: v for k, v in p.items() if k != 'score'})

        if not top_pairs:
            _set_primer_progress_payload({"active": False, "stage": "done", "progress": 100, "message": ""})
            return {"success": False, "message": "No diverse 4C pairs found"}

        log_primer_diagnostic(f"Returning {len(top_pairs)} 4C primer pairs")
        _set_primer_progress_payload({"active": False, "stage": "done", "progress": 100, "message": "Complete!"})
        _set_primer_result(state, {
            "mode": "4c",
            "chrom": req.chrom,
            "target_start": target_start,
            "target_end": target_end,
            "pairs": top_pairs,
            "pair": top_pairs[0],
        })

        return {
            "success": True,
            "chrom": req.chrom,
            "target_start": target_start,
            "target_end": target_end,
            "pairs": top_pairs,
            "pair": top_pairs[0],
            "message": f"Found {len(top_pairs)} 4C primer pair(s)",
        }

    except PrimerDesignAborted:
        _set_primer_progress_payload({"active": False, "stage": "aborted", "progress": 0, "message": "Aborted"})
        return {"success": False, "message": "Design aborted"}
    except ImportError as e:
        _set_primer_progress_payload({"active": False, "stage": "error", "progress": 0, "message": str(e)})
        return {"success": False, "message": f"Missing dependency: {e}"}
    except Exception as e:
        import traceback
        traceback.print_exc()
        _set_primer_progress_payload({"active": False, "stage": "error", "progress": 0, "message": str(e)})
        return {"success": False, "message": str(e)}
