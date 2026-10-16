import type { DafcPrimerQuad, PrimerPair } from '../types';
import { fetchJson } from './sharedFetch';
import { pickWithFallback } from './files';

const API_BASE = '/api';

export interface BlastToolInfo { ok: boolean; path: string | null; version: string | null; source: string | null; hint: string }
export interface BlastToolSummary { ok: boolean; label: string; hint: string; blastn: BlastToolInfo; makeblastdb: BlastToolInfo }

export interface PrimerConfigResponse {
  success?: boolean;
  message?: string;
  fasta?: string | null;
  blast_db?: string | null;
  configured?: boolean;
  current_genome?: string | null;
  blast_db_warning?: string | null;
  /** Which BLAST+ the server runs (services/external_tools.py): label, version, path, install hint. */
  blast_tool?: BlastToolSummary;
  created?: boolean;
  missing_dependency?: boolean;
  dependency?: string;
  output_dir?: string;
  command?: string[];
}

export async function getPrimerConfig(): Promise<PrimerConfigResponse> {
  return fetchJson(`${API_BASE}/primer_config`);
}

export async function setPrimerConfig(fastaPath?: string, blastDbPath?: string): Promise<PrimerConfigResponse> {
  const params = new URLSearchParams();
  if (fastaPath) params.set('fasta_path', fastaPath);
  if (blastDbPath) params.set('blast_db_path', blastDbPath);
  return fetchJson(`${API_BASE}/primer_config?${params}`, { method: 'POST' });
}

export async function buildPrimerBlastDb(force = false): Promise<PrimerConfigResponse> {
  const params = new URLSearchParams();
  if (force) params.set('force', 'true');
  const query = params.toString();
  return fetchJson(`${API_BASE}/primer_blast_db/build${query ? `?${query}` : ''}`, { method: 'POST' });
}

export async function pickFilePrimer(
  fileType: 'fasta' | 'blast',
): Promise<{ success: boolean; path: string | null; message?: string; databases?: string[] }> {
  const native = () => fetchJson<{ success: boolean; path: string | null; message?: string; databases?: string[]; cancelled?: boolean }>(
    `${API_BASE}/pick_file_primer?file_type=${fileType}`);
  if (fileType === 'fasta') return pickWithFallback(native, { title: 'Choose the reference FASTA' });
  // A folder chosen in the page still needs the server to find the databases in it.
  return pickWithFallback(native, { title: 'Choose the folder with BLAST database files', folder: true },
    ([dir]) => fetchJson(`${API_BASE}/pick_file_primer?file_type=blast&dir=${encodeURIComponent(dir)}`));
}

export interface PrimerProgressResponse {
  active: boolean;
  stage: string;
  progress: number;
  message: string;
  details?: Record<string, unknown>;
}

export async function getPrimerProgress(options?: RequestInit): Promise<PrimerProgressResponse> {
  return fetchJson(`${API_BASE}/primer_progress`, options);
}

export async function abortPrimerDesign(): Promise<{ success: boolean; message?: string }> {
  return fetchJson(`${API_BASE}/primer_abort`, { method: 'POST' });
}

export type PrimerTmMethod = 'snapgene' | 'primer3' | 'owczarzy' | 'breslauer' | 'wallace';

export interface PrimerDesignOptions {
  min_product?: number;
  max_product?: number;
  min_tm?: number;
  max_tm?: number;
  max_tm_diff?: number;
  min_len?: number;
  max_len?: number;
  max_g_count?: number;
  max_run_length?: number;
  max_gc_pct?: number;
  tm_method?: PrimerTmMethod;
  check_tandem_repeats?: boolean;
  check_three_prime_specificity?: boolean;
  optimize_for?: 'closest' | 'balanced';
  /** Max number of primer pairs to return (default 5). */
  max_results?: number;
  /** Minimum bp between primers of two accepted pairs. Set to 0 to disable. */
  min_spacing?: number;
  /** Half-open genomic intervals on this chromosome that candidate primers must not overlap. */
  exclude_regions?: Array<[number, number]>;
  /** Shared analysis seed used by stochastic primer caps. */
  sample_seed?: string | null;
}

/** `?panel_genome=<key>` for a panel on another assembly (services/panel_genomes.py), else nothing. */
function panelGenomeQuery(genome?: string | null): string {
  return genome ? `?panel_genome=${encodeURIComponent(genome)}` : '';
}

export async function designPrimers(
  chrom: string,
  start: number,
  end: number,
  options?: PrimerDesignOptions,
  requestOptions?: Pick<RequestInit, 'signal'> & { genome?: string | null },
): Promise<{ success: boolean; message?: string; pairs?: PrimerPair[]; pair?: PrimerPair; chrom?: string; target_start?: number; target_end?: number }> {
  // A target on a panel's own reference (another assembly): its sequence.
  return fetchJson(`${API_BASE}/design_primers${panelGenomeQuery(requestOptions?.genome)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: requestOptions?.signal,
    body: JSON.stringify({
      chrom,
      start,
      end,
      min_product: options?.min_product ?? 5000,
      max_product: options?.max_product ?? 50000,
      min_tm: options?.min_tm ?? 55,
      max_tm: options?.max_tm ?? 65,
      max_tm_diff: options?.max_tm_diff ?? 2.0,
      min_len: options?.min_len ?? 18,
      max_len: options?.max_len ?? 25,
      max_g_count: options?.max_g_count ?? 2,
      max_run_length: options?.max_run_length ?? 4,
      max_gc_pct: options?.max_gc_pct ?? 70,
      tm_method: options?.tm_method ?? 'primer3',
      check_tandem_repeats: options?.check_tandem_repeats ?? true,
      check_three_prime_specificity: options?.check_three_prime_specificity ?? true,
      optimize_for: options?.optimize_for ?? 'closest',
      max_results: options?.max_results ?? 5,
      min_spacing: options?.min_spacing ?? 50,
      ...(options?.exclude_regions && options.exclude_regions.length > 0
        ? { exclude_regions: options.exclude_regions }
        : {}),
    }),
  });
}

export async function designDafcPrimers(
  chrom: string,
  x_start: number,
  x_end: number,
  y_start: number,
  y_end: number,
  options?: PrimerDesignOptions & { exclude_regions_by_chrom?: Record<string, Array<[number, number]>> },
  y_chrom?: string,
  requestOptions?: Pick<RequestInit, 'signal'>,
): Promise<{ success: boolean; message?: string; quads?: DafcPrimerQuad[]; chrom?: string; locus_x?: { target_start: number; target_end: number }; locus_y?: { target_start: number; target_end: number }; sample_seed?: string }> {
  return fetchJson(`${API_BASE}/design_dafc_primers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: requestOptions?.signal,
    body: JSON.stringify({
      chrom,
      x_start,
      x_end,
      y_start,
      y_end,
      ...(y_chrom ? { y_chrom } : {}),
      min_product: options?.min_product ?? 5000,
      max_product: options?.max_product ?? 50000,
      min_tm: options?.min_tm ?? 55,
      max_tm: options?.max_tm ?? 65,
      max_tm_diff: options?.max_tm_diff ?? 2.0,
      min_len: options?.min_len ?? 18,
      max_len: options?.max_len ?? 25,
      max_g_count: options?.max_g_count ?? 2,
      max_run_length: options?.max_run_length ?? 4,
      max_gc_pct: options?.max_gc_pct ?? 70,
      tm_method: options?.tm_method ?? 'primer3',
      check_tandem_repeats: options?.check_tandem_repeats ?? true,
      check_three_prime_specificity: options?.check_three_prime_specificity ?? true,
      optimize_for: options?.optimize_for ?? 'closest',
      max_results: options?.max_results ?? 5,
      min_spacing: options?.min_spacing ?? 50,
      sample_seed: options?.sample_seed ?? null,
      ...(options?.exclude_regions_by_chrom && Object.keys(options.exclude_regions_by_chrom).length > 0
        ? { exclude_regions: options.exclude_regions_by_chrom }
        : {}),
    }),
  });
}

export async function design4cPrimers(
  chrom: string,
  start: number,
  end: number,
  options?: {
    min_spacing?: number;
    max_spacing?: number;
    min_tm?: number;
    max_tm?: number;
    max_tm_diff?: number;
    min_len?: number;
    max_len?: number;
    max_g_count?: number;
    max_run_length?: number;
    max_gc_pct?: number;
    tm_method?: PrimerTmMethod;
    check_tandem_repeats?: boolean;
    check_three_prime_specificity?: boolean;
    exclude_regions?: Array<[number, number]>;
  },
  requestOptions?: Pick<RequestInit, 'signal'> & { genome?: string | null },
): Promise<{ success: boolean; message?: string; pairs?: PrimerPair[]; pair?: PrimerPair }> {
  return fetchJson(`${API_BASE}/design_4c_primers${panelGenomeQuery(requestOptions?.genome)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: requestOptions?.signal,
    body: JSON.stringify({ chrom, start, end, ...options }),
  });
}

export async function getPrimers(): Promise<{ success: boolean; pair?: PrimerPair; chrom?: string; target_start?: number; target_end?: number }> {
  return fetchJson(`${API_BASE}/primers`);
}

export async function clearPrimers(): Promise<{ success: boolean }> {
  return fetchJson(`${API_BASE}/primers`, { method: 'DELETE' });
}
