import { copyPanelAtSite } from '../utils/panelCopies';
import { previewHidden } from '../utils/previewFeatures';
import { mainViewForPanel, panelFollowers, withLinkedPanelMoving } from '../utils/panelExtensions';
import { isPublicServerPage } from '../utils/publicServerFlag';
import { revealDrawerPanel } from './drawerTabsStore';
import type { BrowserState } from './browserStore';
import type { PanelConfig, SubTrackConfig, SubTrackType, PanelLayout, PanelContentType, AnalysisPanelType } from '../types';
import { canonicalPanelType, getAnalysisPanel, isAnalysisPanel, normalizeAnalysisPanelContentTypes } from '../plugins/registry';
import { generatePanelId, createDefaultSubTracks, createGenomeSubTracks, restoreBuiltinAt } from './utils';
import { restoreOrphanSplitSources } from './splitSources';
import { restoreOrphanGraphMembers, withoutGraphFold, withoutGraphMembership } from './graphMembership';
import { clampTrackHeight, isDeletableTrack } from '../components/tracks/trackRegistry';
import { isPanOrZoom, moveLikewise, withSiteLockSuppressed } from './siteLock';
import { seedHistoryBaseline } from './historySlice';
import { canLinkToMainView, inComparisonGroup, isMainViewPanel, linkGroupPeers, recordPanelMove } from '../utils/panelNavigation';
import { forgetRememberedState } from '../hooks/useRememberedState';
import { isStacked, sideBySide, stackBelow, stackTarget, type PanelArrangement } from './panelArrangement';
import { isLiveLift } from '../utils/datasetKinds';

/** Analysis state kept per panel (keyed by stateKey ?? datasetId). */

const PANEL_DOCK_STORAGE_PREFIX = 'fiberbrowser_panel_dock_';
/** Where the user last docked a kind of analysis panel ('side' or 'beside'). */
export function rememberedPanelDock(contentType: string): 'side' | 'beside' | null {
  try {
    const value = localStorage.getItem(PANEL_DOCK_STORAGE_PREFIX + contentType);
    return value === 'side' || value === 'beside' ? value : null;
  } catch {
    return null;
  }
}
function rememberPanelDock(contentType: string, dock: 'side' | 'beside'): void {
  try { localStorage.setItem(PANEL_DOCK_STORAGE_PREFIX + contentType, dock); } catch { /* not remembered */ }
}

export const PER_PANEL_STATE_KEYS = [
  'clusterAssignments', 'clusterOrder', 'selectedClusters', 'readSortOrder', 'clusterProfiles',
  'filteredReadIds', 'readFilterSources', 'clusterFocus', 'readStateDetails', 'selectedReadIds',
  'svSplits', 'clusterGroupLabels', 'svCarrierEvidence', 'svSelectedCluster',
] as const;

const panelNavigationLabel = (chrom: string, start: number) => `Panel to ${chrom}:${Math.max(0, Math.floor(start)).toLocaleString()}`;

/** Undo point before and after a panel-view action. */
function withUndo(get: () => BrowserState, label: string, apply: () => void, coalesceKey?: string) {
  seedHistoryBaseline(get(), 'Before ' + label.charAt(0).toLowerCase() + label.slice(1), 'layout');
  apply();
  get().pushSnapshot?.(label, { kind: 'layout', coalesceKey });
}

/** A panel's pans/zooms this close together are one undo step (the main view's settle after 500 ms). */
const PANEL_NAVIGATION_COALESCE_MS = 750;

/** Panels linked to `panel` that keep views of their own follow its move, and theirs follow them (a source view moves
 * its graph host, which moves the host's other source views), each panel at most once. */
function moveLinkedFollowers(get: () => BrowserState, panel: PanelConfig, span: { chrom: string; start: number; end: number }) {
  const moved = new Set([panel.id]);
  let wave = [{ panel, span }];
  while (wave.length) {
    const next: typeof wave = [];
    for (const w of wave) {
      for (const f of panelFollowers(w.panel, w.span, get().panels)) {
        if (moved.has(f.panelId)) continue;
        moved.add(f.panelId);
        get().setPanelViewportFromLink(f.panelId, f.span);
        const p = get().panels.find(x => x.id === f.panelId);
        if (p) next.push({ panel: p, span: f.span });
      }
    }
    wave = next;
  }
}

const panelKey = (panel: PanelConfig) => panel.stateKey ?? panel.datasetId ?? panel.id;

/**
 * Panel selections without panels that are gone: a selection made only of
 * closed panels would leave analysis targeting nothing.
 */
function pruneSelections(state: BrowserState, panels: PanelConfig[]): Pick<BrowserState, 'selectedDatasets' | 'selectedPanelIds'> {
  const ids = new Set(panels.map(p => p.id));
  const prune = (sel: Set<string>) => ([...sel].every(id => ids.has(id)) ? sel : new Set([...sel].filter(id => ids.has(id))));
  return { selectedDatasets: prune(state.selectedDatasets), selectedPanelIds: prune(state.selectedPanelIds) };
}

/**
 * The next link group id no panel uses yet, with the counter after it. Panels
 * restored from a session or snapshot carry their own groups (link-1, ...)
 * that the counter never saw.
 */
function freshLinkGroup(state: BrowserState): { groupId: string; nextLinkGroupId: number } {
  const used = new Set(state.panels.map(p => p.linkGroup).filter(Boolean));
  let n = Math.max(1, state.nextLinkGroupId);
  while (used.has(`link-${n}`)) n += 1;
  return { groupId: `link-${n}`, nextLinkGroupId: n + 1 };
}

/** Drop one panel's analysis state (it moved somewhere else). */
function clearPanelState(state: BrowserState, key: string): Partial<BrowserState> {
  const out: Record<string, unknown> = {};
  for (const name of PER_PANEL_STATE_KEYS) {
    const map = (state as unknown as Record<string, Record<string, unknown>>)[name];
    if (map && key in map) {
      const { [key]: _dropped, ...rest } = map;
      out[name] = rest;
    }
  }
  return out as Partial<BrowserState>;
}

/**
 * A panel switching to other reads (one strand) gets state of its own: a key
 * shared with another panel of the dataset is left to that panel and this one
 * takes a fresh key; its own key is cleared. Dynamic reassignment and an active
 * cluster branch are for the reads clustered before, so they stop too.
 */
function isolatePanelState(state: BrowserState, panel: PanelConfig): { stateKey?: string; reset: Partial<BrowserState> } {
  const key = panelKey(panel);
  const shared = state.panels.some(p => p.id !== panel.id && p.contentType === 'dataset' && panelKey(p) === key);
  return {
    ...(shared ? { stateKey: panel.id } : {}),
    reset: {
      ...(shared ? {} : clearPanelState(state, key)),
      ...(state.activeClusterTreeNodeId ? { activeClusterTreeNodeId: null } : {}),
      ...(state.dynamicClustering ? { dynamicClustering: false } : {}),
    },
  };
}

const HIDDEN_STRIP_PANELS_STORAGE_KEY = 'fiberhmm_hidden_strip_panels';

function loadHiddenStripPanels(): Set<string> {
  try {
    const raw = localStorage.getItem(HIDDEN_STRIP_PANELS_STORAGE_KEY);
    if (!raw) return new Set<string>();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set<string>();
    return new Set(parsed.filter((value): value is string => typeof value === 'string').map(value => canonicalPanelType(value)));
  } catch {
    return new Set<string>();
  }
}

function persistHiddenStripPanels(hidden: Set<string>) {
  localStorage.setItem(HIDDEN_STRIP_PANELS_STORAGE_KEY, JSON.stringify([...hidden]));
}

export interface NavigatorRegion {
  id: string;
  chrom: string;
  start: number;
  end: number;
  label: string;
  source: 'manual' | 'contact' | 'haplotype' | 'navigator';
  datasetIds?: string[];
  groupId?: string;
}

// ============================================================
// PANEL SLICE — Interface
// ============================================================

export interface PanelSlice {
  slotOrder: string[];  // maintained by datasetSlice for dataset ordering
  openAnalysisPanel: (type: AnalysisPanelType) => void;
  closeAnalysisPanel: (id: string) => void;
  reorderSlots: (fromIndex: number, toIndex: number) => void;
  openContactRegions: (selection: { chrom: string; x_start: number; x_end: number; y_start: number; y_end: number; y_chrom?: string; contact_mode?: 'dafc' | 'microc'; read_ids?: string[] }) => void;
  closeContactRegions: () => void;
  /**
   * Two views of the same coordinates on two chromosomes (haplotypes). By
   * default every open dataset is shown on both; datasets1/datasets2 choose
   * each view's datasets instead (e.g. one sample per haplotype).
   */
  openHaplotypeComparison: (params: {
    chrom1: string; chrom2: string; start: number; end: number;
    datasets1?: string[]; datasets2?: string[];
  }) => void;
  closeHaplotypeComparison: () => void;
  openGenomeRegionViews: (regions: Array<{ chrom: string; start: number; end: number; label?: string; datasetIds?: string[] }>) => void;

  // Dataset panels — independent panel system
  panels: PanelConfig[];
  fullViewPanelId: string | null;
  editMode: boolean;
  nextLinkGroupId: number;
  selectedPanelIds: Set<string>;  // For shift-click selection of panels to link
  dismissedPanelTypes: Set<string>;  // Panel types explicitly closed by user (suppresses auto-open)
  hiddenStripPanels: Set<string>;   // Panel contentTypes hidden from the analysis strip

  // Row layout
  collapsedRows: Set<number>;        // Which layout rows are collapsed
  analysisStripCollapsed: boolean;   // Whether the analysis strip is collapsed
  navigatorRegions: NavigatorRegion[]; // Independent region channel used by Genome Navigator

  // Strip visibility
  toggleStripPanel: (contentType: string) => void;
  setHiddenStripPanels: (contentTypes: Iterable<string>) => void;
  addNavigatorRegion: (region: Omit<NavigatorRegion, 'id'> & { id?: string }) => void;
  updateNavigatorRegion: (id: string, updates: Partial<Omit<NavigatorRegion, 'id'>>) => void;
  removeNavigatorRegion: (id: string) => void;
  clearNavigatorRegions: () => void;

  // Panel CRUD
  addPanel: (datasetId: string) => string;
  removePanel: (panelId: string) => void;
  setPanelReversed: (panelId: string, reversed: boolean) => void;
  /**
   * A linked panel's view set by its link (a lift map's exact correction, a jump to a source insertion): only that
   * panel's own view. It maps nothing back to the main view, moves no link-group peers and records no undo step.
   */
  setPanelViewportFromLink: (panelId: string, view: { chrom: string; start: number; end: number }) => void;
  duplicatePanel: (panelId: string) => string;

  // Panel config
  setPanelCollapsed: (panelId: string, collapsed: boolean) => void;
  setPanelDataset: (panelId: string, datasetId: string) => void;
  setPanelLayout: (panelId: string, layout: PanelLayout) => void;

  // Sub-track management (with link-group propagation)
  toggleSubTrack: (panelId: string, trackType: SubTrackType, panelOnly?: boolean) => void;
  removeSubTrack: (panelId: string, trackType: SubTrackType) => void;
  /** Px within the kind's limits; null = its default height. */
  setSubTrackHeight: (panelId: string, trackType: SubTrackType, height: number | null) => void;
  /** Put a deleted track back (or add a built-in the panel lacks) at its place. */
  restoreSubTrack: (panelId: string, trackType: SubTrackType) => void;
  reorderSubTracks: (panelId: string, fromIndex: number, toIndex: number) => void;

  // Panel viewport (for split-view panels with viewportOverride)
  setPanelViewport: (panelId: string, start: number, end: number) => void;
  setPanelIndependent: (panelId: string, independent: boolean) => void;
  navigatePanel: (panelId: string, chrom: string, start: number, end: number) => void;
  /** navigatePanel without moving the main view through a view link. */
  navigatePanelOwnView: (panelId: string, chrom: string, start: number, end: number) => void;
  /**
   * Copy a dataset panel next to itself with its own navigation; returns the
   * copy's id. `linked` (the header's +): it moves with the main view until
   * unlinked; otherwise its location box takes focus.
   */
  openPanelAtSite: (panelId: string, options?: { linked?: boolean }) => string;
  setPanelSiteLocked: (panelId: string, locked: boolean) => void;
  /** DAF-seq: show only one strand's reads in this panel (null: both). */
  setPanelStrand: (panelId: string, strand: 'CT' | 'GA' | null) => void;
  /** DAF-seq: this panel shows CT and a copy next to it shows GA; returns the GA panel's id. */
  splitPanelByStrand: (panelId: string) => string;
  /** Live lift: one panel per haplotype label (the source panel keeps the first); returns the new panels' ids. */
  splitPanelByLiftHap: (panelId: string, labels: string[]) => string[];
  /** Live lift: the dataset's haplotype panels back to one pooled panel. */
  poolLiftHapPanels: (datasetId: string, panelId?: string) => void;
  /** DAF-seq: a copy of this panel showing `strand`, next to it. */
  addStrandPanel: (panelId: string, strand: 'CT' | 'GA') => string;
  /** Panel whose location box should take focus once it renders (a new copy at another locus). */
  pendingPanelLocationFocus: string | null;
  clearPendingPanelLocationFocus: () => void;

  // Panel sizing
  setPanelWidthFraction: (panelId: string, fraction: number) => void;

  // Link groups
  togglePanelLink: (panelId: string) => void;
  linkPanels: (panelIds: string[]) => void;
  unlinkPanel: (panelId: string) => void;

  // Row layout actions
  setPanelRow: (panelId: string, row: number) => void;
  movePanelToRow: (panelId: string, targetRow: number, insertIndex?: number) => void;
  insertPanelAsNewRow: (panelId: string, afterRowIndex: number) => void;
  stackPanelBelow: (panelId: string, targetPanelId: string) => void;
  /** Stack a panel below its neighbour column's, or give it a column of its own (undoable). */
  arrangePanel: (panelId: string, arrangement: PanelArrangement) => void;
  toggleRowCollapsed: (row: number) => void;
  setAnalysisStripCollapsed: (collapsed: boolean) => void;
  removeEmptyRows: () => void;

  // Layout
  setFullViewPanel: (panelId: string | null) => void;
  reorderPanels: (fromIndex: number, toIndex: number) => void;
  setEditMode: (enabled: boolean) => void;

  // Panel selection (for linking workflow)
  togglePanelSelection: (panelId: string, shiftKey: boolean) => void;
  clearPanelSelection: () => void;

  // Reset
  resetPanelLayout: () => void;
  /** Reset every panel to equal width (clears widthFraction so each row splits
   *  evenly 1/N). Leaves rows, heights, and sub-tracks untouched. */
  equalizePanelWidths: () => void;
  /** Pin an analysis panel to the side (a drawer over the reads) or dock it beside them; remembered per panel type. */
  setPanelDock: (panelId: string, dock: 'side' | 'beside') => void;
  /** Dock every panel of a drawer beside the reads at once (one undo step); remembered per panel type. */
  dockPanelsBeside: (panelIds: string[]) => void;
  /**
   * A side panel dropped somewhere in a row (one undo step): it takes its own column there, before `beforePanelId`
   * (null: at the row's end), docked beside the reads ('beside': out of the drawer, as "Dock beside the reads" does)
   * or pinned to the side ('side': into the drawer, as "Pin to the side"). The other panels keep their widths.
   * `place`: on a new row after that row, or stacked under that panel, instead (the move and the dock one step).
   */
  dockPanelAt: (panelId: string, row: number, beforePanelId: string | null, dock: 'side' | 'beside',
    place?: { newRowAfter: number } | { stackBelow: string }) => void;
  /** Clean view per dataset panel: false hides the labels drawn over the data (the default), true keeps them shown. */
  setPanelTrackLabels: (panelId: string, show: boolean) => void;

  // Migration
  initPanelsFromDatasets: () => void;
  initGenomePanel: () => void;

  // Actions
}

// ============================================================
// PANEL SLICE — Implementation
// ============================================================

export function createPanelSlice(set: (partial: Partial<BrowserState> | ((state: BrowserState) => Partial<BrowserState>)) => void, get: () => BrowserState): PanelSlice {
  /** A panel's own view to a locus (navigatePanel without the undo step or a view link). */
  const movePanelOwnView = (panelId: string, chrom: string, start: number, end: number) => set(state => {
    const panel = state.panels.find(p => p.id === panelId);
    if (!panel) return state;
    const s0 = Math.max(0, Math.floor(start));
    const next = { chrom, start: s0, end: Math.max(s0 + 3, Math.floor(end)) };
    // Its reference's link group goes with it ("Linked navigation", panels on another assembly).
    const peers = new Set(linkGroupPeers(state.panels, panel, state.navigationMode));
    // A jump elsewhere leaves the panel's clusters and filters behind (the
    // main view does the same when it jumps).
    let cleared: Partial<BrowserState> = {};
    for (const p of state.panels) {
      if (!peers.has(p.id) || (p.viewportOverride && isPanOrZoom(p.viewportOverride, next))) continue;
      cleared = { ...cleared, ...clearPanelState({ ...state, ...cleared } as BrowserState, panelKey(p)) };
    }
    return {
      ...cleared,
      // Stays in its haplotype comparison (closed together with it).
      panels: state.panels.map(p => peers.has(p.id) ? { ...p, viewportOverride: { ...next }, linkGroup: null } : p),
      lastMovedPanels: recordPanelMove(state.lastMovedPanels, panel, next),
    };
  });
  const seedLayoutHistory = () => {
    const state = get();
    if ((state._historyStack?.length ?? 0) === 0) {
      state.pushSnapshot?.('Before layout change', { kind: 'layout' });
    }
  };

  const pushLayoutHistory = (label: string) => {
    get().pushSnapshot?.(label, { kind: 'layout' });
  };

  return {
  slotOrder: [],

  // Dataset panels
  panels: [],
  fullViewPanelId: null,
  editMode: false,
  nextLinkGroupId: 1,
  selectedPanelIds: new Set<string>(),
  dismissedPanelTypes: new Set<string>(),
  hiddenStripPanels: loadHiddenStripPanels(),
  collapsedRows: new Set<number>(),
  analysisStripCollapsed: false,
  navigatorRegions: [],

  toggleStripPanel: (contentType) => set(state => {
    if (!isAnalysisPanel(contentType)) return {};
    const next = new Set(state.hiddenStripPanels);
    if (next.has(contentType)) next.delete(contentType);
    else next.add(contentType);
    persistHiddenStripPanels(next);
    return { hiddenStripPanels: next };
  }),

  setHiddenStripPanels: (contentTypes) => set(() => {
    const next = new Set(normalizeAnalysisPanelContentTypes(contentTypes));
    persistHiddenStripPanels(next);
    return { hiddenStripPanels: next };
  }),

  addNavigatorRegion: (region) => set(state => {
    if (!region.chrom || region.end <= region.start) return state;
    const id = region.id || `nav-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const next: NavigatorRegion = {
      id,
      chrom: region.chrom,
      start: region.start,
      end: region.end,
      label: region.label || `${region.chrom}:${region.start}-${region.end}`,
      source: region.source,
      datasetIds: region.datasetIds,
      groupId: region.groupId,
    };
    return {
      navigatorRegions: [
        next,
        ...state.navigatorRegions.filter(existing => existing.id !== id),
      ].slice(0, 50),
    };
  }),

  updateNavigatorRegion: (id, updates) => set(state => ({
    navigatorRegions: state.navigatorRegions.map(region =>
      region.id === id ? { ...region, ...updates } : region
    ),
  })),

  removeNavigatorRegion: (id) => set(state => ({
    navigatorRegions: state.navigatorRegions.filter(region => region.id !== id),
  })),

  clearNavigatorRegions: () => set({ navigatorRegions: [] }),

  openAnalysisPanel: (requested) => set(state => {
    const plugin = getAnalysisPanel(requested);
    if (!plugin) return state;
    // A renamed panel type opens the panel under its current name (plugins/registry.ts PANEL_ALIASES).
    const type = plugin.contentType;
    if (plugin.hostOnly && (state.publicMode || isPublicServerPage())) return state;  // not offered on public servers
    // A Preview feature's panel opens only while previews are on (Settings → Show preview features); one a session
    // brought stays, and is shown again below.
    if (previewHidden(plugin.preview) && !state.panels.some(p => p.contentType === type)) return state;
    // For singleton panels, if one already exists, unminimize it instead of creating a duplicate
    if (plugin.singleton !== false) {
      const existing = state.panels.find(p => p.contentType === type);
      if (existing) {
        if (existing.collapsed) {
          return {
            panels: state.panels.map(p => p.id === existing.id ? { ...p, collapsed: false } : p),
            dismissedPanelTypes: (() => { const s = new Set(state.dismissedPanelTypes); s.delete(type); return s; })(),
          };
        }
        // Already open, perhaps behind another tab of the side-panel drawer or
        // in a drawer tucked away: show it.
        revealDrawerPanel(existing.id);
        return state;
      }
    }
    // Ids are unique: a panel restored under another type's usual id (a migrated one) keeps it, and this one moves.
    const usual = plugin.singleton !== false ? `panel-${type}` : `panel-${type}-${Date.now()}`;
    let id = usual;
    for (let n = 2; state.panels.some(p => p.id === id); n++) id = `${usual}-${n}`;
    const panel: PanelConfig = {
      id,
      contentType: type as PanelContentType,
      datasetId: null,
      subTracks: [],
      collapsed: false,
      linkGroup: null,
      layoutRow: 0,
      // Opens where the user last put this kind of panel (pinned to the side or beside the reads).
      // A remembered 'beside' opens it automatic (beside the reads while they have room, else
      // in the drawer), not docked at the tight minimums: older versions stored 'beside'
      // whenever a pin was lifted, so restoring it would squeeze panels the user never docked.
      ...(rememberedPanelDock(type) === 'side' ? { dock: 'side' as const } : {}),
    };
    // Clear dismissed state when explicitly opening
    const newDismissed = new Set(state.dismissedPanelTypes);
    newDismissed.delete(type);
    let panels = [...state.panels, panel];
    // A short panel (the graph view) opens stacked under the top row's first reads or genome panel, at its natural
    // height, not as a tall column beside the reads.
    if (plugin.opens === 'stack-below-reads' && !panel.dock) {
      const reads = state.panels.find(p => p.contentType === 'dataset' && !p.collapsed && (p.layoutRow ?? 0) === 0);
      if (reads) {
        // Under the last panel already stacked there (a second graph view goes under the first).
        const column = reads.layoutColumn;
        const stacked = column == null ? [reads] : state.panels.filter(p => (p.layoutRow ?? 0) === 0 && p.layoutColumn === column && !p.collapsed);
        panels = stackBelow(panels, panel.id, stacked[stacked.length - 1].id);
      }
    }
    return { panels, dismissedPanelTypes: newDismissed };
  }),
  closeAnalysisPanel: (id) => set(state => {
    const panel = state.panels.find(p => p.id === id);
    if (panel && panel.contentType !== 'dataset') forgetRememberedState(panel.contentType);
    const newDismissed = new Set(state.dismissedPanelTypes);
    if (panel && panel.contentType !== 'dataset') {
      newDismissed.add(panel.contentType);
    }
    return {
      panels: state.panels.filter(p => p.id !== id),
      fullViewPanelId: state.fullViewPanelId === id ? null : state.fullViewPanelId,
      dismissedPanelTypes: newDismissed,
    };
  }),
  reorderSlots: (fromIndex, toIndex) => set(state => {
    // Now just reorders panels
    const newPanels = [...state.panels];
    const [moved] = newPanels.splice(fromIndex, 1);
    newPanels.splice(toIndex, 0, moved);
    return { panels: newPanels };
  }),

  // Contact region split view — creates Locus X and Locus Y dataset panels
  openContactRegions: (selection) => set(state => {
    const groupId = `contact-${Date.now()}`;

    // Replace any previous contact-region comparison while preserving unrelated
    // viewport overrides (for example haplotype comparison panels).
    const withoutPreviousContactPanels = state.panels
      .filter(p => !p.contactRegionGroupId && !(p.regionLabel === 'Locus X' || p.regionLabel === 'Locus Y'))
      .map(p => {
        if (p.collapsedByContactRegionGroup) {
          const { collapsedByContactRegionGroup: _removed, ...rest } = p;
          return { ...rest, collapsed: false };
        }
        return p;
      });

    const visibleDatasetPanels = withoutPreviousContactPanels.filter(
      p => p.contentType === 'dataset' && isMainViewPanel(p) && !p.collapsed
    );
    const fallbackDatasetPanels = withoutPreviousContactPanels.filter(
      p => p.contentType === 'dataset' && isMainViewPanel(p)
    );
    const datasetPanels = visibleDatasetPanels.length > 0 ? visibleDatasetPanels : fallbackDatasetPanels;
    const splitRow = datasetPanels.length > 0
      ? Math.min(...datasetPanels.map(p => p.layoutRow ?? 0))
      : 0;

    const panelsWithCollapsedSources = withoutPreviousContactPanels.map(panel => {
      if (!datasetPanels.some(source => source.id === panel.id)) return panel;
      if (panel.collapsed) return panel;
      return { ...panel, collapsed: true, collapsedByContactRegionGroup: groupId };
    });

    const makeRegionPanel = (
      original: PanelConfig | null,
      role: 'x' | 'y',
    ): PanelConfig => {
      const label = role === 'x' ? 'Locus X' : 'Locus Y';
      const chrom = role === 'x' ? selection.chrom : selection.y_chrom ?? selection.chrom;
      const start = role === 'x' ? selection.x_start : selection.y_start;
      const end = role === 'x' ? selection.x_end : selection.y_end;
      const originalKey = original?.stateKey ?? original?.datasetId ?? original?.id ?? 'contact';
      const id = generatePanelId();
      return {
        id,
        contentType: 'dataset',
        datasetId: original?.datasetId ?? null,
        subTracks: original?.subTracks.map(track => ({ ...track })) ?? [],
        collapsed: false,
        linkGroup: null,
        layoutRow: splitRow,
        layoutColumn: role === 'x' ? 0 : 1,
        widthFraction: 0.5,
        stateKey: `${originalKey}:${groupId}:${role}`,
        viewportOverride: { chrom, start, end },
        regionLabel: label,
        contactRegionGroupId: groupId,
        contactRegionRole: role,
      };
    };

    const regionPanels: PanelConfig[] = [];
    if (datasetPanels.length === 0) {
      regionPanels.push(makeRegionPanel(null, 'x'), makeRegionPanel(null, 'y'));
    } else {
      for (const original of datasetPanels) {
        regionPanels.push(makeRegionPanel(original, 'x'), makeRegionPanel(original, 'y'));
      }
    }

    const contactRegions: NavigatorRegion[] = [
      {
        id: `${groupId}:x`,
        chrom: selection.chrom,
        start: selection.x_start,
        end: selection.x_end,
        label: 'Locus X',
        source: 'contact',
        datasetIds: datasetPanels.map(panel => panel.datasetId).filter((id): id is string => Boolean(id)),
        groupId,
      },
      {
        id: `${groupId}:y`,
        chrom: selection.y_chrom ?? selection.chrom,
        start: selection.y_start,
        end: selection.y_end,
        label: 'Locus Y',
        source: 'contact',
        datasetIds: datasetPanels.map(panel => panel.datasetId).filter((id): id is string => Boolean(id)),
        groupId,
      },
    ];

    const contactPanels = [...panelsWithCollapsedSources, ...regionPanels];
    return {
      panels: contactPanels,
      // The comparison it replaced is gone: so are its panels' selections.
      ...pruneSelections(state, contactPanels),
      navigatorRegions: [
        ...contactRegions,
        ...state.navigatorRegions.filter(region => region.source !== 'contact'),
      ].slice(0, 50),
    };
  }),

  closeContactRegions: () => set(state => {
    const newPanels = state.panels
      .filter(p => !p.contactRegionGroupId && !(p.regionLabel === 'Locus X' || p.regionLabel === 'Locus Y'))
      .map(p => {
        if (!p.collapsedByContactRegionGroup) return p;
        const { collapsedByContactRegionGroup: _removed, ...rest } = p;
        return { ...rest, collapsed: false };
      });
    return {
      panels: newPanels,
      ...pruneSelections(state, newPanels),
      navigatorRegions: state.navigatorRegions.filter(region => region.source !== 'contact'),
    };
  }),

  // Haplotype comparison — two views (View 1 on chrom1, View 2 on chrom2) at
  // the same coordinates. Its panels are locked sites (stores/siteLock.ts).
  openHaplotypeComparison: ({ chrom1, chrom2, start, end, datasets1, datasets2 }) => set(state => {
    const groupId = `hap-${Date.now()}`;
    // Replace an earlier haplotype comparison without disturbing contact-map
    // or manually opened region comparisons.
    const basePanels = state.panels
      .filter(panel => !panel.haplotypeGroup)
      .map(panel => {
        if (!panel.collapsedByHaplotypeGroup) return panel;
        const { collapsedByHaplotypeGroup: _removed, ...rest } = panel;
        return { ...rest, collapsed: false };
      });
    const newPanels = [...basePanels];

    // Collapse the source dataset panels, remembering which panels this
    // comparison hid so close only restores its own sources.
    // (Members folded into a graph are shown by their host: no comparison panels of their own; graph features.)
    // (A member folded into a graph is left out when another panel of its dataset stands for it; one folded into
    // another dataset's graph is a source of its own: graph features review.)
    const datasetPanels = basePanels.filter(p => p.contentType === 'dataset' && isMainViewPanel(p)
      && (!p.collapsedByGraphGroup || !basePanels.some(q => q !== p && q.datasetId === p.datasetId && !q.collapsedByGraphGroup && isMainViewPanel(q))));
    for (const original of datasetPanels) {
      const idx = newPanels.findIndex(p => p.id === original.id);
      if (idx >= 0 && !original.collapsed) {
        newPanels[idx] = { ...newPanels[idx], collapsed: true, collapsedByHaplotypeGroup: groupId };
      }
    }

    const makePanel = (side: 1 | 2, datasetId: string | null, template?: PanelConfig): PanelConfig => {
      const chrom = side === 1 ? chrom1 : chrom2;
      return {
        id: generatePanelId(),
        contentType: 'dataset',
        datasetId,
        subTracks: template
          ? template.subTracks.map(track => ({ ...track }))
          : (datasetId ? createDefaultSubTracks(state.orthogonalTracks, state.compositeTracks) : []),
        collapsed: false,
        linkGroup: null,
        layoutRow: 0,
        layoutColumn: side - 1,
        widthFraction: 0.5,
        viewportOverride: { chrom, start, end },
        regionLabel: chrom,
        ...(datasetId || template
          ? { stateKey: `${template?.stateKey ?? datasetId ?? template?.id}:${groupId}:${side}` }
          : {}),
        haplotypeGroup: groupId,
        haplotypeSide: side,
        siteLocked: true,
      };
    };

    const explicit = Boolean(datasets1?.length && datasets2?.length);
    let side1DatasetIds: string[];
    let side2DatasetIds: string[];
    if (explicit) {
      // Each view shows its own datasets; a dataset's open panel is the
      // template for its tracks.
      const templateByDataset = new Map<string, PanelConfig>();
      for (const panel of datasetPanels) {
        if (panel.datasetId && !templateByDataset.has(panel.datasetId)) templateByDataset.set(panel.datasetId, panel);
      }
      side1DatasetIds = [...new Set(datasets1)];
      side2DatasetIds = [...new Set(datasets2)];
      newPanels.push(
        ...side1DatasetIds.map(id => makePanel(1, id, templateByDataset.get(id))),
        ...side2DatasetIds.map(id => makePanel(2, id, templateByDataset.get(id))),
      );
    } else if (datasetPanels.length > 0) {
      // Every open dataset on both views, next to its source panel.
      for (const original of datasetPanels) {
        const insertIdx = newPanels.findIndex(p => p.id === original.id) + 1;
        newPanels.splice(insertIdx, 0, makePanel(1, original.datasetId, original), makePanel(2, original.datasetId, original));
      }
      side1DatasetIds = side2DatasetIds = datasetPanels
        .map(panel => panel.datasetId).filter((id): id is string => Boolean(id));
    } else {
      // No dataset panels: placeholder views.
      newPanels.push(makePanel(1, null), makePanel(2, null));
      side1DatasetIds = side2DatasetIds = [];
    }

    const hapRegions: NavigatorRegion[] = [
      {
        id: `${groupId}:1`,
        chrom: chrom1,
        start,
        end,
        label: chrom1,
        source: 'haplotype',
        datasetIds: side1DatasetIds,
        groupId,
      },
      {
        id: `${groupId}:2`,
        chrom: chrom2,
        start,
        end,
        label: chrom2,
        source: 'haplotype',
        datasetIds: side2DatasetIds,
        groupId,
      },
    ];

    return {
      panels: newPanels,
      // The comparison it replaced is gone: so are its panels' selections.
      ...pruneSelections(state, newPanels),
      navigatorRegions: [
        ...hapRegions,
        ...state.navigatorRegions.filter(region => region.source !== 'haplotype'),
      ].slice(0, 50),
    };
  }),

  closeHaplotypeComparison: () => set(state => {
    const panels = state.panels
      .filter(panel => !panel.haplotypeGroup)
      .map(panel => {
        if (!panel.collapsedByHaplotypeGroup) return panel;
        const { collapsedByHaplotypeGroup: _removed, ...rest } = panel;
        return { ...rest, collapsed: false };
      });
    return {
      panels,
      ...pruneSelections(state, panels),
      navigatorRegions: state.navigatorRegions.filter(region => region.source !== 'haplotype'),
    };
  }),

  openGenomeRegionViews: (regions) => set(state => {
    const validRegions = regions.filter(region => region.chrom && region.end > region.start);
    if (validRegions.length === 0) return state;

    const groupId = `genome-nav-${Date.now()}`;
    const sourceDatasetPanels = state.panels.filter(p => p.contentType === 'dataset' && isMainViewPanel(p));
    const fallbackDatasetIds = state.datasets.map(dataset => dataset.id);
    const templateByDataset = new Map<string, PanelConfig>();
    for (const panel of sourceDatasetPanels) {
      if (panel.datasetId && !templateByDataset.has(panel.datasetId)) {
        templateByDataset.set(panel.datasetId, panel);
      }
    }

    const nextPanels: PanelConfig[] = [...state.panels];
    const baseRow = nextPanels.reduce((maxRow, panel) => Math.max(maxRow, panel.layoutRow ?? 0), 0) + 1;

    validRegions.forEach((region, regionIndex) => {
      const datasetIds = (region.datasetIds && region.datasetIds.length > 0)
        ? region.datasetIds
        : fallbackDatasetIds;
      if (datasetIds.length === 0) {
        nextPanels.push({
          id: generatePanelId(),
          contentType: 'dataset',
          datasetId: null,
          subTracks: [],
          collapsed: false,
          linkGroup: null,
          layoutRow: baseRow + regionIndex,
          viewportOverride: { chrom: region.chrom, start: region.start, end: region.end },
          regionLabel: region.label || `${region.chrom}:${region.start}-${region.end}`,
          genomeRegionGroupId: groupId,
        });
        return;
      }

      datasetIds.forEach((datasetId, datasetIndex) => {
        const sourcePanel = templateByDataset.get(datasetId);
        nextPanels.push({
          id: generatePanelId(),
          contentType: 'dataset',
          datasetId,
          subTracks: sourcePanel?.subTracks.map(track => ({ ...track })) ?? createDefaultSubTracks(state.orthogonalTracks, state.compositeTracks),
          collapsed: false,
          linkGroup: null,
          layoutRow: baseRow + regionIndex,
          layoutColumn: datasetIndex,
          widthFraction: 1 / Math.max(1, datasetIds.length),
          stateKey: `${datasetId}:${groupId}:${regionIndex}`,
          viewportOverride: { chrom: region.chrom, start: region.start, end: region.end },
          regionLabel: region.label || `${region.chrom}:${region.start}-${region.end}`,
          genomeRegionGroupId: groupId,
        });
      });
    });

    return { panels: nextPanels };
  }),

  // Panel CRUD actions
  addPanel: (datasetId) => {
    const id = generatePanelId();
    const state = get();
    const dataset = state.datasets.find(d => d.id === datasetId);
    const panel: PanelConfig = {
      id,
      contentType: 'dataset',
      datasetId,
      ...(isLiveLift(dataset) ? { liftHaplotypeMode: dataset?.live_lift?.settings?.haplotype_mode ?? 'split' } : {}),
      subTracks: createDefaultSubTracks(state.orthogonalTracks, state.compositeTracks),
      collapsed: false,
      linkGroup: null,
      layoutRow: 0,
    };
    set(state => ({ panels: [...state.panels, panel] }));
    return id;
  },

  removePanel: (panelId) => set(state => {
    const panel = state.panels.find(p => p.id === panelId);
    const newDismissed = new Set(state.dismissedPanelTypes);
    if (panel && panel.contentType !== 'dataset') {
      newDismissed.add(panel.contentType);
    }
    // The last panel of a split shows the panel it was split from again (not left folded away).
    // (and a closed graph host's members are shown again, out of its graph, with their state: D8).
    const panels = restoreOrphanGraphMembers(restoreOrphanSplitSources(state.panels.filter(p => p.id !== panelId)));
    // Its own state goes too, unless another panel shares its key.
    const key = panel?.contentType === 'dataset' ? panelKey(panel) : null;
    const keyShared = key != null && panels.some(p => p.contentType === 'dataset' && panelKey(p) === key);
    return {
      panels,
      fullViewPanelId: state.fullViewPanelId === panelId ? null : state.fullViewPanelId,
      dismissedPanelTypes: newDismissed,
      ...pruneSelections(state, panels),
      ...(key != null && !keyShared && key !== panel?.datasetId ? clearPanelState(state, key) : {}),
    };
  }),

  setPanelReversed: (panelId, reversed) => withUndo(get, 'Reverse panel', () => set(state => ({
    panels: state.panels.map(p => p.id === panelId ? { ...p, reversed } : p),
  }))),
  setPanelViewportFromLink: (panelId, view) => set(state => {
    const panel = state.panels.find(p => p.id === panelId);
    const v = panel?.viewportOverride;
    if (!panel || !v || (v.chrom === view.chrom && v.start === view.start && v.end === view.end)) return state;
    return { panels: state.panels.map(p => p.id === panelId ? { ...p, viewportOverride: { chrom: view.chrom, start: view.start, end: view.end } } : p) };
  }),
  duplicatePanel: (panelId) => {
    const state = get();
    const source = state.panels.find(p => p.id === panelId);
    if (!source || source.contentType !== 'dataset') return '';  // Only duplicate dataset panels
    const newId = generatePanelId();
    const clone: PanelConfig = {
      ...withoutGraphMembership(source),
      id: newId,
      subTracks: source.subTracks.map(t => ({ ...t })),
      stateKey: newId,      // independent state key so filters/clusters are per-copy
      linkGroup: null,      // duplicates start unlinked
    };
    // Ensure the source also has a stateKey (so it doesn't share state with the clone via datasetId)
    const sourceNeedsKey = !source.stateKey;
    const idx = state.panels.findIndex(p => p.id === panelId);
    const newPanels = [...state.panels];
    // The source's clusters, filters and order move with it to its new key.
    const moved: Record<string, unknown> = {};
    if (sourceNeedsKey) {
      newPanels[idx] = { ...source, stateKey: source.id };
      const from = panelKey(source);
      for (const name of PER_PANEL_STATE_KEYS) {
        const map = (state as unknown as Record<string, Record<string, unknown>>)[name];
        if (map && from in map) moved[name] = { ...map, [source.id]: map[from] };
      }
    }
    newPanels.splice(idx + 1, 0, clone);
    set({ panels: newPanels, ...moved } as Partial<BrowserState>);
    return newId;
  },

  setPanelCollapsed: (panelId, collapsed) => set(state => ({
    // Shown again by hand: no longer held folded by a split or comparison (closing that later leaves it be).
    panels: state.panels.map(p => {
      if (p.id !== panelId) return p;
      if (collapsed) return { ...withoutGraphFold(p), collapsed };
      const { collapsedBySplitGroup: _a, collapsedByHaplotypeGroup: _b, collapsedByContactRegionGroup: _c, ...rest } = withoutGraphFold(p);
      return { ...rest, collapsed };
    }),
    fullViewPanelId: collapsed && state.fullViewPanelId === panelId ? null : state.fullViewPanelId,
  })),

  setPanelDataset: (panelId, datasetId) => set(state => ({
    panels: state.panels.map(p => p.id === panelId ? { ...p, datasetId } : p),
  })),

  setPanelLayout: (panelId, layout) => set(state => ({
    panels: state.panels.map(p => p.id === panelId ? { ...p, layoutRow: layout === 'column' ? 1 : 0 } : p),
  })),

  // Shared visibility keeps the same track kind aligned across panels.
  toggleSubTrack: (panelId, trackType, panelOnly = false) => {
    const panel = get().panels.find(p => p.id === panelId);
    const target = panel?.subTracks.find(t => t.type === trackType);
    if (!target || target.removed) return;
    seedLayoutHistory();
    set(state => ({
      panels: state.panels.map(p => panelOnly && p.id !== panelId ? p : {
        ...p,
        subTracks: p.subTracks.map(t => t.type === trackType && !t.removed
          ? { ...t, visible: !target.visible } : t),
      }),
    }));
    pushLayoutHistory(`${target.visible ? 'Hide' : 'Show'} ${trackType}`);
  },

  removeSubTrack: (panelId, trackType) => {
    const panel = get().panels.find(p => p.id === panelId);
    if (!panel) return;
    const target = panel.subTracks.find(t => t.type === trackType);
    if (!target || target.removed) return;

    const isProjectedTrack = trackType.startsWith('ortho-') || trackType.startsWith('composite-');
    if (isProjectedTrack && !target.visible) return;
    if (!isProjectedTrack && !isDeletableTrack(trackType)) return;
    seedLayoutHistory();

    // A projected track is hidden in the panel (its source lives in the Library / cart);
    // a built-in keeps its place, marked removed, so "Tracks in this panel" puts it back there.
    const removeFn = (tracks: SubTrackConfig[]) => tracks.map(t => (t.type !== trackType ? t
      : isProjectedTrack ? { ...t, visible: false } : { ...t, removed: true }));

    set(state => {
      if (panel.linkGroup) {
        return {
          panels: state.panels.map(p =>
            p.linkGroup === panel.linkGroup
              ? { ...p, subTracks: removeFn(p.subTracks) }
              : p
          ),
        };
      }
      return {
        panels: state.panels.map(p =>
          p.id === panelId ? { ...p, subTracks: removeFn(p.subTracks) } : p
        ),
      };
    });
    pushLayoutHistory(`${isProjectedTrack ? 'Minimize' : 'Remove'} ${trackType}`);
  },

  restoreSubTrack: (panelId, trackType) => {
    const panel = get().panels.find(p => p.id === panelId);
    if (!panel) return;
    const target = panel.subTracks.find(t => t.type === trackType);
    if (target && !target.removed && target.visible) return;
    seedLayoutHistory();
    const restoreFn = (tracks: SubTrackConfig[]) => {
      if (!tracks.some(t => t.type === trackType)) return restoreBuiltinAt(tracks, trackType);
      return tracks.map(t => {
        if (t.type !== trackType) return t;
        const { removed: _removed, ...rest } = t;
        return { ...rest, visible: true };
      });
    };
    set(state => ({
      panels: state.panels.map(p =>
        (panel.linkGroup ? p.linkGroup === panel.linkGroup && p.contentType === panel.contentType : p.id === panelId)
          ? { ...p, subTracks: restoreFn(p.subTracks) }
          : p
      ),
    }));
    pushLayoutHistory(`Restore ${trackType}`);
  },

  setSubTrackHeight: (panelId, trackType, height) => set(state => {
    const panel = state.panels.find(p => p.id === panelId);
    if (!panel) return state;

    const setHeightFn = (tracks: SubTrackConfig[]) => tracks.map(t => {
      if (t.type !== trackType) return t;
      if (height == null) {
        const { heightOverride: _h, ...rest } = t;
        return rest;
      }
      return { ...t, heightOverride: clampTrackHeight(trackType, height) };
    });

    if (panel.linkGroup) {
      return {
        panels: state.panels.map(p =>
          p.linkGroup === panel.linkGroup
            ? { ...p, subTracks: setHeightFn(p.subTracks) }
            : p
        ),
      };
    }
    return {
      panels: state.panels.map(p =>
        p.id === panelId ? { ...p, subTracks: setHeightFn(p.subTracks) } : p
      ),
    };
  }),

  reorderSubTracks: (panelId, fromIndex, toIndex) => {
    const panel = get().panels.find(p => p.id === panelId);
    if (!panel) return;
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= panel.subTracks.length || toIndex >= panel.subTracks.length) return;
    seedLayoutHistory();

    // Linked panels can hold different tracks (one removed Sequence while
    // unlinked): move the same track to the same neighbour's place in each,
    // by track type, and leave a panel lacking either one as it is.
    const movedType = panel.subTracks[fromIndex].type;
    const anchorType = panel.subTracks[toIndex].type;
    const reorderFn = (tracks: SubTrackConfig[]) => {
      const from = tracks.findIndex(t => t.type === movedType);
      const to = tracks.findIndex(t => t.type === anchorType);
      if (from < 0 || to < 0 || from === to) return tracks;
      const newTracks = [...tracks];
      const [moved] = newTracks.splice(from, 1);
      newTracks.splice(to, 0, moved);
      return newTracks;
    };

    set(state => {
      if (panel.linkGroup) {
        return {
          panels: state.panels.map(p =>
            p.linkGroup === panel.linkGroup
              ? { ...p, subTracks: reorderFn(p.subTracks) }
              : p
          ),
        };
      }
      return {
        panels: state.panels.map(p =>
          p.id === panelId ? { ...p, subTracks: reorderFn(p.subTracks) } : p
        ),
      };
    });
    pushLayoutHistory(`Reorder tracks in ${panelId}`);
  },

  // Link groups
  togglePanelLink: (panelId) => set(state => {
    const panel = state.panels.find(p => p.id === panelId);
    if (!panel) return state;

    if (panel.linkGroup) {
      // Unlink
      return {
        panels: state.panels.map(p =>
          p.id === panelId ? { ...p, linkGroup: null } : p
        ),
      };
    }
    // Link: assign to default group (or first existing group)
    const existingGroup = state.panels.find(p => p.id !== panelId && p.linkGroup)?.linkGroup;
    const fresh = existingGroup ? null : freshLinkGroup(state);
    const groupId = existingGroup || fresh!.groupId;
    return {
      panels: state.panels.map(p =>
        p.id === panelId ? { ...p, linkGroup: groupId } : p
      ),
      nextLinkGroupId: fresh ? fresh.nextLinkGroupId : state.nextLinkGroupId,
    };
  }),

  linkPanels: (panelIds) => set(state => {
    const { groupId, nextLinkGroupId } = freshLinkGroup(state);
    return {
      panels: state.panels.map(p =>
        panelIds.includes(p.id) ? { ...p, linkGroup: groupId } : p
      ),
      nextLinkGroupId,
    };
  }),

  unlinkPanel: (panelId) => set(state => ({
    panels: state.panels.map(p =>
      p.id === panelId ? { ...p, linkGroup: null } : p
    ),
  })),

  setPanelIndependent: (panelId, independent) => withUndo(get, independent ? 'Navigate panel on its own' : 'Panel follows the main view', () => set(state => {
    const panel = state.panels.find(p => p.id === panelId);
    // Another assembly's panel can't show the main view's locus.
    if (!panel || (!independent && !canLinkToMainView(panel))) return state;
    const v = panel.viewportOverride;
    // Rejoining the main view from somewhere else: that site's clusters and
    // filters don't apply to the main region's reads.
    const leavesSite = !independent && v && !(v.chrom === state.chrom && v.start === state.start && v.end === state.end);
    return {
      ...(leavesSite ? clearPanelState(state, panelKey(panel)) : {}),
      panels: state.panels.map(p => p.id === panelId ? {...p,
        stateKey: p.stateKey ?? p.id,
        viewportOverride: independent ? (p.viewportOverride ?? {chrom:state.chrom,start:state.start,end:state.end}) : undefined,
        siteLocked: independent ? p.siteLocked : undefined,
        haplotypeGroup: undefined, linkGroup: independent ? null : 'default',
      } : p),
    };
  })),
  navigatePanel: (panelId, chrom, start, end) => withUndo(get, panelNavigationLabel(chrom, start), () => {
    movePanelOwnView(panelId, chrom, start, end);
    const moved = get().panels.find(p => p.id === panelId);
    if (moved?.viewportOverride) moveLinkedFollowers(get, moved, moved.viewportOverride);
    // A linked panel (utils/panelExtensions.ts view links) takes the main view with it, as its pans do: one undo step.
    const state = get();
    const panel = state.panels.find(p => p.id === panelId);
    const v = panel?.viewportOverride;
    const mapped = panel && v ? mainViewForPanel(panel, v) ?? null : null;
    if (mapped && !(mapped.chrom === state.chrom && mapped.start === state.start && mapped.end === state.end)) {
      withLinkedPanelMoving(panelId, () => get().setViewport(mapped.chrom, mapped.start, mapped.end));
    }
  }),
  navigatePanelOwnView: (panelId, chrom, start, end) => withUndo(get, panelNavigationLabel(chrom, start), () => {
    movePanelOwnView(panelId, chrom, start, end);
    // Panels linked to it that keep views of their own follow it, as after navigatePanel (a graph host's moves to
    // another contig and its pans while it follows a graph go through here).
    const moved = get().panels.find(p => p.id === panelId);
    if (moved?.viewportOverride) moveLinkedFollowers(get, moved, moved.viewportOverride);
  }),
  openPanelAtSite: (panelId, options) => {
    const state = get();
    const source = state.panels.find(p => p.id === panelId);
    if (!source || source.contentType !== 'dataset') return '';
    const id = generatePanelId();
    const copy = copyPanelAtSite(source, id, state, options?.linked);
    // The source keeps its key (the dataset id for a plain panel): peak scans
    // and exports read the main panel's profile under it.
    const idx = state.panels.findIndex(p => p.id === panelId);
    // Beside its source (side by side); the panel menu stacks it (Stack below).
    const panels = [...state.panels];
    panels.splice(idx + 1, 0, copy);
    withUndo(get, options?.linked ? 'Add panel copy' : 'Copy panel to another locus',
      () => set({
        panels,
        ...(options?.linked ? {} : { pendingPanelLocationFocus: id }),
      }));
    return id;
  },
  setPanelSiteLocked: (panelId, locked) => withUndo(get, locked ? 'Link panel' : 'Unlink panel', () => set(state => ({
    // A panel on another assembly is never linked to the main view (canLinkToMainView).
    panels: state.panels.map(p => p.id === panelId && p.viewportOverride && canLinkToMainView(p) ? { ...p, siteLocked: locked } : p),
  }))),
  pendingPanelLocationFocus: null,
  clearPendingPanelLocationFocus: () => set({ pendingPanelLocationFocus: null }),
  setPanelStrand: (panelId, strand) => withUndo(get, strand ? `Show ${strand} strand` : 'Show both strands', () => set(state => {
    const panel = state.panels.find(p => p.id === panelId);
    if (!panel || (panel.strand ?? null) === strand) return state;
    // Other reads now: this panel's clusters and filters don't apply.
    const { stateKey, reset } = isolatePanelState(state, panel);
    return {
      ...reset,
      panels: state.panels.map(p => p.id === panelId ? { ...p, strand: strand ?? undefined, ...(stateKey ? { stateKey } : {}) } : p),
    };
  })),
  addStrandPanel: (panelId, strand) => {
    const source = get().panels.find(p => p.id === panelId);
    if (!source || source.contentType !== 'dataset') return '';
    const id = generatePanelId();
    const copy: PanelConfig = {
      ...withoutGraphMembership(source), id, stateKey: id, strand,
      subTracks: source.subTracks.map(track => ({ ...track })),
      linkGroup: null, collapsed: false, layoutColumn: undefined,
      // A comparison's copy leaves the comparison but keeps its locus: never in its reference's link group.
      ...(inComparisonGroup(source) ? { ownLocus: true } : {}),
      regionLabel: undefined, contactRegionGroupId: undefined, contactRegionRole: undefined,
      genomeRegionGroupId: undefined, haplotypeGroup: undefined,
      collapsedByContactRegionGroup: undefined, collapsedByHaplotypeGroup: undefined,
    };
    withUndo(get, `Show ${strand} strand beside`, () => set(state => {
      const idx = state.panels.findIndex(p => p.id === panelId);
      if (idx < 0) return state;
      const panels = [...state.panels];
      panels.splice(idx + 1, 0, copy);
      return {
        panels,
        ...(state.activeClusterTreeNodeId ? { activeClusterTreeNodeId: null } : {}),
        ...(state.dynamicClustering ? { dynamicClustering: false } : {}),
      };
    }));
    return id;
  },
  splitPanelByStrand: (panelId) => {
    const state = get();
    const source = state.panels.find(p => p.id === panelId);
    if (!source || source.contentType !== 'dataset') return '';
    const id = generatePanelId();
    const copy: PanelConfig = {
      ...withoutGraphMembership(source),
      id,
      subTracks: source.subTracks.map(track => ({ ...track })),
      stateKey: id,
      strand: 'GA', ...(source.liftSplitGroup ? { liftSplitGroup: source.liftSplitGroup } : {}),
      linkGroup: null,
      collapsed: false,
      layoutColumn: undefined,  // its own column, right after the source
      // A comparison's copy leaves the comparison but keeps its locus: never in its reference's link group.
      ...(inComparisonGroup(source) ? { ownLocus: true } : {}),
      regionLabel: undefined,
      contactRegionGroupId: undefined,
      contactRegionRole: undefined,
      genomeRegionGroupId: undefined,
      haplotypeGroup: undefined,
      collapsedByContactRegionGroup: undefined,
      collapsedByHaplotypeGroup: undefined,
    };
    withUndo(get, 'Split panel by strand', () => set(current => {
      const idx = current.panels.findIndex(p => p.id === panelId);
      if (idx < 0) return current;
      const panels = [...current.panels];
      const src = panels[idx];
      // Already CT: its reads (and clusters) stay; the GA copy is new.
      const { stateKey, reset } = src.strand === 'CT'
        ? { stateKey: undefined, reset: {
          // The new GA panel has no clusters: an active branch would hide its reads.
          ...(current.activeClusterTreeNodeId ? { activeClusterTreeNodeId: null } : {}),
          ...(current.dynamicClustering ? { dynamicClustering: false } : {}),
        } }
        : isolatePanelState(current, src);
      panels[idx] = { ...src, strand: 'CT', ...(stateKey ? { stateKey } : {}) };
      panels.splice(idx + 1, 0, copy);
      return { ...reset, panels };
    }));
    return id;
  },

  splitPanelByLiftHap: (panelId, labels) => {
    const source = get().panels.find(p => p.id === panelId);
    if (!source || source.contentType !== 'dataset' || labels.length === 0) return [];
    const liftSplitGroup = `lsg-${generatePanelId()}`;
    const copies: PanelConfig[] = labels.slice(1).map(label => {
      const id = generatePanelId();
      return {
        ...withoutGraphMembership(source), id, stateKey: id, liftHap: label, liftHaplotypeMode: 'split', liftSplitGroup,
        subTracks: source.subTracks.map(track => ({ ...track })),
        collapsed: false, regionLabel: undefined,
        contactRegionGroupId: undefined, contactRegionRole: undefined, genomeRegionGroupId: undefined,
        haplotypeGroup: undefined, collapsedByContactRegionGroup: undefined, collapsedByHaplotypeGroup: undefined,
      };
    });
    withUndo(get, 'Split by haplotype', () => set(current => {
      const idx = current.panels.findIndex(p => p.id === panelId);
      if (idx < 0) return current;
      const panels = [...current.panels];
      const src = panels[idx];
      // Other reads now: the source panel's clusters and filters don't apply.
      const { stateKey, reset } = isolatePanelState(current, src);
      panels[idx] = { ...src, liftHap: labels[0], liftHaplotypeMode: 'split', liftSplitGroup, ...(stateKey ? { stateKey } : {}) };
      panels.splice(idx + 1, 0, ...copies);
      return { ...reset, panels };
    }));
    return copies.map(c => c.id);
  },
  poolLiftHapPanels: (datasetId, panelId) => withUndo(get, 'Pool haplotypes', () => set(state => {
    // One Split by haplotype's panels (the clicked panel's group), never a graph's host or members; the clicked
    // panel is kept (graph features review).
    const clicked = panelId ? state.panels.find(p => p.id === panelId) : undefined;
    const inGraph = (p: PanelConfig) => p.viewMode === 'graph' || (p.graphView as { role?: string } | undefined)?.role === 'host' || Boolean(p.graphMemberOf);
    const mine = state.panels.filter(p => p.datasetId === datasetId && p.liftHap && !inGraph(p)
      && (!clicked || (p.liftSplitGroup ?? null) === (clicked.liftSplitGroup ?? null)));
    if (mine.length === 0) return state;
    const keep = (clicked && mine.find(p => p.id === clicked.id)) || mine[0];
    const drop = new Set(mine.filter(p => p.id !== keep.id).map(p => p.id));
    const { stateKey, reset } = isolatePanelState(state, keep);
    return {
      ...reset,
      panels: restoreOrphanGraphMembers(state.panels.filter(p => !drop.has(p.id))
        .map(p => p.id === keep.id ? { ...p, liftHap: undefined, liftHaplotypeMode: 'pooled', liftSplitGroup: undefined, ...(stateKey ? { stateKey } : {}) } : p)),
    };
  })),
  setPanelViewport: (panelId, start, end) => {
    const state = get();
    const panel = state.panels.find(p => p.id === panelId);
    const prev = panel?.viewportOverride;
    if (!panel || !prev) return;
    const next = { chrom: prev.chrom, start, end };
    if (next.start === prev.start && next.end === prev.end) return;
    const move = panel.siteLocked && isPanOrZoom(prev, next);
    // An undo step, like a move of the main view. A locked panel moves the main view too, whose own navigation step
    // records it (not twice). Seeded before the link maps the move, so a late link correction knows the baseline
    // is not the move's step.
    if (!move) seedHistoryBaseline(state, 'Before navigation', 'navigation');
    // A linked panel's view on the main genome (utils/panelExtensions.ts view links; null: none, or the main view
    // already shows it, e.g. a pan inside a part with no main-view coordinates, whose own step is then recorded below).
    const mappedMain = !move ? mainViewForPanel(panel, next) ?? null : null;
    const linkedMain = mappedMain && !(mappedMain.chrom === state.chrom && mappedMain.start === state.start && mappedMain.end === state.end)
      ? mappedMain : null;
    // Its reference's link group shows the same locus ("Linked navigation", panels on another assembly).
    const peers = new Set(linkGroupPeers(state.panels, panel, state.navigationMode));
    set({
      panels: state.panels.map(p => {
        if (peers.has(p.id)) return { ...p, viewportOverride: { ...next } };
        if (move && p.siteLocked && p.viewportOverride) return { ...p, viewportOverride: moveLikewise(p.viewportOverride, prev, next) };
        return p;
      }),
      lastMovedPanels: recordPanelMove(state.lastMovedPanels, panel, next),
    });
    // Panels linked to this one that keep views of their own ("Each panel navigates") follow it.
    moveLinkedFollowers(get, panel, next);
    if (move) {
      // The main view is a site too; its own update must not move us again.
      const main = moveLikewise({ chrom: state.chrom, start: state.start, end: state.end }, prev, next);
      withSiteLockSuppressed(() => get().setViewport(main.chrom, main.start, main.end));
    } else if (linkedMain) {
      // A linked panel moves the main view mapped back through its link; the main view's move doesn't move it back,
      // and its navigation step records this one.
      withLinkedPanelMoving(panel.id, () => get().setViewport(linkedMain.chrom, linkedMain.start, linkedMain.end));
    } else {
      // Pans and zooms in quick succession (wheel, buttons) are one step.
      get().pushSnapshot?.(`Navigate panel to ${next.chrom}:${Math.max(0, next.start).toLocaleString()}-${next.end.toLocaleString()}`,
        { kind: 'navigation', coalesceKey: `panel-navigation:${panelId}`, coalesceMs: PANEL_NAVIGATION_COALESCE_MS, explicit: true });
    }
  },

  setPanelWidthFraction: (panelId, fraction) => set(state => ({
    panels: state.panels.map(p =>
      p.id === panelId ? { ...p, widthFraction: fraction } : p
    ),
  })),

  // Row layout actions
  setPanelRow: (panelId, row) => set(state => ({
    panels: state.panels.map(p => p.id === panelId ? { ...p, layoutRow: row } : p),
  })),

  movePanelToRow: (panelId, targetRow, insertIndex) => set(state => {
    const panel = state.panels.find(p => p.id === panelId);
    if (!panel) return state;
    // Remove from current position, set new row as own column, and insert at target
    const without = state.panels.filter(p => p.id !== panelId);
    const updated = { ...panel, layoutRow: targetRow, layoutColumn: undefined };
    if (insertIndex != null) {
      // Find the Nth panel in targetRow and insert before it
      let count = 0;
      for (let i = 0; i <= without.length; i++) {
        if (count === insertIndex || i === without.length) {
          without.splice(i, 0, updated);
          break;
        }
        if (without[i]?.layoutRow === targetRow && !without[i].collapsed) count++;
      }
      return { panels: without };
    }
    // Append to end of target row
    return { panels: [...without, updated] };
  }),

  insertPanelAsNewRow: (panelId, afterRowIndex) => set(state => {
    const panel = state.panels.find(p => p.id === panelId);
    if (!panel) return state;
    const newRow = afterRowIndex + 1;
    // Shift all panels in rows >= newRow up by 1, then place this panel in newRow
    const panels = state.panels.map(p => {
      if (p.id === panelId) return { ...p, layoutRow: newRow, layoutColumn: undefined };
      const row = p.layoutRow ?? 0;
      if (row >= newRow) return { ...p, layoutRow: row + 1 };
      return p;
    });
    // Remap collapsedRows for the shift
    const newCollapsed = new Set<number>();
    for (const r of state.collapsedRows) {
      newCollapsed.add(r >= newRow ? r + 1 : r);
    }
    return { panels, collapsedRows: newCollapsed };
  }),

  stackPanelBelow: (panelId, targetPanelId) => set(state => {
    const panels = stackBelow(state.panels, panelId, targetPanelId);
    return panels === state.panels ? state : { panels };
  }),

  arrangePanel: (panelId, arrangement) => {
    const state = get();
    const target = arrangement === 'stack' ? stackTarget(state.panels, panelId) : null;
    if (arrangement === 'stack' ? !target : !isStacked(state.panels, panelId)) return;
    withUndo(get, arrangement === 'stack' ? 'Stack panel' : 'Panel side by side', () => set(current => ({
      panels: arrangement === 'stack' ? stackBelow(current.panels, panelId, target!.id) : sideBySide(current.panels, panelId),
    })));
  },

  toggleRowCollapsed: (row) => set(state => {
    const next = new Set(state.collapsedRows);
    if (next.has(row)) next.delete(row);
    else next.add(row);
    return { collapsedRows: next };
  }),

  setAnalysisStripCollapsed: (collapsed) => set({ analysisStripCollapsed: collapsed }),

  removeEmptyRows: () => set(state => {
    // Find which rows are actually used
    const usedRows = new Set(state.panels.map(p => p.layoutRow ?? 0));
    const sorted = [...usedRows].sort((a, b) => a - b);
    // Build mapping: old row → new row (contiguous 0,1,2...)
    const rowMap = new Map<number, number>();
    sorted.forEach((r, i) => rowMap.set(r, i));
    // Remap panels
    const newPanels = state.panels.map(p => {
      const newRow = rowMap.get(p.layoutRow ?? 0) ?? 0;
      return newRow !== (p.layoutRow ?? 0) ? { ...p, layoutRow: newRow } : p;
    });
    // Remap collapsedRows
    const newCollapsed = new Set<number>();
    for (const r of state.collapsedRows) {
      const mapped = rowMap.get(r);
      if (mapped != null) newCollapsed.add(mapped);
    }
    return { panels: newPanels, collapsedRows: newCollapsed };
  }),

  // Layout
  setFullViewPanel: (panelId) => set({ fullViewPanelId: panelId }),

  reorderPanels: (fromIndex, toIndex) => set(state => {
    const newPanels = [...state.panels];
    const [moved] = newPanels.splice(fromIndex, 1);
    newPanels.splice(toIndex, 0, moved);
    return { panels: newPanels };
  }),

  setEditMode: (enabled) => set(state => ({
    editMode: enabled,
    selectedPanelIds: enabled ? state.selectedPanelIds : new Set<string>(),  // Clear selection when leaving edit mode
  })),

  // Panel selection for linking workflow
  togglePanelSelection: (panelId, shiftKey) => set(state => {
    if (!state.editMode) return state;  // Only in edit mode
    const newSet = new Set(state.selectedPanelIds);
    if (shiftKey) {
      // Shift-click: toggle this panel in selection
      if (newSet.has(panelId)) {
        newSet.delete(panelId);
      } else {
        newSet.add(panelId);
      }
    } else {
      // Normal click: if this is the only one selected, deselect; otherwise select only this
      if (newSet.size === 1 && newSet.has(panelId)) {
        newSet.clear();
      } else {
        newSet.clear();
        newSet.add(panelId);
      }
    }
    return { selectedPanelIds: newSet };
  }),

  clearPanelSelection: () => set({ selectedPanelIds: new Set<string>() }),

  // Reset all custom sizes, restore default sub-track order, and move all to row 0
  resetPanelLayout: () => set(state => ({
    panels: state.panels.map(p => ({
      ...p,
      layoutRow: 0,
      widthFraction: undefined,
      heightFraction: undefined,
      subTracks: p.contentType === 'dataset'
        ? createDefaultSubTracks(state.orthogonalTracks, state.compositeTracks).map(def => {
            // Preserve visibility of existing tracks but reset heightOverride
            const existing = p.subTracks.find(st => st.type === def.type);
            return existing ? { ...def, visible: existing.visible, ...(existing.removed ? { removed: true } : {}) } : def;
          })
        : p.subTracks,
    })),
    collapsedRows: new Set<number>(),
  })),

  setPanelDock: (panelId, dock) => {
    const panel = get().panels.find(p => p.id === panelId);
    if (!panel || panel.contentType === 'dataset') return;
    if ((panel.dock ?? null) === dock) return;
    rememberPanelDock(panel.contentType, dock);
    const label = getAnalysisPanel(panel.contentType)?.label ?? 'panel';
    withUndo(get, dock === 'side' ? `Pin ${label} to the side` : `Dock ${label} beside the reads`, () => set(state => ({
      panels: state.panels.map(p => {
        if (p.id !== panelId) return p;
        const { dock: _old, ...rest } = p;
        // Beside the reads: the pin is lifted and the panel takes its column again at the comfortable widths. Under the
        // scroll policy nothing goes to the drawer by itself, so there is no room to make: 'beside' (the tighter docked
        // minimums) would only squeeze the row (usability round 3, B1).
        if (dock !== 'side') return rest;
        // Stacked with other panels: it leaves that column for its own (the drawer).
        const stacked = p.layoutColumn != null && state.panels.some(o => o.id !== p.id
          && (o.layoutRow ?? 0) === (p.layoutRow ?? 0) && o.layoutColumn === p.layoutColumn);
        if (stacked) delete (rest as Partial<PanelConfig>).layoutColumn;
        return { ...rest, dock: 'side' as const };
      }),
    })));
  },
  dockPanelsBeside: (panelIds) => {
    // The drawer's panels (pinned to the side) take their columns beside the reads again: the pin is lifted. Only
    // these panels: the side panels already beside the reads keep their widths (usability round 3, B1: docking one
    // panel used to dock every side panel of the row at the tight minimums, 400/320/320/320). Under the scroll policy
    // nothing goes to the drawer by itself, so making room never pushes another panel into it.
    const ids = new Set(panelIds);
    const moving = get().panels.filter(p => ids.has(p.id) && p.contentType !== 'dataset' && p.dock === 'side');
    if (moving.length === 0) return;
    for (const p of moving) rememberPanelDock(p.contentType, 'beside');
    const label = moving.length === 1 ? (getAnalysisPanel(moving[0].contentType)?.label ?? 'panel') : 'side panels';
    withUndo(get, `Dock ${label} beside the reads`, () => set(state => ({
      panels: state.panels.map(p => {
        if (!moving.some(m => m.id === p.id)) return p;
        const { dock: _pin, ...rest } = p;
        return rest;
      }),
    })));
  },
  dockPanelAt: (panelId, row, beforePanelId, dock, place) => {
    const panel = get().panels.find(p => p.id === panelId);
    if (!panel || panel.contentType === 'dataset') return;
    rememberPanelDock(panel.contentType, dock);
    const name = getAnalysisPanel(panel.contentType)?.label ?? 'panel';
    withUndo(get, dock === 'side' ? `Pin ${name} to the side` : `Dock ${name} beside the reads`, () => {
      if (place && 'newRowAfter' in place) get().insertPanelAsNewRow(panelId, place.newRowAfter);
      else if (place && 'stackBelow' in place) get().stackPanelBelow(panelId, place.stackBelow);
      else {
        set(state => {
          const current = state.panels.find(p => p.id === panelId);
          if (!current) return state;
          const { layoutColumn: _col, ...rest } = current;
          const moved: PanelConfig = { ...rest, layoutRow: row };
          const without = state.panels.filter(p => p.id !== panelId);
          const at = beforePanelId ? without.findIndex(p => p.id === beforePanelId) : -1;
          if (at < 0) {
            // the row's end: after its last panel (rows keep their order in the list)
            const last = without.map(p => (p.layoutRow ?? (p.layoutPosition === 'column' ? 1 : 0)) === row).lastIndexOf(true);
            without.splice(last < 0 ? without.length : last + 1, 0, moved);
          } else without.splice(at, 0, moved);
          return { panels: without };
        });
      }
      set(state => ({
        panels: state.panels.map(p => {
          if (p.id !== panelId) return p;
          const { dock: _old, ...rest } = p;
          return dock === 'side' ? { ...rest, dock: 'side' as const } : rest;
        }),
      }));
      get().removeEmptyRows();
    });
  },
  setPanelTrackLabels: (panelId, show) => {
    const panel = get().panels.find(p => p.id === panelId);
    if (!panel || Boolean(panel.showTrackLabels) === show) return;
    withUndo(get, show ? 'Clean view off' : 'Clean view on', () => set(state => ({
      panels: state.panels.map(p => {
        if (p.id !== panelId) return p;
        const { showTrackLabels: _old, ...rest } = p;
        return show ? { ...rest, showTrackLabels: true } : rest;
      }),
    })));
  },
  equalizePanelWidths: () => set(state => ({
    // Clearing widthFraction makes computeColumnWidths fall back to an equal
    // 1/N split per row — "default, equal width" without touching anything else.
    panels: state.panels.map(p =>
      p.widthFraction === undefined ? p : { ...p, widthFraction: undefined }
    ),
  })),

  // Migration: create default panels from current datasets (linked by default)
  initPanelsFromDatasets: () => set(state => {
    if (state.panels.length > 0) return state;  // Already initialized
    const defaultLinkGroup = state.datasets.length > 1 ? 'link-1' : null;
    const panels: PanelConfig[] = state.datasets.map(ds => ({
      id: generatePanelId(),
      contentType: 'dataset' as PanelContentType,
      datasetId: ds.id,
      ...(isLiveLift(ds) ? { liftHaplotypeMode: ds.live_lift?.settings?.haplotype_mode ?? 'split' } : {}),
      subTracks: createDefaultSubTracks(state.orthogonalTracks, state.compositeTracks),
      collapsed: false,
      linkGroup: defaultLinkGroup,
      layoutRow: 0,
    }));
    return {
      panels,
      nextLinkGroupId: defaultLinkGroup ? 2 : state.nextLinkGroupId,
    };
  }),

  // Create a genome-only panel (no dataset) for browsing annotations/sequence/tracks
  initGenomePanel: () => set(state => {
    // Don't create if dataset panels already exist
    if (state.panels.some(p => p.contentType === 'dataset' && p.datasetId !== null)) return state;
    // Don't create if genome panel already exists
    if (state.panels.some(p => p.id === 'panel-genome')) return state;
    const panel: PanelConfig = {
      id: 'panel-genome',
      contentType: 'dataset' as PanelContentType,
      datasetId: null,
      subTracks: createGenomeSubTracks(state.orthogonalTracks, state.compositeTracks),
      collapsed: false,
      linkGroup: null,
      layoutRow: 0,
    };
    return { panels: [...state.panels, panel] };
  }),

  };
}
