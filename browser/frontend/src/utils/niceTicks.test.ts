import { describe, expect, it } from 'vitest';
import { formatGenomic, formatRelativeBp, formatTick, niceStep, niceTicks } from './niceTicks';

describe('nice ticks', () => {
  it('1-2-5 steps', () => {
    expect([0.13, 0.3, 0.7, 1, 1.4, 3, 7, 12].map(niceStep)).toEqual([0.2, 0.5, 1, 1, 2, 5, 10, 20]);
  });
  it('about one major per 70 px on x, 45 px on y; minors where there is room', () => {
    const x = niceTicks(-10000, 10000, 600, 70);
    expect(x.step).toBe(2000);
    expect(x.major).toEqual([-10000, -8000, -6000, -4000, -2000, 0, 2000, 4000, 6000, 8000, 10000]);
    expect(x.minor).toContain(-9600);
    expect(x.minor).not.toContain(-8000);
    const y = niceTicks(0, 0.93, 200, 45);
    expect(y.step).toBe(0.2);
    expect(y.major).toEqual([0, 0.2, 0.4, 0.6, 0.8]);
    expect(niceTicks(0, 1, 30, 45).major).toEqual([0, 1]);
  });
  it('labels: −10 kb … 0 … +10 kb; genomic positions; decimals by step', () => {
    expect([-10000, -5000, 0, 5000, 10000].map(v => formatRelativeBp(v, 5000))).toEqual(['−10 kb', '−5 kb', '0', '+5 kb', '+10 kb']);
    expect([-500, -250, 0, 250].map(v => formatRelativeBp(v, 250))).toEqual(['−500 bp', '−250 bp', '0', '+250 bp']);
    expect(formatRelativeBp(2500, 500)).toBe('+2.5 kb');
    expect(formatGenomic(47515000, 1000)).toBe('47,515,000');
    expect(formatGenomic(12500000, 5e6)).toBe('13 Mb');
    expect(formatTick(0.4, 0.2)).toBe('0.4');
    expect(formatTick(-0.05, 0.05)).toBe('−0.05');
  });
});
