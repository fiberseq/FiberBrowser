/**
 * An automatic peak scan's time budget: a scan the server can't answer in time stops, so "Scanning peaks..." never
 * stays up, and the scan's own controls say so ("Scan stopped after 60 s — press Scan to retry"). A manual Scan has
 * no limit.
 */
export const AUTO_SCAN_BUDGET_MS = 60_000;

export function scanStoppedNote(budgetMs: number = AUTO_SCAN_BUDGET_MS): string {
  return `Scan stopped after ${Math.round(budgetMs / 1000)} s — press Scan to retry`;
}

/**
 * Arm the budget on a scan's controller: past `budgetMs` it calls `onStop` and aborts the scan (unless it was
 * aborted already). Returns the disarm function (call it when the scan ends).
 */
export function armScanBudget(controller: AbortController, onStop: () => void, budgetMs: number = AUTO_SCAN_BUDGET_MS): () => void {
  const timer = setTimeout(() => {
    if (controller.signal.aborted) return;
    onStop();
    controller.abort();
  }, budgetMs);
  return () => clearTimeout(timer);
}
