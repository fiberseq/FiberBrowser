/**
 * Group by read groups (split panels), selected classes, and None for size plots:
 * - split panels become groups with their reads; nothing split says why;
 * - selected classes become groups of member reads ('1' in the feature states), overlapping allowed;
 * - profile/heatmap reads go to each group they belong to;
 * - size plots ask once per group (its reads as cluster 0) and None asks the server to pool.
 */
import '../testSetup';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ fetchFootprintSizes: vi.fn(), fetchJson: vi.fn(), getFeatureStates: vi.fn() }));
vi.mock('../../api/clustering', async importOriginal => ({ ...(await importOriginal<typeof import('../../api/clustering')>()), fetchFootprintSizes: api.fetchFootprintSizes }));
vi.mock('../../api/sharedFetch', async importOriginal => ({ ...(await importOriginal<typeof import('../../api/sharedFetch')>()), fetchJson: api.fetchJson }));
vi.mock('../../api/features', async importOriginal => ({ ...(await importOriginal<typeof import('../../api/features')>()), getFeatureStates: api.getFeatureStates }));
vi.mock('../../components/charts/SizeEnrichmentChart', () => ({
  drawSizeEnrichment: () => {},
  SizeEnrichmentChart: ({ title, testId }: { title: string; testId: string }) => <div data-testid={testId}>{title}</div>,
}));

import { useBrowserStore } from '../../stores/browserStore';
import { useSplitPanelStore } from '../../stores/splitPanelStore';
import { useReadGroups, type ReadGroupDef } from './readGroups';
import { fetchEngineReads } from './useProfileData';
import { SizePlot } from './SizePlot';
import { newPlot, type PlotGroupBy } from './plotModel';

const matrix = (n: number) => ({ matrix: [[1, 2]], size_min: 10, size_max: 20, size_bin: 10, pos_bin: 10, mode: 'span', normalization: 'row', row_min_footprints: 20, sigma_size_bp: 0, sigma_pos_bp: 0, group_by: 'cluster', n_reads: n, n_footprints: n });
const target = { chrom: 'chrT', start: 1000, end: 1020, genome: null, panels: [{ key: 'p1', datasetId: 'd1', label: 'D1', datasetLabel: 'D1' }] };

describe('useReadGroups', () => {
  let container: HTMLDivElement;
  let root: Root;
  let seen: ReturnType<typeof useReadGroups>;
  function Probe({ by }: { by: PlotGroupBy }) { seen = useReadGroups(by); return null; }
  beforeEach(() => { container = document.createElement('div'); root = createRoot(container); });
  afterEach(() => act(() => root.unmount()));

  it('split panels: one group per split panel with its reads; nothing split says why', async () => {
    useBrowserStore.setState({ panels: [] } as never);
    act(() => root.render(<Probe by="read-groups" />));
    expect(seen.groups).toEqual([]);
    expect(seen.blocker).toMatch(/split a dataset/i);
    useBrowserStore.setState({ panels: [
      { id: 'a', contentType: 'dataset', datasetId: 'd1', stateKey: 'd1#A', subTracks: [], readSubset: { groupId: 'g', label: 'Carriers', colour: '#f00', count: 2, sourcePanelId: 'p', rule: { kind: 'frozen', datasetId: 'd1', groupKeys: [] } } },
      { id: 'b', contentType: 'dataset', datasetId: 'd1', stateKey: 'd1#B', subTracks: [], readSubset: { groupId: 'g', label: 'Reference', colour: '#00f', count: 1, sourcePanelId: 'p', rule: { kind: 'frozen', datasetId: 'd1', groupKeys: [] } } },
    ] } as never);
    useSplitPanelStore.setState({ reads: { 'd1#A': { ids: new Set(['r1', 'r2']), state: 'ready' }, 'd1#B': { ids: new Set(['r3']), state: 'ready' } } });
    act(() => root.render(<Probe by="read-groups" />));
    expect(seen.groups.map(g => [g.title, [...g.members.d1]])).toEqual([['Carriers', ['r1', 'r2']], ['Reference', ['r3']]]);
    expect(seen.signature).toBe('d1#A:d1=2;d1#B:d1=1');
  });

  it('selected classes: members per class from the feature states (a read can be in two)', async () => {
    useBrowserStore.setState({ selectedFeatures: [{ kind: 'fp-class', source: 's', id: 'c1', datasetId: 'd1' }, { kind: 'fp-class', source: 's', id: 'c2', datasetId: 'd1' }] } as never);
    api.getFeatureStates.mockResolvedValue({
      features: [{ kind: 'fp-class', source: 's', id: 'c1', dataset_id: 'd1', label: 'Class 1' }, { kind: 'fp-class', source: 's', id: 'c2', dataset_id: 'd1', label: 'Class 2' }],
      by_dataset: { d1: { r1: '11', r2: '10', r3: '0.' } },
    });
    await act(async () => { root.render(<Probe by="classes" />); });
    await act(async () => { await Promise.resolve(); });
    expect(seen.groups.map(g => [g.title, [...g.members.d1].sort()])).toEqual([['Class 1', ['r1', 'r2']], ['Class 2', ['r1']]]);
  });
});

describe('reads into groups', () => {
  it('profile / heatmap reads go to each group they belong to', async () => {
    api.fetchJson.mockResolvedValue({ reads: [
      { id: 'r1', aligned_blocks: [[1000, 1020]], layers: { nuc: { intervals: [[0, 10, 10]] } } },
      { id: 'r2', aligned_blocks: [[1000, 1020]], layers: { nuc: { intervals: [[10, 20, 10]] } } },
    ] });
    const groups: ReadGroupDef[] = [
      { id: 'A', title: 'A', color: '#f00', members: { d1: new Set(['r1', 'r2']) } },
      { id: 'B', title: 'B', color: '#00f', members: { d1: new Set(['r1']) } },
    ];
    const r = await fetchEngineReads({ source: 'nuc', region: { chrom: 'chrT', start: 1000, end: 1020 }, panels: target.panels, clusters: null, groupBy: 'groups', readGroups: groups, readCap: 100, sampleSeed: 's' });
    expect(r.groups.map(g => g.title)).toEqual(['A', 'B']);
    expect(r.reads.map(x => x.group)).toEqual(['A|g', 'A|g', 'B|g']);
  });
});

describe('windows before the contig start', () => {
  it('a window starting below 0 fetches from 0 and places reads relative to the fetch', async () => {
    api.fetchJson.mockReset();
    api.fetchJson.mockResolvedValue({ reads: [{ id: 'r1', aligned_blocks: [[0, 80]], layers: { nuc: { intervals: [[10, 40, 30]] } } }] });
    const r = await fetchEngineReads({ source: 'nuc', region: { chrom: 'chrT', start: -50, end: 150 }, panels: target.panels, clusters: null, groupBy: 'none', readCap: 100, sampleSeed: 's' });
    expect(String(api.fetchJson.mock.calls[0][0])).toContain('start=0&');
    expect(r.reads[0].intervals).toEqual([[10, 40, 30]]);
  });
});

describe('size plots by read group and pooled', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => { vi.useFakeTimers(); api.fetchFootprintSizes.mockReset(); container = document.createElement('div'); root = createRoot(container); });
  afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); });
  const flush = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(200); }); };

  it('one request per group, its reads as cluster 0; one plot per group', async () => {
    api.fetchFootprintSizes.mockImplementation((_c: string, _s: number, _e: number, o: { clusterAssignments: Record<string, Record<string, number>> }) =>
      Promise.resolve({ success: true, data: { d1: { 0: matrix(Object.keys(o.clusterAssignments.d1).length) } } }));
    const groups: ReadGroupDef[] = [
      { id: 'A', title: 'Carriers', color: '#f00', members: { d1: new Set(['r1', 'r2']) } },
      { id: 'B', title: 'Reference', color: '#00f', members: { d1: new Set(['r3']) } },
    ];
    act(() => { root.render(<SizePlot plot={newPlot({ groupBy: 'read-groups' })} target={target} clusters={null} pending={false} width={600} readGroups={groups} groupsSig="A2B1" />); });
    await flush();
    expect(api.fetchFootprintSizes).toHaveBeenCalledTimes(2);
    expect(api.fetchFootprintSizes.mock.calls[0][3]).toMatchObject({ groupBy: 'cluster', clusterAssignments: { d1: { r1: 0, r2: 0 } }, datasetIds: ['d1'] });
    const titles = [...container.querySelectorAll('[data-testid="plots-size-panel"]')].map(e => e.textContent);
    expect(titles).toEqual(['Carriers', 'Reference']);
    expect(container.textContent).toContain('2 reads');
  });

  it('None pools: one pooled request, one plot "All datasets"', async () => {
    api.fetchFootprintSizes.mockResolvedValue({ success: true, data: { __pooled__: { '-1': matrix(9) } } });
    const t2 = { ...target, panels: [...target.panels, { key: 'p2', datasetId: 'd2', label: 'D2' }] };
    act(() => { root.render(<SizePlot plot={newPlot({ groupBy: 'none' })} target={t2} clusters={null} pending={false} width={600} />); });
    await flush();
    expect(api.fetchFootprintSizes).toHaveBeenCalledTimes(1);
    expect(api.fetchFootprintSizes.mock.calls[0][3]).toMatchObject({ groupBy: 'pooled', datasetIds: ['d1', 'd2'] });
    expect([...container.querySelectorAll('[data-testid="plots-size-panel"]')].map(e => e.textContent)).toEqual(['All datasets']);
  });
});

import { useProfileData, type ProfileEntry } from './useProfileData';

describe('metaprofile pooled over selected features', () => {
  it('reads each feature window and adds the raw profiles (centred, one group per dataset)', async () => {
    vi.useFakeTimers();
    api.fetchJson.mockReset().mockImplementation((url: string) => {
      const start = Number(new URL(url, 'http://x').searchParams.get('start'));
      // Feature 1: a footprint over the left half; feature 2: over the whole window.
      const half = start === 1000;
      return Promise.resolve({ reads: [{ id: `r${start}`, aligned_blocks: [[start, start + 100]], layers: { nuc: { intervals: [[0, half ? 50 : 100, half ? 50 : 100]] } } }] });
    });
    let seen: { entry: ProfileEntry | null } = { entry: null };
    function Probe() {
      seen = useProfileData({
        plot: newPlot({ type: 'metaprofile', where: 'features', source: 'nuc', profile: { binBp: 50, sigmaBp: 0, normalization: 'fraction', minCoverage: 0, readCap: 10 } }),
        target, clusters: null, sampleSeed: 's', settingsKey: '', enabled: true,
        features: [
          { id: 'f1', label: 'f1', chrom: 'chrT', start: 1000, end: 1100, genome: null },
          { id: 'f2', label: 'f2', chrom: 'chrT', start: 5000, end: 5100, genome: null },
        ],
      });
      return null;
    }
    const c = document.createElement('div');
    const r = createRoot(c);
    act(() => r.render(<Probe />));
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    const g = seen.entry!.groups[0];
    expect(Array.from(g.raw.coverage)).toEqual([2, 2]);
    expect(Array.from(g.raw.signal)).toEqual([2, 1]);
    expect(g.raw.nReads).toBe(2);
    act(() => r.unmount());
    vi.useRealTimers();
  });
});
