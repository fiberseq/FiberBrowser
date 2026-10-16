import { useEffect, useRef, useState } from 'react';
import { getLibraryEntryQc, type LibraryEntry } from '../../../api/library';
import { libraryQcInFlight, startLibraryEntryQc, type LibraryQcRunResult } from '../../../api/libraryQc';
import type { QcPayload } from '../../../api/pipeline';

const BUTTON = 'px-2 py-1 rounded border border-gray-300 dark:border-white/15 text-[11.5px] text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/10 disabled:opacity-40';

/** Why QC can't run on this entry from the Library (null: it can). */
export function libraryQcBlocked(entry: LibraryEntry): string | null {
  if (entry.kind !== 'bam') return 'fiberhmm-qc checks BAM files.';
  if (entry.remote) return 'This file is on a cluster: QC from the Library runs on files on this computer (run fiberhmm-qc on the cluster, or copy the file here).';
  if (!entry.available) return 'The file is not at its saved location: Locate it first.';
  return null;
}

// Runs whose finish already refreshed the Library list (a run followed twice refreshes it once).
const refreshed = new WeakSet<Promise<LibraryQcRunResult>>();

function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

interface Props {
  entry: LibraryEntry;
  /** The QC shown in the section now (a result, from beside the file or an earlier run). */
  result: (QcPayload & { reference_note?: string | null }) | null;
  /** A finished run of the entry shown now (never of another entry), or the entry's QC
   *  read again after it changed (null: it has none now). */
  onResult: (payload: QcPayload | null) => void;
  /** The Library list changed (the QC column now has this entry's verdict). */
  onChanged: () => void;
}

/**
 * "Run QC" in the Library's QC section: fiberhmm-qc on the entry's BAM, without opening it.
 * A run continues when another entry is shown or the details close; only the entry it
 * was started for ever shows its result.
 */
export function LibraryQcRun({ entry, result, onResult, onChanged }: Props) {
  const [, setVersion] = useState(0);
  const [error, setError] = useState<{ id: string; text: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const shownId = useRef(entry.id);
  shownId.current = entry.id;
  const callbacks = useRef({ onResult, onChanged });
  callbacks.current = { onResult, onChanged };
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const running = libraryQcInFlight(entry.id);
  const blocked = libraryQcBlocked(entry);

  const start = (id: string, confirm: boolean) => {
    setError(null);
    void startLibraryEntryQc(id, confirm);
    setVersion(v => v + 1);
  };

  // Follow the run of the entry shown (one started here, or before the details were reopened).
  useEffect(() => {
    const run = libraryQcInFlight(entry.id);
    if (!run) return;
    const id = entry.id;
    let live = true;
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    run.promise.then((res: LibraryQcRunResult) => {
      if (!mounted.current) return;  // the details closed: the Library has the result when reopened
      setVersion(v => v + 1);
      // The table's QC column (also when another entry is shown by now).
      if (res.success && res.remembered && !refreshed.has(run.promise)) {
        refreshed.add(run.promise);
        callbacks.current.onChanged();
      }
      if (!live || shownId.current !== id || (res.entry_id && res.entry_id !== id)) return;
      if (res.needs_confirmation) {
        if (window.confirm(res.error || 'This file is online-only: running QC downloads it. Run QC anyway?')) start(id, true);
        return;
      }
      if (!res.success || res.error) {
        setError({ id, text: res.error || 'fiberhmm-qc did not run.' });
        return;
      }
      callbacks.current.onResult(res);
    });
    return () => { live = false; window.clearInterval(tick); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id, running?.promise]);

  // The entry's QC changed while it is shown (its file changed, or a run finished while
  // another entry was shown): read it again, so the section never keeps an outdated report.
  // A newly shown entry is read by the details themselves.
  const qcKey = `${entry.qc?.json ?? ''}|${entry.qc?.verdicts?.overall ?? ''}|${entry.changed ? 1 : 0}|${entry.cloud_only ? 1 : 0}`;
  const seen = useRef<{ id: string; key: string } | null>(null);
  useEffect(() => {
    const before = seen.current;
    seen.current = { id: entry.id, key: qcKey };
    if (!before || before.id !== entry.id || before.key === qcKey) return;
    const id = entry.id;
    if (!entry.qc?.json) {
      callbacks.current.onResult(null);
      return;
    }
    let live = true;
    Promise.resolve(getLibraryEntryQc(id))
      .then(res => { if (live && shownId.current === id && res) callbacks.current.onResult(res); })
      .catch(() => {});
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id, qcKey]);

  const shownError = error && error.id === entry.id ? error.text : null;
  const note = result?.available ? result.reference_note : null;
  return (
    <div className="space-y-1" data-testid="library-qc-run-section">
      {!result?.available && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={BUTTON} disabled={!!running || !!blocked} title={blocked ?? undefined}
            onClick={() => start(entry.id, false)} data-testid="library-qc-run">
            {running ? 'Running QC…' : 'Run QC'}
          </button>
          {running && (
            <span className="text-[11px] text-gray-500 dark:text-gray-400" data-testid="library-qc-progress">
              fiberhmm-qc is reading a sample of the reads… {elapsed(now - running.started)}
            </span>
          )}
          {!running && blocked && entry.kind === 'bam' && (
            <span className="text-[11px] text-gray-500 dark:text-gray-400" data-testid="library-qc-blocked">{blocked}</span>
          )}
          {!running && !blocked && entry.cloud_only && (
            <span className="text-[11px] text-gray-500 dark:text-gray-400">Online-only: running QC downloads the file.</span>
          )}
        </div>
      )}
      {shownError && <div className="text-[11.5px] text-red-600 dark:text-red-300 whitespace-pre-line" data-testid="library-qc-error">{shownError}</div>}
      {note && <div className="text-[11px] text-gray-500 dark:text-gray-400" data-testid="library-qc-note">{note}</div>}
    </div>
  );
}
