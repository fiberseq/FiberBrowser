/**
 * fb-n4-integ (Codex integ 1-3): clustering and Sort in "Each panel navigates".
 *
 * 1. A run on a panel's own reference names that reference (panel_genome) and a
 *    locus on it, so gene-conditioned rules use its annotation, not hg38's.
 * 2. An answer is applied only while every clustered panel still shows the
 *    view it was sent for (its locus, reference and state key), not only
 *    while the stale main locus is unchanged.
 * 3. Sort groups its requests per panel view (locus and reference), with that
 *    view's peaks, instead of skipping panels that moved on their own.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clusterAllReads } from '../../api/clustering';
import { filterReadsByAnalysisRule, sortReads } from '../../api/readOperations';
import { scanPeaks } from '../../api/peaks';
import type { FirePeak, PanelConfig } from '../../types';
import { annotationRegionScopes } from '../../components/controls/annotation-panel/annotationScopes';
import { filterRegionGroups, groupStillShown } from '../filterScopes';
import { captureRunViews, clusterRequestLocus, runViewsStillCurrent } from '../panelRunScope';
import { sortViewGroups } from '../sortScope';

const panel = (id: string, datasetId: string, over: Partial<PanelConfig> = {}) =>
  ({ id, contentType: 'dataset', datasetId, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, ...over }) as PanelConfig;

// The main locus is stale (Per panel): both panels have their own.
const MAIN = { chrom: 'chr19', start: 47_514_037, end: 47_518_985 };
const HUMAN = { chrom: 'chr19', start: 47_514_262, end: 47_519_210 };
const FLY = { chrom: 'chr2L', start: 6_356_793, end: 6_357_648 };
const base = () => ({
  ...MAIN, currentGenome: 'hg38', fastaPath: null,
  panels: [panel('ph', 'napa', { viewportOverride: { ...HUMAN } }), panel('pf', 'flyamp', { genome: 'dm6', viewportOverride: { ...FLY } })],
});

const stubFetch = (json: unknown) => {
  const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, json: async () => json }) as Response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};
const query = (fetchMock: ReturnType<typeof stubFetch>) => new URL(String(fetchMock.mock.calls[0][0]), 'http://x.test').searchParams;

afterEach(() => vi.unstubAllGlobals());

describe('1. clustering on a panel\'s own reference', () => {
  it('sends panel_genome, so the server reads that reference (and its genes)', async () => {
    const fetchMock = stubFetch({ results: {} });
    await clusterAllReads(FLY.chrom, FLY.start, FLY.end, [{ start: 6_356_930, end: 6_357_166 }], 4, false, ['flyamp'],
      'kmeans', undefined, undefined, 90, 0.5, undefined, undefined, undefined, undefined, { panelGenome: 'dm6' });
    expect(query(fetchMock).get('panel_genome')).toBe('dm6');
  });

  it('names the first window\'s locus on that reference (the main locus is an hg38 chromosome)', () => {
    expect(clusterRequestLocus(MAIN, [{ ...FLY }], 'dm6')).toEqual(FLY);
    expect(clusterRequestLocus(MAIN, [{ ...HUMAN }], null)).toEqual(MAIN);
  });

  it('Sort and Filter requests send panel_genome too', async () => {
    let fetchMock = stubFetch({ results: {} });
    await sortReads(FLY.chrom, FLY.start, FLY.end, false, ['flyamp'], 'similarity', { panelGenome: 'dm6' });
    expect(query(fetchMock).get('panel_genome')).toBe('dm6');
    fetchMock = stubFetch({ results: {} });
    await filterReadsByAnalysisRule(FLY.chrom, FLY.start, FLY.end, false, ['flyamp'], { metric: 'count', operator: '>=', threshold: 1, panelGenome: 'dm6' });
    expect(query(fetchMock).get('panel_genome')).toBe('dm6');
    // A panel's own peak scan too.
    fetchMock = stubFetch({ peaks: [] });
    await scanPeaks(FLY.chrom, FLY.start, FLY.end, 80, 5, undefined, undefined, undefined, undefined, undefined, 'accessibility', false, undefined, ['flyamp'], undefined, 'dm6');
    expect(query(fetchMock).get('panel_genome')).toBe('dm6');
  });
});

describe('2. a pending clustering checks every clustered panel', () => {
  it('a panel moved to another locus (the main locus unchanged) drops the answer', () => {
    const s = base();
    const views = captureRunViews(s, ['napa', 'flyamp']);
    expect(views.map(v => [v.panelId, v.chrom, v.start])).toEqual([['ph', 'chr19', HUMAN.start], ['pf', 'chr2L', FLY.start]]);
    expect(runViewsStillCurrent(views, s, 'panOrZoom')).toBe(true);
    const moved = { ...s, panels: s.panels.map(p => (p.id === 'pf' ? { ...p, viewportOverride: { chrom: 'chr3R', start: 1, end: 900 } } : p)) };
    expect(runViewsStillCurrent(views, moved, 'panOrZoom')).toBe(false);
  });

  it('a pan or zoom keeps it (navigation keeps the clusters then too); another reference, state key or a closed panel drops it', () => {
    const s = base();
    const views = captureRunViews(s, ['napa']);
    const pan = { ...s, panels: s.panels.map(p => (p.id === 'ph' ? { ...p, viewportOverride: { ...HUMAN, start: HUMAN.start + 200, end: HUMAN.end + 200 } } : p)) };
    expect(runViewsStillCurrent(views, pan, 'panOrZoom')).toBe(true);
    expect(runViewsStillCurrent(views, pan, 'exact')).toBe(false);
    const otherRef = { ...s, panels: s.panels.map(p => (p.id === 'ph' ? { ...p, genome: 'hs1' } : p)) };
    expect(runViewsStillCurrent(views, otherRef, 'panOrZoom')).toBe(false);
    const otherKey = { ...s, panels: s.panels.map(p => (p.id === 'ph' ? { ...p, stateKey: 'napa:copy' } : p)) };
    expect(runViewsStillCurrent(views, otherKey, 'panOrZoom')).toBe(false);
    expect(runViewsStillCurrent(views, { ...s, panels: s.panels.filter(p => p.id !== 'ph') }, 'panOrZoom')).toBe(false);
    // Another main FASTA under the same panel: another reference.
    const mainViews = captureRunViews({ ...s, panels: [panel('pm', 'napa')] }, ['napa']);
    expect(runViewsStillCurrent(mainViews, { ...s, panels: [panel('pm', 'napa')], currentGenome: 'hs1' })).toBe(false);
  });
});

describe('3. Sort groups its requests per panel view', () => {
  const peaks = [
    { index: 0, start: 47_515_000, end: 47_515_100 },
    { index: 1, start: 6_356_930, end: 6_357_166, chrom: 'chr2L', genome: 'dm6' },
    { index: 2, start: 47_600_000, end: 47_600_100, chrom: 'chr19' },
  ] as FirePeak[];

  it('a panel moved on its own is sorted at its locus, on its reference, with its peaks (not skipped)', () => {
    const s = base();
    const groups = sortViewGroups({
      stateKeys: ['napa', 'flyamp'], stateKeyToDs: { napa: 'napa', flyamp: 'flyamp' }, panels: s.panels, main: MAIN,
      allPeaks: peaks, selectedPeaks: [0, 1], peakModes: {}, selectedGenes: [],
    });
    expect(groups.map(g => [g.chrom, g.start, g.end, g.genome ?? null, g.datasetIds, g.peaks.map(p => p.index)])).toEqual([
      ['chr19', HUMAN.start, HUMAN.end, null, ['napa'], [0]],
      ['chr2L', FLY.start, FLY.end, 'dm6', ['flyamp'], [1]],
    ]);
  });

  it('the main view keeps its chromosome\'s peaks; a dm6 peak never joins an hg38 view', () => {
    const groups = sortViewGroups({
      stateKeys: ['napa'], stateKeyToDs: { napa: 'napa' }, panels: [panel('pm', 'napa')], main: MAIN,
      allPeaks: [...peaks, { index: 3, start: 10, end: 20, chrom: 'chr19', genome: 'dm6' } as FirePeak], selectedPeaks: [], peakModes: {}, selectedGenes: [],
    });
    expect(groups.map(g => [g.main, g.peaks.map(p => p.index)])).toEqual([[true, [0, 2]]]);
  });

  it('Filter and annotation groups keep panels on two references apart, even at the same coordinates', () => {
    const same = { chrom: 'chrX', start: 100, end: 900 };
    const panels = [panel('a', 'hs', { viewportOverride: { ...same } }), panel('b', 'mm', { genome: 'mm10', viewportOverride: { ...same } })];
    const scopes = annotationRegionScopes(['hs', 'mm'], { hs: 'hs', mm: 'mm' }, panels, MAIN);
    expect(scopes.map(g => [g.genome ?? null, g.datasetIds])).toEqual([[null, ['hs']], ['mm10', ['mm']]]);
    const groups = filterRegionGroups({
      stateKeys: ['hs', 'mm'], stateKeyToDs: { hs: 'hs', mm: 'mm' }, panels, main: MAIN, rule: { scope: { kind: 'currentWindow' } },
      allPeaks: [{ index: 0, start: 200, end: 300, chrom: 'chrX', genome: 'mm10' } as FirePeak], selectedPeaks: [], peakModes: {}, selectedGenes: [],
    });
    expect(groups.map(g => g.peakRegions)).toEqual([[], [[200, 300]]]);
    // A panel now on another reference no longer shows the group's view.
    expect(groupStillShown(groups[1], panels, MAIN)).toBe(true);
    expect(groupStillShown(groups[1], [panels[0], { ...panels[1], genome: 'mm39' }], MAIN)).toBe(false);
  });
});
