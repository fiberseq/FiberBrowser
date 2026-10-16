import '../testSetup';
import { describe, expect, it } from 'vitest';
import { placeAxisLabels } from './InsertionLensPanel';

const measure = (text: string) => text.length * 6;

describe('the lens axis labels never overlap (audit bug 7: "−1 kbleft bp")', () => {
  it('the breakpoints win; a flank label that would touch one is left out (its tick stays)', () => {
    // A narrow drawer: 1 kb flanks of a 9 kb insert, 300 px.
    const ticks = [
      { x: 0, label: '−1 kb', major: false }, { x: 27, label: 'left bp', major: true },
      { x: 110, label: '1,000', major: false }, { x: 273, label: 'right bp', major: true }, { x: 299, label: '+1 kb', major: false },
    ];
    const placed = placeAxisLabels(ticks, 300, measure);
    expect(placed.map(p => p.label)).toEqual(['left bp', 'right bp', '1,000']);
    // Wide: all of them.
    const wide = placeAxisLabels(ticks.map(t => ({ ...t, x: t.x * 4 })), 1200, measure);
    expect(wide.map(p => p.label).sort()).toEqual(['+1 kb', '1,000', 'left bp', 'right bp', '−1 kb'].sort());
  });
});
