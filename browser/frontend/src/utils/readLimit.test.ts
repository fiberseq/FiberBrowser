import { describe, expect, it } from 'vitest';
import { formatLimitBp, limitFor, windowAtLimit } from './readLimit';

describe('read window helpers', () => {
  it('raises the limit to the smallest offered one that shows the view', () => {
    expect(limitFor(150_000)).toBe(200_000);
    expect(limitFor(200_000)).toBe(200_000);
    expect(limitFor(3_000_000)).toBe(5_000_000);
    expect(limitFor(20_000_000)).toBeNull();
  });

  it('zooms to the limit around the centre of the view', () => {
    expect(windowAtLimit(9_400_000, 9_550_000, 100_000)).toEqual({ start: 9_425_000, end: 9_525_000 });
    expect(windowAtLimit(10_000, 210_000, 100_000)).toEqual({ start: 60_000, end: 160_000 });
    expect(windowAtLimit(0, 150_000, 100_000).start).toBe(25_000);
  });

  it('names widths as the settings do', () => {
    expect(formatLimitBp(100_000)).toBe('100 kb');
    expect(formatLimitBp(1_000_000)).toBe('1 Mb');
    expect(formatLimitBp(1_500_000)).toBe('1.5 Mb');
  });
});
