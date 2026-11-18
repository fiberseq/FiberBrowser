/** Footprint size plots: the colormap per colour mode (settings, scales, colour bar) and the PNG / SVG / PDF drawing path. */
import { describe, expect, it } from 'vitest';
import { colormapRgb, FOOTPRINT_SIZE_COLORMAP_LABELS, FOOTPRINT_SIZE_COLORMAPS, isDivergingColormap, isFootprintSizeColormap } from './footprintSizeColormaps';
import { colorScaleFor, colormapName, ratioScale, scaleRgb, sizeMatrixTsv } from './footprintSizeMatrix';
import {
  colorSlotOf, DEFAULT_FOOTPRINT_SIZE_COLORMAPS, DEFAULT_FOOTPRINT_SIZE_SETTINGS, normalizeFootprintSizeSettings, withView,
  type FootprintSizeColormapChoice, type FootprintSizeSettings,
} from './footprintSizeSettings';
import { viridisRgb } from '../components/charts/viridis';
import { drawSizeEnrichment, type SizeEnrichmentChartProps } from '../components/charts/SizeEnrichmentChart';
import { drawChartToSvgString } from './chartVectorExport';

const enrich = DEFAULT_FOOTPRINT_SIZE_SETTINGS;           // log2 enrichment, a single plot
const counts = withView(DEFAULT_FOOTPRINT_SIZE_SETTINGS, 'vplot');  // V-plot (counts)
const rgb = (c: [number, number, number]) => `rgb(${c[0]},${c[1]},${c[2]})`;
const pick = (s: FootprintSizeSettings, mode: 'comparative' | 'enrichment' | 'vplot', c: Partial<FootprintSizeColormapChoice>): FootprintSizeSettings =>
  ({ ...s, colormaps: { ...s.colormaps, [mode]: { ...s.colormaps[mode], ...c } } });

describe('footprint size colormaps', () => {
  it('offers magma, viridis, inferno, plasma, cividis, greys and a diverging RdBu, with the matplotlib ends', () => {
    expect(FOOTPRINT_SIZE_COLORMAPS).toEqual(['magma', 'viridis', 'inferno', 'plasma', 'cividis', 'greys', 'rdbu_r']);
    expect(colormapRgb('magma', 0)).toEqual([0, 0, 4]);
    expect(colormapRgb('magma', 1)).toEqual([252, 253, 191]);
    expect(colormapRgb('inferno', 1)).toEqual([252, 255, 164]);
    expect(colormapRgb('plasma', 0)).toEqual([13, 8, 135]);
    expect(colormapRgb('cividis', 1)).toEqual([254, 232, 56]);
    expect(colormapRgb('greys', 0)).toEqual([255, 255, 255]);
    expect(colormapRgb('greys', 1)).toEqual([0, 0, 0]);
    // RdBu_r: blue low, near-white middle, red high.
    expect(colormapRgb('rdbu_r', 0)).toEqual([5, 48, 97]);
    expect(colormapRgb('rdbu_r', 0.5)).toEqual([247, 246, 246]);
    expect(colormapRgb('rdbu_r', 1)).toEqual([103, 0, 31]);
    expect(colormapRgb('viridis', 0.3)).toEqual(viridisRgb(0.3));
    expect(colormapRgb('magma', -2)).toEqual(colormapRgb('magma', 0));
    expect(colormapRgb('magma', 5)).toEqual(colormapRgb('magma', 1));
    expect(isFootprintSizeColormap('jet')).toBe(false);
    expect(isFootprintSizeColormap('auto')).toBe(false);
    expect(isDivergingColormap('rdbu_r')).toBe(true);
    expect(isDivergingColormap('magma')).toBe(false);
  });

  it('defaults: comparative (log2 ratio) RdBu_r centred on 0; single plots magma (Size enrichment, log2 too) and viridis (V-plot)', () => {
    expect(DEFAULT_FOOTPRINT_SIZE_COLORMAPS).toEqual({
      comparative: { name: 'rdbu_r', reverse: false }, enrichment: { name: 'magma', reverse: false }, vplot: { name: 'viridis', reverse: false },
    });
    expect(enrich.log).toBe(true);                       // the default plot stays log2 enrichment
    expect(colorSlotOf(enrich)).toBe('enrichment');
    expect(colorSlotOf(counts)).toBe('vplot');
    expect(colorSlotOf(enrich, true)).toBe('comparative');
    // The default single plot: log2 enrichment on a symmetric range, coloured magma low to high (not RdBu).
    const single = colorScaleFor([[[1, -1]]], enrich);
    expect(single.colormap).toBe('magma');
    expect(scaleRgb(single.lo, single)).toEqual(colormapRgb('magma', 0));
    expect(scaleRgb(single.hi, single)).toEqual(colormapRgb('magma', 1));
    expect([single.loLabel, single.midLabel]).toEqual([`-${single.hiLabel.slice(1)}`, '0']);
    expect(colorScaleFor([[[2, 0.5]]], { ...enrich, log: false }).colormap).toBe('magma');
    // V-plot: viridis, as V-plots have always been drawn.
    const seq = colorScaleFor([[[0, 1, 2]]], counts);
    expect(seq.colormap).toBe('viridis');
    expect(scaleRgb(seq.hi, seq)).toEqual(viridisRgb(1));
    expect(FOOTPRINT_SIZE_COLORMAP_LABELS.viridis).toBe('Viridis (classic V-plot)');
    // Comparative: the log2 ratio plot, RdBu_r with 0 at its white middle, blue below, red above.
    const ratio = ratioScale([[1, -1]], enrich);
    expect(ratio.colormap).toBe('rdbu_r');
    expect(scaleRgb(0, ratio)).toEqual(colormapRgb('rdbu_r', 0.5));
    expect(scaleRgb(ratio.lo, ratio)).toEqual(colormapRgb('rdbu_r', 0));
    expect(scaleRgb(ratio.hi, ratio)).toEqual(colormapRgb('rdbu_r', 1));
    expect(ratioScale([[1, -1]], counts).colormap).toBe('rdbu_r');
  });

  it("keeps each slot's own pick (Size enrichment, V-plot, comparative) across view switches; picks and reverse are saved", () => {
    const s = pick(pick(pick(enrich, 'enrichment', { name: 'cividis' }), 'vplot', { name: 'greys', reverse: true }), 'comparative', { name: 'plasma' });
    expect(colorScaleFor([[[1, -1]]], s).colormap).toBe('cividis');
    const asVplot = withView(s, 'vplot');
    expect(colorScaleFor([[[0, 2]]], asVplot)).toMatchObject({ colormap: 'greys', reverse: true });
    expect(colorScaleFor([[[1, -1]]], withView(asVplot, 'enrichment')).colormap).toBe('cividis');
    expect(ratioScale([[1]], s).colormap).toBe('plasma');
    expect(normalizeFootprintSizeSettings(JSON.parse(JSON.stringify(s))).colormaps).toEqual(s.colormaps);
    expect(normalizeFootprintSizeSettings({ colormaps: { comparative: { name: 'jet', reverse: 'x' } } }).colormaps).toEqual(DEFAULT_FOOTPRINT_SIZE_COLORMAPS);
    expect(normalizeFootprintSizeSettings({ smooth: 1 }).colormaps).toEqual(DEFAULT_FOOTPRINT_SIZE_COLORMAPS);
  });

  it('migrates the earlier signed / unsigned and single choices', () => {
    // signed served the ratio plot (kept there); single log2 plots now take magma; an unsigned pick other than
    // its default is kept for Size enrichment; V-plot takes its default.
    const old = normalizeFootprintSizeSettings({ colormaps: { signed: { name: 'rdbu_r', reverse: false }, unsigned: { name: 'magma', reverse: false } } }).colormaps;
    expect(old).toEqual(DEFAULT_FOOTPRINT_SIZE_COLORMAPS);
    const picked = normalizeFootprintSizeSettings({ colormaps: { signed: { name: 'plasma', reverse: true }, unsigned: { name: 'inferno', reverse: false } } }).colormaps;
    expect(picked).toEqual({ comparative: { name: 'plasma', reverse: true }, enrichment: { name: 'inferno', reverse: false }, vplot: DEFAULT_FOOTPRINT_SIZE_COLORMAPS.vplot });
    expect(normalizeFootprintSizeSettings({ colormap: 'rdbu_r', reverseColormap: true }).colormaps.comparative).toEqual({ name: 'rdbu_r', reverse: true });
    expect(normalizeFootprintSizeSettings({ colormap: 'cividis' }).colormaps.enrichment).toEqual({ name: 'cividis', reverse: false });
    expect(normalizeFootprintSizeSettings({ colormap: 'auto' }).colormaps).toEqual(DEFAULT_FOOTPRINT_SIZE_COLORMAPS);
  });

  it('a diverging map keeps 0 at its middle on any scale; a sequential map runs low to high; reverse flips', () => {
    const divOnSingle = colorScaleFor([[[1, -1]]], pick(enrich, 'enrichment', { name: 'rdbu_r' }));
    expect(scaleRgb(0, divOnSingle)).toEqual(colormapRgb('rdbu_r', 0.5));
    const divOnCounts = colorScaleFor([[[0, 2]]], pick(counts, 'vplot', { name: 'rdbu_r' }));
    expect(scaleRgb(divOnCounts.lo, divOnCounts)).toEqual(colormapRgb('rdbu_r', 0.5));   // 0 counts: the white middle
    expect(scaleRgb(divOnCounts.hi, divOnCounts)).toEqual(colormapRgb('rdbu_r', 1));
    const rev = colorScaleFor([[[1, -1]]], pick(enrich, 'enrichment', { reverse: true }));
    expect(scaleRgb(rev.hi, rev)).toEqual(colormapRgb('magma', 0));
    const ratio = ratioScale([[1, -1]], pick(enrich, 'comparative', { name: 'plasma', reverse: true }));
    expect(scaleRgb(ratio.hi, ratio)).toEqual(colormapRgb('plasma', 0));
  });

  it('names the colormap in the TSV header', () => {
    const meta = { sizeMin: 10, sizeMax: 30, sizeBin: 10, posBin: 10, nReads: 1, nFootprints: 2 };
    const t = (s: FootprintSizeSettings, comparative?: boolean) => sizeMatrixTsv([[1, 2]], meta, s, { title: 'A', chrom: 'chrT', start: 0, comparative });
    expect(t(enrich)).toMatch(/^# colormap: magma \(sequential\)$/m);
    expect(t(counts)).toMatch(/^# colormap: viridis \(sequential\)$/m);
    expect(t(pick(enrich, 'enrichment', { name: 'inferno', reverse: true }))).toMatch(/^# colormap: inferno \(sequential\), reversed$/m);
    expect(t(enrich, true)).toMatch(/^# colormap: rdbu \(diverging, centred on 0\)$/m);
    expect(t(counts, true)).toMatch(/^# colormap: rdbu \(diverging, centred on 0\)$/m);
    expect(colormapName(counts)).toBe('viridis (sequential)');
  });
});

describe('footprint size plot drawing with a colormap (PNG canvas, SVG and PDF all draw through it)', () => {
  const props = (name: 'magma' | 'viridis', reverse = false): SizeEnrichmentChartProps => {
    const s = pick(counts, 'vplot', { name, reverse });
    const matrix = [[0, 5], [10, 10]];
    return {
      matrix, sizeMin: 10, sizeMax: 30, sizeBin: 10, posBin: 10, start: 0,
      scale: { ...colorScaleFor([matrix], s), hi: 10 }, width: 200, height: 160, filename: 'x',
    };
  };
  const record = (p: SizeEnrichmentChartProps) => {
    const fills: string[] = [];
    const ctx = new Proxy({}, {
      get: (_t, k) => (k === 'measureText' ? () => ({ width: 10 }) : () => undefined),
      set: (_t, k, v) => { if (k === 'fillStyle') fills.push(String(v)); return true; },
    }) as unknown as CanvasRenderingContext2D;
    drawSizeEnrichment(ctx, 200, 160, p);
    return fills;
  };

  it('fills the cells and the colour bar from the chosen colormap (recording context: the canvas / PNG path)', () => {
    const fills = record(props('magma'));
    expect(fills).toContain(rgb(colormapRgb('magma', 0)));
    expect(fills).toContain(rgb(colormapRgb('magma', 1)));
    expect(fills).not.toContain(rgb(viridisRgb(1)));
    const reversed = record(props('magma', true));
    // The cell with 0 (drawn first) is now the top of magma.
    expect(reversed.indexOf(rgb(colormapRgb('magma', 1)))).toBeLessThan(reversed.indexOf(rgb(colormapRgb('magma', 0))));
  });

  it('exports the colormap in the SVG (vector path shared with PDF)', () => {
    const svg = drawChartToSvgString((c, w, h) => drawSizeEnrichment(c, w, h, props('magma')), 200, 160);
    expect(svg).toContain(`fill="${rgb(colormapRgb('magma', 1))}"`);
    expect(svg).toContain(`fill="${rgb(colormapRgb('magma', 0))}"`);
    const vir = drawChartToSvgString((c, w, h) => drawSizeEnrichment(c, w, h, props('viridis')), 200, 160);
    expect(vir).toContain(`fill="${rgb(viridisRgb(1))}"`);
    expect(vir).not.toContain(`fill="${rgb(colormapRgb('magma', 1))}"`);
  });

  it('a log2 plot names its colour bar unit (log2) and draws magma by default; a log2 ratio draws RdBu', () => {
    const matrix = [[1, -1], [0, 0.5]];
    const p: SizeEnrichmentChartProps = { matrix, sizeMin: 10, sizeMax: 30, sizeBin: 10, posBin: 10, start: 0,
      scale: colorScaleFor([matrix], enrich), width: 200, height: 160, filename: 'x', title: 'A' };
    const svg = drawChartToSvgString((c, w, h) => drawSizeEnrichment(c, w, h, p), 200, 160);
    expect(svg).toMatch(/>log2</);
    expect(svg).toContain(`fill="${rgb(colormapRgb('magma', 1))}"`);
    expect(svg).not.toContain(`fill="${rgb(colormapRgb('rdbu_r', 1))}"`);
    const ratioSvg = drawChartToSvgString((c, w, h) => drawSizeEnrichment(c, w, h, { ...p, scale: ratioScale(matrix, enrich) }), 200, 160);
    expect(ratioSvg).toMatch(/>log2</);
    expect(ratioSvg).toContain(`fill="${rgb(colormapRgb('rdbu_r', 0.5))}"`);
    const countsSvg = drawChartToSvgString((c, w, h) => drawSizeEnrichment(c, w, h, { ...p, scale: colorScaleFor([[[0, 2]]], counts) }), 200, 160);
    expect(countsSvg).not.toMatch(/>log2</);
  });
});
