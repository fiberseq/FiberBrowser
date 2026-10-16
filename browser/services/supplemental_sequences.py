"""Sequences of plasmid maps loaded next to (or instead of) a FASTA reference."""
from __future__ import annotations

from services.circular_genome import circular_chrom_size, circular_region_wraps, circular_view_segments
from utils.chrom import normalize_chrom_name


def supplemental_sequence_for_chrom(state, chrom: str) -> tuple[str, str] | None:
    """(name, sequence) of a loaded plasmid map for ``chrom``, else None.

    Plasmid maps take precedence over the FASTA for their contig, as in /api/sequence.
    """
    plasmids = getattr(state, "plasmid_sequences", {}) or {}
    if not plasmids:
        return None
    candidates = [chrom]
    if hasattr(state, "translate_chrom"):
        candidates.append(state.translate_chrom(chrom))
    norm_target = normalize_chrom_name(chrom)
    for candidate in candidates:
        if candidate in plasmids:
            return candidate, plasmids[candidate]
    for name, sequence in plasmids.items():
        if normalize_chrom_name(name) == norm_target:
            return name, sequence
    return None


def supplemental_sequence_slice(state, name: str, sequence: str, start: int, end: int) -> str:
    """``sequence[start:end]``, wrapping across the origin of a circular plasmid."""
    length = len(sequence)
    if circular_chrom_size(state, name) and circular_region_wraps(start, end, length):
        return "".join(sequence[s.ref_start:s.ref_end] for s in circular_view_segments(start, end, length))
    return sequence[max(0, start):min(end, length)]
