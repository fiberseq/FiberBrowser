import type { BrowserState } from '../stores/browserStore';
import type { PanelConfig } from '../types';
import { safeFilenamePart } from './analysisExport';
import type { Locus } from './panelNavigation';

/**
 * Panel scope (fb-n2-scope): what a panel shows, and which panel the user is
 * working in. USE THIS instead of the main locus (`s.chrom/start/end`).
 *
 * In "Each panel navigates" (switched on by itself when a dataset is opened
 * with its own genome) the main locus stops moving: every panel has its own
 * locus box (`viewportOverride`) and the main locus is stale. Panels on
 * another assembly (`PanelConfig.genome`) always have their own locus. So
 * anything about "the view" (highlights, exports, file names, Read Stats,
 * cluster charts, Go to) must ask which panel, and read that panel's locus
 * and reference.
 *
 * API (all pure: pass the store state, e.g. `useBrowserStore.getState()`):
 *
 * - `panelView(s, panel)`: the view one panel shows: its locus (its own, else
 *   the main locus), its reference, and the other visible panels showing
 *   exactly the same view.
 * - `targetPanelView(s, target)`: `target` is a panel id (the panel an action
 *   was invoked from: its header, its read menu) or `'active'`.
 * - `activePanelId(s, invokedFrom?)` / `activePanelView(s, invokedFrom?)`:
 *   "the panel the user is working in", in this order:
 *     1. `invokedFrom`: the panel the action was invoked from (a dataset panel
 *        that exists);
 *     2. the first visible selected panel (`selectedDatasets`, panel order);
 *     3. "Each panel navigates": the panel moved last that is still where that
 *        move took it (`lastMovedPanels`, across every reference), else the
 *        first visible dataset panel;
 *     4. "Linked navigation": the main view (the first visible panel that
 *        follows it), else the first visible dataset panel;
 *     5. no dataset panel at all: the main locus (`panelId: null`).
 * - `shownPanelViews(s, { scope })`: every distinct view on screen (one per
 *   reference + locus), in panel order (none while an analysis panel is
 *   maximized; the main locus when no dataset panel is open); scope 'selection' (default) keeps the
 *   selected panels' views when panels are selected (as other scoped
 *   operations do: no selection means all panels), 'all' ignores it.
 * - `viewLocusLabel(view)`: "chr2L:6,356,793-6,357,648".
 * - `viewFileStem(views)`: a file name part for one or several views
 *   ("chr19_47514262-47519210", "chr19_47514262-47519210_plus2").
 *
 * "Visible" dataset panels: not minimized, not in a collapsed row; while a
 * panel is maximized, only it (none when it is an analysis panel).
 *
 * Requests about a view pass `genome` as `panel_genome` (null: the main
 * genome); catalogs and highlights are keyed by `genomeKey`.
 */

export type PanelScopeState = Pick<BrowserState,
  'panels' | 'chrom' | 'start' | 'end' | 'navigationMode' | 'selectedDatasets' | 'lastMovedPanels'
  | 'collapsedRows' | 'fullViewPanelId' | 'currentGenome' | 'fastaPath'>;

export interface PanelView extends Locus {
  /** The panel (null: the main locus, no dataset panel on screen). */
  panelId: string | null;
  /** The panel's own reference (PanelConfig.genome); null: the main genome. */
  genome: string | null;
  /** The reference's catalog/highlight key (registry id or FASTA name; the main genome's for null). */
  genomeKey: string;
  /** The visible dataset panels showing exactly this view (same reference and locus), the panel first. */
  panelIds: string[];
  /** It follows the main locus (a main-genome panel without a locus of its own). */
  followsMain: boolean;
}

const basename = (path: string): string => path.split(/[\\/]/).pop() || path;

/** The main genome's catalog key (services/region_detect.region_genome_key on the server). */
export function mainGenomeKey(s: Pick<BrowserState, 'currentGenome' | 'fastaPath'>): string {
  return s.currentGenome || (s.fastaPath ? basename(s.fastaPath) : '') || 'none';
}

const isDatasetPanel = (p: PanelConfig) => p.contentType === 'dataset' && !!p.datasetId;

/** The dataset panels on screen, in panel order (none while an analysis panel is maximized). */
export function visibleDatasetPanels(s: Pick<PanelScopeState, 'panels' | 'collapsedRows' | 'fullViewPanelId'>): PanelConfig[] {
  const maximized = s.fullViewPanelId ? s.panels.find(p => p.id === s.fullViewPanelId) : undefined;
  if (maximized) return isDatasetPanel(maximized) ? [maximized] : [];
  return s.panels.filter(p => isDatasetPanel(p) && !p.collapsed && !s.collapsedRows?.has(p.layoutRow ?? 0));
}

const mainLocus = (s: Pick<PanelScopeState, 'chrom' | 'start' | 'end'>): Locus => ({ chrom: s.chrom, start: s.start, end: s.end });

/** The locus a panel shows: its own, else the main locus. */
export function panelLocus(s: Pick<PanelScopeState, 'chrom' | 'start' | 'end'>, panel: PanelConfig): Locus {
  const v = panel.viewportOverride;
  return v ? { chrom: v.chrom, start: v.start, end: v.end } : mainLocus(s);
}

const viewKey = (genomeKey: string, l: Locus) => `${genomeKey}|${l.chrom}:${l.start}-${l.end}`;

/** The view one panel shows (its locus, its reference, and the visible panels showing the same). */
export function panelView(s: PanelScopeState, panel: PanelConfig): PanelView {
  const locus = panelLocus(s, panel);
  const genomeKey = panel.genome || mainGenomeKey(s);
  const key = viewKey(genomeKey, locus);
  const same = visibleDatasetPanels(s)
    .filter(p => p.id !== panel.id && viewKey(p.genome || mainGenomeKey(s), panelLocus(s, p)) === key)
    .map(p => p.id);
  return {
    ...locus,
    panelId: panel.id,
    genome: panel.genome ?? null,
    genomeKey,
    panelIds: [panel.id, ...same],
    followsMain: !panel.genome && !panel.viewportOverride,
  };
}

/** The main locus as a view (its first visible panel, if any). */
function mainView(s: PanelScopeState): PanelView {
  const panel = visibleDatasetPanels(s).find(p => !p.genome && !p.viewportOverride);
  if (panel) return panelView(s, panel);
  return { ...mainLocus(s), panelId: null, genome: null, genomeKey: mainGenomeKey(s), panelIds: [], followsMain: true };
}

const sameLocus = (a: Locus | undefined, b: Locus) => !!a && a.chrom === b.chrom && a.start === b.start && a.end === b.end;

/** The panel the user is working in (see the precedence above); null: none on screen. */
export function activePanelId(s: PanelScopeState, invokedFrom?: string | null): string | null {
  if (invokedFrom) {
    const explicit = s.panels.find(p => p.id === invokedFrom && isDatasetPanel(p));
    if (explicit) return explicit.id;
  }
  const visible = visibleDatasetPanels(s);
  if (visible.length === 0) return null;
  const selected = visible.find(p => s.selectedDatasets?.has(p.id));
  if (selected) return selected.id;
  if (s.navigationMode === 'perPanel') {
    // The move most recent across references, while the panel is still there.
    const moves = Object.values(s.lastMovedPanels ?? {}).flat().sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    for (let i = moves.length - 1; i >= 0; i--) {
      const p = visible.find(q => q.id === moves[i].panelId);
      if (p && sameLocus(p.viewportOverride, moves[i].locus)) return p.id;
    }
    return visible[0].id;
  }
  return (visible.find(p => !p.genome && !p.viewportOverride) ?? visible[0]).id;
}

/** The view of the panel the user is working in (the main locus when no dataset panel is shown). */
export function activePanelView(s: PanelScopeState, invokedFrom?: string | null): PanelView {
  const id = activePanelId(s, invokedFrom);
  const panel = id ? s.panels.find(p => p.id === id) : undefined;
  return panel ? panelView(s, panel) : mainView(s);
}

/** The selected or last-moved view of one dataset, including its split and alternative panels. */
export function datasetPanelView(s: PanelScopeState, datasetId: string): PanelView {
  return activePanelView({ ...s, panels: s.panels.filter(p => p.contentType === 'dataset' && p.datasetId === datasetId), fullViewPanelId: null });
}

/** The view of `target`: a panel id (an unknown one: the active panel's) or 'active'. */
export function targetPanelView(s: PanelScopeState, target: string | 'active'): PanelView {
  return activePanelView(s, target === 'active' ? null : target);
}

/**
 * Every distinct view on screen (one per reference + locus), in panel order.
 * `scope` 'selection': only the selected panels' when panels are selected.
 */
export function shownPanelViews(s: PanelScopeState, options: { scope?: 'selection' | 'all' } = {}): PanelView[] {
  const visible = visibleDatasetPanels(s);
  // No dataset panel at all: the main locus; dataset panels all hidden (an analysis panel maximized): none.
  if (visible.length === 0) return s.panels.some(isDatasetPanel) ? [] : [mainView(s)];
  const selected = (options.scope ?? 'selection') === 'selection' ? visible.filter(p => s.selectedDatasets?.has(p.id)) : [];
  const out: PanelView[] = [];
  const seen = new Set<string>();
  for (const panel of selected.length ? selected : visible) {
    const view = panelView(s, panel);
    const key = viewKey(view.genomeKey, view);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(view);
  }
  return out;
}

/** "chr2L:6,356,793-6,357,648". */
export function viewLocusLabel(view: Locus): string {
  return `${view.chrom}:${Math.max(0, view.start).toLocaleString('en-US')}-${view.end.toLocaleString('en-US')}`;
}

/** A file name part for one view or several ("chr19_47514262-47519210", "…_plus2"). */
export function viewFileStem(views: Locus | Locus[]): string {
  const list = Array.isArray(views) ? views : [views];
  if (list.length === 0) return 'view';
  const first = list[0];
  const stem = `${safeFilenamePart(first.chrom)}_${Math.max(0, Math.floor(first.start))}-${Math.floor(first.end)}`;
  return list.length > 1 ? `${stem}_plus${list.length - 1}` : stem;
}
