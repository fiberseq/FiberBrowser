import type { ChromInfo, Dataset, GenesResponse, GeneSearchResponse, PlasmidLink, PlasmidProblem } from '../types';

export type { PlasmidLink, PlasmidProblem } from '../types';
import { fetchJson } from './sharedFetch';
import { useBrowserStore } from '../stores/browserStore';

const API_BASE = '/api';

export interface GenomeInfo {
  id: string;
  name: string;
  gtf_label: string;
}

/**
 * A panel on another assembly than the main genome asks for its own
 * reference's answer (services/panel_genomes.py): `panel_genome=<key>`.
 * No key (or null): the main genome, as before.
 */
export function withPanelGenome(params: URLSearchParams, genome?: string | null): URLSearchParams {
  if (genome) params.set('panel_genome', genome);
  return params;
}

export async function getChromosomes(genome?: string | null): Promise<{ chroms: ChromInfo[] }> {
  // Cache-bust: the backend sets Cache-Control: max-age=3600 on this endpoint,
  // but chroms change when a new FASTA/genome is loaded mid-session.
  const params = withPanelGenome(new URLSearchParams({ _t: String(Date.now()) }), genome);
  return fetchJson(`${API_BASE}/chroms?${params}`);
}

export async function getGenes(chrom: string, start: number, end: number, options?: RequestInit, genome?: string | null): Promise<GenesResponse> {
  const params = withPanelGenome(new URLSearchParams({ chrom, start: start.toString(), end: end.toString() }), genome);
  return fetchJson(`${API_BASE}/genes?${params}`, options);
}

export async function searchGene(query: string, options?: RequestInit, chrom?: string, genome?: string | null): Promise<GeneSearchResponse> {
  const params = new URLSearchParams({ query });
  if(chrom) params.set('chrom',chrom);
  withPanelGenome(params, genome);
  return fetchJson(`${API_BASE}/gene_search?${params}`, options);
}

export async function getSequence(chrom: string, start: number, end: number, genome?: string | null): Promise<{ sequence: string; chrom: string; start: number; end: number }> {
  const params = withPanelGenome(new URLSearchParams({ chrom, start: start.toString(), end: end.toString() }), genome);
  return fetchJson(`${API_BASE}/sequence?${params}`);
}

/** The server returns at most this many bases per /api/sequence request. */
export const SEQUENCE_REQUEST_MAX_BP = 10_000;

/**
 * A region's sequence of any length, in requests the server allows. Stops early
 * (a shorter result) only where the reference itself ends.
 */
export async function getSequenceChunked(chrom: string, start: number, end: number, genome?: string | null): Promise<string> {
  const parts: string[] = [];
  for (let at = start; at < end; at += SEQUENCE_REQUEST_MAX_BP) {
    const to = Math.min(end, at + SEQUENCE_REQUEST_MAX_BP);
    const res = await getSequence(chrom, at, to, genome);
    const seq = res.sequence ?? '';
    parts.push(seq);
    if (seq.length < to - at) break;  // past the end of the contig
  }
  return parts.join('');
}

export async function loadFasta(path: string): Promise<{ success: boolean; path?: string; sequences?: number; inferred_genome?: string | null; error?: string }> {
  return fetchJson(`${API_BASE}/load_fasta?path=${encodeURIComponent(path)}`, { method: 'POST' });
}

/** Genomes a custom FASTA can be declared to come from (the JASPAR species map, services/motifs.py). */
export const DECLARABLE_GENOMES = ['hg38', 'hg19', 'mm39', 'mm10', 'rn7', 'danRer11', 'dm6', 'ce11', 'sacCer3'] as const;

/**
 * Say which genome a custom FASTA (the main one, or a panel's with `genome`) comes from, so motif species
 * and other genome-keyed features use it; null clears it. Its coordinates stay its own.
 */
export async function declareGenome(declared: string | null, genome?: string | null): Promise<{
  success: boolean; genome?: string | null; fasta_path?: string; error?: string; revision?: number;
  jaspar_species?: { genome: string; taxid: number; name?: string | null; inferred: boolean } | null;
}> {
  const params = withPanelGenome(new URLSearchParams(), genome);
  const query = params.toString();
  const res = await fetchJson<Awaited<ReturnType<typeof declareGenome>>>(`${API_BASE}/reference/declare_genome${query ? `?${query}` : ''}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ genome: declared }),
  });
  // Every view keyed on the genome refetches, not only the one that declared.
  if (res?.success) useBrowserStore.getState().bumpReferenceRevision();
  return res;
}

export interface GenomeDeclaration { fasta_path: string; genome: string }

/** Every genome declared for a FASTA in this server session (kept by the page's autosave). */
export async function getGenomeDeclarations(): Promise<GenomeDeclaration[]> {
  const res = await fetchJson<{ declarations?: GenomeDeclaration[] }>(`${API_BASE}/reference/genome_declarations`);
  return Array.isArray(res?.declarations) ? res.declarations : [];
}

/** Put back declarations saved with a session (Reopen / Restore): saved ones are set, none cleared. */
export async function restoreGenomeDeclarations(declarations: GenomeDeclaration[]): Promise<{ success: boolean; changed?: boolean }> {
  const res = await fetchJson<{ success: boolean; changed?: boolean }>(`${API_BASE}/reference/genome_declarations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ declarations }),
  });
  if (res?.changed) useBrowserStore.getState().bumpReferenceRevision();
  return res;
}

export interface PlasmidLoadResult {
  success: boolean;
  name?: string;
  path?: string;
  length?: number;
  circular?: boolean;
  feature_count?: number;
  warnings?: string[];
  current_genome?: string | null;
  error?: string;
  links?: PlasmidLink[];
  problems?: PlasmidProblem[];
}

export interface PlasmidsLoadResult {
  success: boolean;
  loaded: PlasmidLoadResult[];
  errors: Array<{ path: string; error: string }>;
  count: number;
  links?: PlasmidLink[];
  problems?: PlasmidProblem[];
}

export interface OpenPlasmidDatasetResult {
  success: boolean;
  error?: string;
  plasmid?: PlasmidLoadResult & { already_loaded?: boolean };
  /** Where the reads are: the chromosome of the first linked BAM (else the map). */
  chrom?: string;
  datasets?: Dataset[];
  links?: PlasmidLink[];
  problems?: PlasmidProblem[];
  errors?: Array<{ path: string; error: string }>;
  current_genome?: string | null;
}

/** Load a plasmid map with the BAM(s) aligned to it and link them by sequence. */
export async function openPlasmidDataset(mapPath: string, bamPaths: string[], referenceFasta?: string): Promise<OpenPlasmidDatasetResult> {
  return fetchJson(`${API_BASE}/plasmid/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ map_path: mapPath, bam_paths: bamPaths, ...(referenceFasta ? { reference_fasta: referenceFasta } : {}) }),
  });
}

/** Link a same-length BAM contig whose sequence could not be checked. */
export async function confirmPlasmidLink(chrom: string, datasetId: string, contig: string, offset = 0): Promise<{ success: boolean; error?: string; link?: PlasmidLink; links?: PlasmidLink[]; problems?: PlasmidProblem[] }> {
  return fetchJson(`${API_BASE}/plasmid/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chrom, dataset_id: datasetId, contig, offset }),
  });
}

export async function getPlasmidLinks(chrom?: string, options?: RequestInit): Promise<{ links: PlasmidLink[]; problems: PlasmidProblem[] }> {
  const params = chrom ? `?chrom=${encodeURIComponent(chrom)}` : '';
  return fetchJson(`${API_BASE}/plasmid/links${params}`, options);
}

export async function loadPlasmid(path: string): Promise<PlasmidLoadResult> {
  return fetchJson(`${API_BASE}/load_plasmid?path=${encodeURIComponent(path)}`, { method: 'POST' });
}

export async function loadPlasmids(paths: string[]): Promise<PlasmidsLoadResult> {
  return fetchJson(`${API_BASE}/load_plasmids`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths }),
  });
}

export async function setCircularChrom(chrom: string, circular: boolean, genome?: string | null): Promise<{ success: boolean; chrom?: string; circular?: boolean; size?: number; error?: string }> {
  const params = withPanelGenome(new URLSearchParams({ chrom, circular: circular.toString() }), genome);
  return fetchJson(`${API_BASE}/circular_chrom?${params}`, { method: 'POST' });
}

export async function loadGtf(path: string, genome?: string | null): Promise<{ success: boolean; message?: string; gene_count?: number }> {
  return fetchJson(`${API_BASE}/load_gtf?${withPanelGenome(new URLSearchParams({ path }), genome)}`, {
    method: 'POST'
  });
}

export async function removeGtf(): Promise<{ success: boolean; message?: string }> {
  return fetchJson(`${API_BASE}/gtf`, { method: 'DELETE' });
}

export async function getGenomes(options?: RequestInit): Promise<{ genomes: GenomeInfo[] }> {
  return fetchJson(`${API_BASE}/genomes`, options);
}

export async function loadGenome(genomeId: string): Promise<{
  success: boolean;
  genome_id: string;
  name: string;
  fasta_loaded?: boolean;
  gtf_loaded?: boolean;
  gene_count?: number;
  fasta_error?: string;
  gtf_error?: string;
}> {
  return fetchJson(`${API_BASE}/load_genome?genome_id=${encodeURIComponent(genomeId)}`, { method: 'POST' });
}
