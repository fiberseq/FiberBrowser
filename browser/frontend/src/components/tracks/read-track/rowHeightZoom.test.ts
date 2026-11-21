import { describe, expect, it } from 'vitest';
import { nextReadRowHeight } from './layout';
import { wheelDelta, wheelLogFactor } from '../../../utils/wheel';

describe('Shift-wheel row height', () => {
  it('changes continuously from auto-fit and continues down to the minimum', () => {
    expect(nextReadRowHeight('auto', 5, -1)).toBeCloseTo(5 * Math.exp(0.002));
    expect(nextReadRowHeight(5, 5, 1)).toBeLessThan(5);
    expect(nextReadRowHeight(0.5, 5, 100)).toBe(0.5);
    expect(nextReadRowHeight(99, 5, -100)).toBe(99);
  });

  it('accumulates tiny deltas without coarse steps or rounding', () => {
    let height = 5;
    for (let i = 0; i < 100; i++) height = nextReadRowHeight(height, 5, -0.1);
    expect(height).toBeCloseTo(nextReadRowHeight(5, 5, -10), 10);
    expect(height).toBeGreaterThan(5);
    expect(height).toBeLessThan(5.2);
  });

  it('normalizes line/page units and shifted horizontal wheels; clamps mouse spikes', () => {
    const event = { deltaX: 0, deltaY: 1, deltaMode: 0, shiftKey: false };
    expect(wheelDelta({ ...event, deltaMode: 1 })).toBe(16);
    expect(wheelDelta({ ...event, deltaMode: 2 }, 600)).toBe(600);
    expect(wheelDelta({ ...event, deltaY: 0, deltaX: -2, shiftKey: true })).toBe(-2);
    expect(wheelDelta({ ...event, deltaY: 3, deltaX: -2, shiftKey: true })).toBe(3);
    expect(wheelLogFactor(10000)).toBe(0.18);
    expect(wheelLogFactor(-10000)).toBe(-0.18);
  });
});
