"""Full-cohort combinatorial analysis with bounded feature extraction.

Read dictionaries and positional features are expanded in bounded blocks.
The retained analysis columns are uint8 pattern bits; read IDs and the
public assignment/element lists remain proportional to the full cohort.
"""
from __future__ import annotations

import numpy as np

from services.clustering_features import (
    class_aware_pattern_slices, extract_features_from_compact, metric_percentile_ranks, molecule_metric_slots,
    molecule_metric_values,
)
from services.dynamic_clustering import match_pattern_to_cluster
from services.read_metrics import read_covers_regions

COLUMNAR_MIN_READS = 100_000
FEATURE_BLOCK_BYTES = 8 * 1024 * 1024


def use_columnar_clustering(state, req, query):
    """Select the uncapped linear BAM path; other workflows retain their loader."""
    if (req.method not in ('binary', 'combinatorial') or query.max_reads
            or getattr(state, 'max_working_reads', 0)
            or getattr(state, 'performance', {}).get('effective') == 'low'
            or getattr(req, 'viewports', None) or getattr(req, 'extra_chroms', None)
            or query.read_ids_by_dataset or query.singleton_read_ids is not None
            or query.strand_by_dataset or getattr(state, 'consensus_workflow_active', False)):
        return False
    from services.circular_genome import is_circular_chrom
    from services.compact_read_loader import _bam_wrap_length_for
    from services.bam_handles import get_bam_handle
    from services.plasmid_reconcile import contig_links
    from services.read_sampling import estimate_reads
    if is_circular_chrom(state, query.chrom):
        return False
    estimated = 0
    unknown_size = False
    for dataset_id in query.dataset_ids:
        dataset = state.get_dataset(dataset_id)
        if (not dataset or getattr(dataset, 'data_type', None) != 'bam'
                or len(getattr(dataset, 'paths', [])) != 1
                or getattr(dataset, 'derived_layers', None)
                or getattr(dataset, 'companion_layers', None)
                or getattr(dataset, 'molecule_groups', None)):
            return False
        if _bam_wrap_length_for(dataset.paths[0], query.chrom, False, get_bam_handle,
                                getattr(state, 'chrom_map', None),
                                contig_links(state, path=dataset.paths[0])):
            return False
        count = estimate_reads(dataset.paths[0], query.chrom, query.start, query.end,
                               chrom_map=getattr(state, 'chrom_map', None))
        unknown_size = unknown_size or count is None
        estimated += count or 0
    # CSI and remote indexes may not support the BAI size estimate. Keep the
    # supported full cohort bounded rather than expanding it to discover size.
    return unknown_size or estimated >= COLUMNAR_MIN_READS


def _above(means, threshold):
    """``means > threshold`` as the native fit compares them.

    Match the native NumPy-scalar/Python-scalar comparison. NumPy 1.x
    promotes that comparison to float64, while an array comparison would
    round the threshold to float32. NumPy 2.x uses its scalar promotion
    policy in result_type.
    """
    comparison_type = np.result_type(means.dtype.type(0), threshold)
    return means.astype(comparison_type, copy=False) > threshold


class ColumnarPatterns:
    """Reduce native positional features to exact pattern columns in blocks.

    Input rows must fully cover every peak. This makes rare-pattern matching
    weights equal to peak widths, as in the native endpoint's coverage filter.
    The native extractor is shared, including empty authoritative MSP layers,
    marks, quality-filtered intervals and saved footprint class rules.

    Molecule metric bits are a median split of each read's percentile rank in
    the whole cohort, which is only known once every block is in: each block
    keeps its reads' raw scalars (one value per read, like the read IDs) and
    the bits are set at finish, so they never depend on block boundaries or
    read order.
    """

    def __init__(self, peaks, region_start, *, peak_modes=None,
                 subnucleosomal_threshold=90, accessibility_threshold=0.5,
                 cluster_feature_rules=None, cluster_rule_context=None, block_rows=512):
        self.peaks = peaks
        self.region_start = region_start
        self.options = dict(peak_modes=peak_modes, subnucleosomal_threshold=subnucleosomal_threshold,
                            cluster_feature_rules=cluster_feature_rules,
                            cluster_rule_context=cluster_rule_context)
        self.threshold = accessibility_threshold
        # Include all rule terms as a conservative allowance for class columns.
        extra = sum(len(rule.get('terms', [])) for rule in (cluster_feature_rules or []))
        width = sum(max(0, (right - left + 9) // 10) for left, right in peaks) + extra
        self.block_rows = max(1, min(int(block_rows), FEATURE_BLOCK_BYTES // max(4, width * 4)))
        self.pending = []
        self.blocks = []
        # Pattern bit -> (molecule metric, raw scalars of every read so far): ranked over the cohort at finish.
        self.metric_bits = None
        self.read_ids = []
        self.slices = None
        self.peak_widths = None
        self.feature_peak_bytes = 0
        self.max_expanded_reads = 0
        self.pattern_bytes = 0

    def __len__(self):
        return len(self.read_ids) + len(self.pending)

    def append(self, read):
        if not read_covers_regions(read, self.peaks):
            raise ValueError('Columnar clustering requires full feature coverage')
        self.pending.append(read)
        if len(self.pending) >= self.block_rows:
            self.flush()

    def flush(self):
        if not self.pending:
            return
        from services.background_work import checkpoint
        checkpoint()
        X, ids, widths, modes = extract_features_from_compact(
            self.pending, self.peaks, self.region_start, step=10, **self.options)
        slices = class_aware_pattern_slices(widths, modes, self.options['cluster_feature_rules'])
        if self.slices is None:
            self.slices, self.peak_widths = slices, widths
            slots = molecule_metric_slots(widths, modes, self.options['cluster_feature_rules'])
            self.metric_bits = {bit: (slots[offset], [])
                                for bit, (_peak, offset, width, is_class) in enumerate(slices)
                                if is_class and width == 1 and offset in slots}
        elif self.slices != slices or self.peak_widths != widths:
            raise ValueError('Feature schema changed during columnar clustering')
        bits = np.zeros((len(ids), len(slices)), dtype=np.uint8)
        for bit, (_peak, offset, width, is_class) in enumerate(slices):
            if bit in self.metric_bits:
                # Ranked against the whole cohort at finish; the block's ranks are its own.
                self.metric_bits[bit][1].extend(molecule_metric_values(self.pending, self.metric_bits[bit][0]))
                continue
            if width:
                bits[:, bit] = _above(X[:, offset:offset + width].mean(axis=1), 0.5 if is_class else self.threshold)
        self.feature_peak_bytes = max(self.feature_peak_bytes, X.nbytes)
        self.max_expanded_reads = max(self.max_expanded_reads, len(self.pending))
        self.pattern_bytes += bits.nbytes
        self.blocks.append(bits)
        self.read_ids.extend(ids)
        self.pending.clear()

    def finish(self):
        self.flush()
        if not self.read_ids or not self.slices or not sum(self.peak_widths):
            return {}, {}, None, None
        columns = np.concatenate(self.blocks, axis=0)
        self.blocks.clear()
        for bit, (_metric, values) in (self.metric_bits or {}).items():
            # The native extractor's column for the whole cohort (float32 ranks), split at the median.
            columns[:, bit] = _above(metric_percentile_ranks(values), 0.5)
        patterns, inverse, frequencies = np.unique(
            columns, axis=0, return_inverse=True, return_counts=True)
        from services.background_work import checkpoint
        checkpoint()
        # np.unique sorts patterns lexicographically. Preserve that order for
        # frequency ties, matching ordinary and matched-view fitting.
        order = np.argsort(-frequencies, kind='stable')
        kept = order[:50]
        pattern_to_label = {tuple(int(v) for v in patterns[index]): label
                            for label, index in enumerate(kept)}
        weights = tuple(self.peaks[peak][1] - self.peaks[peak][0]
                        for peak, _offset, _width, _class in self.slices)
        lookup = np.empty(len(patterns), dtype=np.int32)
        for index, row in enumerate(patterns):
            pattern = tuple(int(v) for v in row)
            lookup[index] = (pattern_to_label[pattern] if pattern in pattern_to_label
                             else match_pattern_to_cluster(pattern, pattern_to_label, weights))
        labels = lookup[inverse]
        elements = [{'index': bit, 'peak': int(peak), 'class': bool(is_class)}
                    for bit, (peak, _offset, _width, is_class) in enumerate(self.slices)]
        element_ids = {bit: [self.read_ids[index] for index in np.flatnonzero(columns[:, bit])]
                       for bit in range(len(elements))}
        cluster_ids = {label: [] for label in pattern_to_label.values()}
        for read_id, label in zip(self.read_ids, labels):
            cluster_ids[int(label)].append(read_id)
        clusters = {label: {'pattern': pattern,
                            'peak_states': {f'peak_{bit}': bool(value) for bit, value in enumerate(pattern)},
                            'read_ids': cluster_ids[label]}
                    for pattern, label in pattern_to_label.items()}
        info = dict(n_elements=len(elements), elements=elements,
                    cluster_patterns={label: list(item['pattern']) for label, item in clusters.items()},
                    element_read_ids=element_ids, method='combinatorial', clusters=clusters)
        unique, counts = np.unique(labels, return_counts=True)
        assignments = {read_id: int(label) for read_id, label in zip(self.read_ids, labels)}
        return assignments, {int(u): int(n) for u, n in zip(unique, counts)}, np.argsort(labels), info

    def diagnostics(self):
        return dict(engine='columnar', input_rows=len(self.read_ids), pattern_bytes=self.pattern_bytes,
                    peak_feature_block_bytes=self.feature_peak_bytes,
                    max_expanded_reads=self.max_expanded_reads)
