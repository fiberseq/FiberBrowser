/** This page's opener token for New DAF-seq runs (see pageOpenerId). */
const OPENER_KEY = 'fiberbrowser.dafRun.opener';
let memoryOpener: string | null = null;

/**
 * This page's opener token: sent with a run it starts (RunRequest.opener) and needed to claim that
 * run's automatic opening. Per tab or window (sessionStorage: it survives a reload of the same tab,
 * never reaches another window, browser profile, origin or a restarted app).
 */
export function pageOpenerId(): string {
  try {
    const kept = window.sessionStorage.getItem(OPENER_KEY);
    if (kept && /^[A-Za-z0-9_-]{8,64}$/.test(kept)) return kept;
  } catch { /* storage unavailable: this page's memory only */ }
  if (!memoryOpener) {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    memoryOpener = `tab-${Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')}`;
  }
  try { window.sessionStorage.setItem(OPENER_KEY, memoryOpener); } catch { /* memory only */ }
  return memoryOpener;
}
