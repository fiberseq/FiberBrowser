"""Select a reproducible clustering cohort before decoding annotation tags."""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
import hashlib
import heapq
import json
import os

from services.byte_cache import shared_cache

cluster_sample_scope = ContextVar('cluster_sample_scope', default=None)
assigned_cluster_scope = ContextVar('assigned_cluster_scope', default=False)
_selections = shared_cache('indexes')


@dataclass(frozen=True)
class ClusterSample:
    names: frozenset[str]
    target: int
    total: int
    fingerprint: str
    sampled: bool


@dataclass(frozen=True)
class _RankedName:
    rank: tuple[int, str]

    def __lt__(self, other):
        # A max heap: discard the largest rank when a smaller one arrives.
        return self.rank > other.rank


def select_names(names, target, seed, *, with_status=False):
    """Bottom-k distinct names in O(k) memory, independent of source order.

    All physical records sharing a name stay together. The target counts
    names, not alignments; duplicates can therefore exceed it.
    """
    selected, heap = set(), []
    sampled = False
    from services.read_sampling import name_hash
    from services.read_metrics import DEFAULT_SAMPLE_SEED
    for name in names:
        if name in selected:
            continue
        # Nest the default cluster sample around the default display sample.
        # This keeps the visible fibers represented in the first clustering.
        rank = (name_hash(name if seed == DEFAULT_SAMPLE_SEED else seed + '\0' + name), name)
        entry = _RankedName(rank)
        if len(heap) < target:
            heapq.heappush(heap, entry)
            selected.add(name)
        else:
            sampled = True
            if rank < heap[0].rank:
                selected.remove(heapq.heapreplace(heap, entry).rank[1])
                selected.add(name)
    result = frozenset(selected)
    return (result, sampled) if with_status else result


def prepare_cluster_sample(state, dataset_id, chrom, start, end, target, seed, *, read_ids=None):
    """Return an early BAM sample, or None for full/explicit/circular cohorts."""
    if not target or read_ids is not None:
        return None
    if getattr(state, 'performance', {}).get('effective') == 'low' and getattr(state, 'max_working_reads', 0):
        target = min(target, state.max_working_reads)
    dataset = state.get_dataset(dataset_id)
    if dataset is None or dataset.data_type != 'bam':
        return None
    from services.circular_genome import is_circular_chrom
    if is_circular_chrom(state, chrom):
        return None
    paths = list(dataset.paths)
    if not paths or not all(os.path.isfile(path) for path in paths):
        return None
    from services.dataset_generation import dataset_generation
    from services.plasmid_reconcile import contig_links
    generation = dataset_generation(state, dataset_id)
    from services.file_handles import file_stamp
    from services.bam_handles import bam_index_candidates
    sources = tuple((path, file_stamp(path, bam_index_candidates(path))) for path in paths)
    links = [contig_links(state, path=path) for path in paths]
    chrom_map = getattr(state, 'chrom_map', None) or {}
    key = ('cluster_names_v1', dataset_id, generation, sources, chrom, start, end, target, seed,
           json.dumps([chrom_map, links], sort_keys=True))
    cached = _selections.get(key)
    if cached is not None:
        _selections.move_to_end(key)
        return cached if cached.sampled else None

    from services.bam_handles import transient_bam_handle
    from services.background_work import checkpoint
    from utils.chrom import resolve_reference_name
    threads = max(1, int(getattr(state, 'performance', {}).get('bam_threads', 1)))
    total = 0
    circular = False

    def names():
        nonlocal total, circular
        for path, path_links in zip(paths, links):
            checkpoint()
            with transient_bam_handle(path, threads=threads) as bam:
                if bam is None:
                    raise RuntimeError('Could not open a BAM while preparing the clustering sample.')
                actual = resolve_reference_name(chrom, bam.references, chrom_map, links=path_links)
                if actual is None:
                    continue
                if any(sq.get('SN') == actual and str(sq.get('TP', '')).lower() == 'circular'
                       for sq in bam.header.to_dict().get('SQ', [])):
                    circular = True
                    return
                from services.graph_lift import lift_hidden_predicate
                lift_hidden = lift_hidden_predicate(bam.header)
                records = bam.fetch(actual, start, end)
                try:
                    for index, read in enumerate(records):
                        if not index & 255:
                            checkpoint()
                        if read.flag & (4 | 256 | 2048):
                            continue
                        if lift_hidden is not None and lift_hidden(read):
                            continue  # hidden by the read loaders: not a clustering candidate
                        total += 1
                        yield read.query_name
                finally:
                    # pysam region iterators have no close(); release the
                    # iterator before its explicitly owned reader is closed.
                    records = None

    selected, sampled = select_names(names(), int(target), seed, with_status=True)
    if circular:
        return None
    if dataset_generation(state, dataset_id) != generation or state.get_dataset(dataset_id) is not dataset:
        raise RuntimeError('Dataset changed while preparing the clustering sample; cluster again.')
    fingerprint = hashlib.sha256(json.dumps(sorted(selected), ensure_ascii=True).encode()).hexdigest()
    result = ClusterSample(selected, int(target), total, fingerprint, sampled)
    _selections[key] = result
    return result if sampled else None


@contextmanager
def using_cluster_sample(sample):
    token = cluster_sample_scope.set(sample)
    try:
        yield
    finally:
        cluster_sample_scope.reset(token)


@contextmanager
def using_assigned_cluster_reads():
    """Follow-ups consume exact assignment IDs, never an open-ended base scope."""
    token = assigned_cluster_scope.set(True)
    try:
        yield
    finally:
        assigned_cluster_scope.reset(token)
