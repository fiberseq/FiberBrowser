"""Hub association runs (DESIGN §7, A2): one request -> inputs (``assoc_inputs``) -> ``fiberhmm.assoc`` -> a small JSON.

Modes (DESIGN §7.1) and what each one runs:

- **M1** co-occurrence: ``cooccurrence(A states, B states, molecules)``; groups give the interaction test.
- **M2** state-conditioned response: with ``response.kind = 'phasing'``, ``condition_stats`` on decoded molecules of
  native datasets (open/closed by the NUC 2.3 rule at each anchor, nucleosome phasing R_B − E_null or R_B, anchor
  and molecule frames, matched random backgrounds); with ``response.kind = 'scalar'``, ``condition`` over A's states
  and a per-molecule scalar from the scans (backgrounds: A hits outside an anchor BED, the non-transferable rule).
- **M3** within-molecule rate: ``rate_ratio`` (and ``edge_association``) on the nuc scans' marks.
- **M4** overlap and distance: ``overlap_enrichment`` A->B and B->A in the intersected territory; groups give
  ``overlap_contrast``.

Defaults are FiberHMM's (ASSOC_REPORT "Decisions"): M1 the adjusted score (``test='adjusted'``), 5 kb pairs; 1,000
permutations, role draws, shifts and relocations; 1,000 bootstrap draws; 12 density strata in M2 (inside
FiberHMM); one M4 stratum per contig unless a strata BED is given.

The result keeps FiberHMM's own dict (per-pair and per-anchor rows capped at 5,000) and adds display tables
(``effects``, ``anchors``, ``curve``), the inputs' counts, and ``limits``: plain sentences for what the data can't
answer (no pairs, one state only, refused relocations), which the hub shows instead of numbers.

Jobs run on the scan job manager's executor (one worker, shared with live scans), in a dict of their own.
Cancelling stops the run at the next stage (FiberHMM's functions take no cancel event).
"""
from __future__ import annotations

import contextvars
import threading
import time
import uuid
from typing import Dict, List, Optional

import numpy as np

from .assoc_inputs import (AssocInputError, HitTable, Molecules, anchor_hits, decoded_molecules, group_values,
                           inline_hits, intersect, jsonable, merge_regions, molecule_scalars, molecule_table,
                           qname_of_key, rate_data, read_bed, scan_set_hits, scan_set_states, scan_territory,
                           scope_regions, sv_states)

MODES = ('M1', 'M2', 'M3', 'M4')
MODE_LABELS = {
    'M1': 'Same molecules: is B\'s state linked to A\'s state?',
    'M2': 'Does a measure of the molecules differ when A is open (or bound)?',
    'M3': 'Is B denser inside A than outside, on the same molecules?',
    'M4': 'Are B hits nearer A hits than chance?',
}
UNITS = {'M1': 'pair of hits (A, B) × molecule spanning both', 'M2': 'anchor × molecule',
         'M3': 'molecule × inside / outside A', 'M4': 'hit'}
MAX_ROWS = 5000
_INIT_LOCK = threading.Lock()
MAX_JOBS_KEPT = 24


class Cancelled(Exception):
    pass


# ------------------------------------------------------------------ request
def _num(v, default, lo=None, hi=None, cast=int):
    try:
        x = cast(v)
    except (TypeError, ValueError):
        return default
    if lo is not None:
        x = max(lo, x)
    if hi is not None:
        x = min(hi, x)
    return x


def normalize_request(req: dict) -> dict:
    """The run definition, validated (raises AssocInputError with a message for the user)."""
    if not isinstance(req, dict):
        raise AssocInputError('Request must be an object')
    mode = str(req.get('mode') or '')
    if mode not in MODES:
        raise AssocInputError(f'Choose a mode ({", ".join(MODES)})')
    a = req.get('a') if isinstance(req.get('a'), dict) else None
    if not a:
        raise AssocInputError('Choose feature A')
    b = req.get('b') if isinstance(req.get('b'), dict) else None
    response = req.get('response') if isinstance(req.get('response'), dict) else None
    if mode in ('M1', 'M4') and not b:
        raise AssocInputError('Choose feature B')
    if mode == 'M2' and not response:
        raise AssocInputError('Choose the response (nucleosome phasing, or a per-molecule measure)')
    if mode == 'M3' and not b:
        b = {'kind': 'tf'}
    o = req.get('options') if isinstance(req.get('options'), dict) else {}
    options = dict(
        maxDistance=_num(o.get('maxDistance'), 5000, 0, 1_000_000),
        test='strata' if o.get('test') == 'strata' else 'adjusted',
        density='lambda_acc' if o.get('density') == 'lambda_acc' else 'rho_read',
        nPerm=_num(o.get('nPerm'), 1000, 20, 10_000), nBoot=_num(o.get('nBoot'), 1000, 0, 10_000),
        seed=_num(o.get('seed'), 0, 0, 2 ** 31 - 1),
        frames=[f for f in (o.get('frames') or ['anchor', 'molecule']) if f in ('anchor', 'molecule')] or ['anchor'],
        metric='R' if o.get('metric') == 'R' else 'R_minus_null',
        strataBed=str(o.get('strataBed') or '') or None,
        anchorBed=str(o.get('anchorBed') or '') or None,
        includeDuplicates=bool(o.get('includeDuplicates')),
    )
    group = req.get('group') if isinstance(req.get('group'), dict) else None
    if group and group.get('kind') not in (None, 'none', 'dataset', 'haplotype', 'cluster'):
        raise AssocInputError(f'Unknown group {group.get("kind")!r}')
    scope = req.get('scope') if isinstance(req.get('scope'), dict) else {'kind': 'view'}
    datasets = [str(d) for d in (req.get('datasets') or []) if isinstance(d, str)]
    return dict(mode=mode, a=a, b=b, response=response, group=group if group and group.get('kind') not in (None, 'none') else None,
                scope=scope, datasets=datasets, options=options, label=str(req.get('label') or '')[:200],
                question=str(req.get('question') or '')[:40] or None)


# ------------------------------------------------------------------ gathering
def _gather(state, ref: dict, regions, mols: Molecules, datasets, *, states: bool, label: str) -> HitTable:
    kind = ref.get('kind')
    if kind == 'scan':
        table = scan_set_hits(state, str(ref.get('setId') or ''), regions, label=label)
        if states:
            scan_set_states(state, table, str(ref.get('setId')), mols, datasets or None)
        return table
    if kind == 'inline':
        table = inline_hits(ref, regions, label=label)
        if states:
            if table.type_id == 'var.sv':
                sv_states(state, table, mols, datasets or [], include_duplicates=False)
            else:
                raise AssocInputError(f'{table.label} have no per-molecule states in the hub yet (SVs and scan sets do)')
        return table
    if kind == 'anchors':
        if states:
            raise AssocInputError('An anchor set has positions only, no per-molecule states')
        return anchor_hits(ref, regions)
    raise AssocInputError(f'Unknown feature source {kind!r}')


def _label(ref: Optional[dict]) -> str:
    if not ref:
        return ''
    return str(ref.get('label') or ref.get('typeId') or ref.get('kind') or '')


def _cluster_check(defn: dict, regions, territory=None) -> Optional[dict]:
    g = defn.get('group') or {}
    if g.get('kind') != 'cluster':
        return None
    from fiberhmm.assoc.groups import post_selection_check
    tested = list(regions or territory or [])
    cl = [(str(r[0]), int(r[1]), int(r[2])) for r in g.get('clusterRegions') or [] if len(r) >= 3]
    res = post_selection_check(tested, cl, int(g.get('flank') or 0), bool(g.get('acceptPostSelection')))
    res['clusterRegions'] = len(cl)
    if not cl:
        res['note'] = 'the cluster run names no regions: it could not be checked against the tested window'
    return res


def _strip_group_p(res: dict) -> None:
    """A post-selection contrast is descriptive: no p-values on the group comparison."""
    def walk(x):
        if isinstance(x, dict):
            for k in list(x):
                if k in ('p', 'p_wald', 'p_boot'):
                    x[k] = None
                else:
                    walk(x[k])
        elif isinstance(x, list):
            for v in x:
                walk(v)
    for key in ('interaction',):
        if key in res:
            walk(res[key])
    for b in res.get('bins') or []:
        if 'interaction' in b:
            walk(b['interaction'])


def run(state, defn: dict, progress=None, cancel: Optional[threading.Event] = None) -> dict:
    """Run one association; returns the JSON-able result (``status`` 'ok' | 'refused' | 'empty')."""
    def stage(name, msg):
        if cancel is not None and cancel.is_set():
            raise Cancelled()
        if progress is not None:
            progress(name, msg)

    mode = defn['mode']
    regions = scope_regions(defn['scope'])
    stage('inputs', 'Gathering inputs')
    fn = {'M1': _run_m1, 'M2': _run_m2, 'M3': _run_m3, 'M4': _run_m4}[mode]
    # BLAS threads capped at 4: the machine is shared (permutations are vectorised over numpy).
    with _thread_limits():
        out = fn(state, defn, regions, stage)
    out.setdefault('status', 'ok')
    _strip_rows(out.get('result'))
    out['mode'] = defn['mode']
    out['modeLabel'] = MODE_LABELS[defn['mode']]
    out['unit'] = UNITS[defn['mode']]
    out['scope'] = dict(kind=defn['scope'].get('kind', 'view'),
                        regions=[list(r) for r in (regions or [])][:50], nRegions=len(regions or []))
    return jsonable(out)


def _thread_limits():
    try:
        from threadpoolctl import threadpool_limits
        return threadpool_limits(4)
    except Exception:   # noqa: BLE001 - optional dependency
        import contextlib
        return contextlib.nullcontext()


def _strip_rows(res) -> None:
    """FiberHMM's per-pair and per-anchor rows are in ``anchors`` already: keep only their counts in the raw dict, so
    the run stays small enough to keep with the session."""
    if isinstance(res, dict):
        for key in ('pairs', 'per_anchor', 'hits'):
            if isinstance(res.get(key), list):
                res[f'{key}_rows_moved'] = len(res.pop(key))
        for v in res.values():
            if isinstance(v, dict):
                _strip_rows(v)


def _datasets(state, defn: dict) -> List[str]:
    return [d for d in defn.get('datasets') or [] if d in (getattr(state, 'datasets', None) or {})]


def _run_m1(state, defn, regions, stage):
    from fiberhmm.assoc.cooccur import cooccurrence
    o = defn['options']
    mols = Molecules()
    ds = _datasets(state, defn)
    A = _gather(state, defn['a'], regions, mols, ds, states=True, label=_label(defn['a']))
    same = defn['b'].get('kind') == defn['a'].get('kind') == 'scan' and defn['b'].get('setId') == defn['a'].get('setId')
    B = A if same else _gather(state, defn['b'], regions, mols, ds, states=True, label=_label(defn['b']))
    inputs = dict(a=A.summary(), b=B.summary(), molecules=mols.n)
    limits: List[str] = []
    for t in (A, B):
        if not t.hits:
            limits.append(f'No {t.label} in the scope.')
        elif not t.rows:
            limits.append(f'No molecule has a state for any of the {len(t.hits)} {t.label} in the scope.')
    if limits:
        return dict(status='empty', limits=limits, inputs=inputs)
    vals, gkind, ginfo = group_values(state, mols, defn.get('group'), regions)
    check = _cluster_check(defn, regions)
    if check and check['status'] == 'refused':
        return dict(status='refused', postSelection=check, inputs=inputs,
                    limits=['The cluster run used features inside the tested window or its flanks, so comparing its '
                            'clusters here is circular. Accept a "post-selection" label to see the numbers without '
                            'p-values.'])
    labels = {'group': vals} if vals is not None else {}
    stage('inputs', 'Molecule covariates')
    mt, covinfo = molecule_table(state, mols, regions, density=o['density'], labels=labels)
    inputs['covariates'] = covinfo
    inputs['group'] = ginfo
    stage('compute', 'M1: co-occurrence (pairs, pooled score, bootstrap)')
    FA = A.feature_states()
    FB = FA if B is A else B.feature_states()
    res = cooccurrence(FA, FB, mt, max_distance=o['maxDistance'], group='group' if vals is not None else None,
                       group_kind=gkind, test=o['test'], n_boot=o['nBoot'], seed=o['seed'], max_pair_rows=MAX_ROWS)
    if check and check['status'] == 'post-selection':
        _strip_group_p(res)
    stage('store', 'Summarising')
    more, no_contrast = _m1_limits(res, A, B, mols)
    limits += more
    effects = _m1_effects(res)
    out = dict(result=res, inputs=inputs, limits=limits, postSelection=check, effects=effects,
               anchors=_m1_rows(res, A, B), cli=_cli_line(defn, A, B))
    if no_contrast:
        # One state only: FiberHMM still returns an odds ratio (1 by construction), which answers nothing here.
        for e in effects:
            e.update(estimate=None, lo=None, hi=None, p=None, note='no contrast')
        out['status'] = 'empty'
    return out


def _m1_limits(res, A, B, mols):
    """(plain sentences on what the data can't answer, whether A or B has one state only)."""
    out = []
    if res.get('n_pairs_found', 0) == 0:
        out.append(f'No B hit lies within {res.get("max_distance", 5000):,} bp of an A hit in the scope: nothing to pair.')
        return out, False
    pairs = res.get('pairs') or []
    tested = res.get('n_pairs_tested', 0)
    if tested == 0:
        out.append('Every A–B pair overlaps and is of one kind, so none is tested.')
    pooled = res.get('pooled') or {}
    n = pooled.get('n_molecules') or 0
    if tested and not n:
        out.append('No molecule carries states for both A and B of any pair (each pair needs at least 5 molecules '
                   'with both states).')
    # One state only: the question needs molecules in both states of A (and of B).
    a1 = sum((p.get('table') or [0, 0, 0, 0])[0] + (p.get('table') or [0, 0, 0, 0])[1] for p in pairs)
    a0 = sum((p.get('table') or [0, 0, 0, 0])[2] + (p.get('table') or [0, 0, 0, 0])[3] for p in pairs)
    b1 = sum((p.get('table') or [0, 0, 0, 0])[0] + (p.get('table') or [0, 0, 0, 0])[2] for p in pairs)
    b0 = sum((p.get('table') or [0, 0, 0, 0])[1] + (p.get('table') or [0, 0, 0, 0])[3] for p in pairs)
    if pairs and (a1 == 0 or a0 == 0):
        which = 'state 1' if a0 == 0 else 'state 0'
        extra = ' (every spanning molecule carries it: no reference molecules)' if A.type_id == 'var.sv' and a0 == 0 else ''
        out.append(f'Every molecule with both states has A in {which}{extra}: there is no contrast, so this data '
                   f'can\'t answer the question ({a1} in state 1, {a0} in state 0 across the tested pairs).')
    elif pairs and (b1 == 0 or b0 == 0):
        out.append(f'Every molecule with both states has B in {"state 1" if b0 == 0 else "state 0"}: there is no '
                   f'contrast ({b1} in state 1, {b0} in state 0 across the tested pairs).')
    elif pairs and n and n < 20:
        out.append(f'Only {n} molecules carry both states: the estimate is very uncertain.')
    if not np.isfinite(pooled.get('or') if pooled.get('or') is not None else np.nan) and pairs and not out:
        out.append('The odds ratio is not estimable (separation: one cell of the 2 × 2 tables is empty).')
    no_contrast = bool(pairs) and (a1 == 0 or a0 == 0 or b1 == 0 or b0 == 0)
    return out, no_contrast


def _m1_effects(res) -> List[dict]:
    rows = []
    p = res.get('pooled') or {}
    rows.append(dict(key='pooled', label='Pooled (all pairs)', estimate=p.get('or'), lo=p.get('or_lo'), hi=p.get('or_hi'),
                     p=p.get('p'), n=p.get('n_molecules'), scale='odds ratio', test=p.get('test'),
                     detail=dict(pairs=p.get('n_pairs'), p_b1_given_a1=p.get('p_b1_given_a1'),
                                 p_b1_given_a0=p.get('p_b1_given_a0'))))
    mh = p.get('mh_strata') or {}
    if mh:
        rows.append(dict(key='mh', label='Pooled, design strata (MH)', estimate=mh.get('or'), lo=mh.get('or_lo'),
                         hi=mh.get('or_hi'), p=mh.get('p'), n=mh.get('n_molecules'), scale='odds ratio', descriptive=True))
    for g, v in (res.get('groups') or {}).items():
        rows.append(dict(key=f'group:{g}', label=str(g), group=str(g), estimate=v.get('or'), lo=v.get('or_lo'),
                         hi=v.get('or_hi'), p=v.get('p'), n=v.get('n_molecules'), scale='odds ratio',
                         detail=dict(p_b1_given_a1=v.get('p_b1_given_a1'), p_b1_given_a0=v.get('p_b1_given_a0'))))
    if res.get('unphased'):
        u = res['unphased']
        rows.append(dict(key='unphased', label='Unphased (not in the contrast)', group='unphased', estimate=u.get('or'),
                         n=u.get('n_molecules'), scale='odds ratio', descriptive=True))
    return rows


def _m1_rows(res, A, B) -> List[dict]:
    out = []
    for r in (res.get('pairs') or [])[:MAX_ROWS]:
        out.append(dict(id=f'{r.get("a")}|{r.get("b")}', chrom=r.get('chrom'), pos=r.get('a_anchor'), pos2=r.get('b_anchor'),
                        a=r.get('a'), b=r.get('b'), estimate=r.get('or_mh'), lo=r.get('or_lo'), hi=r.get('or_hi'),
                        p=r.get('p_exact'), q=r.get('q'), n=r.get('n'), table=r.get('table'),
                        p_b1_given_a1=r.get('p_b1_given_a1'), p_b1_given_a0=r.get('p_b1_given_a0'),
                        distance=r.get('distance'), nested=r.get('nested') or None,
                        excludedNoB=r.get('excluded_no_b_state'), excludedNoA=r.get('excluded_no_a_state')))
    return out


def _run_m2(state, defn, regions, stage):
    resp = defn['response'] or {}
    if resp.get('kind') == 'phasing':
        return _run_m2_phasing(state, defn, regions, stage)
    if resp.get('kind') == 'scalar':
        return _run_m2_scalar(state, defn, regions, stage)
    raise AssocInputError('Unknown response')


def _anchor_datasets(state, defn, A: HitTable) -> List[str]:
    ds = _datasets(state, defn)
    if ds:
        return ds
    if A.scan is not None:
        out = []
        for _sid, bid, _via, _f in A.scan.bound_pairs():
            if getattr(state.datasets.get(bid), 'data_type', None) == 'bam' and bid not in out:
                out.append(bid)
        if out:
            return out
    return [k for k, d in (getattr(state, 'datasets', None) or {}).items() if getattr(d, 'data_type', None) == 'bam']


def _run_m2_phasing(state, defn, regions, stage):
    from fiberhmm.assoc.nucleosome import condition_stats
    from fiberhmm.nuc.params import DEFAULT_PARAMS
    o = defn['options']
    mols_index = Molecules()
    A = _gather(state, defn['a'], regions, mols_index, [], states=False, label=_label(defn['a']))
    inputs = dict(a=A.summary())
    if not A.hits:
        return dict(status='empty', inputs=inputs, limits=[f'No {A.label} in the scope to use as anchors.'])
    datasets = _anchor_datasets(state, defn, A)
    if not datasets:
        return dict(status='empty', inputs=inputs, limits=['No native dataset is loaded to measure phasing in.'])
    # Molecules over the scope (and each anchor's flanks): matched random backgrounds are drawn where molecules are,
    # at least 2 x span from every anchor, so the windows must reach well past the anchors.
    span = int(DEFAULT_PARAMS.phase_x0 + DEFAULT_PARAMS.phase_summary_periods * 200)
    pad = 10 * span
    windows = merge_regions([(h['chrom'], max(0, h['anchor'] - pad), h['anchor'] + pad) for h in A.hits]
                            + [(c, max(0, a - 3 * span), b + 3 * span) for c, a, b in (regions or [])])
    stage('inputs', f'Decoding molecules of {len(datasets)} dataset(s) (and the nucleosome calibration)')
    decoded = decoded_molecules(state, datasets, windows)
    molecules = [m for ms, _cal in decoded.values() for m in ms]
    if not molecules:
        return dict(status='empty', inputs=inputs, limits=['No molecule of the chosen datasets covers the anchors.'])
    first = next(iter(decoded))
    cal = decoded[first][1]
    anchors = [(h['chrom'], int(h['anchor'])) for h in A.hits]
    # anchors in the BAM's contig naming (chr1 / 1)
    from services.nuc.observations import frame_chrom
    anchors = [(frame_chrom(molecules, c), p) for c, p in anchors]
    g = defn.get('group') or {}
    labels, group, gkind, ginfo = None, None, 'label', {}
    names = {ds_id: getattr(d, 'label', ds_id) for ds_id, d in state.datasets.items()}
    if g.get('kind') == 'dataset':
        labels, group = {'group': lambda m: names.get((m.meta or {}).get('dataset'), (m.meta or {}).get('dataset'))}, 'group'
        ginfo = dict(kind='dataset')
    elif g.get('kind') == 'haplotype':
        labels, group, gkind = {'group': lambda m: f'HP{m.hp}' if m.hp not in (None, 0) else None}, 'group', 'haplotype'
        ginfo = dict(kind='haplotype', phased=sum(1 for m in molecules if m.hp not in (None, 0)),
                     unphased=sum(1 for m in molecules if m.hp in (None, 0)))
    elif g.get('kind') == 'cluster':
        lab = {}
        for ds_key, by_read in (g.get('labels') or {}).items():
            for rid, v in (by_read or {}).items():
                lab[(str(ds_key), qname_of_key(rid))] = str(v)
        labels, group = {'group': lambda m: lab.get(((m.meta or {}).get('dataset'), m.name))}, 'group'
        ginfo = dict(kind='cluster', labelled=sum(1 for m in molecules if ((m.meta or {}).get('dataset'), m.name) in lab))
    check = _cluster_check(defn, regions)
    if check and check['status'] == 'refused':
        return dict(status='refused', postSelection=check, inputs=inputs,
                    limits=['The cluster run used features inside the tested window or its flanks: comparing its '
                            'clusters here is circular.'])
    inputs.update(datasets=datasets, molecules=len(molecules), anchors=len(anchors), group=ginfo,
                  calibration=dict(dataset=first, nrlPooled=getattr(cal, 'nrl_pooled', None)))
    stage('compute', f'M2: phasing at {len(anchors)} anchors ({", ".join(o["frames"])} frame), matched backgrounds')
    res = condition_stats(molecules, anchors, cal=cal, frames=tuple(o['frames']), backgrounds='random', k=5,
                          metrics=(o['metric'],), group=group, group_kind=gkind, labels=labels, n_perm=o['nPerm'],
                          n_role=o['nPerm'], n_boot=o['nBoot'], seed=o['seed'])
    if check and check['status'] == 'post-selection':
        for fr in (res.get('frames') or {}).values():
            for met in (fr.get('metrics') or {}).values():
                _strip_group_p(met)
    stage('store', 'Summarising')
    effects, rows, limits = [], [], []
    hit_at = {(c, p): h['hitId'] for (c, p), h in zip(anchors, A.hits)}
    for frame, fr in (res.get('frames') or {}).items():
        for name, met in (fr.get('metrics') or {}).items():
            effects += _m2_effects(met, f'{frame} frame · {name}')
            rows += [dict(r, frame=frame, metric=name, hitId=hit_at.get((r.get('chrom'), r.get('pos'))))
                     for r in _m2_rows(met)]
    limits += _m2_limits(res, len(anchors))
    if len(decoded) > 1:
        inputs['note'] = f'The nucleosome repeat length and prior come from {names.get(first, first)}\'s calibration.'
    return dict(result=res, inputs=inputs, effects=effects, anchors=rows[:MAX_ROWS], limits=limits, postSelection=check)


def _m2_effects(met: dict, prefix: str) -> List[dict]:
    rows = []
    for b in met.get('bins') or []:
        label = f'{prefix} · bin {b.get("bin")}'
        for key, name, pkey in (('delta_anchor', 'Δ anchor (open − closed)', 'p_within_anchor'),
                                ('delta_site', 'Δ site (anchors − backgrounds)', 'p_site'),
                                ('site_state1', 'open: anchors − backgrounds', 'p_site_state1'),
                                ('site_state0', 'closed: anchors − backgrounds', 'p_site_state0')):
            if key not in b:
                continue
            ci = b.get(f'{key}_ci') or {}
            rows.append(dict(key=f'{prefix}|{b.get("bin")}|{key}', label=f'{label} · {name}', estimate=b.get(key),
                             lo=ci.get('lo'), hi=ci.get('hi'), p=b.get(pkey), n=b.get('n_anchors'),
                             scale='difference', detail=dict(sets=b.get('n_sets'), molecules=b.get('n_anchor_molecules'),
                                                            backgrounds=b.get('n_backgrounds'))))
        for g, v in (b.get('groups') or {}).items():
            for key in ('delta_site', 'delta_anchor'):
                if key in v:
                    ci = v.get(f'{key}_ci') or {}
                    rows.append(dict(key=f'{prefix}|{b.get("bin")}|{g}|{key}', label=f'{label} · {g} · {key.replace("_", " ")}',
                                     group=str(g), estimate=v.get(key), lo=ci.get('lo'), hi=ci.get('hi'),
                                     p=v.get('p_site' if key == 'delta_site' else 'p_within_anchor'),
                                     n=v.get('n_anchors'), scale='difference'))
                    break
        if b.get('interaction'):
            rows.append(dict(key=f'{prefix}|{b.get("bin")}|interaction', label=f'{label} · group difference',
                             interaction=b['interaction'], scale='difference'))
    return rows


def _m2_rows(met: dict) -> List[dict]:
    return [dict(id=f'{r.get("locus")}|{r.get("bin")}', chrom=r.get('chrom'), pos=r.get('pos'), bin=r.get('bin'),
                 estimate=r.get('delta'), se=r.get('se_perm'), p=r.get('p'), q=r.get('q'), shrunk=r.get('delta_shrunk'),
                 n1=r.get('n_state1'), n0=r.get('n_state0')) for r in met.get('per_anchor') or []]


def _m2_limits(res, n_anchors) -> List[str]:
    out = []
    bg = res.get('backgrounds') or {}
    for frame, fr in (res.get('frames') or {}).items():
        for name, met in (fr.get('metrics') or {}).items():
            bins = met.get('bins') or []
            if not bins or all((b.get('n_anchors') or 0) == 0 for b in bins):
                out.append(f'{frame} frame: no anchor has molecules in both states (open and closed) with the flanks '
                           'measured, so nothing can be compared.')
            elif all('delta_site' not in b for b in bins):
                out.append(f'{frame} frame: no anchor got matched backgrounds, so Δ site (anchors against matched '
                           'random sites) is not tested; Δ anchor is.')
            break
    if bg.get('shortfall'):
        out.append(f'{bg["shortfall"]} of {n_anchors} anchors found fewer than 5 matched backgrounds (none relaxed).')
    return list(dict.fromkeys(out))


def _run_m2_scalar(state, defn, regions, stage):
    from fiberhmm.assoc import strata as ST
    from fiberhmm.assoc.background import matched_backgrounds
    from fiberhmm.assoc.condition import Appearances, LocusTable, condition, mean_metric
    o = defn['options']
    resp = defn['response']
    module, column = str(resp.get('module') or ''), str(resp.get('column') or '')
    if module not in ('nuc', 'nfr') or not column:
        raise AssocInputError('The response is a per-molecule measure of a scan: nuc (e.g. nrl) or nfr (openness)')
    mols = Molecules()
    ds = _datasets(state, defn)
    A = _gather(state, defn['a'], regions, mols, ds, states=True, label=_label(defn['a']))
    inputs = dict(a=A.summary(), response=f'{module}:{column}')
    if not A.rows:
        return dict(status='empty', inputs=inputs, limits=[f'No molecule has a state for the {A.label} in the scope.'])
    stage('inputs', 'Molecule measures')
    y = molecule_scalars(state, mols, module, [column], regions)[column]
    dens = molecule_scalars(state, mols, 'nuc', [o['density']], regions)[o['density']]
    if not np.isfinite(y).any():
        return dict(status='empty', inputs=inputs,
                    limits=[f'No molecule has {module}:{column}: open or run a {module} scan in table mode of these datasets.'])
    vals, gkind, ginfo = group_values(state, mols, defn.get('group'), regions)
    n = len(A.hits)
    hit = np.array([r[0] for r in A.rows], np.int64)
    st = np.array([r[2] for r in A.rows], np.int64)
    depth = np.bincount(hit, minlength=n).astype(float)
    prev = np.bincount(hit, weights=st, minlength=n) / np.maximum(depth, 1)
    order = np.arange(n)
    if o.get('anchorBed'):
        bed = read_bed(o['anchorBed'])
        inside = np.array([any(c == A.hits[i]['chrom'] and a <= A.hits[i]['anchor'] < b for c, a, b in bed) for i in order], bool)
        anchors, cands = order[inside], order[~inside]
        if not len(anchors):
            raise AssocInputError(f'No {A.label} lies in the anchor BED')
    else:
        anchors, cands = order, order[:0]
    mb = matched_backgrounds([(A.hits[i]['chrom'], A.hits[i]['anchor']) for i in anchors],
                             [(A.hits[j]['chrom'], A.hits[j]['anchor']) for j in cands],
                             anchor_covariates={'prevalence': prev[anchors], 'depth': depth[anchors]},
                             candidate_covariates={'prevalence': prev[cands], 'depth': depth[cands]},
                             k=5, n_bins=10, min_sep=3000, seed=o['seed'])
    loci = LocusTable.from_sets([(A.hits[i]['chrom'], A.hits[i]['anchor']) for i in anchors],
                                [(A.hits[j]['chrom'], A.hits[j]['anchor']) for j in cands], mb['sets'])
    hit_of_locus = list(anchors) + [cands[j] for _a, js in mb['sets'] for j in js]
    by_hit: Dict[int, List[tuple]] = {}
    for h, m, s in A.rows:
        by_hit.setdefault(h, []).append((m, s))
    L, M, S = [], [], []
    for li, h in enumerate(hit_of_locus):
        for m, s in by_hit.get(int(h), ()):
            L.append(li); M.append(m); S.append(s)
    M = np.array(M, np.int64)
    ok = np.isfinite(y[M])
    stats = np.stack([np.where(ok, y[M], 0.0), ok.astype(float)], -1)[:, None, :]
    stratum = ST.density_bins(dens[M], 12)
    labels = {}
    if vals is not None:
        labels['group'] = vals[M]
    app = Appearances(np.array(L), M, np.array(S), stratum, ok.astype(np.int64), stats, labels, density=dens[M])
    stage('compute', f'M2: {module}:{column} by state at {len(anchors)} anchors')
    res = condition(app, loci, mean_metric(f'mean {column}'), bins=['molecule'], n_perm=o['nPerm'], n_role=o['nPerm'],
                    n_boot=o['nBoot'], group='group' if vals is not None else None, group_kind=gkind, seed=o['seed'])
    res['backgrounds'] = {k: v for k, v in mb.items() if k != 'sets'}
    res['backgrounds']['rule'] = ('other hits of the same type outside the anchor BED (the non-transferable rule), '
                                  'matched on prevalence and depth deciles' if o.get('anchorBed') else 'none (no anchor BED)')
    inputs['group'] = ginfo
    inputs['molecules'] = mols.n
    limits = _m2_limits({'frames': {'molecule': {'metrics': {column: res}}}, 'backgrounds': res['backgrounds']}, len(anchors))
    if not o.get('anchorBed'):
        limits.append('Every A hit is an anchor (no anchor BED): Δ site needs anchors and other hits as their matched '
                      'backgrounds, so only Δ anchor is tested.')
    hit_at = {(h['chrom'], h['anchor']): h['hitId'] for h in A.hits}
    rows = [dict(r, hitId=hit_at.get((r.get('chrom'), r.get('pos')))) for r in _m2_rows(res)[:MAX_ROWS]]
    return dict(result=res, inputs=inputs, effects=_m2_effects(res, f'{module}:{column}'), anchors=rows,
                limits=list(dict.fromkeys(limits)))


def _run_m3(state, defn, regions, stage):
    from fiberhmm.assoc.rate import edge_association, rate_ratio
    o = defn['options']
    a_type = str(defn['a'].get('typeId') or defn['a'].get('markType') or '')
    b = defn['b'] or {'kind': 'tf'}
    b_kind = 'tf' if b.get('kind') == 'tf' else str(b.get('typeId') or '')
    ds = _datasets(state, defn)
    stage('inputs', 'Reading nucleosome marks')
    d, mols, order, used = rate_data(state, a_type, b_kind, regions, ds or None)
    vals, gkind, ginfo = group_values(state, mols, defn.get('group'), regions)
    inputs = dict(a=dict(type=a_type, label=_label(defn['a'])), b=dict(type=b_kind, label=_label(b) or 'TF footprint centres'),
                  molecules=int(d.n), scans=used, group=ginfo)
    check = _cluster_check(defn, regions)
    if check and check['status'] == 'refused':
        return dict(status='refused', postSelection=check, inputs=inputs,
                    limits=['The cluster run used features inside the tested window or its flanks: comparing its '
                            'clusters here is circular.'])
    group = None
    if vals is not None:
        d.labels['group'] = np.array([vals[i] if i is not None else None for i in order], dtype=object)
        group = 'group'
    stage('compute', f'M3: rate ratio over {d.n} molecules ({o["nPerm"]} circular shifts)')
    res = rate_ratio(d, n_shift=o['nPerm'], n_boot=o['nBoot'], group=group, group_kind=gkind, seed=o['seed'])
    res['coordinate'] = ('admissible reference bp (HUB 7.5): nucseg segments minus low-information; scan tables '
                         'carry no per-site informativeness')
    try:
        res['edges'] = edge_association(d, n_shift=o['nPerm'], seed=o['seed'] + 7)
    except Exception as error:   # noqa: BLE001 - edges are a secondary readout
        res['edges'] = dict(error=str(error))
    if check and check['status'] == 'post-selection':
        _strip_group_p(res)
    stage('store', 'Summarising')
    effects = [dict(key='all', label='All molecules', estimate=res.get('rate_ratio'), lo=res.get('rate_ratio_lo'),
                    hi=res.get('rate_ratio_hi'), p=res.get('p_shift'), n=res.get('n_molecules'), scale='rate ratio',
                    detail=dict(p_depleted=res.get('p_depleted'), p_enriched=res.get('p_enriched'), O_in=res.get('O_in'),
                                O_out=res.get('O_out'), E_in=res.get('E_in'), E_out=res.get('E_out')))]
    for g, v in (res.get('groups') or {}).items():
        effects.append(dict(key=f'group:{g}', label=str(g), group=str(g), estimate=v.get('rate_ratio'),
                            lo=v.get('rate_ratio_lo'), hi=v.get('rate_ratio_hi'), p=v.get('p_shift'),
                            n=v.get('n_molecules'), scale='rate ratio'))
    if res.get('unphased'):
        u = res['unphased']
        effects.append(dict(key='unphased', label='Unphased (not in the contrast)', group='unphased',
                            estimate=u.get('rate_ratio'), n=u.get('n_molecules'), scale='rate ratio', descriptive=True))
    if isinstance(res.get('edges'), dict) and res['edges'].get('mean_distance') is not None:
        e = res['edges']
        effects.append(dict(key='edges', label='Edges: distance from A boundaries to the nearest B', estimate=e.get('mean_distance'),
                            p=e.get('p_two_sided'), scale='bp', descriptive=False,
                            detail=dict(null_mean=e.get('null_mean_distance'), p_closer=e.get('p_closer'))))
    limits = []
    if res.get('status') == 'no informative molecules':
        limits.append('No molecule has measured bases both inside and outside A: nothing to compare.')
    if res.get('O_in') is not None and (res.get('O_in') or 0) + (res.get('O_out') or 0) == 0:
        limits.append('No B point falls on any molecule\'s measured bases.')
    return dict(result=res, inputs=inputs, effects=effects, anchors=[], limits=limits, postSelection=check)


def _hits_by_dataset(state, table: HitTable) -> Dict[str, List[dict]]:
    """B hits present in each browser dataset (a positive per-dataset value), for M4 group contrasts."""
    names = {ds_id: getattr(d, 'label', ds_id) for ds_id, d in state.datasets.items()}
    out: Dict[str, List[dict]] = {}
    binds = {}
    if table.scan is not None:
        for sid, bid, _via, _f in table.scan.bound_pairs():
            binds.setdefault(sid, bid)
    for h in table.hits:
        for col, roles in (h.get('columns') or {}).items():
            if col == 'all':
                continue
            ds = col[3:] if col.startswith('ds:') else binds.get(col.split(':', 1)[0]) if table.scan is not None else None
            if not ds:
                continue
            v = [((roles or {}).get(k) or {}).get('v') for k in ('prevalence', 'strength')]
            if any(x is not None and x > 0 for x in v):
                out.setdefault(names.get(ds, ds), []).append(h)
    return out


def _run_m4(state, defn, regions, stage):
    from fiberhmm.assoc.overlap import overlap_contrast, overlap_enrichment
    o = defn['options']
    mols = Molecules()
    A = _gather(state, defn['a'], regions, mols, [], states=False, label=_label(defn['a']))
    B = _gather(state, defn['b'], regions, mols, [], states=False, label=_label(defn['b']))
    # Hits inside an insertion have no extent on this genome: left out (absent here, never a miss).
    for t in (A, B):
        n_ins = sum(1 for h in t.hits if h.get('insertion'))
        if n_ins:
            t.hits = [h for h in t.hits if not h.get('insertion')]
            t.notes.append(f'{n_ins} hits inside an insertion have no place on this genome: left out of M4')
    inputs = dict(a=A.summary(), b=B.summary())
    if not A.hits or not B.hits:
        return dict(status='empty', inputs=inputs,
                    limits=[f'No {t.label} in the scope.' for t in (A, B) if not t.hits])
    ta, na = (A.territory, A.territory_note) if A.territory else scan_territory(A, regions)
    tb, nb = (B.territory, B.territory_note) if B.territory else scan_territory(B, regions)
    parts = [ta, tb] + ([list(regions)] if regions is not None else [])
    terr = intersect(*parts)
    inputs['territory'] = dict(a=na, b=nb, bp=int(sum(e - s for _c, s, e in terr)), intervals=len(terr))
    if not terr:
        return dict(status='empty', inputs=inputs, limits=['A\'s and B\'s territories don\'t overlap in the scope.'])
    strata = None
    if o.get('strataBed'):
        strata = [(c, int(s), int(e), lab) for c, s, e, lab in
                  (line.split()[:4] for line in open(o['strataBed']).read().splitlines()
                   if line.strip() and not line.startswith('#') and len(line.split()) >= 4)]
    inputs['strata'] = 'strata BED' if strata else 'one stratum per contig (no coverage or site-density strata given)'
    HA, HB = A.hitset(), B.hitset()
    stage('compute', f'M4: A→B, {o["nPerm"]} relocations')
    ab = overlap_enrichment(HA, HB, terr, strata, n_relocations=o['nPerm'], seed=o['seed'])
    stage('compute', f'M4: B→A, {o["nPerm"]} relocations')
    ba = overlap_enrichment(HB, HA, terr, strata, n_relocations=o['nPerm'], seed=o['seed'] + 1)
    res = {'A->B': ab, 'B->A': ba, 'territory_bp': inputs['territory']['bp']}
    g = defn.get('group') or {}
    if g.get('kind') == 'dataset':
        by = _hits_by_dataset(state, B)
        if len(by) >= 2:
            stage('compute', 'M4: group contrast (bootstrap over A clusters)')
            res['contrast'] = overlap_contrast(HA, {k: B.hitset(v) for k, v in sorted(by.items())}, terr, strata,
                                               n_boot=o['nBoot'], seed=o['seed'] + 2)
            res['contrast']['groups_from'] = 'B hits with a positive value in each dataset'
        else:
            res['contrast'] = dict(status='needs two groups',
                                   message='B has per-dataset values in fewer than two datasets: no contrast')
    elif g.get('kind') in ('haplotype', 'cluster'):
        res['contrast'] = dict(status='not available', message='M4 compares hit sets; group B by dataset (haplotype '
                               'and cluster groups apply to per-molecule modes M1–M3)')
    stage('store', 'Summarising')
    limits = []
    for name, r in (('A→B', ab), ('B→A', ba)):
        if r.get('status') in ('refused', 'empty'):
            limits.append(f'{name}: {r.get("message") or r.get("status")}')
        elif r.get('global_p') is None and r.get('message'):
            limits.append(f'{name}: {r["message"]}')
    effects = []
    for name, r in (('A→B', ab), ('B→A', ba)):
        rows = r.get('rows') or []
        best = max((x for x in rows if x.get('z') is not None), key=lambda x: abs(x['z']), default=None)
        effects.append(dict(key=name, label=f'{name}: global test (max |z| over distances)', estimate=r.get('global_stat'),
                            p=r.get('global_p'), n=r.get('n_a_used'), scale='max |z|', status=r.get('status'),
                            detail=dict(bestDistance=best.get('d') if best else None,
                                        bestOE=best.get('o_over_e') if best else None, clusters=r.get('n_clusters'))))
    curve = {name: dict(rows=r.get('rows') or [], histogram=r.get('histogram'), status=r.get('status'))
             for name, r in (('A->B', ab), ('B->A', ba))}
    rows = []
    for r in (ab.get('rows') or []):
        rows.append(dict(id=f'd{r.get("d")}', d=r.get('d'), observed=r.get('observed'), null_mean=r.get('null_mean'),
                         estimate=r.get('o_over_e'), z=r.get('z'), p=r.get('p_descriptive'), n=r.get('n_used')))
    return dict(result=res, inputs=inputs, effects=effects, anchors=[], curve=curve, distances=rows, limits=limits)


def _cli_line(defn: dict, A: HitTable, B: HitTable) -> Optional[str]:
    """The equivalent ``fiberhmm-scan assoc`` line when A and B come from one opened table-mode scan."""
    if A.scan is None or B.scan is None or A.scan is not B.scan or A.scan.source == 'cache':
        return None
    mode = {'M1': 'cooccur', 'M2': 'condition', 'M3': 'rate', 'M4': 'overlap'}[defn['mode']]
    args = ['fiberhmm-scan', 'assoc', str(A.scan.path), '--mode', mode, '--a', A.type_id, '--b', B.type_id]
    for c, s, e in scope_regions(defn['scope']) or []:
        args += ['--region', f'{c}:{s}-{e}']
    g = (defn.get('group') or {}).get('kind')
    if g in ('dataset', 'haplotype'):
        args += ['--group', g]
    o = defn['options']
    if o['maxDistance'] != 5000:
        args += ['--max-distance', str(o['maxDistance'])]
    if o['test'] != 'adjusted':
        args += ['--test', o['test']]
    args += ['-o', 'assoc_out/']
    import shlex
    return ' '.join(shlex.quote(a) for a in args)


# ------------------------------------------------------------------ jobs
def _session(state):
    with _INIT_LOCK:
        if 'assoc_jobs' not in state.__dict__:
            state.assoc_jobs = {}
            state.assoc_jobs_lock = threading.RLock()
    return state.assoc_jobs, state.assoc_jobs_lock


def _summary(job: dict, with_result: bool = True) -> dict:
    out = {k: v for k, v in job.items() if not k.startswith('_')}
    if not with_result:
        out.pop('result', None)
    return out


def submit(state, request: dict, *, runner=None) -> dict:
    """Validate and queue an association run on the scan job executor; returns the job summary."""
    from services.consensus_progress import finish_progress, update_progress
    from services.scan.jobs import _EXECUTOR
    defn = normalize_request(request)
    jobs, lock = _session(state)
    with lock:
        if any(j['status'] in ('queued', 'running', 'cancelling') for j in jobs.values()):
            raise AssocInputError('An association is already running in this session: wait for it or cancel it')
        job_id = uuid.uuid4().hex[:12]
        job = dict(job_id=job_id, status='queued', stage='queued', message='Queued', created_at=time.time(),
                   mode=defn['mode'], definition=defn, _cancel=threading.Event())
        jobs[job_id] = job
        for old in sorted(jobs.values(), key=lambda j: j['created_at'])[:-MAX_JOBS_KEPT]:
            if old['status'] not in ('queued', 'running', 'cancelling'):
                jobs.pop(old['job_id'], None)

    def progress(stage, message):
        with lock:
            update_progress(job, stage, str(message))

    def worker():
        try:
            with lock:
                if job['_cancel'].is_set():
                    raise Cancelled()
                job['status'] = 'running'
                update_progress(job, 'starting', 'Starting')
            result = (runner or run)(state, defn, progress, job['_cancel'])
            with lock:
                if job['_cancel'].is_set():
                    raise Cancelled()
                job['result'] = result
                job['status'] = 'complete'
                job['message'] = 'Done'
                finish_progress(job)
        except Cancelled:
            with lock:
                job['status'] = 'cancelled'
                job['message'] = 'Cancelled'
        except AssocInputError as error:
            with lock:
                job['status'] = 'error'
                job['message'] = job['error'] = str(error)
        except BaseException as error:   # noqa: BLE001 - the job records every failure
            with lock:
                job['status'] = 'error'
                job['message'] = job['error'] = f'{type(error).__name__}: {error}' if str(error) else type(error).__name__
        finally:
            with lock:
                job['finished_at'] = time.time()

    job['_future'] = _EXECUTOR.submit(contextvars.copy_context().run, worker)
    return _summary(job)


def get_job(state, job_id: str) -> dict:
    jobs, lock = _session(state)
    with lock:
        job = jobs.get(job_id)
        if job is None:
            raise KeyError(job_id)
        return _summary(job)


def list_jobs(state) -> list:
    jobs, lock = _session(state)
    with lock:
        return [_summary(j, with_result=False) for j in sorted(jobs.values(), key=lambda j: j['created_at'])]


def cancel(state, job_id: str) -> dict:
    jobs, lock = _session(state)
    with lock:
        job = jobs.get(job_id)
        if job is None:
            raise KeyError(job_id)
        if job['status'] in ('queued', 'running'):
            job['_cancel'].set()
            job['status'] = 'cancelling'
            job['message'] = 'Cancelling at the next stage'
        return _summary(job, with_result=False)


def dispose_session(state) -> None:
    """A session is being imported: cancel this workspace's association runs (their results never land)."""
    jobs, lock = _session(state)
    with lock:
        for job in jobs.values():
            if job['status'] in ('queued', 'running', 'cancelling'):
                job['_cancel'].set()
                job['status'] = 'cancelling'
                job['message'] = 'Cancelled: another session was opened'


def wait(state, job_id: str, timeout: Optional[float] = None) -> dict:
    jobs, lock = _session(state)
    with lock:
        future = jobs[job_id].get('_future')
    if future is not None:
        future.result(timeout=timeout)
    return get_job(state, job_id)


def describe() -> dict:
    """Modes, their labels and units, and the defaults (for the builder)."""
    return dict(modes=[dict(mode=m, label=MODE_LABELS[m], unit=UNITS[m]) for m in MODES],
                defaults=dict(maxDistance=5000, test='adjusted', density='rho_read', nPerm=1000, nBoot=1000, seed=0,
                              frames=['anchor', 'molecule'], metric='R_minus_null'))
