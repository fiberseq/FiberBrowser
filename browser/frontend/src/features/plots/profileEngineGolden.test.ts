/**
 * The browser's profile engine and the server's twin (browser/services/profile_engine.py) give the same numbers:
 * the golden values tests/test_profile_engine.py asserts for the same reads.
 */
import { describe, expect, it } from 'vitest';
import { accumulateChannels, type ChannelRead } from './profileEngine';

const READS: ChannelRead[] = [
  { start: 0.5, end: 6.2, spans: { a: [[0.0, 7.0], [1.3, 2.9]], b: [[3.5, 3.6]] }, points: { m: [0.0, 0.69, 0.7, 6.99, 7.0, -0.1] } },
  { start: -2.0, end: 3.0, spans: { a: [[-1.0, 0.71]] }, points: { m: [2.1, 4.2] } },
  { start: 4.0, end: 9.0, spans: { b: [[6.3, 12.0]] } },
];
const GOLDEN = {"overlap": {"coverage": [1.285714286, 2.0, 2.0, 2.0, 1.285714286, 1.285714286, 2.0, 2.0, 1.857142857, 1.0], "channels": {"a": [2.0, 1.157142857, 2.0, 2.0, 1.142857143, 1.0, 1.0, 1.0, 1.0, 1.0], "b": [0.0, 0.0, 0.0, 0.0, 0.0, 0.142857143, 0.0, 0.0, 0.0, 1.0], "m": [2.0, 1.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0]}}, "touch": {"coverage": [2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0], "channels": {"a": [2.0, 2.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0], "b": [0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0], "m": [2.0, 1.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0]}}};

const round = (a: ArrayLike<number>) => Array.from(a, v => Math.round(v * 1e9) / 1e9);

describe('engine golden values (shared with the server twin)', () => {
  for (const w of ['overlap', 'touch'] as const) {
    it(w, () => {
      const out = accumulateChannels(READS, 10, 7, w);
      expect(round(out.coverage)).toEqual(GOLDEN[w].coverage);
      expect(Object.fromEntries(Object.keys(out.channels).sort().map(k => [k, round(out.channels[k])]))).toEqual(GOLDEN[w].channels);
    });
  }
});
