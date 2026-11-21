"""Per-molecule summaries for the cluster map's colours (`/api/cluster_molecules`).

The map colours each dot by its molecule: m6A per kb, aligned span, each layer's share of the view, or the layer at a
position. These come from the clustered reads themselves (the same exact-assignment working set the projection
uses), so they don't depend on the read panels being loaded or shown.
"""
from __future__ import annotations

import hashlib
import json
import threading
from collections import OrderedDict
from typing import Any, Dict, Iterable, Optional

from services.analysis_query import AnalysisReadQuery
from services.scoped_read_analysis import scoped_analysis
from services.read_selection import cohort_read_id, read_matches_id_filter

# Layers that aren't per-position calls (scalars, marks, regularity tiles, modification flags).
_NOT_CALLS = frozenset({'nucreg', 'nucpatch', 'nucsz', 'nucseg', 'nucmol', 'nfrmol', 'deam_opportunity',
                        'm6a', 'm5c', 'deam', 'mod'})
# FIRE elements are accessibility calls; with an MSP layer they repeat it (both are the 'fire' share), so they
# count only on a dataset without one.
# The layer at a position: footprint layers first, then accessibility (as the frontend's layerStateAt).
_STATE_ORDER = ('tf', 'nuc', 'footprint', 'fire', 'msp')

_CACHE: "OrderedDict[str, dict]" = OrderedDict()
_CACHE_LOCK = threading.Lock()
_CACHE_SIZE = 16


def profile_key(layer: str) -> str:
    """The key a profile / share is stored under (footprint is nuc, msp is fire)."""
    return {'footprint': 'nuc', 'msp': 'fire'}.get(layer, layer)


def _call_layers(dataset) -> list[str]:
    available = getattr(dataset, 'available_layers', None) or {}
    return sorted(name for name, on in available.items() if on and name not in _NOT_CALLS
                  and not (name == 'fire' and available.get('msp')))


def _has_m6a(dataset) -> bool:
    """Whether the dataset's molecules carry m6A calls (a read without any in view then has 0, not no value)."""
    available = getattr(dataset, 'available_layers', None) or {}
    return bool(available.get('m6a'))


def _m6a_marks(read: dict, has_m6a: bool):
    """The read's m6A positions: ``methyl_m6a``; a legacy ``methyl`` only when no other modification filled it
    (the loader puts 5mC or deamination positions there on reads without m6A); [] on an m6A dataset; else None."""
    marks = read.get('methyl_m6a')
    if marks is not None:
        return marks
    if read.get('methyl') is not None and read.get('methyl_m5c') is None and read.get('deam') is None:
        return read['methyl']
    return [] if has_m6a else None


def _clipped(intervals: Iterable, lo: float, hi: float) -> int:
    total = 0
    for iv in intervals or ():
        if len(iv) >= 3 and iv[2] <= 0:
            continue
        s, e = max(lo, iv[0]), min(hi, iv[1])
        if e > s:
            total += e - s
    return total


def _covers(intervals: Iterable, pos: int) -> bool:
    return any((len(iv) < 3 or iv[2] > 0) and iv[0] <= pos < iv[1] for iv in intervals or ())


def _extent(read: dict, start: int) -> tuple[float, float]:
    """The read's aligned extent in view coordinates (its calls' extent without alignment coordinates)."""
    rs, re_ = read.get('reference_start'), read.get('reference_end')
    if rs is not None and re_ is not None:
        return float(rs - start), float(re_ - start)
    lo, hi = float('inf'), float('-inf')
    groups = [read.get('intervals') or ()] + [(layer or {}).get('intervals') or () for layer in (read.get('layers') or {}).values()]
    for ivs in groups:
        for iv in ivs:
            lo, hi = min(lo, iv[0]), max(hi, iv[1])
    return lo, hi


def summarize_read(read: dict, start: int, end: int, has_m6a: bool = False) -> dict:
    """One molecule: aligned span (bp), m6A calls in the view and per kb of the read inside it (``_m6a_marks``),
    each call layer's share of the read inside the view."""
    width = end - start
    r0, r1 = _extent(read, start)
    span = int(r1 - r0) if r1 > r0 else 0
    lo, hi = max(0.0, r0), min(float(width), r1)
    in_view = hi - lo if hi > lo else 0.0
    marks = _m6a_marks(read, has_m6a)
    m6a = None if marks is None else sum(1 for p in marks if lo <= p < hi)
    frac: Dict[str, float] = {}
    if in_view > 0:
        layers = read.get('layers') or {}
        for name, layer in layers.items():
            ivs = (layer or {}).get('intervals')
            if name in _NOT_CALLS or not ivs or (name == 'fire' and 'msp' in layers):
                continue
            key = profile_key(name)
            if key in frac and name == 'footprint':
                continue   # an explicit nuc layer wins over the legacy alias
            frac[key] = round(min(1.0, _clipped(ivs, lo, hi) / in_view), 4)
        if 'fire' not in frac and read.get('fire'):
            # FIRE elements on the row itself (as/al), when no MSP / FIRE layer was loaded (as layer_state_at reads them)
            frac['fire'] = round(min(1.0, _clipped([(s, e, 1) for s, e, *_ in read['fire']], lo, hi) / in_view), 4)
        if 'nuc' not in frac and 'tf' not in frac and 'nuc' not in layers and read.get('intervals'):
            frac['nuc'] = round(min(1.0, _clipped(read['intervals'], lo, hi) / in_view), 4)
    return {
        'span': span,
        'm6a': m6a,
        'm6a_per_kb': (round(m6a / (in_view / 1000.0), 3) if m6a is not None and in_view > 0 else None),
        'frac': frac,
    }


def layer_state_at(read: dict, start: int, position: int) -> Optional[str]:
    """The layer covering a reference position on a read; 'linker' inside it without a call; None outside it."""
    pos = position - start
    r0, r1 = _extent(read, start)
    if not (r0 <= pos < r1):
        return None
    layers = read.get('layers') or {}
    for name in _STATE_ORDER:
        if _covers((layers.get(name) or {}).get('intervals'), pos):
            return profile_key(name)
    if _covers([(s, e, 1) for s, e, *_ in read.get('fire') or ()], pos):
        return 'fire'
    for name, layer in layers.items():
        if name in _STATE_ORDER or name in _NOT_CALLS:
            continue
        if _covers((layer or {}).get('intervals'), pos):
            return profile_key(name)
    if 'nuc' not in layers and 'tf' not in layers and _covers(read.get('intervals'), pos):
        return 'nuc'
    return 'linker'


def _cache_get(key: str) -> Optional[dict]:
    with _CACHE_LOCK:
        hit = _CACHE.get(key)
        if hit is not None:
            _CACHE.move_to_end(key)
        return hit


def _cache_put(key: str, value: dict) -> None:
    with _CACHE_LOCK:
        _CACHE[key] = value
        _CACHE.move_to_end(key)
        while len(_CACHE) > _CACHE_SIZE:
            _CACHE.popitem(last=False)


def read_source_identity(state, dataset_id: str, chrom: str) -> tuple:
    """What a dataset's loaded reads depend on beyond the request: its files and generation (a reload, a new file),
    how the contig's reads are loaded (topology, read-end cutoff, signal filters), the quality filters, the legacy
    layer settings, the read cap, the tables-mode scans overlaid on its rows, the consensus overlay and the
    nucleosome outputs injected into them (``services.nuc.store.nuc_identity``)."""
    from services.background_work import dataset_identity
    from services.nuc.store import nuc_identity
    from services.read_quality_filters import active_quality_filters
    from services.working_sets import read_load_token
    overlay = ()
    if state.__dict__.get('scan_registry'):
        from services.scan.overlay import overlay_signature
        overlay = overlay_signature(state, dataset_id)
    consensus_overlay = ()
    if state.__dict__.get('consensus_workflow_active'):
        from services.consensus_workflow import overlay_identity
        consensus_overlay = overlay_identity(state)
    dataset = state.get_dataset(dataset_id) if hasattr(state, 'get_dataset') else None
    return (dataset_identity(state, [dataset_id]), repr(read_load_token(state, chrom)),
            repr(active_quality_filters(state)), bool(getattr(state, 'infer_legacy_layers', True)),
            getattr(state, 'legacy_nuc_min_size', 90), getattr(state, 'max_working_reads', 0), overlay,
            consensus_overlay, nuc_identity(dataset, regularity=False))


@scoped_analysis
def cluster_molecules(state, *, chrom: str, start: int, end: int, spanning: bool, dataset_ids: list[str],
                      cluster_assignments: Dict[str, Dict[str, int]], sample_seed: Optional[str] = None,
                      lift_hap_by_dataset: Optional[Dict[str, str]] = None, position: Optional[int] = None) -> dict:
    """Each clustered molecule's summary by dataset and read id; with `position`, also the layer there.

    Read ids are the cohort ids the cluster assignments (and the projection) use. The summaries are cached per
    request (without the position); the layer at a position reads the same cached reads."""
    chrom = state.translate_chrom(chrom)
    from services.lift.capability import require_for_ids
    require_for_ids(state, dataset_ids, 'clustering')
    molecules: Dict[str, Dict[str, dict]] = {}
    layers_seen: set[str] = set()

    def entry_for(dataset_id: str) -> Optional[dict]:
        dataset = state.get_dataset(dataset_id)
        assigned = (cluster_assignments or {}).get(dataset_id)
        if assigned is None and dataset is not None:
            assigned = getattr(dataset, 'cluster_assignments', None)
        if not dataset or not assigned:
            return None
        call_layers = _call_layers(dataset)
        ids = sorted(map(str, assigned))
        key = json.dumps([dataset_id, chrom, start, end, bool(spanning), sample_seed,
                          (lift_hap_by_dataset or {}).get(dataset_id), call_layers,
                          hashlib.sha1('\n'.join(ids).encode()).hexdigest(),
                          read_source_identity(state, dataset_id, chrom)], default=str)
        entry = _cache_get(key)
        if entry is None:
            query = AnalysisReadQuery.from_request(
                state, capability='clustering', lift_hap_by_dataset=lift_hap_by_dataset,
                chrom=chrom, start=start, end=end, spanning=spanning, dataset_id=dataset_id,
                sample_seed=sample_seed, include_methylation=True,
                include_layers=bool(call_layers), requested_layers=call_layers or None,
                include_layer_qualities=False,
            )
            from services.cluster_sample import using_assigned_cluster_reads
            with using_assigned_cluster_reads():
                working_set = query.build_working_set(state, dataset_id, read_ids=ids)
            wanted = set(ids)
            reads = {cohort_read_id(r): r for r in working_set.reads if read_matches_id_filter(r, wanted)}
            has_m6a = _has_m6a(dataset)
            entry = {'reads': reads,
                     'summaries': {rid: summarize_read(r, start, end, has_m6a) for rid, r in reads.items()}}
            _cache_put(key, entry)
        return entry

    # The datasets' reads load side by side (each is its own BAM; the loads are mostly I/O and decompression).
    if len(dataset_ids) > 1:
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=min(4, len(dataset_ids))) as pool:
            # Each load runs in a copy of this request's context (its reference / scope context variables).
            import contextvars
            futures = [pool.submit(contextvars.copy_context().run, entry_for, d) for d in dataset_ids]
            entries = [f.result() for f in futures]
    else:
        entries = [entry_for(d) for d in dataset_ids]
    for dataset_id, entry in zip(dataset_ids, entries):
        if entry is None:
            continue
        out: Dict[str, dict] = {}
        for rid, summary in entry['summaries'].items():
            layers_seen.update(summary['frac'])
            if position is not None:
                summary = {**summary, 'state': layer_state_at(entry['reads'][rid], start, int(position))}
            out[rid] = summary
        molecules[dataset_id] = out
    return {'molecules': molecules, 'layers': sorted(layers_seen), 'position': position}


def clear_cache() -> None:
    with _CACHE_LOCK:
        _CACHE.clear()
