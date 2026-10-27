// The graph band gutter is 52 px wide: a cluster count line such as "Not a carrier 51" or "C0 29 · C1 3" was cut off
// (stabilize open item, LOW). It now wraps to the gutter.
import { describe, expect, it } from 'vitest';
import { gutterLines } from './readCanvas';

// 5 px per character, a 42 px line: 8 characters fit.
const measure = (s: string) => s.length * 5;

describe('gutterLines', () => {
  it('keeps a line that fits as it is', () => {
    expect(gutterLines('C0 24', 42, measure, 3)).toEqual(['C0 24']);
  });

  it('puts cluster counts on lines of their own when they do not fit together', () => {
    expect(gutterLines('C0 29 · C1 10', 42, measure, 3)).toEqual(['C0 29', 'C1 10']);
    expect(gutterLines('C0 2 · C1 3 · C2 4', 42, measure, 3)).toEqual(['C0 2', 'C1 3', 'C2 4']);
  });

  it('wraps "Not a carrier" at its spaces', () => {
    expect(gutterLines('Not a carrier 51', 42, measure, 3)).toEqual(['Not a', 'carrier', '51']);
    expect(gutterLines('Not a carrier 51', 60, measure, 3)).toEqual(['Not a', 'carrier 51']);
  });

  it('ends in "…" when the band has no room for every line', () => {
    expect(gutterLines('C0 2 · C1 3 · C2 4', 42, measure, 2)).toEqual(['C0 2', 'C1 3…']);
    expect(gutterLines('C0 2', 42, measure, 0)).toEqual([]);
  });
});
