import { describe, expect, it } from 'vitest';
import { computeMembershipClusters, cooccGroupParams, subsetCoOccupancy } from './footprintMembership';

describe('cooccGroupParams', () => {
  it('sends a class\'s fitted bounds so co-occupancy matches as a saved rule does', () => {
    const [p] = cooccGroupParams([{
      id: 'g', name: 'A', color: '#000', sourceIndex: 0, sizeMin: 10, sizeMax: 40, overlapFraction: 0.5, enabled: true,
      referenceAbsStart: 100, referenceAbsEnd: 150, familyModelAbsStart: 110, familyModelAbsEnd: 130,
    } as never]);
    expect(p).toMatchObject({ referenceAbsStart: 100, referenceAbsEnd: 150, familyModelAbsStart: 110, familyModelAbsEnd: 130 });
  });
});

describe('computeMembershipClusters', () => {
  it('clusters each dataset by the classes saved from it (other datasets\' classes are not evaluated there)', () => {
    const g = (id: string, ds: string) => ({ id, name: id, sourceDatasetId: ds, consensusStateId: id, sizeMin: 0, sizeMax: null } as never);
    const groups = [g('A·daf', 'daf'), g('A·hia5', 'hia5'), g('B·daf', 'daf')];
    const occ = {
      daf: { per_group: [{ ids_with: ['r1', 'r2'], ids_without: ['r3'] }, { ids_with: [], ids_without: [] }, { ids_with: ['r2'], ids_without: ['r1', 'r3'] }] },
      hia5: { per_group: [{ ids_with: [], ids_without: [] }, { ids_with: ['h1'], ids_without: ['h2'] }, { ids_with: [], ids_without: [] }] },
    } as never;
    const c = computeMembershipClusters(occ, groups, ['daf', 'hia5'])!;
    expect(c).not.toBeNull();
    expect(Object.keys(c.byDataset.daf).sort()).toEqual(['r1', 'r2', 'r3']);
    expect(Object.keys(c.byDataset.hia5).sort()).toEqual(['h1', 'h2']);
    expect(c.patterns).toContain('1.1');
    expect(c.legend.find(l => l.label.includes('A·hia5'))?.label).not.toContain('A·daf');
  });
});

describe('clustering by some of the saved footprints', () => {
  const g = (id: string) => ({ id, name: id, sizeMin: 0, sizeMax: null } as never);
  const groups = [g('A'), g('B'), g('C'), g('D')];
  // 8 reads; each footprint's carriers (every read evaluated for every footprint).
  const reads = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8'];
  const carriers: Record<string, string[]> = { A: ['r1', 'r2', 'r3', 'r4'], B: ['r1', 'r2', 'r5'], C: ['r1', 'r6', 'r7'], D: ['r2', 'r3', 'r8'] };
  const row = (id: string) => ({ ids_with: carriers[id], ids_without: reads.filter(r => !carriers[id].includes(r)) });
  const occ = { ds: { per_group: groups.map(group => row((group as { id: string }).id)), pairs: [{ group_i: 0, group_j: 1 }], total_reads: 8 } } as never;

  it('subsets the per-group rows consistently and drops the pairs', () => {
    const sub = subsetCoOccupancy(occ, [3, 1]) as Record<string, { per_group: Array<{ ids_with: string[] }>; pairs: unknown[] }>;
    expect(sub.ds.per_group.map(r => r.ids_with)).toEqual([carriers.D, carriers.B]);
    expect(sub.ds.pairs).toEqual([]);
    // Rows for other definitions (an older result) are left out rather than mislabelled.
    expect((subsetCoOccupancy(occ, [7]) as Record<string, { per_group: unknown[] }>).ds.per_group).toEqual([]);
  });

  it('equals the full clustering with the other footprints collapsed', () => {
    const full = computeMembershipClusters(occ, groups, ['ds'])!;
    const picked = [0, 2];  // A and C
    const sub = computeMembershipClusters(subsetCoOccupancy(occ, picked), picked.map(i => groups[i]), ['ds'])!;
    // Each read's pattern over A and C is its full pattern's A and C bits.
    for (const read of reads) {
      const fullPattern = full.patterns[full.byDataset.ds[read]];
      expect(sub.patterns[sub.byDataset.ds[read]]).toBe(picked.map(i => fullPattern[i]).join(''));
    }
    expect(sub.patterns.length).toBeLessThanOrEqual(4);
    expect(sub.legend.every(l => !l.label.includes('B') && !l.label.includes('D'))).toBe(true);
    expect(sub.legend.reduce((n, l) => n + l.count, 0)).toBe(reads.length);
  });
});

describe('membership clustering of classes with half-base edges (fb-n1-bugs 1)', () => {
  it('stores whole-base peak regions covering each class, so Projection gets integers', async () => {
    const { applyMembershipClusters, basesCovering } = await import('./footprintMembership');
    const { useBrowserStore } = await import('../stores/browserStore');
    // Lattice-recaller class spans are medians of call edges: half bases are common.
    const group = (id: string, start: number, end: number, sizeMax: number | null) => ({
      id, name: id, sourceIndex: -1, sizeMin: 0, sizeMax, referenceAbsStart: start, referenceAbsEnd: end,
    } as never);
    const groups = [group('A', 47515967.5, 47515997.5, null), group('B', 47516044.5, 47516088.5, 60), group('C', 47516100, 47516120, null)];
    applyMembershipClusters({ byDataset: { ds: { r1: 0 } }, patterns: ['100'], legend: [] }, groups, { ds: ['ds'] }, 47515000);
    const regions = useBrowserStore.getState().clusterPeakRegions;
    expect(regions.map(r => [r.start, r.end, r.mode])).toEqual([
      [47515967, 47515998, 'accessibility'],
      [47516044, 47516089, 'tf'],
      [47516100, 47516120, 'accessibility'],
    ]);
    expect(regions.every(r => Number.isInteger(r.start) && Number.isInteger(r.end))).toBe(true);
    expect(basesCovering(10.5, 20.5)).toEqual({ start: 10, end: 21 });
  });

  it('cart sequence export asks for whole bases around half-base classes', async () => {
    const { groupEntriesByChrom } = await import('../components/controls/footprint-analysis/cartExport');
    const [g] = groupEntriesByChrom([{ referenceChrom: 'chr19', referenceAbsStart: 100.5, referenceAbsEnd: 130.5 }], 'chr19', 20);
    expect([g.start, g.end]).toEqual([80, 151]);
  });

  it('the main view takes whole bases (Zoom to class on half-base edges)', async () => {
    const { useBrowserStore } = await import('../stores/browserStore');
    useBrowserStore.getState().setViewport('chr19', 47515917.5, 47516047.5);
    const s = useBrowserStore.getState();
    expect([s.start, s.end]).toEqual([47515917, 47516048]);
  });
});
