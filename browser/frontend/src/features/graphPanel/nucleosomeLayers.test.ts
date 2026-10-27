/**
 * Nucleosome layers in graph mode (nucleosome panel DESIGN §7.1 item 2, §7.2): class bytes on nuc/tf call pieces
 * recolour them through the colormap's class rules while size classes are on, and the segment lane is one
 * primitive per piece, cut at visits and coverage holes like the calls.
 */
import { describe, expect, it } from 'vitest';
import alu10k from './__fixtures__/gateC/alu_10k.topology.json';
import { buildLayout } from './layout';
import { buildScene, type Scene } from './scene';
import { packMolecules, placeRead, placeReads, placementIndex } from './readGeometry';
import { bandHeight, callPieceStyle, describeReadHit, drawReads, effectiveReadLayers, emptyDrawStats, READ_ROW_GAP, READ_ROW_HEIGHT } from './readCanvas';
import { chromatinStyle, graphNucMark } from './chromatinStyle';
import { nucSegLaneGeometry, nucSizeClassRules, NUC_SIZE_CLASS_COLORS } from '../../utils/nucLayers';
import { DEFAULT_COLORMAP, type ColorRule } from '../../types';
import type { GraphBinding, GraphRead, GraphTopology, Span } from './types';

const topology = alu10k.topology as unknown as GraphTopology;
const model = buildLayout(topology, alu10k.bindings as unknown as GraphBinding[]);
const COLORS = { target: '#334155', ref: '#334155', mat: '#c2410c', pat: '#1d4ed8' };
const scene = (bands?: Record<string, number>) => buildScene(model, {
  width: 1400, gutter: 52, rightPad: 6, rulerHeight: 30, laneHeight: 28, laneGap: 4, compression: 'log',
  reversed: false, colors: COLORS, smallBp: 0, bands,
});
const NUC_DEFAULT = '#33a040';
const MONO = NUC_SIZE_CLASS_COLORS[2].toLowerCase();
const SHORT = NUC_SIZE_CLASS_COLORS[1].toLowerCase();
const classColormap = { ...DEFAULT_COLORMAP, rules: [...nucSizeClassRules(), ...DEFAULT_COLORMAP.rules] } as typeof DEFAULT_COLORMAP;

let serial = 0;
interface ReadOpts {
  nuc?: [number, number][]; cls?: (number | null)[]; zb?: (number | null)[]; tf?: [number, number][]; tfCls?: (number | null)[];
  nseg?: { iv: [number, number][]; code: number[]; p?: number[]; q3?: number[] }; holes?: Span[]; q?: string;
}
/** A read on path `b` over [s, e) with nuc/tf calls, their class bytes and a segment lane (absolute source coordinates). */
function read(b: string, s: number, e: number, o: ReadOpts = {}): GraphRead {
  const cov: [number, number, number, number][] = [];
  let at = s, m = 0;
  for (const h of [...(o.holes ?? [])].sort((x, y) => x.start - y.start)) {
    if (h.start > at) { cov.push([at, h.start, m, 1]); m += h.start - at; }
    at = h.end;
  }
  if (e > at) cov.push([at, e, m, 1]);
  const layer = (iv: [number, number][], name: string, cls?: (number | null)[], zb?: (number | null)[]) => ({
    iv: iv.map(([a, c]) => [a, c, c - a] as [number, number, number]), id: iv.map((_, i) => `${name}:${i}`),
    part: iv.map(([a]) => [a - s, 0] as [number, number]), ...(cls ? { cls, zb: zb ?? cls.map(() => 128) } : {}) });
  const q = o.q ?? `nucread${++serial}`;
  return {
    k: `ds|0|${q}|r`, d: 'ds', lib: 0, q, rec: 'r', b, c: b, st: '+', sup: false, s, e, cov, ins: [],
    dl: (o.holes ?? []).map(h => [h.start, h.end - h.start] as [number, number]),
    ...(o.nuc ? { nuc: layer(o.nuc, 'MA0', o.cls, o.zb) } : {}),
    ...(o.tf ? { tf: layer(o.tf, 'MA2', o.tfCls) } : {}),
    ...(o.nseg ? { nseg: { iv: o.nseg.iv.map(([a, c]) => [a, c, c - a] as [number, number, number]), code: o.nseg.code,
      ...(o.nseg.p ? { p: o.nseg.p } : {}), ...(o.nseg.q3 ? { q3: o.nseg.q3 } : {}) } } : {}),
  };
}

/** A context that records each fillRect with the fill colour it was drawn in. */
function recordingCtx() {
  const fills: { color: string; x: number; y: number; w: number; h: number }[] = [];
  let fillStyle = '';
  const ctx = new Proxy({}, {
    get: (_t, k) => (k === 'fillRect' ? (x: number, y: number, w: number, h: number) => fills.push({ color: String(fillStyle).toLowerCase(), x, y, w, h })
      : k === 'fillStyle' ? fillStyle : () => {}),
    set: (_t, k, v) => { if (k === 'fillStyle') fillStyle = v; return true; },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, fills };
}

/** Place one read, pack it and draw its band with `layers`. */
function drawOne(r: GraphRead, layers: ReturnType<typeof effectiveReadLayers>, colormap = classColormap) {
  const base = scene();
  const molecule = placeRead(r, placementIndex(base, topology));
  const lanes = packMolecules([molecule], 10);
  const banded: Scene = scene({ [r.b]: bandHeight(lanes.get(r.b)) });
  const { ctx, fills } = recordingCtx();
  const stats = emptyDrawStats();
  const hits = drawReads(ctx, banded, lanes, chromatinStyle(colormap), layers, COLORS, READ_ROW_HEIGHT, READ_ROW_GAP, 1, stats);
  return { molecule, hits, fills, stats };
}

describe('graph mode: nucleosome class colouring', () => {
  it('class rules match a call by its class bytes; without a mark they match nothing', () => {
    const style = chromatinStyle(classColormap);
    expect(style.call('nuc', 150, {}, graphNucMark(2, 128))!.color.toLowerCase()).toBe(MONO);
    expect(style.call('nuc', 150, {}, graphNucMark(1, 100))!.color.toLowerCase()).toBe(SHORT);
    // No mark (or a call with a null class byte): the class rules are skipped, the size rule paints it.
    expect(style.call('nuc', 150, {}, null)!.color.toLowerCase()).toBe(NUC_DEFAULT);
    expect(style.call('nuc', 150, {})!.color.toLowerCase()).toBe(NUC_DEFAULT);
    expect(graphNucMark(null, 128)).toBeNull();
    expect(graphNucMark(undefined, undefined)).toBeNull();
    expect(graphNucMark(2, null)!.z).toBe(255);
  });

  it('rules without nucleosome conditions are unchanged by class bytes', () => {
    const style = chromatinStyle(DEFAULT_COLORMAP);
    for (const size of [40, 90, 150, 400]) {
      const plain = style.call('nuc', size, {});
      expect(style.call('nuc', size, {}, graphNucMark(2, 128))).toEqual(plain);
      expect(style.call('nuc', size, {}, graphNucMark(16 + 1, 255))).toEqual(plain);
    }
    expect(style.call('tf', 30, { tq: 200 }, graphNucMark(16 + 1, 128))).toEqual(style.call('tf', 30, { tq: 200 }));
  });

  it('z and TF conditions: a missing z never matches a z rule; the TF bit selects TF calls', () => {
    const zRule: ColorRule = { id: 'z', name: 'z', color: '#ff0000', opacity: 1, sizeMin: 1, sizeMax: null, targetLayers: [], conditions: [],
      zMin: -1, zMax: 1, enabled: true };
    const tfRule: ColorRule = { id: 't', name: 't', color: '#0000ff', opacity: 1, sizeMin: 1, sizeMax: null, targetLayers: ['tf'], conditions: [],
      nucTf: true, enabled: true };
    const style = chromatinStyle({ ...DEFAULT_COLORMAP, rules: [zRule, tfRule, ...DEFAULT_COLORMAP.rules] } as typeof DEFAULT_COLORMAP);
    expect(style.call('nuc', 150, {}, graphNucMark(2, 128))!.color.toLowerCase()).toBe('#ff0000');   // z 0
    expect(style.call('nuc', 150, {}, graphNucMark(2, 255))!.color.toLowerCase()).toBe(NUC_DEFAULT);   // z missing
    expect(style.call('nuc', 150, {}, graphNucMark(2, 188))!.color.toLowerCase()).toBe(NUC_DEFAULT);   // z 3
    expect(style.call('tf', 30, { tq: 255 }, graphNucMark(16 + 1, 255))!.color.toLowerCase()).toBe('#0000ff');
    expect(style.call('tf', 30, { tq: 255 }, graphNucMark(1, 255))!.color.toLowerCase()).not.toBe('#0000ff');
  });

  it('pieces carry their call\'s bytes; the size-classes toggle decides whether class rules see them', () => {
    const r = read('target', 93_000, 94_000, { nuc: [[93_100, 93_250], [93_400, 93_550]], cls: [2, null] });
    const m = placeRead(r, placementIndex(scene(), topology));
    const [withCls, noCls] = [0, 1].map(i => m.calls.filter(c => c.layer === 'nuc' && c.index === i));
    expect(withCls.length).toBeGreaterThan(0);
    expect(withCls.every(c => c.cls === 2 && c.zb === 128)).toBe(true);
    expect(noCls.every(c => c.cls === null)).toBe(true);
    const style = chromatinStyle(classColormap);
    expect(callPieceStyle(style, withCls[0], true)!.color.toLowerCase()).toBe(MONO);
    expect(callPieceStyle(style, withCls[0], false)!.color.toLowerCase()).toBe(NUC_DEFAULT);
    // A null class byte never matches a class rule, toggle on or off.
    expect(callPieceStyle(style, noCls[0], true)!.color.toLowerCase()).toBe(NUC_DEFAULT);
    expect(callPieceStyle(style, noCls[0], false)!.color.toLowerCase()).toBe(NUC_DEFAULT);
    // A layer without class bytes: pieces have none.
    const bare = placeRead(read('target', 93_000, 94_000, { nuc: [[93_100, 93_250]] }), placementIndex(scene(), topology));
    expect(bare.calls.every(c => !('cls' in c))).toBe(true);
  });

  it('drawn: the Nucleosomes size-classes layer on paints the class colour, off the size rule\'s', () => {
    const r = read('target', 93_000, 94_000, { nuc: [[93_100, 93_250]], cls: [2] });
    const on = drawOne(r, effectiveReadLayers({ nucsz: true }));
    const off = drawOne(r, effectiveReadLayers({ nucsz: false }));
    expect(on.stats.nuc).toBeGreaterThan(0);
    expect(on.fills.some(f => f.color === MONO)).toBe(true);
    expect(off.fills.some(f => f.color === MONO)).toBe(false);
    expect(off.fills.some(f => f.color === NUC_DEFAULT)).toBe(true);
  });
});

describe('graph mode: segment lane', () => {
  const idx = () => placementIndex(scene(), topology);

  it('is cut like the call pieces: at a visit edge (the insertion slot) and at a coverage hole', () => {
    // A target read over the AluY insertion boundary at 97,395 (the slot is MAT's: connector space on the target).
    const span: [number, number] = [97_100, 97_700];
    const m = placeRead(read('target', 97_000, 97_800, { nuc: [span], nseg: { iv: [span], code: [1], p: [217], q3: [87] } }), idx());
    const seg = m.seg!;
    const calls = m.calls.filter(c => c.layer === 'nuc');
    expect(seg.length).toBeGreaterThan(1);
    expect(seg.map(p => [p.s0, p.s1, p.x0, p.x1])).toEqual(calls.map(c => [c.s0, c.s1, c.x0, c.x1]));
    expect(seg.some(p => p.s1 === 97_395) && seg.some(p => p.s0 === 97_395)).toBe(true);
    expect(seg.reduce((t, p) => t + p.s1 - p.s0, 0)).toBe(600);
    // Every piece keeps its whole row and bytes.
    expect(seg.every(p => p.row[0] === 97_100 && p.row[1] === 97_700 && p.code === 1 && p.value === 217 && p.extra === 87)).toBe(true);
    // A CIGAR deletion inside a node cuts the lane as it cuts the call.
    const del = placeRead(read('mat', 95_000, 95_420, { holes: [{ start: 95_200, end: 95_230 }], nuc: [[95_150, 95_300]],
      nseg: { iv: [[95_150, 95_300]], code: [2] } }), idx());
    expect(del.seg!.map(p => [p.s0, p.s1])).toEqual([[95_150, 95_200], [95_230, 95_300]]);
    expect(del.seg!.map(p => [p.s0, p.s1])).toEqual(del.calls.filter(c => c.layer === 'nuc').map(c => [c.s0, c.s1]));
  });

  it('rows without a code are not placed; a read without a lane has none', () => {
    const m = placeRead(read('target', 93_000, 94_000, { nseg: { iv: [[93_100, 93_300], [93_300, 93_600]], code: [0, 3] } }), idx());
    expect(m.seg!.every(p => p.code === 3 && p.index === 1)).toBe(true);
    expect(placeRead(read('target', 93_000, 94_000), idx()).seg).toBeUndefined();
    expect(placeRead(read('target', 93_000, 94_000, { nseg: { iv: [[93_100, 93_300]], code: [1] } }), idx(), 'target', { calls: false }).seg).toBeUndefined();
  });

  it('is drawn at the bottom of the row while the segment layer is on, one row per piece', () => {
    const r = read('target', 93_000, 94_000, { nuc: [[93_100, 93_250]], nseg: { iv: [[93_050, 93_500], [93_500, 93_900], [93_600, 93_700]], code: [1, 2, 17], p: [200, 180, 51] } });
    const on = drawOne(r, effectiveReadLayers({ nucseg: true }));
    const pieces = on.molecule.seg!;
    expect(on.stats.nucSeg).toBe(pieces.length);
    const y = on.hits[0].y0 + READ_ROW_GAP / 2;
    const lane = nucSegLaneGeometry(y, READ_ROW_HEIGHT)!;
    const laneFills = on.fills.filter(f => f.y >= lane.y - 1e-9 && f.y + f.h <= y + READ_ROW_HEIGHT + 1e-9 && f.h <= lane.h);
    // Regular and disordered in the lane's colours, inside the read's extent; the missing nucleosome leaves a gap.
    expect(laneFills.some(f => f.color === '#15803d')).toBe(true);
    expect(laneFills.some(f => f.color === '#ea580c')).toBe(true);
    for (const f of laneFills) expect(f.x >= on.molecule.extent![0] - 1 && f.x + f.w <= on.molecule.extent![1] + 1).toBe(true);
    const off = drawOne(r, effectiveReadLayers({ nucseg: false }));
    expect(off.stats.nucSeg ?? 0).toBe(0);
    expect(off.fills.some(f => f.color === '#15803d')).toBe(false);
  });
});

describe('graph mode: primitive budget with the segment lane', () => {
  const idx = () => placementIndex(scene(), topology);
  const reads = (n: number, lane: boolean) => Array.from({ length: n }, (_, i) => read('target', 93_000, 94_000, {
    q: `budget${lane ? 'L' : 'N'}${i}`, nuc: [[93_100, 93_250], [93_400, 93_550]],
    ...(lane ? { nseg: { iv: [[93_050, 93_500], [93_500, 93_900]], code: [1, 2] } } : {}) }));

  it('lane pieces count against the budget like call pieces', () => {
    const calls = placeReads(reads(3, false), idx());
    const withLane = placeReads(reads(3, true), idx());
    const segPieces = withLane.molecules.reduce((t, m) => t + (m.seg?.length ?? 0), 0);
    const callPieces = withLane.molecules.reduce((t, m) => t + m.calls.length, 0);
    expect(segPieces).toBeGreaterThanOrEqual(6);
    expect(withLane.primitives).toBe(callPieces + segPieces);
    expect(withLane.primitives).toBe(calls.primitives + segPieces);
    expect(withLane.segHidden).toBe(0);
  });

  it('past the budget trailing molecules lose calls and lane together (bodies stay), and the hover says so', () => {
    const all = placeReads(reads(3, true), idx());
    const perMolecule = all.primitives / 3;
    // Room for the calls of all three, not for their lanes: the lane is counted, so the third molecule's marks go.
    const callsOnly = placeReads(reads(3, false), idx()).primitives;
    const tight = placeReads(reads(3, true), idx(), callsOnly);
    expect(tight.primitives).toBeLessThanOrEqual(callsOnly);
    expect(tight.marksHidden).toBe(3 - Math.floor(callsOnly / perMolecule));
    expect(tight.segHidden).toBe(tight.marksHidden);
    const hidden = tight.molecules.filter(m => m.marksHidden);
    expect(hidden.every(m => m.calls.length === 0 && m.seg === undefined && m.body.length > 0)).toBe(true);
    expect(tight.molecules.filter(m => !m.marksHidden).every(m => (m.seg?.length ?? 0) > 0)).toBe(true);
    const hit = { x0: hidden[0].extent![0], x1: hidden[0].extent![1], y0: 0, y1: 9, molecule: hidden[0] };
    const x = (hidden[0].body[0].x0 + hidden[0].body[0].x1) / 2;
    expect(describeReadHit(hit, x, () => 'Demo', () => 'Target', effectiveReadLayers({ nucseg: true }))).toContain('calls, m6A and the segment lane not drawn');
    expect(describeReadHit(hit, x, () => 'Demo', () => 'Target', effectiveReadLayers({}))).toContain('calls and m6A not drawn');
  });
});

describe('graph mode: nucleosome hover', () => {
  it('names the call\'s size class and z while size classes are on, and the lane\'s state and events while it is drawn', () => {
    const r = read('target', 93_000, 94_000, { nuc: [[93_100, 93_250]], cls: [2], zb: [120],
      nseg: { iv: [[93_050, 93_500], [93_150, 93_200]], code: [1, 17], p: [217, 51], q3: [87, 3] } });
    const m = placeRead(r, placementIndex(scene(), topology));
    const hit = { x0: m.extent![0], x1: m.extent![1], y0: 0, y1: 9, molecule: m };
    // Over the missing-nucleosome event, inside the call.
    const event = m.seg!.find(p => p.code === 17)!;
    const x = (event.x0 + event.x1) / 2;
    const text = describeReadHit(hit, x, () => 'Demo', () => 'Target', effectiveReadLayers({ nucsz: true, nucseg: true }));
    expect(text).toMatch(/nucleosome 150 bp at 93,100-93,250 \(MA0:0\) · mono · z −0\.4/);
    expect(text).toContain('array: regular · P 85% · q̂ 187 bp');
    expect(text).toContain('disrupted: missing nucleosome · LLR 5.1 · 3 marks');
    const off = describeReadHit(hit, x, () => 'Demo', () => 'Target', effectiveReadLayers({}));
    expect(off).toContain('nucleosome 150 bp');
    expect(off).not.toContain('mono');
    expect(off).not.toContain('array:');
    // Over the lane where no call is: the segment alone.
    const right = Math.max(...m.calls.filter(c => c.layer === 'nuc').map(c => c.x1));
    const seg = m.seg!.find(p => p.code === 1 && p.x1 > right + 5)!;
    const bare = describeReadHit(hit, Math.min(seg.x1, right + 4), () => 'Demo', () => 'Target', effectiveReadLayers({ nucseg: true }));
    expect(bare).toContain('array: regular');
    expect(bare).not.toContain('nucleosome 150');
  });
});
