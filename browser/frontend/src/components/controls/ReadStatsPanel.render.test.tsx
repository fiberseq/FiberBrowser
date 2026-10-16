import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { fetchReadStats } from '../../api/readStats';
import { ReadStatsPanel } from './ReadStatsPanel';

vi.mock('../../api/readStats', () => ({ fetchReadStats: vi.fn() }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const row = (read_id: string, acc: number, fps: number) => ({
  read_id, dataset_id: 'ds1', mapq: 60, strand: '+', read_length: 4000, aligned_span: 4000, nm: 0,
  footprint_count: fps, nucleosome_count: fps, subnuc_count: 0, avg_footprint_size: 147, median_footprint_size: 147,
  accessibility_pct: acc, methyl_count: null, methyl_pct: null, cigar_string: null, cigar_ops: null,
  ref_start: null, ref_end: null, fp_intervals: null, methyl_pos: null,
});

function respond(ids: string[]) {
  const perRead = ids.map((id, i) => row(id, 10 * (i + 1), i + 1));
  return {
    per_read: perRead, is_bam: true, requested_count: ids.length, found_count: ids.length, truncated: false,
    aggregate: { n_reads: ids.length, n_datasets: 1, strand_counts: { '+': ids.length, '-': 0 }, mean_accessibility_pct: 20,
      hist_fp_count: [{ lo: 0, hi: 2, count: ids.length, label: '0' }] },
  };
}

const wait = (ms: number) => act(async () => { await new Promise(r => setTimeout(r, ms)); });

describe('Read Stats groups: selection, reads shown, a cluster', () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.mocked(fetchReadStats);

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (_c, _s, _e, _sp, ids) => respond(ids.ds1 ?? []) as never);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useBrowserStore.setState({
      chrom: 'chr19', start: 1000, end: 6000,
      datasets: [{ id: 'ds1', label: 'napa_ddda', color: '#3b82f6' }],
      panels: [{ id: 'p1', contentType: 'dataset', datasetId: 'ds1', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 }],
      selectedReadIds: {},
      activeReadIds: { ds1: ['r1', 'r2', 'r3', 'r4'] },
      clusterAssignments: { ds1: { r1: 1, r2: 2, r3: 1, r4: 2 } },
      clusterOrder: {}, clusterFocus: {},
    } as never);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  const picker = () => container.querySelector<HTMLSelectElement>('[data-testid="read-stats-scope"]')!;
  const pick = async (value: string) => {
    await act(async () => {
      const select = picker();
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await wait(400);
  };

  it('describes every read shown when nothing is selected, with a by-cluster table', async () => {
    await act(async () => root.render(<ReadStatsPanel />));
    await wait(400);
    expect(picker().value).toBe('shown');
    expect([...picker().options].map(o => o.textContent)).toEqual([
      'Selected reads (0)', 'Reads shown (4)', 'Cluster 1 (2)', 'Cluster 2 (2)',
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][4]).toEqual({ ds1: ['r1', 'r2', 'r3', 'r4'] });
    expect(container.textContent).toContain('4 reads shown');
    const byCluster = container.querySelector('[data-testid="read-stats-by-cluster"]')!;
    expect(byCluster.textContent).toContain('Cluster 1');
    expect(byCluster.textContent).toContain('Cluster 2');
  });

  it('describes one cluster when picked, and the selection once reads are selected', async () => {
    await act(async () => root.render(<ReadStatsPanel />));
    await wait(400);
    await pick('cluster:2');
    expect(fetchMock.mock.calls.at(-1)![4]).toEqual({ ds1: ['r2', 'r4'] });
    expect(container.textContent).toContain('Cluster 2 · 2 reads');
    expect(container.querySelector('[data-testid="read-stats-by-cluster"]')).toBeNull();

    await act(async () => useBrowserStore.getState().setReadSelection('ds1', new Set(['r3'])));
    await wait(400);
    expect(picker().value).toBe('selection');
    expect(fetchMock.mock.calls.at(-1)![4]).toEqual({ ds1: ['r3'] });
    expect(container.querySelector('[data-tour="read-stats-deselect"]')).not.toBeNull();
  });

  it('counts only reads in panels on screen, and a copy at the same locus once', async () => {
    useBrowserStore.setState({
      panels: [
        { id: 'p1', contentType: 'dataset', datasetId: 'ds1', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 },
        { id: 'p2', contentType: 'dataset', datasetId: 'ds1', stateKey: 'ds1:copy', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0,
          viewportOverride: { chrom: 'chr19', start: 1000, end: 6000 } },
        { id: 'p3', contentType: 'dataset', datasetId: 'ds1', stateKey: 'ds1:hidden', subTracks: [], collapsed: true, linkGroup: null, layoutRow: 0,
          viewportOverride: { chrom: 'chr7', start: 1, end: 100 } },
      ],
      activeReadIds: { ds1: ['r1', 'r2', 'r3', 'r4'], 'ds1:copy': ['r1', 'r2', 'r3', 'r4'], 'ds1:hidden': ['h1', 'h2'] },
      clusterAssignments: { ds1: { r1: 1, r2: 2, r3: 1, r4: 2 } },
    } as never);
    await act(async () => root.render(<ReadStatsPanel />));
    await wait(400);
    expect(picker().options[1].textContent).toBe('Reads shown (4)');
    const [, , , , ids, , options] = fetchMock.mock.calls.at(-1)!;
    expect(ids).toEqual({ ds1: ['r1', 'r2', 'r3', 'r4'] });
    expect(options?.extraRegions ?? []).toEqual([]);
  });
  it('says in one line which dataset the reads are from (L12, L24)', async () => {
    await act(async () => root.render(<ReadStatsPanel />));
    await wait(400);
    const text = container.textContent ?? '';
    expect(text).toContain('4 reads shown');
    expect(text).toContain('from napa_ddda');
    // No second and third count of the same reads.
    expect(text).not.toContain('found for stats');
    // The table does not count the reads a third time.
    await act(async () => (container.querySelector('[data-analysis-tab="table"]') as HTMLButtonElement).click());
    await wait(50);
    expect(container.querySelector('table')).not.toBeNull();
    expect(container.textContent).not.toMatch(/\d+ rows?\b/);
    expect(container.textContent).not.toContain('Showing');
  });

  it('names each dataset when reads come from several, and can not pick an empty group (L24)', async () => {
    useBrowserStore.setState({
      datasets: [{ id: 'ds1', label: 'napa_ddda', color: '#3b82f6' }, { id: 'ds2', label: 'flyamp_dddb', color: '#ef4444' }],
      panels: [
        { id: 'p1', contentType: 'dataset', datasetId: 'ds1', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 },
        { id: 'p2', contentType: 'dataset', datasetId: 'ds2', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 },
      ],
      activeReadIds: { ds1: ['r1', 'r2'], ds2: ['s1'] },
      clusterAssignments: {},
    } as never);
    await act(async () => root.render(<ReadStatsPanel />));
    await wait(400);
    expect(container.textContent).toContain('from napa_ddda, flyamp_dddb');
    const selection = [...picker().options].find(o => o.value === 'selection')!;
    expect(selection.disabled).toBe(true);
    expect([...picker().options].find(o => o.value === 'shown')!.disabled).toBe(false);
  });
});

// fb-n2-scope (audit M2): a dm6 read opened in Read Stats from its own panel was
// placed on the main (hg38, stale) chromosome: "chr19:6,356,893-6,357,548 (+)".
describe("Read Stats: one read's chromosome is its panel's", () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.mocked(fetchReadStats);

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => ({
      ...respond(['fly1']),
      per_read: [{ ...row('fly1', 30, 3), dataset_id: 'flyamp', ref_start: 6_356_893, ref_end: 6_357_548 }],
    }) as never);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useBrowserStore.setState({
      chrom: 'chr19', start: 47_514_037, end: 47_519_435,
      datasets: [{ id: 'napa', label: 'napa_ddda', color: '#3b82f6' }, { id: 'flyamp', label: 'FlyAmp', color: '#8b5cf6' }],
      panels: [
        { id: 'p1', contentType: 'dataset', datasetId: 'napa', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0,
          viewportOverride: { chrom: 'chr19', start: 47_514_262, end: 47_519_210 }, navOwn: true },
        { id: 'p2', contentType: 'dataset', datasetId: 'flyamp', genome: 'dm6', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0,
          viewportOverride: { chrom: 'chr2L', start: 6_356_793, end: 6_357_648 }, navOwn: true },
      ],
      selectedReadIds: { flyamp: new Set(['fly1']) },
      activeReadIds: { napa: ['h1'], flyamp: ['fly1'] },
      clusterAssignments: {}, clusterOrder: {}, clusterFocus: {},
    } as never);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  it('shows chr2L (where the read was looked up), not the main chr19', async () => {
    await act(async () => root.render(<ReadStatsPanel />));
    await wait(400);
    const [, , , , , , options] = fetchMock.mock.calls.at(-1)!;
    expect(options?.extraRegions?.map(r => r.chrom)).toEqual(['chr2L']);
    const text = container.textContent ?? '';
    expect(text).toContain('chr2L:6,356,893-6,357,548');
    expect(text).not.toContain('chr19:6,356,893');
  });
});
