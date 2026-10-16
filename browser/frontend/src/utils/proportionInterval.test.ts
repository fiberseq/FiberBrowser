import { describe, expect, it } from 'vitest';
import { formatPctInterval, wilsonInterval } from './proportionInterval';

describe('a share with its 95% interval', () => {
  it('Wilson', () => {
    const [lo, hi] = wilsonInterval(3267, 3600)!;
    expect(lo).toBeGreaterThan(0.897);
    expect(hi).toBeLessThan(0.917);
    expect(wilsonInterval(1, 0)).toBeNull();
  });
  it('printed like the other percentages, a tenth of a percent near the edges', () => {
    expect(formatPctInterval(3267, 3600)).toBe('91% (95% CI 90–92%)');
    expect(formatPctInterval(1795, 1799)).toBe('>99% (95% CI 99.4–>99.9%)');
    expect(formatPctInterval(1, 1799)).toMatch(/^<1% \(95% CI <0\.1–0\.3%\)$/);
    expect(formatPctInterval(0, 0)).toBe('–');
  });
});
