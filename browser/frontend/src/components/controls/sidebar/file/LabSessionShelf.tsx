import { useState } from 'react';
import { deleteLabSession, getLabSession, listLabSessions, saveLabSession, type LabSessionSummary } from '../../../../api/labSessions';
import { importSession } from '../../../../api/session';
import { useBrowserStore } from '../../../../stores/browserStore';
import { labInfo } from '../../../../utils/labServer';
import { Trash } from '../../../ui/Icons';

function when(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Lab servers: save the session on the lab's shared shelf, or open one a member saved. */
export function LabSessionShelf({ setError }: { setError: (message: string) => void }) {
  const sessionName = useBrowserStore(s => s.sessionName);
  const [sessions, setSessions] = useState<LabSessionSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const me = labInfo();

  const refresh = async () => {
    try {
      setSessions(await listLabSessions());
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not list the lab sessions');
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      const saved = await saveLabSession(sessionName.trim() || 'Untitled session');
      setStatus(`Saved "${saved.name}" on the lab shelf`);
      if (sessions) await refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not save the session');
    } finally {
      setBusy(false);
    }
  };

  const open = async (entry: LabSessionSummary) => {
    setBusy(true);
    try {
      const result = await importSession(await getLabSession(entry.id));
      // Parts of it this build leaves out (a plugin pack it doesn't have): said in one line.
      setStatus(`Opened "${entry.name}" (${entry.user})${typeof result.pack_note === 'string' ? `. ${result.pack_note}` : ''}`);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not open the session');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (entry: LabSessionSummary) => {
    if (!window.confirm(`Delete "${entry.name}" from the lab shelf?`)) return;
    try {
      await deleteLabSession(entry.id);
      await refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not delete the session');
    }
  };

  const row = 'w-full text-left px-2 py-1 text-[13px] text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/5 rounded disabled:opacity-50';
  return (
    <div data-testid="lab-session-shelf">
      <button type="button" onClick={() => void save()} disabled={busy} className={row}
        title="Save this session where every lab member can open it" data-testid="lab-session-save">
        Save to lab shelf
      </button>
      <button type="button" onClick={() => (sessions ? setSessions(null) : void refresh())} className={row}
        data-testid="lab-session-list">
        {sessions ? 'Hide lab sessions' : 'Open a lab session…'}
      </button>
      {status && <div className="px-2 text-[11px] text-emerald-700 dark:text-emerald-300" role="status">{status}</div>}
      {sessions && (
        <ul className="mx-2 max-h-56 overflow-y-auto rounded border border-gray-200 dark:border-white/10 text-[12px]">
          {sessions.length === 0 && <li className="px-2 py-1 text-gray-500">No saved lab sessions yet.</li>}
          {sessions.map(entry => (
            <li key={entry.id} className="flex items-center gap-1 border-b border-gray-100 px-2 py-1 last:border-0 dark:border-white/5"
              data-testid="lab-session-entry">
              <button type="button" onClick={() => void open(entry)} disabled={busy}
                className="min-w-0 flex-1 truncate text-left text-blue-700 hover:underline dark:text-blue-300"
                title={`Open (saved by ${entry.user}, ${when(entry.updated)})`}>
                {entry.name}
              </button>
              <span className="flex-shrink-0 text-[11px] text-gray-500">{entry.user} · {when(entry.updated)}</span>
              {(entry.user === me?.user || me?.role === 'admin') && (
                <button type="button" onClick={() => void remove(entry)} className="flex-shrink-0 rounded p-0.5 text-gray-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10"
                  aria-label={`Delete ${entry.name}`}><Trash size={11} /></button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
