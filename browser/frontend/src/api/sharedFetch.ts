import { signalFilterUrl } from '../utils/signalFilters';
import { decodeReadStream, READ_STREAM_TYPE, type ReadProgress } from './readStream';
export type ReadRequestOptions = RequestInit & { onReadProgress?: ReadProgress };
import { clearLoadedReadRegions } from './loadedReadRegion';
import { decodeReadBinary, READ_BINARY_TYPE } from './readBinary';
// Shared fetch helpers for API modules. Compact-read GETs use the abort-aware
// shared path so identical viewport requests coalesce instead of stampeding.
const _pendingRequests = new Map<string, Promise<unknown>>();
let activeApiRequests = 0;
let apiActivity = 0;
let activeReadRequests = 0;
let readActivity = 0;
const backgroundSyncPaths = new Set([
  '/api/render/live_state', '/api/tabs/heartbeat', '/api/jupyter/settings/sync',
  '/api/jupyter/browser_order', '/api/jupyter/sync_peaks', '/api/regions/catalog',
  '/api/preferences/analysis',
]);

/** A stable token means no foreground request has started or finished. */
export function apiIdleToken(): number | undefined {
  return activeApiRequests === 0 ? apiActivity : undefined;
}

/** Navigation fills yield to visible reads and analysis, without waiting on status polling. */
export function readIdleToken(): number | undefined {
  return activeReadRequests === 0 ? readActivity : undefined;
}

async function withApiActivity<T>(work: () => Promise<T>, options?: RequestInit, url = ''): Promise<T> {
  if ((options as RequestInit & { priority?: string })?.priority === 'low') return work();
  const path = new URL(url || '/', 'http://localhost').pathname;
  const isRead = /\/api\/(reads\/compact(?:_all)?|linked\/reads\/compact)(?:\?|$)/.test(url)
    || (!!options?.method && !['GET', 'HEAD'].includes(options.method.toUpperCase()) && !backgroundSyncPaths.has(path));
  activeApiRequests++;
  apiActivity++;
  if (isRead) { activeReadRequests++; readActivity++; }
  try { return await work(); }
  finally {
    activeApiRequests--; apiActivity++;
    if (isRead) { activeReadRequests--; readActivity++; }
  }
}

const _sharedGetRequests = new Map<string, {
  controller: AbortController;
  progress: Set<ReadProgress>;
  promise: Promise<unknown>;
  abortableConsumers: Set<AbortSignal>;
  unabortableConsumers: number;
  abortTimer: ReturnType<typeof setTimeout> | null;
}>();

function abortError(): DOMException {
  return new DOMException('Request aborted', 'AbortError');
}

function sortedQueryString(params: URLSearchParams): string {
  return [...params.entries()]
    .sort(([aKey, aVal], [bKey, bVal]) => (
      aKey === bKey ? aVal.localeCompare(bVal) : aKey.localeCompare(bKey)
    ))
    .map(([key, val]) => `${encodeURIComponent(key)}=${encodeURIComponent(val)}`)
    .join('&');
}

export function withSortedParams(path: string, params: URLSearchParams): string {
  const query = sortedQueryString(params);
  return query ? `${path}?${query}` : path;
}

function hasSharedGetConsumers(entry: { abortableConsumers: Set<AbortSignal>; unabortableConsumers: number }): boolean {
  return entry.abortableConsumers.size > 0 || entry.unabortableConsumers > 0;
}

function cancelScheduledAbort(entry: { abortTimer: ReturnType<typeof setTimeout> | null }) {
  if (!entry.abortTimer) return;
  clearTimeout(entry.abortTimer);
  entry.abortTimer = null;
}

function scheduleBackendAbortIfUnused(
  url: string,
  entry: {
    controller: AbortController;
    abortableConsumers: Set<AbortSignal>;
    unabortableConsumers: number;
    abortTimer: ReturnType<typeof setTimeout> | null;
  },
) {
  if (hasSharedGetConsumers(entry) || entry.abortTimer) return;
  entry.abortTimer = setTimeout(() => {
    entry.abortTimer = null;
    const current = _sharedGetRequests.get(url);
    if (current === entry && !hasSharedGetConsumers(current)) {
      // A new consumer can return to this key before fetch/body rejection
      // settles. It must start a fresh request, not inherit an aborted one.
      _sharedGetRequests.delete(url);
      current.controller.abort();
    }
  }, 0);
}

// Polling and high-frequency navigation endpoints dominate the activity log
// without adding training-data value. Skipping them keeps the log focused on
// user-initiated actions and analysis requests.
const _ACTIVITY_LOG_SKIP = [
  /^\/api\/jupyter\/state(\?|$)/,
  /^\/api\/jupyter\/region(\?|$)/,
  /^\/api\/jupyter\/refresh(\?|$)/,
  /^\/api\/dafc\/status(\?|$)/,
  /^\/api\/microc\/expected_status(\?|$)/,
  /^\/api\/primer_progress(\?|$)/,
  /^\/api\/status(\?|$)/,
  /^\/api\/nl\/share_status(\?|$)/,
  /^\/api\/nl\/log_session(\?|$)/,
  /^\/api\/reads\/compact(_all)?(\?|$)/,
  /^\/api\/linked\/reads\/compact(\?|$)/,
  /^\/api\/coverage(\?|$)/,
  /^\/api\/tracks\/batch(\?|$)/,
  // The figure renderer's copy of the view: pushed after every view change,
  // with the whole frontend state (region catalogs included) as its body.
  /^\/api\/render\/live_state(\?|$)/,
];

// Request bodies are kept in the activity log (2,000 entries). A large one is
// recorded by size only: parsed, a 50,000-region catalog in a body cost ~10 MB
// of heap per entry, and the log held every one (the tab grew without bound).
export const ACTIVITY_LOG_BODY_MAX_CHARS = 16_384;

function _logFetch(input: RequestInfo | URL, options?: RequestInit): void {
  try {
    let url = '';
    if (typeof input === 'string') url = input;
    else if (input instanceof URL) url = input.pathname + input.search;
    else if ('url' in input) url = input.url;
    if (!url.startsWith('/api/') && !url.includes('://')) return;
    const path = url.startsWith('http') ? new URL(url).pathname + new URL(url).search : url;
    if (!path.startsWith('/api/')) return;
    if (_ACTIVITY_LOG_SKIP.some(re => re.test(path))) return;
    let body: unknown = options?.body;
    if (typeof body === 'string') {
      if (body.length > ACTIVITY_LOG_BODY_MAX_CHARS) body = `<${body.length} characters>`;
      else try { body = JSON.parse(body); } catch { /* leave as string */ }
    } else if (body instanceof Blob || body instanceof ArrayBuffer || body instanceof FormData) {
      body = '<binary>';
    }
    // Lazy import to avoid a circular dep at module-init time.
    import('../utils/activityLog').then(mod => mod.logActivity({
      timestamp: Date.now(),
      kind: 'api',
      method: (options?.method ?? 'GET').toUpperCase(),
      path,
      body,
    })).catch(() => {/* best-effort */});
  } catch {
    // Logging must never break the fetch.
  }
}

export function fetchApiResponse(input: RequestInfo | URL, options?: RequestInit): Promise<Response> {
  // API routes are session-scoped on the backend. Force credentials here so a
  // caller cannot accidentally override the cookie behavior with `omit`.
  if (typeof input === 'string') input = signalFilterUrl(input);
  _logFetch(input, options);
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const path = new URL(url, 'http://localhost').pathname;
  if (options?.method && !['GET', 'HEAD'].includes(options.method.toUpperCase())
    && !['/api/render/live_state', '/api/tabs/heartbeat', '/api/jupyter/settings/sync',
      '/api/jupyter/browser_order', '/api/jupyter/sync_peaks', '/api/scan_peaks',
      '/api/regions/catalog', '/api/preferences/analysis', '/api/quality_filters'].includes(path)) clearLoadedReadRegions();
  return withApiActivity(async () => {
    const response = await fetch(input, { ...(options ?? {}), credentials: 'include' });
    if (path === '/api/quality_filters' && options?.method?.toUpperCase() === 'POST' && response.ok) {
      // Restoring settings already active on the server must not discard a
      // newly loaded view. Older servers without `changed` still invalidate.
      let changed = true;
      try { changed = (await response.clone().json())?.changed !== false; } catch { /* old response */ }
      if (changed) clearLoadedReadRegions();
    }
    return response;
  }, options, url);
}

export async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  url = signalFilterUrl(url);
  // Only deduplicate GET requests (no body, no signal that would differ).
  const canDedup = !options?.method || options.method === 'GET';
  if (canDedup && !options?.signal) {
    const existing = _pendingRequests.get(url);
    if (existing) return existing as Promise<T>;

    const promise = fetchJsonImpl<T>(url, options).finally(() => {
      _pendingRequests.delete(url);
    });
    _pendingRequests.set(url, promise);
    return promise;
  }
  return fetchJsonImpl<T>(url, options);
}

export async function fetchJsonSharedGet<T>(url: string, options?: ReadRequestOptions): Promise<T> {
  url = signalFilterUrl(url);
  const signal = options?.signal;
  if (signal?.aborted) throw abortError();

  let entry = _sharedGetRequests.get(url);
  if (entry?.controller.signal.aborted) {
    cancelScheduledAbort(entry);
    _sharedGetRequests.delete(url);
    entry = undefined;
  }
  if (!entry) {
    const controller = new AbortController();
    const { signal: _signal, onReadProgress: _progress, ...rest } = options ?? {};
    const progress = new Set<ReadProgress>();
    const promise = fetchJsonImpl<T>(url, { ...rest, signal: controller.signal, onReadProgress: data => { for (const listener of progress) listener(data); } }).finally(() => {
      const current = _sharedGetRequests.get(url);
      if (current && current === entry) {
        cancelScheduledAbort(current);
        _sharedGetRequests.delete(url);
      }
    });
    entry = {
      controller,
      progress,
      promise,
      abortableConsumers: new Set(),
      unabortableConsumers: 0,
      abortTimer: null,
    };
    _sharedGetRequests.set(url, entry);
  }

  cancelScheduledAbort(entry);
  if (options?.onReadProgress) entry.progress.add(options.onReadProgress);

  if (!signal) {
    entry.unabortableConsumers += 1;
    return entry.promise.finally(() => {
      if (options?.onReadProgress) entry?.progress.delete(options.onReadProgress);
      if (entry) entry.unabortableConsumers = Math.max(0, entry.unabortableConsumers - 1);
    }) as Promise<T>;
  }

  entry.abortableConsumers.add(signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      signal.removeEventListener('abort', abortHandler);
      entry?.abortableConsumers.delete(signal);
      if (options?.onReadProgress) entry?.progress.delete(options.onReadProgress);
    };
    const abortHandler = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortError());

      const current = _sharedGetRequests.get(url);
      if (!current) return;
      scheduleBackendAbortIfUnused(url, current);
    };
    signal.addEventListener('abort', abortHandler, { once: true });
    entry.promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value as T);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

async function fetchJsonImpl<T>(url: string, options?: ReadRequestOptions): Promise<T> {
  // Include the response body: visible read streams remain foreground work
  // after their headers arrive. Direct response callers track through headers.
  return withApiActivity(() => fetchJsonBody<T>(url, options), options, url);
}

async function fetchJsonBody<T>(url: string, options?: ReadRequestOptions): Promise<T> {
  const response = await fetchApiResponse(url, options);
  if (!response.ok) {
    let detail = '';
    try {
      const payload = await response.clone().json();
      const rawDetail = payload?.error || payload?.message || payload?.detail || '';
      detail = typeof rawDetail === 'string' ? rawDetail : JSON.stringify(rawDetail);
    } catch {
      try {
        detail = await response.clone().text();
      } catch {
        detail = '';
      }
    }
    const suffix = detail ? `: ${detail}` : '';
    throw new Error(`API error ${response.status}${suffix}`);
  }
  if (response.headers?.get('content-type')?.includes(READ_STREAM_TYPE)) {
    return await decodeReadStream(response, options?.onReadProgress) as T;
  }
  if (response.headers?.get('content-type')?.includes(READ_BINARY_TYPE)) {
    return decodeReadBinary(await response.arrayBuffer());
  }
  return response.json();
}
