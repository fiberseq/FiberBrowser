"""A BAM of chosen reads (Export data > Reads > BAM subset).

The records of the named reads that overlap a region, from every file of a
BAM dataset, written to one coordinate-sorted BAM (@HD SO:coordinate) with
the first file's header: its @PG chain extended by a FiberBrowser line, and
the read groups and @PG lines of every file (a read group or program ID
another file uses for another record is renamed, with its records' RG / PG
tags and the @PG PP links that point at it). The files must have the same
references (names and lengths). All other tags are kept as they are.
Secondary and supplementary records of those reads in the region come along;
unmapped ones cannot overlap a region. On a circular contig, a window across
its origin (a logical start below 0 or an end past its length) is fetched on
both sides of the seam.
"""
from __future__ import annotations

import os
from typing import Iterable, Optional

MAX_SUBSET_READS = 200_000


class SubsetError(ValueError):
    """The request can't be served (not a BAM dataset, no reads, mismatched files)."""


def _header_with_pg(data: dict, previous: Optional[str] = None) -> dict:
    """``data`` with a FiberBrowser @PG line after ``previous`` (default: the last @PG)."""
    data = dict(data)
    pgs = list(data.get("PG") or [])
    ids = {pg.get("ID") for pg in pgs}
    pg_id, n = "fiberbrowser-subset", 1
    while pg_id in ids:
        n += 1
        pg_id = f"fiberbrowser-subset.{n}"
    entry = {"ID": pg_id, "PN": "FiberBrowser", "DS": "reads chosen in FiberBrowser (Export data)"}
    if previous is None and pgs:
        previous = pgs[-1].get("ID")
    if previous is not None:
        entry["PP"] = previous
    try:
        from version import __version__ as fb_version  # browser/version.py
        entry["VN"] = str(fb_version)
    except Exception:
        pass
    data["PG"] = pgs + [entry]
    hd = dict(data.get("HD") or {"VN": "1.6"})
    hd["SO"] = "coordinate"
    data["HD"] = hd
    return data


def _references(bam) -> tuple:
    return tuple(zip(bam.references, bam.lengths))


def _merge_read_groups(groups: list, extra: list) -> dict:
    """Add ``extra``'s read groups to ``groups``; returns renames (old ID -> new ID) for that file."""
    by_id = {g.get("ID"): g for g in groups}
    renames = {}
    for group in extra:
        gid = group.get("ID")
        if gid not in by_id:
            groups.append(dict(group))
            by_id[gid] = group
        elif by_id[gid] != group:  # same ID, other sample/library: keep both apart
            n = 2
            while f"{gid}.{n}" in by_id:
                n += 1
            renamed = {**group, "ID": f"{gid}.{n}"}
            groups.append(renamed)
            by_id[renamed["ID"]] = renamed
            renames[gid] = renamed["ID"]
    return renames


def _merge_programs(programs: list, extra: list) -> dict:
    """Add ``extra``'s @PG lines to ``programs``; returns renames (old ID -> new ID) for that file.

    A line identical to one already there (the same tool run, e.g. files split
    from one BAM) is kept once; another line under an ID already taken gets a
    new ID, and that file's PP links follow it (a line whose parent was
    renamed is another line too, wherever the parent is listed).
    """
    by_id = {p.get("ID"): p for p in programs}
    renames: dict = {}

    def rewritten(program: dict) -> dict:
        record = dict(program)
        if record.get("PP") in renames:
            record["PP"] = renames[record["PP"]]
        return record

    changed = True
    while changed:
        changed = False
        for program in extra:
            pid = program.get("ID")
            if pid in renames or pid not in by_id or by_id[pid] == rewritten(program):
                continue
            taken = set(by_id) | set(renames.values())
            n = 2
            while f"{pid}.{n}" in taken:
                n += 1
            renames[pid] = f"{pid}.{n}"
            changed = True
    for program in extra:
        record = rewritten(program)
        record["ID"] = renames.get(record.get("ID"), record.get("ID"))
        if record["ID"] in by_id:  # identical to one already there
            continue
        programs.append(record)
        by_id[record["ID"]] = record
    return renames


def _query_windows(state, chrom: str, start: int, end: int) -> list:
    """The linear windows to fetch: both sides of a circular contig's origin when the window wraps."""
    try:
        from services.circular_genome import circular_query_segments_for_region
        segments = circular_query_segments_for_region(state, chrom, int(start), int(end))
    except Exception:
        segments = None
    if segments:
        return [(max(0, int(lo)), int(hi)) for lo, hi, _shift in segments if hi > lo]
    return [(max(0, int(start)), int(end))]


def write_read_subset_bam(state, dataset_id: str, chrom: str, start: int, end: int,
                          read_ids: Iterable[str], out_path: str,
                          *, contig_links: Optional[dict] = None) -> dict:
    """Write the region's records of ``read_ids`` to ``out_path``; returns counts."""
    import pysam
    from services.remote_sources.opening import open_alignment_file
    from utils.chrom import resolve_reference_name

    dataset = state.get_dataset(dataset_id)
    if dataset is None:
        raise SubsetError(f"No dataset {dataset_id!r} is open")
    if getattr(dataset, "data_type", None) != "bam":
        raise SubsetError(f"{dataset.label} is not a BAM (a BAM subset needs alignments)")
    wanted = {str(r) for r in read_ids if r}
    if not wanted:
        raise SubsetError("No reads to export")
    if len(wanted) > MAX_SUBSET_READS:
        raise SubsetError(f"{len(wanted):,} reads: at most {MAX_SUBSET_READS:,} at a time")

    header: Optional[dict] = None
    references: Optional[tuple] = None
    read_groups: list = []
    programs: list = []
    chain_end: Optional[str] = None
    records = []
    found: set = set()
    windows = _query_windows(state, chrom, start, end)
    for path in dataset.paths:
        with open_alignment_file(path, "rb") as bam:
            data = bam.header.to_dict()
            from services.signal_evidence import signal_header, record_keeps_signal
            signal_provenance = signal_header(data)
            if header is None:
                header = data
                references = _references(bam)
                read_groups = [dict(g) for g in (data.get("RG") or [])]
                programs = [dict(p) for p in (data.get("PG") or [])]
                chain_end = programs[-1].get("ID") if programs else None
                renames: dict = {}
                pg_renames: dict = {}
            elif _references(bam) != references:
                raise SubsetError(f"{os.path.basename(str(path))} has other chromosomes (names or lengths) than "
                                  f"{os.path.basename(str(dataset.paths[0]))}: export its datasets separately")
            else:
                renames = _merge_read_groups(read_groups, list(data.get("RG") or []))
                pg_renames = _merge_programs(programs, list(data.get("PG") or []))
            bam_chrom = resolve_reference_name(chrom, bam.references, links=contig_links)
            if bam_chrom is None:
                continue
            for k, (lo, hi) in enumerate(windows):
                for read in bam.fetch(bam_chrom, lo, hi):
                    if read.is_unmapped or read.query_name not in wanted:
                        continue
                    if not record_keeps_signal(read, signal_provenance):
                        continue
                    # A record across the seam overlaps an earlier window too: written from that one.
                    if any(read.reference_start < p_hi and (read.reference_end or read.reference_start + 1) > p_lo
                           for p_lo, p_hi in windows[:k]):
                        continue
                    if renames and read.has_tag("RG") and read.get_tag("RG") in renames:
                        read.set_tag("RG", renames[read.get_tag("RG")], value_type="Z")
                    if pg_renames and read.has_tag("PG") and read.get_tag("PG") in pg_renames:
                        read.set_tag("PG", pg_renames[read.get_tag("PG")], value_type="Z")
                    records.append(read)
                    found.add(read.query_name)
    if header is None:
        raise SubsetError(f"{dataset.label} has no files")
    if read_groups:
        header["RG"] = read_groups
    if programs:
        header["PG"] = programs
    out_header = _header_with_pg(header, previous=chain_end)
    records.sort(key=lambda r: (r.reference_id, r.reference_start))
    with pysam.AlignmentFile(out_path, "wb", header=out_header) as out:
        for read in records:
            out.write(read)
    return {"records": len(records), "reads": len(found), "missing": sorted(wanted - found)}
