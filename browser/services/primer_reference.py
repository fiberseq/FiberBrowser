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


def supplemental_sequences(state) -> dict:
    """Sequences loaded beside the genome (plasmid maps such as SnapGene .dna, GenBank): held in memory,
    in no FASTA file and in no BLAST database built from one."""
    sequences = getattr(state, 'plasmid_sequences', None)
    return dict(sequences) if isinstance(sequences, dict) else {}


def supplemental_template(state, chrom) -> str | None:
    """The loaded plasmid/custom sequence named exactly ``chrom``, else None (never by a chr-prefix alias)."""
    if not chrom:
        return None
    return str(chrom) if str(chrom) in supplemental_sequences(state) else None


def resolve_template_chrom(name, available, state):
    """The design contig ``name`` means among ``available`` (FASTA contigs plus loaded plasmids), or None.

    A loaded plasmid is its own exact name only (it wins over a FASTA contig of the same name): the
    chr-prefix fallback reaches FASTA contigs, never a plasmid, and a plasmid's name never reaches a
    FASTA contig."""
    if not name:
        return None
    name = str(name)
    plasmids = supplemental_sequences(state)
    if name in plasmids or name in available:
        return name
    alt = name[3:] if name.startswith('chr') else 'chr' + name
    if alt in available and alt not in plasmids:
        return alt
    return None


def _handle_file(handle):
    name = getattr(handle, 'filename', None)
    return name.decode(errors='replace') if isinstance(name, bytes) else name


def get_fasta_interface(state, fasta_path):
    """A sequence interface over the primer FASTA plus the plasmid/custom sequences loaded beside it.

    A contig of the FASTA is read from it (the browser's pysam reference when it is the requested
    file; a primer FASTA configured separately is opened itself); a loaded plasmid map's contig is
    read from memory, so designing on a plasmid needs no FASTA file at all (``fasta_path`` None). Resolve
    a requested name with ``resolve_template_chrom``."""
    fetch_file, length_file, file_chroms = _get_file_interface(state, fasta_path) if fasta_path else (None, None, set())
    # A loaded plasmid wins for its own name: it is the contig the browser shows under that name.
    supplemental = supplemental_sequences(state)
    if not supplemental:
        if fetch_file is None:
            return (lambda chrom, start, end: ''), (lambda chrom: 0), set()
        return fetch_file, length_file, file_chroms

    def fetch_seq(chrom, start, end):
        if chrom in supplemental:
            seq = supplemental[chrom]
            return seq[max(0, start):min(end, len(seq))].upper()
        return fetch_file(chrom, start, end)

    def chrom_length(chrom):
        if chrom in supplemental:
            return len(supplemental[chrom])
        return length_file(chrom)

    return fetch_seq, chrom_length, set(file_chroms) | set(supplemental)


def _get_file_interface(state, fasta_path):
    """Get a FASTA interface, preferring the browser's pysam reference when it is
    the requested file (a primer FASTA configured separately is opened itself)."""

    pysam_fa = getattr(state, 'fasta', None)
    if pysam_fa is not None and fasta_path and not (_same_file(getattr(state, 'fasta_path', None), fasta_path)
                                                    or _same_file(_handle_file(pysam_fa), fasta_path)):
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


def template_sequences(state, names) -> dict:
    """``{name: (sequence, circular)}`` for loaded plasmid/custom sequences among ``names`` (the self check)."""
    sequences = supplemental_sequences(state)
    metadata = getattr(state, 'plasmid_metadata', None) or {}
    circular_chroms = getattr(state, 'circular_chroms', None) or {}
    out = {}
    for name in names or ():
        if name in sequences:
            meta = metadata.get(name) or {}
            circular = bool(meta.get('circular', name in circular_chroms))
            out[name] = (sequences[name], circular)
    return out
