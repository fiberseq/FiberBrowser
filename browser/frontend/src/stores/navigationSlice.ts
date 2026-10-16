import type { BrowserState } from './browserStore';
import type { PanelConfig } from '../types';
import { seedHistoryBaseline } from './historySlice';
import { withSiteLockSuppressed } from './siteLock';
import { PER_PANEL_STATE_KEYS } from './panelSlice';
import {
  matchablePanels,
  recordPanelMove,
  panelsForGenomes,
  panelsForLinkedMode,
  panelsForPerPanelMode,
  type Locus,
  type NavigationMode,
  type PanelMoves,
} from '../utils/panelNavigation';
import { formatCoordinates } from '../utils/coordinates';

export type { NavigationMode } from '../utils/panelNavigation';

/**
 * How dataset panels navigate (fb-r2-genomes, fb-r3-nav): "Linked navigation"
 * (one locus per reference: the main genome's panels follow the main nav bar,
 * the panels on another assembly move together from any of their locus boxes)
 * or "Each panel navigates" (every panel has its own locus box; the main nav
 * bar is off). See utils/panelNavigation.ts.
 */
export interface NavigationSlice {
  navigationMode: NavigationMode;
  setNavigationMode: (mode: NavigationMode) => void;
  /**
   * The moves of each link group's panels (group key, '' for the main genome),
   * most recent last: "Linked navigation" takes each group to where the one
   * moved last still is. Not saved (sessions and undo steps keep the loci).
   */
  lastMovedPanels: PanelMoves;
  /** A short note beside the navigation toggle (the mode was switched for you); not saved. */
  navigationNotice: string | null;
  setNavigationNotice: (notice: string | null) => void;
  /**
   * "Match other panels on <reference> to this location": every other dataset
   * panel on the panel's reference goes to its locus (the main view too, for a
   * main-genome panel in "Linked navigation"). Comparisons keep theirs. One undo step.
   */
  matchPanelsToPanel: (panelId: string) => void;
  /**
   * After datasets were given a reference of their own ("Open with dm6 in its
   * own panel"): "Each panel navigates", with those datasets' panels at their
   * loci, as one undo step (the reference itself stays: the server keeps it).
   */
  switchToPerPanelForOwnReference: (datasetIds: string[], loci: Record<string, Locus>, label: string) => void;
  /**
   * Panels follow their datasets' references (dataset id -> key; a dataset
   * not listed is on the main genome). `loci`: where a dataset just given a
   * reference opens. `undoLabel`: an undo point (a user action); none for a sync.
   */
  applyPanelGenomes: (
    assignments: Record<string, string>,
    options?: {
      loci?: Record<string, Locus>;
      fallback?: (genome: string) => Locus | null;
      hasChrom?: (genome: string, chrom: string) => boolean;
      undoLabel?: string;
    },
  ) => void;
}

type SetState = (partial: Partial<BrowserState> | ((state: BrowserState) => Partial<BrowserState>)) => void;

const keyOf = (p: PanelConfig) => p.stateKey ?? p.datasetId ?? p.id;
const sameLocus = (a?: { chrom: string; start: number; end: number } | null, b?: { chrom: string; start: number; end: number } | null) =>
  !!a && !!b && a.chrom === b.chrom && a.start === b.start && a.end === b.end;

/**
 * Panels now showing another locus than before leave their clusters and
 * filters behind (as a jump of the main view does). Another reference at the
 * same coordinates is another locus too (Codex audit #6): chr2L:1-1000 of dm6
 * is not that of another assembly.
 */
function clearMovedPanelState(state: BrowserState, before: PanelConfig[], after: PanelConfig[], main: { chrom: string; start: number; end: number }): Partial<BrowserState> {
  const where = (p: PanelConfig | undefined) => (p ? p.viewportOverride ?? main : null);
  const moved = new Set<string>();
  for (const p of after) {
    if (p.contentType !== 'dataset') continue;
    const old = before.find(q => q.id === p.id);
    if (old && (!sameLocus(where(old), where(p)) || (old.genome ?? null) !== (p.genome ?? null))) moved.add(keyOf(p));
  }
  if (moved.size === 0) return {};
  const out: Record<string, unknown> = {};
  for (const name of PER_PANEL_STATE_KEYS) {
    const map = (state as unknown as Record<string, Record<string, unknown>>)[name];
    if (!map) continue;
    const kept = Object.fromEntries(Object.entries(map).filter(([key]) => !moved.has(key)));
    if (Object.keys(kept).length !== Object.keys(map).length) out[name] = kept;
  }
  return out as Partial<BrowserState>;
}

/**
 * The panels just opened at their dataset's own locus on a reference count as
 * moved there (audit L2): back in "Linked navigation" their reference's group
 * goes where the dataset opened last is, not to the group's first panel.
 */
function recordOpenedAt(moves: PanelMoves, panels: PanelConfig[], loci: Record<string, Locus> | undefined, only?: Set<string>): PanelMoves {
  if (!loci) return moves;
  let out = moves;
  for (const p of panels) {
    const at = p.datasetId ? loci[p.datasetId] : undefined;
    if (!at || !p.genome || (only && !only.has(p.datasetId!)) || !sameLocus(p.viewportOverride, at)) continue;
    out = recordPanelMove(out, p, at);
  }
  return out;
}

function withUndo(get: () => BrowserState, label: string, apply: () => void) {
  seedHistoryBaseline(get(), 'Before ' + label.charAt(0).toLowerCase() + label.slice(1), 'layout');
  apply();
  get().pushSnapshot?.(label, { kind: 'layout' });
}

/**
 * The main view jumps to `to` (linked copies don't move with it); the panels
 * whose state keys are in `stay` were already there and keep their clusters
 * and filters (the jump clears the main view's).
 */
function moveMainViewKeeping(get: () => BrowserState, set: SetState, to: Locus, stay: Set<string>) {
  const kept: Record<string, Record<string, unknown>> = {};
  for (const name of PER_PANEL_STATE_KEYS) {
    const map = (get() as unknown as Record<string, Record<string, unknown>>)[name] ?? {};
    const entries = Object.entries(map).filter(([key]) => stay.has(key));
    if (entries.length) kept[name] = Object.fromEntries(entries);
  }
  withSiteLockSuppressed(() => get().setViewport(to.chrom, to.start, to.end));
  if (Object.keys(kept).length) {
    const now = get() as unknown as Record<string, Record<string, unknown>>;
    set(Object.fromEntries(Object.entries(kept).map(([name, entries]) => [name, { ...(now[name] ?? {}), ...entries }])) as Partial<BrowserState>);
  }
}

export const PER_PANEL_SWITCH_NOTICE = 'Switched to Per panel: each panel has its own locus box now. Linked moves the panels on each genome together again.';

/** "Each panel navigates": the panels and the per-panel state that goes with the switch. */
function perPanelState(state: BrowserState): Pick<BrowserState, 'navigationMode' | 'panels'> {
  const main = { chrom: state.chrom, start: state.start, end: state.end };
  return { navigationMode: 'perPanel', panels: panelsForPerPanelMode(state.panels, main) };
}

export const createNavigationSlice = (set: SetState, get: () => BrowserState): NavigationSlice => ({
  navigationMode: 'linked',
  lastMovedPanels: {},
  navigationNotice: null,
  setNavigationNotice: (notice) => set({ navigationNotice: notice }),
  setNavigationMode: (mode) => {
    const state = get();
    if (state.navigationMode === mode) return;
    const main = { chrom: state.chrom, start: state.start, end: state.end };
    withUndo(get, mode === 'perPanel' ? 'Each panel navigates' : 'Linked navigation', () => {
      if (mode === 'perPanel') {
        set({ ...perPanelState(get()), navigationNotice: null });
        return;
      }
      const before = get().panels;
      // Each reference's panels go where the one moved last is (else the first).
      const { panels, mainLocus } = panelsForLinkedMode(before, get().lastMovedPanels);
      // Panels that were elsewhere than where their group goes keep no clusters/filters from there.
      set({ navigationMode: mode, navigationNotice: null, panels, ...clearMovedPanelState(get(), before, panels, mainLocus ?? main) });
      // The main view goes where that main-genome panel was (the reads stay on
      // screen); a jump, so linked copies don't move with it.
      if (mainLocus && (mainLocus.chrom !== main.chrom || mainLocus.start !== main.start || mainLocus.end !== main.end)) {
        // The panels that were already there keep their clusters and filters
        // (the jump clears the main view's).
        const stay = new Set(before.filter(p => p.navOwn && !p.genome && sameLocus(p.viewportOverride, mainLocus)).map(keyOf));
        moveMainViewKeeping(get, set, mainLocus, stay);
      }
    });
  },
  matchPanelsToPanel: (panelId) => {
    const state = get();
    const source = state.panels.find(p => p.id === panelId);
    if (!source || source.contentType !== 'dataset') return;
    const main = { chrom: state.chrom, start: state.start, end: state.end };
    const at: Locus = { ...(source.viewportOverride ?? main) };
    const others = matchablePanels(state.panels, source);
    const ids = new Set(others.filter(p => p.viewportOverride).map(p => p.id));
    // A main-genome panel in "Linked navigation": the main view (its panels) goes there too.
    const moveMain = !source.genome && !!source.viewportOverride && state.navigationMode === 'linked'
      && others.some(p => !p.viewportOverride) && !sameLocus(main, at);
    if (!moveMain && !others.some(p => ids.has(p.id) && !sameLocus(p.viewportOverride, at))) return;
    const where = formatCoordinates(at.chrom, at.start, at.end);
    withUndo(get, `Match panels to ${where}`, () => {
      if (moveMain) {
        // The panels already there keep their clusters and filters.
        const stay = new Set([source, ...others].filter(p => p.viewportOverride && sameLocus(p.viewportOverride, at)).map(keyOf));
        moveMainViewKeeping(get, set, at, stay);
      }
      const now = get();
      const panels = now.panels.map(p => (ids.has(p.id) && !sameLocus(p.viewportOverride, at) ? { ...p, viewportOverride: { ...at } } : p));
      set({
        panels,
        lastMovedPanels: recordPanelMove(now.lastMovedPanels, source, at),
        // Those now elsewhere leave their clusters and filters behind (the main view's jump cleared its own).
        ...clearMovedPanelState(now, now.panels, panels, { chrom: now.chrom, start: now.start, end: now.end }),
      });
    });
  },
  switchToPerPanelForOwnReference: (datasetIds, loci, label) => {
    const state = get();
    if (state.navigationMode === 'perPanel') return;
    const wanted = new Set(datasetIds);
    withUndo(get, label, () => {
      const before = get().panels;
      const next = perPanelState(get());
      // The datasets just given their reference open at their own best-covered locus.
      const panels = next.panels.map(p => (p.datasetId && wanted.has(p.datasetId) && p.genome && p.navOwn && loci[p.datasetId]
        && !sameLocus(p.viewportOverride, loci[p.datasetId]) ? { ...p, viewportOverride: { ...loci[p.datasetId] } } : p));
      const main = { chrom: state.chrom, start: state.start, end: state.end };
      set({
        ...next, panels, navigationNotice: PER_PANEL_SWITCH_NOTICE, ...clearMovedPanelState(get(), before, panels, main),
        lastMovedPanels: recordOpenedAt(get().lastMovedPanels, panels, loci, wanted),
      });
    });
  },
  applyPanelGenomes: (assignments, options = {}) => {
    const state = get();
    const panels: PanelConfig[] = panelsForGenomes(state.panels, assignments, {
      loci: options.loci,
      main: { chrom: state.chrom, start: state.start, end: state.end },
      mode: state.navigationMode,
      fallback: options.fallback,
      hasChrom: options.hasChrom,
    });
    if (panels === state.panels) return;
    const main = { chrom: state.chrom, start: state.start, end: state.end };
    const apply = () => set({
      panels, ...clearMovedPanelState(get(), state.panels, panels, main),
      lastMovedPanels: recordOpenedAt(get().lastMovedPanels, panels, options.loci),
    });
    if (options.undoLabel) withUndo(get, options.undoLabel, apply);
    else apply();
  },
});
