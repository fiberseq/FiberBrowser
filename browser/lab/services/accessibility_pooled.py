"""Accessibility (preview): motif analysis pooled over every NFR of one or more runs (EXPERIMENTAL).

A single NFR has a handful of sites per motif, so nothing reaches significance there; pooled over NFRs (and runs,
e.g. a batch over the Regions catalogue) the same comparisons gain power. Per motif family and **variant type**:

* Variant types from the engine's geometry labels: full (the reference opening and full-like), core (narrower:
  core, trimmed), extended (wider), shifted, alternative (a separate register: alternative-, satellite-), merged.
* **Sites**: per NFR, the type's variants together: sites in the part of their spans no other variant covers against
  the other variants' own parts (disjoint; bp); pooled over NFRs as a Mantel-Haenszel rate ratio, with the exact
  conditional test (two-sided). One stratum per family, type and NFR.
* **Open** and **footprinted | open**: per NFR, at the family's site nearest the type's variants (chosen by position;
  sites of one family share molecules, so one site per NFR), the members of the type's variants against the members
  of the other variants, reads in both left out (2 x 2: open / closed; footprinted / not among open, class-labelled
  reads), pooled over NFRs as a Mantel-Haenszel odds ratio with the Cochran-Mantel-Haenszel test. Openness is largely set by where a variant's reads open; footprinting among open
  reads is the informative comparison.
* Families across NFRs: connected components of matrices that are versions of one another, share a name, or are
  similar (information-weighted column correlation >= the family threshold); a per-NFR family always lies inside
  one component. Benjamini-Hochberg q per measure, across every family x type cell tested.
"""
from __future__ import annotations

import threading

import numpy as np

TYPES = ('full', 'core', 'extended', 'shifted', 'alternative', 'merged', 'other')
TYPE_HELP = {
    'full': 'the reference opening (and full-like: both edges within the shift tolerance)',
    'core': 'narrower than the reference (core, trimmed-left / -right)',
    'extended': 'wider than the reference (extended, extended-left / -right)',
    'shifted': 'both edges moved the same way (shifted-left / -right)',
    'alternative': 'a separate opening register (alternative- / satellite-left / -right)',
    'merged': 'two variants merged into one opening',
    'other': 'any other label',
}
_sim_lock = threading.Lock()
_sim_cache = {}       # (id_a, id_b) -> similarity


def variant_type(relation):
    r = str(relation or '')
    if r in ('full', 'full-like'):
        return 'full'
    if r == 'core' or r.startswith('trimmed'):
        return 'core'
    if r.startswith('extended'):
        return 'extended'
    if r.startswith('shifted'):
        return 'shifted'
    if r.startswith(('alternative', 'satellite')):
        return 'alternative'
    if r.startswith('merged'):
        return 'merged'
    return 'other'


# ------------------------------------------------------------------ statistics
def _union_iv(iv):
    out = []
    for a, b in sorted((float(a), float(b)) for a, b in iv if b > a):
        if out and a <= out[-1][1]:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return out


def _minus_iv(iv, cut):
    out = []
    for a, b in _union_iv(iv):
        pieces = [[a, b]]
        for c, d in _union_iv(cut):
            nxt = []
            for x, y in pieces:
                if d <= x or c >= y:
                    nxt.append([x, y])
                    continue
                if c > x:
                    nxt.append([x, c])
                if d < y:
                    nxt.append([d, y])
            pieces = nxt
        out.extend(pieces)
    return out


def _len_iv(iv):
    return float(sum(b - a for a, b in _union_iv(iv)))


def _in_iv(c, iv):
    return any(a <= c < b for a, b in iv)


def exact_stratified_p(strata):
    """Exact two-sided conditional test of a common rate ratio of 1: given each stratum's total N_i, a_i ~ Binomial(N_i,
    t1_i / T_i) independently; the distribution of sum(a_i) is their convolution. p = min(1, 2 min(P(A <= obs),
    P(A >= obs)))."""
    from scipy.stats import binom
    dist = np.array([1.])
    obs = 0
    for a, t1, b, t0 in strata:
        n = int(a + b)
        pmf = binom.pmf(np.arange(n + 1), n, t1/(t1 + t0))
        dist = np.convolve(dist, pmf)
        obs += int(a)
    lower = float(dist[:obs + 1].sum())
    upper = float(dist[obs:].sum())
    return min(1., 2*min(lower, upper))


def mh_rate_ratio(strata):
    """strata: [(a, t1, b, t0)] counts and exposures (group 1: a events in t1; group 0: b in t0). Mantel-Haenszel
    rate ratio and the exact conditional test (two-sided; small counts are common here, where the score test's normal
    approximation fails); strata without events or exposure are skipped."""
    num = den = obs = exp = var = 0.
    used = 0
    kept = []
    for a, t1, b, t0 in strata:
        n, T = a + b, t1 + t0
        if n <= 0 or t1 <= 0 or t0 <= 0:
            continue
        used += 1
        kept.append((a, t1, b, t0))
        num += a*t0/T
        den += b*t1/T
        obs += a
        exp += n*t1/T
        var += n*t1*t0/T**2
    if not used or var <= 0:
        return dict(strata=used, events=int(obs), expected=round(exp, 3), ratio=None, log2=None, p=None)
    rr = num/den if den > 0 and num > 0 else None           # 0 or infinite: not estimable, the test still holds
    return dict(strata=used, events=int(obs), expected=round(exp, 3), ratio=None if rr is None else round(float(rr), 4),
                log2=None if rr is None else round(float(np.log2(rr)), 3), p=exact_stratified_p(kept),
                direction=1 if obs > exp else -1 if obs < exp else 0)


def cmh(tables):
    """tables: [(a, b, c, d)] 2 x 2 per stratum (row 1: event / no event in the group; row 2: the comparison).
    Mantel-Haenszel odds ratio (None when 0 or infinite) and the Cochran-Mantel-Haenszel test with the continuity
    correction."""
    from scipy.stats import chi2
    num = den = s_a = s_e = s_v = 0.
    used = 0
    for a, b, c, d in tables:
        n = a + b + c + d
        if n < 2 or (a + b) == 0 or (c + d) == 0 or (a + c) == 0 or (b + d) == 0:
            continue
        used += 1
        num += a*d/n
        den += b*c/n
        s_a += a
        s_e += (a + b)*(a + c)/n
        s_v += (a + b)*(c + d)*(a + c)*(b + d)/(n*n*(n - 1))
    if not used or s_v <= 0:
        return dict(strata=used, odds_ratio=None, log2=None, p=None)
    stat = max(0., abs(s_a - s_e) - 0.5)**2/s_v              # with the continuity correction (small counts)
    orr = num/den if den > 0 and num > 0 else None          # 0 or infinite: not estimable, the test still holds
    return dict(strata=used, odds_ratio=None if orr is None else round(float(orr), 4),
                log2=None if orr is None else round(float(np.log2(orr)), 3), p=float(chi2.sf(stat, 1)),
                direction=1 if s_a > s_e else -1 if s_a < s_e else 0)


# ------------------------------------------------------------------ families across NFRs
def components(records, similarity_min):
    """{matrix_id: component} over the records (dicts with matrix_id, name, counts): versions / same names, or
    similar matrices, are joined."""
    from services.motif_scoring import similarity
    ids = [r['matrix_id'] for r in records]
    parent = {i: i for i in ids}

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    for x in range(len(records)):
        for y in range(x + 1, len(records)):
            a, b = records[x], records[y]
            same = a['name'].lower() == b['name'].lower() or a['matrix_id'].split('.')[0] == b['matrix_id'].split('.')[0]
            if not same:
                fp = lambda r: (r['matrix_id'], hash(tuple(tuple(float(x) for x in r['counts'][k]) for k in 'ACGT')))  # noqa: E731
                key = tuple(sorted((fp(a), fp(b))))
                with _sim_lock:
                    s = _sim_cache.get(key)
                if s is None:
                    s = similarity(a['counts'], b['counts'])
                    with _sim_lock:
                        _sim_cache[key] = s
                if s < similarity_min:
                    continue
            ra, rb = find(a['matrix_id']), find(b['matrix_id'])
            if ra != rb:
                parent[rb] = ra
    return {i: find(i) for i in ids}


# ------------------------------------------------------------------ the pooled analysis
def pooled(runs, records, similarity_min, min_reads, site_layers, member_uids):
    """runs: [(job_id, result, classes, [(nfr, motifs output)])] (classes: accessibility_occupancy.class_source); records: the scanned matrices (for the families);
    site_layers / member_uids: lab.services.accessibility_occupancy.site_layers and the analysis member_uids."""
    from services.motif_scoring import bh
    from lab.services.accessibility_occupancy import DEFAULT_CORE_BP
    seen = {}
    for _job, _result, _classes, nfrs in runs:
        for _nfr, m in nfrs:
            for row in m['families']:
                for mem in row['members']:
                    seen.setdefault(mem['id'], None)
    recs = [r for r in records if r['matrix_id'] in seen]
    comp = components(recs, similarity_min)
    names = {r['matrix_id']: r['name'] for r in recs}
    cells = {}                    # (component, type) -> {'sites': [...], 'open': [...], 'fp': [...]}
    comp_members = {}
    comp_sites = {}
    n_nfrs = 0
    for job_id, result, run_classes, nfrs in runs:
        mols = result.get('molecules') or {}
        min_gap = int((result.get('parameters') or {}).get('min_gap_bp', 60))
        cache = {}
        for nfr, m in nfrs:
            variants = nfr.get('variants') or []
            if len(variants) < 2:
                continue
            n_nfrs += 1
            members = {v['name']: member_uids(result, v['id']) for v in variants}
            spans = {v['name']: (float(v['L']), float(v['R'])) for v in variants}
            vtype = {v['name']: variant_type(v.get('relation')) for v in variants}
            classes = (run_classes or {}).get('classes') or []
            core = int((m.get('occupancy') or {}).get('core_bp') or DEFAULT_CORE_BP)
            # per family across NFRs (component): the union of its local rows' sites, so a component is one row here
            by_comp = {}
            for row in m['families']:
                rep = comp.get(row['id'])
                if rep is None:
                    continue
                g = by_comp.setdefault(rep, dict(sites=[], names=set(), region_sites=0))
                g['names'].update(x['name'] for x in row['members'])
                g['region_sites'] += row['region_sites']
                g['sites'].extend(row['sites'])
            for rep, g in by_comp.items():
                comp_members.setdefault(rep, set()).update(g['names'])
                comp_sites[rep] = comp_sites.get(rep, 0) + g['region_sites']
                sites = sorted({(s['start'], s['end']): s for s in g['sites']}.values(), key=lambda s: s['start'])
                centres = [(s['start'] + s['end'])/2 for s in sites]
                # one stratum per variant type and NFR: the type's variants together against the other variants
                for t in sorted(set(vtype.values())):
                    mine_names = [n for n in spans if vtype[n] == t]
                    other_names = [n for n in spans if vtype[n] != t]
                    if not other_names:
                        continue
                    cell = cells.setdefault((rep, t), dict(sites=[], open=[], fp=[], nfrs=set()))
                    cell['nfrs'].add((job_id, nfr['id']))
                    own = _minus_iv([spans[n] for n in mine_names], [spans[n] for n in other_names])
                    sib = _minus_iv([spans[n] for n in other_names], [spans[n] for n in mine_names])
                    t1, t0 = _len_iv(own), _len_iv(sib)
                    if t1 > 0 and t0 > 0:
                        a = sum(1 for c in centres if _in_iv(c, own))
                        b = sum(1 for c in centres if _in_iv(c, sib))
                        cell['sites'].append((a, t1, b, t0))
                    if not mols or not sites:
                        continue
                    mine = set().union(*[members[n] for n in mine_names])
                    rest = set().union(*[members[n] for n in other_names]) - mine
                    mine = mine - set().union(*[members[n] for n in other_names])        # disjoint groups
                    L0, R0 = min(spans[n][0] for n in mine_names), max(spans[n][1] for n in mine_names)
                    dist = lambda st: max(0., L0 - (st['start'] + st['end'])/2, (st['start'] + st['end'])/2 - R0)  # noqa: E731
                    best_open = best_fp = None
                    for st in sorted(sites, key=lambda st: (dist(st), st['start'])):
                        c = (st['start'] + st['end'])/2
                        layers, cover = site_layers(result, {'v': mine, 'rest': rest}, c, classes, core, min_gap, cache)
                        av, rv = layers['v'], layers['rest']
                        if best_open is None and av['reads'] >= min_reads and rv['reads'] >= min_reads:
                            best_open = (av['open'], av['reads'] - av['open'], rv['open'], rv['reads'] - rv['open'])
                        if best_fp is None and cover and av['labelled'] >= min_reads and rv['labelled'] >= min_reads:
                            best_fp = (av['footprinted'], av['labelled'] - av['footprinted'], rv['footprinted'], rv['labelled'] - rv['footprinted'])
                        if best_open and best_fp:
                            break
                    if best_open:
                        cell['open'].append(best_open)
                    if best_fp:
                        cell['fp'].append(best_fp)
    out = []
    for (rep, t), cell in cells.items():
        out.append(dict(family=rep, type=t, nfrs=len(cell['nfrs']), sites=mh_rate_ratio(cell['sites']),
                        open=cmh(cell['open']), footprinted=cmh(cell['fp'])))
    for measure in ('sites', 'open', 'footprinted'):
        qs = bh([c[measure]['p'] for c in out])
        for c, q in zip(out, qs):
            c[measure]['q'] = q
    fams = []
    for rep in sorted(comp_members, key=lambda r: -comp_sites.get(r, 0)):
        mem = sorted(comp_members[rep])
        fams.append(dict(id=rep, name=names.get(rep, rep), members=mem, sites=comp_sites.get(rep, 0)))
    present = [t for t in TYPES if any(c['type'] == t for c in out)]
    return dict(families=fams, types=present, type_help={t: TYPE_HELP[t] for t in present}, cells=out, nfrs=n_nfrs,
                runs=len(runs), definitions=dict(
                    sites='Sites in the part of the type\'s spans no other variant covers against the other variants\' own parts; '
                          'Mantel-Haenszel rate ratio over NFRs, exact conditional test',
                    open='Open at the family\'s site nearest the type\'s variants, per NFR: their members against the other variants\' '
                         '(reads in both left out); Mantel-Haenszel odds ratio over NFRs, CMH test. Largely set by where each '
                         'variant\'s reads open',
                    footprinted='Footprinted among open, class-labelled reads at the family\'s nearest site under a footprint '
                                'class: the same comparison',
                    families='Families across NFRs: versions, same names or similar matrices (connected components)',
                    q='Benjamini-Hochberg q per measure across every family x type cell tested'))
