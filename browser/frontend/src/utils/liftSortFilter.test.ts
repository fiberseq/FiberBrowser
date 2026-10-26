/** Toolbar Sort/Filter on lifted rows (graph features, item 2): the server names lifted rows by cohort identity; a
 * linear lifted row finds its place by it (or by its record key, for an order written in the graph view); a split
 * panel's round sends its haplotype. */
import { describe, expect, it } from 'vitest';
import { sortRankOf } from '../components/tracks/read-track/readFilter';
import { orderIndex } from './recordKeys';
import { liftHapsForRound } from './sortScope';

const aid = (q: string, row = 0, placement = '3') => `lift-cohort:v1 ["g|${q}","${q}","r${q}",${row},"${placement}"]`;

describe('sortRankOf', () => {
  it('ranks a lifted row by its analysis_id, a native row by its id, unsorted last', () => {
    const idx = orderIndex([aid('b'), aid('a'), 'native1']);
    expect(sortRankOf(idx, { id: 'a', analysis_id: aid('a') })).toBe(1);
    expect(sortRankOf(idx, { id: 'b', analysis_id: aid('b') })).toBe(0);
    expect(sortRankOf(idx, { id: 'native1' })).toBe(2);
    expect(sortRankOf(idx, { id: 'zz' })).toBe(999999);
  });

  it('ranks a lifted row by its record key when the order names another row of the record (graph row)', () => {
    // A graph row's identity is the primary placement; the linear row has its own chain and row index.
    const idx = orderIndex([aid('b', 0, 'primary'), aid('a', 0, 'primary')]);
    expect(sortRankOf(idx, { id: 'a', analysis_id: aid('a', 2, '7') })).toBe(1);
  });

  it('sorts a list of lifted rows into the server order', () => {
    const order = [aid('c'), aid('a'), aid('b')];
    const idx = orderIndex(order);
    const rows = ['a', 'b', 'c'].map(q => ({ id: q, analysis_id: aid(q) }));
    expect([...rows].sort((x, y) => sortRankOf(idx, x) - sortRankOf(idx, y)).map(r => r.id)).toEqual(['c', 'a', 'b']);
  });
});

describe('liftHapsForRound', () => {
  const panels = [
    { datasetId: 'lift', stateKey: 'lift', liftHap: 'MAT' },
    { datasetId: 'lift', stateKey: 'lift#pat', readSubset: { rule: { liftHap: 'PAT' } } },
    { datasetId: 'pooled', stateKey: 'pooled' },
    { datasetId: 'native', stateKey: undefined },
  ];
  it('names each split panel\'s haplotype; pooled and native panels send none', () => {
    expect(liftHapsForRound({ lift: 'lift', pooled: 'pooled', native: 'native' }, panels)).toEqual({ lift: 'MAT' });
    expect(liftHapsForRound({ lift: 'lift#pat' }, panels)).toEqual({ lift: 'PAT' });
  });
});

describe('agy review group A: scoped sorts of a panel with a graph run (record-key labels)', () => {
  it('a selected cluster within a read filter, and the displayed scope, match by record', async () => {
    const { resolveSortRequestScope } = await import('./sortScope');
    const { displayedScope } = await import('./progressiveAnalysis');
    const { recordKey } = await import('./recordKeys');
    const linear = aid('a'), other = aid('b');
    const rk = recordKey(linear)!, rkOther = recordKey(other)!;
    const out = resolveSortRequestScope({ datasetIds: ['d'], sortKeyMap: { d: ['k'] }, clusterAssignments: { k: { [rk]: 1, [rkOther]: 2 } },
      selectedClusters: { k: new Set([1]) }, clusterFocus: {}, filteredReadIds: { k: new Set([linear, other]) },
      activeClusterTreeNodeId: null, clusterTreeNodes: {} });
    expect(out.readIds.d).toEqual([rk]);
    // The display's rows (linear identities) within that scope.
    expect(displayedScope([linear, other], out.readIds.d)).toEqual([linear]);
  });
});
