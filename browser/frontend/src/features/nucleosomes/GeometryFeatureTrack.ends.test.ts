import { describe, expect, it } from 'vitest';
import { openScreenEnds } from './GeometryFeatureTrack';

describe('geometry chip open ends', () => {
  it('both ends open: both chevrons; a reversed view swaps them', () => {
    expect(openScreenEnds({ openLeft: true, openRight: true }, false)).toEqual([true, true]);
    expect(openScreenEnds({ openLeft: true }, false)).toEqual([true, false]);
    expect(openScreenEnds({ openLeft: true }, true)).toEqual([false, true]);
  });
});
