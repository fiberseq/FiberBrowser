import { useEffect } from 'react';
import { useBrowserStore } from '../../../stores/browserStore';
import { isSandboxPage } from '../../../utils/sandbox';
import { SidebarSubSection } from '../SidebarSubSection';
import { LibraryPanel } from './LibraryPanel';
import { OPEN_LIBRARY_EVENT, openLibrary, useLibraryStore } from './libraryStore';
import { EntryBadges } from './LibraryTable';
import { LIBRARY_SCOPE_TEXT, rerunExplanation, rerunSummary } from '../../../utils/library';

/** The Library is a local feature: never on a --public server or in a tour tab. */
export function useLibraryAvailable(): boolean {
  const publicMode = useBrowserStore(s => s.publicMode);
  return !publicMode && !isSandboxPage();
}

/**
 * Mounted once: the Library window (opened from the sidebar or by the
 * ``fiberbrowser:open-library`` event) and its refresh while it is open.
 */
export function LibraryHost() {
  const available = useLibraryAvailable();
  const open = useLibraryStore(s => s.open);
  const setOpen = useLibraryStore(s => s.setOpen);
  const refresh = useLibraryStore(s => s.refresh);
  const scanning = useLibraryStore(s => Boolean(s.payload?.scan.running || s.payload?.scan.queued.length));

  useEffect(() => {
    if (!available) return;
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<{ selectedId?: string }>).detail ?? {};
      setOpen(true, detail.selectedId ?? undefined);
      void refresh();
    };
    window.addEventListener(OPEN_LIBRARY_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_LIBRARY_EVENT, onOpen);
  }, [available, refresh, setOpen]);

  useEffect(() => {
    if (!available || !open) return;
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, scanning ? 1500 : 10000);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    window.addEventListener('keydown', onKey, true);
    return () => { window.clearInterval(timer); window.removeEventListener('keydown', onKey, true); };
  }, [available, open, scanning, refresh, setOpen]);

  if (!available || !open) return null;
  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-brand-950/45 backdrop-blur-[2px]" onClick={() => setOpen(false)} />
      <div
        role="dialog"
        aria-label="Library"
        className="relative flex flex-col w-full max-w-[1400px] h-[88vh] rounded-apple-lg bg-white dark:bg-dark-surface shadow-modal dark:shadow-modal-dark border border-line/70 dark:border-white/10 overflow-hidden"
        data-testid="library-dialog"
      >
        <LibraryPanel onClose={() => setOpen(false)} />
      </div>
    </div>
  );
}

/** Sidebar > Data & Sessions > Library: a summary, the latest files, and the full Library. */
export function LibrarySidebarSection() {
  const available = useLibraryAvailable();
  const payload = useLibraryStore(s => s.payload);
  const refresh = useLibraryStore(s => s.refresh);
  const datasetCount = useBrowserStore(s => s.datasets.length);

  // Opened files are recorded in the background: look again shortly after a load.
  useEffect(() => {
    if (!available) return;
    void refresh();
    const timer = window.setTimeout(() => { void refresh(); }, 2000);
    return () => window.clearTimeout(timer);
  }, [available, refresh, datasetCount]);

  if (!available) return null;
  const entries = payload?.entries ?? [];
  const recent = entries.filter(e => e.role !== 'aligned').slice(0, 4);
  const rerun = entries.filter(e => e.rerun).length;
  const missing = entries.filter(e => !e.available).length;
  return (
    <SidebarSubSection
      id="file.library"
      label="Library"
      helpText={`Your datasets: ${LIBRARY_SCOPE_TEXT}. Search, tag, group and reopen them with their genome or plasmid map.`}
      defaultOpen
      persist
    >
      <div className="space-y-1.5" data-testid="library-sidebar">
        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            onClick={() => openLibrary()}
            className="px-2 py-1 rounded bg-blue-500 text-white text-[11.5px] hover:bg-blue-600"
            data-testid="library-open-panel"
          >
            Open Library
          </button>
          <span className="text-[11px] text-gray-500 dark:text-gray-400">
            {entries.length} file{entries.length === 1 ? '' : 's'}
            {rerun ? ` · ${rerun} need${rerun === 1 ? 's' : ''} re-run` : ''}
            {missing ? ` · ${missing} missing` : ''}
          </span>
        </div>
        {recent.map(entry => (
          <button
            key={entry.id}
            type="button"
            onClick={() => openLibrary(entry.id)}
            className="block w-full text-left rounded px-1 py-0.5 text-[11.5px] hover:bg-gray-100 dark:hover:bg-white/10"
            title={entry.path}
          >
            <span className="truncate text-gray-800 dark:text-gray-100">{entry.label}</span>{' '}
            <EntryBadges entry={entry} />
            {entry.rerun && (
              <span className="block text-[11px] text-amber-800 dark:text-amber-200" data-testid="library-sidebar-rerun-note" title={rerunExplanation(entry)}>
                Why: {rerunSummary(entry)}. Open for details.
              </span>
            )}
          </button>
        ))}
      </div>
    </SidebarSubSection>
  );
}
