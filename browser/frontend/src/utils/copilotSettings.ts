// Small localStorage helpers for Copilot UI preferences (the tutorial-mode
// and usage-sharing flags use them too).

const PREFER_FP16_KEY = 'fiberhmm_copilot_prefer_fp16';

/** A '1' flag in localStorage; false when storage is missing or blocked (reading it throws). */
export function readStoredFlag(key: string): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage?.getItem(key) === '1';
  } catch {
    return false;
  }
}

/** Set or clear a '1' flag; a no-op when storage is missing, blocked or full. */
export function writeStoredFlag(key: string, value: boolean): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    if (value) window.localStorage.setItem(key, '1');
    else window.localStorage.removeItem(key);
  } catch {
    // Preference not saved; the session keeps working.
  }
}

/** Whether the user prefers the full-precision (fp16) build over the smaller
 *  int4 (q4) build when downloading a model. Defaults to false (q4 — small/fast). */
export function readPreferFp16(): boolean {
  return readStoredFlag(PREFER_FP16_KEY);
}

export function writePreferFp16(value: boolean): void {
  writeStoredFlag(PREFER_FP16_KEY, value);
}
