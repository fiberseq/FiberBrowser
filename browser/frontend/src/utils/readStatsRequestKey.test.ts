import { describe, expect, it } from 'vitest';
import { buildReadStatsRequestKey, resultForRequest } from './readStatsRequestKey';

const base = {
  chrom: 'chr2R',
  start: 100,
  end: 500,
  spanning: true,
  readIdsByDataset: {
    ds2: ['b', 'a', 'a'],
    ds1: ['d'],
  },
  sampleSeed: '1729',
};

describe('buildReadStatsRequestKey', () => {
  it('is stable across equivalent selected-read scopes', () => {
    const first = buildReadStatsRequestKey(base);
    const second = buildReadStatsRequestKey({
      ...base,
      readIdsByDataset: {
        ds1: ['d'],
        ds2: ['a', 'b'],
      },
    });

    expect(second).toBe(first);
  });

  it('changes when stats scope changes', () => {
    const first = buildReadStatsRequestKey(base);

    expect(buildReadStatsRequestKey({ ...base, start: 101 })).not.toBe(first);
    expect(buildReadStatsRequestKey({ ...base, spanning: false })).not.toBe(first);
    expect(buildReadStatsRequestKey({ ...base, sampleSeed: '1730' })).not.toBe(first);
    expect(buildReadStatsRequestKey({
      ...base,
      readIdsByDataset: { ...base.readIdsByDataset, ds3: ['x'] },
    })).not.toBe(first);
  });
});

describe('resultForRequest', () => {
  it('drops a result fetched for an earlier request', () => {
    const keyA = buildReadStatsRequestKey(base);
    const keyB = buildReadStatsRequestKey({ ...base, readIdsByDataset: { ds1: ['e'] } });
    const fetched = { key: keyA, data: { found_count: 3 } };
    expect(resultForRequest(fetched, keyA)).toBe(fetched.data);
    expect(resultForRequest(fetched, keyB)).toBeNull();
    expect(resultForRequest(null, keyA)).toBeNull();
  });
});

describe('read stats request key and analysis settings', () => {
  it('changes when the server-side read settings change', () => {
    const base = { chrom: 'chr1', start: 0, end: 100, spanning: true, readIdsByDataset: { d: ['r'] } };
    expect(buildReadStatsRequestKey({ ...base, analysisSettingsKey: 'a' }))
      .not.toBe(buildReadStatsRequestKey({ ...base, analysisSettingsKey: 'b' }));
  });
});
