/** The browser's stable sampler: BLAKE2b against known digests and the server's keys (golden values shared with
 *  tests/test_stable_sample.py), lowest-k independent of input order, different seeds different samples. */
import { describe, expect, it } from 'vitest';
import { blake2b, lowestK, stableKey } from './stableSample';

const hex = (b: Uint8Array) => [...b].map(x => x.toString(16).padStart(2, '0')).join('');

describe('stable sampling', () => {
  it('BLAKE2b matches hashlib (64-byte "abc", 8-byte empty)', () => {
    expect(hex(blake2b(new TextEncoder().encode('abc'), 64))).toBe('ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923');
    expect(blake2b(new Uint8Array(300), 8).length).toBe(8);
  });
  it('keys equal the server\'s (golden)', () => {
    expect(stableKey(1)).toBe(16513079772995842083n);
    expect(stableKey(7)).toBe(13805528602901388239n);
    expect(stableKey(1, 'ds1')).toBe(555083412080106611n);
    expect(stableKey(1, 'ds1', 'm84046/1/ccs')).toBe(13303154941664623350n);
    expect(stableKey(7, 'ds1', 'm84046/1/ccs')).toBe(5841588228132999484n);
    expect(stableKey(1, 'é')).toBe(7315250790590001095n);
  });
  it('lowest-k is the same whatever the input order; another seed picks others', () => {
    const names = Array.from({ length: 200 }, (_, i) => `read${i}`);
    const pick = (ns: string[], seed: number) => lowestK(ns, 20, n => stableKey(seed, 'ds', n), n => n);
    expect(pick([...names].reverse(), 1)).toEqual(pick(names, 1));
    expect(new Set(pick(names, 2))).not.toEqual(new Set(pick(names, 1)));
  });
});

describe('Poisson bootstrap weights', () => {
  it('match the server (golden) and the percentile rule', async () => {
    const { poissonWeights, percentileInterval } = await import('./stableSample');
    expect([...poissonWeights(1, 'u1', 12)]).toEqual([2, 0, 1, 3, 0, 0, 0, 0, 0, 1, 1, 2]);
    expect([...poissonWeights(7, 'read9', 12)]).toEqual([3, 1, 2, 2, 0, 1, 0, 1, 0, 1, 0, 2]);
    expect(percentileInterval([3, 1, 2, 5, 4], 0.5)).toEqual([2, 4]);
  });
});
