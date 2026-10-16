import { fetchJson } from './sharedFetch';

const API_BASE = '/api';

/** A reference loaded besides the main genome (services/panel_genomes.py). */
export interface PanelGenomeInfo {
  /** `dm6`, `fasta:<stem>`, `contigs:<dataset>`: what requests send as panel_genome. */
  key: string;
  /** Short name for the panel header ("dm6", "pUC19_amplicon contigs"). */
  label: string;
  /** registry (an online genome), fasta (a FASTA you picked), contigs (the BAM header's), header_fasta (its UR FASTA). */
  kind: 'registry' | 'fasta' | 'contigs' | 'header_fasta' | null;
  genome_id: string | null;
  assembly: string | null;
  fasta_path: string | null;
  gtf_path: string | null;
  has_fasta: boolean;
  has_gtf: boolean;
  gene_count: number;
  n_chroms: number;
  chroms: Array<{ name: string; size: number; circular?: boolean }>;
  /** Datasets using it (GET /api/panel_genomes only). */
  datasets?: string[];
}

export interface PanelGenomesResponse {
  main: { genome_id: string | null; fasta_path: string | null };
  genomes: PanelGenomeInfo[];
  /** dataset id -> key */
  datasets: Record<string, string>;
  /** dataset id -> its best-covered window on its own reference (where a panel with none there starts). */
  loci?: Record<string, { chrom: string; start: number; end: number }>;
}

export interface AttachGenomeRequest {
  dataset_ids: string[];
  /** A registry genome (dm6, hg38, ...). */
  genome_id?: string;
  /** A FASTA (with .fai) and, optionally, its annotation. */
  fasta_path?: string;
  gtf_path?: string;
  /** No reference: the file's own contigs (plasmid, amplicon). */
  contigs?: boolean;
  /** Width of the window each dataset's panel opens at. */
  span?: number;
}

export interface AttachGenomeResponse {
  success: boolean;
  error?: string;
  /** The reference (null when the genome asked for is the main one: the datasets follow it). */
  genome: PanelGenomeInfo | null;
  main?: boolean;
  /** Each dataset's best-covered window on its reference. */
  loci?: Record<string, { chrom: string; start: number; end: number }>;
}

export async function getPanelGenomes(options?: RequestInit): Promise<PanelGenomesResponse> {
  return fetchJson(`${API_BASE}/panel_genomes`, options);
}

export async function attachPanelGenome(request: AttachGenomeRequest): Promise<AttachGenomeResponse> {
  return fetchJson(`${API_BASE}/panel_genomes/attach`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
}

export async function detachPanelGenome(datasetIds: string[]): Promise<{ success: boolean; dropped?: string[] }> {
  return fetchJson(`${API_BASE}/panel_genomes/detach`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataset_ids: datasetIds }),
  });
}
