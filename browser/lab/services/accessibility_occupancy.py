"""Accessibility (preview): the hierarchy of evidence at motif sites, per NFR variant (EXPERIMENTAL).

A transcription factor can only bind DNA that is open, so the evidence is nested, never two alternatives:

* **Open (stable layer, from NFR shape).** On each member read of a variant: is the site centre inside a
  nucleosome-free gap of at least the run's minimum gap (the read's own nucleosome calls)? Reads whose nucleosome
  calls do not reach past the site on both sides have no data there. P(open) per variant, Wilson interval.
* **Footprinted given open (transient layer, from Find classes).** A lattice-recaller footprint class whose span
  covers the site core; among the variant's members open at the site and labelled by that class run, the share that
  are class members. P(footprinted | open), Wilson interval.
* **Overall footprinted share** = P(open) x P(footprinted | open).

Stacked per variant: closed / open, not footprinted / open and footprinted. A class member that is not open at the
site is not biology (a calling or assignment inconsistency): it is counted as a QC flag and left out of the numbers.

Tests follow the hierarchy: openness between variants (chi-square, or Fisher's exact for two variants, on open vs
closed among reads with data), and footprinting among open reads between variants (the same on footprinted vs not
among open, class-labelled reads); variants with fewer than ``min_reads`` reads in a layer are left out of its test;
Benjamini-Hochberg q across the sites tested in the NFR, per layer.
"""
from __future__ import annotations

import numpy as np

DEFAULT_CORE_BP = 10
DEFAULT_MIN_READS = 10
PROFILE_HALF = 150
PROFILE_STEP = 5


def wilson(k, n, z=1.96):
    if not n:
        return None
    p = k/n
    d = 1 + z*z/n
    c = (p + z*z/(2*n))/d
    h = z*np.sqrt(p*(1 - p)/n + z*z/(4*n*n))/d
    return [round(float(max(0., c - h)), 4), round(float(min(1., c + h)), 4)]


def contingency_test(table):
    """p-value for a 2 x k table (rows: event / no event; columns: variants): Fisher's exact for 2 x 2, chi-square
    otherwise; None when fewer than two columns or no variation."""
    t = np.asarray(table, float)
    if t.ndim != 2 or t.shape[1] < 2:
        return None
    t = t[:, t.sum(0) > 0]
    if t.shape[1] < 2 or (t.sum(1) == 0).any():
        return None if t.shape[1] < 2 else 1.0
    if t.shape[1] == 2:
        from scipy.stats import fisher_exact
        return float(fisher_exact(t.astype(int))[1])
    from scipy.stats import chi2_contingency
    return float(chi2_contingency(t, correction=False)[1])


# ------------------------------------------------------------------ footprint classes
def class_source(state, job):
    """The footprint classes for this run: those it joined itself, else a compatible Find classes run that exists now
    (same datasets, chemistry and loader settings; overlapping region), joined by unit_id without re-running."""
    result = job['result']
    try:
        from fiberhmm.inference.accessibility import analysis as A
        els = A.elements(result) if result.get('element_states') else {}
    except Exception:       # noqa: BLE001 - an older run without context: no classes
        els = {}
    tf = [dict(e, id=eid) for eid, e in els.items() if e.get('kind') == 'tf']
    if tf:
        return dict(key=('run', job.get('class_job_id')), classes=tf, job_id=job.get('class_job_id'), joined='run')
    reasons = []
    try:
        from lab.services.accessibility_workflow import _loader_options, _matching_class_job, _runtime
        _options, loader_input = _loader_options(job.get('request') or {})
        cjob = _matching_class_job(state, job['request'], job.get('_snapshot'), loader_input.get('input'), exact=False,
                                   reasons=reasons)
    except Exception:       # noqa: BLE001 - no Find classes session, or an incompatible request
        cjob = None
    if cjob is None:
        return dict(key=None, classes=[], job_id=None, joined=None, reason=_no_class_reason(reasons))
    from pathlib import Path
    d = Path(cjob.get('artifact_dir') or '')
    if not (d/'classes.tsv').is_file() or not (d/'molecules.tsv.gz').is_file():
        return dict(key=None, classes=[], job_id=None, joined=None,
                    reason='The matching Find classes run has no class files (an older or interrupted run): run it again.')
    acc = _runtime()
    region = result['region']
    classes = [c for c in acc.load_recaller_classes(d) if c['end'] > region['start'] and c['start'] < region['end']]
    uids = set(result.get('molecules') or ())
    classes = [c for c in classes if any(u in uids for u in c['state'])]
    return dict(key=('posthoc', cjob['job_id']), classes=classes, job_id=cjob['job_id'], joined='posthoc',
                reason=None if classes else 'The Find classes run on these datasets shares no molecule with this run '
                                            '(unit_id join): run Find classes again on this window.')


def _no_class_reason(reasons):
    """Why no footprint layer: no Find classes run in this session, or the nearest runs and what differs."""
    if not reasons:
        return 'No Find classes run in this session covers these molecules.'
    counts = {}
    for r in reasons:
        counts[r] = counts.get(r, 0) + 1
    parts = ', '.join(f'{r} ({n})' if n > 1 else r for r, n in sorted(counts.items(), key=lambda kv: -kv[1]))
    return f"{len(reasons)} Find classes run{'s' if len(reasons) > 1 else ''} in this session, none on these molecules: {parts}."


def covering_classes(classes, centre, core_bp):
    """Classes whose span holds the site centre and covers at least half the core."""
    lo, hi = centre - core_bp/2, centre + core_bp/2
    return [c for c in classes if c['start'] <= centre < c['end'] and min(hi, c['end']) - max(lo, c['start']) >= core_bp/2]


# ------------------------------------------------------------------ per-read openness
def open_gaps(m, min_gap_bp):
    """(covered span, nucleosome-free gaps >= min_gap_bp) from a molecule's nucleosome calls (>= 90 bp)."""
    nucs = sorted((int(a), int(b)) for a, b in m.get('nucs') or ())
    if not nucs:
        return None, []
    return (nucs[0][0], nucs[-1][1]), [(b0, a1) for (_a0, b0), (a1, _b1) in zip(nucs, nucs[1:]) if a1 - b0 >= min_gap_bp]


def read_state(m, centre, min_gap_bp, cache, reason=False):
    """'nodata' (the read's nucleosome calls do not flank the site), 'open' or 'closed' at ``centre``; with
    ``reason``, closed is 'nucleosome' (inside a >= 90-bp call) or 'linker' (in a gap shorter than the minimum)."""
    uid = id(m)
    if uid not in cache:
        cache[uid] = open_gaps(m, min_gap_bp)
    cov, gaps = cache[uid]
    if cov is None or not cov[0] < centre < cov[1]:
        return 'nodata'
    if any(a <= centre < b for a, b in gaps):
        return 'open'
    if not reason:
        return 'closed'
    return 'nucleosome' if any(a <= centre < b for a, b in (m.get('nucs') or ())) else 'linker'


def union_label(cover, uid):
    """The footprint event at a site is membership in any covering class: footprinted (1) when a class labels the
    read a member, not footprinted (0) only when every covering class labels it a non-member, else unknown (None:
    an abstention, or a class that did not label the read)."""
    labels = [c['state'].get(uid) for c in cover]
    if any(v == 1 for v in labels):
        return 1
    if labels and all(v == 0 for v in labels):
        return 0
    return None


def site_layers(result, members, centre, classes, core_bp, min_gap_bp, cache, shared=None):
    """Per variant: counts and shares of the hierarchy at one site; the covering classes. Class members that are
    not open at the site (nucleosome or linker protection) are counted by reason and left out. ``shared``: reads in
    more than one variant; the ``x_*`` counts leave them out (the between-variant tests need disjoint groups)."""
    mols = result['molecules']
    cover = covering_classes(classes, centre, core_bp)
    shared = shared or set()
    out = {}
    for name, uids in members.items():
        n = n_open = n_lab = n_fp = 0
        x = dict(reads=0, open=0, labelled=0, footprinted=0)
        excluded = dict(nucleosome=0, linker=0)
        for u in uids:
            m = mols.get(u)
            if m is None:
                continue
            st = read_state(m, centre, min_gap_bp, cache, reason=bool(cover))
            if st == 'nodata':
                continue
            n += 1
            lab = union_label(cover, u) if cover else None
            own = u not in shared
            x['reads'] += own
            if st == 'open':
                n_open += 1
                x['open'] += own
                if lab is not None:
                    n_lab += 1
                    n_fp += lab
                    x['labelled'] += own
                    x['footprinted'] += own and lab
            elif lab == 1 or any(c['state'].get(u) == 1 for c in cover):
                excluded[st if st in excluded else 'nucleosome'] += 1     # protection, not a footprint
        p_open = n_open/n if n else None
        p_fp = n_fp/n_lab if n_lab else None
        out[name] = dict(reads=n, open=n_open, labelled=n_lab, unlabelled_open=n_open - n_lab if cover else None, exclusive=x,
                         footprinted=n_fp, excluded_members=excluded if cover else None,
                         p_open=None if p_open is None else round(p_open, 4), ci_open=wilson(n_open, n),
                         p_fp_given_open=None if p_fp is None else round(p_fp, 4), ci_fp_given_open=wilson(n_fp, n_lab),
                         p_footprinted=None if p_open is None or p_fp is None else round(p_open*p_fp, 4))
        if p_open is not None:
            closed = 1 - p_open
            ofp = p_open*(p_fp or 0.) if p_fp is not None else None
            parts = dict(closed=closed, open_unfootprinted=None if ofp is None else p_open - ofp, open_footprinted=ofp)
            if ofp is None:
                parts['open'] = p_open
            out[name]['stack'] = {k: None if v is None else round(v, 4) for k, v in parts.items()}
            known = {k: v for k, v in parts.items() if v is not None and k != 'open'}
            out[name]['state'] = max(known, key=known.get) if ofp is not None else ('open' if p_open >= .5 else 'closed')
    return out, [dict(id=c['id'], label=c.get('label') or c['id'], start=c['start'], end=c['end'],
                      prevalence=c.get('prevalence')) for c in cover]


# ------------------------------------------------------------------ coverage of a site by each variant's opening
def _core(centre, core_bp):
    return centre - core_bp/2, centre + core_bp/2


def assigned_opening(rec, name, span):
    """The opening of a read that its most likely configuration assigns to variant ``name``; when the configuration
    does not name it (a member by probability only), the opening overlapping the variant's span most. None: none."""
    gaps = [(int(a), int(b)) for a, b in rec.get('gaps') or ()]
    if not gaps:
        return None
    tokens = (rec.get('map') or '').split('+')
    if len(tokens) == len(gaps) and name in tokens:
        return gaps[tokens.index(name)]
    lo, hi = span
    best = max(gaps, key=lambda g: min(g[1], hi) - max(g[0], lo))
    return best if min(best[1], hi) - max(best[0], lo) > 0 else None


def site_coverage(result, nfr, members, centre, core_bp, shared=None):
    """Per variant: among its member molecules, the share whose own opening (the one the read's configuration assigns
    to the variant) covers the site core entirely (``core_bp`` around the centre). A site at the centre of a variant's
    span is covered in nearly every member; one near its edge less often, since edges vary between molecules. Also the
    composition: of the covering openings, the share each variant contributes. ``x_*``: reads in one variant only."""
    mols = result['molecules']
    lo, hi = _core(centre, core_bp)
    spans = {v['name']: (float(v['L']), float(v['R'])) for v in nfr['variants']}
    shared = shared or set()
    out = {}
    for name, uids in members.items():
        n = k = xn = xk = 0
        for u in uids:
            rec = ((mols.get(u) or {}).get('nfr') or {}).get(nfr['id'])
            if not rec or rec.get('status') != 'callable':
                continue
            g = assigned_opening(rec, name, spans[name])
            hit = g is not None and g[0] <= lo and hi <= g[1]
            n += 1
            k += hit
            if u not in shared:
                xn += 1
                xk += hit
        out[name] = dict(n=n, covered=k, p=None if not n else round(k/n, 4), ci=wilson(k, n), exclusive=dict(n=xn, covered=xk))
    total = sum(v['covered'] for v in out.values())
    for v in out.values():
        v['share'] = None if not total else round(v['covered']/total, 4)
    return out


def covering_openings(result, nfr, centre, core_bp):
    """{unit_id: (label, (start, end))}: on each callable read of the NFR, the opening covering the site core and the
    configuration label of that opening (V1, V2, ..., 'other'); at most one opening per read covers a site."""
    lo, hi = _core(centre, core_bp)
    out = {}
    for uid, m in result['molecules'].items():
        rec = (m.get('nfr') or {}).get(nfr['id'])
        if not rec or rec.get('status') != 'callable':
            continue
        gaps = [(int(a), int(b)) for a, b in rec.get('gaps') or ()]
        tokens = (rec.get('map') or '').split('+')
        if len(tokens) != len(gaps):
            tokens = ['other']*len(gaps)
        for (a, b), t in zip(gaps, tokens):
            if a <= lo and hi <= b:
                out[uid] = (t, (a, b))
                break
    return out


def site_sizes(result, nfr, centre, core_bp, raw=False):
    """The size (bp) of the opening covering the site core on each callable read of the NFR, by the configuration
    label of that opening (V1, V2, ..., 'other'). Labels are disjoint (one opening per read covers the site). Summaries
    per label, or the sizes themselves with ``raw``."""
    by = {}
    for t, (a, b) in covering_openings(result, nfr, centre, core_bp).values():
        by.setdefault(t, []).append(b - a)
    if raw:
        return {k: sorted(v) for k, v in by.items()}
    return {k: _quantiles(v) for k, v in by.items()}


def pooled_sizes(result, nfr, centres, core_bp):
    """Sizes over several sites with each read counted once: a read's distinct openings over the sites, labelled; a
    read whose openings carry different variant labels at different sites is left out (the groups stay disjoint).
    {label: [size, ...]} (one value per read and label: the mean of its distinct openings, almost always one)."""
    per = {}
    for c in centres:
        for uid, (t, g) in covering_openings(result, nfr, c, core_bp).items():
            per.setdefault(uid, set()).add((t, g))
    by = {}
    for opens in per.values():
        labels = {t for t, _g in opens}
        if len(labels) != 1:
            continue
        t = next(iter(labels))
        sizes = sorted({g[1] - g[0] for _t, g in opens})
        by.setdefault(t, []).append(round(float(np.mean(sizes)), 1))
    return {k: sorted(v) for k, v in by.items()}


def _quantiles(xs):
    a = np.asarray(xs, float)
    q1, med, q3 = np.percentile(a, [25, 50, 75])
    return dict(n=int(len(a)), q1=round(float(q1), 1), median=round(float(med), 1), q3=round(float(q3), 1))


def size_test(groups, min_reads=DEFAULT_MIN_READS):
    """Do the sizes differ between groups? Mann-Whitney U (two groups) or Kruskal-Wallis (more), two-sided, over the
    groups with at least ``min_reads`` sizes; None when fewer than two such groups or every size is equal."""
    ok = [np.asarray(v, float) for v in groups.values() if len(v) >= min_reads]
    if len(ok) < 2:
        return None
    if len(np.unique(np.concatenate(ok))) < 2:
        return 1.0
    from scipy.stats import kruskal, mannwhitneyu
    if len(ok) == 2:
        return float(mannwhitneyu(ok[0], ok[1], alternative='two-sided').pvalue)
    return float(kruskal(*ok).pvalue)


def annotate(A, result, nfr, motifs, classes, core_bp=DEFAULT_CORE_BP, min_reads=DEFAULT_MIN_READS):
    """Adds ``layers`` (per variant), ``classes`` and the two tests to every site of every family in ``motifs``
    (the output of accessibility_motifs.nfr_motifs); returns the occupancy summary (QC, sentences, definitions)."""
    from services.motif_scoring import bh
    if not result.get('molecules'):
        return dict(available=False, note='This run has no per-read records here; run Find variants again.')
    names = [v['name'] for v in nfr['variants']]
    members = {v['name']: A.member_uids(result, v['id']) for v in nfr['variants']}
    seen, shared = set(), set()
    for us in members.values():
        shared |= seen & us
        seen |= us
    min_gap = int((result.get('parameters') or {}).get('min_gap_bp', 60))
    cls = classes.get('classes') or []
    cache = {}
    tested = []
    excl = dict(nucleosome=0, linker=0)
    open_cls = unlab = 0
    for row in motifs['families']:
        for s in row['sites']:
            c = (s['start'] + s['end'])/2
            layers, cover = site_layers(result, members, c, cls, core_bp, min_gap, cache, shared)
            s['layers'] = layers
            s['classes'] = cover
            # the tests compare disjoint groups: reads in more than one variant are left out of them
            X = {n: layers[n]['exclusive'] for n in names}
            ok_open = [n for n in names if X[n]['reads'] >= min_reads]
            ok_fp = [n for n in names if X[n]['labelled'] >= min_reads]
            s['p_open_diff'] = contingency_test([[X[n]['open'] for n in ok_open], [X[n]['reads'] - X[n]['open'] for n in ok_open]])
            s['p_fp_diff'] = contingency_test([[X[n]['footprinted'] for n in ok_fp],
                                               [X[n]['labelled'] - X[n]['footprinted'] for n in ok_fp]]) if cover else None
            # coverage by each variant's own opening (the default view) and the size of the opening over the site
            cv = site_coverage(result, nfr, members, c, core_bp, shared)
            s['coverage'] = {n: {k: v for k, v in cv[n].items() if k != 'exclusive'} for n in names}
            ok_cv = [n for n in names if cv[n]['exclusive']['n'] >= min_reads]
            s['p_cover_diff'] = contingency_test([[cv[n]['exclusive']['covered'] for n in ok_cv],
                                                  [cv[n]['exclusive']['n'] - cv[n]['exclusive']['covered'] for n in ok_cv]])
            ps = [cv[n]['p'] for n in names if cv[n]['p'] is not None and cv[n]['n'] >= min_reads]
            s['cover_delta'] = round(max(ps) - min(ps), 4) if len(ps) >= 2 else None
            raw = site_sizes(result, nfr, c, core_bp, raw=True)
            s['sizes'] = {k: _quantiles(v) for k, v in raw.items()}
            s['p_size_diff'] = size_test({k: v for k, v in raw.items() if k in names}, min_reads)
            if cover:
                for n in names:
                    for k, v in (layers[n]['excluded_members'] or {}).items():
                        excl[k] += v
                    open_cls += layers[n]['open']
                    unlab += layers[n]['unlabelled_open'] or 0
            tested.append(s)
    for key, src in (('q_open_diff', 'p_open_diff'), ('q_fp_diff', 'p_fp_diff'), ('q_cover_diff', 'p_cover_diff'),
                     ('q_size_diff', 'p_size_diff')):
        for s, q in zip(tested, bh([s[src] for s in tested])):
            s[key] = q
    for row in motifs['families']:
        qo = [s['q_open_diff'] for s in row['sites'] if s.get('q_open_diff') is not None]
        qf = [s['q_fp_diff'] for s in row['sites'] if s.get('q_fp_diff') is not None]
        row['best_q_open'] = min(qo) if qo else None
        row['best_q_fp'] = min(qf) if qf else None
        qc = [s['q_cover_diff'] for s in row['sites'] if s.get('q_cover_diff') is not None]
        qs = [s['q_size_diff'] for s in row['sites'] if s.get('q_size_diff') is not None]
        row['best_q_cover'] = min(qc) if qc else None
        row['best_q_size'] = min(qs) if qs else None
        row['footprint_classes'] = sorted({c['label'] for s in row['sites'] for c in s.get('classes') or ()})
    return dict(
        available=True, classes=len(cls), class_job=classes.get('job_id'), joined=classes.get('joined'),
        class_reason=None if cls else classes.get('reason'),
        core_bp=core_bp, min_reads=min_reads, min_gap_bp=min_gap, sites=len(tested), shared_reads=len(shared),
        sites_with_class=sum(1 for s in tested if s['classes']),
        excluded_members=excl, open_reads_at_class_sites=open_cls, unlabelled_open=unlab,
        unlabelled_share=round(unlab/open_cls, 4) if open_cls else None,
        sentences=_sentences(motifs['families'], names),
        definitions=dict(
            open='Open (stable layer, NFR shape): the site centre lies in a nucleosome-free gap of the read of at least '
                 f'{min_gap} bp; reads whose nucleosome calls do not flank the site have no data',
            footprinted=('Footprinted given open (transient layer): among open reads labelled by the Find classes run, '
                         'the share that are members of a footprint class covering the site core '
                         f'({core_bp} bp around the motif centre)'),
            overall='Overall footprinted share = P(open) x P(footprinted | open)',
            excluded=('A lattice class labels a read a member when the class span is protected on it; a member whose site '
                      'lies in a nucleosome call is nucleosome protection, and one in a gap shorter than the minimum is linker '
                      'protection, not a footprint: the hierarchy leaves them out (counted by reason)'),
            unlabelled=('Footprinted = a member of any class covering the site; not footprinted only when every covering class '
                        'labels the read a non-member; open reads the class run abstained on are unlabelled and left out of '
                        'P(footprinted | open)'),
            open_test=('The openness test is informative for sites shared by several variants\' spans or in the flanks; for a '
                       'site inside one variant\'s span only it restates where that variant\'s reads open'),
            coverage=(f'Coverage: among a variant\'s member reads, the share whose own opening (the one the read\'s most '
                      f'likely configuration assigns to the variant; else the opening overlapping its span most) covers the '
                      f'site core entirely ({core_bp} bp around the motif centre). Near 100% at the centre of the variant\'s '
                      f'span, lower near its edges. Share of openness: of the reads whose variant opening covers the site, '
                      f'the share each variant contributes'),
            sizes=(f'NFR size at the site: on each callable read whose opening covers the site core, the size of that '
                   f'opening (nucleosome to nucleosome), by the variant its configuration assigns it (other: none). Mann-'
                   f'Whitney (2 variants) or Kruskal-Wallis between variants with >= {min_reads} reads; BH q across the '
                   f'sites of this NFR'),
            cover_test=(f'Coverage between variants: Fisher (2 variants) or chi-square on reads in one variant only, '
                        f'variants with >= {min_reads} such reads; BH q across the sites of this NFR'),
            tests=f'Openness between variants and footprinting among open reads between variants: Fisher (2 variants) or '
                  f'chi-square on disjoint groups (reads in more than one variant are left out of the tests), variants with '
                  f'>= {min_reads} such reads in the layer; BH q across the sites of this NFR, per layer'),
    )


def _pct(v):
    return '–' if v is None else f'{100*v:.0f}%'


def _sentences(rows, names, limit=6):
    from lab.services.accessibility_motifs import label
    out = []
    seen = set()
    for row in sorted(rows, key=lambda r: (min(x for x in (r.get('best_q_fp'), r.get('best_q_open'), 1.) if x is not None),
                                           not r['pinned'])):
        for s in sorted(row['sites'], key=lambda s: min(x for x in (s.get('q_fp_diff'), s.get('q_open_diff'), 1.) if x is not None)):
            qf, qo = s.get('q_fp_diff'), s.get('q_open_diff')
            if (qf is None or qf > .1) and (qo is None or qo > .1) and not row['pinned']:
                continue
            key = int(s['start'])//10
            if key in seen:
                continue
            L = s.get('layers') or {}
            parts = []
            for n in names:
                x = L.get(n) or {}
                if x.get('p_open') is None:
                    continue
                txt = f"{n} open {_pct(x['p_open'])}"
                if x.get('p_fp_given_open') is not None:
                    txt += f", footprinted in {_pct(x['p_fp_given_open'])} of open"
                parts.append(txt)
            if not parts:
                continue
            seen.add(key)
            stat = '; '.join(t for t in (f"openness q = {qo:.2g}" if qo is not None and qo <= .1 else '',
                                         f"footprint q = {qf:.2g}" if qf is not None and qf <= .1 else '') if t) or 'pinned'
            cls = f" (class {', '.join(c['label'] for c in s['classes'])})" if s.get('classes') else ''
            out.append(f"{label(row)} site at {int(s['start']):,}{cls}: " + '; '.join(parts) + f" [{stat}].")
            if len(out) >= limit:
                return out
    return out


# ------------------------------------------------------------------ motif-centred meta-profiles
def meta_profile(A, result, nfr_sites, classes, half=PROFILE_HALF, step=PROFILE_STEP, min_reads=DEFAULT_MIN_READS):
    """Around the sites of one motif family, oriented by the motif strand: per variant, P(open) and P(footprinted |
    open) at offsets -half..+half, pooled over the sites (``nfr_sites``: [(nfr, [site, ...]), ...]) and over all
    callable reads of the NFR ('all'). A footprint dip / opening at offset 0 is the evidence of binding."""
    offs = np.arange(-half, half + 1, step)
    min_gap = int((result.get('parameters') or {}).get('min_gap_bp', 60))
    cls = classes.get('classes') or []
    cache = {}
    acc = {}
    nsites = 0
    mols = result['molecules']

    def add(name, uid, xs, cover):
        m = mols.get(uid)
        if m is None:
            return
        if id(m) not in cache:
            cache[id(m)] = open_gaps(m, min_gap)
        cov, gaps = cache[id(m)]
        if cov is None:
            return
        data = (xs > cov[0]) & (xs < cov[1])
        if not data.any():
            return
        is_open = np.zeros(len(xs), bool)
        for g0, g1 in gaps:
            is_open |= (xs >= g0) & (xs < g1)
        is_open &= data
        # footprinted where a covering class has the read as a member; not footprinted only where every class
        # covering the position labels it a non-member
        fp = np.zeros(len(xs), bool)
        neg = np.ones(len(xs), bool)
        anyc = np.zeros(len(xs), bool)
        for k, mask in cover:
            v = k['state'].get(uid)
            anyc |= mask
            if v == 1:
                fp |= mask
            if v != 0:
                neg &= ~mask
        lab = fp | (neg & anyc)
        a = acc.setdefault(name, dict(reads=np.zeros(len(xs)), open=np.zeros(len(xs)), lab=np.zeros(len(xs)), fp=np.zeros(len(xs))))
        a['reads'] += data
        a['open'] += is_open
        a['lab'] += is_open & lab
        a['fp'] += is_open & lab & fp

    for nfr, sites in nfr_sites:
        members = {v['name']: A.member_uids(result, v['id']) for v in nfr['variants']}
        callable_ = {u for u, m in mols.items() if (m.get('nfr') or {}).get(nfr['id'], {}).get('status') == 'callable'}
        for s in sites:
            c = (s['start'] + s['end'])/2
            xs = c + (-1 if s.get('strand') == '-' else 1)*offs
            lo, hi = xs.min(), xs.max()
            cover = [(k, (xs >= k['start']) & (xs < k['end'])) for k in cls if k['end'] > lo and k['start'] <= hi]
            nsites += 1
            for name, uids in list(members.items()) + [('all', callable_)]:
                for u in uids:
                    add(name, u, xs, cover)
    out = {}
    for name, a in acc.items():
        with np.errstate(invalid='ignore', divide='ignore'):
            po = np.where(a['reads'] >= min_reads, a['open']/np.maximum(a['reads'], 1), np.nan)
            pf = np.where(a['lab'] >= min_reads, a['fp']/np.maximum(a['lab'], 1), np.nan)
        out[name] = dict(p_open=[None if np.isnan(v) else round(float(v), 4) for v in po],
                         p_fp_given_open=[None if np.isnan(v) else round(float(v), 4) for v in pf],
                         reads=[int(v) for v in a['reads']], labelled=[int(v) for v in a['lab']])
    return dict(offsets=[int(o) for o in offs], sites=nsites, variants=out, classes=len(cls))
