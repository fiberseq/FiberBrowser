"""Vectorized helpers for footprint analysis read-heavy calculations."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Callable, Iterable, Optional, Sequence

import numpy as np

from services.read_metrics import sample_stable_by_id


IntervalGetter = Callable[[dict], Iterable[Sequence[int]]]
FamilyMetadataGetter = Callable[[dict], Sequence[tuple[int, int, int]]]
NON_FP_LAYERS = frozenset({
    "msp", "fire", "m6a", "mod", "m5c", "deam",
    "ddda_mcg", "ddda_mcg_hemi",
})


def _unclipped_intervals(layer_data: dict) -> list:
    """A layer's calls at their source bounds (not clipped to the view), aligned
    with its interval metadata; the same bounds a single-layer lookup uses."""
    return layer_data.get("source_intervals") or layer_data.get("intervals") or []


@dataclass(frozen=True)
class IntervalTable:
    """Flattened positive-size intervals for one working set."""

    starts: np.ndarray
    ends: np.ndarray
    sizes: np.ndarray
    read_indices: np.ndarray
    read_ids: list[str]
    n_reads: int
    family_ids: np.ndarray
    family_confidences: np.ndarray
    # 0 = absent/unknown, 1 = ordinary assignment confidence,
    # 2 = named fhlt producer-declared latent support (not assignment confidence).
    family_confidence_kinds: np.ndarray
    family_names: np.ndarray | None = None
    family_layers: np.ndarray | None = None
    # The absolute reference spans the reads' alignments cover, [start, end), flattened: span i belongs to read
    # span_read_indices[i]. A read origin-spanning on a circular contig has several (its head and wrapped tail).
    span_starts: np.ndarray | None = None
    span_ends: np.ndarray | None = None
    span_read_indices: np.ndarray | None = None
    # Per read (in read order): whether its spans are known; a read with unknown extent is eligible everywhere.
    extent_known: np.ndarray | None = None

    @property
    def empty(self) -> bool:
        return self.sizes.size == 0

    @property
    def centers(self) -> np.ndarray:
        return (self.starts + self.ends) // 2

    def ids_for_read_indices(self, indices: Iterable[int]) -> set[str]:
        return {self.read_ids[int(i)] for i in indices}

    def shared_name_indices(self) -> dict[str, list[int]]:
        """Names carried by more than one read (distinct alignments, e.g. the
        same QNAME in two merged BAMs), with the reads carrying each."""
        by_name: dict[str, list[int]] = {}
        for index, read_id in enumerate(self.read_ids):
            by_name.setdefault(read_id, []).append(index)
        return {name: indices for name, indices in by_name.items() if len(indices) > 1}


@dataclass
class FootprintLayerResolver:
    """Resolve which interval collection footprint analysis should inspect."""

    target_layer: Optional[str] = None
    selected_layers: tuple[str, ...] = ()
    non_fp_layers: frozenset[str] = NON_FP_LAYERS
    asked: int = 0
    found: int = 0

    @property
    def primary_table_key(self) -> tuple[str, str]:
        return ("footprint_analysis", "family_layers:"+",".join(self.selected_layers) if self.selected_layers else self.target_layer or "_primary")

    def _annotation_rows(self, read):
        if self.selected_layers:
            # Per layer through its own resolver, like intervals() (an 'all_fp'
            # selection is the union of the footprint layers, not a layer).
            return [row for name in self.selected_layers for row in FootprintLayerResolver(name)._annotation_rows(read)]
        layers = read.get('layers') or {}
        if self.target_layer == 'all_fp' and not self.selected_layers:
            # Use the same last family-bearing observation as family_metadata.
            rows = {}
            for name, layer in layers.items():
                if name in self.non_fp_layers: continue
                metadata = self._layer_family_metadata(layer or {})
                names = (layer or {}).get('annotation_names') or []
                for i, iv in enumerate(_unclipped_intervals(layer or {})):
                    if len(iv) < 3: continue
                    key = tuple(iv[:3])
                    if key not in rows or metadata[i][0] > 0:
                        rows[key] = (names[i] if i < len(names) else '', name)
            return list(rows.values())
        rows = []
        for name in self.selected_layers or (self.target_layer,):
            layer = layers.get(name) or {}
            if not layer and name in ('fire', 'msp'):
                layer = layers.get('msp' if name == 'fire' else 'fire') or {}
            names = layer.get('annotation_names') or []
            rows.extend((names[i] if i < len(names) else '', name)
                        for i in range(len(layer.get('source_intervals') or layer.get('intervals') or [])))
        return rows

    def annotation_names(self, read):
        return [row[0] for row in self._annotation_rows(read)]

    def annotation_layers(self, read):
        return [row[1] for row in self._annotation_rows(read)]

    def intervals(self, read: dict) -> Iterable[Sequence[int]]:
        if self.selected_layers:
            return [iv for name in self.selected_layers for iv in FootprintLayerResolver(name).intervals(read)]
        if not self.target_layer:
            return read.get("intervals") or []

        if self.target_layer == "all_fp":
            # Only union structured footprint-type layers. Primary intervals
            # can encode raw read-span or gap blocks depending on data source.
            self.asked += 1
            seen = set()
            out = []
            for layer_name, layer_data in (read.get("layers") or {}).items():
                if layer_name in self.non_fp_layers:
                    continue
                for interval in _unclipped_intervals(layer_data or {}):
                    if len(interval) < 3:
                        continue
                    key = (interval[0], interval[1], interval[2])
                    if key not in seen:
                        seen.add(key)
                        out.append(interval)
            if out:
                self.found += 1
            return out

        self.asked += 1
        layers = read.get("layers") or {}
        layer_data = layers.get(self.target_layer)
        if not layer_data and self.target_layer == "fire":
            layer_data = layers.get("msp")
        elif not layer_data and self.target_layer == "msp":
            layer_data = layers.get("fire")
        if layer_data:
            self.found += 1
            return layer_data.get("source_intervals") or layer_data.get("intervals") or []
        return []

    def family_metadata(self, read: dict) -> Sequence[tuple[int, int, int]]:
        """Return ``(fi,fq,kind)`` rows aligned to selected intervals."""
        if self.selected_layers:
            # Per layer through its own resolver, so the rows line up with intervals()
            # (which resolves fire/msp aliases the same way).
            return [row for name in self.selected_layers for row in FootprintLayerResolver(name).family_metadata(read)]
        if not self.target_layer:
            return ()
        layers = read.get("layers") or {}
        if self.target_layer == "all_fp":
            family_by_interval: dict[tuple[int, int, int], tuple[int, int, int]] = {}
            for layer_name, layer_data in layers.items():
                if layer_name in self.non_fp_layers:
                    continue
                intervals = _unclipped_intervals(layer_data or {})
                rows = self._layer_family_metadata(layer_data or {})
                for index, interval in enumerate(intervals):
                    if len(interval) < 3:
                        continue
                    row = rows[index] if index < len(rows) else (0, 0, 0)
                    if row[0] > 0:
                        family_by_interval[(interval[0], interval[1], interval[2])] = row
            seen = set()
            out = []
            for layer_name, layer_data in layers.items():
                if layer_name in self.non_fp_layers:
                    continue
                for interval in _unclipped_intervals(layer_data or {}):
                    if len(interval) < 3:
                        continue
                    key = (interval[0], interval[1], interval[2])
                    if key not in seen:
                        seen.add(key)
                        out.append(family_by_interval.get(key, (0, 0, 0)))
            return out
        layer_data = layers.get(self.target_layer)
        if not layer_data and self.target_layer == "fire":
            layer_data = layers.get("msp")
        elif not layer_data and self.target_layer == "msp":
            layer_data = layers.get("fire")
        if not layer_data:
            return ()
        return self._layer_family_metadata(layer_data)

    @staticmethod
    def _layer_family_metadata(layer_data: dict) -> list[tuple[int, int, int]]:
        intervals = layer_data.get("intervals") or []
        annotation_names = layer_data.get("annotation_names") or []
        quality_names = layer_data.get("quality_names") or []
        qualities = layer_data.get("qualities") or []
        try:
            fi_index = quality_names.index("fi")
        except ValueError:
            return [(0, 0, 0)] * len(intervals)
        try:
            fq_index = quality_names.index("xq" if "xq" in quality_names else "fq")
        except ValueError:
            fq_index = -1
        fi_values = qualities[fi_index] if fi_index < len(qualities) else []
        fq_values = qualities[fq_index] if 0 <= fq_index < len(qualities) else []
        rows: list[tuple[int, int, int]] = []
        for index in range(len(intervals)):
            family_id = int(fi_values[index]) if index < len(fi_values) else 0
            family_confidence = int(fq_values[index]) if index < len(fq_values) else 0
            annotation_name = str(annotation_names[index]) if index < len(annotation_names) else ""
            confidence_kind = 0
            if family_id > 0 and layer_data.get('family_confidence_kind')!='unavailable':
                confidence_kind = 2 if annotation_name.lower().startswith("fhlt_") else 1
            rows.append((family_id, family_confidence, confidence_kind))
        return rows

    def missing_warning(self) -> Optional[str]:
        if self.target_layer and self.asked > 0 and self.found == 0:
            return (
                f"Layer '{self.target_layer}' is selected but no loaded read carries that layer. "
                "Overlap counts and size histograms will be empty. "
                "Switch the Layer selector to one your dataset actually has (e.g. All / Nuc / TF / FIRE)."
            )
        return None


def footprint_analysis_needs_layers(
    target_layer: Optional[str],
    profile_layers: Optional[Sequence[str]],
    include_profiles: bool,
) -> bool:
    return bool(target_layer or (include_profiles and profile_layers))


def cap_working_set_reads(working_set, max_reads: Optional[int], seed: str):
    """Apply a deterministic per-analysis read cap while preserving count metadata."""
    if not max_reads or len(working_set.reads) <= max_reads:
        return working_set

    sampled = sample_stable_by_id(working_set.reads, max_reads, seed=seed)
    return type(working_set)(
        sampled,
        working_set.total_overlapping,
        working_set.total_spanning,
        working_set.chrom,
        working_set.start,
        working_set.end,
    )


def get_cached_interval_table(
    working_set,
    cache_key,
    interval_getter: IntervalGetter,
    family_metadata_getter: Optional[FamilyMetadataGetter] = None,
    max_entries: int = 8,
) -> IntervalTable:
    """Get or build a cached interval table attached to a WorkingSet."""
    cache = getattr(working_set, "_interval_table_cache", None)
    if cache is None:
        return build_interval_table(
            working_set.reads,
            interval_getter,
            working_set.start,
            family_metadata_getter=family_metadata_getter,
        )

    cached = cache.get(cache_key)
    if cached is not None:
        cache.move_to_end(cache_key)
        return cached

    table = build_interval_table(
        working_set.reads,
        interval_getter,
        working_set.start,
        family_metadata_getter=family_metadata_getter,
    )
    cache[cache_key] = table
    cache.move_to_end(cache_key)
    from services.byte_cache import ByteCache
    while not isinstance(cache, ByteCache) and len(cache) > max_entries:
        cache.popitem(last=False)
    return table


def read_reference_spans(read: dict, region_start: int) -> Optional[list[tuple[int, int]]]:
    """The absolute reference spans a read's alignment covers, or None when unknown.

    BAM reads carry their alignment bounds (reference_start/end); the displayed intervals can't stand in for them
    because terminal gaps may be hidden. A read with ``alignment_spans`` (an origin-spanning record on a circular
    contig, or a row of a wrapped circular view) covers each of those parts, and never the gap between them. Reads
    without bounds (BigBed), or whose display coordinates were shifted away from them, use the extent of their
    displayed intervals. Coordinates can be negative (a wrapped part on a circular contig)."""
    intervals = [iv for iv in (read.get("intervals") or []) if len(iv) >= 2]
    shown = ((region_start + min(int(iv[0]) for iv in intervals), region_start + max(int(iv[1]) for iv in intervals))
             if intervals else None)
    if read.get("alignment_spans"):
        from services.circular_genome import merged_spans
        spans = [(int(lo), int(hi)) for lo, hi in merged_spans(read.get("alignment_spans"))]
        if spans:
            return spans
    start, end = read.get("reference_start"), read.get("reference_end")
    if isinstance(start, (int, np.integer)) and isinstance(end, (int, np.integer)) and end > start:
        if shown is None or (shown[0] >= start - 1 and shown[1] <= end + 1):
            return [(int(start), int(end))]
    return [shown] if shown is not None else None


def read_reference_extent(read: dict, region_start: int) -> Optional[tuple[int, int]]:
    """The single span a read's alignment covers, or None when unknown or split in parts (see
    ``read_reference_spans``, which eligibility uses)."""
    spans = read_reference_spans(read, region_start)
    return spans[0] if spans and len(spans) == 1 else None


def build_interval_table(
    reads: list[dict],
    interval_getter: IntervalGetter,
    region_start: int,
    family_metadata_getter: Optional[FamilyMetadataGetter] = None,
) -> IntervalTable:
    """Flatten positive intervals into absolute-coordinate NumPy arrays."""

    starts: list[int] = []
    ends: list[int] = []
    sizes: list[int] = []
    read_indices: list[int] = []
    read_ids: list[str] = []
    family_names: list[str] = []
    family_layers: list[str] = []
    family_ids: list[int] = []
    family_confidences: list[int] = []
    family_confidence_kinds: list[int] = []

    resolver = getattr(interval_getter, '__self__', None)
    if not isinstance(resolver, FootprintLayerResolver):
        resolver = None
    span_starts: list[int] = []
    span_ends: list[int] = []
    span_read_indices: list[int] = []
    extent_known = np.zeros(len(reads), dtype=bool)
    for read_index, read in enumerate(reads):
        read_ids.append(str(read.get("id", id(read))))
        spans = read_reference_spans(read, region_start)
        if spans is not None:
            extent_known[read_index] = True
            for lo, hi in spans:
                span_starts.append(int(lo))
                span_ends.append(int(hi))
                span_read_indices.append(read_index)
        intervals = list(interval_getter(read))
        metadata = list(family_metadata_getter(read)) if family_metadata_getter else []
        # Once per read (not per interval).
        rows = resolver._annotation_rows(read) if resolver is not None else []
        for interval_index, interval in enumerate(intervals):
            if len(interval) < 3:
                continue
            size = int(interval[2])
            if size <= 0:
                continue
            starts.append(region_start + int(interval[0]))
            ends.append(region_start + int(interval[1]))
            sizes.append(size)
            read_indices.append(read_index)
            family_id, family_confidence, family_confidence_kind = (
                metadata[interval_index] if interval_index < len(metadata) else (0, 0, 0)
            )
            name, layer = rows[interval_index] if interval_index < len(rows) else ('', '')
            family_layers.append(layer)
            family_names.append(name)
            family_ids.append(max(0, min(255, int(family_id))))
            family_confidences.append(max(0, min(255, int(family_confidence))))
            family_confidence_kinds.append(max(0, min(2, int(family_confidence_kind))))

    return IntervalTable(
        starts=np.asarray(starts, dtype=np.int64),
        ends=np.asarray(ends, dtype=np.int64),
        sizes=np.asarray(sizes, dtype=np.int32),
        read_indices=np.asarray(read_indices, dtype=np.int32),
        read_ids=read_ids,
        n_reads=len(reads),
        family_ids=np.asarray(family_ids, dtype=np.uint8),
        family_names=np.asarray(family_names,dtype=object),
        family_layers=np.asarray(family_layers,dtype=object),
        family_confidences=np.asarray(family_confidences, dtype=np.uint8),
        family_confidence_kinds=np.asarray(family_confidence_kinds, dtype=np.uint8),
        span_starts=np.asarray(span_starts, dtype=np.int64),
        span_ends=np.asarray(span_ends, dtype=np.int64),
        span_read_indices=np.asarray(span_read_indices, dtype=np.int64),
        extent_known=extent_known,
    )


def _footprint_bounds(footprint: dict) -> tuple[int, int]:
    return (
        int(footprint.get("absStart", footprint.get("abs_start", 0))),
        int(footprint.get("absEnd", footprint.get("abs_end", 0))),
    )


def first_overlap_sizes_by_read(table: IntervalTable, start: int, end: int) -> np.ndarray:
    """Return the first overlapping interval size for each matching read."""

    if table.empty:
        return np.empty(0, dtype=np.int32)

    matching_positions = np.flatnonzero((table.starts < end) & (table.ends > start))
    if matching_positions.size == 0:
        return np.empty(0, dtype=np.int32)

    # The table is flattened in read order, then interval order. return_index
    # gives the first matching interval per read, matching the old loop+break.
    _, first_offsets = np.unique(table.read_indices[matching_positions], return_index=True)
    return table.sizes[matching_positions[first_offsets]]


def compute_overlap_stats(
    table: IntervalTable,
    footprints: list[dict],
    total_reads: int,
    include_sizes: bool = True,
) -> list[dict]:
    """Compute per-footprint overlap counts, sizes, and histograms."""

    hist_bins = np.arange(10, 305, 5, dtype=np.int32)
    per_footprint: list[dict] = []

    for footprint in footprints:
        abs_start, abs_end = _footprint_bounds(footprint)
        overlap_sizes = first_overlap_sizes_by_read(table, abs_start, abs_end)
        overlap_count = int(overlap_sizes.size)
        overlap_fraction = overlap_count / total_reads if total_reads > 0 else 0
        size_mean = float(np.mean(overlap_sizes)) if overlap_count else 0
        size_median = float(np.median(overlap_sizes)) if overlap_count else 0
        hist_counts, _ = (
            np.histogram(overlap_sizes, bins=hist_bins)
            if overlap_count
            else (np.zeros(len(hist_bins) - 1, dtype=np.int64), None)
        )
        entry = {
            "overlap_count": overlap_count,
            "overlap_fraction": round(overlap_fraction, 4),
            "size_mean": round(size_mean, 1),
            "size_median": round(size_median, 1),
            "size_histogram": {
                "bins": [int(x) for x in hist_bins[:-1]],
                "counts": [int(c) for c in hist_counts],
                "bin_width": 5,
            },
        }
        if include_sizes:
            entry["overlap_sizes"] = [int(x) for x in overlap_sizes]
        per_footprint.append(entry)

    return per_footprint


def accumulate_profile(table: IntervalTable, footprints: list[dict], profile_window: int) -> np.ndarray:
    """Accumulate interval-center density around each selected footprint."""

    from services.public_limits import check_public_allocation
    check_public_allocation(profile_window=profile_window)
    agg = np.zeros(2 * profile_window + 1, dtype=float)
    if table.empty:
        return agg

    centers = table.centers
    for footprint in footprints:
        abs_start, abs_end = _footprint_bounds(footprint)
        center = (abs_start + abs_end) // 2
        rel = centers - center
        in_window = (rel >= -profile_window) & (rel <= profile_window)
        if np.any(in_window):
            np.add.at(agg, (rel[in_window] + profile_window).astype(np.intp), 1)
    return agg


def make_read_bootstrap_weights(
    n_reads: int,
    *,
    seed: str,
    resamples: int = 500,
) -> np.ndarray:
    """Create a compact deterministic multinomial read-resampling plan.

    One plan can be reused across profile layers from the same working set,
    avoiding repeated RNG work and producing paired cross-layer resamples.
    """
    n = max(0, int(n_reads))
    count = max(1, int(resamples))
    if n == 0:
        return np.empty((count, 0), dtype=np.uint8)
    digest = hashlib.sha256(str(seed).encode("utf-8")).digest()
    rng = np.random.default_rng(int.from_bytes(digest[:8], "little", signed=False))
    probabilities = np.full(n, 1.0 / n, dtype=float)
    dtype = np.uint8 if n <= np.iinfo(np.uint8).max else (
        np.uint16 if n <= np.iinfo(np.uint16).max else np.uint32
    )
    weights = np.empty((count, n), dtype=dtype)
    chunk_size = min(25, count)
    for offset in range(0, count, chunk_size):
        chunk_count = min(chunk_size, count - offset)
        weights[offset:offset + chunk_count] = rng.multinomial(
            n,
            probabilities,
            size=chunk_count,
        ).astype(dtype, copy=False)
    return weights


def bootstrap_profile_ci(
    table: IntervalTable,
    footprints: list[dict],
    profile_window: int,
    *,
    seed: str,
    resamples: int = 500,
    confidence_level: float = 0.95,
    weights: Optional[np.ndarray] = None,
) -> dict:
    """Pointwise percentile CI from deterministic whole-read resampling.

    Each sparse matrix row is one read's complete profile contribution across
    every selected footprint. Resampling rows preserves all intervals within a
    read and avoids the invalid shortcut of resampling already-aggregated bins.
    The returned band is on the same total-count scale as ``accumulate_profile``.
    """
    from services.public_limits import check_public_allocation
    check_public_allocation(profile_window=profile_window)
    n_positions = 2 * profile_window + 1
    n_reads = int(table.n_reads)
    if weights is not None:
        if weights.ndim != 2 or weights.shape[1] != n_reads:
            raise ValueError(
                f"Bootstrap weights shape {weights.shape} does not match {n_reads} reads"
            )
        n_resamples = int(weights.shape[0])
        if n_resamples < 1:
            raise ValueError("Bootstrap weights must contain at least one resample")
    else:
        n_resamples = max(1, int(resamples))
    metadata = {
        "confidence_level": float(confidence_level),
        "method": "whole-read bootstrap percentile",
        "resamples": n_resamples,
        "n_reads": n_reads,
    }
    if n_reads == 0:
        zeros = [0.0] * n_positions
        return {"low": zeros, "high": zeros.copy(), **metadata}

    row_parts = []
    column_parts = []
    centers = table.centers
    for footprint in footprints:
        abs_start, abs_end = _footprint_bounds(footprint)
        center = (abs_start + abs_end) // 2
        relative = centers - center
        in_window = (relative >= -profile_window) & (relative <= profile_window)
        if np.any(in_window):
            row_parts.append(table.read_indices[in_window])
            column_parts.append((relative[in_window] + profile_window).astype(np.int32))

    if not row_parts:
        zeros = [0.0] * n_positions
        return {"low": zeros, "high": zeros.copy(), **metadata}

    from scipy.sparse import coo_matrix

    rows = np.concatenate(row_parts)
    columns = np.concatenate(column_parts)
    contributions = coo_matrix(
        (np.ones(rows.size, dtype=np.float32), (rows, columns)),
        shape=(n_reads, n_positions),
        dtype=np.float32,
    ).tocsr()

    if n_reads == 1:
        aggregate = np.asarray(contributions.sum(axis=0)).ravel().astype(float)
        values = [float(value) for value in aggregate]
        return {"low": values, "high": values.copy(), **metadata}

    if weights is None:
        weights = make_read_bootstrap_weights(
            n_reads,
            seed=seed,
            resamples=n_resamples,
        )
    draws = np.empty((n_resamples, n_positions), dtype=np.float32)
    chunk_size = min(25, n_resamples)
    for offset in range(0, n_resamples, chunk_size):
        count = min(chunk_size, n_resamples - offset)
        chunk_weights = weights[offset:offset + count].astype(np.float32, copy=False)
        # Sparse read contributions × multinomial read weights. Transposing
        # keeps the dense temporary bounded by chunk_size × n_positions.
        draws[offset:offset + count] = np.asarray(contributions.T.dot(chunk_weights.T).T)

    alpha = 1.0 - float(confidence_level)
    low, high = np.quantile(draws, [alpha / 2.0, 1.0 - alpha / 2.0], axis=0)
    return {
        "low": [float(value) for value in low],
        "high": [float(value) for value in high],
        **metadata,
    }


def accumulate_profile_and_vplot(
    table: IntervalTable,
    footprints: list[dict],
    profile_window: int,
    size_min: int,
    size_max: int,
    size_bin: int,
    pos_bin: int,
) -> tuple[np.ndarray, np.ndarray]:
    """Accumulate aggregate profile and V-plot matrix from one interval table."""

    n_size_bins = max(0, (size_max - size_min) // size_bin) if size_bin > 0 else 0
    n_pos_bins = max(0, (2 * profile_window) // pos_bin) if pos_bin > 0 else 0
    # A public server's limits, whatever route led here (no-op for local use).
    from services.public_limits import check_public_allocation
    check_public_allocation(vplot_cells_=n_size_bins * n_pos_bins, profile_window=profile_window)
    agg = np.zeros(2 * profile_window + 1, dtype=float)
    vp_matrix = np.zeros((n_size_bins, n_pos_bins), dtype=float)
    if table.empty:
        return agg, vp_matrix

    centers = table.centers
    size_idx = ((table.sizes - size_min) // size_bin).astype(np.intp) if size_bin > 0 else np.zeros_like(table.sizes)
    size_valid = (
        (size_bin > 0)
        & (table.sizes >= size_min)
        & (table.sizes < size_max)
        & (size_idx >= 0)
        & (size_idx < n_size_bins)
    )

    for footprint in footprints:
        abs_start, abs_end = _footprint_bounds(footprint)
        center = (abs_start + abs_end) // 2
        rel = centers - center

        in_profile = (rel >= -profile_window) & (rel <= profile_window)
        if np.any(in_profile):
            np.add.at(agg, (rel[in_profile] + profile_window).astype(np.intp), 1)

        if n_size_bins == 0 or n_pos_bins == 0 or pos_bin <= 0:
            continue
        pos_idx = ((rel + profile_window) // pos_bin).astype(np.intp)
        in_vplot = size_valid & (pos_idx >= 0) & (pos_idx < n_pos_bins)
        if np.any(in_vplot):
            np.add.at(vp_matrix, (size_idx[in_vplot], pos_idx[in_vplot]), 1)

    return agg, vp_matrix


def _group_reference(group: dict, footprints: list[dict]) -> Optional[tuple[int, int]]:
    model_start, model_end = group.get("familyModelAbsStart"), group.get("familyModelAbsEnd")
    if model_start is not None and model_end is not None:
        return int(model_start), int(model_end)
    ref_start = group.get("referenceAbsStart")
    ref_end = group.get("referenceAbsEnd")
    if ref_start is not None and ref_end is not None:
        return int(ref_start), int(ref_end)

    raw_index = group.get("sourceIndex", group.get("source_index"))
    source_index = int(raw_index) if raw_index is not None else -1  # 0 is the first footprint
    if 0 <= source_index < len(footprints):
        return _footprint_bounds(footprints[source_index])
    return None


def compute_group_memberships(
    table: IntervalTable,
    groups: list[dict],
    footprints: list[dict],
    ambiguous_out: Optional[dict[int, set[str]]] = None,
) -> dict[int, set[str]]:
    """Compute read membership for each footprint cart group.

    Membership is by read name. A name carried by several reads (alignments
    of distinct molecules) whose reads disagree on a group is left out of that
    group and, when ``ambiguous_out`` is given, listed there: counting it would
    merge two molecules into one (as consensus-class membership also does).
    """

    memberships: dict[int, set[str]] = {}
    if table.n_reads == 0:
        return {i: set() for i in range(len(groups))}
    shared = table.shared_name_indices()

    def settle(group_index: int, member_indices) -> None:
        members = table.ids_for_read_indices(member_indices)
        if shared:
            member_set = {int(i) for i in member_indices}
            for name, indices in shared.items():
                inside = sum(1 for i in indices if i in member_set)
                if 0 < inside < len(indices):
                    members.discard(name)
                    if ambiguous_out is not None:
                        ambiguous_out.setdefault(group_index, set()).add(name)
        memberships[group_index] = members

    for group_index, group in enumerate(groups):
        if group.get('consensusStateId'):
            # Class membership must be supplied by the frozen caller result.
            # Never silently substitute geometric matching for a missing run.
            memberships[group_index] = set()
            continue
        reference = _group_reference(group, footprints)
        src_start, src_end = reference if reference is not None else (0, 0)
        src_size = max(1, src_end - src_start)
        size_min = int(group.get("sizeMin", 0) or 0)
        raw_size_max = group.get("sizeMax", None)
        size_max = int(raw_size_max) if raw_size_max is not None else None

        min_fp_cov = float(group.get("minFpCoverage", 0.0) or 0.0)
        min_tgt_cov = float(group.get("minTargetCoverage", 0.0) or 0.0)
        if min_fp_cov == 0.0 and min_tgt_cov == 0.0:
            legacy_mode = group.get("overlapMode")
            legacy_frac = float(group.get("overlapFraction", 0.0) or 0.0)
            if legacy_mode == "contains_target":
                min_tgt_cov = 1.0
            elif legacy_mode == "contained_by_target":
                min_fp_cov = 1.0
            elif legacy_mode == "fraction" and legacy_frac > 0:
                min_fp_cov = legacy_frac
                min_tgt_cov = legacy_frac

        if table.empty:
            memberships[group_index] = set()
            continue

        mask = np.ones(table.sizes.shape, dtype=bool)
        if reference is not None:
            mask &= (table.starts < src_end) & (table.ends > src_start)
        if size_min > 0:
            mask &= table.sizes >= size_min
        if size_max is not None:
            mask &= table.sizes <= size_max
        family_name=group.get('familyAnnotationName')
        if family_name:
            mask &= table.family_names==family_name if table.family_names is not None else False
        # 'all_fp' is every footprint layer: its intervals keep their own layer names.
        if group.get('layer') and group.get('layer') != 'all_fp' and table.family_layers is not None:
            mask &= table.family_layers==group['layer']
        raw_family_id = group.get("familyId", group.get("family_id"))
        if raw_family_id is not None and not family_name:
            family_id = int(raw_family_id)
            mask &= table.family_ids == family_id
        minimum_family_confidence = float(
            group.get(
                "minFamilyConfidence",
                group.get("min_family_confidence", 0.0),
            )
            or 0.0
        )
        if minimum_family_confidence > 0:
            minimum_family_q = int(np.ceil(255.0 * minimum_family_confidence))
            mask &= table.family_confidence_kinds == 1
            mask &= table.family_confidences >= minimum_family_q

        positions = np.flatnonzero(mask)
        if positions.size == 0:
            memberships[group_index] = set()
            continue

        keep = np.ones(positions.shape, dtype=bool)
        if reference is not None:
            overlap_start = np.maximum(table.starts[positions], src_start)
            overlap_end = np.minimum(table.ends[positions], src_end)
            overlap_len = overlap_end - overlap_start
            keep &= overlap_len > 0
            if min_fp_cov > 0:
                keep &= overlap_len >= min_fp_cov * table.sizes[positions]
            if min_tgt_cov > 0:
                keep &= overlap_len >= min_tgt_cov * src_size

        if not np.any(keep):
            memberships[group_index] = set()
            continue

        settle(group_index, np.unique(table.read_indices[positions[keep]]))

    return memberships


def _sorted_read_ids(read_ids) -> list[str]:
    return sorted(str(read_id) for read_id in read_ids)


def benjamini_hochberg(p_values: Sequence[float]) -> list[float]:
    """Return monotone Benjamini-Hochberg adjusted p-values in input order."""
    if not p_values:
        return []
    clean = [min(1.0, max(0.0, float(p))) if np.isfinite(p) else 1.0 for p in p_values]
    order = sorted(range(len(clean)), key=lambda index: (clean[index], index))
    adjusted = [1.0] * len(clean)
    running_min = 1.0
    for reverse_index in range(len(order) - 1, -1, -1):
        original_index = order[reverse_index]
        rank = reverse_index + 1
        running_min = min(running_min, clean[original_index] * len(clean) / rank)
        adjusted[original_index] = min(1.0, running_min)
    return adjusted


def add_cooccupancy_fdr(co_occupancy: dict) -> dict:
    """Attach BH q-values across every dataset/pair in one analysis response."""
    pairs = [
        pair
        for dataset_result in co_occupancy.values()
        for pair in (dataset_result.get("pairs", []) if isinstance(dataset_result, dict) else [])
    ]
    for pair, q_value in zip(pairs, benjamini_hochberg([pair.get("p_value", 1.0) for pair in pairs])):
        pair["q_value"] = float(q_value)
    return co_occupancy


def reads_covering(table: IntervalTable, span: Optional[tuple[int, int]]) -> set[str]:
    """Read names with an alignment that covers ``span`` entirely (all reads when there is no span to cover, or
    for reads whose extent is unknown). A read in parts (origin-spanning) covers it when one part does."""
    if span is None or table.extent_known is None:
        return set(table.read_ids)
    ok = ~np.asarray(table.extent_known, dtype=bool)
    covering = (table.span_starts <= span[0]) & (table.span_ends >= span[1])
    ok[table.span_read_indices[covering]] = True
    return {table.read_ids[i] for i in np.flatnonzero(ok)}


def compute_cooccupancy_result(
    table: IntervalTable,
    groups: list[dict],
    footprints: list[dict],
    *,
    total_reads: Optional[int] = None,
    fisher_exact_func=None,
    class_memberships=None,
    class_eligible=None,
    class_ambiguous=None,
    class_not_evaluated=None,
    class_unavailable=None,
) -> dict:
    """Compute per-group and pairwise occupancy summaries for cart groups.

    A read name whose alignments disagree on a group (``class_ambiguous``, or
    found here for geometric groups) is not eligible for it, so it's neither
    counted with nor without that group, nor in its pairs.

    ``class_not_evaluated``: per class group, matched reads the class was not evaluated on (reported as a count,
    never counted without it). ``class_unavailable``: per class group, why it can't be resolved (its run is gone,
    another chromosome); such a group is reported with no eligible reads and left out of every pair.
    """
    total = int(total_reads if total_reads is not None else table.n_reads)
    all_ids = set(table.read_ids)
    ambiguous: dict[int, set[str]] = {}
    group_membership = compute_group_memberships(table, groups, footprints, ambiguous_out=ambiguous)
    for gi, names in (class_ambiguous or {}).items():
        ambiguous[gi] = set(names)
    unavailable = dict(class_unavailable or {})
    for i, group in enumerate(groups):
        if group.get('consensusStateId') and i not in (class_memberships or {}) and i not in unavailable:
            raise ValueError('Class membership is unavailable; rerun or restore its consensus analysis')
    class_memberships = {**{i: set() for i in unavailable}, **(class_memberships or {})}
    class_eligible = {**(class_eligible or {}), **{i: set() for i in unavailable}}
    group_membership.update(class_memberships or {})
    covering = {}
    for i, group in enumerate(groups):
        if group.get('consensusStateId') or i in (class_eligible or {}):
            continue
        # A read is observed at a site only if its alignment covers the site's whole reference span: a read ending
        # before it is not evidence that the site is unoccupied.
        covering[i] = reads_covering(table, _group_reference(group, footprints))
    eligible = {
        i: (all_ids & set((class_eligible or {}).get(i, covering.get(i, all_ids)))) - ambiguous.get(i, set())
        for i in range(len(groups))
    }

    per_group = []
    for gi in range(len(groups)):
        members = group_membership.get(gi, set()) & eligible[gi]
        per_group.append({
            "n_with": len(members),
            "n_without": len(eligible[gi] - members),
            "eligible_reads": len(eligible[gi]),
            "ids_with": _sorted_read_ids(members),
            "ids_without": _sorted_read_ids(eligible[gi] - members),
            **({"ambiguous_read_ids": _sorted_read_ids(ambiguous[gi])} if ambiguous.get(gi) else {}),
            **({"not_evaluated_reads": len((class_not_evaluated or {})[gi] & all_ids)} if gi in (class_not_evaluated or {}) else {}),
            **({"unavailable": unavailable[gi]} if gi in unavailable else {}),
        })

    pairs = []
    if len(groups) >= 2:
        if fisher_exact_func is None:
            from scipy.stats import fisher_exact as fisher_exact_func

        for i in range(len(groups)):
            for j in range(i + 1, len(groups)):
                pair_ids = eligible[i] & eligible[j]
                if not pair_ids:
                    continue
                a = group_membership.get(i, set()) & pair_ids
                b = group_membership.get(j, set()) & pair_ids
                both = len(a & b)
                a_only = len(a - b)
                b_only = len(b - a)
                neither = len(pair_ids - a - b)
                contingency_table = [[both, a_only], [b_only, neither]]
                odds_ratio, p_value = fisher_exact_func(contingency_table)
                pairs.append({
                    "group_i": i,
                    "group_j": j,
                    "table": contingency_table,
                    "odds_ratio": round(float(odds_ratio), 3),
                    "p_value": float(p_value),
                    "n_both": both,
                    "n_i_only": a_only,
                    "n_j_only": b_only,
                    "n_neither": neither,
                    "ids_both": _sorted_read_ids(a & b),
                    "ids_i_only": _sorted_read_ids(a - b),
                    "ids_j_only": _sorted_read_ids(b - a),
                    "ids_neither": _sorted_read_ids(pair_ids - a - b),
                    "eligible_reads": len(pair_ids),
                })

    return {
        "pairs": pairs,
        "per_group": per_group,
        "total_reads": total,
    }
