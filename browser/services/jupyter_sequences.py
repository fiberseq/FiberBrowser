"""Sequence extraction helpers shared by Jupyter endpoints."""
from __future__ import annotations

from typing import Callable, Optional

from services.circular_genome import circular_region_wraps, circular_view_segments


def notebook_sequence_fasta(state) -> Optional[str]:
    """The FASTA notebook sequence services read: the browser's loaded reference
    (what ``client.set_fasta`` loads), else the one configured for primers."""
    import os
    for path in (getattr(state, "fasta_path", None), getattr(state, "primer_fasta", None)):
        if isinstance(path, str) and path and os.path.exists(path):
            return path
    return None


class _IndexedChromSeq:
    """One contig of an indexed FASTA, sliced on demand (upper case, like make_fa_dic)."""

    def __init__(self, fasta, chrom: str):
        self._fasta = fasta
        self._chrom = chrom
        self._length = fasta.get_reference_length(chrom)

    def __len__(self) -> int:
        return self._length

    def __getitem__(self, key):
        if not isinstance(key, slice) or key.step not in (None, 1):
            raise TypeError("indexed FASTA contigs support plain slices only")
        start, stop, _ = key.indices(self._length)
        if stop <= start:
            return ""
        return self._fasta.fetch(self._chrom, start, stop).upper()


class IndexedFastaView:
    """A read-only, dict-like view of an indexed (plain or BGZF) FASTA."""

    def __init__(self, fasta):
        self._fasta = fasta
        self._names = set(fasta.references)

    def __contains__(self, chrom) -> bool:
        return chrom in self._names

    def __getitem__(self, chrom) -> _IndexedChromSeq:
        if chrom not in self._names:
            raise KeyError(chrom)
        return _IndexedChromSeq(self._fasta, chrom)

    def keys(self):
        return list(self._fasta.references)


def _open_indexed_fasta(state, path: Optional[str]):
    """The browser's open reference when it is this file, else the file opened
    through its index; None when it can't be (then make_fa_dic reads it)."""
    import os
    if not path:
        return None
    loaded = getattr(state, "fasta", None)
    loaded_path = getattr(state, "fasta_path", None)
    try:
        if loaded is not None and loaded_path and os.path.realpath(str(loaded_path)) == os.path.realpath(str(path)):
            return loaded
    except Exception:
        pass
    try:
        from services.fasta_handles import ThreadLocalFasta
        return ThreadLocalFasta(path)  # cached on the state and read from several threads
    except Exception:
        return None


def get_cached_fasta_dict(state, loader: Optional[Callable[[str], dict]] = None, path: Optional[str] = None) -> dict:
    """Return the primer FASTA as a dictionary, loading it if needed.

    An indexed FASTA (plain or BGZF-compressed) is read through its index, so a
    compressed reference works and nothing is loaded whole. Cached with the path
    it came from, so configuring another FASTA loads that one.
    """
    path = path or getattr(state, "primer_fasta", None)
    key = _fasta_cache_key(state, path)
    cached = getattr(state, "_primer_fa_cache", None)
    if cached is not None and getattr(state, "_primer_fa_cache_path", None) == key:
        return cached

    if loader is None:
        indexed = _open_indexed_fasta(state, path)
        if indexed is not None:
            cached = IndexedFastaView(indexed)
            state._primer_fa_cache = cached
            state._primer_fa_cache_path = key
            return cached
        from primer_designer import make_fa_dic as loader
        from services.primer_config import log_primer_diagnostic
        log_primer_diagnostic("Loading reference genome with make_fa_dic (may take a minute)...")

    cached = loader(path)
    state._primer_fa_cache = cached
    state._primer_fa_cache_path = key
    return cached


def _fasta_cache_key(state, path: Optional[str]):
    """What the cached view was built from. When ``path`` is the browser's
    loaded reference, that reference itself (a collection of several FASTAs keeps
    its first path when its other members change) and its file list."""
    import os
    loaded_path = getattr(state, "fasta_path", None)
    try:
        same = bool(path and loaded_path) and os.path.realpath(str(path)) == os.path.realpath(str(loaded_path))
    except Exception:
        same = False
    if not same:
        return (path,)
    pairs = tuple(p.get("fasta") for p in (getattr(state, "reference_pairs", None) or []) if isinstance(p, dict))
    return (path, id(getattr(state, "fasta", None)), pairs)


def resolve_fasta_chrom(fa: dict, chrom: str) -> Optional[str]:
    """Resolve chromosome names with chr-prefix fallback."""
    if chrom in fa:
        return chrom
    alt = chrom[3:] if chrom.startswith("chr") else "chr" + chrom
    if alt in fa:
        return alt
    return None


def extract_sequence_regions(
    regions,
    fa: dict,
    *,
    extend: int = 0,
    strand: str = "+",
    reverse_complement: Optional[Callable[[str], str]] = None,
    include_missing: bool = True,
    circular_chrom_sizes: Optional[dict[str, int]] = None,
) -> list[dict]:
    """Extract sequence payloads for Jupyter region requests."""
    results = []
    for index, region in enumerate(regions):
        chrom = region.chrom
        raw_start = region.start - extend
        raw_end = region.end + extend
        start = max(0, raw_start)
        end = raw_end
        name = region.name or f"region_{index}"
        actual_chrom = resolve_fasta_chrom(fa, chrom)

        if actual_chrom is None:
            if include_missing:
                results.append({
                    "chrom": chrom,
                    "start": start,
                    "end": end,
                    "name": name,
                    "sequence": None,
                    "error": f"Chromosome {chrom} not found in FASTA",
                })
            continue

        chrom_seq = fa[actual_chrom]
        chrom_size = int((circular_chrom_sizes or {}).get(chrom) or (circular_chrom_sizes or {}).get(actual_chrom) or 0)
        is_circular = chrom_size > 0
        if is_circular:
            chrom_size = min(chrom_size, len(chrom_seq)) if len(chrom_seq) else chrom_size
            if circular_region_wraps(raw_start, raw_end, chrom_size):
                pieces = [
                    chrom_seq[segment.ref_start:segment.ref_end]
                    for segment in circular_view_segments(raw_start, raw_end, chrom_size)
                ]
                seq = "".join(pieces)
                start = raw_start
                end = raw_end
            else:
                start = raw_start
                end = raw_end
                seq = chrom_seq[start:end]
        else:
            end = min(end, len(chrom_seq))
            seq = chrom_seq[start:end]
        if strand == "-" and reverse_complement is not None:
            seq = reverse_complement(seq)

        result = {
            "chrom": chrom,
            "start": start,
            "end": end,
            "name": name,
            "sequence": seq,
            "length": len(seq),
        }
        if is_circular:
            result["circular"] = True
        results.append(result)

    return results
