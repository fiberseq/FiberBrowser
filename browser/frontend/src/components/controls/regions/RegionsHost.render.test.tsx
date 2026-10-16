import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../../stores/browserStore';
import { usePanelGenomeStore } from '../../../stores/panelGenomeStore';
import { setRegionCatalogPersistence, useRegionCatalogStore } from '../../../stores/regionCatalogStore';
import { addCategory, addEntries, emptyCatalog } from '../../../utils/regionCatalog';
import { RegionsHost } from './RegionsHost';

vi.mock('../../../utils/viewIdle', () => ({ waitForViewIdle: async () => {} }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Audit M16: a dm6 dataset opened while hg38 is the main genome was scanned on
 * hg38 (chrX matches by name); its "amplicons" stayed in the hg38 catalog,
 * named after hg38 genes, after it moved to its own dm6 panel.
 */
describe('RegionsHost: a dataset’s amplicons follow it to its own reference', () => {
  let container: HTMLDivElement;
  let root: Root;
  let answers: Array<Record<string, unknown>>;

  const settle = async () => {
    for (let i = 0; i < 6; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  };
  const autoCategories = (genome: string) =>
    (useRegionCatalogStore.getState().catalogs[genome]?.categories ?? []).filter(c => c.source === 'auto').map(c => c.name);

  beforeEach(() => {
    answers = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/api/reads/regions')) {
        const body = answers.shift() ?? { success: false, error: 'unexpected' };
        return { ok: true, status: 200, json: async () => body } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }));
    setRegionCatalogPersistence(() => false);
    useRegionCatalogStore.setState({ catalogs: {}, sync: {}, fingerprints: {}, scans: {}, active: null, recent: [], shown: null, picked: null, undo: null, loadErrors: {} });
    usePanelGenomeStore.setState({ genomes: {}, assignments: {} });
    useBrowserStore.setState({
      currentGenome: 'hg38', fastaPath: null, publicMode: false, chrom: 'chr19', start: 1, end: 100,
      chroms: [{ name: 'chr19', size: 58_617_616 }, { name: 'chrX', size: 156_040_895 }],
      datasets: [{ id: 'dl', label: 'mutant_b_recalled', data_type: 'bam' }],
      panels: [{ id: 'dl', contentType: 'dataset', datasetId: 'dl', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 }],
      bookmarks: [], navigatorRegions: [], selectedDatasets: new Set(), navigationMode: 'linked',
    } as any);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('refused on hg38 (another assembly): amplicons filed there before are removed; on dm6 they are found there', async () => {
    // What an earlier version left in the hg38 catalog.
    let hg = addCategory(emptyCatalog('hg38'), { id: 'stale', name: 'Amplicons · mutant_b_recalled', source: 'auto', fingerprint: 'fp-dl' }).catalog;
    hg = addEntries(hg, 'stale', [{ chrom: 'chrX', start: 100, end: 900, label: 'Metazoa_SRP', source: 'auto' }]).catalog;
    useRegionCatalogStore.setState({ catalogs: { hg38: hg } });
    answers.push({ success: false, refused: true, mismatch: true, genome: 'hg38', fingerprint: 'fp-dl', regions: [], reason: 'Dl was aligned to dm6…' });
    await act(async () => root.render(<RegionsHost />));
    await settle();
    expect(autoCategories('hg38')).toEqual([]);
    expect(useRegionCatalogStore.getState().scans.dl).toMatchObject({ state: 'refused' });

    // "Open with dm6 in its own panel": scanned again there.
    answers.push({ success: true, kind: 'amplicon', genome: 'dm6', fingerprint: 'fp-dl', regions: [{ chrom: 'chrX', start: 100, end: 900, reads: 50, label: 'sog', gene: 'sog' }] });
    await act(async () => { usePanelGenomeStore.setState({ assignments: { dl: 'dm6' } }); });
    await settle();
    expect(autoCategories('dm6')).toEqual(['Amplicons · mutant_b_recalled']);
    expect(useRegionCatalogStore.getState().catalogs.dm6.entries.map(e => e.label)).toEqual(['sog']);
    expect(autoCategories('hg38')).toEqual([]);
  });

  it('amplicons found on one reference leave it when the dataset moves to another', async () => {
    answers.push({ success: true, kind: 'amplicon', genome: 'hg38', fingerprint: 'fp-dl', regions: [{ chrom: 'chrX', start: 100, end: 900, reads: 50, label: 'NAPA', gene: 'NAPA' }] });
    await act(async () => root.render(<RegionsHost />));
    await settle();
    expect(autoCategories('hg38')).toEqual(['Amplicons · mutant_b_recalled']);
    answers.push({ success: true, kind: 'amplicon', genome: 'dm6', fingerprint: 'fp-dl', regions: [{ chrom: 'chrX', start: 100, end: 900, reads: 50, label: 'sog', gene: 'sog' }] });
    await act(async () => { usePanelGenomeStore.setState({ assignments: { dl: 'dm6' } }); });
    await settle();
    expect(autoCategories('hg38')).toEqual([]);
    expect(autoCategories('dm6')).toEqual(['Amplicons · mutant_b_recalled']);
  });
});
