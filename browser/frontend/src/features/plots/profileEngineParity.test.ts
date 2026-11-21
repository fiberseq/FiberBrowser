/**
 * Parity: the read track's metaprofiles (Clusters › Overview sparklines, Profiles, the MetaTrack sub-track, the
 * Nucleosomes cluster series) come from the profile engine's 'touch' weighting. Since 3.1 (feat/plot-set-yscale,
 * utils/metaprofileBins) a read counts at most once per bin per channel, and its coverage spans every interval it
 * adds: the read track's old accumulation counted a read twice in a bin where two of its calls meet (abutting
 * nucleosomes with a linker shorter than a bin), so cluster profiles reached 1.33. The reference below is a plain
 * per-read set of touched bins; the old numbers are no longer the target.
 */
import { describe, expect, it } from 'vitest';
import { accumulateChannels, finishChannels } from './profileEngine';

/** Reference: per read, the set of bins its layer intervals touch (once each) over its widened span; marks one by one. */
function reference(reads: Array<{ intervals: number[][]; methyl?: number[] }>, viewWidth: number, resolution: number) {
  const binSize = viewWidth / resolution;
  const cov = new Array(resolution).fill(0), lay = new Array(resolution).fill(0), mod = new Array(resolution).fill(0);
  const bins = (s: number, e: number) => {
    const out: number[] = [];
    if (e <= 0 || s >= viewWidth || e <= s) return out;
    const a = Math.max(0, Math.floor(Math.max(0, s) / binSize));
    const b = Math.min(resolution, Math.ceil(Math.min(viewWidth, e) / binSize));
    for (let i = a; i < b; i++) out.push(i);
    return out;
  };
  for (const r of reads) {
    for (const pos of r.methyl ?? []) if (pos >= 0 && pos < viewWidth) mod[Math.min(resolution - 1, Math.floor(pos / binSize))]++;
    let rs = Infinity, re = -Infinity;
    for (const [s, e] of r.intervals) { rs = Math.min(rs, s); re = Math.max(re, e); }
    const touched = new Set<number>();
    for (const [s, e, size] of r.intervals) if (size > 0) bins(s, e).forEach(i => touched.add(i));
    touched.forEach(i => lay[i]++);
    for (const i of bins(rs, re)) cov[i]++;
  }
  return {
    layer: lay.map((v, i) => (cov[i] > 0 ? v / cov[i] : v)),
    mod: mod.map((v, i) => (cov[i] > 0 ? v / cov[i] : v)),
  };
}

function rng(seed: number) { return () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }; }

describe('read-track metaprofiles on the engine', () => {
  it('touch weighting counts a read once per bin per channel; presence stays within [0, 1]', () => {
    const r = rng(7);
    const width = 3337, resolution = 500;
    const reads = Array.from({ length: 120 }, () => {
      let x = Math.floor(r() * 2000) - 300;
      const intervals: number[][] = [];
      while (x < 3600 && intervals.length < 30) {
        const len = 10 + Math.floor(r() * 180);
        const fp = r() > 0.4;
        intervals.push([x, x + len, fp ? len : -len]);
        x += len;
      }
      return { intervals, methyl: Array.from({ length: 20 }, () => Math.floor(r() * 4000) - 200) };
    });
    const ref = reference(reads, width, resolution);
    const channelReads = reads.map(rd => {
      const s = Math.min(...rd.intervals.map(i => i[0])), e = Math.max(...rd.intervals.map(i => i[1]));
      return { start: s, end: e, spans: { layer: rd.intervals.filter(i => i[2] > 0).map(i => [i[0], i[1]] as [number, number]) }, points: { mod: rd.methyl } };
    });
    const now = finishChannels(accumulateChannels(channelReads, resolution, width, 'touch'));
    for (let i = 0; i < resolution; i++) {
      expect(now.layer[i]).toBeCloseTo(ref.layer[i], 5);
      expect(now.mod[i]).toBeCloseTo(ref.mod[i], 5);
      expect(now.layer[i]).toBeGreaterThanOrEqual(0);
      expect(now.layer[i]).toBeLessThanOrEqual(1);
    }
  });

  it('two calls of one read meeting inside a bin count the read once there (the old track counted 2)', () => {
    const reads = [{ start: 0, end: 100, spans: { nuc: [[0, 45], [45, 100]] as Array<[number, number]> } }];
    const prof = finishChannels(accumulateChannels(reads, 10, 100, 'touch'));
    expect(prof.nuc.every(v => v === 1)).toBe(true);
  });

  it('a layer interval past the read\'s footprint span widens its coverage (no signal without coverage)', () => {
    const reads = [{ start: 0, end: 50, spans: { fire: [[60, 80]] as Array<[number, number]> } }];
    const acc = accumulateChannels(reads, 10, 100, 'touch');
    expect(Array.from(acc.coverage).slice(0, 8)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    expect(Math.max(...finishChannels(acc).fire)).toBe(1);
  });
});
