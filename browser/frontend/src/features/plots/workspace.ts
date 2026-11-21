/**
 * Which workspace fills the window: the Browser (reads), Plots or the Feature hub. A small store of its own, outside
 * the browser store, so undo never flips workspaces and a session never opens in a workspace unasked. The hub's
 * docked panel stays the "find" side; full window it is a workspace like Plots, with the same shell.
 *
 * Keys (hooks/useKeyboardShortcuts, never while typing or behind a dialog):
 * P toggles Plots, H toggles the Feature hub, Esc in a workspace goes back to the browser.
 * The full-window hub is experimental (hubWorkspaceFlag, off by default): while it is off, 'hub' is never set and H is unbound.
 */
import { create } from 'zustand';
import { useBrowserStore } from '../../stores/browserStore';
import { findOpenAnalysisPanel } from '../../plugins/registry';
import { newPlot, type PlotSpec } from './plotModel';
import { hubWorkspaceEnabled, onHubWorkspaceFlag } from './hubWorkspaceFlag';

export type WorkspaceView = 'browser' | 'plots' | 'hub';
export type PlotsTab = 'plot' | 'gallery';
export const FEATURE_HUB_PANEL = 'feature-hub';

interface WorkspaceState {
  view: WorkspaceView;
  /** Plots: the plot or the Gallery. */
  plotsTab: PlotsTab;
}

export const useWorkspaceStore = create<WorkspaceState>(() => ({ view: 'browser', plotsTab: 'plot' }));

// The flag turned off while the hub is full window: back to the browser.
onHubWorkspaceFlag(on => { if (!on && useWorkspaceStore.getState().view === 'hub') useWorkspaceStore.setState({ view: 'browser' }); });

export const plotsOpen = (): boolean => useWorkspaceStore.getState().view === 'plots';
export const hubOpen = (): boolean => useWorkspaceStore.getState().view === 'hub';
/** A workspace (Plots or the hub) covers the reads. */
export const workspaceOpen = (): boolean => useWorkspaceStore.getState().view !== 'browser';
export const setPlotsTab = (tab: PlotsTab): void => { if (useWorkspaceStore.getState().plotsTab !== tab) useWorkspaceStore.setState({ plotsTab: tab }); };

let held = 0;
/** Run `fn` with the workspace kept over the reads: a panel it opens (a Plots action running the panel's own command:
 *  Find classes, the nucleosome analysis) works behind Plots instead of taking the window. */
export function keepWorkspaceWhile<T>(fn: () => T): T {
  held++;
  try { return fn(); } finally { held--; }
}
export const workspaceHeld = (): boolean => held > 0;

export function setWorkspace(view: WorkspaceView): void {
  if (view === 'hub' && !hubWorkspaceEnabled()) view = 'browser';
  if (useWorkspaceStore.getState().view !== view) useWorkspaceStore.setState({ view });
}

/** Open Plots; with `plot`, start a new plot from it (the builder's plot is replaced, saved plots stay). */
export function openPlots(plot?: Partial<PlotSpec>): boolean {
  if (plot) {
    const s = useBrowserStore.getState();
    s.setPlotsWorkspace(ws => ({ ...ws, current: newPlot(plot) }));
  }
  setWorkspace('plots');
  return true;
}

/** Back to the browser from Plots or the hub. */
export function closePlots(): boolean {
  if (!workspaceOpen()) return false;
  setWorkspace('browser');
  return true;
}

export function togglePlots(): boolean {
  if (plotsOpen()) closePlots(); else openPlots();
  return true;
}

export function featureHubOpen(s = useBrowserStore.getState()): boolean {
  return Boolean(findOpenAnalysisPanel(s.panels, FEATURE_HUB_PANEL));
}

/** H / the toggle's Hub: the Feature hub full window, or back to the browser. */
export function toggleFeatureHub(): boolean {
  if (!hubWorkspaceEnabled()) return false;
  setWorkspace(hubOpen() ? 'browser' : 'hub');
  return true;
}

/** The docked hub panel (the "find" side), opened beside the reads. */
export function openDockedHub(): boolean {
  setWorkspace('browser');
  const s = useBrowserStore.getState();
  if (!featureHubOpen(s)) s.openAnalysisPanel(FEATURE_HUB_PANEL as Parameters<typeof s.openAnalysisPanel>[0]);
  return true;
}

export type WorkspaceKeyAction = 'toggle-plots' | 'toggle-hub' | 'back-to-browser' | 'swallow' | null;

export interface WorkspaceKeyEvent {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/** Keys that act on the reads behind a workspace (reset, scan, cluster focus, genome map, row height): inert there. */
const READ_ONLY_KEYS = new Set(['r', 'R', 's', 'S', 'g', 'G', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '[', ']', '{', '}']);

/**
 * What a key does to the workspaces (the caller has already left out typing, dialogs and keys an open menu owns).
 * null: not a workspace key (the browser's own shortcuts handle it); 'swallow': a read key, inert in Plots.
 */
export function workspaceKeyAction(e: WorkspaceKeyEvent, view: WorkspaceView): WorkspaceKeyAction {
  const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
  if (plain && (e.key === 'p' || e.key === 'P') && !e.shiftKey) return 'toggle-plots';
  if (plain && (e.key === 'h' || e.key === 'H') && !e.shiftKey && hubWorkspaceEnabled()) return 'toggle-hub';
  if (view === 'browser') return null;
  if (e.key === 'Escape' && plain) return 'back-to-browser';
  if (plain && READ_ONLY_KEYS.has(e.key)) return 'swallow';
  return null;
}

export function runWorkspaceKeyAction(action: WorkspaceKeyAction): boolean {
  switch (action) {
    case 'toggle-plots': return togglePlots();
    case 'toggle-hub': return toggleFeatureHub();
    case 'back-to-browser': return closePlots();
    case 'swallow': return true;
    default: return false;
  }
}

/** The Plots source nearest a peak rule's signal (null: a track, annotation or custom rule, not read-derived). */
export function plotsSourceOfPeakRule(source: string): string | null {
  if (source === 'accessibility' || source === 'fire' || source === 'msp' || source === 'fire_signal' || source === 'profile:fire') return 'fire';
  if (source === 'nuc') return 'nuc';
  if (source === 'tf_density') return 'tf';
  if (source === 'm6a' || source === 'profile:mod') return 'm6a';
  if (source.startsWith('layer:')) return source.slice('layer:'.length) || null;
  return null;
}
