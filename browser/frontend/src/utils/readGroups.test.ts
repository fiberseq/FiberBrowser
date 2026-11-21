import { describe, expect, it } from 'vitest';
import { useBrowserStore } from '../stores/browserStore';
import { applyReadGroups, groupingIsCurrent, restoreReadGroups } from './readGroups';

const reset = () => useBrowserStore.setState({
  clusterAssignments: {}, clusterOrder: {}, clusterFocus: {}, clusterPatterns: {}, clusterPeakRegions: [], clusterCentroids: {},
  clusterPeakWidths: [], dynamicClustering: false, svSplits: {}, svCarrierEvidence: {}, clusterGroupLabels: {}, clusterTreeNodes: {}, activeClusterTreeNodeId: null, _historyStack: [], _historyPointer: -1,
} as never);

const SPLIT = {
  byDataset: { ds1: { r1: 0, r2: 1, r3: 2, r4: 3, r5: 4 } }, order: [0, 1, 2, 3, 4],
  patterns: { 0: [1, 1], 1: [1, 0], 2: [0, 1], 3: [0, 0] }, regions: [{ start: 100, end: 300, mode: 'accessibility' }],
};

describe('read groups through the cluster store', () => {
  it('apply a split to every panel of the dataset, as undo steps, without touching the cluster tree', () => {
    reset();
    const clustering = { r1: 5, r2: 5, r3: 6 };
    useBrowserStore.setState({
      clusterAssignments: { ds1: clustering }, clusterOrder: { ds1: [5, 6] }, dynamicClustering: true,
      clusterTreeNodes: { n1: { id: 'n1', assignments: { ds1: clustering }, patterns: { 7: [1] }, peakRegions: [{ start: 1, end: 2 }] } }, activeClusterTreeNodeId: 'n1',
    } as never);
    const before = useBrowserStore.getState()._historyStack.length;
    const applied = applyReadGroups(SPLIT, { ds1: ['ds1', 'ds1~copy'] }, 'Split reads by N1 V2 × N2 V1');
    const s = useBrowserStore.getState();
    expect(s.clusterAssignments.ds1).toEqual(SPLIT.byDataset.ds1);
    expect(s.clusterAssignments['ds1~copy']).toEqual(SPLIT.byDataset.ds1);
    expect(s.clusterOrder.ds1).toEqual([0, 1, 2, 3, 4]);
    expect(s.clusterPatterns).toEqual(SPLIT.patterns);
    expect(s.dynamicClustering).toBe(false);
    const node = (s.clusterTreeNodes as Record<string, { assignments: unknown; patterns?: unknown; peakRegions?: unknown }>).n1;
    expect(node.assignments).toEqual({ ds1: clustering });   // the user's clustering, kept
    expect(node.patterns).toEqual({ 7: [1] });               // and its patterns and regions
    expect(node.peakRegions).toEqual([{ start: 1, end: 2 }]);
    expect(s._historyStack.length).toBeGreaterThan(before);
    expect(s._historyStack.at(-1)).toMatchObject({ label: 'Split reads by N1 V2 × N2 V1', kind: 'clustering' });
    expect(groupingIsCurrent(applied)).toBe(true);
  });

  it('Clear puts back the very grouping a split replaced; a second split stacks on the first', () => {
    reset();
    const clustering = { r1: 5, r2: 5, r3: 6 };
    useBrowserStore.setState({ clusterAssignments: { ds1: clustering }, clusterOrder: { ds1: [5, 6] } } as never);
    const first = applyReadGroups(SPLIT, { ds1: ['ds1'] }, 'Split reads by A × B');
    const second = applyReadGroups({ ...SPLIT, byDataset: { ds1: { r1: 1, r2: 1 } } }, { ds1: ['ds1'] }, 'Split reads by C × D');
    expect(groupingIsCurrent(first)).toBe(false);
    restoreReadGroups(second);
    expect(groupingIsCurrent(first)).toBe(true);                     // the first split is shown again, and can be cleared in turn
    restoreReadGroups(first);
    expect(useBrowserStore.getState().clusterAssignments.ds1).toBe(clustering);
    expect(useBrowserStore.getState().clusterOrder.ds1).toEqual([5, 6]);
  });

  it('Clear after splitting an SV allele split puts the SV split back, names included', () => {
    reset();
    const alleles = { r1: 0, r2: 1, r3: 2 };
    const def = { datasetId: 'ds1', chrom: 'chr2L', t: 'I', ref: 9_470_000, len: 9200, end: 9_470_000, margin: 50, label: '9.2 kb insertion',
      counts: [1, 1, 1], viewStart: 9_462_000, viewEnd: 9_492_000 };
    const names = { 0: 'Carriers', 1: 'Reference', 2: 'Not informative' };
    useBrowserStore.setState({ clusterAssignments: { ds1: alleles }, clusterOrder: { ds1: [0, 1, 2] },
      svSplits: { ds1: def }, clusterGroupLabels: { ds1: names } } as never);
    const applied = applyReadGroups(SPLIT, { ds1: ['ds1'] }, 'Split reads by A × B');
    let s = useBrowserStore.getState();
    expect(s.svSplits.ds1).toBeUndefined();               // these groups are not alleles: the split and its names go
    expect(s.clusterGroupLabels.ds1).toBeUndefined();
    restoreReadGroups(applied);
    s = useBrowserStore.getState();
    expect(s.clusterAssignments.ds1).toBe(alleles);
    expect(s.svSplits.ds1).toBe(def);
    expect(s.clusterGroupLabels.ds1).toEqual(names);
  });

  it('undo returns to the grouping before the split, and the split then reads as replaced', () => {
    reset();
    const clustering = { r1: 5, r2: 6 };
    useBrowserStore.setState({ clusterAssignments: { ds1: clustering }, clusterOrder: { ds1: [5, 6] } } as never);
    useBrowserStore.getState().pushSnapshot('Cluster reads', { kind: 'clustering' });
    const applied = applyReadGroups(SPLIT, { ds1: ['ds1'] }, 'Split reads by A × B');
    useBrowserStore.getState().undo();
    expect(useBrowserStore.getState().clusterAssignments.ds1).toEqual(clustering);
    expect(groupingIsCurrent(applied)).toBe(false);
  });

  it('a grouping that undo or redo brings back reads as current again', () => {
    reset();
    useBrowserStore.setState({ clusterAssignments: { ds1: { r1: 5 } }, clusterOrder: { ds1: [5] } } as never);
    useBrowserStore.getState().pushSnapshot('Cluster reads', { kind: 'clustering' });
    const applied = applyReadGroups(SPLIT, { ds1: ['ds1'] }, 'Split reads by A × B');
    useBrowserStore.getState().undo();
    expect(groupingIsCurrent(applied)).toBe(false);
    useBrowserStore.getState().redo();
    expect(groupingIsCurrent(applied)).toBe(true);
  });
});

it('keeps SV evidence tiers through group replacement, Clear and snapshots', () => {
  reset();
  const levels = { r1: 'confirmed' as const, r2: 'putative' as const };
  const first = applyReadGroups({ ...SPLIT, svEvidenceLevels: levels }, { ds1: ['ds1'] }, 'SV genotype');
  expect(useBrowserStore.getState().svCarrierEvidence.ds1).toEqual(levels);
  const second = applyReadGroups(SPLIT, { ds1: ['ds1'] }, 'Other grouping');
  expect(useBrowserStore.getState().svCarrierEvidence.ds1).toBeUndefined();
  restoreReadGroups(second);
  expect(useBrowserStore.getState().svCarrierEvidence.ds1).toEqual(levels);
  restoreReadGroups(first);
  expect(useBrowserStore.getState().svCarrierEvidence.ds1).toBeUndefined();
});
