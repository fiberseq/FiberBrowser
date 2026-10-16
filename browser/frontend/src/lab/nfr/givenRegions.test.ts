import { describe, expect, it } from 'vitest';
import { activeNfrRegions, DEFAULT_NFR_SETTINGS, runParameters } from './AccessibilityPanel';

// Owner (6 Oct): a "Find again" region from ind (chr3L) stayed in the settings and every later run elsewhere found no
// NFR. Given regions now apply only where they are.
describe('given NFR regions apply only in their view', () => {
  const ind = { ...DEFAULT_NFR_SETTINGS, nfrRegions: 'chr3L:15039433-15039983', nfrRegionsChrom: 'chr3L' };
  const numb = { chrom: 'chr2L', start: 9_464_149, end: 9_471_599 };
  const there = { chrom: 'chr3L', start: 15_037_533, end: 15_052_280 };

  it('elsewhere: not sent, and detection runs', () => {
    expect(activeNfrRegions(ind, numb)).toMatchObject({ used: [], ignored: true, chrom: 'chr3L' });
    const p = runParameters(ind, null, true, true, false, numb);
    expect(p.nfr_regions).toBeUndefined();
    expect(p.detect_method).toBe('raw');
  });

  it('in its view: sent, and nothing is detected', () => {
    expect(activeNfrRegions(ind, there).used).toEqual([[15_039_433, 15_039_983]]);
    const p = runParameters(ind, null, true, true, false, there);
    expect(p.nfr_regions).toEqual([[15_039_433, 15_039_983]]);
    expect(p.detect_method).toBeUndefined();
  });

  it('a chromosome typed with the region counts; same coordinates on another chromosome do not', () => {
    const typed = { ...DEFAULT_NFR_SETTINGS, nfrRegions: 'chr3L:15039433-15039983', nfrRegionsChrom: '' };
    expect(activeNfrRegions(typed, { chrom: 'chr2L', start: 15_030_000, end: 15_050_000 }).used).toEqual([]);
    expect(activeNfrRegions(typed, { chrom: 'chr3L', start: 15_030_000, end: 15_050_000 }).used).toHaveLength(1);
  });
});
