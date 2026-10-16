import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findTopLocus, isTopLocusStep, resetTopLoci } from './topLoci';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

/** A fetch that never answers until aborted (a search that would run forever). */
const hangingFetch = () => vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
  init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
}));

describe('findTopLocus: a reads search always ends', () => {
  beforeEach(() => resetTopLoci());
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('steps through the ranking', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ success: true, windows: [
      { chrom: 'chr2L', start: 100, end: 1100, depth: 40 }, { chrom: 'chr3R', start: 5, end: 1005, depth: 9 }] })));
    const first = await findTopLocus(1000, 'd');
    const second = await findTopLocus(1000, 'd');
    expect(isTopLocusStep(first) && first.window.chrom).toBe('chr2L');
    expect(isTopLocusStep(second) && [second.index, second.total]).toEqual([1, 2]);
  });

  it("gives the server's reason when no read maps to the loaded genome", async () => {
    const fetchMock = vi.fn(async () => json({
      success: false, windows: [], reason: 'contig_mismatch', genome: 'dm6',
      error: 'No reads from napa_ddda map to the loaded genome (dm6).' }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await findTopLocus(1000, 'napa_ddda');
    expect(result).toEqual({ window: null, reason: 'contig_mismatch', message: 'No reads from napa_ddda map to the loaded genome (dm6).' });
    // Not cached: after loading the right genome, the next click asks again.
    await findTopLocus(1000, 'napa_ddda');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('says a dataset has no reads', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ success: false, windows: [], reason: 'no_reads', error: 'No reads found in empty.' })));
    const result = await findTopLocus(1000, 'empty');
    expect(!isTopLocusStep(result) && [result.reason, result.message]).toEqual(['no_reads', 'No reads found in empty.']);
  });

  it('Cancel ends a search the server never answers', async () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const pending = findTopLocus(1000, 'd', { signal: controller.signal });
    controller.abort();
    await expect(pending).resolves.toMatchObject({ window: null, reason: 'cancelled' });
    // The request itself was aborted, and a new click starts a new one.
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal?.aborted).toBe(true);
    const again = findTopLocus(1000, 'd', { signal: AbortSignal.abort() });
    await expect(again).resolves.toMatchObject({ reason: 'cancelled' });
  });

  it('cancelling one search leaves another for the same ranking running', async () => {
    let answer: (r: Response) => void = () => {};
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      answer = resolve;
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    vi.stubGlobal('fetch', fetchMock);
    const panel = new AbortController();
    const first = findTopLocus(1000, 'd', { signal: panel.signal });
    const second = findTopLocus(1000, 'd');
    panel.abort();
    await expect(first).resolves.toMatchObject({ reason: 'cancelled' });
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(false);
    answer(json({ success: true, windows: [{ chrom: 'chr2L', start: 1, end: 1001, depth: 3 }] }));
    const result = await second;
    expect(isTopLocusStep(result) && result.window.chrom).toBe('chr2L');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a cancelled search never moves the view, even with the ranking already known', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ success: true, windows: [{ chrom: 'chr2L', start: 1, end: 1001, depth: 3 }] })));
    await findTopLocus(1000, 'd');
    const controller = new AbortController();
    const pending = findTopLocus(1000, 'd', { signal: controller.signal });
    controller.abort();
    await expect(pending).resolves.toMatchObject({ window: null, reason: 'cancelled' });
  });

  it('times out instead of searching forever', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', hangingFetch());
    const pending = findTopLocus(1000, 'd', { timeoutMs: 5000 });
    await vi.advanceTimersByTimeAsync(5001);
    await expect(pending).resolves.toEqual({ window: null, reason: 'timeout', message: 'No answer from the server within 5 s.' });
  });

  it('a failed request is a message, not a rejection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const result = await findTopLocus(1000, 'd');
    expect(result).toMatchObject({ window: null, reason: 'error' });
    expect(!isTopLocusStep(result) && result.message).toMatch(/^Could not search for reads/);
  });
});
