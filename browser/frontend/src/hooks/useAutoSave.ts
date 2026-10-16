import { projectionForSave } from '../utils/projectionExport';
import { getGenomeDeclarations } from '../api/reference';
import { useEffect, useRef } from 'react';
import { useBrowserStore } from '../stores/browserStore';
import { serializeState } from '../stores/historySlice';
import { hasRestoredWork, loadAutoSave, saveAutoSave } from '../stores/historyStorage';
import type { SerializedState } from '../stores/historySlice';
import { autoSaveHasWork } from '../components/controls/CrashRecoveryBanner';
import { closedDatasetReference } from '../stores/panelGenomeStore';
import { getLaunchInfo, lastSessionSuperseded, launchOfferPending, useLaunchUiStore } from '../utils/launchSession';
import { isSandboxPage } from '../utils/sandbox';
import { useReadActionsStore } from '../stores/readActionsStore';
import { extensionKeys } from '../stores/storeExtensions';

const AUTO_SAVE_INTERVAL_MS = 30_000; // 30 seconds (periodic background tick)
const CHANGE_DEBOUNCE_MS = 1500;       // commit shortly after catalog/cart changes
const VIEWPORT_DEBOUNCE_MS = 4000;     // the locus a reopened session comes back at
/** Moving around: saved after a pause, so a quit reopens where you were. */
export const AUTO_SAVE_VIEWPORT_KEYS = ['chrom', 'start', 'end'] as const;
export const AUTO_SAVE_WATCHED_KEYS = [
  // A genome declared for a FASTA (api/reference.declareGenome bumps it).
  'referenceRevision',
  'signalFilters',
  'clusterPreparationCount', 'clusterPreparationSamples', 'analysisSampleCount',
  'analysisSampleSeed',
  'downsampleCount',
  'readDisplayMode',
  'allReadsDisplayCap',
  'backgroundReadCap',
  'spanningOnly',
  'clusterAssignments',
  'clusterOrder',
  'clusterPatterns',
  'clusterCentroids',
  'clusterPeakWidths',
  'clusterPeakRegions',
  'clusterWindowPeaks', 'clusterMatchedRun',
  'clusterTreeNodes',
  'clusterTreeRootIds',
  'activeClusterTreeNodeId',
  'clusterFeatureRules',
  'analysisSortRules',
  'analysisFilterRules',
  'readSortOrder',
  'filteredReadIds',
  'clusterFocus',
  'readStateDetails',
  'peakRules',
  'peaksByRule',
  'peaksLocked',
  'selectedPeaks',
  'selectedDatasets',
  'selectedReadIds',
  'selectedGenes',
  'transcriptionStateFilters',
  'activeColormap',
  'footprintGroups',
  'selectedFeatures',
  'pinnedMotifs',
  'motifScoreMode',
  'motifPValue',
  'customMotifs',
  'captureRegions',
  'capturePadding',
  'navigatorRegions',
  'catalog',
  'compositeTracks',
  'savedTracks',
  'enabledModTypes',
  'enabledMetaProfiles',
  'cachedLayerTypes',
  'clickTargetLayer',
  'footprintAnalysisLayer',
  'panels',
  'showHiddenTrackStrip',
  'hiddenStripPanels',
  'analysisStripCollapsed',
  'cooccClusterSelections',
  'readRowHeight',
  'readSeparatorMode',
  'readSeparatorMinHeight',
  'readSeparatorWidth',
  'maxRegionForReads',
  // The Highlight group's highlights (an add, rename, recolour or removal is saved at once).
  'highlights',
  // A new Projection map.
  'readProjection',
] as const;

/** Worth offering back after a reload: anything the user did (undo
 * history), or analysis the restore check recognises. */
export function entryHasWork(entry: { state: SerializedState; acted?: boolean } | null): boolean {
  return Boolean(entry && (entry.acted || autoSaveHasWork(entry.state)));
}

/**
 * Save the current page for crash recovery. A page with nothing done yet
 * (a fresh load, or just a genome/FASTA loaded) never replaces a save that
 * has work in it: that work would be gone after the next reload.
 */
export async function autoSaveNow(): Promise<void> {
  // A session being restored is half there: the saved copy stays until the
  // restore is done (it saves itself then).
  if (useLaunchUiStore.getState().restoring) return;
  const state = useBrowserStore.getState();
  const serialized = withDatasetReferences(serializeState(state));
  // The Projection map, so "reopen last session" brings it back with its clustering (not in undo snapshots: too big).
  const projection = projectionForSave(state);
  if (projection) serialized.readProjection = projection;
  // Genomes declared for custom FASTAs live on the server: a restarted server has lost them (Reopen puts them back).
  const declarations = await getGenomeDeclarations().catch(() => null);
  if (declarations && declarations.length) serialized.genomeDeclarations = declarations;
  // Moving around alone isn't work to offer back.
  const acted = hasRestoredWork() || (state._historyStack ?? []).some(snapshot => snapshot.kind !== 'navigation');
  // The last session is being offered back: keep it until something is done here.
  if (!acted && launchOfferPending()) return;
  if (!acted && !autoSaveHasWork(serialized) && !lastSessionSuperseded() && entryHasWork(await loadAutoSave())) return;
  const launch = await getLaunchInfo();
  // A restore started meanwhile: this is the page before it.
  if (useLaunchUiStore.getState().restoring) return;
  await saveAutoSave(serialized, acted, launch?.boot_id ?? null);
}

/** Each dataset with the reference of its own it is on (a panel genome): a
 * session reopened on a restarted server attaches it again. */
export function withDatasetReferences(serialized: SerializedState): SerializedState {
  if (!serialized.datasets?.length) return serialized;
  return {
    ...serialized,
    datasets: serialized.datasets.map(d => {
      const reference = closedDatasetReference(d.id);
      return reference ? { ...d, reference } : d;
    }),
  };
}

function commit() {
  const state = useBrowserStore.getState();
  // Save when there's anything worth restoring — datasets, catalog entries,
  // or composite tracks beyond the seeded default. Without this, loading
  // bigwigs (no BAM) never triggered an autosave and the catalog was lost
  // on every reload.
  const hasContent =
    state.datasets.length > 0 ||
    state.catalog.length > 0 ||
    state.compositeTracks.some(c => c.id !== '__default_metaprofile__') ||
    state.savedTracks.length > 0;
  if (hasContent) void autoSaveNow();
}

/**
 * Auto-saves the current state to IndexedDB:
 *   - Every 30 seconds (background tick).
 *   - 1.5s after any change to reproducibility-critical analysis state.
 *   - 4s after the view moves (a reopened session comes back at that locus).
 *
 * The change-triggered save makes analysis/cart/session edits durable as soon
 * as they're created, instead of relying on the next 30s tick. Mount once at
 * the top.
 */
export function useAutoSave() {
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const changeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (typeof window !== 'undefined' && window.__FIBERBROWSER_RENDER_MODE) return;
    // A tour tab (sandbox) is throwaway: its saves would replace the session the
    // next launch offers back (one IndexedDB per origin).
    if (isSandboxPage()) return;
    timerRef.current = setInterval(commit, AUTO_SAVE_INTERVAL_MS);

    // Subscribe to session-critical changes; commit on a short debounce so
    // bursts of UI edits collapse to a single write.
    const unsub = useBrowserStore.subscribe((state, prev) => {
      const changed = AUTO_SAVE_WATCHED_KEYS.some(key => state[key] !== prev[key])
        // Plugin packs' saved state (stores/storeExtensions.ts).
        || extensionKeys().some(key => (state as unknown as Record<string, unknown>)[key] !== (prev as unknown as Record<string, unknown>)[key]);
      if (changed || AUTO_SAVE_VIEWPORT_KEYS.some(key => state[key] !== prev[key])) {
        if (changeTimerRef.current) clearTimeout(changeTimerRef.current);
        changeTimerRef.current = setTimeout(commit, changed ? CHANGE_DEBOUNCE_MS : VIEWPORT_DEBOUNCE_MS);
      }
    });

    // Reads hidden with "Exclude selected" (kept in the read actions store) are saved too.
    const unsubExcluded = useReadActionsStore.subscribe((state, prev) => {
      if (state.excludedReadIds === prev.excludedReadIds) return;
      if (changeTimerRef.current) clearTimeout(changeTimerRef.current);
      changeTimerRef.current = setTimeout(commit, CHANGE_DEBOUNCE_MS);
    });

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (changeTimerRef.current) clearTimeout(changeTimerRef.current);
      unsub();
      unsubExcluded();
    };
  }, []);
}
