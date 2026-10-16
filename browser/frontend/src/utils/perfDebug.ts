const PERF_DEBUG_STORAGE_KEY = 'fiberbrowser_perf_debug';
const PERF_DEBUG_QUERY_KEYS = new Set(['1', 'true', 'yes', 'on']);

export function isPerfDebugEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const params = new URLSearchParams(window.location.search);
    const queryValue = params.get('perf') ?? params.get('perf_debug');
    if (queryValue && PERF_DEBUG_QUERY_KEYS.has(queryValue.toLowerCase())) return true;
    return window.localStorage.getItem(PERF_DEBUG_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setPerfDebugEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    if (enabled) window.localStorage.setItem(PERF_DEBUG_STORAGE_KEY, '1');
    else window.localStorage.removeItem(PERF_DEBUG_STORAGE_KEY);
  } catch {}
}

export function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export function logPerfTiming(
  label: string,
  elapsedMs: number,
  details: Record<string, unknown> = {},
  slowThresholdMs = 50,
): void {
  // Timings are for debugging only (?perf=1, or localStorage
  // fiberbrowser_perf_debug=1): a normal session's console stays quiet.
  if (!isPerfDebugEnabled()) return;
  const roundedMs = Math.round(elapsedMs * 10) / 10;
  const slow = elapsedMs >= slowThresholdMs;
  const payload = { ms: roundedMs, ...details };
  const logger = slow ? console.warn : console.info;
  logger(`[perf] ${label}`, payload);
}
