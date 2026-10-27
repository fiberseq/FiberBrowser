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

/** A nucleosome panel's own settings, saved with the session on its panel (panels[].nucleosomes). */
export interface NucPanelState {
  /** Observation ids the user hid from the columns. */
  hidden?: string[];
  /** nuc module parameters (fiberhmm-scan --parameters' nuc group); absent: the defaults. */
  parameters?: Record<string, unknown>;
}

declare module '../../types' {
  interface PanelConfig {
    /** A nucleosome panel's settings (features/nucleosomes). */
    nucleosomes?: NucPanelState;
  }
}
