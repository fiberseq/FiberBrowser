import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { searchGene } = vi.hoisted(() => ({ searchGene: vi.fn() }));
vi.mock('../../api/reference', () => ({ searchGene }));

import { matchScore, normalizeText, rankItems } from './fuzzy';
import {
  asyncScoreCeiling, bestSuggestion, getSearchProviders, normalizeRunResult, orderGroups, registerSearchProvider,
  runFromPalette, runSearchSuggestion, SEARCH_SCORE, searchProviders, searchProvidersNow, setMainLocusBoxRunner, type SearchContext,
} from './providers';
import { geneProvider, locusProvider, looksLikeGene, parseGeneWithPadding } from './locusProviders';
import { registerBuiltinSearchProviders } from './builtinProviders';
import { useBrowserStore } from '../../stores/browserStore';

const ctx = (extra: Partial<SearchContext> = {}): SearchContext => ({ source: 'palette', signal: new AbortController().signal, ...extra });

describe('matching', () => {
  it('normalizes case, accents and punctuation', () => {
    expect(normalizeText('Read-End  Footprints!')).toBe('read end footprints');
    expect(normalizeText('Café')).toBe('cafe');
  });

  it('needs every word, and ranks title over synonyms over place', () => {
    expect(matchScore('terminal gaps', { title: 'Hide terminal gaps' })).toBeGreaterThan(0);
    expect(matchScore('terminal sizes', { title: 'Hide terminal gaps' })).toBe(0);
    const title = matchScore('edges', { title: 'Footprint edges' });
    const keyword = matchScore('edges', { title: 'Hide terminal gaps', keywords: ['edges'] });
    const place = matchScore('edges', { title: 'Something', context: 'Edges menu' });
    expect(title).toBeGreaterThan(keyword);
    expect(keyword).toBeGreaterThan(place);
    expect(place).toBeGreaterThan(0);
  });

  it('takes word starts, words inside, and a few letters in order', () => {
    expect(matchScore('term', { title: 'Hide terminal gaps' })).toBeGreaterThan(0);
    expect(matchScore('minal', { title: 'Hide terminal gaps' })).toBeGreaterThan(0);
    expect(matchScore('trmnl', { title: 'Hide terminal gaps' })).toBeGreaterThan(0);
    expect(matchScore('xyz', { title: 'Hide terminal gaps' })).toBe(0);
  });

  it('an exact title beats a longer one; empty matches all', () => {
    const items = [{ t: 'Undo history timeline' }, { t: 'Undo' }];
    expect(rankItems('undo', items, i => ({ title: i.t })).map(r => r.item.t)).toEqual(['Undo', 'Undo history timeline']);
    expect(rankItems('', items, i => ({ title: i.t }))).toHaveLength(2);
  });
});

describe('Go-to providers', () => {
  const initial = useBrowserStore.getState();
  beforeEach(() => {
    searchGene.mockReset();
    useBrowserStore.setState({
      chroms: [{ name: 'chr1', size: 1_000_000 }, { name: 'chrX', size: 500_000 }] as never,
      navigationMode: 'linked',
    });
  });
  afterEach(() => useBrowserStore.setState(initial, true));

  it('offers coordinates and moves the main view under the reference name', () => {
    const setViewport = vi.fn();
    useBrowserStore.setState({ setViewport });
    const [s] = locusProvider.search('1:1,000-2,000', ctx()) as ReturnType<typeof locusProvider.search> & unknown[];
    expect(s.label).toBe('1:1,000-2,000');
    expect(s.disabledReason).toBeUndefined();
    s.run(ctx());
    expect(setViewport).toHaveBeenCalledWith('chr1', 1000, 2000);
    expect(locusProvider.search('terminal', ctx())).toEqual([]);
    const [unknown] = locusProvider.search('chrZ:1-10', ctx()) as any[];
    expect(unknown.disabledReason).toMatch(/No chromosome chrZ/);
  });

  it('is off while each panel navigates', () => {
    useBrowserStore.setState({ navigationMode: 'perPanel' });
    const [s] = locusProvider.search('chr1:1-100', ctx()) as any[];
    expect(s.disabledReason).toMatch(/Each panel navigates/);
  });

  it('finds a gene as the locus box does (the gene, or its TSS ± padding)', async () => {
    const setViewport = vi.fn();
    useBrowserStore.setState({ setViewport });
    searchGene.mockResolvedValue({ found: true, chrom: 'chrX', start: 100, end: 900, tss: 100, gene_name: 'roX1' });
    const [plain] = await geneProvider.search('rox1', ctx());
    expect(plain).toMatchObject({ label: 'roX1', detail: 'chrX:100-900', score: 900 });
    plain.run(ctx());
    expect(setViewport).toHaveBeenLastCalledWith('chrX', 100, 900);
    const [padded] = await geneProvider.search('roX1 +/- 2kb', ctx());
    expect(padded.label).toBe('roX1 ± 2,000 bp');
    padded.run(ctx());
    expect(setViewport).toHaveBeenLastCalledWith('chrX', 0, 2100);
    expect(searchGene).toHaveBeenLastCalledWith('roX1', expect.objectContaining({ signal: expect.anything() }), undefined, undefined);
  });

  it('offers the names the server suggests, and asks nothing for non-gene text', async () => {
    searchGene.mockResolvedValue({ found: false, suggestions: ['NAPA', 'NAPB'] });
    const out = await geneProvider.search('NAP', ctx());
    expect(out.map(s => s.label)).toEqual(['NAPA', 'NAPB']);
    expect(out.every(s => s.guess)).toBe(true);
    expect(out[0].score).toBeLessThan(500);
    searchGene.mockClear();
    expect(await geneProvider.search('hide terminal gaps', ctx())).toEqual([]);
    expect(await geneProvider.search('chr1:1-2', ctx())).toEqual([]);
    expect(searchGene).not.toHaveBeenCalled();
    expect(looksLikeGene('TP53')).toBe(true);
    expect(parseGeneWithPadding('TP53 +- 1.5kb')).toEqual({ gene: 'TP53', padding: 1500 });
  });

  it("a suggestion's slow lookup doesn't undo a newer navigation (Codex review)", async () => {
    const setViewport = vi.fn((chrom: string, start: number, end: number) => useBrowserStore.setState({ chrom, start, end }));
    useBrowserStore.setState({ setViewport, chrom: 'chr1', start: 0, end: 100 });
    searchGene.mockResolvedValueOnce({ found: false, suggestions: ['NAPA'] });
    const [suggestion] = await geneProvider.search('NAP', ctx());
    let answer!: (value: unknown) => void;
    searchGene.mockReturnValueOnce(new Promise(resolve => { answer = resolve; }));
    const pending = suggestion.run(ctx());
    // Meanwhile the user goes elsewhere.
    (locusProvider.search('chrX:1-500', ctx()) as any[])[0].run(ctx());
    answer({ found: true, chrom: 'chr19', start: 10, end: 20 });
    await pending;
    expect(setViewport).toHaveBeenCalledTimes(1);
    expect(useBrowserStore.getState().chrom).toBe('chrX');
  });

  it('groups providers, asks the server ones separately, and drops failures', async () => {
    registerBuiltinSearchProviders();
    registerBuiltinSearchProviders();  // once
    expect(getSearchProviders().filter(p => p.id === 'locus')).toHaveLength(1);
    const remove = registerSearchProvider({
      id: 'test-regions', kind: 'region', label: 'Regions', order: 30,
      search: q => (q === 'promoter' ? [{ id: 'r1', kind: 'region', label: 'NAPA promoter', score: 300, run: () => {} }] : []),
    });
    const broken = registerSearchProvider({ id: 'broken', kind: 'read', label: 'Reads', search: () => { throw new Error('no'); } });
    try {
      expect(searchProvidersNow('promoter', ctx()).map(g => g.provider.id)).toEqual(['test-regions']);
      searchGene.mockResolvedValue({ found: false, suggestions: [] });
      expect((await searchProviders('promoter', ctx(), 'async')).map(g => g.provider.id)).toEqual([]);
      const aborted = new AbortController();
      aborted.abort();
      expect(await searchProviders('promoter', ctx({ signal: aborted.signal }))).toEqual([]);
    } finally {
      remove();
      broken();
    }
    expect(getSearchProviders().some(p => p.id === 'test-regions')).toBe(false);
  });
});

describe('one search for the locus boxes and the palette (integ-r4)', () => {
  const initial = useBrowserStore.getState();
  const genome = 'hg38';
  let offCatalog: (() => void) | null = null;
  beforeEach(async () => {
    searchGene.mockReset();
    registerBuiltinSearchProviders();
    useBrowserStore.setState({
      chroms: [{ name: 'chr19', size: 58_000_000 }] as never, navigationMode: 'linked', currentGenome: genome,
    } as never);
    // A saved region named exactly like a gene, and one named otherwise.
    const { useRegionCatalogStore } = await import('../../stores/regionCatalogStore');
    const { emptyCatalog, addCategory, addEntries } = await import('../regionCatalog');
    let c = emptyCatalog(genome);
    const cat = addCategory(c, { name: 'Enhancers' }); c = cat.catalog;
    c = addEntries(c, cat.id, [
      { chrom: 'chr19', start: 100, end: 200, label: 'NAPA', category: cat.id, source: 'saved' } as never,
      { chrom: 'chr19', start: 300, end: 400, label: 'napa enhancer', category: cat.id, source: 'saved' } as never,
    ]).catalog;
    useRegionCatalogStore.setState(st => ({ catalogs: { ...st.catalogs, [genome]: c } }));
    offCatalog = () => useRegionCatalogStore.setState(st => { const { [genome]: _gone, ...rest } = st.catalogs; return { catalogs: rest }; });
  });
  afterEach(() => { offCatalog?.(); useBrowserStore.setState(initial, true); });

  it('every built-in kind is registered once', () => {
    registerBuiltinSearchProviders();
    expect(getSearchProviders().map(p => p.id)).toEqual(expect.arrayContaining(['locus', 'gene', 'regions', 'read-names']));
    expect(new Set(getSearchProviders().map(p => p.id)).size).toBe(getSearchProviders().length);
  });

  it('a region never shadows the gene named exactly so; it is still offered (and strong)', async () => {
    searchGene.mockResolvedValue({ found: true, chrom: 'chr19', start: 47_510_062, end: 47_520_062, gene_name: 'NAPA' });
    const groups = await searchProviders('NAPA', ctx({ source: 'locus' }));
    const best = bestSuggestion(groups)!;
    expect(best.kind).toBe('gene');
    const region = groups.flatMap(g => g.suggestions).find(s => s.kind === 'region' && s.label === 'NAPA')!;
    expect(region.score).toBeGreaterThanOrEqual(SEARCH_SCORE.strong);
    expect(region.score).toBeLessThan(best.score);
    // Grouped, the best group first.
    expect(orderGroups(groups).map(g => g.provider.id)[0]).toBe('gene');
  });

  it('with no such gene, the region named so is the best match', async () => {
    searchGene.mockResolvedValue({ found: false, suggestions: ['NAPB'] });
    const groups = await searchProviders('NAPA', ctx({ source: 'locus' }));
    expect(bestSuggestion(groups)).toMatchObject({ kind: 'region', label: 'NAPA' });
    // A spelling guess is listed but never what Enter runs.
    expect(groups.flatMap(g => g.suggestions).find(s => s.label === 'NAPB')?.guess).toBe(true);
  });

  it('read names only for text shaped like one, and then no gene lookup', async () => {
    const name = 'm84046_240619_124816_s1/240062573/ccs';
    const reads = await searchProviders(name, ctx());
    expect(reads.map(g => g.provider.id)).toEqual(['read-names']);
    expect(searchGene).not.toHaveBeenCalled();
    searchGene.mockResolvedValue({ found: false, suggestions: [] });
    const gene = await searchProviders('NAPA', ctx());
    expect(gene.some(g => g.provider.id === 'read-names')).toBe(false);
    // The read's score needs no server answer to beat (Enter runs it at once).
    expect(bestSuggestion(reads)!.score).toBeGreaterThan(asyncScoreCeiling());
  });

  it("a panel's box asks its own reference and chromosome and moves its own panel", async () => {
    const navigate = vi.fn();
    const setViewport = vi.fn();
    useBrowserStore.setState({ setViewport, navigationMode: 'perPanel' });
    searchGene.mockResolvedValue({ found: true, chrom: '19', start: 10, end: 20, gene_name: 'NAPA' });
    const panelCtx = ctx({ source: 'panel-locus', viewport: { chrom: 'chr19_hap2', start: 0, end: 1 }, navigate, genome: 'hap2', chroms: [{ name: 'chr19_hap2', size: 1 }, { name: 'chr19', size: 2 }] as never });
    const [gene] = await geneProvider.search('NAPA', panelCtx);
    expect(searchGene).toHaveBeenLastCalledWith('NAPA', expect.anything(), 'chr19_hap2', 'hap2');
    // Not blocked in Per panel mode: the panel's box moves its panel.
    expect(gene.disabledReason).toBeUndefined();
    await runSearchSuggestion(gene, panelCtx);
    expect(navigate).toHaveBeenCalledWith('chr19', 10, 20);
    expect(setViewport).not.toHaveBeenCalled();
    // From the palette (the main view) it says why not.
    const [fromPalette] = await geneProvider.search('NAPA', ctx());
    expect(fromPalette.disabledReason).toMatch(/Each panel navigates/);
  });

  it('runs answer one shape: a region that cannot be shown says why; an abort is a cancel', async () => {
    expect(normalizeRunResult(undefined)).toEqual({ ok: true });
    expect(normalizeRunResult('No panel shows hg19')).toEqual({ ok: false, message: 'No panel shows hg19' });
    const aborted = new AbortController();
    aborted.abort();
    const res = await runSearchSuggestion({ id: 'x', kind: 'read', label: 'x', score: 1, run: () => ({ ok: true }) }, ctx({ signal: aborted.signal }));
    expect(res.cancelled).toBe(true);
  });

  it("the palette's picks run in the main locus box while it is there", async () => {
    const runner = vi.fn(async () => ({ ok: true }));
    const off = setMainLocusBoxRunner(runner);
    const run = vi.fn();
    const suggestion = { id: 'x', kind: 'locus', label: 'x', score: 1, run };
    await runFromPalette(suggestion);
    expect(runner).toHaveBeenCalledWith(suggestion);
    expect(run).not.toHaveBeenCalled();
    off();
    await runFromPalette(suggestion);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ source: 'palette' }));
  });
});
