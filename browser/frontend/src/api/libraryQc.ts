import { fetchJson } from './sharedFetch';
import type { QcPayload } from './pipeline';

/** fiberhmm-qc run on a Library entry's BAM (POST /api/library/entries/{id}/qc/run). */
export interface LibraryQcRunResult extends QcPayload {
  entry_id?: string;
  /** An online-only file: running downloads it, so the server asks first (`error` says so). */
  needs_confirmation?: boolean;
  online_only?: boolean;
  cache_key?: string;
  /** Kept with the entry (false when it was removed or moved while QC ran). */
  remembered?: boolean;
  enzyme?: string;
  reference?: string | null;
  /** Set when no reference FASTA was found: what running without one leaves out. */
  reference_note?: string | null;
}

export function runLibraryEntryQc(id: string, confirm = false): Promise<LibraryQcRunResult> {
  return fetchJson(`/api/library/entries/${encodeURIComponent(id)}/qc/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(confirm ? { confirm: true } : {}),
  });
}

// Runs in flight, by entry: they continue when the details are closed or another entry is
// shown, and the details pick them up again (still running, or the result) when reopened.
const inflight = new Map<string, { promise: Promise<LibraryQcRunResult>; started: number }>();

export function libraryQcInFlight(id: string): { promise: Promise<LibraryQcRunResult>; started: number } | undefined {
  return inflight.get(id);
}

/** Start (or join) the QC run of an entry. */
export function startLibraryEntryQc(id: string, confirm = false): Promise<LibraryQcRunResult> {
  const running = inflight.get(id);
  if (running) return running.promise;
  const promise = runLibraryEntryQc(id, confirm).catch((err): LibraryQcRunResult => ({
    available: false, success: false, entry_id: id, error: err instanceof Error ? err.message : String(err),
    qc: null, curves: null, plots: {},
  }));
  const record = { promise, started: Date.now() };
  inflight.set(id, record);
  void promise.finally(() => { if (inflight.get(id) === record) inflight.delete(id); });
  return promise;
}

/** Tests: forget runs in flight. */
export function resetLibraryQcRuns(): void {
  inflight.clear();
}
