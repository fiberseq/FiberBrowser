import { describe, it, expect, beforeAll } from 'vitest';
import { selectedClusterPeakRegions } from './clusterTargets';
import { registerFeatureKind } from '../stores/featureStore';

// Round 2 integration: SVs ticked in Variants are not regions to cluster on, so they must not hide the selected peaks
// (Cluster was enabled, then did nothing).
describe('selectedClusterPeakRegions', () => {
  beforeAll(() => {
    registerFeatureKind({ kind: 'sv', perDataset: true, keyedByChrom: true, layerLabel: 'SV genotype', regionMode: () => null } as never);
  });
  const base = {
    chrom: 'chr2L', start: 9_462_000, end: 9_492_000, clusterPeakMode: 'accessibility', clusterFeatureRules: [],
    peakModes: {}, selectedGenes: [],
    getAllPeaks: () => [{ index: 7, start: 9_470_000, end: 9_470_400 }],
    selectedPeaks: new Set([7]),
  };
  it('ticked SVs leave the selected peak to Cluster', () => {
    const st = { ...base, selectedFeatures: [
      { kind: 'sv', id: 'a', chrom: 'chr2L', start: 9_467_038, end: 9_467_039, datasetId: 'd' },
      { kind: 'sv', id: 'b', chrom: 'chr2L', start: 9_487_240, end: 9_487_241, datasetId: 'd' },
    ] };
    expect(selectedClusterPeakRegions(st as never)).toEqual([{ start: 9_470_000, end: 9_470_400, mode: 'accessibility' }]);
  });
  it('Combinatorial with ticked SVs: the peaks do not count (the SVs group the reads)', () => {
    const st = { ...base, clusterMethod: 'combinatorial', selectedFeatures: [
      { kind: 'sv', id: 'a', chrom: 'chr2L', start: 9_467_038, end: 9_467_039, datasetId: 'd' },
    ] };
    expect(selectedClusterPeakRegions(st as never)).toEqual([]);
  });
  it('no peaks and only SVs: nothing to cluster on (the caller says so)', () => {
    const st = { ...base, selectedPeaks: new Set<number>(), selectedFeatures: [{ kind: 'sv', id: 'a', chrom: 'chr2L', start: 1, end: 2, datasetId: 'd' }] };
    expect(selectedClusterPeakRegions(st as never)).toEqual([]);
  });
});
