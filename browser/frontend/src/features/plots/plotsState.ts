/**
 * The Plots workspace's builder state (a browser-store extension, stores/storeExtensions.ts): the plot in the builder
 * and the Follow delay. Saved with the session as `frontend.plotsWorkspace`; never changes what the read lanes show
 * (refreshFree) and is never put back by undo / redo (builder edits record no steps, and opening a Gallery entry is
 * the undoable way back to a plot). Results live with the plot on screen; every plot made is kept in the Gallery
 * (gallery.ts), which has its own session key.
 *
 * Session format (version 2): plotsWorkspace: { version: 2, current: PlotSpec, openedFrom, followDelayMs: number, regionSets: RegionSet[] }
 * A session without it gets a new plot.
 */
import { registerStoreExtension } from '../../stores/storeExtensions';
import type { BrowserState } from '../../stores/browserStore';
import { normalizeRegionSet, type RegionSet } from './bedRegions';
import {
  DEFAULT_FOLLOW_DELAY_MS, MAX_FOLLOW_DELAY_MS, MIN_FOLLOW_DELAY_MS, newPlot, normalizePlot, type PlotSpec,
} from './plotModel';

export const PLOTS_WORKSPACE_VERSION = 2;

export interface PlotsWorkspaceState {
  version: number;
  /** The plot in the builder. */
  current: PlotSpec;
  /** The Gallery entry the builder plot was opened from (its versions point back to it); null: a new plot. */
  openedFrom: string | null;
  /** Follow plots recompute this long after the view stops moving (ms). */
  followDelayMs: number;
  /** BED region sets loaded (by path), for Where = BED region sets; saved with the session. */
  regionSets: RegionSet[];
}

export function emptyPlotsWorkspace(): PlotsWorkspaceState {
  return { version: PLOTS_WORKSPACE_VERSION, current: newPlot(), openedFrom: null, followDelayMs: DEFAULT_FOLLOW_DELAY_MS, regionSets: [] };
}

export function normalizeFollowDelay(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_FOLLOW_DELAY_MS;
  return Math.round(Math.min(MAX_FOLLOW_DELAY_MS, Math.max(MIN_FOLLOW_DELAY_MS, n)));
}

/** A stored workspace as state (malformed parts fall back). */
export function normalizePlotsWorkspace(raw: unknown): PlotsWorkspaceState {
  if (!raw || typeof raw !== 'object') return emptyPlotsWorkspace();
  const r = raw as Record<string, unknown>;
  return {
    version: PLOTS_WORKSPACE_VERSION,
    current: r.current ? normalizePlot(r.current) : newPlot(),
    openedFrom: typeof r.openedFrom === 'string' ? r.openedFrom : null,
    followDelayMs: normalizeFollowDelay(r.followDelayMs),
    regionSets: (Array.isArray(r.regionSets) ? r.regionSets : []).map(normalizeRegionSet).filter((x): x is RegionSet => !!x).slice(0, 20),
  };
}

declare module '../../stores/browserStore' {
  interface BrowserState {
    plotsWorkspace: PlotsWorkspaceState;
    setPlotsWorkspace: (next: PlotsWorkspaceState | ((ws: PlotsWorkspaceState) => PlotsWorkspaceState)) => void;
    /** Change the plot in the builder. */
    updateCurrentPlot: (patch: Partial<PlotSpec> | ((plot: PlotSpec) => PlotSpec)) => void;
  }
}

let registered = false;

export function registerPlotsState(): void {
  if (registered) return;
  registered = true;
  registerStoreExtension({
    id: 'plotsWorkspace',
    keys: ['plotsWorkspace'],
    refreshFree: true,
    create: set => ({
      plotsWorkspace: emptyPlotsWorkspace(),
      setPlotsWorkspace: (next: PlotsWorkspaceState | ((ws: PlotsWorkspaceState) => PlotsWorkspaceState)) =>
        set(s => ({ plotsWorkspace: typeof next === 'function' ? next(s.plotsWorkspace) : next })),
      updateCurrentPlot: (patch: Partial<PlotSpec> | ((plot: PlotSpec) => PlotSpec)) =>
        set(s => ({ plotsWorkspace: { ...s.plotsWorkspace, current: typeof patch === 'function' ? patch(s.plotsWorkspace.current) : { ...s.plotsWorkspace.current, ...patch } } })),
    }),
    serialize: (s: BrowserState) => ({ plotsWorkspace: s.plotsWorkspace }),
    // Undo / redo leave the builder alone (see above).
    restoreSnapshot: () => ({}),
    // Crash recovery is not an undo step: the autosaved builder comes back (an older save without it: left alone).
    recover: saved => (saved.plotsWorkspace ? { plotsWorkspace: normalizePlotsWorkspace(saved.plotsWorkspace) } : {}),
    importSession: frontend => ({ plotsWorkspace: normalizePlotsWorkspace(frontend?.plotsWorkspace) }),
  });
}
