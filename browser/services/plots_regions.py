"""Plots: the reads of many regions at once (BED region sets).

For each region set: subsample the regions (random N with a seed, equal N per set, all; capped), then for every
chosen region and dataset read the working set over the region's window and return engine-ready reads: the read's
span, the chosen source's intervals (absolute, half-open) or marks, and (for the nucleosome-occlusion filter) its
nucleosome intervals. Reads per region are a seeded, stable sample. The work runs in chunks, so a client that goes
away (cancels) stops it between chunks.
"""
from __future__ import annotations

import random
from typing import Iterable

ALL_FOOTPRINTS = "all_footprints"


def source_layers(source: str) -> list[str]:
    if source == ALL_FOOTPRINTS:
        return ["nuc", "tf"]
    if source == "fire":
        return ["msp", "fire"]
    if source == "m6a":
        return []
    return [source]


def region_identity(region: list) -> str:
    """A BED region's identity for sampling keys (coordinates, strand, name; not its line number)."""
    r = list(region) + ["", "", "", "", ""]
    return f"{r[0]}:{int(r[1])}-{int(r[2])}:{r[3] or '.'}:{r[4] or ''}"


def subsample_regions(sets: list[dict], mode: str, n: int, seed: int, cap: int) -> list[list[int]]:
    """The indices of the regions read per set (sorted): all (to the cap), random N per set, equal N per set.

    Random picks are the stable sampling rule (services/stable_sample): the regions with the smallest keys of (seed,
    set id, region identity), so a region's selection does not depend on line order or on the other sets."""
    from services.stable_sample import lowest_k, stable_key
    smallest = min((len(s.get("regions") or []) for s in sets), default=0)
    out = []
    for s in sets:
        regions = s.get("regions") or []
        total = len(regions)
        k = total if mode == "all" else smallest if mode == "equal" else n
        k = min(k, cap, total)
        if k >= total:
            out.append(list(range(total)))
            continue
        sid = str(s.get("id") or "")
        idx = lowest_k(range(total), k, key=lambda i: stable_key(seed, sid, region_identity(regions[i])),
                       ident=lambda i: f"{region_identity(regions[i])}#{i:09d}")
        out.append(sorted(idx))
    return out


def _abs(intervals: Iterable, offset: int, positive_only: bool = True, sizes: list | None = None) -> list[int]:
    """Flat absolute [a, b, ...]; ``sizes`` (when given) gets each kept interval's footprint size (its third field,
    the whole size of an interval clipped to the fetched span; else its length)."""
    flat: list[int] = []
    for iv in intervals or []:
        if len(iv) < 2:
            continue
        a, b = int(iv[0]), int(iv[1])
        size = iv[2] if len(iv) > 2 else 1
        if b <= a or (positive_only and size is not None and size <= 0):
            continue
        flat.extend((offset + a, offset + b))
        if sizes is not None:
            sizes.append(int(iv[2]) if len(iv) > 2 and iv[2] is not None and iv[2] > 0 else b - a)
    return flat


def engine_read(read: dict, offset: int, source: str, occluders: bool, sizes: list | None = None) -> list | None:
    """[start, end, source intervals (flat), marks, nucleosomes (flat)] in absolute coordinates; None without a span.
    ``sizes`` (when given) gets each source interval's footprint size, in order."""
    ivs = read.get("intervals") or []
    blocks = read.get("aligned_blocks") or []
    if blocks:
        start, end = min(b[0] for b in blocks), max(b[1] for b in blocks)
    elif ivs:
        start, end = offset + min(i[0] for i in ivs), offset + max(i[1] for i in ivs)
    else:
        return None
    if end <= start:
        return None
    layers = read.get("layers") or {}

    def layer(name: str, out: list | None = None) -> list[int]:
        return _abs((layers.get(name) or {}).get("intervals") or [], offset, sizes=out)

    def nuc_src(out: list | None = None) -> list[int]:
        return layer("nuc", out) if "nuc" in layers else _abs(ivs, offset, sizes=out)

    nuc = nuc_src()
    marks: list[int] = []
    if source == ALL_FOOTPRINTS:
        src = nuc_src(sizes) + layer("tf", sizes)
    elif source == "nuc":
        src = nuc_src(sizes)
    elif source == "fire":
        src = layer("msp", sizes) + layer("fire", sizes)
    elif source == "m6a":
        src = []
        marks = [offset + int(p) for p in (read.get("methyl_m6a") or read.get("methyl") or [])]
    else:
        src = layer(source, sizes)
    return [int(start), int(end), src, marks, nuc if occluders else []]


def footprint_intervals(read: dict, offset: int) -> list[int]:
    """Every footprint of a read (the nucleosome and TF layers, or its calls without layers), flat, absolute, by start."""
    layers = read.get("layers") or {}
    if "nuc" in layers or "tf" in layers:
        flat = _abs((layers.get("nuc") or {}).get("intervals") or [], offset) + _abs((layers.get("tf") or {}).get("intervals") or [], offset)
    else:
        flat = _abs(read.get("intervals") or [], offset)
    pairs = sorted((flat[k], flat[k + 1]) for k in range(0, len(flat) - 1, 2))
    return [x for p in pairs for x in p]


def clip_flat(flat: list[int], start: int, end: int) -> list[int]:
    """Flat intervals [a, b, a, b, ...] clipped to [start, end)."""
    out: list[int] = []
    for k in range(0, len(flat) - 1, 2):
        a, b = max(flat[k], start), min(flat[k + 1], end)
        if b > a:
            out.extend((a, b))
    return out


def whole_in_window(flat: list[int], sizes: list[int], start: int, end: int) -> tuple[list[int], list[int]]:
    """The intervals overlapping [start, end), not clipped, with their sizes (size histograms: the real bounds)."""
    out: list[int] = []
    kept: list[int] = []
    for k in range(0, len(flat) - 1, 2):
        if flat[k + 1] > start and flat[k] < end:
            out.extend((flat[k], flat[k + 1]))
            kept.append(sizes[k // 2])
    return out, kept


def cut_by_fetch(flat: list[int], lo: int, hi: int) -> list[int]:
    """Indices of the intervals that reach the fetched span's edges [lo, hi): the loader may have cut them there, so
    their reference bounds are not whole. A footprint across a large deletion can reach past any margin (its reference
    span is not bounded by its size), so the margin alone does not make it whole. lo = 0 cuts nothing."""
    return [k // 2 for k in range(0, len(flat) - 1, 2) if (lo > 0 and flat[k] <= lo) or flat[k + 1] >= hi]


def relative_flat(flat: list[int], offset: int) -> list[int]:
    return [x - offset for x in flat]


def sample_reads(rows: list, k: int, seed: int, dataset: str) -> list:
    """Up to k engine rows (the read name at index 5) by the stable sampling rule: the reads with the smallest keys
    of (seed, dataset, read name), in start order. The same read gets the same key in every region and chunk."""
    if k <= 0 or len(rows) <= k:
        return rows
    from services.stable_sample import lowest_k, stable_key
    kept = lowest_k(rows, k, key=lambda r: stable_key(seed, dataset, r[5]), ident=lambda r: f"{r[5]}|{r[0]}")
    return sorted(kept, key=lambda r: (r[0], r[5]))


def region_window(region: list, anchor: str, mode: str, flank: int, scale_flank: int) -> tuple[str, int, int]:
    chrom, start, end = region[0], int(region[1]), int(region[2])
    strand = region[3] if len(region) > 3 else "."
    if mode == "scale":
        return chrom, max(0, start - scale_flank), end + scale_flank
    if anchor == "centre":
        a = (start + end + 1) // 2  # as the client rounds (half up)
    elif anchor == "start":
        a = end if strand == "-" else start
    else:
        a = start if strand == "-" else end
    return chrom, max(0, a - flank), a + flank


def region_blocks(windows: list[tuple[str, int, int]], max_gap: int = 20_000, max_len: int = 250_000) -> list[tuple[str, int, int, list[int]]]:
    """Windows merged into blocks read once each (nearby windows on a chromosome): (chrom, start, end, window indices)."""
    order = sorted(range(len(windows)), key=lambda i: (windows[i][0], windows[i][1]))
    blocks: list[list] = []
    for i in order:
        chrom, start, end = windows[i]
        last = blocks[-1] if blocks else None
        if last and last[0] == chrom and start - last[2] <= max_gap and max(end, last[2]) - last[1] <= max_len:
            last[2] = max(last[2], end)
            last[3].append(i)
        else:
            blocks.append([chrom, start, end, [i]])
    return [(b[0], b[1], b[2], b[3]) for b in blocks]


def clip_read(row: list, start: int, end: int) -> list | None:
    """An engine read clipped to [start, end): its span, intervals, marks and nucleosomes inside the window only."""
    s, e = max(row[0], start), min(row[1], end)
    if e <= s:
        return None

    def clip(flat: list[int]) -> list[int]:
        out: list[int] = []
        for k in range(0, len(flat) - 1, 2):
            a, b = max(flat[k], start), min(flat[k + 1], end)
            if b > a:
                out.extend((a, b))
        return out

    return [s, e, clip(row[2]), [p for p in row[3] if start <= p < end], clip(row[4])]


def relative_row(row: list, offset: int) -> list:
    """A clipped read relative to its window start. Nucleosomes that repeat the start of the source intervals (they
    always do for the nucleosome and all-footprints sources) are sent as their count of numbers instead."""
    src = [x - offset for x in row[2]]
    nuc = [x - offset for x in row[4]]
    shared = len(nuc) if nuc and src[:len(nuc)] == nuc else nuc
    return [row[0] - offset, row[1] - offset, src, [x - offset for x in row[3]], shared]
