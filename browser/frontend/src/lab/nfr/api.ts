import type { NfrMoleculeSampling } from './readDepth';
import type { LoaderSampling } from '../../utils/readDepth';
/**
 * Accessibility (preview): FiberHMM NFR variants and element co-accessibility (EXPERIMENTAL).
 * Backend: browser/routers/accessibility.py -> services/accessibility_workflow.py -> fiberhmm.inference.accessibility.
 */
import { fetchJson } from '../../api/sharedFetch';
import { withSandboxParam } from '../../utils/sandbox';

export interface NfrChannelPrevalence { n: number; em: number | null; strict: number | null }

export interface NfrVariant {
  id: string; nfr: string; name: string;
  start: number; end: number; L: number; R: number; Lsd: number; Rsd: number; width: number;
  depth: string; relation: string;
  prevalence: number; strict: number; ci: [number, number] | null;
  only: number; with_ref: number; gain_nats: number; stability: number; exp_reads: number;
  robust: number | null; by_channel: Record<string, NfrChannelPrevalence>;
}

export interface NfrConfiguration { label: string; display_label: string; weight: number; internal_footprint: string[] | null }

export interface NfrDepthState { id: string; name: string; depth: string; threshold: number; prevalence: number; n: number }

/** How a detected NFR region was found (FiberHMM with depth-aware detection; absent on older results). */
export interface NfrRegionDetection {
  /** Peak share of callable reads inside a >= 175-bp gap, where, and the reads open / callable there. */
  peak: number; peak_at?: number; open_reads?: number; peak_callable?: number;
  /** The view's background share, the fold over it and the BH q at the peak (null when unavailable). */
  background: number | null; fold: number | null; q: number | null;
}

/** The run's NFR detection: the rule, the view's background, and why the enrichment test was off (note). */
export interface AccessibilityDetection {
  molecule_sampling?: NfrMoleculeSampling[];
  loader_sampling?: LoaderSampling[];
  method: 'raw' | 'enrichment' | 'fixed' | 'given'; note: string;
  background?: number | null; background_raw?: number | null; enrichment_test?: boolean; threshold?: number;
  enrichment_gates?: boolean;
  opportunity_diagnostic?: {
    available: boolean; note?: string;
    background: { median_opportunities_per_100bp: number | null };
    nfr: { median_opportunities_per_100bp: number | null };
  };
  min_fraction?: number; min_fold?: number; q?: number; min_open_reads?: number;
}

export interface NfrRegionResult {
  id: string; start: number; end: number; source: 'given' | 'detected'; profile_peak: number | null;
  detection?: NfrRegionDetection | null;
  reads: number; callable: number; censored: number; overflow_reads: number; mode: 'variants' | 'depth';
  status: 'ok' | 'not_analysable' | 'no_variants'; message: string;
  k?: number; ps_curve?: [number, number][]; gaps?: number;
  merges?: [string, string, number][]; dropped?: { id: string; L: number; R: number; gain: number; stability: number; exp_reads: number; reasons?: string[] }[];
  closed?: number; other?: { em: number | null; strict: number | null; ci: [number, number] | null };
  variants: NfrVariant[]; configurations: NfrConfiguration[]; depth_states: NfrDepthState[];
}

export interface AccessibilityElement {
  id: string; kind: 'nfr' | 'tf'; subtype: 'variant' | 'nfr' | 'depth' | 'class';
  nfr?: string; class_id?: string; start: number; end: number; label: string; prevalence: number | null; n: number;
  channels?: string[];
}

export interface AccessibilityPair {
  a: string; b: string; kind_a: string; kind_b: string; n: number; shared: number; table: [number, number, number, number];
  log2or: number | null; lo: number | null; hi: number | null; fisher_p: number | null;
  mh: number | null; mh_lo: number | null; mh_hi: number | null; p_exact: number; q: number;
  class: 'co-accessible' | 'anti' | 'independence-compatible' | 'unresolved';
  adjust: string; null_median: number | null; exp11: number | null; nested: '' | 'inside' | 'edge'; dist: number;
  cluster?: number | null; cluster_n?: number;
}

export interface AccessibilityCombos {
  elements: string[]; labels: string[]; n: number; n_spanning: number; n_shared_excluded: number; status: string;
  patterns: { pattern: string; obs: number; exp_indep: number; null_med: number; null_lo: number; null_hi: number; q: number; significant: boolean; pinned: boolean }[];
}

export interface AccessibilityResult {
  schema: string; experimental: boolean; note: string;
  region: { chrom: string; start: number; end: number };
  datasets: { dataset_id: string; chemistry: string | null; molecules: number }[];
  parameters: Record<string, unknown>;
  detection?: AccessibilityDetection;
  nfrs: NfrRegionResult[];
  elements: AccessibilityElement[];
  pairs: AccessibilityPair[];
  family: { tested: number; scope: string; skipped: { a: string; b: string; reason: string }[]; bh: string };
  combos: AccessibilityCombos | null;
  class_join: { classes: number; class_molecules: number; joined_molecules: number; molecules: number } | null;
  within_clusters: { mode: string; k: number; molecules: number | null } | null;
  warnings: string[];
}

export interface AccessibilityJob {
  job_id: string; status: 'queued' | 'running' | 'cancelling' | 'complete' | 'cancelled' | 'error';
  stage?: string; message?: string; created_at?: number; started_at?: number; finished_at?: number;
  progress?: { stage: string; completed: number | null; total: number | null; fraction: number | null; unit?: string | null };
  request?: { dataset_ids: string[]; chrom: string; start: number; end: number; parameters?: Record<string, unknown>; region_source?: string; region_label?: string };
  payload_source?: string; class_job_id?: string; restored?: boolean;
  result?: AccessibilityResult;
}

export interface AccessibilityGroups {
  job_id: string; nfr: string;
  variants: { name: string; start: number; end: number }[];
  groups: { id: number; label: string; display_label: string; count: number; pattern: number[] }[];
  by_dataset: Record<string, Record<string, number>>;
}

export interface AccessibilityRequest {
  dataset_ids: string[];
  chrom: string; start: number; end: number;
  region_source?: string; region_label?: string;
  parameters: Record<string, unknown>;
  loader_parameters?: Record<string, unknown>;
  /** A run's datatypes per dataset, when replaying its request. */
  chemistry_overrides?: Record<string, string>;
}

const base = '/api/accessibility';
/** The engine's parameters and defaults (FiberHMM NFROptions): what this FiberHMM can be asked for. */
export interface AccessibilitySchema { schema: string; defaults: Record<string, unknown>; panel_parameters: string[] }
const post = (value: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });

export const startAccessibility = (request: AccessibilityRequest) => fetchJson<AccessibilityJob>(`${base}/jobs`, post(request));
export const getAccessibilityJob = (id: string) => fetchJson<AccessibilityJob>(`${base}/jobs/${encodeURIComponent(id)}`);
export const getAccessibilitySchema = () => fetchJson<AccessibilitySchema>(`${base}/schema`);
export const getAccessibilityJobs = () => fetchJson<{ jobs: AccessibilityJob[] }>(`${base}/jobs`);
export const cancelAccessibility = (id: string) => fetchJson<AccessibilityJob>(`${base}/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const getAccessibilityGroups = (id: string, nfr: string) =>
  fetchJson<AccessibilityGroups>(`${base}/jobs/${encodeURIComponent(id)}/groups?${new URLSearchParams({ nfr })}`);
export const getAccessibilityReads = (id: string, element: string, minimum = 0.5) =>
  fetchJson<{ by_dataset: Record<string, string[]> }>(`${base}/jobs/${encodeURIComponent(id)}/reads?${new URLSearchParams({ element, minimum: String(minimum) })}`);
export const accessibilityExportUrl = (id: string, name: string) =>
  withSandboxParam(`${base}/jobs/${encodeURIComponent(id)}/export/${encodeURIComponent(name)}`);
export const ACCESSIBILITY_EXPORTS: { name: string; label: string }[] = [
  { name: 'variants.tsv', label: 'Variants' },
  { name: 'configurations.tsv', label: 'Configurations' },
  { name: 'coaccess.tsv', label: 'NFR pairs' },
  { name: 'combos.tsv', label: 'Combination patterns' },
  { name: 'molecules.tsv.gz', label: 'Per-read membership (gzip)' },
  { name: 'manifest.json', label: 'Manifest (parameters, inputs, version)' },
];

// ------------------------------------------------------------------ analysis views (round 2)
export interface NfrProfiles {
  nfr: string; x: number[]; step: number;
  all: { profile: number[]; n: number };
  variants: Record<string, { profile: number[]; n: number }>;
}

export interface SplitProfile { x: number[]; accessibility: (number | null)[]; n: number[]; reads: number }

export interface SplitGroup {
  id: number; key: string; label: string; molecules: number; count: number; pattern: number[] | null;
  expected?: { independence: number; null_median: number; null_lo: number; null_hi: number; q: number };
}

export interface SplitStratum { channel: string; quintile: number; n: number; openness: [number, number]; table: [number, number, number, number]; log2or: number }

export interface AccessibilitySplit {
  job_id: string; kind: 'pair' | 'combination';
  a?: string; b?: string; elements?: string[]; short: string[];
  groups: SplitGroup[];
  by_dataset: Record<string, Record<string, number>>;
  ambiguous_reads: Record<string, number>;
  table?: [number, number, number, number];
  pair?: AccessibilityPair | null; tested?: boolean; skipped?: string | null;
  excluded: Record<string, number>; excluded_text: Record<string, string>;
  strata?: SplitStratum[];
  spacing?: { kind: string; reads: number; median?: number; q1?: number; q3?: number; inside?: number; edge?: number; note: string } | null;
  profiles?: Record<string, SplitProfile>;
  window?: [number, number];
  n?: number;
}

export interface Quantiles { n: number; p5: number; q1: number; median: number; q3: number; p95: number; mean: number }

export interface VariantShape {
  variant: string; nfr: string; name: string;
  sizes: { step: number; lo: number; hi: number; variants: Record<string, { summary: Quantiles | null; hist: number[] }> };
  edges: {
    points: [number, number, string][]; total: number; shown: number;
    density: { step: number; left: [number, number]; right: [number, number]; counts: number[][] } | null;
    centres: Record<string, [number, number]>;
  };
  boundary: Record<string, {
    minus1: Quantiles | null; plus1: Quantiles | null; minus1_size: Quantiles | null; plus1_size: Quantiles | null;
    minus1_dyads: number[]; plus1_dyads: number[];
  }> | null;
  boundary_note: string | null;
}

export interface VariantVPlots {
  variant: string; nfr: string; window: [number, number]; step: number; size: [number, number]; size_step: number;
  counts: { all: number; own: number }; span: [number, number];
  all: { centre: number[][]; coverage: number[][] };
  own: { centre: number[][]; coverage: number[][] };
}

export interface PhasingSeries { x: number[]; occupancy: (number | null)[]; n: number[]; reads: number }
export interface VariantPhasing {
  variant: string; nfr: string; window: [number, number]; span: [number, number];
  members: PhasingSeries; others: PhasingSeries;
  boundary: NonNullable<VariantShape['boundary']>[string] | null;
}

export interface PrevalenceRow { group: string; callable: number; prevalence: number | null; strict: number | null; ci: [number, number] | null; reads: number | null }
export interface VariantPrevalence { variant: string; nfr: string; groups: PrevalenceRow[]; datasets: PrevalenceRow[]; note: string }

/** Per-NFR views: every variant of the NFR in one figure. */
export interface NfrShape extends Omit<VariantShape, 'variant' | 'name'> { variants: string[] }
export interface NfrVPlots {
  nfr: string; window: [number, number]; step: number; size: [number, number]; size_step: number;
  all: { centre: number[][]; coverage: number[][] }; count_all: number; names: string[];
  variants: Record<string, { centre: number[][]; coverage: number[][]; count: number; span: [number, number] }>;
}
export interface NfrPhasing {
  nfr: string; window: [number, number]; names: string[]; all: PhasingSeries;
  variants: Record<string, { members: PhasingSeries; span: [number, number]; boundary: VariantPhasing['boundary'] }>;
}
export interface NfrPrevalenceRow {
  group: string; callable: number; reads: number | null;
  variants: Record<string, { prevalence: number | null; strict: number | null; ci: [number, number] | null }>;
}
export interface UsageTest {
  groups: string[]; reads: Record<string, number>; configurations: string[]; g: number | null; df: number; p: number | null;
  variants: Record<string, { share: Record<string, number>; g?: number; df?: number; p: number | null; q: number | null }>; definition: string;
}
export interface NfrPrevalence { nfr: string; names: string[]; groups: NfrPrevalenceRow[]; datasets: NfrPrevalenceRow[]; note: string;
  tests?: { groups: UsageTest | null; datasets: UsageTest | null } }

/** The hierarchy of evidence at a site for one variant: open (NFR shape) > footprinted given open (Find classes). */
export interface SiteLayer {
  reads: number; open: number; labelled: number; unlabelled_open: number | null; footprinted: number;
  excluded_members: { nucleosome: number; linker: number } | null;
  p_open: number | null; ci_open: [number, number] | null;
  p_fp_given_open: number | null; ci_fp_given_open: [number, number] | null;
  p_footprinted: number | null;
  stack?: { closed: number; open_unfootprinted: number | null; open_footprinted: number | null; open?: number };
  state?: string;
}
export interface SiteClass { id: string; label: string; start: number; end: number; prevalence: number | null }
export interface MotifSite {
  start: number; end: number; strand: string; score: number; p: number; rel: number; motif: string;
  /** Share of each variant's member reads open at the site centre. */
  open: Record<string, number | null>;
  /** Variants whose span holds the site centre. */
  in: string[];
  layers?: Record<string, SiteLayer>;
  classes?: SiteClass[];
  p_open_diff?: number | null; q_open_diff?: number | null; p_fp_diff?: number | null; q_fp_diff?: number | null;
  /** Per variant: the share of its member reads whose own opening covers the site core (the default view), and the
   * share of the covering openings it contributes. */
  coverage?: Record<string, SiteCoverage>;
  p_cover_diff?: number | null; q_cover_diff?: number | null; cover_delta?: number | null;
  /** Size of the opening over the site core, by the variant its configuration assigns it ('other': none). */
  sizes?: Record<string, { n: number; q1: number; median: number; q3: number }>;
  p_size_diff?: number | null; q_size_diff?: number | null;
}
export interface SiteCoverage { n: number; covered: number; p: number | null; ci: [number, number] | null; share: number | null }
export interface MotifOccupancy {
  available: boolean; note?: string; classes?: number; class_job?: string | null; joined?: 'run' | 'posthoc' | null;
  core_bp?: number; min_reads?: number; min_gap_bp?: number; sites?: number; sites_with_class?: number;
  excluded_members?: { nucleosome: number; linker: number }; open_reads_at_class_sites?: number;
  unlabelled_open?: number; unlabelled_share?: number | null; sentences?: string[]; definitions?: Record<string, string>;
  /** Why there is no footprint layer (no Find classes run in the session, or what differs from this run). */
  class_reason?: string | null;
}
export interface MotifEnrichment {
  sites: number; bp: number; expected: number; log2_vs_local: number | null;
  p_local: number | null; q_local: number | null; p_model: number | null; q_model: number | null;
}
export interface MotifDifferential {
  only: number; only_bp: number; siblings: number; siblings_bp: number; p: number | null; q: number | null;
  log2_vs_siblings: number | null; open_delta: number | null; open_site: number | null;
}
export interface MotifMember { id: string; name: string; common: string | null; length: number; min_p: number; reachable: boolean; source?: string; tax_group?: string | null }
/** One motif family (versions of a matrix, or similar matrices hitting the same bases here). */
export interface MotifFamily {
  id: string; name: string; common: string | null; pinned: string[]; members: MotifMember[];
  /** Sites in the window (the map) and in the whole scanned region. */
  total: number; region_sites: number;
  background: { sites: number; bp: number; expected: number };
  enrichment: Record<string, MotifEnrichment>;
  differential: Record<string, MotifDifferential>;
  sites: MotifSite[]; reachable: boolean;
  best_q: number; best_q_model: number; best_q_diff: number;
  best_q_open?: number | null; best_q_fp?: number | null; best_q_cover?: number | null; best_q_size?: number | null; footprint_classes?: string[];
}
export interface NfrMotifs {
  nfr: string; window: [number, number]; region: [number, number]; variants: string[];
  spans: Record<string, [number, number]>; members: Record<string, number>;
  species: { genome: string; taxid: number; inferred: boolean; name: string | null } | null;
  pinned: { requested: string[]; resolved: Record<string, string[]>; /** The JASPAR names each pinned name resolved to (Su(Hw) -> su(Hw), GAF -> Trl). */ names?: Record<string, string[]>; missing: string[]; substituted: Record<string, string>; defaults: string[]; /** Former defaults JASPAR CORE lacks (Ibf1): reported quietly. */ retired?: string[]; species: string | null };
  threshold: { mode: 'p' | 'relative'; p: number | null; relative: number | null; background: 'local' | 'genome' | 'uniform'; composition: Record<string, number> };
  scanned: number; unreachable: { id: string; name: string; length: number; min_p: number }[]; tested: number;
  background: { bp: number; intervals: number }; families: MotifFamily[]; with_sites: number;
  sentences: string[]; warnings: string[]; seconds: number; definitions: Record<string, string>;
  occupancy?: MotifOccupancy;
  /** Present on the variant route. */
  focus?: string; variant?: string;
}
export interface MotifOptions {
  motifs?: string[]; pinned?: string[]; mode?: 'p' | 'relative'; p?: number; relative?: number;
  background?: 'local' | 'genome' | 'uniform'; strand?: 'both' | '+' | '-'; family_similarity?: number;
  flank?: number; bg_flank?: number; core_bp?: number; min_reads?: number;
  custom?: { name: string; counts: Record<string, number[]> }[];
}

export interface SequenceFeatures { bp: number; gc: number | null; cpg: number; cpg_oe: number | null; tracts: { start: number; end: number; base: string; length: number }[]; tract_bp: number }
export interface VariantSequence {
  variant: string | null; nfr?: string; window: [number, number];
  /** The reference bases of ``window`` on ``chrom`` (the run datasets' own reference; blanks past a contig end). */
  chrom?: string; sequence?: string;
  variants: Record<string, SequenceFeatures & { span: [number, number] }>;
  flanks: { left: SequenceFeatures; right: SequenceFeatures };
  gc_track: { x: number[]; gc: (number | null)[]; window: number };
  tracts: SequenceFeatures['tracts'];
  definitions: Record<string, string>;
}

export interface TransferJob {
  transfer_id: string; job_id: string; nfr: string; dataset_ids: string[];
  status: 'queued' | 'running' | 'complete' | 'error' | 'cancelled'; message: string;
  result?: { nfr: string; region: [number, number]; datasets: Record<string, { reads: number; callable: number; closed: number | null; variants: Record<string, { prevalence: number | null; strict: number | null; ci: [number, number] | null }> }> };
}

const enc = encodeURIComponent;
const variantBase = (id: string, variant: string) => `${base}/jobs/${enc(id)}/variants/${enc(variant)}`;

export const getNfrOverview = (id: string, nfr: string) =>
  fetchJson<NfrProfiles>(`${base}/jobs/${enc(id)}/overview?${new URLSearchParams({ nfr })}`);
export const splitAccessibilityReads = (id: string, body: { a: string; b: string } | { elements: string[] }) =>
  fetchJson<AccessibilitySplit>(`${base}/jobs/${enc(id)}/split`, post(body));
export const getVariantShape = (id: string, variant: string) => fetchJson<VariantShape>(`${variantBase(id, variant)}/shape`);
export const getVariantVPlots = (id: string, variant: string) => fetchJson<VariantVPlots>(`${variantBase(id, variant)}/vplots`);
export const getVariantPhasing = (id: string, variant: string) => fetchJson<VariantPhasing>(`${variantBase(id, variant)}/phasing`);
/** Prevalence per read group (bootstrap: replicates; default the run's own count). */
export const getVariantPrevalence = (id: string, variant: string, groups: Record<string, Record<string, string[]>>, bootstrap?: number) =>
  fetchJson<VariantPrevalence>(`${variantBase(id, variant)}/prevalence`, post(bootstrap == null ? { groups } : { groups, bootstrap }));
export const getVariantMotifs = (id: string, variant: string, options: MotifOptions) =>
  fetchJson<NfrMotifs>(`${variantBase(id, variant)}/motifs`, post(options));
export const cancelVariantTransfer = (transferId: string) => fetchJson<TransferJob>(`${base}/transfers/${enc(transferId)}`, { method: 'DELETE' });
/** Run Find classes on the run's window (or get the compatible run that exists): the motif sites' footprint layer. */
export const startNfrClassRun = (id: string) =>
  fetchJson<{ job_id: string | null; status: string; existing: boolean; message?: string | null; joined?: string }>(`${base}/jobs/${enc(id)}/classes`, post({}));
/** The footprint classes the run can use: joined by the run itself ('run'), joined after it from a compatible Find
 * classes run ('posthoc': the pair tests include them only after Find NFR variants runs again), or none. */
export interface ClassStatus { class_job: string | null; joined: 'run' | 'posthoc' | null; classes: number; reason?: string | null }
export const getClassStatus = (id: string) => fetchJson<ClassStatus>(`${base}/jobs/${enc(id)}/class-status`);
/** Custom motifs from pasted text: IUPAC, a bare PFM, or JASPAR / MEME / HOMER. */
export const parseMotifs = (text: string, name?: string) =>
  fetchJson<{ motifs: { name: string; counts: Record<'A' | 'C' | 'G' | 'T', number[]> }[] }>('/api/motifs/parse', post({ text, ...(name ? { name } : {}) }));
export interface PooledStat { strata: number; ratio?: number | null; odds_ratio?: number | null; log2: number | null; p: number | null; q: number | null; events?: number; expected?: number; direction?: number }
export interface PooledCell { family: string; type: string; nfrs: number; sites: PooledStat; open: PooledStat; footprinted: PooledStat }
export interface PooledMotifs {
  families: { id: string; name: string; members: string[]; sites: number }[];
  types: string[]; type_help: Record<string, string>; cells: PooledCell[]; nfrs: number; runs: number; job_ids: string[];
  definitions: Record<string, string>;
}
/** Motif families x variant types pooled over every NFR of the given runs. */
export const getPooledMotifs = (jobIds: string[], options: MotifOptions) =>
  fetchJson<PooledMotifs>(`${base}/pooled`, post({ ...options, job_ids: jobIds }));
export interface KmerRow { kmer: string; siblings: PooledStat; background: PooledStat; match: { name: string; id: string; share: number } | null }
/** De novo k-mers enriched in variant-specific openings, pooled over the runs, with their best JASPAR match. */
export const getKmerEnrichment = (jobIds: string[], k = 6) =>
  fetchJson<{ k: number; types: Record<string, { kmers: KmerRow[]; strata: { siblings: number; background: number } }>; tested: number; nfrs: number; runs: number; definition: string }>(
    `${base}/kmers`, post({ job_ids: jobIds, k }));
/** Find variants in many regions with a run's datasets and settings (one queued run per region). */
export const startAccessibilityBatch = (jobId: string, regions: { chrom: string; start: number; end: number; label?: string }[]) =>
  fetchJson<{ jobs: { region: unknown; job_id: string | null; status: string; message?: string }[] }>(`${base}/jobs/${enc(jobId)}/batch`, post({ regions }));
export interface ChipAtlasTask {
  id: string; job_id: string; status: 'running' | 'complete' | 'error'; done: number; total: number; message: string; genome: string;
  factors: string[];
  selection?: { cell_type_classes: string[]; cell_types: string[] };
  factors_out?: { factor: string; available: number; with_peak: number; failed?: string[];
    experiments: { id: string; cell_type_class: string; cell_type: string; peaks: [number, number, string][] }[];
    overlap: Record<string, Record<string, number | null>> }[];
  bound?: { factor: string; best_share: number; nfrs: string[] }[];
  region?: { chrom: string; start: number; end: number };
}
export const getChipAtlasMetadata = () =>
  fetchJson<{ present: boolean; bytes: number | null; progress: { status: string; message: string; loading: boolean } }>(`${base}/chipatlas_metadata`);
export const downloadChipAtlasMetadata = () => fetchJson<{ started: boolean }>(`${base}/chipatlas_metadata`, post({}));
/** The experiments a ChIP-Atlas fetch takes: of these cell type classes and cell types (each empty: any). */
export interface ChipAtlasSelection { cellTypeClasses: string[]; cellTypes: string[] }
export const startChipAtlas = (id: string, factors: string[], maxPerFactor?: number, selection?: ChipAtlasSelection) =>
  fetchJson<ChipAtlasTask>(`${base}/jobs/${enc(id)}/chipatlas`, post({ factors, ...(maxPerFactor ? { max_per_factor: maxPerFactor } : {}),
    ...(selection ? { cell_type_classes: selection.cellTypeClasses, cell_types: selection.cellTypes } : {}) }));
export interface ChipAtlasExperiments {
  present: boolean; genome: string; total: number; matching: number;
  cell_type_classes: { key: string; count: number }[];
  cell_types: { key: string; cell_type_class: string; count: number }[];
  factors: Record<string, number>;
}
/** The ChIP-Atlas experiment selector for the run's assembly: cell type classes and cell types over the factors, and how
 * many experiments the selection matches. */
export const getChipAtlasExperiments = (id: string, factors: string[], selection: ChipAtlasSelection) =>
  fetchJson<ChipAtlasExperiments>(`${base}/jobs/${enc(id)}/chipatlas_experiments?${new URLSearchParams({
    factors: factors.join(','), cell_type_classes: JSON.stringify(selection.cellTypeClasses), cell_types: JSON.stringify(selection.cellTypes) })}`);
export const getChipAtlas = (taskId: string) => fetchJson<ChipAtlasTask>(`${base}/chipatlas/${enc(taskId)}`);
export interface NfrClass { id: string; class_id: string; label: string; start: number; end: number; prevalence: number | null; layers: Record<string, SiteLayer>; inside: string[] }
/** Footprint classes inside an NFR, with open and member-given-open per variant. */
export const getNfrClasses = (id: string, nfr: string) =>
  fetchJson<{ nfr: string; class_job: string | null; joined: string | null; classes: NfrClass[]; reason?: string | null }>(`${base}/jobs/${enc(id)}/nfrs/${enc(nfr)}/classes`);
export interface CoOccPair { variant: string; a: string; b: string; a_id: string; b_id: string; distance: number; reads: number;
  table: [number, number, number, number]; both: number; expected_both: number | null; odds_ratio: number | null; log2: number | null; p: number | null; q: number | null; strata: number }
/** Pairs of footprint classes footprinted together on molecules, within each variant. */
export const getNfrCooccupancy = (id: string, nfr: string) =>
  fetchJson<{ nfr: string; class_job: string | null; pairs: CoOccPair[]; definition: string }>(`${base}/jobs/${enc(id)}/nfrs/${enc(nfr)}/cooccupancy`);
/** Per-base phyloP over the NFR's window (the assembly's UCSC track, read remotely on request). */
export const getNfrConservation = (id: string, nfr: string, flank = 300) =>
  fetchJson<{ nfr: string; genome: string; track: string; url: string; window: [number, number]; values: (number | null)[] }>(
    `${base}/jobs/${enc(id)}/nfrs/${enc(nfr)}/conservation?${new URLSearchParams({ flank: String(flank) })}`);
/** The motif analysis of one NFR, its variants side by side. */
export const getNfrMotifs = (id: string, nfr: string, options: MotifOptions) =>
  fetchJson<NfrMotifs>(`${base}/jobs/${enc(id)}/nfrs/${enc(nfr)}/motifs`, post(options));
const nfrBase = (id: string, nfr: string) => `${base}/jobs/${enc(id)}/nfrs/${enc(nfr)}`;
export const getNfrShape = (id: string, nfr: string) => fetchJson<NfrShape>(`${nfrBase(id, nfr)}/shape`);
export const getNfrVPlots = (id: string, nfr: string, bins?: { step?: number; size_step?: number; pad?: number }) =>
  fetchJson<NfrVPlots>(`${nfrBase(id, nfr)}/vplots${bins && Object.keys(bins).length ? `?${new URLSearchParams(Object.entries(bins).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]))}` : ''}`);
export const getNfrPhasing = (id: string, nfr: string) => fetchJson<NfrPhasing>(`${nfrBase(id, nfr)}/phasing`);
export const getNfrSequence = (id: string, nfr: string, flank = 300) =>
  fetchJson<VariantSequence>(`${nfrBase(id, nfr)}/sequence?${new URLSearchParams({ flank: String(flank) })}`);
/** Prevalence of every variant of the NFR per read group (bootstrap: replicates; default the run's own count). */
export const getNfrPrevalence = (id: string, nfr: string, groups: Record<string, Record<string, string[]>>, bootstrap?: number) =>
  fetchJson<NfrPrevalence>(`${nfrBase(id, nfr)}/prevalence`, post(bootstrap == null ? { groups } : { groups, bootstrap }));
export const nfrMembersUrl = (id: string, nfr: string) => withSandboxParam(`${nfrBase(id, nfr)}/members.tsv`);
export const getVariantSequence = (id: string, variant: string, flank = 300) =>
  fetchJson<VariantSequence>(`${variantBase(id, variant)}/sequence?${new URLSearchParams({ flank: String(flank) })}`);
export const variantMembersUrl = (id: string, variant: string) => withSandboxParam(`${variantBase(id, variant)}/members.tsv`);
export const startVariantTransfer = (id: string, nfr: string, datasetIds: string[], chemistry?: Record<string, string>) =>
  fetchJson<TransferJob>(`${base}/jobs/${enc(id)}/transfer`, post({ nfr, dataset_ids: datasetIds, chemistry_overrides: chemistry }));
export const getVariantTransfer = (transferId: string) => fetchJson<TransferJob>(`${base}/transfers/${enc(transferId)}`);
