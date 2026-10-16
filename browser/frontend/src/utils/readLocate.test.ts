import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchJson = vi.fn();
vi.mock('../api/sharedFetch', () => ({ fetchJson: (...args: unknown[]) => fetchJson(...args) }));

import { useBrowserStore } from '../stores/browserStore';
import { useReadActionsStore } from '../stores/readActionsStore';
import { goToReads, LOCATE_MAX_NAMES, locateReads, readWindow, windowForHits } from './readLocate';
import { importReadNames, selectedReadNames, selectedReadNamesByPanel } from './readSelection';
import { searchProvidersNow, type SearchContext } from './search/providers';
import './search/builtinProviders';

const A = 'm84046_240619_124816_s1/240062573/ccs';
const B = 'm84046_240619_124816_s1/247271840/ccs';
const hit = (name: string, extra = {}) => ({
  name, read_id: name, dataset_id: 'ds1', chrom: 'chr19', start: 47_514_487, end: 47_518_985, strand: '+', ...extra,
});
const body = (call: number) => JSON.parse(fetchJson.mock.calls[call][1].body);

const setViewport = vi.fn();
const navigatePanel = vi.fn();
beforeEach(() => {
  fetchJson.mockReset();
  setViewport.mockReset();
  navigatePanel.mockReset();
  useReadActionsStore.setState({ highlight: null, pinnedReadIds: [] });
  useBrowserStore.setState({
    chrom: 'chr19', start: 1_000, end: 2_000, spanningOnly: false,
    datasets: [{ id: 'ds1', label: 'napa_ddda' }] as never,
    panels: [{ id: 'p1', contentType: 'dataset', datasetId: 'ds1', stateKey: 'ds1', subTracks: [] }] as never,
    selectedReadIds: {},
    setViewport, navigatePanel,
  } as never);
});
afterEach(() => vi.clearAllMocks());

/** fb-r4-clicks: going to reads by name. */
describe('locateReads', () => {
  it('widens the search (view, chromosome, genome) only until every name is found', async () => {
    fetchJson
      .mockResolvedValueOnce({ scope: 'region', found: [], not_found: [A, B], complete: true })
      .mockResolvedValueOnce({ scope: 'chrom', found: [hit(A)], not_found: [B], complete: true })
      .mockResolvedValueOnce({ scope: 'genome', found: [], not_found: [B], complete: true });
    const progress: string[] = [];
    const res = await locateReads([A, B], { viewport: { chrom: 'chr19', start: 0, end: 10 }, onProgress: (_s, l) => progress.push(l) });
    expect(fetchJson.mock.calls.map((_c, i) => body(i).scope)).toEqual(['region', 'chrom', 'genome']);
    expect(body(1).names).toEqual([A, B]);
    expect(body(2).names).toEqual([B]);  // only what is still missing
    expect(progress).toEqual(['Searching the view…', 'Searching chr19…', 'Searching every chromosome…']);
    expect(res.found.map(h => h.name)).toEqual([A]);
    expect(res.notFound).toEqual([B]);
  });

  it('stops at the first scope that finds them all, and a cancel ends it', async () => {
    fetchJson.mockResolvedValueOnce({ scope: 'region', found: [hit(A)], not_found: [], complete: true });
    const res = await locateReads([A], { viewport: { chrom: 'chr19', start: 0, end: 10 } });
    expect(fetchJson).toHaveBeenCalledTimes(1);
    expect(res.found).toHaveLength(1);

    const controller = new AbortController();
    fetchJson.mockImplementationOnce(() => { controller.abort(); return Promise.reject(Object.assign(new Error('x'), { name: 'AbortError' })); });
    const cancelled = await locateReads([B], { viewport: { chrom: 'chr19', start: 0, end: 10 }, signal: controller.signal });
    expect(cancelled.cancelled).toBe(true);
  });

  it("a read's window: its whole span with a margin; exactly its span when only full-length reads show", () => {
    expect(readWindow({ start: 1_000, end: 6_000 }, false)).toEqual({ start: 500, end: 6_500 });
    expect(readWindow({ start: 1_000, end: 6_000 }, true)).toEqual({ start: 1_000, end: 6_000 });
    const near = windowForHits([hit(A, { start: 1_000, end: 2_000 }), hit(B, { start: 3_000, end: 4_000 })] as never, false);
    expect(near).toEqual({ chrom: 'chr19', start: 700, end: 4_300 });
  });
});

describe('goToReads', () => {
  it('goes to the read in the panel that has it and pulses it (kept in the sample)', async () => {
    fetchJson.mockResolvedValueOnce({ scope: 'region', found: [], not_found: [A], complete: true })
      .mockResolvedValueOnce({ scope: 'chrom', found: [hit(A)], not_found: [], complete: true });
    const res = await goToReads([A]);
    expect(res.ok).toBe(true);
    expect(res.message).toContain('chr19:47,514,487');
    const [chrom, start, end] = setViewport.mock.calls[0];
    expect(chrom).toBe('chr19');
    expect(start).toBeLessThan(47_514_487);
    expect(end).toBeGreaterThan(47_518_985);
    const { highlight, pinnedReadIds } = useReadActionsStore.getState();
    expect([...highlight!.ids]).toEqual([A]);
    expect(highlight!.scrollTo).toBe(A);
    expect(highlight!.pulseUntil).toBeGreaterThan(Date.now());
    expect(pinnedReadIds).toEqual([A]);
    // One read is not selected; a list is.
    expect(useBrowserStore.getState().selectedReadIds.ds1).toBeUndefined();
  });

  it('a panel at its own locus moves itself', async () => {
    useBrowserStore.setState({
      panels: [{ id: 'p1', contentType: 'dataset', datasetId: 'ds1', stateKey: 'ds1', subTracks: [], viewportOverride: { chrom: 'chr1', start: 0, end: 10 } }] as never,
    } as never);
    fetchJson.mockResolvedValue({ scope: 'region', found: [hit(A)], not_found: [], complete: true });
    await goToReads([A]);
    expect(navigatePanel).toHaveBeenCalledWith('p1', 'chr19', expect.any(Number), expect.any(Number));
    expect(setViewport).not.toHaveBeenCalled();
  });

  it('says clearly when a read is not in the open datasets', async () => {
    fetchJson.mockResolvedValue({ scope: 'genome', found: [], not_found: [A], complete: true });
    const res = await goToReads([A]);
    expect(res.ok).toBe(false);
    expect(res.message).toBe(`Read not found in the open datasets: ${A}`);
    expect(setViewport).not.toHaveBeenCalled();
    expect(useReadActionsStore.getState().highlight).toBeNull();
  });

  it('a pasted list selects and highlights the reads found (and names the missing ones)', async () => {
    fetchJson.mockResolvedValue({ scope: 'region', found: [hit(A)], not_found: [B], complete: true });
    const res = await importReadNames(`${A}\n${B}\n`);
    expect(res.found.map(h => h.name)).toEqual([A]);
    expect(res.message).toContain('Found 1 of 2 reads (selected)');
    expect(res.message).toContain(`not found: ${B}`);
    expect([...useBrowserStore.getState().selectedReadIds.ds1]).toEqual([A]);
    expect(selectedReadNames()).toEqual([A]);
    expect(selectedReadNamesByPanel()).toEqual([{ stateKey: 'ds1', datasetId: 'ds1', label: 'napa_ddda', names: [A] }]);
  });
});

describe('goToReads after review (Codex)', () => {
  it('selects the reads after moving there (a jump clears the old selection)', async () => {
    setViewport.mockImplementation(() => useBrowserStore.setState({ selectedReadIds: {} }));
    fetchJson.mockResolvedValue({ scope: 'region', found: [hit(A), hit(B)], not_found: [], complete: true });
    const res = await goToReads([A, B]);
    expect(res.message).toContain('(selected)');
    expect([...useBrowserStore.getState().selectedReadIds.ds1].sort()).toEqual([A, B].sort());
  });

  it('a supplementary alignment in view does not end the search: the primary one is looked for further out', async () => {
    fetchJson
      .mockResolvedValueOnce({ scope: 'region', found: [hit(A, { start: 5, end: 9, supplementary: true })], not_found: [], complete: true })
      .mockResolvedValueOnce({ scope: 'chrom', found: [hit(A)], not_found: [], complete: true });
    const res = await locateReads([A], { viewport: { chrom: 'chr19', start: 0, end: 10 } });
    expect(fetchJson).toHaveBeenCalledTimes(2);
    expect(res.found[0].start).toBe(47_514_487);
    // None anywhere: the supplementary one answers.
    fetchJson.mockReset();
    fetchJson
      .mockResolvedValueOnce({ scope: 'region', found: [hit(A, { start: 5, end: 9, supplementary: true })], not_found: [], complete: true })
      .mockResolvedValue({ scope: 'chrom', found: [], not_found: [A], complete: true });
    const only = await locateReads([A], { viewport: { chrom: 'chr19', start: 0, end: 10 } });
    expect(only.found.map(h => h.start)).toEqual([5]);
    expect(only.notFound).toEqual([]);
  });

  it('another session opened while it searched: it stands down (no move, no highlight)', async () => {
    let answer: (v: unknown) => void = () => {};
    fetchJson.mockImplementation(() => new Promise(r => { answer = r; }));
    const pending = goToReads([A]);
    await Promise.resolve();
    useReadActionsStore.getState().reset();  // what importing a session does
    answer({ scope: 'region', found: [hit(A)], not_found: [], complete: true });
    const res = await pending;
    expect(res.cancelled).toBe(true);
    expect(setViewport).not.toHaveBeenCalled();
    expect(useReadActionsStore.getState().highlight).toBeNull();
  });

  it('a dataset closed meanwhile is not gone to', async () => {
    let answer: (v: unknown) => void = () => {};
    fetchJson.mockImplementation(() => new Promise(r => { answer = r; }));
    const pending = goToReads([A]);
    await Promise.resolve();
    useBrowserStore.setState({ datasets: [{ id: 'other', label: 'x' }] as never } as never);
    answer({ scope: 'region', found: [hit(A)], not_found: [], complete: true });
    const res = await pending;
    expect(res.ok).toBe(false);
    expect(setViewport).not.toHaveBeenCalled();
  });
});

describe('goToReads, fb-n3-search (Codex 17, 19, 20)', () => {
  it('a long list goes in chunks the server searches whole: the last name is looked for (Codex 19)', async () => {
    const names = Array.from({ length: LOCATE_MAX_NAMES + 1 }, (_, i) => `m1_1/${i}/ccs`);
    const last = names[names.length - 1];
    fetchJson.mockImplementation((_url: string, init: { body: string }) => {
      const asked: string[] = JSON.parse(init.body).names;
      return Promise.resolve({
        scope: 'genome', complete: true,
        found: asked.includes(last) ? [hit(last)] : [],
        not_found: asked.filter(n => n !== last),
      });
    });
    const res = await locateReads(names);
    expect(fetchJson.mock.calls.every((_c, i) => body(i).names.length <= LOCATE_MAX_NAMES)).toBe(true);
    expect(res.found.map(h => h.name)).toEqual([last]);
    expect(res.notFound).toHaveLength(LOCATE_MAX_NAMES);
  });

  it('names the server did not search make the answer incomplete', async () => {
    fetchJson.mockResolvedValue({ scope: 'genome', complete: true, found: [], not_found: [], not_searched: [A] });
    const res = await locateReads([A]);
    expect(res.complete).toBe(false);
  });

  it('a file the server could not read is said so, not "read not found" (Codex 20)', async () => {
    fetchJson.mockResolvedValue({
      scope: 'genome', complete: false, found: [], not_found: [A],
      errors: [{ dataset_id: 'ds1', path: '/data/napa.bam', error: 'fetch called on bamfile without index' }],
    });
    const res = await goToReads([A], { viewport: null });
    expect(res.ok).toBe(false);
    expect(res.message).toContain('could not read napa_ddda (fetch called on bamfile without index)');
    expect(res.message).toContain('incomplete');
  });

  it('reads on two assemblies are never put in one window: each goes to its own panel (Codex 17)', async () => {
    useBrowserStore.setState({
      currentGenome: 'hg38', fastaPath: null, navigationMode: 'linked',
      datasets: [{ id: 'ds1', label: 'napa_ddda' }, { id: 'ds2', label: 'fly' }] as never,
      panels: [
        { id: 'p1', contentType: 'dataset', datasetId: 'ds1', stateKey: 'ds1', subTracks: [] },
        { id: 'p2', contentType: 'dataset', datasetId: 'ds2', stateKey: 'ds2', subTracks: [], genome: 'dm6', viewportOverride: { chrom: 'chr1', start: 0, end: 10 } },
      ] as never,
    } as never);
    // Both on a contig called chr1, 4 kb apart: close enough to be windowed together if only the name counted.
    fetchJson.mockResolvedValue({
      scope: 'genome', complete: true, not_found: [],
      found: [hit(A, { chrom: 'chr1', start: 1_000, end: 2_000 }), hit(B, { dataset_id: 'ds2', chrom: 'chr1', start: 6_000, end: 7_000 })],
    });
    const res = await goToReads([A, B], { viewport: null });
    expect(res.ok).toBe(true);
    expect(setViewport).toHaveBeenCalledTimes(1);
    const [chrom, start, end] = setViewport.mock.calls[0];
    expect(chrom).toBe('chr1');
    expect(start).toBeLessThan(1_000);
    expect(end).toBeLessThan(6_000);  // not stretched to the dm6 read
    expect(navigatePanel).toHaveBeenCalledWith('p2', 'chr1', expect.any(Number), expect.any(Number));
    const [, , s2, e2] = navigatePanel.mock.calls[0];
    expect(s2).toBeGreaterThan(2_000);
    expect(e2).toBeGreaterThan(7_000);
  });
});

describe('goToReads, Codex review (fb-n3-search)', () => {
  it('names in either order: the other reference\'s read still moves its own view', async () => {
    useBrowserStore.setState({
      currentGenome: 'hg38', fastaPath: null, navigationMode: 'linked',
      datasets: [{ id: 'ds1', label: 'napa_ddda' }, { id: 'ds2', label: 'fly' }] as never,
      panels: [
        { id: 'p1', contentType: 'dataset', datasetId: 'ds1', stateKey: 'ds1', subTracks: [] },
        { id: 'p2', contentType: 'dataset', datasetId: 'ds2', stateKey: 'ds2', subTracks: [], genome: 'dm6', viewportOverride: { chrom: 'chr1', start: 0, end: 10 } },
      ] as never,
    } as never);
    // The dm6 read first, the hg38 one (its panel follows the main view) second.
    fetchJson.mockResolvedValue({
      scope: 'genome', complete: true, not_found: [],
      found: [hit(B, { dataset_id: 'ds2', chrom: 'chr1', start: 6_000, end: 7_000 }), hit(A, { chrom: 'chr1', start: 1_000, end: 2_000 })],
    });
    const res = await goToReads([B, A], { viewport: null });
    expect(res.ok).toBe(true);
    expect(navigatePanel).toHaveBeenCalledWith('p2', 'chr1', expect.any(Number), expect.any(Number));
    expect(setViewport).toHaveBeenCalledTimes(1);
    const [, start, end] = setViewport.mock.calls[0];
    expect(start).toBeLessThan(1_000);
    expect(end).toBeLessThan(6_000);
  });
});

describe('search providers', () => {
  it('a read name is a "Read" suggestion that goes to it; coordinates and genes are not', async () => {
    const ctx: SearchContext = { source: 'locus', signal: new AbortController().signal };
    const suggest = (q: string) => searchProvidersNow(q, ctx).flatMap(g => g.suggestions.map(s => ({ ...s, group: g.provider.label })));
    const [s] = suggest(A);
    expect(s.kind).toBe('read');
    expect(s.group).toBe('Reads');
    expect(suggest('roX1').filter(x => x.kind === 'read')).toEqual([]);
    expect(suggest('chr2L:1-1000').filter(x => x.kind === 'read')).toEqual([]);
    fetchJson.mockResolvedValue({ scope: 'region', found: [hit(A)], not_found: [], complete: true });
    const navigate = vi.fn();
    const res = await s.run({ ...ctx, navigate, viewport: { chrom: 'chr19', start: 0, end: 10 } }) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(navigate).toHaveBeenCalled();  // a panel's box moves its own panel
  });
});

describe('Reset view', () => {
  it('brings excluded reads back and drops read highlights', async () => {
    const { resetViewUndoably } = await import('./resetView');
    useBrowserStore.setState({ resetView: vi.fn(), pushSnapshot: vi.fn() } as never);
    useReadActionsStore.getState().excludeReads('ds1', ['r1']);
    useReadActionsStore.getState().highlightReads(['r2']);
    resetViewUndoably();
    expect(useReadActionsStore.getState().excludedReadIds).toEqual({});
    expect(useReadActionsStore.getState().highlight).toBeNull();
  });
});
