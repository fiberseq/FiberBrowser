import { describe, expect, it } from 'vitest';
import { describeSvCluster, readSvDraw, supportingReadIds, svEvidenceLevel } from './svDrawing';
import type { CompactRead, SvCluster, SvSegment } from './types';

const target = { id: 'I:1000:100', t: 'I', ref: 1000, end: 1000, len: 100, support: 1, informative: 1, sa_support: 0 } as SvCluster;
const clip: CompactRead = { id: 'clip', intervals: [], sv: [{ t: 'S', side: 'R', ref: 1000, len: 150, q: 100 }] };
const segment = (pos: number, q_start: number, q_end: number): SvSegment => ({
  chrom: 'chrT', pos, q_start, q_end, query_length: 250, mapq: 60, strand: '+', cigar_ref_len: q_end - q_start,
});

describe('SV evidence levels', () => {
  it('draws raw I–M–I and D–M–D pieces and exposes exact replacement spans', () => {
    const insertion: CompactRead = { id: 'exact', intervals: [], sv: [{ t: 'I', ref: 1000, len: 100, q: 0,
      ref_len: 10, alt_len: 110, q_end: 110, raw_pieces: [
        { t: 'I', ref: 1000, len: 50, q: 0 }, { t: 'M', ref: 1000, len: 10, q: 50 }, { t: 'I', ref: 1010, len: 50, q: 60 },
      ] }] };
    expect(readSvDraw(insertion, 0, 2000, 100).insertions.map(e => e.len)).toEqual([50, 50]);
    expect(readSvDraw(insertion, 0, 2000, 101).insertions).toEqual([]);
    const deletion: CompactRead = { id: 'deleted', intervals: [], sv: [{ t: 'D', ref: 1, len: 40, q: 0,
      raw_ref: 1000, raw_ref_end: 1050, raw_pieces: [
        { t: 'D', ref: 1000, len: 20, q: 0 }, { t: 'M', ref: 1020, len: 10, q: 0 }, { t: 'D', ref: 1030, len: 20, q: 10 },
      ] }] };
    expect(readSvDraw(deletion, 900, 2000, 40).deletions).toEqual([
      { start: 100, end: 120, len: 20 }, { start: 130, end: 150, len: 20 },
    ]);
    expect(describeSvCluster({ ...target, ref_len: 10, alt_len: 110, uncertainty: [900, 1000] }, null, [], 'chrT').where)
      .toContain('replaces 10 reference bp with 110 query bp');
  });
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
  it('uses all local alignment evidence once per molecule, including supplementary-only rows', () => {
    const deletion = { ...target, t: 'D' as const, len: 1000, end: 2000 };
    const left = { ...clip, sv_segments: [segment(900, 0, 100)] };
    const right = { ...clip, supplementary: true, sv_segments: [segment(2000, 100, 250)] };
    expect(supportingReadIds([left, right, right], deletion)).toEqual(['clip']);
    const merged = { ...left, sv_segments: [...left.sv_segments, ...right.sv_segments], sv_alignments: [left, right] };
    expect(svEvidenceLevel(merged, deletion)).toBe('confirmed');
    const only = { ...right, sv: [{ t: 'I' as const, ref: 1000, len: 100, q: 0 }] };
    expect(supportingReadIds([only, only], target)).toEqual(['clip']);
  });
});

it('tests the matching clip across targets, retaining hard clips as putative only', () => {
  const double = { ...clip, sv: [...clip.sv!, { t: 'S' as const, side: 'L' as const, ref: 750, len: 100, q: 0 }] };
  expect(svEvidenceLevel(double, target, 'chrT', [target, { ...target, ref: 750 }])).toBe('putative');
  expect(svEvidenceLevel(double, target, 'chrT', [target, { ...target, t: 'D', len: 200 }])).toBe('ambiguous');
  expect(svEvidenceLevel({ ...clip, sv: [{ ...clip.sv![0], t: 'S', side: 'R', ref: 1000, len: 100, q: 0, h: 1 }] }, target)).toBe('putative');
});

it('propagates equivalent anchors through clipping and target competition', () => {
  const normalized = { ...target, uncertainty: [1000, 2000] as [number, number] };
  const shifted = { ...clip, sv: [{ t: 'S' as const, side: 'R' as const, ref: 1500, len: 100, q: 0 }] };
  expect(svEvidenceLevel(shifted, normalized)).toBe('putative');
  expect(svEvidenceLevel(shifted, normalized, 'chrT', [normalized, { ...normalized, len: 300 }])).toBe('ambiguous');
  expect(svEvidenceLevel({ ...clip, sv: [{ t: 'I', ref: 1500, len: 100, q: 0 }] }, normalized)).toBe('confirmed');
});
