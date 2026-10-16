"""Reference FASTA helpers for primer design."""
from __future__ import annotations

from services.primer_config import log_primer_diagnostic


def resolve_chrom(name, available):
    """Resolve chromosome name with chr-prefix fallback. Returns key or None."""
    if name in available:
        return name
    alt = name[3:] if name.startswith('chr') else 'chr' + name
    if alt in available:
        return alt
    return None


def _same_file(a, b) -> bool:
    import os
    try:
        return bool(a) and bool(b) and os.path.realpath(str(a)) == os.path.realpath(str(b))
    except Exception:
        return False


def get_fasta_interface(state, fasta_path):
    """Get a FASTA interface, preferring the browser's pysam reference when it is
    the requested file (a primer FASTA configured separately is opened itself)."""

    pysam_fa = getattr(state, 'fasta', None)
    if pysam_fa is not None and fasta_path and not _same_file(getattr(state, 'fasta_path', None), fasta_path):
        pysam_fa = None
    if pysam_fa is None:
        try:
            from services.fasta_handles import ThreadLocalFasta
            pysam_fa = ThreadLocalFasta(fasta_path)
        except Exception:
            pysam_fa = None

    if pysam_fa is not None:
        def fetch_seq(chrom, start, end):
            return pysam_fa.fetch(chrom, max(0, start), min(end, pysam_fa.get_reference_length(chrom))).upper()

        def chrom_length(chrom):
            return pysam_fa.get_reference_length(chrom)

        return fetch_seq, chrom_length, set(pysam_fa.references)

    from services.jupyter_sequences import get_cached_fasta_dict
    fa_dict = get_cached_fasta_dict(state, path=fasta_path)

    def fetch_seq(chrom, start, end):
        return fa_dict[chrom][start:end]

    def chrom_length(chrom):
        return len(fa_dict[chrom])

    return fetch_seq, chrom_length, set(fa_dict.keys())
