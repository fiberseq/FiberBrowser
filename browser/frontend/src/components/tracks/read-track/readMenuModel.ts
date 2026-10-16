/**
 * What the right-click menu on reads offers (fb-r4-clicks). A plain click or
 * drag on reads pans; Shift+click selects a read and ⌘/Ctrl+click a
 * footprint; everything else one can do to a read or a footprint is here.
 * Pure: ReadContextMenu draws the items, useReadMenuActions does them.
 */
import { previewHidden } from '../../../utils/previewFeatures';

export type ReadMenuAction =
  | 'select-read'
  | 'select-footprint'
  | 'open-read-stats'
  | 'copy-read-name'
  | 'copy-read-locus'
  | 'highlight-read'
  | 'clear-highlight'
  | 'zoom-to-read'
  | 'copy-selected-names'
  | 'keep-selected'
  | 'exclude-selected'
  | 'clear-read-filter'
  | 'show-excluded'
  | 'clear-selection'
  | 'find-read-by-name'
  | 'zoom-in-here'
  | 'zoom-out'
  | 'copy-view-locus'
  | 'copy-position'
  // Structural variants (fb-n9-sv)
  | 'sv-split-this'
  | 'sv-split-at-cursor'
  // ...straight into one panel per allele group (Carriers / Reference / Not informative)
  | 'sv-split-this-panels'
  | 'sv-split-at-cursor-panels'
  | 'sv-highlight-supporting'
  | 'sv-copy-inserted'
  | 'sv-clear-split'
  | 'sv-split-panels'
  // Items plugin packs add (registerReadMenuContribution): `ext:<id>`, done by the contribution's `run`.
  | `ext:${string}`;

export type ReadMenuIcon =
  | 'reads' | 'footprint' | 'stats' | 'copy' | 'pin' | 'target' | 'zoom-in' | 'zoom-out'
  | 'filter' | 'eye' | 'eye-off' | 'x' | 'search' | 'clipboard' | 'split'
  // a panel's icon, or one a plugin pack registered (ReadContextMenu registerMenuIcon)
  | `panel:${string}` | `ext:${string}`;

export interface ReadMenuItem {
  kind: 'item';
  action: ReadMenuAction;
  label: string;
  icon: ReadMenuIcon;
  /** The click that does the same (shown on the right). */
  shortcut?: string;
  disabled?: boolean;
  title?: string;
  /** A Preview feature's item: drawn with its Preview badge. */
  preview?: string;
}

export interface ReadMenuSeparator { kind: 'separator' }
export interface ReadMenuHeading { kind: 'heading'; label: string }
/** A group of items under one entry, shown below it when opened (Enter, Arrow right or a click). */
export interface ReadMenuSubmenu<I = ReadMenuItem> { kind: 'submenu'; id: string; label: string; icon: string; title?: string; disabled?: boolean; entries: I[] }
export type ReadMenuEntry = ReadMenuItem | ReadMenuSeparator | ReadMenuHeading;

export interface ReadMenuContext {
  /** The read under the cursor (null: empty track space). */
  readId: string | null;
  /** The footprint under the cursor on that read. */
  footprint: { label: string } | null;
  readSelected: boolean;
  /** Reads selected in this panel. */
  selectedCount: number;
  /** The panel has a read-ID filter (Keep only, or an analysis's). */
  hasReadFilter: boolean;
  /** Reads hidden in this panel by Exclude. */
  excludedCount: number;
  /** Why Keep only / Exclude can't apply here (a linked pair panel); absent: they can. */
  filtersUnavailable?: string;
  /** This read is highlighted. */
  readHighlighted: boolean;
  /** SV items (fb-n9-sv): the SV under the pointer on this read, the cluster at the cursor, the SV band. */
  sv?: ReadMenuSv;
  /** Any read is highlighted. */
  anyHighlight: boolean;
  isMac: boolean;
  /** The panel shows BAM reads of its own (not a linked pair panel): plugin packs' read items may apply. */
  bamReads?: boolean;
}

export interface ReadMenuSv {
  /** "DEL 1.5 kb": an SV event of the read under the pointer. */
  thisEvent?: string | null;
  /** The read's event is an insertion (its bases can be copied). */
  thisInsertion?: boolean;
  /** "DEL 1.5 kb, 13/21": the largest-support cluster at the cursor. */
  atCursor?: string | null;
  /** This panel's reads are split by an SV allele. */
  splitActive?: boolean;
  /** Why Split into panels can't start here (a split panel: the split comes from its whole panel). */
  splitPanelsBlocked?: string;
}

/** What the SV track's menu is opened on (the SV row's own items). */
export interface SvClusterMenuContext {
  /** "DEL 1.5 kb, 13/21" (null: no cluster under the pointer). */
  cluster: string | null;
  insertion: boolean;
  splitActive: boolean;
  splitAllowed: boolean;
  splitPanelsBlocked?: string;
  /** The panel shows BAM reads of its own (not a linked pair panel). */
  bamReads?: boolean;
}

/**
 * Items a plugin pack adds to the read menu and the SV row's menu. Each item's action is `ext:<id>`; the pack's
 * `run` does it with the menu's target (ReadMenuRunContext).
 */
export interface ReadMenuContribution {
  id: string;
  /** A Preview feature's id (utils/previewFeatures): its items, hints and notes only while previews are on. */
  preview?: string;
  /** Items on the reads, after the SV section (a separator follows them). */
  readItems?: (ctx: ReadMenuContext) => ReadMenuEntry[];
  /** Items on an SV cluster of the SV row, after "Highlight supporting reads". */
  svClusterItems?: (sv: SvClusterMenuContext) => ReadMenuEntry[];
  /** A few words the SV row's hover card adds to "Right-click: group or split the reads by it" for a cluster (its item's name). */
  svHint?: (cluster: { t: string }) => string | null;
  /** Said after "Split into panels by this SV"'s tooltip (what the pack does to such a split). */
  splitPanelsNote?: string;
  run: (action: string, ctx: ReadMenuRunContext) => void | Promise<void>;
}

/** What an item of a plugin pack acts on. */
export interface ReadMenuRunContext {
  datasetId: string;
  chrom: string;
  stateKey: string;
  /** The panel the menu is in (when known). */
  panelId?: string;
  /** The genomic position under the pointer (the read menu). */
  genomePos?: number;
  /** SV clusters: the one of the read's own event, the one at the cursor (the read menu), or the SV row's. */
  svClusters: Array<{ t: 'D' | 'I' | string; ref: number; len: number } | null | undefined>;
  say: (text: string) => void;
}

const registered: ReadMenuContribution[] = [];
/** The contributions offered now (a Preview feature's only while previews are on). */
const shown = (): ReadMenuContribution[] => registered.filter(c => !previewHidden(c.preview));

export function registerReadMenuContribution(contribution: ReadMenuContribution): void {
  const at = registered.findIndex(c => c.id === contribution.id);
  if (at >= 0) registered[at] = contribution;
  else registered.push(contribution);
}

/** The contribution an `ext:` action belongs to. */
function contributionFor(action: string): ReadMenuContribution | undefined {
  return shown().find(c => action === `ext:${c.id}` || action.startsWith(`ext:${c.id}:`));
}

/** Do a plugin pack's item (false: not one). */
export function runReadMenuContribution(action: string, ctx: ReadMenuRunContext): boolean {
  if (!action.startsWith('ext:')) return false;
  const contribution = contributionFor(action);
  if (!contribution) return false;
  void contribution.run(action, ctx);
  return true;
}

/** The plugin packs' words for an SV cluster's hover card. */
export function svClusterHints(cluster: { t: string }): string[] {
  return shown().map(c => c.svHint?.(cluster)).filter((h): h is string => Boolean(h));
}

/**
 * The SV track's own items (fb-n9-sv; the SV summary is its own track since
 * fb-n11-tracks): on a cluster ("DEL 1.5 kb, 13/21"), faint ones included.
 */
export function svClusterMenu(sv: SvClusterMenuContext): ReadMenuEntry[] {
  const entries: ReadMenuEntry[] = [];
  if (sv.cluster) {
    entries.push({ kind: 'heading', label: sv.cluster });
    if (sv.splitAllowed) {
      entries.push(
        item('sv-split-this', 'Group in this panel by this SV', 'split', { title: 'Group the reads in view in this panel: carriers, reference, not informative' }),
        item('sv-split-this-panels', 'Split into panels by this SV', 'split', sv.splitPanelsBlocked
          ? { disabled: true, title: sv.splitPanelsBlocked } : { title: splitPanelsTitle() }),
      );
    }
    entries.push(item('sv-highlight-supporting', 'Highlight supporting reads', 'pin'));
    for (const c of shown()) entries.push(...(c.svClusterItems?.(sv) ?? []));
  }
  if (sv.splitActive) entries.push(item('sv-split-panels', 'Split into panels (carriers, reference…)', 'split', sv.splitPanelsBlocked
    ? { disabled: true, title: sv.splitPanelsBlocked } : { title: 'One read panel per SV allele group, to cluster them together and compare' }), item('sv-clear-split', 'Clear SV split', 'x'));
  return entries;
}

/** Why a split panel can't be split into panels again. */
export const SPLIT_IN_SPLIT = 'This is a split panel: close the split (Split ×) and split the whole panel, or use Group in this panel here';

const SPLIT_PANELS_BASE = 'One read panel per allele group (Carriers, Reference, Not informative), side by side';
/** "Split into panels by this SV"'s tooltip (with what plugin packs add to such a split). */
const splitPanelsTitle = (): string => [SPLIT_PANELS_BASE, ...shown().map(c => c.splitPanelsNote).filter(Boolean)].join('; ');

/** A menu item (exported for plugin packs' contributions). */
export const item = (action: ReadMenuAction, label: string, icon: ReadMenuIcon, extra: Partial<ReadMenuItem> = {}): ReadMenuItem =>
  ({ kind: 'item', action, label, icon, ...extra });
const SEP: ReadMenuSeparator = { kind: 'separator' };

export function buildReadMenu(ctx: ReadMenuContext): ReadMenuEntry[] {
  const mod = ctx.isMac ? '⌘' : 'Ctrl';
  const entries: ReadMenuEntry[] = [];
  const n = ctx.selectedCount;
  const countLabel = n > 0 ? ` (${n.toLocaleString()})` : '';

  if (ctx.readId) {
    entries.push(
      item('select-read', ctx.readSelected ? 'Deselect read' : 'Select read', 'reads', { shortcut: '⇧-click' }),
      item('select-footprint', ctx.footprint ? `Select footprint (${ctx.footprint.label})` : 'Select footprint', 'footprint', {
        shortcut: `${mod}-click`,
        disabled: !ctx.footprint,
        title: ctx.footprint ? undefined : 'No footprint under the cursor on this read',
      }),
      item('open-read-stats', 'Open in Read Stats', 'stats'),
      SEP,
      item('copy-read-name', 'Copy read name', 'copy'),
      item('copy-read-locus', 'Copy locus of read', 'clipboard'),
      ctx.readHighlighted
        ? item('clear-highlight', 'Remove highlight', 'x')
        : item('highlight-read', 'Highlight read in all panels', 'pin'),
      item('zoom-to-read', 'Zoom to read', 'target'),
      SEP,
    );
  } else {
    entries.push(
      item('find-read-by-name', 'Go to a read by name…', 'search', {
        title: 'Paste a read name (or several, comma separated) into the locus box and press Enter',
      }),
      item('zoom-in-here', 'Zoom in here', 'zoom-in'),
      item('zoom-out', 'Zoom out', 'zoom-out'),
      item('copy-view-locus', 'Copy locus of view', 'clipboard'),
      item('copy-position', 'Copy position', 'copy'),
      SEP,
    );
    if (ctx.anyHighlight) entries.push(item('clear-highlight', 'Remove highlight', 'x'));
  }

  const sv = ctx.sv;
  if (sv && (sv.thisEvent || sv.atCursor || sv.splitActive)) {
    if (sv.thisEvent) {
      entries.push(item('sv-split-this', `Group in this panel by this SV (${sv.thisEvent})`, 'split', {
        title: 'Group the reads in view in this panel: carriers, reference (span it without it), not informative',
      }));
      entries.push(item('sv-split-this-panels', `Split into panels by this SV (${sv.thisEvent})`, 'split',
        sv.splitPanelsBlocked ? { disabled: true, title: sv.splitPanelsBlocked } : { title: splitPanelsTitle() }));
      if (sv.thisInsertion) entries.push(item('sv-copy-inserted', 'Copy inserted sequence', 'copy'));
    }
    if (sv.atCursor) {
      entries.push(item('sv-split-at-cursor', `Group in this panel by SV at cursor (${sv.atCursor})`, 'split', {
        title: 'The SV with the most supporting reads under the pointer',
      }));
      entries.push(item('sv-split-at-cursor-panels', `Split into panels by SV at cursor (${sv.atCursor})`, 'split',
        sv.splitPanelsBlocked ? { disabled: true, title: sv.splitPanelsBlocked } : { title: splitPanelsTitle() }));
    }
    if (sv.splitActive) entries.push(item('sv-split-panels', 'Split into panels (carriers, reference…)', 'split', sv.splitPanelsBlocked
      ? { disabled: true, title: sv.splitPanelsBlocked } : { title: 'One read panel per SV allele group, to cluster them together and compare' }), item('sv-clear-split', 'Clear SV split', 'x'));
    entries.push(SEP);
  }

  // Items plugin packs add (registerReadMenuContribution).
  const extra = shown().flatMap(c => c.readItems?.(ctx) ?? []);
  if (extra.length) entries.push(...extra, SEP);

  entries.push(
    item('copy-selected-names', `Copy names of selected reads${countLabel}`, 'copy', {
      disabled: n === 0, title: n === 0 ? 'Shift+click reads to select them' : undefined,
    }),
    item('keep-selected', `Keep only selected reads${countLabel}`, 'filter', {
      disabled: n === 0 || Boolean(ctx.filtersUnavailable), title: ctx.filtersUnavailable,
    }),
    item('exclude-selected', `Exclude selected reads${countLabel}`, 'eye-off', {
      disabled: n === 0 || Boolean(ctx.filtersUnavailable), title: ctx.filtersUnavailable,
    }),
  );
  if (n > 0) entries.push(item('clear-selection', 'Clear read selection', 'x'));
  if (ctx.hasReadFilter) entries.push(item('clear-read-filter', 'Show all reads (clear read filter)', 'eye'));
  if (ctx.excludedCount > 0) entries.push(item('show-excluded', `Show excluded reads (${ctx.excludedCount.toLocaleString()})`, 'eye'));
  return entries;
}

/** Items one can act on (keyboard navigation skips separators, headings and disabled items). */
export function actionableIndices(entries: ReadonlyArray<{ kind: string; disabled?: boolean }>): number[] {
  return entries.flatMap((e, i) => ((e.kind === 'item' || e.kind === 'submenu') && !e.disabled ? [i] : []));
}

/** The menu's position: at the pointer, kept inside the window. */
export function clampMenuPosition(
  x: number, y: number, menu: { width: number; height: number }, viewport: { width: number; height: number }, margin = 4,
): { left: number; top: number } {
  const left = Math.max(margin, Math.min(x, viewport.width - menu.width - margin));
  const top = y + menu.height + margin > viewport.height
    ? Math.max(margin, y - menu.height)  // above the pointer when it would run off the bottom
    : y;
  return { left, top };
}
