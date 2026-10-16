/**
 * One way to restore a session, whatever started it (Restore button, Load
 * File, drag and drop): the host checks the session's files, offers to
 * relink missing ones, then imports.
 */
export interface SessionRestoreOutcome {
  restored: boolean;
  message?: string;
}

type Handler = (session: Record<string, unknown>) => Promise<SessionRestoreOutcome>;

let handler: Handler | null = null;

export function setSessionRestoreHandler(next: Handler | null): void {
  handler = next;
}

export function requestSessionRestore(session: Record<string, unknown>): Promise<SessionRestoreOutcome> {
  if (!handler) return Promise.resolve({ restored: false, message: 'Session restore is not available yet' });
  return handler(session);
}

/** A saved browser session (as opposed to other JSON such as footprint rules). */
export function looksLikeSession(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return 'viewport' in v && ('datasets' in v || 'frontend' in v || 'version' in v);
}
