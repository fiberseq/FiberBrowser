import { describe, expect, it } from 'vitest';
import { alleleLabel, differenceDescription, haplotypeSummary, differenceGlyph, differenceLanes, inspectionModel, nextDifference, stripModel } from './differencesModel';
import type { Difference, DifferenceInspection, DifferencesResponse } from './differenceTypes';
import deletionInspection from '../../../../../tests/data/deletion_inspection.json';
const diff = (pos: number, size = 1, kind: Difference['kind'] = 'snv'): Difference => ({
  id: `MAT:src:${pos}-${pos + size}:${kind}`, hap: 'h1', hap_label: 'MAT', kind, reason: 'aligned_indel', source: 'assembly',
  t_start: pos, t_end: kind === 'insertion' ? pos : pos + size, ref_bp: kind === 'insertion' ? 0 : size, alt_bp: size,
  chain: 1, strand: '+', src: { contig: 'src', start: 10, end: 10 + size }, grch38: 'A', alt: 'C',
});
describe('difference strip decisions', () => {
  it('describes replacement spans and zero-width source boundaries without reversed ranges', () => {
    const replacement = { ...diff(50, 1733, 'replacement'), alt_bp: 1 };
    expect(differenceDescription(replacement, 'chr1')).toContain('1,733→1 bp');
    expect(differenceDescription({ ...replacement, kind: 'deletion', alt_bp: 0, src: { contig: 'src', start: 200, end: 200 } }, 'chr1'))
      .toContain('src:200|201 (source boundary)');
  });
  it('uses one lane per displayed haplotype', () => {
    expect(differenceLanes(['MAT', 'PAT'])).toEqual(['MAT', 'PAT']);
    expect(differenceLanes(['MAT', 'PAT'], 'PAT')).toEqual(['PAT']);
  });
  it('uses item detail or density bins as instructed by the API, retaining large items', () => {
    const response = { items: [diff(20), diff(50, 2353, 'insertion')], bins: [{ count: 4 }], mode: 'items' } as DifferencesResponse;
    expect(stripModel(response, 0).bins).toEqual([]);
    expect(stripModel({ ...response, mode: 'bins' }, 50)).toEqual({ items: [response.items[1]], bins: response.bins });
  });
  it('labels and sizes large insertion wedges, distinguishes each structural geometry', () => {
    expect(differenceGlyph(diff(50, 2353, 'insertion'))).toMatchObject({ shape: 'wedge', label: '+2.4 kb' });
    expect(differenceGlyph(diff(50, 3, 'insertion')).label).toBe('');
    expect(differenceGlyph(diff(50, 2353, 'insertion')).width).toBeGreaterThan(differenceGlyph(diff(50, 3, 'insertion')).width);
    for (const [kind, shape] of [['snv', 'tick'], ['deletion', 'bracket'], ['inversion', 'chevron'], ['no_correspondence', 'hatch'], ['aligned_bubble', 'hatch'], ['replacement', 'hatch']] as const) {
      expect(differenceGlyph(diff(50, 10, kind)).shape).toBe(shape);
    }
  });
  it('shows allele enums as the dataset\'s own assembly names (wire values unchanged)', () => {
    expect(haplotypeSummary({ hg002: 2, grch38: 1 }, 'dm6', 'strainA')).toBe('strainA 2 · dm6 1');
    expect(haplotypeSummary({ hg002: 2, grch38: 1, no_coverage: 3 })).toBe('Source 2 · Reference 1 · NO COVERAGE 3');
    expect(alleleLabel('same_as_grch38', { target: 'dm6' })).toBe('Same as dm6');
    expect(alleleLabel('hg002', { source: 'NA12878' })).toBe('NA12878');
    expect(alleleLabel('other')).toBe('OTHER');
  });
  it('names both assemblies, bases, reason, and matched native evidence on hover', () => {
    const text = differenceDescription({ ...diff(50, 2353, 'insertion'), reason: 'source_insertion', read_support: { carriers: 7, cluster: 0 } }, 'chr1');
    expect(text).toContain('Reference chr1:'); expect(text).toContain('Source src:');
    expect(text).toContain('Reference: A · Source: C');
    const named = differenceDescription({ ...diff(50, 2353, 'insertion'), reason: 'source_insertion' }, 'chr1', { source: 'NA12878', target: 'CHM13' });
    expect(named).toContain('CHM13 chr1:'); expect(named).toContain('NA12878 src:'); expect(named).toContain('CHM13: A · NA12878: C'); expect(text).toContain('sequence of the source assembly only');
    expect(text).toContain("Geometry candidate: 7 native reads' insertion (sequence comparison unassessed)");
  });
  it('previous/next searches beyond edges and respects each minimum-size filter', () => {
    const ds = [diff(10, 1000, 'insertion'), diff(45), diff(120), diff(130, 10), diff(160, 50), diff(220, 1000)];
    expect(nextDifference(ds, 50, 100, 1, 0)?.t_start).toBe(120);
    expect(nextDifference(ds, 50, 100, 1, 10)?.t_start).toBe(130);
    expect(nextDifference(ds, 50, 100, 1, 50)?.t_start).toBe(160);
    expect(nextDifference(ds, 50, 100, 1, 1000)?.t_start).toBe(220);
    expect(nextDifference(ds, 50, 100, -1, 0)?.t_start).toBe(45);
    expect(nextDifference(ds, 50, 100, -1, 1000)?.t_start).toBe(10);
    expect(nextDifference(ds, 50, 100, 1, 2000)).toBeNull();
  });
});
describe('inspection table model', () => {
  it('highlights an empty deletion cohort from explicit geometry membership', () => {
    expect(inspectionModel(deletionInspection as DifferenceInspection[]).carriers).toEqual(['full']);
    expect(inspectionModel([{ ...deletionInspection[0], carries_deletion: false }] as DifferenceInspection[]).carriers).toEqual([]);
  });
  it('groups alleles per haplotype, calls out GRCh38 reads, and highlights carriers', () => {
    const rows = [
      { id: 'a', hap_label: 'MAT', allele: 'hg002' }, { id: 'b', hap_label: 'MAT', allele: 'grch38' },
      { id: 'c', hap_label: 'PAT', allele: 'deleted' }, { id: 'd', hap_label: 'MAT', allele: 'other', carries_insertion: true },
      { id: 'e', hap_label: 'PAT', allele: 'no_coverage' },
    ] as DifferenceInspection[];
    const m = inspectionModel(rows);
    expect(m.summary).toEqual({ MAT: { hg002: 1, grch38: 1, other: 1 }, PAT: { deleted: 1, no_coverage: 1 } });
    expect(m.misphased.map(r => r.id)).toEqual(['b']); expect(m.carriers).toEqual(['a', 'd']);
  });
});

describe('carrier highlights from an inspection', () => {
  it('scope to the carriers\' display rows and judge a read-supported edit by its bases', async () => {
    const { carrierHighlight } = await import('./differencesModel');
    const rows = [{ id: 'q', row_id: 'lift|0|q|mat', hap_label: 'MAT', allele: 'other', read_bases: 'G' },
      { id: 'r', row_id: 'lift|0|r|mat', hap_label: 'MAT', allele: 'hg002', read_bases: 'A' }] as DifferenceInspection[];
    const m = inspectionModel(rows, 'MAT', { source: 'reads', kind: 'snv', alt: 'G' });
    expect(m.carriers).toEqual(['q']);
    expect(carrierHighlight(m.carrierRows, 'lift')).toEqual({ ids: ['q'], scopedRows: { lift: new Set(['lift|0|q|mat']) } });
    expect(inspectionModel(rows, 'MAT').carriers).toEqual(['r']);
    expect(carrierHighlight([{ id: 'x' }] as DifferenceInspection[], 'lift')).toEqual({ ids: ['x'] });
  });
});
