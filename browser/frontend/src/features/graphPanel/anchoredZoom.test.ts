// The anchored-zoom correction converts its pixel miss to bases at the scale the sequence around the anchor is
// drawn at, not the average scale (e2e health pass, 26 Oct: the average scale left the base 48 px off beside the
// AluY insertion). The settled end-to-end check is diffmatch-gates.spec.ts "anchored zoom keeps the target base under
// the pointer".
import { describe, expect, it } from 'vitest';
import { bpScale } from './coordinates';
import { localBpScale, type TargetMapEntry } from './scene';

describe('localBpScale', () => {
  // 1,000 target bases over 1,000 px, with a 2 kb insertion drawn 600 px wide at 500.
  const map: TargetMapEntry[] = [
    { kind: 'seq', t0: 0, t1: 500, x0: 0, x1: 200 },
    { kind: 'slot', t0: 500, t1: 500, x0: 200, x1: 800 },
    { kind: 'seq', t0: 500, t1: 1000, x0: 800, x1: 1000 },
  ];

  it('is the drawn sequence\'s own scale, below the average when an insertion is drawn wide', () => {
    expect(localBpScale(map, 250)).toBeCloseTo(0.4);
    expect(localBpScale(map, 750)).toBeCloseTo(0.4);
    expect(bpScale({ start: 0, end: 1000, width: 1000, left: 0, reversed: false } as never)).toBe(1);
  });

  it('a 40 px miss is 100 bases there (the average scale gave 40, so the pan fell short)', () => {
    expect(Math.round(40 / localBpScale(map, 250)!)).toBe(100);
  });

  it('is null away from drawn sequence (the caller falls back to the average scale)', () => {
    expect(localBpScale(map, 1500)).toBeNull();
    expect(localBpScale([{ kind: 'gap', t0: 0, t1: 100, x0: 0, x1: 10 }], 50)).toBeNull();
  });

  it('is positive on a reversed drawing', () => {
    expect(localBpScale([{ kind: 'seq', t0: 0, t1: 100, x0: 300, x1: 100 }], 50)).toBeCloseTo(2);
  });
});
