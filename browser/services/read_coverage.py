"""Binned read coverage helpers."""
from __future__ import annotations

import math
import time
import traceback
from typing import Iterable, Optional

from services.circular_genome import bam_wrap_length, merged_spans, wrap_passes
from services.diagnostics import env_flag_enabled, log_if_enabled
from utils.chrom import get_chrom_variants, resolve_reference_name

READ_COVERAGE_DIAGNOSTICS_ENV = "FIBERBROWSER_COVERAGE_DIAGNOSTICS"


def coverage_diagnostics_enabled() -> bool:
    return env_flag_enabled(READ_COVERAGE_DIAGNOSTICS_ENV)


def log_coverage_diagnostic(message: str) -> None:
    log_if_enabled(READ_COVERAGE_DIAGNOSTICS_ENV, message)


def _add_interval_coverage(
    diff: list[int],
    *,
    region_start: int,
    bin_size: float,
    bins: int,
    interval_start: int,
    interval_end: int,
) -> None:
    """Add one read/entry interval to binned coverage using a difference array.

    Intervals are half-open: a read ending exactly on a bin edge does not
    reach the next bin (two abutting reads are depth 1 at the join, not 2).
    """
    bin_range = _interval_bin_range(
        region_start=region_start, bin_size=bin_size, bins=bins,
        interval_start=interval_start, interval_end=interval_end)
    if bin_range is None:
        return
    diff[bin_range[0]] += 1
    diff[bin_range[1]] -= 1


def _interval_bin_range(
    *,
    region_start: int,
    bin_size: float,
    bins: int,
    interval_start: int,
    interval_end: int,
) -> Optional[tuple[int, int]]:
    """The bins ``[lo, hi)`` a half-open interval touches, or None."""
    if interval_end <= interval_start or bins <= 0:
        return None
    b0 = int((interval_start - region_start) / bin_size)
    b1 = min(math.ceil((interval_end - region_start) / bin_size), bins)
    lo = max(0, b0)
    hi = max(lo, b1)
    if hi <= lo:
        return None
    return lo, hi


def _add_record_coverage(
    diff: list[int],
    pieces: Iterable,
    *,
    region_start: int,
    bin_size: float,
    bins: int,
) -> None:
    """Add one record, given as possibly disjoint pieces, once to every bin it
    touches: separate pieces of it in the same bin (a wrapped record's head
    and tail, pieces either side of a seam) count once there."""
    bin_ranges = []
    for piece_start, piece_end in pieces:
        bin_range = _interval_bin_range(
            region_start=region_start, bin_size=bin_size, bins=bins,
            interval_start=piece_start, interval_end=piece_end)
        if bin_range is not None:
            bin_ranges.append(bin_range)
    for lo, hi in merged_spans(bin_ranges):
        diff[lo] += 1
        diff[hi] -= 1


def compute_binned_read_coverage(
    datasets: Iterable,
    chrom: str,
    start: int,
    end: int,
    bins: int,
    bam_handle_getter,
    bigbed_handle_getter,
    query_segments: Optional[Iterable[tuple[int, int, int]]] = None,
    circular: bool = False,
    contig_links: Optional[dict] = None,
    include_duplicates: bool = False,
) -> dict:
    """Compute binned read counts for BAM and BigBed datasets.

    `start`/`end` define the logical viewport.  For circular chromosomes,
    callers may pass linear reference query segments as
    `(ref_start, ref_end, coord_shift)`, where `ref + coord_shift` maps back
    onto the logical viewport coordinate system.

    On a circular contig (``@SQ TP:circular``, or ``circular=True``) a BAM
    record whose alignment runs past the contig end also covers the first
    bases (its wrapped tail).  Each record counts once per bin: its pieces
    (head, tail, pieces either side of a wrapped view's seam) are joined as
    bin ranges before counting.

    ``contig_links``: ``{dataset id: its plasmid links}`` in the caller's
    workspace (``services.plasmid_reconcile.contig_links``).

    Duplicate-flagged molecules (BAM 0x400, BigBed ``isDuplicate``) count only
    with ``include_duplicates``: the reads the read panel shows (the loaders'
    rule), as samtools depth and IGV count by default.  In a wrapped view, a
    BigBed molecule's rows sharing a name (pieces either side of the seam) are
    one molecule, as the read panel merges them, and count once per bin.
    """
    region_size = end - start
    if bins <= 0 or region_size <= 0:
        return {"coverage": [], "max": 0, "warnings": ["invalid coverage region"]}
    bin_size = region_size / bins
    coverage_diff = [0] * (bins + 1)
    warnings = []
    segments = list(query_segments) if query_segments is not None else [(start, end, 0)]

    t0 = time.time()
    total_reads = 0  # molecules counted (the read panel's reads in this window, before its filters)

    for dataset in datasets:
        if dataset.data_type == 'bam':
            for bam_path in dataset.paths:
                bam = bam_handle_getter(bam_path)
                if bam is None:
                    log_coverage_diagnostic(f"  [Coverage] BAM handle is None for {bam_path}")
                    continue

                bam_chrom = resolve_reference_name(
                    chrom, bam.references, links=(contig_links or {}).get(getattr(dataset, "id", None)))
                if bam_chrom is None:
                    msg = f"chrom '{chrom}' not in BAM refs (first 5: {list(bam.references[:5])})"
                    log_coverage_diagnostic(f"  [Coverage] {msg}")
                    warnings.append(msg)
                    continue

                from services.signal_evidence import signal_header, record_keeps_signal
                signal_provenance = signal_header(getattr(bam, "header", None))
                try:
                    count = 0
                    wrap_length = bam_wrap_length(bam, bam_chrom, flagged_circular=circular)
                    pieces_by_record: dict[tuple, list[list[int]]] = {}
                    for query_start, query_end, coord_shift in segments:
                        passes = [(0, query_start, query_end)] + [
                            (offset, query_start + offset, query_end + offset)
                            for offset in wrap_passes(query_start, query_end, wrap_length)
                        ]
                        for offset, pass_start, pass_end in passes:
                            found = False
                            # Identical records (exact duplicates) stay apart by
                            # their order, which every pass sees the same.
                            occurrences: dict[tuple, int] = {}
                            for read in bam.fetch(bam_chrom, pass_start, pass_end):
                                if read.is_unmapped or read.is_secondary or read.is_supplementary:
                                    continue
                                if not record_keeps_signal(read, signal_provenance):
                                    continue
                                found = True
                                if not include_duplicates and getattr(read, "is_duplicate", False):
                                    continue
                                read_start = max(read.reference_start, pass_start)
                                read_end = min(read.reference_end or read.reference_start + 1, pass_end)
                                if offset:
                                    # A record longer than the contig is back at its
                                    # own start here: count that position once.
                                    read_end = min(read_end, read.reference_start + offset)
                                if read_end <= read_start:
                                    continue
                                key = (getattr(read, "query_name", None), read.reference_start,
                                       read.reference_end, bool(getattr(read, "is_reverse", False)))
                                occurrence = occurrences.get(key, 0)
                                occurrences[key] = occurrence + 1
                                key = key + (occurrence,)
                                pieces_by_record.setdefault(key, []).append(
                                    [read_start - offset + coord_shift, read_end - offset + coord_shift])
                            if offset and not found:
                                break
                    for pieces in pieces_by_record.values():
                        _add_record_coverage(
                            coverage_diff,
                            pieces,
                            region_start=start,
                            bin_size=bin_size,
                            bins=bins,
                        )
                        count += 1
                    total_reads += count
                    log_coverage_diagnostic(f"  [Coverage] BAM {bam_chrom}:{start}-{end} via {len(segments)} segment(s) -> {count} reads")
                except Exception as e:
                    log_coverage_diagnostic(f"  [Coverage] BAM error ({bam_path}): {e}")

        elif dataset.data_type == 'bigbed':
            from services.signal_evidence import signal_keeps
            if not signal_keeps(None):
                continue
            # Companion files (tf/msp/... of the same molecules) are listed in
            # a grouped dataset's paths too; counting their rows would count
            # each molecule once per file.
            companion_paths = {
                path
                for paths in (getattr(dataset, 'companion_layers', None) or {}).values()
                for path in ([paths] if isinstance(paths, str) else list(paths or []))
            }
            primary_paths = [p for p in dataset.paths if p not in companion_paths] or list(dataset.paths)
            for bb_path in primary_paths:
                bb = bigbed_handle_getter(bb_path)
                if bb is None:
                    log_coverage_diagnostic(f"  [Coverage] BigBed handle is None for {bb_path}")
                    continue

                try:
                    bb_chroms = bb.chroms()
                except Exception as e:
                    log_coverage_diagnostic(f"  [Coverage] bb.chroms() failed for {bb_path}: {e}")
                    continue

                if not bb_chroms:
                    log_coverage_diagnostic(f"  [Coverage] BigBed has empty chroms dict for {bb_path}")
                    continue

                bb_chrom = chrom
                if chrom not in bb_chroms:
                    found = False
                    for variant in get_chrom_variants(chrom):
                        if variant in bb_chroms:
                            bb_chrom = variant
                            found = True
                            break
                    if not found:
                        msg = f"chrom '{chrom}' not in BigBed chroms (available: {list(bb_chroms.keys())[:10]})"
                        log_coverage_diagnostic(f"  [Coverage] {msg}")
                        warnings.append(msg)
                        continue

                bb_chrom_size = bb_chroms.get(bb_chrom, end)
                try:
                    from services.bigbed_detection import bigbed_has_duplicate_field
                    has_duplicate_field = bool(bigbed_has_duplicate_field(bb_path))
                except Exception:
                    has_duplicate_field = False

                try:
                    total_entries = 0
                    pieces_by_name: dict = {}
                    for query_start, query_end, coord_shift in segments:
                        # pyBigWig refuses a window reaching past either contig end.
                        bounded_query_start = max(0, query_start)
                        bounded_query_end = min(query_end, bb_chrom_size)
                        if bounded_query_end <= bounded_query_start:
                            continue
                        entries = bb.entries(bb_chrom, bounded_query_start, bounded_query_end)
                        entry_count = len(entries) if entries else 0
                        total_entries += entry_count
                        log_coverage_diagnostic(f"  [Coverage] BigBed entries({bb_chrom}, {bounded_query_start}, {bounded_query_end}) -> {entry_count} entries")
                        if entries and entry_count > 0:
                            for index, entry in enumerate(entries):
                                fields = (entry[2] if len(entry) > 2 and entry[2] else "").split("\t")
                                if (has_duplicate_field and not include_duplicates
                                        and fields[-1].strip() == "1"):
                                    continue
                                # As the read panel shows them: in a wrapped view, rows
                                # sharing a name are one molecule (its pieces either side
                                # of the seam); otherwise each row is its own.
                                name = (fields[0] if fields[0] and len(segments) > 1
                                        else ("row", query_start, index))
                                pieces_by_name.setdefault(name, []).append([
                                    max(entry[0], bounded_query_start) + coord_shift,
                                    min(entry[1], bounded_query_end) + coord_shift,
                                ])
                    for pieces in pieces_by_name.values():
                        _add_record_coverage(
                            coverage_diff, pieces, region_start=start, bin_size=bin_size, bins=bins)
                    total_reads += len(pieces_by_name)
                    if total_entries == 0:
                        log_coverage_diagnostic(f"  [Coverage] BigBed returned no entries for {bb_chrom}:{start}-{end}")
                except Exception as e:
                    log_coverage_diagnostic(f"  [Coverage] BigBed error ({bb_path}): {e}")
                    if coverage_diagnostics_enabled():
                        traceback.print_exc()
        else:
            log_coverage_diagnostic(f"  [Coverage] Unknown data_type '{dataset.data_type}' for dataset {dataset.id}")

    coverage = [0] * bins
    running = 0
    for idx in range(bins):
        running += coverage_diff[idx]
        coverage[idx] = running

    max_cov = max(coverage) if coverage else 0
    nonzero = sum(1 for value in coverage if value > 0)
    log_coverage_diagnostic(f"  [Coverage] RESULT: {chrom}:{start}-{end} ({bins} bins) -> max={max_cov}, nonzero={nonzero} in {time.time()-t0:.3f}s")

    return {"coverage": coverage, "max": max_cov, "warnings": warnings, "reads": total_reads}
