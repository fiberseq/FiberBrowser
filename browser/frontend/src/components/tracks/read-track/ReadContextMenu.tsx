import { PreviewBadge } from '../../ui/PreviewBadge';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  BarChart, ClipboardList, Copy, Download, Eye, EyeOff, Layers, Library, Minus, Pin, Plus, Reads, RowHeight, Search, Settings, Sliders, Split, Target, TfFootprint, X,
} from '../../ui/Icons';
import { PanelIcon } from '../../ui/panelIcons';
import {
  actionableIndices, clampMenuPosition,
  type ReadMenuAction, type ReadMenuSeparator, type ReadMenuHeading, type ReadMenuSubmenu,
} from './readMenuModel';

const ICONS: Record<string, (p: { size?: number }) => JSX.Element> = {
  reads: Reads, footprint: TfFootprint, stats: BarChart, copy: Copy, clipboard: ClipboardList, pin: Pin,
  target: Target, 'zoom-in': Plus, 'zoom-out': Minus, filter: Sliders, eye: Eye, 'eye-off': EyeOff, x: X, search: Search,
  split: Split,
  // Track menus (fb-n11-tracks)
  layers: Layers, resize: RowHeight, settings: Settings, download: Download, library: Library,
};

/** Icons plugin packs add for their menu items (used as `ext:<name>`). */
const EXTRA_ICONS: Record<string, (p: { size?: number }) => JSX.Element> = {};

export function registerMenuIcon(name: string, icon: (p: { size?: number }) => JSX.Element): void {
  EXTRA_ICONS[name] = icon;
}

function MenuIcon({ icon }: { icon: string }) {
  if (icon.startsWith('panel:')) return <PanelIcon contentType={icon.slice('panel:'.length)} size={13} />;
  const Icon = icon.startsWith('ext:') ? EXTRA_ICONS[icon.slice('ext:'.length)] : ICONS[icon];
  return Icon ? <Icon size={13} /> : null;
}

/** A menu item: what it does (`action`), its label and icon (a name above, or `panel:<contentType>`). */
export interface ContextMenuItem<A extends string = string> {
  kind: 'item';
  action: A;
  label: string;
  icon: string;
  shortcut?: string;
  disabled?: boolean;
  title?: string;
  /** A Preview feature's item: drawn with its Preview badge. */
  preview?: string;
}
export type ContextMenuEntry<A extends string = string> = ContextMenuItem<A> | ReadMenuSeparator | ReadMenuHeading | ReadMenuSubmenu<ContextMenuItem<A>>;

/** The entries as drawn: an open submenu's items follow it (indented). */
type DrawnEntry<A extends string> = (ContextMenuItem<A> & { nested?: string }) | ReadMenuSeparator | ReadMenuHeading | ReadMenuSubmenu<ContextMenuItem<A>>;
function drawnEntries<A extends string>(entries: ContextMenuEntry<A>[], open: ReadonlySet<string>): DrawnEntry<A>[] {
  return entries.flatMap(e => (e.kind === 'submenu' && open.has(e.id) ? [e, ...e.entries.map(c => ({ ...c, nested: e.id }))] : [e]));
}

export interface ReadContextMenuProps<A extends string = ReadMenuAction> {
  /** Where the pointer was (client coordinates). */
  x: number;
  y: number;
  entries: ContextMenuEntry<A>[];
  /** Shown at the top (the read's name, or the position). */
  title?: string;
  onAction: (action: A) => void;
  onClose: () => void;
  /** The menu's test id (the read menu: read-context-menu). */
  testId?: string;
  /** Its accessible name (default: "Actions for <title>"). */
  label?: string;
}

/**
 * The right-click menu on reads (fb-r4-clicks): at the pointer, over
 * everything; arrow keys, Home/End move, Enter/Space act, Escape or a click
 * elsewhere closes it (focus goes back where it was). It never pans the view.
 */
export function ReadContextMenu<A extends string = ReadMenuAction>({ x, y, entries, title, onAction, onClose, testId = 'read-context-menu', label }: ReadContextMenuProps<A>) {
  const ref = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // Submenus opened in place (audit SV-5: a track's admin items under one entry).
  const [openSubmenus, setOpenSubmenus] = useState<ReadonlySet<string>>(() => new Set());
  const drawn = drawnEntries(entries, openSubmenus);
  const actionable = actionableIndices(drawn);
  const toggleSubmenu = (id: string, on?: boolean) => setOpenSubmenus(prev => {
    const next = new Set(prev);
    if (on ?? !next.has(id)) next.add(id); else next.delete(id);
    return next;
  });
  const [active, setActive] = useState<number>(actionable[0] ?? -1);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y });
  const restoreFocus = useRef<Element | null>(typeof document !== 'undefined' ? document.activeElement : null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos(clampMenuPosition(x, y, { width: rect.width, height: rect.height }, { width: window.innerWidth, height: window.innerHeight }));
  }, [x, y, drawn.length]);

  useEffect(() => {
    if (active >= 0) itemRefs.current[active]?.focus();
  }, [active]);

  // While a menu is open, hover tips stay hidden (index.css: body[data-fb-menu-open] [data-fb-hover-tip]).
  useEffect(() => {
    document.body.dataset.fbMenuOpen = '';
    return () => { delete document.body.dataset.fbMenuOpen; };
  }, []);

  useEffect(() => {
    const restore = restoreFocus.current;
    const close = () => onCloseRef.current();
    const onPointer = (event: PointerEvent) => {
      if (ref.current?.contains(event.target as Node)) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    };
    const onAway = () => close();
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onAway);
    window.addEventListener('blur', onAway);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onAway);
      window.removeEventListener('blur', onAway);
      // Back where it was, unless the action put it somewhere (e.g. the locus box).
      const now = document.activeElement;
      const lost = !now || now === document.body || Boolean(ref.current?.contains(now));
      if (lost && restore instanceof HTMLElement && document.contains(restore)) restore.focus({ preventScroll: true });
    };
  }, []);

  const move = (delta: number) => {
    if (actionable.length === 0) return;
    const at = actionable.indexOf(active);
    const next = at < 0 ? 0 : (at + delta + actionable.length) % actionable.length;
    setActive(actionable[next]);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Handled here: the app's shortcuts (arrows pan and zoom) must not see them.
    event.stopPropagation();
    switch (event.key) {
      case 'ArrowDown': event.preventDefault(); move(1); break;
      case 'ArrowUp': event.preventDefault(); move(-1); break;
      case 'Home': event.preventDefault(); setActive(actionable[0] ?? -1); break;
      case 'End': event.preventDefault(); setActive(actionable[actionable.length - 1] ?? -1); break;
      case 'Tab': event.preventDefault(); move(event.shiftKey ? -1 : 1); break;
      case 'ArrowRight': {
        const e = drawn[active];
        if (e?.kind === 'submenu') { event.preventDefault(); toggleSubmenu(e.id, true); setActive(active + 1); }
        break;
      }
      case 'ArrowLeft': {
        const e = drawn[active];
        const parent = e?.kind === 'item' && e.nested ? drawn.findIndex(x => x.kind === 'submenu' && x.id === e.nested) : -1;
        if (parent >= 0) { event.preventDefault(); toggleSubmenu(e.kind === 'item' ? e.nested! : '', false); setActive(parent); }
        else if (e?.kind === 'submenu' && openSubmenus.has(e.id)) { event.preventDefault(); toggleSubmenu(e.id, false); }
        break;
      }
      case 'Escape': event.preventDefault(); onClose(); break;
      default: break;
    }
  };

  const menu = (
    <div
      ref={ref}
      role="menu"
      aria-label={label ?? (title ? `Actions for ${title}` : 'Read actions')}
      data-testid={testId}
      className="fb-menu !fixed !z-[200] max-w-[22rem]"
      style={{ left: pos.left, top: pos.top, right: 'auto', marginTop: 0 }}
      onKeyDown={onKeyDown}
      // A portal still bubbles React events to the read panel's ancestors
      // (panel drag, track handlers): nothing in the menu reaches them.
      onMouseDown={e => e.stopPropagation()}
      onPointerDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
      onWheel={e => e.stopPropagation()}
      onContextMenu={e => { e.preventDefault(); e.stopPropagation(); }}
    >
      {title && (
        <div className="truncate px-3 pb-1 pt-0.5 font-mono text-[11px] text-ink-muted" title={title} data-testid={`${testId}-title`}>
          {title}
        </div>
      )}
      {drawn.map((entry, i) => {
        if (entry.kind === 'separator') return <div key={`sep-${i}`} role="separator" className="fb-menu-sep" />;
        if (entry.kind === 'heading') return <div key={`h-${i}`} className="px-3 py-1 text-[11px] text-ink-muted">{entry.label}</div>;
        if (entry.kind === 'submenu') {
          const isOpen = openSubmenus.has(entry.id);
          return (
            <button
              key={`sub-${entry.id}`}
              ref={el => { itemRefs.current[i] = el; }}
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={isOpen}
              tabIndex={i === active ? 0 : -1}
              disabled={entry.disabled}
              title={entry.title}
              data-submenu={entry.id}
              className="fb-menu-item disabled:cursor-default disabled:opacity-45"
              onMouseEnter={() => { if (!entry.disabled) setActive(i); }}
              onClick={(e) => { e.stopPropagation(); if (!entry.disabled) toggleSubmenu(entry.id); }}
            >
              <span className="flex w-4 justify-center text-ink-muted" aria-hidden="true"><MenuIcon icon={entry.icon} /></span>
              <span className="flex-1 truncate">{entry.label}</span>
              <span className="ml-3 text-[11px] text-ink-muted" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
            </button>
          );
        }
        return (
          <button
            key={entry.action}
            ref={el => { itemRefs.current[i] = el; }}
            type="button"
            role="menuitem"
            tabIndex={i === active ? 0 : -1}
            aria-disabled={entry.disabled || undefined}
            disabled={entry.disabled}
            title={entry.title}
            data-action={entry.action}
            className={`fb-menu-item disabled:cursor-default disabled:opacity-45 disabled:hover:bg-transparent ${entry.nested ? 'pl-6' : ''}`}
            onMouseEnter={() => { if (!entry.disabled) setActive(i); }}
            onClick={(e) => {
              e.stopPropagation();
              if (entry.disabled) return;
              onClose();
              onAction(entry.action);
            }}
          >
            <span className="flex w-4 justify-center text-ink-muted" aria-hidden="true"><MenuIcon icon={entry.icon} /></span>
            <span className="flex-1 truncate">{entry.label}</span>
            {entry.preview && <PreviewBadge feature={entry.preview} />}
            {entry.shortcut && (
              <span className="ml-3 text-[11px] text-ink-muted" aria-label={`shortcut ${entry.shortcut}`}>{entry.shortcut}</span>
            )}
          </button>
        );
      })}
    </div>
  );
  return typeof document === 'undefined' ? menu : createPortal(menu, document.body);
}
