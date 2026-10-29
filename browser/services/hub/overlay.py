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

Sampling. Every bin holds four sample points (bounded by the bin's own edges; the last bin of a range is cut at the
range's end). A locus is sampled on this genome's coordinates; a live-lift observation maps every sample through
its haplotype's primary lift pieces one by one, so a base that haplotype lacks has no sample there (nothing
measured, never absence), a ``-`` piece reverses as it maps, and the records are fetched over exactly the mapped
samples. A hit of an assembly scan is sampled on its own source coordinates for its own haplotype.

Carriers only (graph mode). A graph-path observation counts a locus only when the hub hit's graph columns say that
path carries it, whole or in part; absent and unresolved paths are left out and counted (``lociSkipped``). A
linear observation whose haplotype (or dataset) the graph columns name follows the same rule. A locus inside an
insertion (relative to this genome) is never measured on this genome's own reads (``absent``), and on another
haplotype's panel only through its own graph status.

The response keeps per-bin numerators and denominators (molecules, averaged over a bin's samples), the axis, and a
pile sample (default at most 400 rows) chosen by a seeded hash of (locus, molecule), stable across reloads.
"""
from __future__ import annotations

import hashlib
from collections import Counter
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
    """Which (integer) positions fall in the disjoint sorted intervals (negative positions: never)."""
    out = np.zeros(len(points), bool)
    if not len(iv):
        return out
    starts = np.array([a for a, _b in iv], np.int64)
    ends = np.array([b for _a, b in iv], np.int64)
    k = np.searchsorted(starts, points, 'right') - 1
    ok = (k >= 0) & (points >= 0)
    out[ok] = points[ok] < ends[k[ok]]
    return out


def marks_of(row, layer: str, kinds) -> List[Tuple[int, int]]:
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
    """The aligned axis: bounded bins (edges), their centres and labels, and each locus's sample positions."""

    def __init__(self, align: str, flank: int, widths: Sequence[int], bin_bp: Optional[int] = None):
        self.align, self.flank = align, int(flank)
        w = int(np.percentile(widths, 95)) if len(widths) else 0
        self.width = max(1, min(w, MAX_RANGE_BP))
        span = {'anchor': 2 * self.flank + 1, 'left': self.width + 2 * self.flank,
                'right': self.width + 2 * self.flank, 'scaled': 2 * self.flank}[align]
        self.bin_bp = int(bin_bp) if bin_bp else max(10, int(round(max(1, span) / 200 / 10.0)) * 10)
        b = self.bin_bp
        if align == 'scaled':
            # left flank [-flank, 0) (its outermost bin cut at -flank), the patch in SCALED_BINS bins, right flank
            # [0, flank) after the patch (its outermost bin cut at flank)
            self.left_edges = sorted({max(-self.flank, -s) for s in range(0, self.flank + b, b)}) if self.flank else [0]
            self.right_edges = sorted({min(self.flank, s) for s in range(0, self.flank + b, b)}) if self.flank else [0]
            self.n_left, self.n_right = len(self.left_edges) - 1, len(self.right_edges) - 1
            self.nbins = self.n_left + SCALED_BINS + self.n_right
            self.x = [(self.left_edges[i] + self.left_edges[i + 1]) / 2 for i in range(self.n_left)] + \
                     [(i + 0.5) / SCALED_BINS for i in range(SCALED_BINS)] + \
                     [1.0 + (self.right_edges[i] + self.right_edges[i + 1]) / 2 for i in range(self.n_right)]
            self.label = f'scaled: flanks in bp ({b} bp bins), each patch 0–1 in {SCALED_BINS} bins'
        else:
            self.lo, self.hi = {'anchor': (-self.flank, self.flank + 1), 'left': (-self.flank, self.width + self.flank),
                                'right': (-(self.width + self.flank) + 1, self.flank + 1)}[align]
            self.edges = list(range(self.lo, self.hi, b)) + [self.hi]
            self.nbins = len(self.edges) - 1
            self.x = [(self.edges[i] + self.edges[i + 1]) / 2 for i in range(self.nbins)]
            self.label = {'anchor': 'bp from the anchor', 'left': 'bp from the left edge', 'right': 'bp from the right edge'}[align]

    @staticmethod
    def _within(edges) -> Tuple[np.ndarray, np.ndarray]:
        """Integer offsets of SAMPLES_PER_BIN points inside each [e_k, e_k+1), and their bins."""
        e = np.asarray(edges, float)
        w = np.diff(e)
        j = (np.arange(SAMPLES_PER_BIN) + 0.5) / SAMPLES_PER_BIN
        off = np.floor(e[:-1, None] + w[:, None] * j[None, :]).astype(np.int64).ravel()
        bins = np.repeat(np.arange(len(w)), SAMPLES_PER_BIN)
        return off, bins

    def samples(self, a0: int, a1: int, anchor: int, minus: bool) -> Tuple[np.ndarray, np.ndarray]:
        """(genomic positions, bin index) of one locus's sample points in its own coordinates. A '-' locus is the
        mirror image: the base at offset d from the reference base r is r - d (r + d on '+')."""
        pts, bins, _x, _w = self.samples_x(a0, a1, anchor, minus)
        return pts, bins

    def samples_x(self, a0: int, a1: int, anchor: int, minus: bool):
        """Like ``samples``, plus each sample's axis interval (its centre and width in axis units: bp, or the patch's
        0-1 inside a scaled locus), so a pile row drawn from samples covers exactly what was sampled."""
        k = SAMPLES_PER_BIN
        if self.align == 'scaled':
            lo_off, lo_bins = self._within(self.left_edges)
            hi_off, hi_bins = self._within(self.right_edges)
            width = max(1, a1 - a0)
            j = (np.arange(SCALED_BINS * k) + 0.5) / (SCALED_BINS * k)
            inner = a0 + np.floor(j * width).astype(np.int64)
            pts = np.concatenate([a0 + lo_off, inner, a1 + hi_off])                 # '+' positions
            bins = np.concatenate([lo_bins, self.n_left + np.repeat(np.arange(SCALED_BINS), k),
                                   self.n_left + SCALED_BINS + hi_bins])
            lw = np.repeat(np.diff(np.asarray(self.left_edges, float)) / k, k)
            rw = np.repeat(np.diff(np.asarray(self.right_edges, float)) / k, k)
            lx = np.repeat(np.asarray(self.left_edges[:-1], float), k) + (np.tile(np.arange(k), self.n_left) + 0.5) * lw
            rx = 1.0 + np.repeat(np.asarray(self.right_edges[:-1], float), k) + (np.tile(np.arange(k), self.n_right) + 0.5) * rw
            x = np.concatenate([lx, j, rx])
            wx = np.concatenate([lw, np.full(len(j), 1.0 / (SCALED_BINS * k)), rw])
            if minus:
                pts = a0 + a1 - 1 - pts
            return pts.astype(np.int64), bins.astype(np.int64), x, wx
        off, bins = self._within(self.edges)
        e = np.asarray(self.edges, float)
        wx = np.repeat(np.diff(e) / k, k)
        x = np.repeat(e[:-1], k) + (np.tile(np.arange(k), self.nbins) + 0.5) * wx
        ref = {'anchor': anchor, 'left': a0 if not minus else a1 - 1, 'right': a1 - 1 if not minus else a0}[self.align]
        pts = ref + off if not minus else ref - off
        return pts.astype(np.int64), bins, x, wx

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
                x0, x1 = max(x0, -self.flank), min(x1, 1.0 + self.flank)
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
    """An observation's path status for a locus (from the hub hit's graph columns), else None."""
    paths = locus.get('paths') or {}
    hap = (obs.get('graph') or {}).get('hap') or obs.get('liftHap')
    ds = obs.get('datasetId')
    for p in paths.values():
        if isinstance(p, dict) and hap and p.get('hap') == hap and (not p.get('datasets') or ds in p.get('datasets')):
            return str(p.get('status'))
    for p in paths.values():
        if isinstance(p, dict) and not hap and ds in (p.get('datasets') or []):
            return str(p.get('status'))
    return None


def lift_points(state, source, hap: Optional[str], chrom: str, pts: np.ndarray):
    """Target positions -> (source positions, the contig most of them map to) through a live-lift dataset's primary
    pieces of ``hap``; a position no piece of that haplotype holds (or on another contig) maps to -1."""
    from services.lift.live_lift import lift_key, select_pieces
    config = state.datasets[source.browser_id].live_lift
    handle = config.handle
    out = np.full(len(pts), -1, np.int64)
    if chrom not in handle.map.targets or not len(pts):
        return out, None
    haps = handle.resolve_haplotypes(config.haplotypes)
    key = lift_key(handle, haps, config.settings)
    lo, hi = int(pts.min()), int(pts.max()) + 1
    sel = select_pieces(handle, chrom, max(0, lo), hi, haplotypes=haps, settings=config.settings, key=key)
    labels = getattr(handle, 'haplotype_labels', None) or {}
    contig = np.empty(len(pts), dtype=object)
    for p in sel.pieces:
        if not p.primary or (hap and hap not in (p.hap, labels.get(p.hap))):
            continue
        m = (pts >= p.t_start) & (pts < p.t_end) & (out < 0)
        if not m.any():
            continue
        out[m] = (p.q_start + (pts[m] - p.t_start)) if p.strand == '+' else (p.q_end - 1 - (pts[m] - p.t_start))
        contig[m] = p.source
    mapped = out >= 0
    if not mapped.any():
        return out, None
    main = Counter(contig[mapped]).most_common(1)[0][0]
    out[mapped & (contig != main)] = -1
    return out, main


def overlay(state, request: dict) -> dict:
    """The overlay of one layer over the request's loci for each observation (module docstring)."""
    from services.nuc.inputs import browser_read_policy, nuc_source
    from services.nuc.observations import ObservationError, observation_cohort, same_contig
    from services.nuc.patches import molecule_track
    from services.nuc.store import STORE
    layer = str(request.get('layer') or 'regular')
    generic = layer.startswith('layer:') and bool(layer[6:])
    if layer not in LAYERS and not generic:
        raise OverlayError(f'Unknown layer {layer!r} (one of {", ".join(LAYERS)})')
    align = str(request.get('align') or 'left')
    if align not in ALIGNS:
        raise OverlayError(f'Unknown alignment {align!r}')
    flank = request.get('flank')
    flank = 1000 if flank is None else max(0, min(20_000, int(flank)))
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
    pile_max = max(0, min(2000, int(request.get('pileMax') if request.get('pileMax') is not None else 400)))
    seed = str(request.get('seed') or 'fiberbrowser.overlay')
    # Edge alignment needs each patch's length: a hit inside an insertion is measured on its own haplotype's source
    # span (its place on this genome is only the junction).
    graph_mode = any(o.get('kind') == 'graph' for o in observations)
    widths = [max(1, int(l['source']['end']) - int(l['source']['start'])) if (l.get('insertion') or (graph_mode and l.get('graph', {}).get('binding') != l.get('graph', {}).get('target'))) and isinstance(l.get('source'), dict)
              and l['source'].get('end') is not None else max(1, int(l['end']) - int(l['start'])) for l in loci]
    axis = Axis(align, flank, widths, request.get('binBp'))
    policy = browser_read_policy(state, include_duplicates=bool(request.get('includeDuplicates')))
    graph_mode = any(o.get('kind') == 'graph' for o in observations)
    series, pile_all = [], []
    k = SAMPLES_PER_BIN
    for obs in observations:
        num = np.zeros(axis.nbins)
        den = np.zeros(axis.nbins)
        used_loci, molecules, missing = 0, set(), 0
        skipped: Dict[str, int] = {}
        obs_hap = (obs.get('graph') or {}).get('hap') or obs.get('liftHap')
        entry = dict(obsId=obs.get('obsId'), label=obs.get('label'), datasetId=obs.get('datasetId'),
                     kind=obs.get('kind') or 'linear', hap=obs_hap)
        try:
            source = nuc_source(state, str(obs['datasetId']))
        except ValueError as error:
            entry['error'] = str(error)
            series.append(entry)
            continue

        def skip(reason):
            skipped[reason] = skipped.get(reason, 0) + 1

        for locus in loci:
            a0, a1, anchor = int(locus['start']), int(locus['end']), int(locus.get('anchor', locus['start']))
            a1 = max(a1, a0 + 1)
            minus = locus.get('strand') == '-'
            insertion = bool(locus.get('insertion'))
            geometry = locus.get('_graph_geometry') if graph_mode else None
            if graph_mode and locus.get('_graph_error'):
                skip('graph_columns_unavailable')
                continue
            # Carriers only (module docstring).
            status = _path_status(locus, obs)
            if status is None and obs.get('kind') == 'graph' and locus.get('paths'):
                skip('unresolved')
                continue
            if status is not None and status not in ('carried', 'partial'):
                skip(status)
                continue
            if status == 'partial' and source.kind != 'lifted' and geometry is None:
                # a partial carrier is measured where its lift maps each base (bases it lacks have no source base);
                # a native panel has no lift to mask the columns it lacks
                skip('partial')
                continue
            src = locus.get('source') if source.kind == 'lifted' else None
            # the hit's own source coordinates only on its own dataset and haplotype
            # A hit inside an insertion has no bases on this genome: it is sampled on its own source coordinates, on its
            # own dataset and haplotype. Every other locus is sampled on this genome's axis and each sample lifted, so
            # every panel measures the same displayed position.
            own = bool(insertion and src and src.get('chrom')
                       and (not src.get('hap') or not obs_hap or src.get('hap') == obs_hap)
                       and (not src.get('datasetId') or src.get('datasetId') == obs.get('datasetId')))
            if insertion and source.kind != 'lifted' and geometry is None:
                skip('absent')               # inside an insertion: this genome's own reads don't hold its sequence
                continue
            if insertion and not own and geometry is None:
                skip('other_haplotype')      # another haplotype's insertion hit: no position on this panel's contig
                continue
            # The sample points in the records' own coordinates.
            column_mapped = geometry is not None
            if column_mapped:
                from .graph_overlay import graph_points
                canonical_source = locus.get('source') if geometry['canonical'] != (locus.get('graph') or {}).get('target') else None
                base = canonical_source or locus
                ca, cb = int(base['start']), max(int(base['end']), int(base['start']) + 1)
                cp = int(base.get('anchor', ca))
                cm = base.get('strand') == '-'
                samples, bins, sx, sw = axis.samples_x(ca, cb, cp, cm)
                if align == 'anchor':
                    mapped_anchor, _ = graph_points(geometry, obs, np.array([cp], np.int64))
                    if mapped_anchor[0] < 0:
                        skip('anchor_not_on_this_observation')
                        continue
                pts, contig = graph_points(geometry, obs, samples)
                if contig is None:
                    skip('unresolved')
                    continue
                geo = (ca, cb, cp, cm)
            elif own:
                la0, la1 = int(src['start']), max(int(src['end']), int(src['start']) + 1)
                lan = int(src.get('anchor', src['start']))
                sminus = src.get('strand') == '-' if src.get('strand') in ('+', '-') else minus
                pts, bins, sx, sw = axis.samples_x(la0, la1, lan, sminus)
                contig = str(src['chrom'])
                geo = (la0, la1, lan, sminus)
            else:
                pts, bins, sx, sw = axis.samples_x(a0, a1, anchor, minus)
                geo = (a0, a1, anchor, minus)
                contig = locus['chrom']
                if source.kind == 'lifted':
                    if align == 'anchor':
                        # the anchor itself must exist on this haplotype (never a substitute position)
                        at, at_contig = lift_points(state, source, obs_hap, locus['chrom'], np.array([anchor], np.int64))
                        if at_contig is None or at[0] < 0:
                            skip('anchor_not_on_this_observation')
                            continue
                    pts, contig = lift_points(state, source, obs_hap, locus['chrom'], pts)
                    if contig is None or (align == 'anchor' and contig != at_contig):
                        skip('not_on_this_observation')
                        continue
            ok = pts >= 0
            if not ok.any():
                skip('not_on_this_observation')
                continue
            w0, w1 = int(pts[ok].min()), int(pts[ok].max()) + 1
            if source.kind == 'lifted' or column_mapped:
                # the records over exactly the mapped samples, on the haplotype's own contig
                scoped = {**obs, 'kind': 'graph', 'chrom': locus['chrom'], 'start': a0, 'end': a1,
                          'graph': {'contig': contig, 'start': w0, 'end': w1, **({'hap': obs_hap} if obs_hap else {})}}
            else:
                scoped = {**obs, 'chrom': contig, 'start': w0, 'end': w1}
                if scoped.get('kind') == 'graph':
                    scoped['graph'] = {kk: v for kk, v in (obs.get('graph') or {}).items() if kk == 'hap'}
            try:
                if generic:
                    from .layer_cohort import layer_cohort
                    _source, _recs, windows, cfg, cohort, counts = layer_cohort(state, scoped, policy, layer[6:])
                else:
                    _source, _recs, windows, cfg, cohort, counts = observation_cohort(state, scoped, policy)
            except (ObservationError, ValueError) as error:
                skip('error')
                entry.setdefault('errors', []).append(str(error))
                continue
            if not windows:
                skip('not_on_this_observation')
                continue
            missing += counts.get('missing', 0)
            got = False
            for rec, row in cohort:
                if row.low_information or not same_contig(row.chrom, contig):
                    continue
                hit = STORE.get_result(rec.path, rec.sha, rec.occ, cfg.config_for(rec.path)) if cfg is not None else None
                if generic:
                    measured, kinds = _union(row.measured), {}
                else:
                    measured, kinds = molecule_track(row, hit[0] if hit else None, rec.blocks, hit[1] if hit else None)
                if not measured:
                    continue
                m = _inside(pts, measured)
                if not m.any():
                    continue
                marks = _union(row.marks) if generic else marks_of(row, layer, kinds)
                x = _inside(pts, marks) & m
                np.add.at(den, bins[m], 1.0)
                np.add.at(num, bins[x], 1.0)
                got = True
                mol = f'{obs.get("datasetId")}|{rec.qname}'
                molecules.add(mol)
                if pile_max:
                    lkey = str(locus.get('key') or locus.get('hitId') or f'{locus["chrom"]}:{a0}')
                    if not column_mapped and (own or source.kind != 'lifted'):
                        la0, la1, lan, lminus = geo
                        clip = lambda iv: [(max(a, w0), min(b, w1)) for a, b in iv if b > w0 and a < w1]  # noqa: E731
                        pm, pmeas = axis.to_x(clip(marks), la0, la1, lan, lminus), axis.to_x(clip(measured), la0, la1, lan, lminus)
                        plen = int(sum(min(b, la1) - max(a, la0) for a, b in marks if b > la0 and a < la1))
                    else:
                        # a lifted panel: the sampled axis intervals, merged where they touch (bases the haplotype
                        # lacks are gaps)
                        pm, pmeas = _runs(sx, sw, x), _runs(sx, sw, m)
                        plen = int(x.sum())
                    pile_all.append((_pile_key(seed, lkey, mol), dict(obsId=obs.get('obsId'), locus=lkey, molecule=rec.qname,
                                                                    marks=pm, measured=pmeas, length=plen)))
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
        notes.append('No measured molecule carries this layer over these loci. Load or compute its outputs first.')
    if graph_mode:
        notes.append('graph paths count a locus only where they carry it (absent and unresolved paths are left out)')
    return dict(layer=layer, align=align, flank=flank, binBp=axis.bin_bp, scaledBins=SCALED_BINS if align == 'scaled' else None,
                x=axis.x, xLabel=axis.label, series=series, pile=pile, pileTotal=len(pile_all), loci=len(loci),
                graphMode=graph_mode, notes=notes)


def _runs(xs: np.ndarray, ws: np.ndarray, flag: np.ndarray) -> List[Tuple[float, float]]:
    """Flagged samples as axis intervals (each covers its own share of its bin), merged where they touch."""
    out: List[Tuple[float, float]] = []
    order = np.argsort(xs, kind='stable')
    for i in order.tolist():
        if not flag[i]:
            continue
        a, b = float(xs[i] - ws[i] / 2), float(xs[i] + ws[i] / 2)
        if out and a <= out[-1][1] + 1e-9:
            out[-1] = (out[-1][0], round(max(out[-1][1], b), 4))
        else:
            out.append((round(a, 4), round(b, 4)))
    return out
