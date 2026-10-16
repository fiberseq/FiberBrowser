"""Motif scoring shared by the analysis panels (Footprints, plugin packs' motif views): JASPAR catalogue per species with pinned key
factors and custom matrices, a site scan at a per-matrix p-value (exact score distribution, as FIMO / MOODS) or at a
relative score, families of similar matrices, and Benjamini-Hochberg q-values.

Scores: ``services.motifs.ScoredMatrix`` (log-odds with JASPAR pseudocounts against the background used, integer
scores, exact tail). Backgrounds: 'local' (the base composition of the scanned sequence), 'genome' (the composition of
the loaded FASTA, sampled once per file) or 'uniform'; all strand-symmetric and strictly positive.
"""
from __future__ import annotations

import threading
from services.byte_cache import shared_cache

import numpy as np

DEFAULT_P = 1e-4
DEFAULT_FLANK = 300
DEFAULT_BG_FLANK = 5000
FAMILY_SIMILARITY = 0.8
FAMILY_SITE_SHARE = 0.5

# Key factors shown regardless of rank; the user edits these per species (the frontend sends its own list).
PINNED_DEFAULTS = {
    'fly': ['vfl', 'Trl', 'Clamp', 'pho', 'Dref', 'BEAF-32', 'CTCF', 'M1BP', 'dl', 'twi', 'sna', 'bcd', 'hb',
            'Kr', 'kni', 'gt', 'cad', 'tll', 'grh', 'opa'],
    'human': ['CTCF', 'FOS::JUN', 'JUN', 'ATF3', 'SP1', 'KLF4', 'NRF1', 'YY1', 'ELK1', 'GABPA', 'ETS1', 'NFYA', 'CREB1',
              'REST', 'USF1', 'MAX', 'ZNF143'],
    'mouse': ['CTCF', 'FOS::JUN', 'Jun', 'Atf3', 'SP1', 'KLF4', 'Nrf1', 'Yy1', 'ELK1', 'GABPA', 'ETS1', 'NFYA', 'CREB1',
              'REST', 'USF1', 'MAX', 'ZNF143'],
}
PINNED_DEFAULTS['rat'] = PINNED_DEFAULTS['human']
# Former defaults that JASPAR CORE does not have (Ibf1): a pinned list saved while they were defaults still holds them,
# and they are reported quietly ("default factor unavailable"), not as the user's own missing motif.
RETIRED_DEFAULTS = {'fly': ['Ibf1']}

# Common names where they differ from the JASPAR (gene) name.
COMMON_NAMES = {
    'vfl': 'Zelda', 'Trl': 'GAF', 'dl': 'Dorsal', 'twi': 'Twist', 'sna': 'Snail', 'bcd': 'Bicoid', 'hb': 'Hunchback',
    'Kr': 'Krüppel', 'kni': 'Knirps', 'gt': 'Giant', 'cad': 'Caudal', 'tll': 'Tailless', 'grh': 'Grainyhead',
    'opa': 'Odd-paired', 'pho': 'Pleiohomeotic', 'phol': 'Pho-like', 'zen': 'Zerknüllt', 'ttk': 'Tramtrack',
    'su(Hw)': 'Suppressor of Hairy-wing', 'Su(H)': 'Suppressor of Hairless', 'eve': 'Even-skipped', 'ftz': 'Fushi tarazu',
    'odd': 'Odd-skipped', 'prd': 'Paired', 'run': 'Runt', 'slp1': 'Sloppy-paired 1', 'h': 'Hairy', 'Dif': 'Dif (Rel family)',
    'Rel': 'Relish', 'Mad': 'Mad (Smad)', 'brk': 'Brinker', 'z': 'Zeste', 'Abd-B': 'Abdominal-B', 'Ubx': 'Ultrabithorax',
    'Antp': 'Antennapedia', 'en': 'Engrailed', 'pnr': 'Pannier', 'srp': 'Serpent', 'Stat92E': 'STAT',
    'FOS::JUN': 'AP-1', 'REST': 'NRSF', 'SPI1': 'PU.1', 'Spi1': 'PU.1', 'CTCFL': 'BORIS', 'TP53': 'p53',
    'NFE2L2': 'NRF2', 'Pou5f1::Sox2': 'OCT4-SOX2',
}

# Other names people type for a factor (lowercase, punctuation-free; see motif_key), where COMMON_NAMES does not
# already give them: the JASPAR name each one means.
MOTIF_ALIASES = {
    'zld': 'vfl', 'zelda': 'vfl', 'gaga': 'Trl', 'gagafactor': 'Trl', 'gaf': 'Trl', 'trithoraxlike': 'Trl',
    'suhw': 'su(Hw)', 'suppressorofhairywing': 'su(Hw)', 'suh': 'Su(H)', 'clamp': 'Clamp', 'ap1': 'FOS::JUN',
    'nrsf': 'REST', 'pu1': 'SPI1', 'boris': 'CTCFL', 'p53': 'TP53', 'nrf2': 'NFE2L2', 'oct4sox2': 'Pou5f1::Sox2',
}

_cache_lock = threading.Lock()
_scored_cache = shared_cache('tracks')      # (matrix id, background) -> ScoredMatrix


def common_name(name):
    c = COMMON_NAMES.get(name)
    return c if c and c.lower() != str(name).lower() else None


def motif_key(name):
    """A name as compared for lookups: case, accents and punctuation ignored ('Su(Hw)' and 'su(hw)' -> 'suhw',
    'Krüppel' -> 'kruppel', 'BEAF-32' -> 'beaf32')."""
    import unicodedata
    text = unicodedata.normalize('NFKD', str(name or ''))
    return ''.join(ch for ch in text if ch.isalnum() and not unicodedata.combining(ch)).lower()


def name_matches(query, matrix_id, name):
    """Whether a typed name means this matrix: its JASPAR name or ID (case-insensitive), the name ignoring case and
    punctuation, its common name (Zelda -> vfl, GAF -> Trl) or a known alias."""
    q = str(query).strip()
    ql, qk = q.lower(), motif_key(q)
    if name.lower() == ql or matrix_id.lower() == ql or matrix_id.split('.')[0].lower() == ql:
        return True
    if not qk:
        return False
    if motif_key(name) == qk:
        return True
    common = COMMON_NAMES.get(name)
    if common and (motif_key(common) == qk or motif_key(common.split(' (')[0]) == qk):
        return True
    alias = MOTIF_ALIASES.get(qk)
    return bool(alias) and alias.lower() == name.lower()


def species_key(species):
    return (species or {}).get('name')


def pinned_defaults(species):
    return list(PINNED_DEFAULTS.get(species_key(species) or '', []))


def retired_defaults(species):
    return list(RETIRED_DEFAULTS.get(species_key(species) or '', []))


def default_like(species, names):
    """The names among ``names`` that are (or were) the species' defaults rather than the user's own picks."""
    known = {motif_key(n) for n in pinned_defaults(species) + retired_defaults(species)}
    return [n for n in names if motif_key(n) in known]


def _scored(M, mid, name, counts, bg):
    bg = M.normalize_background(bg)
    key = (mid, tuple(bg[b] for b in 'ACGT'), hash(tuple(tuple(float(x) for x in counts[b]) for b in 'ACGT')))
    with _cache_lock:
        hit = _scored_cache.get(key)
        if hit is not None:
            _scored_cache.move_to_end(key)
            return hit
    sm = M.scored_matrix(mid, name, counts, bg)
    with _cache_lock:
        _scored_cache[key] = sm
    return sm


# ------------------------------------------------------------------ the catalogue (species, named, pinned)
def _record(matrix_id, name, counts, source, tax_group=None):
    return dict(matrix_id=matrix_id, name=name, counts={b: [float(x) for x in counts[b]] for b in 'ACGT'}, source=source,
                tax_group=tax_group)


def _resolve(M, query, species_records, taxon):
    """Matrices for a name (case-insensitive; or a matrix ID / base ID; else the name ignoring punctuation, a common
    name or an alias: ``name_matches``): the species' own, else the genome's JASPAR taxon group's (noted), else none."""
    q = str(query).strip()
    ql = q.lower()

    def exact(mid, name):
        return name.lower() == ql or mid.lower() == ql or mid.split('.')[0].lower() == ql

    def match(mid, name):
        return name_matches(q, mid, name)
    # an exact name or ID wins over a common name or alias (SPI1 is not also every 'PU.1')
    own = [r for r in species_records if exact(r['matrix_id'], r['name'])] or \
        [r for r in species_records if match(r['matrix_id'], r['name'])]
    if own:
        return own, None
    try:
        catalog = M.jaspar_catalog()
    except Exception:       # noqa: BLE001 - pyjaspar missing or broken: the species set is all there is
        catalog = []
    in_taxon = [e for e in catalog if taxon is None or e['tax_group'] == taxon]
    other = [e for e in in_taxon if exact(e['matrix_id'], e['name'])] or [e for e in in_taxon if match(e['matrix_id'], e['name'])]
    if other:
        return [_record(e['matrix_id'], e['name'], e['counts'], 'taxon', e['tax_group']) for e in other], taxon
    return [], None


def catalogue(ref_state, names=None, pinned=None, pwms=None, custom=None):
    """(records, species, pinned_info, warnings). ``names``: scan only these; ``pinned``: always reported (None: the
    species' defaults); ``pwms`` (tests): [(id, name, counts)] instead of JASPAR; ``custom``: the user's own matrices
    [{name, counts}] scanned next to the species' (and pinnable by name)."""
    from services import motifs as M
    warnings = []
    species = None
    species_records = []
    taxon = None
    if pwms is not None:
        records = [_record(mid, name, counts, 'custom') for mid, name, counts in pwms]
        species_records = records
    else:
        has_jaspar = M.check_pyjaspar()
        if not has_jaspar and not custom:
            raise ValueError("pyjaspar is not installed: run 'pip install pyjaspar' for JASPAR motifs.")
        if not has_jaspar:
            warnings.append('pyjaspar is not installed: only your own motifs are scanned')
        genome, inferred = M.jaspar_genome(ref_state)
        if has_jaspar and genome in M.GENOME_TO_JASPAR_SPECIES:
            taxid = M.GENOME_TO_JASPAR_SPECIES[genome]
            species = dict(genome=genome, taxid=taxid, inferred=inferred, name=M.JASPAR_SPECIES_NAMES.get(taxid))
            taxon = M.genome_taxon(genome)
            species_records = [_record(m.matrix_id, m.name, m.counts, 'species') for m in M.get_jaspar_core_motifs(taxid)
                               if all(m.counts.get(b) for b in 'ACGT')]
        elif has_jaspar and genome is None and not names and not pinned and not custom:
            # A custom sequence nothing declares, and no motifs of the user's: the vertebrate matrices, said so.
            species = M.fallback_species()
            taxon = M.FALLBACK_TAX_GROUP
            species_records = [_record(m.matrix_id, m.name, m.counts, 'species') for m, _p in M.get_jaspar_taxon_pssms(taxon)]
            warnings.append(M.FALLBACK_NOTE)
        elif not names and not pinned and not custom:
            raise ValueError('No genome with a JASPAR species is loaded (e.g. hg38, mm10, dm6): pick motifs by name instead.')
        records = list(species_records)
    for i, c in enumerate(custom or ()):
        counts = normalize_counts(c.get('counts') if isinstance(c, dict) else None)
        name = str((c or {}).get('name') or f'custom {i + 1}').strip()[:60] if isinstance(c, dict) else ''
        if counts is None or not name:
            warnings.append(f'Custom motif {i + 1} skipped: not a 4 x L count or frequency matrix')
            continue
        rec = _record(f'custom:{name}', name, counts, 'custom')
        species_records = species_records + [rec]
        if not names:
            records.append(rec)
    if names:
        records, missing = [], []
        for n in names:
            found, _sub = _resolve(M, n, species_records, taxon) if pwms is None else (
                [r for r in species_records if name_matches(n, r['matrix_id'], r['name'])], None)
            if not found:
                missing.append(n)
            records.extend(found)
        if missing:
            warnings.append(f"Not in JASPAR CORE: {', '.join(missing)}")
    if pinned is None:
        pinned = pinned_defaults(species)
    pinned_info = dict(requested=list(pinned), resolved={}, names={}, missing=[], substituted={}, defaults=pinned_defaults(species),
                       retired=retired_defaults(species), species=species_key(species))
    have = {r['matrix_id'] for r in records}
    for p in pinned:
        found, sub = _resolve(M, p, species_records, taxon) if pwms is None else (
            [r for r in species_records if name_matches(p, r['matrix_id'], r['name'])], None)
        if not found:
            pinned_info['missing'].append(p)
            continue
        pinned_info['resolved'][p] = [r['matrix_id'] for r in found]
        pinned_info['names'][p] = sorted({r['name'] for r in found})
        if sub:
            pinned_info['substituted'][p] = sub
        for r in found:
            r = dict(r, pinned_as=p)
            if r['matrix_id'] in have:
                # pinned under another name already (GAF after Trl): the first name keeps it
                records = [dict(x, pinned_as=p) if x['matrix_id'] == r['matrix_id'] and not x.get('pinned_as') else x for x in records]
            else:
                records.append(r)
                have.add(r['matrix_id'])
    return records, species, pinned_info, warnings


def bh(pvalues):
    """Benjamini-Hochberg q-values (None stays None; m = the p-values given)."""
    idx = [i for i, p in enumerate(pvalues) if p is not None]
    q = [None]*len(pvalues)
    m = len(idx)
    if not m:
        return q
    order = sorted(idx, key=lambda i: pvalues[i])
    running = 1.0
    for rank in range(m, 0, -1):
        i = order[rank - 1]
        running = min(running, pvalues[i]*m/rank)
        q[i] = min(1.0, running)
    return q


# ------------------------------------------------------------------ families
def _shape(counts):
    m = np.array([counts[b] for b in 'ACGT'], float)
    m = m + np.sqrt(max(m.sum(0).mean(), 1e-9))*.25
    p = m/m.sum(0, keepdims=True)
    ic = 2 + (p*np.log2(p)).sum(0)
    c = p - p.mean(0, keepdims=True)
    n = np.linalg.norm(c, axis=0, keepdims=True)
    n[n == 0] = 1
    return c/n, ic


def similarity(a_counts, b_counts):
    """Information-weighted column correlation at the best offset and strand, over the less informative matrix's
    total information (1: the same shape; a short matrix inside a long one scores high)."""
    (a, ia), (b, ib) = _shape(a_counts), _shape(b_counts)
    denom = min(ia.sum(), ib.sum())
    if denom <= 0:
        return 0.
    best = 0.
    for bb, ibb in ((b, ib), (b[::-1, ::-1], ib[::-1])):
        C = a.T @ bb
        W = np.minimum.outer(ia, ibb)
        for k in range(-(C.shape[0] - 1), C.shape[1]):
            best = max(best, float((np.diagonal(C, offset=k)*np.diagonal(W, offset=k)).sum()/denom))
    return best


def _overlaps(s, t):
    return min(s['end'], t['end']) - max(s['start'], t['start']) > .5*min(s['end'] - s['start'], t['end'] - t['start'])


def _shared(sa, sb):
    """Share of each site set that overlaps a site of the other (sites sorted by start)."""
    def share(x, y):
        if not x:
            return 0.
        hit = 0
        j = 0
        for s in x:
            while j < len(y) and y[j]['end'] <= s['start']:
                j += 1
            k = j
            while k < len(y) and y[k]['start'] < s['end']:
                if _overlaps(s, y[k]):
                    hit += 1
                    break
                k += 1
        return hit/len(x)
    return share(sa, sb), share(sb, sa)


def families(entries, similarity_min=None):
    """Union-find over matrices with sites: versions of one matrix (same base ID or name), or similar matrices whose
    sites mostly coincide (each set >= FAMILY_SITE_SHARE on the other's). Two different pinned names never merge."""
    parent = list(range(len(entries)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    pins = [{e['pinned_as']} if e.get('pinned_as') else set() for e in entries]

    def join(i, j):
        ri, rj = find(i), find(j)
        if ri == rj or (pins[ri] and pins[rj] and pins[ri] != pins[rj]):
            return
        parent[rj] = ri
        pins[ri] |= pins[rj]
    for i in range(len(entries)):
        for j in range(i + 1, len(entries)):
            a, b = entries[i], entries[j]
            same = a['name'].lower() == b['name'].lower() or a['matrix_id'].split('.')[0] == b['matrix_id'].split('.')[0]
            if not same:
                x, y = _shared(a['sites'], b['sites'])
                if min(x, y) < FAMILY_SITE_SHARE:
                    continue
                if similarity(a['counts'], b['counts']) < (FAMILY_SIMILARITY if similarity_min is None else similarity_min):
                    continue
            join(i, j)
    groups = {}
    for i in range(len(entries)):
        groups.setdefault(find(i), []).append(entries[i])
    return list(groups.values())


def _merge_sites(sites):
    """Union of members' sites: overlapping ones (by > half the shorter) are one site, the lowest p-value kept."""
    kept = []
    for s in sorted(sites, key=lambda s: (s['p'], -s['score'])):
        if any(_overlaps(s, k) for k in kept):
            continue
        kept.append(s)
    return sorted(kept, key=lambda s: s['start'])


# ------------------------------------------------------------------ the scan
def background_for(seq, background='local', genome_comp=None, M=None):
    """The background model: 'local' (``seq``'s composition), 'genome' (``genome_comp``, the loaded FASTA's; local if
    unavailable) or 'uniform'; normalised (strand-symmetric, positive, quantised)."""
    if M is None:
        from services import motifs as M
    if background == 'genome' and genome_comp:
        return M.normalize_background(genome_comp)
    if background == 'uniform':
        return M.normalize_background(M.UNIFORM_BACKGROUND)
    return M.normalize_background(M.background_composition(seq))


def scan(seq, region_lo, records, *, p=DEFAULT_P, relative=None, background='local', genome_comp=None, strand='both', M=None):
    """Score every record over ``seq`` (starting at ``region_lo``): sites at p <= ``p`` (or, with ``relative``, at
    that share of the matrix's score range), on both strands or one ('+' / '-', reference orientation).
    Returns (entries, bg composition, unreachable)."""
    if M is None:
        from services import motifs as M
    bg = background_for(seq, background, genome_comp, M)
    entries, unreachable = [], []
    for r in records:
        sm = _scored(M, r['matrix_id'], r['name'], r['counts'], bg)
        cutoff = sm.cutoff_for_relative(relative) if relative is not None else sm.cutoff_for_p(p)
        entry = dict(r, length=sm.length, min_p=sm.min_p, reachable=cutoff is not None)
        if cutoff is None:
            entry.update(sites=[], p_site=0.)
            unreachable.append(entry)
            entries.append(entry)
            continue
        hits = [h for h in M.scan_scored(seq, sm, cutoff) if strand in ('both', None) or h['strand'] == strand]
        sites = _merge_sites([dict(start=region_lo + h['start'], end=region_lo + h['end'], strand=h['strand'],
                                   score=round(h['score'], 2), p=h['p'], rel=round(h['rel'], 3), motif=r['matrix_id'])
                              for h in hits])
        entry.update(sites=sites, p_site=sm.pvalue(cutoff))
        entries.append(entry)
    return entries, bg, unreachable


def scan_nfr(seq, region_lo, records, *, p=DEFAULT_P, relative=None, background='local', M=None, **kw):
    """Older name of ``scan``."""
    return scan(seq, region_lo, records, p=p, relative=relative, background=background, M=M, **kw)


# ------------------------------------------------------------------ the genome background
_genome_comp_cache = {}


def genome_composition(fasta, path_key=None, windows=400, width=20_000, seed=7):
    """Base composition of a FASTA, sampled: ``windows`` windows of ``width`` bp spread over the references in
    proportion to their length (seeded; a few MB read once per file and cached)."""
    key = path_key or getattr(fasta, 'filename', None)
    key = key.decode() if isinstance(key, bytes) else key
    if key in _genome_comp_cache:
        return _genome_comp_cache[key]
    refs = [(r, fasta.get_reference_length(r)) for r in fasta.references]
    refs = [(r, n) for r, n in refs if n > width]
    if not refs:
        return None
    total = sum(n for _r, n in refs)
    rng = np.random.default_rng(seed)
    counts = dict(A=0, C=0, G=0, T=0)
    for _ in range(windows):
        x = rng.integers(0, total)
        for r, n in refs:
            if x < n:
                break
            x -= n
        a = int(min(max(0, x), n - width))
        s = fasta.fetch(r, a, a + width).upper()
        for b in 'ACGT':
            counts[b] += s.count(b)
    comp = counts if sum(counts.values()) else None
    _genome_comp_cache[key] = comp
    return comp



# ------------------------------------------------------------------ custom matrices (pasted or loaded)
def normalize_counts(counts):
    """{A, C, G, T: [L numbers]} with L >= 3, non-negative, every column summing above 0; None otherwise."""
    if not isinstance(counts, dict):
        return None
    try:
        cols = [[float(x) for x in counts[b]] for b in 'ACGT']
    except (KeyError, TypeError, ValueError):
        return None
    L = len(cols[0])
    if L < 3 or L > 60 or any(len(c) != L for c in cols) or any(x < 0 or not np.isfinite(x) for c in cols for x in c):
        return None
    if any(sum(cols[b][i] for b in range(4)) <= 0 for i in range(L)):
        return None
    return {b: cols[i] for i, b in enumerate('ACGT')}


def parse_motif_text(text, name=None):
    """Motifs from pasted text: an IUPAC consensus, a bare PFM (4 rows A C G T, or 4 columns, counts or
    frequencies), or JASPAR / MEME / HOMER format. Returns [{name, counts}]."""
    import os
    import tempfile
    from services import motifs as M
    t = (text or '').strip()
    if not t:
        raise ValueError('Paste a consensus, a matrix or a motif file')
    if len(t) > 200_000:
        raise ValueError('Motif text is too long')
    one = t.replace(' ', '')
    if '\n' not in t and one.isalpha():
        return [dict(name=name or one.upper(), counts=M.consensus_to_pwm(one))]
    fmt = 'meme' if 'letter-probability matrix' in t.lower() else 'homer' if t.startswith('>') and '\t' in t.split('\n', 1)[0] \
        else 'jaspar' if t.startswith('>') else None
    if fmt:
        fd, path = tempfile.mkstemp(suffix='.txt')
        try:
            with os.fdopen(fd, 'w') as fh:
                fh.write(t)
            parsed = dict(meme=M.parse_meme_file, homer=M.parse_homer_file, jaspar=M.parse_jaspar_file)[fmt](path)
        except Exception as error:
            raise ValueError(f'Could not read the {fmt.upper()} motif: {error}') from error
        finally:
            os.unlink(path)
        out = [dict(name=n, counts=normalize_counts(d['counts'])) for n, d in parsed.items()]
        out = [o for o in out if o['counts']]
        if not out:
            raise ValueError(f'No usable matrix in the {fmt.upper()} text')
        return out
    rows = []
    for line in t.splitlines():
        line = line.strip().replace('[', ' ').replace(']', ' ')
        if not line or line.startswith('#'):
            continue
        parts = line.split()
        if parts and parts[0].upper() in ('A', 'C', 'G', 'T', 'A:', 'C:', 'G:', 'T:', 'A|', 'C|', 'G|', 'T|'):
            parts = parts[1:]
        try:
            rows.append([float(x) for x in parts])
        except ValueError as error:
            raise ValueError(f'Not a number in the matrix: {line[:40]}') from error
    if len(rows) == 4 and len({len(r) for r in rows}) == 1:
        counts = {b: rows[i] for i, b in enumerate('ACGT')}
    elif rows and all(len(r) == 4 for r in rows):
        counts = {b: [r[i] for r in rows] for i, b in enumerate('ACGT')}
    else:
        raise ValueError('A matrix needs 4 rows (A, C, G, T) or 4 columns')
    counts = normalize_counts(counts)
    if counts is None:
        raise ValueError('The matrix needs >= 3 positions of non-negative numbers')
    return [dict(name=name or 'custom', counts=counts)]


# ------------------------------------------------------------------ request options (shared by the panels)
def motif_options(*, mode=None, p=None, relative=None, background='local', strand='both', family_similarity=None,
                  custom=None, pinned=None, motifs=None, default_relative=0.8):
    """Validated scoring options. ``mode`` 'p' (per-matrix p-value; default) or 'relative' (the share of each
    matrix's score range, the older behaviour); each mode keeps its own threshold (``p``, ``relative``). An older
    request with only ``relative`` set means relative mode."""
    if mode is None:
        mode = 'relative' if relative is not None and p is None else 'p'
    if mode not in ('p', 'relative'):
        raise ValueError("mode must be 'p' or 'relative'")
    p = DEFAULT_P if p is None else float(p)
    if not 1e-10 <= p <= 0.05:
        raise ValueError('p must be 1e-10 - 0.05')
    relative = default_relative if relative is None else float(relative)
    if not 0.5 <= relative <= 1:
        raise ValueError('relative must be 0.5-1 (share of the matrix score range)')
    if background not in ('local', 'genome', 'uniform'):
        raise ValueError("background must be 'local', 'genome' or 'uniform'")
    if strand not in ('both', '+', '-'):
        raise ValueError("strand must be 'both', '+' or '-'")
    fs = FAMILY_SIMILARITY if family_similarity is None else float(family_similarity)
    if not 0.5 <= fs <= 1.0:
        raise ValueError('family_similarity must be 0.5-1')
    if custom is not None and not isinstance(custom, (list, tuple)):
        raise ValueError('custom must be a list of {name, counts}')
    custom = [c for c in (custom or ())][:50]
    if pinned is not None:
        if not isinstance(pinned, (list, tuple)):
            raise ValueError('pinned must be a list of motif names')
        pinned = [str(m).strip() for m in pinned if str(m).strip()][:100]
    names = [str(m).strip() for m in motifs or () if str(m).strip()]
    return dict(mode=mode, p=p, relative=relative, background=background, strand=strand, family_similarity=fs,
                custom=custom, pinned=pinned, motifs=names)


def options_key(o):
    """A hashable cache key for ``motif_options`` output."""
    import json
    return json.dumps(o, sort_keys=True, default=str)
