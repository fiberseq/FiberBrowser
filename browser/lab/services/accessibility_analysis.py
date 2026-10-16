"""Accessibility (preview): analysis views of a finished NFR run (EXPERIMENTAL).

The read-level math is FiberHMM's (``fiberhmm.inference.accessibility.analysis``): pair and combination splits with
the tests' own eligibility, size/edge/V-plot arrays, phasing, frozen-catalogue prevalence. This module adds what needs
the browser: read names per dataset (the read panel groups by name), the reference sequence (motif map, sequence
features) through the app's motif scanner (JASPAR CORE via pyjaspar, ``services.motifs``), membership TSVs, and
"quantify in other datasets" jobs that load other open datasets at the run's locus.
"""
from __future__ import annotations

import csv
import io
import math
import threading
import time
import uuid

import numpy as np

from lab.services.accessibility_workflow import _EXECUTOR, _complete, _names, _session, _runtime, AccessibilityCancelled

CELL_LABELS = {'11': ('+', '+'), '10': ('+', '−'), '01': ('−', '+'), '00': ('−', '−')}
NA_GROUP = 4
MAX_SEQUENCE_BP = 20_000
NEEDS_ENGINE = ('This view needs the FiberHMM accessibility analysis module (the exp/fh-nfr preview build, '
                'fiberhmm.inference.accessibility.analysis).')


def _analysis():
    _runtime()
    try:
        from fiberhmm.inference.accessibility import analysis
    except ImportError as error:
        raise ValueError(f'{NEEDS_ENGINE} ({error})') from error
    return analysis


def _result(state, job_id):
    return _complete(state, job_id)['result']


def _job(state, job_id):
    return _complete(state, job_id)


VIEW_CACHE = 160


def _cache(state, job_id, key, compute):
    """Per-run memo of a view (results are immutable, so a view never changes for a run); least recently used out
    first, so many small views (site sizes) never evict the motif scan they derive from."""
    job = _job(state, job_id)
    from services.byte_cache import ByteCache, shared_cache
    jobs, lock = _session(state)
    with lock:
        memo = job.get('_views')
        if not isinstance(memo, ByteCache):
            memo = shared_cache()
            job['_views'] = memo
        if key in memo:
            value = memo.pop(key)
            memo[key] = value               # most recently used last
            return value
    value = compute()
    with lock:
        memo[key] = value
    return value


# ------------------------------------------------------------------ read names
def _read_groups(result, groups):
    """{group_id: [unit_id]} -> by_dataset {dataset: {read name: group_id}}; a read name whose molecules fall in
    different groups (the same QNAME in two merged BAMs, repeated alignments) is left out and counted, as Find
    classes does."""
    found = {}
    for gid, uids in groups.items():
        for u in uids:
            m = result['molecules'].get(u)
            if m is None:
                continue
            for name in _names(m):
                found.setdefault((m['dataset'], name), set()).add(gid)
    by_dataset, ambiguous, counts = {}, {}, {}
    for dataset, _name in found:
        by_dataset.setdefault(dataset, {})      # a dataset whose names are all ambiguous still gets its (empty) groups
    for (dataset, name), gids in sorted(found.items()):
        if len(gids) > 1:
            ambiguous[dataset] = ambiguous.get(dataset, 0) + 1
            continue
        gid = next(iter(gids))
        by_dataset.setdefault(dataset, {})[name] = gid
        counts[gid] = counts.get(gid, 0) + 1
    return by_dataset, ambiguous, counts


def _uids_for_names(result, names_by_dataset):
    """{dataset: [read names]} -> the unit_ids carrying those names."""
    wanted = {(d, n) for d, names in (names_by_dataset or {}).items() for n in names or ()}
    out = []
    for uid, m in result['molecules'].items():
        if any((m['dataset'], n) in wanted for n in _names(m)):
            out.append(uid)
    return sorted(out)


def _short(result, eid):
    e = next((e for e in result.get('elements') or () if e['id'] == eid), None)
    if e is None:
        return eid
    if e['kind'] == 'tf':
        return str(e.get('label') or eid).replace('class ', 'C')
    return eid.replace(':', ' ')


# ------------------------------------------------------------------ overview
def overview(state, job_id, nfr_id):
    A = _analysis()
    return _cache(state, job_id, ('overview', nfr_id), lambda: A.variant_profiles(_result(state, job_id), nfr_id))


# ------------------------------------------------------------------ split
EXCLUSION_TEXT = {
    'not_spanning_a': 'no state for {a} (edge-censored, abstained or another channel)',
    'not_spanning_b': 'no state for {b} (edge-censored, abstained or another channel)',
    'no_coverage': 'under 200 bp of nucleosome-bounded coverage in the window',
    'channel': 'the two classes were read on different channels',
    'shared': 'one opening covers both (shared: a single opening says nothing about whether the two open together)',
    'no_background': 'too little of the read outside the two elements to measure its openness',
    'not_spanning': 'does not span every chosen element',
}


def split(state, job_id, a=None, b=None, elements=None):
    """Reads of the run split for a pair (a, b) into A+B+ / A+B− / A−B+ / A−B− (the pair test's 2x2 table) and not
    informative, or for 3-8 elements by their open/closed pattern; read names per dataset for the read panel."""
    A = _analysis()
    result = _result(state, job_id)
    if elements:
        ids = [str(e) for e in elements]
        s = A.combo_split(result, ids)
        groups = {i: g['reads'] for i, g in enumerate(s['patterns'])}
        na = len(groups)
        groups[na] = s['not_informative']
        by_dataset, ambiguous, counts = _read_groups(result, groups)
        short = [_short(result, i) for i in ids]
        out_groups = [dict(id=i, key=g['pattern'], molecules=len(g['reads']), count=counts.get(i, 0), pattern=[int(c) for c in g['pattern']],
                           label=' '.join(f"{sh}{'+' if c == '1' else '−'}" for sh, c in zip(short, g['pattern'])))
                      for i, g in enumerate(s['patterns'])]
        out_groups.append(dict(id=na, key='na', molecules=len(s['not_informative']), count=counts.get(na, 0), pattern=None,
                               label='Not informative'))
        combo = result.get('combos') or {}
        stats = {p['pattern']: p for p in combo.get('patterns') or ()} if combo.get('elements') == ids else {}
        for g in out_groups:
            if g['key'] in stats:
                p = stats[g['key']]
                g['expected'] = dict(independence=p['exp_indep'], null_median=p['null_med'], null_lo=p['null_lo'], null_hi=p['null_hi'], q=p['q'])
        return dict(job_id=job_id, kind='combination', elements=ids, short=short, groups=out_groups, by_dataset=by_dataset,
                    ambiguous_reads=ambiguous, n=s['n'], excluded={k: len(v) for k, v in s['excluded'].items()},
                    excluded_text={k: EXCLUSION_TEXT.get(k, k) for k in s['excluded']},
                    counts='groups count read names; molecules are the evidence units the test used')
    if not a or not b:
        raise ValueError('Give two elements (a and b) or a list of elements')
    s = _cache(state, job_id, ('split', a, b), lambda: A.pair_split(result, a, b))
    sa, sb = _short(result, s['a']), _short(result, s['b'])
    groups = {i: s['cells'][k] for i, k in enumerate(A.CELLS)}
    groups[NA_GROUP] = s['not_informative']
    by_dataset, ambiguous, counts = _read_groups(result, groups)
    out_groups = []
    for i, k in enumerate(A.CELLS):
        pa, pb = CELL_LABELS[k]
        out_groups.append(dict(id=i, key=k, label=f'{sa}{pa} {sb}{pb}', molecules=len(s['cells'][k]), count=counts.get(i, 0),
                               pattern=[int(k[0]), int(k[1])]))
    out_groups.append(dict(id=NA_GROUP, key='na', label='Not informative', molecules=len(s['not_informative']),
                           count=counts.get(NA_GROUP, 0), pattern=None))
    text = {k: EXCLUSION_TEXT.get(k, k).format(a=sa, b=sb) for k in s['excluded']}
    return dict(job_id=job_id, kind='pair', a=s['a'], b=s['b'], short=[sa, sb], groups=out_groups, by_dataset=by_dataset,
                ambiguous_reads=ambiguous, table=s['table'], pair=s['pair'], tested=s['tested'], skipped=s['skipped'],
                excluded={k: len(v) for k, v in s['excluded'].items()}, excluded_text=text, strata=s['strata'],
                spacing=s['spacing'], profiles=s['profiles'], window=s['window'], recomputed=s['recomputed'],
                counts='groups count read names; molecules are the evidence units the test used')


# ------------------------------------------------------------------ saved-variant views
VIEWS = ('shape', 'vplots', 'phasing')


def variant_view(state, job_id, variant_id, view):
    A = _analysis()
    if view not in VIEWS:
        raise ValueError(f'Unknown view {view!r}')
    fn = dict(shape=A.size_shape, vplots=A.vplots, phasing=A.phasing)[view]
    return _cache(state, job_id, (view, variant_id), lambda: fn(_result(state, job_id), variant_id))


def variant_prevalence(state, job_id, variant_id, groups=None, bootstrap=None):
    """Prevalence of the variant per read group ({label: {dataset: [read names]}}), per dataset of the run, and over
    every callable read, by the configuration EM with the run's catalogue frozen."""
    A = _analysis()
    result = _result(state, job_id)
    if groups is not None and not isinstance(groups, dict):
        raise ValueError('groups must be an object of {label: {dataset: [read names]}}')
    if bootstrap is not None and (isinstance(bootstrap, bool) or not isinstance(bootstrap, (int, float)) or not 0 <= int(bootstrap) <= 1000):
        raise ValueError('bootstrap must be 0-1000 (default: the run\'s)')
    bootstrap = None if bootstrap is None else int(bootstrap)
    by_label = {}
    for label, names in (groups or {}).items():
        if not isinstance(names, dict):
            raise ValueError('each group is {dataset: [read names]}')
        by_label[str(label)] = _uids_for_names(result, names)
    datasets = sorted({m['dataset'] for m in result['molecules'].values()})
    per_dataset = {d: sorted(u for u, m in result['molecules'].items() if m['dataset'] == d) for d in datasets} if len(datasets) > 1 else {}
    out = A.group_prevalence(result, variant_id, by_label, bootstrap)
    if per_dataset:
        ds = A.group_prevalence(result, variant_id, per_dataset, bootstrap)
        out['datasets'] = [g for g in ds['groups'] if g['group'] != 'all']
    else:
        out['datasets'] = []
    return out


def membership_tsv(state, job_id, variant_id):
    """Per-read membership of one variant: every read of its NFR, P(variant), member (>= the open threshold), the
    most likely configuration and the opening it assigns to the variant."""
    A = _analysis()
    result = _result(state, job_id)
    nfr_id, _, name = variant_id.partition(':')
    members = A.member_uids(result, variant_id)       # exactly the reads the pair tests counted as open
    buf = io.StringIO()
    w = csv.writer(buf, delimiter='\t', lineterminator='\n')
    w.writerow(['variant', 'unit_id', 'read_name', 'dataset', 'strand', 'status', 'p', 'member', 'configuration', 'opening_start', 'opening_end'])
    for uid in sorted(result['molecules']):
        m = result['molecules'][uid]
        rec = (m.get('nfr') or {}).get(nfr_id)
        if not rec:
            continue
        p = (rec.get('p') or {}).get(name)
        gap = ''
        cfg = rec.get('map') or ''
        tokens = cfg.split('+')
        if rec.get('gaps') and len(tokens) == len(rec['gaps']) and name in tokens:
            gap = rec['gaps'][tokens.index(name)]
        w.writerow([variant_id, uid, m.get('read_name') or '', m['dataset'], m.get('strand') or '', rec.get('status'),
                    '' if p is None else p, '' if p is None else int(uid in members), cfg, gap[0] if gap else '', gap[1] if gap else ''])
    return buf.getvalue()


# ------------------------------------------------------------------ per-NFR views: every variant side by side
def _nfr_of(result, nfr_id):
    nfr = next((n for n in result['nfrs'] if n['id'] == nfr_id), None)
    if nfr is None or not nfr.get('variants'):
        raise ValueError(f'No NFR {nfr_id!r} with variants in this run')
    return nfr


def nfr_view(state, job_id, nfr_id, view, step=None, size_step=None, pad=None):
    """One figure per view for all of an NFR's variants: shape (widths, edges and boundary nucleosomes per variant),
    vplots (every opening, and each variant's own on the same grid), phasing (one occupancy line per variant's
    members, and all callable reads)."""
    A = _analysis()
    if view not in VIEWS:
        raise ValueError(f'Unknown view {view!r}')
    result = _result(state, job_id)
    nfr = _nfr_of(result, nfr_id)
    names = [v['name'] for v in nfr['variants']]
    vopts = {}
    for k, v, lo, hi in (('step', step, 2, 100), ('size_step', size_step, 2, 100), ('pad', pad, 0, 3000)):
        if v is not None:
            v = int(v)
            if not lo <= v <= hi:
                raise ValueError(f'{k} must be {lo}-{hi}')
            vopts[k] = v

    def compute():
        if view == 'shape':
            out = A.size_shape(result, nfr['variants'][0]['id'])
            out.pop('variant', None); out.pop('name', None)
            return dict(out, variants=names)
        if view == 'vplots':
            per = {v['name']: A.vplots(result, v['id'], **vopts) for v in nfr['variants']}
            base = per[names[0]]
            return dict(nfr=nfr_id, window=base['window'], step=base['step'], size=base['size'], size_step=base['size_step'],
                        all=base['all'], count_all=base['counts']['all'], names=names,
                        variants={n: dict(base_view['own'], count=base_view['counts']['own'], span=base_view['span'])
                                  for n, base_view in per.items()})
        per = {v['name']: A.phasing(result, v['id']) for v in nfr['variants']}
        first = per[names[0]]
        m, o = first['members'], first['others']
        occ = []
        for om, nm, oo, no in zip(m['occupancy'], m['n'], o['occupancy'], o['n']):
            parts = [(x, k) for x, k in ((om, nm), (oo, no)) if x is not None and k]
            occ.append(round(sum(x*k for x, k in parts)/sum(k for _x, k in parts), 4) if parts else None)
        everyone = dict(x=m['x'], occupancy=occ, n=[a + b for a, b in zip(m['n'], o['n'])], reads=m['reads'] + o['reads'])
        return dict(nfr=nfr_id, window=first['window'], names=names, all=everyone,
                    variants={n: dict(members=p['members'], span=p['span'], boundary=p['boundary']) for n, p in per.items()})
    return _cache(state, job_id, ('nfr', view, nfr_id, tuple(sorted(vopts.items())) if view == 'vplots' else ()), compute)


def nfr_prevalence(state, job_id, nfr_id, groups=None, bootstrap=None):
    """Prevalence of every variant of the NFR per read group, per dataset of the run and over every callable read:
    rows {group, callable, reads, variants: {name: {prevalence, strict, ci}}}."""
    result = _result(state, job_id)
    nfr = _nfr_of(result, nfr_id)
    names = [v['name'] for v in nfr['variants']]
    rows, datasets, note = {}, {}, ''
    for v in nfr['variants']:
        out = variant_prevalence(state, job_id, v['id'], groups, bootstrap)
        note = out.get('note') or note
        for target, src in ((rows, out['groups']), (datasets, out['datasets'])):
            for g in src:
                row = target.setdefault(g['group'], dict(group=g['group'], callable=g['callable'], reads=g.get('reads'), variants={}))
                row['variants'][v['name']] = {k: g.get(k) for k in ('prevalence', 'strict', 'ci')}
    by_label = {str(k): _uids_for_names(result, v) for k, v in (groups or {}).items() if isinstance(v, dict)}
    ds = sorted({m['dataset'] for m in result['molecules'].values()})
    by_ds = {d: [u for u, m in result['molecules'].items() if m['dataset'] == d] for d in ds} if len(ds) > 1 else {}
    tests = dict(groups=usage_test(_analysis(), result, nfr, by_label), datasets=usage_test(_analysis(), result, nfr, by_ds))
    return dict(nfr=nfr_id, names=names, groups=list(rows.values()), datasets=list(datasets.values()), note=note, tests=tests)


def usage_test(A, result, nfr, groups, min_expected=5):
    """Does variant usage differ between groups? Over the groups' callable reads: a G-test (multinomial likelihood
    ratio) of most-likely configuration x group (configurations with fewer than ``min_expected`` expected reads pooled
    into 'other'), and per variant a G-test of member / not member x group, BH across variants. Groups' reads must be
    disjoint (a read in two groups is left out of both)."""
    from scipy.stats import chi2_contingency
    from services.motif_scoring import bh
    if len(groups) < 2:
        return None
    seen = {}
    for g, uids in groups.items():
        for u in uids:
            seen[u] = None if u in seen else g
    labels = [g for g in groups if any(v == g for v in seen.values())]
    if len(labels) < 2:
        return None
    configs, members = {}, {v['name']: A.member_uids(result, v['id']) for v in nfr['variants']}
    n_by = {g: 0 for g in labels}
    mem = {v: {g: 0 for g in labels} for v in members}
    for u, g in seen.items():
        if g is None:
            continue
        rec = (result['molecules'].get(u, {}).get('nfr') or {}).get(nfr['id'])
        if not rec or rec.get('status') != 'callable':
            continue
        cfg = rec.get('map') or 'closed'
        configs.setdefault(cfg, {x: 0 for x in labels})[g] += 1
        n_by[g] += 1
        for v, us in members.items():
            mem[v][g] += int(u in us)
    total = sum(n_by.values())
    if total == 0 or sum(1 for g in labels if n_by[g]) < 2:
        return None
    labels = [g for g in labels if n_by[g]]
    rows, other = {}, {g: 0 for g in labels}
    for cfg, counts in configs.items():
        exp = min(sum(counts.values())*n_by[g]/total for g in labels)
        if exp >= min_expected:
            rows[cfg] = counts
        else:
            for g in labels:
                other[g] += counts[g]
    if sum(other.values()):
        rows['other'] = other
    out = dict(groups=labels, reads={g: n_by[g] for g in labels}, configurations=sorted(rows))
    if len(rows) >= 2:
        table = [[rows[c][g] for g in labels] for c in sorted(rows)]
        g_stat, p, dof, _e = chi2_contingency(table, lambda_='log-likelihood', correction=False)
        out.update(g=round(float(g_stat), 3), df=int(dof), p=float(p))
    else:
        out.update(g=None, df=0, p=None)
    per = {}
    for v in members:
        t = [[mem[v][g] for g in labels], [n_by[g] - mem[v][g] for g in labels]]
        if min(sum(t[0]), sum(t[1])) == 0:
            per[v] = dict(share={g: round(mem[v][g]/n_by[g], 4) for g in labels}, p=None)
            continue
        g_stat, p, dof, _e = chi2_contingency(t, lambda_='log-likelihood', correction=False)
        per[v] = dict(share={g: round(mem[v][g]/n_by[g], 4) for g in labels}, g=round(float(g_stat), 3), df=int(dof), p=float(p))
    for v, q in zip(per, bh([per[v]['p'] for v in per])):
        per[v]['q'] = q
    out['variants'] = per
    out['definition'] = ('G-test (multinomial likelihood ratio) of the reads\' most likely configuration x group, rare '
                         'configurations pooled; per variant, member (P >= the open threshold) vs not x group, BH across variants. '
                         'Reads in two groups are left out.')
    return out


def nfr_membership_tsv(state, job_id, nfr_id):
    """Per-read membership of every variant of one NFR: P(variant), member (>= the open threshold) and the opening
    the read's most likely configuration assigns to it, one column set per variant."""
    A = _analysis()
    result = _result(state, job_id)
    nfr = _nfr_of(result, nfr_id)
    names = [v['name'] for v in nfr['variants']]
    members = {v['name']: A.member_uids(result, v['id']) for v in nfr['variants']}
    buf = io.StringIO()
    w = csv.writer(buf, delimiter='\t', lineterminator='\n')
    w.writerow(['nfr', 'unit_id', 'read_name', 'dataset', 'strand', 'status', 'configuration']
               + [f'{c}_{n}' for n in names for c in ('p', 'member', 'opening_start', 'opening_end')])
    for uid in sorted(result['molecules']):
        m = result['molecules'][uid]
        rec = (m.get('nfr') or {}).get(nfr_id)
        if not rec:
            continue
        cfg = rec.get('map') or ''
        tokens = cfg.split('+')
        row = [nfr_id, uid, m.get('read_name') or '', m['dataset'], m.get('strand') or '', rec.get('status'), cfg]
        for n in names:
            p = (rec.get('p') or {}).get(n)
            gap = rec['gaps'][tokens.index(n)] if rec.get('gaps') and len(tokens) == len(rec['gaps']) and n in tokens else ''
            row += ['' if p is None else p, '' if p is None else int(uid in members[n]), gap[0] if gap else '', gap[1] if gap else '']
        w.writerow(row)
    return buf.getvalue()


def nfr_sequence(state, job_id, nfr_id, flank=300, window=50):
    result = _result(state, job_id)
    nfr = _nfr_of(result, nfr_id)
    out = variant_sequence(state, job_id, nfr['variants'][0]['id'], flank, window)
    return dict(out, variant=None, nfr=nfr_id)


# ------------------------------------------------------------------ reference sequence: motifs and features
def _ref_identity(state, job) -> str:
    """The run's reference genome identity (species, coordinates, declaration revision): motif views are
    cached per identity, so a declared or cleared genome is scanned again."""
    from services import motifs as M
    from services.panel_genomes import for_datasets
    return M.genome_identity_key(for_datasets(state, (job.get('request') or {}).get('dataset_ids') or []))


def _reference(state, job, lo, hi):
    from services.panel_genomes import for_datasets
    from services.render_endpoint import _view_sequence
    ref_state = for_datasets(state, (job.get('request') or {}).get('dataset_ids') or [])
    chrom = job['result']['region']['chrom']
    if hi - lo > MAX_SEQUENCE_BP:
        raise ValueError(f'The window is longer than {MAX_SEQUENCE_BP:,} bp')
    seq = _view_sequence(ref_state, chrom, int(lo), int(hi))
    if not seq.strip():
        raise ValueError('No reference sequence for this region: load the genome FASTA (Genome menu) to see motifs and sequence features.')
    return ref_state, seq


def _window(nfr, flank):
    """The NFR and every variant (fractional edges: floor on the left, ceil on the right, so a rounded edge is always
    inside) +- flank."""
    vs = nfr.get('variants') or []
    lo = math.floor(min([nfr['start']] + [v['L'] for v in vs])) - flank
    hi = math.ceil(max([nfr['end']] + [v['R'] for v in vs])) + flank
    return max(0, int(lo)), int(hi)


def _motif_region(nfr, flank, bg_flank):
    """The window (variants' span +- flank) inside the scanned region (the NFR +- bg_flank, the local background),
    trimmed to MAX_SEQUENCE_BP."""
    w_lo, w_hi = _window(nfr, flank)
    lo, hi = min(w_lo, int(nfr['start']) - bg_flank), max(w_hi, int(nfr['end']) + bg_flank)
    excess = (hi - lo) - MAX_SEQUENCE_BP
    if excess > 0:
        lo, hi = min(w_lo, lo + excess//2 + 1), max(w_hi, hi - excess//2 - 1)
    return max(0, lo), hi


def nfr_motifs(state, job_id, nfr_id, motifs=None, pinned=None, p=None, relative=None, background='local', flank=300,
               bg_flank=None, pwms=None, mode=None, strand='both', family_similarity=None, custom=None, core_bp=None,
               min_reads=None):
    """Motifs of one NFR, its variants side by side (``lab.services.accessibility_motifs``): sites at a per-matrix
    p-value (or, in 'relative' mode, a share of each matrix's score range), enrichment per variant against the local
    background and the background model, the differential between the variants, families of similar matrices, the
    pinned key factors (None: the species' defaults) and custom matrices; and at every site the hierarchy of
    evidence per variant (``lab.services.accessibility_occupancy``): open (NFR shape), footprinted given open (Find
    classes), their product. ``motifs``: scan only these names. ``pwms`` (tests): [(id, name, counts)]."""
    from lab.services import accessibility_motifs as AM
    from lab.services import accessibility_occupancy as OC
    from services.motif_scoring import motif_options, options_key, genome_composition
    A = _analysis()
    job = _job(state, job_id)
    result = job['result']
    nfr = next((n for n in result['nfrs'] if n['id'] == nfr_id), None)
    if nfr is None or not nfr.get('variants'):
        raise ValueError(f'No NFR {nfr_id!r} with variants in this run')
    o = motif_options(mode=mode, p=p, relative=relative, background=background, strand=strand,
                      family_similarity=family_similarity, custom=custom, pinned=pinned, motifs=motifs,
                      default_relative=0.85)
    flank = int(flank)
    if not 0 <= flank <= 5000:
        raise ValueError('flank must be 0-5,000 bp')
    bg_flank = AM.DEFAULT_BG_FLANK if bg_flank is None else int(bg_flank)
    if not 500 <= bg_flank <= 9000:
        raise ValueError('bg_flank must be 500-9,000 bp')
    core_bp = OC.DEFAULT_CORE_BP if core_bp is None else int(core_bp)
    if not 1 <= core_bp <= 60:
        raise ValueError('core_bp must be 1-60')
    min_reads = OC.DEFAULT_MIN_READS if min_reads is None else int(min_reads)
    if not 1 <= min_reads <= 1000:
        raise ValueError('min_reads must be 1-1,000')
    classes = OC.class_source(state, job)
    key = ('nfr_motifs', _ref_identity(state, job), nfr_id, options_key(o), flank, bg_flank, core_bp, min_reads, classes['key'] or ('none', classes.get('reason')),
           None if pwms is None else tuple((i, n) for i, n, _c in pwms))

    def compute():
        lo, hi = _motif_region(nfr, flank, bg_flank)
        ref_state, seq = _reference(state, job, lo, hi)
        records, species, pinned_info, warnings = AM.catalogue(ref_state, o['motifs'], o['pinned'], pwms, o['custom'])
        genome_comp = None
        if o['background'] == 'genome':
            fasta = getattr(ref_state, 'fasta', None)
            genome_comp = genome_composition(fasta) if fasta is not None else None
            if genome_comp is None:
                warnings.append('No genome FASTA to sample: the local composition is used')
        w_lo, w_hi = _window(nfr, flank)
        pad = max(int(nfr['start']) - w_lo, w_hi - int(nfr['end']), 0) + 10
        profiles = A.variant_profiles(result, nfr['id'], pad=pad)
        out = AM.nfr_motifs(result, nfr, seq, (lo, hi), profiles, records, species=species, pinned_info=pinned_info,
                            p=o['p'], relative=o['relative'] if o['mode'] == 'relative' else None,
                            background=o['background'], genome_comp=genome_comp, strand=o['strand'],
                            family_similarity=o['family_similarity'], flank=flank, bg_flank=bg_flank, warnings=warnings)
        out['occupancy'] = OC.annotate(A, result, nfr, out, classes, core_bp=core_bp, min_reads=min_reads)
        out['threshold']['mode'] = o['mode']
        return out
    return _cache(state, job_id, key, compute)


def nfr_motif_profile(state, job_id, nfr_id, family, scope='nfr', half=None, **options):
    """Motif-centred meta-profile (lab.services.accessibility_occupancy.meta_profile) of one motif family: the sites of
    its member matrices (``family``: matrix IDs or names) in this NFR, or in every NFR of the run with variants."""
    from lab.services import accessibility_occupancy as OC
    A = _analysis()
    if scope not in ('nfr', 'run'):
        raise ValueError("scope must be 'nfr' or 'run'")
    wanted = {str(x).lower() for x in (family if isinstance(family, (list, tuple)) else [family]) if x}
    if not wanted:
        raise ValueError('family: one or more matrix IDs or names')
    job = _job(state, job_id)
    result = job['result']
    nfrs = [n for n in result['nfrs'] if n.get('variants') and (scope == 'run' or n['id'] == nfr_id)]
    if not nfrs:
        raise ValueError(f'No NFR {nfr_id!r} with variants in this run')
    picked, label = [], None
    for n in nfrs:
        m = nfr_motifs(state, job_id, n['id'], **options)
        for row in m['families']:
            if any(x['id'].lower() in wanted or x['name'].lower() in wanted for x in row['members']):
                label = label or row['name']
                picked.append((n, row['sites']))
    classes = OC.class_source(state, job)
    half = OC.PROFILE_HALF if half is None else int(half)
    if not 30 <= half <= 500:
        raise ValueError('half must be 30-500 bp')
    min_reads = int(options.get('min_reads') or OC.DEFAULT_MIN_READS)
    key = ('profile', _ref_identity(state, _job(state, job_id)), scope, nfr_id, tuple(sorted(wanted)), repr(sorted(options.items(), key=lambda kv: kv[0])), classes['key'], half)
    out = _cache(state, job_id, key, lambda: OC.meta_profile(A, result, picked, classes, half=half, min_reads=min_reads))
    return dict(out, family=label or sorted(wanted)[0], scope=scope, nfrs=[n['id'] for n, _s in picked],
                definitions=dict(open='Share of the variant\'s member reads open at each offset (NFR shape)',
                                 footprinted='Among open, class-labelled reads, the share in a footprint class covering the position',
                                 orientation='Offsets follow the motif strand; 0 is the motif centre'))


def nfr_site_sizes(state, job_id, nfr_id, sites, core_bp=None, min_reads=None):
    """NFR size at motif sites: on each callable read whose opening covers a site core, the size of that opening, by
    the variant its configuration assigns it ('other': none), pooled over ``sites`` ([[start, end], ...]: one site, or
    a motif family's sites in this NFR). The sizes themselves (for the distribution and CDF) and the test between
    variants (accessibility_occupancy.size_test)."""
    from lab.services import accessibility_occupancy as OC
    result = _result(state, job_id)
    nfr = _nfr_of(result, nfr_id)
    names = [v['name'] for v in nfr['variants']]
    if not isinstance(sites, list) or not sites or len(sites) > 2000:
        raise ValueError('sites: 1-2,000 [start, end] pairs')
    try:
        pts = sorted({(float(a), float(b)) for a, b in sites})
    except (TypeError, ValueError) as error:
        raise ValueError('sites: [start, end] pairs') from error
    core_bp = OC.DEFAULT_CORE_BP if core_bp is None else int(core_bp)
    if not 1 <= core_bp <= 60:
        raise ValueError('core_bp must be 1-60')
    min_reads = OC.DEFAULT_MIN_READS if min_reads is None else int(min_reads)

    def compute():
        # one site: its reads' openings; several (a family): each read once, the groups disjoint
        by = OC.site_sizes(result, nfr, (pts[0][0] + pts[0][1])/2, core_bp, raw=True) if len(pts) == 1 \
            else OC.pooled_sizes(result, nfr, [(a + b)/2 for a, b in pts], core_bp)
        order = [n for n in names if n in by] + sorted(k for k in by if k not in names)
        p = OC.size_test({k: v for k, v in by.items() if k in names}, min_reads)
        return dict(nfr=nfr_id, sites=[list(x) for x in pts], core_bp=core_bp, labels=order,
                    sizes={k: sorted(by[k]) for k in order}, summary={k: OC._quantiles(by[k]) for k in order}, p=p,
                    test='Mann-Whitney' if len([k for k in names if len(by.get(k, ())) >= min_reads]) == 2 else 'Kruskal-Wallis',
                    definition=('Size of the opening (nucleosome to nucleosome) covering the site core on each callable '
                                'read, by the variant its most likely configuration assigns that opening (other: none); '
                                f'test between variants with >= {min_reads} reads (one site: as in the sites table; '
                                'several: pooled over them, each read once, reads with different variants at different '
                                'sites left out)'))
    return _cache(state, job_id, ('sizes', nfr_id, tuple(pts), core_bp, min_reads), compute)


def submit_class_run(state, job_id):
    """Find classes (the lattice recaller) for this run's window, datasets, chemistry and loader settings, so its
    footprint classes join this run by unit_id (occupancy appears without re-running Find variants). Returns the
    consensus job, or the compatible one that already exists."""
    from lab.services import accessibility_occupancy as OC
    from lab.services.accessibility_workflow import run_name
    from services.consensus_workflow import submit
    job = _job(state, job_id)
    existing = OC.class_source(state, job)
    if existing['classes']:
        return dict(job_id=existing['job_id'], status='complete', existing=True, joined=existing['joined'])
    req = job.get('request') or {}
    r = job['result']['region']
    body = dict(dataset_ids=list(req.get('dataset_ids') or []), chemistry_overrides=dict(req.get('chemistry_overrides') or {}),
                chrom=r['chrom'], start=int(r['start']), end=int(r['end']),
                parameters=dict(input=dict((req.get('loader_parameters') or {}).get('input') or {})),
                region_source='region', region_label=f"window of {run_name(state, job_id)}")
    out = submit(state, body)
    return dict(job_id=out.get('job_id'), status=out.get('status'), existing=False, message=out.get('message'))


def class_status(state, job_id):
    """The footprint classes this run can use, for the whole run: joined by the run itself ('run': its pair tests
    include them), joined after it from a compatible Find classes run ('posthoc': the NFR views use them, but the pair
    tests only after Find NFR variants runs again), or none (with the reason)."""
    from lab.services import accessibility_occupancy as OC
    job = _job(state, job_id)
    src = OC.class_source(state, job)
    return dict(class_job=src['job_id'], joined=src['joined'], classes=len(src['classes']), reason=src.get('reason'))


def pooled_motifs(state, job_ids, pwms=None, **options):
    """Motif families x variant types pooled over every NFR (with >= 2 variants) of the given runs
    (services/accessibility_pooled.py): sites (own part vs siblings'), open and footprinted | open, Mantel-Haenszel."""
    from lab.services import accessibility_motifs as AM
    from lab.services import accessibility_occupancy as OC
    from lab.services import accessibility_pooled as PO
    from services.motif_scoring import motif_options, options_key
    A = _analysis()
    ids = [str(j) for j in (job_ids or []) if j]
    if not ids:
        raise ValueError('job_ids: one or more complete runs')
    if len(ids) > 60:
        raise ValueError('At most 60 runs can be pooled')
    o = motif_options(mode=options.get('mode'), p=options.get('p'), relative=options.get('relative'),
                      background=options.get('background') or 'local', strand=options.get('strand') or 'both',
                      family_similarity=options.get('family_similarity'), custom=options.get('custom'),
                      pinned=options.get('pinned'), motifs=options.get('motifs'), default_relative=0.85)
    min_reads = int(options.get('min_reads') or OC.DEFAULT_MIN_READS)
    runs, ref_state = [], None
    for jid in ids:
        job = _job(state, jid)
        classes = OC.class_source(state, job)
        nfrs = [(n, nfr_motifs(state, jid, n['id'], pwms=pwms, **options)) for n in job['result']['nfrs'] if len(n.get('variants') or ()) >= 2]
        runs.append((jid, job['result'], classes, nfrs))
        if ref_state is None:
            from services.panel_genomes import for_datasets
            ref_state = for_datasets(state, (job.get('request') or {}).get('dataset_ids') or [])
    records, _species, _pinned, _w = AM.catalogue(ref_state, o['motifs'], o['pinned'], pwms, o['custom'])
    extra = tuple((k, options.get(k)) for k in ('flank', 'bg_flank', 'core_bp'))
    key = ('pooled', _ref_identity(state, _job(state, ids[0])), tuple(ids), options_key(o), min_reads, extra, tuple(str(r[2]['key']) for r in runs),
           None if pwms is None else tuple(i for i, _n, _c in pwms))
    job0 = ids[0]
    return _cache(state, job0, key, lambda: dict(PO.pooled(runs, records, o['family_similarity'], min_reads, OC.site_layers, A.member_uids),
                                                  job_ids=ids))


def kmer_enrichment(state, job_ids, k=6, top=40, pwms=None):
    """De novo k-mers enriched in the variant-specific parts of NFR openings, pooled over every NFR with >= 2 variants
    of the runs (services/accessibility_kmers.py), each matched to the JASPAR matrix that scores it best."""
    from lab.services import accessibility_kmers as KM
    from lab.services import accessibility_motifs as AM
    from services import motifs as M
    k = int(k)
    if not 4 <= k <= 8:
        raise ValueError('k must be 4-8')
    ids = [str(j) for j in (job_ids or []) if j]
    if not ids:
        raise ValueError('job_ids: one or more complete runs')
    kmers = KM.kmers_of(k)
    index = {}
    for i, km in enumerate(kmers):
        index[km] = i
        index[km.translate(KM.COMP)[::-1]] = i
    from lab.services.accessibility_pooled import variant_type
    strata_own, strata_bg, ref_state, n_nfrs = {}, {}, None, 0     # per variant type
    for jid in ids:
        job = _job(state, jid)
        result = job['result']
        opened = [[n['start'], n['end']] for n in result['nfrs']] + [[v['L'], v['R']] for n in result['nfrs'] for v in n.get('variants') or ()]
        for nfr in result['nfrs']:
            vs = nfr.get('variants') or []
            if len(vs) < 2:
                continue
            n_nfrs += 1
            lo, hi = _motif_region(nfr, 300, AM.DEFAULT_BG_FLANK)
            ref_state, seq = _reference(state, job, lo, hi)
            bg = AM._minus([[lo, hi]], opened)
            cb, nb = KM.count(seq, lo, bg, k, index)
            spans = {v['name']: [v['L'], v['R']] for v in vs}
            vtype = {v['name']: variant_type(v.get('relation')) for v in vs}
            # one stratum per variant type and NFR: the type's variants against the others (an oriented comparison;
            # summing each variant against its siblings would cancel for two variants)
            for t in sorted(set(vtype.values())):
                mine = [spans[n] for n in spans if vtype[n] == t]
                others = [spans[n] for n in spans if vtype[n] != t]
                if not others:
                    continue
                own = AM._minus(mine, others)
                sib = AM._minus(others, mine)
                co, no = KM.count(seq, lo, own, k, index)
                cs, ns = KM.count(seq, lo, sib, k, index)
                if no and ns:
                    strata_own.setdefault(t, []).append((co, no, cs, ns))
                if no and nb:
                    strata_bg.setdefault(t, []).append((co, no, cb, nb))
    key = ('kmers', _ref_identity(state, _job(state, ids[0])), tuple(ids), k, top, None if pwms is None else tuple(i for i, _n, _c in pwms))

    def compute():
        canon = {km: i for i, km in enumerate(kmers)}
        per_type = {t: KM.enrich(strata_own.get(t, []), strata_bg.get(t, []), canon, top) for t in sorted(set(strata_own) | set(strata_bg))}
        tested = len(kmers)
        if pwms is not None:
            recs = [dict(matrix_id=i, name=n, counts=c) for i, n, c in pwms]
        else:
            genome, _inf = M.jaspar_genome(ref_state) if ref_state is not None else (None, False)
            taxid = M.GENOME_TO_JASPAR_SPECIES.get(genome)
            recs = [dict(matrix_id=m.matrix_id, name=m.name, counts=m.counts) for m in M.get_jaspar_core_motifs(taxid)] if taxid and M.check_pyjaspar() else []
        scored = []
        for r in recs:
            ip = M.integer_pssm(M.log_odds_pssm({b: [float(x) for x in r['counts'][b]] for b in 'ACGT'}))
            scored.append((r['name'], r['matrix_id'], ip, ip[::-1, ::-1].copy()))
        matched = {}
        for rows, _n in per_type.values():
            for r in rows:
                if r['kmer'] not in matched:
                    bm = KM.best_matrix(r['kmer'], scored) if scored else None
                    matched[r['kmer']] = None if bm is None else dict(name=bm[0], id=bm[1], share=bm[2])
                r['match'] = matched[r['kmer']]
        types = {t: dict(kmers=rows, strata=dict(siblings=len(strata_own.get(t, [])), background=len(strata_bg.get(t, []))))
                 for t, (rows, _n) in per_type.items()}
        return dict(k=k, types=types, tested=tested, nfrs=n_nfrs, runs=len(ids),
                    definition=('k-mers (with their reverse complements) in the part of a variant type\'s spans no other variant covers, '
                                'against the other variants\' own parts and against the local background; Mantel-Haenszel rate ratio over NFRs '
                                '(one stratum per type and NFR), '
                                'exact conditional test, BH across k-mers; ranked by the siblings comparison (the background comparison is '
                                'confounded by base composition: open DNA is richer in some k-mers than nucleosomal flanks); the JASPAR '
                                'match is the matrix scoring the k-mer best (share of its range)'))
    return _cache(state, ids[0], key, compute)


_BATCHES = {}


def submit_batch(state, job_id, regions, poll=2.0):
    """Find variants in each region with this run's datasets and settings: a background queue that submits the next
    region when the previous run has finished (a session runs one Find variants at a time). Returns the batch."""
    import threading
    import uuid as _uuid
    from lab.services import accessibility_workflow as W
    job = _job(state, job_id)
    if not isinstance(regions, list) or not regions:
        raise ValueError('regions: a list of {chrom, start, end, label}')
    if len(regions) > 50:
        raise ValueError('At most 50 regions per batch')
    base = dict(job.get('request') or {})
    params = {k: v for k, v in (base.get('parameters') or {}).items() if k != 'nfr_regions'}
    reqs = []
    for r in regions:
        if not isinstance(r, dict):
            raise ValueError('each region is {chrom, start, end, label}')
        reqs.append((r, dict(base, chrom=str(r['chrom']), start=int(r['start']), end=int(r['end']), parameters=params,
                             region_source='catalog', region_label=str(r.get('label') or '')[:120])))
    bid = _uuid.uuid4().hex
    batch = dict(id=bid, status='running', jobs=[dict(region=r, job_id=None, status='waiting') for r, _q in reqs])
    _BATCHES[bid] = batch
    jobs, lock = W._session(state)

    def busy():
        with lock:
            return any(j['status'] in ('queued', 'running', 'cancelling') for j in jobs.values())

    def run():
        import time as _t
        for i, (_r, req) in enumerate(reqs):
            while busy():
                _t.sleep(poll)
            try:
                sub = W.submit(state, req)
                batch['jobs'][i].update(job_id=sub['job_id'], status='submitted')
            except ValueError as error:
                batch['jobs'][i].update(status='error', message=str(error))
                continue
            while True:
                with lock:
                    st = (jobs.get(batch['jobs'][i]['job_id']) or {}).get('status')
                if st not in ('queued', 'running', 'cancelling'):
                    batch['jobs'][i]['status'] = st or 'gone'
                    break
                _t.sleep(poll)
        batch['status'] = 'complete'
    import contextvars
    context = contextvars.copy_context()
    threading.Thread(target=lambda: context.run(run), daemon=True, name='accessibility-batch').start()
    return dict(batch)


def get_batch(batch_id):
    b = _BATCHES.get(batch_id)
    if b is None:
        raise KeyError(batch_id)
    return dict(b)


def _run_genome(state, job):
    from services import motifs as M
    from services.panel_genomes import for_datasets
    ref_state = for_datasets(state, (job.get('request') or {}).get('dataset_ids') or [])
    genome = M.coordinate_genome(ref_state)   # peaks are looked up by coordinates: never a declared genome
    if not genome:
        raise ValueError('No assembly is known for this run (load the genome, e.g. dm6 or hg38) for ChIP-Atlas')
    return genome


def chipatlas_peaks(state, job_id, factors, max_per_factor=None, cell_type_classes=None, cell_types=None):
    """Start fetching ChIP-Atlas peaks of ``factors`` over the run's window (services/chipatlas_peaks.py), from the
    experiments of the chosen cell type classes and cell types (empty: any)."""
    from lab.services import chipatlas_peaks as CP
    job = _job(state, job_id)
    genome = _run_genome(state, job)
    return CP.submit(state, job_id, job['result'], genome, factors, max_per_factor or CP.MAX_PER_FACTOR,
                     cell_type_classes=cell_type_classes, cell_types=cell_types)


def chipatlas_experiments(state, job_id, factors=None, cell_type_classes=None, cell_types=None):
    """The ChIP-Atlas experiment selector for this run's assembly: cell type classes and cell types with their counts
    over the factors, and how many experiments the choice matches (services/chipatlas_peaks.facets)."""
    from lab.services import chipatlas_peaks as CP
    job = _job(state, job_id)
    return CP.facets(_run_genome(state, job), factors, cell_type_classes, cell_types)


def _class_layers(A, result, nfr, c, cache):
    from lab.services import accessibility_occupancy as OC
    members = {v['name']: A.member_uids(result, v['id']) for v in nfr['variants']}
    centre = (c['start'] + c['end'])/2
    core = int(max(1, min(60, round(c['end'] - c['start']))))
    min_gap = int((result.get('parameters') or {}).get('min_gap_bp', 60))
    layers, _cover = OC.site_layers(result, members, centre, [c], core, min_gap, cache)
    return layers


def nfr_classes(state, job_id, nfr_id):
    """The footprint classes (Find classes) inside an NFR, each with the hierarchy per variant at its centre: open
    (NFR shape) and member given open."""
    from lab.services import accessibility_occupancy as OC
    A = _analysis()
    job = _job(state, job_id)
    result = job['result']
    nfr = _nfr_of(result, nfr_id)
    src = OC.class_source(state, job)
    lo = min([nfr['start']] + [v['L'] for v in nfr['variants']])
    hi = max([nfr['end']] + [v['R'] for v in nfr['variants']])
    cache = {}
    out = []
    for c in sorted((c for c in src['classes'] if c['end'] > lo and c['start'] < hi), key=lambda c: c['start']):
        out.append(dict(id=c['id'], class_id=c.get('class_id') or c['id'], label=c.get('label') or c['id'], start=c['start'],
                        end=c['end'], prevalence=c.get('prevalence'), layers=_class_layers(A, result, nfr, c, cache),
                        inside=[v['name'] for v in nfr['variants'] if v['L'] <= (c['start'] + c['end'])/2 < v['R']]))
    return dict(nfr=nfr_id, class_job=src['job_id'], joined=src['joined'], classes=out, reason=src.get('reason'))


def class_cooccupancy(state, job_id, nfr_id, min_reads=10):
    """Two footprint classes footprinted together on the same molecule (TF cooperativity), within each variant: among
    the variant's member reads open at both classes and labelled by both, the 2 x 2 of footprinted at A x at B,
    stratified by channel (dataset and strand) as a Mantel-Haenszel odds ratio with the CMH test; BH across pairs x
    variants. Odds ratio > 1: bound together more often than independently."""
    from lab.services import accessibility_occupancy as OC
    from lab.services.accessibility_pooled import cmh
    from services.motif_scoring import bh
    A = _analysis()
    job = _job(state, job_id)
    result = job['result']
    nfr = _nfr_of(result, nfr_id)
    src = OC.class_source(state, job)
    lo = min([nfr['start']] + [v['L'] for v in nfr['variants']])
    hi = max([nfr['end']] + [v['R'] for v in nfr['variants']])
    cls = sorted((c for c in src['classes'] if c['end'] > lo and c['start'] < hi), key=lambda c: c['start'])
    min_gap = int((result.get('parameters') or {}).get('min_gap_bp', 60))
    cache = {}
    mols = result['molecules']
    out = []
    for v in nfr['variants']:
        members = A.member_uids(result, v['id'])
        for i in range(len(cls)):
            for j in range(i + 1, len(cls)):
                a, b = cls[i], cls[j]
                if min(a['end'], b['end']) > max(a['start'], b['start']):
                    continue                      # overlapping classes: one molecule cannot carry both
                ca, cb = (a['start'] + a['end'])/2, (b['start'] + b['end'])/2
                strata = {}
                for u in members:
                    m = mols.get(u)
                    if m is None or u not in a['state'] or u not in b['state']:
                        continue
                    if OC.read_state(m, ca, min_gap, cache) != 'open' or OC.read_state(m, cb, min_gap, cache) != 'open':
                        continue
                    t = strata.setdefault(f"{m['dataset']}::{m.get('strand')}", [0, 0, 0, 0])
                    t[(0 if a['state'][u] == 1 else 2) + (0 if b['state'][u] == 1 else 1)] += 1
                n = sum(sum(t) for t in strata.values())
                if n < min_reads:
                    continue
                tot = [sum(t[k] for t in strata.values()) for k in range(4)]
                stat = cmh([tuple(t) for t in strata.values()])
                exp_both = ((tot[0] + tot[1])*(tot[0] + tot[2])/n) if n else None
                out.append(dict(variant=v['name'], a=a.get('label') or a['id'], b=b.get('label') or b['id'], a_id=a['id'], b_id=b['id'],
                                distance=round(cb - ca), reads=n, table=tot, both=tot[0], expected_both=None if exp_both is None else round(exp_both, 2),
                                odds_ratio=stat['odds_ratio'], log2=stat['log2'], p=stat['p'], strata=stat['strata'],
                                direction=stat.get('direction')))
    for r, q in zip(out, bh([r['p'] for r in out])):
        r['q'] = q
    out.sort(key=lambda r: (r['q'] if r['q'] is not None else 2, r['variant']))
    return dict(nfr=nfr_id, class_job=src['job_id'], pairs=out, definition=(
        'Among the variant\'s member reads open at both classes and labelled by both: footprinted at A x at B (2 x 2 per '
        'channel), Mantel-Haenszel odds ratio and CMH test; BH across pairs and variants. Odds ratio > 1: footprinted '
        'together more often than independently (cooperative); < 1: one excludes the other'))


def nfr_conservation(state, job_id, nfr_id, flank=300, opener=None):
    """Per-base conservation (UCSC phyloP, the assembly's curated track) over the NFR's window, read remotely on
    request (a small region of the bigWig); None values where the track has none."""
    from services import motifs as M
    from services.external_ucsc import UCSC_CURATED_TRACKS
    from services.panel_genomes import for_datasets
    job = _job(state, job_id)
    nfr = _nfr_of(job['result'], nfr_id)
    genome = M.coordinate_genome(for_datasets(state, (job.get('request') or {}).get('dataset_ids') or []))
    track = next((t for t in UCSC_CURATED_TRACKS.get(genome or '', []) if str(t.get('id', '')).lower().startswith('phylop')), None)
    if track is None:
        raise ValueError(f'No conservation track is known for {genome or "this assembly"} (phyloP: hg38, hg19, mm39, mm10, dm6, sacCer3)')
    lo, hi = _window(nfr, int(flank))

    def compute():
        import pyBigWig
        bw = (opener or pyBigWig.open)(track['url'])
        try:
            chrom = job['result']['region']['chrom']
            names = set((bw.chroms() or {}).keys())
            c = chrom if chrom in names else (f'chr{chrom}' if f'chr{chrom}' in names else chrom)
            vals = [float('nan')]*(int(hi) - int(lo))
            if c in names:
                a, b = max(0, int(lo)), min(int(hi), int(bw.chroms(c)))
                if b > a:
                    vals[a - int(lo):b - int(lo)] = bw.values(c, a, b)
        finally:
            bw.close()
        return dict(nfr=nfr_id, genome=genome, track=track.get('label') or track['id'], url=track['url'], window=[lo, hi],
                    values=[None if v != v else round(float(v), 2) for v in vals])
    return _cache(state, job_id, ('conservation', nfr_id, int(flank), track['url']), compute)


def class_variants(state, job_id, class_id):
    """The NFR variants a footprint class sits in (class span overlapping the NFR), with the hierarchy per variant."""
    from lab.services import accessibility_occupancy as OC
    A = _analysis()
    job = _job(state, job_id)
    result = job['result']
    src = OC.class_source(state, job)
    c = next((c for c in src['classes'] if c['id'] == class_id or c.get('class_id') == class_id), None)
    if c is None:
        raise ValueError(f'No footprint class {class_id!r} joined to this run')
    cache = {}
    out = []
    for nfr in result['nfrs']:
        if not nfr.get('variants'):
            continue
        lo = min([nfr['start']] + [v['L'] for v in nfr['variants']])
        hi = max([nfr['end']] + [v['R'] for v in nfr['variants']])
        if c['end'] <= lo or c['start'] >= hi:
            continue
        out.append(dict(nfr=nfr['id'], layers=_class_layers(A, result, nfr, c, cache),
                        inside=[v['name'] for v in nfr['variants'] if v['L'] <= (c['start'] + c['end'])/2 < v['R']]))
    return dict(class_id=class_id, label=c.get('label') or class_id, start=c['start'], end=c['end'], class_job=src['job_id'], nfrs=out)


def variant_motifs(state, job_id, variant_id, **options):
    """The NFR's motif analysis (``nfr_motifs``) with this variant as the focus."""
    nfr_id, _, name = variant_id.partition(':')
    result = _result(state, job_id)
    nfr = next((n for n in result['nfrs'] if n['id'] == nfr_id), None)
    if nfr is None or not any(v['name'] == name for v in nfr.get('variants') or ()):
        raise ValueError(f'No variant {variant_id!r} in this run')
    return dict(nfr_motifs(state, job_id, nfr_id, **options), focus=name, variant=variant_id)


def _round(v, nd=3):
    return None if v is None else round(float(v), nd)


def _pct(v):
    return '–' if v is None else f'{100*v:.0f}%'


def sequence_features(seq, lo):
    """GC%, CpG count and observed/expected ratio, and poly(dA:dT) tracts (runs of >= 6 A or >= 6 T on one strand:
    nucleosome-disfavouring) of a sequence starting at ``lo``."""
    import re
    s = seq.upper()
    n = sum(1 for c in s if c in 'ACGT')
    gc = sum(1 for c in s if c in 'GC')
    c, g = s.count('C'), s.count('G')
    cpg = s.count('CG')
    tracts = [dict(start=lo + m.start(), end=lo + m.end(), base=m.group()[0], length=m.end() - m.start())
              for m in re.finditer(r'A{6,}|T{6,}', s)]
    return dict(bp=n, gc=round(gc/n, 4) if n else None, cpg=cpg,
                cpg_oe=round(cpg*n/(c*g), 3) if c and g else None, tracts=tracts, tract_bp=sum(t['length'] for t in tracts))


def variant_sequence(state, job_id, variant_id, flank=300, window=50):
    """Sequence features of the variant's open span next to its siblings', the NFR's flanks, and a GC% track; and
    the reference bases of the window (``sequence``, aligned to ``window`` on ``chrom``)."""
    job = _job(state, job_id)
    result = job['result']
    nfr_id, _, name = variant_id.partition(':')
    nfr = next((n for n in result['nfrs'] if n['id'] == nfr_id), None)
    if nfr is None or not any(v['name'] == name for v in nfr.get('variants') or ()):
        raise ValueError(f'No variant {variant_id!r} in this run')

    def compute():
        lo, hi = _window(nfr, int(flank))
        _ref, seq = _reference(state, job, lo, hi)
        spans = {}
        for v in nfr['variants']:
            a, b = int(round(v['L'])), int(round(v['R']))
            spans[v['name']] = dict(span=[a, b], **sequence_features(seq[a - lo:b - lo], a))
        left = sequence_features(seq[:max(0, int(nfr['start']) - lo)], lo)
        right = sequence_features(seq[int(nfr['end']) - lo:], int(nfr['end']))
        step = 10
        xs = list(range(lo, hi - window + 1, step))
        track = []
        for x in xs:
            w = seq[x - lo:x - lo + window].upper()
            k = sum(1 for ch in w if ch in 'ACGT')
            track.append(None if not k else round(sum(1 for ch in w if ch in 'GC')/k, 3))
        whole = sequence_features(seq, lo)
        # the bases themselves (for Copy sequence / FASTA): the reference of the run's datasets, so an alt-allele
        # dataset's synthetic contig; blanks past a contig end are kept so positions stay aligned to ``window``
        return dict(variant=variant_id, window=[lo, hi], chrom=result['region']['chrom'], sequence=seq, variants=spans, flanks=dict(left=left, right=right),
                    gc_track=dict(x=[x + window/2 for x in xs], gc=track, window=window), tracts=whole['tracts'],
                    definitions=dict(tracts='runs of >= 6 A or >= 6 T (poly(dA:dT); nucleosome-disfavouring)',
                                     cpg_oe='CpG observed / expected = CpG x length / (C x G)'))
    return _cache(state, job_id, ('sequence', variant_id, int(flank), int(window)), compute)


# ------------------------------------------------------------------ quantify in other datasets
def _transfers(state):
    jobs, lock = _session(state)
    with lock:
        if '_transfers' not in state.__dict__:
            state._transfers = {}
        return state._transfers, lock


def submit_transfer(state, job_id, dataset_ids, nfr_id, chemistry_overrides=None):
    """Load other open datasets at the run's region (as Find variants would) and quantify one NFR's frozen variant
    catalogue on their reads: no discovery, the run's geometry. A small job: poll get_transfer."""
    A = _analysis()
    job = _job(state, job_id)
    result = job['result']
    nfr = next((n for n in result['nfrs'] if n['id'] == nfr_id), None)
    if nfr is None:
        raise ValueError(f'No NFR {nfr_id!r} in this run')
    if not nfr.get('catalogue'):
        raise ValueError('This run predates frozen catalogues: run Find variants again to quantify it elsewhere.')
    ids = list(dict.fromkeys(str(d) for d in dataset_ids or ()))
    if not ids:
        raise ValueError('Choose one or more datasets')
    from services.chemistry_metadata import dataset_consensus_chemistry
    from services.panel_genomes import dataset_genome
    run_ids = (job.get('request') or {}).get('dataset_ids') or []
    genome = {dataset_genome(state, d) for d in run_ids}
    chem = {}
    for d in ids:
        ds = state.get_dataset(d)
        if ds is None:
            raise ValueError(f'Dataset {d!r} is no longer open')
        if getattr(ds, 'data_type', 'bam') != 'bam':
            raise ValueError(f'{ds.label}: only BAM datasets can be quantified')
        if {dataset_genome(state, d)} != genome:
            raise ValueError(f'{ds.label} is on another reference than the run')
        chem[d] = (chemistry_overrides or {}).get(d) or dataset_consensus_chemistry(ds)
        if chem[d] not in ('ddda', 'dddb', 'hia5-pacbio', 'hia5-nanopore'):
            raise ValueError(f'{ds.label}: set the assay type first (the dataset setup card in the NFRs or Footprints panel)')
    region = result['region']
    request = dict(dataset_ids=ids, chemistry_overrides=chem, chrom=region['chrom'], start=region['start'], end=region['end'],
                   loader_parameters=(job.get('request') or {}).get('loader_parameters'))
    from lab.services.accessibility_workflow import _loader_options
    options, _ = _loader_options(request)
    transfers, lock = _transfers(state)
    tid = uuid.uuid4().hex
    from services.consensus_workflow import _snapshot
    t = dict(transfer_id=tid, job_id=job_id, nfr=nfr_id, dataset_ids=ids, status='queued', message='Waiting for the Accessibility worker',
             created_at=time.time(), _cancel=threading.Event(), _snapshot=_snapshot(state, ids))
    with lock:
        transfers[tid] = t

    def worker():
        try:
            def progress(stage, message=None, **_work):
                if t['_cancel'].is_set():
                    raise AccessibilityCancelled('Cancelled')
                with lock:
                    if t['status'] == 'queued' or t['status'] == 'running':
                        t.update(status='running', message=message or stage)
            progress.report = progress
            progress('loading', 'Loading molecules through FiberHMM')
            from services.consensus_workflow import load_payload
            payload = load_payload(state, request, options, progress)
            progress('quantify', 'Quantifying the frozen variants')
            out = A.transfer(payload, result, nfr_id)
            from services.consensus_workflow import _same_sources, _snapshot
            with lock:
                if t['_cancel'].is_set():
                    raise AccessibilityCancelled('Cancelled before the result was installed')
                if not _same_sources(t['_snapshot'], _snapshot(state, ids)):
                    raise ValueError('The datasets changed during the quantification; the result was not installed')
                t.update(status='complete', message='Done', result=out, finished_at=time.time())
        except AccessibilityCancelled as exc:
            with lock:
                t.update(status='cancelled', message=str(exc))
        except Exception as exc:
            import traceback
            traceback.print_exc()
            with lock:
                t.update(status='error', message=str(exc))
    import contextvars
    t['_future'] = _EXECUTOR.submit(contextvars.copy_context().run, worker)
    return {k: v for k, v in t.items() if not k.startswith('_')}


def cancel_transfer(state, transfer_id):
    transfers, lock = _transfers(state)
    with lock:
        t = transfers.get(transfer_id)
        if t is None:
            raise KeyError(transfer_id)
        if t['status'] in ('queued', 'running'):
            t['_cancel'].set()
            t.update(status='cancelled', message='Cancelled')
        return {k: v for k, v in t.items() if not k.startswith('_')}


def dispose_transfers(state):
    """A new session: cancel and forget every quantification of the previous one."""
    if '_transfers' not in state.__dict__:
        return
    transfers, lock = _transfers(state)
    with lock:
        for t in transfers.values():
            t['_cancel'].set()
        transfers.clear()


def get_transfer(state, transfer_id):
    transfers, lock = _transfers(state)
    with lock:
        t = transfers.get(transfer_id)
        if t is None:
            raise KeyError(transfer_id)
        return {k: v for k, v in t.items() if not k.startswith('_')}
