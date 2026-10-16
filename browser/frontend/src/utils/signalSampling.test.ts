import { describe, expect, it } from 'vitest';
import { reduceSignalValues, shouldDrawSteppedSignal, signalPointLimit } from './signalSampling';

describe('signalSampling', () => {
  it('keeps already-small signal arrays by reference when orientation is unchanged', () => {
    const values = [1, 2, 3];
    expect(reduceSignalValues(values, 10, false)).toBe(values);
  });

  it('averages dense signal arrays into bounded draw points', () => {
    expect(reduceSignalValues([1, 2, 3, 4, 5, 6], 3)).toEqual([1.5, 3.5, 5.5]);
  });

  it('reduces and reverses signal orientation in one pass', () => {
    expect(reduceSignalValues([1, 2, 3, 4, 5, 6], 3, true)).toEqual([5.5, 3.5, 1.5]);
  });

  it('sanitizes invalid draw values while reducing', () => {
    expect(reduceSignalValues([1, Number.NaN, 3, 4], 2)).toEqual([0.5, 3.5]);
  });

  it('uses stepped rendering when bins are sparse relative to screen pixels', () => {
    expect(signalPointLimit(1000)).toBe(1500);
    expect(shouldDrawSteppedSignal(100, 1000)).toBe(true);
    expect(shouldDrawSteppedSignal(900, 1000)).toBe(false);
  });
});
