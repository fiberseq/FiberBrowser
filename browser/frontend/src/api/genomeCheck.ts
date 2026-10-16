import { fetchJson } from './sharedFetch';

const API_BASE = '/api';

/** What a file's contigs say about its assembly (services/assembly_fingerprint.py). */
export interface AssemblyFingerprint {
  assembly: string | null;
  name: string | null;
  short: string | null;
  confidence: 'high' | 'medium' | 'low' | 'none';
  kind: 'genome' | 'plasmid' | 'unknown' | 'empty';
  naming: 'ucsc' | 'ensembl' | 'ncbi' | 'other' | 'mixed' | null;
  in_registry: boolean;
  declared: string | null;
  conflicts: string[];
}

/** A registry genome to load (the download/cache flow of POST /api/load_genome). */
export interface GenomeSuggestion {
  genome_id: string;
  name: string;
  confidence: string;
  /** Downloaded already: loading it is quick. */
  cached: boolean;
  /** False on a public server or a tour tab: report only. */
  can_load: boolean;
  /** Datasets it was suggested from (the overall suggestion only). */
  datasets?: string[];
}

export type GenomeFitStatus =
  | 'match' | 'no_reference' | 'unknown' | 'sequence_differs'
  | 'missing_contigs' | 'other_names' | 'different_assembly';

export interface DatasetGenomeCheck {
  dataset_id: string;
  label: string;
  data_type?: string | null;
  assembly: AssemblyFingerprint;
  reference: { label: string | null; assembly: string | null; kind: string };
  status: GenomeFitStatus;
  severity: 'ok' | 'info' | 'warning' | 'error';
  message: string | null;
  suggestion: GenomeSuggestion | null;
  known_not_in_registry: boolean;
  details: {
    missing: Array<{ contig: string; length: number }>;
    length_differs: Array<{ contig: string; reference_contig: string; file_length: number; reference_length: number }>;
    renamed: Array<{ contig: string; reference_contig: string; length: number }>;
    sequence_differs: Array<{ contig: string; reference_contig: string }>;
    ignored: Array<{ contig: string; reason: string }>;
    notes: string[];
  };
}

export interface GenomeCheckResponse {
  reference: {
    kind: 'fasta' | 'registry' | 'plasmids' | 'none';
    label: string | null;
    assembly: string | null;
    name: string | null;
    genome_id: string | null;
    n_contigs: number;
    partial: boolean;
  };
  datasets: DatasetGenomeCheck[];
  /** The datasets whose severity is warning or error. */
  problems: DatasetGenomeCheck[];
  /** The one registry genome every dataset of a known assembly points to. */
  suggestion: GenomeSuggestion | null;
  can_load_genomes: boolean;
  has_gtf: boolean;
}

export async function getGenomeCheck(options?: RequestInit): Promise<GenomeCheckResponse> {
  return fetchJson(`${API_BASE}/genome/check`, options);
}

export async function getDatasetAssembly(datasetId: string, options?: RequestInit): Promise<DatasetGenomeCheck> {
  return fetchJson(`${API_BASE}/datasets/${encodeURIComponent(datasetId)}/assembly`, options);
}
