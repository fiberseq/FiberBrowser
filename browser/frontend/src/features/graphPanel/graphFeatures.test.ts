/** Graph features (parity with linear): band routing, labels and drawing details. */
import { describe, expect, it } from 'vitest';
import { routeRead, type BandMember } from './memberBands';
import type { GraphRead } from './types';

const read = (over: Partial<GraphRead>): GraphRead => ({
  k: 'd|0|q|r', d: 'd', lib: 0, q: 'q', rec: 'r', b: 'mat', c: 'chr3_MATERNAL', st: '+', sup: false, s: 0, e: 100,
  cov: [[0, 100, 0, 1]], ins: [], ...over,
});
const member = (over: Partial<BandMember>): BandMember => ({
  panelId: 'p', stateKey: 'p', datasetId: 'd', liftHap: 'MAT', binding: null, label: 'MAT', color: '#f80', ...over,
});

describe('item 7: a cross-haplotype supplementary is on its own contig\'s band', () => {
  it('a MAT supplementary of a PAT molecule goes to the MAT member, never the PAT one', () => {
    const sup = read({ sup: true, b: 'mat', hap: 'MAT' });
    expect(routeRead(sup, member({ liftHap: 'MAT' }))).toBe(true);
    expect(routeRead(sup, member({ panelId: 'pat', liftHap: 'PAT' }))).toBe(false);
    // A pooled member (no haplotype of its own) takes it unless a sibling member shows MAT.
    expect(routeRead(sup, member({ liftHap: null }))).toBe(true);
    expect(routeRead(sup, member({ liftHap: null, excludeHaps: ['MAT'] }))).toBe(false);
  });
});
