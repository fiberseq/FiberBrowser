"""Where a BAM's reads are, from its index: targeted regions without reading every read.

A targeted run (a capture, a few loci of long reads) can hold tens of thousands of
reads of 70 kb each (MM/ML tags): reading them all to find two regions takes
minutes. Its ``.bai`` already says where they are:

- the linear index gives, per 16 kb window, the file offset of the first read
  overlapping the window; windows without reads keep a neighbour's offset. The
  bytes between two windows' offsets are the reads between them, and the
  reference's pseudo-bin holds its first and last offsets and its mapped-read
  count (bytes per read). That is a coarse profile of where the data is
  (``window_bytes``), enough to tell a targeted dataset (most of its data in a
  small share of the genome) from a whole-genome one (``survey``);
- around each dense stretch, one record read at each distinct offset gives where
  those reads start and how long they are (a few dozen seeks per region), and the
  reads between two offsets are spread over the starts between them, each as long
  as its sampled read: a depth profile at 1 kb (``refine``), trimmed to half its
  peak. It estimates the depth's shape (its scale within about two-fold): good for
  finding where the reads are, not for counting them.

Everything here returns None without a local ``.bai`` (a CSI index, a remote file):
callers then say they read the reads instead.
"""
from __future__ import annotations

import os
import struct
from dataclasses import dataclass
from typing import Optional

WINDOW_BP = 16_384
# The reference's pseudo-bin (SAM spec 5.2): its first/last offsets and mapped/unmapped counts.
PSEUDO_BIN = 37450
# A dataset is targeted when the densest windows holding DENSE_DATA_SHARE of its data
# cover at most TARGETED_GENOME_SHARE of the genome its reads are on.
DENSE_DATA_SHARE = 0.8
TARGETED_GENOME_SHARE = 0.05
# A coarse stretch: windows over this share of the densest window, closer than MERGE_WINDOWS merged.
COARSE_FLOOR_SHARE = 0.05
MERGE_WINDOWS = 2
# Sampled around a stretch (long reads start well before the first window they reach).
MARGIN_WINDOWS = 8
# Records read at each distinct offset (their median length is the group's).
SAMPLE_RECORDS = 2
# Distinct offsets sampled at most per stretch.
MAX_SAMPLES = 500
# Refined profile resolution, and the share of a stretch's peak its region extends to.
PROFILE_BP = 1_000
EDGE_SHARE = 0.5
# Stretches reported at most per dataset.
MAX_STRETCHES = 200

from services.byte_cache import shared_cache
_INDEX_CACHE = shared_cache('indexes')


@dataclass
class ContigIndex:
    """One reference's linear index (virtual offsets) and pseudo-bin."""
    linear: tuple
    begin: int  # virtual offset of its first read
    end: int    # virtual offset after its last read
    mapped: int
    chunks: tuple = ()  # (bin, ((beg, end), ...)) of the real bins: their bounds are record starts too

    def bytes_per_read(self, ratio: float) -> float:
        return max(1e-6, (file_pos(self.end, ratio) - file_pos(self.begin, ratio)) / max(1, self.mapped))


def bai_path(bam_path: str) -> Optional[str]:
    if not bam_path or "://" in str(bam_path):
        return None
    for candidate in (bam_path + ".bai", bam_path[:-4] + ".bai" if bam_path.lower().endswith(".bam") else None):
        if candidate and os.path.isfile(candidate):
            return candidate
    return None


def parse_bai(path: str) -> list:
    """[ContigIndex | None] per reference of a BAI file (full virtual offsets: they are seeked to)."""
    st = os.stat(path)
    key = (path, st.st_size, st.st_mtime_ns)
    cached = _INDEX_CACHE.get(key)
    if cached is not None:
        return cached
    with open(path, "rb") as fh:
        data = fh.read()
    if data[:4] != b"BAI\1":
        raise ValueError(f"{os.path.basename(path)} is not a BAI index")
    n_ref = struct.unpack_from("<i", data, 4)[0]
    off = 8
    refs: list = []
    for _ in range(n_ref):
        n_bin = struct.unpack_from("<i", data, off)[0]
        off += 4
        begin = end = mapped = 0
        bins = []
        for _b in range(n_bin):
            bin_id, n_chunk = struct.unpack_from("<Ii", data, off)
            off += 8
            if bin_id == PSEUDO_BIN and n_chunk >= 2:
                begin, end, mapped, _unmapped = struct.unpack_from("<4Q", data, off)
            elif n_chunk:
                flat = struct.unpack_from(f"<{2 * n_chunk}Q", data, off)
                bins.append((bin_id, tuple(zip(flat[::2], flat[1::2]))))
            off += 16 * n_chunk
        n_intv = struct.unpack_from("<i", data, off)[0]
        off += 4
        linear = struct.unpack_from(f"<{n_intv}Q", data, off) if n_intv else ()
        off += 8 * n_intv
        refs.append(ContigIndex(linear, begin, end, mapped, tuple(bins)) if n_intv and mapped else None)
    _INDEX_CACHE[key] = refs
    return refs


def bin_span(bin_id: int) -> tuple:
    """[start, end) in bp of a BAI bin (SAM spec 5.3: six levels, 16 kb leaves)."""
    for first, shift in ((4681, 14), (585, 17), (73, 20), (9, 23), (1, 26), (0, 29)):
        if bin_id >= first:
            k = bin_id - first
            return k << shift, (k + 1) << shift
    return 0, 1 << 29


_RATIO_CACHE = shared_cache('indexes')


def block_ratio(bam_path: str, voffsets) -> float:
    """Uncompressed over compressed size of the file's BGZF blocks (median of those at ``voffsets``):
    a virtual offset's in-block part is uncompressed bytes, its block address compressed ones."""
    try:
        st = os.stat(bam_path)
    except OSError:
        return 3.0
    key = (bam_path, st.st_size, st.st_mtime_ns)
    if key in _RATIO_CACHE:
        return _RATIO_CACHE[key]
    ratios = []
    try:
        with open(bam_path, "rb") as fh:
            for c in sorted({v >> 16 for v in voffsets})[:: max(1, len(voffsets) // 24)][:32]:
                fh.seek(c)
                head = fh.read(18)
                if len(head) < 18 or head[:4] != b"\x1f\x8b\x08\x04":
                    continue
                bsize = struct.unpack_from("<H", head, 16)[0] + 1
                fh.seek(c + bsize - 4)
                isize = struct.unpack("<I", fh.read(4))[0]
                if bsize > 0 and isize > 0:
                    ratios.append(isize / bsize)
    except (OSError, struct.error):
        pass
    ratios.sort()
    ratio = ratios[len(ratios) // 2] if ratios else 3.0
    _RATIO_CACHE[key] = ratio
    return ratio


def file_pos(voffset: int, ratio: float) -> float:
    """A virtual offset as compressed-equivalent bytes from the file's start (monotone in the offset)."""
    return (voffset >> 16) + (voffset & 0xFFFF) / ratio


def bam_index(bam_path: str) -> Optional[list]:
    path = bai_path(bam_path)
    if path is None:
        return None
    try:
        return parse_bai(path)
    except (OSError, ValueError, struct.error):
        return None


def window_bytes(idx: ContigIndex, ratio: float) -> dict:
    """{window: bytes of the reads first reaching it} (only windows with data; compressed-equivalent bytes).

    Windows without reads of their own carry the next window's offset (htslib fills them so), and
    windows long reads overlap share the offset of the read reaching them first: a run of equal
    offsets is credited to its last window (the reads after it start there or later; a long read's
    shift is within the margin ``refine`` samples)."""
    out: dict = {}
    last_w, last_v = None, None
    for w, v in enumerate(idx.linear):
        if not v:
            continue
        if last_v is not None and v > last_v:
            out[last_w] = out.get(last_w, 0.0) + file_pos(v, ratio) - file_pos(last_v, ratio)
        last_w, last_v = w, v
    if last_w is not None:
        out[last_w] = out.get(last_w, 0.0) + max(file_pos(idx.end, ratio) - file_pos(last_v, ratio), 1e-3)
    return out


@dataclass
class Survey:
    """Where a dataset's data is, from its indexes."""
    targeted: bool
    reads: int
    dense_share: float            # genome share of the densest windows holding DENSE_DATA_SHARE of the data
    stretches: list               # [(path, contig, tid, lo_window, hi_window)] dense stretches, densest first


def survey(bam_handles: dict, contigs: list) -> Optional[Survey]:
    """``contigs``: [(path, contig, size)] the dataset's reads are on (the loaded reference's).
    None when a file has no local BAI (the caller says so and reads the reads)."""
    per: list = []  # (path, contig, tid, idx, bytes by window)
    genome_windows = 0
    reads = 0
    for path, contig, size in contigs:
        refs = bam_index(path)
        bam = bam_handles.get(path)
        if refs is None or bam is None:
            return None
        try:
            tid = bam.get_tid(contig)
        except Exception:
            tid = -1
        idx = refs[tid] if 0 <= tid < len(refs) else None
        genome_windows += max(1, -(-int(size) // WINDOW_BP))
        if idx is None:
            continue
        reads += int(idx.mapped)
        ratio = block_ratio(path, [v for v in idx.linear if v])
        per.append((path, contig, tid, idx, window_bytes(idx, ratio)))
    if not per:
        return Survey(False, 0, 0.0, [])
    all_bytes = sorted((b for *_x, wb in per for b in wb.values()), reverse=True)
    total = sum(all_bytes) or 1
    acc, n = 0, 0
    for b in all_bytes:
        acc += b
        n += 1
        if acc >= DENSE_DATA_SHARE * total:
            break
    dense_share = n / max(1, genome_windows)
    targeted = dense_share <= TARGETED_GENOME_SHARE
    stretches: list = []
    if targeted:
        floor = all_bytes[0] * COARSE_FLOOR_SHARE
        for path, contig, tid, idx, wb in per:
            dense = sorted(w for w, b in wb.items() if b >= floor)
            run = None
            for w in dense:
                if run is not None and w - run[1] <= MERGE_WINDOWS:
                    run[1] = w
                else:
                    if run is not None:
                        stretches.append((path, contig, tid, run[0], run[1], sum(wb.get(x, 0) for x in range(run[0], run[1] + 1))))
                    run = [w, w]
            if run is not None:
                stretches.append((path, contig, tid, run[0], run[1], sum(wb.get(x, 0) for x in range(run[0], run[1] + 1))))
        stretches.sort(key=lambda s: -s[5])
        stretches = [s[:5] for s in stretches[:MAX_STRETCHES]]
    return Survey(targeted, reads, dense_share, stretches)


def refine(bam, idx: ContigIndex, tid: int, lo_window: int, hi_window: int, ratio: float = 3.0) -> Optional[tuple]:
    """(start, end, peak depth, est. reads) of a dense stretch: its depth profile from one sampled
    record per distinct offset around it, trimmed to EDGE_SHARE of its peak."""
    a = max(0, lo_window - MARGIN_WINDOWS)
    b = min(len(idx.linear) - 1, hi_window + MARGIN_WINDOWS)
    lin = {v for v in idx.linear[a:b + 1] if v}
    if not lin:
        return None
    # The offset after the stretch's reads: the next window with a later offset, else the contig's end.
    after = next((v for v in idx.linear[b + 1:] if v and v > max(lin)), idx.end)
    # More record starts between them: the bounds of the chunks of bins over the stretch (the
    # linear index alone has few distinct offsets where long reads overlap many windows).
    lo_off, lo_bp_s, hi_bp_s = min(lin), a * WINDOW_BP, (b + 1) * WINDOW_BP
    extra = set()
    for bin_id, chunks in idx.chunks:
        bs, be = bin_span(bin_id)
        if be <= lo_bp_s or bs >= hi_bp_s:
            continue
        for cb, ce in chunks:
            for v in (cb, ce):
                if lo_off <= v < after:
                    extra.add(v)
    offsets = sorted(lin | extra)
    if len(offsets) > MAX_SAMPLES:
        step = len(offsets) / MAX_SAMPLES
        offsets = [offsets[int(i * step)] for i in range(MAX_SAMPLES)]
    samples: list = []  # (offset, first start, median length)
    from contextlib import nullcontext
    with bam.lease() if hasattr(bam, "lease") else nullcontext(bam) as reader:
        for voff in offsets:
            try:
                reader.seek(voff)
                got = []
                for k, read in enumerate(reader):
                    if k >= SAMPLE_RECORDS or read.reference_id != tid:
                        break
                    if read.is_unmapped:
                        continue
                    rs = int(read.reference_start)
                    got.append((rs, max(1, int(read.reference_end or rs + 1) - rs)))
            except Exception:
                continue
            if got:
                lengths = sorted(g[1] for g in got)
                samples.append((voff, got[0][0], lengths[len(lengths) // 2]))
    # Reads starting outside the stretch and its margin are another stretch's (an offset the gap's
    # windows carry); they still bound the bytes of the group before them.
    span_lo, span_hi = a * WINDOW_BP, (b + 1) * WINDOW_BP
    bounds = [o for o, _s, _l in samples[1:]] + [after]
    groups = [(o, s0, ln, nxt) for (o, s0, ln), nxt in zip(samples, bounds) if span_lo <= s0 < span_hi]
    if not groups:
        return None
    lo_bp = min(g[1] for g in groups)
    hi_bp = max(g[1] + g[2] for g in groups) + WINDOW_BP + 1
    n_bins = (hi_bp - lo_bp) // PROFILE_BP + 2
    diff = [0.0] * (n_bins + 2)
    bpr = idx.bytes_per_read(ratio)
    est_reads = 0.0
    for i, (voff, s0, length, nxt) in enumerate(groups):
        # Its starts run to the next group's (the last group's: over the window after its read).
        s1 = max(groups[i + 1][1] if i + 1 < len(groups) else s0 + WINDOW_BP, s0 + 1)
        reads = max(1.0, (file_pos(nxt, ratio) - file_pos(voff, ratio)) / bpr)
        est_reads += reads
        per_bp = reads / (s1 - s0)
        # Reads starting uniformly over [s0, s1), each `length` long: depth ramps up over the
        # starts and down over the ends (increments of a running sum, per bin).
        for x0, x1, sign in ((s0, s1, 1.0), (s0 + length, s1 + length, -1.0)):
            for x in range(max(0, (x0 - lo_bp) // PROFILE_BP), min(n_bins, (x1 - lo_bp) // PROFILE_BP + 1)):
                blo, bhi = max(x0, lo_bp + x * PROFILE_BP), min(x1, lo_bp + (x + 1) * PROFILE_BP)
                if bhi > blo:
                    diff[x] += sign * per_bp * (bhi - blo)
    # diff[x] holds the depth gained over bin x; depth at a bin is the running sum.
    depth, accd = [], 0.0
    for x in range(n_bins):
        accd += diff[x]
        depth.append(max(0.0, accd))
    peak = max(depth) if depth else 0.0
    if peak <= 0:
        return None
    # Half the stretch's plateau (a high percentile, not one spiky bin).
    covered = sorted(d for d in depth if d >= peak * 0.05)
    plateau = covered[int(len(covered) * 0.9)] if covered else peak
    edge = plateau * EDGE_SHARE
    first = next(i for i, d in enumerate(depth) if d >= edge)
    last = next(i for i in range(len(depth) - 1, -1, -1) if depth[i] >= edge)
    return (lo_bp + first * PROFILE_BP, lo_bp + (last + 1) * PROFILE_BP, plateau, int(round(est_reads)))
