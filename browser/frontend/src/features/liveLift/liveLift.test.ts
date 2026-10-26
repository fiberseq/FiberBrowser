import { describe, expect, it, beforeEach, vi } from 'vitest';
import { DEFAULT_COLORMAP } from '../../types';
import { coverageHistogramBins, drawReadTrack } from '../../components/tracks/read-track/ReadTrackCanvas';
import {
  formatBadgeBp, liveLiftBadgeGeometry, liveLiftHitAt, liveLiftBodyRects, liveLiftBodySpans, liveLiftSegmentAt,
} from '../../components/tracks/read-track/liveLiftCanvas';
import type { CompactRead, LiveLiftRow } from '../../components/tracks/read-track/types';
import { makeDataViewportKey } from '../../components/tracks/read-track/useReadTrackData';
import { canProjectReadRegion } from '../../api/loadedReadRegion';
import { createTestStore, ensureBuiltinPanelsRegistered } from '../../stores/__tests__/helpers';
import { liveLiftTooltipLines } from './LiveLiftTooltip';
import { liveLiftChipText } from './register';
import { isBamBacked, isLiveLift } from '../../utils/datasetKinds';
import { liveLiftHaplotypeColor } from './palette';
import { makeAxis } from './axis';
import { insertionPayloadRects } from '../../components/tracks/read-track/liveLiftInsertionCanvas';
import type { LiveLiftInsertion } from '../../components/tracks/read-track/types';

/** A recording 2D context (as svCanvasDraw.test.ts): fills after clipping, horizontal strokes and texts. */
function recordingContext() {
  const fills: Array<{ x0: number; x1: number; y: number; h: number; fill: string; alpha: number }> = [];
  const lines: Array<{ x0: number; x1: number; y: number; dashed: boolean }> = [];
  const texts: string[] = [];
  type Clip = Array<[number, number]>;
  let clip: Clip = [[-Infinity, Infinity]];
  const stack: Clip[] = [];
  let pending: Clip = [];
  let path: Array<[number, number]> = [];
  let dash: number[] = [];
  const state: Record<string, unknown> = { fillStyle: '#000000', strokeStyle: '#000000' };
  const intersect = (a: Clip, b: Clip): Clip => a.flatMap(([a0, a1]) => b.map(([b0, b1]) => [Math.max(a0, b0), Math.min(a1, b1)] as [number, number]).filter(([x0, x1]) => x1 > x0));
  const methods: Record<string, (...args: any[]) => unknown> = {
    save: () => { stack.push(clip); },
    restore: () => { clip = stack.pop() ?? [[-Infinity, Infinity]]; dash = []; },
    beginPath: () => { pending = []; path = []; },
    rect: (x: number, _y: number, w: number) => { pending.push([Math.min(x, x + w), Math.max(x, x + w)]); },
    clip: () => { clip = intersect(clip, pending); },
    moveTo: (x: number, y: number) => { path = [[x, y]]; },
    lineTo: (x: number, y: number) => { path.push([x, y]); },
    setLineDash: (d: number[]) => { dash = d; },
    stroke: () => {
      for (let i = 1; i < path.length; i++) {
        if (path[i][1] === path[i - 1][1]) lines.push({ x0: Math.min(path[i][0], path[i - 1][0]), x1: Math.max(path[i][0], path[i - 1][0]), y: path[i][1], dashed: dash.length > 0 });
      }
    },
    fillRect: (x: number, y: number, w: number, h: number) => {
      for (const [c0, c1] of clip) {
        const x0 = Math.max(Math.min(x, x + w), c0);
        const x1 = Math.min(Math.max(x, x + w), c1);
        if (x1 > x0) fills.push({ x0, x1, y, h, fill: String(state.fillStyle).toLowerCase(), alpha: Number(state.globalAlpha ?? 1) });
      }
    },
    fillText: (text: string) => { texts.push(text); },
    measureText: (text: string) => ({ width: String(text).length * 5 }),
    createLinearGradient: () => ({ addColorStop: () => undefined }),
    getLineDash: () => dash,
  };
  const ctx = new Proxy(state, {
    get: (target, prop: string) => (prop in methods ? methods[prop] : prop in target ? target[prop] : () => undefined),
    set: (target, prop: string, value) => { target[prop] = value; return true; },
  });
  return { ctx, fills, lines, texts };
}

const fakeCanvas = (ctx: unknown) => ({ getContext: () => ctx, style: {}, dataset: {}, width: 0, height: 0 }) as unknown as HTMLCanvasElement;
const START = 10_000;
const LL: LiveLiftRow = {
  v: 1, hap_label: 'MAT', hap_source: 'primary',
  source: { contig: 'chr3_MATERNAL', start: 99, end: 1200, orientation: 'forward' },
  segments: [[0, 600, 0, '+', true], [700, 1000, 1, '-', true]],
  connectors: [[300, 310]],
  badges: [[600, 'source_insertion', 2353, 2353, 'I']],
};
const LIFTED: CompactRead = {
  id: 'm', strand: 'CT',
  intervals: [[100, 300, 200], [310, 400, 200], [750, 900, 150]],
  layers: { nuc: { intervals: [[100, 300, 200], [310, 400, 200], [750, 900, 150]] } },
  live_lift: LL,
} as unknown as CompactRead;

function draw(reads: CompactRead[], extra: Record<string, unknown> = {}) {
  const rec = recordingContext();
  const canvas = fakeCanvas(rec.ctx);
  drawReadTrack({
    canvas, displayReads: reads, width: 1000, height: 100, regionWidth: 1000,
    chrom: 'chr3', start: START, end: START + 1000, loading: false,
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
    maxRegionForReads: 100_000, svEnabled: false, svMinLen: 50,
    ...extra,
  } as unknown as Parameters<typeof drawReadTrack>[0]);
  return { ...rec, canvas };
}

const readBg = String(DEFAULT_COLORMAP.readBackgroundColor ?? '#f1f5f9').toLowerCase();
const empty = String(DEFAULT_COLORMAP.noReadBackgroundColor ?? DEFAULT_COLORMAP.backgroundColor ?? '#ffffff').toLowerCase();

describe('insertion columns on reads and sibling native reads', () => {
  const expansion = { chrom: 'chr3', pos: START + 600, length: 100, ins_id: 'MAT:src:0-100:insertion', label: 'HG002 MAT +100 bp', hap_label: 'MAT' };
  const payload: LiveLiftInsertion = { pos: 600, length: 100, mol_bp: 50, hap_label: 'MAT', src: ['src', 0, 100], orientation: '-', covered: [40, 90], intervals: [[30, 60, 30], [70, 100, 30]], methyl_m6a: [50], deam: [[80, 1]] };
  it.each([false, true])('draws mirrored payload coordinates as given, within covered only (panel reversed=%s)', reversed => {
    const axis = makeAxis(START, START + 1000, 1100, reversed, [expansion]);
    const rects = insertionPayloadRects(payload, expansion.ins_id, axis);
    expect(rects).toEqual(reversed ? [{ x: 440, w: 20, size: 30 }, { x: 410, w: 20, size: 30 }] : [{ x: 640, w: 20, size: 30 }, { x: 670, w: 20, size: 30 }]);
    const r = draw([{ ...LIFTED, live_lift: { ...LL, insertions: { [expansion.ins_id]: payload } } }], { width: 1100, axis, isReversed: reversed,
      enabledModTypes: { footprint: true, m6a: true, deam: true } });
    expect(r.fills.some(f => f.fill === readBg && f.x0 === (reversed ? 410 : 640) && f.x1 === (reversed ? 460 : 690))).toBe(true);
    expect(r.fills.some(f => f.fill === '#6b21a8' && Math.abs(f.x0 - (reversed ? 449 : 650)) < .01)).toBe(true);
  });
  it('native and non-carrier rows leave the insertion empty and retain aligned bodies on either side', () => {
    const axis = makeAxis(START, START + 1000, 1100, false, [expansion]);
    for (const read of [{ id: 'native', intervals: [[0, 1000, -1000]] } as CompactRead, LIFTED]) {
      const r = draw([read], { width: 1100, axis });
      const bodies = r.fills.filter(f => f.fill === readBg);
      expect(bodies.every(f => f.x1 <= 600 || f.x0 >= 700)).toBe(true);
      expect(bodies.some(f => f.x0 >= 700)).toBe(true);
    }
  });
  it('mismatch detail draws muted assembly, normal reads and amber GRCh38 allele markers', () => {
    const read = { ...LIFTED, cigar: [
      { type: 'X', pos: 100, len: 1, seq: 'C', source: 'assembly' },
      { type: 'X', pos: 110, len: 1, seq: 'A', source: 'reads' },
      { type: 'X', pos: 120, len: 1, seq: 'G', source: 'reads', allele: 'grch38' },
    ] } as CompactRead;
    const r = draw([read], { enabledCigarTypes: { mismatches: true, insertions: false, deletions: false } });
    expect(r.fills.some(f => f.x0 === 120 && f.fill === '#d97706')).toBe(true);
    expect(r.fills.some(f => f.x0 === 100 && f.alpha === .38)).toBe(true);
    expect(r.fills.some(f => f.x0 === 110 && f.alpha === 1)).toBe(true);
    expect(r.fills.filter(f => f.x0 === 100 || f.x0 === 110).length).toBeGreaterThanOrEqual(2);
  });
});

describe('live-lift geometry', () => {
  it.each([false, true])('resolves dense 23/147 bp neighbours at 20 kb / 480 px (reversed=%s)', reversed => {
    const ll: LiveLiftRow = { ...LL, segments: [[0, 20000, 0, '+', true]], badges: [
      [7220, 'source_insertion', 1, 1, 'I'], [7243, 'source_insertion', 1, 1, 'I'], [7390, 'source_insertion', 2353, 2353, 'I'],
    ] };
    const options = { y: 10, rowHeight: 16, linkedOffset: 0, regionWidth: 20000, toX: (p: number) => (reversed ? 20000 - p : p) * 480 / 20000 };
    const geometry = liveLiftBadgeGeometry(ll, options), large = geometry[2];
    // The neighbour's tick can be nearer inside the large insertion's notch:
    // a labelled box owns this overlap even when the tick was emitted first.
    const shared = large.x + (reversed ? 2 : -2);
    expect(liveLiftHitAt(ll, shared, 12, options)?.badge).toBe(ll.badges![2]);
    expect(liveLiftHitAt(ll, large.x, 12, options)?.badge).toBe(ll.badges![2]);
    // Away from the labelled box, ticks remain independently inspectable.
    const thin = geometry[0];
    if (!reversed) expect(liveLiftHitAt(ll, thin.x, 12, options)?.badge).toBe(ll.badges![0]);
    const labelled = { ...ll, badges: ll.badges!.map(b => [b[0], b[1], 100, 100, 'I'] as typeof b) };
    expect(liveLiftHitAt(labelled, geometry[1].x, 12, options)?.badge).toBe(labelled.badges[1]);
    const tied = { ...ll, badges: [[7390, 'source_insertion', 100, 100, 'I'], ll.badges![2]] as LiveLiftRow['badges'] };
    expect(liveLiftHitAt(tied, large.x, 12, options)?.badge).toBe(tied.badges![1]);
  });

  it.each(['omitted', 'collapsed', 'expanded'] as const)('publishes the badge ID and molecular bp with %s insertion annotations', annotations => {
    const id = 'MAT:src:100-2453:insertion';
    const payload: LiveLiftInsertion = { pos: 600, length: 2353, mol_bp: 2300, src: ['src', 100, 2453], hap_label: 'MAT', orientation: '+', covered: [53, 2353], intervals: [] };
    const ll: LiveLiftRow = { ...LL,
      badges: [[300, 'outside_chains', 2400, 2400, 'R'], [598, 'source_insertion', 1, 1, 'I'], [600, 'source_insertion', 2300, 2300, 'I']],
      badge_ids: [null, null, id],
      ...(annotations === 'omitted' ? {} : { insertions: annotations === 'expanded' ? { [id]: payload } : {} }) };
    const { canvas } = draw([{ ...LIFTED, live_lift: ll }]);
    const target = JSON.parse(canvas.dataset.liveLiftBadgeTarget);
    // Partial/noisy carrier bp must not replace the full map insertion's ID.
    expect(target).toEqual({ x: 600, y: 10, ins_id: id, bp: 2300 });
    expect(canvas.dataset.liveLiftInsertionCalls).toBe('0');
    const hit = liveLiftHitAt(ll, target.x, target.y, { y: 0, rowHeight: 20, linkedOffset: 0, regionWidth: 1000, toX: p => p });
    expect(hit?.badge).toBe(ll.badges![2]);
  });

  it('does not publish an unresolved badge as an insertion target', () => {
    const { canvas } = draw([{ ...LIFTED, live_lift: { ...LL, badge_ids: [null], insertions: {} } }]);
    expect(canvas.dataset.liveLiftBadgeTarget).toBe('');
  });

  it('body spans are segments minus connectors', () => {
    expect(liveLiftBodySpans(LL)).toEqual([[0, 300], [310, 600], [700, 1000]]);
    expect(liveLiftBodyRects(LL, 0, 1000, x => x)).toEqual([{ x: 0, w: 300 }, { x: 310, w: 290 }, { x: 700, w: 300 }]);
  });

  it('finds the segment (and its strand) under a position; none in a connector or a gap', () => {
    expect(liveLiftSegmentAt(LL, 50)).toEqual({ strand: '+', chain: 0 });
    expect(liveLiftSegmentAt(LL, 800)).toEqual({ strand: '-', chain: 1 });
    expect(liveLiftSegmentAt(LL, 305)).toBeNull();
    expect(liveLiftSegmentAt(LL, 650)).toBeNull();
    expect(formatBadgeBp(2353)).toBe('+2.4 kb');
    expect(formatBadgeBp(80)).toBe('+80 bp');
  });
});

describe('live-lift rows on the read canvas (SV display off)', () => {
  it('draws the body from segments: nothing of the read over a connector or between segments', () => {
    const { fills, lines, texts } = draw([LIFTED]);
    const row = fills.filter(f => f.y >= 0 && f.y < 20 && f.h <= 20 && f.fill !== empty);
    expect(row.some(f => f.fill === readBg && f.x0 === 0 && f.x1 === 300)).toBe(true);
    expect(row.some(f => f.fill === readBg && f.x0 === 700 && f.x1 === 1000)).toBe(true);
    // The body rects (full row height; a badge's label box is shorter).
    for (const f of row.filter(f => f.fill === readBg && f.h >= 15)) {
      expect(f.x1 <= 300 || f.x0 >= 310).toBe(true);          // the connector stays empty
      expect(f.x1 <= 600 || f.x0 >= 700).toBe(true);          // between segments too
    }
    expect(lines.some(l => l.dashed && l.x0 === 300 && l.x1 === 310)).toBe(true);
    expect(texts).toContain('+2.4 kb');
  });

  it('mirrors in a reversed panel', () => {
    const { fills } = draw([LIFTED], { isReversed: true });
    const body = fills.filter(f => f.y >= 0 && f.y < 20 && f.h <= 20 && f.fill === readBg);
    expect(body.some(f => f.x0 === 0 && f.x1 === 300)).toBe(true);   // the '-' segment 700..1000 mirrored
  });

  it('stripes pooled rows at the left body edge by haplotype; split and native rows need no stripe', () => {
    for (const hap of ['MAT', 'PAT', 'other']) {
      const read = { ...LIFTED, live_lift: { ...LL, hap_label: hap } };
      const color = liveLiftHaplotypeColor(hap);
      const pooled = draw([read]).fills.filter(f => f.fill === color);
      expect(pooled).toEqual([{ x0: 0, x1: 3, y: 0, h: 20, fill: color, alpha: 1 }]);
      expect(draw([read], { liftHap: hap }).fills.some(f => f.fill === color)).toBe(false);
      expect(draw([{ ...read, live_lift: undefined }]).fills.some(f => f.fill === color)).toBe(false);
      const reversed = draw([read], { isReversed: true }).fills.filter(f => f.fill === color);
      expect(reversed[0].x0).toBe(0);
    }
  });

  it('uses a readable haplotype stripe on a dark canvas ground', () => {
    const color = liveLiftHaplotypeColor('MAT', true);
    const { fills } = draw([LIFTED], { activeColormap: { ...DEFAULT_COLORMAP, noReadBackgroundColor: '#111827' } });
    expect(fills.some(f => f.fill === color && f.x0 === 0 && f.x1 === 3)).toBe(true);
  });
});

describe('coverage histogram of lifted rows', () => {
  it('counts bodies, not the hull across a connector or between segments', () => {
    const bins = coverageHistogramBins([LIFTED], 10, 1000);
    expect(Array.from(bins)).toEqual([1, 1, 1, 1, 1, 1, 0, 1, 1, 1]);
  });
});

describe('tooltip and chip', () => {
  it('says where the record is, the molecule strand, reversal and badges', () => {
    const lines = liveLiftTooltipLines(LIFTED);
    expect(lines[0]).toBe('Live lift from chr3_MATERNAL:100-1,200');
    expect(lines).toContain('Haplotype MAT');
    expect(lines).toContain('Molecule strand CT (st, unchanged by the lift)');
    expect(lines.some(l => l.startsWith('1 segment run reversed'))).toBe(true);
    expect(lines.some(l => l.startsWith('+2.4 kb: sequence of the source assembly only'))).toBe(true);
    expect(lines).toContain('CIGAR detail: muted source-assembly differences; normal read mismatches; amber reference-allele markers (possible mis-phasing).');
  });

  it('chips a lifted panel by haplotype', () => {
    const dataset = { id: 'l', data_type: 'bam_livelift', live_lift: { haplotypes: ['H#1', 'H#2'],
      haplotype_labels: { 'H#1': 'MAT', 'H#2': 'PAT' } } } as never;
    expect(liveLiftChipText({ panel: { liftHap: 'PAT' } as never, dataset })).toBe('Live lift · PAT → this genome');
    expect(liveLiftChipText({ panel: {} as never, dataset })).toBe('Live lift · MAT+PAT → this genome');
    expect(isBamBacked(dataset)).toBe(true);
    expect(isLiveLift({ data_type: 'bam' })).toBe(false);
  });
});

describe('haplotype panels', () => {
  let store: ReturnType<typeof createTestStore>;
  beforeEach(() => {
    localStorage.clear();
    ensureBuiltinPanelsRegistered();
    store = createTestStore();
  });

  it('splits into one panel per haplotype (a rule, following the view) and pools back', () => {
    store.getState().setViewport('chr3', 1000, 2000);
    const a = store.getState().addPanel('lifted');
    const [pat] = store.getState().splitPanelByLiftHap(a, ['MAT', 'PAT']);
    const panels = store.getState().panels;
    expect(panels.map(p => [p.id, p.liftHap])).toEqual([[a, 'MAT'], [pat, 'PAT']]);
    expect(panels[1].stateKey).toBe(pat);
    expect(panels[1].viewportOverride).toBeUndefined();
    expect(panels[1].readSubset).toBeUndefined();           // no static id membership
    store.getState().poolLiftHapPanels('lifted');
    expect(store.getState().panels.map(p => p.liftHap)).toEqual([undefined]);
  });

  it('a haplotype is part of the panel data key, and lifted requests are never re-projected client side', () => {
    expect(makeDataViewportKey('chr3', 0, 10, 'd', '', '', null, 'MAT')).not.toBe(makeDataViewportKey('chr3', 0, 10, 'd'));
    expect(makeDataViewportKey('chr3', 0, 10, 'd')).toBe('chr3|0|10|d|||');
    const params = new URLSearchParams({ full_working_set: 'true', spanning: 'false', hide_terminal_gaps: 'false',
      terminal_gap_threshold: '0', lift_hap: 'MAT' });
    expect(canProjectReadRegion(params)).toBe(false);
    params.delete('lift_hap');
    expect(canProjectReadRegion(params)).toBe(true);
  });
});

describe('split by default', () => {
  it('a lifted dataset that arrives opens one panel per haplotype once; pooled stays pooled', async () => {
    const { autoSplitNewLiftedDatasets } = await import('./register');
    const { useBrowserStore } = await import('../../stores/browserStore');
    const live = { haplotypes: ['H#2', 'H#1'], haplotype_labels: { 'H#2': 'MAT', 'H#1': 'PAT' }, settings: { haplotype_mode: 'split' } };
    useBrowserStore.setState({ datasets: [{ id: 'lift', label: 'l', path: 'x.bam', color: '#000', data_type: 'bam_livelift', live_lift: live } as never],
      panels: [] });
    useBrowserStore.getState().addPanel('lift');
    const seen = new Set<string>();
    autoSplitNewLiftedDatasets(seen);
    expect(useBrowserStore.getState().panels.map(p => p.liftHap)).toEqual(['MAT', 'PAT']);
    useBrowserStore.getState().poolLiftHapPanels('lift');
    autoSplitNewLiftedDatasets(seen);
    expect(useBrowserStore.getState().panels.map(p => p.liftHap)).toEqual([undefined]);
  });

  it('G8: one haplotype (a strain against its reference): no split; it waits to open as a graph', async () => {
    const { autoSplitNewLiftedDatasets } = await import('./register');
    const open = await import('../graphPanel/openAsGraph');
    const spy = vi.spyOn(open, 'notePendingGraphOpen').mockImplementation(() => undefined);
    const { useBrowserStore } = await import('../../stores/browserStore');
    const live = { haplotypes: ['S#1'], haplotype_labels: { 'S#1': 'strainA' }, settings: { haplotype_mode: 'split' } };
    useBrowserStore.setState({ datasets: [{ id: 'one', label: 'o', path: 'x.bam', color: '#000', data_type: 'bam_livelift', live_lift: live } as never],
      panels: [] });
    useBrowserStore.getState().addPanel('one');
    autoSplitNewLiftedDatasets(new Set());
    expect(useBrowserStore.getState().panels.map(p => p.liftHap)).toEqual([undefined]);
    expect(spy).toHaveBeenCalledWith('one');
    spy.mockRestore();
  });
});

describe('history and sessions', () => {
  it('a lifted dataset keeps its map in history (undo reopens it through the lift route) and panels keep liftHap', async () => {
    const { serializeDataset, serializeState } = await import('../../stores/historySlice');
    const ds = { id: 'l', label: 'l', path: 'a.bam', color: '#000', data_type: 'bam_livelift',
      live_lift: { manifest: '/m.json', haplotypes: ['H#2'], haplotype_labels: {}, settings: { g_split: 20000 }, key: 'k', map_label: 'm' } };
    expect(serializeDataset(ds).live_lift).toEqual({ manifest: '/m.json', haplotypes: ['H#2'], settings: { g_split: 20000 } });
    const { useBrowserStore } = await import('../../stores/browserStore');
    useBrowserStore.setState({ panels: [] });
    const a = useBrowserStore.getState().addPanel('l');
    useBrowserStore.getState().splitPanelByLiftHap(a, ['MAT', 'PAT']);
    const saved = serializeState(useBrowserStore.getState()) as unknown as { panels: Array<{ liftHap?: string }> };
    expect(saved.panels.map(p => p.liftHap)).toEqual(['MAT', 'PAT']);
  });
});
