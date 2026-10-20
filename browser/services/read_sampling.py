"""A manageable read display working set for deep or wide BAM views.

A deep BAM (a targeted PacBio m6A library: ~24,000 reads per 150 kb) has
thousands of reads in a 100 kb view, and the display load used to parse every
one of them (footprint tags, marks, a fingerprint per record) although only
~800 are drawn. Here the display load keeps a stable, deterministic sample:

- **Before parsing.** A record is kept or skipped on its name alone (a hash),
  before any tag is parsed; a skipped record costs its decompression only.
  Its alignment extent is remembered, so "N of M reads" is exact.
- **Stable.** A read is kept at level ``L`` when its name hash falls below
  ``2**-L``. Levels are nested: zooming in (a lower level) only adds reads,
  zooming out only removes them, and panning at one zoom keeps or drops the
  same reads, so layout and clustering stay consistent.
- **Sized from the index.** The level comes from the reads expected in the
  view, read off the BAM index (the BAI linear index: file bytes per 16 kb
  window), against a target of ~4,000 reads (``FIBERBROWSER_WORKING_READS_TARGET``,
  0 turns sampling off), growing slowly with the window.

Only the read display samples. Analyses that build their own working set
(``state.build_working_set``) get every read, unless the reads they are asked
about (``read_ids``, the reads the panel shows) are all in the display sample.
"""
from __future__ import annotations

import hashlib
import math
import os
import struct
import threading
from contextvars import ContextVar

decode_read_scope = ContextVar('decode_read_scope', default=None)
prefetch_sample_level = ContextVar('prefetch_sample_level', default=None)
from collections import OrderedDict
from contextlib import contextmanager
from typing import Optional

import numpy as np

DEFAULT_TARGET = 4000
MAX_LEVEL = 8
_BAI_WINDOW = 1 << 14
_LOOKAHEAD_WINDOWS = 2


def target_reads(width: int, state=None) -> int:
    """Reads a view of ``width`` bp may hold before the display samples (0: never)."""
    try:
        base = int(os.environ.get("FIBERBROWSER_WORKING_READS_TARGET", DEFAULT_TARGET))
    except ValueError:
        base = DEFAULT_TARGET
    config = getattr(state, 'performance', {})
    if config and (config.get('effective') == 'low' or 'FIBERBROWSER_WORKING_READS_TARGET' not in os.environ):
        base = config['sample_target']
    if base <= 0:
        return 0
    # Wider windows hold a few more (up to twice the target at 200 kb and beyond).
    return int(min(2 * base, max(base, base * math.sqrt(max(1, width) / 50_000))))


def name_hash(name: str) -> int:
    """A stable 64-bit hash of a read name (the same in every process and run)."""
    return int.from_bytes(hashlib.blake2b(name.encode("utf-8", "surrogateescape"), digest_size=8).digest(), "little")


def keeps(name: str, level: int) -> bool:
    """Whether a read is in the sample at ``level`` (always at level 0)."""
    return level <= 0 or name_hash(name) < (1 << 64) >> int(level)


def fraction(level: int) -> float:
    return 1.0 / (1 << max(0, int(level)))


class Sampler:
    """One load's sampling: which records to parse, and the extents of those skipped."""

    __slots__ = ("level", "threshold", "skipped_starts", "skipped_ends", "kept_starts", "kept_ends", "keep_ids", "only_ids", "raw_aliases", "max_records", "exact_ids")

    def __init__(self, level: int, keep_ids=None, only_ids=None, raw_aliases=(), max_records=None, exact_ids=False):
        self.level = int(level)
        self.threshold = (1 << 64) >> self.level
        self.skipped_starts: list[int] = []
        self.skipped_ends: list[int] = []
        # The kept records' alignment extents too: "N of M" counts both on the
        # same footing (alignments in view, before the read filters).
        self.kept_starts: list[int] = []
        self.kept_ends: list[int] = []
        self.keep_ids = frozenset(keep_ids or ())
        self.only_ids = only_ids
        self.raw_aliases = raw_aliases
        self.max_records = max_records
        self.exact_ids = exact_ids

    def keep(self, name: str) -> bool:
        if self.only_ids is not None:
            if self.exact_ids:
                return name in self.only_ids
            from services.read_selection import base_read_id
            return (self.max_records is None or len(self.kept_starts) < self.max_records) and (
                name in self.only_ids or name in self.raw_aliases or base_read_id(name) in self.only_ids)
        return self.level <= 0 or name in self.keep_ids or name_hash(name) < self.threshold

    def skip(self, start: int, end: int) -> None:
        self.skipped_starts.append(int(start))
        self.skipped_ends.append(int(end))

    def kept(self, start: int, end: int) -> None:
        self.kept_starts.append(int(start))
        self.kept_ends.append(int(end))


_local = threading.local()


def active_sampler() -> Optional[Sampler]:
    """The sampler of the load running on this thread (None: parse every record)."""
    return getattr(_local, "sampler", None)


@contextmanager
def sampling(sampler: Optional[Sampler]):
    previous = active_sampler()
    _local.sampler = sampler
    try:
        yield sampler
    finally:
        _local.sampler = previous


class SampledReads(list):
    """A broad load's kept reads, with the extents of the records it skipped."""

    def __init__(self, reads=(), *, level: int = 0, skipped_starts=None, skipped_ends=None,
                 kept_starts=None, kept_ends=None, estimated: bool = False):
        super().__init__(reads)
        self.sample_level = int(level)
        self.sampling_estimated = bool(estimated)
        as_array = lambda v: np.asarray(v if v is not None else [], dtype=np.int64)  # noqa: E731
        self.skipped_starts = as_array(skipped_starts)
        self.skipped_ends = as_array(skipped_ends)
        self.kept_starts = as_array(kept_starts)
        self.kept_ends = as_array(kept_ends)


def _overlapping(starts, ends, start: int, end: int, spanning: bool = False) -> int:
    if starts is None or ends is None or not len(starts):
        return 0
    if spanning:
        return int(((starts <= start) & (ends >= end)).sum())
    return int(((starts < end) & (ends > start)).sum())


def skipped_overlapping(reads, start: int, end: int, spanning: bool = False) -> int:
    """Records a sampled load skipped that overlap (or, ``spanning``, span) ``[start, end)``."""
    return _overlapping(getattr(reads, "skipped_starts", None), getattr(reads, "skipped_ends", None), start, end, spanning)


def sampling_info(reads, start: int, end: int, kept_overlapping: int, kept_spanning: int) -> Optional[dict]:
    """For a sampled load: ``kept`` of ``total`` primary alignments in view (both counted
    on their alignment extents, before the read filters: exact), and ``loaded``, the
    sampled reads in view after the filters (what the panel counts). None otherwise."""
    level = int(getattr(reads, "sample_level", 0) or 0)
    if level <= 0:
        return None
    k_starts, k_ends = getattr(reads, "kept_starts", None), getattr(reads, "kept_ends", None)
    kept = _overlapping(k_starts, k_ends, start, end)
    kept_span = _overlapping(k_starts, k_ends, start, end, spanning=True)
    info = {
        "level": level,
        "fraction": fraction(level),
        "kept": kept,
        "total": kept + skipped_overlapping(reads, start, end),
        "kept_spanning": kept_span,
        "total_spanning": kept_span + skipped_overlapping(reads, start, end, spanning=True),
        "loaded": int(kept_overlapping),
        "loaded_spanning": int(kept_spanning),
    }
    if getattr(reads, "sampling_estimated", False):
        # Target extents are counted before composing bodies and resolving
        # primary haplotypes, so the target row counts are estimates.
        info["estimated"] = True
    return info


def merge_sampling_info(parts) -> Optional[dict]:
    """One view's sampling from its parts (a circular view's two segments)."""
    parts = [p for p in parts or () if p]
    if not parts:
        return None
    out = {"level": max(p["level"] for p in parts)}
    out["fraction"] = fraction(out["level"])
    for k in ("kept", "total", "kept_spanning", "total_spanning", "loaded", "loaded_spanning"):
        out[k] = sum(int(p.get(k, 0)) for p in parts)
    return out


# ---------------------------------------------------------------------------
# Reads in a window, from the BAM index


from services.byte_cache import shared_cache
_bai_cache = shared_cache('indexes')
_bai_lock = threading.Lock()


def _bai_path(bam_path: str) -> Optional[str]:
    for candidate in (bam_path + ".bai", os.path.splitext(bam_path)[0] + ".bai"):
        if os.path.isfile(candidate):
            return candidate
    return None


def _parse_bai(path: str) -> list:
    """Per reference: (linear index compressed offsets, first byte, last byte, mapped reads)."""
    with open(path, "rb") as fh:
        data = fh.read()
    if data[:4] != b"BAI\x01":
        raise ValueError("not a BAI index")
    pos = 4
    (n_ref,) = struct.unpack_from("<i", data, pos)
    pos += 4
    refs = []
    for _ in range(n_ref):
        (n_bin,) = struct.unpack_from("<i", data, pos)
        pos += 4
        meta = None
        for _ in range(n_bin):
            bin_id, n_chunk = struct.unpack_from("<Ii", data, pos)
            pos += 8
            if bin_id == 37450 and n_chunk == 2:
                beg, end_, mapped, _unmapped = struct.unpack_from("<QQQQ", data, pos)
                meta = (beg >> 16, end_ >> 16, mapped)
            pos += 16 * n_chunk
        (n_intv,) = struct.unpack_from("<i", data, pos)
        pos += 4
        offsets = np.frombuffer(data, dtype="<u8", count=n_intv, offset=pos) >> 16
        pos += 8 * n_intv
        refs.append((np.array(offsets, dtype=np.int64), meta))
    return refs


def _bai_refs(bam_path: str) -> Optional[list]:
    path = _bai_path(bam_path)
    if path is None:
        return None
    try:
        st = os.stat(path)
    except OSError:
        return None
    key = (path, st.st_mtime_ns, st.st_size)
    with _bai_lock:
        hit = _bai_cache.get(key)
    if hit is not None:
        return hit
    try:
        refs = _parse_bai(path)
    except (OSError, ValueError, struct.error):
        refs = []
    with _bai_lock:
        _bai_cache[key] = refs
    return refs


def estimate_reads(bam_path: str, chrom: str, start: int, end: int, *, bam_handle_getter=None,
                   chrom_map=None, contig_links=None) -> Optional[float]:
    """Reads expected to overlap ``[start, end)``, from the BAM index; None when unknown."""
    if "://" in str(bam_path):
        return None
    try:
        if bam_handle_getter is None:
            from services.bam_handles import get_bam_handle as bam_handle_getter
        bam = bam_handle_getter(bam_path)
        if bam is None:
            return None
        from utils.chrom import resolve_reference_name
        actual = resolve_reference_name(chrom, bam.references, chrom_map or {}, links=contig_links)
        if actual is None:
            return 0.0
        tid = bam.get_tid(actual)
    except Exception:  # noqa: BLE001 - no estimate, no sampling
        return None
    refs = _bai_refs(str(bam_path))
    if not refs or tid < 0 or tid >= len(refs):
        return None
    offsets, meta = refs[tid]
    if meta is None or not len(offsets):
        return 0.0 if meta is None or meta[2] == 0 else None
    first_byte, last_byte, mapped = meta
    if mapped <= 0 or last_byte <= first_byte:
        return 0.0
    bytes_per_read = (last_byte - first_byte) / mapped
    w0 = max(0, int(start)) // _BAI_WINDOW
    # The linear index gives the first record overlapping each 16 kb window; a
    # record starting in the view but ending past it sits after the first one
    # overlapping the next window, so look two windows on (long reads, ~32 kb).
    w1 = max(0, int(end) - 1) // _BAI_WINDOW + 1 + _LOOKAHEAD_WINDOWS
    if w0 >= len(offsets):
        return 0.0
    lo = int(offsets[w0]) if offsets[w0] else first_byte
    hi = int(offsets[w1]) if w1 < len(offsets) and offsets[w1] else last_byte
    return max(0.0, (hi - lo) / bytes_per_read)


_LIFTED_ESTIMATES: "OrderedDict[tuple, Optional[float]]" = OrderedDict()
_LIFTED_ESTIMATES_MAX = 4096


def clear_lifted_estimates() -> None:
    with _bai_lock:
        _LIFTED_ESTIMATES.clear()


def _index_signature(path: str) -> Optional[tuple]:
    index = _bai_path(path)
    if index is None:
        return None
    try:
        st = os.stat(index)
    except OSError:
        return None
    return index, st.st_mtime_ns, st.st_size


def estimate_dataset_reads(state, dataset, chrom: str, start: int, end: int) -> Optional[float]:
    """Reads of a BAM dataset expected in ``[start, end)`` (None: unknown)."""
    if getattr(dataset, "data_type", None) == "bam_livelift":
        from services.lift.live_lift import LiftRefused, select_pieces, plan_fetch, estimate_lifted_reads
        config = dataset.live_lift
        if chrom not in config.handle.map.targets:
            return 0.0
        # A lifted estimate selects pieces and plans a fetch: the display's
        # sample level asks for a dozen of them on every request. It depends
        # only on the lift identity, the files' indexes and the range.
        key = (config.key(), tuple(map(str, dataset.paths)), tuple(_index_signature(str(p)) for p in dataset.paths),
               chrom, int(start), int(end))
        with _bai_lock:
            if key in _LIFTED_ESTIMATES:
                _LIFTED_ESTIMATES.move_to_end(key)
                return _LIFTED_ESTIMATES[key]
        try:
            selection = select_pieces(config.handle, chrom, start, end, haplotypes=config.haplotypes,
                                      settings=config.settings, key=config.key())
            value = estimate_lifted_reads(dataset.paths, plan_fetch(selection, config.settings, fetch_range=(start, end)))
        except LiftRefused:
            value = None
        with _bai_lock:
            _LIFTED_ESTIMATES[key] = value
            while len(_LIFTED_ESTIMATES) > _LIFTED_ESTIMATES_MAX:
                _LIFTED_ESTIMATES.popitem(last=False)
        return value
    if dataset is None or getattr(dataset, "data_type", None) != "bam":
        return None
    total = 0.0
    from services.plasmid_reconcile import contig_links
    for path in getattr(dataset, "paths", None) or ():
        try:
            links = contig_links(state, path=path)
        except Exception:  # noqa: BLE001
            links = None
        n = estimate_reads(path, chrom, start, end, chrom_map=getattr(state, "chrom_map", None), contig_links=links)
        if n is None:
            return None
        total += n
    return total


def level_block(start: int, end: int) -> tuple[int, int]:
    """The grid block a view's level is read from: a power of two at least four
    views wide, holding the view's centre. Every pan inside it gets the same
    level (the same reads, and the same cached load); only crossing into the
    next block can change it."""
    width = max(1, int(end) - int(start))
    block = 1 << max(14, (4 * width - 1).bit_length())
    centre = (int(start) + int(end)) // 2
    lo = (centre // block) * block
    return lo, lo + block


def sample_level(state, dataset, chrom: str, start: int, end: int) -> int:
    """The display sample level for this view of a BAM dataset (0: every read):
    the reads a view of this width holds at the depth of its block."""
    level = prefetch_sample_level.get()
    if level is not None:
        return level
    width = max(1, int(end) - int(start))
    target = target_reads(width, state)
    if target <= 0:
        return 0
    lo, hi = level_block(start, end)
    in_block = estimate_dataset_reads(state, dataset, chrom, lo, hi)
    if in_block is None:
        if getattr(state, 'performance', {}).get('effective') == 'low' and getattr(dataset, 'data_type', None) == 'bam':
            # CSI/remote indexes lack the BAI estimate. Count alignments in C
            # before decoding tags, so a missing estimate cannot defeat Low.
            from services.bam_handles import get_bam_handle
            from utils.chrom import resolve_reference_name
            total = 0
            for path in dataset.paths:
                bam = get_bam_handle(path)
                actual = resolve_reference_name(chrom, bam.references, getattr(state, 'chrom_map', None))
                if actual is not None:
                    total += bam.count(actual, start, end, read_callback='nofilter')
            return max(0, int(math.ceil(math.log2(max(1, total) / target))))
        return 0  # unknown depth: never sample blind
    # The block's busiest view: its reads over the view's share of the block,
    # read off the densest view-wide stretch (targeted libraries are lumpy).
    total = max(in_block * width / (hi - lo),
                max((estimate_dataset_reads(state, dataset, chrom, a, a + width) or 0.0)
                    for a in range(lo, hi, max(1, width // 2))))
    if total <= target:
        return 0
    ceiling = 24 if getattr(state, 'performance', {}).get('effective') == 'low' else MAX_LEVEL
    return min(ceiling, int(math.ceil(math.log2(total / target))))


MIN_PREFETCH = 3


def bounded_prefetch(state, dataset, chrom: str, start: int, end: int, multiplier: int, level: int) -> int:
    """The prefetch multiplier for a deep view: the configured one, halved (down to
    ``MIN_PREFETCH``: a view on each side) while the reads it would parse exceed
    twice the target. A 100 kb view of a deep library at 10x parsed a whole
    1 Mb of reads before it drew any."""
    width = int(end) - int(start)
    target = target_reads(width, state)
    multiplier = max(1, int(multiplier))
    if target <= 0 or multiplier <= MIN_PREFETCH:
        return multiplier
    budget = 2 * target
    while multiplier > MIN_PREFETCH:
        broad = width * multiplier
        lo = max(0, int(start) - (broad - width) // 2)
        est = estimate_dataset_reads(state, dataset, chrom, lo, lo + broad)
        if est is None or est * fraction(level) <= budget:
            break
        multiplier = max(MIN_PREFETCH, multiplier // 2)
    return multiplier
