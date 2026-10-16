import { describe, expect, it } from 'vitest';
import { drawOverlayProfile, type ProfileSeries } from './OverlayProfileChart';

/** Records where the curves go and where the legend swatches and labels are drawn. */
function fakeContext() {
  const curveX: number[] = [];
  const swatches: { x: number; y: number }[] = [];
  const labels: { text: string; x: number; y: number; align: string }[] = [];
  const ctx: any = {
    fillStyle: '', strokeStyle: '', font: '', textAlign: 'left', textBaseline: '', lineWidth: 1,
    clearRect() {}, beginPath() {}, closePath() {}, fill() {}, stroke() {}, save() {}, restore() {}, translate() {}, rotate() {}, setLineDash() {},
    moveTo(x: number) { curveX.push(x); }, lineTo(x: number) { curveX.push(x); },
    fillRect(x: number, y: number, w: number, h: number) { if (w === 8 && h === 8) swatches.push({ x, y }); },
    fillText(text: string, x: number, y: number) { labels.push({ text, x, y, align: ctx.textAlign }); },
    measureText(text: string) { return { width: text.length * 5 }; },
  };
  return { ctx: ctx as CanvasRenderingContext2D, curveX, swatches, labels };
}

const flat = (v: number, n = 50) => Array.from({ length: n }, () => v);
const series = (labels: string[]): ProfileSeries[] => labels.map((label, i) => ({ label, color: '#16a34a', data: flat(i + 1) }));

describe('drawOverlayProfile legend', () => {
  it('sits right of the plot, so no curve runs under the labels (the 36 px cluster overview)', () => {
    const { ctx, curveX, swatches, labels } = fakeContext();
    drawOverlayProfile(ctx, 400, 36, series(['Nuc', 'TF']), true, false, undefined, undefined, true, undefined);
    expect(swatches).toHaveLength(2);
    const legendLeft = Math.min(...swatches.map(s => s.x));
    expect(Math.max(...curveX)).toBeLessThan(legendLeft);
    for (const l of labels.filter(l => l.text === 'Nuc' || l.text === 'TF')) {
      expect(l.x).toBeGreaterThan(legendLeft);
      expect(l.x + l.text.length * 5).toBeLessThanOrEqual(400);
    }
  });

  it('wraps into another column instead of running off a short chart', () => {
    const { ctx, curveX, swatches } = fakeContext();
    drawOverlayProfile(ctx, 600, 36, series(['Nuc', 'TF', 'Accessibility', 'm6A']), true, false, undefined, undefined, true, undefined);
    expect(swatches).toHaveLength(4);
    for (const s of swatches) expect(s.y + 8).toBeLessThanOrEqual(36);
    expect(new Set(swatches.map(s => s.x)).size).toBe(2);
    expect(Math.max(...curveX)).toBeLessThan(Math.min(...swatches.map(s => s.x)));
  });

  it('uses the whole width when there is no legend', () => {
    const { ctx, curveX, swatches } = fakeContext();
    drawOverlayProfile(ctx, 400, 36, series(['Nuc']), true, false, undefined, undefined, true, undefined);
    expect(swatches).toHaveLength(0);
    expect(Math.max(...curveX)).toBe(396);
  });
});

describe('drawOverlayProfile legend on a narrow chart with many layers', () => {
  it('keeps the plot and draws the legend (the columns that fit) over it on a backing instead of squeezing the plot away', () => {
    const { ctx, curveX, swatches } = fakeContext();
    const rects: { x: number; w: number; h: number }[] = [];
    const fillRect = (ctx as any).fillRect;
    (ctx as any).fillRect = (x: number, y: number, w: number, h: number) => { rects.push({ x, w, h }); fillRect(x, y, w, h); };
    drawOverlayProfile(ctx, 200, 36, series(['Nuc', 'TF', 'Accessibility', 'Deam', 'm6A', '5mC']), true, false, undefined, undefined, true, undefined);
    expect(Math.max(...curveX)).toBe(196);
    expect(swatches.length).toBeGreaterThanOrEqual(2);
    for (const s of swatches) {
      expect(s.x).toBeGreaterThanOrEqual(0);
      expect(s.x + 8).toBeLessThanOrEqual(200);
    }
    expect(rects.some(r => r.w > 8 && r.h > 8)).toBe(true); // the backing
  });
});
