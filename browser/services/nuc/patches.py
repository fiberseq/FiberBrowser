"""Patch scores per observation (NUC §6.3, §13.1): for each recurrence patch (regular, disordered, undersized,
missing; from an opened or live scan's ``nuc.patch.*`` hits) and each observation (a dataset panel, a haplotype
pop-out, a strand split, a linked locus, a graph path), the observation's own molecules give

- the **fraction**: kind-covered measured bases over measured bases in the patch (the scan's per-group fraction,
  for exactly the observation's molecules);
- the **recurrence test**: FiberHMM's exact shift-within-read null (``fiberhmm.nuc.enrichment.window_test``) on the
  observation's molecules over the patch, and Benjamini-Hochberg across the listed patches of one kind, per
  observation (``enrichment.bh``).

A molecule's measured bases follow the scan module (``fiberhmm.scan.modules.nuc`` run_unit): inside its decoded
regular / disordered / undetermined segments, outside low-information ones, on the record's aligned reference blocks
(whatever the outputs' source: live, an opened scan or an annotated BAM). A lifted observation measures the hull of
its window's source pieces on the contig they cover most.

Phased and fuzzy patches are scored by the scan per group (R − null, coherence, dispersion); they carry no
per-observation test here.
"""
from __future__ import annotations

from typing import Dict, List, Optional, Sequence, Tuple

from .observations import ObservationError, observation_cohort, same_contig, window_hull
from .store import STORE

#: patch type -> the scan module's kind name (ENRICH_KINDS)
PATCH_KIND = {'regular': 'reg', 'disordered': 'dis', 'undersized': 'uds', 'missing': 'mis'}
_STATE_KIND = {1: 'reg', 2: 'dis', 4: 'und', 3: 'low'}
_EVENT_KIND = {16: 'uds', 17: 'mis'}


def _union(iv):
    out: List[List[int]] = []
    for a, b in sorted((int(a), int(b)) for a, b in iv if b > a):
        if out and a <= out[-1][1]:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return [(a, b) for a, b in out]


def _intersect(x, y):
    out, i, j = [], 0, 0
    while i < len(x) and j < len(y):
        a, b = max(x[i][0], y[j][0]), min(x[i][1], y[j][1])
        if b > a:
            out.append((a, b))
        if x[i][1] < y[j][1]:
            i += 1
        else:
            j += 1
    return out


def _subtract(x, cut):
    out = []
    for a, b in x:
        pieces = [(a, b)]
        for c, d in cut:
            nxt = []
            for p, q in pieces:
                if d <= p or c >= q:
                    nxt.append((p, q))
                    continue
                if c > p:
                    nxt.append((p, c))
                if d < q:
                    nxt.append((d, q))
            pieces = nxt
        out.extend(pieces)
    return out


def molecule_track(row, mol=None, blocks=()):
    """(measured reference intervals, {kind: reference intervals}) of one molecule's outputs, as the scan module
    builds its recurrence tracks: inside its regular / disordered / undetermined segments, on its aligned reference
    blocks (``blocks``, the record's; else the decoded molecule's), outside low-information segments."""
    kinds: Dict[str, List[Tuple[int, int]]] = {k: [] for k in ('reg', 'dis', 'und', 'low', 'uds', 'mis')}
    for _ms, _ml, a, b, q, _n in row.groups.get('nucseg') or ():
        if not q or b <= a:
            continue
        k = _STATE_KIND.get(q[0]) or _EVENT_KIND.get(q[0])
        if k:
            kinds[k].append((int(a), int(b)))
    measured = _union(kinds['reg'] + kinds['dis'] + kinds['und'])
    if blocks:
        measured = _intersect(_union(blocks), measured)
    elif mol is not None and getattr(mol, 'blocks', None) is not None:
        measured = _intersect(_union([(int(r0), int(r0 + ln)) for _q0, r0, ln in mol.blocks]), measured)
    measured = _subtract(measured, _union(kinds['low']))
    return measured, kinds


def patch_scores(state, observations: Sequence[dict], patches: Sequence[dict], *, include_duplicates: bool = False,
                 fdr: float = 0.05, min_molecules: int = 3) -> dict:
    """Per observation, per patch: {n, fraction, observed, expected, p} and q (BH over the observation's listed
    patches of the same kind)."""
    from fiberhmm.nuc.enrichment import K_LEVELS, MeasuredTrack, bh, window_test
    from .inputs import browser_read_policy
    policy = browser_read_policy(state, include_duplicates=include_duplicates)
    out = []
    for obs in observations:
        entry: Dict = dict(obsId=obs.get('obsId'), datasetId=obs.get('datasetId'), patches={})
        for patch in patches:
            key = str(patch.get('key') or '')
            kind = PATCH_KIND.get(str(patch.get('type') or ''))
            chrom, s, e = str(patch.get('chrom') or ''), int(patch.get('start') or 0), int(patch.get('end') or 0)
            if not key or not chrom or e <= s:
                continue
            if kind is None:
                entry['patches'][key] = dict(note='Scored by the scan per group (phased and fuzzy patches)')
                continue
            scoped = {**obs, 'chrom': chrom, 'start': s, 'end': e}
            if scoped.get('kind') == 'graph':
                scoped['graph'] = {k: v for k, v in (obs.get('graph') or {}).items() if k == 'hap'}
            try:
                _source, _recs, windows, cfg, cohort, counts = observation_cohort(state, scoped, policy)
            except (ObservationError, ValueError) as error:
                entry['patches'][key] = dict(error=str(error))
                continue
            if not windows:
                entry['patches'][key] = dict(error='Not on this observation (no lift piece of its haplotype covers it)')
                continue
            contig, w0, w1 = window_hull(windows)
            tracks, covered, measured_bp, entering = [], 0, 0, 0
            for rec, row in cohort:
                hit = STORE.get_result(rec.path, rec.sha, rec.occ, cfg.config_for(rec.path)) if cfg is not None else None
                if row.low_information or not same_contig(row.chrom, contig):
                    continue
                measured, kinds = molecule_track(row, hit[0] if hit else None, rec.blocks)
                if not measured:
                    continue
                t = MeasuredTrack(measured)
                t.set_kind(kind, kinds[kind])
                i, j = t.window(w0, w1)
                # The fraction counts every measured base (the scan's per-group fraction); the test counts the
                # molecules measured over at least half the patch (window_test).
                covered += int(t.x[kind][i:j].sum())
                measured_bp += j - i
                if 2 * (j - i) >= (w1 - w0) and j > i:
                    entering += 1
                tracks.append(t)
            res = window_test(tracks, kind, w0, w1, K=K_LEVELS, min_molecules=min_molecules)
            entry['patches'][key] = dict(kind=kind, n=entering,
                                         fraction=(covered / measured_bp) if measured_bp else None,
                                         observed=res['obs'] if res else None, expected=res['exp'] if res else None,
                                         p=res['p'] if res else None, notComputed=counts['missing'])
        # BH per kind across this observation's listed patches.
        by_kind: Dict[str, List[str]] = {}
        for key, v in entry['patches'].items():
            if v.get('p') is not None:
                by_kind.setdefault(v['kind'], []).append(key)
        for kind, keys in by_kind.items():
            rejected = bh([entry['patches'][k]['p'] for k in keys], fdr)
            ps = [entry['patches'][k]['p'] for k in keys]
            qs = _bh_adjusted(ps)
            for k, rej, q in zip(keys, rejected, qs):
                entry['patches'][k]['q'] = q
                entry['patches'][k]['significant'] = bool(rej)
        out.append(entry)
    return dict(fdr=fdr, observations=out)


def _bh_adjusted(p: Sequence[float]) -> List[Optional[float]]:
    """Benjamini-Hochberg adjusted p-values (q-values): the smallest FDR at which each p is rejected."""
    n = len(p)
    order = sorted(range(n), key=lambda i: p[i])
    q = [0.0] * n
    running = 1.0
    for rank in range(n - 1, -1, -1):
        i = order[rank]
        running = min(running, p[i] * n / (rank + 1))
        q[i] = min(1.0, running)
    return q
