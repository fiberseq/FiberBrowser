import '../../testSetup';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import * as regions from '../../../api/regions';
import { useBrowserStore } from '../../../stores/browserStore';
import { normalizeNfrMotifSettings } from '../nfrMotifSettings';
import { cellColor, PooledMotifs } from './PooledMotifs';

vi.mock('../api', async importOriginal => ({
  ...(await importOriginal<typeof import('../api')>()),
  getAccessibilityJobs: vi.fn(), getPooledMotifs: vi.fn(), startAccessibilityBatch: vi.fn(), getKmerEnrichment: vi.fn(),
}));
vi.mock('../../../api/regions', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../api/regions')>()), getRegionCatalog: vi.fn(),
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const wait = (ms: number) => act(async () => { await new Promise(r => setTimeout(r, ms)); });
const q = (c: HTMLElement, id: string) => c.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const qa = (c: HTMLElement, id: string) => [...c.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const click = (el: Element | null) => act(async () => { (el as HTMLElement).click(); });
const stat = (log2: number, q: number | null) => ({ strata: 5, ratio: 2 ** log2, odds_ratio: 2 ** log2, log2, p: q, q });

describe('NFR motifs pooled over runs', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    useBrowserStore.setState({ motifScoreMode: 'p', motifPValue: 1e-4, motifThreshold: 0.85, customMotifs: [], currentGenome: 'dm6',
      nfrMotifSettings: normalizeNfrMotifSettings(undefined) } as never);
    vi.mocked(api.getAccessibilityJobs).mockReset().mockResolvedValue({ jobs: [
      { job_id: 'j1', status: 'complete', request: { dataset_ids: ['d'], chrom: 'chr3L', start: 100, end: 15000 } },
      { job_id: 'j2', status: 'complete', request: { dataset_ids: ['d'], chrom: 'chr2L', start: 5, end: 9000, region_label: 'ind' } },
    ] } as never);
    vi.mocked(api.getPooledMotifs).mockReset().mockResolvedValue({
      families: [{ id: 'MA1', name: 'vfl', members: ['vfl', 'Kah'], sites: 30 }, { id: 'MA2', name: 'dl', members: ['dl'], sites: 12 }],
      types: ['full', 'alternative'], type_help: { full: 'f', alternative: 'a' }, nfrs: 9, runs: 2, job_ids: ['j1', 'j2'],
      cells: [
        { family: 'MA1', type: 'full', nfrs: 5, sites: stat(0.2, 0.8), open: stat(1, 0.001), footprinted: stat(1.5, 0.004) },
        { family: 'MA2', type: 'alternative', nfrs: 3, sites: stat(-1, 0.5), open: stat(-0.5, 0.3), footprinted: stat(-1, 0.6) },
      ],
      definitions: { sites: 's', open: 'o', footprinted: 'f', families: 'fa', q: 'q' },
    } as api.PooledMotifs);
    vi.mocked(regions.getRegionCatalog).mockReset().mockResolvedValue({ catalog: { version: 1, genome: 'dm6', categories: [],
      entries: [{ id: 'r1', chrom: 'chr3L', start: 1, end: 9000, label: 'ind', category: 'c', source: 'manual' }] } } as never);
    vi.mocked(api.startAccessibilityBatch).mockReset().mockResolvedValue({ jobs: [{ region: {}, job_id: 'j3', status: 'queued' }] });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  it('pools the picked runs with the shared scoring, and draws family x type cells with q stars', async () => {
    await act(async () => root.render(<PooledMotifs jobId="j1" />));
    await wait(20);
    const boxes = qa(container, 'nfr-pooled-run') as HTMLInputElement[];
    expect(boxes.map(b => b.checked)).toEqual([true, false]);
    await click(boxes[1]);
    await click(q(container, 'nfr-pooled-run-button'));
    await wait(20);
    expect(api.getPooledMotifs).toHaveBeenCalledWith(['j1', 'j2'], expect.objectContaining({ mode: 'p', p: 1e-4, core_bp: 10 }));
    const rows = qa(container, 'nfr-pooled-row');
    expect(rows.map(r => r.dataset.family)).toEqual(['vfl', 'dl']);           // ranked by q of the measure
    const cell = rows[0].querySelector('[data-type="full"]')!;
    expect(cell.textContent).toBe('2.8**');
    expect(q(container, 'nfr-pooled-summary')!.textContent).toContain('1 family × type cell at q ≤ 0.1');
    await click(q(container, 'nfr-pooled-measure-sites'));
    const now = qa(container, 'nfr-pooled-row');
    expect(now.map(r => r.dataset.family)).toEqual(['dl', 'vfl']);                // re-ranked by the sites q
    expect(now.find(r => r.dataset.family === 'vfl')!.querySelector('[data-type="full"]')!.textContent).toBe('1.1');
  });

  it('finds variants in the Regions catalogue with this run\'s settings', async () => {
    await act(async () => root.render(<PooledMotifs jobId="j1" />));
    await wait(20);
    await click(q(container, 'nfr-batch-toggle'));
    await wait(20);
    await click(q(container, 'nfr-batch-submit'));
    expect(api.startAccessibilityBatch).toHaveBeenCalledWith('j1', [{ chrom: 'chr3L', start: 1, end: 9000, label: 'ind' }]);
  });

  it('finds enriched k-mers over the picked runs and names their JASPAR match', async () => {
    vi.mocked(api.getKmerEnrichment).mockResolvedValue({ k: 6, tested: 2080, nfrs: 9, runs: 1, definition: 'MH', types: {
      alternative: { strata: { siblings: 5, background: 5 }, kmers: [{ kmer: 'GATAAG', siblings: stat(1, 0.5), background: stat(1, 0.5), match: null }] },
      full: { strata: { siblings: 9, background: 9 }, kmers: [{ kmer: 'CAGGTA', siblings: stat(1.5, 0.003), background: stat(1, 0.02), match: { name: 'vfl', id: 'MA1462.2', share: 1 } }] } } });
    await act(async () => root.render(<PooledMotifs jobId="j1" />));
    await wait(20);
    await click(q(container, 'nfr-kmers-run'));
    await wait(20);
    expect(api.getKmerEnrichment).toHaveBeenCalledWith(['j1'], 6);
    expect(q(container, 'nfr-kmer-row')!.textContent).toContain('GATAAG');          // the first type
    await click(q(container, 'nfr-kmers-type-full'));
    const row = q(container, 'nfr-kmer-row')!;
    expect(row.textContent).toContain('CAGGTA');
    expect(row.textContent).toContain('2.8× q 0.003');
    expect(row.textContent).toContain('vfl (100%)');
  });

  it('colours ratios: fuchsia above 1, blue below, none untested', () => {
    expect(cellColor(1)).toContain('192, 38, 211');
    expect(cellColor(-1)).toContain('2, 132, 199');
    expect(cellColor(null)).toBe('transparent');
  });
});
