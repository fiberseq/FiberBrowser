import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { listServerDirectory, type ServerDirectoryListing } from '../../../api/files';
import { setServerFileBrowserListener, type ServerFileRequest } from '../../../utils/serverFileBrowser';
import { matchesFilter } from '../../../utils/supportedFiles';
import { ArrowUp, Folder } from '../../ui/Icons';

const LAST_DIR_KEY = 'fiberbrowser_server_file_browser_dir';

function formatSize(size: number | null): string {
  if (size == null) return '';
  if (size >= 1e9) return `${(size / 1e9).toFixed(1)} GB`;
  if (size >= 1e6) return `${(size / 1e6).toFixed(1)} MB`;
  if (size >= 1e3) return `${(size / 1e3).toFixed(0)} kB`;
  return `${size} B`;
}

function readLastDir(): string | undefined {
  try { return window.localStorage.getItem(LAST_DIR_KEY) ?? undefined; } catch { return undefined; }
}

/** Mounted once; shows the in-page server file browser when a picker asks for it. */
export function ServerFileBrowserHost() {
  const [request, setRequest] = useState<ServerFileRequest | null>(null);
  useEffect(() => {
    setServerFileBrowserListener(setRequest);
    return () => setServerFileBrowserListener(null);
  }, []);
  if (!request) return null;
  return <ServerFileBrowser key={request.id} request={request} />;
}

function ServerFileBrowser({ request }: { request: ServerFileRequest }) {
  const [listing, setListing] = useState<ServerDirectoryListing | null>(null);
  const [pathInput, setPathInput] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [navigating, setNavigating] = useState(false);
  // Only the latest folder request may update the listing.
  const navToken = useRef(0);
  const dialogRef = useRef<HTMLDivElement>(null);

  const [roots, setRoots] = useState<ServerDirectoryListing['roots']>(undefined);
  // File types shown (folders always are): the first filter, "Supported files", by default.
  const filters = request.folder ? [] : (request.filters ?? []);
  const [filterIndex, setFilterIndex] = useState(0);
  const activeSuffixes = filters[filterIndex]?.suffixes ?? [];
  const entries = (listing?.entries ?? []).filter(entry => entry.is_dir || matchesFilter(entry.name, activeSuffixes)
    || selected.includes(entry.path));

  const open = async (path?: string): Promise<boolean> => {
    const token = ++navToken.current;
    setError(null);
    setNavigating(true);
    try {
      const result = await listServerDirectory(path);
      if (token !== navToken.current) return false;
      if (result.roots) setRoots(result.roots);
      if (!result.success) {
        setError(result.message ?? 'Cannot open that folder');
        return false;
      }
      setListing(result);
      setPathInput(result.path);
      setSelected(result.selected && !request.folder ? [result.selected] : []);
      try { window.localStorage.setItem(LAST_DIR_KEY, result.path); } catch { /* optional */ }
      return true;
    } catch (err) {
      if (token === navToken.current) setError(err instanceof Error ? err.message : 'Cannot list files');
    } finally {
      if (token === navToken.current) setNavigating(false);
    }
    return false;
  };

  // The last folder, else the default (home; a lab server's first data folder).
  useEffect(() => {
    const last = readLastDir();
    void open(last).then(ok => { if (!ok && last) void open(undefined); });
  }, []);
  useEffect(() => {
    // The dialog is modal: keep keys (Escape especially) from reaching the
    // browser's shortcuts, which would clear selections behind it.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        request.resolve(null);
      }
      if (event.key === 'Escape' || !(event.target instanceof Node && dialogRef.current?.contains(event.target))) {
        event.stopPropagation();
      }
    };
    // Keys inside the dialog work normally but stop at its edge, so arrows
    // or Cmd+Z after clicking a row don't pan or undo the browser behind it.
    const dialog = dialogRef.current;
    const contain = (event: KeyboardEvent) => event.stopPropagation();
    window.addEventListener('keydown', onKey, true);
    dialog?.addEventListener('keydown', contain);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      dialog?.removeEventListener('keydown', contain);
    };
  }, [request]);

  const toggle = (path: string) => setSelected(current => (
    request.multiple
      ? (current.includes(path) ? current.filter(p => p !== path) : [...current, path])
      : [path]
  ));
  const confirm = async () => {
    if (navigating) return;
    if (request.folder) {
      // A folder typed but not yet opened is what the user means to choose.
      const typed = pathInput.trim();
      if (typed && typed !== listing?.path) {
        const result = await listServerDirectory(typed).catch(() => null);
        if (!result?.success) {
          setError(result?.message ?? 'Cannot open that folder');
          return;
        }
        request.resolve([result.path]);
        return;
      }
      request.resolve(listing ? [listing.path] : null);
    }
    else request.resolve(selected.length ? selected : null);
  };

  return createPortal(
    <div className="fixed inset-0 z-[110] flex items-center justify-center" onClick={() => request.resolve(null)}>
      <div className="absolute inset-0 bg-black/40" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={request.title}
        data-testid="server-file-browser"
        className="relative mx-4 flex max-h-[80vh] w-full max-w-2xl flex-col rounded-lg bg-white shadow-xl dark:bg-gray-800"
        onClick={event => event.stopPropagation()}
      >
        <div className="border-b border-gray-200 px-4 py-3 dark:border-white/10">
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">{request.title}</h2>
          <form
            className="mt-2 flex gap-1"
            onSubmit={event => { event.preventDefault(); void open(pathInput); }}
          >
            <button type="button" disabled={!listing?.parent} onClick={() => void open(listing?.parent ?? undefined)}
              className="inline-flex items-center rounded-fb border border-line px-2 text-[12px] hover:bg-gray-50 disabled:opacity-40 dark:border-gray-600 dark:hover:bg-white/10" title="Up one folder" aria-label="Up one folder"><ArrowUp size={13} /></button>
            <button type="button" onClick={() => void open(listing?.home)}
              className="rounded border border-gray-300 px-2 text-[12px] dark:border-gray-600" title="Home folder">~</button>
            <input
              value={pathInput}
              onChange={event => setPathInput(event.target.value)}
              aria-label="Folder path"
              className="min-w-0 flex-1 rounded border border-gray-300 px-2 py-0.5 font-mono text-[12px] dark:border-gray-600 dark:bg-gray-900"
            />
            <button type="submit" className="rounded border border-gray-300 px-2 text-[12px] dark:border-gray-600">Go</button>
          </form>
          {roots && roots.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1" data-testid="server-file-roots">
              {roots.map(root => (
                <button key={root.path} type="button" onClick={() => void open(root.path)} title={root.path}
                  className="rounded bg-gray-100 px-2 py-0.5 text-[11px] text-gray-700 hover:bg-gray-200 dark:bg-white/10 dark:text-gray-200">
                  {root.label}{root.writable ? '' : ' (read-only)'}
                </button>
              ))}
            </div>
          )}
          {error && <div className="mt-1 text-[11px] text-red-600 dark:text-red-400">{error}</div>}
        </div>
        <div className="flex-1 overflow-y-auto py-1 text-[13px]" aria-busy={navigating}>
          {entries.map(entry => (
            <button
              key={entry.path}
              type="button"
              data-testid="server-file-entry"
              onClick={() => (entry.is_dir ? void open(entry.path) : !request.folder && toggle(entry.path))}
              onDoubleClick={() => { if (!entry.is_dir && !request.folder) request.resolve([entry.path]); }}
              className={`flex w-full items-center gap-2 px-4 py-1 text-left hover:bg-blue-50 dark:hover:bg-blue-950/40 ${selected.includes(entry.path) ? 'bg-blue-100 dark:bg-blue-900/40' : ''} ${!entry.is_dir && request.folder ? 'opacity-40' : ''}`}
            >
              <span className="flex w-4 text-brand-500/80 dark:text-brand-300/80" aria-hidden="true">{entry.is_dir ? <Folder size={14} /> : null}</span>
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              <span className="text-[11px] text-gray-400">{formatSize(entry.size)}</span>
            </button>
          ))}
          {listing?.entries?.length === 0 && <div className="px-4 py-2 text-[12px] text-gray-500">Empty folder</div>}
          {!!listing?.entries?.length && entries.length === 0 && (
            <div className="px-4 py-2 text-[12px] text-gray-500">No {filters[filterIndex]?.label.toLowerCase() ?? 'files'} here. Choose All files below to see every file.</div>
          )}
          {listing?.truncated && <div className="px-4 py-2 text-[11px] text-gray-500">Showing the first 2,000 items. Type a file's full path above to pick one not shown.</div>}
        </div>
        <div className="flex items-center gap-2 border-t border-gray-200 px-4 py-3 dark:border-white/10">
          {filters.length > 0 && (
            <select
              aria-label="File types"
              data-testid="server-file-filter"
              value={filterIndex}
              onChange={event => setFilterIndex(Number(event.target.value))}
              className="max-w-[45%] rounded border border-gray-300 px-1 py-0.5 text-[12px] dark:border-gray-600 dark:bg-gray-900"
            >
              {filters.map((filter, index) => <option key={filter.label} value={index}>{filter.label}</option>)}
            </select>
          )}
          <span className="truncate text-[12px] text-gray-500">
            {request.folder ? listing?.path : selected.length ? `${selected.length} selected` : request.multiple ? 'Click files to select them' : 'Click a file'}
          </span>
          <button type="button" onClick={() => request.resolve(null)}
            className="ml-auto rounded px-3 py-1 text-[13px] text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/10">Cancel</button>
          <button type="button" onClick={() => void confirm()} disabled={navigating || (!request.folder && selected.length === 0)}
            data-testid="server-file-browser-open"
            className="rounded bg-blue-600 px-3 py-1 text-[13px] font-medium text-white hover:bg-blue-700 disabled:opacity-50">
            {request.folder ? 'Use this folder' : 'Open'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
