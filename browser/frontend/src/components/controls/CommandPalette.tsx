import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import {
  closeCommandPalette, toggleCommandPalette, useCommandPaletteStore,
} from '../../utils/commandPaletteStore';
import {
  buildPaletteItems, gotoItems, paletteSections, toggleItem, type PaletteItem,
} from '../../utils/commandPaletteItems';
import { asyncAnswerCouldOutrank, type SearchContext } from '../../utils/search/providers';
import { paletteTargets, paletteTargetsKey } from '../../utils/search/paletteTargets';
// Coordinates, genes, saved regions and read names (the locus boxes' providers).
import '../../utils/search/builtinProviders';
import { useProviderSearch } from '../../hooks/useProviderSearch';
import { openOverlayState } from '../../hooks/useKeyboardShortcuts';
import { runAppCommand } from '../../utils/appCommands';
import { getAnalysisPanel } from '../../plugins/registry';
import { hasPanelIcon, PanelIcon } from '../ui/panelIcons';
import { useBrowserStore } from '../../stores/browserStore';
import { usePanelGenomeStore } from '../../stores/panelGenomeStore';
import { beginNavigationIntent, mainReferenceIdentity, type NavigationIntent } from '../../utils/search/navigationIntent';
import {
  Crosshair, Dna, Keyboard, LayoutColumns, MapPinPlus, Play, Reads, Search, Settings, CircleHalf,
} from '../ui/Icons';

const RECENT_KEY = 'fiberbrowser_palette_recent_v1';
const RECENT_MAX = 8;
/**
 * The palette's search: every reference on screen, each through the panel
 * that shows it (utils/search/paletteTargets: the active panel for its own
 * reference); read names once, everywhere.
 */
const paletteSearchContext = (signal: AbortSignal): SearchContext => ({ source: 'palette', signal, targets: paletteTargets() });

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
export const PALETTE_SHORTCUT = isMac ? '⌘K' : 'Ctrl+K';

/** The recent picks (per viewer; a convenience only). */
export function readRecentPicks(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function rememberPick(id: string): void {
  if (id.startsWith('goto:')) return;  // places change with the data: not kept
  try {
    const next = [id, ...readRecentPicks().filter(other => other !== id)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* storage off: no recent list */ }
}

/** ⌘K / Ctrl+K anywhere (also in a text field), unless another dialog is open. */
export function isPaletteHotkey(e: KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k';
}

/**
 * Where the pointer was before the current mousemove, page-wide (a capture listener on the window runs before a row's
 * handler). The mouse chooses a row only when it really moved: Chromium also sends mousemove under a still pointer when
 * the rows move or change under it (a toggle's words flipping, the active row scrolled into view, the palette opening
 * under the pointer), and that must not take the choice from the arrow keys (the command-palette e2e flake). By
 * position, not movementX: events sent by automation carry no movement.
 */
let pointerBefore: { x: number; y: number } | null = null;
let pointerNow: { x: number; y: number } | null = null;
if (typeof window !== 'undefined') {
  window.addEventListener('mousemove', e => { pointerBefore = pointerNow; pointerNow = { x: e.clientX, y: e.clientY }; }, { capture: true, passive: true });
}
export function pointerMoved(e: { clientX: number; clientY: number }): boolean {
  return !pointerBefore || pointerBefore.x !== e.clientX || pointerBefore.y !== e.clientY;
}

function ItemIcon({ item }: { item: PaletteItem }) {
  const size = 14;
  if (item.kind === 'panel') {
    // The panel's own icon (as on its strip chip and header); a plugin may bring one; else a generic panel.
    const PluginIcon = item.panelType ? getAnalysisPanel(item.panelType)?.icon : undefined;
    const icon = item.panelType && hasPanelIcon(item.panelType)
      ? <PanelIcon contentType={item.panelType} size={size} />
      : PluginIcon ? <PluginIcon size={size} /> : <LayoutColumns size={size} />;
    return <span style={{ color: item.color }} className="inline-flex" data-panel-icon={item.panelType}>{icon}</span>;
  }
  if (item.kind === 'goto') {
    if (item.gotoKind === 'gene') return <Dna size={size} />;
    if (item.gotoKind === 'region' || item.gotoKind === 'category') return <MapPinPlus size={size} />;
    if (item.gotoKind === 'read') return <Reads size={size} />;
    return <Crosshair size={size} />;
  }
  if (item.kind === 'setting') return <Settings size={size} />;
  if (item.kind === 'toggle') return <CircleHalf size={size} />;
  if (item.kind === 'shortcut') return <Keyboard size={size} />;
  return <Play size={size} />;
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="shrink-0 whitespace-nowrap rounded border border-line bg-surface-sunken px-1.5 py-px font-mono text-[10.5px] text-ink-muted dark:border-white/15 dark:bg-white/10 dark:text-gray-300">
      {children}
    </kbd>
  );
}

/**
 * The command palette: one search over every action, panel, setting and
 * keyboard shortcut, and "Go to" a locus or gene. ⌘K / Ctrl+K, the top bar's
 * search button, or the menu bar (View › Search Commands and Settings…).
 */
export function CommandPalette({ initialQuery = '', onClose }: { initialQuery?: string; onClose: () => void }) {
  const [query, setQuery] = useState(initialQuery);
  // The option chosen (arrows, the mouse) by its id, for the text it was chosen for:
  // answers arriving later (genes) insert rows above it without changing the choice.
  const [chosen, setChosen] = useState<{ query: string; id: string } | null>(null);
  const [version, setVersion] = useState(0);  // rebuilds the items after a toggle flips
  // The main genome (by its full FASTA path) and the panels a Go to reaches (one per reference, the
  // active panel's first): other assemblies or other panels mean other answers (genes, regions, coordinates).
  const mainReference = useBrowserStore(s => mainReferenceIdentity(s));
  // (A panel reference's chromosomes arriving later change the targets too.)
  const panelGenomes = usePanelGenomeStore(s => s.genomes);
  const targetsKey = useBrowserStore(s => paletteTargetsKey(paletteTargets(s as never)));
  void panelGenomes;
  const referenceKey = `${mainReference}|${targetsKey}`;
  // "Go to": the immediate providers now, the server ones (genes) once typing pauses.
  // While the server's are still coming, Enter on an empty list waits for them.
  const { groups: gotoGroups, pending: gotoPending, complete: completeGoto } = useProviderSearch(query, paletteSearchContext, `palette|${referenceKey}`);
  const [enterWhenReady, setEnterWhenReady] = useState(false);
  // That Enter's intent: a new Go to (it supersedes older pending answers), dropped if the main view moves first.
  const enterIntent = useRef<NavigationIntent | null>(null);
  const enterPanels = useRef<Array<{ panelId: string }>>([]);
  const [status, setStatus] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;

  const items = useMemo(() => buildPaletteItems(), [version]);
  const recent = useMemo(() => readRecentPicks(), [version]);

  // A waiting Enter belongs to the text and the assembly it was pressed for.
  useEffect(() => { setEnterWhenReady(false); enterIntent.current = null; }, [query, referenceKey]);

  const sections = useMemo(
    () => paletteSections(query, items, recent, gotoItems(gotoGroups)),
    [query, items, recent, gotoGroups],
  );
  const flat = useMemo(() => sections.flatMap(section => section.items), [sections]);

  // The chosen option's row now (it moves when rows arrive above it); nothing
  // chosen: the first. A chosen option pushed off the list is not replaced by
  // another one: nothing is active (Enter runs nothing) until the next choice.
  const chooseFor = chosen && chosen.query === query ? chosen.id : null;
  const chosenAt = chooseFor ? flat.findIndex(item => item.id === chooseFor) : -1;
  const active = chooseFor ? chosenAt : 0;
  const setActive = (next: number | ((current: number) => number)) => {
    const at = typeof next === 'function' ? next(active) : next;
    const item = flat[at];
    setChosen(item ? { query, id: item.id } : null);
  };
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    listRef.current?.querySelector('[role="option"][aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [active, flat]);

  const choose = useCallback((item: PaletteItem | undefined) => {
    if (!item) return;
    // A choice made now replaces an Enter still waiting for the genes (it must not run later too).
    setEnterWhenReady(false);
    enterIntent.current = null;
    if (item.disabledReason) { setStatus(item.disabledReason); return; }
    rememberPick(item.kind === 'toggle' && item.setting ? `setting:${item.setting.id}` : item.id);
    if (item.keepOpen) {
      item.run();
      setVersion(v => v + 1);
      if (item.setting?.toggle) setStatus(`${item.setting.label}: ${item.setting.toggle.get() ? 'on' : 'off'}`);
      return;
    }
    onClose();
    // A Go to: chosen now, run just after; not if any view moved (it may go to
    // a panel: a region, a read), the assembly changed or another Go to was
    // asked in between. Its intent is on the view it moves (a panel's own, else the main view).
    const intent = item.kind === 'goto' ? beginNavigationIntent(item.navTarget ?? 'main') : null;
    const panels = useBrowserStore.getState().panels.map(p => ({ panelId: p.id }));
    // After the palette has closed and given focus back (Go to locus focuses the locus box).
    window.setTimeout(() => {
      if (intent && !intent.isCurrent(panels)) return;
      void item.run();
    }, 0);
  }, [onClose]);

  useEffect(() => {
    if (!enterWhenReady || gotoPending) return;
    setEnterWhenReady(false);
    const intent = enterIntent.current;
    enterIntent.current = null;
    // A view moved (or another Go to ran) while the genes were looked up: that Enter is stale.
    if (intent && !intent.isCurrent(enterPanels.current)) return;
    // What is highlighted now (the first row, unless one was chosen meanwhile).
    const item = flat[active];
    if (item) choose(item);
  }, [enterWhenReady, gotoPending, flat, active, choose]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (isPaletteHotkey(e.nativeEvent)) {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    const move = (delta: number) => {
      e.preventDefault();
      if (flat.length === 0) return;
      setActive(i => (i < 0 ? (delta > 0 ? 0 : flat.length - 1) : (i + delta + flat.length) % flat.length));
    };
    switch (e.key) {
      case 'ArrowDown': move(1); break;
      case 'ArrowUp': move(-1); break;
      case 'PageDown': e.preventDefault(); setActive(i => Math.min(flat.length - 1, i + 8)); break;
      case 'PageUp': e.preventDefault(); setActive(i => Math.max(0, i - 8)); break;
      case 'Enter': {
        e.preventDefault();
        const item = flat[active];
        // The option chosen was pushed off the list (answers arrived): run nothing else instead.
        if (!item && chooseFor) { setStatus('The option chosen is no longer listed: choose again.'); break; }
        // Enter before the gene lookup came back, with nothing chosen, when the gene could
        // outrank the first row (an exact gene above a region named so, or above a command):
        // wait for it, then run the best match, as the locus box does (unless a view moves
        // meanwhile: the main one, or any panel the answer may go to). Typing or Escape cancels.
        const flipsSetting = (e.metaKey || e.ctrlKey) && item?.kind === 'setting';
        if (!chooseFor && gotoPending && !flipsSetting
          && (!item || asyncAnswerCouldOutrank(item.kind === 'goto' ? item.score : undefined, query))) {
          enterIntent.current = beginNavigationIntent('main');
          enterPanels.current = useBrowserStore.getState().panels.map(p => ({ panelId: p.id }));
          setEnterWhenReady(true);
          // Ask the server now (not after the typing pause).
          void completeGoto();
          break;
        }
        // ⌘/Ctrl+Enter on an on/off setting flips it without leaving the palette.
        if ((e.metaKey || e.ctrlKey) && item?.kind === 'setting' && item.setting?.toggle) {
          // (Its Turn on/off item is not listed under Recent: built here.)
          choose(toggleItem(item.setting) ?? undefined);
        } else {
          choose(item);
        }
        break;
      }
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        onClose();
        break;
      case 'Tab':
        // Focus stays in the field; the list is moved with the arrows.
        e.preventDefault();
        move(e.shiftKey ? -1 : 1);
        break;
      default:
        break;
    }
    // No key typed here reaches the browser's shortcuts.
    e.stopPropagation();
  };

  const activeItem = flat[active];
  let index = -1;

  return (
    <div
      className="fixed inset-0 z-[110] flex items-start justify-center px-4 pt-[12vh]"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
      data-testid="command-palette-backdrop"
    >
      <div className="pointer-events-none absolute inset-0 bg-black/30 dark:bg-black/50" aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search commands and settings"
        data-testid="command-palette"
        className="relative flex max-h-[70vh] w-full max-w-[40rem] flex-col overflow-hidden rounded-fb-lg border border-line bg-white text-[12px] text-ink shadow-modal dark:border-white/10 dark:bg-dark-surface dark:text-gray-100 dark:shadow-modal-dark"
      >
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3 dark:border-white/10">
          <Search size={16} className="shrink-0 text-ink-muted" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded={flat.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={flat.length > 0 && active >= 0 ? optionId(active) : undefined}
            aria-label="Search commands, settings and panels, or go to a locus, gene, region or read"
            placeholder="Search commands, settings, panels, or go to a locus, gene, region or read"
            value={query}
            onChange={e => { setQuery(e.target.value); setChosen(null); setStatus(''); }}
            onKeyDown={onKeyDown}
            spellCheck={false}
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-muted dark:text-gray-100"
            data-testid="command-palette-input"
          />
          <Kbd>esc</Kbd>
        </div>

        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Results"
          className="min-h-0 flex-1 overflow-y-auto py-1"
          data-testid="command-palette-list"
        >
          {sections.map(section => (
            <li key={section.label} role="presentation">
              {(sections.length > 1 || !query.trim()) && (
                <div role="presentation" className="px-3 pb-0.5 pt-2 text-[11px] font-medium text-ink-muted">{section.label}</div>
              )}
              <ul role="group" aria-label={section.label}>
                {section.items.map(item => {
                  index += 1;
                  const at = index;
                  const selected = at === active;
                  return (
                    <li
                      key={item.id}
                      id={optionId(at)}
                      role="option"
                      aria-selected={selected}
                      aria-disabled={item.disabledReason ? true : undefined}
                      data-palette-item={item.id}
                      data-palette-kind={item.kind}
                      onMouseMove={e => { if (pointerMoved(e) && chooseFor !== item.id) setActive(at); }}
                      onMouseDown={e => e.preventDefault()}
                      onClick={() => { setActive(at); choose(item); }}
                      className={`mx-1 flex cursor-pointer items-center gap-2.5 rounded-fb px-2 py-1.5 ${
                        selected ? 'bg-brand-600/10 text-ink dark:bg-brand-400/15 dark:text-white' : 'text-gray-700 dark:text-gray-200'
                      } ${item.disabledReason ? 'opacity-55' : ''}`}
                    >
                      <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-fb ${selected ? 'text-brand-700 dark:text-brand-300' : 'text-ink-muted'}`} aria-hidden="true">
                        <ItemIcon item={item} />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-[13px]">{item.title}</span>
                        {(item.detail || item.disabledReason) && (
                          <span className="truncate text-[11px] text-ink-muted dark:text-gray-400">{item.disabledReason ?? item.detail}</span>
                        )}
                      </span>
                      <span className="shrink-0 text-[10.5px] text-ink-muted dark:text-gray-400">{item.tag}</span>
                      {item.shortcut && <Kbd>{item.shortcut}</Kbd>}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
          {flat.length === 0 && (
            <li role="presentation" className="px-4 py-6 text-center text-[12px] text-ink-muted" data-testid="command-palette-empty">
              Nothing matches “{query.trim()}”. Try other words, a gene or region name, coordinates like chr1:1,000-2,000, or a read name (for a name of any other shape, type <span className="font-mono">read:</span> before it, e.g. <span className="font-mono">read: {query.trim() || 'my_read_7'}</span>).
            </li>
          )}
        </ul>

        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-3 py-1.5 text-[11px] text-ink-muted dark:border-white/10 dark:text-gray-400">
          <span><Kbd>↑</Kbd> <Kbd>↓</Kbd> move</span>
          <span><Kbd>Enter</Kbd> {activeItem?.kind === 'setting' ? 'show setting' : 'choose'}</span>
          {activeItem?.kind === 'setting' && activeItem.setting?.toggle && <span><Kbd>{isMac ? '⌘' : 'Ctrl+'}Enter</Kbd> turn {activeItem.setting.toggle.get() ? 'off' : 'on'}</span>}
          <span className="ml-auto" role="status" aria-live="polite" data-testid="command-palette-status">{enterWhenReady ? 'Looking up…' : status}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Mounts the palette while it is open, owns ⌘K / Ctrl+K, and gives focus back
 * when it closes. Rendered once at the browser's root.
 */
export function CommandPaletteHost() {
  const { open, initialQuery, openCount } = useCommandPaletteStore();
  const returnFocus = useRef<HTMLElement | null>(null);

  // Focus goes back where it was before the chosen item runs (Go to locus then focuses the locus box).
  const restoreFocus = useCallback(() => {
    const el = returnFocus.current;
    returnFocus.current = null;
    if (el && el.isConnected && el !== document.body) el.focus({ preventScroll: true });
  }, []);
  const close = useCallback(() => {
    closeCommandPalette();
    restoreFocus();
  }, [restoreFocus]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isPaletteHotkey(e) || e.defaultPrevented) return;
      const isOpen = useCommandPaletteStore.getState().open;
      // Behind another dialog (Export, Library, ...) the keys are that dialog's.
      if (!isOpen && openOverlayState().modal) return;
      e.preventDefault();
      toggleCommandPalette();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useLayoutEffect(() => {
    if (open) {
      const el = document.activeElement;
      // Not the palette's own field (a reopen while open).
      if (el instanceof HTMLElement && !el.closest('[data-testid="command-palette"]')) returnFocus.current = el;
      return;
    }
    // Closed by the keys or the menu bar rather than by choosing.
    restoreFocus();
  }, [open, openCount, restoreFocus]);

  if (!open) return null;
  return <CommandPalette key={openCount} initialQuery={initialQuery} onClose={close} />;
}

/** The top bar's search button (beside More). */
export function CommandPaletteButton() {
  return (
    <button
      type="button"
      onClick={() => runAppCommand('command-palette')}
      className="fb-icon-btn"
      title={`Search commands and settings (${PALETTE_SHORTCUT})`}
      aria-label="Search commands and settings"
      aria-keyshortcuts={isMac ? 'Meta+K' : 'Control+K'}
      data-testid="command-palette-button"
      data-tour="command-palette-button"
    >
      <Search size={15} />
    </button>
  );
}
