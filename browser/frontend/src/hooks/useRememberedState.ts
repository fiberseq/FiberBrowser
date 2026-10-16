import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';

/**
 * UI state that survives a panel being remounted while it stays open: moving
 * between the row and the side drawer (pinning, a narrow window, an export
 * laying the panels out flat) mounts the panel afresh, which would otherwise
 * reset its tab. Forgotten when the panel closes (forgetRememberedState), so a
 * panel opened again starts as usual (and deep links to a tab still work).
 */
const memory = new Map<string, unknown>();

export function useRememberedState<T>(
  key: string,
  init: () => T,
  /** sessionStorage key of a pending "open on this tab" request: it wins over the remembered tab. */
  requestStorageKey?: string,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    if (!memory.has(key) || hasPendingRequest(requestStorageKey)) return init();
    return memory.get(key) as T;
  });
  useEffect(() => {
    memory.set(key, value);
    // Whatever the panel shows now supersedes a request it already handled
    // while open (it would otherwise win again at the next remount).
    if (requestStorageKey && typeof window !== 'undefined') {
      try { window.sessionStorage.removeItem(requestStorageKey); } catch { /* nothing to clear */ }
    }
  }, [key, value, requestStorageKey]);
  return [value, setValue];
}

function hasPendingRequest(storageKey?: string): boolean {
  if (!storageKey || typeof window === 'undefined') return false;
  try { return window.sessionStorage.getItem(storageKey) !== null; } catch { return false; }
}

/** Forget the remembered UI state of a panel type (it was closed). */
export function forgetRememberedState(contentType: string): void {
  const prefix = `${contentType}:`;
  for (const key of [...memory.keys()]) if (key.startsWith(prefix)) memory.delete(key);
}
