import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { checkSessionFiles, type SessionFileCheck, type SessionFileEntry } from '../../../../api/session';
import { pickAnyFile, pickFolder } from '../../../../api/files';
import { messageFromError } from '../../../../utils/fileLoadErrors';

const KIND_LABELS: Record<string, string> = {
  dataset: 'Dataset',
  overlay: 'Overlay',
  track: 'Track',
  reference: 'Reference',
  annotation: 'Annotation',
  contact_map: 'Contact map',
};

interface SessionRelinkDialogProps {
  session: Record<string, unknown>;
  initialCheck: SessionFileCheck;
  onCancel: () => void;
  onRestore: (mapping: Record<string, string>) => void;
}

/**
 * Shown before a session restore when some of its files are not at their
 * saved paths (typically a session opened on another computer). Locating one
 * file relinks the others that moved the same way; a folder search finds the
 * rest by name. Nothing is cleared until the user presses Restore.
 */
export function SessionRelinkDialog({ session, initialCheck, onCancel, onRestore }: SessionRelinkDialogProps) {
  const [check, setCheck] = useState(initialCheck);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typedPaths, setTypedPaths] = useState<Record<string, string>>({});

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [onCancel]);

  const recheck = async (options: { anchor?: { old: string; new: string }; searchRoot?: string }) => {
    setBusy(true);
    setError(null);
    try {
      setCheck(await checkSessionFiles(session, { mapping: check.mapping, ...options }));
    } catch (err) {
      setError(messageFromError(err, 'Could not check files'));
    } finally {
      setBusy(false);
    }
  };

  const locateFile = async (file: SessionFileEntry) => {
    const picked = await pickAnyFile().catch(() => null);
    const path = picked?.paths?.[0] ?? picked?.path;
    if (path) await recheck({ anchor: { old: file.path, new: path } });
  };

  const searchFolder = async () => {
    const picked = await pickFolder('Folder containing the session files').catch(() => null);
    if (picked?.path) await recheck({ searchRoot: picked.path });
  };

  const submitTypedPath = async (file: SessionFileEntry) => {
    const path = typedPaths[file.path]?.trim();
    if (path) await recheck({ anchor: { old: file.path, new: path } });
  };

  const relinkedCount = check.files.filter(file => file.relinked && file.status !== 'missing').length;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center" onClick={onCancel}>
      <div className="absolute inset-0 bg-black/40" />
      <div
        role="dialog"
        aria-label="Locate session files"
        data-testid="session-relink-dialog"
        className="relative mx-4 flex max-h-[85vh] w-full max-w-3xl flex-col rounded-lg bg-white shadow-xl dark:bg-gray-800"
        onClick={event => event.stopPropagation()}
      >
        <div className="border-b border-gray-200 px-4 py-3 dark:border-white/10">
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Locate session files</h2>
          <p className="mt-1 text-[12px] text-gray-500 dark:text-gray-400">
            {check.missing > 0
              ? `${check.missing} file${check.missing === 1 ? ' is' : 's are'} not at the saved location. Locate one and the others that moved with it are found automatically, or search a folder.`
              : 'All files found.'}
            {check.changed > 0 && ` ${check.changed} file${check.changed === 1 ? ' differs' : 's differ'} from when the session was saved.`}
          </p>
          <button
            type="button"
            onClick={searchFolder}
            disabled={busy}
            className="mt-2 rounded border border-blue-200 bg-blue-50 px-2 py-1 text-[12px] font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50 dark:border-blue-500/30 dark:bg-blue-950/30 dark:text-blue-300"
          >
            Search a folder…
          </button>
        </div>

        <div className="flex-1 divide-y divide-gray-100 overflow-y-auto dark:divide-white/5">
          {check.files.map(file => (
            <div key={file.path} className="px-4 py-2" data-testid="session-relink-row">
              <div className="flex items-center gap-2">
                <StatusBadge status={file.status} />
                <span className="text-[11px] text-gray-400">{KIND_LABELS[file.kind] ?? file.kind}</span>
                <span className="truncate text-[13px] font-medium text-gray-700 dark:text-gray-200" title={file.label}>{file.label}</span>
                {file.status !== 'ok' && (
                  <button
                    type="button"
                    onClick={() => locateFile(file)}
                    disabled={busy}
                    className="ml-auto flex-shrink-0 rounded border border-gray-200 px-2 py-0.5 text-[12px] text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-white/15 dark:text-gray-300 dark:hover:bg-white/5"
                  >
                    Locate…
                  </button>
                )}
              </div>
              <div className="mt-0.5 truncate font-mono text-[11px] text-gray-400" title={file.path}>
                {file.relinked ? <span className="line-through">{file.path}</span> : file.path}
              </div>
              {file.relinked && (
                <div className="truncate font-mono text-[11px] text-teal-700 dark:text-teal-300" title={file.resolved_path}>
                  → {file.resolved_path}
                </div>
              )}
              {file.status === 'missing' && (
                <input
                  type="text"
                  value={typedPaths[file.path] ?? ''}
                  onChange={event => setTypedPaths(paths => ({ ...paths, [file.path]: event.target.value }))}
                  onKeyDown={event => { if (event.key === 'Enter') submitTypedPath(file); }}
                  placeholder="…or paste the file's path here and press Enter"
                  className="mt-1 w-full rounded border border-gray-200 bg-white px-2 py-0.5 font-mono text-[11px] text-gray-700 dark:border-white/15 dark:bg-gray-900 dark:text-gray-200"
                />
              )}
            </div>
          ))}
        </div>

        <div className="flex items-center gap-2 border-t border-gray-200 px-4 py-3 dark:border-white/10">
          <span className="text-[12px] text-gray-500 dark:text-gray-400">
            {busy ? 'Checking…' : error ?? (relinkedCount > 0 ? `${relinkedCount} relinked. Save the session afterwards to keep the new locations.` : '')}
          </span>
          <button
            type="button"
            onClick={onCancel}
            className="ml-auto rounded px-3 py-1 text-[13px] text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/10"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onRestore(check.mapping)}
            disabled={busy}
            data-testid="session-relink-restore"
            className="rounded bg-blue-600 px-3 py-1 text-[13px] font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {check.missing > 0 ? `Restore without ${check.missing} file${check.missing === 1 ? '' : 's'}` : 'Restore'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function StatusBadge({ status }: { status: SessionFileEntry['status'] }) {
  const styles = {
    ok: 'bg-teal-50 text-teal-700 dark:bg-teal-950/40 dark:text-teal-300',
    missing: 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300',
    changed: 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
  }[status];
  const label = { ok: 'Found', missing: 'Missing', changed: 'Changed' }[status];
  return <span className={`flex-shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold ${styles}`}>{label}</span>;
}
