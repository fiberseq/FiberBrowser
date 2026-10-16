"""Accessibility (preview): motifs of an NFR's variants (EXPERIMENTAL).

One scan per NFR, every variant side by side:

* **Sites** pass a per-matrix p-value (default p < 1e-4), from each PSSM's exact score distribution under a 0-order
  background (``services.motifs.ScoredMatrix``, as FIMO / MOODS). A relative score cut-off (0-1) is kept as an option.
  Background (default 'local'): the base composition of the NFR +- ``bg_flank`` bp (both strands: A = T, C = G); the
  log-odds matrices are built against the same background (JASPAR pseudocounts). 'uniform' uses 25% each.
* **Enrichment** per motif family and variant: sites centred in the variant's span against the local background
  (the region minus every NFR and variant span of the run): a conditional binomial test of the two rates (one-sided,
  more sites in the span), and against the background model's own expectation (Poisson, both strands, an upper
  bound so conservative). Benjamini-Hochberg q across the families tested, per variant.
* **Differential** between the variants: sites in the part of a variant's span no sibling covers against the part
  the siblings cover and it does not (conditional binomial, BH across families). The share of each variant's member
  reads open at a site is shown as the observation that confirms it; it is not a separate test, since members are
  assigned by where they open.
* **Families**: matrices of similar shape (information-weighted column correlation >= 0.8) whose sites mostly
  coincide here, or versions of one matrix, collapse into one row naming its members; its sites are the union.
* **Pinned key factors** (per species, editable) are always reported, with or without sites.
"""
from __future__ import annotations

import time

import numpy as np

from services.motif_scoring import (  # noqa: F401  (re-exported: tests, older callers)
    COMMON_NAMES, DEFAULT_BG_FLANK, DEFAULT_FLANK, DEFAULT_P, FAMILY_SIMILARITY, FAMILY_SITE_SHARE, PINNED_DEFAULTS,
    _merge_sites, _overlaps, _record, _resolve, _scored, _shape, _shared, bh, catalogue, common_name, families,
    pinned_defaults, scan, scan_nfr, similarity, species_key,
)

# ------------------------------------------------------------------ geometry helpers
def _union(intervals):
    out = []
    for a, b in sorted((float(a), float(b)) for a, b in intervals if b > a):
        if out and a <= out[-1][1]:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return out


def _minus(intervals, cut):
    """intervals minus cut (both lists of [a, b])."""
    out = []
    for a, b in _union(intervals):
        pieces = [[a, b]]
        for c, d in _union(cut):
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


def _inside(c, intervals):
    """Half-open, as _minus and _length: a site centred on a boundary belongs to the interval starting there."""
    return any(a <= c < b for a, b in intervals)


def window_exposure(valid_starts, lo, length, intervals):
    """Positions where a site of ``length`` could be centred inside the intervals (half-open): window starts whose
    whole window is called bases (``valid_starts``: a prefix sum over starts) and whose centre start + length/2
    falls inside."""
    n = 0
    total = len(valid_starts) - 1
    for a, b in _union(intervals):
        i = max(0, int(np.ceil(a - lo - length/2)))
        j = min(total, int(np.ceil(b - lo - length/2)))
        if j > i:
            n += int(valid_starts[j] - valid_starts[i])
    return float(n)


def _length(intervals, called=None, lo=0):
    """Total bp of the intervals; with ``called`` (a bool array from ``lo``), only called bases count."""
    if called is None:
        return float(sum(b - a for a, b in _union(intervals)))
    n = 0
    for a, b in _union(intervals):
        i, j = max(0, int(np.ceil(a)) - lo), min(len(called), int(np.floor(b)) - lo)
        if j > i:
            n += int(called[i:j].sum())
    return float(n)


# ------------------------------------------------------------------ statistics
def rate_test(n_a, len_a, n_b, len_b):
    """One-sided conditional binomial test that the site rate in A exceeds B's (the exact test of two Poisson rates):
    P(X >= n_a), X ~ Binom(n_a + n_b, len_a / (len_a + len_b)). None when either length is 0."""
    from scipy.stats import binom
    if len_a <= 0 or len_b <= 0:
        return None
    if n_a <= 0:
        return 1.0
    return float(binom.sf(n_a - 1, n_a + n_b, len_a/(len_a + len_b)))


def poisson_test(n, lam):
    from scipy.stats import poisson
    if n <= 0:
        return 1.0
    if lam <= 0:
        return 0.0
    return float(poisson.sf(n - 1, lam))


def _log2ratio(n_a, len_a, n_b, len_b):
    if len_a <= 0 or len_b <= 0:
        return None
    return round(float(np.log2(((n_a + .5)/len_a)/((n_b + .5)/len_b))), 3)


def nfr_motifs(result, nfr, seq, region, profiles, records, *, species=None, pinned_info=None, p=DEFAULT_P, relative=None,
               background='local', flank=DEFAULT_FLANK, bg_flank=DEFAULT_BG_FLANK, warnings=None, genome_comp=None,
               strand='both', family_similarity=None):
    """The motif analysis of one NFR (see the module docstring). ``seq`` covers ``region`` = (lo, hi); ``profiles``:
    FiberHMM's variant_profiles over the window (member reads' openness)."""
    t0 = time.time()
    warnings = list(warnings or [])
    lo, hi = region
    variants = nfr.get('variants') or []
    names = [v['name'] for v in variants]
    spans = {v['name']: [float(v['L']), float(v['R'])] for v in variants}
    w_lo = max(lo, int(min([nfr['start']] + [v['L'] for v in variants])) - flank)
    w_hi = min(hi, int(max([nfr['end']] + [v['R'] for v in variants])) + flank)
    called = np.frombuffer(seq.upper().encode('ascii', 'replace'), dtype=np.uint8)
    called = np.isin(called, np.frombuffer(b'ACGT', dtype=np.uint8))
    # local background: the region minus every NFR and variant span of the run (other open DNA is not background)
    opened = [[n['start'], n['end']] for n in result.get('nfrs') or ()] + \
             [[v['L'], v['R']] for n in result.get('nfrs') or () for v in n.get('variants') or ()]
    bg_iv = _minus([[lo, hi]], opened)
    bg_len = _length(bg_iv, called, lo)
    entries, comp, unreachable = scan(seq, lo, records, p=p, relative=relative, background=background,
                                      genome_comp=genome_comp, strand=strand)
    starts_by_length = {}

    def valid_starts(length):
        """Prefix sum over window starts whose whole window (``length`` bases) is called."""
        if length not in starts_by_length:
            ok = np.zeros(0, bool) if len(called) < length else \
                np.lib.stride_tricks.sliding_window_view(called, length).all(axis=1)
            starts_by_length[length] = np.concatenate([[0], np.cumsum(ok)])
        return starts_by_length[length]

    def exposure(members, intervals):
        """(mean eligible centres over the reachable members, the model's expected count): each member's own
        windows, its own per-position rate (both strands, an upper bound)."""
        reach = [e for e in members if e['reachable']] or members
        ex = [window_exposure(valid_starts(e['length']), lo, e['length'], intervals) for e in reach]
        lam = sum(2*e['p_site']*x for e, x in zip(reach, ex) if e['reachable'])
        return (sum(ex)/len(ex) if ex else 0.), lam
    with_sites = [e for e in entries if e['sites']]
    groups = families(with_sites, family_similarity)
    # a matrix without sites (or unreachable) joins its namesake's family (another version, the same pinned name);
    # otherwise it is its own family (tested, p = 1), so the BH m counts it
    for e in entries:
        if e['sites']:
            continue
        def compatible(g):
            pins = {x['pinned_as'] for x in g if x.get('pinned_as')}
            return not (e.get('pinned_as') and pins and pins != {e['pinned_as']})
        home = next((g for g in groups if compatible(g) and any(
            x['name'].lower() == e['name'].lower() or x['matrix_id'].split('.')[0] == e['matrix_id'].split('.')[0]
            or (e.get('pinned_as') and x.get('pinned_as') == e['pinned_as']) for x in g)), None)
        if home is None:
            groups.append([e])
        else:
            home.append(e)
    x = np.asarray(profiles['x'], float)

    def open_at(name, c):
        prof = (profiles['variants'].get(name) or {}).get('profile')
        return None if not prof or not len(x) else round(float(np.interp(c, x, prof)), 3)
    members_n = {n: int((profiles['variants'].get(n) or {}).get('n') or 0) for n in names}
    own_only = {n: _minus([spans[n]], [spans[m] for m in names if m != n]) for n in names}
    sib_only = {n: _minus([spans[m] for m in names if m != n], [spans[n]]) for n in names}
    rows = []
    for members in groups:
        pinned = sorted({e['pinned_as'] for e in members if e.get('pinned_as')})
        sites = _merge_sites([s for e in members for s in e['sites']])
        centres = [(s['start'] + s['end'])/2 for s in sites]
        bg_ex, bg_lam = exposure(members, bg_iv)
        n_bg = sum(1 for c in centres if _inside(c, bg_iv))
        enr, diff = {}, {}
        for n in names:
            a, b = spans[n]
            k = sum(1 for c in centres if a <= c < b)
            ex, lam = exposure(members, [spans[n]])
            enr[n] = dict(sites=k, bp=ex, expected=round(lam, 4), log2_vs_local=_log2ratio(k, ex, n_bg, bg_ex),
                          p_local=rate_test(k, ex, n_bg, bg_ex), p_model=poisson_test(k, lam))
            k_o = sum(1 for c in centres if _inside(c, own_only[n]))
            k_s = sum(1 for c in centres if _inside(c, sib_only[n]))
            len_o, len_s = exposure(members, own_only[n])[0], exposure(members, sib_only[n])[0]
            diff[n] = dict(only=k_o, only_bp=len_o, siblings=k_s, siblings_bp=len_s, p=rate_test(k_o, len_o, k_s, len_s),
                           log2_vs_siblings=_log2ratio(k_o, len_o, k_s, len_s))
        shown = []
        for s, c in zip(sites, centres):
            if not w_lo <= c < w_hi:
                continue
            opens = {n: open_at(n, c) for n in names}
            shown.append(dict(s, open=opens, **{'in': [n for n in names if spans[n][0] <= c < spans[n][1]]}))
        # open contrast at the variant's own-only sites (the confirming observation)
        for n in names:
            best = None
            for s in shown:
                c = (s['start'] + s['end'])/2
                if not _inside(c, own_only[n]) or s['open'].get(n) is None:
                    continue
                others = [v for m, v in s['open'].items() if m != n and v is not None]
                delta = s['open'][n] - (min(others) if others else 0.)
                if best is None or delta > best[0]:
                    best = (delta, s)
            diff[n]['open_delta'] = None if best is None else round(best[0], 3)
            diff[n]['open_site'] = None if best is None else best[1]['start']
        rep = _representative(members, pinned, names, spans)
        rows.append(dict(
            id=rep['matrix_id'], name=rep['name'], common=common_name(rep['name']), pinned=pinned,
            members=[dict(id=e['matrix_id'], name=e['name'], common=common_name(e['name']), length=e['length'],
                          min_p=e['min_p'], reachable=e['reachable'], source=e.get('source'), tax_group=e.get('tax_group'))
                     for e in sorted(members, key=lambda e: (e is not rep, e['name'].lower(), e['matrix_id']))],
            total=len(shown), region_sites=len(sites), background=dict(sites=n_bg, bp=bg_ex, expected=round(bg_lam, 3)),
            enrichment=enr, differential=diff, sites=shown, reachable=any(e['reachable'] for e in members)))
    m_tested = len(rows)
    for n in names:
        for key, src in (('q_local', 'p_local'), ('q_model', 'p_model')):
            qs = bh([r['enrichment'][n][src] for r in rows])
            for r, q in zip(rows, qs):
                r['enrichment'][n][key] = q
        qs = bh([r['differential'][n]['p'] for r in rows])
        for r, q in zip(rows, qs):
            r['differential'][n]['q'] = q

    def best_q(r, part, key):
        vals = [r[part][n][key] for n in names if r[part][n].get(key) is not None]
        return min(vals) if vals else 1.
    for r in rows:
        r['best_q'] = best_q(r, 'enrichment', 'q_local')
        r['best_q_model'] = best_q(r, 'enrichment', 'q_model')
        r['best_q_diff'] = best_q(r, 'differential', 'q')
    listed = [r for r in rows if r['total'] or r['pinned']]
    listed.sort(key=lambda r: (r['best_q'], r['best_q_model'], -r['total'], r['name'].lower()))
    sentences = _sentences(listed, names, spans)
    return dict(
        nfr=nfr['id'], window=[w_lo, w_hi], region=[lo, hi], variants=names, spans=spans,
        members={n: members_n[n] for n in names}, species=species, pinned=pinned_info,
        threshold=dict(mode='relative' if relative is not None else 'p', p=None if relative is not None else p,
                       relative=relative, background=background, composition={b: round(v, 4) for b, v in comp.items()}),
        scanned=len(records), unreachable=[dict(id=e['matrix_id'], name=e['name'], length=e['length'], min_p=e['min_p'])
                                           for e in unreachable],
        tested=m_tested, background=dict(bp=bg_len, intervals=len(bg_iv)), families=listed,
        with_sites=sum(1 for r in listed if r['total']), sentences=sentences, warnings=warnings,
        seconds=round(time.time() - t0, 2),
        definitions=dict(
            sites=('A site scores p <= {p} for its matrix under the background model (exact score distribution, both '
                   'strands)').format(p=p) if relative is None else f'A site scores >= {relative} of its matrix\'s range (relative score)',
            background=(f'Background model: the base composition of the NFR +- {bg_flank:,} bp (both strands)' if background == 'local'
                        else 'Background model: the genome FASTA\'s composition (sampled)' if background == 'genome'
                        else 'Background model: uniform (25% each base)'),
            enrichment=('Sites in the variant\'s span against the local background (the region minus every NFR and '
                        'variant span of the run): one-sided binomial test of the two site rates, BH q across the motif '
                        'families tested; "model": against the expected count under the background model (Poisson)'),
            differential=('Sites in the part of the variant\'s span no sibling covers against the siblings\' own parts '
                          '(binomial test of the two rates, BH q across families). Open: the share of each variant\'s '
                          'member reads open at the site; it confirms the call but is not a separate test, since '
                          'members are assigned by where their reads open.'),
            families=('Matrices of similar shape whose sites mostly coincide here, or versions of one matrix, are one '
                      'row; its sites are the union'),
        ))


def _representative(members, pinned, names, spans):
    if pinned:
        own = [e for e in members if e.get('pinned_as') in pinned]
        return min(own, key=lambda e: (e['name'].lower() != str(e['pinned_as']).lower(), -len(e['sites']), e['matrix_id']))

    def in_spans(e):
        return sum(1 for s in e['sites'] if any(spans[n][0] <= (s['start'] + s['end'])/2 < spans[n][1] for n in names))
    return min(members, key=lambda e: (-in_spans(e), min((s['p'] for s in e['sites']), default=1.), e['matrix_id']))


def label(row):
    return f"{row['name']} ({row['common']})" if row.get('common') else row['name']


def _sentences(rows, names, spans, limit=6):
    """One sentence per variant-specific site: a family significant in the differential (q <= 0.1) or pinned, at a
    site in the variant's own part that its reads open and a sibling's leave closed."""
    from lab.services.accessibility_analysis import _pct
    out = []
    for n in names:
        picked = 0
        cands = sorted((r for r in rows if r['differential'][n].get('open_delta') is not None
                        and ((r['differential'][n].get('q') or 1) <= .1 or r['pinned'])),
                       key=lambda r: ((r['differential'][n].get('q') or 1), -(r['differential'][n]['open_delta'] or 0)))
        for r in cands:
            d = r['differential'][n]
            if d['open_delta'] < .3:
                continue
            site = next(s for s in r['sites'] if s['start'] == d['open_site'])
            sib = [m for m in names if m != n and site['open'].get(m) is not None]
            low = min(sib, key=lambda m: site['open'][m]) if sib else None
            q = d.get('q')
            stat = f"q = {q:.2g}" if q is not None and q <= .1 else 'pinned'
            out.append(f"{n} opens over a {label(r)} site at {int(site['start']):,} (p = {site['p']:.1e}; {stat}): "
                       f"{_pct(site['open'].get(n))} of its reads open there"
                       + (f", {_pct(site['open'][low])} of {low}'s" if low else '') + '.')
            picked += 1
            if picked >= 2 or len(out) >= limit:
                break
    return out[:limit]
