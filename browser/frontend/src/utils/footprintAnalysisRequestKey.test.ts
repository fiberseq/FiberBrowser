import { describe, expect, it } from 'vitest';
import { buildFootprintAnalysisRequestKey } from './footprintAnalysisRequestKey';

const base = {
  chrom: 'chr2R',
  start: 100,
  end: 500,
  spanning: true,
  footprints: [
    { datasetId: 'ds1', readId: 'r1', absStart: 120, absEnd: 170, size: 50 },
    { datasetId: 'ds2', readId: 'r2', absStart: 180, absEnd: 280, size: 100 },
  ],
  datasetIds: ['ds2', 'ds1'],
  readScopeKey: 'all',
  layer: 'tf',
  maxReads: 5000,
  sampleSeed: '1729',
};

describe('buildFootprintAnalysisRequestKey', () => {
  it('normalizes dataset order without changing footprint order', () => {
    const first = buildFootprintAnalysisRequestKey(base);

    expect(buildFootprintAnalysisRequestKey({ ...base, datasetIds: ['ds1', 'ds2'] })).toBe(first);
    expect(buildFootprintAnalysisRequestKey({ ...base, footprints: [...base.footprints].reverse() })).not.toBe(first);
  });

  it('tracks scope and layer settings', () => {
    const first = buildFootprintAnalysisRequestKey(base);

    expect(buildFootprintAnalysisRequestKey({ ...base, readScopeKey: 'cluster:1' })).not.toBe(first);
    expect(buildFootprintAnalysisRequestKey({ ...base, layer: 'fire' })).not.toBe(first);
    expect(buildFootprintAnalysisRequestKey({ ...base, sampleSeed: '1730' })).not.toBe(first);
  });
});
