/**
 * The per-panel track kinds (fb-n11-tracks): what each row of a dataset panel
 * is called, how tall it is by default and how far it resizes, whether it can be
 * deleted from a panel, and what its right-click menu offers. Every row gets its
 * resize handle, delete/restore, the "Tracks in this panel" entry and the common
 * right-click section from the framework (SubTrackDispatch); a kind only says
 * what is particular to it. See scratch TRACKS.md for the conventions.
 *
 * Pure (no store imports): stores clamp heights with it, and menu items name
 * the panel to open; TrackContextMenuHost resolves them.
 */
import type { PanelConfig, SubTrackConfig, SubTrackType } from '../../types';
import { declareContribution } from '../../plugins/packRegistry';
import { previewHidden } from '../../utils/previewFeatures';

export type TrackMenuIcon =
  | 'layers' | 'resize' | 'x' | 'settings' | 'download' | 'library' | 'search' | 'split' | `ext:${string}`
  | 'reads' | 'target' | 'eye' | `panel:${string}`;

export interface TrackMenuContext {
  panel: PanelConfig;
  type: SubTrackType;
  datasetId: string | null;
  stateKey: string | null;
}

export interface TrackMenuItem {
  id: string;
  label: string;
  icon: TrackMenuIcon;
  title?: string;
  disabled?: boolean;
  /** Open this analysis panel (its content type). */
  panel?: string;
  /** Open the Library. */
  library?: boolean;
  /** Anything else. */
  run?: (ctx: TrackMenuContext) => void;
  /** A Preview feature's id (utils/previewFeatures): offered only while previews are on. */
  preview?: string;
}

export interface TrackKindDef {
  /** A SubTrackType, or a prefix ending in '-' for a family ('composite-', 'ortho-'). */
  type: string;
  label: string;
  defaultHeight: number;
  minHeight: number;
  maxHeight: number;
  /** Drag handle and "Set height…" (default true). */
  resizable?: boolean;
  /** Delete from a panel / restore (default true). */
  deletable?: boolean;
  /** Offered under "Add to this panel" when a panel lacks it. */
  builtin?: boolean;
  /** When it draws ("after Find classes"): the Tracks menu says so beside a row that may be empty now. */
  shownWhen?: string;
  /** The settings-catalog id "Track settings" reveals. */
  settingId?: string;
  /** Track-specific items ("open the relevant panel"), 1–3. */
  menu?: (ctx: TrackMenuContext) => TrackMenuItem[];
  /** "Export this track…" (absent: no item). */
  exportTrack?: (ctx: TrackMenuContext) => void;
  /**
   * Where a kind added by a plugin pack goes in a panel's rows (new panels, and panels from older sessions that lack
   * it; stores/utils.ts): after the first of `after` present, else before the first of `before` present, else last.
   * `requires`: only in panels with this row (e.g. 'reads': dataset panels). Absent: the kind is not added by itself.
   */
  defaultPlacement?: { after?: string[]; before?: string[]; requires?: string };
  /** A Preview feature's row (utils/previewFeatures): not listed in "Tracks in this panel" while previews are off. */
  preview?: string;
}

const kinds = new Map<string, TrackKindDef>();
const extraMenus = new Map<string, Array<(ctx: TrackMenuContext) => TrackMenuItem[]>>();

/** Add (or replace) a track kind. Call at module load of the track's own file, or from a plugin pack's register(). */
export function registerTrackKind(def: TrackKindDef): void {
  kinds.set(def.type, def);
  if (!def.type.endsWith('-')) declareContribution('tracks', def.type);
}

/** Add items to another kind's right-click menu (a plugin pack's "Open <its panel>" on a built-in row). */
export function extendTrackMenu(type: string, items: (ctx: TrackMenuContext) => TrackMenuItem[]): void {
  extraMenus.set(type, [...(extraMenus.get(type) ?? []), items]);
}

/** A kind's menu items: its own, then the ones plugin packs added. */
export function trackMenuItems(type: SubTrackType | string, ctx: TrackMenuContext): TrackMenuItem[] {
  const kind = trackKind(type);
  return [...(kind.menu?.(ctx) ?? []), ...(extraMenus.get(kind.type) ?? []).flatMap(fn => fn(ctx))]
    .filter(item => !previewHidden(item.preview));
}

/** Whether a row type has a registered kind (a row of a plugin pack this build lacks has none). */
export function isKnownTrackType(type: string): boolean {
  if (kinds.has(type)) return true;
  for (const def of kinds.values()) if (def.type.endsWith('-') && type.startsWith(def.type)) return true;
  return false;
}

/** Kinds added by plugin packs that place themselves in a panel's rows (stores/utils.ts). */
export function placedTrackKinds(): TrackKindDef[] {
  return [...kinds.values()].filter(def => def.defaultPlacement && !def.type.endsWith('-'));
}

const FALLBACK: TrackKindDef = { type: '', label: 'Track', defaultHeight: 40, minHeight: 20, maxHeight: 600 };

/** The kind of a row: its exact type, else the longest registered prefix ('composite-…'). */
export function trackKind(type: SubTrackType | string): TrackKindDef {
  const exact = kinds.get(type);
  if (exact) return exact;
  let best: TrackKindDef | null = null;
  for (const def of kinds.values()) {
    if (def.type.endsWith('-') && type.startsWith(def.type) && (!best || def.type.length > best.type.length)) best = def;
  }
  return best ?? { ...FALLBACK, type, label: type };
}

export function isResizableTrack(type: SubTrackType | string): boolean {
  return trackKind(type).resizable !== false;
}

export function isDeletableTrack(type: SubTrackType | string): boolean {
  return trackKind(type).deletable !== false;
}

/** A height for this kind within its limits (whole px); a bad value gives the default. */
export function clampTrackHeight(type: SubTrackType | string, px: number, fallback?: number): number {
  const def = trackKind(type);
  const value = Number.isFinite(px) ? px : (fallback ?? def.defaultHeight);
  return Math.round(Math.min(def.maxHeight, Math.max(def.minHeight, value)));
}

/** A row's height: its override (clamped) or `fallback` (the kind's default when absent). */
export function rowHeight(track: Pick<SubTrackConfig, 'type' | 'heightOverride'>, fallback?: number): number {
  const base = fallback ?? trackKind(track.type).defaultHeight;
  return track.heightOverride == null ? base : clampTrackHeight(track.type, track.heightOverride, base);
}

/** Built-in kinds (offered under "Add to this panel" when missing), in their default order. */
export function builtinTrackTypes(): SubTrackType[] {
  return [...kinds.values()].filter(def => def.builtin && !def.type.endsWith('-')).map(def => def.type as SubTrackType);
}

/** Whether a row is listed now (a Preview feature's only while previews are on). */
export function isTrackListed(type: SubTrackType | string): boolean {
  return !previewHidden(trackKind(type).preview);
}

/** "Open <Panel>" for a menu (a Preview feature's panel: its id as `preview`). */
export function openPanelItem(contentType: string, label: string, title?: string, preview?: string): TrackMenuItem {
  return { id: `open-${contentType}`, label, icon: `panel:${contentType}`, panel: contentType, title, ...(preview ? { preview } : {}) };
}

const LIBRARY_ITEM: TrackMenuItem = { id: 'open-library', label: 'Library', icon: 'library', library: true, title: 'Add or remove tracks from the Library' };
const TRACKS_PANEL = openPanelItem('track-browser', 'Tracks panel', 'Every loaded track: show, hide, colour and combine');
const REGIONS = openPanelItem('circular-genome', 'Regions', 'Saved regions and search');

// --- the built-ins, in default panel order -----------------------------------

registerTrackKind({
  type: 'axis', label: 'Axis', defaultHeight: 30, minHeight: 20, maxHeight: 60, resizable: false, builtin: true,
  menu: () => [REGIONS],
});
registerTrackKind({
  type: 'fire', label: 'Peaks', defaultHeight: 50, minHeight: 24, maxHeight: 240, builtin: true,
  settingId: 'analysis.lock-peaks',
  menu: () => [
    openPanelItem('peak-detection', 'Peak Detection (scan settings)'),
    { ...REGIONS, label: 'Regions (save peaks as regions)' },
    openPanelItem('cluster-detail', 'Cluster on selected peaks', 'Open Clusters: cluster the reads on the peaks you selected'),
  ],
});
registerTrackKind({
  type: 'consensus', label: 'Footprint classes', defaultHeight: 60, minHeight: 32, maxHeight: 320, builtin: true,
  menu: () => [openPanelItem('footprint-analysis', 'Footprints panel')],
});
registerTrackKind({
  type: 'microc', label: 'Micro-C', defaultHeight: 150, minHeight: 60, maxHeight: 600, builtin: true,
  menu: () => [openPanelItem('contact-map', 'Contacts panel')],
});
registerTrackKind({
  type: 'coacc', label: 'Co-accessibility', defaultHeight: 120, minHeight: 48, maxHeight: 480, builtin: true,
  menu: () => [openPanelItem('co-accessibility', 'Co-accessibility panel')],
});
registerTrackKind({
  type: 'composite-', label: 'Track', defaultHeight: 40, minHeight: 24, maxHeight: 400,
  menu: () => [
    openPanelItem('cluster-features', 'Rules'),
    openPanelItem('colormap', 'Labeling'),
    TRACKS_PANEL,
    LIBRARY_ITEM,
  ],
});
registerTrackKind({
  type: 'ortho-', label: 'Track', defaultHeight: 40, minHeight: 24, maxHeight: 400,
  menu: () => [TRACKS_PANEL, LIBRARY_ITEM, REGIONS],
});
registerTrackKind({
  type: 'capture', label: 'Capture', defaultHeight: 30, minHeight: 20, maxHeight: 160, builtin: true,
  menu: () => [openPanelItem('capture', 'Capture Regions panel')],
});
registerTrackKind({
  type: 'primer', label: 'Primers', defaultHeight: 40, minHeight: 24, maxHeight: 200, builtin: true,
  menu: () => [openPanelItem('primer-design', 'Primers panel')],
});
registerTrackKind({
  type: 'sv', label: 'SVs', defaultHeight: 44, minHeight: 24, maxHeight: 240, builtin: true,
  settingId: 'view.sv-display',
});
registerTrackKind({
  type: 'coverage', label: 'Coverage', defaultHeight: 40, minHeight: 20, maxHeight: 240, builtin: true,
  settingId: 'view.coverage-histogram',
  menu: () => [openPanelItem('read-stats', 'Read Stats panel')],
});
registerTrackKind({
  type: 'reads', label: 'Reads', defaultHeight: 0, minHeight: 0, maxHeight: Infinity, resizable: false, deletable: false, builtin: true,
  settingId: 'view.show-reads-up-to',
});
registerTrackKind({
  type: 'sequence', label: 'Sequence', defaultHeight: 24, minHeight: 16, maxHeight: 60, builtin: true,
});
registerTrackKind({
  type: 'gene', label: 'Genes', defaultHeight: 80, minHeight: 30, maxHeight: 400, builtin: true,
  menu: () => [{ ...REGIONS, label: 'Regions and search' }],
});
// Legacy slot (old sessions): the metaprofile is a composite now.
registerTrackKind({ type: 'meta', label: 'Meta Profile', defaultHeight: 50, minHeight: 24, maxHeight: 400 });
