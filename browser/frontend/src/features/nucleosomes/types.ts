/**
 * The nucleosome panel's data model (native/nucleosome_panel/DESIGN.md §5.2, §6): observations (one column per
 * dataset panel, haplotype pop-out, strand split, linked locus or graph path), the server's per-observation
 * summaries (browser/services/nuc/observations.py) and the panel's saved settings.
 */

/** One column of the panel: what a Cluster run would send for that panel (utils/clusterTargets.clusterWindows). */
export interface NucObservation {
  /** Stable per panel and path: the panel's state key, plus `:graph:<hap>` for a graph path. */
  obsId: string;
  label: string;
  color: string;
  datasetId: string;
  panelId: string;
  stateKey: string;
  kind: 'linear' | 'graph';
  chrom: string;
  start: number;
  end: number;
  liftHap?: string;
  /** DAF strand panels. */
  strand?: 'CT' | 'GA';
  /** The panel's read subset (a split panel, a filter, a cluster focus): QNAMEs or record keys. */
  readIds?: string[];
  graph?: { hap?: string; contig?: string; start?: number; end?: number };
}

export interface NucCalibrationSummary {
  source: 'scan' | 'cache' | 'computed';
  scanId?: string | null;
  scope?: string | null;
  method?: string | null;
  digest: string;
  settingsHash: string;
  version: string;
  nrlPooled?: number | null;
  lambdaFloor?: number | null;
  supported?: [number, number] | [] | null;
  absolute: boolean;
  regions: number;
}

export interface NucHistogram { edges: number[]; counts: number[]; n: number }

export interface NucJob {
  timings?: { calibration: number; molecules: number };
  job_id: string;
  status: 'queued' | 'running' | 'cancelling' | 'cancelled' | 'complete' | 'error';
  stage?: string; message?: string; error?: string;
  created_at: number; finished_at?: number;
  datasets: Array<{ datasetId: string; label: string; kind: string }>;
  view: { chrom: string; start: number; end: number };
  results: Record<string, { calibration: NucCalibrationSummary; records: number; computed: number; cached: number;
    undecodable: Record<string, number>; withoutCalls?: number; datasets: string[] }>;
  progress?: { completed?: number; total?: number; stage?: string } | null;
}

export interface NucDatasetStatus {
  datasetId: string;
  label?: string;
  kind?: 'native' | 'lifted';
  error?: string;
  active?: { settingsHash: string; calibration: NucCalibrationSummary } | null;
  storedCalibration?: NucCalibrationSummary | null;
  records?: number;
}

/** A nucleosome panel's own settings, saved with the session on its panel (panels[].nucleosomes). */
export interface NucPanelState {
  /** Observation ids the user hid from the columns. */
  hidden?: string[];
  /** nuc module parameters (fiberhmm-scan --parameters' nuc group); absent: the defaults. */
  parameters?: Record<string, unknown>;
  /** Older sessions' tab (Sites, Spacing and calls, At a site or Regularity): ignored, the panel opens on its
   * geometries (as are their `window`, `windowSource`, `anchor`, `flank` and `background` keys). */
  mode?: string;
  /** Regularity view: the layer's parameters (fiberhmm.nuc.regularity; absent: FiberHMM's defaults) and its cohort. */
  regularity?: NucRegularitySettings;
}

declare module '../../types' {
  interface PackSubTrackTypes {
    /** The regularity geometry track above the reads (features/nucleosomes/GeometryFeatureTrack.tsx). */
    'nuc-geometries': true;
  }

  interface PanelConfig {
    /** A nucleosome panel's settings (features/nucleosomes). */
    nucleosomes?: NucPanelState;
  }
}

export type NucAutoAnalyse = 'off' | 'first' | 'every';
export type NucCohort = 'overlapping' | 'spanning';
/** A settings object's cohort (`cohort`, else the older `spanning` flag). */
export const cohortOf = (reg: { cohort?: NucCohort; spanning?: boolean } | undefined): NucCohort =>
  reg?.cohort ?? (reg?.spanning ? 'spanning' : 'overlapping');

/** The Regularity view's settings (fiberhmm.nuc.regularity.RegularityParams; 0 turns masking/thinning off). */
export interface NucRegularitySettings {
  params?: NucRegularityParams;
  /** Which molecules count: those overlapping the window (default, fiberhmm-scan's default cohort too) or only those
   * spanning it. */
  cohort?: NucCohort;
  /** Older sessions: only molecules spanning the whole window (read when `cohort` is absent). */
  spanning?: boolean;
  /** Along the region: what the line shows (absent: the regularity score; a channel key of utils/clusterViewChannels). */
  trackChannel?: string;
  /** Start the panel's Analyse by itself on a view without nucleosome calls: never ('off'), once when the Regularity
   * view first opens for the panel ('first', the default; afterwards an unanalysed view offers an "Analyse this view"
   * button), or on every view once it has settled ('every'; a superseded automatic Analyse is cancelled). */
  autoAnalyse?: NucAutoAnalyse;
  /** The patch section (regularity patches and shared geometries; nothing is computed while it is switched off). */
  patches?: NucPatchSettings;
  /** Which tab of the panel shows (absent: the shared geometries). */
  view?: NucRegTab;
}

/** The nucleosome panel's tabs: shared geometries (with the per-series summary), charts and detail tables, and the
 * association with an open region or TF site. */
export type NucRegTab = 'geometries' | 'charts' | 'site';

/** Patch calling, edges, geometry grouping, folding and display (fiberhmm.nuc.patches.PatchParams +
 * fiberhmm.nuc.geometries.GeometryParams field names; absent: FiberHMM's defaults). */
export interface NucPatchParams {
  enter?: number; extend?: number; min_tiles?: number;
  edges?: 'snap' | 'grid'; snap_rule?: 'open' | 'period'; open_bp?: number; search_bp?: number; nuc_min_bp?: number;
  tol_frac?: number; merged_bp?: number; core_bp?: number;
  tol_bp?: number; min_share?: number; min_molecules?: number; max_geometries?: number | null;
  fold?: 'none' | 'near' | 'all'; near_max_bp?: number;
  /** A patch cut by the view edge joins the grouping only with at least this many bp inside (0: every patch). */
  edge_min_bp?: number;
  stack_per_geometry?: number; profile_min_molecules?: number; share_min_molecules?: number;
  site_open_bp?: number; site_nuc_min_bp?: number; site_min_share?: number; site_min_gap_bp?: number; site_max?: number;
  flank_near_bp?: number; flank_far_bp?: number; tf_window_bp?: number; carriers?: 'full' | 'any';
  /** Low-regularity patches (FiberHMM LowPatchParams; mirror hysteresis below the random-packing reference);
   * absent or null: high-regularity patches only. */
  low?: NucLowPatchParams | null;
}

/** Low-regularity patch calling: start at or below `enter`, extend while at or below `extend` (log2 relative to the
 * random-packing reference median), at least `min_tiles` windows, own edges. */
export interface NucLowPatchParams {
  enter?: number; extend?: number; min_tiles?: number;
  edges?: 'snap' | 'grid'; snap_rule?: 'open' | 'period'; open_bp?: number; search_bp?: number; nuc_min_bp?: number; tol_frac?: number;
}

export type NucPatchKind = 'high' | 'low';

export interface NucPatchSettings {
  open?: boolean;
  params?: NucPatchParams;
  /** Per-dataset reference choice: a median by hand (log2), or `scan:<scanId>` to adopt a bound scan's recorded
   * reference; absent: the dataset's computed random-packing reference (its calibration population). */
  reference?: Record<string, number | string | null>;
  /** Association: site position (reference; null = the most open site), state and what the profile shows. */
  site?: number | null;
  siteState?: 'nfr' | 'tf';
  show?: 'patch' | 'low' | 'score';
  /** The class list shows every geometry of this analysis, or the saved ones (absent: all). */
  list?: 'all' | 'saved';
  /** Which kinds the class list shows (both by default when low patches are called). */
  kindFilter?: 'all' | NucPatchKind;
  /** Positions relative to this coordinate (e.g. a TSS); absent: genomic coordinates. */
  origin?: number | null;
}

export interface NucGeometryRow {
  /** G1.. (high) or L1.. (low); `number` within the kind, `rootNumber` the root's (itself when not folded). */
  id: string; kind?: NucPatchKind; number?: number; rootNumber?: number; geometryId: string;
  /** The hub hit id, as fiberhmm-scan writes it (geometry:<start>-<end>, geometry-low:<start>-<end>). */
  hitId?: string; start: number; end: number; width: number; openLeft: boolean; openRight: boolean;
  /** The chromosome the geometry is on (observations on several chromosomes pool each apart); absent or null in an
   * older answer: the window's. */
  chrom?: string | null;
  molecules: number; patches: number; startMad: number | null; endMad: number | null; score: number | null; period: number;
  parent: string | null; parentIndex: number | null; children: string[];
  perObservation: Record<string, { molecules: number; full: number; partial: number; callable: number;
    fullShare: number | null; partialShare: number | null; callableShare?: number | null; score: number | null }>;
  /** Per dataset over its molecules counted once each (overlapping panels or series never double-count). */
  perDataset?: Record<string, { molecules: number; full: number; partial: number; callable: number }>;
  /** Carriers among callable molecules, m6A density matched across datasets (one dataset: the callable share). */
  densityMatched: Record<string, number | null>;
}

export interface NucNestedRow {
  kind?: NucPatchKind; child: string; parent: string; shared: 'start' | 'end'; moved: number; near: boolean; folded: boolean;
  rest: [number, number]; shortOnly: number | null; longCarriers: number | null; noGeometry: number | null; nShortOnly: number;
}

export interface NucGeometryResult {
  /** The widest chromosome's window (profiles and the association are drawn over it). */
  window: { chrom: string; start: number; end: number } | null;
  /** Every chromosome the observations are on (each geometry names its own: `NucGeometryRow.chrom`). */
  chromosomes?: string[];
  params: { patch: Record<string, unknown>; geometry: Record<string, unknown>; view: Record<string, unknown>; cohort?: NucCohort };
  references: Record<string, number | null>; errors: Record<string, string>;
  /** Where each dataset's reference came from (calibration population, a scan's, or set by hand). */
  referenceSources?: Record<string, NucReferenceSource | null>;
  /** Bound scans' recorded references with the same regularity parameters (adoptable as `scan:<scanId>`). */
  scanReferences?: Record<string, Array<{ scanId: string; label: string; median: number | null }>>;
  /** What each share divides by. */
  shareDefinitions?: Record<string, string>;
  nMolecules: number; nPatches: number;
  kinds?: NucPatchKind[]; nPatchesByKind?: Partial<Record<NucPatchKind, number>>;
  geometries: NucGeometryRow[];
  nested: NucNestedRow[];
  stack: Array<{ id: string; kind?: NucPatchKind; n: number; patches: Array<[number, number]> }>;
  profiles: { edges: number[]; carriers: Record<string, Array<number | null>>; none: Array<number | null>;
    share: Record<string, Array<number | null>>; shareLow?: Record<string, Array<number | null>> };
  patchStats: Record<string, NucPatchStats & { low?: NucPatchStats }>;
  assignments: Record<string, { group: Record<string, number>; groupLow?: Record<string, number>; carried: Record<string, number[]>;
    partial?: Record<string, number[]> }>;
  association?: {
    sites: Array<{ pos: number; share: number }>; site: number | null; state: 'nfr' | 'tf'; show: 'patch' | 'low' | 'score';
    stateNames?: [string, string];
    profiles?: { edges: number[]; series: Array<{ obsId: string; state: number; n: number; values: Array<number | null> }> };
    table?: Array<{ obsId: string; state: number; molecules: number; m6aPerKb: number | null; upShare: number | null;
      upScore: number | null; downShare: number | null; downScore: number | null; matched: { up: number | null; down: number | null } | null;
      upLowShare?: number | null; downLowShare?: number | null; matchedLow?: { up: number | null; down: number | null } | null }>;
    tests?: { rows: Array<Record<string, unknown>>; skipped?: unknown[]; method?: string; note?: string };
  };
  timings: Record<string, number>;
  updatedDatasets: string[];
  cached: boolean;
}

export interface NucPatchStats {
  molecules: number; patches?: number; perMolecule?: number | null; shareInPatches?: number | null;
  medianClosed?: number | null; score?: number | null; lengths?: { edges: number[]; counts: number[]; n: number };
}

export interface NucRegularityParams {
  window_bp?: number; step_bp?: number; signal?: 'm6a' | 'occupancy'; band_bp?: [number, number];
  min_calls?: number; mask_open_bp?: number | null; thin_per_kb?: number | null;
  /** Read ends: blank (full windows only), extend (outer tiles painted to the ends), truncated (cut end windows). */
  ends?: 'blank' | 'extend' | 'truncated'; end_min_bp?: number; short_min_bp?: number;
}

export interface NucRegularityReference {
  median: number | null; quantiles: Record<string, number | null>; n_windows: number; n_molecules: number;
  observed_p95: number | null; observed_median: number | null; hist: { edges: number[]; counts: number[] };
  usable?: boolean; reason?: string | null;
}

/** Where a regularity reference came from (`kind` calibration: the dataset's calibration population, as
 * fiberhmm-scan computes it; scan: a bound scan's recorded reference; override: set by hand). */
export interface NucReferenceSource {
  kind: 'calibration' | 'scan' | 'override'; label?: string; median?: number | null; usable?: boolean;
  regions?: number; population?: number; molecules?: number; windows?: number; seed?: number; files?: number;
  perWidth?: boolean; scanId?: string | null; reason?: string | null;
}

export interface NucRegularitySummaryRow {
  molecules: number; m6aPerKb: number | null; footprintMedian: number | null; mergedPct: number | null;
  spacingMedian: number | null; score: number | null; scoreAboveRef: number | null; repeatLength: number | null;
}

export interface NucRegularityObservation {
  obsId: string; label?: string; datasetId: string; error?: string; cluster?: number | null;
  molecules?: number; scored?: number; notComputed?: number; records?: number;
  window?: { chrom: string; start: number; end: number } | null;
  scores?: { edges: number[]; counts: number[]; n: number };
  /** Counts per period the spectrum can report (round(nfft / k) inside the band). */
  periods?: { values: number[]; counts: number[]; n: number };
  /** Along the region: mean tile score and (period) mean local repeat length per bin; null = no tile there. */
  track?: { edges: number[]; mean: Array<number | null>; n: number[]; period?: Array<number | null> };
  scatter?: { points: Array<[number, number]>; n: number; spearman: number | null };
  acf?: { lags: number[]; mean: number[] | null; n: number; maskBp: number; thinPerKb: number };
  summary?: NucRegularitySummaryRow;
  /** With per_molecule: each scored molecule's tile score median and maximum, by QNAME. */
  perMolecule?: Record<string, [number | null, number | null]>;
}

export interface NucRegularityResult {
  observations: NucRegularityObservation[];
  datasets: Record<string, { params: NucRegularityParams; paramsDigest: string; reference: NucRegularityReference | null;
    scale: { zero: number; top: number; reference: boolean }; recomputed: number; missing: number;
    source?: NucReferenceSource | null }>;
  updatedDatasets: string[];
  cohort?: NucCohort;
}
