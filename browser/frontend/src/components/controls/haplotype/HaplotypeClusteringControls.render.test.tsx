import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../../stores/browserStore';
import { HaplotypeClusteringControls } from './HaplotypeClusteringControls';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const hapPanel = (id: string, datasetId: string, side: 1 | 2, chrom: string) => ({
  id, contentType: 'dataset', datasetId, subTracks: [], collapsed: false, linkGroup: null,
  layoutRow: 0, layoutColumn: side - 1, stateKey: `${datasetId}:hap-1:${side}`,
  viewportOverride: { chrom, start: 1000, end: 2000 }, regionLabel: chrom,
  haplotypeGroup: 'hap-1', haplotypeSide: side, siteLocked: true,
});

const rule = { id: 'r1', name: 'Peaks', source: 'accessibility', enabled: true, color: '#000', opacity: 1,
  useGradient: false, smoothWidth: 100, thresholds: [0.5, 0.3, 0.15, 0.08], minPeakWidth: 80, minReads: 5 };

function setup(overrides: Record<string, unknown> = {}) {
  useBrowserStore.setState({
    chrom: 'chr1_mat', start: 1000, end: 2000,
    datasets: [{ id: 'a', label: 'Sample A' }, { id: 'b', label: 'Sample B' }],
    panels: [hapPanel('p1', 'a', 1, 'chr1_mat'), hapPanel('p2', 'b', 2, 'chr1_pat')],
    peakRules: [rule],
    peaksByRule: { r1: [
      { index: 0, start: 1200, end: 1300, chrom: 'chr1_mat' },
      { index: 1, start: 1250, end: 1330, chrom: 'chr1_pat' },
      { index: 2, start: 1600, end: 1700, chrom: 'chr1_pat' },
    ] },
    selectedPeaks: new Set([0, 1]),
    peakModes: {},
    filteredReadIds: { 'b:hap-1:2': new Set(['s1', 's2']) },
    clusterMethod: 'kmeans', clusterK: 3,
    analysisSampleCount: null, analysisSampleSeed: 'seed',
    subnucleosomalThreshold: 90, accessibilityThreshold: 0.5,
    clusterAssignments: {},
    ...overrides,
  } as any);
}

describe('HaplotypeClusteringControls', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const button = (label: string) => [...container.querySelectorAll('button')].find(b => b.textContent?.includes(label))!;

  it('co-clusters matched domains, applies the states to both views and shows their shift', async () => {
    setup();
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({
        mode: 'joint', method: 'kmeans', label_space: 'shared', feature_count: 1, bins_per_feature: 20,
        balanced_fit_reads: 4, total_reads: 6, view_separation_nmi: 0.05, dataset_separation_nmi: 0.05,
        results: {
          'a:hap-1:1': { view_id: 'view1', dataset_id: 'a', assignments: { r1: 0, r2: 0, r3: 0, r4: 1 } },
          'b:hap-1:2': { view_id: 'view2', dataset_id: 'b', assignments: { s1: 1, s2: 0 } },
        },
      }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => root.render(<HaplotypeClusteringControls />));
    expect(container.textContent).toContain('View 1: chr1_mat · Sample A');
    expect(container.textContent).toContain('F1: 1,200–1,300');

    await act(async () => { button('Co-cluster matched domains').click(); });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/cluster_matched_views');
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ mode: 'joint', method: 'kmeans', k: 3, balance_views: true });
    expect(body.views[0]).toMatchObject({ id: 'view1', chrom: 'chr1_mat', peak_regions: [{ start: 1200, end: 1300 }],
      panels: [{ dataset_id: 'a', result_key: 'a:hap-1:1' }] });
    expect(body.views[1].panels[0]).toMatchObject({ result_key: 'b:hap-1:2', read_ids: ['s1', 's2'] });
    expect(body.views[1].reverse).toBe(false);

    const state = useBrowserStore.getState();
    expect(state.clusterAssignments['a:hap-1:1']).toEqual({ r1: 0, r2: 0, r3: 0, r4: 1 });
    expect(state.clusterAssignments['b:hap-1:2']).toEqual({ s1: 1, s2: 0 });
    expect(state.dynamicClustering).toBe(false);
    const summary = container.querySelector('[data-testid="haplotype-comparison-summary"]')!;
    expect(summary.textContent).toContain('75.0% (3)');
    expect(summary.textContent).toContain('-25.0 pp');
    expect(button('Show co-clustered result')).toBeTruthy();
  });

  it('asks for the same number of peaks in both views', async () => {
    setup({ selectedPeaks: new Set([0, 1, 2]) });
    await act(async () => root.render(<HaplotypeClusteringControls />));
    expect(container.textContent).toContain('1 peaks in View 1 and 2 in View 2');
    expect(button('Co-cluster matched domains').disabled).toBe(true);
  });

  it("explains when the Cluster panel's method can't be used", async () => {
    setup({ clusterMethod: 'hdbscan' });
    await act(async () => root.render(<HaplotypeClusteringControls />));
    expect(container.textContent).toContain("can't be used here");
    expect(button('Cluster each view separately').disabled).toBe(true);
  });

  it('numbers View 2 features from the right when it is reversed', async () => {
    setup({ selectedPeaks: new Set([0, 1, 2]), peaksByRule: { r1: [
      { index: 0, start: 1200, end: 1300, chrom: 'chr1_mat' },
      { index: 3, start: 1400, end: 1450, chrom: 'chr1_mat' },
      { index: 1, start: 1250, end: 1330, chrom: 'chr1_pat' },
      { index: 2, start: 1600, end: 1700, chrom: 'chr1_pat' },
    ] } });
    useBrowserStore.setState({ selectedPeaks: new Set([0, 1, 2, 3]) } as any);
    await act(async () => root.render(<HaplotypeClusteringControls />));
    const reverse = [...container.querySelectorAll('label')].find(l => l.textContent?.includes('Reverse View 2'))!
      .querySelector('input')!;
    await act(async () => { reverse.click(); });
    expect(container.textContent).toContain('F2: 1,250–1,330');
    expect(container.textContent).toContain('F1: 1,600–1,700');
  });
});
