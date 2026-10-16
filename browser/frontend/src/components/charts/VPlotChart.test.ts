import { describe, expect, it } from 'vitest';
import { axisLabelX } from './VPlotChart';

describe('V-plot x-axis end labels (L8)', () => {
  it('keeps the right-hand coordinate on the canvas', () => {
    // A 500 px chart whose plot ends 16 px from the edge, labelled "47,523,807" (~56 px).
    const x = axisLabelX(484, 56, 500);
    expect(x + 56 / 2).toBeLessThanOrEqual(500);
  });

  it('keeps the left-hand coordinate on the canvas', () => {
    const x = axisLabelX(40, 100, 500);
    expect(x - 100 / 2).toBeGreaterThanOrEqual(0);
  });

  it('leaves a label that fits centred under its tick', () => {
    expect(axisLabelX(250, 20, 500)).toBe(250);
  });
});
