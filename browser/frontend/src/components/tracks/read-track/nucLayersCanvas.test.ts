import { describe, expect, it } from 'vitest';
import { DEFAULT_COLORMAP, type Colormap } from '../../../types';
import { nucSegColor, nucSizeClassRules } from '../../../utils/nucLayers';
import { drawReadTrack } from './ReadTrackCanvas';
import { drawNucSegLane } from './nucSegCanvas';
import { findFootprintHit } from './footprintHitTest';
import { nucleosomeTooltipLines } from './ReadTrackTooltip';
import type { CompactRead } from './types';

/** A 2D context recording fillRects (with the alpha they were drawn at), paths filled, and dashes. */
function recordingContext() {
  const fills: Array<{ x: number; y: number; w: number; h: number; fill: string; alpha: number }> = [];
  const paths: Array<{ points: Array<[number, number]>; fill: string }> = [];
  const strokes: Array<{ points: Array<[number, number]>; stroke: string; dash: number[]; width: number }> = [];
  let path: Array<[number, number]> = [];
  let dash: number[] = [];
  const stack: Array<{ dash: number[]; alpha: unknown }> = [];
  const state: Record<string, unknown> = { fillStyle: '#000000', strokeStyle: '#000000', globalAlpha: 1, lineWidth: 1 };
  const methods: Record<string, (...args: any[]) => unknown> = {
    save: () => { stack.push({ dash, alpha: state.globalAlpha }); },
    restore: () => { const top = stack.pop(); if (top) { dash = top.dash; state.globalAlpha = top.alpha; } },
    beginPath: () => { path = []; },
    moveTo: (x: number, y: number) => { path = [[x, y]]; },
    lineTo: (x: number, y: number) => { path.push([x, y]); },
    closePath: () => undefined,
    fill: () => { paths.push({ points: path, fill: String(state.fillStyle).toLowerCase() }); },
    stroke: () => { strokes.push({ points: path, stroke: String(state.strokeStyle).toLowerCase(), dash, width: Number(state.lineWidth) }); },
    fillRect: (x: number, y: number, w: number, h: number) => {
      fills.push({ x, y, w, h, fill: String(state.fillStyle).toLowerCase(), alpha: Number(state.globalAlpha) });
    },
    fillText: () => undefined,
    measureText: (text: string) => ({ width: String(text).length * 5 }),
    createLinearGradient: () => ({ addColorStop: () => undefined }),
    getLineDash: () => dash,
    setLineDash: (values: number[]) => { dash = values; },
  };
  const ctx = new Proxy(state, {
    get: (target, prop: string) => (prop in methods ? methods[prop] : prop in target ? target[prop] : () => undefined),
    set: (target, prop: string, value) => { target[prop] = value; return true; },
  });
  return { ctx, fills, paths, strokes };
}

const fakeCanvas = (ctx: unknown) => ({ getContext: () => ctx, style: {}, width: 0, height: 0, dataset: {} }) as unknown as HTMLCanvasElement;
const START = 50_000;
const zByte = (z: number) => Math.round(20 * z + 128);

// One read: a short, a mono and a split multi(2) nucleosome, a TF call, size marks and array rows.
const READ: CompactRead = {
  id: 'n1',
  intervals: [[0, 1000, -1000]],
  layers: {
    nuc: { intervals: [[100, 160, 60], [200, 347, 147], [600, 700, 300], [720, 900, 300]] },
    tf: { intervals: [[400, 420, 20]], quality_names: ['tq'], qualities: [[255]] },
    nucsz: {
      intervals: [[100, 160, 60], [200, 347, 147], [400, 420, 20], [600, 900, 300]],
      quality_names: ['coarse', 'named', 'posterior', 'z'],
      qualities: [[1, 2, 1 + 16, 4], [0, 0, 0, 0], [200, 220, 240, 230], [zByte(-2.5), zByte(0), 255, zByte(1)]],
    },
    nucseg: {
      intervals: [[0, 500, 500], [500, 800, 300], [800, 1000, 200], [250, 400, 150], [600, 700, 100]],
      quality_names: ['code', 'posterior_or_llr10', 'q_hat_minus_100_or_count'],
      qualities: [[1, 2, 3, 17, 16], [230, 200, 0, 51, 40], [87, 0, 0, 2, 3]],
    },
    nucmol: { intervals: [[0, 1000, 1000]], qualities: [[1], [2], [3]] },
  },
} as unknown as CompactRead;

function draw(enabled: Record<string, boolean>, colormap: Colormap = DEFAULT_COLORMAP, rowHeight = 20) {
  const rec = recordingContext();
  const canvas = fakeCanvas(rec.ctx);
  drawReadTrack({
    canvas, displayReads: [READ], width: 1000, height: 100, regionWidth: 1000,
    chrom: 'chrN', start: START, end: START + 1000, loading: false,
    datasetId: 'd', sidebarWidth: 0, hasCluster: false, myClusterAssignments: {}, myClusterOrder: [],
    hasClusterFocus: false, myClusterFocus: null, mySelectedClusters: null,
    enabledModTypes: { nuc: true, tf: true, ...enabled }, enabledCigarTypes: { mismatches: false, insertions: false, deletions: false },
    isBAM: true, fillReadHeight: false, storeReadRowHeight: rowHeight, readScrollOffset: 0,
    readSeparatorMode: 'off', readSeparatorMinHeight: 3, readSeparatorWidth: 1,
    showCoverageHistogram: false, isReversed: false,
    activeColormap: colormap, genes: [], allPeaks: [], orthogonalTracks: [],
    modificationOverlays: [], overlayMarks: {}, jupyterReadHighlights: new Map(),
    jupyterFootprintColorMap: new Map(), allJupyterMarkers: [],
    selectedReadIds: undefined, selectedFootprints: [], footprintCrossHighlight: false,
    footprintGroups: [], selectedFamilyGroupId: null, footprintAnalysisLayer: null,
    clusterStateConsensus: new Map(), hasFilter: false, myFilteredReadIds: null,
    maxRegionForReads: 100_000,
  } as unknown as Parameters<typeof drawReadTrack>[0]);
  return { ...rec, dataset: (canvas as unknown as { dataset: Record<string, string> }).dataset };
}

const withClasses: Colormap = { ...DEFAULT_COLORMAP, rules: [...nucSizeClassRules(), ...DEFAULT_COLORMAP.rules] };
const callFill = (fills: ReturnType<typeof draw>['fills'], x: number, w: number) =>
  fills.find(f => f.x === x && f.w === w && f.y === 0 && f.h === 20)?.fill;

describe('nucleosome size classes on the read canvas', () => {
  it('recolour nucleosome calls through the template rules when Size classes is on', () => {
    const { fills } = draw({ nucsz: true }, withClasses);
    expect(callFill(fills, 100, 60)).toBe('#f59e0b');  // short
    expect(callFill(fills, 200, 147)).toBe('#16a34a');  // mono
    // Both pieces of the split multi(2) call take its mark.
    expect(callFill(fills, 600, 100)).toBe('#2563eb');
    expect(callFill(fills, 720, 180)).toBe('#2563eb');
  });

  it('leave TF calls to the TF colours', () => {
    const { fills } = draw({ nucsz: true }, withClasses);
    const tf = fills.filter(f => f.x === 400 && f.w === 20 && f.y === 0 && f.h === 20);
    expect(tf.length).toBeGreaterThan(0);
    for (const f of tf) expect(f.fill.startsWith('#f59e0b')).toBe(false);
  });

  it('are off with the layer off: the default colours apply', () => {
    const { fills } = draw({ nucsz: false }, withClasses);
    expect(callFill(fills, 200, 147)).toBe('#33a040');
    expect(callFill(fills, 100, 60)).not.toBe('#f59e0b');
  });

  it('never paint the size marks, segments or scalar groups as overlays', () => {
    const { fills } = draw({ nucsz: true, nucseg: false, nucmol: true, nfrmol: true });
    // The default slate/green layer colours of nucsz / nucmol would show as translucent full-height fills.
    const fullHeight = fills.filter(f => f.y === 0 && f.h === 20);
    expect(fullHeight.some(f => f.fill.startsWith('#64748b'))).toBe(false);
    expect(fullHeight.some(f => f.x === 400 && f.w === 20 && f.fill.startsWith('#16a34a'))).toBe(false);
    expect(fullHeight.some(f => f.x === 0 && f.w === 1000 && f.fill !== '#f1f5f9')).toBe(false);
  });
});

describe('the nucleosome array lane on the read canvas', () => {
  it('is drawn at the bottom of each row when Array segments is on', () => {
    const { fills, paths, strokes, dataset } = draw({ nucseg: true });
    const lane = fills.filter(f => f.y === 17 && f.h === 3);
    expect(lane.some(f => f.x === 0 && f.w === 500 && f.fill === nucSegColor(1))).toBe(true);
    expect(lane.some(f => f.x === 500 && f.w === 300 && f.fill === nucSegColor(2))).toBe(true);
    // Low information: a pale strip and a dotted line.
    expect(lane.some(f => f.x === 800 && f.fill === nucSegColor(3) && f.alpha < 1)).toBe(true);
    expect(strokes.some(s => s.stroke === nucSegColor(3) && s.dash.length === 2 && s.width === 3)).toBe(true);
    // Undersized run: an amber bar in the top of the lane.
    expect(fills.some(f => f.x === 600 && f.w === 100 && f.y === 17 && f.h === 2 && f.fill === nucSegColor(16))).toBe(true);
    // Missing nucleosome: a gap in the lane and a triangle over its centre.
    expect(lane.some(f => f.x === 250 && f.w === 150 && f.fill === '#f1f5f9')).toBe(true);
    expect(paths.some(p => p.fill === nucSegColor(17) && p.points.some(([x, y]) => x === 325 && y === 17))).toBe(true);
    expect(dataset.nucSegRows).toBe('5');
  });

  it('is not drawn with the layer off', () => {
    const { fills, dataset } = draw({ nucseg: false });
    expect(fills.some(f => f.fill === nucSegColor(1))).toBe(false);
    expect(dataset.nucSegRows).toBe('0');
  });

  it('shrinks with the row and keeps thin rows legible', () => {
    const { fills } = draw({ nucseg: true }, DEFAULT_COLORMAP, 4);
    expect(fills.some(f => f.fill === nucSegColor(1) && f.h === 1 && f.y === 3)).toBe(true);
  });
});

describe('drawNucSegLane', () => {
  const rows = {
    segments: [{ start: 0, end: 400, code: 1, value: 230, extra: 87 }, { start: 400, end: 600, code: 4, value: 100, extra: 0 }],
    events: [{ start: 100, end: 200, code: 17, value: 50, extra: 1 }],
  };
  const base = { y: 0, bodyH: 20, linkedOffset: 0, regionWidth: 1000, toX: (rel: number) => rel, ground: '#111827', dark: true };

  it('uses the dark palette on a dark ground', () => {
    const rec = recordingContext();
    expect(drawNucSegLane(rec.ctx as unknown as CanvasRenderingContext2D, rows, base)).toBe(3);
    expect(rec.fills.some(f => f.fill === nucSegColor(1, true))).toBe(true);
    expect(rec.fills.some(f => f.fill === nucSegColor(4, true))).toBe(true);
    // The gap above the lane and the missing-nucleosome gap use the ground.
    expect(rec.fills.some(f => f.fill === '#111827' && f.y === 16 && f.h === 1)).toBe(true);
    expect(rec.fills.some(f => f.fill === '#111827' && f.x === 100 && f.y === 17)).toBe(true);
  });

  it('mirrors in a reversed view and clips to the view', () => {
    const rec = recordingContext();
    drawNucSegLane(rec.ctx as unknown as CanvasRenderingContext2D, rows, { ...base, regionWidth: 500, toX: rel => 500 - rel });
    const regular = rec.fills.find(f => f.fill === nucSegColor(1, true));
    expect(regular).toMatchObject({ x: 100, w: 400 });
    const undetermined = rec.fills.find(f => f.fill === nucSegColor(4, true));
    expect(undetermined).toMatchObject({ x: 0, w: 100 });
  });

  it('draws nothing in rows thinner than 2 px', () => {
    const rec = recordingContext();
    expect(drawNucSegLane(rec.ctx as unknown as CanvasRenderingContext2D, rows, { ...base, bodyH: 1 })).toBe(0);
    expect(rec.fills).toHaveLength(0);
  });
});

describe('nucleosome layers elsewhere in the read track', () => {
  it('are never the footprint a click selects', () => {
    const hit = findFootprintHit(READ, { relPos: 250, bpTolerance: 0, enabledModTypes: { nucsz: true, nucseg: true } });
    expect(hit?.layer).toBe('nuc');
    expect(findFootprintHit(READ, { relPos: 450, bpTolerance: 0, enabledModTypes: { nucsz: true, nucseg: true, nucmol: true } })).toBeNull();
  });

  it('give the hover the size mark, segment and events under the pointer', () => {
    expect(nucleosomeTooltipLines(READ, START + 300, START)).toEqual([
      'Size class: mono · z 0.0 · P 86%',
      'Array: regular · P 90% · q̂ 187 bp',
      'Disrupted: missing nucleosome · LLR 5.1 · 2 marks',
    ]);
    expect(nucleosomeTooltipLines(READ, START + 650, START)).toEqual([
      'Size class: multi (2) · z 1.0 · P 90%',
      'Array: disordered · P 78%',
      'Disrupted: undersized footprint run · LLR 4.0 · 3 footprints',
    ]);
    expect(nucleosomeTooltipLines(READ, undefined, START)).toEqual([]);
  });
});
