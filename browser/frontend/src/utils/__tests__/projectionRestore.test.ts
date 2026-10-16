/**
 * fb-r5-search (Codex 5): a Projection map an older version saved after its
 * inputs had changed is not made current again when the session is imported.
 */
import { describe, expect, it } from 'vitest';
import {
  currentReadProjection, indexProjection, projectionInputSignature, restoreSavedProjection, savedSignatureMatches,
} from '../projectionExport';

describe('Codex 5: an older session’s stale Projection map is not made current on import', () => {
  const data = {
    method: 'tsne', n_reads: 2, read_ids: ['r1', 'r2'], dataset_ids: ['old', 'old'], coords_x: [1, 2], coords_y: [3, 4],
  } as never;
  const inputs = (refreshGeneration: number, threshold = 90, ds = 'old') => ({
    chrom: 'chr19', start: 1000, end: 2000, analysisSampleSeed: 's', subnucleosomalThreshold: threshold, spanningOnly: true,
    clusterAssignments: { [ds]: { r1: 0, r2: 1 } }, refreshGeneration,
  });

  it('a map computed at threshold 90 and saved after it changed to 95 is dropped', () => {
    const map = indexProjection(data, { chrom: 'chr19', start: 1000, end: 2000 }, projectionInputSignature(inputs(3, 90)));
    // Before f89942a6 the export kept it although the inputs now were 95's.
    const restoredInputs = inputs(9, 95, 'new');
    expect(restoreSavedProjection(JSON.parse(JSON.stringify(map)), { old: 'new' }, restoredInputs)).toBeNull();
    expect(currentReadProjection(null, restoredInputs)).toBeNull();
  });

  it('the same inputs under a new refresh counter and dataset ids come back current', () => {
    const map = indexProjection(data, { chrom: 'chr19', start: 1000, end: 2000 }, projectionInputSignature(inputs(3)));
    const after = inputs(9, 90, 'new');
    expect(savedSignatureMatches(map.signature, after, { old: 'new' })).toBe(true);
    expect(savedSignatureMatches(map.signature, after)).toBe(false);  // without the id map: other datasets
    const restored = restoreSavedProjection(JSON.parse(JSON.stringify(map)), { old: 'new' }, after)!;
    expect(currentReadProjection(restored, after)).toBe(restored);
  });

  it('other reads mapped, other quality filters, or no / a broken signature: dropped', () => {
    const map = indexProjection(data, { chrom: 'chr19', start: 1000, end: 2000 }, projectionInputSignature(inputs(3)));
    expect(savedSignatureMatches(map.signature, { ...inputs(9), clusterAssignments: { old: { r1: 0, r3: 1 } } })).toBe(false);
    expect(savedSignatureMatches(map.signature, { ...inputs(9), legacyLayerInference: true })).toBe(false);
    expect(restoreSavedProjection({ ...map, signature: undefined }, {}, inputs(9))).toBeNull();
    expect(restoreSavedProjection({ ...map, signature: '[not json' }, {}, inputs(9))).toBeNull();
  });

  it('crash recovery: ids inside cluster rules move with the datasets (the map stays)', () => {
    const rules = (ds: string) => [{ id: 'rule1', name: 'class', enabled: true, terms: [
      { id: 't1', source: 'footprint_group', group: { id: 'g1', name: 'g', sourceDatasetId: ds } },
    ] }];
    const before = { ...inputs(3), clusterFeatureRules: rules('old') };
    const map = indexProjection(data, { chrom: 'chr19', start: 1000, end: 2000 }, projectionInputSignature(before));
    const after = { ...inputs(9, 90, 'new'), clusterFeatureRules: rules('new') };
    expect(restoreSavedProjection(JSON.parse(JSON.stringify(map)), { old: 'new' }, after)).not.toBeNull();
  });

  it('a legacy rule normalized again on export and import is the same rule (the map stays)', async () => {
    const { normalizeClusterFeatureRules } = await import('../../stores/utils');
    const legacy = [{ id: 'rule1', name: 'nuc', terms: [{ id: 't1', source: 'layer', layer: 'nuc', sizeMin: 100 }] }];
    const once = normalizeClusterFeatureRules(legacy);
    const map = indexProjection(data, { chrom: 'chr19', start: 1000, end: 2000 }, projectionInputSignature({ ...inputs(3), clusterFeatureRules: once }));
    const twice = normalizeClusterFeatureRules(normalizeClusterFeatureRules(once));
    expect(restoreSavedProjection(JSON.parse(JSON.stringify(map)), {}, { ...inputs(9), clusterFeatureRules: twice })).not.toBeNull();
    // Another size range is another map.
    const other = normalizeClusterFeatureRules([{ ...legacy[0], terms: [{ ...legacy[0].terms[0], sizeMin: 150 }] }]);
    expect(restoreSavedProjection(JSON.parse(JSON.stringify(map)), {}, { ...inputs(9), clusterFeatureRules: other })).toBeNull();
  });

  it('swapped read sets between two panels are not the same map', () => {
    const both = (a: string[], b: string[]) => ({ ...inputs(3), clusterAssignments: {
      old: Object.fromEntries(a.map(r => [r, 0])), other: Object.fromEntries(b.map(r => [r, 0])),
    } });
    const map = indexProjection(data, { chrom: 'chr19', start: 1000, end: 2000 }, projectionInputSignature(both(['r1'], ['r2'])));
    expect(savedSignatureMatches(map.signature, both(['r2'], ['r1']))).toBe(false);
    expect(savedSignatureMatches(map.signature, both(['r1'], ['r2']))).toBe(true);
  });

  it('a quality filter saved under an old layer alias is the same filter', () => {
    const filters = (layer: string) => ({ qualityFilters: [{ layer, qualityName: 'q', minValue: 10, enabled: true }] });
    const map = indexProjection(data, { chrom: 'chr19', start: 1000, end: 2000 },
      projectionInputSignature({ ...inputs(3), activeColormap: filters('nuc_layer') as never }));
    expect(savedSignatureMatches(map.signature, { ...inputs(9), activeColormap: filters('nuc') as never })).toBe(true);
    expect(savedSignatureMatches(map.signature, { ...inputs(9), activeColormap: filters('tf') as never })).toBe(false);
  });
});
