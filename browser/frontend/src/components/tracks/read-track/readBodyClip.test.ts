import { describe, expect, it } from 'vitest';
import { DEFAULT_COLORMAP } from '../../../types';
import { drawReadTrack, getCompactReadExtent, withReadBodyClip } from './ReadTrackCanvas';
import type { CompactRead } from './types';

/**
 * A 2D context that records every fillRect as the x-span it actually paints:
 * the rect intersected with the active clip (save/restore/rect/clip tracked;
 * only the x-axis matters here). Everything else is a no-op.
 */
function recordingContext() {
  const painted: Array<{ x0: number; x1: number; y: number; fill: string }> = [];
  let clip: [number, number] = [-Infinity, Infinity];
  const stack: Array<[number, number]> = [];
  let pendingRect: [number, number] | null = null;
  const state: Record<string, unknown> = { fillStyle: '#000000' };
  const methods: Record<string, (...args: number[]) => unknown> = {
    save: () => { stack.push(clip); },
    restore: () => { clip = stack.pop() ?? [-Infinity, Infinity]; },
    beginPath: () => { pendingRect = null; },
    rect: (x, _y, w) => { pendingRect = [Math.min(x, x + w), Math.max(x, x + w)]; },
    clip: () => {
      if (pendingRect) clip = [Math.max(clip[0], pendingRect[0]), Math.min(clip[1], pendingRect[1])];
    },
    fillRect: (x, y, w) => {
      const x0 = Math.max(Math.min(x, x + w), clip[0]);
      const x1 = Math.min(Math.max(x, x + w), clip[1]);
      if (x1 > x0) painted.push({ x0, x1, y, fill: String(state.fillStyle) });
    },
    measureText: () => ({ width: 0 }),
    createLinearGradient: () => ({ addColorStop: () => undefined }),
    getLineDash: () => [],
  };
  const ctx = new Proxy(state, {
    get: (target, prop: string) => (prop in methods ? methods[prop] : prop in target ? target[prop] : () => undefined),
    set: (target, prop: string, value) => { target[prop] = value; return true; },
  });
  return { ctx, painted };
}

function fakeCanvas(ctx: unknown) {
  return { getContext: () => ctx, style: {}, width: 0, height: 0 } as unknown as HTMLCanvasElement;
}

// A read as the compact loader returns it for a FiberHMM DddA file with
// terminal gaps hidden: body 120..630 (a nucleosome between two TF calls),
// with the MSP layer still reaching back to the alignment start (100) and on
// to its end (700).
const READ: CompactRead = {
  id: 'r1',
  intervals: [[120, 400, -280], [400, 550, 150], [550, 630, -80]],
  layers: {
    nuc: { intervals: [[400, 550, 150]] },
    tf: { intervals: [[120, 160, 40], [600, 630, 30]] },
    msp: { intervals: [[100, 400, 300], [550, 700, 150]] },
  },
} as unknown as CompactRead;

function draw(read: CompactRead, enabledModTypes: Record<string, boolean>) {
  const { ctx, painted } = recordingContext();
  drawReadTrack({
    canvas: fakeCanvas(ctx), displayReads: [read], width: 1000, height: 40, regionWidth: 1000,
    chrom: 'chr1', start: 1000, end: 2000, loading: false,
    datasetId: 'd', sidebarWidth: 0, hasCluster: false, myClusterAssignments: {}, myClusterOrder: [],
    hasClusterFocus: false, myClusterFocus: null, mySelectedClusters: null,
    enabledModTypes, enabledCigarTypes: { mismatches: false, insertions: false, deletions: false },
    isBAM: true, fillReadHeight: true, storeReadRowHeight: 10, readScrollOffset: 0,
    readSeparatorMode: 'auto', readSeparatorMinHeight: 3, readSeparatorWidth: 1,
    showCoverageHistogram: false, isReversed: false,
    activeColormap: DEFAULT_COLORMAP, genes: [], allPeaks: [], orthogonalTracks: [],
    modificationOverlays: [], overlayMarks: {}, jupyterReadHighlights: new Map(),
    jupyterFootprintColorMap: new Map(), allJupyterMarkers: [],
    selectedReadIds: undefined, selectedFootprints: [], footprintCrossHighlight: false,
    footprintGroups: [], selectedFamilyGroupId: null, footprintAnalysisLayer: null,
    clusterStateConsensus: new Map(), hasFilter: false, myFilteredReadIds: null,
    maxRegionForReads: 100_000,
  } as unknown as Parameters<typeof drawReadTrack>[0]);
  return painted;
}

describe('read body clip', () => {
  it('extends the read extent over every interval of the body', () => {
    expect(getCompactReadExtent(READ)).toEqual({ start: 120, end: 630 });
  });

  it('paints nothing beyond the read body, whatever layers are on', () => {
    const painted = draw(READ, { nuc: true, tf: true, msp: true, fire: true, footprint: true });
    const bg = (DEFAULT_COLORMAP.noReadBackgroundColor ?? DEFAULT_COLORMAP.backgroundColor ?? '#ffffff').toLowerCase();
    const rowPaint = painted.filter(p => p.y >= 0 && p.fill.toLowerCase() !== bg && !(p.x0 <= 0 && p.x1 >= 1000));
    expect(rowPaint.length).toBeGreaterThan(3);
    for (const p of rowPaint) {
      expect(p.x0).toBeGreaterThanOrEqual(120);
      expect(p.x1).toBeLessThanOrEqual(630);
    }
    // The TF calls at the body's edges are drawn (not clipped away).
    expect(rowPaint.some(p => p.x0 === 120 && p.x1 === 160)).toBe(true);
    expect(rowPaint.some(p => p.x0 === 600 && p.x1 === 630)).toBe(true);
  });

  it('withReadBodyClip restores the context even when drawing throws', () => {
    const { ctx } = recordingContext();
    const calls: string[] = [];
    const spy = new Proxy(ctx as object, {
      get: (target, prop: string) => {
        const v = (target as Record<string, unknown>)[prop];
        return typeof v === 'function' ? (...a: number[]) => { calls.push(prop); return (v as (...x: number[]) => unknown)(...a); } : v;
      },
    }) as unknown as CanvasRenderingContext2D;
    expect(() => withReadBodyClip(spy, { x: 10, w: 20 }, 50, () => { throw new Error('boom'); })).toThrow('boom');
    expect(calls).toEqual(['save', 'beginPath', 'rect', 'clip', 'restore']);
    const unclipped: string[] = [];
    withReadBodyClip(spy, null, 50, () => unclipped.push('drawn'));
    expect(unclipped).toEqual(['drawn']);
  });
});
