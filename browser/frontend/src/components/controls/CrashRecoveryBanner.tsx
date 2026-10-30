import { normalizeSvConflictOptions } from '../../utils/svConflicts';
import { useReadActionsStore } from '../../stores/readActionsStore';
import { useEffect, useRef, useState } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import { loadAutoSave, clearAutoSave, markRestoredWork } from '../../stores/historyStorage';
import { addDataset, getDatasets, type Dataset } from '../../api/datasets';
import { loadGenome, loadFasta, restoreGenomeDeclarations } from '../../api/reference';
import { fetchJson } from '../../api/sharedFetch';
import { deserializeSavedState, remapDatasetIds, type SerializedState, type SerializedDataset } from '../../stores/historySlice';
import { attachPanelGenome, getPanelGenomes, type PanelGenomeInfo } from '../../api/panelGenomes';
import { loadDerivedLayers } from '../../api/footprints';
import { activateConsensus, getConsensusJobs } from '../../api/consensusWorkflow';
import { derivedLayerSources } from '../../utils/datasetUndo';
import { usePanelGenomeStore } from '../../stores/panelGenomeStore';
import { toArray, toSet } from '../../stores/hydration';
import { migrateColormap, normalizeAnalysisFilterRules, normalizeAnalysisSortRules, normalizeClusterFeatureRules, normalizeTranscriptionStateFilters } from '../../stores/utils';
import { normalizeLayerToggleMap } from '../../utils/layerAliases';
import { formatTimeAgo } from '../../utils/time';
import type { AutoSaveEntry } from '../../stores/historyStorage';
import { RotateCcw } from '../ui/Icons';
import {
  decideLaunchOffer, describeSavedSession, getLastSessionPreference, getLaunchInfo,
  setLaunchOfferPending, setLaunchUi, supersedeLastSession, type LaunchOffer,
} from '../../utils/launchSession';
import type { SavedCluster } from '../../types/clustering';
import { genomeLoadHasFasta, serverGenomeLoaded } from '../../utils/genomeAutoload';
import { otherTabLive, startTabHeartbeat, stopTabHeartbeat, watchOtherTabs } from '../../utils/tabPresence';
import { restoreSavedProjection } from '../../utils/projectionExport';
import { withoutMissingPackState } from '../../api/sessionPacks';
import { clampMinSvSupport, SV_MIN_SUPPORT_DEFAULT } from '../tracks/read-track/svDrawing';

/** Normalize path for comparison (resolve trailing slashes, case on macOS). */
function normPath(p: string): string {
  return p.replace(/\/+$/, '');
}

/** JSON settings compared by value, including nested records, regardless of object key order. */
function orderedSettings(_key: string, value: unknown): unknown {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value;
}

/** The same files can be opened natively or with several different lift configurations. */
function sameDatasetConfiguration(saved: SerializedDataset, loaded: Dataset): boolean {
  // Older ordinary BAM snapshots and servers did not always include data_type.
  if ((saved.data_type ?? 'bam') !== (loaded.data_type ?? 'bam')) return false;
  const a = saved.live_lift;
  const b = loaded.live_lift;
  if (!a || !b) return !a && !b;
  return normPath(a.manifest) === normPath(b.manifest)
    && JSON.stringify([...a.haplotypes].sort()) === JSON.stringify([...b.haplotypes].sort())
    && JSON.stringify(a.settings, orderedSettings) === JSON.stringify(b.settings, orderedSettings);
}

/**
 * Reconcile saved datasets with current backend state.
 * - Matches existing backend datasets by paths, type and lift configuration (avoids duplicates)
 * - Only adds datasets not already on the backend
 * - Returns the final dataset list + an ID mapping (saved ID → actual ID)
 */
async function reconcileDatasets(savedDatasets: SerializedDataset[]): Promise<{
  datasets: any[];
  idMap: Record<string, string>;
}> {
  // 1. Get currently loaded datasets from backend
  const { datasets: currentDatasets } = await getDatasets();

  // 2. Match saved datasets to existing or add missing ones
  const idMap: Record<string, string> = {};
  const addedIds = new Set<string>();
  // Each loaded dataset stands for one saved dataset at most: two saved
  // datasets of the same file (opened twice, each with its own reference or
  // analysis) must not both land on one.
  const taken = new Set<string>();

  for (const saved of savedDatasets) {
    if (!saved.paths || saved.paths.length === 0) continue;

    // Reuse a backend dataset only when it holds exactly the saved files: a
    // merged [A, B] isn't restored by a loaded A alone. The saved dataset's
    // own id first (the same server run).
    const free = currentDatasets.filter(d => !taken.has(d.id) && sameDatasetConfiguration(saved, d));
    const sameId = free.find((d: { id: string }) => d.id === saved.id);
    const existingDs = (sameId && matchSavedDataset(saved.paths, [sameId])) || matchSavedDataset(saved.paths, free);

    if (existingDs) {
      // Dataset already on backend — just record the ID mapping
      idMap[saved.id] = existingDs.id;
      taken.add(existingDs.id);
      continue;
    }

    // Not on backend — add it
    try {
      const pathArg = saved.paths.length === 1 ? saved.paths[0] : saved.paths;
      const result = saved.live_lift
        ? await (await import('../../features/liveLift/api')).addLiveLiftDataset({
          paths: saved.paths, label: saved.label, manifest: saved.live_lift.manifest,
          haplotypes: saved.live_lift.haplotypes, settings: saved.live_lift.settings,
        })
        : await addDataset(pathArg, saved.label);
      if (result.success && result.dataset) {
        idMap[saved.id] = result.dataset.id;
        addedIds.add(result.dataset.id);
        taken.add(result.dataset.id);
      }
    } catch {
      console.warn(`Crash recovery: failed to reload dataset ${saved.id}`);
    }
  }

  // 3. Fetch final dataset list from backend (includes both CLI and newly added)
  const { datasets: finalDatasets } = await getDatasets();

  // 4. Restore colors from saved state
  for (const saved of savedDatasets) {
    const actualId = idMap[saved.id];
    if (actualId) {
      const target = finalDatasets.find((d: any) => d.id === actualId);
      if (target) target.color = saved.color;
    }
  }

  return { datasets: finalDatasets, idMap };
}

/** The loaded dataset made of exactly these files (order-insensitive), if any. */
export function matchSavedDataset<D extends { paths?: string[] | null }>(savedPaths: string[], loaded: D[]): D | undefined {
  const want = [...new Set(savedPaths.map(normPath))].sort();
  return loaded.find(ds => {
    const have = [...new Set((ds.paths || []).map(normPath))].sort();
    return have.length === want.length && have.every((p, i) => p === want[i]);
  });
}

/** Remap keys in a Record using an ID mapping. */
/** Saved clusterings keyed by the recovered datasets' IDs (panel keys too). */
export function remapSavedClusters(saved: readonly SavedCluster[], idMap: Record<string, string>): SavedCluster[] {
  return saved.map(entry => ({
    ...entry,
    assignments: remapRecord(entry.assignments ?? {}, idMap),
    order: remapRecord(entry.order ?? {}, idMap),
    ...(entry.panelResults ? {
      panelResults: entry.panelResults.map(result => ({
        ...result,
        datasetId: remapId(result.datasetId, idMap),
        stateKey: remapId(result.stateKey, idMap),
      })),
    } : {}),
  }));
}

/** A dataset id or a state key (`<id>` or `<id>:…`) under the recovered ids. */
function remapId(id: string, idMap: Record<string, string>): string {
  if (Object.prototype.hasOwnProperty.call(idMap, id)) return idMap[id];
  const colon = id.indexOf(':');
  const head = colon > 0 ? id.slice(0, colon) : '';
  return head && Object.prototype.hasOwnProperty.call(idMap, head) ? idMap[head] + id.slice(colon) : id;
}

function remapRecord<V>(rec: Record<string, V>, idMap: Record<string, string>): Record<string, V> {
  const out: Record<string, V> = {};
  for (const [k, v] of Object.entries(rec)) {
    out[remapId(k, idMap)] = v;
  }
  return out;
}

type ReferencePair = { fasta: string; annotation: string | null };
/** Same FASTAs in order; with annotations, also the same annotation for each. */
const samePairs = (a: ReferencePair[], b: ReferencePair[], withAnnotations: boolean) =>
  a.length === b.length && a.every((pair, i) => pair.fasta === b[i].fasta
    && (!withAnnotations || (pair.annotation ?? null) === (b[i].annotation ?? null)));

/**
 * The saved reference, as a collection when several FASTA/annotation pairs
 * were loaded together. Left alone when the server still has it (reloading a
 * single FASTA would drop the other pairs); a collection is reloaded whole.
 */
export async function restoreReference(s: Pick<SerializedState, 'fastaPath' | 'referencePairs'>): Promise<boolean> {
  if (!s.fastaPath) return false;
  // Saved pairs only describe the reference if they start with the saved FASTA
  // (another FASTA loaded since doesn't clear them).
  const pairs = s.referencePairs && s.referencePairs.length > 0 && s.referencePairs[0].fasta === s.fastaPath
    ? s.referencePairs : null;
  let current: ReferencePair[] = [];
  try {
    current = (await fetchJson<{ pairs: ReferencePair[] }>('/api/reference_pairs')).pairs ?? [];
  } catch { /* an older server: reload below */ }
  const wanted = pairs ?? [{ fasta: s.fastaPath, annotation: null }];
  let loaded = samePairs(current, wanted, pairs != null);
  // Saved pairs (one pair included: its annotation is part of it) reload as a
  // collection; a lone FASTA reloads as a FASTA.
  if (!loaded && pairs) {
    const res = await fetchJson<{ success: boolean; error?: string }>('/api/reference_pairs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pairs),
    });
    loaded = !!res.success;
  } else if (!loaded) {
    loaded = !!(await loadFasta(s.fastaPath)).success;
  }
  if (loaded) {
    useBrowserStore.setState({ hasFasta: true, fastaPath: s.fastaPath, referencePairs: pairs } as any);
  }
  return loaded;
}

/**
 * Restore a serialized state snapshot into the store, bypassing setViewport().
 * If the snapshot includes datasets, reconcile them with the backend first.
 */
export async function restoreSnapshot(saved: SerializedState) {
  // Saved by a build with plugin packs this one lacks: their panels, and the datasets only those showed, are left out
  // before anything is reopened (api/sessionPacks.ts).
  const s = withoutMissingPackState(saved);
  // Highlights, pins and exclusions belong to the workspace being replaced.
  useReadActionsStore.getState().reset();
  // 1. Reconcile datasets with backend (avoids duplicates, builds ID map)
  let idMap: Record<string, string> = {};
  if (s.datasets && s.datasets.length > 0) {
    const result = await reconcileDatasets(s.datasets);
    idMap = result.idMap;
    useBrowserStore.setState({ datasets: result.datasets } as any);
  }

  const hasRemap = Object.keys(idMap).some(k => idMap[k] !== k);
  // What could not be put back: said once the rest is restored.
  const problems: string[] = [];

  // 1a. Restore reference genome / FASTA on the backend first. Only a reference that
  // loaded becomes the page's: otherwise the page keeps the one the server has
  // (the saved name over another loaded reference would mislabel every locus).
  let referenceRestored = false;
  if (s.currentGenome) {
    try {
      // Already the server's (with its FASTA, maybe the user's own): kept as it is, never loaded again.
      const loaded = await serverGenomeLoaded(s.currentGenome);
      if (loaded) {
        referenceRestored = true;
        // The page's own FASTA label stays (the start-up hydration set it); the saved one only when it is the server's.
        const pageFasta = useBrowserStore.getState().fastaPath;
        useBrowserStore.setState({
          hasFasta: true,
          fastaPath: pageFasta ?? (s.fastaPath && s.fastaPath === loaded.fasta_path ? s.fastaPath : null),
          currentGenome: s.currentGenome,
        } as any);
      } else {
        const res = await loadGenome(s.currentGenome);
        if (res.success) {
          referenceRestored = true;
          useBrowserStore.setState({
            hasFasta: genomeLoadHasFasta(res),
            fastaPath: res.name || s.currentGenome,
            currentGenome: s.currentGenome,
          } as any);
        } else {
          problems.push(`the genome ${s.currentGenome} (${(res as { error?: string }).error ?? 'not loaded'}): load it from the genome menu`);
        }
      }
    } catch (e) {
      console.warn('Crash recovery: failed to reload genome', s.currentGenome, e);
      problems.push(`the genome ${s.currentGenome} (${e instanceof Error ? e.message : String(e)}): load it from the genome menu`);
    }
  } else if (s.fastaPath) {
    try {
      referenceRestored = await restoreReference(s);
      if (!referenceRestored) problems.push(`the reference ${s.fastaPath}: load it again (Open)`);
    } catch (e) {
      console.warn('Crash recovery: failed to reload FASTA', s.fastaPath, e);
      problems.push(`the reference ${s.fastaPath} (${e instanceof Error ? e.message : String(e)}): load it again (Open)`);
    }
  }

  // 1a'. Genomes declared for custom FASTAs (motif species, TE library): before anything genome-keyed runs.
  if (s.genomeDeclarations && s.genomeDeclarations.length) {
    try {
      await restoreGenomeDeclarations(s.genomeDeclarations);
    } catch (e) {
      problems.push(`the genomes declared for custom references (${e instanceof Error ? e.message : String(e)}): declare them again`);
    }
  }

  // 1b. Datasets on a reference of their own (panel genomes): a restarted
  // server has lost it, so attach it again; its key may differ now. After the
  // main reference (Codex 1): attaching dm6 while dm6 is still the main genome
  // would only make the dataset follow the main one, which then changes.
  const genomeKeys = await restoreDatasetReferences(s.datasets ?? [], idMap, problems);

  // 1c. Layers the datasets had attached that their files don't bring back
  // (footprint classes, loaded .fiberlayers bundles).
  await restoreSavedDerivedLayers(s.datasets ?? [], idMap, problems);

  // 2. The snapshot under the recovered datasets' ids (exact ids and
  // `<id>:…` state keys alike, in panels, records, cluster branches) and the
  // re-attached references' keys (panels, peaks). Everything below reads it.
  const r = renameGenomeKeys(remapDatasetIds(s, idMap), genomeKeys);
  const mapId = (id: string) => remapId(id, idMap);

  // 3. Reconstruct Sets from arrays
  const clusterAssignments = r.clusterAssignments ?? {};
  const clusterOrder = r.clusterOrder ?? {};
  const readSortOrder = r.readSortOrder ?? {};
  const readStateDetails = r.readStateDetails ?? {};
  const readFilterSources = r.readFilterSources ?? {};
  const filteredReadIds: Record<string, Set<string> | null> = {};
  for (const [k, v] of Object.entries(r.filteredReadIds ?? {})) filteredReadIds[k] = v ? toSet<string>(v) : null;
  const clusterFocus: Record<string, Set<number> | null> = {};
  for (const [k, v] of Object.entries(r.clusterFocus ?? {})) clusterFocus[k] = v ? toSet<number>(v) : null;
  const selectedReadIds: Record<string, Set<string>> = {};
  for (const [k, v] of Object.entries(r.selectedReadIds ?? {})) selectedReadIds[k] = toSet<string>(v);
  const clusterTreeNodes = (r.clusterTreeNodes ?? {}) as Record<string, unknown>;
  const selectedClusters: Record<string, Set<number>> = {};
  for (const [k, v] of Object.entries(r.selectedClusters ?? {})) selectedClusters[k] = toSet<number>(v);
  const selectedDatasets = toArray<string>(r.selectedDatasets).map(mapId);

  // 6. Restore UI state: everything undo knows how to put back (so fields
  // added to snapshots later come back too), then the recovery specifics.
  const base = deserializeSavedState(r) as Record<string, unknown>;
  delete base.datasets;  // the backend's list, reconciled above
  delete base.currentGenome;  // set by the genome reload above when it succeeded
  const currentPrimer = useBrowserStore.getState().primer;
  useBrowserStore.setState({
    ...base,
    chrom: r.chrom,
    start: r.start,
    end: r.end,
    isReversed: r.isReversed,
    showRelativeCoords: r.showRelativeCoords,
    relativeTSS: r.relativeTSS,
    ...(r.relativeGene !== undefined ? { relativeGene: r.relativeGene } : {}),
    selectedPeaks: toSet<number>(r.selectedPeaks),
    peakModes: r.peakModes as any,
    clusterK: r.clusterK,
    clusterResolution: r.clusterResolution ?? 1,
    clusterMethod: r.clusterMethod,
    // Rules and cluster branches, as undo restores them.
    clusterPeakMode: r.clusterPeakMode ?? 'accessibility',
    clusterFeatureRules: normalizeClusterFeatureRules(r.clusterFeatureRules),
    analysisSortRules: normalizeAnalysisSortRules(r.analysisSortRules),
    analysisFilterRules: normalizeAnalysisFilterRules(r.analysisFilterRules),
    clusterTreeNodes,
    clusterTreeRootIds: r.clusterTreeRootIds ?? [],
    activeClusterTreeNodeId: r.activeClusterTreeNodeId ?? null,
    selectedClusters,
    clusterAssignments,
    clusterOrder,
    clusterPatterns: r.clusterPatterns,
    clusterCentroids: r.clusterCentroids,
    clusterPeakWidths: r.clusterPeakWidths,
    clusterMetricCohort: r.clusterMetricCohort ?? {},
    clusterPeakRegions: r.clusterPeakRegions,
    dynamicClustering: r.dynamicClustering,
    dynamicOverlapMode: r.dynamicOverlapMode,
    readSortOrder,
    subnucleosomalThreshold: r.subnucleosomalThreshold,
    accessibilityThreshold: r.accessibilityThreshold,
    filteredReadIds,
    readFilterSources: readFilterSources as any,
    clusterFocus,
    readStateDetails: readStateDetails as any,
    transcriptionStateFilters: normalizeTranscriptionStateFilters(r.transcriptionStateFilters),
    // Restore peak rules + peaksByRule (rule-based system)
    ...(r.peakRules ? { peakRules: r.peakRules } : {}),
    ...(r.peaksByRule
      ? { peaksByRule: r.peaksByRule as any }
      : r.customPeaks && (r.customPeaks as any[]).length > 0
        ? { peaksByRule: { 'default-custom': r.customPeaks } as any }
        : {}),
    peaksLocked: r.peaksLocked ?? false,
    selectedGenes: r.selectedGenes as any,
    viewMode: r.viewMode as any,
    sortMode: r.sortMode as any,
    filterMode: r.filterMode as any,
    spanningOnly: r.spanningOnly,
    downsampleCount: r.downsampleCount,
    readDisplayMode: r.readDisplayMode === 'all' ? 'all' : 'sample',
    allReadsDisplayCap: r.allReadsDisplayCap ?? 10_000,
    backgroundReadCap: r.backgroundReadCap ?? null,
    clusterPreparationCount: r.clusterPreparationCount ?? null,
    clusterPreparationSamples: r.clusterPreparationSamples ?? {},
    analysisSampleCount: r.analysisSampleCount ?? null,
    analysisSampleSeed: r.analysisSampleSeed ?? 'fiberbrowser-analysis',
    enabledModTypes: normalizeLayerToggleMap(r.enabledModTypes as any) ?? {},
    enabledMetaProfiles: normalizeLayerToggleMap(r.enabledMetaProfiles as any) ?? {},
    cachedLayerTypes: normalizeLayerToggleMap(r.cachedLayerTypes as any) ?? {},
    clickTargetLayer: r.clickTargetLayer ?? null,
    footprintAnalysisLayer: r.footprintAnalysisLayer ?? null,
    // As history restore does: older autosaves predate these settings.
    legacyLayerInference: r.legacyLayerInference ?? true,
    legacyNucMinSize: r.legacyNucMinSize ?? 90,
    fillSmallGaps: r.fillSmallGaps,
    fillGapSize: r.fillGapSize,
    hideTerminalGaps: r.hideTerminalGaps,
    terminalGapThreshold: r.terminalGapThreshold,
    hideShortEndFootprints: r.hideShortEndFootprints ?? true,
    minFpQuality: r.minFpQuality,
    minFootprints: r.minFootprints,
    minFootprintsAuto: r.minFootprintsAuto ?? false,
    showDuplicateReads: r.showDuplicateReads ?? false,
    enabledCigarTypes: r.enabledCigarTypes,
    svDisplayEnabled: r.svDisplayEnabled ?? true,
    svMinLen: r.svMinLen ?? 50,
    svConflictOptions: normalizeSvConflictOptions(r.svConflictOptions),
    svMinSupport: clampMinSvSupport(r.svMinSupport ?? SV_MIN_SUPPORT_DEFAULT),
    darkMode: r.darkMode,
    peakSettings: r.peakSettings,
    activeColormap: migrateColormap(r.activeColormap as any),
    fillReadHeight: r.fillReadHeight,
    showReadTooltip: r.showReadTooltip,
    showCoverageHistogram: r.showCoverageHistogram,
    maxRegionForReads: r.maxRegionForReads ?? 100_000,
    motifThreshold: r.motifThreshold,
    sessionName: r.sessionName,
    uiScale: r.uiScale,
    readRowHeight: r.readRowHeight,
    readScrollOffsets: r.readDisplayMode === 'all' ? r.readScrollOffsets ?? {} : {},
    refreshGeneration: useBrowserStore.getState().refreshGeneration + 1,
    // Keep the saved clusters exactly; re-derive only after navigating away.
    restoredClusterViewport: r.chrom ? { chrom: r.chrom, start: r.start, end: r.end } : null,
    showGenomeOverview: r.showGenomeOverview ?? false,
    publicMode: r.publicMode ?? false,
    fullViewPanelId: r.fullViewPanelId,
    editMode: r.editMode,
    selectedReadIds,
    selectedDatasets: toSet<string>(selectedDatasets),
    selectedFootprints: r.selectedFootprints as any,
    footprintGroups: r.footprintGroups as any,
    footprintCrossHighlight: r.footprintCrossHighlight,
    savedClusters: renameGenomeKeys(hasRemap ? remapSavedClusters((s.savedClusters ?? []) as SavedCluster[], idMap) : (s.savedClusters ?? []), genomeKeys) as any,
    captureRegions: (r.captureRegions ?? []) as any,
    capturePadding: r.capturePadding ?? 0,
    hiddenStripPanels: toSet<string>(r.hiddenStripPanels),
    collapsedRows: toSet<number>(r.collapsedRows),
    analysisStripCollapsed: r.analysisStripCollapsed ?? false,
    cooccClusterSelections: r.cooccClusterSelections ?? [],
    // The saved genome, when it (or the saved FASTA, which replaces it) loaded again.
    ...(referenceRestored && r.currentGenome !== undefined ? { currentGenome: r.currentGenome } : {}),
    // Restore primer config
    ...(r.primerConfigBlastDb !== undefined || r.primerSavedPrimers !== undefined
      ? {
          primer: {
            ...currentPrimer,
            targetStart: null,
            targetEnd: null,
            pair: null,
            configFasta: currentPrimer.configFasta ?? null,
            configBlastDb: r.primerConfigBlastDb ?? null,
            designing: false,
            error: null,
            designResults: [],
            savedPrimers: (r.primerSavedPrimers as any[]) ?? [],
            dafcQuads: [],
            mode: currentPrimer.mode ?? 'standard',
            cartTrackDisplay: currentPrimer.cartTrackDisplay ?? 'off',
          },
        }
      : {}),
  } as any);

  // 7. Sync darkMode
  if (s.darkMode) {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
  localStorage.setItem('fiberhmm_darkmode', String(s.darkMode));

  // 8. Sync BLAST DB to localStorage
  if (s.primerConfigBlastDb) {
    localStorage.setItem('fiberhmm_blast_db', s.primerConfigBlastDb);
  }

  // 9. Restore catalog + cart. Backend track indices are process-local, so
  // sources stay metadata-only until a visible cart source or enabled rule
  // needs them.
  if (r.catalog) {
    useBrowserStore.getState().setCatalog(r.catalog);
  }
  if (r.compositeTracks) {
    useBrowserStore.getState().setCompositeTracks(r.compositeTracks);
  }
  if (r.savedTracks) {
    useBrowserStore.getState().setSavedTracks(r.savedTracks);
  }

  // 10. Panels on a reference of their own get its name and chromosomes.
  void usePanelGenomeStore.getState().refresh();

  // 11. Trigger data refetch
  useBrowserStore.getState().triggerRefresh();

  // 12. The Projection map the autosave kept (its datasets under their reopened
  // ids), signed with the restored inputs (after the refresh above moved the counter).
  if (s.readProjection) {
    useBrowserStore.setState({ readProjection: restoreSavedProjection(s.readProjection, idMap, useBrowserStore.getState()) } as any);
  }

  // 13. The rest is back; say what isn't.
  if (problems.length > 0) {
    useBrowserStore.getState().setError(`Reopened, except ${problems.join('; ')}.`);
  }
}

/**
 * The restored page is where its history starts: Undo then never goes back to
 * the page as it was before the restore (the empty launch view). Effects that
 * echo the restore (the view moved to the saved locus) are not steps either.
 */
export function startHistoryAtRestoredState(label: string): void {
  const store = useBrowserStore.getState();
  store.clearHistory();
  store.pushSnapshot(label, { kind: 'session' });
  useBrowserStore.setState({ _lastRestoreTime: Date.now() } as any);
}

type DerivedLayerMeta = { kind?: string; consensus_job_id?: string | null; bundle_path?: string | null; bundle_paths?: string[] | null };

/**
 * Attach again the derived layers saved datasets had: `.fiberlayers` bundles
 * are loaded from their files; a footprint-class run is shown again when this
 * server still has it (runs are kept in memory, not across a restart: then
 * it's reported). Layers already on the dataset are left alone.
 */
export async function restoreSavedDerivedLayers(
  saved: SerializedDataset[],
  idMap: Record<string, string>,
  problems: string[],
): Promise<void> {
  const store = useBrowserStore;
  const layersOf = (id: string) => Object.values(
    ((store.getState().datasets as Array<{ id: string; derived_layers?: Record<string, DerivedLayerMeta> }>).find(d => d.id === id)?.derived_layers) ?? {},
  );
  const jobs = new Map<string, string[]>();
  let changed = false;
  for (const dataset of saved) {
    const id = idMap[dataset.id];
    if (!id) continue;
    const { consensusJobs, bundles } = derivedLayerSources(dataset);
    const current = layersOf(id);
    const attached = new Set(current.flatMap(m => m?.bundle_paths ?? [m?.bundle_path]));
    for (const path of bundles) {
      if (attached.has(path)) continue;
      try {
        const res = await loadDerivedLayers(path, [id]);
        if (res.success) changed = true;
        else problems.push(`${dataset.label}'s layers from ${path} (${res.error ?? 'not attached'})`);
      } catch (e) {
        problems.push(`${dataset.label}'s layers from ${path} (${e instanceof Error ? e.message : String(e)})`);
      }
    }
    for (const job of consensusJobs) {
      if (current.some(m => m?.kind === 'consensus-workflow' && m.consensus_job_id === job)) continue;
      // A run is bound to the dataset ids it ran on: one that came back under
      // another id can't take it (rerun Find classes, or open a saved session file).
      if (id !== dataset.id) {
        problems.push(`the footprint classes of ${dataset.label} (its run was for the dataset as first opened: run Find classes again)`);
        continue;
      }
      jobs.set(job, [...(jobs.get(job) ?? []), dataset.label]);
    }
  }
  if (jobs.size > 0) {
    let available = new Set<string>();
    try {
      available = new Set((await getConsensusJobs()).jobs.filter(j => j.status === 'complete').map(j => j.job_id));
    } catch { /* an older server: reported below */ }
    for (const [job, labels] of jobs) {
      if (!available.has(job)) {
        problems.push(`the footprint classes of ${labels.join(', ')} (that run ended with the previous launch: run Find classes again, or save sessions to a file to keep their runs)`);
        continue;
      }
      try {
        await activateConsensus(job);
        changed = true;
      } catch (e) {
        problems.push(`the footprint classes of ${labels.join(', ')} (${e instanceof Error ? e.message : String(e)})`);
      }
    }
  }
  if (!changed) return;
  try {
    const response = await getDatasets();
    const state = store.getState();
    state.setDatasets(state.datasets.map(d => {
      const server = response.datasets.find((v: { id: string }) => v.id === d.id);
      return server ? { ...d, available_layers: server.available_layers, derived_layers: server.derived_layers } : d;
    }));
  } catch { /* the layer list catches up on the next dataset refresh */ }
}

/** Whether the reference a dataset has now is the one it was saved with. */
export function referenceMatchesSaved(info: PanelGenomeInfo | undefined, source: NonNullable<SerializedDataset['reference']>['source']): boolean {
  if (!info) return false;
  if (source.genome_id) return info.kind === 'registry' && (info.genome_id ?? info.key) === source.genome_id;
  if (source.fasta_path) {
    return info.kind === 'fasta' && !!info.fasta_path && normPath(info.fasta_path) === normPath(source.fasta_path)
      && (!source.gtf_path || (!!info.gtf_path && normPath(info.gtf_path) === normPath(source.gtf_path)));
  }
  if (source.contigs) return info.kind === 'contigs' || info.kind === 'header_fasta';
  return false;
}

/**
 * Attach again the reference each saved dataset had of its own (a registry
 * genome, a FASTA, its contigs), unless the server still has it on that
 * dataset. Returns old key -> new key for the panels that showed it.
 */
export async function restoreDatasetReferences(
  saved: SerializedDataset[],
  idMap: Record<string, string>,
  problems: string[] = [],
): Promise<Record<string, string>> {
  const withReference = saved.filter(d => d.reference && idMap[d.id]);
  if (withReference.length === 0) return {};
  let assigned: Record<string, string> = {};
  let genomes: PanelGenomeInfo[] = [];
  try {
    const current = await getPanelGenomes();
    assigned = current.datasets ?? {};
    genomes = current.genomes ?? [];
  } catch { /* an older server: try to attach */ }
  const keys: Record<string, string> = {};
  for (const dataset of withReference) {
    const reference = dataset.reference!;
    const id = idMap[dataset.id];
    // Kept only when it is the saved reference (the dataset may have been put
    // on another one since): otherwise its saved loci would be read on the wrong assembly.
    if (assigned[id] && referenceMatchesSaved(genomes.find(g => g.key === assigned[id]), reference.source)) {
      keys[reference.key] = assigned[id];
      continue;
    }
    try {
      const res = await attachPanelGenome({ dataset_ids: [id], ...reference.source });
      if (res.success && res.genome?.key) keys[reference.key] = res.genome.key;
      // Its reference is the main genome now: the dataset follows it (nothing to rename).
      else if (res.success && res.main) continue;
      else if (!res.success) {
        console.warn(`Restore: ${dataset.label}'s reference ${reference.key}: ${res.error ?? 'not loaded'}`);
        problems.push(`${dataset.label}'s reference ${reference.key} (${res.error ?? 'not loaded'})`);
      }
    } catch (e) {
      console.warn(`Restore: ${dataset.label}'s reference ${reference.key}`, e);
      problems.push(`${dataset.label}'s reference ${reference.key} (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return keys;
}

/**
 * References whose key changed on reattaching them: every `genome` field of the
 * snapshot (panels, saved peaks, …) follows the new key.
 */
export function renameGenomeKeys<T>(value: T, keys: Record<string, string>): T {
  if (!Object.keys(keys).some(k => keys[k] !== k)) return value;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== 'object') return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      out[k] = k === 'genome' && typeof x === 'string' && Object.prototype.hasOwnProperty.call(keys, x) ? keys[x] : walk(x);
    }
    return out;
  };
  return walk(value) as T;
}

/** Only offer to restore when there is analysis worth getting back. */
export function autoSaveHasWork(state: SerializedState): boolean {
  const nonEmpty = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === 'object') return Object.values(value as object).some(nonEmpty);
    return value != null && value !== false && value !== '';
  };
  const s = state as unknown as Record<string, unknown>;
  // Scanned peaks alone are not work (auto-scan fills them on every load);
  // a peak selection is.
  if (['clusterAssignments', 'selectedPeaks', 'footprintGroups', 'filteredReadIds', 'excludedReadIds', 'readSortOrder',
    'captureRegions', 'selectedGenes', 'catalog', 'savedTracks', 'primerSavedPrimers'].some(key => nonEmpty(s[key]))) return true;
  const composites = Array.isArray(s.compositeTracks) ? s.compositeTracks as Array<{ id?: string }> : [];
  return composites.some(track => track.id !== '__default_metaprofile__');
}

/** The longest the Welcome card waits for the launch offer to be decided (ms). */
const DECIDING_WELCOME_MS = 3_000;

export function CrashRecoveryBanner() {
  const [autoSave, setAutoSave] = useState<AutoSaveEntry | null>(null);
  const [offer, setOffer] = useState<LaunchOffer>(null);
  const [dismissed, setDismissed] = useState(false);
  const [restoring, setRestoring] = useState(false);
  // The offer stays until it's used or dismissed, or a new dataset is loaded
  // (then this is a different session). Datasets the server already had when
  // the page opened (CLI launches) don't count.
  const [startupDatasetIds, setStartupDatasetIds] = useState<Set<string> | null>(null);
  const datasetIds = useBrowserStore(s => s.datasets.map(d => d.id).join('\n'));
  // Datasets a restore opens are not a new session.
  const sessionStarted = !restoring && startupDatasetIds !== null
    && datasetIds.split('\n').some(id => id && !startupDatasetIds.has(id));
  // Once started, removing that dataset again doesn't bring the offer back.
  useEffect(() => {
    if (!sessionStarted) return;
    // Another session started instead of reopening the last one (Start fresh): it replaces the saved one. Crash
    // recovery keeps its save until there is work to replace it with.
    if (offer === 'reopen') supersedeLastSession();
    setDismissed(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionStarted]);

  /** The datasets open now count as this session's (a restore opened them). */
  const adoptOpenDatasets = () => setStartupDatasetIds(new Set(useBrowserStore.getState().datasets.map(d => d.id)));

  /**
   * Restore a saved session. The autosave holds the saved copy until the
   * restore is complete and saved again (a half-restored page never replaces
   * it); a failed restore keeps the offer to try again.
   */
  const runRestore = async (entry: AutoSaveEntry, kind: LaunchOffer): Promise<boolean> => {
    setRestoring(true);
    setLaunchUi({ restoring: true });
    setLaunchOfferPending(true);
    try {
      await restoreSnapshot(entry.state);
      // The reopened session is where Undo stops (M9).
      startHistoryAtRestoredState(kind === 'recover' ? 'Restored session' : 'Reopened last session');
      markRestoredWork();
    } catch (e) {
      console.error('Crash recovery failed:', e);
      adoptOpenDatasets();
      setRestoring(false);
      setLaunchUi({ restoring: false });
      setLaunchOfferPending(kind !== 'recover');
      const what = kind === 'recover' ? 'restore the session' : 'reopen your last session';
      useBrowserStore.getState().setError(`Could not ${what}: ${e instanceof Error ? e.message : String(e)}. Try ${kind === 'recover' ? 'Restore' : 'Reopen'} again.`);
      return false;
    }
    adoptOpenDatasets();
    setDismissed(true);
    setRestoring(false);
    setLaunchUi({ restoring: false });
    // Saved again as restored (under this run), then the autosave goes on.
    try {
      const { autoSaveNow } = await import('../../hooks/useAutoSave');
      await autoSaveNow();
    } catch { /* the next change saves it */ }
    setLaunchOfferPending(false);
    return true;
  };

  const handleRestore = async (entry = autoSave) => {
    if (!entry) return;
    await runRestore(entry, offer);
  };

  useEffect(() => {
    let cancelled = false;
    setLaunchUi({ deciding: true });
    // Storage that never answers (blocked IndexedDB) must not keep the Welcome card away for good.
    // (It also caps the wait for the datasets below.)
    const decidingTimer = window.setTimeout(() => setLaunchUi({ deciding: false }), DECIDING_WELCOME_MS);
    // The datasets the server already had (CLI launches). Nothing offered: the
    // Welcome card still waits until they are on the page (the page lists them
    // a moment after the decision; the card flashed over them).
    const startupIds = getDatasets()
      .then(res => (res.datasets ?? []).map((d: { id: string }) => d.id))
      .catch(() => [] as string[]);
    let unsubscribe = () => {};
    let stopWatching = () => {};
    const startupShown = startupIds.then(ids => new Promise<void>(resolve => {
      if (cancelled || ids.length === 0 || useBrowserStore.getState().datasets.length > 0) { resolve(); return; }
      unsubscribe = useBrowserStore.subscribe(s => {
        if (s.datasets.length > 0) { unsubscribe(); resolve(); }
      });
      // The cap: stop listening once the card is released anyway.
      window.setTimeout(() => { unsubscribe(); resolve(); }, DECIDING_WELCOME_MS);
    }));
    const decidedNoOffer = () => {
      void startupShown.then(() => {
        if (cancelled) return;
        window.clearTimeout(decidingTimer);
        setLaunchUi({ deciding: false });
      });
    };
    Promise.all([loadAutoSave(), getLaunchInfo(), startupIds]).then(([entry, launch, cliIds]) => {
      if (cancelled) return;
      const othersLive = launch ? otherTabLive(launch.boot_id) : false;
      const decide = (others: boolean) => decideLaunchOffer(entry, launch, {
        hasWork: autoSaveHasWork, preference: getLastSessionPreference(), otherTabLive: others,
      });
      const next = decide(othersLive);
      // Held back only because another page of this run looked live: if that page crashed (its beat expires
      // rather than closing), the recovery is offered then.
      if (!next && othersLive && launch && entry && decide(false) === 'recover') {
        stopWatching = watchOtherTabs(launch.boot_id, how => {
          if (cancelled || how !== 'crashed') return;
          // The other page kept saving until it crashed: offer its latest save, if it still qualifies and no
          // other page of this run is live now (and this page has not started a session of its own).
          void loadAutoSave().then(latest => {
            if (cancelled || !latest || otherTabLive(launch.boot_id)) return;
            const offer = decideLaunchOffer(latest, launch, {
              hasWork: autoSaveHasWork, preference: getLastSessionPreference(), otherTabLive: false,
            });
            if (offer !== 'recover') return;
            setAutoSave(latest);
            setOffer('recover');
            setLaunchOfferPending(false);
          }).catch(() => {});
        });
      }
      // Decided: from now on this page counts as open (after the check, so two tabs opened together after a
      // crash both offer the restore).
      if (launch) startTabHeartbeat(launch.boot_id);
      if (!entry || !next) {
        decidedNoOffer();
        setLaunchOfferPending(false);  // nothing offered: the autosave may go on
        return;
      }
      // A late decision (storage or the server slow to answer, past the Welcome card's wait): the user may have started
      // a session already (opened a dataset, done something). The last session is then declined, as when the
      // Welcome card's other choices are used; a crash's offer is still shown (its banner), never held invisibly.
      const now = useBrowserStore.getState();
      const startedAlready = now.datasets.some(d => !cliIds.includes(d.id))
        || (now._historyStack ?? []).some(snapshot => snapshot.kind !== 'navigation');
      if ((next === 'reopen' || next === 'auto-reopen') && startedAlready) {
        decidedNoOffer();
        supersedeLastSession();
        setLaunchOfferPending(false);
        return;
      }
      if (next === 'recover' && startedAlready) {
        // Not dismissed by the session started before anything was offered: the banner stays up until Restore /
        // Dismiss (or a dataset opened after it).
        adoptOpenDatasets();
        setDismissed(false);
      }
      if (next === 'reopen' && cliIds.length > 0) {
        // Data opened on the command line takes precedence: no Welcome card, so no "Reopen last session" either. The
        // offer is declined (Start fresh, not remembered): this session is saved from now on.
        decidedNoOffer();
        supersedeLastSession();
        setLaunchOfferPending(false);
        return;
      }
      if (next === 'discard') {
        // Remembered "Start fresh": the last session isn't offered or kept.
        decidedNoOffer();
        supersedeLastSession();
        void clearAutoSave();
        setLaunchOfferPending(false);
        return;
      }
      window.clearTimeout(decidingTimer);
      // Decided: the offer is up from now on (the last session on the Welcome card, a crash in the banner).
      setLaunchUi({ deciding: false });
      setAutoSave(entry);
      setOffer(next);
      // The offered session stays saved until the user decides (crash recovery
      // keeps the older rule: a save with work is not replaced by an idle page).
      setLaunchOfferPending(next !== 'recover');
      if (next === 'auto-reopen') void restoreAuto(entry);
    }).catch(() => {
      decidedNoOffer();
      void getLaunchInfo().then(launch => { if (launch && !cancelled) startTabHeartbeat(launch.boot_id); });
    });
    void startupIds.then(ids => { if (!cancelled) setStartupDatasetIds(new Set(ids)); });
    return () => {
      cancelled = true;
      unsubscribe();
      stopWatching();
      stopTabHeartbeat();
      window.clearTimeout(decidingTimer);
      setLaunchUi({ deciding: false, offerShown: false, restoring: false, lastSession: null });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reopen without asking (remembered): say so while it runs, then step aside;
  // if it fails, ask instead.
  const restoreAuto = async (entry: AutoSaveEntry) => {
    if (!(await runRestore(entry, 'auto-reopen'))) setOffer('reopen');
  };

  const visible = Boolean(autoSave && offer && !dismissed && !sessionStarted);
  // "Reopen last session" is a button of the Welcome card; the crash-recovery offer (and an automatic reopen's
  // note) is this banner.
  const onWelcome = visible && offer === 'reopen';
  // Gone (a new dataset loaded, dismissed): the autosave goes on.
  const wasVisible = useRef(false);
  useEffect(() => {
    if (wasVisible.current && !visible) setLaunchOfferPending(false);
    if (wasVisible.current || visible) setLaunchUi({ offerShown: visible && !onWelcome });
    wasVisible.current = visible;
  }, [visible, onWelcome]);
  // Latest restore for the Welcome card's button (it may render before this component re-renders).
  const restoreRef = useRef(handleRestore);
  restoreRef.current = handleRestore;
  const savedAt = autoSave?.timestamp ?? 0;
  const summary = autoSave ? describeSavedSession(autoSave.state) : '';
  useEffect(() => {
    setLaunchUi({ lastSession: onWelcome ? { summary, savedAt, reopen: () => void restoreRef.current() } : null });
  }, [onWelcome, summary, savedAt]);

  if (!visible || !autoSave || onWelcome) return null;

  const handleDismiss = () => {
    supersedeLastSession();
    setDismissed(true);
    setLaunchOfferPending(false);
    void clearAutoSave();
  };

  if (offer === 'auto-reopen') {
    // Reopened without asking (the remembered choice): a note while it runs.
    return (
      <div
        className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-brand-100 bg-brand-50 px-4 py-2 text-[12px] dark:border-brand-400/20 dark:bg-brand-400/10"
        role="region"
        aria-label="Reopening your last session"
        data-testid="reopen-last-session"
      >
        <RotateCcw size={14} aria-hidden="true" className="text-brand-700 dark:text-brand-300" />
        <span className="flex-1 text-gray-800 dark:text-gray-100">
          {restoring ? 'Reopening your last session' : 'Your last session'}
          {summary && <span className="text-gray-600 dark:text-gray-300"> ({summary})</span>}
          <span className="ml-1 text-gray-500 dark:text-gray-400">from {formatTimeAgo(autoSave.timestamp)}</span>
        </span>
      </div>
    );
  }

  const datasetCount = autoSave.state.datasets?.length ?? 0;

  return (
    <div className="bg-amber-50 dark:bg-amber-900/30 border-b border-amber-200 dark:border-amber-700 px-4 py-2 flex items-center gap-3 text-sm" data-testid="crash-recovery-banner">
      <span className="text-amber-700 dark:text-amber-300 flex-1">
        Unsaved session found from {formatTimeAgo(autoSave.timestamp)}
        {autoSave.state.chrom && (
          <span className="text-amber-500 dark:text-amber-400 ml-1">
            ({autoSave.state.chrom}:{autoSave.state.start?.toLocaleString()}-{autoSave.state.end?.toLocaleString()})
          </span>
        )}
        {datasetCount > 0 && (
          <span className="text-amber-500 dark:text-amber-400 ml-1">
            — {datasetCount} dataset{datasetCount !== 1 ? 's' : ''}
          </span>
        )}
      </span>
      <button
        onClick={() => void handleRestore()}
        disabled={restoring}
        className="px-3 py-1 rounded bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white text-xs font-medium"
      >
        {restoring ? 'Restoring...' : 'Restore'}
      </button>
      <button
        onClick={handleDismiss}
        disabled={restoring}
        className="px-3 py-1 rounded bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-600 dark:text-gray-300 text-xs font-medium"
      >
        Dismiss
      </button>
    </div>
  );
}
