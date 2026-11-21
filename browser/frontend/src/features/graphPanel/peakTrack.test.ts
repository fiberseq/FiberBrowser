import { describe, expect, it } from 'vitest';
import { graphPeakSpans } from './peakTrack';
import type { Scene } from './scene';

const scene = (over: Partial<Scene> = {}): Scene => ({
  targetMap: [
    { t0: 100, t1: 200, x0: 10, x1: 110, kind: 'seq' },
    { t0: 200, t1: 200, x0: 110, x1: 310, kind: 'slot' },
    { t0: 200, t1: 400, x0: 310, x1: 410, kind: 'seq' },
  ],
  occurrences: [
    { occ: 'ins-mat', path: 'mat', lane: 'mat', x0: 120, x1: 200 },
    // A folded family member's own occurrence lives in the lead's tube.
    { occ: 'ins-pat', path: 'pat', lane: 'mat', x0: 120, x1: 180 },
  ], hits: [], ...over,
} as Scene);

describe('graph peak columns', () => {
  it('splits target peaks at insertion slots and uses each segment of the nonlinear map', () => {
    expect(graphPeakSpans(scene(), { index: 0, start: 150, end: 300 }, 'target')).toEqual([
      { x0: 60, x1: 110 }, { x0: 310, x1: 360 },
    ]);
    expect(graphPeakSpans(scene(), { index: 0, start: 150, end: 300 }, 'pat')).toEqual([
      { x0: 60, x1: 110 }, { x0: 120, x1: 180 }, { x0: 310, x1: 360 },
    ]);
  });

  it('puts an insertion-only peak on its carriers, including a folded member, without drawing the target padding', () => {
    const peak = { index: 0, start: 190, end: 210, graph: { kind: 'insertion' } };
    expect(graphPeakSpans(scene(), peak, 'target')).toEqual([]);
    expect(graphPeakSpans(scene(), peak, 'mat')).toEqual([{ x0: 120, x1: 200 }]);
    expect(graphPeakSpans(scene(), peak, 'pat')).toEqual([{ x0: 120, x1: 180 }]);
  });

  it('mirrors the piecewise map and occurrence columns without changing the biological span', () => {
    const forward = scene();
    const reverse = scene({ reversed: true,
      targetMap: forward.targetMap.map(m => ({ ...m, x0: 420 - m.x0, x1: 420 - m.x1 })),
      occurrences: forward.occurrences.map(o => ({ ...o, x0: 420 - o.x1, x1: 420 - o.x0 })),
    });
    expect(graphPeakSpans(reverse, { index: 0, start: 150, end: 300 }, 'pat')).toEqual([
      { x0: 60, x1: 110 }, { x0: 240, x1: 300 }, { x0: 310, x1: 360 },
    ]);
  });

  it('clips at the drawn target domain and excludes anchors at the half-open end', () => {
    expect(graphPeakSpans(scene(), { index: 0, start: 90, end: 200 }, 'mat')).toEqual([{ x0: 10, x1: 110 }]);
    expect(graphPeakSpans(scene(), { index: 0, start: 400, end: 500 }, 'mat')).toEqual([]);
  });

  it('draws a marked insertion from its own visits, without borrowing adjacent target sequence', () => {
    const marked = scene({
      targetMap: [{ t0: 200, t1: 200, x0: 120, x1: 120, kind: 'slot' }],
      hits: [{ x0: 118, x1: 122, payload: { kind: 'slot', group: { target: { start: 200, end: 200 },
        alts: [{ visits: [{ occ: { id: 'ins-mat' } }], byCarrier: { pat: [{ occ: { id: 'ins-pat' } }] } }] } } }] as Scene['hits'],
    });
    expect(graphPeakSpans(marked, { index: 0, start: 190, end: 210, graph: { kind: 'insertion' } }, 'pat'))
      .toEqual([{ x0: 120, x1: 180 }]);
    expect(graphPeakSpans(marked, { index: 0, start: 190, end: 210 }, 'target')).toEqual([]);
  });
});
