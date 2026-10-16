import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../../stores/browserStore';
import { setRegionCatalogPersistence, useRegionCatalogStore } from '../../../stores/regionCatalogStore';
import { usePanelGenomeStore } from '../../../stores/panelGenomeStore';
import { addCategory, addEntries, emptyCatalog } from '../../../utils/regionCatalog';
import { RegionCatalog } from './RegionCatalog';
import { SmartSearchInput } from '../SmartSearchInput';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function seedCatalog() {
  let c = emptyCatalog('dm6');
  c = addCategory(c, { id: 'enh', name: 'Enhancers' }).catalog;
  c = addCategory(c, { id: 'amp', name: 'Amplicons · flyamp', source: 'auto', fingerprint: 'fp1' }).catalog;
  c = addEntries(c, 'enh', [
    { id: 'e1', chrom: 'chr2R', start: 9_000, end: 9_500, label: 'eve stripe 2', source: 'bed' },
    { id: 'e2', chrom: 'chr2R', start: 12_000, end: 12_800, label: 'eve late', source: 'bed' },
  ]).catalog;
  c = addEntries(c, 'amp', [{ id: 'a1', chrom: 'chr2L', start: 1_000, end: 1_650, label: 'ftz', autoLabel: 'ftz', source: 'auto', reads: 5030 }]).catalog;
  return c;
}

const type = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

describe('Regions panel catalog and locus-box region search', () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes('/api/regions/catalog')) return { ok: true, json: async () => ({ success: true, catalog: { categories: [], entries: [] } }) } as Response;
    if (String(url).includes('/api/regions/label')) return { ok: true, json: async () => ({ label: 'near eve (1.0 kb)', gene: 'eve' }) } as Response;
    return { ok: true, json: async () => ({}) } as Response;
  });

  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('fetch', fetchMock);
    useRegionCatalogStore.setState({ catalogs: { dm6: seedCatalog() }, sync: { dm6: 'local' }, fingerprints: {}, scans: {}, active: null, recent: [], shown: null, picked: null, undo: null, loadErrors: {} });
    useBrowserStore.setState({
      currentGenome: 'dm6', fastaPath: null, chrom: 'chr2R', start: 100, end: 2_100,
      chroms: [{ name: 'chr2R', size: 25_000_000 }, { name: 'chr2L', size: 23_000_000 }],
      datasets: [], panels: [], selectedDatasets: new Set(), navigationMode: 'linked', highlights: [],
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

  const q = <T extends Element = HTMLElement>(sel: string) => container.querySelector<T>(sel);
  const all = (sel: string) => [...container.querySelectorAll<HTMLElement>(sel)];
  const labels = () => all('[data-testid="region-entry-label"]').map(e => e.textContent);

  it('lists categories with counts; a closed dataset’s amplicons are hidden; filters by keyword', async () => {
    await act(async () => root.render(<RegionCatalog />));
    expect(all('[data-testid="region-category-name"]').map(e => e.textContent)).toEqual(['Enhancers']);
    expect(labels()).toEqual(['eve stripe 2', 'eve late']);
    // The amplicons show once their dataset is open.
    await act(async () => { useRegionCatalogStore.getState().setFingerprint('flyamp', 'fp1'); });
    expect(all('[data-testid="region-category-name"]').map(e => e.textContent)).toEqual(['Enhancers', 'Amplicons · flyamp']);
    expect(all('[data-testid="region-category-count"]').map(e => e.textContent)).toEqual(['2', '1']);
    await act(async () => type(q<HTMLInputElement>('[data-testid="region-filter"]')!, 'late'));
    expect(labels()).toEqual(['eve late']);
    await act(async () => type(q<HTMLInputElement>('[data-testid="region-filter"]')!, 'flyamp'));
    expect(labels()).toEqual(['ftz']);
  });

  it('renames in place, goes to a region, steps with next/previous, highlights a selection', async () => {
    await act(async () => root.render(<RegionCatalog />));
    // Double-click a name: edit it.
    const first = all('[data-testid="region-entry-go"]')[0];
    await act(async () => { first.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    const input = q<HTMLInputElement>('[data-testid="region-edit-input"]')!;
    await act(async () => { type(input, 'MSE'); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(useRegionCatalogStore.getState().catalogs.dm6.entries.find(e => e.id === 'e1')?.label).toBe('MSE');

    // Next: the first region of the category (saved regions open as saved).
    await act(async () => q<HTMLButtonElement>('[data-testid="region-next"]')!.click());
    expect(useBrowserStore.getState()).toMatchObject({ chrom: 'chr2R', start: 9_000, end: 9_500 });
    expect(q('[data-testid="region-step-label"]')!.textContent).toBe('1 / 2 in Enhancers');
    await act(async () => q<HTMLButtonElement>('[data-testid="region-next"]')!.click());
    expect(useBrowserStore.getState().start).toBe(12_000);
    await act(async () => q<HTMLButtonElement>('[data-testid="region-prev"]')!.click());
    expect(useBrowserStore.getState().start).toBe(9_000);

    // Select both and highlight them: one undoable step, labelled like the regions.
    for (const box of all('[data-testid="region-entry"] input[type="checkbox"]')) await act(async () => (box as HTMLInputElement).click());
    expect(q('[data-testid="region-selection-bar"]')!.textContent).toContain('2 selected');
    await act(async () => q<HTMLButtonElement>('[data-testid="region-selection-highlight"]')!.click());
    expect(useBrowserStore.getState().highlights.map(h => [h.genome, h.chrom, h.start, h.end, h.label])).toEqual([
      ['dm6', 'chr2R', 9_000, 9_500, 'MSE'], ['dm6', 'chr2R', 12_000, 12_800, 'eve late'],
    ]);
  });

  it('Save view saves the view of the chosen reference into one of its own categories', async () => {
    useBrowserStore.setState({
      currentGenome: 'hg38', chrom: 'chr19', start: 1_000, end: 2_000,
      panels: [
        { id: 'human', contentType: 'dataset', datasetId: 'human', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 },
        { id: 'fly', contentType: 'dataset', datasetId: 'fly', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, genome: 'dm6',
          viewportOverride: { chrom: 'chr2L', start: 500, end: 900 } },
      ],
      selectedDatasets: new Set(['human']),
    } as any);
    useRegionCatalogStore.setState({ catalogs: { hg38: addCategory(emptyCatalog('hg38'), { id: 'mine', name: 'Mine', source: 'saved' }).catalog, dm6: seedCatalog() }, sync: { hg38: 'local', dm6: 'local' } });
    await act(async () => root.render(<RegionCatalog />));
    expect(q<HTMLSelectElement>('[data-testid="region-genome-select"]')!.value).toBe('hg38');
    await act(async () => q<HTMLButtonElement>('[data-testid="region-save-view"]')!.click());
    expect(q('[data-testid="region-save-form"]')!.textContent).toContain('chr19:1,000-2,000');
    // Another reference: its own panel's view, and a category of its own catalog.
    const select = q<HTMLSelectElement>('[data-testid="region-genome-select"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, 'dm6');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(q('[data-testid="region-save-form"]')!.textContent).toContain('chr2L:500-900');
    await act(async () => { type(q<HTMLInputElement>('[data-testid="region-save-label"]')!, 'fly view'); });
    await act(async () => q<HTMLButtonElement>('[data-testid="region-save-confirm"]')!.click());
    const dm6 = useRegionCatalogStore.getState().catalogs.dm6;
    const saved = dm6.entries.find(e => e.label === 'fly view')!;
    expect(saved).toMatchObject({ chrom: 'chr2L', start: 500, end: 900 });
    expect(dm6.categories.some(c => c.id === saved.category)).toBe(true);
    expect(useRegionCatalogStore.getState().catalogs.hg38.entries).toEqual([]);
  });

  it('a large BED list is windowed (only the visible rows are drawn)', async () => {
    let c = addCategory(emptyCatalog('dm6'), { id: 'big', name: 'Peaks' }).catalog;
    c = addEntries(c, 'big', Array.from({ length: 20_000 }, (_, i) => ({ chrom: 'chr2R', start: i * 100, end: i * 100 + 50, label: `peak ${i}`, source: 'bed' as const }))).catalog;
    useRegionCatalogStore.setState({ catalogs: { dm6: c } });
    await act(async () => root.render(<RegionCatalog />));
    expect(all('[data-testid="region-entry"]').length).toBeLessThan(100);
    expect(q('[data-testid="region-category-count"]')!.textContent).toBe('20,000');
  });

  it('the locus box offers saved regions as you type; arrows and Enter go there', async () => {
    await act(async () => root.render(<SmartSearchInput />));
    const input = q<HTMLInputElement>('[data-testid="location-search-input"]')!;
    await act(async () => { input.focus(); input.dispatchEvent(new FocusEvent('focus')); });
    await act(async () => type(input, 'eve'));
    const options = all('[data-testid="search-suggestion"]');
    expect(options.map(o => o.querySelector('[data-suggestion-label]')!.textContent)).toEqual(['eve late', 'eve stripe 2']);
    expect(options[0].textContent).toContain('Enhancers · chr2R:12,000-12,800');
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
    expect(options[1].getAttribute('aria-selected')).toBe('true');
    await act(async () => { input.form!.requestSubmit(); });
    expect(useBrowserStore.getState()).toMatchObject({ chrom: 'chr2R', start: 9_000, end: 9_500 });
    // A region named exactly: Enter goes there without the gene search.
    await act(async () => { input.focus(); type(input, 'Eve Late'); });
    await act(async () => { input.form!.requestSubmit(); });
    expect(useBrowserStore.getState().start).toBe(12_000);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/gene_search'))).toBe(false);
  });
});

describe('Regions panel fixes (fb-n2-regions)', () => {
  let container: HTMLDivElement;
  let root: Root;

  const q = <T extends Element = HTMLElement>(sel: string) => container.querySelector<T>(sel);
  const all = (sel: string) => [...container.querySelectorAll<HTMLElement>(sel)];
  const labels = () => all('[data-testid="region-entry-label"]').map(e => e.textContent);
  const pick = async (select: HTMLSelectElement, value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  /** hg38 is the main genome; a dm6 dataset has its own panel. */
  const twoReferences = () => {
    useBrowserStore.setState({
      currentGenome: 'hg38', chrom: 'chr19', start: 1_000, end: 2_000,
      chroms: [{ name: 'chr19', size: 58_617_616 }, { name: 'chrX', size: 156_040_895 }],
      datasets: [{ id: 'human', label: 'napa_ddda' }, { id: 'fly', label: 'FlyAmp' }],
      panels: [
        { id: 'human', contentType: 'dataset', datasetId: 'human', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 },
        { id: 'fly', contentType: 'dataset', datasetId: 'fly', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, genome: 'dm6',
          viewportOverride: { chrom: 'chr2L', start: 500, end: 900 } },
      ],
      selectedDatasets: new Set(),
    } as any);
    usePanelGenomeStore.setState({ genomes: { dm6: { key: 'dm6', label: 'dm6', kind: 'registry', genome_id: 'dm6', fasta_path: null,
      chroms: [{ name: 'chr2L', size: 23_513_712 }, { name: 'chr2R', size: 25_286_936 }, { name: 'chr3R', size: 32_079_331 }] } as any } });
    useRegionCatalogStore.setState({ catalogs: { hg38: emptyCatalog('hg38'), dm6: seedCatalog() }, sync: { hg38: 'local', dm6: 'local' } });
  };

  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ success: true, catalog: { categories: [], entries: [] } }) }) as Response));
    useRegionCatalogStore.setState({ catalogs: { dm6: seedCatalog() }, sync: { dm6: 'local' }, fingerprints: {}, scans: {}, active: null, recent: [], shown: null, picked: null, undo: null, loadErrors: {}, saveError: null });
    usePanelGenomeStore.setState({ genomes: {}, assignments: {} });
    useBrowserStore.setState({
      currentGenome: 'dm6', fastaPath: null, chrom: 'chr2R', start: 100, end: 2_100,
      chroms: [{ name: 'chr2R', size: 25_000_000 }, { name: 'chr2L', size: 23_000_000 }],
      datasets: [], panels: [], selectedDatasets: new Set(), navigationMode: 'linked', highlights: [],
    } as any);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('Export BED with a filter writes only the regions the filter shows (M17)', async () => {
    let written: Blob | null = null;
    vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL: (b: Blob) => { written = b; return 'blob:x'; }, revokeObjectURL: () => undefined }));
    await act(async () => root.render(<RegionCatalog />));
    await act(async () => type(q<HTMLInputElement>('[data-testid="region-filter"]')!, 'late'));
    expect(labels()).toEqual(['eve late']);
    await act(async () => q<HTMLButtonElement>('[data-testid="region-export-bed"]')!.click());
    const text = await new Promise<string>(resolve => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.readAsText(written!); });
    expect(text).toContain('eve late');
    expect(text).not.toContain('eve stripe 2');
    expect(q('[data-testid="region-status"]')!.textContent).toContain('Exported 1 region');
  });

  it('Export BED without a filter includes the regions under a folded heading (Codex review #6)', async () => {
    let written: Blob | null = null;
    vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL: (b: Blob) => { written = b; return 'blob:x'; }, revokeObjectURL: () => undefined }));
    let c = seedCatalog();
    c = addCategory(c, { id: 'sub', name: 'Late', parent: 'enh' }).catalog;
    c = addEntries(c, 'sub', [{ id: 's1', chrom: 'chr2R', start: 20_000, end: 20_500, label: 'sub region', source: 'bed' }]).catalog;
    c = { ...c, categories: c.categories.map(x => (x.id === 'enh' ? { ...x, collapsed: true } : x)) };
    useRegionCatalogStore.setState({ catalogs: { dm6: c } });
    await act(async () => root.render(<RegionCatalog />));
    await act(async () => q<HTMLButtonElement>('[data-testid="region-export-bed"]')!.click());
    const text = await new Promise<string>(resolve => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.readAsText(written!); });
    expect(text).toContain('sub region');
    expect(text).toContain('eve stripe 2');
    expect(text).not.toContain('ftz');  // a closed dataset's amplicons
  });

  it('Delete a category asks in the panel (no browser dialog) and can be undone (M18)', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await act(async () => root.render(<RegionCatalog />));
    await act(async () => q<HTMLButtonElement>('[data-testid="region-category-menu"]')!.click());
    await act(async () => q<HTMLButtonElement>('[data-testid="region-category-delete"]')!.click());
    expect(confirm).not.toHaveBeenCalled();
    expect(q('[data-testid="region-prompt"]')!.textContent).toContain('Delete Enhancers and its 2 regions?');
    expect(labels()).toEqual(['eve stripe 2', 'eve late']);
    await act(async () => q<HTMLButtonElement>('[data-testid="region-confirm-delete"]')!.click());
    expect(labels()).toEqual([]);
    expect(q('[data-testid="region-undo-bar"]')!.textContent).toContain('Deleted Enhancers');
    await act(async () => q<HTMLButtonElement>('[data-testid="region-undo"]')!.click());
    expect(labels()).toEqual(['eve stripe 2', 'eve late']);
    expect(q('[data-testid="region-undo-bar"]')).toBeNull();
    // Reset asks in the panel too.
    await act(async () => (container.querySelector<HTMLButtonElement>('[aria-label="More region actions"]')!).click());
    await act(async () => q<HTMLButtonElement>('[data-testid="region-reset"]')!.click());
    expect(confirm).not.toHaveBeenCalled();
    expect(q('[data-testid="region-prompt"]')!.textContent).toContain("Forget every saved region on dm6? This can't be undone.");
  });

  it('Import BED of dm6 regions into the hg38 catalog offers dm6; regions can be moved to another reference (H4)', async () => {
    twoReferences();
    await act(async () => root.render(<RegionCatalog />));
    expect(q<HTMLSelectElement>('[data-testid="region-genome-select"]')!.value).toBe('hg38');
    const bed = 'track name="DV enhancers"\nchr2R\t9974318\t9975000\teve_stripe2\nchr3R\t6758000\t6760000\tftz_zebra\n';
    const input = q<HTMLInputElement>('[data-testid="region-import-input"]')!;
    const file = (text: string, name: string) => ({ name, text: async () => text });  // (jsdom's File has no text())
    Object.defineProperty(input, 'files', { configurable: true, value: [file(bed, 'fly_enhancers.bed')] });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(q('[data-testid="region-prompt"]')!.textContent).toContain('fly_enhancers.bed looks like dm6 regions: chr2R, chr3R are not on hg38.');
    expect(useRegionCatalogStore.getState().catalogs.hg38.entries).toEqual([]);
    await act(async () => q<HTMLButtonElement>('[data-testid="region-import-elsewhere"]')!.click());
    expect(useRegionCatalogStore.getState().catalogs.hg38.entries).toEqual([]);
    expect(useRegionCatalogStore.getState().catalogs.dm6.entries.map(e => e.label)).toContain('ftz_zebra');
    expect(q('[data-testid="region-status"]')!.textContent).toContain('fly_enhancers.bed (into dm6): 2 regions');

    // Imported into hg38 anyway: they can be moved to dm6 (category menu), and back with Undo.
    Object.defineProperty(input, 'files', { configurable: true, value: [file(bed.replace('DV enhancers', 'Again'), 'again.bed')] });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    await act(async () => q<HTMLButtonElement>('[data-testid="region-import-here"]')!.click());
    expect(useRegionCatalogStore.getState().catalogs.hg38.entries).toHaveLength(2);
    await act(async () => q<HTMLButtonElement>('[data-testid="region-category-menu"]')!.click());
    await act(async () => q<HTMLButtonElement>('[data-testid="region-category-move-genome"]')!.click());
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(useRegionCatalogStore.getState().catalogs.hg38.entries).toEqual([]);
    expect(useRegionCatalogStore.getState().catalogs.dm6.categories.map(c => c.name)).toContain('Again');
    expect(q('[data-testid="region-undo-bar"]')!.textContent).toContain('Moved 2 regions to dm6');
  });

  it('switching catalogs clears the last message; the menu names the main genome; the panel publishes the catalog it shows (L4, M15)', async () => {
    twoReferences();
    await act(async () => root.render(<RegionCatalog />));
    const select = q<HTMLSelectElement>('[data-testid="region-genome-select"]')!;
    expect([...select.options].map(o => o.textContent)).toEqual(['hg38 (main genome)', 'dm6']);
    expect(useRegionCatalogStore.getState().shown).toBe('hg38');
    await act(async () => q<HTMLButtonElement>('[data-testid="region-export-bed"]')!.click());
    expect(q('[data-testid="region-status"]')!.textContent).toBe('Nothing to export.');
    await pick(select, 'dm6');
    expect(q('[data-testid="region-status"]')).toBeNull();
    expect(useRegionCatalogStore.getState().shown).toBe('dm6');
    act(() => root.unmount());
    root = createRoot(container);
    expect(useRegionCatalogStore.getState().shown).toBeNull();
    // Opened again (or moved into the drawer): still the catalog chosen.
    await act(async () => root.render(<RegionCatalog />));
    expect(q<HTMLSelectElement>('[data-testid="region-genome-select"]')!.value).toBe('dm6');
  });

  it('a long name keeps its room: the coordinates shrink instead (L13)', async () => {
    await act(async () => root.render(<RegionCatalog />));
    const coords = q('[data-testid="region-entry-coords"]')!;
    expect(coords.className).toContain('min-w-0');
    expect(coords.className).not.toContain('shrink-0');
    expect(q('[data-testid="region-entry-label"]')!.className).toContain('min-w-[4.5rem]');
  });

  it('a catalog that could not be read says so and offers Retry (Codex 25)', async () => {
    // The server is still down: the read on opening fails again.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502, json: async () => ({ detail: 'HTTP 502' }) }) as Response));
    setRegionCatalogPersistence(() => true);
    useRegionCatalogStore.setState({ sync: { dm6: 'error' }, loadErrors: { dm6: 'HTTP 502' } });
    await act(async () => root.render(<RegionCatalog />));
    expect(q('[data-testid="region-load-error"]')!.textContent).toMatch(/could not be read \(.*502/);
    const ensure = vi.spyOn(useRegionCatalogStore.getState(), 'ensureLoaded');
    await act(async () => q<HTMLButtonElement>('[data-testid="region-load-retry"]')!.click());
    expect(ensure).toHaveBeenCalledWith('dm6');
    setRegionCatalogPersistence(() => false);
  });
});
