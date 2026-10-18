import { describe, expect, it } from 'vitest';
import { supportingReadIds, svEvidenceLevel } from './svDrawing';
import type { CompactRead, SvCluster, SvSegment } from './types';

const target = { id: 'I:1000:100', t: 'I', ref: 1000, end: 1000, len: 100, support: 1, informative: 1, sa_support: 0 } as SvCluster;
const clip: CompactRead = { id: 'clip', intervals: [], sv: [{ t: 'S', side: 'R', ref: 1000, len: 150, q: 100 }] };
const segment = (pos: number, q_start: number, q_end: number): SvSegment => ({
  chrom: 'chrT', pos, q_start, q_end, query_length: 250, mapq: 60, strand: '+', cigar_ref_len: q_end - q_start,
});

describe('SV evidence levels', () => {
  it('keeps clips putative, multi-allelic clips ambiguous and default highlights confirmed', () => {
    expect(svEvidenceLevel(clip, target)).toBe('putative');
    expect(svEvidenceLevel(clip, target, 'chrT', [target, { ...target, len: 300 }])).toBe('ambiguous');
    expect(supportingReadIds([clip, clip], target)).toEqual([]);
    const cigar = { ...clip, sv: undefined, sv_evidence: [{ t: 'I' as const, ref: 1000, len: 100, q: 100 }] };
    expect(supportingReadIds([cigar, cigar], target)).toEqual(['clip']);
  });
  it('requires collinearity, strand, MAPQ and available sequence for insertion junctions', () => {
    const read = { ...clip, sequence_span: [0, 250] as [number, number],
      sv_segments: [segment(900, 0, 100), segment(1000, 200, 250)] };
    for (const strand of ['+', '-'] as const) {
      read.sv_segments = read.sv_segments.map(s => ({ ...s, strand }));
      expect(svEvidenceLevel(read, target, 'chrT')).toBe('confirmed');
    }
    for (const patch of [{ mapq: 0 }, { q_start: 50 }, { strand: '+' as const }]) {
      expect(svEvidenceLevel({ ...read, sv_segments: [read.sv_segments[0], { ...read.sv_segments[1], ...patch }] }, target)).toBe('putative');
    }
    expect(svEvidenceLevel({ ...read, sequence_span: [0, 100] }, target)).toBe('putative');
  });
  it('cannot confirm a deletion with overlapping query intervals or an inversion', () => {
    const deletion = { ...target, t: 'D' as const, len: 1000, end: 2000 };
    const read = { ...clip, sv_segments: [segment(900, 0, 100), segment(2000, 100, 250)] };
    expect(svEvidenceLevel(read, deletion)).toBe('confirmed');
    expect(svEvidenceLevel({ ...read, sv_segments: [read.sv_segments[0], { ...read.sv_segments[1], q_start: 0 }] }, deletion)).toBe('putative');
    expect(svEvidenceLevel({ ...read, sv_segments: [read.sv_segments[0], { ...read.sv_segments[1], strand: '-' }] }, deletion)).toBe('putative');
  });
});
