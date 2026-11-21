/**
 * The insertion lens profile on the Plots profile engine gives the numbers the lens computed before (its old code kept
 * here as the reference): random reads with fractional coordinates, lens totals under and over the 600-bin cap.
 */
import { describe, expect, it } from 'vitest';
import type { CompactRead } from '../../components/tracks/read-track/types';
import { computeLensProfile, profilesTsv, type LensProfile } from './insertionLensModel';
import { accumulateChannels } from '../plots/profileEngine';

// --- the replaced implementation (reference) ---------------------------------------------------------------------
function addSpan(acc: number[], a: number, b: number, binWidth: number) {
  if (b <= a) return;
  const first = Math.max(0, Math.floor(a / binWidth));
  const last = Math.min(acc.length - 1, Math.floor((b - 1e-9) / binWidth));
  for (let k = first; k <= last; k++) {
    const lo = Math.max(a, k * binWidth);
    const hi = Math.min(b, (k + 1) * binWidth);
    if (hi > lo) acc[k] += hi - lo;
  }
}
function unionSpans(spans: [number, number][]): [number, number][] {
  const sorted = spans.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [a, b] of sorted) {
    if (out.length && a <= out[out.length - 1][1]) out[out.length - 1][1] = Math.max(out[out.length - 1][1], b);
    else out.push([a, b]);
  }
  return out;
}
function layerSpans(read: CompactRead, names: string[]): [number, number][] {
  const spans: [number, number][] = [];
  for (const name of names) for (const iv of read.layers?.[name]?.intervals ?? []) spans.push([iv[0], iv[1]]);
  return unionSpans(spans);
}
function oldLensProfile(reads: CompactRead[], total: number, maxBins = 600): LensProfile {
  const bins = Math.max(1, Math.min(maxBins, Math.ceil(total)));
  const binWidth = total / bins;
  const covered = new Array(bins).fill(0), nuc = new Array(bins).fill(0), msp = new Array(bins).fill(0), marks = new Array(bins).fill(0);
  for (const read of reads) {
    const body: [number, number][] = [];
    for (const iv of read.intervals ?? []) body.push([iv[0], iv[1]]);
    for (const layer of Object.values(read.layers ?? {})) for (const iv of layer.intervals ?? []) body.push([iv[0], iv[1]]);
    for (const [a, b] of unionSpans(body)) addSpan(covered, a, b, binWidth);
    for (const [a, b] of layerSpans(read, ['nuc'])) addSpan(nuc, a, b, binWidth);
    for (const [a, b] of layerSpans(read, ['msp', 'fire'])) addSpan(msp, a, b, binWidth);
    const points = read.methyl_m6a ?? read.methyl_m5c ?? (read.deam ? read.deam.map(d => d[0]) : read.methyl) ?? [];
    for (const p of points) { const k = Math.floor(p / binWidth); if (k >= 0 && k < bins) marks[k] += 1; }
  }
  const frac = (num: number[]) => num.map((v, k) => (covered[k] > 0 ? Math.min(1, v / covered[k]) : null));
  return { bins, binWidth, coverage: covered.map(c => c / binWidth), nuc: frac(nuc), msp: frac(msp),
    marks: marks.map((m, k) => (covered[k] > 0 ? (100 * m) / covered[k] : null)) };
}

function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

function randomReads(total: number, n: number, seed: number): CompactRead[] {
  const r = rng(seed);
  const span = () => { const a = -50 + r() * (total + 100); return [a, a + 5 + r() * 400] as [number, number]; };
  return Array.from({ length: n }, (_, i) => {
    const ivs = Array.from({ length: 1 + Math.floor(r() * 5) }, () => { const [a, b] = span(); return [a, b, Math.round(b - a)] as [number, number, number]; });
    const layer = (k: number) => ({ intervals: Array.from({ length: k }, () => { const [a, b] = span(); return [a, b, Math.round(b - a)]; }) });
    return {
      id: `r${i}`, intervals: ivs,
      layers: { nuc: layer(Math.floor(r() * 4)), msp: layer(Math.floor(r() * 3)), ...(r() < 0.3 ? { fire: layer(1) } : {}) },
      ...(r() < 0.5 ? { methyl_m6a: Array.from({ length: Math.floor(r() * 30) }, () => -20 + r() * (total + 40)) } : { methyl: Array.from({ length: Math.floor(r() * 10) }, () => r() * total) }),
    } as unknown as CompactRead;
  });
}

describe('insertion lens profile on the engine', () => {
  for (const [total, seed] of [[250.5, 1], [600, 2], [1337.25, 3], [5000, 4], [7, 5]] as const) {
    it(`matches the replaced code (total ${total})`, () => {
      const reads = randomReads(total, 60, seed);
      const now = computeLensProfile(reads, total), was = oldLensProfile(reads, total);
      expect([now.bins, now.binWidth]).toEqual([was.bins, was.binWidth]);
      for (const key of ['coverage', 'nuc', 'msp', 'marks'] as const) {
        now[key].forEach((v, k) => {
          const w = was[key][k];
          if (w == null) expect(v).toBeNull(); else expect(v as number).toBeCloseTo(w, 9);
        });
      }
      const axis = { flank: 100 } as never;
      expect(profilesTsv(axis, [{ label: 'g', profile: now }])).toBe(profilesTsv(axis, [{ label: 'g', profile: was }]));
    });
  }
});

describe('engine overlap weighting with non-integer bin widths', () => {
  it('a span over the whole window fills every bin', () => {
    expect(Array.from(accumulateChannels([{ start: 0, end: 7 }], 10, 7, 'overlap').coverage).map(v => +v.toFixed(12))).toEqual(new Array(10).fill(1));
  });
});
