"""Fast BAM read-boundary extraction helpers."""
from __future__ import annotations

import os
from typing import Optional

from utils.chrom import get_chrom_variants, resolve_reference_name
from utils.validation import is_url


def get_read_boundaries_from_bam(
    bam_path: str,
    chrom: str,
    start: int,
    end: int,
    max_reads: int = 5000,
    chrom_map: Optional[dict] = None,
    contig_links: Optional[dict] = None,
) -> list[tuple[int, int]]:
    """
    Extract read start/end positions without parsing tags.

    This is intentionally narrow and fast for autozoom-style operations that
    only need boundary density, not full compact-read payloads.
    """
    if not is_url(bam_path) and not os.path.exists(bam_path):
        return []

    import pysam

    boundaries: list[tuple[int, int]] = []

    try:
        from services.remote_sources.opening import open_alignment_file
        with open_alignment_file(bam_path, "rb") as bam:
            actual_chrom = resolve_reference_name(chrom, bam.references, chrom_map, links=contig_links)
            if actual_chrom is None:
                return []

            count = 0
            from services.graph_lift import lift_hidden_predicate
            hidden = lift_hidden_predicate(getattr(bam, "header", None))
            for read in bam.fetch(actual_chrom, int(start), int(end)):
                if read.is_unmapped or read.is_secondary or read.is_supplementary:
                    continue
                if hidden is not None and hidden(read):
                    continue
                boundaries.append((read.reference_start, read.reference_end))
                count += 1
                if count >= max_reads:
                    break
    except Exception as exc:
        print(f"Error getting read boundaries: {exc}")
        return []

    return boundaries
