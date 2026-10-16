"""Contig-bounded BigBed queries."""
from __future__ import annotations


def bigbed_entries_in_bounds(bw, chrom: str, start: int, end: int, chrom_sizes=None):
    """``bw.entries`` over the part of [start, end) inside the contig.

    pyBigWig raises "Invalid interval bounds!" for a window reaching past either
    contig end (a padded prefetch near a telomere, or a view zoomed out past the
    end); the entries inside it are still there. Coordinates stay absolute, so
    callers project them as before.
    """
    sizes = chrom_sizes
    if sizes is None:
        try:
            sizes = bw.chroms()
        except Exception:
            sizes = None
    size = sizes.get(chrom) if hasattr(sizes, 'get') else None
    lo = max(0, int(start))
    # A missing or non-positive size is unknown: query as asked.
    hi = int(end) if not size or int(size) <= 0 else min(int(end), int(size))
    if hi <= lo:
        return None
    return bw.entries(chrom, lo, hi)
