import { useEffect, useRef, useState } from 'react';
import { pickFile } from '../../../api/files';
import { addLibraryFiles, getLibrary, type LibraryEntry } from '../../../api/library';
import { startLibraryEntryQc, type LibraryQcRunResult } from '../../../api/libraryQc';
import { chemistryLabel } from '../../../utils/library';
import { QcReport } from './QcReport';

const SELECT = 'text-[12px] px-2 py-1 border rounded dark:bg-gray-900 dark:border-gray-600 max-w-[22rem]';
const BUTTON = 'px-3 py-1 rounded border border-gray-300 dark:border-white/15 text-[12px] text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/10 disabled:opacity-40';
const PRIMARY = 'px-3 py-1 rounded bg-blue-500 text-white text-[12px] hover:bg-blue-600 disabled:opacity-40';

/** A BAM QC can run on from the Library: on this computer and at its saved location. */
function runnable(entry: LibraryEntry): boolean {
  return entry.kind === 'bam' && entry.available && !entry.remote;
}

type Shown = { id: string; label: string; result: LibraryQcRunResult };

/**
 * "QC a dataset" with no BAM loaded: QC a BAM from the Library, or a file chosen here
 * (it joins the Library, which keeps its QC), without loading it into the view.
 */
export function QcFilePicker() {
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [chosen, setChosen] = useState('');
  const [running, setRunning] = useState<string | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // The latest request: an answer to an earlier one (another file) is dropped.
  const latest = useRef(0);

  const load = async (): Promise<LibraryEntry[]> => {
    const listed = (await getLibrary()).entries.filter(runnable);
    setEntries(listed);
    return listed;
  };

  useEffect(() => {
    let cancelled = false;
    getLibrary()
      .then(res => { if (!cancelled) setEntries(res.entries.filter(runnable)); })
      .catch(err => { if (!cancelled) { setEntries([]); setLoadError(err instanceof Error ? err.message : String(err)); } });
    return () => { cancelled = true; };
  }, []);

  const selected = chosen || entries?.[0]?.id || '';
  const labelOf = (id: string, list = entries ?? []) => list.find(e => e.id === id)?.label ?? id;

  const run = async (id: string, label: string, confirm = false) => {
    const request = ++latest.current;
    setRunning(id);
    setShown(null);
    setMessage(null);
    const result = await startLibraryEntryQc(id, confirm);
    if (request !== latest.current) return;  // superseded: another file was chosen or run
    setRunning(null);
    if (result.needs_confirmation) {
      if (window.confirm(result.error || 'This file is online-only: running QC downloads it. Run QC anyway?')) void run(id, label, true);
      return;
    }
    setShown({ id, label, result });
  };

  const chooseFile = async () => {
    setMessage(null);
    const picked = await pickFile('bam');
    const path = picked.paths?.[0] ?? picked.path;
    if (!picked.success || !path) {
      if (picked.message && !picked.cancelled) setMessage(picked.message);
      return;
    }
    const added = await addLibraryFiles([path]);
    const id = added.ids?.[0];
    if (!added.success || !id) {
      setMessage(added.errors?.join('\n') || 'That file can\'t be checked.');
      return;
    }
    const listed = await load().catch(() => entries ?? []);
    if (!listed.some(e => e.id === id)) {
      setMessage(`${path.split('/').pop()} is not a BAM on this computer that QC can read.`);
      return;
    }
    latest.current += 1;
    setChosen(id);
    void run(id, labelOf(id, listed));
  };

  const result = shown && shown.id === selected ? shown : null;
  const entry = entries?.find(e => e.id === selected);
  return (
    <div className="space-y-2" data-testid="daf-run-qc-picker">
      <div className="text-[12px] text-gray-600 dark:text-gray-300">
        No BAM is loaded: choose one from the Library or a file. QC runs on it without opening it; the Library keeps the result with the file.
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {entries && entries.length > 0 && (
          <select className={SELECT} value={selected} data-testid="daf-run-qc-library-select"
            onChange={e => { latest.current += 1; setRunning(null); setShown(null); setMessage(null); setChosen(e.target.value); }}>
            {entries.map(e => <option key={e.id} value={e.id}>{e.label}{e.cloud_only ? ' (online-only)' : ''}</option>)}
          </select>
        )}
        {entries && entries.length > 0 && (
          <button type="button" className={PRIMARY} disabled={!selected || running === selected}
            onClick={() => void run(selected, labelOf(selected))} data-testid="daf-run-qc-library-run">
            {running === selected ? 'Running QC…' : 'Run QC'}
          </button>
        )}
        <button type="button" className={BUTTON} disabled={running !== null} onClick={() => void chooseFile()} data-testid="daf-run-qc-choose-file">
          Choose a BAM file…
        </button>
      </div>
      {entries === null && <div className="text-[11.5px] text-gray-500">Reading the Library…</div>}
      {entries && entries.length === 0 && (
        <div className="text-[11.5px] text-gray-500" data-testid="daf-run-qc-library-empty">
          {loadError ? `The Library could not be read (${loadError}).` : 'No BAMs in the Library yet.'} Choose a BAM file to check.
        </div>
      )}
      {entry && running !== selected && !result && (
        <div className="text-[11.5px] text-gray-500 dark:text-gray-400">
          Chemistry: {chemistryLabel(entry) || 'from the BAM header'}{entry.cloud_only ? ' · online-only: running QC downloads the file' : ''}
        </div>
      )}
      {running && running === selected && (
        <div className="text-[11.5px] text-gray-500 dark:text-gray-400" data-testid="daf-run-qc-progress">
          fiberhmm-qc is reading a sample of the reads of {labelOf(running)}…
        </div>
      )}
      {message && <div className="text-[12px] text-red-600 whitespace-pre-line" data-testid="daf-run-qc-message">{message}</div>}
      {result && (
        <div className="space-y-1" data-testid="daf-run-dataset-qc-result">
          <div className="text-[11.5px] text-gray-500 dark:text-gray-400" data-testid="daf-run-dataset-qc-identity">
            QC of <span className="font-medium text-gray-700 dark:text-gray-200">{result.label}</span>
            {result.result.enzyme ? ` (${result.result.enzyme === 'auto' ? 'chemistry from the BAM header' : result.result.enzyme})` : ''}
          </div>
          {result.result.success === false || result.result.error
            ? <div className="text-[12px] text-red-600" data-testid="daf-run-qc-error">{result.result.error}</div>
            : <QcReport payload={result.result} />}
          {result.result.reference_note && <div className="text-[11px] text-gray-500 dark:text-gray-400">{result.result.reference_note}</div>}
        </div>
      )}
    </div>
  );
}
