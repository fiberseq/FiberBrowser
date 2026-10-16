import { describe, expect, it } from 'vitest';
import { computeReadTrackLayout, nextReadRowHeight } from './layout';

describe('Cmd/Ctrl-wheel row height', () => {
  it('eases a fixed height down instead of snapping to auto on the first step', () => {
    // 100 reads in 500 px: automatic sizing fits 5 px rows.
    const autoFit = computeReadTrackLayout(100, 500, 0, 0, false, 'auto', 0).autoRowHeight;
    expect(autoFit).toBe(5);
    // The fixed layout reports its own height, which is what the old code compared against.
    expect(computeReadTrackLayout(100, 500, 0, 0, false, 20, 0).autoRowHeight).toBe(20);
    expect(nextReadRowHeight(20, autoFit, 1)).toBeCloseTo(17);
    expect(nextReadRowHeight(5.5, autoFit, 1)).toBe('auto');
  });

  it('zooms in from auto starting at the fitted height', () => {
    expect(nextReadRowHeight('auto', 5, -1)).toBeCloseTo(5.9);
    expect(nextReadRowHeight(90, 5, -1)).toBe(99);
  });
});
