/** The mini read strip's reads: compact intervals as genomic footprints (positive length) and gaps (negative),
 * packed into a few lanes (a downsample), and its window (3× the view, clamped to the chromosome). */
import { describe, expect, it } from 'vitest';
import { packStripReads, stripDragResult, stripReads, stripWindow } from './MiniReadStrip';

describe('mini read strip', () => {
  it('reads intervals relative to the requested start: footprints positive, gaps negative', () => {
    const reads = stripReads([{ intervals: [[10, 20, 10], [20, 25, -5], [25, 40, 15]], aligned_blocks: [[1008, 1042]] }, { intervals: [] }], 1000);
    expect(reads).toEqual([{ start: 1008, end: 1042, parts: [[1010, 1020, true], [1020, 1025, false], [1025, 1040, true]] }]);
  });

  it('packs reads into lanes first-fit by start, leaving out what does not fit', () => {
    const r = (start: number, end: number) => ({ start, end, parts: [] });
    const lanes = packStripReads([r(0, 100), r(50, 150), r(120, 200), r(10, 60), r(5, 30)], 2);
    expect(lanes.map(l => l.map(x => x.start))).toEqual([[0, 120], [5, 50]]);
  });

  it('the window is three views wide, clamped to the chromosome', () => {
    expect(stripWindow(1000, 2000)).toEqual({ start: 0, end: 3000 });
    expect(stripWindow(5000, 6000)).toEqual({ start: 4000, end: 7000 });
    expect(stripWindow(9000, 10000, 10500)).toEqual({ start: 7500, end: 10500 });
  });
});

describe('dragging the strip box', () => {
  it('pan moves the view against the pointer, move with it; the width is kept and the view stays on the chromosome', () => {
    expect(stripDragResult('pan', 1000, 2000, 300)).toEqual({ start: 700, end: 1700 });
    expect(stripDragResult('move', 1000, 2000, 300)).toEqual({ start: 1300, end: 2300 });
    expect(stripDragResult('move', 1000, 2000, -5000)).toEqual({ start: 0, end: 1000 });
    expect(stripDragResult('move', 1000, 2000, 5000, { chromSize: 3000 })).toEqual({ start: 2000, end: 3000 });
  });

  it('an edge zooms with the other edge fixed, between the minimum and maximum width', () => {
    expect(stripDragResult('left', 1000, 2000, -500)).toEqual({ start: 500, end: 2000 });
    expect(stripDragResult('right', 1000, 2000, 500)).toEqual({ start: 1000, end: 2500 });
    expect(stripDragResult('left', 1000, 2000, 990, { min: 50 })).toEqual({ start: 1950, end: 2000 });
    expect(stripDragResult('right', 1000, 2000, -990, { min: 50 })).toEqual({ start: 1000, end: 1050 });
    expect(stripDragResult('right', 1000, 2000, 1e9, { max: 10000 })).toEqual({ start: 1000, end: 11000 });
    expect(stripDragResult('left', 1000, 2000, -1e9)).toEqual({ start: 0, end: 2000 });
    expect(stripDragResult('right', 1000, 2000, 1e9, { chromSize: 4000 })).toEqual({ start: 1000, end: 4000 });
  });
});
