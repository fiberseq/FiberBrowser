"""Primer candidate scanning and pair construction helpers."""
from __future__ import annotations

import numpy as np

from services.primer_blast_runtime import blast_and_score_cached, check_abort
from services.primer_config import log_primer_diagnostic

PAIR_MATRIX_MAX_CELLS = 2_000_000

PRIMER_TM_METHODS = {
    "snapgene",
    "primer3",
    "owczarzy",
    "breslauer",
    "wallace",
}


def normalize_tm_method(method: str | None) -> str:
    """Normalize frontend Tm method IDs to supported backend methods."""
    value = (method or "primer3").strip().lower().replace("-", "_")
    aliases = {
        "snapgene_like": "snapgene",
        "snapgene_nn": "snapgene",
        "primer3_default": "primer3",
        "santalucia_owczarzy": "owczarzy",
        "santalucia": "primer3",
        "breslauer_legacy": "breslauer",
        "wallace_2_4": "wallace",
    }
    value = aliases.get(value, value)
    return value if value in PRIMER_TM_METHODS else "primer3"


def calc_primer_tm(seq: str, method: str | None = "primer3") -> float:
    """Calculate primer Tm with one of the selectable PCR-facing methods."""
    sequence = str(seq).upper()
    mode = normalize_tm_method(method)
    if mode == "wallace":
        gc = sequence.count("G") + sequence.count("C")
        at = sequence.count("A") + sequence.count("T")
        return float(4 * gc + 2 * at)

    import primer3 as _p3

    if mode == "primer3":
        return float(_p3.calc_tm(sequence))
    if mode == "snapgene":
        return float(_p3.calc_tm(
            sequence,
            mv_conc=50.0,
            dv_conc=0.0,
            dntp_conc=0.0,
            dna_conc=250.0,
            tm_method="santalucia",
            salt_corrections_method="santalucia",
        ))
    if mode == "owczarzy":
        return float(_p3.calc_tm(
            sequence,
            mv_conc=50.0,
            dv_conc=1.5,
            dntp_conc=0.6,
            dna_conc=50.0,
            tm_method="santalucia",
            salt_corrections_method="owczarzy",
        ))
    if mode == "breslauer":
        return float(_p3.calc_tm(
            sequence,
            mv_conc=50.0,
            dv_conc=0.0,
            dntp_conc=0.0,
            dna_conc=50.0,
            tm_method="breslauer",
            salt_corrections_method="schildkraut",
        ))

    return float(_p3.calc_tm(sequence))


def has_tandem_repeat(seq: str, max_unit_size: int = 4, min_copies: int = 4) -> bool:
    """Return True for short-period tandem repeats such as ACACACACACAC."""
    sequence = str(seq).upper()
    n = len(sequence)
    if n == 0 or min_copies <= 1:
        return False

    for unit_size in range(2, max(2, max_unit_size) + 1):
        repeat_span = unit_size * min_copies
        if repeat_span > n:
            continue
        for start in range(0, n - repeat_span + 1):
            unit = sequence[start:start + unit_size]
            if len(set(unit)) == 1:
                continue
            copies = 1
            cursor = start + unit_size
            while cursor + unit_size <= n and sequence[cursor:cursor + unit_size] == unit:
                copies += 1
                if copies >= min_copies:
                    return True
                cursor += unit_size
    return False


def fast_find_primers(seq, start_pos, min_len, max_len, min_tm, max_tm, max_gs=2,
                      max_run_length=4, max_gc_pct=70.0, progress_callback=None,
                      tm_method="primer3", check_tandem_repeats=True):
    """
    Find valid DAF-seq primer candidates in a sequence window.

    max_run_length: reject primers with any homopolymer run of this length or longer
        (e.g., 4 rejects AAAA+). Set to 0 or a value > max_len to disable.
    max_gc_pct: reject primers whose GC% exceeds this value. DAF-seq primers skew
        C-rich because Gs are capped at max_gs, so this bounds overall GC content.
        Set to 100 to disable.
    check_tandem_repeats: reject short-period tandem repeats such as ACACACAC.
    """
    results = []
    seq_len = len(seq)

    run_cap = max_run_length if (max_run_length and max_run_length > 0) else (10 ** 6)

    def has_long_run(s):
        n = len(s)
        if run_cap > n:
            return False
        run = 1
        for i in range(1, n):
            if s[i] == s[i - 1]:
                run += 1
                if run >= run_cap:
                    return True
            else:
                run = 1
        return False

    primer_lengths = list(range(min_len, max_len + 1))
    total_lengths = len(primer_lengths)
    for length_i, primer_len in enumerate(primer_lengths, start=1):
        check_abort()
        if progress_callback:
            progress_callback(primer_len, length_i - 1, total_lengths, None)
        if seq_len < primer_len:
            if progress_callback:
                progress_callback(primer_len, length_i, total_lengths, 0)
            continue

        n_primers = seq_len - primer_len + 1
        primers = np.array([seq[i:i + primer_len] for i in range(n_primers)])
        positions = np.arange(n_primers) + start_pos

        if len(primers) == 0:
            continue

        def check_gs(s):
            if s.count('G') > max_gs:
                return False
            if 'G' in s[-5:]:
                return False
            return True

        g_mask = np.array([check_gs(p) for p in primers])
        run_mask = np.array([not has_long_run(p) for p in primers])
        repeat_mask = np.array([not has_tandem_repeat(p) for p in primers]) if check_tandem_repeats else np.ones(len(primers), dtype=bool)

        def check_gc(s):
            gc = s.count('G') + s.count('C')
            return (gc / len(s) * 100.0) <= max_gc_pct

        gc_mask = np.array([check_gc(p) for p in primers])

        # Only A/C/G/T: an ambiguous base (N etc.) makes primer3's Tm raise.
        acgt_mask = np.array([set(str(p)) <= {'A', 'C', 'G', 'T'} for p in primers])

        cheap_mask = g_mask & run_mask & repeat_mask & gc_mask & acgt_mask
        if not cheap_mask.any():
            if progress_callback:
                progress_callback(primer_len, length_i, total_lengths, 0)
            continue

        primers_cheap = primers[cheap_mask]
        positions_cheap = positions[cheap_mask]

        def calc_tm_vec(seqs):
            return np.array([calc_primer_tm(str(s), tm_method) for s in seqs])

        tms_cheap = calc_tm_vec(primers_cheap)
        tm_mask = (tms_cheap >= min_tm) & (tms_cheap <= max_tm)

        if not tm_mask.any():
            if progress_callback:
                progress_callback(primer_len, length_i, total_lengths, 0)
            continue

        primers_tm = primers_cheap[tm_mask]
        positions_tm = positions_cheap[tm_mask]
        tms_tm = tms_cheap[tm_mask]

        try:
            import primer3 as _p3
            hp_mask = np.array([_p3.bindings.calc_hairpin(str(p)).tm < 45 for p in primers_tm])
            sd_mask = np.array([_p3.bindings.calc_homodimer(str(p)).tm < 45 for p in primers_tm])
        except Exception:
            hp_mask = np.ones(len(primers_tm), dtype=bool)
            sd_mask = np.ones(len(primers_tm), dtype=bool)

        mask = hp_mask & sd_mask

        for pos, primer, tm in zip(positions_tm[mask], primers_tm[mask], tms_tm[mask]):
            results.append({
                'starts': pos,
                'sequences': str(primer),
                'tms': tm,
                'length': primer_len,
            })
        if progress_callback:
            progress_callback(primer_len, length_i, total_lengths, int(mask.sum()))

    import pandas as pd

    return pd.DataFrame(results) if results else pd.DataFrame(columns=['starts', 'sequences', 'tms', 'length'])


def fast_find_pairs_vectorized(fwd_df, rev_df, target_start, target_end, min_product, max_product, max_tm_diff=2.0):
    """Find primer pairs outside the target region using NumPy broadcasting."""
    if fwd_df.empty or rev_df.empty:
        return None, None, None

    fwd_df = fwd_df.copy()
    fwd_df['ends'] = fwd_df['starts'] + fwd_df['length']
    valid_fwd = fwd_df[fwd_df['ends'] <= target_start].copy()

    rev_df = rev_df.copy()
    rev_df['left_edge'] = rev_df['starts'] - rev_df['length']
    valid_rev = rev_df[rev_df['left_edge'] >= target_end].copy()

    if valid_fwd.empty or valid_rev.empty:
        return None, None, None

    valid_fwd = valid_fwd.reset_index(drop=True)
    valid_rev = valid_rev.reset_index(drop=True)

    fwd_starts = valid_fwd['starts'].values
    fwd_tms = valid_fwd['tms'].values
    rev_starts = valid_rev['starts'].values
    rev_tms = valid_rev['tms'].values

    fwd_idx, rev_idx = find_valid_pair_indices_chunked(
        fwd_starts,
        fwd_tms,
        rev_starts,
        rev_tms,
        min_product,
        max_product,
        max_tm_diff,
    )

    if len(fwd_idx) == 0:
        return None, None, None

    return valid_fwd, valid_rev, (fwd_idx, rev_idx)


def find_valid_pair_indices_chunked(fwd_starts, fwd_tms, rev_starts, rev_tms,
                                    min_product, max_product, max_tm_diff=2.0,
                                    max_cells: int = PAIR_MATRIX_MAX_CELLS):
    """Return pair indices without materializing the full fwd x rev matrix."""
    n_rev = len(rev_starts)
    if len(fwd_starts) == 0 or n_rev == 0:
        return np.array([], dtype=int), np.array([], dtype=int)

    chunk = max(1, max_cells // max(1, n_rev))
    fwd_parts = []
    rev_parts = []
    for start in range(0, len(fwd_starts), chunk):
        end = min(len(fwd_starts), start + chunk)
        product_sizes = rev_starts[np.newaxis, :] - fwd_starts[start:end, np.newaxis]
        tm_diffs = np.abs(fwd_tms[start:end, np.newaxis] - rev_tms[np.newaxis, :])
        valid_mask = (
            (product_sizes >= min_product) &
            (product_sizes <= max_product) &
            (tm_diffs <= max_tm_diff)
        )
        fi, ri = np.where(valid_mask)
        if len(fi) == 0:
            continue
        fwd_parts.append(fi + start)
        rev_parts.append(ri)

    if not fwd_parts:
        return np.array([], dtype=int), np.array([], dtype=int)
    return np.concatenate(fwd_parts), np.concatenate(rev_parts)


def find_pair_participation(valid_fwd, valid_rev, min_product, max_product, max_tm_diff=2.0,
                            max_cells: int = PAIR_MATRIX_MAX_CELLS):
    """Return boolean masks for primers participating in at least one valid pair."""
    if valid_fwd.empty or valid_rev.empty:
        return np.zeros(len(valid_fwd), dtype=bool), np.zeros(len(valid_rev), dtype=bool)

    fwd_starts = valid_fwd['starts'].values
    fwd_tms = valid_fwd['tms'].values
    rev_starts = valid_rev['starts'].values
    rev_tms = valid_rev['tms'].values

    n_rev = len(rev_starts)
    chunk = max(1, max_cells // max(1, n_rev))
    fwd_mask = np.zeros(len(valid_fwd), dtype=bool)
    rev_mask = np.zeros(len(valid_rev), dtype=bool)

    for start in range(0, len(valid_fwd), chunk):
        end = min(len(valid_fwd), start + chunk)
        product_sizes = rev_starts[np.newaxis, :] - fwd_starts[start:end, np.newaxis]
        tm_diffs = np.abs(fwd_tms[start:end, np.newaxis] - rev_tms[np.newaxis, :])
        valid_mask = (
            (product_sizes >= min_product) &
            (product_sizes <= max_product) &
            (tm_diffs <= max_tm_diff)
        )
        fwd_mask[start:end] = valid_mask.any(axis=1)
        rev_mask |= valid_mask.any(axis=0)

    return fwd_mask, rev_mask


def count_valid_pairs_chunked(fwd_starts, fwd_tms, rev_starts, rev_tms,
                              min_product, max_product, max_tm_diff=2.0,
                              max_cells: int = PAIR_MATRIX_MAX_CELLS) -> int:
    """Count valid pairs without materializing the full fwd x rev matrix."""
    n_rev = len(rev_starts)
    if len(fwd_starts) == 0 or n_rev == 0:
        return 0

    chunk = max(1, max_cells // max(1, n_rev))
    total = 0
    for start in range(0, len(fwd_starts), chunk):
        end = min(len(fwd_starts), start + chunk)
        product_sizes = rev_starts[np.newaxis, :] - fwd_starts[start:end, np.newaxis]
        tm_diffs = np.abs(fwd_tms[start:end, np.newaxis] - rev_tms[np.newaxis, :])
        valid_mask = (
            (product_sizes >= min_product) &
            (product_sizes <= max_product) &
            (tm_diffs <= max_tm_diff)
        )
        total += int(valid_mask.sum())
    return total


def blast_and_build_pairs(valid_fwd, valid_rev, pair_indices, target_start, target_end, blast_db):
    """BLAST unique primers from valid pairs and build final pair dicts."""
    fwd_idx, rev_idx = pair_indices

    unique_fwd_idx = np.unique(fwd_idx)
    unique_rev_idx = np.unique(rev_idx)

    fwd_seqs_to_blast = valid_fwd.iloc[unique_fwd_idx]['sequences'].unique()
    rev_seqs_to_blast = valid_rev.iloc[unique_rev_idx]['sequences'].unique()

    log_primer_diagnostic(
        f"BLASTing {len(fwd_seqs_to_blast)} unique fwd + {len(rev_seqs_to_blast)} unique rev primers"
    )

    seqs_to_blast = list(dict.fromkeys(list(fwd_seqs_to_blast) + list(rev_seqs_to_blast)))
    passing_seqs, _counts, n_cached, n_blasted, stderr_text = blast_and_score_cached(
        seqs_to_blast,
        blast_db,
        check_three_prime=False,
    )
    if stderr_text:
        log_primer_diagnostic(f"BLAST failed for primer pairs: {stderr_text}")
        return []

    if not passing_seqs:
        log_primer_diagnostic("No primers passed BLAST filter")
        return []

    log_primer_diagnostic(
        f"{len(passing_seqs)} primers passed BLAST "
        f"({n_cached} cached, {n_blasted} newly BLASTed)"
    )

    pairs = []
    fwd_data = valid_fwd.to_dict('index')
    rev_data = valid_rev.to_dict('index')

    for fi, ri in zip(fwd_idx, rev_idx):
        fwd = fwd_data[fi]
        rev = rev_data[ri]

        if fwd['sequences'] not in passing_seqs or rev['sequences'] not in passing_seqs:
            continue

        product_size = rev['starts'] - fwd['starts']
        tm_diff = abs(fwd['tms'] - rev['tms'])

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
            'product_size': int(product_size),
            'tm_diff': round(float(tm_diff), 1),
            'g_count': fwd['sequences'].count('G') + rev['sequences'].count('G'),
            'fwd_distance': int(target_start - fwd['ends']),
            'rev_distance': int(rev['left_edge'] - target_end),
        })

    log_primer_diagnostic(f"Built {len(pairs)} pairs from BLAST-passing primers")
    return pairs
