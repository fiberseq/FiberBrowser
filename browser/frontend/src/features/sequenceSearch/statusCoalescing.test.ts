/** 3.1.0 audit: a status request still out when the reference changes must not verify the new reference, even
 *  through the real fetchJson, which coalesces same-URL GETs without a signal into one network request. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { goToHit, isStaleResult, refreshStatus, resetSequenceSearch, useSequenceSearch } from './store';
import type { SearchResult } from './model';

const STATUS = (reference_id: string, genome: string) => ({
  success: true, genome, genome_loaded: true, searchable: true, problem: null, plasmids: [], reference_id,
  blast: { available: true, blastn: true, makeblastdb: true, db_ready: false, hint: '' },
  defaults: { mode: 'auto', exact_max_length: 30, max_mismatches: 0, evalue: 0.01, max_hits: 500, min_length: 12, blast_task: 'auto' },
});
const RESULT = {
  schema: 'fiberbrowser.sequence_search/1', mode: 'exact', query: 'GATTACAGGCTTCAAGT', query_length: 17, genome: 'a', reference_id: 'ref-a',
  settings: STATUS('ref-a', 'a').defaults, notes: [], total: 1, palindrome: false,
  hits: [{ chrom: 'chr1', start: 1000, end: 1017, strand: '+', mismatches: 0, identity: 100, evalue: null, bitscore: null, qstart: 0, qend: 17,
    matched: 'GATTACAGGCTTCAAGT' }],
} as unknown as SearchResult;

describe('sequence-search status after a reference change (real fetch coalescing)', () => {
  const replies: Array<(body: unknown) => void> = [];
  beforeEach(() => {
    replies.length = 0;
    resetSequenceSearch();
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => replies.push(body => resolve(new Response(JSON.stringify(body), {
      status: 200, headers: { 'Content-Type': 'application/json' } }))))));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('the refresh after the change is its own request; the old answer does not unblock the hits', async () => {
    const setViewport = vi.fn();
    useBrowserStore.setState({ setViewport, currentGenome: 'a', chroms: [] } as never);
    useSequenceSearch.setState({ status: STATUS('ref-a', 'a') as never, result: RESULT, jobId: 'j1', run: 'done' });
    // A status request on reference A is out when B is loaded.
    const early = refreshStatus();
    useBrowserStore.setState({ currentGenome: 'b' } as never);
    expect(useSequenceSearch.getState().referencePending).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    // A's answer arrives first: dropped, the hits stay blocked.
    replies[0](STATUS('ref-a', 'a'));
    await early;
    await new Promise(r => setTimeout(r, 0));
    expect(useSequenceSearch.getState().referencePending).toBe(true);
    expect(goToHit(0)).toMatch(/Checking the loaded reference/);
    expect(setViewport).not.toHaveBeenCalled();
    // B's answers (the change's refresh and the one the blocked click asked for): verified, A's hits are stale.
    for (const reply of replies.slice(1)) reply(STATUS('ref-b', 'b'));
    await vi.waitFor(() => expect(useSequenceSearch.getState().referencePending).toBe(false));
    expect(isStaleResult()).toBe(true);
    expect(setViewport).not.toHaveBeenCalled();
  });
});
