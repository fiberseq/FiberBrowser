/**
 * What plugin packs can say about dataset panels of their own kinds (ARCHITECTURE.md), and the panel moves they take
 * part in. Core asks here instead of knowing the kinds:
 *
 * - traits: a panel on a contig of its own (no reference locus: split loci don't apply), a panel kept while another
 *   dataset is open (its own dataset is rebuilt from it), a hint for the clustering reference check;
 * - view links: a panel whose view follows the main view through a mapping, and moves the main view back;
 * - split hooks: a step after "Split into panels" opened its panels, and one before a split set closes (datasets the
 *   pack built for its panels go with them, in the same undo step).
 */
import type { PanelConfig } from '../types';
import type { SerializedDataset } from '../stores/historySlice';
import { previewHidden } from './previewFeatures';

export interface PanelTraits {
  /** It shows a contig of its own, not a locus of a reference. */
  ownContig?: boolean;
  /** Kept while this dataset is open, though its own dataset isn't open yet (the pack rebuilds it). */
  keptWithDataset?: string;
  /** Added to the clustering's reference-scope message when such a panel is in the run. */
  clusterScopeHint?: string;
  /** A panel on its own contig: the way back to its reference ("Show on reference"), said where it is pinned. */
  backToReference?: { label: string; run: () => void };
}

const traitProviders: Array<(panel: PanelConfig) => PanelTraits | null | undefined> = [];

export function registerPanelTraits(provider: (panel: PanelConfig) => PanelTraits | null | undefined): void {
  traitProviders.push(provider);
}

/** A panel's traits (merged over the providers; none for a plain dataset panel). */
export function panelTraits(panel: PanelConfig | null | undefined): PanelTraits {
  if (!panel || !traitProviders.length) return {};
  const out: PanelTraits = {};
  for (const provider of traitProviders) Object.assign(out, provider(panel) ?? {});
  return out;
}

// ---------------------------------------------------------------- view links
export interface Span { chrom: string; start: number; end: number }

export interface ViewLink {
  /** The view a panel with a view of its own shows for this main view (undefined: it doesn't follow it; null: it
   * follows it, but nothing of it maps here, so it stays). */
  toPanel: (panel: PanelConfig, main: Span) => Span | null | undefined;
  /** The main view for the panel's own move (undefined: it doesn't move the main view; null: no main view for it). */
  toMain: (panel: PanelConfig, next: Span) => Span | null | undefined;
}

const viewLinks: ViewLink[] = [];
let movingPanel: string | null = null;

export function registerViewLink(link: ViewLink): void {
  viewLinks.push(link);
}

/** The view a linked panel shows for the main view (undefined: not a linked panel). */
export function linkedPanelView(panel: PanelConfig, main: Span): Span | null | undefined {
  for (const link of viewLinks) {
    const out = link.toPanel(panel, main);
    if (out !== undefined) return out;
  }
  return undefined;
}

/** The main view a linked panel's move takes the main view to (null/undefined: none). */
export function mainViewForPanel(panel: PanelConfig, next: Span): Span | null | undefined {
  for (const link of viewLinks) {
    const out = link.toMain(panel, next);
    if (out !== undefined) return out;
  }
  return undefined;
}

/** Panel-to-panel links for panels that each keep a view of their own ("Each panel navigates"): a panel's move
 * takes its linked panels along, each to its own mapped view. */
export interface PanelLink {
  followers: (panel: PanelConfig, next: Span, panels: PanelConfig[]) => { panelId: string; span: Span }[];
}
const panelLinks: PanelLink[] = [];
export function registerPanelLink(link: PanelLink): void {
  panelLinks.push(link);
}
export function panelFollowers(panel: PanelConfig, next: Span, panels: PanelConfig[]): { panelId: string; span: Span }[] {
  return panelLinks.flatMap(link => link.followers(panel, next, panels));
}

export function hasViewLinks(): boolean {
  return viewLinks.length > 0;
}

/** Run a main-view move that a linked panel's own move makes (that panel keeps its view). */
export function withLinkedPanelMoving<T>(panelId: string, fn: () => T): T {
  const before = movingPanel;
  movingPanel = panelId;
  try {
    return fn();
  } finally {
    movingPanel = before;
  }
}

/** The linked panel whose own move is moving the main view now (null: none). */
export function linkedPanelMoving(): string | null {
  return movingPanel;
}

// ---------------------------------------------------------------- split hooks
export interface SplitHooks {
  /** A Preview feature's id (utils/previewFeatures): `opened` runs only while previews are on (`closing` always: it
   * cleans up what the feature built). */
  preview?: string;
  /** After "Split into panels" opened a set (its id) from this source. */
  opened?: (groupId: string, source: { kind: string; panelId?: string }) => void | Promise<void>;
  /** Before a set's panels close: datasets a pack built for them go too (ids to drop, and what Undo reopens); null
   * when it has nothing to do for these panels (the close then stays synchronous). */
  closing?: (panels: PanelConfig[]) => Promise<{ ids: string[]; closed: SerializedDataset[] }> | null;
  /** What the split dialog says about a row's panel before it opens ("expanded insertion, own coordinates"), or null.
   * Like `opened`, only while previews are on. */
  rowNote?: (source: { kind: string; panelId?: string }, row: { groupKeys: string[]; label: string }) => string | null | undefined;
}

const splitHooks: SplitHooks[] = [];

export function registerSplitHooks(hooks: SplitHooks): void {
  splitHooks.push(hooks);
}

export async function splitOpened(groupId: string, source: { kind: string; panelId?: string }): Promise<void> {
  for (const h of splitHooks) if (!previewHidden(h.preview)) await h.opened?.(groupId, source);
}

/** What the packs say about a split row's panel before it opens (the first note wins). */
export function splitRowNote(source: { kind: string; panelId?: string }, row: { groupKeys: string[]; label: string }): string | null {
  for (const h of splitHooks) {
    if (previewHidden(h.preview)) continue;
    const note = h.rowNote?.(source, row);
    if (note) return note;
  }
  return null;
}

/** The packs' work before a split set closes, or null when none has any (the close stays synchronous). */
export function splitClosing(panels: PanelConfig[]): Promise<{ ids: string[]; closed: SerializedDataset[] }> | null {
  const pending = splitHooks.map(h => h.closing?.(panels) ?? null).filter((p): p is Promise<{ ids: string[]; closed: SerializedDataset[] }> => Boolean(p));
  if (!pending.length) return null;
  return Promise.all(pending).then(all => ({ ids: all.flatMap(r => r.ids), closed: all.flatMap(r => r.closed) }));
}
