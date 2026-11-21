import { describe, expect, it } from 'vitest';
import { geometryDatasetsToAnalyse, geometryGroups, patchShareProfiles } from './useClusterGeometries';
import { PATCH_SHARE_CHANNEL } from '../../../utils/clusterViewChannels';

const result = (over: Record<string, unknown> = {}) => ({
  window: { chrom: 'c', start: 0, end: 1000 }, errors: {}, nMolecules: 4, nPatches: 3, geometries: [{}, {}],
  profiles: { edges: [0, 500, 1000], carriers: {}, none: [], share: { o0: [0.2, 0.8], o1: [null, 0.4] } },
  assignments: { ds: { group: { q1: 1, q2: 0 }, carried: { q1: [1], q2: [] } } },
  ...over,
}) as never;
const series = [
  { obsId: 'o0', stateKey: 'ds', datasetId: 'ds', cluster: 0, start: 0, end: 1000 },
  { obsId: 'o1', stateKey: 'ds', datasetId: 'ds', cluster: 1, start: 0, end: 1000 },
] as never;

describe('cluster patches', () => {
  it('resample each cluster\'s patch share onto the profile bins', () => {
    const p = patchShareProfiles(series, result(), 4);
    expect(p.ds[0][PATCH_SHARE_CHANNEL]).toEqual([0.2, 0.2, 0.8, 0.8]);
    // A bin the server left empty (too few molecules) stays a gap: never filled from the neighbour.
    expect(p.ds[1][PATCH_SHARE_CHANNEL].slice(2)).toEqual([0.4, 0.4]);
    expect(p.ds[1][PATCH_SHARE_CHANNEL].slice(0, 2).every(Number.isNaN)).toBe(true);
  });
  it('give each molecule its geometry group by dataset and QNAME', () => {
    const g = geometryGroups(result());
    expect(g.ds.get('q1')).toBe(1);
    expect(g.ds.get('q2')).toBe(0);
  });
  it('analyse the datasets whose observations all lack the regularity reference, each on its own', () => {
    const two = [
      { obsId: 'a0', stateKey: 'A', datasetId: 'A', cluster: 0, start: 0, end: 1000 },
      { obsId: 'a1', stateKey: 'A', datasetId: 'A', cluster: 1, start: 0, end: 1000 },
      { obsId: 'b0', stateKey: 'B', datasetId: 'B', cluster: 0, start: 0, end: 1000 },
    ] as never;
    const msg = 'No regularity reference yet: run Analyse first';
    expect(geometryDatasetsToAnalyse(result(), two)).toEqual([]);
    // One dataset analysed, the other not (a locus after a restart): only the other is analysed.
    expect(geometryDatasetsToAnalyse(result({ errors: { b0: msg } }), two)).toEqual(['B']);
    expect(geometryDatasetsToAnalyse(result({ errors: { a0: msg, a1: msg, b0: msg } }), two)).toEqual(['A', 'B']);
    // One cluster without the reference is not a dataset without it.
    expect(geometryDatasetsToAnalyse(result({ errors: { a0: msg } }), two)).toEqual([]);
  });
});
