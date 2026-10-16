import { keepSvSplitsInView } from './svSlice';
import { geneTss } from '../utils/coordinates';
import type { BrowserState } from './browserStore';
import type { Gene, FirePeak, ChromInfo, Bookmark, ViewportHistoryEntry, Interval, PanelConfig, FootprintGroup } from '../types';
import { keepMatched } from '../utils/matchedRegions';
import { DEBUG, LAST_GENOME_STORAGE_KEY, LAST_FASTA_PATH_STORAGE_KEY, loadBookmarksFromStorage, saveBookmarksToStorage, makeCleanTransientState, saveFootprintGroupsToStorage } from './utils';
import { useEphemeralStore } from './ephemeralStore';
import { computeRuleOffset } from './peakRuleSlice';
import { findChromInfo } from '../utils/chromAliases';
import { isPanOrZoom, moveLikewise, siteLockSuppressed } from './siteLock';
import { hasViewLinks, linkedPanelMoving, linkedPanelView } from '../utils/panelExtensions';
import { PER_PANEL_STATE_KEYS } from './panelSlice';

/**
 * setViewport moves the main view. Panels with their own view keep their
 * clusters and filters (the main view's reset of those maps skips their
 * keys), and locked ones pan/zoom along with it.
 */
function withSiteRules(state: BrowserState, chrom: string, start: number, end: number, result: Partial<BrowserState>): Partial<BrowserState> {
  // Panning and zooming keep the order of known reads, as independent panels do.
  // A jump to another locus drops it; newly encountered reads follow the ordered ones.
  if (isPanOrZoom(state, { chrom, start, end }) && 'readSortOrder' in result) {
    result = { ...result, readSortOrder: state.readSortOrder };
  }
  return withViewLinks(state, chrom, start, end, withLockedSites(state, chrom, start, end, result));
}

/**
 * Linked panels of plugin packs (utils/panelExtensions.ts view links) show the main view mapped through their link
 * (a contig of its own mapped onto the main genome). The panel whose move this is (linkedPanelMoving) keeps its own view.
 */
function withViewLinks(state: BrowserState, chrom: string, start: number, end: number, result: Partial<BrowserState>): Partial<BrowserState> {
  if (!hasViewLinks()) return result;
  const panels = (result.panels as PanelConfig[] | undefined) ?? state.panels;
  const moving = linkedPanelMoving();
  const next = { chrom: (result.chrom as string) ?? chrom, start: (result.start as number) ?? start, end: (result.end as number) ?? end };
  const views = new Map<string, ReturnType<typeof linkedPanelView>>();
  for (const p of panels) if (p.viewportOverride && p.id !== moving) views.set(p.id, linkedPanelView(p, next));
  if (![...views.values()].some(v => v !== undefined)) return result;
  let changed = false;
  const out = panels.map(p => {
    const mapped = views.get(p.id);
    if (mapped === undefined || !p.viewportOverride) return p;
    const v = p.viewportOverride;
    if (!mapped || (mapped.chrom === v.chrom && mapped.start === v.start && mapped.end === v.end)) return p;
    changed = true;
    return { ...p, viewportOverride: mapped };
  });
  return changed ? { ...result, panels: out } : result;
}

function withLockedSites(state: BrowserState, chrom: string, start: number, end: number, result: Partial<BrowserState>): Partial<BrowserState> {
  const own = state.panels.filter(p => p.viewportOverride);
  if (own.length === 0) return result;
  const out: Record<string, unknown> = { ...result };
  const prev = { chrom: state.chrom, start: state.start, end: state.end };
  const next = { chrom: (out.chrom as string) ?? chrom, start: (out.start as number) ?? start, end: (out.end as number) ?? end };
  const locking = !siteLockSuppressed() && own.some(p => p.siteLocked);
  const pan = isPanOrZoom(prev, next);
  // A linked panel moves with a pan or zoom; one showing exactly the main
  // view (a plain linked copy) also follows a jump elsewhere, and like the
  // main view leaves its filters and clusters behind.
  const followsJump = (p: PanelConfig) => locking && !pan && p.siteLocked && !!p.viewportOverride
    && p.viewportOverride.chrom === prev.chrom && p.viewportOverride.start === prev.start && p.viewportOverride.end === prev.end;
  const keys = own.filter(p => !followsJump(p)).map(p => p.stateKey ?? p.datasetId ?? p.id);
  for (const name of PER_PANEL_STATE_KEYS) {
    if (!(name in out)) continue;
    const before = (state as unknown as Record<string, Record<string, unknown>>)[name] ?? {};
    const kept = Object.fromEntries(keys.filter(k => k in before).map(k => [k, before[k]]));
    if (Object.keys(kept).length > 0) out[name] = { ...(out[name] as Record<string, unknown>), ...kept };
  }
  if (locking) {
    out.panels = state.panels.map(p => (p.siteLocked && p.viewportOverride
      ? (pan ? { ...p, viewportOverride: moveLikewise(p.viewportOverride, prev, next) }
        : followsJump(p) ? { ...p, viewportOverride: { ...next } } : p)
      : p));
  }
  return out as Partial<BrowserState>;
}

/**
 * Leaving a chromosome: the saved footprint definitions stay, and one pinned
 * to a position without a chromosome is pinned to the one it was made on (so
 * it doesn't match the same coordinates elsewhere). Definitions generated from
 * this view (auto families) go with it.
 */
function groupsLeavingChrom(groups: FootprintGroup[], fromChrom: string): FootprintGroup[] {
  const kept = groups
    .filter(g => !g.autoGeneratedFamily)
    .map(g => (!g.referenceChrom && g.referenceAbsStart != null && fromChrom ? { ...g, referenceChrom: fromChrom } : g));
  if (kept.length === groups.length && kept.every((g, i) => g === groups[i])) return groups;
  saveFootprintGroupsToStorage(kept);
  return kept;
}

/**
 * A bookmark / Back / Forward jump: the main view's transient state is reset,
 * as the same jump through setViewport would, and the same panel rules apply
 * (a panel at its own locus keeps its clusters and filters; a linked copy
 * follows). Saved footprint definitions survive.
 */
function jumpState(state: BrowserState, chrom: string, start: number, end: number, extra: Partial<BrowserState>): Partial<BrowserState> {
  const { footprintGroups: _dropped, ...clean } = makeCleanTransientState();
  void _dropped;
  return withSiteRules(state, chrom, start, end, {
    chrom, start, end,
    ...clean,
    ...(chrom !== state.chrom ? { footprintGroups: groupsLeavingChrom(state.footprintGroups, state.chrom) } : {}),
    ...extra,
  } as Partial<BrowserState>);
}

// ============================================================
// VIEWPORT SLICE — Interface
// ============================================================

export interface ViewportSlice {
  chrom: string;
  start: number;
  end: number;
  
  // Data
  chroms: ChromInfo[];
  loading: boolean;
  error: string | null;
  
  // Server config (set from /api/status)
  prefetchMultiplier: number;  // How much to prefetch (e.g., 10 = 10x viewport)
  
  // Vertical zoom state for read tracks
  bookmarks: Bookmark[];

  // Navigation history
  viewportHistory: ViewportHistoryEntry[];
  historyIndex: number;  // Current position in history (-1 = at head, no forward)

  // Reverse view & relative coordinates
  isReversed: boolean;
  showRelativeCoords: boolean;
  relativeTSS: number | null;
  relativeGene: Gene | null;
  // CIGAR display settings (for BAM datasets)
  hasFasta: boolean;
  fastaPath: string | null;
  currentGenome: string | null;
  setHasFasta: (v: boolean) => void;
  setFastaPath: (p: string | null) => void;
  setCurrentGenome: (id: string | null) => void;
  /** Bumped when a genome is declared for a FASTA (api/reference.declareGenome): every genome-keyed view
   *  (class-card motifs, NFR motifs, the TE library) fetches again. */
  referenceRevision: number;
  bumpReferenceRevision: () => void;

  // Dark mode
  setViewport: (chrom: string, start: number, end: number) => void;
  setChroms: (chroms: ChromInfo[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setPrefetchMultiplier: (multiplier: number) => void;

  // Vertical zoom actions
  zoomIn: () => void;
  zoomOut: () => void;
  panLeft: () => void;
  panRight: () => void;
  
  // Reset action - clears clustering, filters, selections, etc.
  resetView: () => void;

  // Peak sync for Jupyter API
  addBookmark: (name: string) => void;
  removeBookmark: (id: string) => void;
  navigateToBookmark: (id: string) => void;
  updateBookmark: (id: string, updates: Partial<Pick<Bookmark, 'name'>>) => void;

  // Navigation history actions
  goBack: () => void;
  goForward: () => void;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  pushViewportHistory: (entry: ViewportHistoryEntry) => void;

  // CIGAR display actions
  toggleReversed: () => void;
  toggleRelativeCoords: () => void;

  // Sidebar state
}

// ============================================================
// VIEWPORT SLICE — Implementation
// ============================================================

// Stable empty references — avoids creating new objects on every setViewport call,
// which would defeat useShallow equality checks and cause unnecessary re-renders.
const EMPTY_OBJ: Record<string, never> = {};
const EMPTY_ARR: never[] = [];
const EMPTY_TRANSCRIPTION_FILTERS = {
  pause: false, pic: false, elongating: null as number | null,
  elongating_max: null as number | null,
} as const;
const DEBUG_VIEWPORT = DEBUG && (
  import.meta.env.VITE_DEBUG_VIEWPORT === '1' ||
  import.meta.env.VITE_DEBUG_VIEWPORT === 'true'
);

function isCircularChrom(chroms: ChromInfo[], chrom: string): boolean {
  return Boolean(findChromInfo(chroms, chrom)?.circular);
}

export function createViewportSlice(rawSet: (partial: Partial<BrowserState> | ((state: BrowserState) => Partial<BrowserState>)) => void, get: () => BrowserState): ViewportSlice {
  const set: typeof rawSet = partial => rawSet(state => keepMatched(state, typeof partial === 'function' ? partial(state) : partial));
  return {
  chrom: 'chr2L',
  start: 1000000,
  end: 1020000,
  
  chroms: [],
  loading: false,
  error: null,
  
  prefetchMultiplier: 10,  // Default, updated from server

  // Vertical zoom state
  bookmarks: loadBookmarksFromStorage(),

  // Navigation history - start empty
  viewportHistory: [],
  historyIndex: -1,  // -1 means at the head (most recent)

  // Reverse view & relative coordinates
  isReversed: false,
  showRelativeCoords: false,
  relativeTSS: null,
  relativeGene: null,
  // Sidebar state
  hasFasta: false,
  fastaPath: null,
  currentGenome: null,
  referenceRevision: 0,
  bumpReferenceRevision: () => set(state => ({ referenceRevision: state.referenceRevision + 1 })),
  setHasFasta: (v: boolean) => set({ hasFasta: v }),
  setFastaPath: (p: string | null) => {
    // Persist the path so the App can re-load this FASTA on next page load
    // instead of falling back to the hg38 default. Cleared when p is null.
    try {
      if (p) localStorage.setItem(LAST_FASTA_PATH_STORAGE_KEY, p);
      else localStorage.removeItem(LAST_FASTA_PATH_STORAGE_KEY);
    } catch {}
    set({ fastaPath: p });
  },
  setCurrentGenome: (id: string | null) => {
    if (id) {
      try { localStorage.setItem(LAST_GENOME_STORAGE_KEY, id); } catch {}
    } else {
      // User explicitly cleared the registry-genome (e.g. after loading a
      // local FASTA). Clear the stored last_genome so the App's auto-load
      // fallback doesn't re-pick the previous registry genome on reload.
      try { localStorage.removeItem(LAST_GENOME_STORAGE_KEY); } catch {}
    }
    set({ currentGenome: id });
  },

  // Track name filters
  setViewport: (chrom, start, end) => {
    // Whole bases (every read/sequence request takes integers): a span with
    // fractional edges (a footprint class's median edges) is widened to cover it.
    if (!Number.isInteger(start)) start = Math.floor(start);
    if (!Number.isInteger(end)) end = Math.ceil(end);
    // An SV allele split whose locus stays in view keeps its groups (svSlice.ts).
    set(state => withSiteRules(state, chrom, start, end, keepSvSplitsInView(state, ((): Partial<BrowserState> => {
    // Enforce minimum viewport width of 3bp to prevent division-by-zero
    // in coordinate transforms, canvas scaling, metaprofile binning, etc.
    if (end - start < 3) {
      const center = Math.round((start + end) / 2);
      start = center - 1;
      end = center + 2;
    }

    // Verbose path tracing is opt-in because navigation happens on every pan/zoom.
    if (DEBUG_VIEWPORT) {
      console.log(`[setViewport] New: ${chrom}:${start}-${end}, Old: ${state.chrom}:${state.start}-${state.end}`);
      console.log(`[setViewport] State: dynamicClustering=${state.dynamicClustering}, patterns=${Object.keys(state.clusterPatterns).length}, peakRegions=${state.clusterPeakRegions.length}, selectedPeaks=${state.selectedPeaks.size}`);
    }
    if (DEBUG_VIEWPORT && state.clusterPeakRegions.length > 0) {
      console.log(`[setViewport] Peak regions (absolute): ${state.clusterPeakRegions.map(p => `${p.start}-${p.end}`).join(', ')}`);
    }

    // If changing chromosomes, clear most state but preserve cross-chrom peaks
    const chromChanged = chrom !== state.chrom;
    if (chromChanged) {
      if (DEBUG_VIEWPORT) console.log(`[setViewport] PATH: chromChanged -> clearing all (preserving cross-chrom peaks)`);
      // Preserve custom peaks that have an explicit chrom field different from the old global chrom
      const customRuleId = state.getCustomRuleId();
      const customPeaks = state.peaksByRule[customRuleId] || [];
      const crossChromPeaks = customPeaks.filter(p => p.chrom && p.chrom !== state.chrom);
      const crossChromIndices = new Set(crossChromPeaks.map(p => p.index));
      const preservedSelection = new Set([...state.selectedPeaks].filter(i => crossChromIndices.has(i)));
      const preservedModes: Record<number, any> = {};
      for (const idx of preservedSelection) {
        if (state.peakModes[idx]) preservedModes[idx] = state.peakModes[idx];
      }
      // Keep only cross-chrom custom peaks; clear all other rules
      const newPeaksByRule: Record<string, FirePeak[]> = {};
      if (crossChromPeaks.length > 0) {
        newPeaksByRule[customRuleId] = crossChromPeaks;
      }
      return {
        chrom, start, end,
        peaksByRule: newPeaksByRule,
        peakSignalCache: EMPTY_OBJ,
        correspondenceScans: EMPTY_OBJ,
        peaksLocked: false,
        selectedPeaks: preservedSelection.size > 0 ? preservedSelection : new Set(),
        peakModes: Object.keys(preservedModes).length > 0 ? preservedModes : EMPTY_OBJ,
        peakDrawMode: false,
        peakDrawStart: null,
        clusterAssignments: EMPTY_OBJ,
        clusterOrder: EMPTY_OBJ,
        selectedClusters: EMPTY_OBJ,
        clusterPatterns: EMPTY_OBJ,
        clusterCentroids: EMPTY_OBJ,
        clusterPeakWidths: EMPTY_ARR,
        clusterPeakRegions: EMPTY_ARR,
        dynamicClustering: false,
        // Keep the cluster tree in sync with the (now-cleared) live assignments
        // so navigation never leaves an orphaned tree the renderer can't show.
        clusterTreeNodes: EMPTY_OBJ,
        clusterTreeRootIds: EMPTY_ARR,
        activeClusterTreeNodeId: null,
        readSortOrder: EMPTY_OBJ,
        clusterProfiles: EMPTY_OBJ,
        filteredReadIds: EMPTY_OBJ,
        readFilterSources: EMPTY_OBJ,
        clusterFocus: EMPTY_OBJ,
        selectedGenes: EMPTY_ARR,
        readStateDetails: EMPTY_OBJ,
        selectedFootprints: EMPTY_ARR,
        // Saved footprint definitions persist (they're the cart, saved to
        // storage); only the ones derived from this view go.
        footprintGroups: groupsLeavingChrom(state.footprintGroups, state.chrom),
        footprintFilterKey: null,
        selectedReadIds: EMPTY_OBJ,
        dismissedPanelTypes: new Set<string>(),
        transcriptionStateFilters: EMPTY_TRANSCRIPTION_FILTERS,
        showRelativeCoords: false,
        relativeTSS: null,
        relativeGene: null,
      };
    }

    // Check if dynamic clustering should be preserved
    // Peaks need to be at least partially visible (overlap with viewport)
    const hasDynamic = state.dynamicClustering;
    const hasPatterns = Object.keys(state.clusterPatterns).length > 0;
    const hasPeakRegions = state.clusterPeakRegions.length > 0;
    const peaksVisible = state.clusterPeakRegions.some(p => p.start < end && p.end > start);

    if (DEBUG_VIEWPORT) {
      console.log(`[setViewport] Dynamic check: hasDynamic=${hasDynamic}, hasPatterns=${hasPatterns}, hasPeakRegions=${hasPeakRegions}, peaksVisible=${peaksVisible}`);
      if (hasPeakRegions) {
        state.clusterPeakRegions.forEach((p, i) => {
          const visible = p.start < end && p.end > start;
          console.log(`[setViewport]   Peak ${i}: ${p.start}-${p.end}, visible=${visible} (${p.start} < ${end} && ${p.end} > ${start})`);
        });
      }
    }

    const preserveDynamic = hasDynamic && hasPatterns && hasPeakRegions && peaksVisible;

    if (preserveDynamic) {
      if (DEBUG_VIEWPORT) console.log(`[setViewport] PATH: preserveDynamic -> keeping clustering state`);
      // Preserve dynamic clustering state - only update viewport coordinates
      return {
        chrom, start, end,
        peakDrawMode: false,
        peakDrawStart: null,
        readSortOrder: EMPTY_OBJ,
        clusterProfiles: EMPTY_OBJ,
        filteredReadIds: EMPTY_OBJ,
        readFilterSources: EMPTY_OBJ,
        clusterFocus: EMPTY_OBJ,
        selectedClusters: EMPTY_OBJ,
        selectedGenes: EMPTY_ARR,
        readStateDetails: EMPTY_OBJ,
        selectedReadIds: EMPTY_OBJ,
        transcriptionStateFilters: EMPTY_TRANSCRIPTION_FILTERS,
        showRelativeCoords: false,
        relativeTSS: null,
        relativeGene: null,
        // Keep: clusterAssignments, clusterOrder, clusterPatterns, clusterPeakRegions,
        //       dynamicClustering, selectedPeaks, customPeaks, firePeaks, peakModes,
        //       selectedFootprints, footprintGroups (absolute coords, persist across zoom)
      };
    }

    if (state.peaksLocked) {
      if (DEBUG_VIEWPORT) console.log(`[setViewport] PATH: peaksLocked -> preserving current peak set, clearing stale analysis state`);
      return {
        chrom, start, end,
        peakSignalCache: EMPTY_OBJ,
        correspondenceScans: EMPTY_OBJ,
        peakDrawMode: false,
        peakDrawStart: null,
        clusterAssignments: EMPTY_OBJ,
        clusterOrder: EMPTY_OBJ,
        selectedClusters: EMPTY_OBJ,
        clusterPatterns: EMPTY_OBJ,
        clusterCentroids: EMPTY_OBJ,
        clusterPeakWidths: EMPTY_ARR,
        clusterPeakRegions: EMPTY_ARR,
        dynamicClustering: false,
        // Keep the cluster tree in sync with the (now-cleared) live assignments
        // so navigation never leaves an orphaned tree the renderer can't show.
        clusterTreeNodes: EMPTY_OBJ,
        clusterTreeRootIds: EMPTY_ARR,
        activeClusterTreeNodeId: null,
        readSortOrder: EMPTY_OBJ,
        clusterProfiles: EMPTY_OBJ,
        filteredReadIds: EMPTY_OBJ,
        readFilterSources: EMPTY_OBJ,
        clusterFocus: EMPTY_OBJ,
        selectedGenes: EMPTY_ARR,
        readStateDetails: EMPTY_OBJ,
        selectedReadIds: EMPTY_OBJ,
        transcriptionStateFilters: EMPTY_TRANSCRIPTION_FILTERS,
        showRelativeCoords: false,
        relativeTSS: null,
        relativeGene: null,
        // Keep: peaksByRule, selectedPeaks, peakModes, peaksLocked,
        //       selectedFootprints, footprintGroups (absolute coords).
      };
    }

    // Check if we should preserve peak selection (even without clustering)
    // Peaks have absolute genomic coordinates - check if any selected peaks are visible
    const allPeaks = state.getAllPeaks();
    const customPeaks = state.peaksByRule[state.getCustomRuleId()] || [];
    const selectedPeakCoords = Array.from(state.selectedPeaks)
      .map(idx => allPeaks.find(p => p.index === idx))
      .filter((p): p is typeof allPeaks[number] => p !== undefined);

    if (DEBUG_VIEWPORT) {
      console.log(`[setViewport] Peak check: allPeaks=${allPeaks.length}, customPeaks=${customPeaks.length}, selectedPeaks=${state.selectedPeaks.size}, selectedPeakCoords=${selectedPeakCoords.length}`);
      if (selectedPeakCoords.length > 0) {
        selectedPeakCoords.forEach((p, i) => {
          const visible = p.start < end && p.end > start;
          console.log(`[setViewport]   Selected peak ${i} (idx=${p.index}): ${p.start}-${p.end}, visible=${visible}`);
        });
      }
    }

    // A peak is visible if it overlaps with the new viewport
    const anySelectedPeakVisible = selectedPeakCoords.some(
      p => p.start < end && p.end > start
    );

    // Also check if any custom peaks are visible (even if not selected)
    const anyCustomPeakVisible = customPeaks.some(
      p => p.start < end && p.end > start
    );

    if (DEBUG_VIEWPORT) console.log(`[setViewport] Visibility: anySelectedPeakVisible=${anySelectedPeakVisible}, anyCustomPeakVisible=${anyCustomPeakVisible}`);

    // Check if we have existing cluster assignments (for non-dynamic methods like kmeans)
    const hasClusterAssignments = Object.values(state.clusterAssignments).some(
      assignments => Object.keys(assignments).length > 0
    );
    if (DEBUG_VIEWPORT) console.log(`[setViewport] hasClusterAssignments=${hasClusterAssignments}`);

    // Preserve peak state if any selected peaks or custom peaks are still visible
    const preservePeaks = (state.selectedPeaks.size > 0 && anySelectedPeakVisible) ||
                          (customPeaks.length > 0 && anyCustomPeakVisible);

    if (preservePeaks) {
      // If we have cluster assignments AND peaks are visible, keep clusters too
      // This handles non-dynamic methods (kmeans, hdbscan, etc.)
      if (hasClusterAssignments && anySelectedPeakVisible) {
        if (DEBUG_VIEWPORT) console.log(`[setViewport] PATH: preservePeaksWithClusters -> keeping peak selection AND clustering`);
        return {
          chrom, start, end,
          peakDrawMode: false,
          peakDrawStart: null,
          readSortOrder: EMPTY_OBJ,
          clusterProfiles: EMPTY_OBJ,
          filteredReadIds: EMPTY_OBJ,
          readFilterSources: EMPTY_OBJ,
          clusterFocus: EMPTY_OBJ,
          selectedClusters: EMPTY_OBJ,
          selectedGenes: EMPTY_ARR,
          readStateDetails: EMPTY_OBJ,
          selectedReadIds: EMPTY_OBJ,
          transcriptionStateFilters: EMPTY_TRANSCRIPTION_FILTERS,
          showRelativeCoords: false,
          relativeTSS: null,
          relativeGene: null,
          // Keep: selectedPeaks, customPeaks, firePeaks, peakModes,
          //       clusterAssignments, clusterOrder, clusterPatterns, clusterPeakRegions, dynamicClustering,
          //       selectedFootprints, footprintGroups (absolute coords, persist across zoom)
        };
      }

      if (DEBUG_VIEWPORT) console.log(`[setViewport] PATH: preservePeaks -> keeping peak selection, clearing clustering`);
      // Preserve peak selection and custom peaks, but clear clustering state
      return {
        chrom, start, end,
        peakDrawMode: false,
        peakDrawStart: null,
        clusterAssignments: EMPTY_OBJ,
        clusterOrder: EMPTY_OBJ,
        selectedClusters: EMPTY_OBJ,
        clusterPatterns: EMPTY_OBJ,
        clusterCentroids: EMPTY_OBJ,
        clusterPeakWidths: EMPTY_ARR,
        clusterPeakRegions: EMPTY_ARR,
        dynamicClustering: false,
        // Keep the cluster tree in sync with the (now-cleared) live assignments
        // so navigation never leaves an orphaned tree the renderer can't show.
        clusterTreeNodes: EMPTY_OBJ,
        clusterTreeRootIds: EMPTY_ARR,
        activeClusterTreeNodeId: null,
        readSortOrder: EMPTY_OBJ,
        clusterProfiles: EMPTY_OBJ,
        filteredReadIds: EMPTY_OBJ,
        readFilterSources: EMPTY_OBJ,
        clusterFocus: EMPTY_OBJ,
        selectedGenes: EMPTY_ARR,
        readStateDetails: EMPTY_OBJ,
        selectedReadIds: EMPTY_OBJ,
        transcriptionStateFilters: EMPTY_TRANSCRIPTION_FILTERS,
        showRelativeCoords: false,
        relativeTSS: null,
        relativeGene: null,
        // Keep: selectedPeaks, customPeaks, firePeaks, peakModes,
        //       selectedFootprints, footprintGroups (absolute coords, persist across zoom)
      };
    }

    // Normal viewport change - clear everything except footprint selection
    if (DEBUG_VIEWPORT) console.log(`[setViewport] PATH: normal -> clearing everything (keeping footprints)`);
    return {
      chrom, start, end,
      peaksByRule: EMPTY_OBJ,
      peakSignalCache: EMPTY_OBJ,
      correspondenceScans: EMPTY_OBJ,
      selectedPeaks: new Set(),
      peakModes: EMPTY_OBJ,
      peakDrawMode: false,
      peakDrawStart: null,
      clusterAssignments: EMPTY_OBJ,
      clusterOrder: EMPTY_OBJ,
      selectedClusters: EMPTY_OBJ,
      clusterPatterns: EMPTY_OBJ,
      clusterPeakRegions: EMPTY_ARR,
      dynamicClustering: false,
      // The clustering is gone: so is its tree (an active child branch would
      // otherwise filter the reads to an empty cohort).
      clusterTreeNodes: EMPTY_OBJ,
      clusterTreeRootIds: EMPTY_ARR,
      activeClusterTreeNodeId: null,
      readSortOrder: EMPTY_OBJ,
      clusterProfiles: EMPTY_OBJ,
      filteredReadIds: EMPTY_OBJ,
      readFilterSources: EMPTY_OBJ,
      clusterFocus: EMPTY_OBJ,
      selectedGenes: EMPTY_ARR,
      readStateDetails: EMPTY_OBJ,
      selectedReadIds: EMPTY_OBJ,
      transcriptionStateFilters: EMPTY_TRANSCRIPTION_FILTERS,
      showRelativeCoords: false,
      relativeTSS: null,
      relativeGene: null,
      // Keep: selectedFootprints, footprintGroups (absolute coords, persist across zoom), peakRules (config)
    };
  })(), chrom, start, end)));
  },

  setChroms: (chroms) => set({ chroms }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  setPrefetchMultiplier: (multiplier) => set({ prefetchMultiplier: multiplier }),

  // Vertical zoom actions
  zoomIn: () => {
    const state = get();
    const { chrom, start, end } = state;
    const center = (start + end) / 2;
    const newSize = Math.max(100, (end - start) / 1.5);
    const newStart = Math.round(center - newSize / 2);
    const newEnd = Math.round(center + newSize / 2);
    // Use setViewport to properly handle state preservation
    state.setViewport(chrom, newStart, newEnd);
  },

  zoomOut: () => {
    const state = get();
    const { chrom, start, end } = state;
    const center = (start + end) / 2;
    const chromInfo = findChromInfo(state.chroms, chrom);
    const isCircular = Boolean(chromInfo?.circular);
    const maxSize = chromInfo ? chromInfo.size : 10_000_000;
    const newSize = Math.min(maxSize, (end - start) * 1.5);
    const newStart = isCircular
      ? Math.round(center - newSize / 2)
      : Math.max(0, Math.round(center - newSize / 2));
    const newEnd = Math.round(center + newSize / 2);
    // Use setViewport to properly handle state preservation
    state.setViewport(chrom, newStart, newEnd);
  },

  panLeft: () => {
    const state = get();
    const { chrom, start, end } = state;
    const shift = Math.round((end - start) * 0.25);
    const newStart = isCircularChrom(state.chroms, chrom)
      ? start - shift
      : Math.max(0, start - shift);
    const newEnd = end - shift;
    // Use setViewport to properly handle state preservation
    state.setViewport(chrom, newStart, newEnd);
  },

  panRight: () => {
    const state = get();
    const { chrom, start, end } = state;
    const shift = Math.round((end - start) * 0.25);
    const newStart = start + shift;
    const newEnd = end + shift;
    // Use setViewport to properly handle state preservation
    state.setViewport(chrom, newStart, newEnd);
  },
  
  resetView: () => {
    // Clear all transient state - clustering, filters, selections, etc.
    // Does NOT clear datasets or viewport position
    set({
      // Clear clustering
      clusterAssignments: {},
      clusterOrder: {},
      selectedClusters: {},
      readSortOrder: {},
      clusterPatterns: {},
      clusterCentroids: {},
      clusterPeakWidths: [],
      clusterPeakRegions: [],
      dynamicClustering: false,
      clusterProfiles: {},
      clusterFocus: {},
      activeReadIds: {},
      clusterTreeNodes: {},
      clusterTreeRootIds: [],
      activeClusterTreeNodeId: null,
      clusterK: 3,
      clusterMethod: 'kmeans',
      clusterResolution: 1,

      // Clear filters
      filteredReadIds: {},
      readFilterSources: {},
      filterMode: 'either',

      // Clear selections
      selectedPeaks: new Set(),
      selectedDatasets: new Set(),
      peakModes: {},
      peaksByRule: {},
      peakSignalCache: {},
      correspondenceScans: {},
      peaksLocked: false,

      // Clear peak drawing, and the Highlight group's ruler drawing (a plain drag zooms again).
      // The highlights themselves stay: they are named annotations (Clear all in the Highlight list removes them).
      peakDrawMode: false,
      peakDrawStart: null,
      highlightDrawMode: false,

      // Clear Jupyter state
      jupyterHighlights: [],
      jupyterMarkers: [],
      jupyterFootprintColors: [],
      jupyterReadOrder: {},
      jupyterReadFilter: {},
      jupyterPushedReads: null,

      // Clear ephemeral footprint selection — but keep footprintGroups,
      // they're a persistent "cart" of footprint definitions that survive
      // navigation and load/save with the session.
      selectedFootprints: [],
      footprintFilterKey: null,
      selectedReadIds: {},

      // Clear gene selection and transcription state filters
      selectedGenes: [],
      readStateDetails: {},
      transcriptionStateFilters: {
        pause: false,
        pic: false,
        elongating: null,
        elongating_max: null,
      },

      // Clear primer state (keep config + saved primers + mode)
      primer: {
        targetStart: null,
        targetEnd: null,
        pair: null,
        configFasta: get().primer.configFasta,
        configBlastDb: get().primer.configBlastDb,
        designing: false,
        error: null,
        designResults: [],
        savedPrimers: get().primer.savedPrimers,
        mode: get().primer.mode,
        dafcQuads: [],
        cartTrackDisplay: get().primer.cartTrackDisplay,
      },

      // Reset sort mode
      sortMode: 'position',

      // Clear loading/error
      loading: false,
      error: null,

    });
    // Reset pan state in ephemeral store
    useEphemeralStore.getState().resetPanState();
  },

  addBookmark: (name: string) => {
    const state = get();
    const newBookmark: Bookmark = {
      id: `bookmark_${Date.now()}`,
      name,
      chrom: state.chrom,
      start: state.start,
      end: state.end,
      created: new Date().toISOString(),
    };
    const newBookmarks = [...state.bookmarks, newBookmark];
    saveBookmarksToStorage(newBookmarks);
    set({ bookmarks: newBookmarks });
  },

  removeBookmark: (id: string) => {
    const state = get();
    const newBookmarks = state.bookmarks.filter(b => b.id !== id);
    saveBookmarksToStorage(newBookmarks);
    set({ bookmarks: newBookmarks });
  },

  navigateToBookmark: (id: string) => {
    const state = get();
    const bookmark = state.bookmarks.find(b => b.id === id);
    if (bookmark) {
      // Push current viewport to history before navigating
      get().pushViewportHistory({ chrom: state.chrom, start: state.start, end: state.end });
      // Navigate to bookmark
      set(s => jumpState(s, bookmark.chrom, bookmark.start, bookmark.end, {}));
    }
  },

  updateBookmark: (id: string, updates: Partial<Pick<Bookmark, 'name'>>) => {
    const state = get();
    const newBookmarks = state.bookmarks.map(b =>
      b.id === id ? { ...b, ...updates } : b
    );
    saveBookmarksToStorage(newBookmarks);
    set({ bookmarks: newBookmarks });
  },

  // Navigation history actions
  pushViewportHistory: (entry: ViewportHistoryEntry) => {
    const state = get();
    // Don't push if it's the same as current location
    const lastEntry = state.viewportHistory[state.viewportHistory.length - 1];
    if (lastEntry &&
        lastEntry.chrom === entry.chrom &&
        lastEntry.start === entry.start &&
        lastEntry.end === entry.end) {
      // Already recorded (e.g. Forward reached it): moving on from it puts us back at the head.
      if (state.historyIndex !== -1) set({ historyIndex: -1 });
      return;
    }

    // If we're in the middle of history (went back), truncate forward history
    let history = state.viewportHistory;
    if (state.historyIndex >= 0 && state.historyIndex < history.length - 1) {
      history = history.slice(0, state.historyIndex + 1);
    }

    // Add new entry and limit to 50 entries
    const newHistory = [...history, entry].slice(-50);
    set({
      viewportHistory: newHistory,
      historyIndex: -1,  // Reset to head
    });
  },

  goBack: () => {
    const state = get();
    const { viewportHistory, historyIndex, chrom, start, end } = state;

    // Calculate actual index (historyIndex -1 means we're at the head, looking at current view)
    const currentIdx = historyIndex === -1 ? viewportHistory.length : historyIndex;

    if (currentIdx <= 0) return;  // Can't go back further

    // If at head, first push current location so we can go forward to it
    if (historyIndex === -1 && viewportHistory.length > 0) {
      // Check if current position is different from last in history
      const lastEntry = viewportHistory[viewportHistory.length - 1];
      if (lastEntry.chrom !== chrom || lastEntry.start !== start || lastEntry.end !== end) {
        // Push current to history and navigate — single atomic set()
        const newHistory = [...viewportHistory, { chrom, start, end }].slice(-50);
        const targetIdx = newHistory.length - 2;
        const target = newHistory[targetIdx];
        set(s => jumpState(s, target.chrom, target.start, target.end, {
          viewportHistory: newHistory,
          historyIndex: targetIdx,
        }));
        return;
      }
    }

    // Navigate to previous entry
    const targetIdx = currentIdx - 1;
    const target = viewportHistory[targetIdx];
    if (target) {
      set(s => jumpState(s, target.chrom, target.start, target.end, { historyIndex: targetIdx }));
    }
  },

  goForward: () => {
    const state = get();
    const { viewportHistory, historyIndex } = state;

    if (historyIndex === -1 || historyIndex >= viewportHistory.length - 1) {
      return;  // Already at head
    }

    const targetIdx = historyIndex + 1;
    const target = viewportHistory[targetIdx];
    if (target) {
      // Stay on the entry (even the last one): the view now is that entry, so
      // the next Back goes to the one before it. Resetting to the head (-1)
      // made Back 'go' to the last entry, the view itself.
      set(s => jumpState(s, target.chrom, target.start, target.end, { historyIndex: targetIdx }));
    }
  },

  canGoBack: () => {
    const state = get();
    const { viewportHistory, historyIndex } = state;
    const currentIdx = historyIndex === -1 ? viewportHistory.length : historyIndex;
    return currentIdx > 0;
  },

  canGoForward: () => {
    const state = get();
    const { viewportHistory, historyIndex } = state;
    return historyIndex !== -1 && historyIndex < viewportHistory.length - 1;
  },

  // CIGAR display actions
  toggleReversed: () => set(state => ({ isReversed: !state.isReversed })),
  toggleRelativeCoords: () => set(state => {
    if (!state.showRelativeCoords && state.selectedGenes.length > 0) {
      const gene = state.selectedGenes[0];
      const tss = geneTss(gene);
      return { showRelativeCoords: true, relativeTSS: tss, relativeGene: gene };
    }
    return { showRelativeCoords: false, relativeTSS: null, relativeGene: null };
  }),
  };
}
