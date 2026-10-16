/**
 * fb-r5-search: search answers that come back later (a read lookup, a gene the
 * server suggested) move a view only while it still shows what it showed when
 * they were asked (utils/search/navigationIntent).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchJson = vi.fn();
vi.mock('../../api/sharedFetch', async (orig) => ({ ...(await orig<object>()), fetchJson: (...a: unknown[]) => fetchJson(...a) }));
const searchGene = vi.fn();
vi.mock('../../api/reference', async (orig) => ({ ...(await orig<object>()), searchGene: (...a: unknown[]) => searchGene(...a) }));

import { useBrowserStore } from '../../stores/browserStore';
import { useReadActionsStore } from '../../stores/readActionsStore';
import { goToReads } from '../readLocate';
import { geneProvider } from '../search/locusProviders';
import { readNameProvider } from '../search/readProvider';
import { beginNavigationIntent, supersedeNavigationIntents, type NavigationTarget } from '../search/navigationIntent';
import { runSearchSuggestion, type SearchContext, type SearchSuggestion } from '../search/providers';
import { locusProvider } from '../search/locusProviders';

const READ = 'm84046_240619_124816_s1/240062573/ccs';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
const tick = () => new Promise(r => setTimeout(r, 0));

/** Every move of the main view or a panel, in order. */
const moves: string[] = [];
const setViewport = vi.fn((chrom: string, start: number, end: number) => {
  moves.push(`main ${chrom}:${start}-${end}`);
  useBrowserStore.setState({ chrom, start, end });
});
const movePanel = (panelId: string) => (chrom: string, start: number, end: number) => {
  moves.push(`${panelId} ${chrom}:${start}-${end}`);
  useBrowserStore.setState(s => ({ panels: s.panels.map(p => (p.id === panelId ? { ...p, viewportOverride: { chrom, start, end } } : p)) }));
};
/** The user pans or resizes (not a search). */
const pan = (start: number, end: number) => useBrowserStore.setState({ start, end });
const panPanel = (panelId: string, start: number, end: number) => useBrowserStore.setState(s => ({
  panels: s.panels.map(p => (p.id === panelId ? { ...p, viewportOverride: { ...p.viewportOverride!, start, end } } : p)),
}));

const hit = (start: number, end: number) => ({
  scope: 'region', complete: true, not_found: [],
  found: [{ name: READ, read_id: 'r1', dataset_id: 'ds1', chrom: 'chr19', start, end, strand: '+' }],
});

beforeEach(() => {
  fetchJson.mockReset();
  searchGene.mockReset();
  setViewport.mockClear();
  moves.length = 0;
  useBrowserStore.setState({
    currentGenome: 'hg38', fastaPath: null, chrom: 'chr19', start: 1_000, end: 2_000,
    chroms: [{ name: 'chr19', size: 58_000_000 }], navigationMode: 'linked', spanningOnly: false,
    datasets: [{ id: 'ds1', label: 'ds1' }],
    panels: [
      { id: 'ds1', contentType: 'dataset', datasetId: 'ds1', stateKey: 'ds1', subTracks: [], collapsed: false },
      { id: 'p2', contentType: 'dataset', datasetId: 'ds2', stateKey: 'ds2', subTracks: [], collapsed: false, navOwn: true,
        viewportOverride: { chrom: 'chr19', start: 1_000, end: 2_000 } },
    ],
    selectedReadIds: {},
    setViewport,
  } as never);
});

describe('navigation intents', () => {
  it('is current until a pan, a zoom, another assembly, a later intent or another session', () => {
    expect(beginNavigationIntent('main').isCurrent()).toBe(true);
    const a = beginNavigationIntent('main');
    pan(1_000, 3_000);
    expect(a.isCurrent()).toBe(false);
    const b = beginNavigationIntent('main');
    useBrowserStore.setState({ currentGenome: 'mm10' } as never);
    expect(b.isCurrent()).toBe(false);
    const c = beginNavigationIntent('main');
    beginNavigationIntent('main');
    expect(c.isCurrent()).toBe(false);  // superseded by the later one
    const d = beginNavigationIntent('main');
    useReadActionsStore.setState(s => ({ epoch: s.epoch + 1 }));
    expect(d.isCurrent()).toBe(false);
  });

  it("is per target: another panel's Go to leaves it alone; its own panel's resize or close does not", () => {
    const panel: NavigationTarget = { panelId: 'p2' };
    const a = beginNavigationIntent(panel);
    supersedeNavigationIntents({ panelId: 'other' });
    expect(a.isCurrent()).toBe(true);
    panPanel('p2', 1_000, 4_000);  // only its end moves
    expect(a.isCurrent()).toBe(false);
    const b = beginNavigationIntent(panel);
    useBrowserStore.setState(s => ({ panels: s.panels.map(p => (p.id === 'p2' ? { ...p, genome: 'mm10' } : p)) }) as never);
    expect(b.isCurrent()).toBe(false);
    const c = beginNavigationIntent(panel);
    useBrowserStore.setState(s => ({ panels: s.panels.filter(p => p.id !== 'p2') }));
    expect(c.isCurrent()).toBe(false);
  });

  it('a watching intent does not cancel the pending ones', () => {
    const a = beginNavigationIntent('main');
    const watch = beginNavigationIntent('main', { supersede: false });
    expect(a.isCurrent()).toBe(true);
    expect(watch.isCurrent()).toBe(true);
  });
});

describe('Codex 1: a read lookup does not jump back after the user panned', () => {
  it('main view: the pan wins, and the read is not selected either', async () => {
    const answer = deferred<unknown>();
    fetchJson.mockReturnValueOnce(answer.promise);
    const pending = goToReads([READ], { select: true });
    pan(5_000, 6_000);
    answer.resolve(hit(10_000, 11_000));
    const res = await pending;
    expect(res.ok).toBe(false);
    expect(res.cancelled).toBe(true);
    expect(res.message).toMatch(/view changed/);
    expect(moves).toEqual([]);
    expect(useBrowserStore.getState().start).toBe(5_000);
    expect(useBrowserStore.getState().selectedReadIds.ds1).toBeUndefined();
  });

  it('a zoom that keeps the start is a move too', async () => {
    const answer = deferred<unknown>();
    fetchJson.mockReturnValueOnce(answer.promise);
    const pending = goToReads([READ]);
    pan(1_000, 9_000);
    answer.resolve(hit(10_000, 11_000));
    expect((await pending).ok).toBe(false);
    expect(moves).toEqual([]);
  });

  it("a panel's box: its panel resized meanwhile stays put", async () => {
    const answer = deferred<unknown>();
    fetchJson.mockReturnValueOnce(answer.promise);
    const [s] = readNameProvider.search(READ, { source: 'panel-locus', signal: new AbortController().signal }) as SearchSuggestion[];
    const pending = s.run({
      source: 'panel-locus', signal: new AbortController().signal, navigate: movePanel('p2'),
      viewport: { chrom: 'chr19', start: 1_000, end: 2_000 }, target: { panelId: 'p2' },
    });
    panPanel('p2', 1_000, 4_000);
    answer.resolve({ ...hit(10_000, 11_000), found: [{ ...hit(10_000, 11_000).found[0], dataset_id: 'ds1' }] });
    await pending;
    expect(moves).toEqual([]);
  });

  it('unmoved: it goes to the read (the control)', async () => {
    fetchJson.mockResolvedValueOnce(hit(10_000, 11_000));
    const res = await goToReads([READ]);
    expect(res.ok).toBe(true);
    expect(moves).toEqual(['main chr19:9900-11100']);
  });

  it('a list imported without moving the view is still selected after a pan', async () => {
    const answer = deferred<unknown>();
    fetchJson.mockReturnValueOnce(answer.promise);
    const pending = goToReads([READ], { select: true, navigateTo: false });
    pan(5_000, 6_000);
    answer.resolve(hit(10_000, 11_000));
    expect((await pending).ok).toBe(true);
    expect(moves).toEqual([]);
    expect([...useBrowserStore.getState().selectedReadIds.ds1]).toEqual(['r1']);
  });
});

/** The guess ("no gene named NAP: NAPA?") a gene search offers. */
async function guess(ctx: Partial<SearchContext> = {}): Promise<SearchSuggestion> {
  searchGene.mockResolvedValueOnce({ found: false, suggestions: ['NAPA'] });
  const [s] = await geneProvider.search('NAP', { source: 'locus', signal: new AbortController().signal, ...ctx });
  expect(s.guess).toBe(true);
  return s;
}

describe('Codex 2: a guessed gene does not move a view that changed meanwhile', () => {
  it("a panel resized from 1000–2000 to 1000–4000 (its start unchanged) stays put", async () => {
    const ctx = { source: 'panel-locus' as const, navigate: movePanel('p2'), target: { panelId: 'p2' } };
    const s = await guess(ctx);
    const answer = deferred<unknown>();
    searchGene.mockReturnValueOnce(answer.promise);
    const pending = s.run({ ...ctx, signal: new AbortController().signal });
    panPanel('p2', 1_000, 4_000);
    answer.resolve({ found: true, chrom: 'chr19', start: 47_510_062, end: 47_520_062 });
    const res = await pending;
    expect(res).toMatchObject({ ok: false, cancelled: true });
    expect(moves).toEqual([]);
  });

  it('the main view resized (start unchanged) stays put', async () => {
    const s = await guess();
    const answer = deferred<unknown>();
    searchGene.mockReturnValueOnce(answer.promise);
    const pending = s.run({ source: 'locus', signal: new AbortController().signal });
    pan(1_000, 4_000);
    answer.resolve({ found: true, chrom: 'chr19', start: 47_510_062, end: 47_520_062 });
    await pending;
    expect(moves).toEqual([]);
  });

  it('the main assembly changed meanwhile: not moved', async () => {
    const s = await guess();
    const answer = deferred<unknown>();
    searchGene.mockReturnValueOnce(answer.promise);
    const pending = s.run({ source: 'locus', signal: new AbortController().signal });
    useBrowserStore.setState({ currentGenome: 'mm10' } as never);
    answer.resolve({ found: true, chrom: 'chr19', start: 47_510_062, end: 47_520_062 });
    await pending;
    expect(moves).toEqual([]);
  });

  it("another panel's Go to does not cancel it", async () => {
    const ctx = { source: 'panel-locus' as const, navigate: movePanel('p2'), target: { panelId: 'p2' } };
    const s = await guess(ctx);
    const answer = deferred<unknown>();
    searchGene.mockReturnValueOnce(answer.promise);
    const pending = s.run({ ...ctx, signal: new AbortController().signal });
    supersedeNavigationIntents({ panelId: 'p9' });
    answer.resolve({ found: true, chrom: 'chr19', start: 47_510_062, end: 47_520_062 });
    expect((await pending).ok).toBe(true);
    expect(moves).toEqual(['p2 chr19:47510062-47520062']);
  });

  it('a gene found on one assembly is not run on another', async () => {
    searchGene.mockResolvedValueOnce({ found: true, chrom: 'chr19', start: 47_510_062, end: 47_520_062, gene_name: 'NAPA' });
    const [s] = await geneProvider.search('NAPA', { source: 'palette', signal: new AbortController().signal });
    useBrowserStore.setState({ currentGenome: 'mm10' } as never);
    const res = await runSearchSuggestion(s, { source: 'palette', signal: new AbortController().signal });
    expect(res).toMatchObject({ ok: false, message: expect.stringMatching(/reference changed/) });
    expect(moves).toEqual([]);
  });
});

describe('Codex review of fb-r5-search', () => {
  it('two FASTAs with the same file name are two references', async () => {
    useBrowserStore.setState({ currentGenome: null, fastaPath: '/human/reference.fa' } as never);
    searchGene.mockResolvedValueOnce({ found: true, chrom: 'chr19', start: 47_510_062, end: 47_520_062, gene_name: 'NAPA' });
    const [gene] = await geneProvider.search('NAPA', { source: 'palette', signal: new AbortController().signal });
    const intent = beginNavigationIntent('main');
    useBrowserStore.setState({ fastaPath: '/mouse/reference.fa' } as never);
    expect(intent.isCurrent()).toBe(false);
    expect((await runSearchSuggestion(gene, { source: 'palette', signal: new AbortController().signal })).ok).toBe(false);
    expect(moves).toEqual([]);
  });

  it('coordinates chosen on one assembly are not run on the next (a queued palette pick)', async () => {
    const [locus] = locusProvider.search('chr19:4000-5000', { source: 'palette', signal: new AbortController().signal }) as SearchSuggestion[];
    useBrowserStore.setState({ currentGenome: 'mm10' } as never);
    expect((await runSearchSuggestion(locus, { source: 'palette', signal: new AbortController().signal })).ok).toBe(false);
    expect(moves).toEqual([]);
  });

  it('Linked panels on one reference are one target: the older guess loses', async () => {
    useBrowserStore.setState({
      panels: [
        { id: 'a', contentType: 'dataset', datasetId: 'da', stateKey: 'da', subTracks: [], genome: 'dm6', viewportOverride: { chrom: '2L', start: 1, end: 100 } },
        { id: 'b', contentType: 'dataset', datasetId: 'db', stateKey: 'db', subTracks: [], genome: 'dm6', viewportOverride: { chrom: '2L', start: 1, end: 100 } },
      ],
    } as never);
    const moveGroup = (chrom: string, start: number, end: number) => {
      moves.push(`group ${chrom}:${start}-${end}`);
      useBrowserStore.setState(st => ({ panels: st.panels.map(p => ({ ...p, viewportOverride: { chrom, start, end } })) }));
    };
    const ctxA = { source: 'panel-locus' as const, navigate: moveGroup, target: { panelId: 'a' }, genome: 'dm6' };
    const ctxB = { ...ctxA, target: { panelId: 'b' } };
    const guessA = await guess(ctxA);
    const guessB = await guess(ctxB);
    const answerA = deferred<unknown>();
    const answerB = deferred<unknown>();
    searchGene.mockReturnValueOnce(answerA.promise).mockReturnValueOnce(answerB.promise);
    const runA = guessA.run({ ...ctxA, signal: new AbortController().signal });
    const runB = guessB.run({ ...ctxB, signal: new AbortController().signal });
    answerA.resolve({ found: true, chrom: '2L', start: 5_000, end: 6_000 });
    await runA;
    answerB.resolve({ found: true, chrom: '3R', start: 7_000, end: 8_000 });
    await runB;
    expect(moves).toEqual(['group 3R:7000-8000']);
  });

  it('a panel moved on its own, or panels reordered, leave a main-view Go to alone', () => {
    const a = beginNavigationIntent('main');
    panPanel('p2', 50_000, 60_000);
    useBrowserStore.setState(st => ({ panels: [...st.panels].reverse() }));
    expect(a.isCurrent()).toBe(true);
  });

  it('a pan away and back is still a move', () => {
    const a = beginNavigationIntent('main');
    pan(5_000, 6_000);
    pan(1_000, 2_000);
    expect(a.isCurrent()).toBe(false);
    const p = beginNavigationIntent({ panelId: 'p2' });
    panPanel('p2', 5_000, 6_000);
    panPanel('p2', 1_000, 2_000);
    expect(p.isCurrent()).toBe(false);
  });

  it('a read found from the main box does not move the panel that has it if that panel moved', async () => {
    useBrowserStore.setState({ datasets: [{ id: 'ds1', label: 'ds1' }, { id: 'ds2', label: 'ds2' }] } as never);
    const answer = deferred<unknown>();
    fetchJson.mockReturnValueOnce(answer.promise);
    const pending = goToReads([READ]);
    panPanel('p2', 30_000, 40_000);
    answer.resolve({ ...hit(10_000, 11_000), found: [{ ...hit(10_000, 11_000).found[0], dataset_id: 'ds2' }] });
    expect((await pending).ok).toBe(false);
    expect(useBrowserStore.getState().panels.find(p => p.id === 'p2')!.viewportOverride!.start).toBe(30_000);
  });

  it('a guess whose run was cancelled after its answer arrived moves nothing', async () => {
    const s = await guess();
    const answer = deferred<unknown>();
    searchGene.mockReturnValueOnce(answer.promise);
    const controller = new AbortController();
    const pending = s.run({ source: 'locus', signal: controller.signal });
    controller.abort();
    answer.resolve({ found: true, chrom: 'chr19', start: 47_510_062, end: 47_520_062 });
    await pending;
    expect(moves).toEqual([]);
  });
});

describe('rapid Go to / pan sequences never move a view to a stale target', () => {
  // Two requests on the main view (a read lookup and a guessed gene, each
  // answered later) and a pan, in every order; a request may move the view
  // only if no later request was made and nothing moved the view since it was made.
  type Ev = 'S1' | 'S2' | 'P' | 'R1' | 'R2';
  const events: Ev[] = ['S1', 'S2', 'P', 'R1', 'R2'];
  const orders: Ev[][] = [];
  const permute = (rest: Ev[], acc: Ev[]) => {
    if (!rest.length) { orders.push(acc); return; }
    for (const e of rest) permute(rest.filter(x => x !== e), [...acc, e]);
  };
  permute(events, []);
  const valid = orders.filter(o => o.indexOf('S1') < o.indexOf('R1') && o.indexOf('S2') < o.indexOf('R2'));

  it(`holds in all ${valid.length} orders`, async () => {
    expect(valid.length).toBe(30);
    for (const order of valid) {
      useBrowserStore.setState({ chrom: 'chr19', start: 1_000, end: 2_000 });
      moves.length = 0;
      const readAnswer = deferred<unknown>();
      const geneAnswer = deferred<unknown>();
      const s2 = await guess();
      let r1: Promise<unknown> | null = null;
      let r2: Promise<unknown> | null = null;
      // The model: when each request started, and whether the view moved since.
      const started: Record<string, number> = {};
      let lastStart = 0;
      let lastMove = 0;
      let clock = 0;
      const allowed: string[] = [];
      for (const ev of order) {
        clock += 1;
        if (ev === 'S1') {
          fetchJson.mockReturnValueOnce(readAnswer.promise);
          r1 = goToReads([READ]);
          started.r1 = clock; lastStart = clock;
        } else if (ev === 'S2') {
          searchGene.mockReturnValueOnce(geneAnswer.promise);
          r2 = Promise.resolve(s2.run({ source: 'locus', signal: new AbortController().signal }));
          started.r2 = clock; lastStart = clock;
        } else if (ev === 'P') {
          pan(useBrowserStore.getState().start + 50_000, useBrowserStore.getState().end + 50_000);
          lastMove = clock;
        } else {
          const which = ev === 'R1' ? 'r1' : 'r2';
          const fresh = started[which] === lastStart && lastMove < started[which];
          if (fresh) allowed.push(which);
          const before = moves.length;
          if (ev === 'R1') readAnswer.resolve(hit(10_000, 11_000));
          else geneAnswer.resolve({ found: true, chrom: 'chr19', start: 47_510_062, end: 47_520_062 });
          await (ev === 'R1' ? r1 : r2);
          await tick();
          const moved = moves.length > before;
          expect({ order: order.join(' '), which, moved }).toEqual({ order: order.join(' '), which, moved: fresh });
          if (moved) lastMove = clock;
        }
      }
      // Whatever moved the view last is what it shows: the user's pan or the latest fresh answer.
      expect(moves.length).toBe(allowed.length);
    }
  });
});

describe('Codex review of fb-r5-search, round 2', () => {
  it('replacing one loaded pair’s FASTA is another reference', async () => {
    useBrowserStore.setState({ currentGenome: null, fastaPath: '/p/hap1.fa', referencePairs: [{ fasta: '/p/hap1.fa', annotation: null }, { fasta: '/p/hap2-v1.fa', annotation: null }] } as never);
    searchGene.mockResolvedValueOnce({ found: true, chrom: 'chr1_h2', start: 10, end: 20, gene_name: 'NAPA' });
    const [gene] = await geneProvider.search('NAPA', { source: 'palette', signal: new AbortController().signal });
    const intent = beginNavigationIntent('main');
    useBrowserStore.setState({ referencePairs: [{ fasta: '/p/hap1.fa', annotation: null }, { fasta: '/p/hap2-v2.fa', annotation: null }] } as never);
    expect(intent.isCurrent()).toBe(false);
    expect((await runSearchSuggestion(gene, { source: 'palette', signal: new AbortController().signal })).ok).toBe(false);
    expect(moves).toEqual([]);
  });

  it('a main-box read lookup does not move a panel asked to go elsewhere meanwhile', async () => {
    useBrowserStore.setState({ datasets: [{ id: 'ds1', label: 'ds1' }, { id: 'ds2', label: 'ds2' }] } as never);
    const answer = deferred<unknown>();
    fetchJson.mockReturnValueOnce(answer.promise);
    const pending = goToReads([READ]);
    beginNavigationIntent({ panelId: 'p2' });  // a gene guess started in that panel's box
    answer.resolve({ ...hit(10_000, 11_000), found: [{ ...hit(10_000, 11_000).found[0], dataset_id: 'ds2' }] });
    expect((await pending).ok).toBe(false);
    expect(useBrowserStore.getState().panels.find(p => p.id === 'p2')!.viewportOverride!.start).toBe(1_000);
  });

  it('running any suggestion is a new Go to, even to where the view already is', async () => {
    const answer = deferred<unknown>();
    fetchJson.mockReturnValueOnce(answer.promise);
    const pending = goToReads([READ]);
    const here: SearchSuggestion = { id: 'here', kind: 'region', label: 'here', score: 700, run: () => { setViewport('chr19', 1_000, 2_000); } };
    await runSearchSuggestion(here, { source: 'locus', signal: new AbortController().signal });
    moves.length = 0;
    answer.resolve(hit(10_000, 11_000));
    expect((await pending).ok).toBe(false);
    expect(moves).toEqual([]);
  });

  it('a saved region found on one FASTA is not run on another of the same name', async () => {
    const { searchRegionCatalog } = await import('../search/regionProvider');
    const { addCategory, addEntries, emptyCatalog } = await import('../regionCatalog');
    useBrowserStore.setState({ currentGenome: null, fastaPath: '/human/reference.fa' } as never);
    let c = emptyCatalog('reference.fa');
    const cat = addCategory(c, { name: 'Mine' }); c = cat.catalog;
    c = addEntries(c, cat.id, [{ chrom: 'chr19', start: 5_000, end: 6_000, label: 'enh', category: cat.id, source: 'saved' } as never]).catalog;
    const [region] = searchRegionCatalog(c, 'enh', { ctx: { source: 'palette', signal: new AbortController().signal } });
    useBrowserStore.setState({ fastaPath: '/mouse/reference.fa' } as never);
    expect((await runSearchSuggestion(region, { source: 'palette', signal: new AbortController().signal })).ok).toBe(false);
    expect(moves).toEqual([]);
  });
});

describe('Codex review of fb-r5-search, round 3', () => {
  const entry = (start: number, end: number) => ({ id: 'e1', chrom: 'chr19', start, end, label: 'here', category: 'c1', source: 'saved' }) as never;

  it('an older panel guess landing where the panel already is does not cancel a newer read lookup for that panel', async () => {
    useBrowserStore.setState({ datasets: [{ id: 'ds1', label: 'ds1' }, { id: 'ds2', label: 'ds2' }] } as never);
    const ctx = { source: 'panel-locus' as const, navigate: movePanel('p2'), target: { panelId: 'p2' } };
    const s = await guess(ctx);
    const gene = deferred<unknown>();
    searchGene.mockReturnValueOnce(gene.promise);
    const guessRun = s.run({ ...ctx, signal: new AbortController().signal });
    const read = deferred<unknown>();
    fetchJson.mockReturnValueOnce(read.promise);
    const lookup = goToReads([READ]);  // newer, from the main box; the read is in p2
    gene.resolve({ found: true, chrom: 'chr19', start: 1_000, end: 2_000 });
    await guessRun;  // superseded by nothing of its own target's: lands (where p2 already is)
    read.resolve({ ...hit(10_000, 11_000), found: [{ ...hit(10_000, 11_000).found[0], dataset_id: 'ds2' }] });
    expect((await lookup).ok).toBe(true);
    expect(useBrowserStore.getState().panels.find(p => p.id === 'p2')!.viewportOverride).toEqual({ chrom: 'chr19', start: 9_900, end: 11_100 });
  });

  it('a region opened in a panel at its current locus supersedes that panel’s pending guess', async () => {
    const { goToRegion } = await import('../regionNavigation');
    const ctx = { source: 'panel-locus' as const, navigate: movePanel('p2'), target: { panelId: 'p2' } };
    const s = await guess(ctx);
    const gene = deferred<unknown>();
    searchGene.mockReturnValueOnce(gene.promise);
    const guessRun = s.run({ ...ctx, signal: new AbortController().signal });
    expect(goToRegion('hg38', entry(1_000, 2_000), { panelId: 'p2' })).toBeNull();
    gene.resolve({ found: true, chrom: 'chr19', start: 47_510_062, end: 47_520_062 });
    expect((await guessRun).ok).toBe(false);
    expect(moves).toEqual([]);
  });

  it('a region clicked in the Regions panel at the main view’s locus cancels an older read lookup', async () => {
    const { goToRegion } = await import('../regionNavigation');
    const answer = deferred<unknown>();
    fetchJson.mockReturnValueOnce(answer.promise);
    const lookup = goToReads([READ]);
    goToRegion('hg38', entry(1_000, 2_000));
    moves.length = 0;
    answer.resolve(hit(10_000, 11_000));
    expect((await lookup).ok).toBe(false);
    expect(moves).toEqual([]);
  });
});
