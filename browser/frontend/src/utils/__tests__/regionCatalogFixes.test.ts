/**
 * Regions fixes from the 3.0 audit (fb-n2-regions): undo of removals and moves,
 * moving regions between references, the BED reference check, one stepping
 * context for N / P and the panel's ‹ ›, a failed catalog read that is tried
 * again, and amplicons that leave a reference their dataset is not on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { flushRegionCatalogSaves, setRegionCatalogPersistence, useRegionCatalogStore } from '../../stores/regionCatalogStore';
import { regionGoNote, stepGenome, stepRegion } from '../regionNavigation';
import { addCategory, addEntries, emptyCatalog, moveBetweenCatalogs, removeCategory, revertCatalogChange, updateEntry } from '../regionCatalog';
import { bedReferenceFit, parseRegionBed } from '../regionBed';
import { bedImportCheck } from '../../components/controls/regions/RegionCatalog';
import type { RegionEntry } from '../../types/regions';

const panel = (id: string, extra: Record<string, unknown> = {}) => ({
  id, contentType: 'dataset', datasetId: id, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, ...extra,
});
const entry = (id: string, chrom: string, start: number, end: number, extra: Partial<RegionEntry> = {}): Omit<RegionEntry, 'category'> & { category?: string } =>
  ({ id, chrom, start, end, label: id, source: 'saved', ...extra });

function twoCategories() {
  let c = emptyCatalog('hg38');
  c = addCategory(c, { id: 'a', name: 'A' }).catalog;
  c = addCategory(c, { id: 'b', name: 'B' }).catalog;
  c = addCategory(c, { id: 'b1', name: 'B sub', parent: 'b' }).catalog;
  c = addCategory(c, { id: 'z', name: 'Z' }).catalog;
  c = addEntries(c, 'a', [entry('a1', 'chr1', 1, 9)]).catalog;
  c = addEntries(c, 'b', [entry('b-1', 'chr1', 10, 20), entry('b-2', 'chr1', 30, 40)]).catalog;
  c = addEntries(c, 'b1', [entry('b1-1', 'chr1', 50, 60)]).catalog;
  c = addEntries(c, 'z', [entry('z1', 'chr1', 70, 80)]).catalog;
  return c;
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ success: true, catalog: { categories: [], entries: [] } }) }) as Response));
  setRegionCatalogPersistence(() => false);
  useRegionCatalogStore.setState({ catalogs: {}, sync: {}, fingerprints: {}, scans: {}, active: null, recent: [], shown: null, picked: null, undo: null, loadErrors: {}, saveError: null });
  useBrowserStore.setState({
    currentGenome: 'hg38', fastaPath: null, chrom: 'chr19', start: 1000, end: 2000,
    chroms: [{ name: 'chr19', size: 58_000_000 }], navigationMode: 'linked', selectedDatasets: new Set(),
    datasets: [{ id: 'human', label: 'napa_ddda' }, { id: 'fly', label: 'FlyAmp' }, { id: 'fly2', label: 'stage_d_recalled' }],
    panels: [panel('human'), panel('fly', { genome: 'dm6', viewportOverride: { chrom: 'chr2L', start: 10, end: 500 } })],
    highlights: [], bookmarks: [], navigatorRegions: [],
  } as never);
});

describe('undoing a removal (M18, Codex 23)', () => {
  it('a deleted category comes back where it was, with its subheading and regions; later edits are kept', () => {
    const before = twoCategories();
    const after = removeCategory(before, 'b');
    expect(after.categories.map(c => c.id)).toEqual(['a', 'z']);
    // Edited since: a rename and a new region.
    let now = updateEntry(after, 'z1', { label: 'renamed since' });
    now = addEntries(now, 'a', [entry('new', 'chr1', 90, 95)]).catalog;
    const undone = revertCatalogChange(before, after, now);
    expect(undone.categories.map(c => c.id)).toEqual(['a', 'b', 'b1', 'z']);
    expect(undone.entries.map(e => e.id)).toEqual(['a1', 'b-1', 'b-2', 'b1-1', 'z1', 'new']);
    expect(undone.entries.find(e => e.id === 'z1')!.label).toBe('renamed since');
  });

  it('the store: Delete then Undo; Undo is offered once', () => {
    useRegionCatalogStore.setState({ catalogs: { hg38: twoCategories() } });
    const store = useRegionCatalogStore.getState();
    // A tour's cleanup is not offered for Undo; a removal the user asked for is.
    store.removeEntries('hg38', ['a1']);
    expect(useRegionCatalogStore.getState().undo).toBeNull();
    store.addEntries('hg38', 'a', [entry('a1', 'chr1', 1, 9)]);
    store.removeCategory('hg38', 'b', { undoable: true });
    expect(useRegionCatalogStore.getState().undo?.label).toBe('Deleted B');
    expect(useRegionCatalogStore.getState().catalogs.hg38.entries).toHaveLength(2);
    expect(useRegionCatalogStore.getState().undoLast()).toBe('Deleted B');
    expect(useRegionCatalogStore.getState().catalogs.hg38.entries.map(e => e.id)).toEqual(['b-1', 'b-2', 'b1-1', 'z1', 'a1']);
    expect(useRegionCatalogStore.getState().undo).toBeNull();
    // Removing selected regions is undoable too.
    useRegionCatalogStore.getState().removeEntries('hg38', ['b-2', 'z1'], { undoable: true });
    expect(useRegionCatalogStore.getState().undo?.label).toBe('Removed 2 regions');
    useRegionCatalogStore.getState().undoLast();
    expect(useRegionCatalogStore.getState().catalogs.hg38.entries).toHaveLength(5);
  });
});

describe('moving regions to another reference (H4, M16)', () => {
  it('a category moves whole; a dataset’s amplicons become an ordinary category; single regions join a same-name category', () => {
    let hg = twoCategories();
    hg = addCategory(hg, { id: 'amp', name: 'Amplicons · Dl', source: 'auto', fingerprint: 'fp' }).catalog;
    hg = addEntries(hg, 'amp', [entry('x1', 'chrX', 100, 900, { source: 'auto' })]).catalog;
    let dm = addCategory(emptyCatalog('dm6'), { id: 'a', name: 'A' }).catalog;  // the same id is taken there
    dm = addEntries(dm, 'a', [entry('a1', 'chr2L', 5, 9)]).catalog;
    const res = moveBetweenCatalogs(hg, dm, { categoryIds: ['b', 'amp'], entryIds: ['z1'] });
    expect(res.moved).toBe(5);
    expect(res.source.categories.map(c => c.id)).toEqual(['a', 'z']);
    expect(res.source.entries.map(e => e.id)).toEqual(['a1']);
    const names = res.target.categories.map(c => [c.name, c.parent ? 'sub' : 'top', c.source ?? null, c.fingerprint ?? null]);
    expect(names).toEqual([['A', 'top', null, null], ['B', 'top', null, null], ['B sub', 'sub', null, null], ['Amplicons · Dl', 'top', 'user', null], ['Z', 'top', null, null]]);
    expect(res.target.entries.map(e => e.id)).toEqual(['a1', 'b-1', 'b-2', 'b1-1', 'x1', 'z1']);
  });

  it('the store moves and undoes in both catalogs', async () => {
    useRegionCatalogStore.setState({ catalogs: { hg38: twoCategories(), dm6: emptyCatalog('dm6') }, sync: { hg38: 'local', dm6: 'local' } });
    expect(await useRegionCatalogStore.getState().moveToGenome('hg38', 'dm6', { categoryIds: ['b'] })).toEqual({ moved: 3 });
    expect(useRegionCatalogStore.getState().catalogs.dm6.entries).toHaveLength(3);
    expect(useRegionCatalogStore.getState().undo?.label).toBe('Moved 3 regions to dm6');
    useRegionCatalogStore.getState().undoLast();
    expect(useRegionCatalogStore.getState().catalogs.dm6.entries).toHaveLength(0);
    expect(useRegionCatalogStore.getState().catalogs.hg38.categories.map(c => c.id)).toEqual(['a', 'b', 'b1', 'z']);
  });

  it('a dataset’s detected amplicons can be dropped from a reference it is not on', async () => {
    let hg = addCategory(emptyCatalog('hg38'), { id: 'amp', name: 'Amplicons · Dl', source: 'auto', fingerprint: 'fp' }).catalog;
    hg = addCategory(hg, { id: 'mine', name: 'Mine' }).catalog;
    hg = addEntries(hg, 'amp', [entry('x1', 'chrX', 100, 900, { source: 'auto' })]).catalog;
    useRegionCatalogStore.setState({ catalogs: { hg38: hg }, sync: { hg38: 'local' } });
    await useRegionCatalogStore.getState().dropDetected('hg38', 'fp');
    expect(useRegionCatalogStore.getState().catalogs.hg38.categories.map(c => c.id)).toEqual(['mine']);
    expect(useRegionCatalogStore.getState().catalogs.hg38.entries).toEqual([]);
  });
});

describe('a BED file is checked against the references shown (H4)', () => {
  const hg38 = { key: 'hg38', chroms: [{ name: 'chr19', size: 58_617_616 }, { name: 'chrX', size: 156_040_895 }, { name: 'chr4', size: 190_214_555 }] };
  const dm6 = { key: 'dm6', chroms: [{ name: 'chr2L', size: 23_513_712 }, { name: 'chr2R', size: 25_286_936 }, { name: 'chr3R', size: 32_079_331 }, { name: 'chrX', size: 23_542_271 }] };
  const fly = parseRegionBed('track name="DV enhancers"\nchr2R\t9974318\t9975000\teve_stripe2\nchr3R\t6758000\t6760000\tftz_zebra\n').regions;

  it('dm6 regions under hg38: dm6 is offered', () => {
    expect(bedReferenceFit(fly, [hg38, dm6]).map(f => [f.key, f.fits])).toEqual([['dm6', 2], ['hg38', 0]]);
    expect(bedImportCheck(fly, 'hg38', [hg38, dm6])).toEqual({ kind: 'elsewhere', genome: 'dm6', missing: ['chr2R', 'chr3R'] });
    expect(bedImportCheck(fly, 'dm6', [hg38, dm6])).toEqual({ kind: 'ok' });
  });

  it('chromosomes no reference has: asked; regions both fit (chrX in each): imported as asked', () => {
    const odd = parseRegionBed('scaffold_9\t1\t100\n').regions;
    expect(bedImportCheck(odd, 'hg38', [hg38, dm6])).toEqual({ kind: 'unknown', missing: ['scaffold_9'] });
    const both = parseRegionBed('chrX\t1000\t2000\nX\t5000\t6000\n').regions;
    expect(bedImportCheck(both, 'hg38', [hg38, dm6])).toEqual({ kind: 'ok' });
    // Nothing known about the target's chromosomes: no question.
    expect(bedImportCheck(fly, 'hg38', [{ key: 'hg38', chroms: [] }, dm6])).toEqual({ kind: 'ok' });
  });
});

describe('one stepping context for N / P and the Regions panel (M15, Codex 28)', () => {
  const seed = () => {
    let hg = addCategory(emptyCatalog('hg38'), { id: 'h', name: 'Amplicons · napa' }).catalog;
    hg = addEntries(hg, 'h', [entry('napa', 'chr19', 47_514_487, 47_518_985)]).catalog;
    let dm = addCategory(emptyCatalog('dm6'), { id: 'd', name: 'Amplicons · FlyAmp' }).catalog;
    dm = addEntries(dm, 'd', [entry('cg', 'chr2L', 6_356_893, 6_357_548), entry('numb', 'chr2L', 9_464_006, 9_467_048)]).catalog;
    useRegionCatalogStore.setState({ catalogs: { hg38: hg, dm6: dm } });
  };

  it('with the dm6 catalog shown and an hg38 panel selected, N steps dm6', () => {
    seed();
    useBrowserStore.setState({ selectedDatasets: new Set(['human']) } as never);
    useRegionCatalogStore.getState().setShown('dm6');
    expect(stepGenome()).toBe('dm6');
    expect(stepRegion(1)).toBeNull();
    const s = useBrowserStore.getState();
    expect(s.panels.find(p => p.id === 'fly')!.viewportOverride).toEqual({ chrom: 'chr2L', start: 6_356_893, end: 6_357_548 });
    expect([s.chrom, s.start]).toEqual(['chr19', 1000]);
    // The panel closed: the reference last stepped stays the context while a panel shows it.
    useRegionCatalogStore.getState().setShown(null);
    expect(stepGenome()).toBe('dm6');
    stepRegion(1);
    expect(useBrowserStore.getState().panels.find(p => p.id === 'fly')!.viewportOverride!.start).toBe(9_464_006);
  });

  it('nothing stepped and no panel open: the targeted panel’s reference', () => {
    seed();
    expect(stepGenome()).toBe('hg38');
    useBrowserStore.setState({ selectedDatasets: new Set(['fly']) } as never);
    expect(stepGenome()).toBe('dm6');
  });
});

describe('Go to a region with several panels on its reference (L4)', () => {
  it('says which panel moved when none is selected', () => {
    useBrowserStore.setState({
      navigationMode: 'perPanel',
      panels: [panel('human'), panel('fly', { genome: 'dm6', viewportOverride: { chrom: 'chr2L', start: 10, end: 500 } }),
        panel('fly2', { genome: 'dm6', viewportOverride: { chrom: 'chr2L', start: 10, end: 500 } })],
    } as never);
    expect(regionGoNote('dm6')).toBe('Shown in FlyAmp. To show it in another dm6 panel, select that panel first.');
    useBrowserStore.setState({ selectedDatasets: new Set(['fly2']) } as never);
    expect(regionGoNote('dm6')).toBeNull();
    expect(regionGoNote('hg38')).toBeNull();
  });
});

describe('a catalog read that fails is tried again (Codex 25)', () => {
  it('error, then Retry reads it, keeps the edits made meanwhile and saves them', async () => {
    const saved = addEntries(addCategory(emptyCatalog('dm6'), { id: 's', name: 'Saved' }).catalog, 's', [entry('old', 'chr2L', 1, 9)]).catalog;
    let fail = true;
    const puts: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        puts.push(JSON.parse(String(init.body)));
        return { ok: true, status: 200, json: async () => ({ success: true, revision: 2 }) } as Response;
      }
      if (fail) return { ok: false, status: 502, json: async () => ({ detail: 'Bad gateway' }) } as Response;
      return { ok: true, status: 200, json: async () => ({ success: true, catalog: { ...saved, revision: 1 } }) } as Response;
    }));
    setRegionCatalogPersistence(() => true);
    const store = useRegionCatalogStore.getState();
    await store.ensureLoaded('dm6');
    expect(useRegionCatalogStore.getState().sync.dm6).toBe('error');
    expect(useRegionCatalogStore.getState().loadErrors.dm6).toBeTruthy();
    // An edit meanwhile stays in the window.
    useRegionCatalogStore.getState().addCategory('dm6', { id: 'new', name: 'New' });
    fail = false;
    await useRegionCatalogStore.getState().ensureLoaded('dm6');
    expect(useRegionCatalogStore.getState().sync.dm6).toBe('ready');
    expect(useRegionCatalogStore.getState().loadErrors.dm6).toBeUndefined();
    expect(useRegionCatalogStore.getState().catalogs.dm6.categories.map(c => c.id)).toEqual(['s', 'new']);
    await flushRegionCatalogSaves();
    expect(puts.at(-1).catalog.categories.map((c: any) => c.id)).toEqual(['s', 'new']);
    setRegionCatalogPersistence(() => false);
  });

  it('a save the server refuses as too large says so', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') return { ok: false, status: 413, json: async () => ({ too_large: true, detail: 'Too many to save: 200,001 regions (at most 200,000).' }) } as Response;
      return { ok: true, status: 200, json: async () => ({ success: true, catalog: { genome: 'dm6', revision: 0, categories: [], entries: [] } }) } as Response;
    }));
    setRegionCatalogPersistence(() => true);
    await useRegionCatalogStore.getState().ensureLoaded('dm6');
    useRegionCatalogStore.getState().addCategory('dm6', { name: 'Big' });
    await flushRegionCatalogSaves();
    expect(useRegionCatalogStore.getState().saveError).toMatch(/Too many to save/);
    setRegionCatalogPersistence(() => false);
  });
});

describe('Codex review of fb-n2-regions', () => {
  /** A catalog server in memory; `failGet` / `failPut` per reference; records each PUT and GET. */
  function server(options: { failGet?: string[]; failPut?: string[]; identity?: Record<string, string> } = {}) {
    const files: Record<string, any> = {};
    const puts: any[] = [];
    let gate: Promise<void> | null = null;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(String(url), 'http://x');
      if (u.pathname === '/api/regions/catalog' && (!init?.method || init.method === 'GET')) {
        const g = u.searchParams.get('genome')!;
        if (gate) await gate;
        if (options.failGet?.includes(g)) return { ok: false, status: 502, json: async () => ({ detail: 'Bad gateway' }) } as Response;
        return { ok: true, status: 200, json: async () => ({ success: true, identity: options.identity?.[g] ?? '', catalog: files[g] ?? { genome: g, revision: 0, categories: [], entries: [] } }) } as Response;
      }
      if (u.pathname === '/api/regions/catalog' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        puts.push(body);
        if (options.failPut?.includes(body.genome)) return { ok: false, status: 413, json: async () => ({ detail: 'Too many to save' }) } as Response;
        const rev = (files[body.genome]?.revision ?? 0) + 1;
        files[body.genome] = { ...body.catalog, revision: rev };
        return { ok: true, status: 200, json: async () => ({ success: true, revision: rev }) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    setRegionCatalogPersistence(() => true);
    return { files, puts, hold: () => { let open!: () => void; gate = new Promise(r => { open = r; }); return () => { gate = null; open(); }; } };
  }

  it('#1 nothing moves into a catalog that could not be read, or saved', async () => {
    const srv = server({ failGet: ['dm6'] });
    srv.files.hg38 = { ...twoCategories(), revision: 1 };
    await useRegionCatalogStore.getState().ensureLoaded('hg38');
    const res = await useRegionCatalogStore.getState().moveToGenome('hg38', 'dm6', { categoryIds: ['b'] });
    expect(res.moved).toBe(0);
    expect(res.error).toMatch(/dm6 regions could not be read/);
    expect(useRegionCatalogStore.getState().catalogs.hg38.entries).toHaveLength(5);
    expect(srv.puts).toEqual([]);

    const srv2 = server({ failPut: ['dm6'] });
    srv2.files.hg38 = { ...twoCategories(), revision: 1 };
    useRegionCatalogStore.setState({ catalogs: {}, sync: {}, loadErrors: {} });
    await useRegionCatalogStore.getState().ensureLoaded('hg38');
    const res2 = await useRegionCatalogStore.getState().moveToGenome('hg38', 'dm6', { categoryIds: ['b'] });
    expect(res2.moved).toBe(0);
    expect(res2.error).toMatch(/Not moved: .*Too many to save/);
    expect(useRegionCatalogStore.getState().catalogs.dm6.entries).toEqual([]);
    expect(useRegionCatalogStore.getState().catalogs.hg38.entries).toHaveLength(5);
    expect(srv2.puts.map(p => p.genome)).toEqual(['dm6']);
    setRegionCatalogPersistence(() => false);
  });

  it('#2 writes carry the identity the catalog was read under', async () => {
    const srv = server({ identity: { 'reference.fa': 'aaaa1111' } });
    await useRegionCatalogStore.getState().ensureLoaded('reference.fa');
    useRegionCatalogStore.getState().addCategory('reference.fa', { name: 'Mine' });
    await flushRegionCatalogSaves();
    expect(srv.puts.at(-1)).toMatchObject({ genome: 'reference.fa', identity: 'aaaa1111' });
    setRegionCatalogPersistence(() => false);
  });

  it('#3 an answer for a forgotten key (another FASTA now) is dropped', async () => {
    const srv = server({ identity: { 'reference.fa': 'aaaa1111' } });
    srv.files['reference.fa'] = { genome: 'reference.fa', revision: 1, categories: [{ id: 'a', name: "A's" }], entries: [] };
    const release = srv.hold();
    const first = useRegionCatalogStore.getState().ensureLoaded('reference.fa');
    useRegionCatalogStore.getState().forget('reference.fa');
    srv.files['reference.fa'] = { genome: 'reference.fa', revision: 0, categories: [], entries: [] };  // B's (empty)
    const second = useRegionCatalogStore.getState().ensureLoaded('reference.fa');
    expect(second).not.toBe(first);
    release();
    await first; await second;
    expect(useRegionCatalogStore.getState().catalogs['reference.fa'].categories).toEqual([]);
    setRegionCatalogPersistence(() => false);
  });

  it('#4 edits waiting to be saved when the key is forgotten are saved to their own catalog', async () => {
    const srv = server({ identity: { 'reference.fa': 'aaaa1111' } });
    await useRegionCatalogStore.getState().ensureLoaded('reference.fa');
    useRegionCatalogStore.getState().addCategory('reference.fa', { name: 'Renamed just now' });
    useRegionCatalogStore.getState().forget('reference.fa');
    await flushRegionCatalogSaves();
    expect(srv.puts).toHaveLength(1);
    expect(srv.puts[0]).toMatchObject({ identity: 'aaaa1111' });
    expect(srv.puts[0].catalog.categories.map((c: any) => c.name)).toEqual(['Renamed just now']);
    setRegionCatalogPersistence(() => false);
  });

  it('#5 undoing a move keeps edits made there since, and regions added to a moved category', async () => {
    useRegionCatalogStore.setState({ catalogs: { hg38: twoCategories(), dm6: emptyCatalog('dm6') }, sync: { hg38: 'local', dm6: 'local' } });
    const store = useRegionCatalogStore.getState();
    await store.moveToGenome('hg38', 'dm6', { categoryIds: ['b'] });
    store.updateEntry('dm6', 'b-1', { label: 'renamed in dm6' });
    store.addEntries('dm6', 'b', [entry('later', 'chr2L', 5, 50)]);
    useRegionCatalogStore.getState().undoLast();
    const hg = useRegionCatalogStore.getState().catalogs.hg38;
    expect(hg.entries.find(e => e.id === 'b-1')).toMatchObject({ label: 'renamed in dm6', category: 'b' });
    const dm = useRegionCatalogStore.getState().catalogs.dm6;
    expect(dm.entries.map(e => e.id)).toEqual(['later']);
    expect(dm.categories.map(c => c.id)).toEqual(['b']);
  });
});

describe('amplicons saved with the old names (H3)', () => {
  it('a known amplicon category takes the new detected names unless renamed', () => {
    let hg = addCategory(emptyCatalog('hg38'), { id: 'amp', name: 'Amplicons · napa_ddda', source: 'auto', fingerprint: 'fp' }).catalog;
    hg = addEntries(hg, 'amp', [
      entry('napa', 'chr19', 47_514_487, 47_518_985, { label: 'Metazoa_SRP', autoLabel: 'Metazoa_SRP', source: 'auto', detail: 'In Metazoa_SRP (also Y_RNA, NAPA)' }),
      entry('mine', 'chr19', 50_000, 51_000, { label: 'my amplicon', autoLabel: 'Y_RNA', source: 'auto' }),
    ]).catalog;
    useRegionCatalogStore.setState({ catalogs: { hg38: hg }, sync: { hg38: 'local' } });
    const id = useRegionCatalogStore.getState().applyDetection({
      success: true, kind: 'amplicon', genome: 'hg38', fingerprint: 'fp', regions: [
        { chrom: 'chr19', start: 47_514_487, end: 47_518_985, reads: 3202, label: 'NAPA', gene: 'NAPA', detail: 'In NAPA' },
        { chrom: 'chr19', start: 50_000, end: 51_000, reads: 10, label: 'near ZNF541 (1.0 kb)', gene: 'ZNF541', detail: 'Intergenic: ZNF541 1.0 kb away' },
      ],
    }, 'napa_ddda', 'auto');
    expect(id).toBe('amp');
    const entries = useRegionCatalogStore.getState().catalogs.hg38.entries;
    expect(entries.map(e => [e.label, e.autoLabel, e.detail])).toEqual([
      ['NAPA', 'NAPA', 'In NAPA'],
      ['my amplicon', 'near ZNF541 (1.0 kb)', 'Intergenic: ZNF541 1.0 kb away'],
    ]);
    // Detected again with the same regions and names: nothing changes (no save).
    const before = useRegionCatalogStore.getState().catalogs.hg38;
    useRegionCatalogStore.getState().applyDetection({
      success: true, kind: 'amplicon', genome: 'hg38', fingerprint: 'fp', regions: [
        { chrom: 'chr19', start: 47_514_487, end: 47_518_985, reads: 3202, label: 'NAPA', gene: 'NAPA', detail: 'In NAPA' },
        { chrom: 'chr19', start: 50_000, end: 51_000, reads: 10, label: 'near ZNF541 (1.0 kb)', gene: 'ZNF541', detail: 'Intergenic: ZNF541 1.0 kb away' },
      ],
    }, 'napa_ddda', 'auto');
    expect(useRegionCatalogStore.getState().catalogs.hg38).toBe(before);
  });

  it('a scan that finds other regions replaces the earlier ones (a renamed region found again keeps its name)', () => {
    let hg = addCategory(emptyCatalog('hg38'), { id: 'amp', name: 'Read clusters · numb', source: 'auto', fingerprint: 'fp' }).catalog;
    hg = addEntries(hg, 'amp', [
      entry('old', 'chr2L', 100, 200, { label: 'stale', autoLabel: 'stale', source: 'auto' }),
      entry('mine', 'chr2L', 9_390_841, 9_561_841, { label: 'numb locus', autoLabel: 'numb', source: 'auto' }),
    ]).catalog;
    useRegionCatalogStore.setState({ catalogs: { hg38: hg }, sync: { hg38: 'local' } });
    useRegionCatalogStore.getState().applyDetection({
      success: true, kind: 'targeted', method: 'index', genome: 'hg38', fingerprint: 'fp', regions: [
        { chrom: 'chr2L', start: 6_295_991, end: 6_472_991, reads: 27204, label: 'DIP-epsilon', gene: 'DIP-epsilon' },
        { chrom: 'chr2L', start: 9_390_841, end: 9_561_841, reads: 24648, label: 'numb', gene: 'numb' },
      ],
    }, 'numb', 'auto');
    const cat = useRegionCatalogStore.getState().catalogs.hg38;
    expect(cat.entries.map(e => e.label)).toEqual(['DIP-epsilon', 'numb locus']);
    expect(cat.categories.find(c => c.id === 'amp')!.name).toBe('Regions · numb');
  });
});
