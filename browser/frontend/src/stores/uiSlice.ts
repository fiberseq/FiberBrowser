import { DEFAULT_SIGNAL_FILTERS, type SignalFilters, type SignalCounts } from '../utils/signalFilters';
import { isPublicServerPage } from '../utils/publicServerFlag';
import type { BrowserState } from './browserStore';
import type { SortMode, FilterMode, ModificationType, MetaProfileType } from '../types';
import { loadSidebarWidth, loadActiveSection, coerceSidebarSection, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, SIDEBAR_WIDTH_STORAGE_KEY, SIDEBAR_ACTIVE_SECTION_STORAGE_KEY } from './utils';
import { normalizeAnnotationLayer } from '../utils/layerAliases';
import { getBrowserPerformanceProfile } from '../utils/performanceProfile';
import { DEFAULT_CLASS_REGION_MODE, isClassRegionMode, type ClassRegionMode } from '../utils/classRegion';


// ============================================================
// UI SLICE — Interface
// ============================================================

export type ReadDisplayMode = 'sample' | 'all';

/** What a read panel last loaded and shows (Copilot troubleshooting reads it). */
export interface ReadTrackStatus {
  datasetId: string;
  chrom: string;
  start: number;
  end: number;
  loading: boolean;
  fetchFailed: boolean;
  warning: string | null;
  /** The panel is wider than the read-display limit, so it shows coverage only. */
  zoomedOut: boolean;
  /** The reads held are still the previous view's. */
  stale: boolean;
  /** Reads drawn after filters, focus and branch scope. */
  displayed: number;
  working: number;
  inScope: number;
  overlapping: number;
  spanning: number;
  strand: 'CT' | 'GA' | null;
}
export type ReadSeparatorMode = 'auto' | 'fixed' | 'off';

/** Min footprints per read by default (sidebar → Reads & Display → Read Filters). */
export const DEFAULT_MIN_FOOTPRINTS = 5;
/** Read-end footprints shorter than this are dropped when hideShortEndFootprints
 *  is on (the server's SHORT_TERMINAL_FOOTPRINT_BP). */
export const SHORT_END_FOOTPRINT_BP = 90;
/** ...and only when within this of the read end (SHORT_TERMINAL_FOOTPRINT_MAX_END_GAP_BP). */
export const SHORT_END_FOOTPRINT_MAX_END_GAP_BP = 30;

/** Why the default Min footprints was turned off (shown on that dataset's reads). */
export interface MinFootprintsNotice {
  datasetId: string;
  label: string;
  /** Reads in view the default hid. */
  hidden: number;
}

/** The notice is about this dataset, and Min footprints is still off (an undo or a restore may have put it back). */
export function minFootprintsNoticeApplies(notice: MinFootprintsNotice | null, datasetId: string | null | undefined, minFootprints: number): boolean {
  return Boolean(notice) && notice!.datasetId === datasetId && minFootprints === 0;
}

export interface UiSlice {
  sortMode: SortMode;
  /** The Sort selector's choice the reads were last sorted by (`occupancy@nuc`, `projection`, …); null: none yet. */
  sortSelection: string | null;
  filterMode: FilterMode;
  spanningOnly: boolean;
  downsampleCount: number | null;
  readDisplayMode: ReadDisplayMode;
  allReadsDisplayCap: number;
  backgroundReadCap: number | null;
  clusterPreparationCount: number | null;
  clusterPreparationSamples: Record<string, import('../types').ClusterPreparationSample>;
  setClusterPreparationCount: (count: number | null) => void;
  analysisSampleCount: number | null;
  analysisSampleSeed: string;
  /** Which region Find classes analyses (utils/classRegion.ts): the selected peaks, the view, or a saved region. */
  classRegionMode: ClassRegionMode;
  enabledModTypes: Record<ModificationType, boolean>;  // Which modification types to display
  enabledMetaProfiles: Record<string, boolean>;  // Which metaprofile layer/rule sources to display
  cachedLayerTypes: Record<string, boolean>;  // Which layer payloads to prefetch/cache with read windows
  legacyLayerInference: boolean;  // Infer TF/nuc/FIRE layers from legacy footprint-only datasets
  legacyNucMinSize: number;  // Footprint size cutoff for inferred nucleosomes
  /** When set, footprint click-selection is restricted to this layer. Lets
   *  the user prefer TF (or any layer) clicks even when small TF overlays
   *  sit inside larger nuc regions. null = best-match across all layers. */
  clickTargetLayer: string | null;
  setClickTargetLayer: (layer: string | null) => void;
  /** Layer scope for the FootprintAnalysisPanel — drives backend analytics
   *  AND cross-highlight rendering on the read track. When null, cross-
   *  highlight matches every overlapping footprint regardless of layer. */
  footprintAnalysisLayer: string | null;
  setFootprintAnalysisLayer: (layer: string | null) => void;
  fillSmallGaps: boolean;
  fillGapSize: number;
  hideTerminalGaps: boolean;  // Hide leading/trailing gaps in reads (default true)
  terminalGapThreshold: number;  // Max terminal gap size (bp) before filtering read out (default 500)
  /** Drop a footprint at either end of a read (cut off by the read end) when it
   *  is under 90 bp, for display and analyses alike (server loads, default true). */
  hideShortEndFootprints: boolean;
  /** The value the server last confirmed (not saved): read requests carry it. */
  appliedHideShortEndFootprints: boolean;
  setAppliedHideShortEndFootprints: (hide: boolean) => void;
  minFpQuality: number;  // Min footprint quality (0-255), 0 = no filter
  minFootprints: number;  // Min footprints per read, 0 = no filter
  /** Min footprints is still the untouched default: data whose reads in view all
   *  fall below it (short reads, amplicons) turn it off (relaxDefaultMinFootprints). */
  minFootprintsAuto: boolean;
  /** Shown on that dataset's reads after the default was turned off for it. */
  minFootprintsNotice: MinFootprintsNotice | null;
  signalFilters: SignalFilters;
  setSignalFilters: (filters: Partial<SignalFilters>) => void;
  signalCounts: Record<string, { datasetId: string; locus: string; counts: SignalCounts }>;
  setSignalCounts: (key: string, summary: { datasetId: string; locus: string; counts: SignalCounts } | null) => void;
  showDuplicateReads: boolean;  // Include BAM 0x400 / BigBed isDuplicate reads
  showHiddenTrackStrip: boolean;
  setShowHiddenTrackStrip: (show: boolean) => void;
  fillReadHeight: boolean;  // Sparse tracks expand rows to fill height; dense tracks use selected row height.
  readSeparatorMode: ReadSeparatorMode;  // Auto ramp, fixed-width, or off inter-read separators.
  readSeparatorMinHeight: number;  // Minimum row height before separators appear.
  readSeparatorWidth: number;  // Fixed separator width in px when readSeparatorMode is fixed.
  exportFullReadTracks: boolean;  // Transient image-export mode: expand scrollable all-read tracks to full height.
  exportMatchedReadCount: number | null;  // Transient image-export display target shared by visible read tracks.
  exportMatchedReadFetchCount: number | null;  // Transient fetch cap retained while the matched display target settles.
  exportInProgress: boolean;  // Suppresses interactive layout chrome during screenshot/export capture.
  showReadTooltip: boolean;  // Show per-read tooltip on hover
  showCoverageHistogram: boolean;  // Show coverage histogram above read track
  maxRegionForReads: number;  // Max viewport size (bp) for individual read rendering; beyond this shows coverage
  /** Each read panel's last load status, by state key (see ReadTrackStatus). */
  readTrackStatus: Record<string, ReadTrackStatus>;
  setReadTrackStatus: (stateKey: string, status: ReadTrackStatus | null) => void;
  motifThreshold: number;  // Motif score threshold (0.5–1.0) for footprint/peak analysis

  // Session name and UI scale
  sessionName: string;
  uiScale: number;  // 0.5–4.0, default 1.0
  /** Show run details, seeds and provenance in panels (off: warnings only). */
  showAnalysisDetails: boolean;

  // Footprint selection (for footprint analysis panel)
  readRowHeight: number | 'auto';  // 'auto' = current auto-fit behavior, number = fixed px per row
  readScrollOffsets: Record<string, number>;  // Per-dataset vertical scroll positions

  // Bookmarks
  enabledCigarTypes: {
    mismatches: boolean;
    insertions: boolean;
    deletions: boolean;
  };

  // Global refresh trigger — increment to signal Browser.tsx to re-fetch tracks/chroms/status
  refreshGeneration: number;
  triggerRefresh: () => void;

  // Track name filters (JASPAR TF filtering etc.)
  darkMode: boolean;
  toggleDarkMode: () => void;

  publicMode: boolean;
  setPublicMode: (enabled: boolean) => void;

  // Analysis panels (now unified into panels array)
  setSortMode: (mode: SortMode) => void;
  setFilterMode: (mode: FilterMode) => void;
  setSpanningOnly: (spanning: boolean) => void;
  setDownsampleCount: (count: number | null) => void;
  setReadDisplayMode: (mode: ReadDisplayMode) => void;
  setAllReadsDisplayCap: (count: number) => void;
  setBackgroundReadCap: (count: number | null) => void;
  setAnalysisSampleCount: (count: number | null) => void;
  setAnalysisSampleSeed: (seed: string) => void;
  setClassRegionMode: (mode: ClassRegionMode) => void;
  toggleModType: (modType: ModificationType, enabled: boolean) => void;
  isModTypeAvailable: (modType: ModificationType) => boolean;  // Check if mod type can be shown
  initModTypeDefaults: () => void;  // Auto-enable mod types based on available layers
  toggleMetaProfile: (profileType: string, enabled: boolean) => void;
  setCachedLayerType: (layerType: string, enabled: boolean) => void;
  setLegacyLayerInference: (enabled: boolean) => void;
  setLegacyNucMinSize: (size: number) => void;

  // Read display/filter actions
  setFillSmallGaps: (fill: boolean) => void;
  setFillGapSize: (size: number) => void;
  setHideTerminalGaps: (hide: boolean) => void;
  setTerminalGapThreshold: (threshold: number) => void;
  setHideShortEndFootprints: (hide: boolean) => void;
  setMinFpQuality: (quality: number) => void;
  setMinFootprints: (count: number) => void;
  /** The default Min footprints hid every read of a dataset in view: turn it off
   *  (once; only while the user hasn't set it) and say so on that dataset. */
  relaxDefaultMinFootprints: (notice: MinFootprintsNotice) => boolean;
  dismissMinFootprintsNotice: () => void;
  setShowDuplicateReads: (show: boolean) => void;
  /** Datasets whose panels load every read in view ("Load all"), not a deep view's sample. */
  loadAllReads: Record<string, boolean>;
  setLoadAllReads: (datasetId: string, on: boolean) => void;
  setFillReadHeight: (fill: boolean) => void;
  setReadSeparatorMode: (mode: ReadSeparatorMode) => void;
  setReadSeparatorMinHeight: (height: number) => void;
  setReadSeparatorWidth: (width: number) => void;
  setExportFullReadTracks: (enabled: boolean) => void;
  setExportMatchedReadCounts: (displayCount: number | null, fetchCount?: number | null) => void;
  setExportInProgress: (enabled: boolean) => void;
  setShowReadTooltip: (show: boolean) => void;
  setShowCoverageHistogram: (show: boolean) => void;
  setMaxRegionForReads: (bp: number) => void;
  setMotifThreshold: (v: number) => void;
  setSessionName: (name: string) => void;
  setUiScale: (scale: number) => void;
  setShowAnalysisDetails: (show: boolean) => void;

  // Footprint selection actions
  setReadRowHeight: (height: number | 'auto') => void;
  setReadScrollOffset: (datasetId: string, offset: number) => void;
  
  // Navigation
  toggleCigarType: (type: 'mismatches' | 'insertions' | 'deletions', enabled: boolean) => void;
  anyCigarEnabled: () => boolean;

  // Genome overview toggle
  showGenomeOverview: boolean;
  toggleGenomeOverview: () => void;

  // Reverse view & relative coordinates actions
  sidebarOpen: boolean;
  sidebarWidth: number;
  /** The settings page the sidebar shows (one section at a time; kept while it is closed). */
  activeSection: string;
  setSidebarOpen: (open: boolean) => void;
  /** Cmd/Ctrl+B: open on the last page shown, or close. */
  toggleSidebar: () => void;
  setSidebarWidth: (width: number) => void;
  /** Show a settings page (an unknown id is ignored); the sidebar's open state is unchanged. */
  setActiveSection: (sectionId: string) => void;
  /** Open the sidebar on a settings page. */
  openSidebarSection: (sectionId: string) => void;
  /** A rail icon: open on its page, switch to it, or (its page on show) close. */
  toggleSidebarSection: (sectionId: string) => void;
}

// ============================================================
// UI SLICE — Implementation
// ============================================================

export function createUiSlice(set: (partial: Partial<BrowserState> | ((state: BrowserState) => Partial<BrowserState>)) => void, get: () => BrowserState): UiSlice {
  const performanceProfile = getBrowserPerformanceProfile();
  return {
  sortMode: 'position',
  sortSelection: null,
  filterMode: 'either',
  // Off: show every read overlapping the view. Full-length-only hid most
  // reads whenever the view was wider than typical read lengths.
  spanningOnly: false,
  downsampleCount: null,
  readDisplayMode: 'sample',
  allReadsDisplayCap: performanceProfile.defaultAllReadsDisplayCap,
  backgroundReadCap: performanceProfile.defaultBackgroundReadCap,
  clusterPreparationCount: 10000,
  clusterPreparationSamples: {},
  setClusterPreparationCount: (count) => set({ clusterPreparationCount: count }),
  analysisSampleCount: null,
  analysisSampleSeed: 'fiberbrowser-analysis',
  classRegionMode: DEFAULT_CLASS_REGION_MODE,
  enabledModTypes: {
    mod: false,
    m6a: false,
    m5c: false,
    deam: false,
    deam_opportunity: false,
    msp: false,
    fire: false,
    footprint: true,
    nuc: true,
    tf: true,
  },
  enabledMetaProfiles: { nuc: true, tf: true, fire: false, m6a: false, m5c: false, deam: false },
  cachedLayerTypes: {},
  legacyLayerInference: true,
  legacyNucMinSize: 90,
  clickTargetLayer: null,
  setClickTargetLayer: (layer) => set({ clickTargetLayer: normalizeAnnotationLayer(layer) }),
  footprintAnalysisLayer: null,
  setFootprintAnalysisLayer: (layer) => set({ footprintAnalysisLayer: normalizeAnnotationLayer(layer) }),
  fillSmallGaps: false,
  fillGapSize: 50,
  hideTerminalGaps: true,  // Default: hide terminal gaps (no large leading/trailing gaps)
  terminalGapThreshold: 500,  // Default: filter reads with terminal gaps > 500bp
  hideShortEndFootprints: true,
  appliedHideShortEndFootprints: true,
  setAppliedHideShortEndFootprints: (hide) => set({ appliedHideShortEndFootprints: hide }),
  minFpQuality: 0,
  minFootprints: DEFAULT_MIN_FOOTPRINTS,
  minFootprintsAuto: true,
  minFootprintsNotice: null,
  signalFilters: { ...DEFAULT_SIGNAL_FILTERS },
  setSignalFilters: filters => set(state => ({ signalFilters: { ...state.signalFilters, ...filters },
    refreshGeneration: state.refreshGeneration + 1 })),
  signalCounts: {},
  setSignalCounts: (key, summary) => set(state => {
    const next = { ...state.signalCounts };
    if (summary) next[key] = summary; else delete next[key];
    return { signalCounts: next };
  }),
  showDuplicateReads: false,
  loadAllReads: {},
  setLoadAllReads: (datasetId, on) => set(state => {
    const next = { ...state.loadAllReads };
    if (on) next[datasetId] = true; else delete next[datasetId];
    return { loadAllReads: next };
  }),
  showHiddenTrackStrip: true,
  setShowHiddenTrackStrip: (show) => set({ showHiddenTrackStrip: show }),
  fillReadHeight: true,
  readSeparatorMode: 'auto',
  readSeparatorMinHeight: 3,
  readSeparatorWidth: 1,
  exportFullReadTracks: false,
  exportMatchedReadCount: null,
  exportMatchedReadFetchCount: null,
  exportInProgress: false,
  showReadTooltip: false,
  showCoverageHistogram: false,
  maxRegionForReads: performanceProfile.defaultMaxRegionForReads,  // Standard: 100kb; low-power clients default lower.
  readTrackStatus: {},
  setReadTrackStatus: (stateKey, status) => set(state => {
    const prev = state.readTrackStatus[stateKey];
    if (status == null) {
      if (!prev) return state;
      const next = { ...state.readTrackStatus };
      delete next[stateKey];
      return { readTrackStatus: next };
    }
    if (prev && (Object.keys(status) as Array<keyof ReadTrackStatus>).every(k => prev[k] === status[k])) return state;
    return { readTrackStatus: { ...state.readTrackStatus, [stateKey]: status } };
  }),
  motifThreshold: 0.85,
  sessionName: '',
  uiScale: 1.0,
  showAnalysisDetails: (() => {
    try { return localStorage.getItem('fiberbrowser_show_analysis_details') === 'true'; } catch { return false; }
  })(),

  // Footprint selection
  readRowHeight: 1,  // Default: compact 1 px rows with Fit + auto sample
  readScrollOffsets: {},  // Per-dataset scroll offsets

  // Genome overview toggle
  showGenomeOverview: false,
  toggleGenomeOverview: () => set(state => ({ showGenomeOverview: !state.showGenomeOverview })),

  // Refresh trigger
  refreshGeneration: 0,
  triggerRefresh: () => set(state => ({ refreshGeneration: state.refreshGeneration + 1 })),

  // Bookmarks - loaded from localStorage
  sidebarOpen: false,
  sidebarWidth: loadSidebarWidth(),
  activeSection: loadActiveSection(),
  setSidebarOpen: (open: boolean) => set({ sidebarOpen: open }),
  toggleSidebar: () => set(state => ({ sidebarOpen: !state.sidebarOpen })),
  setSidebarWidth: (width: number) => {
    const clamped = Math.round(Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, width)));
    try { localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(clamped)); } catch {}
    set({ sidebarWidth: clamped });
  },
  setActiveSection: (sectionId: string) => {
    const id = coerceSidebarSection(sectionId);
    if (!id) return;
    try { localStorage.setItem(SIDEBAR_ACTIVE_SECTION_STORAGE_KEY, id); } catch {}
    set({ activeSection: id });
  },
  openSidebarSection: (sectionId: string) => {
    const id = coerceSidebarSection(sectionId);
    if (!id) { set({ sidebarOpen: true }); return; }
    try { localStorage.setItem(SIDEBAR_ACTIVE_SECTION_STORAGE_KEY, id); } catch {}
    set({ activeSection: id, sidebarOpen: true });
  },
  toggleSidebarSection: (sectionId: string) => {
    const id = coerceSidebarSection(sectionId);
    if (!id) return;
    const { sidebarOpen, activeSection } = get();
    if (sidebarOpen && activeSection === id) { set({ sidebarOpen: false }); return; }
    try { localStorage.setItem(SIDEBAR_ACTIVE_SECTION_STORAGE_KEY, id); } catch {}
    set({ activeSection: id, sidebarOpen: true });
  },

  // CIGAR display - all disabled by default (opt-in for performance)
  enabledCigarTypes: {
    mismatches: false,
    insertions: false,
    deletions: false,
  },

  // Reference sequence (FASTA)
  darkMode: localStorage.getItem('fiberhmm_darkmode') === 'true',
  toggleDarkMode: () => set(state => {
    const next = !state.darkMode;
    localStorage.setItem('fiberhmm_darkmode', String(next));
    // Apply immediately without waiting for React render cycle
    if (next) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    // Update color-scheme meta tag so Chrome doesn't fight us
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.setAttribute('content', next ? 'dark' : 'light');
    return { darkMode: next };
  }),

  publicMode: isPublicServerPage(),  // the server marks public pages before any script runs
  setPublicMode: (enabled) => set({ publicMode: enabled }),

  // Analysis panel actions — now create unified PanelConfig entries
  setSortMode: (mode) => set({ sortMode: mode }),
  setFilterMode: (mode) => set({ filterMode: mode }),
  setSpanningOnly: (spanning) => set({ spanningOnly: spanning }),
  setDownsampleCount: (count) => {
    const n = Number(count);
    set({ downsampleCount: count == null || !Number.isFinite(n) ? null : Math.max(1, Math.min(50_000, Math.round(n))) });
  },
  setReadDisplayMode: (mode) => set(state => {
    const nextMode = mode === 'all' ? 'all' : 'sample';
    return {
      readDisplayMode: nextMode,
      readScrollOffsets: {},
    };
  }),
  setAllReadsDisplayCap: (count) => {
    const n = Number(count);
    set({ allReadsDisplayCap: Number.isFinite(n) ? Math.max(100, Math.min(200_000, Math.round(n))) : 2_000 });
  },
  setBackgroundReadCap: (count) => {
    const n = Number(count);
    set({ backgroundReadCap: count == null || !Number.isFinite(n) || n <= 0 ? null : Math.max(100, Math.min(1_000_000, Math.round(n))) });
  },
  setAnalysisSampleCount: (count) => set({ analysisSampleCount: count }),
  setAnalysisSampleSeed: (seed) => set({ analysisSampleSeed: seed.trim() || 'fiberbrowser-analysis' }),
  setClassRegionMode: (mode) => set({ classRegionMode: isClassRegionMode(mode) ? mode : DEFAULT_CLASS_REGION_MODE }),
  setLegacyLayerInference: (enabled) => set(state => ({
    legacyLayerInference: enabled,
    refreshGeneration: state.refreshGeneration + 1,
  })),
  setLegacyNucMinSize: (size) => set(state => ({
    legacyNucMinSize: Math.max(1, Math.round(Number(size) || 90)),
    refreshGeneration: state.refreshGeneration + 1,
  })),
  toggleModType: (modType, enabled) => set(state => {
    const layer = normalizeAnnotationLayer(modType) ?? modType;
    return { enabledModTypes: { ...state.enabledModTypes, [layer]: enabled } as Record<ModificationType, boolean> };
  }),
  isModTypeAvailable: (modType) => {
    const state = get();
    if (modType === 'fire') {
      return state.datasets.some(d =>
        d.available_layers?.fire ||
        d.available_layers?.msp ||
        d.layer_type === 'fire' ||
        d.layer_type === 'msp'
      ) || state.modificationOverlays.some(o => o.type === 'fire' || o.type === 'msp');
    }
    const hasFromBam = state.datasets.some(d =>
      d.data_type === 'bam' && d.available_layers?.[modType]
    );
    const hasFromBigBed = state.datasets.some(d =>
      d.data_type === 'bigbed' && d.layer_type === modType
    );
    const hasOverlay = state.modificationOverlays.some(o => o.type === modType);
    return hasFromBam || hasFromBigBed || hasOverlay;
  },
  initModTypeDefaults: () => set(state => {
    // Detection helper: does *any* currently-loaded dataset expose this layer?
    // Checks (a) v3 available_layers map, (b) legacy layer_type, and (c) the
    // "BAM with no explicit layers yet" case where footprints/mod default on.
    const hasLayer = (name: string) => state.datasets.some(d =>
      d.available_layers?.[name] ||
      d.layer_type === name ||
      (d.data_type === 'bam' && !d.available_layers && (name === 'footprint' || name === 'mod'))
    );

    const has = {
      footprint: hasLayer('footprint'),
      nuc:       hasLayer('nuc'),
      tf:        hasLayer('tf'),
      msp:       hasLayer('msp'),
      fire:      hasLayer('fire') || hasLayer('msp'),
      // Modern m6A datasets declare `available_layers.m6a`. Legacy datasets
      // (pre-2.4.0) used the generic `mod` key for the same thing, so both
      // light up the new m6a toggle.
      m6a:       hasLayer('m6a') || hasLayer('mod'),
      m5c:       hasLayer('m5c'),
      deam:      hasLayer('deam'),
      // `mod` is strictly the legacy-alias toggle — ONLY auto-enable when the
      // dataset literally declares `mod` (not when it declares `m6a`). If we
      // also lit this up for m6a, unchecking the m6a box would leave `mod`
      // enabled and the canvas's `m6aToggled = m6a || mod` fallback would
      // keep the purple marks drawing forever.
      mod:       hasLayer('mod'),
    };

    // Primary structure defaults on. Extra mark/accessibility payloads
    // (FIRE/deam/m6A/5mC) stay opt-in because they are heavier and visually
    // secondary to the nuc+TF segmentation.
    const defaultEnabled = (key: string, defaultOn: boolean) =>
      Object.prototype.hasOwnProperty.call(state.enabledModTypes, key)
        ? (state.enabledModTypes as Record<string, boolean>)[key]
        : defaultOn;
    const nextLayers: Record<string, boolean> = {
      ...state.enabledModTypes,
      footprint: defaultEnabled('footprint', has.footprint),
      nuc:       defaultEnabled('nuc',       has.nuc),
      tf:        defaultEnabled('tf',        has.tf),
      msp:       defaultEnabled('msp',       false),
      fire:      defaultEnabled('fire',      false),
      m6a:       defaultEnabled('m6a',       false),
      m5c:       defaultEnabled('m5c',       false),
      deam:      defaultEnabled('deam',      false),
      // Possible deamination sites remain available to explicit diagnostic
      // renders, but are never a live browser layer. Also clears stale saved
      // sessions from versions that exposed the experimental toggle.
      deam_opportunity: false,
      mod:       defaultEnabled('mod',       false),
    };

    const defaultMeta = (key: string, defaultOn: boolean) =>
      Object.prototype.hasOwnProperty.call(state.enabledMetaProfiles, key)
        ? (state.enabledMetaProfiles as Record<string, boolean>)[key]
        : defaultOn;
    const nextMeta: Record<string, boolean> = {
      ...state.enabledMetaProfiles,
      nuc:  defaultMeta('nuc',  has.nuc || has.footprint),
      tf:   defaultMeta('tf',   has.tf),
      fire: defaultMeta('fire', false),
      m6a:  defaultMeta('m6a',  false),
      m5c:  defaultMeta('m5c',  false),
      deam: defaultMeta('deam', false),
    };

    return { enabledModTypes: nextLayers, enabledMetaProfiles: nextMeta };
  }),
  toggleMetaProfile: (profileType, enabled) => set(state => {
    const layer = normalizeAnnotationLayer(profileType) ?? profileType;
    return { enabledMetaProfiles: { ...state.enabledMetaProfiles, [layer]: enabled } };
  }),
  setCachedLayerType: (layerType, enabled) => set(state => {
    const layer = normalizeAnnotationLayer(layerType) ?? layerType;
    return { cachedLayerTypes: { ...state.cachedLayerTypes, [layer]: enabled } };
  }),

  // Read display/filter actions
  setFillSmallGaps: (fill) => set({ fillSmallGaps: fill }),
  setFillGapSize: (size) => set({ fillGapSize: size }),
  setHideTerminalGaps: (hide) => set({ hideTerminalGaps: hide }),
  setTerminalGapThreshold: (threshold) => set({ terminalGapThreshold: threshold }),
  setHideShortEndFootprints: (hide) => set({ hideShortEndFootprints: hide }),
  setMinFpQuality: (quality) => set({ minFpQuality: quality }),
  // Any explicit choice (sidebar, Copilot, the notice's buttons) is the user's: no more auto.
  setMinFootprints: (count) => set({ minFootprints: count, minFootprintsAuto: false, minFootprintsNotice: null }),
  relaxDefaultMinFootprints: (notice) => {
    const s = get();
    if (!s.minFootprintsAuto || s.minFootprints !== DEFAULT_MIN_FOOTPRINTS) return false;
    set({ minFootprints: 0, minFootprintsAuto: false, minFootprintsNotice: notice });
    return true;
  },
  dismissMinFootprintsNotice: () => set({ minFootprintsNotice: null }),
  setFillReadHeight: (fill) => set({ fillReadHeight: fill }),
  setReadSeparatorMode: (mode) => set({
    readSeparatorMode: mode === 'fixed' || mode === 'off' ? mode : 'auto',
    readScrollOffsets: {},
  }),
  setReadSeparatorMinHeight: (height) => {
    const n = Number(height);
    set({ readSeparatorMinHeight: Number.isFinite(n) ? Math.max(0.5, Math.min(50, n)) : 3, readScrollOffsets: {} });
  },
  setReadSeparatorWidth: (width) => {
    const n = Number(width);
    set({ readSeparatorWidth: Number.isFinite(n) ? Math.max(0, Math.min(10, n)) : 1, readScrollOffsets: {} });
  },
  setExportFullReadTracks: (enabled) => set({ exportFullReadTracks: enabled }),
  setExportMatchedReadCounts: (displayCount, fetchCount) => {
    if (displayCount == null) {
      set({ exportMatchedReadCount: null, exportMatchedReadFetchCount: null });
      return;
    }
    const display = Math.max(1, Math.min(50_000, Math.round(Number(displayCount) || 1)));
    const requestedFetch = fetchCount == null ? display : Math.round(Number(fetchCount) || display);
    set({
      exportMatchedReadCount: display,
      exportMatchedReadFetchCount: Math.max(display, Math.min(50_000, requestedFetch)),
    });
  },
  setExportInProgress: (enabled) => set({ exportInProgress: enabled }),
  setShowReadTooltip: (show) => set({ showReadTooltip: show }),
  setShowDuplicateReads: (show) => set(state => ({
    showDuplicateReads: show,
    // Duplicate visibility changes read membership, so force a new request
    // immediately instead of waiting for a viewport change.
    refreshGeneration: state.refreshGeneration + 1,
  })),
  setShowCoverageHistogram: (show) => set({ showCoverageHistogram: show }),
  setMaxRegionForReads: (bp) => set({ maxRegionForReads: Math.max(10_000, Math.min(10_000_000, bp)) }),
  setMotifThreshold: (v) => { if (Number.isFinite(v)) set({ motifThreshold: Math.max(0.5, Math.min(1.0, v)) }); },
  setSessionName: (name) => set({ sessionName: name }),
  setUiScale: (scale) => set({ uiScale: Number.isFinite(scale) ? Math.max(0.5, Math.min(4, scale)) : 1 }),
  setShowAnalysisDetails: (show) => {
    try { localStorage.setItem('fiberbrowser_show_analysis_details', String(show)); } catch { /* per-viewer preference */ }
    // Hiding details also drops the click target, whose control it hides.
    set(show ? { showAnalysisDetails: show } : { showAnalysisDetails: show, clickTargetLayer: null });
  },

  // Footprint selection actions
  setReadRowHeight: (height) => set({ readRowHeight: height, readScrollOffsets: {} }),  // Reset all scrolls when height changes
  setReadScrollOffset: (datasetId, offset) => set(state => ({
    readScrollOffsets: { ...state.readScrollOffsets, [datasetId]: Math.max(0, offset) }
  })),
  
  toggleCigarType: (type: 'mismatches' | 'insertions' | 'deletions', enabled: boolean) => {
    set((state) => ({
      enabledCigarTypes: {
        ...state.enabledCigarTypes,
        [type]: enabled,
      },
    }));
  },

  anyCigarEnabled: () => {
    // Coerce to boolean so a partial enabledCigarTypes shape (missing keys)
    // returns `false` instead of `undefined`. The downstream `needsCigar`
    // gets passed to URLSearchParams which calls .toString() on every value;
    // undefined throws and kills the entire /api/reads/compact fetch.
    // (Bug surfaced in render-mode where setState ships {} for cigar types.)
    const state = get();
    const t = state.enabledCigarTypes || {};
    return Boolean(t.mismatches || t.insertions || t.deletions);
  },

  // Reverse view & relative coordinates
  };
}
