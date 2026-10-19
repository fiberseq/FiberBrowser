import { describe, expect, it } from 'vitest';
import { DEFAULT_COLORMAP } from '../../../types';
import { drawReadTrack, inkOn } from './ReadTrackCanvas';
import { svBandMetrics } from './svDrawing';
import { drawSvBand } from './svCanvas';
import type { CompactRead, SvSummary } from './types';

/**
 * A 2D context recording fillRects (x-span after the active clip, a union of
 * rects as withReadBodyClip sets for a broken body), strokes (as line
 * segments) and text, enough to check what the SV display paints where.
 */
function recordingContext() {
  const fills: Array<{ x0: number; x1: number; y: number; h: number; fill: string }> = [];
  const lines: Array<{ x0: number; x1: number; y: number; stroke: string }> = [];
  const dashes: number[][] = [];
  const texts: Array<{ text: string; x: number; y: number }> = [];
  type Clip = Array<[number, number]>;
  let clip: Clip = [[-Infinity, Infinity]];
  const stack: Clip[] = [];
  let pending: Clip = [];
  let path: Array<[number, number]> = [];
  const state: Record<string, unknown> = { fillStyle: '#000000', strokeStyle: '#000000' };
  const intersect = (a: Clip, b: Clip): Clip => a.flatMap(([a0, a1]) => b.map(([b0, b1]) => [Math.max(a0, b0), Math.min(a1, b1)] as [number, number]).filter(([x0, x1]) => x1 > x0));
  const methods: Record<string, (...args: any[]) => unknown> = {
    save: () => { stack.push(clip); },
    restore: () => { clip = stack.pop() ?? [[-Infinity, Infinity]]; },
    beginPath: () => { pending = []; path = []; },
    rect: (x: number, _y: number, w: number) => { pending.push([Math.min(x, x + w), Math.max(x, x + w)]); },
    clip: () => { clip = intersect(clip, pending); },
    moveTo: (x: number, y: number) => { path = [[x, y]]; },
    lineTo: (x: number, y: number) => { path.push([x, y]); },
    stroke: () => {
      for (let i = 1; i < path.length; i++) {
        if (path[i][1] === path[i - 1][1]) lines.push({ x0: Math.min(path[i][0], path[i - 1][0]), x1: Math.max(path[i][0], path[i - 1][0]), y: path[i][1], stroke: String(state.strokeStyle) });
      }
    },
    fillRect: (x: number, y: number, w: number, h: number) => {
      for (const [c0, c1] of clip) {
        const x0 = Math.max(Math.min(x, x + w), c0);
        const x1 = Math.min(Math.max(x, x + w), c1);
        if (x1 > x0) fills.push({ x0, x1, y, h, fill: String(state.fillStyle).toLowerCase() });
      }
    },
    fillText: (text: string, x: number, y: number) => { texts.push({ text, x, y }); },
    measureText: (text: string) => ({ width: String(text).length * 5 }),
    createLinearGradient: () => ({ addColorStop: () => undefined }),
    getLineDash: () => [],
    setLineDash: (values: number[]) => { dashes.push(values); },
  };
  const ctx = new Proxy(state, {
    get: (target, prop: string) => (prop in methods ? methods[prop] : prop in target ? target[prop] : () => undefined),
    set: (target, prop: string, value) => { target[prop] = value; return true; },
  });
  return { ctx, fills, lines, texts, dashes };
}

const fakeCanvas = (ctx: unknown) => ({ getContext: () => ctx, style: {}, width: 0, height: 0 }) as unknown as HTMLCanvasElement;
const START = 10_000;

// A deletion carrier as the loader sends it: calls already split at the
// deletion (abs 10_300..10_700), the body's intervals on both sides.
const CARRIER: CompactRead = {
  id: 'c',
  intervals: [[0, 150, -150], [150, 300, 147], [700, 847, 147], [847, 1000, -153]],
  layers: { nuc: { intervals: [[150, 300, 147], [700, 847, 147]] }, msp: { intervals: [[0, 150, 150], [847, 1000, 153]] } },
  sv: [{ t: 'D', ref: START + 300, len: 400, q: 300 }, { t: 'I', ref: START + 900, len: 312, q: 1200 }],
  cigar: [{ type: 'D', pos: 300, len: 400 }, { type: 'D', pos: 50, len: 3 }],
} as unknown as CompactRead;
const REF: CompactRead = { id: 'r', intervals: [[0, 1000, -1000]] } as CompactRead;
const SUMMARY: SvSummary = {
  min_len: 50, margin: 100, scope: 'all', n_reads: 2,
  clusters: [{ id: 'D:x', t: 'D', ref: START + 300, len: 400, end: START + 700, support: 1, informative: 2, sa_support: 0 }],
  clips: [],
};

function draw(reads: CompactRead[], extra: Record<string, unknown> = {}) {
  const rec = recordingContext();
  drawReadTrack({
    canvas: fakeCanvas(rec.ctx), displayReads: reads, width: 1000, height: 100, regionWidth: 1000,
    chrom: 'chrSV', start: START, end: START + 1000, loading: false,
    datasetId: 'd', sidebarWidth: 0, hasCluster: false, myClusterAssignments: {}, myClusterOrder: [],
    hasClusterFocus: false, myClusterFocus: null, mySelectedClusters: null,
    enabledModTypes: { nuc: true, msp: true, footprint: true }, enabledCigarTypes: { mismatches: false, insertions: true, deletions: true },
    isBAM: true, fillReadHeight: false, storeReadRowHeight: 20, readScrollOffset: 0,
    readSeparatorMode: 'off', readSeparatorMinHeight: 3, readSeparatorWidth: 1,
    showCoverageHistogram: false, isReversed: false,
    activeColormap: DEFAULT_COLORMAP, genes: [], allPeaks: [], orthogonalTracks: [],
    modificationOverlays: [], overlayMarks: {}, jupyterReadHighlights: new Map(),
    jupyterFootprintColorMap: new Map(), allJupyterMarkers: [],
    selectedReadIds: undefined, selectedFootprints: [], footprintCrossHighlight: false,
    footprintGroups: [], selectedFamilyGroupId: null, footprintAnalysisLayer: null,
    clusterStateConsensus: new Map(), hasFilter: false, myFilteredReadIds: null,
    maxRegionForReads: 100_000,
    svEnabled: true, svMinLen: 50,
    ...extra,
  } as unknown as Parameters<typeof drawReadTrack>[0]);
  return rec;
}

const readBg = String(DEFAULT_COLORMAP.readBackgroundColor ?? '#f1f5f9').toLowerCase();

describe('SV display on the read canvas', () => {
  it('breaks the body at a deletion: nothing is painted in the deleted span', () => {
    const { fills, lines, texts } = draw([CARRIER]);
    const rowFills = fills.filter(f => f.y >= 0 && f.y < 20 && f.h <= 20);
    expect(rowFills.some(f => f.fill === readBg && f.x0 === 0 && f.x1 === 300)).toBe(true);
    expect(rowFills.some(f => f.fill === readBg && f.x0 === 700 && f.x1 === 1000)).toBe(true);
    const empty = String(DEFAULT_COLORMAP.noReadBackgroundColor ?? DEFAULT_COLORMAP.backgroundColor ?? '#ffffff').toLowerCase();
    for (const f of rowFills.filter(f => f.fill !== empty)) {
      // Nothing of the read (body, calls, marks) between 300 and 700.
      expect(f.x1 <= 300 || f.x0 >= 700).toBe(true);
    }
    // A thin connector across the deletion, with its size.
    expect(lines.some(l => l.x0 === 300 && l.x1 === 700)).toBe(true);
    expect(texts.map(t => t.text)).toContain('−400');
    expect(texts.map(t => t.text)).toContain('+312');
    // The old CIGAR deletion line is not drawn again for the SV-sized event (only the 3 bp one).
    expect(lines.filter(l => l.x0 === 300 && l.x1 === 700)).toHaveLength(1);
  });

  it('draws the reversed view mirrored', () => {
    const { fills, lines } = draw([CARRIER], { isReversed: true });
    const rowFills = fills.filter(f => f.y >= 0 && f.y < 20 && f.h <= 20 && f.fill === readBg);
    expect(rowFills.some(f => f.x0 === 0 && f.x1 === 300)).toBe(true);    // 700..1000 mirrored
    expect(rowFills.some(f => f.x0 === 700 && f.x1 === 1000)).toBe(true);
    expect(lines.some(l => l.x0 === 300 && l.x1 === 700)).toBe(true);
  });

  it('with SV display off, the body is whole and the CIGAR toggles draw the deletion', () => {
    const { fills, lines } = draw([CARRIER], { svEnabled: false });
    expect(fills.some(f => f.fill === readBg && f.x0 === 0 && f.x1 === 1000)).toBe(true);
    expect(lines.some(l => l.x0 === 300 && l.x1 === 700)).toBe(true);  // the 2 px CIGAR line
  });

  it('the SV summary is its own track now: the read canvas draws no band and its rows start at the top', () => {
    const plain = draw([REF]);
    const withSummary = draw([REF], { svSummary: SUMMARY });
    const firstRowY = (fills: typeof plain.fills) => Math.min(...fills.filter(f => f.fill === readBg).map(f => f.y));
    expect(firstRowY(withSummary.fills)).toBe(firstRowY(plain.fills));
    expect(withSummary.texts.some(t => t.text.startsWith('SV'))).toBe(false);
  });

  it('the SV track draws to the height it is given (glyphs and labels scale)', () => {
    const small = recordingContext();
    drawSvBand(small.ctx as unknown as CanvasRenderingContext2D, SUMMARY, {
      top: 0, height: 30, width: 1000, sidebarWidth: 0, viewStart: START, toX: rel => rel, isReversed: false, backgroundColor: '#fff',
    });
    const tall = recordingContext();
    drawSvBand(tall.ctx as unknown as CanvasRenderingContext2D, SUMMARY, {
      top: 0, height: 160, width: 1000, sidebarWidth: 0, viewStart: START, toX: rel => rel, isReversed: false, backgroundColor: '#fff',
    });
    expect(small.texts.some(t => t.text.includes('1/2'))).toBe(true);
    expect(tall.texts.some(t => t.text.startsWith('SV'))).toBe(true);
    // The deletion's label sits near the arc's apex: high up in the tall track, not at a fixed 36 px band.
    const labelY = (texts: typeof small.texts) => texts.find(t => t.text.includes('1/2'))!.y;
    expect(labelY(tall.texts)).toBeLessThan(40);
    expect(svBandMetrics(160).labelPx).toBeGreaterThan(svBandMetrics(30).labelPx);
    expect(svBandMetrics(160).inner).toBeGreaterThan(120);
  });
});

// fb-n11-tracks: the zoomed-out card sat on the coverage plot ("the coverage profile was gone").
describe('zoomed out past the read limit', () => {
  const coverage = (extra: Record<string, unknown> = {}) => draw([], {
    regionWidth: 150_000, end: START + 150_000, maxRegionForReads: 100_000, height: 200,
    coverageData: new Float32Array([1, 5, 10, 5, 1]), coverageMax: 10, ...extra,
  });
  const bars = (fills: Array<{ y: number; h: number; fill: string }>) => fills.filter(f => /rgba\(1(00|47)/.test(f.fill));

  it('fills the track with the coverage plot, and keeps the banner\'s line at the bottom clear', () => {
    const full = bars(coverage().fills);
    expect(full.length).toBe(5);
    const top = Math.min(...full.map(f => f.y));
    const bottom = Math.max(...full.map(f => f.y + f.h));
    expect(bottom).toBeGreaterThan(190);
    expect(bottom - top).toBeGreaterThan(150);   // most of the 200 px track
    const withBanner = bars(coverage({ coverageFooterHeight: 24 }).fills);
    expect(Math.max(...withBanner.map(f => f.y + f.h))).toBeLessThanOrEqual(200 - 24);
  });

  it('paints the colormap\'s ground and labels that read on it (a dark colormap too)', () => {
    const dark = coverage({ activeColormap: { ...DEFAULT_COLORMAP, noReadBackgroundColor: '#111827' } });
    expect(dark.fills.some(f => f.fill === '#111827' && f.h > 100)).toBe(true);
    expect(dark.fills.some(f => f.fill === '#fafafa')).toBe(false);
    expect(dark.texts.some(t => t.text.startsWith('Coverage'))).toBe(true);
    expect(inkOn('#111827').dark).toBe(true);
    expect(inkOn('#ffffff').dark).toBe(false);
  });
});

it('distinguishes putative carrier highlights with pale dashed evidence markers', () => {
  const confirmed = draw([REF], { readHighlightIds: new Set(['r']) });
  const putative = draw([REF], { readHighlightIds: new Set(['r']), uncertainSvIds: new Set(['r']) });
  expect(confirmed.fills.some(f => f.fill === '#ca8a04')).toBe(true);
  expect(putative.fills.some(f => f.fill === 'rgba(202, 138, 4, 0.5)')).toBe(true);
  expect(putative.dashes).toContainEqual([3, 3]);
  expect(putative.dashes).toContainEqual([2, 2]);
});
