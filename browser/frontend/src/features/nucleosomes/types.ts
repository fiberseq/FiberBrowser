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

export interface NucObservationSummary {
  obsId: string;
  label?: string;
  datasetId: string;
  kind: 'linear' | 'graph';
  error?: string;
  records?: number;
  computed?: number;
  notComputed?: number;
  /** Records FiberHMM could not decode (no calls, a hard-clipped record): never computed. */
  undecodable?: number;
  windows?: Array<{ chrom: string; start: number; end: number }>;
  calibration?: NucCalibrationSummary | null;
  sources?: string[];
  molecules?: number;
  lowInformation?: number;
  sizes?: {
    coarse: Record<'cant_tell' | 'short' | 'mono' | 'long' | 'multi2' | 'multi3' | 'edge_truncated', number>;
    tf: number; footprints: number; cantTellFraction: number | null; z: NucHistogram;
  };
  spacing?: {
    nrl: NucHistogram & { quantiles: number[] | null };
    regularity: number[] | null; gapCv: number[] | null; tooShortFraction: number | null;
  };
  segments?: {
    bp: number; regular: number | null; disordered: number | null; undetermined: number | null;
    low_information: number | null; undersizedRuns: number; missingNucleosomes: number;
  };
  windowMetrics?: {
    n_molecules?: number; excluded_low_information?: number; insufficient?: boolean;
    nrl_quantiles?: number[] | null; regular_fraction?: number | null; disordered_fraction?: number | null;
    undetermined_fraction?: number | null; low_information_fraction?: number | null;
    undersized_fraction?: number | null; missing_per_molecule?: number | null;
    class_mix?: Record<string, number>; too_short_fraction?: number | null;
  } | null;
}

export interface NucJob {
  job_id: string;
  status: 'queued' | 'running' | 'cancelling' | 'cancelled' | 'complete' | 'error';
  stage?: string; message?: string; error?: string;
  created_at: number; finished_at?: number;
  datasets: Array<{ datasetId: string; label: string; kind: string }>;
  view: { chrom: string; start: number; end: number };
  results: Record<string, { calibration: NucCalibrationSummary; records: number; computed: number; cached: number;
    undecodable: Record<string, number>; datasets: string[] }>;
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

/** A stored window for window mode (NUC §3.7, §6.2): typed coordinates or a hand-off from another panel. */
export interface NucWindow {
  chrom: string;
  start: number;
  end: number;
  /** "chr1:1-2", "NFR hit chr1:…", … */
  label: string;
  /** The hand-off's anchor and strand (an NFR centre, a footprint, a hit), when it has one. */
  anchor?: number;
  strand?: '+' | '-';
}

/** Where window mode's window comes from: the view, the first selected peak, the first selected hub hit, typed
 * coordinates, or the last hand-off from another panel. */
export type NucWindowSource = 'view' | 'peak' | 'hub' | 'coordinates' | 'handoff';

export interface NucAnchorSettings {
  /** none: no phasing; feature: the source's own anchor (a hit's anchor, a peak's centre); centre: the window's
   * centre; position: `pos`. */
  kind: 'none' | 'feature' | 'centre' | 'position';
  pos?: number;
  /** 0 unoriented (both flanks pooled by distance), 1 downstream of a + anchor, -1 of a - anchor; 'feature': the
   * source's strand (unoriented without one). */
  orientation: 0 | 1 | -1 | 'feature';
}

/** A nucleosome panel's own settings, saved with the session on its panel (panels[].nucleosomes). */
export interface NucPanelState {
  /** Observation ids the user hid from the columns. */
  hidden?: string[];
  /** nuc module parameters (fiberhmm-scan --parameters' nuc group); absent: the defaults. */
  parameters?: Record<string, unknown>;
  /** Segments (molecule-wide, in view) or Window (metrics within a window, phasing at an anchor). */
  mode?: 'segments' | 'window';
  windowSource?: NucWindowSource;
  /** Typed coordinates or the last hand-off. */
  window?: NucWindow | null;
  anchor?: NucAnchorSettings;
  /** Flank (bp) added on each side of a peak's, hit's or hand-off's anchor: window metrics and phasing need the
   * nucleosomes around it. Default 1000. */
  flank?: number;
  /** Background anchors for the dephasing readout: none, or the other selected hub hits. */
  background?: 'none' | 'hub';
}

export interface NucPhasingBin {
  lo: number; hi: number; R: number | null; phi: number | null; n_dyads: number; n_molecules: number;
  null_mean: number | null; null_p: number | null; R_minus_null: number | null; R_max_period: number | null; P_max: number | null;
}

export interface NucPhasing {
  frame: string; P: number | null; side: string; bins: NucPhasingBin[]; dispersion_bp: number | null;
  n_molecules: number; n_appearances: number; oscillation?: Record<string, number | null>;
}

/** fiberhmm.nuc.dephasing.matched_percentile: the anchor among its matched backgrounds. */
export interface NucMatchedPercentile {
  stat: string; value: number | null; n_matched: number; background_median?: number | null; p_dephased: number | null;
}

export interface NucWindowMetrics {
  n_molecules?: number; excluded_low_information?: number; class_mix?: Record<string, number>; insufficient?: boolean;
  nrl_quantiles?: number[] | null; too_short_fraction?: number | null; regular_fraction?: number | null;
  disordered_fraction?: number | null; undetermined_fraction?: number | null; low_information_fraction?: number | null;
  undersized_fraction?: number | null; missing_per_molecule?: number | null;
  state_counts?: Record<string, number>;
  phasing?: Record<string, NucPhasing>;
  dephasing?: { anchor: Record<string, number | string | null>; coherence: NucMatchedPercentile; excess: NucMatchedPercentile; n_background: number };
}

export interface NucWindowObservation {
  obsId: string; label?: string; datasetId: string; error?: string; anchorNote?: string;
  window?: { chrom: string; start: number; end: number }; molecules?: number; notComputed?: number;
  metrics?: NucWindowMetrics | null; anchor?: { chrom: string; pos: number; orientation: number }; background?: number;
}

declare module '../../types' {
  interface PanelConfig {
    /** A nucleosome panel's settings (features/nucleosomes). */
    nucleosomes?: NucPanelState;
  }
}
