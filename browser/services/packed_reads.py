"""Lossless, bounded-block storage for completed read cohorts."""
from __future__ import annotations

import pickle
import zlib
from bisect import bisect_right
from collections.abc import Sequence
from collections import OrderedDict
import threading
import numpy as np
from services.background_work import checkpoint
from contextlib import contextmanager
from contextvars import ContextVar

packed_decode = ContextVar('packed_decode', default=False)
decode_partition = ContextVar('decode_partition', default=None)
packed_block_sink = ContextVar('packed_block_sink', default=None)
packed_display = ContextVar('packed_display', default=False)
bounded_analysis = ContextVar('bounded_analysis', default=False)


# Keep 256-row worker messages while decoding selected rows in smaller frames.
_READ_CHUNK_ROWS = 16


def _encode_block(reads):
    return tuple(zlib.compress(pickle.dumps(reads[i:i + _READ_CHUNK_ROWS], protocol=5), 1)
                 for i in range(0, len(reads), _READ_CHUNK_ROWS))


def _iter_block(block):
    for part in block if isinstance(block, tuple) else (block,):
        yield from pickle.loads(zlib.decompress(part))


def _block_bytes(block):
    return (sum(len(part) + 64 for part in block) + 64
            if isinstance(block, tuple) else len(block) + 64)


def read_geometry_groups(read):
    """A compact read's geometry by group: its own intervals, its FIRE calls and each annotation layer's."""
    yield 'intervals', read.get('intervals') or []
    yield 'fire', read.get('fire') or []
    if 'live_lift' in read:
        # A live-lift row's body segments and badges (services/lift/reads.geometry_intervals).
        from services.lift.reads import geometry_intervals
        yield 'live_lift', geometry_intervals(read)
    for name, layer in (read.get('layers') or {}).items():
        yield name, (layer.get('intervals') or []) if isinstance(layer, dict) else []


def compact_read_bounds(read, viewport_start=None, viewport_end=None, include=None):
    """Extent of the stored geometry, including layer-only molecules.

    ``include`` (group name -> bool, see read_geometry_groups): only the groups a request shows count. A broad
    load cached for more layers (FIRE, MSPs) is reused for fewer; its reads must not be longer there than in a
    load of just those layers, or the display picks another sample of the same view (3.0.0 audit LOW-2).
    """
    lo = hi = None
    groups = [intervals for name, intervals in read_geometry_groups(read) if include is None or include(name)]
    for group in groups:
        for interval in group:
            if len(interval) < 2:
                continue
            start, end = int(interval[0]), int(interval[1])
            if viewport_start is not None and (end <= viewport_start or start >= viewport_end):
                continue
            if lo is None or start < lo:
                lo = start
            if hi is None or end > hi:
                hi = end
    return None if lo is None else (lo, hi)


def _merge_sorted(intervals):
    merged = []
    for start, end in intervals:
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return merged


def _read_bounds_array(reads):
    # An empty row never overlaps, including windows with negative offsets.
    empty = (np.iinfo(np.int64).max, np.iinfo(np.int64).min)
    bounds = []
    for index, read in enumerate(reads):
        if not index & 255:
            checkpoint()
        bounds.append(compact_read_bounds(read) or empty)
    return np.asarray(bounds, dtype=np.int64).reshape(-1, 2)


@contextmanager
def bounded_read_analysis():
    """Keep decoded evidence in blocks throughout an uncapped analysis load."""
    mode = bounded_analysis.set(True)
    decode = packed_decode.set(True)
    try:
        yield
    finally:
        packed_decode.reset(decode)
        bounded_analysis.reset(mode)


class PackedReads(Sequence):
    """Keep evidence in compressed blocks; expand only blocks being visited.

    These bytes are made and consumed inside the process, never from a file or
    a request. All metadata and numeric precision survive cache round trips.
    """
    block_size = 256
    selection_bytes = 64 * 1024 ** 2

    def __init__(self, reads, *, display_index=True):
        self._length = len(reads)
        # Index while these dictionaries are already decoded. A pan must not
        # decompress the entire neighborhood to discover its overlapping rows.
        self._display_index = ReadDisplayIndex(reads) if display_index else None
        self._bounds = self._display_index.bounds if display_index else _read_bounds_array(reads)
        self._read_ids = None if display_index else tuple(str(r.get("id", "")) for r in reads)
        blocks = []
        for i in range(0, len(reads), self.block_size):
            checkpoint()
            blocks.append(_encode_block(reads[i:i + self.block_size]))
        self._blocks = tuple(blocks)
        self._lock = threading.RLock()
        self._decoded = OrderedDict()
        from services.byte_cache import ByteCache, retained_size
        self._selection_budget = min(self.selection_bytes, retained_size(reads) // 8) if display_index else 0
        self._selected = ByteCache(self._selection_budget)
        self.retained_bytes = sum(_block_bytes(block) for block in self._blocks) + self._bounds.nbytes + 256
        from services.byte_cache import retained_size
        self.retained_bytes += max((retained_size(reads[i:i + self.block_size])
                                   for i in range(0, len(reads), self.block_size)), default=0)
        if self._display_index is not None:
            self.retained_bytes += self._display_index.retained_bytes
        self.retained_bytes += self._selection_budget + retained_size(self._read_ids)
        # Sampled loads also carry the extents of unparsed alignments.
        for name in ('sample_level', 'sampling_estimated', 'skipped_starts', 'skipped_ends', 'kept_starts', 'kept_ends'):
            if hasattr(reads, name):
                value = getattr(reads, name)
                setattr(self, name, value)
                self.retained_bytes += getattr(value, 'nbytes', 32)

    def __len__(self):
        return self._length

    @classmethod
    def from_display_blocks(cls, parts):
        """Retain complete, ordered worker blocks without expanding their reads.

        File boundaries can leave short blocks, so offsets are explicit. The
        display index and expansion reserve were built beside the decoded rows
        in the worker, before those rows were released.
        """
        blocks, ends, indexes = [], [], []
        total = expanded = reserve = 0
        for block, index, size in parts:
            checkpoint()
            total += len(index.bounds)
            ends.append(total)
            blocks.append(block)
            indexes.append(index)
            expanded += size
            reserve = max(reserve, size)
        index = ReadDisplayIndex.combine(indexes)
        budget = min(cls.selection_bytes, expanded // 8)
        offsets = np.asarray(ends, dtype=np.int64)
        result = cls.__new__(cls)
        result.__setstate__({'_blocks': tuple(blocks), '_block_ends': offsets,
            '_length': total, '_display_index': index, '_bounds': index.bounds,
            '_selection_budget': budget,
            'retained_bytes': sum(_block_bytes(block) for block in blocks) + offsets.nbytes
                + index.bounds.nbytes + index.retained_bytes + reserve + budget + 256})
        return result

    def _block_offset(self, index):
        ends = getattr(self, '_block_ends', None)
        if ends is None:
            return divmod(index, self.block_size)
        block = bisect_right(ends, index)
        return block, index - (int(ends[block - 1]) if block else 0)

    def __getstate__(self):
        return {k: v for k, v in vars(self).items() if k not in ('_lock', '_decoded', '_selected')}

    def __setstate__(self, state):
        vars(self).update(state)
        self._lock = threading.RLock()
        self._decoded = OrderedDict()
        from services.byte_cache import ByteCache
        self._selected = ByteCache(getattr(self, '_selection_budget', 0))

    def __iter__(self):
        for block in self._blocks:
            checkpoint()
            yield from _iter_block(block)

    def read_ids(self):
        index = getattr(self, '_display_index', None)
        if index is not None:
            return (str(row.get('analysis_id') or row.get('id', '')) for row in index.metadata)
        ids = getattr(self, '_read_ids', None)
        # Legacy in-process objects without metadata still remain readable.
        return iter(ids) if ids is not None else (str(r.get('analysis_id') or r.get('id', '')) for r in self)

    def selected(self, ids, *, aliases=False):
        """Expand selected frames only, keeping every physical duplicate in order."""
        from services.read_selection import read_matches_id_filter
        wanted = set(ids)
        indices = []
        for i, name in enumerate(self.read_ids()):
            if not i & 255:
                checkpoint()
            if read_matches_id_filter(name, wanted) if aliases else name in wanted:
                indices.append(i)
        return self.take(indices).values()

    def overlapping(self, start, end):
        """Decode only intersecting blocks, preserving original molecule order."""
        bounds = getattr(self, '_bounds', None)
        if bounds is None:
            # Compatibility with an older in-process packed cohort.
            with self._lock:
                if getattr(self, '_bounds', None) is None:
                    self._bounds = _read_bounds_array(self)
                    self.retained_bytes += self._bounds.nbytes
                bounds = self._bounds
        indices = np.flatnonzero((bounds[:, 0] < end) & (bounds[:, 1] > start))
        block_index, block = -1, None
        for index in indices:
            index = int(index)
            next_block, offset = self._block_offset(index)
            if next_block != block_index:
                checkpoint()
                block_index = next_block
                block = self._get_block(block_index)
            yield index, block[offset], int(bounds[index, 0]), int(bounds[index, 1])

    def _get_block(self, block_index):
        with self._lock:
            block = self._decoded.get(block_index)
            if block is None:
                block = list(_iter_block(self._blocks[block_index]))
                self._decoded.clear()
                self._decoded[block_index] = block
            return block

    def _get_chunk(self, block_index, offset):
        encoded = self._blocks[block_index]
        if not isinstance(encoded, tuple):
            return self._get_block(block_index), offset
        chunk_index, inner = divmod(offset, _READ_CHUNK_ROWS)
        key = (block_index, chunk_index)
        checkpoint()
        with self._lock:
            if block_index in self._decoded:
                return self._decoded[block_index], offset
            chunk = self._decoded.get(key)
            if chunk is None:
                chunk = pickle.loads(zlib.decompress(encoded[chunk_index]))
                self._decoded.clear()
                self._decoded[key] = chunk
            return chunk, inner

    def take(self, indices):
        """Expand only frames containing selected rows and retain those rows."""
        result = {}
        for index in sorted(set(indices)):
            retained = self._selected.get(index)
            if retained is not None:
                self._selected.move_to_end(index)
                result[index] = retained
                continue
            block_index, offset = self._block_offset(index)
            chunk, inner = self._get_chunk(block_index, offset)
            result[index] = chunk[inner]
            self._selected[index] = chunk[inner]
        return result

    def __getitem__(self, index):
        if isinstance(index, slice):
            return [self[i] for i in range(*index.indices(self._length))]
        if index < 0:
            index += self._length
        if not 0 <= index < self._length:
            raise IndexError(index)
        block_index, offset = self._block_offset(index)
        chunk, inner = self._get_chunk(block_index, offset)
        return chunk[inner]


def pack_reads(reads, *, display_index=True):
    """Small samples stay as objects; deep completed cohorts use compact blocks."""
    if isinstance(reads, PackedReads) or len(reads) < 4096:
        return reads
    return PackedReads(reads, display_index=display_index)


class ReadDisplayIndex:
    """Retain visible extents and SV evidence without expanding annotation blocks.

    Disjoint extents stay disjoint: a deletion or a distant annotation must not
    create a row in an empty view. Merging touching intervals preserves clipped
    coverage and spanning, the only geometry used to choose display rows.
    """
    def __init__(self, reads):
        segments, bounds, metadata, group_segments = [], [], [], []
        group_names: dict[str, int] = {}
        empty = (np.iinfo(np.int64).max, np.iinfo(np.int64).min)
        for index, read in enumerate(reads):
            if not index & 255:
                checkpoint()
            intervals = []
            for name, group in read_geometry_groups(read):
                own = sorted((int(iv[0]), int(iv[1])) for iv in group if len(iv) >= 2 and iv[1] > iv[0])
                if not own:
                    continue
                gid = group_names.setdefault(name, len(group_names))
                group_segments.extend((index, start, end, gid) for start, end in _merge_sorted(own))
                intervals.extend(own)
            merged = _merge_sorted(sorted(intervals))
            segments.extend((index, start, end) for start, end in merged)
            bounds.append((merged[0][0], merged[-1][1]) if merged else empty)
            metadata.append({key: read[key] for key in
                ('id', 'analysis_id', 'live_lift', 'reference_start', 'reference_end', 'alignment_spans', 'sv') if key in read})
        self.segments = np.asarray(segments, dtype=np.int64).reshape(-1, 3)
        # The same geometry per group (merged within it), for a request showing only some (see overlapping).
        self.group_segments = np.asarray(group_segments, dtype=np.int64).reshape(-1, 4)
        self.group_names = group_names
        self.bounds = np.asarray(bounds, dtype=np.int64).reshape(-1, 2)
        self.metadata = metadata
        from services.byte_cache import retained_size
        self.retained_bytes = self.segments.nbytes + self.group_segments.nbytes + retained_size(metadata) + 256

    @classmethod
    def combine(cls, indexes):
        result = cls.__new__(cls)
        segments, bounds, metadata, group_segments = [], [], [], []
        group_names: dict[str, int] = {}
        grouped = all(getattr(index, 'group_names', None) is not None for index in indexes)
        offset = 0
        for index in indexes:
            checkpoint()
            shifted = index.segments.copy()
            shifted[:, 0] += offset
            segments.append(shifted)
            if grouped:
                part = index.group_segments.copy()
                part[:, 0] += offset
                if len(part):
                    remap = np.zeros(max(index.group_names.values()) + 1, dtype=np.int64)
                    for name, gid in index.group_names.items():
                        remap[gid] = group_names.setdefault(name, len(group_names))
                    part[:, 3] = remap[part[:, 3]]
                group_segments.append(part)
            bounds.append(index.bounds)
            metadata.extend(index.metadata)
            offset += len(index.bounds)
        result.segments = np.concatenate(segments) if segments else np.empty((0, 3), dtype=np.int64)
        result.group_segments = (np.concatenate(group_segments) if group_segments else np.empty((0, 4), dtype=np.int64)) \
            if grouped else None
        result.group_names = group_names if grouped else None
        result.bounds = np.concatenate(bounds) if bounds else np.empty((0, 2), dtype=np.int64)
        result.metadata = metadata
        from services.byte_cache import retained_size
        result.retained_bytes = result.segments.nbytes + retained_size(metadata) + 256 + (
            result.group_segments.nbytes if grouped else 0)
        return result

    def _segments_for(self, include):
        """The merged segments of the groups ``include`` admits (all groups: the stored merge)."""
        names = getattr(self, 'group_names', None)
        if include is None or names is None:
            return self.segments
        allowed = [gid for name, gid in names.items() if include(name)]
        if len(allowed) == len(names):
            return self.segments
        rows = self.group_segments[np.isin(self.group_segments[:, 3], allowed)]
        if not len(rows):
            return np.empty((0, 3), dtype=np.int64)
        rows = rows[np.lexsort((rows[:, 1], rows[:, 0]))]
        owner, starts, ends = rows[:, 0], rows[:, 1], rows[:, 2]
        # Merge touching intervals within each read, as the stored merge does: a run continues while its next start
        # is at most the run's furthest end (each read's coordinates shifted apart so runs never cross reads).
        shift = owner << 34
        reach = np.maximum.accumulate(ends + shift)
        new_run = np.ones(len(rows), dtype=bool)
        new_run[1:] = (starts[1:] + shift[1:]) > reach[:-1]
        first = np.flatnonzero(new_run)
        return np.stack([owner[first], starts[first], np.maximum.reduceat(ends, first)], axis=1)

    def overlapping(self, start, end, include=None):
        """Reads with geometry in [start, end), with that geometry's extent (``include``: the groups that count)."""
        segments = self._segments_for(include)
        selected = segments[(segments[:, 1] < end) & (segments[:, 2] > start)]
        if not len(selected):
            return
        owners, first = np.unique(selected[:, 0], return_index=True)
        starts = np.minimum.reduceat(selected[:, 1], first)
        ends = np.maximum.reduceat(selected[:, 2], first)
        for index, left, right in zip(owners, starts, ends):
            index = int(index)
            yield index, self.metadata[index], int(left), int(right)


class PackedReadBuilder:
    """Decode a batch, pack it, and release its Python read dictionaries."""
    def __init__(self):
        self.blocks = []
        self.pending = []
        self.count = 0
        self.expanded_reserve = 0
        self.bounds = []
        self.read_ids = []

    def append(self, read):
        self.pending.append(read)
        self.count += 1
        if len(self.pending) == PackedReads.block_size:
            self.flush()

    def __len__(self):
        return self.count

    def flush(self):
        if self.pending:
            self.read_ids.extend(str(r.get("id", "")) for r in self.pending)
            display = packed_display.get()
            if display:
                # Whole-file blocks already arrive in physical record order.
                # The hash-partitioned analysis path still keeps its sort key.
                for read in self.pending:
                    read.pop('_fiberbrowser_source_order', None)
                index = ReadDisplayIndex(self.pending)
                self.bounds.append(index.bounds)
            else:
                self.bounds.append(_read_bounds_array(self.pending))
            from services.byte_cache import retained_size
            size = retained_size(self.pending)
            self.expanded_reserve = max(self.expanded_reserve, size)
            block = _encode_block(self.pending)
            sink = packed_block_sink.get()
            if sink is not None:
                sink((block, index, size) if display else block)
            else:
                self.blocks.append(block)
            self.pending.clear()

    def finish(self):
        self.flush()
        result = PackedReads.__new__(PackedReads)
        bounds = np.concatenate(self.bounds) if self.bounds else np.empty((0, 2), dtype=np.int64)
        from services.byte_cache import retained_size
        ids = tuple(self.read_ids)
        result.__setstate__({'_blocks': tuple(self.blocks), '_length': self.count, '_read_ids': ids,
                            '_bounds': bounds,
                            'retained_bytes': sum(_block_bytes(b) for b in self.blocks) + bounds.nbytes + retained_size(ids) + self.expanded_reserve + 256})
        return result


def select_read_ids(reads, ids, *, aliases=False):
    if ids is None:
        return reads
    if isinstance(reads, PackedReads):
        return reads.selected(ids, aliases=aliases)
    from services.read_selection import read_matches_id_filter, read_id_keys
    wanted = set(ids)
    return (r for r in reads if (read_matches_id_filter(r, wanted)
                                if aliases else bool(read_id_keys(r) & wanted)))
