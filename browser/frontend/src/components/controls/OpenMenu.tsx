import { useEffect, useRef, useState, type ComponentType, type SVGProps } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import { runAppCommand, type AppCommandName } from '../../utils/appCommands';
import { openMenuEntries } from '../../utils/openMenu';
import { shortcutForCommand } from '../../utils/shortcuts';
import { useMenuKeys } from '../../hooks/useMenuKeys';
import { CheckCircle, ChevronDown, Dna, FolderOpen, Library, Link, Server } from '../ui/Icons';
import { useLiveLiftStore } from '../../features/liveLift/store';

type Icon = ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;

const ICONS: Partial<Record<AppCommandName, Icon>> = {
  'open-file': FolderOpen,
  library: Library,
  'load-by-path': Link,
  'connect-cluster': Server,
  'new-daf-run': Dna,
  'dataset-qc': CheckCircle,
};

interface OpenSplitButtonProps {
  /** Icon only (the top bar is compact): the ▾ part stays. */
  compact: boolean;
  /** The file dialog is open or files are loading. */
  loading: boolean;
  /** The main part: the file dialog, as Load File always did. */
  onOpenFile: () => void;
  /** The File set's button classes. */
  buttonClass: string;
}

/**
 * The File set's Open button: the main part opens the file dialog; its ▾ lists
 * every other way to get data in (the Library, a path or URL, a cluster) and to
 * make or check it (a DAF-seq run from raw reads, QC of a BAM). Only
 * shown where files can be opened (not on a public server or in a tour tab).
 */
export function OpenSplitButton({ compact, loading, onOpenFile, buttonClass }: OpenSplitButtonProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // Availability reads the store: re-render while open when it changes.
  useBrowserStore(s => s.datasets.length);
  useBrowserStore(s => s.publicMode);
  const onKeyDown = useMenuKeys(open, () => setOpen(false), rootRef);
  // Live lift (behind the server's flag): another way in, a BAM of another assembly drawn here through a map.
  const liveLiftOn = useLiveLiftStore(s => s.enabled === true);
  const fileShortcut = shortcutForCommand('open-file');

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    // Escape with the focus elsewhere (the keys in the menu are handled there).
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // While the file dialog is open or files load, Open file… waits like the main part (no second picker).
  const groups = (open ? openMenuEntries() : []).map(group => group.map(entry => (
    entry.command === 'open-file' && loading ? { ...entry, enabled: false, reason: 'Opening files…' } : entry)));

  return (
    <div ref={rootRef} className="relative flex items-center" onKeyDown={onKeyDown} data-testid="open-split">
      <button
        type="button"
        onClick={onOpenFile}
        disabled={loading}
        className={`${buttonClass} rounded-r-none`}
        title={`Open a file: data (BAM, BigBed, BigWig, GTF, FASTA…) or a saved session (.json)${fileShortcut ? ` (${fileShortcut})` : ''}`}
        aria-label={compact ? 'Open file' : undefined}
        data-testid="load-file-button"
      >
        <FolderOpen size={14} aria-hidden="true" />
        {loading ? (compact ? null : 'Loading...') : compact ? null : <span>Open</span>}
      </button>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className={`${buttonClass} -ml-px rounded-l-none !px-1 ${open ? 'bg-surface-sunken dark:bg-white/[0.12]' : ''}`}
        title="More ways to open data: the Library, a path or URL, a cluster, raw reads (New DAF-seq run), data quality"
        aria-label="More ways to open data"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="open-menu-button"
      >
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open && (
        <div role="menu" aria-label="Open" className="fb-menu !left-0 !right-auto max-h-[calc(100vh-5rem)] min-w-[17rem] overflow-y-auto" data-testid="open-menu">
          {groups.map((group, g) => (
            <div key={g} role="none">
              {g > 0 && <div className="fb-menu-sep" role="separator" />}
              {group.map(entry => {
                const ItemIcon = ICONS[entry.command] ?? FolderOpen;
                const reasonId = entry.reason ? `open-menu-reason-${entry.command}` : undefined;
                return (
                  <button
                    key={entry.command}
                    type="button"
                    role="menuitem"
                    aria-disabled={entry.enabled ? undefined : 'true'}
                    aria-describedby={reasonId}
                    className={`fb-menu-item items-start ${entry.enabled ? '' : 'cursor-default !text-gray-400 hover:!bg-transparent dark:!text-gray-500'}`}
                    onClick={() => {
                      if (!entry.enabled) return;
                      setOpen(false);
                      runAppCommand(entry.command);
                    }}
                    title={entry.reason ?? undefined}
                    data-testid={`open-menu-${entry.command}`}
                  >
                    <ItemIcon size={14} aria-hidden="true" className="mt-0.5 flex-shrink-0" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span>{entry.label}</span>
                      {entry.reason && (
                        <span id={reasonId} className="text-[11px] font-normal text-gray-500 dark:text-gray-400" data-testid={`open-menu-reason-${entry.command}`}>
                          {entry.reason}
                        </span>
                      )}
                    </span>
                    {entry.shortcut && (
                      <kbd className="mt-0.5 font-sans text-[11px] text-ink-secondary" data-testid={`open-menu-shortcut-${entry.command}`}>{entry.shortcut}</kbd>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
          {liveLiftOn && (
            <div role="none">
              <div className="fb-menu-sep" role="separator" />
              <button type="button" role="menuitem" className="fb-menu-item items-start" data-testid="open-menu-add-live-lift"
                title="A BAM aligned to another assembly (e.g. HG002), drawn on this genome through a graphlift map"
                onClick={() => { setOpen(false); useLiveLiftStore.getState().setDialogOpen(true); }}>
                <Link size={14} aria-hidden="true" className="mt-0.5 flex-shrink-0" />
                <span>Add live lift…</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
