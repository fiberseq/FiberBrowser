"""The overlaid patch view (DESIGN §8, hub V1): an aligned metaprofile of a mark layer over arbitrary loci.

Each locus (a hub hit, an anchor, a nucleosome patch) is aligned by its anchor (with strand), its left or right edge,
or scaled to unit length with flanks in bp. For each observation (a dataset panel, a haplotype pop-out, a graph path:
the nucleosome panel's planner) and each aligned position x::

    density(x) = (molecules with the mark covering x) / (molecules measured at x)

"Measured" is the nucleosome module's measured track (``services.nuc.patches.molecule_track``): inside the molecule's
decoded regular / disordered / undetermined segments, on its aligned reference blocks, outside low-information
segments. A molecule that doesn't reach x, or is low-information there, is never counted as absence (DESIGN §8.1,
DGP2 §6.2 L2, NUC §6.3). Molecules come from the observation's cohort (one record per physical molecule; live
outputs, a bound scan's rows, or an annotated BAM's groups: ``services.nuc.observations.observation_cohort``).

Graph mode: a graph-path observation counts a locus only when the hub hit's graph columns say that path **carries** it;
paths where it is absent or unresolved are left out of numerator and denominator, and counted (``lociSkipped``).
A lifted observation measures the locus through its haplotype's lift pieces (the anchor projected onto the source
contig; a ``-`` piece turns the orientation).

The response keeps per-bin numerators and denominators (molecules measured, averaged over the bin's sample points)
and a pile sample (default at most 400 rows) chosen by a seeded hash of (locus, molecule), stable across reloads.
"""
from __future__ import annotations

import hashlib
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

LAYERS = ('regular', 'disordered', 'undetermined', 'low_information', 'undersized', 'missing', 'nucleosome', 'tf')
_KIND = {'regular': 'reg', 'disordered': 'dis', 'undetermined': 'und', 'low_information': 'low', 'undersized': 'uds',
         'missing': 'mis'}
ALIGNS = ('anchor', 'left', 'right', 'scaled')
MAX_LOCI = 2000
MAX_RANGE_BP = 40_000
SCALED_BINS = 100
SAMPLES_PER_BIN = 4


class OverlayError(ValueError):
    pass


def _union(iv):
    out: List[List[int]] = []
    for a, b in sorted((int(a), int(b)) for a, b in iv if b > a):
        if out and a <= out[-1][1]:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return [(a, b) for a, b in out]


def _inside(points: np.ndarray, iv: Sequence[Tuple[int, int]]) -> np.ndarray:
    """Which (integer) positions fall in the disjoint sorted intervals."""
    if not len(iv):
        return np.zeros(len(points), bool)
    starts = np.array([a for a, _b in iv], np.int64)
    ends = np.array([b for _a, b in iv], np.int64)
    k = np.searchsorted(starts, points, 'right') - 1
    ok = k >= 0
    out = np.zeros(len(points), bool)
    out[ok] = points[ok] < ends[k[ok]]
    return out


def marks_of(row, layer: str, measured, kinds) -> List[Tuple[int, int]]:
    if layer in _KIND:
        return _union(kinds.get(_KIND[layer]) or [])
    out = []
    for _ms, _ml, a, b, q, _n in row.groups.get('nucsz') or ():
        if not q or b <= a:
            continue
        tf = bool(int(q[0]) & 16)
        if (layer == 'tf') == tf:
            out.append((int(a), int(b)))
    return _union(out)


class Axis:
    """The aligned axis: bin edges, labels, and the genomic sample positions of each locus."""

    def __init__(self, align: str, flank: int, widths: Sequence[int], bin_bp: Optional[int] = None):
        self.align, self.flank = align, int(flank)
        w = int(np.percentile(widths, 95)) if len(widths) else 0
        self.width = max(1, min(w, MAX_RANGE_BP))
        if align == 'anchor':
            self.lo, self.hi = -self.flank, self.flank + 1
        elif align == 'left':
            self.lo, self.hi = -self.flank, self.width + self.flank
        elif align == 'right':
            self.lo, self.hi = -(self.width + self.flank), self.flank
        else:
            self.lo, self.hi = -self.flank, self.flank
        span = (self.hi - self.lo) if align != 'scaled' else 2 * self.flank
        self.bin_bp = int(bin_bp) if bin_bp else max(10, int(round(max(1, span) / 200 / 10.0)) * 10)
        if align == 'scaled':
            nf = max(0, int(np.ceil(self.flank / self.bin_bp)))
            self.n_left = self.n_right = nf
            self.nbins = nf + SCALED_BINS + nf
            self.x = [(-nf + i + 0.5) * self.bin_bp for i in range(nf)] + \
                     [(i + 0.5) / SCALED_BINS for i in range(SCALED_BINS)] + \
                     [(i + 0.5) * self.bin_bp for i in range(nf)]
            self.label = f'scaled: flanks in bp ({self.bin_bp} bp bins), each patch 0–1 in {SCALED_BINS} bins'
        else:
            self.nbins = int(np.ceil((self.hi - self.lo) / self.bin_bp))
            self.x = [self.lo + (i + 0.5) * self.bin_bp for i in range(self.nbins)]
            self.label = {'anchor': 'bp from the anchor', 'left': 'bp from the left edge', 'right': 'bp from the right edge'}[align]

    def samples(self, a0: int, a1: int, anchor: int, minus: bool):
        """(genomic positions, bin index) of the sample points of one locus in its own frame."""
        k = SAMPLES_PER_BIN
        if self.align == 'scaled':
            # left flank (bins 0..nf-1, outermost first), the patch scaled to SCALED_BINS bins, the right flank
            nf = self.n_left
            off = (np.arange(nf * k) + 0.5) / k * self.bin_bp           # bp out from the edge, nearest first
            inner = (np.arange(SCALED_BINS * k) + 0.5) / (SCALED_BINS * k) * max(1, a1 - a0)
            if not minus:
                pts = np.concatenate([a0 - off[::-1], a0 + inner, a1 + off])
            else:
                pts = np.concatenate([a1 - 1 + off[::-1], a1 - 1 - inner, a0 - 1 - off])
            bins = np.concatenate([np.repeat(np.arange(nf), k), nf + np.repeat(np.arange(SCALED_BINS), k),
                                   nf + SCALED_BINS + np.repeat(np.arange(nf), k)])
            return np.floor(pts).astype(np.int64), bins.astype(np.int64)
        xs = self.lo + (np.arange(self.nbins * k) + 0.5) / k * self.bin_bp
        bins = np.repeat(np.arange(self.nbins), k)
        ref = {'anchor': anchor, 'left': a0 if not minus else a1 - 1, 'right': a1 - 1 if not minus else a0}[self.align]
        pts = ref + xs if not minus else ref - xs
        return np.floor(pts).astype(np.int64), bins

    def to_x(self, iv: Sequence[Tuple[int, int]], a0: int, a1: int, anchor: int, minus: bool) -> List[Tuple[float, float]]:
        """Genomic intervals of one locus mapped onto the axis (pile rows), clipped to the axis range."""
        out = []
        for a, b in iv:
            if self.align == 'scaled':
                def f(p):
                    # flanks in bp (negative left of the patch; 1 + bp right of it), the patch 0-1
                    if minus:
                        p = a0 + a1 - p
                    if p < a0:
                        return float(p - a0)
                    if p >= a1:
                        return 1.0 + (p - a1)
                    return (p - a0) / max(1, a1 - a0)
                x0, x1 = sorted((f(a), f(b)))
            else:
                ref = {'anchor': anchor, 'left': a0 if not minus else a1, 'right': a1 if not minus else a0}[self.align]
                x0, x1 = (a - ref, b - ref) if not minus else (ref - b, ref - a)
                x0, x1 = max(x0, self.lo), min(x1, self.hi)
            if x1 > x0:
                out.append((round(float(x0), 3), round(float(x1), 3)))
        return out


def _pile_key(seed: str, locus: str, molecule: str) -> str:
    return hashlib.sha256(f'{seed}\n{locus}\n{molecule}'.encode()).hexdigest()


def _path_status(locus: dict, obs: dict) -> Optional[str]:
    """A graph observation's path status for a locus (from the hub hit's graph columns), else None."""
    paths = locus.get('paths') or {}
    hap = (obs.get('graph') or {}).get('hap') or obs.get('liftHap')
    ds = obs.get('datasetId')
    for name, p in paths.items():
        if not isinstance(p, dict):
            continue
        if hap and p.get('hap') in (hap,) and (not p.get('datasets') or ds in p.get('datasets')):
            return str(p.get('status'))
    for name, p in paths.items():
        if isinstance(p, dict) and not hap and ds in (p.get('datasets') or []):
            return str(p.get('status'))
    return None


def overlay(state, request: dict) -> dict:
    """The overlay of one layer over the request's loci for each observation (module docstring)."""
    from services.nuc.inputs import browser_read_policy
    from services.nuc.observations import ObservationError, observation_cohort, same_contig, window_hull
    from services.nuc.patches import molecule_track
    from services.nuc.store import STORE
    from services.nuc.window import _in_frame
    from services.nuc.inputs import nuc_source
    layer = str(request.get('layer') or 'regular')
    if layer not in LAYERS:
        raise OverlayError(f'Unknown layer {layer!r} (one of {", ".join(LAYERS)})')
    align = str(request.get('align') or 'left')
    if align not in ALIGNS:
        raise OverlayError(f'Unknown alignment {align!r}')
    flank = max(0, min(20_000, int(request.get('flank') or 1000)))
    loci = [l for l in request.get('loci') or [] if isinstance(l, dict) and l.get('chrom')][:MAX_LOCI + 1]
    if not loci:
        raise OverlayError('No loci: select hits, choose a set or an anchor set')
    notes = []
    if len(loci) > MAX_LOCI:
        loci = loci[:MAX_LOCI]
        notes.append(f'the first {MAX_LOCI:,} loci were used')
    observations = [o for o in request.get('observations') or [] if isinstance(o, dict) and o.get('datasetId')]
    if not observations:
        raise OverlayError('No dataset panel is shown to measure')
    pile_max = max(0, min(2000, int(request.get('pileMax') or 400)))
    seed = str(request.get('seed') or 'fiberbrowser.overlay')
    widths = [max(1, int(l['end']) - int(l['start'])) for l in loci]
    axis = Axis(align, flank, widths, request.get('binBp'))
    policy = browser_read_policy(state, include_duplicates=bool(request.get('includeDuplicates')))
    graph_mode = any(o.get('kind') == 'graph' for o in observations)
    series, pile_all = [], []
    for obs in observations:
        k = SAMPLES_PER_BIN
        num = np.zeros(axis.nbins)
        den = np.zeros(axis.nbins)
        used_loci, molecules, missing = 0, set(), 0
        skipped: Dict[str, int] = {}
        entry = dict(obsId=obs.get('obsId'), label=obs.get('label'), datasetId=obs.get('datasetId'),
                     kind=obs.get('kind') or 'linear', hap=(obs.get('graph') or {}).get('hap') or obs.get('liftHap'))
        try:
            source = nuc_source(state, str(obs['datasetId']))
        except ValueError as error:
            entry['error'] = str(error)
            series.append(entry)
            continue
        for locus in loci:
            a0, a1, anchor = int(locus['start']), int(locus['end']), int(locus.get('anchor', locus['start']))
            a1 = max(a1, a0 + 1)
            minus = locus.get('strand') == '-'
            if obs.get('kind') == 'graph':
                status = _path_status(locus, obs)
                if status is None and locus.get('paths'):
                    skipped['unresolved'] = skipped.get('unresolved', 0) + 1
                    continue
                if status is not None and status != 'carried':
                    skipped[status] = skipped.get(status, 0) + 1
                    continue
            # The locus window (target coordinates), then the observation's records over it.
            if align == 'anchor':
                w0, w1 = anchor - flank, anchor + flank + 1
            elif align == 'left':
                w0, w1 = (a0 - flank, a0 + axis.width + flank) if not minus else (a1 - axis.width - flank, a1 + flank)
            elif align == 'right':
                w0, w1 = (a1 - axis.width - flank, a1 + flank) if not minus else (a0 - flank, a0 + axis.width + flank)
            else:
                w0, w1 = a0 - flank, a1 + flank
            w0 = max(0, w0)
            scoped = {**obs, 'chrom': locus['chrom'], 'start': w0, 'end': w1}
            if scoped.get('kind') == 'graph':
                scoped['graph'] = {kk: v for kk, v in (obs.get('graph') or {}).items() if kk == 'hap'}
            src = locus.get('source') if source.kind == 'lifted' else None
            try:
                _source, _recs, windows, cfg, cohort, counts = observation_cohort(state, scoped, policy)
            except (ObservationError, ValueError) as error:
                skipped['error'] = skipped.get('error', 0) + 1
                entry.setdefault('errors', []).append(str(error))
                continue
            if not windows:
                skipped['not_on_this_observation'] = skipped.get('not_on_this_observation', 0) + 1
                continue
            missing += counts.get('missing', 0)
            # The locus in the records' own frame (a lifted observation: projected onto its haplotype's contig).
            if source.kind == 'lifted':
                if src and src.get('chrom'):
                    la0, la1, lan, lminus, contig = int(src['start']), int(src['end']), int(src.get('anchor', src['start'])), minus, src['chrom']
                else:
                    pa = _in_frame(state, source, obs, locus['chrom'], a0, 1)
                    pb = _in_frame(state, source, obs, locus['chrom'], a1 - 1, 1)
                    pn = _in_frame(state, source, obs, locus['chrom'], anchor, 1)
                    if pa is None or pb is None or pa[0] != pb[0]:
                        skipped['not_on_this_observation'] = skipped.get('not_on_this_observation', 0) + 1
                        continue
                    contig = pa[0]
                    la0, la1 = sorted((pa[1], pb[1]))
                    la1 += 1
                    lan = pn[1] if pn is not None and pn[0] == contig else (la0 + la1) // 2
                    lminus = minus != (pa[2] < 0)
            else:
                la0, la1, lan, lminus, contig = a0, a1, anchor, minus, window_hull(windows)[0]
            pts, bins = axis.samples(la0, la1, lan, lminus)
            got = False
            for rec, row in cohort:
                if row.low_information or not same_contig(row.chrom, contig):
                    continue
                hit = STORE.get_result(rec.path, rec.sha, rec.occ, cfg.config_for(rec.path)) if cfg is not None else None
                measured, kinds = molecule_track(row, hit[0] if hit else None, rec.blocks)
                if not measured:
                    continue
                m = _inside(pts, measured)
                if not m.any():
                    continue
                marks = marks_of(row, layer, measured, kinds)
                x = _inside(pts, marks) & m
                np.add.at(den, bins[m], 1.0)
                np.add.at(num, bins[x], 1.0)
                got = True
                mol = f'{obs.get("datasetId")}|{rec.qname}'
                molecules.add(mol)
                if pile_max:
                    lo_g, hi_g = int(pts.min()), int(pts.max()) + 1
                    clip = lambda iv: [(max(a, lo_g), min(b, hi_g)) for a, b in iv if b > lo_g and a < hi_g]  # noqa: E731
                    pile_all.append((_pile_key(seed, str(locus.get('key') or locus.get('hitId') or f'{a0}'), mol), dict(
                        obsId=obs.get('obsId'), locus=str(locus.get('key') or locus.get('hitId') or f'{locus["chrom"]}:{a0}'),
                        molecule=rec.qname, marks=axis.to_x(clip(marks), la0, la1, lan, lminus),
                        measured=axis.to_x(clip(measured), la0, la1, lan, lminus),
                        length=int(sum(min(b, la1) - max(a, la0) for a, b in marks if b > la0 and a < la1)))))
            if got:
                used_loci += 1
        entry.update(x=axis.x, num=[round(v / k, 3) for v in num], den=[round(v / k, 3) for v in den], loci=used_loci,
                     molecules=len(molecules), notComputed=missing, lociSkipped=skipped)
        if entry.get('errors'):
            entry['errors'] = list(dict.fromkeys(entry['errors']))[:5]
        series.append(entry)
    pile_all.sort(key=lambda kv: kv[0])
    pile = [r for _k, r in pile_all[:pile_max]]
    if not any(s.get('molecules') for s in series):
        notes.append('no molecule has nucleosome outputs over these loci: Compute in view in the Nucleosomes panel, or '
                     'scan the view with the nuc module (Scan… in the hub)')
    if graph_mode:
        notes.append('graph paths count a locus only where they carry it (absent and unresolved paths are left out)')
    return dict(layer=layer, align=align, flank=flank, binBp=axis.bin_bp, scaledBins=SCALED_BINS if align == 'scaled' else None,
                xLabel=axis.label, series=series, pile=pile, pileTotal=len(pile_all), loci=len(loci), graphMode=graph_mode,
                notes=notes)
