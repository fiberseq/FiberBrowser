import '../testSetup';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { SequenceSearchPanel } from './SequenceSearchPanel';
import { HIT_HIGHLIGHT_ID, openSequenceSearch, resetSequenceSearch, useSequenceSearch } from './store';
import type { SearchResult } from './model';

const fetchJson = vi.fn();
vi.mock('../../api/sharedFetch', async orig => ({ ...(await orig<object>()), fetchJson: (...a: unknown[]) => fetchJson(...a) }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const PLANT = 'GATTACAGGCTTCAAGT';
const STATUS = {
  success: true, genome: 'toy', genome_loaded: true, searchable: true, problem: null, plasmids: [], reference_id: 'r1',
  blast: { available: true, blastn: true, makeblastdb: true, db_ready: false, hint: '' },
  defaults: { mode: 'auto', exact_max_length: 30, max_mismatches: 0, evalue: 0.01, max_hits: 500, min_length: 12, blast_task: 'auto' },
};
const RESULT: SearchResult = {
  schema: 'fiberbrowser.sequence_search/1', mode: 'exact', query: PLANT, query_length: 17, genome: 'toy', reference_id: 'r1',
  settings: STATUS.defaults as never, notes: [], total: 2, palindrome: false,
  hits: [
    { chrom: 'chr1', start: 1000, end: 1017, strand: '+', mismatches: 0, identity: 100, evalue: null, bitscore: null, qstart: 0, qend: 17, matched: PLANT },
    { chrom: 'chr2', start: 12000, end: 12017, strand: '-', mismatches: 1, identity: 94.12, evalue: null, bitscore: null, qstart: 0, qend: 17,
      matched: 'GATTACAGTCTTCAAGT' },
  ],
};

const wait = (ms: number) => act(async () => { await new Promise(r => setTimeout(r, ms)); });
const q = (c: HTMLElement, id: string) => c.querySelector<HTMLElement>(`[data-testid="${id}"]`);

function type(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('Find sequence panel', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetSequenceSearch();
    fetchJson.mockReset();
    useBrowserStore.setState({
      chroms: [{ name: 'chr1', size: 40_000 }, { name: 'chr2', size: 25_000 }] as never,
      highlights: [], panels: [], navigationMode: 'linked',
    } as never);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function routeFetch(job: (call: number) => unknown, track?: unknown) {
    let polls = 0;
    fetchJson.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/status')) return STATUS;
      if (url.endsWith('/track')) return track;
      if (url === '/api/sequence_search' && init?.method === 'POST') return { success: true, job_id: 'j1', status: 'running', progress: 0, message: 'Starting' };
      if (url.includes('/jobs/j1') && init?.method === 'DELETE') return { success: true };
      if (url.includes('/jobs/j1')) return job(polls++);
      throw new Error(`unexpected ${url}`);
    });
  }

  it('searches a pasted sequence, lists hits and moves to a clicked one, highlighted', async () => {
    routeFetch(n => (n === 0 ? { success: true, status: 'running', progress: 0.4, message: 'Scanning chr1' }
      : { success: true, status: 'done', result: RESULT }));
    const setViewport = vi.fn();
    useBrowserStore.setState({ setViewport } as never);
    act(() => root.render(<SequenceSearchPanel />));
    await wait(10);
    const input = q(container, 'seqsearch-input') as HTMLTextAreaElement;
    act(() => type(input, `>oligo\n${PLANT.toLowerCase()}`));
    expect(q(container, 'seqsearch-plan')!.textContent).toMatch(/17 bases · exact search, both strands/);
    act(() => q(container, 'seqsearch-find')!.click());
    await wait(20);
    expect(q(container, 'seqsearch-progress')).not.toBeNull();
    const post = fetchJson.mock.calls.find(c => c[0] === '/api/sequence_search');
    expect(JSON.parse(post![1].body)).toMatchObject({ sequence: `>oligo\n${PLANT.toLowerCase()}`, mode: 'auto', max_hits: 500 });
    await wait(1000);
    expect(q(container, 'seqsearch-summary')!.textContent).toBe('2 hits (exact search, both strands)');
    const rows = container.querySelectorAll<HTMLElement>('[data-testid="seqsearch-hit"]');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('chr1:1,001-1,017');
    // The mismatched base is marked.
    expect(rows[1].querySelectorAll('[data-testid="seqsearch-mismatch"]')).toHaveLength(1);
    act(() => rows[1].click());
    expect(setViewport).toHaveBeenCalledWith('chr2', 11_900, 12_117);
    const hl = useBrowserStore.getState().highlights.find(h => h.id === HIT_HIGHLIGHT_ID);
    expect(hl).toMatchObject({ chrom: 'chr2', start: 12_000, end: 12_017 });
    // Another click moves the one highlight (never one per click).
    act(() => rows[0].click());
    expect(useBrowserStore.getState().highlights.filter(h => h.id === HIT_HIGHLIGHT_ID)).toHaveLength(1);
    expect(useBrowserStore.getState().highlights[0]).toMatchObject({ chrom: 'chr1', start: 1000 });
    expect(rows[0].getAttribute('aria-selected')).toBe('true');
  });

  it('adds the hits as a track', async () => {
    routeFetch(() => ({ success: true, status: 'done', result: RESULT }),
      { success: true, track_index: 3, path: 'seqsearch://j1', label: 'Sequence GATTACAGGCTT… (2 hits)' });
    act(() => root.render(<SequenceSearchPanel />));
    act(() => { useSequenceSearch.setState({ query: PLANT }); });
    act(() => q(container, 'seqsearch-find')!.click());
    await wait(600);
    act(() => q(container, 'seqsearch-add-track')!.click());
    await wait(20);
    const entry = useBrowserStore.getState().catalog.find(c => c.path === 'seqsearch://j1');
    expect(entry).toMatchObject({ kind: 'bigbed', trackIndex: 3, loaded: true });
    expect(useBrowserStore.getState().compositeTracks.some(c => c.sources.some(s => 'catalogEntryId' in s.ref && s.ref.catalogEntryId === entry!.id))).toBe(true);
    expect(q(container, 'seqsearch-add-track')!.textContent).toBe('Added as track');
  });

  it('marks hits of another reference stale: no navigation, no track (release audit 3.1.0)', async () => {
    let status = STATUS;
    fetchJson.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/status')) return status;
      if (url === '/api/sequence_search' && init?.method === 'POST') return { success: true, job_id: 'j1', status: 'done', result: RESULT };
      if (url.endsWith('/track')) return { success: true, track_index: 3, path: 'seqsearch://j1', label: 'x' };
      throw new Error(`unexpected ${url}`);
    });
    const setViewport = vi.fn();
    useBrowserStore.setState({ setViewport } as never);
    act(() => root.render(<SequenceSearchPanel />));
    act(() => { useSequenceSearch.setState({ query: PLANT }); });
    act(() => q(container, 'seqsearch-find')!.click());
    await wait(20);
    expect(q(container, 'seqsearch-stale')).toBeNull();
    // Another genome with the same contig names is loaded.
    status = { ...STATUS, genome: 'other', reference_id: 'r2' };
    act(() => { useBrowserStore.setState({ currentGenome: 'other', chroms: [{ name: 'chr1', size: 40_000 }, { name: 'chr2', size: 25_000 }] } as never); });
    await wait(20);
    expect(q(container, 'seqsearch-stale')).not.toBeNull();
    expect((q(container, 'seqsearch-add-track') as HTMLButtonElement).disabled).toBe(true);
    act(() => container.querySelectorAll<HTMLElement>('[data-testid="seqsearch-hit"]')[0].click());
    expect(setViewport).not.toHaveBeenCalled();
    expect(q(container, 'seqsearch-notice')!.textContent).toMatch(/different reference/);
    const { addHitsTrack } = await import('./store');
    let reply = '';
    await act(async () => { reply = await addHitsTrack(); });
    expect(reply).toMatch(/different reference/);
    expect(fetchJson.mock.calls.some(c => String(c[0]).endsWith('/track'))).toBe(false);
  });

  it('blocks hits from the moment the reference changes until the new reference is verified; late replies are dropped', async () => {
    const statusReplies: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
    fetchJson.mockImplementation((url: string) => {
      if (url.endsWith('/status')) return new Promise((resolve, reject) => statusReplies.push({ resolve, reject }));
      if (url.endsWith('/track')) return Promise.resolve({ success: true, track_index: 3, path: 'seqsearch://j1', label: 'x' });
      throw new Error(`unexpected ${url}`);
    });
    const setViewport = vi.fn();
    useBrowserStore.setState({ setViewport, currentGenome: 'toy' } as never);
    const { goToHit, isStaleResult, refreshStatus, STALE_REFERENCE_MESSAGE, addHitsTrack } = await import('./store');
    // A result found on r1, shown with the r1 status.
    useSequenceSearch.setState({ status: STATUS as never, result: RESULT, jobId: 'j1', run: 'done' });
    // A status request from before the change is still out when another genome is loaded.
    for (const r of statusReplies.splice(0)) r.resolve(STATUS);
    useSequenceSearch.setState({ referencePending: false });
    const early = refreshStatus();
    act(() => { useBrowserStore.setState({ currentGenome: 'other' } as never); });
    // At once: no navigation to the old hits, no track.
    expect(goToHit(0)).toMatch(/Checking the loaded reference/);
    expect(setViewport).not.toHaveBeenCalled();
    // The early (pre-change) reply says r1: dropped, still blocked.
    await act(async () => { statusReplies[0].resolve(STATUS); await early; });
    expect(goToHit(0)).toMatch(/Checking the loaded reference/);
    expect(setViewport).not.toHaveBeenCalled();
    // The refresh after the change fails: still blocked (fails closed).
    const afterChange = statusReplies[1];
    await act(async () => { afterChange.reject(new Error('offline')); await new Promise(r => setTimeout(r, 0)); });
    expect(goToHit(0)).toMatch(/Checking the loaded reference/);
    expect(setViewport).not.toHaveBeenCalled();
    // A refresh that succeeds with the new reference: the hits are stale.
    const later = refreshStatus();
    await act(async () => { statusReplies[statusReplies.length - 1].resolve({ ...STATUS, genome: 'other', reference_id: 'r2' }); await later; });
    expect(isStaleResult()).toBe(true);
    expect(goToHit(0)).toBe(STALE_REFERENCE_MESSAGE);
    expect(setViewport).not.toHaveBeenCalled();
    // Back to the first reference: verified again, the hits can be followed.
    act(() => { useBrowserStore.setState({ currentGenome: 'toy' } as never); });
    expect(goToHit(0)).toMatch(/Checking the loaded reference/);
    let track: Promise<string> = Promise.resolve('');
    act(() => { track = addHitsTrack(); });
    await act(async () => { for (const r of statusReplies.slice(-2)) r.resolve(STATUS); await track; });
    expect(goToHit(0)).toBeNull();
    expect(setViewport).toHaveBeenCalledTimes(1);
  });

  it('a first status request still out when the reference changes does not verify the new reference', async () => {
    const statusReplies: Array<(v: unknown) => void> = [];
    fetchJson.mockImplementation((url: string) => {
      if (url.endsWith('/status')) return new Promise(resolve => statusReplies.push(resolve));
      throw new Error(`unexpected ${url}`);
    });
    const { refreshStatus } = await import('./store');
    useSequenceSearch.setState({ status: null, result: null, referencePending: false });
    const first = refreshStatus();
    act(() => { useBrowserStore.setState({ currentGenome: 'another' } as never); });
    await act(async () => { statusReplies[statusReplies.length - 2](STATUS); await first; });
    expect(useSequenceSearch.getState().referencePending).toBe(true);
    await act(async () => { statusReplies[statusReplies.length - 1]({ ...STATUS, reference_id: 'r9' }); await new Promise(r => setTimeout(r, 0)); });
    expect(useSequenceSearch.getState()).toMatchObject({ referencePending: false, status: { reference_id: 'r9' } });
  });

  it('cancels the job of a start that is cancelled or superseded before it answers (release audit 3.1.0)', async () => {
    const pending: Array<{ body: string; resolve: (v: unknown) => void }> = [];
    fetchJson.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/status')) return Promise.resolve(STATUS);
      if (url === '/api/sequence_search' && init?.method === 'POST') {
        return new Promise(resolve => pending.push({ body: String(init.body), resolve }));
      }
      if (init?.method === 'DELETE') return Promise.resolve({ success: true });
      return Promise.resolve({ success: true, status: 'running', progress: 0.1, message: 'Scanning' });
    });
    const { startSearch, cancelSearch } = await import('./store');
    const deletes = () => fetchJson.mock.calls.filter(c => c[1]?.method === 'DELETE').map(c => String(c[0]));
    // Cancel while the start is in flight: its job is cancelled when the reply arrives.
    let started = startSearch(PLANT);
    await wait(0);
    await act(async () => { await cancelSearch(); });
    expect(deletes()).toEqual([]);
    pending[0].resolve({ success: true, job_id: 'jA', status: 'running', progress: 0 });
    await act(async () => { await started; });
    expect(deletes()).toEqual(['/api/sequence_search/jobs/jA']);
    expect(useSequenceSearch.getState().run).toBe('cancelled');
    // Superseded by a different search: the first one's job is cancelled.
    started = startSearch(PLANT);
    await wait(0);
    const second = startSearch('ACGTTGCAACGTTGCA');
    await wait(0);
    pending[1].resolve({ success: true, job_id: 'jB', status: 'running', progress: 0 });
    await act(async () => { await started; });
    expect(deletes()).toEqual(['/api/sequence_search/jobs/jA', '/api/sequence_search/jobs/jB']);
    pending[2].resolve({ success: true, job_id: 'jC', status: 'running', progress: 0 });
    await act(async () => { await second; });
    expect(useSequenceSearch.getState().jobId).toBe('jC');
    // Superseded by the same search: the server answers both with one job, which is kept.
    await act(async () => { await cancelSearch(); });
    started = startSearch(PLANT);
    await wait(0);
    const again = startSearch(PLANT);
    await wait(0);
    pending[3].resolve({ success: true, job_id: 'jD', status: 'running', progress: 0 });
    await act(async () => { await started; });
    pending[4].resolve({ success: true, job_id: 'jD', status: 'running', progress: 0 });
    await act(async () => { await again; });
    expect(deletes().filter(d => d.endsWith('/jD'))).toEqual([]);
    expect(useSequenceSearch.getState()).toMatchObject({ run: 'running', jobId: 'jD' });
    await act(async () => { await cancelSearch(); });
  });

  it('equivalent searches (case-different DNA) keep their shared job; a different job is cancelled once the newer start answers', async () => {
    const pending: Array<{ body: string; resolve: (v: unknown) => void }> = [];
    fetchJson.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/status')) return Promise.resolve(STATUS);
      if (url === '/api/sequence_search' && init?.method === 'POST') {
        return new Promise(resolve => pending.push({ body: String(init.body), resolve }));
      }
      if (init?.method === 'DELETE') return Promise.resolve({ success: true });
      return Promise.resolve({ success: true, status: 'running', progress: 0.1, message: 'Scanning' });
    });
    const { startSearch, cancelSearch } = await import('./store');
    const deletes = () => fetchJson.mock.calls.filter(c => c[1]?.method === 'DELETE').map(c => String(c[0]));
    // Upper then lower case: the server answers both with one job; the older reply arrives first.
    let first = startSearch(PLANT);
    await wait(0);
    let second = startSearch(PLANT.toLowerCase());
    await wait(0);
    pending[0].resolve({ success: true, job_id: 'jE', status: 'running', progress: 0 });
    await act(async () => { await first; });
    expect(deletes()).toEqual([]);
    pending[1].resolve({ success: true, job_id: 'jE', status: 'running', progress: 0 });
    await act(async () => { await second; });
    expect(deletes()).toEqual([]);
    expect(useSequenceSearch.getState()).toMatchObject({ run: 'running', jobId: 'jE' });
    // The same search answered with two jobs (e.g. the reference changed between them): the older one is
    // cancelled when the newer start has answered.
    await act(async () => { await cancelSearch(); });
    first = startSearch(PLANT);
    await wait(0);
    second = startSearch(`>q\n${PLANT.toLowerCase()}`);
    await wait(0);
    pending[2].resolve({ success: true, job_id: 'jF', status: 'running', progress: 0 });
    await act(async () => { await first; });
    expect(deletes()).toEqual(['/api/sequence_search/jobs/jE']);
    pending[3].resolve({ success: true, job_id: 'jG', status: 'running', progress: 0 });
    await act(async () => { await second; });
    expect(deletes()).toEqual(['/api/sequence_search/jobs/jE', '/api/sequence_search/jobs/jF']);
    expect(useSequenceSearch.getState().jobId).toBe('jG');
    // Cancel while an older reply waits on the newer start: the waiting job is cancelled at once.
    await act(async () => { await cancelSearch(); });
    first = startSearch(PLANT);
    await wait(0);
    second = startSearch(PLANT.toLowerCase());
    await wait(0);
    pending[4].resolve({ success: true, job_id: 'jH', status: 'running', progress: 0 });
    await act(async () => { await first; });
    expect(deletes()).not.toContain('/api/sequence_search/jobs/jH');
    await act(async () => { await cancelSearch(); });
    expect(deletes()).toContain('/api/sequence_search/jobs/jH');
    pending[5].resolve({ success: true, job_id: 'jH', status: 'running', progress: 0 });
    await act(async () => { await second; });
    expect(useSequenceSearch.getState().run).toBe('cancelled');
  });

  it('says when no genome is loaded, and refuses a bad query before asking the server', async () => {
    fetchJson.mockImplementation(async (url: string) => {
      if (url.endsWith('/status')) return { ...STATUS, genome_loaded: false, searchable: false, problem: { code: 'no_genome', message: 'No reference genome is loaded. Open a genome first.' } };
      throw new Error(`unexpected ${url}`);
    });
    act(() => root.render(<SequenceSearchPanel />));
    await wait(10);
    expect(q(container, 'seqsearch-problem')!.textContent).toMatch(/No reference genome/);
    act(() => { useSequenceSearch.setState({ query: 'ACGTACGTACGTQQ' }); });
    expect(q(container, 'seqsearch-parse-error')!.textContent).toMatch(/Not DNA/);
    expect((q(container, 'seqsearch-find') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the server refusing a query, and stops a running search', async () => {
    fetchJson.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/status')) return STATUS;
      if (url === '/api/sequence_search') return { success: false, error: 'The sequence is mostly ambiguous bases', code: 'bad_query' };
      return { success: true, status: 'running', progress: 0.1, message: init?.method ?? 'x' };
    });
    act(() => root.render(<SequenceSearchPanel />));
    act(() => { useSequenceSearch.setState({ query: PLANT }); });
    act(() => q(container, 'seqsearch-find')!.click());
    await wait(20);
    expect(q(container, 'seqsearch-error')!.dataset.code).toBe('bad_query');
  });

  it('opens from the locus box suggestion with the sequence and starts the search', async () => {
    routeFetch(() => ({ success: true, status: 'running', progress: 0.2, message: 'Indexing the genome for BLAST' }));
    const openAnalysisPanel = vi.fn();
    useBrowserStore.setState({ openAnalysisPanel } as never);
    openSequenceSearch(PLANT, true);
    await wait(20);
    expect(openAnalysisPanel).toHaveBeenCalledWith('sequence-search');
    expect(useSequenceSearch.getState()).toMatchObject({ query: PLANT, run: 'running', jobId: 'j1' });
    act(() => root.render(<SequenceSearchPanel />));
    await wait(10);
    act(() => q(container, 'seqsearch-cancel')!.click());
    await wait(10);
    expect(useSequenceSearch.getState().run).toBe('cancelled');
    expect(fetchJson.mock.calls.some(c => String(c[0]).includes('/jobs/j1') && c[1]?.method === 'DELETE')).toBe(true);
  });
});
