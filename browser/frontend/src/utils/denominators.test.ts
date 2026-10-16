import { describe, it, expect } from 'vitest';
import { ESTIMATORS, formatCountPct, formatEstimate, formatPct, formatShare } from './denominators';

describe('formatPct', () => {
  it('never prints 0% or 100% for a share that is neither', () => {
    expect(formatPct(0.0004)).toBe('<1%');
    expect(formatPct(0.9996)).toBe('>99%');
    expect(formatPct(0.0004, { digits: 1 })).toBe('<0.1%');
    expect(formatPct(0.99996, { digits: 1 })).toBe('>99.9%');
    expect(formatPct(0)).toBe('0%');
    expect(formatPct(1)).toBe('100%');
  });
  it('rounds like the app and says when a value is missing', () => {
    expect(formatPct(0.052, { digits: 1 })).toBe('5.2%');
    expect(formatPct(0.29)).toBe('29%');
    expect(formatPct(null)).toBe('–');
    expect(formatPct(Number.NaN, { missing: 'n/a' })).toBe('n/a');
  });
  it('takes counts', () => {
    expect(formatCountPct(1, 1799)).toBe('<1%');
    expect(formatCountPct(1798, 1799)).toBe('>99%');
    expect(formatCountPct(3, 0)).toBe('–');
  });
});

describe('formatShare / formatEstimate', () => {
  it('names the denominator', () => {
    expect(formatShare(737, 810, 'loaded reads')).toBe('737 of 810 loaded reads');
    expect(formatShare(3267, 7225, 'reads', { pct: true })).toBe('3,267 of 7,225 reads (45%)');
  });
  it('names the estimator', () => {
    expect(formatEstimate({ estimator: ESTIMATORS.moleculePrevalence, value: 0.052 })).toBe('Estimated molecule prevalence 5.2%');
    expect(formatEstimate({ estimator: ESTIMATORS.confidentReadFraction, value: 0.078, n: 120, of: 1540, population: 'reads' }))
      .toBe('Confident-call read fraction 7.8% (120 of 1,540 reads)');
  });
});
