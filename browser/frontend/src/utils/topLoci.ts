import { getTopCoveredWindows, type FindReadsReason, type TopWindow } from '../api/coverage';

/**
 * Stepping through the best-covered loci, deepest first. Each click goes to
 * the next one (wrapping round); the ranking is fetched once per dataset and
 * zoom (widths within 10% share it).
 *
 * A search always ends: with a locus, or with the server's reason why there
 * is none (e.g. no reads of the dataset map to the loaded genome), when the
 * caller cancels it, or after FIND_READS_TIMEOUT_MS.
 */
export const FIND_READS_TIMEOUT_MS = 60_000;

interface Ranking { windows: TopWindow[]; message?: string; reason?: FindReadsReason }
interface RankingRequest {
  promise: Promise<Ranking>;
  controller: AbortController;
  /** Callers waiting for it; the request is aborted only when all of them cancel. */
  waiting: number;
  timedOut: boolean;
}

const lists = new Map<string, RankingRequest>();
const cursors = new Map<string, number>();

const keyFor = (span: number, datasetId?: string, fit = false) => `${datasetId ?? '*'}|${Math.round(Math.log(Math.max(1, span)) / Math.log(1.1))}${fit ? '|fit' : ''}`;

export interface TopLocusStep { window: TopWindow; index: number; total: number }
export type TopLocusMissReason = FindReadsReason | 'cancelled' | 'error';
/** No locus to go to, and why (a message for the user). */
export interface TopLocusMiss { window: null; reason: TopLocusMissReason; message: string }
export type TopLocusResult = TopLocusStep | TopLocusMiss;

export const isTopLocusStep = (r: TopLocusResult): r is TopLocusStep => r.window !== null;

function ranking(key: string, span: number, datasetId: string | undefined, timeoutMs: number, fit = false): RankingRequest {
  const existing = lists.get(key);
  if (existing) return existing;
  const controller = new AbortController();
  const request = { controller, waiting: 0, timedOut: false } as RankingRequest;
  const timer = setTimeout(() => { request.timedOut = true; controller.abort(); }, timeoutMs);
  request.promise = getTopCoveredWindows(span, datasetId, 20, { signal: controller.signal, fit })
    .then((res): Ranking => ({
      windows: res.success && Array.isArray(res.windows) ? res.windows : [],
      message: res.error,
      reason: res.reason,
    }))
    .finally(() => clearTimeout(timer));
  const promise = request.promise;
  lists.set(key, request);
  promise.catch(() => { if (lists.get(key) === request) lists.delete(key); });
  return request;
}

export interface FindTopLocusOptions {
  /** Aborting it cancels the search (a Cancel button). */
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Narrow each locus to its reads when they cover much less than `span` (amplicons, short reads). */
  fit?: boolean;
}

/** The next best-covered locus at this zoom, or why there is none. Never rejects. */
export async function findTopLocus(span: number, datasetId?: string, options: FindTopLocusOptions = {}): Promise<TopLocusResult> {
  const { signal, timeoutMs = FIND_READS_TIMEOUT_MS, fit = false } = options;
  const key = keyFor(span, datasetId, fit);
  if (signal?.aborted) return { window: null, reason: 'cancelled', message: 'Search cancelled.' };
  const request = ranking(key, span, datasetId, timeoutMs, fit);
  request.waiting += 1;
  let cancelled = false;
  let stopWaiting: () => void = () => {};
  const cancelledNow = new Promise<'cancelled'>(resolve => { stopWaiting = () => resolve('cancelled'); });
  const cancel = () => {
    cancelled = true;
    stopWaiting();
    // Only this caller gives up; the request goes when nobody else waits for it.
    request.waiting -= 1;
    if (request.waiting <= 0) {
      request.controller.abort();
      if (lists.get(key) === request) lists.delete(key);
    }
  };
  signal?.addEventListener('abort', cancel, { once: true });
  let result: Ranking | 'cancelled';
  try {
    // Also settles when the caller cancels, even if the request ignored the abort.
    result = await Promise.race([request.promise, cancelledNow]);
  } catch (err) {
    if (lists.get(key) === request) lists.delete(key);
    if (cancelled || signal?.aborted) return { window: null, reason: 'cancelled', message: 'Search cancelled.' };
    if (request.timedOut) {
      return { window: null, reason: 'timeout', message: `No answer from the server within ${Math.round(timeoutMs / 1000)} s.` };
    }
    const detail = err instanceof Error && err.message ? `: ${err.message}` : '';
    return { window: null, reason: 'error', message: `Could not search for reads${detail}` };
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (!cancelled) request.waiting -= 1;
  }
  if (result === 'cancelled' || cancelled || signal?.aborted) {
    return { window: null, reason: 'cancelled', message: 'Search cancelled.' };
  }
  const { windows } = result;
  if (!windows.length) {
    if (lists.get(key) === request) lists.delete(key);
    return { window: null, reason: result.reason ?? 'not_found', message: result.message || 'No reads found.' };
  }
  const index = (cursors.get(key) ?? 0) % windows.length;
  cursors.set(key, (index + 1) % windows.length);
  return { window: windows[index], index, total: windows.length };
}

/** Forget rankings (datasets or the loaded genome changed): the next search asks the server again. */
export function resetTopLoci(): void {
  lists.clear();
  cursors.clear();
}
