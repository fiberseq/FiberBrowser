/** Graph features (parity with linear): band routing, labels and drawing details. */
import { describe, expect, it } from 'vitest';
import { packMemberBands, routeRead, type BandMember } from './memberBands';
import { clusterCounts } from './readCanvas';
import { getClusterColor, getClusterLabel, NOT_CARRIER_CLUSTER_ID, UNASSIGNED_CLUSTER_COLOR } from '../../components/tracks/read-track/constants';
import type { PlacedMolecule } from './readGeometry';
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

describe('item 6: "not a carrier" (-2) is a label of its own, shown', () => {
  it('has its own name and colour, apart from Unassigned', () => {
    expect(getClusterLabel(NOT_CARRIER_CLUSTER_ID, true)).toBe('Not a carrier');
    expect(getClusterColor(NOT_CARRIER_CLUSTER_ID)).not.toBe(UNASSIGNED_CLUSTER_COLOR);
  });

  it('a band groups its rows: clusters first, then Not a carrier, then Unassigned; the label counts each', () => {
    const mol = (q: string, x: number): PlacedMolecule => ({ read: read({ q, k: `d|0|${q}|r`, aid: `a-${q}`, hap: 'MAT' }), lane: 'mat',
      extent: [x, x + 10], body: [{ x0: x, x1: x + 10, s0: 0, s1: 10 }], holes: [], ins: [] } as never);
    const ms = [mol('a', 0), mol('b', 20), mol('c', 40), mol('d', 60)];
    const lanes = packMemberBands(ms, [member({ binding: 'mat' })], { p: { assignments: { 'a-a': -2, 'a-b': 0, 'a-c': -1 } } }, 10);
    const lane = lanes.get('mat')!;
    expect(lane.rowCluster).toEqual([0, NOT_CARRIER_CLUSTER_ID, -1]);
    expect(clusterCounts(lane, 0, lane.rows.length)).toBe('C0 1 · Not a carrier 1 · – 2');
  });
});
