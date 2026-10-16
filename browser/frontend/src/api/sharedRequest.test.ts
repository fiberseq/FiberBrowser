import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAbortError, resetSharedRequests, sharedRequest, sharedRequestsInFlight, sharedResult } from './sharedRequest';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A fake request: resolves when told, rejects with AbortError when its signal aborts. */
function fakeStart() {
  const calls: { signal: AbortSignal; d: ReturnType<typeof deferred<string>> }[] = [];
  const start = vi.fn((signal: AbortSignal) => {
    const d = deferred<string>();
    signal.addEventListener('abort', () => d.reject(new DOMException('aborted', 'AbortError')));
    calls.push({ signal, d });
    return d.promise;
  });
  return { start, calls };
}

afterEach(() => resetSharedRequests());

describe('sharedRequest', () => {
  it('runs one request for identical keys in flight', async () => {
    const { start, calls } = fakeStart();
    const a = sharedRequest('k', start);
    const b = sharedRequest('k', start);
    expect(start).toHaveBeenCalledTimes(1);
    calls[0].d.resolve('answer');
    await expect(a).resolves.toBe('answer');
    await expect(b).resolves.toBe('answer');
  });

  it('keeps a finished answer: asking again sends nothing', async () => {
    const { start, calls } = fakeStart();
    const a = sharedRequest('k', start);
    calls[0].d.resolve('answer');
    await a;
    await expect(sharedRequest('k', start)).resolves.toBe('answer');
    expect(start).toHaveBeenCalledTimes(1);
    expect(sharedResult('k')).toBe('answer');
  });

  it('does not keep an answer `keep` refuses', async () => {
    const { start, calls } = fakeStart();
    const a = sharedRequest('k', start, undefined, { keep: v => v !== 'bad' });
    calls[0].d.resolve('bad');
    await a;
    expect(sharedResult('k')).toBeUndefined();
  });

  it('aborts the request only when every caller has aborted', async () => {
    const { start, calls } = fakeStart();
    const one = new AbortController();
    const two = new AbortController();
    const a = sharedRequest('k', start, one.signal);
    const b = sharedRequest('k', start, two.signal);
    one.abort();
    await expect(a).rejects.toSatisfy(isAbortError);
    expect(calls[0].signal.aborted).toBe(false); // the other caller still waits
    two.abort();
    await expect(b).rejects.toSatisfy(isAbortError);
    expect(calls[0].signal.aborted).toBe(true); // nobody waits: the fetch (and the server) stop
    expect(sharedRequestsInFlight()).toBe(0);
  });

  it('a caller after an abort starts a fresh request (never inherits the aborted one)', async () => {
    const { start, calls } = fakeStart();
    const one = new AbortController();
    const a = sharedRequest('k', start, one.signal);
    one.abort();
    await expect(a).rejects.toSatisfy(isAbortError);
    const b = sharedRequest('k', start);
    expect(start).toHaveBeenCalledTimes(2);
    calls[1].d.resolve('fresh');
    await expect(b).resolves.toBe('fresh');
  });

  it('an already-aborted signal sends nothing', async () => {
    const { start } = fakeStart();
    const c = new AbortController();
    c.abort();
    await expect(sharedRequest('k', start, c.signal)).rejects.toSatisfy(isAbortError);
    expect(start).not.toHaveBeenCalled();
  });

  it('a failure is not kept: the next caller asks again', async () => {
    const { start, calls } = fakeStart();
    const a = sharedRequest('k', start);
    calls[0].d.reject(new Error('API error 500'));
    await expect(a).rejects.toThrow('500');
    void sharedRequest('k', start).catch(() => {});
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('different keys are different requests', () => {
    const { start } = fakeStart();
    void sharedRequest('a', start).catch(() => {});
    void sharedRequest('b', start).catch(() => {});
    expect(start).toHaveBeenCalledTimes(2);
  });
});
