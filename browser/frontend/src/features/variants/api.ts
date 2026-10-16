import { usePanelGenomeStore } from '../../stores/panelGenomeStore';
/**
 * The Variants panel's endpoints (browser/routers/variants.py): SNPs in a view, reads grouped by SNP allele or
 * allele combination (or HP tag), SV clusters in a view and which SNP alleles travel with an SV.
 */
import { fetchJson } from '../../api/sharedFetch';

export type SnpMode = 'auto' | 'daf' | 'basecall';

export interface SnpParams {
  min_maf: number;
  min_depth: number;
  both_strands: boolean;
  min_bq: number;
  min_mapq: number;
  mode: SnpMode;
}

export const DEFAULT_SNP_PARAMS: SnpParams = { min_maf: 0.1, min_depth: 20, both_strands: true, min_bq: 20, min_mapq: 20, mode: 'auto' };

export interface ScanTarget {
  genome?: string | null;
  readIds?: string[];
  /** With readIds: the state key of the panel they are (not sent: the scan is that panel's, variantsState). */
  panelKey?: string;
  datasetId: string;
  chrom: string;
  start: number;
  end: number;
}

export interface StrandCounts { depth: number; minor: number; major: number }

export interface Snp {
  id: string;
  pos: number;
  kind: 'snv' | 'ins' | 'del';
  ref: string | null;
  alleles: [string, string];
  alt: string;
  length: number;
  depth: number;
  counts: Record<string, number>;
  minor: number;
  maf: number;
  strands: Record<string, StrandCounts>;
  strand_balance: number | null;
  both_strands: boolean;
  daf_safe: boolean | null;
  daf_reason: string;
  low_depth: boolean;
  passes: boolean;
}

export interface SnpScan {
  clientKey?: string;
  target?: ScanTarget;
  scan_key: string;
  dataset_id: string;
  region: { chrom: string; start: number; end: number };
  params: SnpParams & { max_indel: number; include_duplicates: boolean };
  mode: 'daf' | 'basecall';
  chemistry: string | null;
  reference: 'fasta' | 'none';
  n_reads: number;
  median_depth: number;
  fixed: number;
  snps: Snp[];
  directions: { CT: number; GA: number; none: number };
  hp: { tagged: number; values: Record<string, number>; untagged: number };
  daf_policy: string;
  elapsed_ms: number;
  cached: boolean;
}

export interface AlleleGroup {
  id: number;
  key: string;
  label: string;
  alleles: (string | null)[];
  count: number;
  complete?: number;
  kind: 'combo' | 'other' | 'not-informative';
  merged?: number;
}

export interface AlleleGrouping {
  groups: AlleleGroup[];
  assignments: Record<string, number>;
  n_reads: number;
  covering: number;
  placed?: number;
  partial?: boolean;
  threshold: number;
  distinct: number;
  snps: string[];
  /** H1 / H2 labels, or why not: `failed` names each two-haplotype criterion that failed, with its value. */
  phase: { diploid: boolean; message: string; failed?: string[] } | null;
  tags: { tag: string; members: string[] }[] | null;
  scan_key: string;
  dataset_id: string;
  region: { chrom: string; start: number; end: number };
  mode: string;
  /** A genotype grouping with SVs: their ids ("<t>:<ref>:<len>") and every column (SNPs, then SVs). */
  svs?: string[];
  columns?: { id: string; name: string; kind: 'snv' | 'sv' }[];
}

export type AlleleSource = 'selected' | 'informative' | 'hp';

export interface AlleleRequest {
  source: AlleleSource;
  snps?: string[];
  partial: boolean;
  minFraction: number;
  autoPhase: boolean;
  /** Several SNPs, or one as a combination (one SNP otherwise splits ref / alt). */
  asCombination?: boolean;
  /** SVs (1-4) whose genotype (carrier + / reference − / not informative) joins the combination, named in its labels. */
  svs?: { t: 'D' | 'I'; ref: number; len: number; name?: string }[];
}

export interface SvClusterInView {
  id: string;
  t: 'D' | 'I';
  ref: number;
  len: number;
  end: number;
  support: number;
  informative: number;
  sa_support?: number;
  clip_support?: number;
}

export interface SvLinkageRow {
  id: string;
  pos: number;
  alleles: [string, string];
  carriers: { n: number; minor: number; fraction: number };
  reference: { n: number; minor: number; fraction: number };
  diff: number;
  linked: boolean;
}

export interface SvLinkage {
  sv: { t: 'D' | 'I'; ref: number; len: number };
  counts: { carriers: number; reference: number; not_informative: number };
  tested: number;
  linked: number;
  snps: SvLinkageRow[];
}

function body(target: ScanTarget, params: SnpParams, includeDuplicates: boolean, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    dataset_id: target.datasetId, chrom: target.chrom, start: Math.floor(target.start), end: Math.ceil(target.end),
    ...(target.readIds ? { read_ids: target.readIds } : {}),
    ...params, include_duplicates: includeDuplicates, ...extra,
  });
}

const scopedUrl = (url: string, target: ScanTarget) => {
  const genome = target.genome !== undefined ? target.genome : usePanelGenomeStore.getState().assignments[target.datasetId];
  return genome ? `${url}?panel_genome=${encodeURIComponent(genome)}` : url;
};

const post = { method: 'POST', headers: { 'Content-Type': 'application/json' } } as const;

export function scanSnps(target: ScanTarget, params: SnpParams, includeDuplicates: boolean, signal?: AbortSignal): Promise<SnpScan> {
  return fetchJson<SnpScan>(scopedUrl('/api/variants/snps', target), { ...post, body: body(target, params, includeDuplicates), signal });
}

export function groupByAlleles(target: ScanTarget, params: SnpParams, includeDuplicates: boolean, request: AlleleRequest,
  signal?: AbortSignal): Promise<AlleleGrouping> {
  return fetchJson<AlleleGrouping>(scopedUrl('/api/variants/alleles', target), {
    ...post,
    body: body(target, params, includeDuplicates, {
      source: request.source === 'hp' ? 'hp' : 'snps',
      snps: request.source === 'informative' ? 'informative' : request.snps ?? [],
      partial: request.partial, min_fraction: request.minFraction, auto_phase: request.autoPhase,
      as_combination: Boolean(request.asCombination),
      ...(request.svs?.length ? { svs: request.svs, ...(request.source === 'informative' ? { snps: [] } : {}) } : {}),
    }),
    signal,
  });
}

export function svsInView(target: ScanTarget, minLen: number, includeDuplicates: boolean, signal?: AbortSignal):
  Promise<{ clusters: SvClusterInView[]; n_reads: number; min_len: number }> {
  return fetchJson(scopedUrl('/api/variants/svs', target), {
    ...post,
    body: JSON.stringify({ dataset_id: target.datasetId, chrom: target.chrom, start: Math.floor(target.start), end: Math.ceil(target.end),
      ...(target.readIds ? { read_ids: target.readIds } : {}), min_len: minLen, include_duplicates: includeDuplicates }),
    signal,
  });
}

export function svLinkage(target: ScanTarget, params: SnpParams, includeDuplicates: boolean,
  sv: Pick<SvClusterInView, 't' | 'ref' | 'len'>, signal?: AbortSignal): Promise<SvLinkage> {
  return fetchJson<SvLinkage>(scopedUrl('/api/variants/sv_linkage', target), {
    ...post, body: body(target, params, includeDuplicates, { t: sv.t, ref: sv.ref, len: sv.len }), signal,
  });
}
