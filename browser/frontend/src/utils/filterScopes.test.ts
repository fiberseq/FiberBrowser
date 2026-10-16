import { describe, expect, it } from 'vitest';
import type { FirePeak, PanelConfig } from '../types';
import { filterRegionGroups, groupStillShown } from './filterScopes';

const panel = (id: string, override?: { chrom: string; start: number; end: number }) =>
  ({ id, contentType: 'dataset', datasetId: 'ds', stateKey: id === 'main' ? undefined : id, viewportOverride: override }) as unknown as PanelConfig;

describe('filterRegionGroups', () => {
  const main = { chrom: 'chr1', start: 1000, end: 2000 };
  const copy = { chrom: 'chr2', start: 5000, end: 6000 };
  const panels = [panel('main'), panel('copy', copy)];
  const peaks = [
    { index: 0, start: 1200, end: 1300 },
    { index: 1, start: 5200, end: 5300, chrom: 'chr2' },
  ] as FirePeak[];

  it('filters a panel at its own locus there, with the scope resolved in its region', () => {
    const groups = filterRegionGroups({
      stateKeys: ['ds', 'copy'], stateKeyToDs: { ds: 'ds', copy: 'ds' }, panels, main,
      rule: { scope: { kind: 'currentWindow' } }, allPeaks: peaks, selectedPeaks: [], peakModes: {}, selectedGenes: [],
    });
    expect(groups.map(g => [g.chrom, g.start, g.end, g.main, g.windows, g.stateKeysByDataset])).toEqual([
      ['chr1', 1000, 2000, true, [[1000, 2000]], { ds: ['ds'] }],
      ['chr2', 5000, 6000, false, [[5000, 6000]], { ds: ['copy'] }],
    ]);
    // Main-view peaks (untagged) don't leak onto another chromosome.
    expect(groups[1].peakRegions).toEqual([[5200, 5300]]);
  });

  it('selected peaks resolve only where they are', () => {
    const groups = filterRegionGroups({
      stateKeys: ['ds', 'copy'], stateKeyToDs: { ds: 'ds', copy: 'ds' }, panels, main,
      rule: { scope: { kind: 'selectedPeaks' } }, allPeaks: peaks, selectedPeaks: [0], peakModes: {}, selectedGenes: [],
    });
    expect(groups.find(g => g.main)?.windows.length).toBe(1);
    expect(groups.find(g => !g.main)?.windows).toEqual([]);
  });

  it('a group is dropped once a panel moves', () => {
    const [group] = filterRegionGroups({
      stateKeys: ['copy'], stateKeyToDs: { copy: 'ds' }, panels, main,
      rule: { scope: { kind: 'currentWindow' } }, allPeaks: [], selectedPeaks: [], peakModes: {}, selectedGenes: [],
    });
    expect(groupStillShown(group, panels, main)).toBe(true);
    expect(groupStillShown(group, [panel('main'), panel('copy', { chrom: 'chr3', start: 1, end: 2 })], main)).toBe(false);
  });
});


it('keeps private features on their panel and main-reference peaks out of another reference', () => {
  const main = { chrom: 'chr1', start: 100, end: 500 };
  const panels = [panel('main'), panel('copy'), { ...panel('alt'), genome: 'other' }];
  const groups = filterRegionGroups({ stateKeys: ['ds', 'copy', 'alt'], stateKeyToDs: { ds: 'ds', copy: 'ds', alt: 'ds' }, panels, main,
    rule: { scope: { kind: 'selectedPeaks' } }, selectedPeaks: [1, 2], peakModes: {}, selectedGenes: [],
    allPeaks: [{ index: 1, start: 120, end: 150, memberPanelId: 'main' },
      { index: 2, start: 320, end: 350, memberPanelId: 'copy' }],
  });
  expect(groups.map(g => [g.stateKeysByDataset.ds, g.windows, g.peaks.map(p => p.index)])).toEqual([
    [['ds'], [[120, 150]], [1]], [['copy'], [[320, 350]], [2]], [['alt'], [], []],
  ]);
});
