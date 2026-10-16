// ============================================================================
// DAF-C Store - State management for contact matrix and linked browser
// ============================================================================

import { create } from 'zustand';
import type { ContactMode, LinkedSession, MicroCTrackMode, SplitViewMode } from '../types/dafc';
import type { Gene } from '../types';

/** A matrix focus interval; chrom/panelId are absent on focus saved before scoping (applies anywhere it overlaps). */
export interface MatrixFocusRegion { start: number; end: number; chrom?: string; panelId?: string }

// A linked read with its segments in X and Y regions
interface LinkedRead {
  base_id: string;
  x_segments: string[];  // Full segment names in X region
  y_segments: string[];  // Full segment names in Y region
}

interface DAFCStore {
  // DAF-C State
  dafcLoaded: boolean;
  /** Bumped whenever a contact map file is (re)loaded: a new map at the same coordinates. */
  dafcLoadGeneration: number;
  dafcChrom: string;
  dafcStart: number;
  dafcEnd: number;
  dafcResolution: number;
  dafcResolutions: number[];
  dafcSelection: {
    chrom: string;
    x_start: number;
    x_end: number;
    y_start: number;
    y_end: number;
    contacts: number;
    n_ligated_reads: number;
    read_ids: string[];
    contact_mode?: ContactMode;
  } | null;

  // Contact mode detection
  contactMode: ContactMode | null;  // Detected or manual mode
  contactModeOverride: ContactMode | 'auto' | null;  // null/auto = auto-detect, 'dafc'/'microc' = manual override
  splitViewMode: SplitViewMode;  // Semantic mode: molecule-linked, region-independent, or coordinate-synced
  splitViewLinked: boolean;  // Compatibility mirror: true only for molecule-linked rows

  // Micro-C track display modes
  microcTrackMode: MicroCTrackMode;  // Current display mode for contact track
  microcMinDistance: number;  // Min interaction distance for arc display (filter out short-range noise)
  microcMaxDistance: number;  // Max interaction distance for matrix/arc display
  microcResolution: number | null;  // Selected resolution (null = auto)
  arcStrengthFilter: number;  // Minimum arc strength to display (0-1)
  arcStrengthFilterMax: number;  // Maximum arc strength to display (0-1, 1 = no max filter)
  filterByPeaks: boolean;  // Filter arcs to show only those overlapping selected peaks
  matrixScaling: 'linear' | 'log' | 'sqrt';  // Matrix value scaling mode
  matrixColormap: 'red' | 'fall' | 'hot' | 'viridis' | 'blues';  // Matrix colormap
  matrixNormalization: 'none' | 'balanced' | 'oe' | 'oe_global';  // Matrix normalization: none, ICE balanced, O/E local, or O/E global
  // Focus region for matrix (genomic coords), scoped to the panel and chromosome it was drawn on.
  matrixFocusRegion: MatrixFocusRegion | null;
  matrixValueMin: number | null;  // Min value clamp for color scale (null = auto)
  matrixValueMax: number | null;  // Max value clamp for color scale (null = auto)
  arcDisplayMode: 'individual' | 'merged' | 'opacity';  // Arc display mode: individual, merged, or opacity-scaled
  arcMergeBinSize: number;  // Bin size for merging nearby arcs (in bp)
  arcNormalization: 'none' | 'oe' | 'oe_global';  // Arc normalization: none (raw), oe (local), or oe_global (chromosome-wide)
  arcMinCount: number;  // Minimum raw count filter (0 = use strength threshold)
  arcOEFloor: number;  // Minimum O/E to display (only for O/E modes, 0 = show all)
  arcAccCorrect: boolean;  // Apply accessibility correction from fiber-seq
  arcAccLog: boolean;  // Use log-space accessibility correction (experimental)
  globalOEStatus: 'ready' | 'computing' | 'not_started';  // Status of global O/E expected values for current chrom
  v4cNormalization: 'none' | 'oe';  // Virtual 4C normalization: none (raw) or oe (observed/expected)
  v4cSmoothing: number;  // Smoothing window size (0 = off, 3/5/7 = moving average)
  v4cMinCount: number;  // Minimum raw count to display (filters noise)
  v4cViewpoint: { chrom?: string; start: number; end: number; label?: string } | null;  // Custom viewpoint for Virtual 4C (null = viewport center); used only on its chromosome

  // Linked Sessions
  linkedSessions: LinkedSession[];
  currentLinkedSessionId: string | null;
  linkedRegions: {
    chrom: string;
    x_chrom?: string | null;
    y_chrom?: string | null;
    x_start: number;
    x_end: number;
    y_start: number;
    y_end: number;
  } | null;
  linkedReadCount: number;
  linkedVersion: number;
  
  // Split view state for linked reads
  linkedReads: LinkedRead[];        // Ordered list of linked reads
  xSegmentNames: Set<string>;       // All X segment names (for filtering)
  ySegmentNames: Set<string>;       // All Y segment names (for filtering)
  linkedSplitMode: 'horizontal' | 'vertical';  // horizontal = top/bottom, vertical = side-by-side
  
  // Independent viewports for X and Y panels
  xViewport: { start: number; end: number } | null;
  yViewport: { start: number; end: number } | null;
  
  // Sort order: which region determines the row ordering
  linkedSortBy: 'x' | 'y';
  
  // Viewport filtering: show only reads visible in checked viewport(s)
  xViewportFilter: boolean;  // If true, only show reads with segments in X viewport
  yViewportFilter: boolean;  // If true, only show reads with segments in Y viewport
  
  // Computed visible read IDs (set by each ReadTrack)
  xVisibleReadIds: Set<string> | null;  // Read IDs visible in X viewport (null: its reads haven't loaded)
  yVisibleReadIds: Set<string> | null;  // Read IDs visible in Y viewport (null: its reads haven't loaded)
  
  // Show unlinked reads panel below linked reads
  showUnlinkedReads: boolean;
  highlightLinkedMolecules: boolean;

  // Gene annotation state
  showGeneAnnotations: boolean;  // Toggle for gene display on matrix axes
  dafcGenes: Gene[];  // Cached genes for current viewport

  // Independent X/Y viewport for contact matrix (off-diagonal support)
  dafcXStart: number;
  dafcXEnd: number;
  dafcYStart: number;
  dafcYEnd: number;

  // Viewport sync
  dafcFollowBrowser: boolean;  // When true, contact map mirrors browser viewport

  // Actions
  setDafcLoaded: (loaded: boolean) => void;
  bumpDafcLoadGeneration: () => void;
  setDafcViewport: (chrom: string, start: number, end: number) => void;
  setDafcMatrixViewport: (chrom: string, xStart: number, xEnd: number, yStart: number, yEnd: number) => void;
  setDafcResolution: (resolution: number) => void;
  setDafcResolutions: (resolutions: number[]) => void;
  setDafcSelection: (selection: DAFCStore['dafcSelection']) => void;

  // Contact mode actions
  setContactMode: (mode: ContactMode | null) => void;
  setContactModeOverride: (mode: ContactMode | 'auto' | null) => void;
  setSplitViewMode: (mode: SplitViewMode) => void;
  setSplitViewLinked: (linked: boolean) => void;

  // Micro-C track actions
  setMicrocTrackMode: (mode: MicroCTrackMode) => void;
  toggleMicrocTrackMode: (mode: 'matrix' | 'arc' | 'virtual4c' | 'apa') => void;
  setMicrocMinDistance: (distance: number) => void;
  setMicrocMaxDistance: (distance: number) => void;
  setMicrocResolution: (resolution: number | null) => void;
  setArcStrengthFilter: (strength: number) => void;
  setArcStrengthFilterMax: (strength: number) => void;
  setFilterByPeaks: (enabled: boolean) => void;
  toggleFilterByPeaks: () => void;
  setMatrixScaling: (scaling: 'linear' | 'log' | 'sqrt') => void;
  setMatrixColormap: (colormap: 'red' | 'fall' | 'hot' | 'viridis' | 'blues') => void;
  setMatrixNormalization: (normalization: 'none' | 'balanced' | 'oe' | 'oe_global') => void;
  setMatrixFocusRegion: (region: MatrixFocusRegion | null) => void;
  clearMatrixFocusRegion: () => void;
  setMatrixValueMin: (val: number | null) => void;
  setMatrixValueMax: (val: number | null) => void;
  setArcDisplayMode: (mode: 'individual' | 'merged' | 'opacity') => void;
  setArcMergeBinSize: (size: number) => void;
  setArcNormalization: (norm: 'none' | 'oe' | 'oe_global') => void;
  setArcMinCount: (count: number) => void;
  setArcOEFloor: (floor: number) => void;
  setArcAccCorrect: (enabled: boolean) => void;
  setArcAccLog: (enabled: boolean) => void;
  setV4cNormalization: (norm: 'none' | 'oe') => void;
  setV4cSmoothing: (window: number) => void;
  setV4cMinCount: (count: number) => void;
  setV4cViewpoint: (viewpoint: { chrom?: string; start: number; end: number; label?: string } | null) => void;
  clearV4cViewpoint: () => void;
  setGlobalOEStatus: (status: 'ready' | 'computing' | 'not_started') => void;
  setLinkedSessions: (sessions: DAFCStore['linkedSessions']) => void;
  setCurrentLinkedSession: (sessionId: string | null) => void;
  setLinkedState: (
    regions: DAFCStore['linkedRegions'],
    count: number,
    version: number
  ) => void;
  
  // New actions for split view
  setLinkedReads: (reads: LinkedRead[]) => void;
  setLinkedSegments: (xSegments: string[], ySegments: string[]) => void;
  setLinkedSplitMode: (mode: 'horizontal' | 'vertical') => void;
  setXViewport: (start: number, end: number) => void;
  setYViewport: (start: number, end: number) => void;
  setLinkedSortBy: (sortBy: 'x' | 'y') => void;
  toggleLinkedSortBy: () => void;
  setXViewportFilter: (enabled: boolean) => void;
  setYViewportFilter: (enabled: boolean) => void;
  toggleXViewportFilter: () => void;
  toggleYViewportFilter: () => void;
  setXVisibleReadIds: (ids: Set<string> | null) => void;
  setYVisibleReadIds: (ids: Set<string> | null) => void;
  setShowUnlinkedReads: (show: boolean) => void;
  toggleShowUnlinkedReads: () => void;
  setHighlightLinkedMolecules: (show: boolean) => void;
  toggleHighlightLinkedMolecules: () => void;
  clearLinkedState: () => void;

  // Gene annotation actions
  setShowGeneAnnotations: (show: boolean) => void;
  toggleShowGeneAnnotations: () => void;
  setDafcGenes: (genes: Gene[]) => void;

  // Viewport sync actions
  setDafcFollowBrowser: (follow: boolean) => void;
}

export const useDafcStore = create<DAFCStore>((set) => ({
  // Initial state
  dafcLoaded: false,
  dafcLoadGeneration: 0,
  dafcChrom: 'chr1',
  dafcStart: 0,
  dafcEnd: 10000000,
  dafcResolution: 10000,
  dafcResolutions: [],
  dafcSelection: null,
  contactMode: null,
  contactModeOverride: null,  // null = auto-detect
  splitViewMode: 'region_independent',
  splitViewLinked: false,  // Default to region-independent rows
  microcTrackMode: null,  // No track displayed by default
  microcMinDistance: 500,  // 500bp default min distance (filter out very short-range noise)
  microcMaxDistance: 100000,  // 100kb default max distance
  microcResolution: null,  // null = auto-select based on viewport
  arcStrengthFilter: 0,  // Show all arcs by default (0 = no min filter)
  arcStrengthFilterMax: 1,  // Show all arcs by default (1 = no max filter)
  filterByPeaks: true,  // Filter by peaks by default (show only peak-to-peak contacts)
  matrixScaling: 'log',  // Log scaling by default to show rare contacts
  matrixColormap: 'fall',  // Fall colormap (white -> yellow -> red -> black) by default
  matrixNormalization: 'balanced',  // ICE-balanced by default (matches HiGlass)
  matrixFocusRegion: null,  // No focus by default (show full viewport)
  matrixValueMin: null,  // Auto min
  matrixValueMax: null,  // Auto max
  arcDisplayMode: 'individual',  // Default: show all individual arcs
  arcMergeBinSize: 1000,  // Default: 1kb bins for merging (close to typical resolution)
  arcNormalization: 'none',  // Default: raw counts (not O/E normalized)
  arcMinCount: 0,  // Default: use strength threshold (0 = disabled)
  arcOEFloor: 0,  // Default: show all O/E values (0 = no floor)
  arcAccCorrect: false,  // Default: no accessibility correction
  arcAccLog: false,  // Default: linear correction (if enabled)
  globalOEStatus: 'not_started',  // Default: not started
  v4cNormalization: 'none',  // Default: raw counts (not O/E normalized)
  v4cSmoothing: 3,  // Default: 3-bin moving average for noise reduction
  v4cMinCount: 0,  // Default: show all (no minimum threshold)
  v4cViewpoint: null,  // Default: use viewport center as viewpoint
  linkedSessions: [],
  currentLinkedSessionId: null,
  linkedRegions: null,
  linkedReadCount: 0,
  linkedVersion: 0,
  linkedReads: [],
  xSegmentNames: new Set(),
  ySegmentNames: new Set(),
  linkedSplitMode: 'vertical',  // Only vertical (side-by-side) supported
  xViewport: null,
  yViewport: null,
  linkedSortBy: 'x',
  xViewportFilter: false,
  yViewportFilter: false,
  xVisibleReadIds: null,
  yVisibleReadIds: null,
  showUnlinkedReads: false,
  highlightLinkedMolecules: false,

  // Gene annotation initial state
  showGeneAnnotations: false,
  dafcGenes: [],

  // Independent X/Y viewport initial state
  dafcXStart: 0,
  dafcXEnd: 10000000,
  dafcYStart: 0,
  dafcYEnd: 10000000,

  // Viewport sync initial state
  dafcFollowBrowser: true,  // Contact map follows browser by default

  // Actions
  setDafcLoaded: (dafcLoaded: boolean) => set({ dafcLoaded }),
  bumpDafcLoadGeneration: () => set(s => ({ dafcLoadGeneration: s.dafcLoadGeneration + 1 })),
  setDafcViewport: (dafcChrom: string, dafcStart: number, dafcEnd: number) =>
    set({ dafcChrom, dafcStart, dafcEnd, dafcXStart: dafcStart, dafcXEnd: dafcEnd, dafcYStart: dafcStart, dafcYEnd: dafcEnd, dafcSelection: null }),
  setDafcMatrixViewport: (dafcChrom: string, dafcXStart: number, dafcXEnd: number, dafcYStart: number, dafcYEnd: number) => {
    // Also update the diagonal viewport to the bounding range (for strip track compat)
    const dafcStart = Math.min(dafcXStart, dafcYStart);
    const dafcEnd = Math.max(dafcXEnd, dafcYEnd);
    set({ dafcChrom, dafcStart, dafcEnd, dafcXStart, dafcXEnd, dafcYStart, dafcYEnd, dafcSelection: null });
  },
  setDafcResolution: (dafcResolution: number) => set({ dafcResolution }),
  setDafcResolutions: (dafcResolutions: number[]) => set({ dafcResolutions }),
  setDafcSelection: (dafcSelection: DAFCStore['dafcSelection']) => set({ dafcSelection }),

  // Contact mode actions
  setContactMode: (contactMode: ContactMode | null) => set({ contactMode }),
  setContactModeOverride: (contactModeOverride: ContactMode | 'auto' | null) => set({ contactModeOverride }),
  setSplitViewMode: (splitViewMode: SplitViewMode) => set({
    splitViewMode,
    splitViewLinked: splitViewMode === 'molecule_linked',
  }),
  setSplitViewLinked: (splitViewLinked: boolean) => set({
    splitViewLinked,
    splitViewMode: splitViewLinked ? 'molecule_linked' : 'region_independent',
  }),

  // Micro-C track actions
  setMicrocTrackMode: (microcTrackMode: MicroCTrackMode) => set({ microcTrackMode }),
  toggleMicrocTrackMode: (mode: 'matrix' | 'arc' | 'virtual4c' | 'apa') => {
    const currentMode = useDafcStore.getState().microcTrackMode;
    if (currentMode === mode) {
      // Unchecking - just set to null
      set({ microcTrackMode: null });
    } else if (currentMode !== null) {
      // Switching from one mode to another - go through null first
      set({ microcTrackMode: null });
      // Use setTimeout to ensure the null state is processed before setting new mode
      setTimeout(() => set({ microcTrackMode: mode }), 0);
    } else {
      // From null to mode - direct set
      set({ microcTrackMode: mode });
    }
  },
  setMicrocMinDistance: (microcMinDistance: number) => set({ microcMinDistance }),
  setMicrocMaxDistance: (microcMaxDistance: number) => set({ microcMaxDistance }),
  setMicrocResolution: (microcResolution: number | null) => set({ microcResolution }),
  setArcStrengthFilter: (arcStrengthFilter: number) => set({ arcStrengthFilter }),
  setArcStrengthFilterMax: (arcStrengthFilterMax: number) => set({ arcStrengthFilterMax }),
  setFilterByPeaks: (filterByPeaks: boolean) => set({ filterByPeaks }),
  toggleFilterByPeaks: () => set((state) => ({ filterByPeaks: !state.filterByPeaks })),
  setMatrixScaling: (matrixScaling: 'linear' | 'log' | 'sqrt') => set({ matrixScaling }),
  setMatrixColormap: (matrixColormap: 'red' | 'fall' | 'hot' | 'viridis' | 'blues') => set({ matrixColormap }),
  setMatrixNormalization: (matrixNormalization: 'none' | 'balanced' | 'oe' | 'oe_global') => set({ matrixNormalization }),
  setMatrixFocusRegion: (matrixFocusRegion: MatrixFocusRegion | null) => set({ matrixFocusRegion }),
  clearMatrixFocusRegion: () => set({ matrixFocusRegion: null }),
  setMatrixValueMin: (matrixValueMin: number | null) => set({ matrixValueMin }),
  setMatrixValueMax: (matrixValueMax: number | null) => set({ matrixValueMax }),
  setArcDisplayMode: (arcDisplayMode: 'individual' | 'merged' | 'opacity') => set({ arcDisplayMode }),
  setArcMergeBinSize: (arcMergeBinSize: number) => set({ arcMergeBinSize }),
  setArcNormalization: (arcNormalization: 'none' | 'oe' | 'oe_global') => set({ arcNormalization }),
  setArcMinCount: (arcMinCount: number) => set({ arcMinCount }),
  setArcOEFloor: (arcOEFloor: number) => set({ arcOEFloor }),
  setArcAccCorrect: (arcAccCorrect: boolean) => set({ arcAccCorrect }),
  setArcAccLog: (arcAccLog: boolean) => set({ arcAccLog }),
  setV4cNormalization: (v4cNormalization: 'none' | 'oe') => set({ v4cNormalization }),
  setV4cSmoothing: (v4cSmoothing: number) => set({ v4cSmoothing }),
  setV4cMinCount: (v4cMinCount: number) => set({ v4cMinCount }),
  setV4cViewpoint: (v4cViewpoint: { chrom?: string; start: number; end: number; label?: string } | null) => set({ v4cViewpoint }),
  clearV4cViewpoint: () => set({ v4cViewpoint: null }),
  setGlobalOEStatus: (globalOEStatus: 'ready' | 'computing' | 'not_started') => set({ globalOEStatus }),

  setLinkedSessions: (linkedSessions: DAFCStore['linkedSessions']) => set({ linkedSessions }),
  setCurrentLinkedSession: (currentLinkedSessionId: string | null) => set({ currentLinkedSessionId }),
  setLinkedState: (linkedRegions: DAFCStore['linkedRegions'], linkedReadCount: number, linkedVersion: number) =>
    set({ linkedRegions, linkedReadCount, linkedVersion }),
  
  // New actions
  setLinkedReads: (linkedReads: LinkedRead[]) => set({ linkedReads }),
  setLinkedSegments: (xSegments: string[], ySegments: string[]) => set({
    xSegmentNames: new Set(xSegments),
    ySegmentNames: new Set(ySegments),
  }),
  setLinkedSplitMode: (linkedSplitMode: 'horizontal' | 'vertical') => set({ linkedSplitMode }),
  setXViewport: (start: number, end: number) => set({ xViewport: { start, end } }),
  setYViewport: (start: number, end: number) => set({ yViewport: { start, end } }),
  setLinkedSortBy: (linkedSortBy: 'x' | 'y') => set({ linkedSortBy }),
  toggleLinkedSortBy: () => set((state) => ({ linkedSortBy: state.linkedSortBy === 'x' ? 'y' : 'x' })),
  setXViewportFilter: (xViewportFilter: boolean) => set({ xViewportFilter }),
  setYViewportFilter: (yViewportFilter: boolean) => set({ yViewportFilter }),
  toggleXViewportFilter: () => set((state) => ({ xViewportFilter: !state.xViewportFilter })),
  toggleYViewportFilter: () => set((state) => ({ yViewportFilter: !state.yViewportFilter })),
  setXVisibleReadIds: (xVisibleReadIds: Set<string> | null) => set({ xVisibleReadIds }),
  setYVisibleReadIds: (yVisibleReadIds: Set<string> | null) => set({ yVisibleReadIds }),
  setShowUnlinkedReads: (showUnlinkedReads: boolean) => set({ showUnlinkedReads }),
  toggleShowUnlinkedReads: () => set((state) => ({ showUnlinkedReads: !state.showUnlinkedReads })),
  setHighlightLinkedMolecules: (highlightLinkedMolecules: boolean) => set({ highlightLinkedMolecules }),
  toggleHighlightLinkedMolecules: () => set((state) => ({ highlightLinkedMolecules: !state.highlightLinkedMolecules })),
  clearLinkedState: () => set({
    linkedReads: [],
    xSegmentNames: new Set(),
    ySegmentNames: new Set(),
    linkedRegions: null,
    splitViewMode: 'region_independent',
    splitViewLinked: false,
    xViewport: null,
    yViewport: null,
    linkedSortBy: 'x',
    xViewportFilter: false,
    yViewportFilter: false,
    xVisibleReadIds: null,
    yVisibleReadIds: null,
    showUnlinkedReads: false,
    highlightLinkedMolecules: false,
  }),

  // Gene annotation actions
  setShowGeneAnnotations: (showGeneAnnotations: boolean) => set({ showGeneAnnotations }),
  toggleShowGeneAnnotations: () => set((state) => ({ showGeneAnnotations: !state.showGeneAnnotations })),
  setDafcGenes: (dafcGenes: Gene[]) => set({ dafcGenes }),

  // Viewport sync actions
  setDafcFollowBrowser: (dafcFollowBrowser: boolean) => set({ dafcFollowBrowser }),
}));

/**
 * The read filter of a linked split view: the molecules visible in each window
 * whose filter is on (both on: in both). A window whose reads haven't loaded
 * (null) doesn't filter yet; one loaded but empty filters to nothing. null
 * means no filter.
 */
export function linkedViewportFilter(
  xOn: boolean, yOn: boolean, xIds: Set<string> | null, yIds: Set<string> | null,
): Set<string> | null {
  const sides = [xOn ? xIds : null, yOn ? yIds : null].filter((ids): ids is Set<string> => ids != null);
  if (sides.length === 0) return null;
  if (sides.length === 1) return sides[0];
  const result = new Set<string>();
  for (const id of sides[0]) if (sides[1].has(id)) result.add(id);
  return result;
}
