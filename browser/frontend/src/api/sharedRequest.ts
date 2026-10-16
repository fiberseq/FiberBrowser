/**
 * One request per question for the background analyses that follow the view
 * (quality-filter counts, insertions in view): identical keys in flight share
 * one fetch, the fetch is aborted once every caller has aborted (so the server
 * stops its work: services/background_work.py), and a finished answer is kept
 * for a while, so going back to a view asks nothing.
 *
 * Callers pass their own AbortSignal and abort it when the view moves on.
 */

interface Entry<T> {
  promise: Promise<T>;
  controller: AbortController;
  consumers: number;
  settled: boolean;
}

interface Cached<T> { value: T; at: number }

const inFlight = new Map<string, Entry<unknown>>();
const results = new Map<string, Cached<unknown>>();

export const SHARED_RESULT_TTL_MS = 10 * 60_000;
export const SHARED_RESULT_MAX = 100;

function abortError(): DOMException {
  return new DOMException('Request aborted', 'AbortError');
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
    || (typeof error === 'object' && error !== null && (error as { name?: string }).name === 'AbortError');
}

/** A finished answer for `key`, if one is kept. */
export function sharedResult<T>(key: string, ttlMs = SHARED_RESULT_TTL_MS): T | undefined {
  const hit = results.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > ttlMs) { results.delete(key); return undefined; }
  return hit.value as T;
}

function remember(key: string, value: unknown) {
  results.delete(key);
  results.set(key, { value, at: Date.now() });
  while (results.size > SHARED_RESULT_MAX) results.delete(results.keys().next().value!);
}

/**
 * `start(signal)` once per `key` while it is in flight (or answered within
 * `ttlMs`); this caller's `signal` only detaches this caller.
 */
export function sharedRequest<T>(
  key: string,
  start: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  { ttlMs = SHARED_RESULT_TTL_MS, keep = (_value: T) => true }: { ttlMs?: number; keep?: (value: T) => boolean } = {},
): Promise<T> {
  if (signal?.aborted) return Promise.reject(abortError());
  const cached = sharedResult<T>(key, ttlMs);
  if (cached !== undefined) return Promise.resolve(cached);

  let entry = inFlight.get(key) as Entry<T> | undefined;
  if (!entry || entry.controller.signal.aborted) {
    const controller = new AbortController();
    const created: Entry<T> = { controller, consumers: 0, settled: false, promise: undefined as unknown as Promise<T> };
    created.promise = start(controller.signal).then(
      value => {
        created.settled = true;
        if (inFlight.get(key) === created) inFlight.delete(key);
        if (!controller.signal.aborted && keep(value)) remember(key, value);
        return value;
      },
      error => {
        created.settled = true;
        if (inFlight.get(key) === created) inFlight.delete(key);
        throw error;
      },
    );
    created.promise.catch(() => { /* each consumer sees it */ });
    inFlight.set(key, created as Entry<unknown>);
    entry = created;
  }
  const shared = entry;
  shared.consumers += 1;
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const leave = () => {
      shared.consumers -= 1;
      if (shared.consumers <= 0 && !shared.settled) {
        // Nobody wants it now: stop it (the server stops too), and forget it.
        if (inFlight.get(key) === shared) inFlight.delete(key);
        shared.controller.abort();
      }
    };
    const onAbort = () => {
      if (done) return;
      done = true;
      leave();
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    shared.promise.then(
      value => {
        if (done) return;
        done = true;
        signal?.removeEventListener('abort', onAbort);
        shared.consumers -= 1;
        resolve(value);
      },
      error => {
        if (done) return;
        done = true;
        signal?.removeEventListener('abort', onAbort);
        shared.consumers -= 1;
        reject(error);
      },
    );
  });
}

/** In-flight requests (tests). */
export function sharedRequestsInFlight(): number {
  return inFlight.size;
}

/** Forget everything (tests; a data refresh). */
export function resetSharedRequests(): void {
  for (const entry of inFlight.values()) entry.controller.abort();
  inFlight.clear();
  results.clear();
}
