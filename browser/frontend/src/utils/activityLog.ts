/**
 * Bounded ring buffer of user activity for organic-usage training distillation.
 *
 * Two sources:
 * - Every same-origin /api/... call goes here automatically (via sharedFetch).
 * - UI-only actions (panel toggles, read selection, cluster focus) call
 *   logActivity directly.
 *
 * The buffer is plain module state, not Zustand — no rerenders triggered. The
 * session-log hook reads it on dump.
 */
const MAX_ENTRIES = 2000;

export type ActivityKind = 'api' | 'ui' | 'snapshot' | 'error';

export interface ActivityEntry {
  timestamp: number;
  kind: ActivityKind;
  method?: string;
  path?: string;
  body?: unknown;
  label?: string;
  details?: Record<string, unknown>;
}

/**
 * Log a runtime error (uncaught exception, unhandled promise rejection, or
 * React error boundary). Surfaces in the session log alongside the action
 * trail so we know what the user was doing when something blew up.
 *
 * Sanitizes the message to a fixed length and only keeps the top of the
 * stack — long error blobs aren't useful for training and may leak local
 * paths from bundler-generated stack frames.
 */
export function logError(source: 'window' | 'unhandledrejection' | 'react', err: unknown, extra?: Record<string, unknown>): void {
  let message = '';
  let stack = '';
  let name = '';
  if (err instanceof Error) {
    name = err.name || 'Error';
    message = err.message || '';
    stack = err.stack || '';
  } else if (typeof err === 'string') {
    message = err;
  } else if (err && typeof err === 'object') {
    try { message = JSON.stringify(err).slice(0, 600); } catch { message = String(err); }
  } else {
    message = String(err);
  }
  // Strip absolute paths from the stack so we don't leak user/lab dirs.
  const cleanedStack = stack
    .replace(/file:\/\/[^\s)]+/g, '<file>')
    .replace(/https?:\/\/[^\s)]+/g, (m) => m.split('?')[0])
    .split('\n')
    .slice(0, 8)
    .join('\n');
  logActivity({
    timestamp: Date.now(),
    kind: 'error',
    label: `error:${source}`,
    details: {
      name: name || undefined,
      message: message.slice(0, 600),
      stack: cleanedStack || undefined,
      ...(extra || {}),
    },
  });
}

const _log: ActivityEntry[] = [];

export function logActivity(entry: ActivityEntry): void {
  _log.push(entry);
  if (_log.length > MAX_ENTRIES) {
    _log.splice(0, _log.length - MAX_ENTRIES);
  }
}

export function getActivityLog(): ActivityEntry[] {
  return _log.slice();
}

export function clearActivityLog(): void {
  _log.length = 0;
}
