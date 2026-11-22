/** New DAF-seq run: fiberhmm-pipeline jobs (browser/routers/pipeline.py). */
import { fetchApiResponse, fetchJson } from './sharedFetch';
import type { BasecallerInfo } from '../utils/basecaller';

/** DAF-seq enzymes; hia5 (m6A Fiber-seq) only for raw Nanopore (POD5) input. */
export type Enzyme = 'dddb' | 'ddda' | 'hia5';
/** reads: FASTQ/BAM; pod5: raw Nanopore, basecalled with dorado by the pipeline first. */
export type InputKind = 'reads' | 'pod5';
export type TriState = 'auto' | 'on' | 'off';

export interface ReadFileEntry {
  path: string;
  /** pod5: a POD5 file, or a folder of them (passed to the pipeline as the folder). */
  kind: 'fastq' | 'bam' | 'pod5';
  size: number;
  /** A member of a zip: extracted into the run folder when the run starts. */
  zip?: string;
  member?: string;
}

export interface DetectedSample {
  key: string;
  name: string;
  order: string | null;
  barcode: string | null;
  files: ReadFileEntry[];
  kinds: string[];
  size: number;
}

export interface ScanResult {
  success: boolean;
  error?: string;
  samples: DetectedSample[];
  warnings: string[];
  zips?: string[];
  n_files?: number;
  input_kind?: InputKind;
}

/** dorado as FiberBrowser found it (services/external_tools.py): status only, the pipeline runs it. */
export interface DoradoStatus {
  ok: boolean;
  path: string | null;
  version: string | null;
  source?: string | null;
  label?: string;
  /** How to install it (FiberHMM's own instructions) when it was not found. */
  hint: string;
  rejected?: [string, string][];
}

/** The basecalling choices of a POD5 run (only non-defaults become --dorado-* flags). */
export interface BasecallSettings {
  /** fast / hac / sup[@vX.Y.Z], a model complex (sup,6mA) or a model folder. */
  model: string;
  /** auto (6mA for Hia5, none for DAF-seq), none, or dorado codes such as 6mA. */
  modified_bases: string;
  /** auto | metal | cuda:all | cuda:0 | cpu */
  device: string;
  batchsize: number | null;
}

export interface GenomeChoice {
  id: string;
  name: string;
  downloaded: boolean;
  fasta: string | null;
  loaded: boolean;
}

export interface LoadedReference {
  kind: 'file';
  path: string;
  label: string;
  genome?: string | null;
  plasmid?: string;
}

export interface PipelineOptions {
  dedup: TriState;
  dedup_mode: 'flag' | 'collapse';
  snp_screen: TriState;
  snp_mask: string;
  chimera_filter: boolean;
  /** FiberHMM 3.0 --alignments: primary-supplementary (its default), primary, or all (secondary too). */
  alignments: 'primary' | 'primary-supplementary' | 'all';
  prob_threshold: number | null;
  use_m5c: TriState;
  cpg_mask_policy: 'unmethylated-only' | 'methylated-only';
  /** Nucleosome recall (Hia5 and DddB): conservative (FiberHMM's default) or topology (--nuc-recall-policy topology).
   *  Never sent for DddA, whose recall ignores it. A draft from before 3.1.1 has none (conservative). */
  nuc_recall_policy?: 'conservative' | 'topology';
  /** Minimum MAPQ, always passed to a new run as --min-mapq (owner, 20 Nov 2026): 0 unless changed. */
  min_mapq: number;
}

export interface PipelineStatus {
  available: boolean;
  source: string | null;
  hint: string;
  aligner: { ok: boolean; checked?: boolean; name?: string | null; hint: string };
  dorado?: DoradoStatus;
  default_basecall?: BasecallSettings;
  cores: number;
  default_cores: number;
  default_output_root: string;
  output_parent: string;
  enzymes: { id: Enzyme; description: string; raw_only?: boolean }[];
  genomes: GenomeChoice[];
  loaded_references: LoadedReference[];
  current_genome: string | null;
  default_options: PipelineOptions;
}

export type ReferenceChoice =
  | { kind: 'genome'; genome_id: string }
  | { kind: 'file'; path: string };

export interface RunRequest {
  samples: { name: string; files: ReadFileEntry[] }[];
  reference: ReferenceChoice | Record<string, never>;
  regions: string[];
  enzyme: Enzyme;
  output_root: string;
  cores: number;
  options: PipelineOptions;
  auto_open: boolean;
  /** The page that starts the run (utils/pipelineResults pageOpenerId): only it opens the result automatically. */
  opener?: string;
  input_kind: InputKind;
  /** POD5 runs only. */
  basecall?: BasecallSettings;
}

export interface RunIssue {
  field: string;
  message: string;
  hint?: string;
}

export interface ValidateResult {
  ok: boolean;
  errors: RunIssue[];
  warnings: string[];
  jobs: { sample: string; outdir: string; command: string | null; n_files: number }[];
  output_root: string | null;
  dorado?: DoradoStatus | null;
}

export interface PipelineStep {
  name: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'skipped';
  done?: number;
  total?: number;
  unit?: string;
  rate?: number;
  eta_s?: number;
  message?: string;
  started_at?: number;
  finished_at?: number;
}

export interface JobProgress {
  version: string | null;
  steps: PipelineStep[];
  current_step: string | null;
  fraction: number | null;
  eta_s: number | null;
  logs: { level: string; message: string }[];
  warnings: string[];
  settings: Record<string, unknown> | null;
  started: boolean;
  done: Record<string, unknown> | null;
}

export interface PipelineOutputs {
  schema?: string;
  sample?: string;
  enzyme?: string;
  aligned_bam?: string | null;
  called_bam?: string | null;
  qc_report?: string | null;
  qc?: { json?: string; report?: string | null; plots?: Record<string, string>; verdicts?: Record<string, unknown> } | null;
  tracks?: string[];
  reference_fasta?: string | null;
  plasmid_map?: string | null;
  open: { fasta: string | null; datasets: string[]; plasmid_maps: string[]; region: string | null };
  /** FiberHMM 3.0: the effective settings, with the basecaller the inputs record (and any override). */
  settings?: { basecaller?: BasecallerInfo | null; basecaller_override?: Record<string, unknown> | null; [key: string]: unknown } | null;
  /** POD5 input: dorado's unaligned BAM, and how it was made. */
  basecalled_bam?: string | null;
  basecall?: {
    reads?: number; message?: string; dorado?: string; dorado_version?: string; command?: string; model?: string;
    modified_bases?: string[] | null; modbase_models?: string[] | null; device?: string; batchsize?: number | null;
    resumed?: boolean; log?: string;
  } | null;
}

export interface ResultSummary {
  /** POD5 input: the reads dorado basecalled. */
  reads_basecalled?: number | null;
  reads_aligned: number | null;
  reads_called: number | null;
  duplicate_percent: number | null;
  footprints_per_read: number | null;
  qc_status: string | null;
  approximate?: boolean;
  error?: string;
}

export type JobStatus = 'queued' | 'running' | 'cancelling' | 'done' | 'error' | 'cancelled' | 'interrupted';

export interface PipelineJob {
  id: string;
  sample: string;
  enzyme: Enzyme;
  outdir: string;
  reference: { path: string; kind: string; label: string; genome_id?: string } | null;
  cores: number;
  reads: string[];
  regions: string[];
  options: Partial<PipelineOptions>;
  option_labels: string[];
  group: string | null;
  command: string | null;
  auto_open: boolean;
  /** The page that started it, when it asked to open the result (only that page opens it automatically). */
  opener?: string | null;
  /** When its result was first opened in a browser (server-side: holds for every profile, origin and restart). */
  opened_at?: number | null;
  opened_by?: 'auto' | 'user' | null;
  /** Who started it (lab servers, where every member sees every run). */
  user?: string | null;
  input_kind?: InputKind;
  basecall?: BasecallSettings | null;
  status: JobStatus;
  created?: number;
  started_at?: number;
  finished_at?: number;
  error?: string;
  hint?: string;
  warning?: string;
  attempt?: number;
  progress: JobProgress;
  outputs?: PipelineOutputs | null;
  summary?: ResultSummary | null;
}

export interface QcPayload {
  available: boolean;
  success?: boolean;
  error?: string;
  label?: string;
  qc: Record<string, any> | null;
  curves: QcCurves | null;
  plots: Record<string, string>;
}

export interface QcHistogram {
  bin_edges_bp: number[];
  sample_fraction_per_bin: number[];
  sample_count_per_bin?: number[];
  sample_n: number;
  sample_overflow?: number;
  reference_fraction_per_bin: number[] | null;
}

export interface QcCurves {
  schema?: string;
  verdicts?: Record<string, string | number | null>;
  signal_rate?: {
    label?: string;
    per_read_rates: number[];
    ecdf: number[];
    reference_ecdf: { rates: number[]; probabilities: number[]; source?: string } | null;
    warn_interval: number[] | null;
    reference_iqr: number[] | null;
  };
  phasogram?: {
    lags_bp: number[];
    detrended_pair_frequency: number[];
    nrl_bp: number | null;
    reference: { lags_bp: number[]; detrended_pair_frequency: number[] } | null;
  };
  footprint_sizes?: { nucleosome?: QcHistogram; tf?: QcHistogram };
  /** Per-read rates split by FiberHMM state (FiberHMM >= 3.0; absent in older curves files). */
  state_rates?: {
    source?: string | null;
    min_msp_bp?: number | null;
    msp_per_read_rates?: number[];
    outside_msp_per_read_rates?: number[];
    reference?: {
      msp?: { probabilities?: number[]; quantiles?: number[] | null } | null;
      outside_msp?: { probabilities?: number[]; quantiles?: number[] | null } | null;
    } | null;
  } | null;
  duplicates?:{ duplicate_fraction: number | null; molecule_cluster_size_histogram?: Record<string, number> | null };
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** ``refresh``: look for dorado again (after installing it). */
export function getPipelineStatus(refresh = false): Promise<PipelineStatus> {
  return fetchJson(refresh ? '/api/pipeline/status?refresh=1' : '/api/pipeline/status');
}

/** The wizard's download of a catalog genome's FASTA (cache only; the browser's open genome is untouched). */
export interface GenomeDownload {
  genome_id: string;
  name?: string;
  /** confirm: over the download warning size and not confirmed (nothing downloaded; start it with confirmLarge). */
  state: 'idle' | 'running' | 'done' | 'error' | 'cancelled' | 'confirm';
  url?: string | null;
  bytes?: number;
  total?: number;
  error?: string | null;
  errors?: { url: string; error: string }[];
  fasta?: string | null;
  /** While running: downloading, then decompressing / indexing (no byte progress there). */
  stage?: 'downloading' | 'decompressing' | 'indexing';
  /** A cancel was asked and the download has not stopped yet. */
  cancelling?: boolean;
  /** The download warning size, with state confirm (total is then the download's size). */
  threshold?: number;
  /** A large download that went ahead (confirmed, or of unknown size past the warning size). */
  warning?: string | null;
}

/** What a catalog genome's download will be, before it starts (bytes null: the server did not say). */
export interface GenomeDownloadSize {
  genome_id: string;
  url: string | null;
  bytes: number | null;
  threshold: number;
  over: boolean;
}

export function getGenomeDownloadSize(genomeId: string): Promise<GenomeDownloadSize> {
  return fetchJson(`/api/pipeline/genome_download/size?genome_id=${encodeURIComponent(genomeId)}`);
}

export function startGenomeDownload(genomeId: string, confirmLarge = false): Promise<GenomeDownload> {
  const confirm = confirmLarge ? '&confirm_large=true' : '';
  return fetchJson(`/api/pipeline/genome_download?genome_id=${encodeURIComponent(genomeId)}${confirm}`, { method: 'POST' });
}

export function getGenomeDownload(genomeId: string, options?: RequestInit): Promise<GenomeDownload> {
  return fetchJson(`/api/pipeline/genome_download?genome_id=${encodeURIComponent(genomeId)}`, options);
}

export function cancelGenomeDownload(genomeId: string): Promise<GenomeDownload> {
  return fetchJson(`/api/pipeline/genome_download/cancel?genome_id=${encodeURIComponent(genomeId)}`, { method: 'POST' });
}

export function scanReads(paths: string[], inputKind: InputKind = 'reads'): Promise<ScanResult> {
  return fetchJson('/api/pipeline/scan', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ paths, input_kind: inputKind }) });
}

export function validateRun(req: RunRequest): Promise<ValidateResult> {
  return fetchJson('/api/pipeline/validate', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(req) });
}

export function submitRun(req: RunRequest): Promise<{ success: boolean; jobs?: PipelineJob[]; errors?: RunIssue[]; warnings?: string[] }> {
  return fetchJson('/api/pipeline/jobs', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(req) });
}

export function listJobs(): Promise<{ jobs: PipelineJob[] }> {
  return fetchJson('/api/pipeline/jobs');
}

export function getJob(id: string): Promise<PipelineJob> {
  return fetchJson(`/api/pipeline/jobs/${encodeURIComponent(id)}`);
}

export async function getJobLog(id: string): Promise<string> {
  const res = await fetchApiResponse(`/api/pipeline/jobs/${encodeURIComponent(id)}/log`);
  return res.ok ? res.text() : `Could not read the log (${res.status}).`;
}

export interface OpenedClaim { claimed: boolean; opened_at: number | null; reason: string | null }

/** Record that a run's result was opened. ``auto``: the automatic opening claims it (granted once, and only to
 * the page that started the run); otherwise "Open in browser", which keeps it from opening automatically. */
export function markJobOpened(id: string, body: { auto?: boolean; opener?: string } = {}): Promise<OpenedClaim> {
  return fetchJson(`/api/pipeline/jobs/${encodeURIComponent(id)}/opened`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
}

export function cancelJob(id: string): Promise<PipelineJob> {
  return fetchJson(`/api/pipeline/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
}

export function retryJob(id: string): Promise<PipelineJob> {
  return fetchJson(`/api/pipeline/jobs/${encodeURIComponent(id)}/retry`, { method: 'POST' });
}

export function forgetJob(id: string): Promise<{ success: boolean }> {
  return fetchJson(`/api/pipeline/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function getJobQc(id: string): Promise<QcPayload> {
  return fetchJson(`/api/pipeline/jobs/${encodeURIComponent(id)}/qc`);
}

export function runDatasetQc(datasetId: string, enzyme: string = 'auto'): Promise<QcPayload> {
  return fetchJson('/api/qc/dataset', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ dataset_id: datasetId, enzyme }) });
}
