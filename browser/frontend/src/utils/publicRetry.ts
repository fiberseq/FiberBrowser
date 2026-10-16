import { isPublicHostPage } from './publicServerFlag';

/**
 * A `--public` server rate-limits its visitors (429) and sheds load when it is
 * busy (503), both with a Retry-After header (backend
 * services/public_protection.py). A burst of reads while scrolling can touch
 * the limit; rather than showing an error, an idempotent request (GET/HEAD)
 * waits as the server asks and tries again, a couple of times, briefly.
 * Analyses (POST) are not repeated: their error reaches the panel as usual.
 */
export const MAX_RETRIES = 2;
export const MAX_WAIT_MS = 8_000;
export const SERVER_BUSY_EVENT = 'fiberbrowser:server-busy';

export function retryDelayMs(response: Response): number | null {
  if (response.status !== 429 && response.status !== 503) return null;
  const header = response.headers.get('Retry-After');
  const seconds = header === null ? NaN : Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const ms = Math.max(250, seconds * 1000);
  return ms <= MAX_WAIT_MS ? ms : null;
}

function isIdempotent(input: RequestInfo | URL, init?: RequestInit): boolean {
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  return method === 'GET' || method === 'HEAD';
}

function sameOriginApi(input: RequestInfo | URL): boolean {
  try {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw, window.location.href);
    return url.origin === window.location.origin && url.pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

const sleep = (ms: number, signal?: AbortSignal | null) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

export function wrapFetchWithRetry(base: typeof fetch): typeof fetch {
  return async function retryingFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    let response = await base(input, init);
    if (!isIdempotent(input, init) || !sameOriginApi(input)) return response;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      const delay = retryDelayMs(response);
      if (delay === null) return response;
      window.dispatchEvent(new CustomEvent(SERVER_BUSY_EVENT, { detail: { status: response.status, delay } }));
      await sleep(delay, init?.signal ?? (input instanceof Request ? input.signal : undefined));
      response = await base(input instanceof Request ? input.clone() : input, init);
    }
    return response;
  };
}

/** On a public server's page, retry rate-limited reads (called once at startup). */
export function installPublicRetry(): void {
  if (typeof window === 'undefined' || !isPublicHostPage()) return;
  window.fetch = wrapFetchWithRetry(window.fetch.bind(window));
}
