import { describe, expect, it } from 'vitest';
import { equivalentInsertions, payloadForExpansion } from './equivalentInsertions';
import { makeAxis } from './axis';
import { insertionPayloadRects } from '../../components/tracks/read-track/liveLiftInsertionCanvas';

const mat: any = { id: 'mat', kind: 'insertion', hap_label: 'MAT', t_start: 100, alt_bp: 100 };
const pat: any = { ...mat, id: 'pat', hap_label: 'PAT', alt_bp: 103 };
describe('equivalent insertions share a boundary and preserve their own bp scale', () => {
  it('matches unique similar alleles, excluding competing insertions and other positions', () => {
    expect(equivalentInsertions(mat, [mat, pat])).toEqual([mat, pat]);
    expect(equivalentInsertions(mat, [mat, pat, { ...pat, id: 'competing' }])).toEqual([mat]);
    expect(equivalentInsertions(mat, [{ ...pat, t_start: 101 }, { ...pat, alt_bp: 500 }])).toEqual([mat]);
  });
  it.each([false, true])('draws the other parent’s partial, minus-oriented payload without stretching (reversed=%s)', reversed => {
    const block: any = { chrom: 'chr1', pos: 100, ins_id: mat.id, length: 103, label: 'lengths differ', hap_label: 'MAT',
      alleles: [{ ins_id: mat.id, hap_label: 'MAT', length: 100 }, { ins_id: pat.id, hap_label: 'PAT', length: 103 }] };
    const payload: any = { pos: 100, hap_label: 'PAT', length: 103, covered: [10, 90], orientation: '-', intervals: [[20, 50, 30]] };
    const row: any = { hap_label: 'PAT', insertions: { pat: payload } };
    expect(payloadForExpansion(row, block)).toBe(payload);
    const axis = makeAxis(0, 200, 303, reversed, [block]);
    expect(insertionPayloadRects(payload, block.ins_id, axis)[0].w).toBe(30);
    expect(payloadForExpansion(undefined, block)).toBeUndefined();
    expect(payloadForExpansion({ hap_label: 'PAT', insertions: { competing: payload } } as any, block)).toBeUndefined();
  });
});
