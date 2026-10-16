import { describe, expect, it, vi } from 'vitest';
import { retryDelayMs, wrapFetchWithRetry } from './publicRetry';

const busy = (status: number, retryAfter: string | null) =>
  new Response('{}', { status, headers: retryAfter === null ? {} : { 'Retry-After': retryAfter } });

describe('public server retry', () => {
  it('reads Retry-After on 429/503 only, within a short wait', () => {
    expect(retryDelayMs(busy(429, '1'))).toBe(1000);
    expect(retryDelayMs(busy(503, '0'))).toBe(250);
    expect(retryDelayMs(busy(429, '60'))).toBeNull();
    expect(retryDelayMs(busy(429, null))).toBeNull();
    expect(retryDelayMs(busy(500, '1'))).toBeNull();
  });

  it('retries a rate-limited read and returns the later answer', async () => {
    vi.useFakeTimers();
    const base = vi.fn()
      .mockResolvedValueOnce(busy(429, '1'))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    const fetcher = wrapFetchWithRetry(base as unknown as typeof fetch);
    const pending = fetcher('/api/reads/compact?chrom=chr1');
    await vi.advanceTimersByTimeAsync(1000);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(base).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('never repeats an analysis (POST)', async () => {
    const base = vi.fn().mockResolvedValue(busy(429, '1'));
    const response = await wrapFetchWithRetry(base as unknown as typeof fetch)('/api/cluster', { method: 'POST' });
    expect(response.status).toBe(429);
    expect(base).toHaveBeenCalledTimes(1);
  });

  it('gives up after a couple of tries', async () => {
    vi.useFakeTimers();
    const base = vi.fn().mockResolvedValue(busy(503, '1'));
    const pending = wrapFetchWithRetry(base as unknown as typeof fetch)('/api/coverage');
    await vi.advanceTimersByTimeAsync(5000);
    expect((await pending).status).toBe(503);
    expect(base).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
});
