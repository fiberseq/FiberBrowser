import { describe, expect, it } from 'vitest';
import { computeReadRowGap, computeReadTrackLayout, shouldDrawReadBoundaryLines } from './layout';

describe('read track layout', () => {
  it('does not overflow while filling sparse reads across separator thresholds', () => {
    for (const mode of ['auto', 'fixed', 'off'] as const) {
      for (const height of [40,41,42,60,100,150,199,320,601]) {
        for (let n=1;n<=height;n++) {
          const layout=computeReadTrackLayout(n,height,0,0,true,1,0,mode);
          expect(layout.needsScroll,`${mode}: ${n} reads in ${height}px`).toBe(false);
          expect(layout.totalContentHeight).toBeLessThanOrEqual(height+1e-7);
        }
      }
    }
  });
  it('still scrolls when the requested fixed row height cannot fit',()=>{
    expect(computeReadTrackLayout(100,40,0,0,true,5,0).needsScroll).toBe(true);
  });
  it('keeps auto-fit non-scrollable when displayed read count drops below capacity', () => {
    const layout = computeReadTrackLayout(190, 1200, 16, 0, false, 'auto', 500);

    expect(layout.needsScroll).toBe(false);
    expect(layout.rowGap).toBe(0);
    expect(layout.rowHeight).toBe(5);
    expect(layout.maxScrollOffset).toBe(0);
    expect(layout.scrollAdjust).toBe(0);
  });

  it('stretches rows to fill the track when fill-read-height auto mode is enabled', () => {
    const layout = computeReadTrackLayout(100, 1016, 16, 0, true, 'auto', 0);

    expect(layout.needsScroll).toBe(false);
    expect(layout.rowHeight).toBe(10);
    expect(layout.totalContentHeight).toBe(1000);
  });

  it('only scrolls when the user sets a fixed row height larger than the track can fit', () => {
    const layout = computeReadTrackLayout(190, 1200, 16, 0, true, 10, 250);

    expect(layout.needsScroll).toBe(true);
    expect(layout.maxScrollOffset).toBeGreaterThan(0);
    expect(layout.scrollAdjust).toBe(250);
  });

  it('uses fixed row height as a floor and expands sparse read sets when fill mode is enabled', () => {
    const layout = computeReadTrackLayout(10, 516, 16, 0, true, 10, 0);

    expect(layout.needsScroll).toBe(false);
    expect(layout.rowHeight).toBeGreaterThan(10);
    expect(layout.totalContentHeight).toBeCloseTo(500, 0);
  });

  it('uses the selected fixed row height when there are enough reads to fill the track', () => {
    const layout = computeReadTrackLayout(120, 516, 16, 0, true, 4, 0);

    expect(layout.needsScroll).toBe(true);
    expect(layout.rowHeight).toBe(4);
  });

  it('ramps manual inter-read separators gently at low row heights', () => {
    expect(computeReadRowGap(2.9)).toBe(0);
    expect(computeReadRowGap(3)).toBe(0.5);
    expect(computeReadRowGap(6)).toBe(1);
    expect(computeReadRowGap(9)).toBe(1.5);
    expect(computeReadRowGap(12)).toBe(2);
    expect(computeReadRowGap(16)).toBe(3);
  });

  it('supports fixed and disabled inter-read separators', () => {
    expect(computeReadRowGap(12, 'off', 3, 2)).toBe(0);
    expect(computeReadRowGap(12, 'fixed', 15, 2)).toBe(0);
    expect(computeReadRowGap(12, 'fixed', 3, 2)).toBe(2);
    expect(computeReadRowGap(2, 'fixed', 1, 4)).toBe(1.5);
  });

  it('does not draw legacy boundary lines when separators are off', () => {
    expect(shouldDrawReadBoundaryLines(20, 10, 'off')).toBe(false);
    expect(shouldDrawReadBoundaryLines(20, 10, 'auto')).toBe(true);
  });

  it('scrolls auto-fit rows when the minimum row height cannot fit every read', () => {
    const layout = computeReadTrackLayout(2000, 216, 16, 0, false, 'auto', 300);
    expect(layout.rowHeight).toBe(0.5);
    expect(layout.needsScroll).toBe(true);
    expect(layout.maxScrollOffset).toBe(800);
    expect(layout.clampedScrollOffset).toBe(300);
    expect(layout.scrollAdjust).toBe(300);
  });
});
