/**
 * The right-click menu of every per-panel track and its "Set height…" box
 * (fb-n11-tracks). A track row opens it through useTrackMenuStore; the items
 * are the track's own (if it has any), its kind's "open the relevant panel"
 * items (trackRegistry), then the common section every track gets.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useBrowserStore } from '../../stores/browserStore';
import { useTrackMenuStore, type OpenTrackMenu } from '../../stores/trackMenuStore';
import type { PanelConfig, SubTrackType } from '../../types';
import { ReadContextMenu, type ContextMenuEntry, type ContextMenuItem } from './read-track/ReadContextMenu';
import { clampMenuPosition } from './read-track/readMenuModel';
import { clampTrackHeight, isResizableTrack, rowHeight, trackKind, trackMenuItems, type TrackMenuContext, type TrackMenuItem } from './trackRegistry';
import { canDeleteTrack, deleteTrack } from './trackActions';
import { getTrackLabel } from './SubTrackMenu';
import { openLibrary } from '../controls/library/libraryStore';

export const TRACK_MENU_PREFIX = 'track:';
const KIND_PREFIX = 'kind:';

function menuContext(panel: PanelConfig, type: SubTrackType): TrackMenuContext {
  return { panel, type, datasetId: panel.datasetId, stateKey: panel.stateKey ?? panel.datasetId };
}

/** The common section of a track's menu (actions prefixed `track:`). */
export function commonTrackMenuEntries(type: SubTrackType, ctx?: TrackMenuContext): ContextMenuEntry[] {
  const kind = trackKind(type);
  const entries: ContextMenuEntry[] = [];
  if (isResizableTrack(type)) {
    entries.push({ kind: 'item', action: 'track:set-height', label: 'Set height…', icon: 'resize', title: 'Type a height for this track (or drag its bottom edge)' });
  }
  if (canDeleteTrack(type)) {
    entries.push({ kind: 'item', action: 'track:remove', label: 'Remove this track', icon: 'x', title: 'Remove it from this panel ("Tracks in this panel" brings it back)' });
  }
  entries.push({ kind: 'item', action: 'track:tracks', label: 'Tracks in this panel…', icon: 'layers', title: 'Every track of this panel: show, remove, restore, reorder' });
  if (kind.exportTrack && ctx) entries.push({ kind: 'item', action: 'track:export', label: 'Export this track…', icon: 'download' });
  if (kind.settingId) entries.push({ kind: 'item', action: 'track:settings', label: 'Track settings', icon: 'settings', title: 'Open its settings in the sidebar' });
  return entries;
}

/** The kind's own items ("Open Rules", …), actions prefixed `kind:`. */
export function kindMenuEntries(type: SubTrackType, ctx: TrackMenuContext): { entries: ContextMenuEntry[]; items: TrackMenuItem[] } {
  const items = trackMenuItems(type, ctx);
  return {
    items,
    entries: items.map(it => ({ kind: 'item' as const, action: `${KIND_PREFIX}${it.id}`, label: it.label, icon: it.icon, title: it.title, disabled: it.disabled, ...(it.preview ? { preview: it.preview } : {}) })),
  };
}

/** The whole menu of a track row. */
export function buildTrackMenu(type: SubTrackType, ctx: TrackMenuContext, own: ContextMenuEntry[] = []): ContextMenuEntry[] {
  const { entries: kindEntries } = kindMenuEntries(type, ctx);
  const out: ContextMenuEntry[] = [...own];
  if (kindEntries.length) {
    if (out.length) out.push({ kind: 'separator' });
    out.push(...kindEntries);
  }
  if (out.length) out.push({ kind: 'separator' });
  const common = commonTrackMenuEntries(type, ctx);
  // A menu with the track's own actions (the SV track's, on an SV) keeps the track's admin items under one entry
  // (audit SV-5): the SV's actions come first, uncluttered.
  if (own.length) {
    out.push({ kind: 'submenu', id: 'track-admin', label: 'Track options', icon: 'settings',
      title: 'Height, remove, the panel\'s tracks, settings', entries: common.filter((e): e is ContextMenuItem => e.kind === 'item') });
  } else out.push(...common);
  return out;
}

async function openSettingById(id: string): Promise<void> {
  const [{ findSetting }, { revealSetting }] = await Promise.all([import('../../utils/settingsRegistry'), import('../../utils/revealSetting')]);
  const setting = findSetting(id);
  if (setting) await revealSetting(setting);
}

/** Do a common (`track:`) or kind (`kind:`) action; false when it is neither. */
export function runTrackMenuAction(action: string, panelId: string, type: SubTrackType, at: { x: number; y: number }): boolean {
  const panel = useBrowserStore.getState().panels.find(p => p.id === panelId);
  if (!panel) return false;
  const ctx = menuContext(panel, type);
  if (action.startsWith(KIND_PREFIX)) {
    const item = kindMenuEntries(type, ctx).items.find(it => `${KIND_PREFIX}${it.id}` === action);
    if (!item) return false;
    if (item.panel) useBrowserStore.getState().openAnalysisPanel(item.panel);
    else if (item.library) openLibrary();
    item.run?.(ctx);
    return true;
  }
  switch (action) {
    case 'track:set-height': useTrackMenuStore.getState().openHeightEdit({ panelId, type, x: at.x, y: at.y }); return true;
    case 'track:remove': deleteTrack(panelId, type); return true;
    case 'track:tracks': useTrackMenuStore.getState().openPanelTracksMenu(panelId); return true;
    case 'track:export': trackKind(type).exportTrack?.(ctx); return true;
    case 'track:settings': {
      const id = trackKind(type).settingId;
      if (id) void openSettingById(id);
      return true;
    }
    default: return false;
  }
}

function TrackMenu({ menu }: { menu: OpenTrackMenu }) {
  const panel = useBrowserStore(s => s.panels.find(p => p.id === menu.panelId));
  const close = useTrackMenuStore(s => s.closeMenu);
  if (!panel) return null;
  const ctx = menuContext(panel, menu.type);
  const entries = buildTrackMenu(menu.type, ctx, menu.own);
  return (
    <ReadContextMenu<string>
      x={menu.x}
      y={menu.y}
      entries={entries}
      title={menu.title ?? getTrackLabel(menu.type)}
      label={`${getTrackLabel(menu.type)} track actions`}
      testId="track-context-menu"
      onClose={close}
      onAction={(action) => {
        if (runTrackMenuAction(action, menu.panelId, menu.type, { x: menu.x, y: menu.y })) return;
        menu.onOwn?.(action);
      }}
    />
  );
}

/** Height for a track row, typed (the drag handle does the same). */
function TrackHeightBox({ panelId, type, x, y }: { panelId: string; type: SubTrackType; x: number; y: number }) {
  const close = useTrackMenuStore(s => s.closeHeightEdit);
  const track = useBrowserStore(s => s.panels.find(p => p.id === panelId)?.subTracks.find(t => t.type === type));
  const kind = trackKind(type);
  const current = track ? rowHeight(track) : kind.defaultHeight;
  const [value, setValue] = useState(String(current));
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const rect = ref.current?.getBoundingClientRect();
    if (rect) setPos(clampMenuPosition(x, y, { width: rect.width, height: rect.height }, { width: window.innerWidth, height: window.innerHeight }));
    inputRef.current?.select();
  }, [x, y]);
  useEffect(() => {
    const onPointer = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) close(); };
    document.addEventListener('pointerdown', onPointer, true);
    return () => document.removeEventListener('pointerdown', onPointer, true);
  }, [close]);
  const apply = (px: number | null) => {
    useBrowserStore.getState().setSubTrackHeight(panelId, type, px);
    close();
  };
  const parsed = parseInt(value, 10);
  const box = (
    <div ref={ref} role="dialog" aria-label={`Height of ${getTrackLabel(type)}`} data-testid="track-height-box"
      className="fb-menu !fixed !z-[200] w-56 p-2 text-[12px]" style={{ left: pos.left, top: pos.top, right: 'auto', marginTop: 0 }}
      onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') close(); }}
      onMouseDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
      <div className="mb-1.5 font-medium">Height of {getTrackLabel(type)}</div>
      <form className="flex items-center gap-1.5" onSubmit={e => { e.preventDefault(); if (Number.isFinite(parsed)) apply(parsed); }}>
        <input ref={inputRef} type="number" min={kind.minHeight} max={kind.maxHeight} step={2} value={value}
          onChange={e => setValue(e.target.value)} aria-label="Height (px)" data-testid="track-height-input"
          className="w-20 rounded border border-line px-1.5 py-0.5 dark:border-white/15 dark:bg-dark-surface dark:text-gray-100" />
        <span className="text-ink-muted">px</span>
        <button type="button" className="fb-btn-ghost ml-auto px-2 py-0.5" data-testid="track-height-apply"
          onClick={() => { if (Number.isFinite(parsed)) apply(parsed); }}>Apply</button>
      </form>
      <div className="mt-1.5 flex items-center justify-between text-[11px] text-ink-muted">
        <span>{kind.minHeight}–{kind.maxHeight} px{Number.isFinite(parsed) && clampTrackHeight(type, parsed) !== parsed ? ` (→ ${clampTrackHeight(type, parsed)})` : ''}</span>
        <button type="button" className="underline underline-offset-2 hover:no-underline" onClick={() => apply(null)} data-testid="track-height-default">
          Default ({kind.defaultHeight})
        </button>
      </div>
    </div>
  );
  return createPortal(box, document.body);
}

/** Mount once (TrackContainer): draws the open track menu / height box. */
export function TrackContextMenuHost() {
  const menu = useTrackMenuStore(s => s.menu);
  const heightEdit = useTrackMenuStore(s => s.heightEdit);
  return (
    <>
      {menu && <TrackMenu key={`${menu.panelId}:${menu.type}:${menu.x}:${menu.y}`} menu={menu} />}
      {heightEdit && <TrackHeightBox key={`${heightEdit.panelId}:${heightEdit.type}`} {...heightEdit} />}
    </>
  );
}
