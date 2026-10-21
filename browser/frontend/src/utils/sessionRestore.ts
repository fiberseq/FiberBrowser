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

let inFlight = 0;

/** Session restores and imports under way (file checks, relink dialogs, the import itself): nothing else may fill
 * an empty page meanwhile (utils/adoptServerDatasets.ts). */
export function sessionRestoresInFlight(): number {
  return inFlight;
}

/** Count `work` as a session restore while it runs. */
export async function duringSessionRestore<T>(work: () => Promise<T>): Promise<T> {
  inFlight += 1;
  try {
    return await work();
  } finally {
    inFlight -= 1;
  }
}

export function requestSessionRestore(session: Record<string, unknown>): Promise<SessionRestoreOutcome> {
  if (!handler) return Promise.resolve({ restored: false, message: 'Session restore is not available yet' });
  const h = handler;
  return duringSessionRestore(() => h(session));
}

/** A saved browser session (as opposed to other JSON such as footprint rules). */
export function looksLikeSession(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return 'viewport' in v && ('datasets' in v || 'frontend' in v || 'version' in v);
}
