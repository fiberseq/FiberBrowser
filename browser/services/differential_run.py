"""Differential features over the browser's state: the per-read feature states of many features (batched through
``services.feature_states``, peak-open hits sharing their working sets), the reads of groups A and B, optional strata
(m6A density bins, replicates), then ``services.differential`` per feature and BH.

Body:
- features: [{key, label, chrom, start, end, refs: [{kind, source, id, dataset_id?, hub_hit?}, ...]}] (a feature's
  refs: one per dataset for per-dataset kinds such as footprint classes; the first ref that evaluates a read counts);
- groups: {A: {label, datasets: [...], reads?: {dataset: [read names]}}, B: {...}} (reads absent: every read of the
  datasets; given: those reads only, e.g. a cluster);
- test: fisher | chi2; density_match (bool), density_bins (5); replicate_aware (bool); min_reads (per side).

Replicate-aware: strata are the replicate pairs (A's i-th dataset with B's i-th) when the groups are datasets, or the
datasets when the groups are reads (clusters, read groups) inside them. Density matching: strata are equal-count bins
of the reads' m6A per kb (reads without marks or span are left out and counted).
"""
from __future__ import annotations

from typing import Callable, Dict, List, Optional

MAX_FEATURES = 2000
STATE_BATCH = 16


class Cancelled(Exception):
    pass


def _record_key(read: dict) -> Optional[str]:
    from services.lift.cohort import record_key
    return record_key(read.get('analysis_id')) or read.get('analysis_id') or read.get('id')


def _states_for(state, refs: List[dict], cancelled: Callable[[], bool]):
    """by_dataset {ds: {read: list of chars}} over all refs (columns in order), and per-ref errors."""
    from services.feature_states import feature_states
    from services.hub.provider_states import shared_windows
    n = len(refs)
    by_dataset: Dict[str, Dict[str, List[str]]] = {}
    errors: Dict[int, str] = {}

    def put(offset: int, result: dict):
        for ds, reads in (result.get('by_dataset') or {}).items():
            dst = by_dataset.setdefault(ds, {})
            for read, chars in reads.items():
                row = dst.get(read)
                if row is None:
                    row = dst[read] = ['.'] * n
                for k, ch in enumerate(chars):
                    row[offset + k] = ch

    with shared_windows(state, [r.get('hub_hit') for r in refs]):
        for i in range(0, n, STATE_BATCH):
            if cancelled():
                raise Cancelled()
            chunk = refs[i:i + STATE_BATCH]
            try:
                put(i, feature_states(state, chunk))
            except (ValueError, KeyError, TypeError):
                # One bad ref (a run no longer in the session) must not sink the others: retry them one by one.
                for k, ref in enumerate(chunk):
                    try:
                        put(i + k, feature_states(state, [ref]))
                    except (ValueError, KeyError, TypeError) as error:
                        errors[i + k] = str(error) or 'states not available'
    return by_dataset, errors


def _densities(state, datasets: List[str], features: List[dict], cancelled) -> Dict[str, Dict[str, float]]:
    """{ds: {read key: m6A marks per kb of aligned span}} over the features' span on each chromosome."""
    spans: Dict[str, List[int]] = {}
    for f in features:
        if f.get('chrom') is None or f.get('start') is None or f.get('end') is None:
            continue
        lo_hi = spans.setdefault(str(f['chrom']), [int(f['start']), int(f['end'])])
        lo_hi[0], lo_hi[1] = min(lo_hi[0], int(f['start'])), max(lo_hi[1], int(f['end']))
    out: Dict[str, Dict[str, float]] = {}
    for ds in datasets:
        dens = out.setdefault(ds, {})
        for chrom, (lo, hi) in spans.items():
            if cancelled():
                raise Cancelled()
            w0, w1 = max(0, lo - 100), hi + 100
            ws = state.build_working_set(ds, chrom, w0, w1, include_methylation=True, include_layers=False,
                                         include_layer_qualities=False)
            # The working set keeps only the marks inside its window: divide by the read's aligned span inside the
            # window too (the blocks are absolute and whole-read).
            win0 = getattr(ws, 'start', w0)
            for r in ws.reads:
                blocks = r.get('aligned_blocks') or []
                if blocks:
                    span = sum(max(0, min(b[1], w1) - max(b[0], win0)) for b in blocks)
                else:
                    span = max(0, min(r.get('reference_end') or 0, w1) - max(r.get('reference_start') or 0, win0))
                marks = r.get('methyl_m6a') or r.get('methyl') or []
                key = _record_key(r)
                if key and span and span > 0:
                    dens[str(key)] = len(marks) * 1000.0 / span
    return out


def run_differential(state, body: dict, cancelled: Callable[[], bool] = lambda: False) -> dict:
    from services.differential import bin_of, count_tables, density_bins, differential_rows
    features = [f for f in (body.get('features') or []) if isinstance(f, dict) and f.get('refs')]
    if not features:
        raise ValueError('Give features with refs')
    if len(features) > MAX_FEATURES:
        raise ValueError(f'At most {MAX_FEATURES} features at a time')
    groups = body.get('groups') or {}
    A, B = groups.get('A') or {}, groups.get('B') or {}
    if not A.get('datasets') or not B.get('datasets'):
        raise ValueError('Groups A and B each need datasets')
    test = 'chi2' if body.get('test') == 'chi2' else 'fisher'
    density = bool(body.get('density_match'))
    replicate = bool(body.get('replicate_aware'))
    min_reads = max(1, int(body.get('min_reads') or 5))
    by_reads = A.get('reads') is not None or B.get('reads') is not None
    if replicate and not by_reads and (len(A['datasets']) != len(B['datasets']) or len(A['datasets']) < 2):
        raise ValueError('Replicate-aware tests pair A\'s datasets with B\'s in order: give both sides the same number (2 or more)')

    refs, columns = [], []
    for f in features:
        cols = []
        for r in f['refs']:
            if isinstance(r, dict):
                cols.append(len(refs))
                refs.append(r)
        columns.append(cols)
    by_dataset_lists, errors = _states_for(state, refs, cancelled)
    by_dataset = {ds: {read: ''.join(chars) for read, chars in reads.items()} for ds, reads in by_dataset_lists.items()}

    members = {side: ({ds: set(map(str, ids)) for ds, ids in (g.get('reads') or {}).items()} if g.get('reads') is not None else None)
               for side, g in (('A', A), ('B', B))}
    dsets = {'A': list(map(str, A['datasets'])), 'B': list(map(str, B['datasets']))}

    def side_of(ds, read):
        out = []
        for side in ('A', 'B'):
            if ds not in dsets[side]:
                continue
            m = members[side]
            if m is None or read in m.get(ds, ()):
                out.append(side)
        return out

    edges: List[float] = []
    dens: Dict[str, Dict[str, float]] = {}
    no_density = 0
    if density:
        dens = _densities(state, sorted(set(dsets['A']) | set(dsets['B'])), features, cancelled)
        tested = [dens.get(ds, {}).get(read) for ds, reads in by_dataset.items() for read in reads if side_of(ds, read)]
        edges = density_bins([v for v in tested if v is not None], int(body.get('density_bins') or 5))
        no_density = sum(1 for v in tested if v is None)

    def stratum_of(ds, read, side):
        parts = []
        if replicate:
            parts.append(ds if by_reads else str(dsets[side].index(ds)))
        if density:
            b = bin_of(dens.get(ds, {}).get(read), edges)
            if b is None:
                return None
            parts.append(f'd{b}')
        return '|'.join(parts) or 'all'

    tables = count_tables([{k: f.get(k) for k in ('key', 'label', 'chrom', 'start', 'end', 'kind')} for f in features],
                          columns, by_dataset, side_of, stratum_of)
    rows = differential_rows(tables, test, replicate or density, min_reads)
    for row, cols in zip(rows, columns):
        bad = [errors[c] for c in cols if c in errors]
        if bad and len(bad) == len(cols):
            row['reason'] = bad[0]
    return dict(success=True, rows=rows, test='cmh' if (replicate or density) else test,
                density=dict(edges=edges, reads_without_density=no_density) if density else None,
                groups={side: dict(label=g.get('label') or side, datasets=dsets[side]) for side, g in (('A', A), ('B', B))},
                features=len(features), testable=sum(1 for r in rows if r['testable']))
