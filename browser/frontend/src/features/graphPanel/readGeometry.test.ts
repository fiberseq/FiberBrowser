/**
 * Gate E (DESIGN_GRAPH_PANEL.md §7, "read geometry/style"): molecules placed along their graph walk on real helper
 * topologies (the Gate C/D fixtures), with synthetic reads in each path's source coordinates, the shape
 * services/graph_panel/reads.py sends after composing them with the live-lift composer.
 */
import { describe, expect, it } from 'vitest';
import alu10k from './__fixtures__/gateC/alu_10k.topology.json';
import snpDel from './__fixtures__/gateC/snp_del.topology.json';
import inv40 from './__fixtures__/gateD/inv40.topology.json';
import invSplit from './__fixtures__/gateD/inv_split.topology.json';
import flip4k from './__fixtures__/gateD/flip_4k.topology.json';
import tandemDup from './__fixtures__/gateD/tandem_dup.topology.json';
import { buildLayout, type LayoutModel } from './layout';
import { buildScene, placementAt, targetAtX, type Scene } from './scene';
import { packMolecules, placeRead, placeReads, placementIndex, type CallPiece, type PlacedMolecule } from './readGeometry';
import { bandHeight, describeReadHit, drawReads, effectiveReadLayers, emptyDrawStats, READ_ROW_GAP } from './readCanvas';
import { useBrowserStore } from '../../stores/browserStore';
import { chromatinStyle } from './chromatinStyle';
import { DEFAULT_COLORMAP } from '../../types';
import type { GraphBinding, GraphRead, GraphReadLayer, GraphTopology, Span } from './types';

type Fixture = { topology: unknown; bindings: unknown };
const topo = (f: Fixture) => f.topology as GraphTopology;
const model = (f: Fixture) => buildLayout(topo(f), f.bindings as GraphBinding[]);
const COLORS = { target: '#334155', ref: '#334155', mat: '#c2410c', pat: '#1d4ed8' };
const scene = (m: LayoutModel, opts: { width?: number; reversed?: boolean; smallBp?: number; bands?: Record<string, number> } = {}) => buildScene(m, {
  width: opts.width ?? 1400, gutter: 52, rightPad: 6, rulerHeight: 30, laneHeight: 28, laneGap: 4, compression: 'log',
  reversed: opts.reversed ?? false, colors: COLORS, smallBp: opts.smallBp ?? 0, bands: opts.bands,
});

let serial = 0;
/** A read on path `b` over [s, e), its coverage cut by `holes` (CIGAR D), with insertions and layers. */
function read(b: string, s: number, e: number, o: { holes?: Span[]; skips?: boolean; ins?: [number, number][]; nuc?: [number, number][]; msp?: [number, number][];
  lq?: number[]; rq?: number[]; m6a?: number[]; sup?: boolean; q?: string; d?: string; lib?: number } = {}): GraphRead {
  const cov: [number, number, number, number][] = [];
  let at = s, m = 0;
  for (const h of [...(o.holes ?? [])].sort((x, y) => x.start - y.start)) {
    if (h.start > at) { cov.push([at, h.start, m, 1]); m += h.start - at; }
    at = h.end;
  }
  if (e > at) cov.push([at, e, m, 1]);
  const layer = (iv: [number, number][] | undefined, name: string, extra: Partial<GraphReadLayer> = {}): GraphReadLayer | undefined => iv && {
    iv: iv.map(([a, b2]) => [a, b2, b2 - a] as [number, number, number]), id: iv.map((_, i) => `${name}:${i}`), part: iv.map(([a]) => [a - s, 0] as [number, number]), ...extra };
  const q = o.q ?? `read${++serial}`;
  return { k: `${o.d ?? 'ds'}|${o.lib ?? 0}|${q}|r`, d: o.d ?? 'ds', lib: o.lib ?? 0, q, rec: 'r', b, c: b, st: '+', sup: Boolean(o.sup), s, e, cov,
    ins: (o.ins ?? []).map(([p, l]) => [p, l, 0] as [number, number, number]),
    dl: o.skips ? [] : (o.holes ?? []).map(h => [h.start, h.end - h.start] as [number, number]),
    nuc: layer(o.nuc, 'MA0', { nq: (o.nuc ?? []).map(() => 200), lq: o.lq, rq: o.rq }), msp: layer(o.msp, 'MA1'), m6a: o.m6a };
}

const place = (sc: Scene, f: Fixture, r: GraphRead) => placeRead(r, placementIndex(sc, topo(f)));
const slot = (sc: Scene, boundary: number) => sc.targetMap.find(t => t.kind === 'slot' && t.t0 === boundary)!;
const within = (x: number, a: number, b: number) => x >= Math.min(a, b) - 1e-6 && x <= Math.max(a, b) + 1e-6;
const occOf = (f: Fixture, path: string, pos: number) => topo(f).paths.find(p => p.binding === path)!.occurrences
  .find(o => o.path_span.start <= pos && pos < o.path_span.end)!;

describe('Gate E: the frame', () => {
  it('a target read base lands on the same target position the ruler gives there', () => {
    const m = model(alu10k), sc = scene(m);
    const r = place(sc, alu10k, read('target', 93_000, 96_000));
    expect(r.body.length).toBeGreaterThan(3);
    for (const b of r.body) {
      const x = (b.x0 + b.x1) / 2;
      const t = targetAtX(sc.targetMap, x)!;
      expect(Math.abs(t.pos - (b.s0 + b.s1) / 2)).toBeLessThanOrEqual(Math.max(2, (b.s1 - b.s0) / 2));
      // And the placement under x is this path's own occurrence at that offset.
      const hit = placementAt(sc, x, undefined, undefined, 'target')!;
      expect(hit.place.occ).toBe(b.occ);
    }
  });
});

describe('Gate E: source-only molecules', () => {
  it('a MAT read wholly inside the 2,353 bp AluY insertion has no target body and draws in the insertion slot', () => {
    const m = model(alu10k), sc = scene(m);
    const ins = slot(sc, 97_395);
    const r = place(sc, alu10k, read('mat', 95_000, 96_500, { nuc: [[95_100, 95_400], [95_600, 96_100]], msp: [[95_400, 95_600]] }));
    expect(r.body.length).toBeGreaterThan(0);
    for (const p of [...r.body, ...r.calls]) {
      expect(within(p.x0, ins.x0, ins.x1) && within(p.x1, ins.x0, ins.x1)).toBe(true);
      expect(targetAtX(sc.targetMap, (p.x0 + p.x1) / 2)).toMatchObject({ pos: 97_395, boundary: true });
    }
    // Every SNP inside the insertion is its own small bubble here (bubbles mode): the walk crosses their curve
    // zones as connector space; none of its bases is left undrawn.
    expect(r.unplacedBp).toBe(0);
    expect(r.connectors.every(c => c.kind === 'connector' && c.x1 - c.x0 < 20)).toBe(true);
    // The same in PAT's own allele of the slot (one slot, two alleles).
    const pat = place(sc, alu10k, read('pat', 96_000, 97_500));
    for (const p of pat.body) expect(within(p.x0, ins.x0, ins.x1) && within(p.x1, ins.x0, ins.x1)).toBe(true);
  });

  it('a target read across the insertion boundary walks over the slot as connector space, drawing nothing in it', () => {
    const m = model(alu10k), sc = scene(m);
    const ins = slot(sc, 97_395);
    const r = place(sc, alu10k, read('target', 97_000, 97_800, { nuc: [[97_200, 97_600]] }));
    for (const p of [...r.body, ...r.calls]) expect(p.x1 <= Math.min(ins.x0, ins.x1) + 1e-6 || p.x0 >= Math.max(ins.x0, ins.x1) - 1e-6).toBe(true);
    const across = r.connectors.find(c => c.x0 <= Math.min(ins.x0, ins.x1) + 1 && c.x1 >= Math.max(ins.x0, ins.x1) - 1);
    expect(across?.kind).toBe('connector');
    // The nucleosome over the boundary is one call in pieces on both sides of the slot, its whole size kept.
    const pieces = r.calls.filter(c => c.layer === 'nuc');
    expect(pieces.some(c => c.x1 <= Math.min(ins.x0, ins.x1)) && pieces.some(c => c.x0 >= Math.max(ins.x0, ins.x1))).toBe(true);
    expect(new Set(pieces.map(c => `${c.id}:${c.call[2]}`))).toEqual(new Set(['MA0:0:400']));
    expect(pieces.reduce((t, c) => t + c.s1 - c.s0, 0)).toBe(400);
  });

  it('a path deletion relative to the target is bypassed: the read connector spans the base allele, nothing drawn there', () => {
    const m = model(snpDel), sc = scene(m);
    const tpat = topo(snpDel).paths.find(p => p.binding === 'pat')!;
    // PAT's walk lacks 320 bp of ref: a read across it.
    const r = place(sc, snpDel, read('pat', 100, tpat.windows[0].end - 100, { nuc: [[150, tpat.windows[0].end - 150]] }));
    const gaps = r.connectors.filter(c => c.kind === 'connector' && c.x1 - c.x0 > 10);
    expect(gaps.length).toBeGreaterThan(0);
    for (const g of gaps) for (const p of [...r.body, ...r.calls]) expect(p.x1 <= g.x0 + 1e-6 || p.x0 >= g.x1 - 1e-6).toBe(true);
    // The long call stays one call: every piece carries its whole size and identity.
    expect(new Set(r.calls.map(c => `${c.id}:${c.call[2]}`)).size).toBe(1);
  });
});

describe('Gate E: CIGAR events inside a node', () => {
  const m = model(alu10k), sc = scene(m);
  const occ = occOf(alu10k, 'mat', 95_200);   // a 297 bp MAT insertion node [95,138, 95,435)
  it('M-D-M: one visit with a coverage hole; calls and MSPs are cut at the deleted bases, never filled', () => {
    const plain = place(sc, alu10k, read('mat', 95_000, 95_420, { nuc: [[95_150, 95_300]] }));
    const del = place(sc, alu10k, read('mat', 95_000, 95_420, { holes: [{ start: 95_200, end: 95_230 }], nuc: [[95_150, 95_300]], msp: [[95_300, 95_400]] }));
    expect(del.visits.map(v => v.occ)).toEqual(plain.visits.map(v => v.occ));   // no new occurrence at the hole
    const v = del.visits.find(x => x.occ === occ.id)!;
    expect(v.holes).toEqual([{ start: 95_200, end: 95_230, kind: 'D' }]);
    expect(v.slices.length).toBe(2);
    const nuc = del.calls.filter(c => c.layer === 'nuc');
    expect(nuc.map(c => [c.s0, c.s1])).toEqual([[95_150, 95_200], [95_230, 95_300]]);
    expect(nuc.every(c => c.call[2] === 150 && c.id === 'MA0:0')).toBe(true);
    // Nothing is drawn over the deleted bases; the hole has its own x range.
    const hole = del.holes.find(h => h.s0 === 95_200)!;
    for (const p of [...del.body, ...del.calls]) expect(p.x1 <= hole.x0 + 1e-6 || p.x0 >= hole.x1 - 1e-6).toBe(true);
  });

  it('M-I-M: an insertion has no path bp and makes no visit; its badge sits at its source boundary', () => {
    const plain = place(sc, alu10k, read('mat', 95_000, 95_420));
    const ins = place(sc, alu10k, read('mat', 95_000, 95_420, { ins: [[95_250, 40]] }));
    expect(ins.visits.map(v => [v.occ, v.slices])).toEqual(plain.visits.map(v => [v.occ, v.slices]));
    expect(ins.body).toEqual(plain.body);
    expect(ins.ins.length).toBe(1);
    const piece = ins.body.find(b => b.s0 < 95_250 && b.s1 > 95_250)!;
    const f = (95_250 - piece.s0) / (piece.s1 - piece.s0);
    expect(ins.ins[0].x).toBeCloseTo(piece.x0 + f * (piece.x1 - piece.x0), 6);
    expect(ins.visits.find(v => v.occ === occ.id)!.ins).toEqual([{ pos: 95_250, len: 40 }]);
  });
});

describe('Gate E: calls crossing visits', () => {
  it('keep whole size, identity, quality and their own edges, by screen side', () => {
    const m = model(alu10k), sc = scene(m);
    // A MAT nucleosome over several nodes of the insertion (node edges at 94,908/94,909/95,137/95,138).
    const r = place(sc, alu10k, read('mat', 94_700, 95_300, { nuc: [[94_850, 95_200]], lq: [40], rq: [220] }));
    const pieces = r.calls.filter(c => c.layer === 'nuc');
    expect(pieces.length).toBeGreaterThanOrEqual(3);
    expect(pieces.every(c => c.call[0] === 94_850 && c.call[1] === 95_200 && c.call[2] === 350 && c.id === 'MA0:0'
      && c.part?.[0] === 150 && c.qualities.nq === 200 && c.qualities.lq === 40 && c.qualities.rq === 220)).toBe(true);
    // Only the piece holding the call's start carries the left edge quality, only the end piece the right one.
    const byX = [...pieces].sort((a, b) => a.x0 - b.x0);
    expect(byX[0].edgeL).toBe(40);
    expect(byX[byX.length - 1].edgeR).toBe(220);
    expect(byX.slice(1).every(c => c.edgeL === undefined) && byX.slice(0, -1).every(c => c.edgeR === undefined)).toBe(true);
  });

  it('under panel reversal the same call keeps everything; only the screen sides of its edge qualities swap', () => {
    const m = model(alu10k);
    const fwd = place(scene(m), alu10k, read('mat', 94_700, 95_300, { q: 'x', nuc: [[94_850, 95_200]], lq: [40], rq: [220] }));
    const rev = place(scene(m, { reversed: true }), alu10k, read('mat', 94_700, 95_300, { q: 'x', nuc: [[94_850, 95_200]], lq: [40], rq: [220] }));
    const key = (c: CallPiece) => [c.s0, c.s1, c.id, c.call.join(), JSON.stringify(c.qualities), c.part?.join()].join('|');
    expect(rev.calls.map(key).sort()).toEqual(fwd.calls.map(key).sort());
    const startPiece = rev.calls.find(c => c.s0 === 94_850)!, endPiece = rev.calls.find(c => c.s1 === 95_200)!;
    expect([startPiece.dir, startPiece.edgeR, startPiece.edgeL]).toEqual([-1, 40, undefined]);
    expect([endPiece.edgeL, endPiece.edgeR]).toEqual([220, undefined]);
    expect(startPiece.x0).toBeGreaterThan(endPiece.x0);   // the call's start is on the right now
  });

  it('inside a 40 bp inversion (no minus piece) the allele runs right to left: edges swap there, not in identity', () => {
    const m = model(inv40), sc = scene(m);
    // MAT walks node 2 (900-940) reversed.
    const r = place(sc, inv40, read('mat', 850, 1000, { nuc: [[905, 935]], lq: [10], rq: [250] }));
    const c = r.calls.find(x => x.layer === 'nuc')!;
    expect(r.calls.filter(x => x.layer === 'nuc').length).toBe(1);
    expect([c.dir, c.edgeL, c.edgeR, c.call[2], c.id]).toEqual([-1, 250, 10, 30, 'MA0:0']);
    // The flanks stay left to right.
    expect(r.body.filter(b => b.s1 <= 900 || b.s0 >= 940).every(b => b.dir === 1)).toBe(true);
  });

  it('a split-chain inversion and a whole-minus path place calls with their source order reversed on screen', () => {
    for (const [f, path] of [[invSplit, 'mat'], [flip4k, 'mat']] as const) {
      const sc = scene(model(f));
      const occs = topo(f).paths.find(p => p.binding === path)!.occurrences;
      const backward = sc.occurrences.filter(o => o.path === path && o.dir === -1);
      expect(backward.length).toBeGreaterThan(0);
      const o = backward.sort((a, b) => (b.end - b.start) - (a.end - a.start))[0];
      const occ = occs.find(x => x.id === o.occ)!;
      const a = occ.path_span.start + o.start, b = occ.path_span.start + o.end;
      const r = place(sc, f, read(path, a, b, { nuc: [[a + 2, b - 2]], lq: [11], rq: [99] }));
      const pieces = r.calls.filter(c => c.layer === 'nuc' && c.occ === o.occ);
      expect(pieces.length).toBe(1);
      expect([pieces[0].edgeL, pieces[0].edgeR]).toEqual([99, 11]);
    }
  });
});

describe('Gate E: repeats, summaries and packing', () => {
  it('a read through a tandem duplication visits each copy once, in its own occurrence', () => {
    const m = model(tandemDup), sc = scene(m);
    const path = topo(tandemDup).paths.find(p => p.binding === 'pat')!;
    const r = place(sc, tandemDup, read('pat', path.windows[0].start, path.windows[0].end));
    const nodes = r.visits.map(v => v.node);
    expect(new Set(r.visits.map(v => v.occ)).size).toBe(r.visits.length);
    expect(nodes.length).toBeGreaterThan(new Set(nodes).size);   // the repeated node, visited as distinct occurrences
  });

  it('clustered geometry places nothing: the walk crosses it as an unplaced connector and the bp are counted', () => {
    const m = model(alu10k);
    const sc = scene(m, { width: 520 });
    expect(sc.clusters).toBeGreaterThan(0);
    const r = place(sc, alu10k, read('target', 92_500, 102_300));
    expect(r.unplacedBp).toBeGreaterThan(0);
    expect(r.connectors.some(c => c.kind === 'unplaced')).toBe(true);
  });

  it('packs molecules in rows per lane by their x extent, reporting rows over the limit', () => {
    const m = model(alu10k), sc = scene(m);
    const reads = [read('mat', 93_000, 95_000), read('mat', 94_000, 96_000), read('mat', 99_500, 100_000), read('pat', 92_000, 93_000), read('mat', 93_500, 94_500)];
    const { molecules } = placeReads(reads, placementIndex(sc, topo(alu10k)));
    const lanes = packMolecules(molecules, 2);
    expect(lanes.get('mat')!.rows.map(r => r.length)).toEqual([2, 1]);
    expect(lanes.get('mat')!.hidden).toBe(1);
    expect(lanes.get('pat')!.rows.length).toBe(1);
    // Records of a QNAME in two libraries stay apart.
    const twin = placeReads([read('mat', 93_000, 94_000, { q: 'same', lib: 0 }), read('mat', 93_000, 94_000, { q: 'same', lib: 1 })], placementIndex(sc, topo(alu10k)));
    expect(new Set(twin.molecules.map(x => x.read.k)).size).toBe(2);
  });

  it('draws read bands under the lanes, a call per piece, and describes the call under the pointer', () => {
    const m = model(alu10k);
    const base = scene(m);
    const molecule = place(base, alu10k, read('mat', 94_700, 95_300, { nuc: [[94_850, 95_200]], m6a: [94_860, 95_250], sup: true }));
    const lanes = packMolecules([molecule], 10);
    const sc = scene(m, { bands: { mat: bandHeight(lanes.get('mat')) } });
    const row = sc.rows.find(r => r.key === 'mat')!;
    expect(row.bandHeight).toBeGreaterThan(0);
    expect(row.bandTop).toBeGreaterThanOrEqual(Math.max(...sc.rows.map(r => r.top + r.height)));
    const calls: unknown[][] = [];
    const ctx = new Proxy({}, { get: (_t, k) => (k === 'fillRect' ? (...a: unknown[]) => calls.push(a) : k === 'setLineDash' || typeof k === 'symbol' ? () => {} : () => {}),
      set: () => true }) as unknown as CanvasRenderingContext2D;
    const hits = drawReads(ctx, sc, lanes, chromatinStyle(DEFAULT_COLORMAP), { nuc: true, tf: true, msp: true, m6a: true }, COLORS);
    expect(hits.length).toBe(1);
    expect(hits[0].y0).toBeGreaterThanOrEqual(row.bandTop - READ_ROW_GAP);
    const nuc = molecule.calls.find(c => c.layer === 'nuc')!;
    const text = describeReadHit(hits[0], (nuc.x0 + nuc.x1) / 2, () => 'Demo', () => 'MAT');
    expect(text).toContain('nucleosome 350 bp at 94,850-95,200 (MA0:0)');
    expect(text).toContain('supplementary');
    expect(text).toMatch(/drawn in \d+ pieces/);
  });
});

describe('graph read bands follow the toolbar Layers row', () => {
  const ctx = () => new Proxy({}, { get: () => () => {}, set: () => true }) as unknown as CanvasRenderingContext2D;
  const drawWith = (layers: ReturnType<typeof effectiveReadLayers>) => {
    const m = model(alu10k);
    const molecule = place(scene(m), alu10k, read('mat', 94_700, 95_300, { nuc: [[94_850, 95_200]], m6a: [94_860, 94_900, 95_250] }));
    const lanes = packMolecules([molecule], 10);
    const sc = scene(m, { bands: { mat: bandHeight(lanes.get('mat')) } });
    const stats = emptyDrawStats();
    const hits = drawReads(ctx(), sc, lanes, chromatinStyle(DEFAULT_COLORMAP), layers, COLORS, undefined, undefined, 1, stats);
    return { stats, hits, molecule };
  };

  it('reads the store toggles the way the read track does (aliases included)', () => {
    expect(effectiveReadLayers({ nuc: true, footprint: true, tf: true, fire: false, msp: false, m6a: false, mod: false }))
      .toEqual({ nuc: true, tf: true, msp: false, m6a: false });
    expect(effectiveReadLayers({ m6a: false, mod: true }).m6a).toBe(true);
    expect(effectiveReadLayers({ fire: false, msp: true }).msp).toBe(true);
    expect(effectiveReadLayers({ fire: true }).msp).toBe(true);
    expect(effectiveReadLayers({ nuc: true, footprint: false }).nuc).toBe(false);
    expect(effectiveReadLayers({}).nuc).toBe(true);   // nuc defaults on, as on the read track
    expect(effectiveReadLayers({}).tf).toBe(false);
    // The panel's own menu can only hide more, never show a layer the toolbar has off.
    expect(effectiveReadLayers({ m6a: false }, { m6a: true }).m6a).toBe(false);
    expect(effectiveReadLayers({ m6a: true }, { m6a: false }).m6a).toBe(false);
    expect(effectiveReadLayers({ m6a: true }, {}).m6a).toBe(true);
  });

  it('the store default (m6A and Accessibility off) draws no m6A and no MSP; turning m6A on draws its ticks', () => {
    const initial = useBrowserStore.getState().enabledModTypes as Record<string, boolean>;
    const off = drawWith(effectiveReadLayers(initial));
    expect(off.stats.m6a).toBe(0);
    expect(off.stats.m6aDensity).toBe(0);
    expect(off.stats.msp).toBe(0);
    expect(off.stats.nuc).toBeGreaterThan(0);
    const on = drawWith(effectiveReadLayers({ ...initial, m6a: true }));
    expect(on.stats.m6a).toBe(3);
    const noNuc = drawWith(effectiveReadLayers({ ...initial, nuc: false }));
    expect(noNuc.stats.nuc).toBe(0);
    // A hidden layer is not named under the pointer either.
    const nuc = noNuc.molecule.calls.find(c => c.layer === 'nuc')!;
    expect(describeReadHit(noNuc.hits[0], (nuc.x0 + nuc.x1) / 2, () => 'Demo', () => 'MAT', effectiveReadLayers({ nuc: false })))
      .not.toContain('nucleosome');
  });
});

describe('Gate E: chromatin styles', () => {
  it('styles a call by its whole size: a 150 bp nucleosome sliced to 20 bp is still a nucleosome', () => {
    const style = chromatinStyle(DEFAULT_COLORMAP);
    expect(style.call('nuc', 150, {})!.color.toLowerCase()).toBe('#33a040');
    expect(style.call('nuc', 40, {})!.color).toBe('#cccccc');
    // FIRE: the gated accessibility rule paints calls with aq >= 230; others take the FIRE colour by quality.
    const fire = style.call('msp', 120, { aq: 240 })!;
    const weak = style.call('msp', 120, { aq: 50 })!;
    expect(fire.opacity).toBeGreaterThan(weak.opacity);
    expect(style.m6a).toBe('#6b21a8');
  });
});

describe('Gate E: review round 1', () => {
  const m = model(alu10k), sc = scene(m);
  it('a hole with no D event is a skip (N), drawn and described apart from a deletion', () => {
    const r = place(sc, alu10k, read('mat', 95_000, 95_420, { holes: [{ start: 95_200, end: 95_260 }], skips: true }));
    expect(r.visits.flatMap(v => v.holes)).toEqual([{ start: 95_200, end: 95_260, kind: 'N' }]);
    expect(r.holes.every(h => h.kind === 'N')).toBe(true);
  });

  it('a coverage hole that is part deletion, part skip splits into a D and an N part', () => {
    const r = place(sc, alu10k, { ...read('mat', 95_000, 95_420, { holes: [{ start: 95_200, end: 95_250 }] }), dl: [[95_200, 10]] });
    expect(r.visits.flatMap(v => v.holes)).toEqual([{ start: 95_200, end: 95_210, kind: 'D' }, { start: 95_210, end: 95_250, kind: 'N' }]);
  });

  it('pieces continuing each other on one tube merge; a call keeps its own edges on the merged piece', () => {
    const marks = scene(m, { smallBp: 50 });   // the AluY small differences as marks: long contiguous tubes
    const r = place(marks, alu10k, read('target', 93_000, 96_000, { nuc: [[93_100, 95_900]], lq: [7], rq: [9] }));
    const raw = topo(alu10k).paths.find(p => p.binding === 'target')!.occurrences.filter(o => o.path_span.end > 93_100 && o.path_span.start < 95_900).length;
    const nuc = r.calls.filter(c => c.layer === 'nuc');
    expect(nuc.length).toBeLessThan(raw);
    const byX = [...nuc].sort((a, b) => a.x0 - b.x0);
    expect(byX[0].edgeL).toBe(7);
    expect(byX[byX.length - 1].edgeR).toBe(9);
    expect(nuc.reduce((t, c) => t + c.s1 - c.s0, 0)).toBe(2_800);
  });

  it('unplaced bp count prefixes, suffixes and wholly undrawn reads inside the drawn range, not bp beyond it', () => {
    const narrow = scene(m, { width: 520 });
    const idx = placementIndex(narrow, topo(alu10k));
    const [w] = idx.domain.get('target')!;
    const whole = placeReads([read('target', w.start, w.end)], idx);
    expect(whole.unplacedBp).toBeGreaterThan(0);   // clusters inside the walk
    // Everything drawn in the wide scene: nothing unplaced, the walk's ends included.
    const all = placeRead(read('target', w.start, w.end), placementIndex(sc, topo(alu10k)));
    expect(all.unplacedBp).toBe(0);
    const outside = placeRead(read('target', w.end + 100, w.end + 300), idx);
    expect(outside.unplacedBp).toBe(0);
  });

  it('past the primitive budget m6A becomes density, then trailing molecules keep their bodies only', () => {
    const ticks = Array.from({ length: 2_900 }, (_, i) => 93_050 + i);   // one per base: many per pixel
    const reads = Array.from({ length: 4 }, (_, i) => read('target', 93_000, 96_000, { q: `m${i}`, nuc: [[93_100, 93_400], [93_500, 93_800]], m6a: ticks }));
    const idx = placementIndex(sc, topo(alu10k));
    const plenty = placeReads(reads, idx);
    expect(plenty.m6aAsDensity).toBe(false);
    const dense = placeReads(reads, idx, 4 * 2_900, 10);   // under what the reads carry: m6A goes to density first
    expect(dense.m6aAsDensity).toBe(true);
    expect(dense.molecules.every(x => x.m6a.length === 0 && x.density.length > 0)).toBe(true);
    expect(dense.primitives).toBeLessThan(plenty.primitives / 2);
    const tight = placeReads(reads, idx, 40, 10);
    expect(tight.marksHidden).toBeGreaterThan(0);
    expect(tight.primitives).toBeLessThanOrEqual(40);
    expect(tight.molecules.every(x => x.body.length > 0)).toBe(true);
  });

  it('quality-gated nucleosome rules match on the call\'s qualities', () => {
    const cm = { ...DEFAULT_COLORMAP, rules: [{ id: 'q', name: 'Q', color: '#ff0000', opacity: 1, sizeMin: 1, sizeMax: null, targetLayers: [],
      conditions: [], qualityGates: [{ qualityName: 'nq', minValue: 200 }], enabled: true }, ...DEFAULT_COLORMAP.rules] } as typeof DEFAULT_COLORMAP;
    const style = chromatinStyle(cm);
    expect(style.call('nuc', 150, { nq: 250 })!.color.toLowerCase()).toBe('#ff0000');
    expect(style.call('nuc', 150, { nq: 100 })!.color.toLowerCase()).toBe('#33a040');
  });

  it('calls are drawn inside a clip of the molecule body (edge bands never reach connector space)', () => {
    const molecule = place(sc, alu10k, read('target', 97_000, 97_800, { nuc: [[97_200, 97_390]], lq: [0], rq: [0] }));
    const lanes = packMolecules([molecule], 10);
    const banded = scene(m, { bands: { target: bandHeight(lanes.get('target')) } });
    const rects: number[][] = [];
    let clips = 0;
    const ctx = new Proxy({}, { get: (_t, k) => (k === 'rect' ? (...a: number[]) => rects.push(a) : k === 'clip' ? () => { clips++; } : () => {}), set: () => true }) as unknown as CanvasRenderingContext2D;
    const soft = chromatinStyle({ ...DEFAULT_COLORMAP, edgeAmbiguity: { mode: 'soft', applyNuc: true, applyTf: true, maxGapBp: 30 } } as typeof DEFAULT_COLORMAP);
    drawReads(ctx, banded, lanes, soft, { nuc: true, tf: true, msp: true, m6a: true }, COLORS);
    expect(clips).toBe(1);
    const ins = slot(banded, 97_395);
    // The clip rectangles are the body pieces: none inside the insertion slot.
    expect(rects.every(([x, , w]) => x + w <= Math.min(ins.x0, ins.x1) + 1e-6 || x >= Math.max(ins.x0, ins.x1) - 1e-6)).toBe(true);
  });
});

describe('Gate E: review round 3', () => {
  const m = model(alu10k), sc = scene(m);
  it('an occurrence wholly inside a hole keeps the hole and its kind', () => {
    // MAT's 1 bp SNP node at 94,908 and its neighbours: a deletion over [94,905, 94,912) covers it whole.
    const r = place(sc, alu10k, { ...read('mat', 94_800, 95_000, { holes: [{ start: 94_905, end: 94_912 }] }) });
    const v = r.visits.find(x => x.span.start === 94_908 && x.span.end === 94_909)!;
    expect(v.slices).toEqual([]);
    expect(v.holes).toEqual([{ start: 94_908, end: 94_909, kind: 'D' }]);
  });

  it('once the mark budget is spent no later molecule places marks; overflow from amplified pieces retries with density', () => {
    const ticks = Array.from({ length: 2_900 }, (_, i) => 93_050 + i);
    const reads = Array.from({ length: 6 }, (_, i) => read('target', 93_000, 96_000, { q: `m${i}`, nuc: [[93_100, 93_400]], m6a: ticks }));
    const idx = placementIndex(sc, topo(alu10k));
    const spent = placeReads(reads, idx, 10, 10);
    expect(spent.marksHidden).toBe(6);
    expect(spent.molecules.every(x => x.calls.length === 0 && x.m6a.length === 0)).toBe(true);
    // Budget above what the reads carry, below what ticks place: the density pass keeps every molecule's marks.
    const carried = 6 * (1 + 2_900);
    const fits = placeReads(reads, idx, carried + 10, 10);
    expect(fits.marksHidden).toBe(0);
  });
});

describe('Gate E: agy review', () => {
  it('a drawn hole joins its slices without a connector; connectors span only the screen gap', () => {
    const m = model(alu10k), sc = scene(m, { width: 6000 });   // wide: a 30 bp hole is several pixels
    const r = place(sc, alu10k, read('mat', 95_000, 95_420, { holes: [{ start: 95_200, end: 95_230 }] }));
    const hole = r.holes.find(h => h.s0 === 95_200)!;
    expect(hole.x1 - hole.x0).toBeGreaterThan(1.5);
    expect(r.connectors.some(c => c.x0 < hole.x1 && c.x1 > hole.x0)).toBe(false);
    // Into an inverted allele (drawn right to left): the connector stops at the allele's body.
    const iv = model(inv40), isc = scene(iv);
    const ir = place(isc, inv40, read('mat', 850, 1000));
    for (const c of ir.connectors) for (const b of ir.body) expect(c.x1 <= b.x0 + 1e-6 || c.x0 >= b.x1 - 1e-6).toBe(true);
  });
});

// Keep the type import used (PlacedMolecule is the shape drawReads takes).
export type { PlacedMolecule };
