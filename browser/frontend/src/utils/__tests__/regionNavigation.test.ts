import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { flushRegionCatalogSaves, saveRegionCatalogNow, setRegionCatalogPersistence, useRegionCatalogStore } from '../../stores/regionCatalogStore';
import { catalogReferenceLabel, goToRegion, mainGenomeKey, regionTarget, stepRegion, targetGenome } from '../regionNavigation';
import { addCategory, addEntries, emptyCatalog } from '../regionCatalog';
import { migrateLegacyRegions } from '../regionMigration';
import { highlightReadRegion, highlightRegion } from '../highlightActions';
import type { RegionEntry } from '../../types/regions';

const panel = (id: string, extra: Record<string, unknown> = {}) => ({
  id, contentType: 'dataset', datasetId: id, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, ...extra,
});
const entry = (id: string, chrom: string, start: number, end: number, extra: Partial<RegionEntry> = {}): RegionEntry =>
  ({ id, chrom, start, end, label: id, category: 'c', source: 'saved', ...extra });

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ success: true, catalog: { categories: [], entries: [] } }) }) as Response));
  setRegionCatalogPersistence(() => false);
  useRegionCatalogStore.setState({ catalogs: {}, sync: {}, fingerprints: {}, scans: {}, active: null, recent: [] });
  useBrowserStore.setState({
    currentGenome: 'hg38', fastaPath: null, chrom: 'chr19', start: 1000, end: 2000,
    chroms: [{ name: 'chr19', size: 58_000_000 }], navigationMode: 'linked', selectedDatasets: new Set(),
    panels: [panel('human'), panel('fly', { genome: 'dm6', viewportOverride: { chrom: 'chr2L', start: 10, end: 500 } })],
    highlights: [], bookmarks: [], navigatorRegions: [],
  } as never);
});

// On a plasmid the Regions catalog said "regions on hg38": plasmid maps are contigs of the
// main genome (their regions are kept in its catalog), so it now names the plasmid too.
describe('the Regions catalog names its reference', () => {
  it('the genome; on a plasmid, the plasmid and the genome; the plasmid alone without a genome', () => {
    useBrowserStore.setState({ chroms: [{ name: 'chr19', size: 58_000_000 }, { name: 'pA', size: 5_000, circular: true, plasmid: true }] } as never);
    expect(catalogReferenceLabel('hg38')).toBe('hg38');
    expect(catalogReferenceLabel('dm6')).toBe('dm6');
    useBrowserStore.setState({ chrom: 'pA', start: 0, end: 5_000 } as never);
    expect(catalogReferenceLabel('hg38')).toBe('pA and hg38');
    expect(catalogReferenceLabel('dm6')).toBe('dm6');
    useBrowserStore.setState({ currentGenome: null } as never);
    expect(catalogReferenceLabel('none')).toBe('pA');
    // A plasmid shown beside the genome's reads (a copy panel at the plasmid) is named too.
    useBrowserStore.setState({ currentGenome: 'hg38', chrom: 'chr19', panels: [panel('human'), panel('copy', { viewportOverride: { chrom: 'pA', start: 0, end: 5_000 } })] } as never);
    expect(catalogReferenceLabel('hg38')).toBe('pA and hg38');
  });
});

describe('regions open where their reference is shown', () => {
  it('main genome → the main view; another assembly → its own panel; a selected panel is targeted', () => {
    const s = useBrowserStore.getState();
    expect(mainGenomeKey(s)).toBe('hg38');
    expect(mainGenomeKey({ currentGenome: null, fastaPath: '/data/my_ref.fa' })).toBe('my_ref.fa');
    expect(regionTarget('hg38')).toEqual({ kind: 'main' });
    expect(regionTarget('dm6')).toEqual({ kind: 'panel', panelId: 'fly' });
    expect(regionTarget('mm10')).toBeNull();
    expect(targetGenome()).toBe('hg38');
    useBrowserStore.setState({ selectedDatasets: new Set(['fly']) } as never);
    expect(targetGenome()).toBe('dm6');

    expect(goToRegion('dm6', entry('a', 'chr2L', 5_000, 6_000))).toBeNull();
    const fly = useBrowserStore.getState().panels.find(p => p.id === 'fly')!;
    expect(fly.viewportOverride).toEqual({ chrom: 'chr2L', start: 5_000, end: 6_000 });
    expect(useBrowserStore.getState().chrom).toBe('chr19');
    // A detected amplicon is shown with a margin.
    goToRegion('hg38', entry('b', 'chr19', 10_000, 12_000, { source: 'auto' }));
    expect([useBrowserStore.getState().start, useBrowserStore.getState().end]).toEqual([9_900, 12_100]);
    expect(goToRegion('mm10', entry('c', 'chr1', 1, 9))).toMatch(/No panel shows mm10/);
  });

  it('Per panel: a main-genome region opens in the targeted panel', () => {
    useBrowserStore.setState({
      navigationMode: 'perPanel',
      panels: [panel('h1', { viewportOverride: { chrom: 'chr19', start: 1, end: 9 }, navOwn: true }), panel('h2', { viewportOverride: { chrom: 'chr19', start: 1, end: 9 }, navOwn: true })],
      selectedDatasets: new Set(['h2']),
    } as never);
    expect(regionTarget('hg38')).toEqual({ kind: 'panel', panelId: 'h2' });
    goToRegion('hg38', entry('a', 'chr19', 500, 900));
    const [h1, h2] = useBrowserStore.getState().panels;
    expect(h1.viewportOverride).toEqual({ chrom: 'chr19', start: 1, end: 9 });
    expect(h2.viewportOverride).toEqual({ chrom: 'chr19', start: 500, end: 900 });
  });

  it('next / previous step through the current category, wrapping round', () => {
    let c = addCategory(emptyCatalog('hg38'), { id: 'c', name: 'Peaks' }).catalog;
    c = addEntries(c, 'c', [entry('p1', 'chr19', 100, 200), entry('p2', 'chr19', 300, 400)]).catalog;
    useRegionCatalogStore.setState({ catalogs: { hg38: c } });
    stepRegion(1);
    expect(useBrowserStore.getState().start).toBe(100);
    stepRegion(1);
    expect(useBrowserStore.getState().start).toBe(300);
    stepRegion(1);
    expect(useBrowserStore.getState().start).toBe(100);
    stepRegion(-1);
    expect(useBrowserStore.getState().start).toBe(300);
  });
});

describe('one list: bookmarks and saved views become regions; sessions carry the catalog', () => {
  /** A catalog server in memory: GET, PUT (with revisions; `failPut` refuses writes). */
  function catalogServer(options: { failPut?: boolean } = {}) {
    const files: Record<string, any> = {};
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(String(url), 'http://x');
      if (u.pathname === '/api/regions/catalog' && (!init?.method || init.method === 'GET')) {
        const g = u.searchParams.get('genome')!;
        return { ok: true, status: 200, json: async () => ({ success: true, catalog: files[g] ?? { genome: g, revision: 0, categories: [], entries: [] } }) } as Response;
      }
      if (u.pathname === '/api/regions/catalog' && init?.method === 'PUT') {
        if (options.failPut) return { ok: false, status: 500, json: async () => ({ detail: 'disk full' }) } as Response;
        const body = JSON.parse(String(init.body));
        const current = files[body.genome]?.revision ?? 0;
        if (body.base_revision != null && body.base_revision !== current) {
          return { ok: false, status: 409, json: async () => ({ success: false, conflict: true, catalog: files[body.genome] }) } as Response;
        }
        files[body.genome] = { ...body.catalog, revision: current + 1 };
        return { ok: true, status: 200, json: async () => ({ success: true, revision: current + 1 }) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    setRegionCatalogPersistence(() => true);
    return files;
  }

  const legacy = () => useBrowserStore.setState({
    bookmarks: [{ id: 'b1', name: 'NAPA promoter', chrom: 'chr19', start: 10, end: 90, created: '2026-01-01' }],
    navigatorRegions: [
      { id: 'n1', chrom: 'chr19', start: 5, end: 50, label: 'Viewport', source: 'navigator' },
      { id: 'x1', chrom: 'chr19', start: 5, end: 50, label: 'X', source: 'contact' },
    ],
  } as never);

  it('moves bookmarks and Add View regions into the catalog once it is saved, leaving comparison regions alone', async () => {
    const files = catalogServer();
    localStorage.setItem('fiberhmm_bookmarks', JSON.stringify([{ id: 'b1' }]));
    legacy();
    expect(await migrateLegacyRegions()).toEqual({ bookmarks: 1, views: 1 });
    const cat = useRegionCatalogStore.getState().catalogs.hg38;
    expect(cat.categories.map(c => c.name)).toEqual(['Bookmarks', 'Saved views']);
    expect(cat.entries.map(e => [e.label, e.source])).toEqual([['NAPA promoter', 'bookmark'], ['Viewport', 'navigator']]);
    // Saved to the user's file before the old lists were emptied.
    expect(files.hg38.entries.map((e: any) => e.label)).toEqual(['NAPA promoter', 'Viewport']);
    expect(useBrowserStore.getState().bookmarks).toEqual([]);
    expect(localStorage.getItem('fiberhmm_bookmarks')).toBe('[]');
    expect(useBrowserStore.getState().navigatorRegions.map(r => r.id)).toEqual(['x1']);
    // Again (a session's bookmarks re-imported): nothing doubles.
    useBrowserStore.setState({ bookmarks: [{ id: 'b1', name: 'NAPA promoter', chrom: 'chr19', start: 10, end: 90, created: '' }] } as never);
    await migrateLegacyRegions();
    expect(useRegionCatalogStore.getState().catalogs.hg38.entries).toHaveLength(2);
    setRegionCatalogPersistence(() => false);
  });

  it('keeps the old bookmarks when the catalog cannot be saved', async () => {
    catalogServer({ failPut: true });
    localStorage.setItem('fiberhmm_bookmarks', JSON.stringify([{ id: 'b1', name: 'NAPA promoter', chrom: 'chr19', start: 10, end: 90, created: '' }]));
    legacy();
    expect(await migrateLegacyRegions()).toEqual({ bookmarks: 0, views: 0 });
    expect(useBrowserStore.getState().bookmarks).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem('fiberhmm_bookmarks')!)).toHaveLength(1);
    expect(useRegionCatalogStore.getState().saveError).toMatch(/disk full/);
    setRegionCatalogPersistence(() => false);
  });

  it('two windows saving: the later one puts its changes on top instead of overwriting', async () => {
    const files = catalogServer();
    files.dm6 = { genome: 'dm6', revision: 1, categories: [{ id: 'c', name: 'Mine' }], entries: [entry('e1', 'chr2L', 1, 9, { category: 'c' })] };
    await useRegionCatalogStore.getState().ensureLoaded('dm6');
    // Another window adds a region and saves (revision 2).
    files.dm6 = { ...files.dm6, revision: 2, entries: [...files.dm6.entries, entry('other', 'chr2L', 20, 30, { category: 'c' })] };
    // This window renames e1 and deletes nothing; then saves from revision 1.
    useRegionCatalogStore.getState().updateEntry('dm6', 'e1', { label: 'renamed here' });
    expect(await saveRegionCatalogNow('dm6')).toBe(true);
    expect(files.dm6.revision).toBe(3);
    expect(files.dm6.entries.map((e: any) => e.label)).toEqual(['renamed here', 'other']);
    expect(useRegionCatalogStore.getState().catalogs.dm6.entries.map(e => e.label)).toEqual(['renamed here', 'other']);
    // A deletion here is not undone by the other window's copy.
    useRegionCatalogStore.getState().removeEntries('dm6', ['other']);
    files.dm6 = { ...files.dm6, revision: 4 };  // the other window saved again, unchanged
    expect(await saveRegionCatalogNow('dm6')).toBe(true);
    expect(files.dm6.entries.map((e: any) => e.id)).toEqual(['e1']);
    setRegionCatalogPersistence(() => false);
  });

  it('a session payload restores (and merges into) the catalog', async () => {
    let c = addCategory(emptyCatalog('dm6'), { id: 'c', name: 'Mine' }).catalog;
    c = addEntries(c, 'c', [entry('e1', 'chr2L', 1, 9)]).catalog;
    useRegionCatalogStore.setState({ catalogs: { dm6: c } });
    const payload = JSON.parse(JSON.stringify(useRegionCatalogStore.getState().sessionPayload()));
    useRegionCatalogStore.setState({ catalogs: { dm6: addEntries(addCategory(emptyCatalog('dm6'), { id: 'k', name: 'Kept' }).catalog, 'k', [entry('e9', 'chr3R', 5, 6)]).catalog } });
    useRegionCatalogStore.getState().restoreSession(payload);
    expect(useRegionCatalogStore.getState().catalogs.dm6.entries.map(e => e.id)).toEqual(['e9', 'e1']);
    await flushRegionCatalogSaves();
  });

  it('a detection waits for the saved catalog: a renamed amplicon list is reused, never doubled', async () => {
    const saved = addEntries(addCategory(emptyCatalog('dm6'), { id: 'auto1', name: 'Amplicons · flyamp', source: 'auto', fingerprint: 'fp' }).catalog,
      'auto1', [entry('a1', 'chr2L', 100, 900, { label: 'my name', autoLabel: 'numb', source: 'auto', category: 'auto1' })]).catalog;
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    vi.stubGlobal('fetch', vi.fn(async () => { await gate; return { ok: true, json: async () => ({ success: true, catalog: saved }) } as Response; }));
    setRegionCatalogPersistence(() => true);
    const store = useRegionCatalogStore.getState();
    const first = store.ensureLoaded('dm6');
    const second = store.ensureLoaded('dm6');  // a second caller (the detection) waits for the same read
    let done = false;
    void second.then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    release();
    await first; await second;
    const id = useRegionCatalogStore.getState().applyDetection({
      success: true, kind: 'amplicon', genome: 'dm6', fingerprint: 'fp', regions: [{ chrom: 'chr2L', start: 100, end: 900, reads: 50, label: 'numb', gene: 'numb' }],
    }, 'flyamp', 'auto');
    expect(id).toBe('auto1');
    expect(useRegionCatalogStore.getState().catalogs.dm6.entries.map(e => e.label)).toEqual(['my name']);
    setRegionCatalogPersistence(() => false);
  });

  it('highlight actions file highlights under the right reference', () => {
    highlightRegion({ chrom: 'chr19', start: 50, end: 10 });
    highlightReadRegion({ start: 100, end: 900, name: 'read/1' }, 'fly');
    expect(useBrowserStore.getState().highlights.map(h => [h.genome, h.chrom, h.start, h.end, h.label ?? null])).toEqual([
      ['hg38', 'chr19', 10, 50, null],
      ['dm6', 'chr2L', 100, 900, 'read/1'],
    ]);
  });
});
