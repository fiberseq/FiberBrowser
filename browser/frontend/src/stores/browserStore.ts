import { foldedInShownGraph } from './graphMembership';
import { setSignalFilterSource } from '../utils/signalFilters';
import { clearLoadedReadRegions } from '../api/loadedReadRegion';
import { useRunResultStore } from './runResultStore';
import { storePinnedMotifs } from '../utils/pinnedMotifs';
import { storeCustomMotifs, storeMotifScoring } from '../utils/motifSettings';
import { connectStoreExtensions } from './storeExtensions';
import { create } from 'zustand';
import type { Dataset, PanelConfig } from '../types';

// Re-export for backward compatibility
export type { Bookmark } from '../types';
export type { Interval } from '../types';

import { createViewportSlice } from './viewportSlice';
import type { ViewportSlice } from './viewportSlice';
import { createDatasetSlice } from './datasetSlice';
import type { DatasetSlice } from './datasetSlice';
import { createClusterSlice } from './clusterSlice';
import type { ClusterSlice } from './clusterSlice';
import { createPanelSlice } from './panelSlice';
import type { PanelSlice } from './panelSlice';
import { createColormapSlice } from './colormapSlice';
import type { ColormapSlice } from './colormapSlice';
import { createUiSlice } from './uiSlice';
import type { UiSlice } from './uiSlice';
import { createJupyterSlice } from './jupyterSlice';
import type { JupyterSlice } from './jupyterSlice';
import { createPrimerSlice } from './primerSlice';
import type { PrimerSlice } from './primerSlice';
import { createSelectionSlice } from './selectionSlice';
import type { SelectionSlice } from './selectionSlice';
import { createHistorySlice } from './historySlice';
import type { HistorySlice } from './historySlice';
import { createAnnotationSlice } from './annotationSlice';
import type { AnnotationSlice } from './annotationSlice';
import { createCaptureSlice } from './captureSlice';
import type { CaptureSlice } from './captureSlice';
import { createPeakRuleSlice } from './peakRuleSlice';
import type { PeakRuleSlice } from './peakRuleSlice';
import { createCatalogSlice } from './catalogSlice';
import type { CatalogSlice } from './catalogSlice';
import { createCompositeTracksSlice } from './compositeTracksSlice';
import type { CompositeTracksSlice } from './compositeTracksSlice';
import { createSavedTracksSlice } from './savedTracksSlice';
import type { SavedTracksSlice } from './savedTracksSlice';
import { createNavigationSlice } from './navigationSlice';
import type { NavigationSlice } from './navigationSlice';
import { createHighlightSlice } from './highlightSlice';
import type { HighlightSlice } from './highlightSlice';
import { createSvSlice } from './svSlice';
import { setClusterGroupLabelSource } from '../utils/clusterGroupLabels';
import type { SvSlice } from './svSlice';

// Composed BrowserState = intersection of all slices
export interface BrowserState extends
  ViewportSlice,
  DatasetSlice,
  ClusterSlice,
  PanelSlice,
  ColormapSlice,
  UiSlice,
  JupyterSlice,
  PrimerSlice,
  SelectionSlice,
  HistorySlice,
  AnnotationSlice,
  CaptureSlice,
  PeakRuleSlice,
  CatalogSlice,
  CompositeTracksSlice,
  SavedTracksSlice,
  NavigationSlice,
  HighlightSlice,
  SvSlice
{}


// Helper: expand selected datasets via linkGroup to include all linked panels.
// Returns IDs in panel arrangement order (not load order) so charts reflect
// the user's panel ordering.
export function getTargetDatasetIds(
  selectedDatasets: Set<string>,  // panel IDs (not dataset IDs)
  panels: PanelConfig[],
  allDatasets: { id: string }[]
): string[] {
  // Dataset panels in their current arrangement order
  const datasetPanels = panels.filter(
    (p): p is PanelConfig & { datasetId: string } =>
      p.contentType === 'dataset' && p.datasetId != null
  );
  // Panel-ordered dataset IDs, deduped (duplicated panels share datasetId)
  const seen = new Set<string>();
  const orderedAll: string[] = [];
  for (const p of datasetPanels) {
    if (!seen.has(p.datasetId)) { seen.add(p.datasetId); orderedAll.push(p.datasetId); }
  }
  for (const d of allDatasets) {
    if (!seen.has(d.id)) { seen.add(d.id); orderedAll.push(d.id); }
  }

  if (selectedDatasets.size === 0) return orderedAll;

  // Map selected panel IDs → dataset IDs, expanding link groups
  const selectedDsIds = new Set<string>();
  const selectedLinkGroups = new Set<string>();
  for (const p of datasetPanels) {
    // A member folded into a selected graph host is selected with it (its band is in the host's graph).
    if (selectedDatasets.has(p.id) || selectedWithHost(p, panels, selectedDatasets)) {
      selectedDsIds.add(p.datasetId);
      if (p.linkGroup) selectedLinkGroups.add(p.linkGroup);
    }
  }
  if (selectedLinkGroups.size > 0) {
    for (const p of datasetPanels) {
      if (p.linkGroup && selectedLinkGroups.has(p.linkGroup)) {
        selectedDsIds.add(p.datasetId);
      }
    }
  }
  return orderedAll.filter(id => selectedDsIds.has(id));
}

/** A member folded into a shown graph whose host is selected (graph features: the host and its folded members are
 * one comparison, as Cluster targets them). */
function selectedWithHost(p: PanelConfig, panels: readonly PanelConfig[], selected: Set<string>): boolean {
  const host = p.collapsed ? foldedInShownGraph(p, panels) : null;
  return Boolean(host && selected.has(host.id));
}

/** Map datasetId → stateKeys for the targeted panels. Used to store operation results per-panel. */
export function getStateKeyMap(
  selectedDatasets: Set<string>,  // panel IDs
  panels: PanelConfig[],
  allDatasets: { id: string }[]
): Record<string, string[]> {
  const datasetPanels = panels.filter(
    (p): p is PanelConfig & { datasetId: string } =>
      p.contentType === 'dataset' && p.datasetId != null
  );
  const targetDsIds = getTargetDatasetIds(selectedDatasets, panels, allDatasets);
  const targetDsSet = new Set(targetDsIds);
  // With panels selected: those panels and every panel linked to one of them
  // (getTargetDatasetIds expands link groups the same way).
  const selectedLinkGroups = new Set(
    datasetPanels.filter(p => selectedDatasets.has(p.id) && p.linkGroup).map(p => p.linkGroup as string),
  );
  const targeted = (p: PanelConfig) =>
    selectedDatasets.size === 0 || selectedDatasets.has(p.id) || (p.linkGroup != null && selectedLinkGroups.has(p.linkGroup))
    || selectedWithHost(p, panels, selectedDatasets);
  const map: Record<string, string[]> = {};
  for (const p of datasetPanels) {
    if (!targetDsSet.has(p.datasetId)) continue;
    // If panels are selected, only include the targeted panels (not all panels of this dataset)
    if (!targeted(p)) continue;
    const key = p.stateKey ?? p.datasetId;
    if (!map[p.datasetId]) map[p.datasetId] = [];
    if (!map[p.datasetId].includes(key)) map[p.datasetId].push(key);
  }
  // Fallback only for datasets without any panel (their state lives under the dataset ID)
  const withPanels = new Set(datasetPanels.map(p => p.datasetId));
  for (const dsId of targetDsIds) {
    if (!map[dsId] && !withPanels.has(dsId)) map[dsId] = [dsId];
  }
  return map;
}

// Helper: check if target datasets share a link group (≥2 panels in same group)
export function isLinkedGroup(targetIds: string[], panels: PanelConfig[]): boolean {
  const targetPanels = panels.filter(
    p => p.contentType === 'dataset' && p.datasetId && targetIds.includes(p.datasetId)
  );
  const groups = targetPanels.map(p => p.linkGroup).filter(g => g !== null);
  return groups.length >= 2 && new Set(groups).size < groups.length;
}


export const useBrowserStore = create<BrowserState>((set, get) => ({
  ...createViewportSlice(set, get),
  ...createDatasetSlice(set, get),
  ...createClusterSlice(set, get),
  ...createPanelSlice(set, get),
  ...createColormapSlice(set, get),
  ...createUiSlice(set, get),
  ...createJupyterSlice(set, get),
  ...createPrimerSlice(set, get),
  ...createSelectionSlice(set, get),
  ...createHistorySlice(set, get),
  ...createAnnotationSlice(set, get),
  ...createCaptureSlice(set, get),
  ...createPeakRuleSlice(set, get),
  ...createCatalogSlice(set, get),
  ...createCompositeTracksSlice(set, get),
  ...createSavedTracksSlice(set, get),
  ...createNavigationSlice(set as any, get),
  ...createHighlightSlice(set as any, get),
  ...createSvSlice(set as any, get),
}) as BrowserState);

// Cluster names a group source set (svSlice) reach getClusterLabel's call sites.
// Only when some panel has names: otherwise no work on clustering updates.
let lastClusterGroupLabels: BrowserState['clusterGroupLabels'] | undefined;
let lastClusterAssignments: BrowserState['clusterAssignments'] | undefined;
useBrowserStore.subscribe(state => {
  const named = Object.keys(state.clusterGroupLabels ?? {}).length > 0;
  if (state.clusterGroupLabels === lastClusterGroupLabels
    && (!named || state.clusterAssignments === lastClusterAssignments)) return;
  lastClusterGroupLabels = state.clusterGroupLabels;
  lastClusterAssignments = state.clusterAssignments;
  setClusterGroupLabelSource(state.clusterGroupLabels, named ? state.clusterAssignments : null);
});

// Motif preferences persist like the footprint cart: whatever changes them (a motif view, undo, a session) is written
// back to localStorage.
useBrowserStore.subscribe((state, previous) => {
  if (state.pinnedMotifs !== previous.pinnedMotifs) storePinnedMotifs(state.pinnedMotifs);
  if (state.motifScoreMode !== previous.motifScoreMode || state.motifPValue !== previous.motifPValue) storeMotifScoring({ mode: state.motifScoreMode, p: state.motifPValue });
  if (state.customMotifs !== previous.customMotifs) storeCustomMotifs(state.customMotifs);
});

// Plugin packs' state (stores/storeExtensions.ts) joins the store now, or when their pack registers.
connectStoreExtensions(useBrowserStore as never);

// A refusal belongs to the locus where the operation was attempted.
useBrowserStore.subscribe((state, previous) => {
  if (state.chrom === previous.chrom && state.start === previous.start && state.end === previous.end) return;
  const { results, clearRunResult } = useRunResultStore.getState();
  for (const kind of ['cluster', 'sort', 'filter'] as const) {
    if (results[kind]?.tone === 'error') clearRunResult(kind);
  }
});

setSignalFilterSource(() => useBrowserStore.getState().signalFilters);
function readSourceKey(dataset: Dataset): string {
  return JSON.stringify([
    dataset.source_identity ?? dataset.paths ?? dataset.path ?? dataset.id,
    dataset.data_type, dataset.layer_type, dataset.companion_layers, dataset.derived_layers,
  ]);
}
useBrowserStore.subscribe((state, previous) => {
  if (state.signalFilters !== previous.signalFilters) {
    clearLoadedReadRegions();
    return;
  }
  if (state.datasets === previous.datasets) return;
  // Read responses discover available layers; labels and panel order also
  // change this array. None changes the molecules or invalidates a pending
  // neighboring fill. Only changes to the underlying sources do that.
  const sources = new Map(previous.datasets.map(dataset => [dataset.id, readSourceKey(dataset)]));
  if (state.datasets.length !== sources.size
    || state.datasets.some(dataset => sources.get(dataset.id) !== readSourceKey(dataset))) clearLoadedReadRegions();
});
