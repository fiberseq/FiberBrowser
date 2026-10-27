import type { BrowserState } from './browserStore';
import type { Gene, FirePeak, Dataset, DatasetProfile, OrthogonalTrack, OrthogonalTrackViewportData, ModificationOverlay, ViewMode, FireTrackType, PanelConfig, PanelContentType, SubTrackConfig, SubTrackType } from '../types';
import { panelTraits } from '../utils/panelExtensions';
import { DEBUG, generatePanelId, createDefaultSubTracks, createGenomeSubTracks, ensureBuiltinSubTracks } from './utils';
import { restoreOrphanSplitSources } from './splitSources';
import { mergeDatasets, unmergeDataset } from '../api/datasets';
import { cancelFirstReadsJump, markFirstReadsJump, viewportKey } from '../utils/firstReadsJump';
import { isLiveLift, opensOwnPanel } from '../utils/datasetKinds';


// ============================================================
// DATASET SLICE — Interface
// ============================================================

export interface DatasetSlice {
  genes: Gene[];
  fireSignal: number[];
  fireTrackType: FireTrackType;
  orthogonalTracks: OrthogonalTrack[];
  orthogonalTrackData: Record<number, OrthogonalTrackViewportData>;

  // Peak drawing
  datasetProfiles: Record<string, DatasetProfile>;
  // Per-cluster metaprofiles: datasetId -> clusterId -> nuc occupancy array
  clusterProfiles: Record<string, Record<number, Record<string, number[]>>>;

  // Datasets
  datasets: Dataset[];
  viewMode: ViewMode;

  // Modification overlays (m6A/m5C bigBed files)
  modificationOverlays: ModificationOverlay[];

  // Jupyter integration
  trackFilters: Record<number, string[]>;  // track index -> active filter names
  setTrackFilter: (trackIdx: number, names: string[] | null) => void;
  /** The backend removed track `trackIdx` and shifted the ones after it down: filters follow their tracks. */
  shiftTrackFiltersAfterRemoval: (trackIdx: number) => void;

  // Reference sequence (FASTA)
  setGenes: (genes: Gene[]) => void;
  setFire: (peaks: FirePeak[], signal: number[], trackType?: FireTrackType) => void;
  setDatasetProfiles: (profiles: Record<string, DatasetProfile> | ((prev: Record<string, DatasetProfile>) => Record<string, DatasetProfile>)) => void;
  /** Per-cluster, per-layer metaprofiles — `datasetId → clusterId → layerKey → profile`.
   *  Layer keys mirror `enabledMetaProfiles` (e.g. `nuc`, `tf`, `fire`, `mod`,
   *  any custom layer or color-rule id). The Profiles tab renders one chart
   *  per enabled layer, with clusters as the series within each chart. */
  setClusterProfiles: (datasetId: string, profiles: Record<number, Record<string, number[]>>) => void;
  setOrthogonalTracks: (tracks: OrthogonalTrack[]) => void;
  reorderTracks: (fromIndex: number, toIndex: number) => void;

  // Dataset actions
  setDatasets: (datasets: Dataset[]) => void;
  setDatasetLabel: (datasetId: string, label: string) => void;
  mergeDatasetAvailableLayers: (datasetId: string, layerNames: string[]) => void;
  addDataset: (dataset: Dataset) => void;
  removeDataset: (datasetId: string) => void;
  reorderDatasets: (fromIndex: number, toIndex: number) => void;
  mergeSelectedPanels: () => Promise<void>;
  unmergeSelectedPanel: () => Promise<void>;
  setViewMode: (mode: ViewMode) => void;

  // Modification overlay actions
  setModificationOverlays: (overlays: ModificationOverlay[]) => void;
  addModificationOverlay: (overlay: ModificationOverlay) => void;
  removeModificationOverlay: (overlayId: string) => void;

  // Jupyter integration actions
}

// ============================================================
// DATASET SLICE — Implementation
// ============================================================

function sameNumberArray(a?: number[], b?: number[]): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function sameIntervals(a?: OrthogonalTrack['intervals'], b?: OrthogonalTrack['intervals']): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const av = a[i];
    const bv = b[i];
    if (av.start !== bv.start || av.end !== bv.end || av.name !== bv.name
        || av.strand !== bv.strand || av.score !== bv.score) {
      return false;
    }
    const aBlocks = av.blocks ?? [];
    const bBlocks = bv.blocks ?? [];
    if (aBlocks.length !== bBlocks.length) return false;
    for (let j = 0; j < aBlocks.length; j++) {
      if (aBlocks[j].start !== bBlocks[j].start || aBlocks[j].size !== bBlocks[j].size) {
        return false;
      }
    }
    if (av.cdsStart !== bv.cdsStart || av.cdsEnd !== bv.cdsEnd) return false;
  }
  return true;
}

function sameOrthogonalTrack(a: OrthogonalTrack | undefined, b: OrthogonalTrack): boolean {
  if (!a) return false;
  return a.index === b.index
    && a.label === b.label
    && a.renderMode === b.renderMode
    && a.category === b.category
    && a.path === b.path
    && a.format === b.format
    && a.motif_type === b.motif_type
    && a.motif_name === b.motif_name
    && a.motif_source === b.motif_source;
}

function trackMetadataOnly(track: OrthogonalTrack): OrthogonalTrack {
  if ((track.values?.length ?? 0) === 0 && track.intervals === undefined) return track;
  const { values: _values, intervals: _intervals, ...metadata } = track;
  return { ...metadata, values: [] };
}

function sameOrthogonalTrackData(
  a: OrthogonalTrackViewportData | undefined,
  b: OrthogonalTrackViewportData,
): boolean {
  if (!a) return false;
  return sameNumberArray(a.values, b.values) && sameIntervals(a.intervals, b.intervals);
}

export function createDatasetSlice(set: (partial: Partial<BrowserState> | ((state: BrowserState) => Partial<BrowserState>)) => void, get: () => BrowserState): DatasetSlice {
  return {
  genes: [],
  fireSignal: [],
  fireTrackType: 'fire',
  orthogonalTracks: [],
  orthogonalTrackData: {},
  datasetProfiles: {},
  clusterProfiles: {},

  datasets: [],
  viewMode: 'sideBySide',  // Default to side-by-side for easy comparison
  modificationOverlays: [],
  
  trackFilters: {},
  setTrackFilter: (trackIdx: number, names: string[] | null) => set(state => {
    const newFilters = { ...state.trackFilters };
    if (names && names.length > 0) {
      newFilters[trackIdx] = names;
    } else {
      delete newFilters[trackIdx];
    }
    return { trackFilters: newFilters };
  }),
  shiftTrackFiltersAfterRemoval: (trackIdx: number) => set(state => {
    const next: Record<number, string[]> = {};
    for (const [key, names] of Object.entries(state.trackFilters)) {
      const idx = Number(key);
      if (idx === trackIdx) continue;
      next[idx > trackIdx ? idx - 1 : idx] = names;
    }
    return { trackFilters: next };
  }),

  // Analysis panels
  setGenes: (genes) => set({ genes }),
  setFire: (peaks, signal, trackType = 'fire') => {
    if (DEBUG) {
      console.log(`[setFire] Setting ${peaks.length} peaks, trackType=${trackType}`);
      if (peaks.length > 0) {
        console.log(`[setFire] First peak: ${peaks[0].start}-${peaks[0].end} (idx=${peaks[0].index})`);
      }
    }
    // Write peaks into accessibility rule's peaksByRule
    const state = get();
    const accessibilityRule = state.peakRules.find(r => r.source === 'accessibility');
    const ruleId = accessibilityRule?.id ?? 'default-accessibility';
    state.setPeaksByRule(ruleId, peaks);
    return set({ fireSignal: signal, fireTrackType: trackType });
  },
  setDatasetProfiles: (profilesOrFn) => set((state) => {
    // Accept either a direct value or an updater function
    const newProfiles = typeof profilesOrFn === 'function' 
      ? profilesOrFn(state.datasetProfiles)
      : profilesOrFn;
    return { datasetProfiles: newProfiles };
  }),
  setClusterProfiles: (datasetId, profiles) => set((state) => ({
    clusterProfiles: { ...state.clusterProfiles, [datasetId]: profiles }
  })),
  setOrthogonalTracks: (tracks) => set(state => {
    // Composite tracks (cart) now own the rendering slots; we no longer
    // project new `ortho-${index}` entries into panel subTracks. Existing
    // ortho-* slots stay in place for backwards compatibility (legacy session
    // restore) and are pruned when their underlying track disappears.
    //
    // Critical perf note: only mutate `panels` if the resulting subTracks
    // actually differ. Returning a fresh `panels` array on every call (even
    // when content is identical) churns every panels-derived useMemo —
    // including `getTargetDatasetIds` — which re-fires expensive analysis
    // effects (footprint analyze, JASPAR fetch, etc.) on every viewport
    // refresh. setOrthogonalTracks runs on every fetch, so this matters.
    const previousByIndex = new Map(state.orthogonalTracks.map(track => [track.index, track]));
    let tracksChanged = tracks.length !== state.orthogonalTracks.length;
    const nextTracks = tracks.map(track => {
      const metadata = trackMetadataOnly(track);
      const previous = previousByIndex.get(track.index);
      if (sameOrthogonalTrack(previous, metadata)) return previous!;
      tracksChanged = true;
      return metadata;
    });

    const previousData = state.orthogonalTrackData;
    const previousDataKeys = Object.keys(previousData);
    const nextData: Record<number, OrthogonalTrackViewportData> = {};
    let dataChanged = false;
    for (const track of tracks) {
      const hasValues = (track.values?.length ?? 0) > 0;
      const hasIntervals = track.intervals !== undefined;
      if (!hasValues && !hasIntervals) continue;
      const data: OrthogonalTrackViewportData = {
        values: track.values ?? [],
        ...(track.intervals !== undefined ? { intervals: track.intervals } : {}),
      };
      const previous = previousData[track.index];
      if (sameOrthogonalTrackData(previous, data)) {
        nextData[track.index] = previous;
      } else {
        nextData[track.index] = data;
        dataChanged = true;
      }
    }
    // Key-count mismatch flags both new viewport data and the "all surviving
    // entries unchanged after removal" case. Empty inactive tracks are omitted
    // from orthogonalTrackData; consumers already treat missing data as empty.
    if (previousDataKeys.length !== Object.keys(nextData).length) dataChanged = true;

    if (!tracksChanged) {
      for (let i = 0; i < tracks.length; i++) {
        if (state.orthogonalTracks[i]?.index !== tracks[i].index) {
          tracksChanged = true;
          break;
        }
      }
    }

    const newOrthoTypes = new Set(nextTracks.map(t => `ortho-${t.index}` as SubTrackType));
    let panelsChanged = false;
    const updatedPanels = state.panels.map(panel => {
      const filtered = panel.subTracks.filter(
        st => !st.type.startsWith('ortho-') || newOrthoTypes.has(st.type)
      );
      const newSubTracks = ensureBuiltinSubTracks(filtered);
      const sameLength = newSubTracks.length === panel.subTracks.length;
      const sameContent = sameLength && newSubTracks.every((st, i) => st === panel.subTracks[i]);
      if (sameContent) return panel;
      panelsChanged = true;
      return { ...panel, subTracks: newSubTracks };
    });
    if (!tracksChanged && !panelsChanged && !dataChanged) return {};
    return {
      ...(tracksChanged ? { orthogonalTracks: nextTracks } : {}),
      ...(panelsChanged ? { panels: updatedPanels } : {}),
      ...(dataChanged ? { orthogonalTrackData: nextData } : {}),
    };
  }),
  reorderTracks: (fromIndex, toIndex) => set(state => {
    const newTracks = [...state.orthogonalTracks];
    const [moved] = newTracks.splice(fromIndex, 1);
    newTracks.splice(toIndex, 0, moved);
    return { orthogonalTracks: newTracks };
  }),
  
  setDatasets: (datasets) => {
    // Queue an auto-select of layer / metaprofile toggles once the new
    // datasets are in place. Scheduled post-state-update so the defaults
    // helper sees the new `available_layers` when it reads them.
    queueMicrotask(() => {
      const state = get();
      state.initModTypeDefaults();
      state.seedDefaultMetaprofile();
    });
    set(state => {
    // Initialize slotOrder with dataset IDs, preserving any existing panel entries
    const panelIds = state.slotOrder.filter(id => id.startsWith('panel-'));
    const dsIds = datasets.map(d => d.id);
    // Remove genome-only panel when datasets are loaded
    const basePanels = datasets.length > 0
      ? state.panels.filter(p => p.id !== 'panel-genome')
      : state.panels;
    // Auto-create panels for new datasets
    const existingPanelDatasetIds = new Set(basePanels.filter(p => p.contentType === 'dataset').map(p => p.datasetId));
    // Determine link group: use existing group if panels exist, otherwise create one if multiple datasets
    const existingLinkGroup = state.panels.find(p => p.linkGroup)?.linkGroup;
    const defaultLinkGroup = existingLinkGroup || (datasets.length > 1 ? `link-${state.nextLinkGroupId}` : null);
    const newPanels = datasets
      // A live-lift source view's BAM shows only in its source view (opensOwnPanel).
      .filter(d => !existingPanelDatasetIds.has(d.id) && opensOwnPanel(d))
      .map(d => ({
        id: generatePanelId(),
        contentType: 'dataset' as PanelContentType,
        datasetId: d.id,
        ...(isLiveLift(d) ? { liftHaplotypeMode: d.live_lift?.settings?.haplotype_mode ?? 'split' } : {}),
        subTracks: createDefaultSubTracks(state.orthogonalTracks, state.compositeTracks),
        collapsed: false,
        linkGroup: defaultLinkGroup,
        layoutRow: 0,
      }));
    // Remove dataset panels for datasets that no longer exist; keep analysis panels
    const newDatasetIds = new Set(datasets.map(d => d.id));
    // A plugin pack's panel whose built dataset is not open yet (a restored session) stays while its source is
    // (utils/panelExtensions.ts traits): the pack rebuilds it.
    const keptPanels = basePanels.filter(p => p.contentType !== 'dataset' || newDatasetIds.has(p.datasetId!)
      || (() => { const keep = panelTraits(p).keptWithDataset; return Boolean(keep && newDatasetIds.has(keep)); })());
    // Datasets that went away take their panels' selections and analysis state with them.
    const panels = [...keptPanels, ...newPanels];
    const liveIds = new Set(panels.map(p => p.id));
    const goneKeys = new Set<string>();
    for (const p of state.panels) {
      if (p.contentType !== 'dataset' || !p.datasetId || newDatasetIds.has(p.datasetId)) continue;
      goneKeys.add(p.datasetId);
      if (p.stateKey) goneKeys.add(p.stateKey);
    }
    const prune = (sel: Set<string>) => ([...sel].every(id => liveIds.has(id)) ? sel : new Set([...sel].filter(id => liveIds.has(id))));
    const dropGone = <V,>(rec: Record<string, V>): Record<string, V> =>
      (Object.keys(rec).some(k => goneKeys.has(k)) ? Object.fromEntries(Object.entries(rec).filter(([k]) => !goneKeys.has(k))) : rec);
    return {
      datasets,
      slotOrder: [...dsIds, ...panelIds],
      panels,
      nextLinkGroupId: (!existingLinkGroup && defaultLinkGroup) ? state.nextLinkGroupId + 1 : state.nextLinkGroupId,
      selectedDatasets: prune(state.selectedDatasets),
      selectedPanelIds: prune(state.selectedPanelIds),
      ...(goneKeys.size > 0 ? {
        clusterAssignments: dropGone(state.clusterAssignments),
        clusterOrder: dropGone(state.clusterOrder),
        readSortOrder: dropGone(state.readSortOrder),
        clusterFocus: dropGone(state.clusterFocus),
        filteredReadIds: dropGone(state.filteredReadIds),
        readFilterSources: dropGone(state.readFilterSources),
        activeReadIds: dropGone(state.activeReadIds),
        readStateDetails: dropGone(state.readStateDetails),
        clusterProfiles: dropGone(state.clusterProfiles),
        datasetProfiles: dropGone(state.datasetProfiles),
        selectedReadIds: dropGone(state.selectedReadIds),
      } : {}),
    };
    });
  },
  setDatasetLabel: (datasetId, label) => set(state => ({
    datasets: state.datasets.map(dataset =>
      dataset.id === datasetId ? { ...dataset, label: label.trim() || dataset.label } : dataset
    ),
  })),
  mergeDatasetAvailableLayers: (datasetId, layerNames) => {
    const names = Array.from(new Set(layerNames.filter(Boolean)));
    if (names.length === 0) return;
    set(state => {
      let changed = false;
      const datasets = state.datasets.map(dataset => {
        if (dataset.id !== datasetId) return dataset;
        const current = dataset.available_layers ?? {};
        if (names.every(name => current[name])) return dataset;
        changed = true;
        return {
          ...dataset,
          available_layers: {
            ...current,
            ...Object.fromEntries(names.map(name => [name, true])),
          },
        };
      });
      return changed ? { datasets } : {};
    });
  },
  addDataset: (dataset) => {
    {
      // Nothing on screen has reads yet (a fresh workspace, a genome at its
      // default locus): this dataset's first view goes to its reads if this
      // one has none (utils/firstReadsJump; anything moving the view first wins).
      const before = get();
      const known = before.datasets.some(d => d.id === dataset.id);
      const anyReads = Object.values(before.activeReadIds ?? {}).some(ids => (ids?.length ?? 0) > 0);
      if (!known && !anyReads) markFirstReadsJump(dataset.id, viewportKey(before.chrom, before.start, before.end));
    }
    queueMicrotask(() => {
      const state = get();
      state.initModTypeDefaults();
      state.seedDefaultMetaprofile();
    });
    set(state => {
    const newSlotOrder = state.slotOrder.includes(dataset.id)
      ? state.slotOrder
      : [...state.slotOrder, dataset.id];
    // Remove genome-only panel (will be replaced by dataset panel)
    const basePanels = state.panels.filter(p => p.id !== 'panel-genome');
    // Auto-create panel for new dataset
    const hasPanel = basePanels.some(p => p.contentType === 'dataset' && p.datasetId === dataset.id);

    // Find existing link group (link to existing panels by default)
    const existingLinkGroup = basePanels
      .filter(p => p.contentType === 'dataset' && p.datasetId !== null)
      .map(p => p.linkGroup)
      .find(g => g !== null) ?? (basePanels.filter(p => p.contentType === 'dataset' && p.datasetId !== null).length > 0 ? `link-${state.nextLinkGroupId}` : null);

    const newPanel: PanelConfig | null = hasPanel ? null : {
      id: generatePanelId(),
      contentType: 'dataset',
      datasetId: dataset.id,
      ...(isLiveLift(dataset) ? { liftHaplotypeMode: dataset.live_lift?.settings?.haplotype_mode ?? 'split' } : {}),
      subTracks: createDefaultSubTracks(state.orthogonalTracks, state.compositeTracks),
      collapsed: false,
      linkGroup: existingLinkGroup,  // Link to existing panels by default
      layoutRow: 0,
    };

    // If creating a new link group, also link existing unlinked panels
    const shouldLinkExisting = newPanel && existingLinkGroup && !basePanels.some(p => p.linkGroup === existingLinkGroup);
    const updatedPanels = shouldLinkExisting
      ? basePanels.map(p => p.contentType === 'dataset' && p.linkGroup === null
          ? { ...p, linkGroup: existingLinkGroup }
          : p)
      : basePanels;
    // New panels open side by side; the panel menu stacks one (M17).
    const placedPanels = newPanel ? [...updatedPanels, newPanel] : updatedPanels;

    // Auto-enable 'nuc' toggle when a v3 BAM (exposing nuc via MA) arrives.
    // Only turn on, never off — preserves an explicit user disable.
    const hasNucLayer = dataset.available_layers?.nuc;
    const nextEnabledModTypes = hasNucLayer
      ? { ...state.enabledModTypes, nuc: state.enabledModTypes.nuc || true }
      : state.enabledModTypes;

    return {
      // Once per ID: a dataset the page already has (taken from the server while its own open was on its way) is
      // updated, never listed twice.
      datasets: state.datasets.some(d => d.id === dataset.id)
        ? state.datasets.map(d => (d.id === dataset.id ? dataset : d)) : [...state.datasets, dataset],
      slotOrder: newSlotOrder,
      panels: placedPanels,
      downsampleCount: state.downsampleCount,
      nextLinkGroupId: shouldLinkExisting ? state.nextLinkGroupId + 1 : state.nextLinkGroupId,
      enabledModTypes: nextEnabledModTypes,
    };
    });
  },
  removeDataset: (datasetId) => set(state => {
    // A dataset closed before its first view loaded doesn't go to its reads later.
    cancelFirstReadsJump(datasetId);
    // Remove panels for this dataset; collect their IDs and stateKeys for keyed-map cleanup
    const removedPanelIds = new Set(
      state.panels
        .filter(p => p.contentType === 'dataset' && p.datasetId === datasetId)
        .map(p => p.id)
    );
    const keysToRemove = new Set([datasetId]);
    // Also remove stateKeys that map to this dataset (duplicated panels)
    for (const p of state.panels) {
      if (p.datasetId === datasetId && p.stateKey) keysToRemove.add(p.stateKey);
    }

    const filterRecord = <V>(rec: Record<string, V>): Record<string, V> =>
      Object.fromEntries(Object.entries(rec).filter(([k]) => !keysToRemove.has(k)));

    // Remove from selectedDatasets (stores panel IDs)
    const newSelectedDatasets = new Set(state.selectedDatasets);
    for (const pid of removedPanelIds) newSelectedDatasets.delete(pid);

    const remainingDatasets = state.datasets.filter(d => d.id !== datasetId);
    // A split whose last panel goes with it (its Carriers panel on an alt dataset) shows its source again.
    let resultPanels = restoreOrphanSplitSources(state.panels.filter(p => !removedPanelIds.has(p.id)));

    // If no datasets remain, create a genome-only panel for browsing
    if (remainingDatasets.length === 0 && state.chroms.length > 0) {
      resultPanels = resultPanels.filter(p => p.id !== 'panel-genome');
      resultPanels.push({
        id: 'panel-genome',
        contentType: 'dataset' as PanelContentType,
        datasetId: null,
        subTracks: createGenomeSubTracks(state.orthogonalTracks, state.compositeTracks),
        collapsed: false,
        linkGroup: null,
        layoutRow: 0,
      });
    }

    return {
      datasets: remainingDatasets,
      slotOrder: state.slotOrder.filter(s => s !== datasetId),
      panels: resultPanels,
      fullViewPanelId: removedPanelIds.has(state.fullViewPanelId || '') ? null : state.fullViewPanelId,
      selectedDatasets: newSelectedDatasets,
      clusterAssignments: filterRecord(state.clusterAssignments),
      clusterOrder: filterRecord(state.clusterOrder),
      readSortOrder: filterRecord(state.readSortOrder),
      clusterFocus: filterRecord(state.clusterFocus),
      filteredReadIds: filterRecord(state.filteredReadIds),
      readFilterSources: filterRecord(state.readFilterSources),
      activeReadIds: filterRecord(state.activeReadIds),
      readStateDetails: filterRecord(state.readStateDetails),
      clusterProfiles: filterRecord(state.clusterProfiles),
      datasetProfiles: filterRecord(state.datasetProfiles),
      selectedReadIds: filterRecord(state.selectedReadIds),
    };
  }),
  setViewMode: (mode) => set({ viewMode: mode }),
  reorderDatasets: (fromIndex, toIndex) => set(state => {
    const newDatasets = [...state.datasets];
    const [moved] = newDatasets.splice(fromIndex, 1);
    newDatasets.splice(toIndex, 0, moved);
    // Sync slotOrder to match new dataset order (keeping panels in place)
    const panelIds = state.slotOrder.filter(id => id.startsWith('panel-'));
    return { datasets: newDatasets, slotOrder: [...newDatasets.map(d => d.id), ...panelIds] };
  }),
  mergeSelectedPanels: async () => {
    const state = get();
    // Get dataset IDs from selected dataset panels
    const datasetIds = state.panels
      .filter(p => state.selectedPanelIds.has(p.id) && p.contentType === 'dataset' && p.datasetId)
      .map(p => p.datasetId!);
    if (datasetIds.length < 2) return;
    const res = await mergeDatasets(datasetIds);
    if (!res.success || !res.dataset || !res.removed_ids) {
      console.error('Merge failed:', res.error);
      get().setError(res.error || 'Merge failed');
      return;
    }
    // Remove old datasets, add merged one
    for (const id of res.removed_ids) {
      get().removeDataset(id);
    }
    get().addDataset(res.dataset);
    set({ selectedPanelIds: new Set<string>() });
    // NOTE: No pushSnapshot — merge changes backend state (dataset IDs), so undo can't restore it
  },
  unmergeSelectedPanel: async () => {
    const state = get();
    // Get the single selected dataset panel
    const panel = state.panels.find(p => state.selectedPanelIds.has(p.id) && p.contentType === 'dataset');
    if (!panel?.datasetId) return;
    const res = await unmergeDataset(panel.datasetId);
    if (!res.success || !res.datasets || !res.removed_id) {
      console.error('Unmerge failed:', res.error);
      get().setError(res.error || 'Unmerge failed');
      return;
    }
    get().removeDataset(res.removed_id);
    for (const ds of res.datasets) {
      get().addDataset(ds);
    }
    set({ selectedPanelIds: new Set<string>() });
    // NOTE: No pushSnapshot — unmerge changes backend state (dataset IDs), so undo can't restore it
  },

  // Modification overlay actions
  setModificationOverlays: (overlays) => set({ modificationOverlays: overlays }),
  addModificationOverlay: (overlay) => set(state => ({ 
    modificationOverlays: [...state.modificationOverlays, overlay]
  })),
  removeModificationOverlay: (overlayId) => set(state => ({
    modificationOverlays: state.modificationOverlays.filter(o => o.id !== overlayId),
  })),
  
  // Jupyter integration
  };
}
