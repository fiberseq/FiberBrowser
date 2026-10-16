import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiIdleToken, readIdleToken, fetchApiResponse, fetchJson, fetchJsonSharedGet } from './sharedFetch';

describe('shared API transport', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('keeps foreground read decoding active while excluding polling and speculative fills', async () => {
    const pending = new Map<string, (value: unknown) => void>();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true,
      json: () => new Promise(resolve => pending.set(url, resolve)),
    }) as Response));
    const status = fetchJson('/api/status');
    const reads = fetchJson('/api/reads/compact_all?dataset_ids=a');
    const fill = fetchJson('/api/reads/compact?prefetch=true', { priority: 'low' } as RequestInit);
    await vi.waitFor(() => expect(pending.size).toBe(3));
    expect(readIdleToken()).toBeUndefined();
    pending.get('/api/reads/compact_all?dataset_ids=a')!({ reads: [] });
    await reads;
    expect(readIdleToken()).toBeTypeOf('number');
    expect(apiIdleToken()).toBeUndefined();
    pending.get('/api/status')!({});
    pending.get('/api/reads/compact?prefetch=true')!({});
    await Promise.all([status, fill]);
    expect(apiIdleToken()).toBeTypeOf('number');
  });

  it('forces browser-session credentials on response fetches', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ success: true }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    await fetchApiResponse('/api/example', { credentials: 'omit' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.credentials).toBe('include');
  });

  it('forces browser-session credentials on JSON fetches', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ success: true }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    await fetchJson('/api/json-example', { credentials: 'omit' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.credentials).toBe('include');
  });

  it('includes backend error details on failed JSON fetches', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 404,
      clone() {
        return this;
      },
      json: async () => ({ detail: 'File not found: /mnt/z/sample.bam' }),
      text: async () => '',
    }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchJson('/api/datasets/add', { method: 'POST' }))
      .rejects.toThrow('API error 404: File not found: /mnt/z/sample.bam');
  });

  it('coalesces identical shared GETs while aborting only the cancelled consumer', async () => {
    let resolveJson!: (value: { success: boolean }) => void;
    const jsonPromise = new Promise<{ success: boolean }>((resolve) => {
      resolveJson = resolve;
    });
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => jsonPromise,
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = fetchJsonSharedGet('/api/reads/compact?dataset_id=a', {
      signal: firstController.signal,
    });
    const second = fetchJsonSharedGet('/api/reads/compact?dataset_id=a', {
      signal: secondController.signal,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    firstController.abort();

    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect((fetchMock.mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(false);

    resolveJson({ success: true });
    await expect(second).resolves.toEqual({ success: true });
  });

  it('aborts the shared backend GET only after all abortable consumers cancel', async () => {
    vi.useFakeTimers();
    let backendSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      backendSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        backendSignal?.addEventListener('abort', () => {
          reject(new DOMException('Request aborted', 'AbortError'));
        });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = fetchJsonSharedGet('/api/coverage?chrom=2R', {
      signal: firstController.signal,
    });
    const second = fetchJsonSharedGet('/api/coverage?chrom=2R', {
      signal: secondController.signal,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    firstController.abort();

    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(backendSignal?.aborted).toBe(false);

    secondController.abort();

    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    expect(backendSignal?.aborted).toBe(false);
    await vi.runOnlyPendingTimersAsync();
    expect(backendSignal?.aborted).toBe(true);
  });

  it('keeps same-key shared GETs alive across same-tick consumer replacement', async () => {
    vi.useFakeTimers();
    let backendSignal: AbortSignal | undefined;
    let resolveJson!: (value: { success: boolean }) => void;
    const jsonPromise = new Promise<{ success: boolean }>((resolve) => {
      resolveJson = resolve;
    });
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      backendSignal = init?.signal ?? undefined;
      return {
        ok: true,
        json: async () => jsonPromise,
      } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const firstController = new AbortController();
    const first = fetchJsonSharedGet('/api/reads/compact?dataset_id=a', {
      signal: firstController.signal,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    firstController.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(backendSignal?.aborted).toBe(false);

    const secondController = new AbortController();
    const second = fetchJsonSharedGet('/api/reads/compact?dataset_id=a', {
      signal: secondController.signal,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.runOnlyPendingTimersAsync();
    expect(backendSignal?.aborted).toBe(false);

    resolveJson({ success: true });
    await expect(second).resolves.toEqual({ success: true });
  });

  it('restarts an aborted key before the old transport settles and preserves the replacement', async () => {
    vi.useFakeTimers();
    let rejectOld!: (reason: unknown) => void;
    let resolveFresh: (response: Response) => void = () => {};
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init!.signal as AbortSignal);
      if (signals.length === 1) return new Promise<Response>((_resolve, reject) => { rejectOld = reject; });
      return new Promise<Response>(resolve => { resolveFresh = resolve; });
    });
    vi.stubGlobal('fetch', fetchMock);
    const url = '/api/reads/compact_all?layer_names=nuc,tf_cr&abort-race=1';
    const firstController = new AbortController();
    const first = fetchJsonSharedGet(url, {signal: firstController.signal});
    firstController.abort();
    await expect(first).rejects.toMatchObject({name: 'AbortError'});
    await vi.runOnlyPendingTimersAsync();
    expect(signals[0].aborted).toBe(true);

    // The real fetch/body rejection need not settle in the same task as abort.
    // Returning to this layer set must not join that doomed pending request.
    const second = fetchJsonSharedGet(url, {signal: new AbortController().signal});
    const secondOutcome = second.then(value => ({value}), error => ({error}));
    try {
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(signals[1].aborted).toBe(false);
      rejectOld(new DOMException('Late abort rejection', 'AbortError'));
      await vi.runOnlyPendingTimersAsync();
      const third = fetchJsonSharedGet(url, {signal: new AbortController().signal});
      expect(fetchMock).toHaveBeenCalledTimes(2);
      resolveFresh({ok: true, json: async () => ({reads: ['fresh']})} as Response);
      await expect(secondOutcome).resolves.toEqual({value: {reads: ['fresh']}});
      await expect(third).resolves.toEqual({reads: ['fresh']});
    } finally {
      rejectOld(new DOMException('Cleanup', 'AbortError'));
      resolveFresh({ok: true, json: async () => ({reads: ['fresh']})} as Response);
      await secondOutcome;
    }
  });
});

it('keeps decoded regions across viewport reports and invalidates on mutations', async () => {
  const { readRegionGeneration } = await import('./loadedReadRegion');
  const fetchMock = vi.fn(async () => ({ ok: true }) as Response);
  vi.stubGlobal('fetch', fetchMock);
  try {
    const before = readRegionGeneration();
    for (const path of ['/api/render/live_state', '/api/tabs/heartbeat?tab=test', '/api/jupyter/settings/sync', '/api/jupyter/browser_order', '/api/jupyter/sync_peaks', '/api/scan_peaks?chrom=chr1&start=0&end=100']) {
      await fetchApiResponse(path, { method: 'POST', body: '{}' });
    }
    expect(readRegionGeneration()).toBe(before);
    // Session restoration saves pinned motifs and analysis preferences while
    // the first read request is in flight. This must not obsolete its cohort.
    await fetchApiResponse('/api/preferences/analysis', { method: 'PUT', body: '{}' });
    await fetchApiResponse('/api/regions/catalog', { method: 'PUT', body: '{}' });
    await fetchApiResponse('/api/regions/catalog?genome=chr1', { method: 'DELETE' });
    expect(readRegionGeneration()).toBe(before);
    await fetchApiResponse('/api/quality_filters', { method: 'POST', body: '{}' });
    expect(readRegionGeneration()).toBe(before + 1);
  } finally {
    vi.unstubAllGlobals();
  }
});
