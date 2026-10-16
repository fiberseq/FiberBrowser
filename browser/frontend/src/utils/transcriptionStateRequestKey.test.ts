import { describe, expect, it } from 'vitest';
import { buildTranscriptionStateRequestKey } from './transcriptionStateRequestKey';

const base = {
  chrom: 'chr2R',
  start: 100,
  end: 500,
  spanning: true,
  datasetIds: ['ds2', 'ds1'],
  geneIds: ['eve', 'sna'],
  filters: { pause: true, pic: false, elongating: 1, elongating_max: null },
  sampleSeed: '1729',
};

describe('buildTranscriptionStateRequestKey', () => {
  it('normalizes dataset and gene order', () => {
    const first = buildTranscriptionStateRequestKey(base);

    expect(buildTranscriptionStateRequestKey({
      ...base,
      datasetIds: ['ds1', 'ds2'],
      geneIds: ['sna', 'eve'],
    })).toBe(first);
  });

  it('tracks viewport and filter changes', () => {
    const first = buildTranscriptionStateRequestKey(base);

    expect(buildTranscriptionStateRequestKey({ ...base, start: 101 })).not.toBe(first);
    expect(buildTranscriptionStateRequestKey({
      ...base,
      filters: { ...base.filters, pic: true },
    })).not.toBe(first);
  });
});
