import { describe, expect, it } from 'vitest';
import { addReadIntervals, touchedBins } from './metaprofileBins';

/** The read track's presence profile, as computeMetaprofileFromReads builds it: per-read union of bins / coverage. */
function presenceProfile(reads: { span: [number, number]; calls: [number, number][] }[], width: number, nBins: number): number[] {
  const sig = new Float64Array(nBins + 1), cov = new Float64Array(nBins + 1);
  for (const r of reads) {
    let a = r.span[0], b = r.span[1];
    for (const [s, e] of r.calls) { a = Math.min(a, s); b = Math.max(b, e); }
    addReadIntervals(sig, r.calls, width, nBins);
    addReadIntervals(cov, [[a, b]], width, nBins);
  }
  const out: number[] = [];
  let s = 0, c = 0;
  for (let i = 0; i < nBins; i++) { s += sig[i]; c += cov[i]; out.push(c > 0 ? s / c : 0); }
  return out;
}

describe('metaprofile bins', () => {
  it('touched bins: floor of the start to ceil of the end, clipped to the window', () => {
    expect(touchedBins(0, 8, 80, 10)).toEqual([0, 1]);
    expect(touchedBins(4, 12, 80, 10)).toEqual([0, 2]);
    expect(touchedBins(-5, 3, 80, 10)).toEqual([0, 1]);
    expect(touchedBins(85, 90, 80, 10)).toBeNull();
    expect(touchedBins(5, 5, 80, 10)).toBeNull();
  });

  it('two calls of one read meeting inside a bin count the read once there', () => {
    const diff = new Float64Array(11);
    addReadIntervals(diff, [[0, 12], [12, 30], [14, 20]], 80, 10);
    let run = 0;
    const per = Array.from({ length: 10 }, (_, i) => (run += diff[i]));
    expect(per).toEqual([1, 1, 1, 1, 0, 0, 0, 0, 0, 0]);
  });

  it('profiles stay within [0, 1] with abutting, overlapping and duplicated calls, and calls past the footprint span', () => {
    const reads = [
      // abutting nucleosomes with 3 bp linkers (shorter than an 8 bp bin)
      { span: [0, 400] as [number, number], calls: [[10, 157], [160, 307], [310, 400]] as [number, number][] },
      // overlapping and duplicated calls (e.g. two tag families read for the same layer)
      { span: [0, 400] as [number, number], calls: [[10, 157], [10, 157], [100, 250]] as [number, number][] },
      // a call past the read's footprint/gap span (an MSP after the last footprint, terminal gap hidden)
      { span: [0, 200] as [number, number], calls: [[150, 260]] as [number, number][] },
    ];
    const p = presenceProfile(reads, 400, 50);
    expect(Math.max(...p)).toBeLessThanOrEqual(1);
    expect(Math.min(...p)).toBeGreaterThanOrEqual(0);
    // Every read has a call around position 155: 3/3, not more.
    expect(p[Math.floor(155 / 8)]).toBe(1);
  });
});
