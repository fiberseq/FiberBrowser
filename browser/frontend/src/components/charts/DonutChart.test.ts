import { describe, expect, it } from 'vitest';
import { drawDonut } from './DonutChart';

function fakeContext() {
  const radii: number[] = [];
  const ctx = {
    clearRect() {}, beginPath() {}, moveTo() {}, closePath() {}, fill() {}, fillRect() {}, fillText() {},
    arc(_x: number, _y: number, r: number) {
      if (r < 0) throw new Error('IndexSizeError: negative radius');
      radii.push(r);
    },
    fillStyle: '', font: '', textAlign: '', textBaseline: '',
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, radii };
}

const eight = Array.from({ length: 8 }, (_, i) => ({ label: `C${i}`, value: i + 1, color: '#000' }));

describe('drawDonut', () => {
  it('drops the legend instead of drawing a negative radius in a short chart', () => {
    const { ctx, radii } = fakeContext();
    expect(() => drawDonut(ctx, 160, 160, eight, 0.55, 'Composition')).not.toThrow();
    expect(radii.length).toBeGreaterThan(0);
    expect(Math.min(...radii)).toBeGreaterThanOrEqual(0);
  });

  it('ignores NaN and negative values', () => {
    const { ctx, radii } = fakeContext();
    expect(() => drawDonut(ctx, 200, 240, [
      { label: 'a', value: Number.NaN, color: '#000' },
      { label: 'b', value: -3, color: '#000' },
      { label: 'c', value: 5, color: '#000' },
    ], 0.55, undefined)).not.toThrow();
    // Only the one real segment is drawn (outer + inner arc).
    expect(radii).toHaveLength(2);
  });
});
