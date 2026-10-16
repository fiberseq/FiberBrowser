import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../../stores/browserStore';
import { useRegionCatalogStore } from '../../../stores/regionCatalogStore';
import { emptyCatalog } from '../../../utils/regionCatalog';
import { RegionCatalog } from './RegionCatalog';
import { beginRegionScan, scanStatusText } from '../../../utils/regionScan';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const numb = { id: 'numb', label: 'numb capture', path: '/d/numb.bam', color: '#3b82f6', data_type: 'bam' };
const wgs = { id: 'wgs', label: 'whole genome', path: '/d/wgs.bam', color: '#ef4444', data_type: 'bam' };
const panel = (id: string, datasetId: string) => ({ id, contentType: 'dataset', datasetId, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 });

describe('Regions › Scan regions: every open dataset says what it found or why not', () => {
  let container: HTMLDivElement;
  let root: Root;
  const asked: string[] = [];
  const fetchMock = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('/api/regions/catalog')) return { ok: true, json: async () => ({ success: true, catalog: { categories: [], entries: [] } }) } as Response;
    if (u.includes('/api/reads/regions')) {
      asked.push(u);
      if (u.includes('dataset_id=numb')) {
        return { ok: true, json: async () => ({ success: true, kind: 'targeted', method: 'index', status: 'scanned', genome: 'dm6', fingerprint: 'fpN', reads: 51824,
          note: 'Found from the BAM index', regions: [
            { chrom: 'chr2L', start: 6_295_991, end: 6_472_991, reads: 27204, label: 'DIP-epsilon', gene: 'DIP-epsilon' },
            { chrom: 'chr2L', start: 9_390_841, end: 9_561_841, reads: 24648, label: 'numb', gene: 'numb' }] }) } as Response;
      }
      if (u.includes('force=true')) {
        return { ok: true, json: async () => ({ success: true, kind: 'top', method: 'reads', status: 'scanned', genome: 'dm6', fingerprint: 'fpW', note: 'Scanned anyway: read 9 reads.', regions: [
          { chrom: 'chr2R', start: 10, end: 500, reads: 9, label: 'eve', gene: 'eve' }] }) } as Response;
      }
      return { ok: true, json: async () => ({ success: false, refused: true, status: 'whole-genome', whole_genome: true, reads: 4_000_000, genome: 'dm6', fingerprint: 'fpW', regions: [],
        reason: 'Whole-genome data (4,000,000 reads)' }) } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  });

  beforeEach(() => {
    asked.length = 0;
    vi.stubGlobal('fetch', fetchMock);
    useRegionCatalogStore.setState({ catalogs: { dm6: emptyCatalog('dm6') }, sync: { dm6: 'local' }, fingerprints: {}, scans: {}, active: null, recent: [], shown: null, picked: null, undo: null, loadErrors: {} });
    useBrowserStore.setState({
      currentGenome: 'dm6', fastaPath: null, chrom: 'chr2L', start: 9_400_000, end: 9_500_000,
      chroms: [{ name: 'chr2L', size: 23_000_000 }, { name: 'chr2R', size: 25_000_000 }],
      datasets: [numb, wgs], panels: [panel('p1', 'numb'), panel('p2', 'wgs')], selectedDatasets: new Set(), navigationMode: 'linked', highlights: [],
    } as any);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

  const rows = () => [...container.querySelectorAll<HTMLElement>('[data-testid="region-scan-row"]')];
  const statusOf = (id: string) => rows().find(r => r.dataset.dataset === id)!.querySelector('[data-testid="region-scan-status"]')!.textContent;

  it('scans the open datasets, files each one\'s regions under its name, and says why one was skipped', async () => {
    await act(async () => root.render(<RegionCatalog />));
    expect(rows().map(r => r.dataset.dataset)).toEqual(['numb', 'wgs']);
    expect(statusOf('numb')).toBe('not scanned yet');
    await act(async () => (container.querySelector('[data-testid="region-find"]') as HTMLButtonElement).click());
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(asked.filter(u => !u.includes('force')).map(u => new URL(u, 'http://x').searchParams.get('dataset_id'))).toEqual(['numb', 'wgs']);
    expect(statusOf('numb')).toBe('scanned: 2 regions (from the BAM index)');
    expect(statusOf('wgs')).toBe('skipped: whole-genome (4,000,000 reads)');
    const cats = useRegionCatalogStore.getState().catalogs.dm6.categories;
    expect(cats.map(c => c.name)).toEqual(['Regions · numb capture']);
    // The skipped dataset offers narrower scans, and the slow one.
    const wgsRow = rows().find(r => r.dataset.dataset === 'wgs')!;
    expect(wgsRow.querySelector('[data-testid="region-scan-view"]')).not.toBeNull();
    expect(wgsRow.querySelector('[data-testid="region-scan-chrom"]')!.textContent).toBe('chr2L');
    await act(async () => (wgsRow.querySelector('[data-testid="region-scan-anyway"]') as HTMLButtonElement).click());
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(asked.some(u => u.includes('dataset_id=wgs') && u.includes('force=true'))).toBe(true);
    expect(statusOf('wgs')).toBe('scanned: 1 region');
    expect(useRegionCatalogStore.getState().catalogs.dm6.categories.map(c => c.name)).toEqual(['Regions · numb capture', 'Top regions · whole genome']);
  });

  it('status lines for each outcome', () => {
    expect(scanStatusText({ state: 'refused', status: 'mismatch' })).toBe('skipped: wrong reference');
    expect(scanStatusText({ state: 'done', regions: 3, scope: 'chrom', scopeLabel: 'chr3R' })).toBe('scanned: 3 regions on chr3R');
    expect(scanStatusText({ state: 'running' })).toBe('scanning…');
  });

  it('the result line follows a newer scan instead of keeping its running status', async () => {
    await act(async () => root.render(<RegionCatalog />));
    const respond = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementationOnce(async url => {
      expect(url).toContain('dataset_id=numb');
      beginRegionScan('numb');
      useRegionCatalogStore.getState().setScan('numb', { state: 'running' });
      return respond(url);
    });
    await act(async () => (container.querySelector('[data-testid="region-find"]') as HTMLButtonElement).click());
    const notice = () => container.querySelector('[data-testid="region-status"]')!.textContent;
    expect(notice()).toContain('numb capture: scanning…');
    await act(async () => useRegionCatalogStore.getState().setScan('numb', { state: 'done', regions: 2, method: 'index' }));
    expect(notice()).toContain('numb capture: scanned: 2 regions (from the BAM index)');
    expect(notice()).not.toContain('scanning…');
  });

  it('a later scan of a dataset replaces its earlier one', async () => {
    const res = (start: number) => ({ success: true, kind: 'top' as const, genome: 'dm6', fingerprint: 'fpW', regions: [{ chrom: 'chr2L', start, end: start + 100, reads: 5, label: 'x', gene: null }] });
    useRegionCatalogStore.getState().applyDetection(res(1000), 'whole genome', 'top', 'chr2L');
    useRegionCatalogStore.getState().applyDetection(res(5000), 'whole genome', 'top', 'chr2L:4,000-6,000');
    const cat = useRegionCatalogStore.getState().catalogs.dm6;
    expect(cat.categories.map(c => c.name)).toEqual(['Top regions · whole genome · chr2L:4,000-6,000']);
    expect(cat.entries.map(e => e.start)).toEqual([5000]);
  });
});
