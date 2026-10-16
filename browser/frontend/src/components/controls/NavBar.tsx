import { createPortal } from 'react-dom';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import { useDafcStore } from '../../stores/dafcStore';
import { LinkedSessionPanel } from '../tracks/dafc/LinkedSessionPanel';
import { useDatasetActions } from '../../hooks/useDatasetActions';
import { Bookmark, Camera, Check, Download, FileDown, Info, Keyboard, MoreVertical, Power, RotateCcw } from '../ui/Icons';
import { HowToCiteDialog } from './HowToCiteDialog';
import { EXPORT_DATA_SHORTCUT, SAVE_SESSION_LABEL } from '../../utils/shortcuts';
import { resetViewUndoably } from '../../utils/resetView';
import { downloadSession } from '../../api/session';
import { QuitButton, useQuitAvailable } from './QuitButton';
import { useAppCommand } from '../../hooks/useAppCommand';
import { CommandPaletteButton } from './CommandPalette';
import { OpenSplitButton } from './OpenMenu';

interface NavBarProps {
  loading: boolean;
  scanning: boolean;
  clustering?: boolean;
  /** The History set (undo, redo, history menu). */
  history?: ReactNode;
  /** The Navigation set: chromosome, locus + Go, back/forward, zoom, locus jump, view toggles. */
  children?: ReactNode;
  onExport?: () => void;  // Callback to open export/screenshot panel
  /** Opens Export data… (every data export in one place). */
  onExportData?: () => void;
  onShowShortcuts?: () => void;
}

/**
 * Below this width in the toolbar's own px (the window's width over the UI
 * size) the top bar is compact: the File buttons show their icons only, so it
 * takes fewer rows and leaves the reads their height (audit H5: at UI size
 * 150% in a 1024 px window it took four rows and half the window).
 */
export const NAV_COMPACT_BELOW = 1180;

/** How long "Session downloaded: <file>" stays under the toolbar after a Save. */
export const SAVED_STATUS_MS = 6000;

/** Whether the top bar is compact (see NAV_COMPACT_BELOW). */
export function useCompactChrome(): boolean {
  const uiScale = useBrowserStore(s => s.uiScale);
  const [width, setWidth] = useState(() => (typeof window === 'undefined' ? 1440 : window.innerWidth));
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width / (uiScale > 0 ? uiScale : 1) < NAV_COMPACT_BELOW;
}

/**
 * The top toolbar, four sets left to right with hairline dividers:
 * File (Open ▾, Save, Export figure, Export data) | History (Undo, Redo) | Navigation | the More menu
 * (Reset view, Analysis details, Keyboard shortcuts, How to cite, Quit).
 * Settings open from the side rail at the right (or Cmd+B).
 */
export function NavBar({ loading, scanning, clustering, history, children, onExport, onExportData, onShowShortcuts }: NavBarProps) {
  const publicMode = useBrowserStore(s => s.publicMode);
  const showAnalysisDetails = useBrowserStore(s => s.showAnalysisDetails);
  const setShowAnalysisDetails = useBrowserStore(s => s.setShowAnalysisDetails);
  const sessionName = useBrowserStore(s => s.sessionName);
  const dafcLoaded = useDafcStore(s => s.dafcLoaded);
  const reopening = useBrowserStore(s => s.reopeningDatasets);
  const { handleLoadFile, loading: fileLoading } = useDatasetActions();
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  // The file the last Save downloaded, said in a polite toast at the foot of the window for a while (round 3, R11:
  // the button's 1.5-s "Saved" was the only sign of where the session went).
  const [savedFile, setSavedFile] = useState<string | null>(null);
  const savedTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(savedTimer.current), []);
  const compact = useCompactChrome();

  const handleSaveSession = async () => {
    setSaveStatus('saving');
    try {
      const file = await downloadSession(sessionName);
      setSaveStatus('saved');
      setSavedFile(file);
      window.clearTimeout(savedTimer.current);
      savedTimer.current = window.setTimeout(() => setSavedFile(null), SAVED_STATUS_MS);
      window.setTimeout(() => setSaveStatus('idle'), 1500);
    } catch {
      setSaveStatus('error');
      window.setTimeout(() => setSaveStatus('idle'), 2500);
    }
  };

  // The app menu's File > Open File / Open Session / Save Session (not in public mode).
  const whenLocal = (run: () => unknown) => () => { if (publicMode) return false; void run(); return true; };
  useAppCommand('open-file', whenLocal(handleLoadFile));
  useAppCommand('open-session', whenLocal(handleLoadFile));
  useAppCommand('save-session', whenLocal(handleSaveSession));

  const fileButton = `fb-btn-secondary h-[30px] text-[12px] ${compact ? 'px-2' : 'px-2 sm:px-2.5'}`;
  // A File button's name: beside its icon, or only in its tooltip and accessible name when compact.
  const fileLabel = (text: string) => (compact ? null : <span className="hidden sm:inline">{text}</span>);

  return (
    <div
      className="relative z-40 flex min-h-9 flex-wrap items-center gap-x-1 gap-y-1 bg-white/85 px-1.5 py-1 backdrop-blur-[20px] select-none dark:border-white/[0.06] dark:bg-dark-bg/85 sm:px-2"
      data-testid="top-nav"
      data-chrome-compact={compact ? 'true' : undefined}
    >
      {/* 1. File: Open ▾ and Save (not in public mode) and Export. */}
      <div className="flex flex-shrink-0 items-center gap-1" data-toolbar-set="file">
      {!publicMode && (
        <>
          <OpenSplitButton compact={compact} loading={fileLoading} onOpenFile={handleLoadFile} buttonClass={fileButton} />
          <button
            onClick={handleSaveSession}
            disabled={saveStatus === 'saving'}
            className={fileButton}
            // The visible label stays short ("Save": "Save session" wraps the toolbar near 1600 px); the tooltip and the
            // accessible name say what it saves (with ⌘S in the app, where the menu has it). The Footprints list is "Add to Saved", so "Save" alone is not ambiguous.
            // While saving / saved / failed, the visible text is the name; icon-only (compact), the label says it.
            title={saveStatus === 'error' ? 'Session save failed; try again' : SAVE_SESSION_LABEL}
            aria-label={saveStatus === 'idle' ? SAVE_SESSION_LABEL : compact
              ? (saveStatus === 'saving' ? 'Saving session' : saveStatus === 'saved' ? 'Session saved' : 'Session save failed; try again')
              : undefined}
            data-testid="save-session-button"
          >
            {compact && saveStatus === 'saved' ? <Check size={14} aria-hidden="true" /> : <Download size={14} aria-hidden="true" />}
            {compact ? null : saveStatus === 'saving' ? 'Saving...' : saveStatus === 'saved' ? 'Saved' : saveStatus === 'error' ? 'Save failed' : 'Save'}
          </button>
          {/* Portal escapes the toolbar’s backdrop-filter containing block; keep the live region mounted. */}
          {createPortal(<span role="status" aria-live="polite" data-testid="save-session-status"
            className={savedFile ? 'pointer-events-none fixed bottom-5 left-1/2 -translate-x-1/2 z-[60] max-w-[calc(100%-2rem)] break-words rounded-fb border border-line bg-white/95 px-3 py-1 text-[12px] text-ink shadow-sm dark:bg-gray-800/95 dark:text-gray-100' : 'sr-only'}>
            {savedFile ? `Session downloaded: ${savedFile}` : ''}
          </span>, document.body)}
        </>
      )}
      {onExport && (
        <button
          onClick={onExport}
          className={fileButton}
          title="Export a figure (PNG, SVG or PDF)"
          aria-label="Export a figure"
          data-testid="export-screenshot-button"
        >
          <Camera size={14} aria-hidden="true" />
          {fileLabel('Export')}
        </button>
      )}
      {onExportData && (
        <button
          onClick={onExportData}
          className={fileButton}
          title={`Export data: read names, BAM subsets, tables, BED and the session file (${EXPORT_DATA_SHORTCUT})`}
          aria-label="Export data"
          data-testid="export-data-button"
        >
          <FileDown size={14} aria-hidden="true" />
          {fileLabel('Data')}
        </button>
      )}
      </div>

      {/* 2. History */}
      {history && (
        <>
          <span className="fb-tb-div" aria-hidden="true" />
          <div className="flex flex-shrink-0 items-center" data-toolbar-set="history">{history}</div>
        </>
      )}

      {/* 3. Navigation (injected from Browser) */}
      <span className="fb-tb-div" aria-hidden="true" />
      {children}

      {/* 4. App, at the right edge */}
      <div className="ml-auto flex flex-shrink-0 items-center gap-0.5 sm:gap-1" data-toolbar-set="app">
        {/* Status floats under the toolbar's right edge: it comes and goes on
            every navigation, and taking space in the row made the toolbar
            wrap and the whole browser jump. */}
        {(loading || scanning || clustering || reopening.length > 0) && (
          <span
            data-testid="nav-status"
            className="pointer-events-none absolute right-2 top-full z-50 mt-1 hidden whitespace-nowrap rounded bg-white/90 px-2 py-0.5 text-xs text-tool-400 shadow-sm animate-pulse sm:inline dark:bg-gray-800/90"
          >
            {reopening.length > 0 ? `Reopening ${reopening.join(', ')}…` : clustering ? 'Clustering...' : scanning ? 'Scanning peaks...' : 'Loading...'}
          </span>
        )}

        {/* Contact map button: opens the in-window Contacts panel, which
            follows the browser viewport (the old /dafc pop-up had its own
            store and could not). */}
        {dafcLoaded && (
          <button
            onClick={() => useBrowserStore.getState().openAnalysisPanel('contact-map')}
            className="text-[13px] px-1.5 py-0 rounded bg-transparent text-gray-500 dark:text-gray-400 hover:bg-black/5 dark:hover:bg-white/10"
            title="Open the contact map panel"
          >
            Contacts
          </button>
        )}

        {/* Linked Session Panel */}
        {dafcLoaded && <LinkedSessionPanel />}

        {/* Search commands and settings (⌘K / Ctrl+K). */}
        <CommandPaletteButton />

        <MoreMenu
          showAnalysisDetails={showAnalysisDetails}
          onToggleAnalysisDetails={() => setShowAnalysisDetails(!showAnalysisDetails)}
          onShowShortcuts={onShowShortcuts}
        />
      </div>
    </div>
  );
}

/** The App set's More menu: reset view, analysis details, keyboard shortcuts, how to cite and quit. */
function MoreMenu({ showAnalysisDetails, onToggleAnalysisDetails, onShowShortcuts }: {
  showAnalysisDetails: boolean;
  onToggleAnalysisDetails: () => void;
  onShowShortcuts?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [quitRequest, setQuitRequest] = useState(0);
  const [citeOpen, setCiteOpen] = useState(false);
  const quitAvailable = useQuitAvailable();
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const run = (action: () => void) => () => { setOpen(false); action(); };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className={`fb-icon-btn ${open || showAnalysisDetails ? 'fb-icon-btn-active' : ''}`}
        title="More: reset view, analysis details, keyboard shortcuts, quit"
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="toolbar-more-button"
      >
        <MoreVertical size={15} />
      </button>
      {open && (
        <div role="menu" className="fb-menu" data-testid="toolbar-more-menu">
          {/* Reset view is one undoable step, like any other. */}
          <button
            type="button"
            role="menuitem"
            className="fb-menu-item"
            onClick={run(() => resetViewUndoably())}
            title="Reset view (R): clear clustering, filters and selections. Undo brings them back."
            aria-label="Reset view"
            data-testid="reset-view-button"
          >
            <RotateCcw size={14} aria-hidden="true" />
            <span className="flex-1">Reset view</span>
            <span className="text-[11px] text-gray-400">R</span>
          </button>
          <div className="fb-menu-sep" />
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={showAnalysisDetails}
            aria-pressed={showAnalysisDetails}
            className="fb-menu-item items-start"
            // A checkbox item: the menu stays open so the change shows.
            onClick={onToggleAnalysisDetails}
            title={showAnalysisDetails
              ? 'Hide analysis details (seeds, inputs, provenance)'
              : 'Show analysis details: seeds, inputs, outputs and provenance for reproducibility'}
            aria-label="Analysis details"
            aria-describedby="analysis-details-caption"
            data-testid="analysis-details-toggle"
          >
            <Info size={14} aria-hidden="true" className="mt-0.5" />
            <span className="flex flex-1 flex-col">
              <span>Analysis details</span>
              <span id="analysis-details-caption" className="text-[11px] font-normal text-gray-500 dark:text-gray-400" data-testid="analysis-details-caption">
                {showAnalysisDetails
                  ? 'On: analysis panels show Run details (seeds, inputs, provenance)'
                  : 'Off: turn on to show Run details (seeds, inputs, provenance) in analysis panels'}
              </span>
            </span>
            {showAnalysisDetails && <Check size={13} className="mt-0.5 text-brand-600 dark:text-brand-300" aria-hidden="true" />}
          </button>
          {onShowShortcuts && (
            <button
              type="button"
              role="menuitem"
              className="fb-menu-item"
              onClick={run(onShowShortcuts)}
              title="Keyboard shortcuts (?)"
              data-testid="keyboard-shortcuts-button"
            >
              <Keyboard size={14} aria-hidden="true" />
              <span className="flex-1">Keyboard shortcuts</span>
              <span className="text-[11px] text-gray-400">?</span>
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className="fb-menu-item"
            onClick={run(() => setCiteOpen(true))}
            title="How to cite FiberBrowser and FiberHMM in published work"
            data-testid="how-to-cite-button"
          >
            <Bookmark size={14} aria-hidden="true" />
            <span className="flex-1">How to cite</span>
          </button>
          {quitAvailable && (
            <>
              <div className="fb-menu-sep" />
              <button
                type="button"
                role="menuitem"
                className="fb-menu-item hover:!text-red-600 dark:hover:!text-red-400"
                onClick={run(() => setQuitRequest(n => n + 1))}
                title="Quit FiberBrowser (stop the server)"
                aria-label="Quit FiberBrowser"
                data-testid="quit-button"
              >
                <Power size={14} aria-hidden="true" />
                <span className="flex-1">Quit FiberBrowser…</span>
              </button>
            </>
          )}
        </div>
      )}
      <QuitButton requestOpen={quitRequest} />
      <HowToCiteDialog open={citeOpen} onClose={() => setCiteOpen(false)} />
    </div>
  );
}
