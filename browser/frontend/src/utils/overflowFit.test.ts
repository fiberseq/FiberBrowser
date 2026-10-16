import { describe, expect, it } from 'vitest';
import { fitRow } from './overflowFit';

describe('fitRow', () => {
  it('everything fits: no More menu', () => {
    expect(fitRow([50, 60, 70], 200, { moreWidth: 40 })).toEqual({ visible: [0, 1, 2], overflow: [] });
  });

  it('too narrow: the first items in order, room kept for More, the rest overflow', () => {
    expect(fitRow([50, 60, 70, 80], 200, { moreWidth: 40 })).toEqual({ visible: [0, 1], overflow: [2, 3] });
  });

  it('the active item always shows, in its place, instead of the last that would', () => {
    expect(fitRow([50, 60, 70, 80], 200, { moreWidth: 40, pinned: [3] })).toEqual({ visible: [0, 3], overflow: [1, 2] });
  });

  it('counts the gaps between items', () => {
    // 50 + 4 + 50 + 4 + 50 = 158 > 150: the third goes (the More button sits after a gap too).
    expect(fitRow([50, 50, 50], 150, { gap: 4 }).overflow).toEqual([2]);
    expect(fitRow([50, 50, 50], 158, { gap: 4 }).overflow).toEqual([]);
  });

  it('nothing fits: only the pinned item, everything else in More', () => {
    expect(fitRow([120, 120, 120], 100, { moreWidth: 40, pinned: [1] })).toEqual({ visible: [1], overflow: [0, 2] });
    expect(fitRow([120, 120], 100, { moreWidth: 40 })).toEqual({ visible: [], overflow: [0, 1] });
  });
});
