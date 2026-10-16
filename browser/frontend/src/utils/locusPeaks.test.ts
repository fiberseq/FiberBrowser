import { describe, expect, it } from 'vitest';
import { alignWindowPeaks } from './locusPeaks';

const main = { result_key: 'a', chrom: 'chr1', start: 1000, end: 2000 };
const hap = { result_key: 'b', chrom: 'chr1_hap2', start: 5000, end: 6200 };

describe('alignWindowPeaks', () => {
  it('matches peaks by order and crops each pair to the narrower one around its centre', () => {
    const r = alignWindowPeaks([main, hap], [
      { start: 1100, end: 1200, mode: 'accessibility' },
      { start: 1500, end: 1560, mode: 'tf' },
      { chrom: 'chr1_hap2', start: 5080, end: 5260, mode: 'accessibility' },
      { chrom: 'chr1_hap2', start: 5600, end: 5640, mode: 'accessibility' },
    ], 'chr1')!;
    expect(r.count).toBe(2);
    expect(r.byWindow.a).toEqual([{ start: 1100, end: 1200, mode: 'accessibility' }, { start: 1510, end: 1550, mode: 'tf' }]);
    expect(r.byWindow.b).toEqual([{ start: 5120, end: 5220, mode: 'accessibility' }, { start: 5600, end: 5640, mode: 'tf' }]);
    expect(r.note).toBeUndefined();
  });

  it('a window without peaks gets them at the same offsets', () => {
    const r = alignWindowPeaks([main, hap], [{ start: 1100, end: 1200, mode: 'accessibility' }], 'chr1')!;
    expect(r.byWindow.b).toEqual([{ start: 5100, end: 5200, mode: 'accessibility' }]);
  });

  it('uses the first peaks of each when the counts differ, and says so', () => {
    const r = alignWindowPeaks([main, hap], [
      { start: 1100, end: 1200 }, { start: 1300, end: 1400 },
      { chrom: 'chr1_hap2', start: 5100, end: 5200 },
    ], 'chr1')!;
    expect(r.count).toBe(1);
    expect(r.note).toMatch(/2 \/ 1 peaks/);
  });

  it('no peaks anywhere: nothing to cluster', () => {
    expect(alignWindowPeaks([main, hap], [{ chrom: 'chr9', start: 1, end: 50 }], 'chr1')).toBeNull();
  });
});

describe('otherLocusWindows', () => {
  it('lists each region shown away from the main view once, with its datasets and panel keys', async () => {
    const { otherLocusWindows } = await import('./locusPeaks');
    const v = { chrom: 'chr2', start: 10, end: 20 };
    const w = otherLocusWindows([
      { id: 'p1', contentType: 'dataset', datasetId: 'a' },
      { id: 'p2', contentType: 'dataset', datasetId: 'a', stateKey: 'p2', viewportOverride: v },
      { id: 'p3', contentType: 'dataset', datasetId: 'b', stateKey: 'p3', viewportOverride: v },
      { id: 'p4', contentType: 'dataset', datasetId: 'a', stateKey: 'p4', viewportOverride: { chrom: 'chr1', start: 0, end: 100 } },
    ], 'chr1', 0, 100);
    expect(w).toEqual([{ ...v, datasetIds: ['a', 'b'], stateKeys: { a: ['p2'], b: ['p3'] } }]);
  });
});
