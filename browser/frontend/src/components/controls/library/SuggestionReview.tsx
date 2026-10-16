/**
 * A suggested experiment's folder, scanned before it is opened or saved as a
 * group: the watched-folder scanner looks at the folder (and a run's output
 * sub-folders) once, without watching it; the user reviews what it found,
 * unticks what they don't want, and the kept files are added to the Library
 * so the group or Open covers the whole folder.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  addLibraryFolderFiles, addWatchedFolder, createLibraryGroup, previewLibraryFolder,
  type FolderScanMode, type FolderScanPreview,
} from '../../../api/library';
import { KIND_LABELS, formatBytes, type SuggestedGroup } from '../../../utils/library';
import {
  kindCounts, leftOutText, openNeedsConfirmation, plainError, scanScopeText,
} from '../../../utils/libraryFolderScan';

const BUTTON = 'px-2 py-1 rounded border border-gray-300 dark:border-white/15 text-[11.5px] text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/10 disabled:opacity-40';
const PRIMARY = 'px-2 py-1 rounded border border-blue-600 bg-blue-600 text-white text-[11.5px] hover:bg-blue-700 disabled:opacity-40';
const LINK = 'text-blue-600 hover:underline disabled:opacity-40';

export type SuggestionAction = 'open' | 'group';

interface Props {
  suggestion: SuggestedGroup & { folder: string };
  action: SuggestionAction;
  onCancel: () => void;
  /** The files kept were added: every one's entry id (the suggestion now covers them). */
  onScanned: (folder: string, ids: string[]) => void;
  /** Saved (or watched): a status line for the Library. */
  onFinished: (message: string) => void;
  /** Open these entries (the Library is refreshed first, so new entries are known). */
  onOpen: (ids: string[], note: string) => Promise<void>;
  /** "Watch this folder" was used (the Library lists watched folders). */
  onWatched?: () => void;
}

export function SuggestionReview({ suggestion, action, onCancel, onScanned, onFinished, onOpen, onWatched }: Props) {
  const folder = suggestion.folder;
  const [mode, setMode] = useState<FolderScanMode>('folder');
  const [preview, setPreview] = useState<FolderScanPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(true);
  const [working, setWorking] = useState(false);
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [name, setName] = useState(suggestion.name);
  const [watchNote, setWatchNote] = useState<string | null>(null);
  const request = useRef(0);
  // False once the review is cancelled or replaced: a late answer then changes nothing.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const scan = useCallback(async (scanMode: FolderScanMode) => {
    const token = ++request.current;
    setScanning(true);
    setError(null);
    setConfirmOpen(false);
    try {
      const res = await previewLibraryFolder(folder, scanMode);
      if (token !== request.current) return;  // a later scan (or Cancel) replaced this one
      if (!res.success) {
        setPreview(null);
        setError(res.error || 'Could not scan the folder.');
      } else {
        setPreview(res);
        setUnticked(new Set());
      }
    } catch (err) {
      if (token === request.current) {
        setPreview(null);
        setError(plainError(err));
      }
    } finally {
      if (token === request.current) setScanning(false);
    }
  }, [folder]);

  useEffect(() => {
    void scan(mode);
    return () => { request.current += 1; };
  }, [scan, mode]);

  const files = preview?.files ?? [];
  const kept = files.filter(f => !unticked.has(f.path));
  const toggle = (path: string) => setUnticked(prev => {
    const next = new Set(prev);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  });

  const run = async () => {
    if (!preview || !kept.length) return;
    if (action === 'open' && !confirmOpen && openNeedsConfirmation(kept)) {
      setConfirmOpen(true);
      return;
    }
    setWorking(true);
    setError(null);
    try {
      const res = await addLibraryFolderFiles(folder, kept.map(f => f.path), mode);
      if (!alive.current) return;
      const ids = res.ids ?? [];
      const errors = res.errors ?? [];
      const notFound = res.not_found ?? [];
      if (!ids.length) {
        setError(res.error || [...errors, ...(notFound.length ? [`${notFound.length} file(s) are no longer in the folder.`] : [])]
          .join('\n') || 'Nothing could be added.');
        return;
      }
      onScanned(folder, ids);
      const notes = [
        res.added ? `${res.added} new to the Library` : '',
        notFound.length ? `${notFound.length} no longer in the folder` : '',
        res.aligned ? `${res.aligned} aligned-only BAM(s) left out` : '',
        res.truncated ? res.truncated : '',
      ].filter(Boolean);
      const extra = [notes.length ? ` (${notes.join('; ')})` : '', errors.length ? `\n${errors.join('\n')}` : ''].join('');
      if (action === 'group') {
        const group = await createLibraryGroup(name.trim() || suggestion.name, ids, folder);
        if (!alive.current) return;
        if (!group.success) {
          setError(group.error || 'Could not save the group.');
          return;
        }
        onFinished(`Saved group ${group.group?.name ?? name} with ${ids.length} file${ids.length === 1 ? '' : 's'}${extra}.`);
      } else {
        await onOpen(ids, extra);
      }
    } catch (err) {
      if (alive.current) setError(plainError(err));
    } finally {
      if (alive.current) setWorking(false);
    }
  };

  const watch = async () => {
    try {
      await addWatchedFolder(folder);
      if (!alive.current) return;
      setWatchNote('Watching this folder: new files will be listed automatically.');
      onWatched?.();
    } catch (err) {
      if (alive.current) setWatchNote(plainError(err));
    }
  };

  const bams = kept.filter(f => f.kind === 'bam').length;
  const verb = action === 'group' ? 'Save as group' : 'Open';
  return (
    <div className="space-y-1.5 rounded border border-blue-200 dark:border-blue-500/30 bg-blue-50/60 dark:bg-blue-900/20 p-2 text-[11.5px]"
      data-testid="library-suggestion-review">
      <div className="flex items-center gap-2">
        <div className="font-medium truncate" title={folder}>{verb}: {suggestion.name}</div>
        <button type="button" className="ml-auto text-gray-400 hover:text-gray-600 text-[14px] leading-none" aria-label="Cancel" onClick={onCancel}>×</button>
      </div>
      <div className="text-gray-600 dark:text-gray-300" data-testid="library-suggestion-scope">
        {preview ? scanScopeText(preview) : scanScopeText({ mode, subdirs: ['tracks', 'calls'], max_depth: 6 })}{' '}
        <button type="button" className={LINK} disabled={scanning || working} data-testid="library-suggestion-mode"
          onClick={() => setMode(mode === 'folder' ? 'deep' : 'folder')}>
          {mode === 'folder' ? 'Include all sub-folders' : 'Only this folder'}
        </button>
      </div>
      {scanning && <div className="text-gray-500" data-testid="library-suggestion-scanning">Scanning {folder}… (file names and sizes only; nothing is downloaded or written)</div>}
      {error && <div className="text-red-600 whitespace-pre-line" role="alert" data-testid="library-suggestion-error">{error}</div>}
      {preview && !scanning && (
        <>
          <div data-testid="library-suggestion-summary">
            {files.length === 0
              ? 'No BAMs, BigBeds or plasmid maps found here.'
              : <>Found {files.length} file{files.length === 1 ? '' : 's'}: {kindCounts(files)}
                {' — '}{preview.new ? `${preview.new} new to the Library` : 'all already in the Library'}
                {preview.cloud_only ? <span className="text-amber-700 dark:text-amber-400">, {preview.cloud_only} online-only</span> : null}.</>}
          </div>
          {preview.truncated && <div className="text-amber-700 dark:text-amber-400">Scan {preview.truncated}: some files may be missing.</div>}
          {files.length > 0 && (
            <>
              <div className="flex gap-2 text-gray-500">
                <span>{kept.length} of {files.length} ticked</span>
                <button type="button" className={LINK} onClick={() => setUnticked(new Set())}>All</button>
                <button type="button" className={LINK} onClick={() => setUnticked(new Set(files.map(f => f.path)))}>None</button>
              </div>
              <ul className="max-h-48 overflow-y-auto rounded border border-gray-200 dark:border-white/10 bg-white dark:bg-dark-bg divide-y divide-gray-100 dark:divide-white/5"
                data-testid="library-suggestion-files">
                {files.map(file => (
                  <li key={file.path} className="flex items-center gap-1.5 px-1.5 py-0.5" data-testid="library-suggestion-file">
                    <input type="checkbox" checked={!unticked.has(file.path)} onChange={() => toggle(file.path)}
                      aria-label={`Include ${file.name}`} />
                    <span className="truncate min-w-0 flex-1" title={file.path}>{file.name}</span>
                    <span className="text-gray-400 shrink-0">{KIND_LABELS[file.kind]}</span>
                    {file.size > 0 && <span className="text-gray-400 shrink-0 w-14 text-right">{formatBytes(file.size)}</span>}
                    {file.cloud_only && (
                      <span className="shrink-0 rounded bg-amber-100 dark:bg-amber-500/20 text-amber-800 dark:text-amber-300 px-1"
                        title="Online-only: listed without downloading it. Make it available offline to open it.">online-only</span>
                    )}
                    <span className={`shrink-0 rounded px-1 ${file.entry_id ? 'text-gray-400' : 'bg-green-100 dark:bg-green-500/20 text-green-800 dark:text-green-300'}`}>
                      {file.entry_id ? 'listed' : 'new'}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {leftOutText(preview) && <div className="text-gray-500" data-testid="library-suggestion-left-out"
            title={preview.big_dir_examples?.length ? `Not scanned (over 20,000 entries):\n${preview.big_dir_examples.join('\n')}` : undefined}>
            {leftOutText(preview)}</div>}
          {confirmOpen ? (
            <div className="flex flex-wrap items-center gap-1.5 rounded border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-900/20 p-1.5" data-testid="library-suggestion-confirm">
              <span>Open all {kept.length} files{bams ? ` (${bams} BAM${bams === 1 ? '' : 's'})` : ''} at once? Many BAMs take a while to load and fill the view.</span>
              <button type="button" className={PRIMARY} disabled={working} onClick={() => void run()} data-testid="library-suggestion-confirm-open">Open all {kept.length}</button>
              <button type="button" className={BUTTON} disabled={working} onClick={() => setConfirmOpen(false)}>Back</button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5">
              {action === 'group' && (
                <input className="text-[11.5px] px-1.5 py-0.5 border rounded dark:bg-gray-900 dark:border-gray-600 min-w-[160px]"
                  aria-label="Group name" value={name} onChange={e => setName(e.target.value)} data-testid="library-suggestion-name" />
              )}
              <button type="button" className={PRIMARY} disabled={working || !kept.length || (action === 'group' && !name.trim())}
                onClick={() => void run()} data-testid="library-suggestion-run">
                {working ? 'Adding…' : action === 'group' ? `Save group of ${kept.length}` : `Open ${kept.length}`}
              </button>
              <button type="button" className={BUTTON} disabled={working} onClick={onCancel}>Cancel</button>
              {!preview.watched && !watchNote && (
                <button type="button" className={`${LINK} ml-auto`} onClick={() => void watch()} data-testid="library-suggestion-watch"
                  title="Keep this folder's files listed: new files are added as they appear">Watch this folder</button>
              )}
              {watchNote && <span className="ml-auto text-gray-500" data-testid="library-suggestion-watch-note">{watchNote}</span>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
