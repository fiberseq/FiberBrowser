"""Endpoint workflow helper for DAF-C / 3C primer design."""
from __future__ import annotations

import numpy as np
from typing import Optional

from models.requests import DafcPrimerDesignRequest
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
from services.primer_filters import subsample_pair_indices as _subsample_pair_indices
from services.primer_loci import (
    find_locus_primers as _find_locus_primers,
    find_valid_pair_indices as _find_valid_pair_indices,
)
from services.primer_reference import (
    get_fasta_interface as _get_fasta_interface,
    resolve_chrom as _resolve_chrom,
)
from services.read_metrics import normalize_sample_seed


def tm_compatible_quads(x_pair_tms, y_pair_tms, max_tm_diff, limit=20000, max_cells=4_000_000):
    """(i, j) of X/Y primer pairs whose four Tms span at most ``max_tm_diff``.

    Row-major like ``np.where`` over the full Nx x Ny grid, but a block of X
    pairs at a time from each pair's Tm min/max (a quad's range is
    max(xmax, ymax) - min(xmin, ymin)), stopping after ``limit`` hits: the full
    (Nx, Ny, 4) array for 50k x 50k pairs would need 80 GB.
    """
    x_pair_tms = np.asarray(x_pair_tms, dtype=np.float64)
    y_pair_tms = np.asarray(y_pair_tms, dtype=np.float64)
    nx, ny = len(x_pair_tms), len(y_pair_tms)
    empty = (np.array([], dtype=int), np.array([], dtype=int))
    if nx == 0 or ny == 0:
        return empty
    x_min, x_max = x_pair_tms.min(axis=1), x_pair_tms.max(axis=1)
    y_min, y_max = y_pair_tms.min(axis=1), y_pair_tms.max(axis=1)
    block = max(1, max_cells // ny)
    rows, cols, found = [], [], 0
    for start in range(0, nx, block):
        stop = min(nx, start + block)
        hi = np.maximum(x_max[start:stop, None], y_max[None, :])
        lo = np.minimum(x_min[start:stop, None], y_min[None, :])
        bi, bj = np.nonzero(hi - lo <= max_tm_diff)
        if len(bi):
            rows.append(bi + start)
            cols.append(bj)
            found += len(bi)
            if found >= limit:
                break
    if not rows:
        return empty
    return np.concatenate(rows)[:limit], np.concatenate(cols)[:limit]


def design_dafc_primers_payload(req: DafcPrimerDesignRequest, state):
    """One design run (its own abort token, released when it ends); see _design_dafc_primers_payload."""
    with _primer_design_run():
        return _design_dafc_primers_payload(req, state)


def _design_dafc_primers_payload(req: DafcPrimerDesignRequest, state):
    """Design Tm-compatible primer pairs for two 3C loci."""
    sample_seed = normalize_sample_seed(req.sample_seed)

    runtime_config, config_error = _resolve_primer_runtime_config(state)
    if config_error:
        return config_error
    fasta_path = runtime_config.fasta_path

    try:
        _set_primer_progress_payload({"active": True, "stage": "init", "progress": 0, "message": "Starting DAF-C design..."})

        from primer_designer import rc
        import primer3

        fetch_seq, get_chrom_len, available_chroms = _get_fasta_interface(state, fasta_path)
        chrom_key = _resolve_chrom(req.chrom, available_chroms)
        if chrom_key is None:
            _set_primer_progress_payload({"active": False, "stage": "error", "progress": 0, "message": ""})
            return {"success": False, "message": f"Chromosome {req.chrom} not in FASTA"}

        chrom_len = get_chrom_len(chrom_key)

        # Resolve Locus Y chromosome (may differ for cross-chrom 3C)
        y_chrom_key = chrom_key
        y_chrom_len = chrom_len
        if req.y_chrom and req.y_chrom != req.chrom:
            y_chrom_key = _resolve_chrom(req.y_chrom, available_chroms)
            if y_chrom_key is None:
                _set_primer_progress_payload({"active": False, "stage": "error", "progress": 0, "message": ""})
                return {"success": False, "message": f"Chromosome {req.y_chrom} not in FASTA"}
            y_chrom_len = get_chrom_len(y_chrom_key)

        log_primer_diagnostic("\n=== DAF-C PRIMER DESIGN ===")
        log_primer_diagnostic(f"Locus X: {req.chrom}:{req.x_start}-{req.x_end}")
        log_primer_diagnostic(f"Locus Y: {req.y_chrom or req.chrom}:{req.y_start}-{req.y_end}")

        # Stage 1: Find primers for each locus
        _set_primer_progress_payload({"active": True, "stage": "search", "progress": 20, "message": "Finding primers for Locus X..."})

        # Map the per-chromosome exclusion dict onto each locus. The frontend
        # keys by the requested chrom string; since the FASTA may carry a
        # 'chr'-prefix variant, check both spellings defensively.
        def _exclusion_for(chrom_name):
            if not req.exclude_regions:
                return None
            if chrom_name in req.exclude_regions:
                return req.exclude_regions[chrom_name]
            alt = chrom_name[3:] if chrom_name.startswith('chr') else f'chr{chrom_name}'
            return req.exclude_regions.get(alt)

        def _dafc_candidate_progress(locus_label: str, base: int, span: int):
            def _callback(strand: str, primer_len: int, done: int, total: int,
                          valid_count: Optional[int], window_bp: int):
                strand_label = "forward" if strand == "forward" else "reverse"
                strand_base = base if strand == "forward" else base + span // 2
                strand_span = max(1, span // 2)
                status = "scanning" if valid_count is None else f"{valid_count:,} valid at this length"
                _set_primer_progress(
                    "search", strand_base + int(strand_span * done / max(1, total)),
                    f"{locus_label} {strand_label}: {primer_len} bp primers ({done}/{total}); {status}",
                    locus=locus_label,
                    strand=strand,
                    window_bp=window_bp,
                    primer_length=primer_len,
                )
            return _callback

        result_x, err_x = _find_locus_primers(fetch_seq, chrom_key, chrom_len, req.x_start, req.x_end, req, rc,
                                              exclude_regions=_exclusion_for(req.chrom),
                                              progress_callback=_dafc_candidate_progress("Locus X", 20, 15))
        if result_x is None:
            _set_primer_progress_payload({"active": False, "stage": "error", "progress": 0, "message": ""})
            return {"success": False, "message": f"Locus X: {err_x}"}
        valid_fwd_x, valid_rev_x, x_fwd_idx, x_rev_idx = result_x

        _set_primer_progress_payload({"active": True, "stage": "search", "progress": 35, "message": "Finding primers for Locus Y..."})

        y_chrom_name = req.y_chrom or req.chrom
        result_y, err_y = _find_locus_primers(fetch_seq, y_chrom_key, y_chrom_len, req.y_start, req.y_end, req, rc,
                                              exclude_regions=_exclusion_for(y_chrom_name),
                                              progress_callback=_dafc_candidate_progress("Locus Y", 35, 15))
        if result_y is None:
            _set_primer_progress_payload({"active": False, "stage": "error", "progress": 0, "message": ""})
            return {"success": False, "message": f"Locus Y: {err_y}"}
        valid_fwd_y, valid_rev_y, y_fwd_idx, y_rev_idx = result_y

        log_primer_diagnostic(f"Locus X: {len(x_fwd_idx)} valid pairs from {len(valid_fwd_x)} fwd + {len(valid_rev_x)} rev")
        log_primer_diagnostic(f"Locus Y: {len(y_fwd_idx)} valid pairs from {len(valid_fwd_y)} fwd + {len(valid_rev_y)} rev")
        _set_primer_progress(
            "pairs", 52,
            f"Locus X has {len(x_fwd_idx):,} candidate pairs; Locus Y has {len(y_fwd_idx):,}",
            locus_x_pairs=len(x_fwd_idx),
            locus_y_pairs=len(y_fwd_idx),
        )

        _check_abort()

        # Stage 2: BLAST all unique primers from valid within-locus pairs

        # Collect unique primers that appear in at least one valid pair
        all_seqs = set()
        all_seqs.update(valid_fwd_x['sequences'].values[np.unique(x_fwd_idx)])
        all_seqs.update(valid_rev_x['sequences'].values[np.unique(x_rev_idx)])
        all_seqs.update(valid_fwd_y['sequences'].values[np.unique(y_fwd_idx)])
        all_seqs.update(valid_rev_y['sequences'].values[np.unique(y_rev_idx)])

        log_primer_diagnostic(f"BLASTing {len(all_seqs)} unique primers")
        _set_primer_progress(
            "blast", 60,
            f"BLASTing {len(all_seqs):,} unique primers across both loci...",
            unique_primers=len(all_seqs),
        )

        blast_passing, _dafc_hit_counts, n_cached, n_blasted, stderr_text = blast_and_score_cached(
            list(all_seqs),
            runtime_config.blast_db_path,
            check_three_prime=req.check_three_prime_specificity,
        )
        validation = _validate_shared_blast_result(blast_passing, _dafc_hit_counts, stderr_text)
        if validation:
            _set_primer_progress_payload(validation["progress"])
            return validation["response"]
        _filter_label = _blast_filter_label(req.check_three_prime_specificity)
        log_primer_diagnostic(
            f"BLAST: {len(blast_passing)}/{len(all_seqs)} primers pass ({_filter_label}) "
            f"[{n_cached} cache hits, {n_blasted} newly BLASTed]"
        )

        # Stage 4: Filter to BLAST-passing primers, re-pair, cross-Tm check, dimer check
        _check_abort()
        _set_primer_progress_payload({"active": True, "stage": "building", "progress": 75, "message": f"Filtering to {len(blast_passing)} BLAST-passing primers..."})

        # Filter each locus's primers to BLAST-passing only
        bfwd_x = valid_fwd_x[valid_fwd_x['sequences'].isin(blast_passing)].reset_index(drop=True)
        brev_x = valid_rev_x[valid_rev_x['sequences'].isin(blast_passing)].reset_index(drop=True)
        bfwd_y = valid_fwd_y[valid_fwd_y['sequences'].isin(blast_passing)].reset_index(drop=True)
        brev_y = valid_rev_y[valid_rev_y['sequences'].isin(blast_passing)].reset_index(drop=True)

        log_primer_diagnostic(
            f"After BLAST filter: X={len(bfwd_x)} fwd + {len(brev_x)} rev, "
            f"Y={len(bfwd_y)} fwd + {len(brev_y)} rev"
        )

        if bfwd_x.empty or brev_x.empty or bfwd_y.empty or brev_y.empty:
            _set_primer_progress_payload({"active": False, "stage": "done", "progress": 100, "message": ""})
            return {"success": False, "message": "No BLAST-passing primers for one or both loci"}

        # Iterative window: re-pair with expanding product size, stop as soon as cross-locus quads found
        product_range = req.max_product - req.min_product
        step = max(1000, product_range // 5)
        cqi = np.array([], dtype=int)
        cqj = np.array([], dtype=int)
        bx_fi = bx_ri = by_fi = by_ri = np.array([], dtype=int)
        Nx = Ny = 0  # no pairs at one or both loci in any window

        for effective_max in range(req.min_product + step, req.max_product + step + 1, step):
            effective_max = min(effective_max, req.max_product)
            _check_abort()
            _set_primer_progress_payload({"active": True, "stage": "pairs", "progress": 82,
                                      "message": f"Trying product range {req.min_product:,}-{effective_max:,}bp..."})

            # Build a lightweight req-like object with the effective max
            class _EffReq:
                pass
            eff = _EffReq()
            eff.min_product = req.min_product
            eff.max_product = effective_max
            eff.max_tm_diff = req.max_tm_diff

            rx = _find_valid_pair_indices(bfwd_x, brev_x, eff)
            ry = _find_valid_pair_indices(bfwd_y, brev_y, eff)

            if rx is None or ry is None:
                if effective_max >= req.max_product:
                    break
                log_primer_diagnostic(
                    f"  Window {req.min_product}-{effective_max}: no pairs at one or both loci, expanding..."
                )
                continue

            bx_fi, bx_ri = rx
            by_fi, by_ri = ry

            # Safety cap
            MAX_PAIRS = 50000
            bx_fi, bx_ri = _subsample_pair_indices(
                bx_fi, bx_ri, MAX_PAIRS, sample_seed,
                "x", chrom_key, req.x_start, req.x_end, effective_max,
            )
            by_fi, by_ri = _subsample_pair_indices(
                by_fi, by_ri, MAX_PAIRS, sample_seed,
                "y", y_chrom_key, req.y_start, req.y_end, effective_max,
            )

            # Cross-locus Tm compatibility
            Nx, Ny = len(bx_fi), len(by_fi)
            _set_primer_progress_payload({"active": True, "stage": "pairs", "progress": 85,
                                      "message": f"Cross-checking {Nx}x{Ny} pairs ({req.min_product:,}-{effective_max:,}bp)..."})

            x_pair_tms = np.column_stack([bfwd_x['tms'].values[bx_fi], brev_x['tms'].values[bx_ri]])
            y_pair_tms = np.column_stack([bfwd_y['tms'].values[by_fi], brev_y['tms'].values[by_ri]])
            cqi, cqj = tm_compatible_quads(x_pair_tms, y_pair_tms, req.max_tm_diff)

            if len(cqi) > 0:
                log_primer_diagnostic(
                    f"  Window {req.min_product}-{effective_max}: {len(cqi)} Tm-compatible quads from {Nx}x{Ny}"
                )
                break
            log_primer_diagnostic(
                f"  Window {req.min_product}-{effective_max}: 0 Tm-compatible quads from {Nx}x{Ny}, expanding..."
            )

        if len(cqi) == 0:
            _set_primer_progress_payload({"active": False, "stage": "done", "progress": 100, "message": ""})
            return {"success": False, "message": f"No Tm-compatible quads from BLAST-passing primers ({Nx}x{Ny} pairs). Try widening max Tm diff."}

        def _build_pair_dict(fwd_row, rev_row, target_start, target_end):
            return {
                'fwd_seq': fwd_row['sequences'],
                'fwd_start': int(fwd_row['starts']),
                'fwd_end': int(fwd_row['ends']),
                'fwd_tm': round(float(fwd_row['tms']), 1),
                'fwd_len': int(fwd_row['length']),
                'rev_seq': rev_row['sequences'],
                'rev_start': int(rev_row['left_edge']),
                'rev_end': int(rev_row['starts']),
                'rev_tm': round(float(rev_row['tms']), 1),
                'rev_len': int(rev_row['length']),
                'product_size': int(rev_row['starts'] - fwd_row['starts']),
                'tm_diff': round(abs(float(fwd_row['tms']) - float(rev_row['tms'])), 1),
                'g_count': fwd_row['sequences'].count('G') + rev_row['sequences'].count('G'),
                'fwd_distance': int(target_start - fwd_row['ends']),
                'rev_distance': int(rev_row['left_edge'] - target_end),
            }

        # Build quads with dimer check
        quads = []
        dimer_failed = 0
        for i, j in zip(cqi, cqj):
            if len(quads) >= 200:  # Enough candidates for scoring
                break

            fwd_x = bfwd_x.iloc[bx_fi[i]]
            rev_x = brev_x.iloc[bx_ri[i]]
            fwd_y = bfwd_y.iloc[by_fi[j]]
            rev_y = brev_y.iloc[by_ri[j]]

            seqs = [fwd_x['sequences'], rev_x['sequences'], fwd_y['sequences'], rev_y['sequences']]

            # Dimer check: 4 reaction-relevant pairs
            dimer_ok = True
            for a_idx, b_idx in [(0, 1), (2, 3), (0, 3), (2, 1)]:
                try:
                    dt = primer3.bindings.calc_heterodimer(seqs[a_idx], seqs[b_idx]).tm
                    if dt >= 40:
                        dimer_ok = False
                        break
                except Exception:
                    pass
            if not dimer_ok:
                dimer_failed += 1
                continue

            tms = [float(fwd_x['tms']), float(rev_x['tms']), float(fwd_y['tms']), float(rev_y['tms'])]
            max_tm_range_val = round(max(tms) - min(tms), 1)

            x_pair = _build_pair_dict(fwd_x, rev_x, req.x_start, req.x_end)
            y_pair = _build_pair_dict(fwd_y, rev_y, req.y_start, req.y_end)

            x_dist = x_pair['fwd_distance'] + x_pair['rev_distance']
            y_dist = y_pair['fwd_distance'] + y_pair['rev_distance']
            score = x_dist + y_dist + max_tm_range_val * 10

            quads.append({
                'x_pair': x_pair,
                'y_pair': y_pair,
                'max_tm_range': max_tm_range_val,
                'score': score,
            })

        quads.sort(key=lambda q: q['score'])

        # Deduplicate
        top_quads = []
        used_seqs = set()
        for q in quads:
            key = (q['x_pair']['fwd_seq'], q['x_pair']['rev_seq'], q['y_pair']['fwd_seq'], q['y_pair']['rev_seq'])
            if key in used_seqs:
                continue
            used_seqs.add(key)
            top_quads.append({k: v for k, v in q.items() if k != 'score'})
            if len(top_quads) >= req.max_results:
                break

        log_primer_diagnostic(
            f"Quad building: {len(cqi)} Tm-compatible, {dimer_failed} failed dimer, {len(quads)} passed"
        )

        if not top_quads:
            _set_primer_progress_payload({"active": False, "stage": "done", "progress": 100, "message": ""})
            return {"success": False, "message": f"No valid quads found ({dimer_failed} failed dimer). Try widening Tm range."}

        log_primer_diagnostic(f"Returning {len(top_quads)} DAF-C primer quads")
        _set_primer_progress_payload({"active": False, "stage": "done", "progress": 100, "message": "Complete!"})
        _set_primer_result(state, {
            "mode": "dafc",
            "chrom": req.chrom,
            "locus_x": {"target_start": req.x_start, "target_end": req.x_end},
            "locus_y": {"target_start": req.y_start, "target_end": req.y_end},
            "quads": top_quads,
            "sample_seed": sample_seed,
        })

        return {
            "success": True,
            "chrom": req.chrom,
            "locus_x": {"target_start": req.x_start, "target_end": req.x_end},
            "locus_y": {"target_start": req.y_start, "target_end": req.y_end},
            "quads": top_quads,
            "sample_seed": sample_seed,
            "message": f"Found {len(top_quads)} compatible primer quad(s)",
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
