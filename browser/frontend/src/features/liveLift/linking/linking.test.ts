import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../../stores/browserStore';
import { usePanelGenomeStore } from '../../../stores/panelGenomeStore';
import { inComparisonGroup, inGenomeLinkGroup, linkGroupPeers, matchablePanels } from '../../../utils/panelNavigation';
import { panelReversed } from '../../../hooks/usePanelDisplayStore';
import { useLiveLiftStore } from '../store';
import type { PanelConfig } from '../../../types';
import {
  decodeTile, indexOutline, mapSpan, outlineLookup, prefetchView, resetNavigation, setNavigationFetcher, tileLookup,
  type LiftSummary, type OutlineRow,
} from './navigation';
import { applyCorrections, jumpLinkedSource, linkGeneration, liftViewLink, pendingCorrection, registerLiftLinking, toggleLinkFlip } from './liftLink';

// The toy map of tests/live_lift_fixtures.py: target chrT; MAT chain 0 '+' with a 10 bp target-only gap at 4000 and a
// 100 bp source insertion at target 6010; MAT chain 1 '-' (t 12000-14000 <-> q 7000-9000); PAT chain 2 '+'.
const MAT = 'chrS_MATERNAL', PAT = 'chrS_PATERNAL';
type Piece = [number, number, number, number, '+' | '-', number];
const PIECES: Piece[] = [[1000, 4000, 0, 3000, '+', 0], [4010, 6010, 3000, 5000, '+', 0], [6010, 7900, 5100, 6990, '+', 0],
  [12000, 14000, 7000, 9000, '-', 1], [15000, 19000, 0, 4000, '+', 2]];
const SOURCE_OF = [MAT, MAT, PAT];
const SUMMARY: LiftSummary = {
  key: 'k1', tile_bp: 1_000_000, outline_max_drift: 1000, haplotypes: ['H#1', 'H#2'], labels: { 'H#1': 'MAT', 'H#2': 'PAT' },
  sources: { [MAT]: 'H#1', [PAT]: 'H#2' }, targets: { chrT: 20_000 }, selected: [true, true, true],
  chains: [['chrT', 1000, 7900, MAT, 0, 6990, '+', 'H#1', 6900, 6890], ['chrT', 12000, 14000, MAT, 7000, 9000, '-', 'H#1', 2000, 2000],
    ['chrT', 15000, 19000, PAT, 0, 4000, '+', 'H#2', 4000, 4000]],
};
const TARGET_OUTLINE: OutlineRow[] = [[1000, 7900, 0, 6990, '+', 0, 90], [12000, 14000, 7000, 9000, '-', 1, 0], [15000, 19000, 0, 4000, '+', 2, 0]];

// services/lift/navigation.py encode_tile, for the tests.
function uvarint(n: number, out: number[]) { while (n >= 0x80) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } out.push(n); }
const zz = (n: number) => (n >= 0 ? n * 2 : -n * 2 - 1);
function encodeTile(pieces: Piece[], side: 0 | 1, tile: number): Uint8Array {
  const runs = pieces.map(p => (side ? [p[2], p[3], p[0], p[5], p[4]] : [p[0], p[1], p[2], p[5], p[4]]) as [number, number, number, number, string])
    .sort((a, b) => a[0] - b[0] || a[3] - b[3]);
  const out = [0x47, 0x4c, 0x54, 0x31, side];
  uvarint(tile, out); uvarint(runs.length, out);
  let prevEnd = tile * 1_000_000, prevOther = 0;
  for (const [s, e, o, c, strand] of runs) {
    uvarint(zz(s - prevEnd), out); uvarint(e - s, out); uvarint(zz(o - prevOther), out); uvarint(c * 2 + (strand === '-' ? 1 : 0), out);
    prevEnd = e; prevOther = o;
  }
  return new Uint8Array(out);
}

interface Deferred { url: string; resolve: () => void }
let deferred: Deferred[] = [];
let holdTiles = false;
function installFetcher() {
  deferred = [];
  setNavigationFetcher({
    json: async url => {
      if (url.startsWith('/api/lift/summary')) return SUMMARY;
      if (url.includes('chrom=chrT')) return { rows: TARGET_OUTLINE };
      if (url.includes(`source=${MAT}`)) return { rows: TARGET_OUTLINE.filter(r => SOURCE_OF[r[5]] === MAT).map(r => [...r, 'chrT']) };
      throw new Error(`unexpected ${url}`);
    },
    bytes: url => {
      const side = url.includes('side=source') ? 1 : 0;
      const contig = new URL(url, 'http://x').searchParams.get('contig')!;
      const pieces = side ? PIECES.filter(p => SOURCE_OF[p[5]] === contig) : PIECES;
      const bytes = encodeTile(pieces, side, 0);
      if (!holdTiles) return Promise.resolve(bytes);
      return new Promise(resolve => deferred.push({ url, resolve: () => resolve(bytes) }));
    },
  });
}
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); await new Promise(r => setTimeout(r, 0)); };

describe('navigation tables', () => {
  it('decodes tiles and looks up both directions, including a - piece', () => {
    const target = decodeTile(encodeTile(PIECES, 0, 0));
    expect(tileLookup(target, 12_000)).toEqual([{ chain: 1, pos: 8999 }]);
    expect(tileLookup(target, 4005)).toEqual([]);                   // the target-only gap
    expect(tileLookup(target, 15_100)).toEqual([{ chain: 2, pos: 100 }]);
    const source = decodeTile(encodeTile(PIECES.filter(p => p[5] < 2), 1, 0));
    expect(tileLookup(source, 8999)).toEqual([{ chain: 1, pos: 12_000 }]);
    expect(tileLookup(source, 5050)).toEqual([]);                    // the source insertion
  });
  it('outline lookups stay within the drift bound', () => {
    const idx = indexOutline(TARGET_OUTLINE, 0);
    const [hit] = outlineLookup(idx, 6500);
    expect(hit.chain).toBe(0);
    expect(Math.abs(hit.pos - 5590)).toBeLessThanOrEqual(hit.drift);   // exact: 5100 + 490
    expect(outlineLookup(indexOutline(TARGET_OUTLINE, 1), 8999).map(h => [h.chain, h.pos])).toContainEqual([1, 12_000]);
  });
});

describe('span mapping', () => {
  beforeEach(() => { resetNavigation(); holdTiles = false; installFetcher(); });
  afterEach(() => setNavigationFetcher(null));
  it('is pending until the outline arrives, approximate on the outline, exact with the tile', async () => {
    expect(mapSpan('lift', 'k1', 'toSource', { chrom: 'chrT', start: 5000, end: 7000 }, { hap: 'H#1' }).status).toBe('pending');
    holdTiles = true;
    await flush();
    expect(mapSpan('lift', 'k1', 'toSource', { chrom: 'chrT', start: 5000, end: 7000 }, { hap: 'H#1' }).status).toBe('pending');
    await flush();
    const approx = mapSpan('lift', 'k1', 'toSource', { chrom: 'chrT', start: 5000, end: 7000 }, { hap: 'H#1' });
    expect(approx.status).toBe('mapped');
    if (approx.status === 'mapped') expect(approx.mapping.exact).toBe(false);
    for (const d of deferred) d.resolve();
    await flush();
    const exact = mapSpan('lift', 'k1', 'toSource', { chrom: 'chrT', start: 5000, end: 7000 }, { hap: 'H#1' });
    // The 100 bp source insertion inside the view widens the source span (4010 -> 3000 ... 6999 -> 6089).
    expect(exact).toEqual({ status: 'mapped', mapping: expect.objectContaining({ chrom: MAT, start: 3990, end: 6090, chain: 0, minus: false, exact: true }) });
  });
  it('maps a - correspondence crossed, never through the other haplotype', async () => {
    await prefetchView('lift', 'k1', 0, 'chrT', 0, 20_000);
    const minus = mapSpan('lift', 'k1', 'toSource', { chrom: 'chrT', start: 12_500, end: 13_000 }, { hap: 'H#1' });
    expect(minus).toEqual({ status: 'mapped', mapping: expect.objectContaining({ chrom: MAT, start: 8000, end: 8500, minus: true, exact: true }) });
    // PAT-only stretch: MAT has nothing there, and its nearest MAT stretch is far away.
    expect(mapSpan('lift', 'k1', 'toSource', { chrom: 'chrT', start: 16_000, end: 16_500 }, { hap: 'H#1' })).toEqual({ status: 'none' });
    // Inside the 10 bp target-only gap of chain 0 the view still follows that chain.
    expect(mapSpan('lift', 'k1', 'toSource', { chrom: 'chrT', start: 4002, end: 4008 }, { hap: 'H#1' }))
      .toEqual({ status: 'mapped', mapping: expect.objectContaining({ chrom: MAT, chain: 0 }) });
    const patOwn = mapSpan('lift', 'k1', 'toSource', { chrom: 'chrT', start: 16_000, end: 16_500 }, { hap: 'H#2' });
    expect(patOwn).toEqual({ status: 'mapped', mapping: expect.objectContaining({ chrom: PAT, start: 1000, end: 1500 }) });
  });
  it('maps a source view back to the target, and a view inside the insertion to its boundary', async () => {
    await prefetchView('lift', 'k1', 1, MAT, 0, 10_000);
    const back = mapSpan('lift', 'k1', 'toTarget', { chrom: MAT, start: 3990, end: 6090 });
    expect(back).toEqual({ status: 'mapped', mapping: expect.objectContaining({ chrom: 'chrT', start: 5000, end: 7000, exact: true }) });
    const inside = mapSpan('lift', 'k1', 'toTarget', { chrom: MAT, start: 5010, end: 5090 });
    expect(inside.status).toBe('mapped');
  });
});

// ── The link in the browser store ──────────────────────────────────────────

const liftPanel: PanelConfig = { id: 'mat', contentType: 'dataset', datasetId: 'lift', subTracks: [], collapsed: false, linkGroup: null, liftHap: 'MAT' } as PanelConfig;
const sourcePanel = (): PanelConfig => ({ id: 'src', contentType: 'dataset', datasetId: 'native', subTracks: [], collapsed: false, linkGroup: null,
  genome: 'contigs:native', viewportOverride: { chrom: MAT, start: 1000, end: 2000 },
  liftLink: { id: 'L1', datasetId: 'lift', liftPanelId: 'mat', hap: 'H#1', hapLabel: 'MAT', contig: MAT, flip: false, chain: null } } as PanelConfig);

describe('liftViewLink', () => {
  beforeEach(async () => {
    resetNavigation(); holdTiles = false; installFetcher();
    registerLiftLinking();
    useLiveLiftStore.setState({ enabled: true });
    usePanelGenomeStore.setState({ genomes: { 'contigs:native': { key: 'contigs:native', chroms: [{ name: MAT, size: 10_000 }, { name: PAT, size: 10_000 }] } as never }, assignments: { native: 'contigs:native' } });
    useBrowserStore.setState({ chrom: 'chrT', start: 2000, end: 3000, navigationMode: 'linked', isReversed: false,
      datasets: [{ id: 'lift', path: '/s.bam', label: 'lift', color: '#000', data_type: 'bam_livelift', live_lift: { key: 'k1', haplotypes: ['H#1', 'H#2'], haplotype_labels: { 'H#1': 'MAT', 'H#2': 'PAT' } } } as never,
        { id: 'native', path: '/s.bam', label: 'native', color: '#000', data_type: 'bam' }],
      panels: [liftPanel, sourcePanel()] });
    await prefetchView('lift', 'k1', 0, 'chrT', 0, 20_000);
    await prefetchView('lift', 'k1', 1, MAT, 0, 10_000);
  });
  afterEach(() => setNavigationFetcher(null));
  const src = () => useBrowserStore.getState().panels.find(p => p.id === 'src')!;
  const main = () => { const s = useBrowserStore.getState(); return { chrom: s.chrom, start: s.start, end: s.end }; };

  it('a main-view move moves the source panel, which does not move the main view back', () => {
    const toMain = vi.spyOn(liftViewLink, 'toMain');
    useBrowserStore.getState().setViewport('chrT', 5000, 7000);
    expect(src().viewportOverride).toEqual({ chrom: MAT, start: 3990, end: 6090 });
    expect(main()).toEqual({ chrom: 'chrT', start: 5000, end: 7000 });
    expect(toMain).not.toHaveBeenCalled();
    toMain.mockRestore();
  });
  it('a source-panel move moves the main view, which does not move the source panel back', () => {
    const toPanel = vi.spyOn(liftViewLink, 'toPanel');
    useBrowserStore.getState().setPanelViewport('src', 3990, 6090);
    expect(main()).toEqual({ chrom: 'chrT', start: 5000, end: 7000 });
    expect(src().viewportOverride).toEqual({ chrom: MAT, start: 3990, end: 6090 });
    // withViewLinks skips the moving panel: its own view is kept exactly as the user left it.
    expect(toPanel.mock.calls.every(([p]) => p.id !== 'src')).toBe(true);
    toPanel.mockRestore();
  });
  it('an exact tile corrects only the source panel, once; a stale correction is dropped', async () => {
    resetNavigation(); holdTiles = true; installFetcher();
    useBrowserStore.getState().setViewport('chrT', 5000, 7000);       // summary pending: the panel stays
    await flush();
    useBrowserStore.getState().setViewport('chrT', 5000, 7001);       // outline only: approximate, tile pending
    const approx = src().viewportOverride;
    expect(approx?.chrom).toBe(MAT);
    const c = pendingCorrection('src');
    expect(c).toMatchObject({ kind: 'panel', chrom: 'chrT', linkId: 'L1', gen: linkGeneration('src') });
    const before = main();
    const setViewport = vi.spyOn(useBrowserStore.getState(), 'setViewport');
    for (const d of deferred.splice(0)) d.resolve();
    await flush();
    expect(src().viewportOverride).toEqual({ chrom: MAT, start: 3990, end: 6091 });
    expect(main()).toEqual(before);
    expect(setViewport).not.toHaveBeenCalled();
    expect(pendingCorrection('src')).toBeUndefined();
    setViewport.mockRestore();
  });
  it('drops a correction whose generation, link or chromosome changed', async () => {
    for (const change of ['jump', 'link', 'chrom'] as const) {
      resetNavigation(); holdTiles = true; installFetcher();
      useBrowserStore.setState({ chrom: 'chrT', start: 2000, end: 3000, panels: [liftPanel, sourcePanel()] });
      useBrowserStore.getState().setViewport('chrT', 5000, 7001);
      await flush();
      useBrowserStore.getState().setViewport('chrT', 5000, 7000);
      await flush();
      useBrowserStore.getState().setViewport('chrT', 5000, 7002);
      expect(pendingCorrection('src')).toBeDefined();
      if (change === 'jump') jumpLinkedSource('src', { contig: MAT, start: 100, end: 200 });
      if (change === 'link') useBrowserStore.setState(s => ({ panels: s.panels.map(p => p.id === 'src' ? { ...p, liftLink: { ...p.liftLink!, id: 'L2' } } : p) }));
      if (change === 'chrom') useBrowserStore.setState({ chrom: 'chrOther' });
      const kept = src().viewportOverride;
      for (const d of deferred.splice(0)) d.resolve();
      await flush();
      applyCorrections('lift');
      expect(src().viewportOverride).toEqual(kept);
      expect(pendingCorrection('src')).toBeUndefined();
    }
  });
  it('leaves its reference link group and is drawn relative to the main orientation', () => {
    const p = src();
    expect(inComparisonGroup(p)).toBe(true);
    expect(inGenomeLinkGroup(p)).toBe(false);
    const peer = { ...p, id: 'peer', liftLink: undefined } as PanelConfig;
    expect(linkGroupPeers([p, peer], p, 'linked')).toEqual(['src']);
    expect(matchablePanels([p, peer], peer).map(x => x.id)).not.toContain('src');
    const state = useBrowserStore.getState();
    expect(panelReversed(state, 'src')).toBe(false);
    toggleLinkFlip('src');
    expect(panelReversed(useBrowserStore.getState(), 'src')).toBe(true);
    useBrowserStore.setState({ isReversed: true });
    expect(panelReversed(useBrowserStore.getState(), 'src')).toBe(false);
  });
  it('a - correspondence maps crossed and the flag off unlinks', () => {
    useBrowserStore.getState().setViewport('chrT', 12_500, 13_000);
    expect(src().viewportOverride).toEqual({ chrom: MAT, start: 8000, end: 8500 });
    useLiveLiftStore.setState({ enabled: false });
    expect(liftViewLink.toPanel(src(), { chrom: 'chrT', start: 0, end: 10 })).toBeUndefined();
  });
  it('a restored link with no navigation data loads summary, outline and tile, then ends exact without moving main', async () => {
    resetNavigation(); holdTiles = false; installFetcher();
    useBrowserStore.setState({ chrom: 'chrT', start: 2000, end: 3000, panels: [liftPanel, sourcePanel()] });
    const before = src().viewportOverride;
    useBrowserStore.getState().setViewport('chrT', 5000, 7000);
    expect(src().viewportOverride).toEqual(before);                    // nothing loaded: it stays
    expect(pendingCorrection('src')?.kind).toBe('panel');
    for (let i = 0; i < 5; i++) await flush();
    expect(src().viewportOverride).toEqual({ chrom: MAT, start: 3990, end: 6090 });
    expect(main()).toEqual({ chrom: 'chrT', start: 5000, end: 7000 });
    expect(pendingCorrection('src')).toBeUndefined();
  });
  it('a source-panel move on a cold cache keeps the span the user moved to; the tile corrects the main view', async () => {
    resetNavigation(); holdTiles = true; installFetcher();
    useBrowserStore.setState({ chrom: 'chrT', start: 2000, end: 3000, panels: [liftPanel, sourcePanel()] });
    useBrowserStore.getState().setViewport('chrT', 2000, 3001);
    await flush(); useBrowserStore.getState().setViewport('chrT', 2000, 3000); await flush();
    // Source outline: the panel's move maps approximately at first.
    useBrowserStore.getState().setPanelViewport('src', 3990, 6091); await flush();
    useBrowserStore.getState().setPanelViewport('src', 3990, 6090);
    expect(pendingCorrection('src')?.kind).toBe('main');
    for (const d of deferred.splice(0)) d.resolve();
    for (let i = 0; i < 4; i++) await flush();
    expect(src().viewportOverride).toEqual({ chrom: MAT, start: 3990, end: 6090 });
    expect(main()).toEqual({ chrom: 'chrT', start: 5000, end: 7000 });
  });
});
