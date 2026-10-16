/** Test data for the Variants panel's tests. */
import type { Snp, SnpScan } from './api';

export function snp(pos: number, extra: Partial<Snp> = {}): Snp {
  return {
    id: `${pos}:snv:A/G`, pos, kind: 'snv', ref: 'A', alleles: ['A', 'G'], alt: 'G', length: 0, depth: 30, counts: { A: 20, G: 10 },
    minor: 10, maf: 0.33, strands: { fwd: { depth: 15, minor: 5, major: 10 }, rev: { depth: 15, minor: 5, major: 10 } },
    strand_balance: 0.5, both_strands: true, daf_safe: null, daf_reason: '', low_depth: false, passes: true, ...extra,
  };
}

export function scan(snps: Snp[], extra: Partial<SnpScan> = {}): SnpScan {
  return {
    scan_key: 'k1', dataset_id: 'ds1', region: { chrom: 'chrSNP', start: 7000, end: 11000 },
    params: { min_maf: 0.1, min_depth: 20, both_strands: true, min_bq: 20, min_mapq: 20, mode: 'auto', max_indel: 30, include_duplicates: false },
    mode: 'basecall', chemistry: null, reference: 'fasta', n_reads: 35, median_depth: 32, fixed: 0, snps,
    directions: { CT: 0, GA: 0, none: 35 }, hp: { tagged: 0, values: {}, untagged: 35 }, daf_policy: 'p', elapsed_ms: 5, cached: false,
    ...extra,
  };
}
