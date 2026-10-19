/** JSON contracts in services/lift/differences.py. Alleles are target-oriented;
 * insertion payload coordinates are already mirrored by the composer. */
export interface Difference {
  id: string; hap: string; hap_label: string;
  kind: 'snv' | 'mnv' | 'aligned_bubble' | 'insertion' | 'deletion' | 'replacement' | 'inversion' | 'no_correspondence';
  reason: string; source: 'assembly' | 'reads'; t_start: number; t_end: number; ref_bp: number; alt_bp: number;
  chain: number | null; strand: '+' | '-' | null;
  src: { contig: string | null; start: number | null; end: number | null };
  grch38: string | null; alt: string | null; t?: 'I' | 'D'; ref?: number; len?: number;
  alt_truncated?: boolean;
  ref_truncated?: boolean;
  ref_sequence_status?: 'unavailable' | 'partial' | 'available';
  alt_sequence_status?: 'unavailable' | 'partial' | 'available';
  aliases?: string[];
  sequence_status?: 'unresolved' | 'unavailable' | 'partial' | 'available';
  read_support?: { cluster: number; carriers: number };
  read_candidates?: Array<{ cluster: number; carriers: number; relation: 'candidate'; method: 'geometry_only';
    sequence_comparison: 'unassessed'; assembly_span: { start: number; end: number; ref_bp: number; alt_bp: number };
    read_span: { start: number; end: number; ref_bp: number; alt_bp: number }; uncertainty: [number, number] }>;
}
export interface DifferenceBin { start: number; end: number; hap: string; hap_label: string; kind: Difference['kind']; count: number; bp: number }
export interface DifferencesResponse {
  dataset_id: string; lift_key: string; chrom: string; start: number; end: number; mode: 'items' | 'bins';
  items: Difference[]; bins: DifferenceBin[]; bin_bp: number | null;
  novel: Array<{ source: 'reads'; t: 'I' | 'D'; ref: number; len: number; support?: number;
    novelty?: 'unassessed'; novelty_reasons?: string[] }>;
}
export interface DifferenceInspection {
  id: string; molecule: string; hap_label: string; record: string; supplementary: boolean; strand: string | null;
  source_pos: { contig: string; start: number; end: number }; read_bases: string; hg002: string | null; grch38: string | null;
  allele: 'hg002' | 'same_as_grch38' | 'grch38' | 'other' | 'deleted' | 'no_coverage' | 'partial' | 'no_insertion' | 'unknown';
  chromatin: { state: 'nucleosome' | 'footprint' | 'accessible' | 'none'; layer: string | null; nearest_m6a_bp: number | null; orientation: '+' | '-' };
  alignment_hg002?: string | null;
  alignment_ins_id?: string;
  item_id?: string; ref_bp?: number; alt_bp?: number; full_span?: boolean;
  ins_id?: string; carries_insertion?: boolean; mol_bp?: number; identity?: number | null; read_bases_length?: number;
}
export interface DifferenceReadsResponse {
  dataset_id: string; lift_key: string; chrom: string; pos: number; end: number;
  rows: DifferenceInspection[]; summary: Record<string, Partial<Record<DifferenceInspection['allele'], number>>>; capped: boolean; max_records: number;
  preferred_hap?: string | null;
  sequence?: { sequence: string; read_id: string; record: string; ins_id: string; orientation: string; source: 'reads' } | null;
  hap_status?: Record<string, string>;
}
