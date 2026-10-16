"""BLAST hit parsing and primer-specificity scoring for primer design."""
from __future__ import annotations

from typing import Dict, List


def apply_blast_filters(seq: str, hits: List[tuple],
                        off_target_min_pident: float = 90.0,
                        off_target_length_frac: float = 0.85,
                        three_prime_window: int = 3,
                        three_prime_min_length: int = 12,
                        three_prime_min_pident: float = 90.0,
                        check_three_prime: bool = True,
                        home_min_pident: float = 99.0) -> dict:
    """Compute on-target, off-target, and 3-prime threat counts from BLAST rows."""
    primer_len = len(seq)
    counts = {'on_target': 0, 'off_target': 0, 'three_prime_threats': 0}
    off_target_min_length = max(12, int(primer_len * off_target_length_frac))
    for (pident, length, qend) in hits:
        if length == primer_len and pident >= home_min_pident:
            counts['on_target'] += 1
            continue
        if pident >= off_target_min_pident and length >= off_target_min_length:
            counts['off_target'] += 1
        if (check_three_prime
                and qend >= (primer_len - three_prime_window)
                and length >= three_prime_min_length
                and pident >= three_prime_min_pident):
            counts['three_prime_threats'] += 1
    return counts


def parse_blast_hits(output_file, seq_to_id, seq_sources=None,
                     off_target_min_pident=90.0, off_target_length_frac=0.85,
                     three_prime_window=3, three_prime_min_length=12, three_prime_min_pident=90.0,
                     check_three_prime=True, home_min_pident=99.0):
    """Parse BLAST tabular output and classify hits per primer.

    BLAST outfmt 6: qseqid pident length qstart qend sseqid sstart send.
    A primer passes iff it has exactly one home hit and off-target /
    3-prime threat counts are both zero.
    Returns (passing_seqs, hit_info, raw_hit_rows_by_seq).
    """
    del seq_sources  # reserved for future use; not consulted here
    per_seq_hits: Dict[str, List[tuple]] = {seq: [] for seq in seq_to_id.values()}

    with open(output_file) as f:
        for line in f:
            parts = line.rstrip('\n').split('\t')
            if len(parts) < 8:
                continue
            qid = parts[0]
            seq = seq_to_id.get(qid)
            if seq is None:
                continue
            try:
                pident = float(parts[1])
                length = int(parts[2])
                qend = int(parts[4])
            except (ValueError, IndexError):
                continue
            per_seq_hits[seq].append((pident, length, qend))

    per_seq = {
        seq: apply_blast_filters(
            seq, hits,
            off_target_min_pident=off_target_min_pident,
            off_target_length_frac=off_target_length_frac,
            three_prime_window=three_prime_window,
            three_prime_min_length=three_prime_min_length,
            three_prime_min_pident=three_prime_min_pident,
            check_three_prime=check_three_prime,
            home_min_pident=home_min_pident,
        )
        for seq, hits in per_seq_hits.items()
    }

    passing = {
        seq for seq, c in per_seq.items()
        if c['on_target'] == 1 and c['off_target'] == 0 and c['three_prime_threats'] == 0
    }
    return passing, per_seq, per_seq_hits
