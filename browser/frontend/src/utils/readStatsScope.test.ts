import { describe, expect, it } from 'vitest';
import { capRequest, idsForScope, scopeOptions, summarizeByCluster } from './readStatsScope';

const assignments = { ds1: { a: 1, b: 2, c: 1, d: -1 }, ds2: { x: 2 } };
const shownByKey = { ds1: ['c', 'a', 'b', 'd'], ds2: ['x', 'y'], gone: ['z'] };
const stateKeys = ['ds1', 'ds2'];

describe('Read Stats groups', () => {
  it('offers the selection, the reads shown and each cluster with its size', () => {
    const options = scopeOptions({ selectionCount: 3, shownByKey, assignments, stateKeys, clusterOrder: [2, 1] });
    expect(options.map(o => [o.key, o.label, o.count])).toEqual([
      ['selection', 'Selected reads', 3],
      ['shown', 'Reads shown', 6],
      ['cluster:2', 'Cluster 2', 2],
      ['cluster:1', 'Cluster 1', 2],
      ['cluster:-1', 'Unassigned (no overlap)', 1],
    ]);
  });

  it('collects each group\'s reads per panel, in display order', () => {
    const ctx = {
      selectedByKey: { ds1: ['b'] }, shownByKey, assignments, stateKeys,
      orderAssigned: (sk: string, members: Record<string, number>) => shownByKey[sk as 'ds1'].filter(id => id in members),
    };
    expect(idsForScope('selection', ctx)).toEqual({ ds1: ['b'] });
    expect(idsForScope('shown', ctx)).toEqual({ ds1: ['c', 'a', 'b', 'd'], ds2: ['x', 'y'] });
    expect(idsForScope('cluster:1', ctx)).toEqual({ ds1: ['c', 'a'] });
    expect(idsForScope('cluster:2', ctx)).toEqual({ ds1: ['b'], ds2: ['x'] });
  });

  it('caps a large request at its first reads, main view first', () => {
    const regions = [{ chrom: 'chr2', start: 0, end: 10, read_ids_by_dataset: { ds1: ['p', 'q'] } }];
    const capped = capRequest({ ds1: ['a', 'b'], ds2: ['x'] }, regions, 4);
    expect(capped.total).toBe(5);
    expect(capped.truncated).toBe(true);
    expect(capped.main).toEqual({ ds1: ['a', 'b'], ds2: ['x'] });
    expect(capped.regions.map(r => r.read_ids_by_dataset)).toEqual([{ ds1: ['p'] }]);
    expect(capRequest({ ds1: ['a'] }, [], 4).truncated).toBe(false);
  });

  it('counts reads shown by two panels of one dataset at one locus once', () => {
    const options = scopeOptions({
      selectionCount: 0, shownByKey: { ds1: ['a', 'b'], 'ds1:copy': ['a', 'b'] }, assignments: { ds1: { a: 1 }, 'ds1:copy': { a: 1 } },
      stateKeys: ['ds1', 'ds1:copy'], identityOf: () => 'ds1@main',
    });
    expect(options.map(o => o.count)).toEqual([0, 2, 1]);
  });

  it('summarises the reads by cluster', () => {
    const rows = [
      { read_id: 'a', dataset_id: 'ds1', accessibility_pct: 10, footprint_count: 4, avg_footprint_size: 140, methyl_pct: null },
      { read_id: 'c', dataset_id: 'ds1', accessibility_pct: 30, footprint_count: 2, avg_footprint_size: 100, methyl_pct: null },
      { read_id: 'b', dataset_id: 'ds1', accessibility_pct: 50, footprint_count: 0, avg_footprint_size: 0, methyl_pct: 5 },
    ];
    const byCluster = summarizeByCluster(rows, (_ds, id) => assignments.ds1[id as 'a'], [1, 2]);
    expect(byCluster.map(r => [r.label, r.n, r.meanAccessibility, r.meanFootprints, r.meanFootprintSize, r.meanModPct])).toEqual([
      ['Cluster 1', 2, 20, 3, 120, null],
      ['Cluster 2', 1, 50, 0, null, 5], // no footprints: the mean size is NA, not 0 bp
    ]);
  });

  it('leaves reads without footprint calls out of the footprint and accessibility means', () => {
    const rows = [
      { read_id: 'a', dataset_id: 'ds1', accessibility_pct: 20, footprint_count: 4, avg_footprint_size: 100, methyl_pct: 3 },
      { read_id: 'c', dataset_id: 'ds1', accessibility_pct: null, footprint_count: null, avg_footprint_size: null, methyl_pct: 1 },
    ];
    const [row] = summarizeByCluster(rows, (_ds, id) => assignments.ds1[id as 'a'], [1]);
    expect([row.n, row.meanAccessibility, row.meanFootprints, row.meanFootprintSize, row.meanModPct]).toEqual([2, 20, 4, 100, 2]);
  });

  it('gives NA (null) means for a cluster in which no read has footprint calls', () => {
    const rows = [
      { read_id: 'a', dataset_id: 'ds1', accessibility_pct: null, footprint_count: null, avg_footprint_size: null, methyl_pct: 4 },
      { read_id: 'c', dataset_id: 'ds1', accessibility_pct: 100, footprint_count: 0, avg_footprint_size: 0, methyl_pct: null },
    ];
    const clusters: Record<string, number> = { a: 1, c: 2 };
    const out = summarizeByCluster(rows, (_ds, id) => clusters[id], [1, 2]);
    expect([out[0].n, out[0].meanAccessibility, out[0].meanFootprints, out[0].meanFootprintSize, out[0].meanModPct]).toEqual([1, null, null, null, 4]);
    // A called, fully accessible read: known 100% and no footprints.
    expect([out[1].meanAccessibility, out[1].meanFootprints, out[1].meanFootprintSize]).toEqual([100, 0, null]);
  });
});
