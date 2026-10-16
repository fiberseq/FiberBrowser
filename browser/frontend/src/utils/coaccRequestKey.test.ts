import { describe, expect, it } from 'vitest';
import { buildCoaccMatrixRequestKey } from './coaccRequestKey';

const base = {
  chrom: 'chr2R',
  start: 100,
  end: 500,
  datasetIds: ['ds2', 'ds1'],
  normalization: 'correlation',
  scaling: 'linear',
  colormap: 'fall',
  minCoverage: 20,
  binSize: 100,
  readIds: ['r2', 'r1'],
  readIdsByDataset: { ds2: ['b', 'a'], ds1: ['d'] },
  signalType: 'accessibility',
  layer: null,
  sampleSeed: '1729',
  maxSize: 320,
  genes: [
    { id: 'g2', name: 'eve', chrom: 'chr2R', start: 300, end: 400, strand: '+', biotype: 'gene', exons: [] },
    { id: 'g1', name: 'sna', chrom: 'chr2R', start: 100, end: 200, strand: '-', biotype: 'gene', exons: [] },
  ],
  refreshKey: 0,
};

describe('buildCoaccMatrixRequestKey', () => {
  it('is stable across equivalent array and object identities', () => {
    const first = buildCoaccMatrixRequestKey(base);
    const second = buildCoaccMatrixRequestKey({
      ...base,
      datasetIds: ['ds1', 'ds2'],
      readIds: ['r1', 'r2'],
      readIdsByDataset: { ds1: ['d'], ds2: ['a', 'b'] },
      genes: [...base.genes].reverse(),
    });

    expect(second).toBe(first);
  });

  it('changes when refresh or semantic matrix settings change', () => {
    const first = buildCoaccMatrixRequestKey(base);

    expect(buildCoaccMatrixRequestKey({ ...base, refreshKey: 1 })).not.toBe(first);
    expect(buildCoaccMatrixRequestKey({ ...base, layer: 'tf' })).not.toBe(first);
    expect(buildCoaccMatrixRequestKey({ ...base, sampleSeed: '1730' })).not.toBe(first);
  });

  it('ignores genes outside the matrix window but tracks visible label changes', () => {
    const first = buildCoaccMatrixRequestKey(base);

    expect(buildCoaccMatrixRequestKey({
      ...base,
      genes: [
        ...base.genes,
        { id: 'offscreen', name: 'outside', chrom: 'chr2R', start: 1000, end: 1100, strand: '+', biotype: 'gene', exons: [] },
      ],
    })).toBe(first);

    expect(buildCoaccMatrixRequestKey({
      ...base,
      genes: [
        ...base.genes,
        { id: 'visible', name: 'inside', chrom: 'chr2R', start: 450, end: 550, strand: '+', biotype: 'gene', exons: [] },
      ],
    })).not.toBe(first);
  });

  it('changes when the quality/layer analysis settings change', () => {
    expect(buildCoaccMatrixRequestKey({ ...base, analysisKey: 'q1' }))
      .not.toBe(buildCoaccMatrixRequestKey({ ...base, analysisKey: 'q2' }));
  });
});
