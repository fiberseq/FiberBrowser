"""Legacy BigBed read-table and companion mark loaders."""
from __future__ import annotations

import math
import os
import re
from typing import Callable, Optional

import numpy as np

from services.bigbed_detection import is_ddda_mcg_block
from services.compact_read_loader import bigbed_entries_in_bounds, detect_swapped_bed12_columns
from services.diagnostics import log_if_enabled
from utils.chrom import get_chrom_variants
from utils.validation import is_url


_bigbed_format_cache: dict[str, bool] = {}
BIGBED_DIAGNOSTICS_ENV = "FIBERBROWSER_BIGBED_DIAGNOSTICS"


def _pd():
    import pandas as pd

    return pd


def log_bigbed_diagnostic(message: str) -> None:
    """Print legacy BigBed loader diagnostics only when explicitly enabled."""
    log_if_enabled(BIGBED_DIAGNOSTICS_ENV, message)


def build_rd_fast_signed(bed_df, chrom, region_start, region_end, spanning_only=True):
    """Build a dense signed footprint DataFrame from parsed BED12 rows."""
    pd = _pd()

    if spanning_only:
        mask = (
            (bed_df["chrom"] == chrom)
            & (bed_df["start"] <= region_start)
            & (bed_df["end"] >= region_end)
        )
    else:
        mask = (
            (bed_df["chrom"] == chrom)
            & (bed_df["start"] < region_end)
            & (bed_df["end"] > region_start)
        )

    sub = bed_df.loc[mask]
    if sub.empty:
        return pd.DataFrame([], columns=np.arange(region_start, region_end))

    n_reads = len(sub)
    width = region_end - region_start
    # Signed sizes: a gap longer than 32 kb would wrap around in int16 and read
    # as a large footprint.
    rd_arr = np.zeros((n_reads, width), dtype=np.int32)
    read_ids = []

    for i, (_, row) in enumerate(sub.iterrows()):
        read_ids.append(str(row.get("name", f"read_{i}")))

        bs_str = row["blockStarts"].rstrip(",")
        bz_str = row["blockSizes"].rstrip(",")

        raw_starts = (
            np.array([int(x) for x in bs_str.split(",")], dtype=np.int32)
            if "," in bs_str
            else np.array([int(bs_str)], dtype=np.int32)
        )
        raw_sizes = (
            np.array([int(x) for x in bz_str.split(",")], dtype=np.int32)
            if "," in bz_str
            else np.array([int(bz_str)], dtype=np.int32)
        )

        abs_starts = raw_starts + row["start"]
        abs_ends = abs_starts + raw_sizes

        sort_idx = np.argsort(abs_starts)
        abs_starts = abs_starts[sort_idx]
        abs_ends = abs_ends[sort_idx]
        raw_sizes = raw_sizes[sort_idx]

        prev = max(row["start"], region_start)
        for fp_start, fp_end, fp_size in zip(abs_starts, abs_ends, raw_sizes):
            if fp_end <= region_start or fp_start >= region_end:
                continue
            clip_start = max(fp_start, region_start)
            clip_end = min(fp_end, region_end)

            if clip_start > prev >= region_start:
                rd_arr[i, prev - region_start:clip_start - region_start] = -(clip_start - prev)

            rd_arr[i, clip_start - region_start:clip_end - region_start] = fp_size
            prev = clip_end

        read_end = min(row["end"], region_end)
        if prev < read_end:
            rd_arr[i, prev - region_start:read_end - region_start] = -(read_end - prev)

    df = pd.DataFrame(rd_arr, columns=np.arange(region_start, region_end))
    df["read_id"] = read_ids
    return df


def load_reads_from_bigbed(
    bigbed_path,
    chrom,
    start,
    end,
    spanning_only=True,
    *,
    bigbed_handle_getter: Optional[Callable] = None,
    swapped_column_detector: Optional[Callable] = None,
    format_cache: Optional[dict[str, bool]] = None,
):
    """Load legacy dense read tables from one or more BigBed files."""
    pd = _pd()

    if bigbed_handle_getter is None:
        from services.bigbed_handles import get_bigbed_handle as bigbed_handle_getter
    if swapped_column_detector is None:
        swapped_column_detector = detect_swapped_bed12_columns
    if format_cache is None:
        format_cache = _bigbed_format_cache

    dfs = []
    chrom_variants = get_chrom_variants(chrom)

    if isinstance(bigbed_path, list):
        bb_files = bigbed_path
    elif is_url(bigbed_path) or os.path.isfile(bigbed_path):
        bb_files = [bigbed_path]
    else:
        bb_files = [
            os.path.join(bigbed_path, filename)
            for filename in os.listdir(bigbed_path)
            if filename.endswith((".bb", ".bigbed", ".bigBed"))
        ]

    for filepath in bb_files:
        try:
            bw = bigbed_handle_getter(filepath)
            if bw is None:
                continue

            available_chroms = bw.chroms()
            matching_chrom = None
            for variant in chrom_variants:
                if variant in available_chroms:
                    matching_chrom = variant
                    break
            if matching_chrom is None:
                continue

            entries = bigbed_entries_in_bounds(bw, matching_chrom, start, end, available_chroms)
            if not entries:
                continue
            df = pd.DataFrame(entries, columns=["start", "end", "rest"])
        except Exception as exc:
            log_bigbed_diagnostic(
                f"  Warning: Failed to read BigBed {os.path.basename(filepath)}: {exc}"
            )
            continue

        df["chrom"] = chrom
        try:
            cols = [
                "name",
                "X1",
                "X2",
                "X3",
                "X4",
                "X5",
                "blockCount",
                "blockSizes",
                "blockStarts",
            ]
            # BED12+ (e.g. an extra blockNq column): the first nine fields are
            # the BED12 ones this loader reads; extra columns are ignored here.
            parts = df["rest"].str.split("\t", n=len(cols), expand=True)
            if parts.shape[1] < len(cols):
                raise ValueError(f"expected BED12 fields, found {parts.shape[1] + 3}")
            df[cols] = parts.iloc[:, :len(cols)]
            df = df.drop(columns=["rest", "X1", "X2", "X3", "X4", "X5"])
        except Exception as exc:
            log_bigbed_diagnostic(
                f"  Warning: Failed to parse BigBed columns from {os.path.basename(filepath)}: {exc}"
            )
            continue

        if filepath not in format_cache:
            format_cache[filepath] = swapped_column_detector(df)

        if format_cache[filepath]:
            df["blockStarts"], df["blockSizes"] = df["blockSizes"].copy(), df["blockStarts"].copy()

        rd = build_rd_fast_signed(df, chrom, start, end, spanning_only)
        if not rd.empty:
            dfs.append(rd)

    if not dfs:
        return pd.DataFrame()

    # Gaps are stored as their full (negative) length, so a read accessible
    # across the whole window is kept like any other covered read.
    return pd.concat(dfs).reset_index(drop=True)


def load_methyl_from_bigbed(
    bigbed_path: str,
    chrom: str,
    region_start: int,
    region_end: int,
    layer_type: str = "m6a",
    *,
    bigbed_handle_getter: Optional[Callable] = None,
) -> dict:
    """Load per-base modification/deamination positions from a companion BigBed."""
    if bigbed_handle_getter is None:
        from services.bigbed_handles import get_bigbed_handle as bigbed_handle_getter

    marks: dict = {}
    chrom_variants = get_chrom_variants(chrom)

    try:
        bw = bigbed_handle_getter(bigbed_path)
        if bw is None:
            return marks

        available_chroms = bw.chroms()
        matching_chrom = None
        for variant in chrom_variants:
            if variant in available_chroms:
                matching_chrom = variant
                break
        if matching_chrom is None:
            return marks

        entries = bigbed_entries_in_bounds(bw, matching_chrom, region_start, region_end, available_chroms)
        if not entries:
            return marks

        for entry_start, _entry_end, rest in entries:
            entry_start = int(entry_start)
            parts = rest.split("\t")
            if len(parts) < 9:
                continue

            read_id = parts[0]
            block_sizes_str = parts[7].rstrip(",")
            block_starts_str = parts[8].rstrip(",")
            if (
                not block_sizes_str
                or not block_starts_str
                or block_sizes_str == "."
                or block_starts_str == "."
            ):
                continue

            try:
                block_sizes = [int(x) for x in block_sizes_str.split(",") if x]
                block_starts = [int(x) for x in block_starts_str.split(",") if x]
            except ValueError:
                continue

            block_extras = None
            if len(parts) >= 10:
                extra_str = parts[9].rstrip(",").strip()
                if extra_str and extra_str != ".":
                    try:
                        block_extras = (
                            [int(x) for x in extra_str.split(",") if x]
                            if "," in extra_str
                            else [int(extra_str)]
                        )
                    except ValueError:
                        block_extras = None
                    if block_extras is not None and len(block_extras) != len(block_starts):
                        block_extras = None

            if layer_type == "deam":
                events: list = []
                for i, (block_start, block_size) in enumerate(zip(block_starts, block_sizes)):
                    flavor = int(block_extras[i]) if block_extras else 0
                    flavor = 1 if flavor else 0
                    abs_start = entry_start + block_start
                    abs_end = abs_start + block_size
                    for pos in range(abs_start, abs_end):
                        if region_start <= pos < region_end:
                            events.append([pos - region_start, flavor])
                if events:
                    marks.setdefault(read_id, []).extend(events)
            else:
                positions: list = []
                for block_index, (block_start, block_size) in enumerate(zip(block_starts, block_sizes)):
                    # A DddA ddda_mcg span in an m5c BigBed is an interval
                    # layer, not a run of 5mC calls: never expand it.
                    if layer_type == "m5c" and is_ddda_mcg_block(
                        block_size, block_extras[block_index] if block_extras is not None else None,
                    ):
                        continue
                    abs_start = entry_start + block_start
                    abs_end = abs_start + block_size
                    for pos in range(abs_start, abs_end):
                        if region_start <= pos < region_end:
                            positions.append(pos - region_start)
                if positions:
                    marks.setdefault(read_id, []).extend(positions)
    except Exception as exc:
        log_bigbed_diagnostic(f"Error loading methyl from companion BigBed {bigbed_path}: {exc}")

    return marks


# ---- fibertools-rs / FIRE per-fiber bigBeds -------------------------------
#
# `ft track-decorators` (fibertools-rs src/subcommands/decorator.rs) writes one
# BED12 row per fiber (FIRE's fire-fibers.bb: two 1-bp blocks at the fiber's
# ends + a haplotype keyword) and, per fiber and element type, one UCSC
# "decoration" row (fire-fiber-decorators.bb): name m6A / 5mC / NUC / FIRE /
# LINKER, the calls as blocks, and the fiber as decoratedItem
# "chrom:start-end:qname". MSP rows are split by colour: fibertools colours
# each MSP by its FIRE FDR bin (src/lib.rs FIRE_COLORS), and older releases
# named every MSP row "FIRE", linker-coloured ones included, so the colour, not
# the name, says how good an MSP is.

# Rows are indexed by their own extent (first to last call). The first fetch is
# the window padded by this much (to find the fibers crossing it); the rows are
# then read over those fibers' whole spans (compact_read_loader), so the calls
# flanking the window, which size the footprints drawn in it, always come too.
FIRE_DECORATOR_FETCH_PAD = 5_000

# fibertools FIRE_COLORS: (max FDR %, RGB). LINKER (FDR 100) is a non-FIRE MSP.
_FIRE_FDR_COLORS = (
    (1.0, (139, 0, 0)),
    (2.0, (175, 0, 0)),
    (3.0, (200, 0, 0)),
    (4.0, (225, 0, 0)),
    (5.0, (255, 0, 0)),
    (10.0, (255, 140, 0)),
    (25.0, (225, 225, 0)),
    (100.0, (147, 112, 219)),
)


def _min_aq_for_fdr(fdr_percent: float) -> int:
    # fibertools: fdr = 100 - aq / 255 * 100, coloured by the first bin with
    # fdr <= bound. The smallest aq in a bin is ceil(255 * (1 - bound / 100)).
    if fdr_percent >= 100.0:
        return 0
    return int(math.ceil(255 * (1 - fdr_percent / 100.0) - 1e-9))


FIRE_COLOR_TO_AQ = {rgb: _min_aq_for_fdr(fdr) for fdr, rgb in _FIRE_FDR_COLORS}
_FIRE_MSP_NAMES = {'FIRE', 'LINKER', 'MSP'}
_DECORATED_ITEM_RE = re.compile(r'^(.+?):(\d+)-(\d+):(.*)$')


def parse_decorated_item(value: str):
    """``chrom:start-end:name`` -> (chrom, start, end, name), or None."""
    match = _DECORATED_ITEM_RE.match((value or '').strip())
    if not match:
        return None
    return match.group(1), int(match.group(2)), int(match.group(3)), match.group(4)


def _rgb(value: str):
    parts = (value or '').strip().split(',')
    if len(parts) < 3:
        return None
    try:
        return tuple(int(x) for x in parts[:3])
    except ValueError:
        return None


def _fire_msp_aq(name: str, color: str) -> Optional[int]:
    """The FIRE quality floor of an MSP decorator row, or None if not an MSP."""
    rgb = _rgb(color)
    if rgb in FIRE_COLOR_TO_AQ:
        return FIRE_COLOR_TO_AQ[rgb]
    if name in _FIRE_MSP_NAMES:
        # Unknown palette: trust the name.
        return 255 if name == 'FIRE' else 0
    return None


def _row_blocks(entry_start: int, fields: list[str]):
    try:
        sizes = [int(x) for x in fields[7].rstrip(',').split(',') if x]
        starts = [int(x) for x in fields[8].rstrip(',').split(',') if x]
    except (ValueError, IndexError):
        return []
    return [(entry_start + s, entry_start + s + z) for s, z in zip(starts, sizes) if z > 0]


def fire_fiber_reads(
    decorator_entries,
    region_start: int,
    region_end: int,
    *,
    fiber_entries=None,
    spanning_only: bool = True,
    hide_terminal_gaps: bool = True,
    min_footprints: int = 0,
    include_nuc: bool = True,
    include_msp: bool = True,
    include_layer_qualities: bool = True,
) -> list[dict]:
    """Compact reads from FIRE decorator rows (and optional fire-fibers rows).

    Read id = the fiber's qname, span = its decoratedItem span (or its
    fire-fibers row). Footprints are the NUC blocks; when the file has no NUC
    rows for a fiber (the FIRE workflow strips them), they are the stretches
    between its MSPs, as for BAM reads with only as/al tags. MSPs (FIRE and
    LINKER rows) are the ``msp`` layer with an ``aq`` floor from their colour
    (so the FIRE gate aq >= 230 keeps FDR <= 10% MSPs). m6A / 5mC blocks are
    ``methyl_m6a`` / ``methyl_m5c`` positions.
    """
    from services.compact_read_loader import walk_read_intervals

    fibers: dict[str, dict] = {}

    def _fiber(qname, start, end):
        fiber = fibers.get(qname)
        if fiber is None:
            fiber = {'start': int(start), 'end': int(end), 'nucs': [], 'msps': [],
                     'm6a': set(), 'm5c': set(), 'has_nuc': False}
            fibers[qname] = fiber
        return fiber

    for e_start, _e_end, rest in fiber_entries or ():
        fields = rest.split('\t')
        if fields and fields[0]:
            _fiber(fields[0], e_start, _e_end)

    for e_start, _e_end, rest in decorator_entries or ():
        fields = rest.split('\t')
        if len(fields) < 10:
            continue
        item = parse_decorated_item(fields[9])
        if item is None:
            continue
        _chrom, f_start, f_end, qname = item
        name = fields[0].strip()
        blocks = _row_blocks(int(e_start), fields)
        if not blocks:
            continue
        fiber = _fiber(qname, f_start, f_end)
        if name == 'm6A':
            fiber['m6a'].update(p for s, e in blocks for p in range(s, e))
        elif name == '5mC':
            fiber['m5c'].update(p for s, e in blocks for p in range(s, e))
        elif name == 'NUC':
            fiber['has_nuc'] = True
            fiber['nucs'].extend(blocks)
        else:
            aq = _fire_msp_aq(name, fields[5])
            if aq is not None:
                fiber['msps'].extend((s, e, aq) for s, e in blocks)

    reads: list[dict] = []
    for qname, fiber in fibers.items():
        f_start, f_end = fiber['start'], fiber['end']
        if spanning_only:
            if f_start > region_start or f_end < region_end:
                continue
        elif f_start >= region_end or f_end <= region_start:
            continue

        msps = sorted(set(fiber['msps']))
        if fiber['has_nuc']:
            nucs = sorted(set(fiber['nucs']))
        else:
            nucs = []
            pos = f_start
            for s, e, _aq in msps:
                if s > pos:
                    nucs.append((pos, s))
                pos = max(pos, e)
            if (msps or fiber['m6a'] or fiber['m5c']) and f_end > pos:
                nucs.append((pos, f_end))
        if min_footprints > 0 and len(nucs) < min_footprints:
            continue

        intervals = [
            [int(s - region_start), int(e - region_start), int(size)]
            for s, e, size, _i in walk_read_intervals(
                [(s, e, e - s) for s, e in nucs], f_start, f_end,
                region_start, region_end, hide_terminal_gaps,
            )
        ]
        if not intervals:
            if nucs:
                continue  # like a footprint read: only a hidden terminal gap in view
            intervals = [[int(max(f_start, region_start) - region_start),
                          int(min(f_end, region_end) - region_start), 0]]

        read: dict = {'id': qname, 'intervals': intervals}
        layers: dict = {}
        if include_nuc:
            nuc_ivs = [iv for iv in intervals if iv[2] > 0]
            if nuc_ivs:
                layers['nuc'] = {'intervals': nuc_ivs, 'qualities': None, 'quality_names': []}
        if include_msp:
            msp_ivs, msp_aq = [], []
            for s, e, aq in msps:
                if e <= region_start or s >= region_end:
                    continue
                msp_ivs.append([int(max(s, region_start) - region_start),
                                int(min(e, region_end) - region_start), int(e - s)])
                msp_aq.append(int(aq))
            if msp_ivs:
                layers['msp'] = {
                    'intervals': msp_ivs,
                    'qualities': [msp_aq] if include_layer_qualities else None,
                    'quality_names': ['aq'] if include_layer_qualities else [],
                }
        if layers:
            read['layers'] = layers
        for key, field in (('m6a', 'methyl_m6a'), ('m5c', 'methyl_m5c')):
            marks = sorted(p - region_start for p in fiber[key] if region_start <= p < region_end)
            if marks:
                read[field] = marks
        reads.append(read)
    return reads
