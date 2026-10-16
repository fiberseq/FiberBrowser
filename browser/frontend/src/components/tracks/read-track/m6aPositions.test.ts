import { describe, expect, it } from 'vitest';
import { m6aPositions } from './ReadTrackCanvas';

describe('m6aPositions', () => {
  it('uses typed m6A marks, and the legacy union only on untyped reads', () => {
    expect(m6aPositions({ methyl: [1], methyl_m6a: [2] })).toEqual([2]);
    expect(m6aPositions({ methyl: [1] })).toEqual([1]);
    // A DAF read: `methyl` holds its deamination positions.
    expect(m6aPositions({ methyl: [5, 9], deam: [[5, 0], [9, 1]] })).toBeUndefined();
    expect(m6aPositions({ methyl: [7], methyl_m5c: [7] })).toBeUndefined();
  });
});
