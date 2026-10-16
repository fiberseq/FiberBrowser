"""Compact read payload builders for DAF-C linked-region views."""
from __future__ import annotations

import random
from typing import Callable, Dict, List, Optional

from services.read_metrics import normalize_sample_seed, stable_seed_int
from services.split_view_modes import MOLECULE_LINKED, normalize_split_view_mode, split_view_semantics


def empty_compact_response(width: int = 1000) -> Dict:
    return {
        "reads": [],
        "count": 0,
        "total": 0,
        "paired_count": 0,
        "working_count": 0,
        "width": width,
    }


def with_split_metadata(result: Dict, session: Dict, sample_seed: Optional[str] = None) -> Dict:
    mode = normalize_split_view_mode(
        session.get("split_view_mode"),
        session.get("contact_mode"),
    )
    result["contact_mode"] = session.get("contact_mode")
    result["split_view_mode"] = mode
    result["split_view_semantics"] = split_view_semantics(mode, session.get("contact_mode"))
    if sample_seed is not None:
        result["sample_seed"] = sample_seed
    return result


def region_context(regions: Dict, region: str) -> Dict:
    if region == "x":
        region_start = regions["x_start"]
        region_end = regions["x_end"]
        segment_key = "x_segments"
        chrom = regions.get("x_chrom") or regions.get("chrom", "")
    else:
        region_start = regions["y_start"]
        region_end = regions["y_end"]
        segment_key = "y_segments"
        chrom = regions.get("y_chrom") or regions.get("chrom", "")
    return {
        "chrom": chrom,
        "start": region_start,
        "end": region_end,
        "width": region_end - region_start,
        "segment_key": segment_key,
    }


def _parse_blocks(block_sizes_str: str, block_starts_str: str):
    if not block_sizes_str or not block_starts_str:
        return None
    try:
        block_sizes = [int(x) for x in block_sizes_str.rstrip(",").split(",") if x]
        block_starts = [int(x) for x in block_starts_str.rstrip(",").split(",") if x]
    except (ValueError, IndexError):
        return None
    return block_sizes, block_starts


def compact_intervals_from_entry(
    entry: Dict,
    region_start: int,
    region_end: int,
    hide_terminal_gaps: bool = True,
    terminal_gap_threshold: int = 500,
) -> Optional[List[List[int]]]:
    """Convert one BED12-like read entry into compact intervals.

    Returns None when terminal-gap filtering excludes the read.
    """
    parsed = _parse_blocks(entry.get("blockSizes", ""), entry.get("blockStarts", ""))
    if parsed is None:
        return []

    block_sizes, block_starts = parsed
    if hide_terminal_gaps and terminal_gap_threshold > 0 and block_starts:
        first_block_start = entry["start"] + block_starts[0]
        last_block_end = entry["start"] + block_starts[-1] + block_sizes[-1]
        leading_gap = first_block_start - entry["start"]
        trailing_gap = entry["end"] - last_block_end
        if leading_gap > terminal_gap_threshold or trailing_gap > terminal_gap_threshold:
            return None

    # The compact loaders' walk: footprints and gaps clipped to the region
    # (region-relative), internal gaps from the whole read's footprints.
    from services.compact_read_loader import walk_read_intervals

    blocks = sorted(
        (entry["start"] + block_start, entry["start"] + block_start + block_size, block_size)
        for block_size, block_start in zip(block_sizes, block_starts)
    )
    return [
        [start - region_start, end - region_start, size]
        for start, end, size, _ in walk_read_intervals(
            blocks, entry["start"], entry["end"], region_start, region_end, hide_terminal_gaps,
        )
    ]


def microc_compact_response(
    entries: List[Dict],
    ctx: Dict,
    max_reads: int,
    sample_seed: str,
    hide_terminal_gaps: bool = True,
    terminal_gap_threshold: int = 500,
) -> Dict:
    if max_reads <= 0 or len(entries) <= max_reads:
        sampled_entries = entries
    else:
        seed = stable_seed_int(sample_seed, "independent_compact", ctx["chrom"], ctx["start"], ctx["end"])
        rng = random.Random(seed)
        sampled_indices = sorted(rng.sample(range(len(entries)), max_reads))
        sampled_entries = [entries[i] for i in sampled_indices]

    compact_reads = []
    for entry in sampled_entries:
        intervals = compact_intervals_from_entry(
            entry,
            ctx["start"],
            ctx["end"],
            hide_terminal_gaps=hide_terminal_gaps,
            terminal_gap_threshold=terminal_gap_threshold,
        )
        if intervals is None:
            continue
        compact_reads.append({
            "id": entry["name"],
            "intervals": intervals,
        })

    return {
        "reads": compact_reads,
        "count": len(compact_reads),
        "total": len(entries),
        "paired_count": 0,
        "working_count": len(compact_reads),
        "width": ctx["width"],
        "sample_seed": sample_seed,
        "region": {
            "chrom": ctx["chrom"],
            "start": ctx["start"],
            "end": ctx["end"],
        },
        "contact_mode": "microc",
    }


def _segment_intervals(
    segments: List[Dict],
    region_start: int,
    region_width: int,
    hide_terminal_gaps: bool = True,
) -> List[List[int]]:
    intervals: List[List[int]] = []
    for seg in segments:
        seg_start = seg["start"]
        seg_end = seg["end"]
        parsed = _parse_blocks(seg.get("blockSizes", ""), seg.get("blockStarts", ""))

        if parsed is not None:
            from services.compact_read_loader import walk_read_intervals

            block_sizes, block_starts = parsed
            # Gaps from the whole segment's consecutive blocks, then clipped: a
            # window inside an internal gap still shows it (and the segment).
            blocks = sorted(
                (seg_start + block_start, seg_start + block_start + block_size, block_size)
                for block_size, block_start in zip(block_sizes, block_starts)
            )
            for start, end, size, _ in walk_read_intervals(
                blocks, seg_start, seg_end, region_start, region_start + region_width, hide_terminal_gaps,
            ):
                intervals.append([int(start - region_start), int(end - region_start), int(size)])
        else:
            rel_start = max(0, seg_start - region_start)
            rel_end = min(region_width, seg_end - region_start)
            if rel_end > rel_start:
                intervals.append([rel_start, rel_end, rel_end - rel_start])

    intervals.sort(key=lambda x: x[0])
    return intervals


def _segments_pass_terminal_gap_filter(segments: List[Dict], terminal_gap_threshold: int) -> bool:
    """Return False when any BED12 segment has a large clipped terminal gap."""
    if terminal_gap_threshold <= 0:
        return True

    for seg in segments:
        parsed = _parse_blocks(seg.get("blockSizes", ""), seg.get("blockStarts", ""))
        if parsed is None:
            continue
        block_sizes, block_starts = parsed
        if not block_sizes or not block_starts:
            continue

        first_block_start = seg["start"] + block_starts[0]
        last_block_end = seg["start"] + block_starts[-1] + block_sizes[-1]
        leading_gap = first_block_start - seg["start"]
        trailing_gap = seg["end"] - last_block_end
        if leading_gap > terminal_gap_threshold or trailing_gap > terminal_gap_threshold:
            return False
    return True


def paired_ligated_reads(ligated_reads: List[Dict]) -> tuple[List[Dict], int]:
    valid_reads = []
    skipped_count = 0
    for read in ligated_reads:
        if read.get("x_segments") and read.get("y_segments"):
            valid_reads.append(read)
        else:
            skipped_count += 1
    return valid_reads, skipped_count


def sample_linked_reads(
    valid_reads: List[Dict],
    max_reads: int,
    sample_seed: str,
    session_id: str,
    regions: Dict,
) -> List[Dict]:
    if max_reads <= 0 or len(valid_reads) <= max_reads:
        return valid_reads

    from services.read_pins import compact_read_id, with_pinned
    seed = stable_seed_int(sample_seed, "linked_compact", session_id, regions["x_start"], regions["y_start"])
    rng = random.Random(seed)
    indices = sorted(rng.sample(range(len(valid_reads)), max_reads))
    # A molecule gone to by name stays in the sample (services/read_pins.py).
    return with_pinned([valid_reads[i] for i in indices], valid_reads, compact_read_id)


def linked_read_sort_position(read: Dict, segment_key: str) -> int:
    segments = read.get(segment_key) or []
    if not segments:
        return 2**63 - 1
    return min(int(seg.get("start", 2**63 - 1)) for seg in segments)


def dafc_compact_response(
    session_id: str,
    session: Dict,
    ctx: Dict,
    max_reads: int,
    sample_seed: str,
    sort_by: str = "x",
    hide_terminal_gaps: bool = True,
    terminal_gap_threshold: int = 500,
    log_fn: Optional[Callable[[str], None]] = None,
) -> Dict:
    ligated_reads = session.get("reads", [])
    if not ligated_reads:
        return with_split_metadata(empty_compact_response(ctx["width"]), session, sample_seed)

    valid_reads, skipped_count = paired_ligated_reads(ligated_reads)
    if skipped_count > 0 and log_fn:
        log_fn(f"Linked compact: skipped {skipped_count} reads without segments in both regions")

    if hide_terminal_gaps and terminal_gap_threshold > 0:
        before_filter = len(valid_reads)
        valid_reads = [
            read for read in valid_reads
            if _segments_pass_terminal_gap_filter(read.get("x_segments") or [], terminal_gap_threshold)
            and _segments_pass_terminal_gap_filter(read.get("y_segments") or [], terminal_gap_threshold)
        ]
        filtered_count = before_filter - len(valid_reads)
        if filtered_count > 0 and log_fn:
            log_fn(f"Linked compact: filtered {filtered_count} pairs with terminal gaps > {terminal_gap_threshold}bp")

    sort_segment_key = "y_segments" if sort_by == "y" else "x_segments"
    valid_reads = sorted(valid_reads, key=lambda read: linked_read_sort_position(read, sort_segment_key))

    total_pairs = len(valid_reads)
    sampled_reads = sample_linked_reads(valid_reads, max_reads, sample_seed, session_id, session["regions"])
    if max_reads > 0 and total_pairs > max_reads and log_fn:
        log_fn(f"Linked compact: sampled {max_reads}/{total_pairs} pairs")

    compact_reads = []
    for idx, ligated in enumerate(sampled_reads):
        segments = ligated.get(ctx["segment_key"], [])
        if not segments:
            if log_fn:
                log_fn(f"WARNING: Read {ligated['read_id']} missing {ctx['segment_key']} after filter")
            compact_reads.append({
                "id": ligated["read_id"],
                "order_index": idx,
                "intervals": [],
            })
            continue

        compact_reads.append({
            "id": ligated["read_id"],
            "order_index": idx,
            "intervals": _segment_intervals(
                segments,
                ctx["start"],
                ctx["width"],
                hide_terminal_gaps=hide_terminal_gaps,
            ),
        })

    result = {
        "reads": compact_reads,
        "count": len(compact_reads),
        "total": len(ligated_reads),
        "paired_count": total_pairs,
        "working_count": total_pairs,
        "width": ctx["width"],
        "region": {
            "chrom": ctx["chrom"],
            "start": ctx["start"],
            "end": ctx["end"],
        },
        "sample_seed": sample_seed,
    }
    return with_split_metadata(result, session, sample_seed)


def linked_reads_compact_response(
    session_id: str,
    session: Dict,
    region: str,
    max_reads: int,
    sort_by: str,
    sample_seed: Optional[str],
    query_reads_fn: Callable[..., List[Dict]],
    state=None,
    dafc_state=None,
    hide_terminal_gaps: bool = True,
    terminal_gap_threshold: int = 500,
    log_fn: Optional[Callable[[str], None]] = None,
) -> Dict:
    sample_seed = normalize_sample_seed(sample_seed)

    if not session.get("regions"):
        return with_split_metadata(empty_compact_response(), session, sample_seed)

    ctx = region_context(session["regions"], region)
    split_view_mode = normalize_split_view_mode(
        session.get("split_view_mode"),
        session.get("contact_mode", "dafc"),
    )
    if split_view_mode != MOLECULE_LINKED:
        entries = query_reads_fn(ctx["chrom"], ctx["start"], ctx["end"], state=state, dafc_state=dafc_state)
        result = microc_compact_response(
            entries,
            ctx,
            max_reads,
            sample_seed,
            hide_terminal_gaps=hide_terminal_gaps,
            terminal_gap_threshold=terminal_gap_threshold,
        )
        result["split_view_mode"] = split_view_mode
        result["split_view_semantics"] = split_view_semantics(split_view_mode)
        return result

    return dafc_compact_response(
        session_id,
        session,
        ctx,
        max_reads,
        sample_seed,
        sort_by=sort_by,
        hide_terminal_gaps=hide_terminal_gaps,
        terminal_gap_threshold=terminal_gap_threshold,
        log_fn=log_fn,
    )
