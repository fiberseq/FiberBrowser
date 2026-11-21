/**
 * Co-accessibility matrices stay square: x and y cover the same positions, so the plot area of each block is a square
 * (± 1 px) at a wide and at a tall size, one square per block on one scale (A − B and multi-group), the colour bar
 * beside it; the SVG export (the drawFn the PDF also uses) draws square plot areas.
 */
import { describe, expect, it } from 'vitest';
import { drawHeatmapRows, squareChartHeight, squareGeometry, type HeatmapRowsChartProps } from './HeatmapRowsChart';
import { drawChartToSvgString } from '../../utils/chartVectorExport';
import { coaccChart, coaccFigure } from '../../features/plots/CoaccPlot';
import { newPlot } from '../../features/plots/plotModel';

const matrix = (n: number, f = 1) => Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => ((i + j) % 5) * f));
const props = (blocks: number, w: number, h: number): HeatmapRowsChartProps => ({
  blocks: Array.from({ length: blocks }, (_, b) => ({ id: `b${b}`, title: `D${b}`, rows: matrix(12, b + 1).map((values, i) => ({ label: String(i), values })) })),
  start: 1000, binBp: 50, width: w, height: h, title: 'Co-accessibility', valueLabel: 'phi', colormap: 'magma', filename: 'x', square: true,
});

/** The cells drawn per block (a recording context): the bounding box of each block's cells. */
function cellBoxes(p: HeatmapRowsChartProps, w: number, h: number) {
  const rects: Array<[number, number, number, number]> = [];
  const ctx = new Proxy({ fillRect: (x: number, y: number, rw: number, rh: number) => rects.push([x, y, rw, rh]), measureText: (t: string) => ({ width: t.length * 5 }) } as Record<string, unknown>, {
    get: (t, k) => (k in t ? t[k as string] : () => {}), set: () => true,
  }) as unknown as CanvasRenderingContext2D;
  drawHeatmapRows(ctx, w, h, p);
  const { side, xs, top } = squareGeometry(p, w, h);
  const cell = side / 12;
  return xs.map(x0 => {
    const mine = rects.filter(([x, y, rw]) => Math.abs(rw - (cell + 0.3)) < 1e-6 && x >= x0 - 0.01 && x < x0 + side && y >= top - 0.01);
    const minX = Math.min(...mine.map(r => r[0])), minY = Math.min(...mine.map(r => r[1]));
    const maxX = Math.max(...mine.map(r => r[0] + r[2] - 0.3)), maxY = Math.max(...mine.map(r => r[1] + r[3] - 0.3));
    return { w: maxX - minX, h: maxY - minY, n: mine.length };
  });
}

describe('square co-accessibility matrices', () => {
  for (const [w, h] of [[1400, 420], [420, 1400]] as const) {
    it(`a ${w} × ${h} chart: each block's plot area is square, sized by the shorter side`, () => {
      for (const k of [1, 2, 3]) {
        const p = props(k, w, h);
        const boxes = cellBoxes(p, w, h);
        expect(boxes).toHaveLength(k);
        for (const b of boxes) {
          expect(b.n).toBeGreaterThan(100);
          expect(Math.abs(b.w - b.h)).toBeLessThanOrEqual(1);
        }
        const g = squareGeometry(p, w, h);
        expect(g.side).toBeLessThanOrEqual(h - g.top - 30 + 1e-9);
        expect(g.xs[k - 1] + g.side).toBeLessThanOrEqual(w);
      }
    });
  }

  it('the SVG export draws square plot areas (the frames around the matrices)', () => {
    const p = props(2, 1000, 700);
    const svg = drawChartToSvgString((ctx, w, h) => drawHeatmapRows(ctx, w, h, p), 1000, 700);
    const frames = [...svg.matchAll(/<path d="M ([\d.]+) ([\d.]+) L ([\d.]+) ([\d.]+) L ([\d.]+) ([\d.]+) L ([\d.]+) ([\d.]+) Z"[^>]*stroke=/g)]
      .map(m => ({ w: Number(m[3]) - Number(m[1]), h: Number(m[8]) - Number(m[2]) }));
    expect(frames.length).toBe(2);
    for (const f of frames) { expect(f.w).toBeGreaterThan(100); expect(Math.abs(f.w - f.h)).toBeLessThanOrEqual(1); }
  });

  it('the Plots co-accessibility chart is square, A − B too, and its height follows its width', () => {
    const data = (id: string) => ({ id, title: id, data: { matrix: matrix(20), coverage: [], chrom: 'chrT', start: 0, end: 1000, bin_size: 50, n_bins: 20, n_reads: 10, normalization: 'phi', marginal_accessibility: [] } });
    const plot = newPlot({ type: 'co-accessibility' });
    const two = coaccChart(plot, coaccFigure(plot, [data('A'), data('B')] as never), 900, false, 600)!;
    expect(two.square).toBe(true);
    expect(two.blocks).toHaveLength(2);
    expect(two.height).toBe(squareChartHeight(two, 900, 600));
    const diff = coaccChart({ ...plot, compare: 'diff' }, coaccFigure({ ...plot, compare: 'diff' }, [data('A'), data('B')] as never), 900, false, 600)!;
    expect(diff.blocks).toHaveLength(1);
    const g = squareGeometry(diff, diff.width, diff.height);
    expect(g.side).toBe(600);
  });
});
